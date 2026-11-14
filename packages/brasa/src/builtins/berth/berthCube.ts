/**
 * @file What `berth anchor` asks of ChRIS: a path resolved as the session
 * resolves it, what stands there, every file beneath it with its size, a
 * plugin instance's status, and one file's bytes.
 *
 * Every read goes through the session's own kernel (salsa, with the
 * session's token), so an anchor reads only what ChRIS lets that person
 * read. A folder is walked through the session's dispatcher, its links
 * followed to the folders they name (a node's output that is a link to a
 * PACS series, an upload a feed was made from). A PACS file comes back whole,
 * as a Buffer, where any other comes back as a stream; both are handed on.
 *
 * Key components:
 * - RemoteEntry, RemoteFile, RemoteBytes: what the reads answer.
 * - berthHome_get: the person's home in ChRIS.
 * - berthPath_resolve: a typed path as an absolute ChRIS path.
 * - remoteEntry_read: what stands at a path, a file or a folder.
 * - remoteTree_list: every file under a folder, with its size and where to read it.
 * - nodeStatus_get: a plugin instance's status, as CUBE reports it.
 * - remoteFile_open: one file's bytes, a stream or a Buffer.
 *
 * Typical usage:
 * ```ts
 * const path: string = await berthPath_resolve('~/uploads/weights');
 * const files: RemoteFile[] = await remoteTree_list(path);
 * const bytes: RemoteBytes = await remoteFile_open(files[0].source);
 * ```
 *
 * Dependencies: a connected ChRIS session (salsa); the session's dispatcher
 * and path mapper. Sizes are bytes.
 *
 * @module
 */
import { posix } from 'node:path';

import type { Result, VFSItem } from '@fnndsc/fond';

import { backendInstalled_get } from '../../core/backend.js';
import { vfsDispatcher_get } from '../../core/filesystem.js';
import { path_resolve } from '../../core/paths.js';

/** A `/proc/jobs` path at or under a job's `data` link: the link, and what follows it. */
const PROC_DATA_PATH: RegExp = /^(\/proc\/jobs\/feed_\d+(?:\/[^/]+_\d+)+\/data)(\/.*)?$/;

/** Listing kinds that are folders to walk into. */
const FOLDER_KINDS: ReadonlySet<string> = new Set(['dir', 'vfs']);

/**
 * What stands at a ChRIS path.
 *
 * @example
 * ```ts
 * const entry: RemoteEntry = { kind: 'file', size: 1024 };
 * ```
 */
export interface RemoteEntry {
  /** A file, or a folder (a link to a folder counts as one). */
  readonly kind: 'file' | 'folder';
  /** A file's size in bytes; 0 for a folder. */
  readonly size: number;
}

/**
 * One file under a folder being anchored.
 *
 * @example
 * ```ts
 * const file: RemoteFile = { name: 'anat/t1.nii', source: '/home/alice/uploads/s/anat/t1.nii', size: 1024 };
 * ```
 */
export interface RemoteFile {
  /** Its name relative to the folder, with `/` between parts. */
  readonly name: string;
  /** The ChRIS path its bytes are read from, links followed. */
  readonly source: string;
  /** Its size in bytes. */
  readonly size: number;
}

/**
 * One file's bytes as ChRIS sent them: a stream, or a PACS file whole.
 *
 * @example
 * ```ts
 * const bytes: RemoteBytes = { stream: Buffer.from('DICM') };
 * ```
 */
export interface RemoteBytes {
  /** The bytes: a stream to read, or the whole file. */
  readonly stream: NodeJS.ReadableStream | Buffer;
}

/**
 * The person's home in ChRIS, `/home/<user>`.
 *
 * @returns The home the session names; `/` when no session is installed.
 *
 * @example
 * ```ts
 * await berthHome_get(); // '/home/alice'
 * ```
 */
export async function berthHome_get(): Promise<string> {
  return (await backendInstalled_get()?.session.home_get()) ?? '/';
}

/**
 * A typed path as an absolute ChRIS path: relative to the working directory,
 * `~` for the home, and a `/proc/jobs/…/data` path through the job's link
 * to the output it names, as `ls` and `download` enter it.
 *
 * @param typed - The path as typed.
 * @returns The absolute path.
 *
 * @example
 * ```ts
 * await berthPath_resolve('~/uploads/weights'); // '/home/alice/uploads/weights'
 * ```
 */
export async function berthPath_resolve(typed: string): Promise<string> {
  const resolved: string = await path_resolve(typed);
  const link: RegExpMatchArray | null = resolved.match(PROC_DATA_PATH);
  if (link === null) return resolved;
  const target: Result<string> = await vfsDispatcher_get().linkTarget_resolve(link[1] as string);
  return target.ok ? `${target.value}${link[2] ?? ''}` : resolved;
}

/**
 * The path CUBE stores a logical path at, links followed; the path as given
 * when it maps to nothing else.
 *
 * @param logical - An absolute ChRIS path.
 * @returns The physical path.
 */
async function physicalPath_get(logical: string): Promise<string> {
  try {
    const { logicalPath_resolve } = await import('@fnndsc/chili/utils');
    const physical: Result<string> = await logicalPath_resolve(logical);
    return physical.ok ? physical.value : logical;
  } catch {
    return logical;
  }
}

/**
 * Lists one folder through the session's dispatcher.
 *
 * @param folder - The folder.
 * @returns Its entries.
 * @throws {Error} When it cannot be listed: a walk must not read an unlistable folder as an empty one.
 */
async function folder_list(folder: string): Promise<VFSItem[]> {
  const listed: Result<VFSItem[]> = await vfsDispatcher_get().list(folder);
  if (!listed.ok) throw new Error(`cannot list ${folder}`);
  return listed.value;
}

/**
 * What stands at a path: a file with its size, a folder, or nothing.
 *
 * @param target - An absolute ChRIS path.
 * @returns The entry, or null when nothing of that name is in its folder.
 * @throws {Error} When the folder holding it cannot be listed.
 *
 * @example
 * ```ts
 * await remoteEntry_read('/home/alice/uploads/t1.nii'); // { kind: 'file', size: 1024 }
 * ```
 */
export async function remoteEntry_read(target: string): Promise<RemoteEntry | null> {
  if (target === '/') return { kind: 'folder', size: 0 };
  const items: VFSItem[] = await folder_list(posix.dirname(target));
  const found: VFSItem | undefined = items.find((item: VFSItem): boolean => item.name === posix.basename(target));
  if (found === undefined) return null;
  return found.type === 'file' ? { kind: 'file', size: found.size } : { kind: 'folder', size: 0 };
}

/**
 * Every file under a folder, walked depth first, links followed to the
 * folders they name; a folder already walked is not walked again.
 *
 * @param folder - The folder as listed (a physical path).
 * @param prefix - The relative name of the folder under the anchor ('' at its top).
 * @param seen - Folders already walked.
 * @returns The files.
 * @throws {Error} When a folder under it cannot be listed.
 */
async function folderFiles_walk(folder: string, prefix: string, seen: Set<string>): Promise<RemoteFile[]> {
  if (seen.has(folder)) return [];
  seen.add(folder);
  const files: RemoteFile[] = [];
  for (const item of await folder_list(folder)) {
    const name: string = prefix === '' ? item.name : `${prefix}/${item.name}`;
    const here: string = posix.join(folder, item.name);
    if (item.type === 'file') {
      files.push({ name, source: here, size: item.size });
    } else if (FOLDER_KINDS.has(item.type)) {
      files.push(...await folderFiles_walk(here, name, seen));
    } else if (item.type === 'link' && item.target !== undefined && item.target !== '') {
      const target: string = item.target.startsWith('/') ? item.target : posix.join(folder, item.target);
      files.push(...await folderFiles_walk(target, name, seen));
    }
  }
  return files;
}

/**
 * Every file under a ChRIS folder, with its size and the path to read it at.
 *
 * @param folder - An absolute ChRIS path (logical: the folder as the person sees it).
 * @returns The files, by name relative to the folder; empty for an empty folder.
 * @throws {Error} When a folder under it cannot be listed.
 *
 * @example
 * ```ts
 * await remoteTree_list('/home/alice/uploads/s'); // [{ name: 'anat/t1.nii', source: '/home/alice/uploads/s/anat/t1.nii', size: 1024 }]
 * ```
 */
export async function remoteTree_list(folder: string): Promise<RemoteFile[]> {
  return folderFiles_walk(await physicalPath_get(folder), '', new Set());
}

/**
 * One ChRIS file as a file to read: its path with links followed.
 *
 * @param file - An absolute ChRIS path to a file.
 * @param size - Its size in bytes.
 * @returns The file, named by its last part.
 *
 * @example
 * ```ts
 * await remoteFile_locate('/home/alice/uploads/t1.nii', 1024); // { name: 't1.nii', source: '/home/alice/uploads/t1.nii', size: 1024 }
 * ```
 */
export async function remoteFile_locate(file: string, size: number): Promise<RemoteFile> {
  return { name: posix.basename(file), source: await physicalPath_get(file), size };
}

/**
 * A plugin instance's status, as CUBE reports it.
 *
 * @param instanceId - The plugin instance's id.
 * @returns Its status (`finishedSuccessfully`, `started`, …).
 * @throws {Error} When CUBE does not answer for it.
 *
 * @example
 * ```ts
 * await nodeStatus_get(41); // 'finishedSuccessfully'
 * ```
 */
export async function nodeStatus_get(instanceId: number): Promise<string> {
  const { job_statusFetch } = await import('@fnndsc/salsa');
  const status: Result<string> = await job_statusFetch(instanceId);
  if (!status.ok) throw new Error(`cannot read the status of plugin instance ${instanceId}`);
  return status.value;
}

/**
 * One ChRIS file's bytes, as the kernel reads them with the session's token.
 *
 * @param source - The file's path (physical).
 * @returns Its bytes: a stream, or a PACS file whole as a Buffer.
 * @throws {Error} When ChRIS does not give the bytes.
 *
 * @example
 * ```ts
 * const bytes: RemoteBytes = await remoteFile_open('/home/alice/uploads/t1.nii');
 * ```
 */
export async function remoteFile_open(source: string): Promise<RemoteBytes> {
  const { fileContent_getBinaryStream } = await import('@fnndsc/salsa');
  const opened: Result<{ stream: unknown; size?: number }> = await fileContent_getBinaryStream(source);
  if (!opened.ok) throw new Error(`cannot read ${source}`);
  const stream: unknown = opened.value.stream;
  if (Buffer.isBuffer(stream)) return { stream };
  return { stream: stream as NodeJS.ReadableStream };
}
