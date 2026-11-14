/**
 * @file `cat` through a link: a file behind a run's `.chrislink` is read
 * where the link points, whether the path names the link by its feed path
 * or by the graph's own address under `/proc/jobs`.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { CommandEnvelope } from '@fnndsc/menu';

jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: async (): Promise<string> => '/home/alice' },
}));

const { linkedStore_install, VIA_PROC, VIA_FEED, LINKED } = await import('./support/linkedStore.js');
const { builtin_cat } = await import('../src/builtins/fs/cat.js');
type LinkedStore = ReturnType<typeof linkedStore_install>;

let store: LinkedStore;
beforeEach((): void => {
  process.exitCode = 0;
  store = linkedStore_install();
});

describe('cat through a link', () => {
  it.each([['the graph address', VIA_PROC], ['the feed path', VIA_FEED]])('reads the file where the link points, by %s', async (_how: string, link: string) => {
    const envelope: CommandEnvelope = await builtin_cat(['--no-highlight', `${link}/hello.txt`]);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toBe('hello\nworld\n');
    expect(store.calls).toContain(`read ${LINKED}/hello.txt`);
  });
});
