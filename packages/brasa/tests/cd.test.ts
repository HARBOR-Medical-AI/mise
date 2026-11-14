/**
 * @file Unit tests for the extracted `cd` path helpers.
 *
 * Covers the pure path-classification logic carved out of `builtin_cd`.
 * Session/cross-package deps are mocked so the module loads in isolation.
 *
 * @module
 */
import { jest, describe, it, expect } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

const folderByPath = jest.fn<(path: string) => Promise<unknown>>();
const directoryChange = jest.fn<(path: string) => Promise<void>>();
jest.unstable_mockModule('../src/session/index.js', () => ({
  session: {
    physicalMode_get: (): boolean => true,
    getCWD: async (): Promise<string> => '/home/u',
    directory_change: directoryChange,
    previousCWD_get: (): string | undefined => undefined,
    connection: { config: { debug: false }, client_get: async (): Promise<unknown> => ({ getFileBrowserFolderByPath: folderByPath }) },
  },
}));
cuminMock_install(() => ({
  Ok: (value: unknown) => ({ ok: true, value }),
  Err: () => ({ ok: false }),
  // A listing cache that never holds anything: every parent read misses.
  listCache_get: () => ({ cache_get: () => null }),
  feedTags_readByFeed: jest.fn(),
  envelope_ok: (rendered: string, model?: unknown) =>
    model === undefined ? { status: 'ok', rendered } : { status: 'ok', rendered, model },
  envelope_error: (rendered: string, errors?: unknown, renderedErr?: string) => {
    const envelope: Record<string, unknown> = { status: 'error', rendered };
    if (errors !== undefined) envelope.errors = errors;
    if (renderedErr !== undefined) envelope.renderedErr = renderedErr;
    return envelope;
  },
}));
jest.unstable_mockModule('../src/builtins/utils.js', () => ({
  path_resolve: jest.fn(async (p: string): Promise<string> => p),
  // The one store-path resolver, over one link: the run's output holds a link to ~/uploads/x.
  storePath_resolve: jest.fn(async (p: string, options: { entry?: boolean } = {}): Promise<string> => {
    const link: string = '/home/u/feeds/feed_1/pl-dircopy_2/data/home_u_uploads_x';
    const follow = (at: string): string => (at === link || at.startsWith(`${link}/`) ? `/home/u/uploads/x${at.slice(link.length)}` : at);
    if (options.entry === true) {
      const slash: number = p.lastIndexOf('/');
      return `${follow(p.slice(0, slash) || '/')}${p.slice(slash)}`.replace(/^\/\//, '/');
    }
    return follow(p);
  }),
  error_stripDebugPrefix: jest.fn((m: string): string => m),
}));
const vfsList = jest.fn<(path: string) => Promise<{ ok: boolean; value?: unknown[] }>>();
// cd lists a parent through the brasa façade (S3/S4); the façade is
// answered by the same dispatcher stub the cases drive.
jest.unstable_mockModule('../src/lib/vfs/vfs.js', () => ({
  vfs: {
    listing_get: async (target: string) => {
      const listed = await vfsList(target);
      return listed.ok ? { ok: true, value: { path: target, items: listed.value, fresh: true } } : { ok: false };
    },
  },
}));
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  vfsDispatcher: {
    list: vfsList,
    providers_get: (): Array<{ prefix: string }> => [{ prefix: '/proc' }],
    provider_get: (): { prefix: string } => ({ prefix: '' }),
  },
}));

const { vfsPath_normalize, vfsPath_isStructural, cfsLink_target, cd_run } = await import('../src/builtins/fs/cd.js');
const { folder_verifyPathMatch } = await import('../src/chris/navigation.js');
// cd enters a CUBE folder through the ChRIS backend's filesystem, over the mocks above.
await (await import('./support/chrisPieces.js')).chrisPieces_install({ vfs: true });

describe('cd through a CFS link', () => {
  const link: string = '/home/u/feeds/feed_1/pl-dircopy_2/data/home_u_uploads_x';
  beforeEach(() => {
    vfsList.mockResolvedValue({ ok: true, value: [
      { name: 'home_u_uploads_x', type: 'link', size: 48, owner: 'u', date: '', target: '/home/u/uploads/x' },
    ] });
    folderByPath.mockReset();
    directoryChange.mockReset();
  });
  it('follows the link to its target', async () => {
    folderByPath.mockResolvedValue({ data: { path: '/home/u/uploads/x' } });
    const result = await cd_run({ path: link });
    expect(result.status).toBe('ok');
    expect(directoryChange).toHaveBeenCalledWith('/home/u/uploads/x');
  });
  it('names the target when the link dangles', async () => {
    folderByPath.mockResolvedValue(null);
    const result = await cd_run({ path: link });
    expect(result.status).toBe('error');
    expect(result.renderedErr).toContain('link target /home/u/uploads/x');
    expect(directoryChange).not.toHaveBeenCalled();
  });
});

describe('cfsLink_target', () => {
  it('names the target of a link as the store-path resolver gives it, and nothing for a folder', async () => {
    expect(await cfsLink_target('/home/u/feeds/feed_1/pl-dircopy_2/data/home_u_uploads_x')).toBe('/home/u/uploads/x');
    expect(await cfsLink_target('/home/u/feeds/feed_1/pl-dircopy_2/data/data')).toBeNull();
    // A folder behind the link is no link itself: its entry and its store path are one.
    expect(await cfsLink_target('/home/u/feeds/feed_1/pl-dircopy_2/data/home_u_uploads_x/sub')).toBeNull();
    expect(await cfsLink_target('/home/u/feeds/feed_1/pl-dircopy_2/data/absent')).toBeNull();
  });
  it('is nothing for the root or a relative path', async () => {
    expect(await cfsLink_target('/')).toBeNull();
    expect(await cfsLink_target('relative/x')).toBeNull();
  });
});

describe('vfsPath_normalize', () => {
  it('strips a single trailing slash', () => {
    expect(vfsPath_normalize('/a/b/')).toBe('/a/b');
  });
  it('leaves the root path intact', () => {
    expect(vfsPath_normalize('/')).toBe('/');
  });
  it('leaves slash-less paths intact', () => {
    expect(vfsPath_normalize('/a/b')).toBe('/a/b');
  });
});

describe('vfsPath_isStructural', () => {
  it('accepts known structural containers', () => {
    for (const p of ['/', '/net', '/net/pacs', '/net/pacs/queries', '/proc', '/proc/jobs']) {
      expect(vfsPath_isStructural(p)).toBe(true);
    }
  });
  it('rejects arbitrary paths', () => {
    expect(vfsPath_isStructural('/proc/jobs/5')).toBe(false);
    expect(vfsPath_isStructural('/home/user')).toBe(false);
  });
});

describe('folder_verifyPathMatch', () => {
  it('is false for null/undefined folder', () => {
    expect(folder_verifyPathMatch(null, '/a')).toBe(false);
    expect(folder_verifyPathMatch(undefined, '/a')).toBe(false);
  });
  it('matches ignoring leading/trailing slashes', () => {
    expect(folder_verifyPathMatch({ path: 'home/user/' }, '/home/user')).toBe(true);
    expect(folder_verifyPathMatch({ data: { path: '/home/user' } }, 'home/user')).toBe(true);
  });
  it('rejects mismatched paths', () => {
    expect(folder_verifyPathMatch({ path: '/home/other' }, '/home/user')).toBe(false);
  });
});
