/**
 * @file grep (#1100): grep's flags with grep's meanings; over a numbered
 * listing it keeps rows with their parents, matched groups whole, and the
 * handles they wore; text is the system grep's, and another flag is refused
 * by the parser.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: async (): Promise<string> => '/home/chris' },
}));
jest.unstable_mockModule('../src/builtins/res/gather.store.js', () => ({
  cohort_read: async (): Promise<unknown> => ({ version: 1, name: null, feed: null, series: [] }),
}));

const { answer_note, answer_get, answerHandles_get, answer_forget } = await import('../src/session/answer.js');
const { answerAdapters_register } = await import('../src/session/answerAdapters.js');
const { chrisReferences, chrisAnswerKinds, chrisVerbTakes } = await import('../src/chris/references.js');
(await import('../src/core/backend.js')).backend_install({ id: 'chris', session: {} as never, references: chrisReferences, answerKinds: chrisAnswerKinds, verbTakes: chrisVerbTakes });
const { grepCommand, grepMatcher_build, builtin_grep } = await import('../src/builtins/sys/grep.js');
const { commandLine_parse } = await import('../src/core/commandParse.js');
const { listingIn_set } = await import('../src/core/listing.js');
answerAdapters_register();

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');
const series = (study: string, n: number, description: string) => ({ seriesUID: `u${n}`, description, modality: 'MR', fileCount: n * 10, vfsPath: `/q/${study}/se${n}` });
const answer = {
  queryId: 1, vfsPath: '/q', pacsName: 'P', expression: 'PatientID:1',
  studies: [
    { description: 'MR Brain', patientName: 'X', patientId: '1', date: '20240101', modalities: 'MR', accession: '', vfsPath: '/q/st1',
      series: [series('st1', 1, 'T1 SAG'), series('st1', 2, 'T2 FLAIR'), series('st1', 3, 'T1 GADAVIST')] },
    { description: 'CT Head', patientName: 'X', patientId: '1', date: '20240202', modalities: 'CT', accession: '', vfsPath: '/q/st2',
      series: [series('st2', 4, 'AXIAL')] },
  ],
};

beforeEach(() => { answer_forget(); listingIn_set(null); process.exitCode = 0; });

/** The words as a literal line. */
const words = (args: string[]) => args.map((value: string) => ({ value, globPattern: value, pathnameExpansion: false, pathnameExpanded: false }));
/** What a line asks, as the declaration hands it on. */
const ask = (patterns: string[], flags: Partial<{ insensitive: boolean; invert: boolean; word: boolean; extended: boolean; fixed: boolean; count: boolean }> = {}) => ({
  insensitive: false, invert: false, word: false, extended: false, fixed: false, count: false, patterns, ...flags,
});

describe('grep arguments', () => {
  it('takes grep\'s own flags, clustered or long, and -e patterns', async () => {
    const vi = await commandLine_parse(grepCommand, words(['-vi', 't1']));
    expect(vi.ok && vi.args).toMatchObject({ options: { invert: true, insensitive: true }, operands: { pattern: 't1' } });
    const e = await commandLine_parse(grepCommand, words(['--ignore-case', '-e', 'a', '-eb', '--regexp=c']));
    expect(e.ok && e.args).toMatchObject({ options: { insensitive: true, regexp: ['a', 'b', 'c'] } });
    const cluster = await commandLine_parse(grepCommand, words(['-wEFc', 'x']));
    expect(cluster.ok && cluster.args).toMatchObject({ options: { word: true, extended: true, fixed: true, count: true } });
  });

  it('refuses another flag in the parser\'s words, before it runs', async () => {
    const short = await builtin_grep(['-o', 'x']);
    expect(short.status).toBe('error');
    expect(strip(short.renderedErr ?? '')).toContain("grep: invalid option -- 'o'; usage: grep");
    expect(process.exitCode).toBe(1);
    expect(strip((await builtin_grep(['--color', 'x'])).renderedErr ?? '')).toContain("grep: unrecognized option '--color'; usage: grep");
  });

  it('reads -- as the end of the options: a pattern may start with a dash', async () => {
    const dashed = await commandLine_parse(grepCommand, words(['--', '-v']));
    expect(dashed.ok && dashed.args).toMatchObject({ options: { invert: false }, operands: { pattern: '-v', files: [] } });
  });

  it('reads a basic regex as grep does: \\| alternates, a bare | is literal', () => {
    const basic = grepMatcher_build(ask(['t1\\|t2']));
    expect(typeof basic === 'function' && basic('a t2 b')).toBe(true);
    const literal = grepMatcher_build(ask(['a|b']));
    expect(typeof literal === 'function' && literal('a|b') && !literal('a')).toBe(true);
    const word = grepMatcher_build(ask(['T1'], { word: true }));
    expect(typeof word === 'function' && word('T1 SAG') && !word('T1C')).toBe(true);
    expect(grepMatcher_build(ask(['('], { extended: true }))).toHaveProperty('refused');
  });
});

describe('grep over a numbered listing', () => {
  it('keeps matching series with their study and patient, and their original handles', async () => {
    listingIn_set({ kind: 'pacs.query', data: answer });
    const envelope = await builtin_grep(['-i', 't1']);
    const text: string = strip(envelope.rendered);
    expect(text).toMatch(/@SER1 +T1 SAG/);
    expect(text).toMatch(/@SER3 +T1 GADAVIST/);
    expect(text).not.toMatch(/T2 FLAIR|AXIAL|CT Head/);
    expect(text).toContain('2 of 4 series kept');
    expect(text).toContain('numbered: @PAT1, @STD1, @SER1,3');
    answer_note(envelope.model?.kind as string, envelope.model?.data, 'query | grep -i t1');
    expect(answerHandles_get().filter((one) => one.kind === 'SER').map((one) => one.ordinal)).toEqual([1, 3]);
  });

  it('keeps a matched group whole, and -v drops a matched group with all its rows', async () => {
    listingIn_set({ kind: 'pacs.query', data: answer });
    expect(strip((await builtin_grep(['-i', 'brain'])).rendered)).toContain('3 of 4 series kept');
    listingIn_set({ kind: 'pacs.query', data: answer });
    const dropped: string = strip((await builtin_grep(['-vi', 'brain'])).rendered);
    expect(dropped).toContain('1 of 4 series kept');
    expect(dropped).toMatch(/@SER4 +AXIAL/);
  });

  it('filters the held listing when nothing is piped, and -c counts without changing it', async () => {
    answer_note('pacs.query', answer, 'query PatientID:1');
    expect((await builtin_grep(['-c', '-i', 't1'])).rendered).toBe('2\n');
    expect(answer_get()?.source).toBe('query PatientID:1');
    const kept = await builtin_grep(['-i', 'flair']);
    expect(strip(kept.rendered)).toContain('PACS answer: query PatientID:1');
    expect(kept.model?.kind).toBe('pacs.query');
  });

  it('says so when nothing matched, as grep does (exit 1)', async () => {
    listingIn_set({ kind: 'pacs.query', data: answer });
    expect(strip((await builtin_grep(['zzz'])).rendered)).toContain('0 of 4 series kept');
    expect(process.exitCode).toBe(1);
  });

  it('refuses with nothing to filter, or no pattern', async () => {
    expect((await builtin_grep(['x'])).status).toBe('error');
    listingIn_set({ kind: 'pacs.query', data: answer });
    expect((await builtin_grep(['-i'])).status).toBe('error');
  });
});

describe('grep on text', () => {
  it('filters lines itself where the surface has no system grep, with the same flags', async () => {
    const { stdin_set } = await import('../src/builtins/games/stdin.js');
    stdin_set('alpha\nBeta\ngamma\n');
    expect((await builtin_grep(['-i', 'b'])).rendered).toBe('Beta\n');
    stdin_set('alpha\nBeta\ngamma\n');
    expect((await builtin_grep(['-vc', 'a'])).rendered).toBe('0\n');
  });
});
