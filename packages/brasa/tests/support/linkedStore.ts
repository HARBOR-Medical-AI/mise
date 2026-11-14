/**
 * @file A store with a run's output that holds a `.chrislink`, reached two
 * ways: by the feed path, and by the graph's own address under `/proc/jobs`.
 * The file commands' tests stand on it to pin that a path through a link
 * lands where the link points, for readers and writers alike.
 *
 * The store is a map of paths to entries, served by a fallback provider
 * that records every operation it is asked; `/proc/jobs` is a mount that
 * stands for the run's output folder, as salsa's does; the backend's link
 * walk follows the store's links at any depth, as the ChRIS backend's does.
 *
 * Typical usage:
 * ```ts
 * const store: LinkedStore = linkedStore_install();
 * await builtin_mkdir([`${VIA_PROC}/new`]);
 * expect(store.entries.has(`${LINKED}/new`)).toBe(true);
 * ```
 *
 * It need not be installed before the command under test is imported: the
 * commands ask `vfsDispatcher_get()` and the backend each time they run.
 *
 * @module
 */
import { posix } from 'node:path';
import { Ok, Err, errorStack, VFSDispatcher, vfs_ok, vfs_fail, type Result, type VFSItem, type VFSProvider, type VfsOutcome } from '@fnndsc/fond';

import { backend_install } from '../../src/core/backend.js';

/** The person whose home the store holds. */
export const HOME: string = '/home/alice';
/** A run's output folder in the store, as CUBE records it. */
export const OUTPUT: string = `${HOME}/feeds/feed_5/pl-dircopy_10/data`;
/** The `.chrislink` the run left in its output, by its feed path. */
export const VIA_FEED: string = `${OUTPUT}/home_alice_uploads_set`;
/** The same link by the graph's own address. */
export const VIA_PROC: string = '/proc/jobs/feed_5/pl-dircopy_10/data/home_alice_uploads_set';
/** Where the link points. */
export const LINKED: string = `${HOME}/uploads/set`;

/** One entry of the store. */
export interface StoreEntry {
  /** A folder, a file, or a link to a folder. */
  type: 'dir' | 'file' | 'link';
  /** A file's text. */
  content?: string;
  /** A link's target. */
  target?: string;
}

/** The installed store: its entries, and the operations it was asked, in order. */
export interface LinkedStore {
  /** Every entry, by store path. */
  readonly entries: Map<string, StoreEntry>;
  /** Each operation asked of the store: `verb path [path]`. */
  readonly calls: string[];
  /** Folders that refuse every write in them (`EACCES`), to stand for CUBE refusing one. */
  readonly refusing: Set<string>;
}

/**
 * The store's entries as a run leaves them: the home, the upload the link
 * points at with one file in it, and the run's output holding the link.
 *
 * @returns The entries.
 */
function entries_seed(): Map<string, StoreEntry> {
  const entries: Map<string, StoreEntry> = new Map();
  for (const folder of ['/home', HOME, `${HOME}/uploads`, LINKED, `${HOME}/feeds`, `${HOME}/feeds/feed_5`, `${HOME}/feeds/feed_5/pl-dircopy_10`, OUTPUT]) {
    entries.set(folder, { type: 'dir' });
  }
  entries.set(`${LINKED}/hello.txt`, { type: 'file', content: 'hello\nworld\n' });
  entries.set(`${LINKED}/inner`, { type: 'dir' });
  entries.set(`${LINKED}/inner/deep.txt`, { type: 'file', content: 'deep\n' });
  entries.set(VIA_FEED, { type: 'link', target: LINKED });
  return entries;
}

/**
 * Follows the store's links at any depth, as the ChRIS backend's walk does.
 *
 * @param entries - The store.
 * @param at - A store path.
 * @returns The path with every link on it followed.
 */
function links_follow(entries: Map<string, StoreEntry>, at: string): string {
  const parts: string[] = at.split('/').filter((part: string): boolean => part !== '');
  let walked: string = '';
  for (const part of parts) {
    walked = `${walked}/${part}`;
    const entry: StoreEntry | undefined = entries.get(walked);
    if (entry?.type === 'link' && entry.target !== undefined) walked = entry.target;
  }
  return walked === '' ? '/' : walked;
}

/**
 * The store as a provider: the fallback for every path no mount claims.
 *
 * @param store - The store's state.
 * @returns The provider.
 */
function storeProvider_make(store: LinkedStore): VFSProvider {
  const { entries, calls, refusing } = store;
  const parent = (path: string): string => posix.dirname(path);
  const refused = (path: string): boolean => refusing.has(parent(path)) || refusing.has(path);
  return {
    prefix: '',
    async list(path: string): Promise<Result<VFSItem[]>> {
      calls.push(`list ${path}`);
      const entry: StoreEntry | undefined = entries.get(path);
      if (path !== '/' && entry?.type !== 'dir') {
        errorStack.stack_push('error', `could not initialize contextObject of type folder ${path}`);
        return Err();
      }
      const items: VFSItem[] = [...entries.entries()]
        .filter(([key]: [string, StoreEntry]): boolean => key !== path && parent(key) === path)
        .map(([key, held]: [string, StoreEntry]): VFSItem => ({
          name: posix.basename(key), type: held.type, size: held.content?.length ?? 0, owner: 'alice', date: '2026-11-14',
          ...(held.target !== undefined ? { target: held.target } : {}),
        }));
      return Ok(items);
    },
    async read(path: string): Promise<VfsOutcome<string>> {
      calls.push(`read ${path}`);
      const entry: StoreEntry | undefined = entries.get(path);
      return entry?.type === 'file' ? vfs_ok(entry.content ?? '') : vfs_fail('ENOENT');
    },
    async readBinary(path: string): Promise<VfsOutcome<Buffer>> {
      calls.push(`readBinary ${path}`);
      const entry: StoreEntry | undefined = entries.get(path);
      return entry?.type === 'file' ? vfs_ok(Buffer.from(entry.content ?? '')) : vfs_fail('ENOENT');
    },
    async write(path: string, content: string | Buffer): Promise<VfsOutcome> {
      calls.push(`write ${path}`);
      if (refused(path)) return vfs_fail('EACCES');
      if (entries.get(parent(path))?.type !== 'dir') return vfs_fail('ENOENT');
      if (entries.get(path)?.type === 'dir') return vfs_fail('EISDIR');
      entries.set(path, { type: 'file', content: content.toString() });
      return vfs_ok(true);
    },
    async mkdir(path: string): Promise<VfsOutcome> {
      calls.push(`mkdir ${path}`);
      if (refused(path)) return vfs_fail('EACCES');
      if (entries.has(path)) return vfs_fail('EEXIST');
      if (entries.get(parent(path))?.type !== 'dir') return vfs_fail('ENOENT');
      entries.set(path, { type: 'dir' });
      return vfs_ok(true);
    },
    async rm(path: string): Promise<VfsOutcome> {
      calls.push(`rm ${path}`);
      if (refused(path)) return vfs_fail('EACCES');
      if (!entries.delete(path)) return vfs_fail('ENOENT');
      return vfs_ok(true);
    },
    async rmdir(path: string): Promise<VfsOutcome> {
      calls.push(`rmdir ${path}`);
      if (refused(path)) return vfs_fail('EACCES');
      if (entries.get(path)?.type !== 'dir') return vfs_fail('ENOENT');
      if ([...entries.keys()].some((key: string): boolean => parent(key) === path)) return vfs_fail('ENOTEMPTY');
      entries.delete(path);
      return vfs_ok(true);
    },
    async rename(src: string, dest: string): Promise<VfsOutcome> {
      calls.push(`rename ${src} ${dest}`);
      if (refused(src) || refused(dest)) return vfs_fail('EACCES');
      const moving: string[] = [...entries.keys()].filter((key: string): boolean => key === src || key.startsWith(`${src}/`));
      if (moving.length === 0) return vfs_fail('ENOENT');
      for (const key of moving) {
        const entry: StoreEntry = entries.get(key) as StoreEntry;
        entries.delete(key);
        entries.set(`${dest}${key.slice(src.length)}`, entry);
      }
      return vfs_ok(true);
    },
    async cp(src: string, dest: string): Promise<VfsOutcome> {
      calls.push(`cp ${src} ${dest}`);
      if (refused(dest)) return vfs_fail('EACCES');
      const entry: StoreEntry | undefined = entries.get(src);
      if (entry === undefined) return vfs_fail('ENOENT');
      if (entries.get(parent(dest))?.type !== 'dir') return vfs_fail('ENOENT');
      entries.set(dest, { ...entry });
      return vfs_ok(true);
    },
  };
}

/**
 * The `/proc/jobs` mount: it stands for the run's output folder under its
 * `data`, and holds nothing else itself.
 *
 * @param calls - Where it records what it is asked.
 * @returns The provider.
 */
function procProvider_make(calls: string[]): VFSProvider {
  const data: RegExp = /^\/proc\/jobs\/feed_5\/pl-dircopy_10\/data(\/.*)?$/;
  return {
    prefix: '/proc/jobs',
    async list(path: string): Promise<Result<VFSItem[]>> {
      calls.push(`proc list ${path}`);
      return Ok([]);
    },
    async cp(): Promise<VfsOutcome> {
      return vfs_fail('EROFS');
    },
    async storePath_resolve(path: string): Promise<Result<string | null>> {
      const match: RegExpExecArray | null = data.exec(path);
      return Ok(match === null ? null : `${OUTPUT}${match[1] ?? ''}`);
    },
  };
}

/**
 * Installs the store as the session's backend: its dispatcher, its link
 * walk and its home.
 *
 * @returns The store, freshly seeded.
 */
export function linkedStore_install(): LinkedStore {
  const store: LinkedStore = { entries: entries_seed(), calls: [], refusing: new Set() };
  const dispatcher: VFSDispatcher = new VFSDispatcher(storeProvider_make(store));
  dispatcher.provider_register(procProvider_make(store.calls));
  backend_install({
    id: 'linked-store',
    session: { home_get: async (): Promise<string> => HOME },
    vfs: { dispatcher, path_physical: async (path: string): Promise<string> => links_follow(store.entries, path) },
  } as never);
  return store;
}
