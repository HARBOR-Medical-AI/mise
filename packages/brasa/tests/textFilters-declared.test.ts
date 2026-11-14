/**
 * @file The text filters and grep as declared commands: a flag not taken is
 * refused by the parser before the handler runs, `-5` is `-n 5`, long
 * options take `=value`, `--` ends the options, and grep's system line is
 * written back from the typed options.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const FILES: Record<string, string> = {
  '/home/chris/-n': 'dash\n',
  '/home/chris/ten.txt': `${Array.from({ length: 12 }, (_v: unknown, i: number): string => `l${i + 1}`).join('\n')}\n`,
};
jest.unstable_mockModule('../src/core/filesystem.js', () => ({
  vfsDispatcher_get: () => ({
    read: async (target: string) => (target in FILES ? { ok: true, value: FILES[target] } : { ok: false, errno: 'ENOENT' }),
  }),
}));
jest.unstable_mockModule('../src/builtins/utils.js', () => ({
  storePath_resolve: async (word: string): Promise<string> => (word.startsWith('/') ? word : `/home/chris/${word}`),
}));
jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: async (): Promise<string> => '/home/chris' },
}));
jest.unstable_mockModule('../src/builtins/res/gather.store.js', () => ({
  cohort_read: async (): Promise<unknown> => ({ version: 1, name: null, feed: null, series: [] }),
}));
const surface = {
  capabilities: { pipeSegments: false },
  pipeSegment: jest.fn(async (_line: string, input: Buffer): Promise<Buffer> => Buffer.from(`system:${input.toString('utf-8')}`)),
};
jest.unstable_mockModule('../src/core/surface.js', () => ({ surface_get: () => surface }));

const { builtin_head, builtin_tail, builtin_sort, builtin_uniq, builtin_cut, builtin_wc } = await import('../src/builtins/sys/textFilters.js');
const { builtin_grep } = await import('../src/builtins/sys/grep.js');
const { stdin_set } = await import('../src/builtins/games/stdin.js');

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');
const twelve: string = FILES['/home/chris/ten.txt'] as string;

beforeEach(() => { stdin_set(null); process.exitCode = 0; surface.capabilities.pipeSegments = false; surface.pipeSegment.mockClear(); });

describe('a flag a filter does not take', () => {
  it('is refused in the parser\'s words, exit 1, before anything is read', async () => {
    stdin_set('a\n');
    const short = await builtin_head(['-q']);
    expect(short.status).toBe('error');
    expect(strip(short.renderedErr ?? '')).toContain("head: invalid option -- 'q'; usage: head");
    expect(process.exitCode).toBe(1);
    expect(strip((await builtin_cut(['--nosuch', '-f', '1'])).renderedErr ?? '')).toContain("cut: unrecognized option '--nosuch'; usage: cut");
  });

  it('refuses a value the handler does not take, in its own words', async () => {
    stdin_set('a b\n');
    expect(strip((await builtin_sort(['-k2n'])).renderedErr ?? '')).toContain("sort: -k takes whole fields, N or N,M, not '2n'");
    stdin_set('a b\n');
    expect(strip((await builtin_sort(['-k2n'])).renderedErr ?? '')).toContain('command sort');
    stdin_set('a b\n');
    expect(strip((await builtin_sort(['-t', '::'])).renderedErr ?? '')).toContain("sort: -t takes one character, not '::'");
    stdin_set('a\n');
    expect(strip((await builtin_cut(['-f', '1', '-c', '2'])).renderedErr ?? '')).toContain('cut: only one of -f, -c or -b');
    stdin_set('a\n');
    expect(strip((await builtin_head(['-n', '+3'])).renderedErr ?? '')).toContain("head: -n takes a number (-N: all but the last N), not '+3'");
  });

  it('refuses uniq\'s second operand (an output file) as the grammar does', async () => {
    const two = await builtin_uniq(['ten.txt', 'out.txt']);
    expect(strip(two.renderedErr ?? '')).toContain("uniq: unexpected operand 'out.txt'; usage: uniq");
  });
});

describe('typed options', () => {
  it('reads -5 as -n 5, for head and tail', async () => {
    expect((await builtin_head(['-2', 'ten.txt'])).rendered).toBe('l1\nl2\n');
    expect((await builtin_tail(['-2', 'ten.txt'])).rendered).toBe('l11\nl12\n');
  });

  it('takes --lines=3 and --lines 3, and still -n -N and -n +N', async () => {
    stdin_set(twelve);
    expect((await builtin_head(['--lines=3'])).rendered).toBe('l1\nl2\nl3\n');
    stdin_set(twelve);
    expect((await builtin_tail(['--lines', '1'])).rendered).toBe('l12\n');
    stdin_set(twelve);
    expect((await builtin_head(['-n', '-10'])).rendered).toBe('l1\nl2\n');
    stdin_set(twelve);
    expect((await builtin_tail(['-n', '+12'])).rendered).toBe('l12\n');
  });

  it('takes long options with their values, and switches bundled', async () => {
    stdin_set('b,2\na,1\n');
    expect((await builtin_sort(['--field-separator=,', '--key', '2', '-r'])).rendered).toBe('b,2\na,1\n');
    stdin_set('a:b\n');
    expect((await builtin_cut(['--delimiter=:', '--fields=2'])).rendered).toBe('b\n');
    stdin_set('a b\n');
    expect((await builtin_wc(['--words', '--lines'])).rendered).toBe('1 2\n');
  });
});

describe('-- ends the options', () => {
  it('makes a dash-word a file', async () => {
    expect((await builtin_head(['-n', '1', '--', '-n'])).rendered).toBe('dash\n');
    expect((await builtin_wc(['-l', '--', '-n'])).rendered).toBe('1 -n\n');
  });
});

describe('grep\'s system line', () => {
  it('is written back from the typed options, never the raw words', async () => {
    surface.capabilities.pipeSegments = true;
    stdin_set('alpha\nbeta\n');
    const out = await builtin_grep(['-vi', '--regexp=a', '-eb']);
    expect(surface.pipeSegment).toHaveBeenCalledWith('grep -i -v -e a -e b', Buffer.from('alpha\nbeta\n'));
    expect(out.rendered).toBe('system:alpha\nbeta\n');
    stdin_set('x\n');
    await builtin_grep(['-c', '--', '-x y']);
    expect(surface.pipeSegment).toHaveBeenLastCalledWith("grep -c -e '-x y'", Buffer.from('x\n'));
  });
});
