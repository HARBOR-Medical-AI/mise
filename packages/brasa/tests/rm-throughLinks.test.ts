/**
 * @file `rm` through a link: a path past a `.chrislink`, by the feed path or
 * by the graph's own address, removes what the link points at; the link
 * itself, named as the operand, is removed as the entry it is, and what it
 * points at stays.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: async (): Promise<string> => '/home/alice' },
}));

const { linkedStore_install, VIA_PROC, VIA_FEED, LINKED } = await import('./support/linkedStore.js');
const { builtin_rm } = await import('../src/builtins/fs/rm.js');

type LinkedStore = ReturnType<typeof linkedStore_install>;

let store: LinkedStore;

beforeEach((): void => {
  store = linkedStore_install();
});

describe('rm through a link', () => {
  it.each([[VIA_PROC], [VIA_FEED]])('removes the file in the link\'s target (%s)', async (via: string) => {
    const envelope = await builtin_rm([`${via}/hello.txt`]);
    expect(envelope.status).toBe('ok');
    expect(store.entries.has(`${LINKED}/hello.txt`)).toBe(false);
    expect(store.calls).toContain(`rm ${LINKED}/hello.txt`);
  });

  it.each([[VIA_PROC], [VIA_FEED]])('removes a folder in the link\'s target with -r (%s)', async (via: string) => {
    const envelope = await builtin_rm(['-r', `${via}/inner`]);
    expect(envelope.status).toBe('ok');
    expect(store.entries.has(`${LINKED}/inner`)).toBe(false);
    expect(store.entries.has(`${LINKED}/inner/deep.txt`)).toBe(false);
  });

  it.each([[VIA_PROC], [VIA_FEED]])('fails, and says so, when the target folder refuses (%s)', async (via: string) => {
    store.refusing.add(LINKED);
    const envelope = await builtin_rm([`${via}/hello.txt`]);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain(`rm: cannot remove '${via}/hello.txt': Permission denied`);
    expect(store.entries.has(`${LINKED}/hello.txt`)).toBe(true);
  });

  it.each([[VIA_PROC], [VIA_FEED]])('removes the link itself, never what it points at, with -r (%s)', async (via: string) => {
    const envelope = await builtin_rm(['-r', via]);
    expect(envelope.status).toBe('ok');
    expect(store.entries.has(VIA_FEED)).toBe(false);
    expect(store.calls).toContain(`rm ${VIA_FEED}`);
    expect(store.entries.has(LINKED)).toBe(true);
    expect(store.entries.has(`${LINKED}/hello.txt`)).toBe(true);
  });
});
