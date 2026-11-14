/**
 * @file The text filters and grep read a ChRIS file through a link: by the
 * graph's own address under `/proc/jobs` and by the feed path, the file read
 * is the one the link points at.
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

let store: ReturnType<typeof linkedStore_install>;

beforeEach((): void => {
  store = linkedStore_install();
  process.exitCode = 0;
});

describe.each([['/proc/jobs', VIA_PROC], ['the feed path', VIA_FEED]])('a file through the link, by %s', (_by: string, via: string) => {
  const file: string = `${via}/hello.txt`;

  it('grep reads the linked file, and names each file when there are several', async () => {
    expect((await builtin_grep(['wor', file])).rendered).toBe('world\n');
    expect((await builtin_grep(['-c', 'o', file, file])).rendered).toBe(`${file}:2\n${file}:2\n`);
    expect(store.calls).toContain(`read ${LINKED}/hello.txt`);
    expect(process.exitCode).toBe(0);
  });

  it('grep with -e reads the first word as a file, and says no match with exit 1', async () => {
    expect((await builtin_grep(['-e', 'hel', file])).rendered).toBe('hello\n');
    expect((await builtin_grep(['zzz', file])).rendered).toBe('');
    expect(process.exitCode).toBe(1);
  });

  it('wc -c and head -1 read the linked file', async () => {
    expect((await builtin_wc(['-c', file])).rendered).toBe(`12 ${file}\n`);
    expect((await builtin_head(['-1', file])).rendered).toBe('hello\n');
    expect(store.calls.filter((call: string): boolean => call === `read ${LINKED}/hello.txt`)).toHaveLength(2);
  });
});
