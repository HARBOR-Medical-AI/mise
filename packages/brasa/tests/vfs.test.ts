import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

// Mock external dependencies BEFORE imports
const mockGetCWD = jest.fn();
const mockPlugins_listAll = jest.fn();
const mockFiles_list = jest.fn();
const mockGrid_render = jest.fn();
const mockLong_render = jest.fn();

// Mock cumin
const mockListCache = {
  cache_get: jest.fn(),
  cache_set: jest.fn(),
  cache_invalidate: jest.fn(),
};

const mockFeedTagsByFeed = jest.fn(async (): Promise<{ ok: boolean; value?: Map<number, string[]> }> => ({ ok: true, value: new Map() }));
cuminMock_install(() => ({
  feedTags_readByFeed: mockFeedTagsByFeed,
  envelope_ok: (rendered: string) => ({ status: 'ok', rendered }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
  listCache_get: () => mockListCache,
  errorStack: {
    stack_search: () => [],
    stack_push: jest.fn(), 
    stack_pop: jest.fn().mockReturnValue({ message: 'Mocked Error Message', type: 'error' }),
    checkpoint_mark: jest.fn(() => 0),
    checkpoint_drain: jest.fn(() => []),
  },
  Ok: (val) => ({ ok: true, value: val }),
  Err: (err) => ({ ok: false, error: err })
}), { fond: { grid_render: mockGrid_render, long_render: mockLong_render } });

// Mock the session module directly
jest.unstable_mockModule('../src/session/index.js', () => ({
  session: {
    getCWD: mockGetCWD,
    setCWD: jest.fn()
  }
}));

const mockVfsDispatcher = {
  list: jest.fn().mockImplementation(async (searchPath: string, options?: any) => {
    try {
      if (searchPath === '/bin') {
        const plugins = await mockPlugins_listAll({});
        const items: any[] = [];
        if (plugins && plugins.tableData) {
          plugins.tableData.forEach((plugin: any) => {
            const pluginName = plugin.name;
            const pluginVersion = plugin.version || '';
            const displayName = pluginVersion ? `${pluginName}-v${pluginVersion}` : pluginName;
            items.push({
              name: displayName,
              type: 'plugin',
              size: 0,
              owner: 'system',
              date: plugin.creation_date || '',
            });
          });
        }
        return { ok: true, value: items };
      }
      if (searchPath === '/usr') {
        return {
          ok: true,
          value: [{
            name: 'bin',
            type: 'vfs',
            size: 0,
            owner: 'root',
            date: new Date().toISOString(),
          }]
        };
      }
      if (searchPath === '/usr/bin') {
        const builtinNames = ['ls', 'cd', 'pwd', 'cat', 'touch', 'rm', 'mkdir'];
        const items = builtinNames.map((name) => ({
          name,
          type: 'plugin',
          size: 0,
          owner: 'system',
          date: new Date().toISOString(),
        }));
        return { ok: true, value: items };
      }
      if (searchPath === '/' || searchPath === '') {
        const items: any[] = [
          { name: 'bin', type: 'vfs', size: 0, owner: 'root', date: new Date().toISOString() },
          { name: 'usr', type: 'vfs', size: 0, owner: 'root', date: new Date().toISOString() },
          { name: 'net', type: 'vfs', size: 0, owner: 'root', date: new Date().toISOString() }
        ];
        const nativeItems = await mockFiles_list({ path: searchPath, ...options }, searchPath);
        if (nativeItems && Array.isArray(nativeItems)) {
          nativeItems.forEach((item: any) => {
            if (item.name !== 'bin' && item.name !== 'usr' && item.name !== 'net') {
              items.push(item);
            }
          });
        }
        items.sort((a, b) => a.name.localeCompare(b.name));
        return { ok: true, value: items };
      }

      const mergedOptions = { path: searchPath, ...options };
      const items = await mockFiles_list(mergedOptions, searchPath);
      return { ok: true, value: items };
    } catch (e) {
      return { ok: false, error: e };
    }
  }),
  cp: jest.fn().mockImplementation(() => Promise.resolve(true)),
  provider_register: jest.fn(),
  provider_get: jest.fn().mockReturnValue({ prefix: '/' })
};

jest.unstable_mockModule('@fnndsc/salsa', () => ({
  plugins_listAll: mockPlugins_listAll,
  vfsDispatcher: mockVfsDispatcher,
  pathMapper_get: () => ({ blindParents_take: mockBlindParentsTake }),
  context_getSingle: jest.fn(() => ({
    user: 'testuser',
    URL: 'http://localhost:8000'
  }))
}));

jest.unstable_mockModule('@fnndsc/chili/commands/fs/ls.js', () => ({
  files_list: mockFiles_list
}));

const mockBlindParentsTake = jest.fn((): string[] => []);


// Mock console methods
const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

// Now import VFS after mocks are set up - must use dynamic import for unstable_mockModule
const { VFS } = await import('../src/lib/vfs/vfs.js');
await (await import('./support/chrisPieces.js')).chrisPieces_install({ vfs: true });
// No backend is installed here, so a listing shows with the core's plain look.
const { LISTING_LOOK_PLAIN } = await import('@fnndsc/fond');

describe('VFS', () => {
  let vfs: VFS;

  beforeEach(() => {
    vfs = new VFS();
    jest.clearAllMocks();
    mockGetCWD.mockResolvedValue('/home/user');
    mockGrid_render.mockReturnValue('grid output');
    mockLong_render.mockReturnValue('long output');
  });

  describe('list()', () => {
    it('should list current directory when no path provided', async () => {
      mockGetCWD.mockResolvedValue('/home/user');
      mockFiles_list.mockResolvedValue([
        { name: 'file1.txt', type: 'file', size: 100, owner: 'user', date: '2025-01-01' }
      ]);

      await vfs.list();

      expect(mockGetCWD).toHaveBeenCalled();
      expect(mockFiles_list).toHaveBeenCalledWith(
        { path: '/home/user' },
        '/home/user'
      );
    });

    it('should resolve relative path against CWD', async () => {
      mockGetCWD.mockResolvedValue('/home/user');
      mockFiles_list.mockResolvedValue([]);

      await vfs.list('docs');

      expect(mockFiles_list).toHaveBeenCalledWith(
        { path: '/home/user/docs' },
        '/home/user/docs'
      );
    });

    it('should route /bin to virtual bin handler', async () => {
      mockGetCWD.mockResolvedValue('/home/user');
      mockPlugins_listAll.mockResolvedValue({
        tableData: [
          { name: 'pl-dircopy', version: '2.1.0', creation_date: '2025-01-01' }
        ]
      });

      await vfs.list('/bin');

      expect(mockPlugins_listAll).toHaveBeenCalled();
      expect(mockFiles_list).not.toHaveBeenCalled();
    });

    it('should use grid render by default', async () => {
      mockGetCWD.mockResolvedValue('/');
      mockFiles_list.mockResolvedValue([
        { name: 'file.txt', type: 'file', size: 100, owner: 'user', date: '2025-01-01' }
      ]);

      await vfs.list('/', {});

      expect(mockGrid_render).toHaveBeenCalled();
      expect(mockLong_render).not.toHaveBeenCalled();
    });

    it('should use long render when long option is true', async () => {
      mockGetCWD.mockResolvedValue('/');
      mockFiles_list.mockResolvedValue([
        { name: 'file.txt', type: 'file', size: 100, owner: 'user', date: '2025-01-01' }
      ]);

      await vfs.list('/', { long: true });

      expect(mockLong_render).toHaveBeenCalled();
      expect(mockGrid_render).not.toHaveBeenCalled();
    });

    it("hangs each feed's tags on its row in a long listing, one map for all, none read without a feed", async () => {
      mockGetCWD.mockResolvedValue('/');
      mockFiles_list.mockResolvedValue([
        { name: 'feed_12', type: 'dir', size: 0, owner: 'user', date: '2025-01-01' },
        { name: 'feed_13', type: 'dir', size: 0, owner: 'user', date: '2025-01-01' },
      ]);
      mockFeedTagsByFeed.mockResolvedValueOnce({ ok: true, value: new Map([[12, ['urgent']]]) });
      await vfs.list('/', { long: true });
      const rows = (mockLong_render.mock.calls.at(-1) as unknown[])[0] as Array<{ name: string; tags?: string[] }>;
      expect(rows.find((r) => r.name === 'feed_12')?.tags).toEqual(['urgent']);
      expect(rows.find((r) => r.name === 'feed_13')?.tags).toBeUndefined();
      expect(mockFeedTagsByFeed).toHaveBeenCalledTimes(1);

      mockFeedTagsByFeed.mockClear();
      mockFiles_list.mockResolvedValue([{ name: 'file.txt', type: 'file', size: 1, owner: 'user', date: '2025-01-01' }]);
      await vfs.list('/', { long: true });
      expect(mockFeedTagsByFeed).not.toHaveBeenCalled();
    });

    it('leaves the rows as they were when the tag map cannot be read', async () => {
      mockGetCWD.mockResolvedValue('/');
      mockFiles_list.mockResolvedValue([{ name: 'feed_12', type: 'dir', size: 0, owner: 'user', date: '2025-01-01' }]);
      mockFeedTagsByFeed.mockResolvedValueOnce({ ok: false });
      await vfs.list('/', { long: true });
      const rows = (mockLong_render.mock.calls.at(-1) as unknown[])[0] as Array<{ tags?: string[] }>;
      expect(rows[0]?.tags).toBeUndefined();
    });

    it('should pass human option to render functions', async () => {
      mockGetCWD.mockResolvedValue('/');
      mockFiles_list.mockResolvedValue([
        { name: 'file.txt', type: 'file', size: 100, owner: 'user', date: '2025-01-01' }
      ]);

      await vfs.list('/', { long: true, human: true });

      expect(mockLong_render).toHaveBeenCalledWith(
        expect.anything(),
        { human: true },
        LISTING_LOOK_PLAIN,
      );
    });
  });

  describe('leaf shortcut vs links', () => {
    it('follows a link through the dispatcher instead of returning the link entry', async () => {
      mockGetCWD.mockResolvedValue('/home/testuser');
      const parentListing = {
        data: [
          { name: 'public', type: 'link', size: 6, owner: 'testuser', date: '', target: '/PUBLIC' },
          { name: 'hello.txt', type: 'file', size: 92, owner: 'testuser', date: '' },
        ],
        fresh: true,
      };
      mockListCache.cache_get.mockImplementation((p: string) =>
        p === '/home/testuser' ? parentListing : undefined,
      );
      mockFiles_list.mockResolvedValue([
        { name: 'shared_thing', type: 'dir', size: 0, owner: 'other', date: '' },
      ]);
      const vfs = new VFS();
      const result = await vfs.data_get('/home/testuser/public');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.map((i: any) => i.name)).toEqual(['shared_thing']);
      }
      expect(mockVfsDispatcher.list).toHaveBeenCalledWith(
        '/home/testuser/public',
        expect.anything(),
      );
    });

    it('still serves a plain file from the cached parent listing', async () => {
      mockGetCWD.mockResolvedValue('/home/testuser');
      const parentListing = {
        data: [
          { name: 'hello.txt', type: 'file', size: 92, owner: 'testuser', date: '' },
        ],
        fresh: true,
      };
      mockListCache.cache_get.mockImplementation((p: string) =>
        p === '/home/testuser' ? parentListing : undefined,
      );
      mockVfsDispatcher.list.mockClear();
      const vfs = new VFS();
      const result = await vfs.data_get('/home/testuser/hello.txt');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.map((i: any) => i.name)).toEqual(['hello.txt']);
      }
      expect(mockVfsDispatcher.list).not.toHaveBeenCalled();
    });
  });

  describe('listVirtualBin()', () => {
    it('should list plugins from /bin', async () => {
      mockGetCWD.mockResolvedValue('/');
      mockPlugins_listAll.mockResolvedValue({
        tableData: [
          { name: 'pl-dircopy', version: '2.1.0', creation_date: '2025-01-01' },
          { name: 'pl-simpledsapp', version: '1.0.0', creation_date: '2025-01-02' }
        ]
      });

      await vfs.list('/bin');

      expect(mockPlugins_listAll).toHaveBeenCalledWith({});
      // Note: Items are now sorted at command layer, view layer receives sorted items
      expect(mockGrid_render).toHaveBeenCalled();
      const callArgs = mockGrid_render.mock.calls[0];
      expect(callArgs[0]).toEqual([
        { name: 'pl-dircopy-v2.1.0', type: 'plugin', size: 0, owner: 'system', date: '2025-01-01' },
        { name: 'pl-simpledsapp-v1.0.0', type: 'plugin', size: 0, owner: 'system', date: '2025-01-02' }
      ]);
    });

    it('should handle plugin without version', async () => {
      mockGetCWD.mockResolvedValue('/');
      mockPlugins_listAll.mockResolvedValue({
        tableData: [
          { name: 'pl-test', creation_date: '2025-01-01' }
        ]
      });

      await vfs.list('/bin');

      // Note: Items are now sorted at command layer, view layer receives sorted items
      expect(mockGrid_render).toHaveBeenCalled();
      const callArgs = mockGrid_render.mock.calls[0];
      expect(callArgs[0]).toEqual([
        { name: 'pl-test', type: 'plugin', size: 0, owner: 'system', date: '2025-01-01' }
      ]);
    });

    it('should handle no plugins found', async () => {
      mockGetCWD.mockResolvedValue('/');
      mockPlugins_listAll.mockResolvedValue({
        tableData: []
      });

      await vfs.list('/bin');

      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(mockGrid_render).not.toHaveBeenCalled();
    });

    it('should handle null tableData', async () => {
      mockGetCWD.mockResolvedValue('/');
      mockPlugins_listAll.mockResolvedValue({});

      await vfs.list('/bin');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should handle plugin list error', async () => {
      mockGetCWD.mockResolvedValue('/');
      mockPlugins_listAll.mockRejectedValue(new Error('API error'));

      const envelope = await vfs.list('/bin');

      expect(envelope.renderedErr).toContain('Mocked Error Message');
    });

    it('should render in long format when requested', async () => {
      mockGetCWD.mockResolvedValue('/');
      mockPlugins_listAll.mockResolvedValue({
        tableData: [
          { name: 'pl-test', version: '1.0.0', creation_date: '2025-01-01' }
        ]
      });

      await vfs.list('/bin', { long: true });

      expect(mockLong_render).toHaveBeenCalled();
      expect(mockGrid_render).not.toHaveBeenCalled();
    });
  });

  describe('listNative()', () => {
    it('should list native ChRIS directory', async () => {
      mockGetCWD.mockResolvedValue('/home/user');
      mockFiles_list.mockResolvedValue([
        { name: 'data', type: 'dir', size: 0, owner: 'user', date: '2025-01-01' },
        { name: 'file.txt', type: 'file', size: 1024, owner: 'user', date: '2025-01-02' }
      ]);

      await vfs.list('/home/user');

      expect(mockFiles_list).toHaveBeenCalledWith(
        { path: '/home/user' },
        '/home/user'
      );
      expect(mockGrid_render).toHaveBeenCalled();
    });

    it('should render a file operand rather than list it as a directory', async () => {
      const file = { name: 'scan.dcm', type: 'file', size: 1024, owner: 'user', date: '2025-01-02' };
      mockFiles_list.mockResolvedValueOnce([file]);

      await vfs.list('/home/user/scan.dcm');

      expect(mockFiles_list).toHaveBeenCalledWith({ path: '/home/user/scan.dcm' }, '/home/user/scan.dcm');
      expect(mockGrid_render).toHaveBeenCalledWith([file], expect.objectContaining({ oneColumn: false }), LISTING_LOOK_PLAIN);
    });

    it('should inject virtual bin directory when listing root', async () => {
      mockGetCWD.mockResolvedValue('/');
      mockFiles_list.mockResolvedValue([
        { name: 'home', type: 'dir', size: 0, owner: 'root', date: '2025-01-01' }
      ]);

      await vfs.list('/');

      const callArgs = mockGrid_render.mock.calls[0][0];
      const binItem = callArgs.find((item: any) => item.name === 'bin');
      expect(binItem).toBeDefined();
      expect(binItem.type).toBe('vfs');
    });

    it('should inject bin and sort items when listing root', async () => {
      mockGetCWD.mockResolvedValue('/');
      mockFiles_list.mockResolvedValue([
        { name: 'home', type: 'dir', size: 0, owner: 'root', date: '2025-01-01' },
        { name: 'aaa', type: 'dir', size: 0, owner: 'root', date: '2025-01-01' }
      ]);

      await vfs.list('/');

      const callArgs = mockGrid_render.mock.calls[0][0];
      expect(callArgs[0].name).toBe('aaa'); // Alphabetically first
      expect(callArgs[1].name).toBe('bin'); // Sorted in
      expect(callArgs[2].name).toBe('home');
    });

    it('should not inject bin when listing non-root', async () => {
      mockGetCWD.mockResolvedValue('/home');
      mockFiles_list.mockResolvedValue([
        { name: 'user', type: 'dir', size: 0, owner: 'root', date: '2025-01-01' }
      ]);

      await vfs.list('/home');

      const callArgs = mockGrid_render.mock.calls[0][0];
      const binItem = callArgs.find((item: any) => item.name === 'bin');
      expect(binItem).toBeUndefined();
    });

    it('should handle empty directory', async () => {
      mockGetCWD.mockResolvedValue('/tmp');
      mockFiles_list.mockResolvedValue([]);

      await vfs.list('/tmp');

      expect(mockFiles_list).toHaveBeenCalled();
      expect(mockGrid_render).not.toHaveBeenCalled();
      expect(mockLong_render).not.toHaveBeenCalled();
    });

    it('should handle files_list error', async () => {
      mockGetCWD.mockResolvedValue('/home');
      mockFiles_list.mockRejectedValue(new Error('Permission denied'));

      const envelope = await vfs.list('/home');

      expect(envelope.renderedErr).toContain('Mocked Error Message');
    });

    it('should use long format when requested', async () => {
      mockGetCWD.mockResolvedValue('/home');
      mockFiles_list.mockResolvedValue([
        { name: 'file.txt', type: 'file', size: 100, owner: 'user', date: '2025-01-01' }
      ]);

      await vfs.list('/home', { long: true });

      expect(mockLong_render).toHaveBeenCalled();
      expect(mockGrid_render).not.toHaveBeenCalled();
    });

    it('should pass human option to long render', async () => {
      mockGetCWD.mockResolvedValue('/home');
      mockFiles_list.mockResolvedValue([
        { name: 'file.txt', type: 'file', size: 1048576, owner: 'user', date: '2025-01-01' }
      ]);

      await vfs.list('/home', { long: true, human: true });

      expect(mockLong_render).toHaveBeenCalledWith(
        expect.anything(),
        { human: true },
        LISTING_LOOK_PLAIN,
      );
    });
  });

  describe('vfs singleton', () => {
    it('should export a VFS instance', async () => {
      const { vfs: vfsSingleton } = await import('../src/lib/vfs/vfs.js');
      expect(vfsSingleton).toBeInstanceOf(VFS);
    });
  });
});
