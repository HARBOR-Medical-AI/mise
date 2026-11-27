/**
 * @jest-environment jsdom
 *
 * @file The console language's host: focus falls to the first shown pane,
 * a verb reaches the pane a target stands for (itself, its group's, or the
 * only one on stage), and a desktop serializes as the lines that put it
 * back.
 */
import { describe, it, expect } from '@jest/globals';
import { argusHost_build, type ConsoleHostHooks } from '../../src/app/consoleHost.js';
import type { ArgusHost } from '../../src/console/argusLang.js';
import type { HostContext } from '../../src/app/hostContext.js';
import type { LayoutManager, LayoutNode } from '../../src/app/layout.js';
import { PanelRoster, type PaneInstance, type PanelKinds } from '../../src/app/panes.js';

function host_make(shown: string[], tree: LayoutNode | null, groups: Record<string, string> = {}, focused: string | null = null, client: unknown = {}): { host: ArgusHost; panels: PanelRoster; lines: string[] } {
  const panels: PanelRoster = new PanelRoster();
  const lines: string[] = [];
  const layout = {
    panes_shown: (): string[] => shown,
    focused_get: (): string | null => focused,
    focus_set: (): boolean => true,
    focus_last: (): string | null => null,
    tree_get: (): LayoutNode | null => tree,
  } as unknown as LayoutManager;
  const kinds: Record<string, string> = { files: 'files', dag: 'dag', 'files-2': 'files', 'view-3': 'view', 'tags-4': 'tags', 'tags-5': 'tags' };
  const context = {
    layout,
    panels,
    paneInstance_get: (id: string): PaneInstance | undefined => (kinds[id] === undefined ? undefined : { id, kind: kinds[id], mount: document.createElement('div') } as PaneInstance),
    subjects: { group_resolve: (id: string): string => groups[id] ?? id, regard_get: (): null => null },
    terminal: { line_run: (line: string): void => { lines.push(line); } },
    client,
    sound: (): void => {},
  } as unknown as Pick<HostContext, 'layout' | 'panels' | 'paneInstance_get' | 'subjects' | 'terminal' | 'client' | 'sound'>;
  const hooks: ConsoleHostHooks = {
    verbs: { move: (): string => 'moved', flip: (): string => 'flipped', resize: (): string => 'resized' },
    help_open: (): string => 'help',
    launcher_enter: (): void => {},
    identity_get: (): string | null => 'u@cube',
    consoleZoom_toggle: (): void => {},
    feed_enter: (): void => {},
    indicated_download: (): boolean => true,
    image_open: async (): Promise<string> => '',
    series_ask: async () => null,
    tagsPane_open: (): string => 'tags',
  };
  return { host: argusHost_build(context, hooks), panels, lines };
}

describe('argusHost_build', () => {
  it('focus falls to the first shown pane before any click, and a zoomed pane first of all', () => {
    const { host } = host_make(['files', 'dag'], null);
    expect(host.focused_get()).toBe('files');
    document.body.dataset['zoom'] = 'dag';
    expect(host.focused_get()).toBe('dag');
    delete document.body.dataset['zoom'];
    expect(host.focus_set('nowhere')).toBe(false);
    expect(host.focus_set('dag')).toBe(true);
    expect(host.paneKind_get('files-2')).toBe('files');
    expect(host.paneLinked_get('files')).toBe(false);
  });

  it('a tags verb reaches the pane itself, else the one in its group, else the only one on stage', () => {
    const { host, panels } = host_make(['files', 'tags-4'], null, { 'tags-4': 'files' });
    const redacted: boolean[] = [];
    const tags = { redact_set: (on: boolean): void => { redacted.push(on); }, filter_set: (): void => {} } as unknown as PanelKinds['tags'];
    panels.set('tags', 'tags-4', tags);
    expect(host.tags_control('files', 'redact', ['on'])).toBe('tags redact on');
    expect(host.tags_control('tags-4', 'redact', ['off'])).toBe('tags redact off');
    expect(host.tags_control('files', 'redact', ['maybe'])).toBe('tags redact on|off');
    expect(redacted).toEqual([true, false]);
    // Off stage: nothing answers.
    const alone = host_make(['files'], null);
    expect(alone.host.tags_control('files', 'redact', ['on'])).toBe("tags redact: no tags pane on stage for 'files'");
  });

  it('a file delete runs as a visible line, and a desktop serializes as the lines that put it back', () => {
    const tree: LayoutNode = { dir: 'col', ratio: 0.5, first: { pane: 'files' }, second: { dir: 'row', ratio: 0.5, first: { pane: 'view-3' }, second: { pane: 'files-2' } } };
    const { host, lines } = host_make(['files', 'view-3', 'files-2'], tree, { 'files-2': 'files' });
    expect(host.file_delete('files')).toBe(false);
    expect(lines).toEqual([]);
    expect(host.desktop_serialize()).toBe(['# lines: quoted', 'view files', 'pane %1 bind viewer', 'pane %1 split right', 'pane %2 bind fs', 'pane %2 split below'].join('\n'));
    const empty = host_make([], null);
    expect(empty.host.desktop_serialize()).toBe('# empty desktop');
  });
});

describe('a line run quietly for a verb', () => {
  /** A host whose session answers every line with the given outcome. */
  const host_answering = (outcome: unknown): ArgusHost => host_make(['files'], null, {}, null, { line_execute: async (): Promise<unknown> => outcome }).host;

  it('is done by its answers and its exit status together: an answer that looks fine with a status that is not zero is not done', async () => {
    expect(await host_answering({ envelopes: [{ status: 'ok', rendered: 'wrote it\n' }], liveChannels: new Set(), exitCode: 0 }).session_run('x')).toEqual({ ok: true, text: 'wrote it\n' });
    expect(await host_answering({ envelopes: [{ status: 'ok', rendered: 'wrote it\n' }], liveChannels: new Set(), exitCode: 2 }).session_run('x')).toEqual({ ok: false, text: 'wrote it\n' });
    // An older daemon says no status: its answers decide.
    expect((await host_answering({ envelopes: [{ status: 'ok', rendered: 'kept\n' }], liveChannels: new Set() }).session_run('x')).ok).toBe(true);
    expect(await host_answering({ envelopes: [{ status: 'error', rendered: '', renderedErr: 'no\n' }], liveChannels: new Set() }).session_run('x')).toEqual({ ok: false, text: 'no\n' });
  });

  it('a line that returned nothing gave no receipt, whatever its status', async () => {
    expect((await host_answering({ envelopes: [], liveChannels: new Set(), exitCode: 0 }).session_run('x')).ok).toBe(false);
  });
});
