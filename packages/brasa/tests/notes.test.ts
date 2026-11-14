/**
 * @file `notes`: the installed releases' notes gathered by day, selected by
 * the flags, rendered for the console and answered as a session.notes
 * model; the NEWS file is the same, plain.
 */
import { jest, describe, it, expect } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

cuminMock_install(() => ({
  envelope_ok: (rendered: string, model?: unknown) => ({ status: 'ok', rendered, model }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
}));

const { notes_gather, notes_select, notesAsk_make, notesCommand, notes_render, release_title, builtin_notes, news_text, package_short, NOTES_PACKAGES, notes_load } = await import('../src/builtins/sys/notes.js');
const { commandLine_parse } = await import('../src/core/commandParse.js');
const { shellWord_literal } = await import('../src/lib/parser.js');
type PackageNotes = import('../src/builtins/sys/notes.js').PackageNotes;

const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

const SHIPPED: Record<string, PackageNotes> = {
  '@fnndsc/argus': { package: '@fnndsc/argus', version: '0.24.1', releases: [
    { version: '0.24.1', date: '2026-10-05', merge: 'f194de9c', bump: 'patch', changes: [{ headline: 'sl flies the Enterprise.', body: '', internal: false }] },
    { version: '0.24.0', date: '2026-10-05', merge: 'ff1316b2', bump: 'minor', changes: [
      { headline: 'The games shelf on the stage.', body: 'A GAMES pane runs the showpieces.', internal: false },
      { headline: 'Internal: the smoke reads the last ask block.', body: '', internal: true },
    ] },
    { version: '0.23.0', date: null, merge: null, bump: 'minor', changes: [{ headline: 'Undated.', body: '', internal: false }] },
  ] },
  '@fnndsc/brasa': { package: '@fnndsc/brasa', version: '0.32.1', releases: [
    { version: '0.32.1', date: '2026-10-05', merge: 'f194de9c', bump: 'patch', changes: [{ headline: 'Bare help has a Games and utilities group.', body: '', internal: false }] },
    { version: '0.32.0', date: '2026-10-05', merge: 'ff1316b2', bump: 'minor', changes: [{ headline: 'Internal: coverage.', body: '', internal: true }] },
  ] },
};
const loader = (name: string): PackageNotes | null => SHIPPED[name] ?? null;

describe('notes', () => {
  it('gathers the installed packages by the merge that released them, newest first, undated last; two releases on one day stay two', () => {
    const { releases, installed } = notes_gather(loader);
    expect(installed).toEqual({ argus: '0.24.1', brasa: '0.32.1' });
    expect(releases.map((r) => r.merge)).toEqual(['f194de9c', 'ff1316b2', null]);
    expect(releases.map((r) => r.date)).toEqual(['2026-10-05', '2026-10-05', null]);
    expect(release_title(releases[0]!)).toBe('2026-10-05 · argus 0.24.1 · brasa 0.32.1');
    expect(package_short('@fnndsc/porter')).toBe('porter');
    expect(NOTES_PACKAGES).toContain('@fnndsc/chell');
    expect(notes_load('@fnndsc/not-a-package')).toBeNull();
  });

  it('reads the flags and refuses the unknown by name', async () => {
    // The line parsed against the declaration, then its options read as an ask.
    const notesArgs_parse = async (words: string[]): Promise<unknown> => {
      const parsed = await commandLine_parse(notesCommand, words.map(shellWord_literal));
      return parsed.ok ? notesAsk_make(parsed.args.options as Parameters<typeof notesAsk_make>[0]) : { refusal: parsed.refusal };
    };
    expect(await notesArgs_parse([])).toEqual({ since: 1, all: false, long: false });
    expect(await notesArgs_parse(['--since', '3', '--all', '--long'])).toEqual({ since: 3, all: true, long: true });
    expect(await notesArgs_parse(['-s', '2026-10-01'])).toMatchObject({ since: '2026-10-01' });
    expect(await notesArgs_parse(['--since'])).toMatchObject({ refusal: expect.stringContaining("'--since' wants") });
    expect(await notesArgs_parse(['--since', 'soon'])).toMatchObject({ refusal: expect.stringContaining("'soon'") });
    expect(await notesArgs_parse(['--verbose'])).toMatchObject({ refusal: expect.stringContaining("'--verbose'") });
    expect(await notesArgs_parse(['argus'])).toMatchObject({ refusal: expect.stringContaining("'argus'") });
  });

  it('selects by count or by date, and hides internal changes unless asked', () => {
    const { releases } = notes_gather(loader);
    const one = notes_select(releases, { since: 1, all: false, long: false });
    expect(one.length).toBe(1);
    expect(one[0]!.entries.flatMap((e) => e.changes).length).toBe(2);
    const two = notes_select(releases, { since: 2, all: false, long: false });
    expect(two[1]!.entries.find((e) => e.package === 'brasa')!.changes).toEqual([]);
    const all = notes_select(releases, { since: 2, all: true, long: false });
    expect(all[1]!.entries.find((e) => e.package === 'brasa')!.changes.length).toBe(1);
    const dated = notes_select(releases, { since: '2026-10-05', all: false, long: false });
    expect(dated.length).toBe(2);
    expect(notes_select(releases, { since: '2026-10-06', all: false, long: false }).length).toBe(0);
  });

  it('renders a heading per release and a row per headline, bodies when long', () => {
    const { releases } = notes_gather(loader);
    const ask = { since: 2, all: false, long: true };
    const text = plain(notes_render(notes_select(releases, ask), ask));
    expect(text).toContain('2026-10-05 · argus 0.24.1 · brasa 0.32.1');
    expect(text).toMatch(/argus\s+sl flies the Enterprise\./);
    expect(text).toContain('A GAMES pane runs the showpieces.');
    expect(text).toContain('internal changes only');
    expect(plain(notes_render([], ask))).toContain('no release notes installed here');
  });

  it('as a command answers the model and says how many releases are earlier', async () => {
    const out = await builtin_notes([], loader);
    expect(out.status).toBe('ok');
    expect(plain(out.rendered)).toContain('2 earlier releases: notes --since N');
    const model = out.model as { kind: string; data: { source: string; installed: Record<string, string>; releases: unknown[]; total: number; all: boolean } };
    expect(model.kind).toBe('session.notes');
    expect(model.data).toMatchObject({ source: 'daemon', installed: { argus: '0.24.1' }, total: 3, all: false });
    expect(model.data.releases.length).toBe(1);
    expect((await builtin_notes(['--since', 'x'], loader)).status).toBe('error');
    const news = news_text(loader);
    expect(news).not.toMatch(/\x1b/);
    expect(news).toContain('undated · argus 0.23.0');
  });
});
