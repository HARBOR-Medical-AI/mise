/**
 * @file CUBE's native mount holds the filesystem contract.
 *
 * salsa's file functions are replaced by a CUBE held in memory that answers
 * the way CUBE does: a folder lists its folders, files and links as three
 * collections; making a folder already there is a success; a file or a
 * folder is deleted by its id, and a folder takes what it holds with it.
 * The native mount, unchanged, runs fond's contract over it.
 */
import * as path from 'path';
import { VFS_CONTRACT, type VfsContractDriver, type MemorySeed, errorStack, Ok, Err, type Result } from '@fnndsc/fond';

interface CubeEntry { type: 'dir' | 'file'; id: number; content: Buffer }

/** A CUBE held in memory. */
class MockCube {
  private entries: Map<string, CubeEntry> = new Map();
  /** Files whose path a folder also holds: CUBE allows it; a disk cannot. */
  private twins: Map<string, CubeEntry> = new Map();
  private nextId: number = 1;
  /** Every delete CUBE was asked for. */
  deletes: number = 0;

  constructor(seed: MemorySeed) {
    this.entries.set('/', { type: 'dir', id: 0, content: Buffer.alloc(0) });
    for (const [where, text] of Object.entries(seed)) {
      if (text === null) this.folder_make(where);
      else this.file_put(where, Buffer.from(text, 'utf-8'));
    }
  }

  /** CUBE makes a folder and any parents, and calls a folder already there a success. */
  folder_make(where: string): void {
    let walked: string = '';
    for (const part of where.split('/').filter(Boolean)) {
      walked += `/${part}`;
      if (!this.entries.has(walked)) this.entries.set(walked, { type: 'dir', id: this.nextId++, content: Buffer.alloc(0) });
    }
  }

  file_put(where: string, content: Buffer): void {
    this.folder_make(path.posix.dirname(where));
    this.entries.set(where, { type: 'file', id: this.nextId++, content });
  }

  /** A file at a folder's own path, the way the old mkdir over a file left one. */
  twin_put(where: string, content: Buffer): void {
    this.twins.set(where, { type: 'file', id: this.nextId++, content });
  }

  twin_get(where: string): CubeEntry | undefined {
    return this.twins.get(where);
  }

  get(where: string): CubeEntry | undefined {
    return this.entries.get(where);
  }

  children(folder: string, type: 'dir' | 'file'): Array<[string, CubeEntry]> {
    const prefix: string = folder === '/' ? '/' : `${folder}/`;
    const held = ([key, entry]: [string, CubeEntry]): boolean =>
      entry.type === type && key !== folder && key.startsWith(prefix) && !key.slice(prefix.length).includes('/');
    return [...this.entries.entries(), ...this.twins.entries()].filter(held);
  }

  delete_byId(id: number): boolean {
    this.deletes += 1;
    const found: [string, CubeEntry] | undefined = [...this.entries.entries()].find(([, entry]) => entry.id === id);
    if (found === undefined) return false;
    if (found[1].type === 'dir' && mockState.lingerReads > 0) mockState.ghosts.set(found[0], { id, reads: mockState.lingerReads });
    for (const key of [...this.entries.keys()]) {
      if (key === found[0] || key.startsWith(`${found[0]}/`)) this.entries.delete(key);
    }
    return true;
  }

  move(src: string, dest: string): boolean {
    if (!this.entries.has(src)) return false;
    for (const key of [...this.entries.keys()]) {
      if (key === src || key.startsWith(`${src}/`)) {
        const entry: CubeEntry = this.entries.get(key) as CubeEntry;
        this.entries.delete(key);
        this.entries.set(dest + key.slice(src.length), entry);
      }
    }
    return true;
  }
}

/**
 * CUBE accepts a folder's DELETE (202) and removes it after: a ghost is a
 * removed folder its parent goes on listing for so many more reads.
 */
const mockState: { cube: MockCube; ghosts: Map<string, { id: number; reads: number }>; lingerReads: number; faults: Map<string, Listing> } = { cube: new MockCube({}), ghosts: new Map(), lingerReads: 0, faults: new Map() };

type Listing =
  | { kind: 'listing'; data: { tableData: Array<Record<string, unknown>>; incomplete?: { gathered: number; reason: string } } }
  | { kind: 'empty' }
  | { kind: 'missing' }
  | { kind: 'refused'; error: Error };

/** Makes one listing of one folder answer as given, whatever the folder holds. */
function mockFault_set(asset: 'dirs' | 'files' | 'links', folder: string, answer: Listing): void {
  mockState.faults.set(`${asset} ${folder}`, answer);
}

/** A listing cut short at its bound: the rows it has, and the word that there were more. */
function mockListing_cutShort(rows: Array<Record<string, unknown>>): Listing {
  return { kind: 'listing', data: { tableData: rows, incomplete: { gathered: rows.length, reason: 'stopped at 1000' } } };
}

/** CUBE's listing of one kind in a folder. */
function mockCube_list(asset: string, folder: string): Listing {
  const fault: Listing | undefined = mockState.faults.get(`${asset} ${folder}`);
  if (fault !== undefined) return fault;
  const at: CubeEntry | undefined = mockState.cube.get(folder);
  if (at === undefined || at.type !== 'dir') return { kind: 'missing' };
  if (asset === 'links') return { kind: 'empty' };
  const rows = mockState.cube.children(folder, asset === 'dirs' ? 'dir' : 'file').map(([key, entry]: [string, CubeEntry]) =>
    asset === 'dirs' ? { id: entry.id, path: key.slice(1) } : { id: entry.id, fname: key.slice(1), fsize: entry.content.length });
  if (asset === 'dirs') {
    for (const [key, ghost] of mockState.ghosts) {
      if (path.posix.dirname(key) !== folder || ghost.reads <= 0) continue;
      ghost.reads -= 1;
      rows.push({ id: ghost.id, path: key.slice(1) });
    }
  }
  return rows.length === 0 ? { kind: 'empty' } : { kind: 'listing', data: { tableData: rows } };
}

/** CUBE's file read: the bytes, or its own refusal on the stack. */
function mockCube_read(where: string): Result<Buffer> {
  const entry: CubeEntry | undefined = mockState.cube.get(where);
  if (entry === undefined || entry.type !== 'file') {
    errorStack.stack_push('error', `File not found: ${path.posix.basename(where)} in ${path.posix.dirname(where)}`);
    return Err();
  }
  return Ok(Buffer.from(entry.content));
}

jest.mock('../src/files/index', () => ({
  files_listOutcome: async (_opts: unknown, asset: string, folder: string) => mockCube_list(asset, folder),
  files_listAll: async (_opts: unknown, asset: string, folder: string) => {
    const listed: Listing = mockCube_list(asset, folder);
    return listed.kind === 'listing' ? listed.data : null;
  },
  fileContent_get: async (where: string) => {
    const bytes: Result<Buffer> = mockCube_read(where);
    return bytes.ok ? Ok(bytes.value.toString('utf-8')) : bytes;
  },
  fileContent_getBinary: async (where: string) => mockCube_read(where),
  files_touch: async (where: string, content: string | Buffer) => {
    mockState.cube.file_put(where, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8'));
    return true;
  },
  files_mkdir: async (where: string) => { mockState.cube.folder_make(where); return true; },
  folderPath_holder: async (where: string) => {
    for (let at: string = where; at !== '/'; at = path.posix.dirname(at)) {
      const entry: CubeEntry | undefined = mockState.cube.get(at) ?? mockState.cube.twin_get(at);
      if (entry !== undefined) return Ok({ path: at, holder: entry.type, atTarget: at === where });
    }
    return Ok(null);
  },
  files_delete: async (id: number) => mockState.cube.delete_byId(id),
  files_move: async (src: string, dest: string) => mockState.cube.move(src, dest),
  files_copy: jest.fn(),
  files_copyRecursively: jest.fn(),
}));

import { NativeVfsProvider } from '../src/vfs/providers/native';

const cubeDriver: VfsContractDriver = {
  mount_make: async (seed: MemorySeed) => {
    mockState.cube = new MockCube(seed);
    mockState.ghosts = new Map();
    mockState.lingerReads = 0;
    mockState.faults = new Map();
    return new NativeVfsProvider();
  },
};

describe('the filesystem contract, held by the native CUBE mount', () => {
  for (const contractCase of VFS_CONTRACT) {
    it(contractCase.name, async () => {
      await expect(contractCase.run(cubeDriver)).resolves.toBeUndefined();
    });
  }
});

describe('what the native mount says beyond an errno', () => {
  it('refuses a rename onto a file with CUBE\'s reason, never overwriting it', async () => {
    const mount = await cubeDriver.mount_make({ '/home/a.txt': 'alpha', '/home/b.txt': 'beta' });
    expect(await mount.rename!('/home/a.txt', '/home/b.txt')).toEqual({
      ok: false, errno: 'EEXIST', reason: 'Destination exists: /home/b.txt — mise cannot overwrite a file; remove it first',
    });
    expect(mockState.cube.get('/home/b.txt')?.content.toString()).toBe('beta');
  });

  it('keeps CUBE\'s own words for a file that is not there', async () => {
    const mount = await cubeDriver.mount_make({ '/home/a.txt': 'alpha' });
    expect(await mount.read!('/home/nope.txt')).toEqual({ ok: false, errno: 'ENOENT', reason: 'File not found: nope.txt in /home' });
  });

  it('removes nothing where a folder and a file share a path, since CUBE\'s delete of either damages the other', async () => {
    const mount = await cubeDriver.mount_make({ '/home/x': null });
    mockState.cube.twin_put('/home/x', Buffer.from('rows', 'utf-8'));
    const refusal = { ok: false, errno: 'EPERM', reason: 'a folder and a file share /home/x, and removing either would damage the other in CUBE' };
    expect(await mount.rm!('/home/x')).toEqual(refusal);
    expect(await mount.rmdir!('/home/x')).toEqual(refusal);
    expect(await mount.rmTree!('/home/x')).toEqual(refusal);
    expect(mockState.cube.deletes).toBe(0);
    expect(mockState.cube.get('/home/x')?.type).toBe('dir');
    expect(mockState.cube.twin_get('/home/x')?.content.toString()).toBe('rows');
  });

  it('rm -r returns once CUBE has finished removing the folder, not when it accepted the removal', async () => {
    const mount = await cubeDriver.mount_make({ '/home/x': null, '/home/x/a.txt': 'alpha' });
    // The parent goes on naming the folder for two more reads after the DELETE.
    mockState.lingerReads = 2;
    expect(await mount.rmTree!('/home/x')).toEqual({ ok: true, value: true });
    expect(mockState.ghosts.get('/home/x')?.reads).toBe(0);
  });

  it('says so, in words, when CUBE still lists a folder whose removal it accepted', async () => {
    jest.useFakeTimers();
    try {
      const mount = await cubeDriver.mount_make({ '/home/x': null });
      mockState.lingerReads = Number.POSITIVE_INFINITY;
      const removal = mount.rmTree!('/home/x');
      await jest.advanceTimersByTimeAsync(20_000);
      expect(await removal).toEqual({ ok: false, errno: 'EIO', reason: 'CUBE accepted the removal of /home/x but still lists it after 15s' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('makes no folder and writes no file where the other already is', async () => {
    const mount = await cubeDriver.mount_make({ '/home/a.txt': 'alpha', '/home/d': null });
    expect(await mount.mkdir!('/home/a.txt')).toEqual({ ok: false, errno: 'EEXIST' });
    expect(await mount.mkdir!('/home/a.txt/sub')).toEqual({ ok: false, errno: 'ENOTDIR' });
    expect(await mount.write!('/home/d', 'over')).toEqual({ ok: false, errno: 'EISDIR' });
    expect(mockState.cube.get('/home/a.txt')?.type).toBe('file');
    expect(mockState.cube.get('/home/d')?.type).toBe('dir');
  });

  it('says a folder read as a file is a directory, not CUBE\'s words for a missing file', async () => {
    const mount = await cubeDriver.mount_make({ '/home/docs': null });
    expect(await mount.read!('/home/docs')).toEqual({ ok: false, errno: 'EISDIR' });
    expect(await mount.readBinary!('/home/docs')).toEqual({ ok: false, errno: 'EISDIR' });
  });
});

describe('rmdir removes a folder only on proof that it is a folder, alone at its path, and empty', () => {
  const eio = (reason: string): unknown => ({ ok: false, errno: 'EIO', reason });

  it('removes a folder whose three listings all answer, and hold nothing', async () => {
    const mount = await cubeDriver.mount_make({ '/home/x': null });
    expect(await mount.rmdir!('/home/x')).toEqual({ ok: true, value: true });
    expect(mockState.cube.deletes).toBe(1);
    expect(mockState.cube.get('/home/x')).toBeUndefined();
  });

  it('removes nothing when the folder holds a file', async () => {
    const mount = await cubeDriver.mount_make({ '/home/x': null, '/home/x/a.txt': 'alpha' });
    expect(await mount.rmdir!('/home/x')).toEqual({ ok: false, errno: 'ENOTEMPTY' });
    expect(mockState.cube.deletes).toBe(0);
  });

  it('removes nothing when the files of the folder are refused, though its folders and links read as empty', async () => {
    const mount = await cubeDriver.mount_make({ '/home/x': null, '/home/x/a.txt': 'alpha' });
    mockFault_set('files', '/home/x', { kind: 'refused', error: new Error('500 Internal Server Error') });
    expect(await mount.rmdir!('/home/x')).toEqual(eio('Cannot tell whether /home/x is empty: its files could not be read (500 Internal Server Error)'));
    expect(mockState.cube.deletes).toBe(0);
    expect(mockState.cube.get('/home/x/a.txt')?.content.toString()).toBe('alpha');
  });

  it('removes nothing when a listing of the folder was cut short, even with no row in it', async () => {
    const mount = await cubeDriver.mount_make({ '/home/x': null });
    mockFault_set('files', '/home/x', mockListing_cutShort([]));
    expect(await mount.rmdir!('/home/x')).toEqual(eio('Cannot tell whether /home/x is empty: its files were not all read (stopped at 1000)'));
    expect(mockState.cube.deletes).toBe(0);
  });

  it('removes nothing when a listing of the folder could not be made at all', async () => {
    const mount = await cubeDriver.mount_make({ '/home/x': null, '/home/x/a.txt': 'alpha' });
    mockFault_set('files', '/home/x', { kind: 'missing' });
    expect(await mount.rmdir!('/home/x')).toEqual(eio('Cannot tell whether /home/x is empty: its files could not be listed'));
    expect(mockState.cube.deletes).toBe(0);
  });

  it('removes nothing when the parent\'s files were cut short, since a file of the same name may be among the unread', async () => {
    const mount = await cubeDriver.mount_make({ '/home/x': null });
    mockFault_set('files', '/home', mockListing_cutShort([]));
    expect(await mount.rmdir!('/home/x')).toEqual(eio('Cannot check /home/x: the files of /home were not all read (stopped at 1000)'));
    expect(mockState.cube.deletes).toBe(0);
  });

  it('removes nothing when a listing of the parent could not be made though the parent is there', async () => {
    const mount = await cubeDriver.mount_make({ '/home/x': null });
    mockFault_set('files', '/home', { kind: 'missing' });
    expect(await mount.rmdir!('/home/x')).toEqual(eio('Cannot check /home/x: /home is there and could not be listed'));
    expect(mockState.cube.deletes).toBe(0);
  });

  it('removes nothing when the parent\'s listing is refused', async () => {
    const mount = await cubeDriver.mount_make({ '/home/x': null });
    mockFault_set('dirs', '/home', { kind: 'refused', error: new Error('403 Forbidden') });
    expect(await mount.rmdir!('/home/x')).toEqual(eio('Cannot check /home/x: 403 Forbidden'));
    expect(mockState.cube.deletes).toBe(0);
  });

  it('says a folder that is not there is not there, when its parent is proved absent too', async () => {
    const mount = await cubeDriver.mount_make({ '/home/x': null });
    expect(await mount.rmdir!('/home/gone/y')).toEqual({ ok: false, errno: 'ENOENT' });
    expect(mockState.cube.deletes).toBe(0);
  });

  it('still shows the rows it has when part of a listing fails: showing is not removing', async () => {
    const mount = await cubeDriver.mount_make({ '/home/x': null, '/home/x/sub': null, '/home/x/a.txt': 'alpha' });
    mockFault_set('files', '/home/x', { kind: 'refused', error: new Error('500 Internal Server Error') });
    const listed = await mount.list('/home/x');
    expect(listed.ok && listed.value.map((item: { name: string }): string => item.name)).toEqual(['sub']);
  });
});
