/**
 * @file fond's dispatcher routes by the longest mount prefix at a segment boundary, and knows no backend.
 */
import { VFSDispatcher } from '../src/vfs/dispatcher';
import type { VFSProvider, VFSItem } from '../src/vfs/provider';
import { vfsItems_sort } from '../src/vfs/sort';
import { errorStack } from '../src/errorStack';
import { vfs_ok, vfs_fail, type VfsOutcome } from '../src/vfs/outcome';
import { Ok, type Result } from '../src/result';

const item = (name: string, size: number = 1): VFSItem => ({ name, type: 'file', size, owner: 'o', date: '2026-10-08' });

/** A mount that lists one item named for itself, and records what it was asked. */
const mount = (prefix: string, seen: string[], extra: Partial<VFSProvider> = {}): VFSProvider => ({
  prefix,
  async list(path: string): Promise<Result<VFSItem[]>> { seen.push(`${prefix || 'fallback'}:list:${path}`); return Ok([item(prefix || 'fallback')]); },
  async cp(src: string, dest: string): Promise<VfsOutcome> { seen.push(`${prefix || 'fallback'}:cp:${src}>${dest}`); return vfs_ok(true); },
  ...extra,
});

beforeEach(() => errorStack.stack_clear());

describe('VFSDispatcher', () => {
  it('routes to the longest prefix that matches at a segment boundary, else the fallback', () => {
    const seen: string[] = [];
    const fallback = mount('', seen);
    const d = new VFSDispatcher(fallback);
    const proc = mount('/proc', seen);
    const jobs = mount('/proc/jobs', seen);
    d.provider_register(proc);
    d.provider_register(jobs);
    expect(d.provider_get('/proc/jobs/feed_1')).toBe(jobs);
    expect(d.provider_get('/proc/tags')).toBe(proc);
    expect(d.provider_get('/proc')).toBe(proc);
    expect(d.provider_get('/procs')).toBe(fallback);
    expect(d.provider_get('home/u')).toBe(fallback);
    expect(d.providers_get()).toEqual([jobs, proc]);
  });

  it('lists a parent of mounts as the mounts beneath it, beside what the fallback holds there', async () => {
    const seen: string[] = [];
    const d = new VFSDispatcher(mount('', seen));
    d.provider_register(mount('/net/pacs', seen));
    const top: Result<VFSItem[]> = await d.list('/net');
    expect(top.ok && top.value.map((i: VFSItem) => `${i.name}:${i.type}`)).toEqual(['pacs:vfs', 'fallback:file']);
    expect(d.path_isVirtual('/net')).toBe(true);
    expect(d.path_isVirtual('/net/pacs/q')).toBe(true);
    expect(d.path_isVirtual('/')).toBe(false);
    expect(d.path_isVirtual('/home')).toBe(false);
  });

  it('with no fallback given, a path no mount claims is refused by name, not answered as an empty folder', async () => {
    const d = new VFSDispatcher();
    expect((await d.list('/anywhere')).ok).toBe(false);
    expect(errorStack.stack_pop()?.message).toContain('No mount serves /anywhere');
    expect(await d.cp('/a', '/b', {})).toEqual(vfs_fail('ENOENT', 'cp: no mount serves /a'));
  });

  it('a fallback path goes through the path resolver; a copy whose path cannot resolve fails rather than guessing', async () => {
    const seen: string[] = [];
    const d = new VFSDispatcher(mount('', seen));
    d.pathResolver_register(async (p: string): Promise<string> => { if (p === '/bad') throw new Error('unknown'); return `/real${p}`; });
    await d.list('/home');
    expect(seen).toContain('fallback:list:/real/home');
    expect(await d.cp('/a', '/b', {})).toEqual(vfs_ok(true));
    expect(seen).toContain('fallback:cp:/real/a>/real/b');
    expect(await d.cp('/bad', '/b', {})).toEqual(vfs_fail('EIO', 'cp: cannot resolve source path /bad: unknown'));
  });

  it('each operation goes to the mount that offers it, and answers EROFS or EXDEV where it cannot', async () => {
    const seen: string[] = [];
    const notes = mount('/notes', seen, {
      async read(): Promise<VfsOutcome<string>> { return vfs_ok('text'); },
      async write(): Promise<VfsOutcome> { return vfs_ok(true); },
      async mkdir(): Promise<VfsOutcome> { return vfs_ok(true); },
      async rmdir(): Promise<VfsOutcome> { return vfs_ok(true); },
      async rename(): Promise<VfsOutcome> { return vfs_ok(true); },
      async rm(): Promise<VfsOutcome> { return vfs_ok(true); },
      async rmTree(): Promise<VfsOutcome> { return vfs_ok(true); },
      async readBinary(): Promise<VfsOutcome<Buffer>> { return vfs_ok(Buffer.from('b')); },
      async linkTarget_resolve(): Promise<Result<string>> { return Ok('/there'); },
    });
    const d = new VFSDispatcher(mount('', seen));
    d.provider_register(notes);
    expect(await d.read('/notes/a')).toEqual(vfs_ok('text'));
    expect(await d.write('/notes/a', 'x')).toEqual(vfs_ok(true));
    expect(await d.mkdir('/notes/d')).toEqual(vfs_ok(true));
    expect(await d.rmdir('/notes/d')).toEqual(vfs_ok(true));
    expect(await d.rename('/notes/a', '/notes/b')).toEqual(vfs_ok(true));
    expect(await d.rm('/notes/a')).toEqual(vfs_ok(true));
    expect(d.rmTree_offered('/notes/d')).toBe(true);
    expect(await d.rmTree('/notes/d')).toEqual(vfs_ok(true));
    expect((await d.readBinary('/notes/a')).ok).toBe(true);
    expect(await d.linkTarget_resolve('/notes/l')).toEqual(Ok('/there'));
    expect(await d.rename('/notes/a', '/home/b')).toEqual(vfs_fail('EXDEV'));
    for (const refused of [d.read('/home/a'), d.write('/home/a', 'x'), d.mkdir('/home/d'), d.rmdir('/home/d'), d.rename('/home/a', '/home/b'), d.rm('/home/a'), d.rmTree('/home/d'), d.readBinary('/home/a')]) {
      expect(await refused).toEqual(vfs_fail('EROFS'));
    }
    expect(d.rmTree_offered('/home/d')).toBe(false);
    expect((await d.linkTarget_resolve('/home/l')).ok).toBe(false);
  });

  it('asks the fallback through the path resolver for every operation it offers', async () => {
    const seen: string[] = [];
    const fallback = mount('', seen, {
      async mkdir(p: string): Promise<VfsOutcome> { seen.push(`mkdir:${p}`); return vfs_ok(true); },
    });
    const d = new VFSDispatcher(fallback);
    d.pathResolver_register(async (p: string): Promise<string> => { if (p === '/bad') throw new Error('unknown'); return `/real${p}`; });
    expect(await d.mkdir('/home/x')).toEqual(vfs_ok(true));
    expect(seen).toContain('mkdir:/real/home/x');
    expect(await d.mkdir('/bad')).toEqual(vfs_fail('EIO', 'mkdir: cannot resolve path /bad: unknown'));
  });
});

describe('vfsItems_sort', () => {
  it('sorts by a field without changing the array given, and reverses on request', () => {
    const items: VFSItem[] = [item('b', 2), item('a', 3), item('c', 1)];
    expect(vfsItems_sort(items).map((i: VFSItem) => i.name)).toEqual(['a', 'b', 'c']);
    expect(vfsItems_sort(items, 'size', true).map((i: VFSItem) => i.name)).toEqual(['a', 'b', 'c']);
    expect(items.map((i: VFSItem) => i.name)).toEqual(['b', 'a', 'c']);
  });
});

describe('a failed read of a folder', () => {
  it('is EISDIR whatever the owning mount said, its words drained; a missing path keeps its own answer', async () => {
    const { MemoryVfsProvider } = await import('../src/vfs/memory');
    const { VFSDispatcher } = await import('../src/vfs/dispatcher');
    const { errorStack } = await import('../src/errorStack');
    const { vfs_fail } = await import('../src/vfs/outcome');
    const store = new MemoryVfsProvider('', { '/home/docs/b.txt': 'beta' });
    // CUBE answers a folder read with words for a missing file.
    store.read = async () => { errorStack.stack_push('error', 'File not found: docs'); return vfs_fail('EIO', 'File not found: docs'); };
    const dispatcher = new VFSDispatcher(store);
    // A projection that reads nothing at all.
    const projection = new MemoryVfsProvider('/proc', { '/proc/jobs': null });
    (projection as { read?: unknown }).read = undefined;
    (projection as { readBinary?: unknown }).readBinary = undefined;
    dispatcher.provider_register(projection);
    errorStack.stack_clear();
    expect(await dispatcher.read('/home/docs')).toEqual({ ok: false, errno: 'EISDIR' });
    expect(await dispatcher.read('/proc/jobs')).toEqual({ ok: false, errno: 'EISDIR' });
    expect(await dispatcher.readBinary('/proc')).toEqual({ ok: false, errno: 'EISDIR' });
    expect(await dispatcher.read('/home/missing.txt')).toEqual({ ok: false, errno: 'EIO', reason: 'File not found: docs' });
    errorStack.stack_pop();
    expect(await dispatcher.read('/proc/jobs/none')).toEqual({ ok: false, errno: 'EROFS' });
    errorStack.stack_clear();
  });
});

describe('a folder that holds only mounts', () => {
  it('lists the mounts, and the store holding nothing there fails nothing', async () => {
    const { MemoryVfsProvider } = await import('../src/vfs/memory');
    const { VFSDispatcher } = await import('../src/vfs/dispatcher');
    const { errorStack } = await import('../src/errorStack');
    const dispatcher = new VFSDispatcher(new MemoryVfsProvider('', { '/home/user/a.txt': 'a' }));
    for (const prefix of ['/usr/bin', '/usr/share']) dispatcher.provider_register(new MemoryVfsProvider(prefix, {}));
    errorStack.stack_clear();
    const listed = await dispatcher.list('/usr');
    expect(listed.ok && listed.value.map((item) => item.name).sort()).toEqual(['bin', 'share']);
    expect(errorStack.stack_getAll()).toEqual([]);
  });
});

describe('a failed read of a backend container', () => {
  it('is EISDIR once the dispatcher is told the kind is a container; before, the mount\'s own answer', async () => {
    const { VFSDispatcher } = await import('../src/vfs/dispatcher');
    const { vfs_fail } = await import('../src/vfs/outcome');
    const seen: string[] = [];
    const tenancy: VFSProvider = {
      ...mount('/net/oci', seen),
      async list(): Promise<Result<VFSItem[]>> { return Ok([{ name: 'harbor', type: 'compartment', size: 0, owner: 'o', date: '2026-10-20' }]); },
      async read(): Promise<VfsOutcome<string>> { return vfs_fail('EIO', 'no such field'); },
    };
    const dispatcher = new VFSDispatcher();
    dispatcher.provider_register(tenancy);
    expect(await dispatcher.read('/net/oci/harbor')).toEqual({ ok: false, errno: 'EIO', reason: 'no such field' });
    dispatcher.containerTest_register((type: string): boolean => type === 'dir' || type === 'vfs' || type === 'compartment');
    expect(await dispatcher.read('/net/oci/harbor')).toEqual({ ok: false, errno: 'EISDIR' });
  });
});

describe('a copy across mounts', () => {
  /** A fallback, a mount that copies out, one that does not, and a mount two levels down whose parent is nobody's. */
  const world = (): { d: VFSDispatcher; seen: string[] } => {
    const seen: string[] = [];
    const d = new VFSDispatcher(mount('', seen));
    d.provider_register(mount('/net/pacs', seen, { copiesOut: true }));
    d.provider_register(mount('/scripts', seen));
    d.provider_register(mount('/notes', seen));
    return { d, seen };
  };
  const copies = (seen: string[]): string[] => seen.filter((line: string): boolean => line.includes(':cp:'));

  it('between two mounts that offer none answers EXDEV, and neither mount is asked anything', async () => {
    const { d, seen } = world();
    expect(await d.cp('/scripts/a.sh', '/notes/a.sh', {})).toMatchObject({ ok: false, errno: 'EXDEV' });
    expect(await d.cp('/scripts/a.sh', '/home/a.sh', {})).toMatchObject({ ok: false, errno: 'EXDEV' });
    expect(await d.cp('/home/a.sh', '/scripts/a.sh', {})).toMatchObject({ ok: false, errno: 'EXDEV' });
    expect(seen).toEqual([]);
  });

  it('out of a mount that offers it, into the fallback, reaches that mount with the destination as the fallback resolves it', async () => {
    const { d, seen } = world();
    d.pathResolver_register(async (p: string): Promise<string> => `/real${p}`);
    expect(await d.cp('/net/pacs/study/series', '/home/ada/feed', {})).toEqual(vfs_ok(true));
    expect(copies(seen)).toEqual(['/net/pacs:cp:/net/pacs/study/series>/real/home/ada/feed']);
  });

  it('out of a mount that offers it, into a third mount, answers EXDEV', async () => {
    const { d, seen } = world();
    expect(await d.cp('/net/pacs/study', '/notes/study', {})).toMatchObject({ ok: false, errno: 'EXDEV' });
    expect(seen).toEqual([]);
  });

  it('into a folder of mounts, which nobody owns, answers EXDEV though the fallback would be handed it', async () => {
    const { d, seen } = world();
    expect(d.provider_get('/net').prefix).toBe('');
    expect(await d.cp('/home/a', '/net', {})).toMatchObject({ ok: false, errno: 'EXDEV' });
    expect(await d.cp('/net/pacs/study', '/net', {})).toMatchObject({ ok: false, errno: 'EXDEV' });
    expect(seen).toEqual([]);
  });

  it('out of a folder of mounts answers EXDEV', async () => {
    const { d, seen } = world();
    expect(await d.cp('/net', '/home/net', { recursive: true })).toMatchObject({ ok: false, errno: 'EXDEV' });
    expect(seen).toEqual([]);
  });

  it('whose destination the fallback resolves to a path a mount owns answers EXDEV', async () => {
    const { d, seen } = world();
    d.pathResolver_register(async (p: string): Promise<string> => (p === '/home/link' ? '/scripts/target' : p));
    expect(await d.cp('/home/a', '/home/link', {})).toMatchObject({ ok: false, errno: 'EXDEV', reason: 'cp: /home/link resolves to /scripts/target, which another mount owns' });
    expect(await d.cp('/net/pacs/study', '/home/link', {})).toMatchObject({ ok: false, errno: 'EXDEV' });
    expect(await d.cp('/home/link', '/home/b', {})).toMatchObject({ ok: false, errno: 'EXDEV' });
    expect(copies(seen)).toEqual([]);
  });

  it('within one mount, and within the fallback, is as it was', async () => {
    const { d, seen } = world();
    expect(await d.cp('/scripts/a.sh', '/scripts/b.sh', {})).toEqual(vfs_ok(true));
    expect(await d.cp('/home/a', '/home/b', {})).toEqual(vfs_ok(true));
    expect(copies(seen)).toEqual(['/scripts:cp:/scripts/a.sh>/scripts/b.sh', 'fallback:cp:/home/a>/home/b']);
  });
});
