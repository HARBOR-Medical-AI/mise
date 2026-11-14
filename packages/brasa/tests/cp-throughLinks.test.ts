/**
 * @file `cp` through a link: a source read through a run's `.chrislink` is
 * what the link points at, and a destination through it lands in the link's
 * target, whether the path names the link by its feed path or by the
 * graph's own address under `/proc/jobs`. A target folder that refuses
 * writes fails the copy, and cp says so.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { VFSDispatcher } from '@fnndsc/fond';
import type { CommandEnvelope } from '@fnndsc/menu';

jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: async (): Promise<string> => '/home/alice' },
}));
jest.unstable_mockModule('@fnndsc/salsa', () => ({ context_getSingle: jest.fn() }));
jest.unstable_mockModule('@fnndsc/chili/models/listing.js', () => ({}));
// The listing cache is watched; the filesystem is the linked store the backend holds.
const mockInvalidate = jest.fn();
const mockInvalidateTree = jest.fn();
const held: { dispatcher_get: () => VFSDispatcher } = { dispatcher_get: (): VFSDispatcher => { throw new Error('no store installed'); } };
jest.unstable_mockModule('../src/core/filesystem.js', () => ({
  vfsDispatcher_get: (): VFSDispatcher => held.dispatcher_get(),
  listingCache_get: () => ({ cache_get: () => null, cache_set: () => undefined, cache_invalidate: mockInvalidate, cache_invalidateTree: mockInvalidateTree }),
  listingCache_holds: (): boolean => true,
}));

const { linkedStore_install, HOME, VIA_PROC, VIA_FEED, LINKED } = await import('./support/linkedStore.js');
const { backendInstalled_get } = await import('../src/core/backend.js');
const { builtin_cp } = await import('../src/builtins/fs/cp.js');
type LinkedStore = ReturnType<typeof linkedStore_install>;

held.dispatcher_get = (): VFSDispatcher => (backendInstalled_get() as unknown as { vfs: { dispatcher: VFSDispatcher } }).vfs.dispatcher;

let store: LinkedStore;
beforeEach((): void => {
  jest.clearAllMocks();
  process.exitCode = 0;
  store = linkedStore_install();
});

describe('cp through a link', () => {
  it.each([['the graph address', VIA_PROC], ['the feed path', VIA_FEED]])('copies from what the link points at, by %s', async (_how: string, link: string) => {
    const envelope: CommandEnvelope = await builtin_cp([`${link}/hello.txt`, `${HOME}/copy.txt`]);
    expect(envelope.status).toBe('ok');
    expect(store.calls).toContain(`cp ${LINKED}/hello.txt ${HOME}/copy.txt`);
    expect(store.entries.get(`${HOME}/copy.txt`)?.content).toBe('hello\nworld\n');
    // Said as it was asked.
    expect(envelope.rendered).toContain(`Copying ${link}/hello.txt to ${HOME}/copy.txt`);
  });

  it.each([['the graph address', VIA_PROC], ['the feed path', VIA_FEED]])('copies into the folder the link points at, by %s', async (_how: string, link: string) => {
    const named: CommandEnvelope = await builtin_cp([`${LINKED}/hello.txt`, `${link}/copy.txt`]);
    expect(named.status).toBe('ok');
    expect(store.entries.get(`${LINKED}/copy.txt`)?.content).toBe('hello\nworld\n');
    const into: CommandEnvelope = await builtin_cp([`${LINKED}/hello.txt`, `${link}/inner`]);
    expect(into.status).toBe('ok');
    expect(store.entries.get(`${LINKED}/inner/hello.txt`)?.content).toBe('hello\nworld\n');
    // Nothing was written at the link's own address.
    expect([...store.entries.keys()].some((key: string): boolean => key.startsWith(`${VIA_FEED}/`))).toBe(false);
  });

  it('forgets the listings of the destination by both its names', async () => {
    await builtin_cp([`${LINKED}/hello.txt`, `${VIA_PROC}/copy.txt`]);
    expect(mockInvalidateTree).toHaveBeenCalledWith(`${VIA_PROC}/copy.txt`);
    expect(mockInvalidateTree).toHaveBeenCalledWith(`${LINKED}/copy.txt`);
    expect(mockInvalidate).toHaveBeenCalledWith(VIA_PROC);
    expect(mockInvalidate).toHaveBeenCalledWith(LINKED);
  });

  it.each([['the graph address', VIA_PROC], ['the feed path', VIA_FEED]])('fails, and says so, when the target folder refuses the write, by %s', async (_how: string, link: string) => {
    store.refusing.add(LINKED);
    const envelope: CommandEnvelope = await builtin_cp([`${LINKED}/hello.txt`, `${link}/copy.txt`]);
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toMatch(/^.*cp: /m);
    expect(envelope.renderedErr).toContain('ermission denied');
    expect(store.entries.has(`${LINKED}/copy.txt`)).toBe(false);
  });
});
