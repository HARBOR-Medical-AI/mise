/**
 * @file The text filters a pipe ends in (wc, head, tail, sort, uniq, cut):
 * POSIX's flags with POSIX's meanings, run in the kernel on what was piped in
 * or on ChRIS files; a flag not taken is refused by the parser.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const FILES: Record<string, string> = {
  '/home/chris/a.csv': 'id,name\n3,carol\n1,alice\n2,bob\n',
  '/home/chris/b.txt': 'one\ntwo\n',
};
jest.unstable_mockModule('../src/core/filesystem.js', () => ({
  vfsDispatcher_get: () => ({
    read: async (target: string) => (target in FILES ? { ok: true, value: FILES[target] } : { ok: false, errno: 'ENOENT' }),
  }),
}));
jest.unstable_mockModule('../src/builtins/utils.js', () => ({
  storePath_resolve: async (word: string): Promise<string> => (word.startsWith('/') ? word : `/home/chris/${word}`),
}));
const surface = {
  capabilities: { pipeSegments: false },
  pipeSegment: jest.fn(async (_line: string, input: Buffer): Promise<Buffer> => Buffer.from(`system:${input.toString('utf-8')}`)),
};
jest.unstable_mockModule('../src/core/surface.js', () => ({ surface_get: () => surface }));

const filters = await import('../src/builtins/sys/textFilters.js');
const { stdin_set } = await import('../src/builtins/games/stdin.js');
const { builtin_wc, builtin_head, builtin_tail, builtin_sort, builtin_uniq, builtin_cut } = filters;

/** Runs a filter on piped text. */
const piped = async (run: (args: string[]) => Promise<{ rendered: string; renderedErr?: string; status: string }>, text: string, args: string[]) => {
  stdin_set(text);
  return run(args);
};

beforeEach(() => { stdin_set(null); process.exitCode = 0; surface.capabilities.pipeSegments = false; surface.pipeSegment.mockClear(); });

describe('wc', () => {
  it('counts the pipe: one count alone is the bare number, as find … | wc -l needs', async () => {
    expect((await piped(builtin_wc, 'a b\nc\n', ['-l'])).rendered).toBe('2\n');
    expect((await piped(builtin_wc, 'a b\nc\n', [])).rendered).toBe('2 3 6\n');
    expect((await piped(builtin_wc, 'héllo\n', ['-cm'])).rendered).toBe('6 7\n');   // characters before bytes, as POSIX orders
  });

  it('counts ChRIS files by name, with a total, and says a file it cannot read', async () => {
    const both = await builtin_wc(['-l', 'a.csv', 'b.txt']);
    expect(both.rendered).toBe('4 a.csv\n2 b.txt\n6 total\n');
    const missing = await builtin_wc(['-l', 'nope.txt']);
    expect(missing.renderedErr).toContain('wc: nope.txt: ');
    expect(missing.status).toBe('error');
    expect(process.exitCode).toBe(1);
  });

  it('says what it needs when nothing is piped and no file is named', async () => {
    expect((await builtin_wc([])).renderedErr).toContain('wc: nothing to read: pipe text in, or name a file');
  });
});

describe('head and tail', () => {
  const ten = Array.from({ length: 12 }, (_v, i) => `l${i + 1}`).join('\n') + '\n';
  it('keep the first or last ten, -n N, -N, head -n -N and tail -n +N', async () => {
    expect((await piped(builtin_head, ten, [])).rendered.split('\n').length).toBe(11);
    expect((await piped(builtin_head, ten, ['-n', '2'])).rendered).toBe('l1\nl2\n');
    expect((await piped(builtin_head, ten, ['-3'])).rendered).toBe('l1\nl2\nl3\n');
    expect((await piped(builtin_head, ten, ['-n', '-10'])).rendered).toBe('l1\nl2\n');
    expect((await piped(builtin_tail, ten, ['-n2'])).rendered).toBe('l11\nl12\n');
    expect((await piped(builtin_tail, ten, ['-n', '+11'])).rendered).toBe('l11\nl12\n');
  });

  it('head several files under ==> name <==, and refuse a count that is not one', async () => {
    expect((await builtin_head(['-n', '1', 'a.csv', 'b.txt'])).rendered).toBe('==> a.csv <==\nid,name\n\n==> b.txt <==\none\n');
    expect((await piped(builtin_tail, ten, ['-n', 'x'])).renderedErr).toContain("tail: -n takes a number (+N: from line N), not 'x'");
  });
});

describe('sort, uniq and cut', () => {
  it('sort orders stably by line or by fields, numerically, reversed, unique', async () => {
    expect((await piped(builtin_sort, 'b\na\nc\n', [])).rendered).toBe('a\nb\nc\n');
    expect((await piped(builtin_sort, '10\n9\n100\n', ['-n'])).rendered).toBe('9\n10\n100\n');
    expect((await piped(builtin_sort, '10\n9\n100\n', ['-rn'])).rendered).toBe('100\n10\n9\n');
    expect((await builtin_sort(['-t', ',', '-k', '2', 'a.csv'])).rendered).toBe('1,alice\n2,bob\n3,carol\nid,name\n');
    expect((await piped(builtin_sort, 'B\na\nb\n', ['-fu'])).rendered).toBe('a\nB\n');
  });

  it('uniq folds runs, counts them, keeps only the repeated or the lone', async () => {
    const runs = 'a\na\nb\nc\nc\nc\n';
    expect((await piped(builtin_uniq, runs, [])).rendered).toBe('a\nb\nc\n');
    expect((await piped(builtin_uniq, runs, ['-c'])).rendered).toBe('      2 a\n      1 b\n      3 c\n');
    expect((await piped(builtin_uniq, runs, ['-d'])).rendered).toBe('a\nc\n');
    expect((await piped(builtin_uniq, runs, ['-u'])).rendered).toBe('b\n');
  });

  it('cut keeps fields or characters by LIST, and says what a list is', async () => {
    expect((await builtin_cut(['-d', ',', '-f', '2', 'a.csv'])).rendered).toBe('name\ncarol\nalice\nbob\n');
    expect((await piped(builtin_cut, 'a:b:c:d\nnone\n', ['-d:', '-f', '1,3-'])).rendered).toBe('a:c:d\nnone\n');
    expect((await piped(builtin_cut, 'a:b\nnone\n', ['-d:', '-sf2'])).rendered).toBe('b\n');
    expect((await piped(builtin_cut, 'abcdef\n', ['-c', '-2,5'])).rendered).toBe('abe\n');
    expect((await piped(builtin_cut, 'x\n', ['-f', 'two'])).renderedErr).toContain('cut: a list is N, N-M, N- or -M');
    expect((await piped(builtin_cut, 'x\n', [])).renderedErr).toContain('cut: say what to keep');
  });
});

describe('a flag the builtin does not take', () => {
  it('is refused by the parser, never handed to a system program (command sort asks for one)', async () => {
    surface.capabilities.pipeSegments = true;
    const refused = await piped(builtin_sort, 'b\na\n', ['-Q']);
    expect(refused.status).toBe('error');
    expect(refused.renderedErr).toContain("sort: invalid option -- 'Q'; usage: sort");
    expect(surface.pipeSegment).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('is refused the same on any surface, and with a ChRIS file', async () => {
    const browser = await piped(builtin_tail, 'a\n', ['-Q']);
    expect(browser.renderedErr).toContain("tail: invalid option -- 'Q'; usage: tail");
    surface.capabilities.pipeSegments = true;
    const file = await builtin_wc(['-L', 'a.csv']);
    expect(file.renderedErr).toContain("wc: invalid option -- 'L'; usage: wc");
    expect(surface.pipeSegment).not.toHaveBeenCalled();
  });
});

describe('the flags a person used, run in the kernel on every surface', () => {
  it('sort -h orders human sizes, -V versions, and refuses a mix', async () => {
    expect((await piped(builtin_sort, '1M\n2K\n3G\n10K\n', ['-h'])).rendered).toBe('2K\n10K\n1M\n3G\n');
    expect((await piped(builtin_sort, 'v10\nv2\nv1.10\nv1.9\n', ['--version-sort'])).rendered).toBe('v1.9\nv1.10\nv2\nv10\n');
    expect((await piped(builtin_sort, '1\n', ['-nh'])).renderedErr).toContain('sort: -n, -h and -V do not mix');
  });

  it('head -c and tail -c keep bytes: the first N, all but the last N, the last N, from byte N', async () => {
    expect((await piped(builtin_head, 'hello\n', ['-c', '3'])).rendered).toBe('hel');
    expect((await piped(builtin_head, 'hello\n', ['--bytes=-2'])).rendered).toBe('hell');
    expect((await piped(builtin_tail, 'hello\n', ['-c3'])).rendered).toBe('lo\n');
    expect((await piped(builtin_tail, 'hello\n', ['-c', '+2'])).rendered).toBe('ello\n');
    expect((await piped(builtin_head, 'hello\n', ['-n', '1', '-c', '1'])).renderedErr).toContain('head: -n and -c do not mix');
  });

  it('tail -f shows the last lines once and says it does not follow', async () => {
    const followed = await builtin_tail(['-f', '-n', '1', 'b.txt']);
    expect(followed.status).toBe('ok');
    expect(followed.rendered).toBe('two\n');
    expect(followed.renderedErr).toContain('tail: -f: a ChRIS file or a pipe is not followed');
    expect(process.exitCode).toBe(0);
  });

  it('uniq -i folds case', async () => {
    expect((await piped(builtin_uniq, 'a\nA\nb\n', ['-i'])).rendered).toBe('a\nb\n');
  });
});
