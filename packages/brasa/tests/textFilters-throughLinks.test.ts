/**
 * @file The text filters and grep read a ChRIS file through a link: by the
 * graph's own address under `/proc/jobs` and by the feed path, the file read
 * is the one the link points at, and every name grep shows is the path as
 * typed, never the store path.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: async (): Promise<string> => '/home/alice' },
}));
jest.unstable_mockModule('../src/builtins/res/gather.store.js', () => ({
  cohort_read: async (): Promise<unknown> => ({ version: 1, name: null, feed: null, series: [] }),
}));

const { linkedStore_install, VIA_PROC, VIA_FEED, LINKED } = await import('./support/linkedStore.js');
const { builtin_wc, builtin_head } = await import('../src/builtins/sys/textFilters.js');
const { builtin_grep } = await import('../src/builtins/sys/grep.js');
const { shellWords_tokenize, shellWords_values } = await import('../src/lib/parser.js');

let store: ReturnType<typeof linkedStore_install>;

/** A grep line as the shell hands on its words after `grep`: they carry their quoting, so a wildcard globs. */
const line_grep = (line: string) => builtin_grep(shellWords_values(shellWords_tokenize(line).slice(1)));

beforeEach((): void => {
  store = linkedStore_install();
  process.exitCode = 0;
});

describe.each([['/proc/jobs', VIA_PROC], ['the feed path', VIA_FEED]])('a file through the link, by %s', (_by: string, via: string) => {
  const file: string = `${via}/hello.txt`;
  const deep: string = `${via}/inner/deep.txt`;

  it('grep reads the linked file, and names each file as typed when there are several', async () => {
    expect((await builtin_grep(['wor', file])).rendered).toBe('world\n');
    expect((await builtin_grep(['-c', 'o', file, deep])).rendered).toBe(`${file}:2\n${deep}:0\n`);
    expect(store.calls).toContain(`read ${LINKED}/hello.txt`);
    expect(process.exitCode).toBe(0);
  });

  it('grep -H names even one file as typed, and --color=never writes plain text', async () => {
    expect((await builtin_grep(['-H', '--color=never', 'wor', file])).rendered).toBe(`${file}:world\n`);
  });

  it('grep -n prefixes name:N:, -l names the files with a match, -h drops the names; never the store path', async () => {
    const numbered: string = (await builtin_grep(['-n', 'o', file, deep])).rendered;
    expect(numbered).toBe(`${file}:1:hello\n${file}:2:world\n`);
    expect(numbered).not.toContain(LINKED);
    expect((await builtin_grep(['-l', 'e', file, deep])).rendered).toBe(`${file}\n${deep}\n`);
    expect((await builtin_grep(['-h', 'e', file, deep])).rendered).toBe('hello\ndeep\n');
  });

  it('grep -r walks the folder through the link, each file named under the folder as typed', async () => {
    const walked: string = (await builtin_grep(['-r', 'e', via])).rendered;
    expect(walked).toBe(`${file}:hello\n${deep}:deep\n`);
    expect(walked).not.toContain(LINKED);
    expect(store.calls).toContain(`list ${LINKED}`);
  });

  it('grep -e takes every word as a file, and a wildcard among them globs', async () => {
    expect((await line_grep(`grep -e hel ${via}/*.txt`)).rendered).toBe('hello\n');
    expect((await line_grep(`grep -l -e hel -e wor ${via}/*.txt ${via}/inner/*.txt`)).rendered).toBe(`${file}\n`);
    expect(process.exitCode).toBe(0);
  });

  it('grep without -e still takes the first word as the pattern', async () => {
    expect((await line_grep(`grep wor ${via}/*.txt`)).rendered).toBe('world\n');
    expect((await builtin_grep(['zzz', file])).rendered).toBe('');
    expect(process.exitCode).toBe(1);
  });

  it('wc -c and head -1 read the linked file', async () => {
    expect((await builtin_wc(['-c', file])).rendered).toBe(`12 ${file}\n`);
    expect((await builtin_head(['-1', file])).rendered).toBe('hello\n');
    expect(store.calls.filter((call: string): boolean => call === `read ${LINKED}/hello.txt`)).toHaveLength(2);
  });
});

describe('grep -r with no folder named', () => {
  it('walks the working directory, names below it, and does not follow a link met on the way', async () => {
    expect((await builtin_grep(['-r', 'deep'])).rendered).toBe('uploads/set/inner/deep.txt:deep\n');
  });
});
