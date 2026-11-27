/**
 * @file Tests for the VFS dispatcher: provider matching, virtual parent
 * synthesis, path-resolver hooks and read dispatch. Providers are mocked
 * with prefix-carrying fakes.
 */

const providerFns = {
  nativeList: jest.fn(),
  nativeCp: jest.fn(),
  pacsList: jest.fn(),
  pacsCp: jest.fn(),
  pacsRead: jest.fn(),
  pacsReadBinary: jest.fn(),
  etcList: jest.fn(),
  procLinkTargetResolve: jest.fn(),
  procWrite: jest.fn(),
};

jest.mock('../src/vfs/providers/native', () => ({
  NativeVfsProvider: class {
    prefix: string = '/';
    list(...args: unknown[]): Promise<unknown> { return providerFns.nativeList(...args); }
    cp(...args: unknown[]): Promise<unknown> { return providerFns.nativeCp(...args); }
  },
}));
jest.mock('../src/vfs/providers/pacs', () => ({
  PacsVfsProvider: class {
    prefix: string = '/net/pacs';
    copiesOut: boolean = true;
    list(...args: unknown[]): Promise<unknown> { return providerFns.pacsList(...args); }
    cp(...args: unknown[]): Promise<unknown> { return providerFns.pacsCp(...args); }
    read(...args: unknown[]): Promise<unknown> { return providerFns.pacsRead(...args); }
    readBinary(...args: unknown[]): Promise<unknown> { return providerFns.pacsReadBinary(...args); }
  },
}));
jest.mock('../src/vfs/providers/etc', () => ({
  EtcVfsProvider: class {
    prefix: string = '/etc';
    list(...args: unknown[]): Promise<unknown> { return providerFns.etcList(...args); }
  },
}));
jest.mock('../src/vfs/providers/proc', () => ({
  ProcVfsProvider: class {
    prefix: string = '/proc';
    list(): Promise<unknown> { return Promise.resolve({ ok: true, value: [] }); }
    linkTarget_resolve(...args: unknown[]): Promise<unknown> { return providerFns.procLinkTargetResolve(...args); }
    write(...args: unknown[]): Promise<unknown> { return providerFns.procWrite(...args); }
  },
}));

// The dispatcher reports through fond's one error stack: watch the real instance.
import { listCache_get } from '@fnndsc/cumin';
import { vfsRefusal_text } from '@fnndsc/fond';
import { errorStack } from '@fnndsc/fond';
let mockStackPush: jest.SpiedFunction<typeof errorStack.stack_push>;

import { CubeVfsDispatcher } from '../src/vfs/dispatcher';
import { VFSItem } from '../src/vfs/provider';

const item = (name: string): VFSItem => ({
  name, type: 'file', size: 1, owner: 'chris', date: '2026-07-03',
} as unknown as VFSItem);

beforeEach(() => {
    listCache_get().cache_invalidate();
  jest.clearAllMocks();
  mockStackPush?.mockRestore();
  mockStackPush = jest.spyOn(errorStack, 'stack_push').mockImplementation((): void => undefined);
  Object.values(providerFns).forEach((fn: jest.Mock) => fn.mockReset());
});

describe('path_isVirtual', () => {
  const d: CubeVfsDispatcher = new CubeVfsDispatcher();

  it('calls a projection path virtual: owned by a provider, at or under its prefix', () => {
    expect(d.path_isVirtual('/proc')).toBe(true);
    expect(d.path_isVirtual('/proc/jobs/feed_4461/pl-dircopy_588089')).toBe(true);
    expect(d.path_isVirtual('/net/pacs')).toBe(true);
    expect(d.path_isVirtual('/net/pacs/PACSDCM')).toBe(true);
    expect(d.path_isVirtual('/etc')).toBe(true);
    expect(d.path_isVirtual('/etc/group')).toBe(true);
  });

  it('calls a strict ancestor of a projection prefix virtual: its only children are projections', () => {
    // /net has no CUBE folder — /net/pacs lives beneath it.
    expect(d.path_isVirtual('/net')).toBe(true);
  });

  it('never calls a real CUBE folder virtual, the store root included', () => {
    expect(d.path_isVirtual('/')).toBe(false);
    expect(d.path_isVirtual('/home/chris')).toBe(false);
    expect(d.path_isVirtual('/home/chris/feeds/feed_4461')).toBe(false);
    expect(d.path_isVirtual('/SHARED')).toBe(false);
    expect(d.path_isVirtual('/PUBLIC')).toBe(false);
  });

  it('does not mistake a look-alike name for a projection prefix', () => {
    // /procedures is not under /proc.
    expect(d.path_isVirtual('/procedures')).toBe(false);
    expect(d.path_isVirtual('/network')).toBe(false);
  });

  it('reads a root-relative or trailing-slash path the same as its clean form', () => {
    expect(d.path_isVirtual('proc/jobs')).toBe(true);
    expect(d.path_isVirtual('/proc/')).toBe(true);
  });
});

describe('provider matching', () => {
  it('routes prefixed paths to their provider and everything else to native', () => {
    const d: CubeVfsDispatcher = new CubeVfsDispatcher();
    expect(d.provider_get('/net/pacs/queries').prefix).toBe('/net/pacs');
    expect(d.provider_get('/etc').prefix).toBe('/etc');
    expect(d.provider_get('/home/chris').prefix).toBe('/');
    expect(d.provider_get('relative/path').prefix).toBe('/');
  });

  it('prefers the most specific prefix after registration', () => {
    const d: CubeVfsDispatcher = new CubeVfsDispatcher();
    d.provider_register({
      prefix: '/net/pacs/queries',
      list: jest.fn(),
      cp: jest.fn(),
    } as never);
    expect(d.provider_get('/net/pacs/queries/q1').prefix).toBe('/net/pacs/queries');
    expect(d.provider_get('/net/pacs/other').prefix).toBe('/net/pacs');
    // The mounts beside the native fallback: /net/pacs, /etc, /proc/jobs,
    // /proc/tags, /usr/share, plus the one registered above.
    expect(d.providers_get().length).toBe(6);
  });
});

describe('list', () => {
  it('synthesizes virtual subdirs at the root and merges native items', async () => {
    providerFns.nativeList.mockResolvedValue({ ok: true, value: [item('home'), item('etc')] });
    const d: CubeVfsDispatcher = new CubeVfsDispatcher();
    const result = await d.list('/');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const names: string[] = result.value.map((i: VFSItem) => i.name).sort();
      // 'etc' from native is deduplicated against the virtual 'etc'
      expect(names).toEqual(['etc', 'home', 'net', 'proc', 'usr']);
    }
  });

  it('synthesizes the next segment for an intermediate virtual parent', async () => {
    providerFns.nativeList.mockResolvedValue({ ok: false });
    const d: CubeVfsDispatcher = new CubeVfsDispatcher();
    const result = await d.list('/net');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((i: VFSItem) => i.name)).toEqual(['pacs']);
  });

  it('applies the path resolver for native paths and falls back on throw', async () => {
    providerFns.nativeList.mockResolvedValue({ ok: true, value: [] });
    const d: CubeVfsDispatcher = new CubeVfsDispatcher();
    d.pathResolver_register(async (p: string) => `/resolved${p}`);
    await d.list('/home/chris');
    expect(providerFns.nativeList).toHaveBeenCalledWith('/resolved/home/chris', undefined);

    d.pathResolver_register(async () => { throw new Error('no map'); });
    await d.list('/home/chris');
    expect(providerFns.nativeList).toHaveBeenLastCalledWith('/home/chris', undefined);
  });

  it('dispatches provider-prefixed paths straight to the provider', async () => {
    providerFns.pacsList.mockResolvedValue({ ok: true, value: [item('q1')] });
    const d: CubeVfsDispatcher = new CubeVfsDispatcher();
    const result = await d.list('/net/pacs/queries');
    expect(result.ok).toBe(true);
    expect(providerFns.pacsList).toHaveBeenCalledWith('/net/pacs/queries', undefined);
  });
});

describe('cp', () => {
  it('resolves both endpoints for native copies', async () => {
    providerFns.nativeCp.mockResolvedValue({ ok: true, value: true });
    const d: CubeVfsDispatcher = new CubeVfsDispatcher();
    d.pathResolver_register(async (p: string) => `/r${p}`);
    expect((await d.cp('/a', '/b', {} as never)).ok).toBe(true);
    expect(providerFns.nativeCp).toHaveBeenCalledWith('/r/a', '/r/b', {});
  });

  it('dispatches provider-prefixed sources to the provider', async () => {
    providerFns.pacsCp.mockResolvedValue({ ok: true, value: true });
    const d: CubeVfsDispatcher = new CubeVfsDispatcher();
    expect((await d.cp('/net/pacs/queries/q1', '/home/chris', {} as never)).ok).toBe(true);
    expect(providerFns.pacsCp).toHaveBeenCalledWith('/net/pacs/queries/q1', '/home/chris', {});
  });

  it('fails the copy when path resolution throws, never guessing a path', async () => {
    providerFns.nativeCp.mockResolvedValue({ ok: true, value: true });
    const d: CubeVfsDispatcher = new CubeVfsDispatcher();
    d.pathResolver_register(async () => { throw new Error('no map'); });
    expect((await d.cp('/a', '/b', {} as never)).ok).toBe(false);
    expect(providerFns.nativeCp).not.toHaveBeenCalled();
  });

  it('fails the copy when only the destination fails to resolve', async () => {
    providerFns.nativeCp.mockResolvedValue({ ok: true, value: true });
    const d: CubeVfsDispatcher = new CubeVfsDispatcher();
    d.pathResolver_register(async (p: string) => {
      if (p === '/b') throw new Error('no map');
      return `/r${p}`;
    });
    expect((await d.cp('/a', '/b', {} as never)).ok).toBe(false);
    expect(providerFns.nativeCp).not.toHaveBeenCalled();
  });
});

describe('write', () => {
  it('dispatches a whole-file write to the provider that holds writable files', async () => {
    providerFns.procWrite.mockResolvedValue({ ok: true, value: true });
    const d: CubeVfsDispatcher = new CubeVfsDispatcher();
    expect((await d.write('/proc/jobs/feed_5/note', 'words')).ok).toBe(true);
    expect(providerFns.procWrite).toHaveBeenCalledWith('/proc/jobs/feed_5/note', 'words');
  });

  it('refuses a write where no provider takes one, by name', async () => {
    const d: CubeVfsDispatcher = new CubeVfsDispatcher();
    expect(await d.write('/etc/motd', 'x')).toEqual({ ok: false, errno: 'EROFS' });
    expect(vfsRefusal_text('write', { errno: 'EROFS' }, '/etc/motd')).toContain('File write not supported');
    expect((await d.write('/home/chris/f.txt', 'x')).ok).toBe(false);
  });
});

describe('read and readBinary', () => {
  it('dispatches reads to providers that support them', async () => {
    providerFns.pacsRead.mockResolvedValue({ ok: true, value: 'text' });
    providerFns.pacsReadBinary.mockResolvedValue({ ok: true, value: Buffer.from('b') });
    const d: CubeVfsDispatcher = new CubeVfsDispatcher();
    expect((await d.read('/net/pacs/queries/f.txt')).ok).toBe(true);
    expect((await d.readBinary('/net/pacs/queries/f.dcm')).ok).toBe(true);
  });

  it('errors for native paths and providers without read support', async () => {
    // The parents list nothing by those names: a file not offered for reading, not a folder.
    providerFns.nativeList.mockResolvedValue({ ok: true, value: [] });
    providerFns.etcList.mockResolvedValue({ ok: true, value: [] });
    const d: CubeVfsDispatcher = new CubeVfsDispatcher();
    expect(await d.read('/home/chris/f.txt')).toEqual({ ok: false, errno: 'EROFS' });
    expect(await d.readBinary('/etc/motd')).toEqual({ ok: false, errno: 'EROFS' });
  });
});

describe('link target resolution', () => {
  it('delegates an unresolved virtual link to its provider', async () => {
    providerFns.procLinkTargetResolve.mockResolvedValue({ ok: true, value: '/home/chris/output' });
    const d: CubeVfsDispatcher = new CubeVfsDispatcher();

    await expect(d.linkTarget_resolve('/proc/jobs/feed_5/pl-root_10/data'))
      .resolves.toEqual({ ok: true, value: '/home/chris/output' });
    expect(providerFns.procLinkTargetResolve)
      .toHaveBeenCalledWith('/proc/jobs/feed_5/pl-root_10/data');
  });

  it('rejects paths whose provider cannot resolve virtual links', async () => {
    const d: CubeVfsDispatcher = new CubeVfsDispatcher();

    await expect(d.linkTarget_resolve('/etc/passwd')).resolves.toEqual({ ok: false });
    expect(mockStackPush).toHaveBeenCalledWith('error', expect.stringContaining('Link resolution not supported'));
  });
});
