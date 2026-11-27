/**
 * @jest-environment jsdom
 */
/**
 * @file A view travels safely: a link carries its lines readable, a
 * received view runs only view lines, and it asks before it runs.
 */
import { describe, it, expect } from '@jest/globals';
import { path_write } from '@fnndsc/menu';
import { viewLine_refusal, viewScript_run, type ArgusHost } from '../../src/console/argusLang.js';
import { viewLink_compose, viewLink_parse, viewScript_compose, viewSheet_ask, VIEW_QUOTED_MARK } from '../../src/app/shareView.js';

describe('viewLine_refusal', () => {
  it('lets a view through: panes, folders shown, a graph\'s view, the baseline', () => {
    for (const line of ['desktop clear', 'view runs', 'pane %1 split right', 'dag %1 census on', 'dag %2 select pl-x_7', 'file %2 open /home/a/b', 'node enter', 'header dag']) {
      expect(viewLine_refusal(line)).toBeNull();
    }
  });

  it('refuses anything that would reach the session or change files', () => {
    expect(viewLine_refusal('rm -r ~/data')).toBe('not a view line: it would run in your session');
    expect(viewLine_refusal('pacs pull 123')).toBe('not a view line: it would run in your session');
    expect(viewLine_refusal('file %1 delete')).toBe('file delete is not part of a view');
    expect(viewLine_refusal('desktop save mine')).toBe('desktop save is not part of a view');
  });
});

describe('view links', () => {
  it('carry the lines readable and give them back whole', () => {
    const script: string = 'desktop clear\nview runs\ndag %1 select pl-dicom_repack_620500';
    const link: string = viewLink_compose('https://titan.example', script);
    expect(link.startsWith('https://titan.example/#view=desktop%20clear%0Aview%20runs')).toBe(true);
    expect(viewLink_parse(new URL(link).hash)).toBe(script);
    expect(viewLink_parse('#/proc/jobs/feed_1')).toBeNull();
    expect(viewLink_parse('#view=%E0%A4%A')).toBeNull();
  });
});

describe('viewSheet_ask', () => {
  it('asks before a view runs, and withholds RUN while any line is refused', async () => {
    const asked: Promise<boolean> = viewSheet_ask(['desktop clear', 'view runs'], new Map(), 'a link');
    const sheet: HTMLElement = document.querySelector('.view-ask') as HTMLElement;
    expect(sheet.querySelector('.share-head')?.textContent).toBe('A VIEW FROM A LINK · RUN THESE LINES?');
    (sheet.querySelector('.view-run') as HTMLButtonElement).click();
    expect(await asked).toBe(true);
    const refused: Promise<boolean> = viewSheet_ask(['view runs', 'rm -r ~'], new Map([[1, 'not a view line: it would run in your session']]), '/home/b/v.desk');
    const second: HTMLElement = document.querySelector('.view-ask') as HTMLElement;
    expect((second.querySelector('.view-run') as HTMLButtonElement).disabled).toBe(true);
    expect(second.querySelector('.view-refused')?.textContent).toContain('← not a view line');
    (second.querySelector('.share-close') as HTMLButtonElement).click();
    expect(await refused).toBe(false);
  });
});

describe('a view\'s line is split once, quotes honoured', () => {
  /** A host with one files pane, recording what the view opened there. */
  function host_make(opened: string[]): ArgusHost {
    return {
      focused_get: (): string | null => 'files-1',
      panes_shown: (): string[] => ['files-1'],
      paneKind_get: (): string | null => 'files',
      files_open: (_pane: string, path: string): boolean => { opened.push(path); return true; },
      viewModes_hold: (): void => undefined,
    } as unknown as ArgusHost;
  }

  it('a folder with spaces, quotes and a newline in its name opens as that one folder, through a script of several lines', async () => {
    const folders: string[] = ['/home/u/plain', '/home/u/two  words', "/home/u/it's \"q\" $HOME;rm", '/home/u/line one\nline two'];
    const script: string = [VIEW_QUOTED_MARK, ...folders.map((folder: string): string => `file open ${path_write(folder)}`)].join('\n');
    const opened: string[] = [];
    const said: string = await viewScript_run(host_make(opened), script, null);
    expect(opened).toEqual(folders);
    expect(said).not.toContain('stopped here');
  });

  it('the allow-list judges the words that would run: a verb hidden in a quoted folder is a folder, and a quoted subject is still the subject', () => {
    expect(viewLine_refusal(`file open ${path_write('/home/u/x delete')}`)).toBeNull();
    expect(viewLine_refusal("file 'delete'")).toBe('file delete is not part of a view');
    expect(viewLine_refusal("'rm' -r /x")).toBe('not a view line: it would run in your session');
    expect(viewLine_refusal("file open '/never closed")).toBe('a quote is left open');
  });

  it('a line with a quote left open stops the view there, and runs nothing after it', async () => {
    const opened: string[] = [];
    const said: string = await viewScript_run(host_make(opened), `${VIEW_QUOTED_MARK}\nfile open /a\nfile open '/b`, null);
    expect(opened).toEqual(['/a']);
    expect(said).toContain('stopped here');
  });
});

describe('a view shared and replayed, and one kept before values were quoted', () => {
  /** A host with one files pane, recording what a view opened there. */
  function host_make(opened: string[]): ArgusHost {
    return {
      focused_get: (): string | null => 'files-1',
      panes_shown: (): string[] => ['files-1'],
      paneKind_get: (): string | null => 'files',
      files_open: (_pane: string, path: string): boolean => { opened.push(path); return true; },
      viewModes_hold: (): void => undefined,
    } as unknown as ArgusHost;
  }

  it('SHARE then replay gives back the folder whole: a blank line, an indent, a # and spaces at either end of its name', async () => {
    const folders: string[] = ['/home/u/one\n\n   # not a comment\n  two', ' /home/u/padded ', "/home/u/it's", '/home/u/plain'];
    // The stage as the desktop serializes it: its mark, a comment of its own, and a files pane per folder.
    const steps: string = [VIEW_QUOTED_MARK, "# the operator's note, with an apostrophe", '', ...folders.map((folder: string): string => `file open ${path_write(folder)}`)].join('\n');
    const shared: string = viewScript_compose(steps);
    expect(shared.split('\n')[1]).toBe(VIEW_QUOTED_MARK);
    const opened: string[] = [];
    const said: string = await viewScript_run({ ...host_make(opened), desktop_clear: (): string => 'cleared' } as unknown as ArgusHost, shared.split('\n').filter((line: string): boolean => line !== 'desktop clear').join('\n'), null);
    expect(opened).toEqual(folders);
    expect(said).not.toContain('stopped here');
  });

  it('a comment with an apostrophe in it swallows nothing: the command after it runs', async () => {
    const opened: string[] = [];
    await viewScript_run(host_make(opened), `${VIEW_QUOTED_MARK}\n# it's mine\nfile open /a\n# and "this\nfile open /b`, null);
    expect(opened).toEqual(['/a', '/b']);
  });

  it('a desktop kept before values were quoted is read as it was written: an apostrophe in a folder\'s name, and its spaces, still open it', async () => {
    const opened: string[] = [];
    // No mark: the old serializer wrote the folder raw.
    const said: string = await viewScript_run(host_make(opened), "# an older desktop\nfile open /home/u/O'Brien files\nfile open /home/u/it's a 'quoted' one", null);
    expect(opened).toEqual(["/home/u/O'Brien files", "/home/u/it's a 'quoted' one"]);
    expect(said).not.toContain('stopped here');
  });
});
