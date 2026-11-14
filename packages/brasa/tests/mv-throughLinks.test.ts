/**
 * @file `mv` through a link: an entry behind a run's `.chrislink` is moved
 * where the link points, and a destination through it lands in the link's
 * target, whether the path names the link by its feed path or by the
 * graph's own address under `/proc/jobs`. Moving the link itself moves the
 * link, never what it points at. A folder that refuses writes fails the
 * move, and mv says so.
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

const { linkedStore_install, HOME, OUTPUT, VIA_PROC, VIA_FEED, LINKED } = await import('./support/linkedStore.js');
const { backendInstalled_get } = await import('../src/core/backend.js');
const { builtin_mv } = await import('../src/builtins/fs/mv.js');
type LinkedStore = ReturnType<typeof linkedStore_install>;

held.dispatcher_get = (): VFSDispatcher => (backendInstalled_get() as unknown as { vfs: { dispatcher: VFSDispatcher } }).vfs.dispatcher;

let store: LinkedStore;
beforeEach((): void => {
  jest.clearAllMocks();
  process.exitCode = 0;
  store = linkedStore_install();
});

describe('mv through a link', () => {
  it.each([['the graph address', VIA_PROC], ['the feed path', VIA_FEED]])('moves an entry from the folder the link points at, by %s', async (_how: string, link: string) => {
    const envelope: CommandEnvelope = await builtin_mv([`${link}/hello.txt`, `${HOME}/moved.txt`]);
    expect(envelope.status).toBe('ok');
    expect(store.calls).toContain(`rename ${LINKED}/hello.txt ${HOME}/moved.txt`);
    expect(store.entries.get(`${HOME}/moved.txt`)?.content).toBe('hello\nworld\n');
    expect(store.entries.has(`${LINKED}/hello.txt`)).toBe(false);
    // Said as it was asked.
    expect(envelope.rendered).toContain(`Moving ${link}/hello.txt to ${HOME}/moved.txt`);
  });

  it.each([['the graph address', VIA_PROC], ['the feed path', VIA_FEED]])('moves into the folder the link points at, by %s', async (_how: string, link: string) => {
    const into: CommandEnvelope = await builtin_mv([`${LINKED}/hello.txt`, `${link}/inner`]);
    expect(into.status).toBe('ok');
    expect(store.entries.get(`${LINKED}/inner/hello.txt`)?.content).toBe('hello\nworld\n');
    const named: CommandEnvelope = await builtin_mv([`${LINKED}/inner/deep.txt`, `${link}/renamed.txt`]);
    expect(named.status).toBe('ok');
    expect(store.entries.get(`${LINKED}/renamed.txt`)?.content).toBe('deep\n');
    // Nothing was written at the link's own address.
    expect([...store.entries.keys()].some((key: string): boolean => key.startsWith(`${VIA_FEED}/`))).toBe(false);
  });

  it.each([['the graph address', VIA_PROC], ['the feed path', VIA_FEED]])('moves the link itself, not what it points at, by %s', async (_how: string, link: string) => {
    const envelope: CommandEnvelope = await builtin_mv([link, `${HOME}/kept`]);
    expect(envelope.status).toBe('ok');
    expect(store.calls).toContain(`rename ${VIA_FEED} ${HOME}/kept`);
    expect(store.entries.get(`${HOME}/kept`)).toEqual({ type: 'link', target: LINKED });
    expect(store.entries.has(VIA_FEED)).toBe(false);
    expect(store.entries.get(LINKED)?.type).toBe('dir');
    expect(store.entries.has(`${LINKED}/hello.txt`)).toBe(true);
  });

  it('forgets the listings of source and destination by both their names', async () => {
    await builtin_mv([`${VIA_PROC}/hello.txt`, `${VIA_PROC}/inner`]);
    expect(mockInvalidate).toHaveBeenCalledWith(VIA_PROC);
    expect(mockInvalidate).toHaveBeenCalledWith(LINKED);
    expect(mockInvalidateTree).toHaveBeenCalledWith(`${VIA_PROC}/hello.txt`);
    expect(mockInvalidateTree).toHaveBeenCalledWith(`${LINKED}/hello.txt`);
    expect(mockInvalidateTree).toHaveBeenCalledWith(`${VIA_PROC}/inner`);
    expect(mockInvalidateTree).toHaveBeenCalledWith(`${LINKED}/inner`);
    // The link itself, moved: its folder is the run's output.
    jest.clearAllMocks();
    await builtin_mv([VIA_PROC, `${HOME}/kept`]);
    expect(mockInvalidate).toHaveBeenCalledWith(OUTPUT);
  });

  it.each([['the graph address', VIA_PROC], ['the feed path', VIA_FEED]])('fails, and says so, when the folder refuses the write, by %s', async (_how: string, link: string) => {
    store.refusing.add(LINKED);
    const from: CommandEnvelope = await builtin_mv([`${link}/hello.txt`, `${HOME}/moved.txt`]);
    expect(from.status).toBe('error');
    expect(from.renderedErr).toContain('mv: ');
    expect(from.renderedErr).toContain('ermission denied');
    expect(store.entries.has(`${LINKED}/hello.txt`)).toBe(true);
    store.entries.set(`${HOME}/new.txt`, { type: 'file', content: 'new\n' });
    const into: CommandEnvelope = await builtin_mv([`${HOME}/new.txt`, `${link}/new.txt`]);
    expect(into.status).toBe('error');
    expect(into.renderedErr).toContain('ermission denied');
    expect(store.entries.has(`${HOME}/new.txt`)).toBe(true);
  });
});
