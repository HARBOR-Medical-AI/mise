import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

const mockDispatcherList = jest.fn();
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  plugins_listAll: jest.fn(),
  vfsDispatcher: { list: mockDispatcherList },
  pathMapper_get: () => ({ blindParents_take: mockBlindParentsTake }),
}));

const mockGetCWD = jest.fn(async () => '/home/chris');
jest.unstable_mockModule('../src/session/index.js', () => ({ session: { getCWD: mockGetCWD } }));

interface CacheEntry { data: unknown; fresh: boolean }
const cacheStore: Map<string, CacheEntry> = new Map();
const mockCacheSet = jest.fn((key: string, data: unknown) => { cacheStore.set(key, { data, fresh: true }); });
const mockCacheInvalidate = jest.fn((key: string) => { cacheStore.delete(key); });
const mockStackPush = jest.fn();
const mockCheckpointDrain = jest.fn((_mark: number): unknown[] => []);
const mockStackSearch = jest.fn<(needle: string) => string[]>(() => []);
const mockFeedTagsByFeed = jest.fn(async (): Promise<{ ok: boolean; value?: Map<number, string[]> }> => ({ ok: true, value: new Map() }));
const mockGridRender = jest.fn(() => 'GRID');
const mockLongRender = jest.fn(() => 'LONG');
const mockApplySort = jest.fn((items: unknown) => items);
cuminMock_install(() => ({
  feedTags_readByFeed: mockFeedTagsByFeed,
  envelope_ok: (rendered: string) => ({ status: 'ok', rendered }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
  listCache_get: () => ({
    cache_get: (key: string): CacheEntry | undefined => cacheStore.get(key),
    cache_set: mockCacheSet,
    cache_invalidate: mockCacheInvalidate,
  }),
  Ok: <T>(value: T) => ({ ok: true as const, value }),
  Err: () => ({ ok: false as const }),
  errorStack: {
    stack_search: (needle: string) => mockStackSearch(needle),
    stack_push: mockStackPush,
    stack_pop: jest.fn(() => ({ message: 'listing failed' })),
    checkpoint_mark: jest.fn(() => 0),
    checkpoint_drain: (mark: number) => mockCheckpointDrain(mark),
    scope_run: (fn: () => unknown) => fn(),
  },
}), { fond: { grid_render: mockGridRender, long_render: mockLongRender, listingItems_sort: mockApplySort } });

jest.unstable_mockModule('@fnndsc/chili/models/listing.js', () => ({}));
const mockBlindParentsTake = jest.fn((): string[] => []);

const mockSpinner = { start: jest.fn(), stop: jest.fn(), updateMessage: jest.fn() };
jest.unstable_mockModule('../src/lib/spinner.js', () => ({ spinner: mockSpinner }));
jest.unstable_mockModule('../src/builtins/utils.js', () => ({
  error_stripDebugPrefix: (s: string): string => s,
}));

const ok = <T>(value: T) => ({ ok: true as const, value });
const err = () => ({ ok: false as const });

const { VFS } = await import('../src/lib/vfs/vfs.js');
await (await import('./support/chrisPieces.js')).chrisPieces_install({ vfs: true });
// No backend is installed here, so a listing shows with the core's plain look.
const { LISTING_LOOK_PLAIN } = await import('@fnndsc/fond');

const item = (name: string) => ({ name, type: 'dir', size: 0, owner: 'chris', date: '' });

let logSpy: jest.SpiedFunction<typeof console.log>;
let errSpy: jest.SpiedFunction<typeof console.error>;
beforeEach(() => {
  jest.clearAllMocks();
  cacheStore.clear();
  mockGetCWD.mockResolvedValue('/home/chris');
  mockApplySort.mockImplementation((items: unknown) => items);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
});

describe('VFS.data_get caching', () => {
  it('serves a cache hit through the sorter without dispatching', async () => {
    cacheStore.set('/home/chris/data', { data: [item('a')], fresh: true });
    const result = await new VFS().data_get('data', { sort: 'size', reverse: true });
    expect(result.ok).toBe(true);
    expect(mockApplySort).toHaveBeenCalledWith([item('a')], 'size', true);
    expect(mockDispatcherList).not.toHaveBeenCalled();
  });

  it('fetches on a cache miss and populates the cache', async () => {
    mockDispatcherList.mockResolvedValue(ok([item('b')]));
    const result = await new VFS().data_get('/data');
    expect(result.ok).toBe(true);
    expect(mockCacheSet).toHaveBeenCalledWith('/data', [item('b')]);
  });

  it('bypasses the cache for /proc paths', async () => {
    cacheStore.set('/proc/status', { data: [item('stale')], fresh: true });
    mockDispatcherList.mockResolvedValue(ok([item('live')]));
    const result = await new VFS().data_get('/proc/status');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0].name).toBe('live');
    expect(mockCacheSet).not.toHaveBeenCalled();
  });

  it('returns a cached parent leaf when listing an expanded /bin match', async () => {
    const plugin = { name: 'pl-dircopy-v2.1.2', type: 'plugin', size: 0, owner: 'system', date: '' };
    cacheStore.set('/bin', { data: [plugin], fresh: true });
    mockDispatcherList.mockResolvedValue(ok([]));

    const result = await new VFS().data_get('/bin/pl-dircopy-v2.1.2');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([plugin]);
    expect(mockDispatcherList).not.toHaveBeenCalled();
  });

  it('still descends into directories found in a cached parent listing', async () => {
    cacheStore.set('/home/chris', { data: [item('data')], fresh: true });
    mockDispatcherList.mockResolvedValue(ok([item('child')]));

    const result = await new VFS().data_get('/home/chris/data');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([item('child')]);
    expect(mockDispatcherList).toHaveBeenCalledWith('/home/chris/data', {});
  });

  it('names a file operand from its parent when the file will not list as a folder (ls FILE, cold)', async () => {
    const file = { name: 'hello.txt', type: 'file', size: 5, owner: 'chris', date: '' };
    mockDispatcherList.mockImplementation(async (target: string) => (target === '/home/chris' ? ok([file]) : err()));
    const listing = await new VFS().data_get('/home/chris/hello.txt');
    expect(listing).toEqual({ ok: true, value: [file] });
    expect(mockCacheSet).toHaveBeenCalledWith('/home/chris', [file]);
  });

  it('still fails a path its parent does not hold, and never answers a folder that will not list', async () => {
    mockDispatcherList.mockImplementation(async (target: string) => (target === '/home/chris' ? ok([{ name: 'gone', type: 'dir', size: 0, owner: 'chris', date: '' }]) : err()));
    expect((await new VFS().data_get('/home/chris/missing.txt')).ok).toBe(false);
    expect((await new VFS().data_get('/home/chris/gone')).ok).toBe(false);
  });

  it('propagates dispatcher failures and wraps thrown errors', async () => {
    mockDispatcherList.mockResolvedValue(err());
    expect((await new VFS().data_get('/data')).ok).toBe(false);

    mockGetCWD.mockRejectedValue(new Error('no session'));
    expect((await new VFS().data_get()).ok).toBe(false);
    expect(mockStackPush).toHaveBeenCalledWith('error', expect.stringContaining('no session'));
  });
});

describe('VFS.data_get -d (directory entry)', () => {
  it('returns the root marker for /', async () => {
    const root = await new VFS().data_get('/', { directory: true });
    expect(root.ok).toBe(true);
    if (root.ok) expect(root.value[0].name).toBe('/');
  });

  it('finds the entry in a cached parent listing', async () => {
    cacheStore.set('/home/chris', { data: [item('data'), item('other')], fresh: true });
    const matched = await new VFS().data_get('/home/chris/data', { directory: true });
    expect(matched.ok).toBe(true);
    if (matched.ok) expect(matched.value).toEqual([item('data')]);
  });

  it('fetches the parent listing when uncached and caches it', async () => {
    mockDispatcherList.mockResolvedValue(ok([item('data')]));
    const result = await new VFS().data_get('/home/chris/data', { directory: true });
    expect(result.ok).toBe(true);
    expect(mockDispatcherList).toHaveBeenCalledWith('/home/chris', expect.anything());
    expect(mockCacheSet).toHaveBeenCalledWith('/home/chris', [item('data')]);
  });

  it('leaves nothing on the error stack from a parent it read only to find one name', async () => {
    mockDispatcherList.mockResolvedValue(ok([item('jobs', 'vfs')]));
    const jobs = await new VFS().data_get('/proc/jobs', { directory: true });
    expect(jobs.ok).toBe(true);
    expect(mockCheckpointDrain).toHaveBeenCalled();
  });

  it('answers a folder the parent does not name when it lists, as a mount does', async () => {
    mockDispatcherList.mockResolvedValue(ok([item('unrelated')]));
    const mount = await new VFS().data_get('/home/chris/mounted', { directory: true });
    expect(mount.ok).toBe(true);
    if (mount.ok) expect(mount.value[0]).toMatchObject({ name: 'mounted', type: 'dir', owner: 'system' });
  });

  it('says a path neither its parent names nor lists is not there, rather than making a folder up', async () => {
    mockDispatcherList.mockImplementation(async (target: string) => (target === '/home/chris' ? ok([item('unrelated')]) : err()));
    const ghost = await new VFS().data_get('/home/chris/ghost', { directory: true });
    expect(ghost.ok).toBe(false);
    expect(mockStackPush).toHaveBeenCalledWith('error', 'Cannot list /home/chris/ghost: No such file or directory');
  });
});

describe('VFS.list rendering and refresh', () => {
  it('renders a grid by default and long format with --long', async () => {
    cacheStore.set('/home/chris', { data: [item('a')], fresh: true });
    const grid = await new VFS().list();
    expect(grid.rendered).toContain('GRID');

    const long = await new VFS().list(undefined, { long: true, human: true });
    expect(long.rendered).toContain('LONG');
    expect(mockLongRender).toHaveBeenCalledWith([item('a')], { human: true }, LISTING_LOOK_PLAIN);
  });

  it('renders nothing for an empty listing', async () => {
    cacheStore.set('/home/chris', { data: [], fresh: true });
    const envelope = await new VFS().list();
    expect(envelope.rendered).toBe('');
  });

  it('says what a listing could not read, and still shows what it read', async () => {
    // The provider names the refused sub-listing; that reason travels with
    // the answer instead of being dropped for looking like success (#462).
    cacheStore.set('/home/chris', { data: [item('a')], fresh: true });
    mockStackSearch.mockReturnValue([
      'error: Cannot fully list /home/chris: could not read files (Internal server error)',
    ]);
    const envelope = await new VFS().list();
    expect(envelope.rendered).toContain('GRID');
    expect(envelope.renderedErr).toContain('could not read files');
    expect(envelope.status).toBe('error');
  });

  it('says so even when nothing at all could be read', async () => {
    cacheStore.set('/home/chris', { data: [], fresh: true });
    mockStackSearch.mockReturnValue([
      'error: Cannot fully list /home/chris: could not read files (Internal server error)',
    ]);
    const envelope = await new VFS().list();
    expect(envelope.renderedErr).toContain('could not read files');
  });

  it('reports errors from the stack', async () => {
    mockDispatcherList.mockResolvedValue(err());
    const envelope = await new VFS().list('/nope');
    expect(envelope.renderedErr).toContain('listing failed');
  });

  it('names a parent whose links the walk could not read when the listing fails', async () => {
    mockDispatcherList.mockResolvedValue(err());
    mockBlindParentsTake.mockReturnValueOnce([]).mockReturnValueOnce(['/home/owner']);
    const envelope = await new VFS().list('/home/owner/feeds/feed_1');
    expect(envelope.renderedErr).toContain('listing failed');
    expect(envelope.renderedErr).toContain("links in '/home/owner' could not be read");
  });

  it('says nothing of an unreadable parent when the listing succeeds', async () => {
    mockStackSearch.mockReturnValue([]);
    mockDispatcherList.mockResolvedValue(ok([item('a')]));
    mockBlindParentsTake.mockReturnValueOnce([]).mockReturnValueOnce(['/home/owner']);
    const envelope = await new VFS().list('/home/owner/feeds/feed_1');
    expect(envelope.status).toBe('ok');
    expect(envelope.renderedErr ?? '').not.toContain('/home/owner');
  });

  it('at a plain console a stale entry is refetched in line: fresh answer, no indicator', async () => {
    cacheStore.set('/home/chris', { data: [item('old')], fresh: false });
    mockDispatcherList.mockResolvedValue(ok([item('new')]));
    const envelope = await new VFS().list();
    expect(envelope.rendered).not.toContain('(cached, refreshing...)');
    expect(mockDispatcherList).toHaveBeenCalledWith('/home/chris', expect.anything());
    expect(mockCacheSet).toHaveBeenCalledWith('/home/chris', [item('new')]);
  });

  it('with a host listening a stale entry is served at once, marked, and revalidated onto the ambient bus', async () => {
    const { ambient_listen } = await import('../src/core/ambient.js');
    const events: unknown[] = [];
    const stop = ambient_listen((event) => { events.push(event); });
    try {
      cacheStore.set('/home/chris', { data: [item('old')], fresh: false });
      mockDispatcherList.mockResolvedValue(ok([item('new')]));
      const vfs = new VFS();
      const envelope = await vfs.list();
      expect(envelope.rendered).toContain('(cached, refreshing...)');
      for (let i = 0; i < 5; i++) await new Promise((r: (v: unknown) => void) => setImmediate(r));
      // The revalidation landed: the next read is fresh and says so.
      const listing = await vfs.listing_get();
      expect(listing.ok && listing.value).toMatchObject({ path: '/home/chris', fresh: true });
      expect(listing.ok && listing.value.items).toEqual([item('new')]);
      expect(mockCacheSet).toHaveBeenCalledWith('/home/chris', [item('new')]);
      expect(events).toEqual([{
        kind: 'envelope',
        envelope: { status: 'ok', rendered: '', model: { kind: 'fs.listing', data: [{ path: '/home/chris', items: [item('new')], fresh: true }] } },
      }]);
    } finally {
      stop();
    }
  });

  it('shows a spinner when a cache miss takes longer than 500ms', async () => {
    jest.useFakeTimers();
    let resolveList: (v: unknown) => void = () => undefined;
    mockDispatcherList.mockReturnValue(new Promise((r: (v: unknown) => void) => { resolveList = r; }));
    const pending: Promise<void> = new VFS().list('/slow');
    await jest.advanceTimersByTimeAsync(600);
    expect(mockSpinner.start).toHaveBeenCalledWith('Fetching directory from remote', true);
    resolveList(ok([item('x')]));
    await pending;
    expect(mockSpinner.stop).toHaveBeenCalled();
  });

  it('never starts the spinner on a fast fetch', async () => {
    mockDispatcherList.mockResolvedValue(ok([item('x')]));
    await new VFS().list('/fast');
    expect(mockSpinner.start).not.toHaveBeenCalled();
  });
});
