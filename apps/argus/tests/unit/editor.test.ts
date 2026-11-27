/**
 * @jest-environment jsdom
 *
 * @file The editor: the kernel's `edit` answered with a pane. A save is the
 * touch line the operator could have typed, quoted so every character
 * survives; a pane opens beside the focused one and is found again for the
 * same file; unsaved text stands against a second open; SAVE and REVERT
 * follow the field; a desktop card's open stands the pane first and asks
 * the kernel quietly.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

/** The guest field, faked: a text the test can type into. */
interface FakeField {
  text: string;
  changed: (text: string) => void;
  focused: boolean;
}
const fields: FakeField[] = [];
jest.unstable_mockModule('../../src/features/edit/field.js', () => ({
  editField_create: async (_container: HTMLElement, text: string, _extension: string, changed: (text: string) => void) => {
    const field: FakeField = { text, changed, focused: false };
    fields.push(field);
    return {
      text_get: (): string => field.text,
      text_set: (next: string): void => { field.text = next; field.changed(next); },
      focus: (): void => { field.focused = true; },
      hasFocus: (): boolean => field.focused,
      blur: (): void => { field.focused = false; },
      destroy: (): void => undefined,
    };
  },
}));

const { editor_wire } = await import('../../src/app/editor.js');
const { saveLine_compose, editLine_compose, editAsk_render } = await import('../../src/features/edit/line.js');
const { arg_quote } = await import('@fnndsc/menu');
const { editExtension_extract: extension_parse } = await import('@fnndsc/menu');
const { PanelRoster, paneFactory_register, paneInstance_create, paneInstance_dispose, paneInstances_list } = await import('../../src/app/panes.js');
import type { EditorModule } from '../../src/app/editor.js';
import type { HostContext } from '../../src/app/hostContext.js';
import type { LayoutManager } from '../../src/app/layout.js';
import type { PaneInstance, PanelRoster as Roster } from '../../src/app/panes.js';

/** The pane's template, as index.html stamps it (the parts the panel reads). */
const TEMPLATE: string = `<div class="workspace-pane pane-edit">
  <span class="pane-title">EDIT</span><span class="pane-state"></span>
  <div class="edit-body"><aside class="mode-frame">
    <button class="strategy-pill edit-save">SAVE</button>
    <button class="strategy-pill edit-revert">REVERT</button>
    <span class="edit-focus" hidden>FOCUS</span>
  </aside><section class="edit-field"></section></div></div>`;

interface Stage { shown: string[]; focused: string | null; splits: Array<[string, string, string, boolean]> }

interface Host {
  module: EditorModule;
  panels: Roster;
  stage: Stage;
  echoed: string[];
  executed: Array<[string, unknown]>;
  ran: string[];
  notes: string[];
  answer: { status: string; renderedErr?: string };
}

/** Lets the pane's awaited field build land. */
const settle = async (): Promise<void> => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

function host_make(): Host {
  const stage: Stage = { shown: ['files'], focused: 'files', splits: [] };
  const panels: Roster = new PanelRoster();
  const host = { echoed: [] as string[], executed: [] as Array<[string, unknown]>, ran: [] as string[], notes: [] as string[], answer: { status: 'ok' } as { status: string; renderedErr?: string } };
  const layout = {
    panes_shown: (): string[] => stage.shown,
    focused_get: (): string | null => stage.focused,
    focus_set: (id: string): boolean => { stage.focused = id; return true; },
    leaf_split: (parent: string, dir: string, child: string, before: boolean): boolean => { stage.splits.push([parent, dir, child, before]); stage.shown.push(child); return true; },
    mount_remove: (): void => undefined,
  } as unknown as LayoutManager;
  const context = {
    layout,
    panels,
    subjects: { pane_leave: (): void => undefined },
    terminal: {
      line_echo: (line: string): void => { host.echoed.push(line); },
      line_note: (line: string): void => { host.notes.push(line); },
      line_run: (line: string): void => { host.ran.push(line); },
      outcome_write: (): void => undefined,
      output_write: (): void => undefined,
    },
    client: {
      line_execute: async (line: string, options: unknown) => { host.executed.push([line, options]); return { envelopes: [host.answer], liveChannels: new Set() }; },
    },
  } as unknown as Pick<HostContext, 'layout' | 'panels' | 'subjects' | 'terminal' | 'client'>;
  const module: EditorModule = editor_wire(context, {
    instance_spawn: (kind): PaneInstance => paneInstance_create(kind),
    birth_record: (): void => undefined,
    replayPlace_get: () => null,
    errandHost_find: (): string | null => 'files',
    launcher_yield: (): void => undefined,
    template_stamp: (): HTMLElement => {
      const holder: HTMLElement = document.createElement('div');
      holder.innerHTML = TEMPLATE;
      return holder.firstElementChild as HTMLElement;
    },
  });
  paneFactory_register('edit', module.instance_build);
  return { module, panels, stage, ...host, get answer() { return host.answer; }, set answer(value) { host.answer = value; } } as Host;
}

beforeEach((): void => {
  for (const instance of paneInstances_list()) paneInstance_dispose(instance.id);
  fields.length = 0;
});

describe('the lines an editor runs', () => {
  it('quotes a text so the kernel reads every character back: newlines, $, @, quotes, backslashes, ; | >', () => {
    expect(arg_quote('plain')).toBe("'plain'");
    expect(arg_quote("it's")).toBe("'it'\\''s'");
    expect(arg_quote('a\\b')).toBe("'a\\b'");
    expect(arg_quote('l1; a | b > c\nl2 $HOME @1')).toBe("'l1; a | b > c\nl2 $HOME @1'");
    expect(saveLine_compose('/home/u/my notes.txt', 'x')).toBe("touch --withContents='x' '/home/u/my notes.txt'");
    expect(editLine_compose('/proc/jobs/feed_12/note')).toBe("edit '/proc/jobs/feed_12/note'");
  });

  it('asks before opening a file of a megabyte or more, and not below', () => {
    expect(editAsk_render('small.txt', 1024 * 1024 - 1, 1024 * 1024)).toBeNull();
    expect(editAsk_render('big.csv', 3.5 * 1024 * 1024, 1024 * 1024)).toBe('edit: big.csv is 3.5 MB; open it in the editor? ');
  });

  it('reads an extension, lower case, with its dot', () => {
    expect(extension_parse('/a/b/Config.JSON')).toBe('.json');
    expect(extension_parse('/proc/jobs/feed_12/note')).toBe('');
    expect(extension_parse('/a/.hidden')).toBe('');
  });
});

describe('editor_wire', () => {
  it('answers the kernel with a pane beside the focused one, the file in its field', async () => {
    const host: Host = host_make();
    expect(host.module.edit_receive({ path: '/home/u/a.json', content: '{}', extension: '.json' })).toBe(true);
    await settle();
    const [id] = host.panels.ids('edit');
    expect(host.stage.splits).toEqual([['files', 'col', id, false]]);
    expect(host.stage.focused).toBe(id);
    expect(fields[0].text).toBe('{}');
    const mount: HTMLElement = paneInstances_list().find((one): boolean => one.id === id)?.mount as HTMLElement;
    expect(mount.querySelector('.pane-state')?.textContent).toBe('SAVED');
    expect(mount.querySelector('.pane-title')?.textContent).toBe('EDIT A.JSON');
    expect((mount.querySelector('.edit-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('lights SAVE when the field differs, saves by echoing the touch line, and dims again', async () => {
    const host: Host = host_make();
    host.module.edit_receive({ path: '/home/u/a.txt', content: 'one', extension: '.txt' });
    await settle();
    const mount: HTMLElement = paneInstances_list()[0].mount as HTMLElement;
    fields[0].text = 'two';
    fields[0].changed('two');
    expect(mount.querySelector('.pane-state')?.textContent).toBe('DIRTY');
    const save: HTMLButtonElement = mount.querySelector('.edit-save') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    expect(await host.panels.get('edit', host.panels.ids('edit')[0])?.save()).toBe(true);
    expect(host.echoed).toEqual(["touch --withContents='two' '/home/u/a.txt'"]);
    expect(host.executed[0]).toEqual(["touch --withContents='two' '/home/u/a.txt'", undefined]);
    expect(mount.querySelector('.pane-state')?.textContent).toBe('SAVED');
    expect(save.disabled).toBe(true);
  });

  it('keeps the text and says NOT SAVED when the kernel refuses the save', async () => {
    const host: Host = host_make();
    host.module.edit_receive({ path: '/proc/jobs/feed_1/title', content: 'x' });
    await settle();
    fields[0].text = 'y';
    fields[0].changed('y');
    host.answer = { status: 'error', renderedErr: 'Read-only file system' };
    const panel = host.panels.get('edit', host.panels.ids('edit')[0]);
    expect(await panel?.save()).toBe(false);
    expect(panel?.dirty_is()).toBe(true);
    expect((paneInstances_list()[0].mount as HTMLElement).querySelector('.pane-state')?.textContent).toBe('NOT SAVED · THE CONSOLE SAYS WHY');
  });

  it('REVERT puts the file back; a second edit of a DIRTY file finds its pane and leaves the change', async () => {
    const host: Host = host_make();
    host.module.edit_receive({ path: '/home/u/a.txt', content: 'one' });
    await settle();
    const panel = host.panels.get('edit', host.panels.ids('edit')[0]);
    fields[0].text = 'changed';
    fields[0].changed('changed');
    expect(host.module.edit_receive({ path: '/home/u/a.txt', content: 'one' })).toBe(true);
    expect(host.panels.ids('edit').length).toBe(1);
    expect(fields[0].text).toBe('changed');
    expect(host.notes[0]).toContain('unsaved changes');
    panel?.revert();
    expect(fields[0].text).toBe('one');
    expect(panel?.dirty_is()).toBe(false);
  });

  it('opens another pane for another file, and refuses a request naming no file', async () => {
    const host: Host = host_make();
    host.module.edit_receive({ path: '/home/u/a.txt', content: 'a' });
    host.module.edit_receive({ path: '/home/u/b.txt', content: 'b' });
    expect(host.panels.ids('edit').length).toBe(2);
    expect(() => host.module.edit_receive({ content: 'x' })).toThrow('needs the file it edits');
  });

  it('a desktop card stands the pane first, then asks the kernel quietly; a refusal reads on the bar', async () => {
    const host: Host = host_make();
    host.answer = { status: 'error', renderedErr: '\u001b[31medit: /gone.txt: no such file\u001b[0m\n' };
    const id: string | null = host.module.edit_open('/gone.txt');
    expect(id).not.toBeNull();
    expect(host.executed[0]).toEqual(["edit '/gone.txt'", { silent: true, observe: false }]);
    await settle();
    const mount: HTMLElement = paneInstances_list()[0].mount as HTMLElement;
    expect(mount.querySelector('.pane-state')?.textContent).toBe('NOT OPENED · EDIT: /GONE.TXT: NO SUCH FILE');
    // Pressed, not replayed: the open is a line in the console.
    host.module.edit_open('/home/u/c.txt', { visible: true });
    expect(host.ran).toEqual(["edit '/home/u/c.txt'"]);
  });

  it('Esc takes the keyboard back from the field, once', async () => {
    const host: Host = host_make();
    host.module.edit_receive({ path: '/home/u/a.txt', content: 'a' });
    await settle();
    const panel = host.panels.get('edit', host.panels.ids('edit')[0]);
    expect(fields[0].focused).toBe(true);
    expect(panel?.field_release()).toBe(true);
    expect(panel?.field_release()).toBe(false);
  });
});
