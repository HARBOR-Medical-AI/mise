/**
 * @file Completion of a CFS path: the folder a partial names, listed through
 * the session's filesystem or its cache, in the partial's own style.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockList = jest.fn(async (_folder: string): Promise<unknown> => ({ ok: true, value: [] }));
const cached: Map<string, unknown> = new Map();
const mockCacheSet = jest.fn((folder: string, items: unknown): void => { cached.set(folder, items); });
jest.unstable_mockModule('../src/core/filesystem.js', () => ({
  vfsDispatcher_get: () => ({ list: mockList }),
  listingCache_get: () => ({
    cache_get: (folder: string) => (cached.has(folder) ? { data: cached.get(folder), fresh: true } : null),
    cache_set: mockCacheSet,
  }),
}));
jest.unstable_mockModule('../src/session/index.js', () => ({ session: { getCWD: async (): Promise<string> => '/home/u/uploads' } }));

const { cfsPaths_complete } = await import('../src/lib/completer/cfsPaths.js');
const { backend_install } = await import('../src/core/backend.js');

/** A folder entry, as the filesystem lists it. */
const entry = (name: string, type: string): Record<string, unknown> => ({ name, type, size: 0, owner: 'u', date: '' });

beforeEach(() => {
  cached.clear();
  mockList.mockReset();
  mockList.mockResolvedValue({ ok: true, value: [] });
  backend_install({ id: 'test', session: { home_get: async (): Promise<string> => '/home/u' } as never, completion: { rootWords: ['bin', 'usr'] } });
});

describe('cfsPaths_complete', () => {
  it('lists the folder a partial names, a folder ending in /, and keeps the listing', async () => {
    mockList.mockResolvedValueOnce({ ok: true, value: [entry('feeds', 'dir'), entry('notes.txt', 'file'), entry('uploads', 'dir')] });
    expect(await cfsPaths_complete('/home/u/')).toEqual(['/home/u/feeds/', '/home/u/notes.txt', '/home/u/uploads/']);
    expect(mockList).toHaveBeenCalledWith('/home/u/');
    expect(await cfsPaths_complete('/home/u/f')).toEqual([]);
    expect(mockCacheSet).toHaveBeenCalledTimes(1);
  });

  it('answers from the cache when the folder is kept', async () => {
    cached.set('/home/u', [entry('feeds', 'dir')]);
    expect(await cfsPaths_complete('/home/u/f')).toEqual(['/home/u/feeds/']);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('reads ~ as the session\'s home and keeps the tilde in what it offers', async () => {
    mockList.mockResolvedValue({ ok: true, value: [entry('uploads', 'dir')] });
    expect(await cfsPaths_complete('~/up')).toEqual(['~/uploads/']);
    expect(mockList).toHaveBeenLastCalledWith('/home/u');
    expect(await cfsPaths_complete('~/')).toEqual(['~/uploads/']);
  });

  it('reads a relative path from the working directory', async () => {
    mockList.mockResolvedValue({ ok: true, value: [entry('sub-01', 'dir')] });
    expect(await cfsPaths_complete('sub')).toEqual(['sub-01/']);
    expect(mockList).toHaveBeenLastCalledWith('/home/u/uploads');
    expect(await cfsPaths_complete('scans/s')).toEqual(['scans/sub-01/']);
    expect(mockList).toHaveBeenLastCalledWith('/home/u/uploads/scans');
  });

  it('offers the backend\'s root words at / even when the root lists none of them', async () => {
    mockList.mockResolvedValue({ ok: true, value: [entry('home', 'dir')] });
    expect(await cfsPaths_complete('/')).toEqual(['/home/', '/bin/', '/usr/']);
  });

  it('completes nothing for a folder that cannot be listed', async () => {
    mockList.mockResolvedValueOnce({ ok: false });
    expect(await cfsPaths_complete('/nope/x')).toEqual([]);
    mockList.mockRejectedValueOnce(new Error('denied'));
    expect(await cfsPaths_complete('/denied/x')).toEqual([]);
  });
});
