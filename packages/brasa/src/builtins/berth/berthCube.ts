/**
 * @file What the `berth` verbs ask of ChRIS: a path resolved as the session
 * resolves it, what stands there, every file beneath it with its size, a
 * plugin instance's status and one file's bytes, for an anchor; and for a
 * close, a local folder uploaded into the person's files, a ds plugin run as
 * a child of a node, and a feed started from an fs plugin over some paths.
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
 * - folderContents_upload: everything inside a local folder, into a ChRIS folder.
 * - pluginChild_run: a registered plugin run by name as a child of a plugin instance.
 * - feedRoot_create: a new feed whose root is `pl-dircopy` over some paths.
 * - feedName_set: a feed named.
 * - AttachOutcome, UploadOutcome: what those answer.
 *
 * Typical usage:
 * ```ts
 * const path: string = await berthPath_resolve('~/uploads/weights');
 * const files: RemoteFile[] = await remoteTree_list(path);
 * const bytes: RemoteBytes = await remoteFile_open(files[0].source);
 * ```
 *
 * Dependencies: a connected ChRIS session (salsa); the session's dispatcher
 * and path mapper; chili's folder upload, the one `upload` runs. Sizes are
 * bytes. A run or a feed CUBE refuses answers with CUBE's reason, as the
 * kernel stacked it.
 *
 * @module
 */
import { readdirSync } from 'node:fs';
import { join, posix } from 'node:path';

import { errorStack, type Result, type StackMessage, type VFSItem } from '@fnndsc/fond';

import { backendInstalled_get } from '../../core/backend.js';
import { error_stripDebugPrefix } from '../../core/errorText.js';
import { vfsDispatcher_get } from '../../core/filesystem.js';
import { path_resolve } from '../../core/paths.js';
import { sink_get } from '../../core/sink.js';

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

/**
 * What a plugin run or a feed's start answered: the plugin instance made, or
 * CUBE's reason for making none.
 *
 * @example
 * ```ts
 * const made: AttachOutcome = { ok: true, instance: 57, feed: 5, pluginName: 'pl-dsdircopy' };
 * const refused: AttachOutcome = { ok: false, reason: 'No matching plugins found' };
 * ```
 */
export type AttachOutcome = AttachMade | AttachRefused;

/** A plugin instance made. */
export interface AttachMade {
  /** The instance was made. */
  readonly ok: true;
  /** Its id. */
  readonly instance: number;
  /** The feed it is in; null when CUBE did not say. */
  readonly feed: number | null;
  /** The plugin's name, as CUBE gave it. */
  readonly pluginName: string;
}

/** No plugin instance made, and why. */
export interface AttachRefused {
  /** No instance was made. */
  readonly ok: false;
  /** CUBE's reason, as the kernel stacked it. */
  readonly reason: string;
}

/**
 * What an upload of a folder's contents did.
 *
 * @example
 * ```ts
 * const sent: UploadOutcome = { files: 3, bytes: 1024, failed: 0 };
 * ```
 */
export interface UploadOutcome {
  /** The files that reached ChRIS. */
  readonly files: number;
  /** Their bytes. */
  readonly bytes: number;
  /** The files that did not. */
  readonly failed: number;
}

/**
 * CUBE's reason for a refusal: what the kernel stacked since a mark, taken off the stack.
 *
 * @param mark - The stack's mark before the call.
 * @param fallback - The words when nothing was stacked.
 * @returns The reason.
 */
function cubeReason_take(mark: number, fallback: string): string {
  const stacked: StackMessage[] = errorStack.checkpoint_drain(mark);
  const words: string[] = stacked.map((message: StackMessage): string => error_stripDebugPrefix(message.message).trim()).filter((message: string): boolean => message !== '');
  return words.length > 0 ? words.join('; ') : fallback;
}

/**
 * Uploads everything inside a local folder into a ChRIS folder: each entry
 * keeps its name under the target, a folder with all it holds, hidden files
 * too. It is the upload `upload` runs, with its progress, entry by entry, so
 * the local folder's own name is not added to the target.
 *
 * @param local - The local folder.
 * @param target - The ChRIS folder, absolute; the upload makes it.
 * @returns What reached ChRIS and what did not.
 * @throws {Error} When the upload cannot start (a local entry that cannot be read).
 *
 * @example
 * ```ts
 * await folderContents_upload('/outgoing', '/home/alice/berth/0b6c…'); // { files: 3, bytes: 1024, failed: 0 }
 * ```
 */
export async function folderContents_upload(local: string, target: string): Promise<UploadOutcome> {
  const { files_uploadWithProgress } = await import('@fnndsc/chili/commands/fs/upload.js');
  let files: number = 0;
  let bytes: number = 0;
  let failed: number = 0;
  for (const name of readdirSync(local).sort()) {
    const summary: { transferredCount: number; transferSize: number; failedCount: number } = await files_uploadWithProgress(join(local, name), target, {
      expandLocalGlob: false,
      force: true,
      onNotice: (message: string, channel: 'status' | 'err'): void => {
        if (channel === 'err') sink_get().err_write(`${message}\n`);
      },
      onProgress: (event): void => sink_get().progress_write({ ...event, label: name }),
    });
    files += summary.transferredCount;
    bytes += summary.transferSize;
    failed += summary.failedCount;
  }
  const { listCache_get } = await import('@fnndsc/cumin');
  listCache_get().cache_invalidateTree(target);
  listCache_get().cache_invalidate(posix.dirname(target));
  return { files, bytes, failed };
}

/**
 * Runs a registered plugin by name as a child of a plugin instance, as a
 * line run in that node's folder does: the version CUBE lists first under
 * that exact name.
 *
 * @param plugin - The plugin's name, `pl-dsdircopy`.
 * @param parent - The plugin instance it runs after.
 * @param parameters - Its parameters by name (`dir`), and `title` for the node.
 * @returns The instance made, or CUBE's reason.
 *
 * @example
 * ```ts
 * await pluginChild_run('pl-dsdircopy', 41, { dir: '/home/alice/berth/0b6c…', title: 'berth work' });
 * ```
 */
export async function pluginChild_run(plugin: string, parent: number, parameters: Readonly<Record<string, string>>): Promise<AttachOutcome> {
  const { plugin_run } = await import('@fnndsc/salsa');
  const mark: number = errorStack.checkpoint_mark();
  const made: Record<string, unknown> | null = await plugin_run(`name_exact:${plugin}`, { ...parameters, previous_id: parent });
  const instance: unknown = made?.['id'];
  if (made === null || typeof instance !== 'number') return { ok: false, reason: cubeReason_take(mark, `CUBE made no ${plugin} instance`) };
  errorStack.checkpoint_drain(mark);
  const feed: unknown = made['feed_id'];
  const pluginName: unknown = made['plugin_name'];
  return { ok: true, instance, feed: typeof feed === 'number' ? feed : null, pluginName: typeof pluginName === 'string' ? pluginName : plugin };
}

/**
 * Starts a new feed from `pl-dircopy` over some ChRIS paths: its `dir` is
 * the paths joined by commas, as the fs plugin takes several, and its title
 * names the feed, as CUBE names a feed after its root.
 *
 * @param paths - The ChRIS paths, absolute.
 * @param name - The feed's name, the root node's title.
 * @returns The root instance made with its feed, or CUBE's reason.
 *
 * @example
 * ```ts
 * await feedRoot_create(['/home/alice/uploads/weights', '/PUBLIC/atlas'], 'berth work');
 * ```
 */
export async function feedRoot_create(paths: readonly string[], name: string): Promise<AttachOutcome> {
  const { feed_create } = await import('@fnndsc/salsa');
  const mark: number = errorStack.checkpoint_mark();
  const made: { id: number; pluginInstance: { data: { id: number } } } | null = await feed_create([...paths], { title: name });
  const instance: unknown = made?.pluginInstance.data.id;
  if (made === null || typeof instance !== 'number') return { ok: false, reason: cubeReason_take(mark, 'CUBE made no feed') };
  errorStack.checkpoint_drain(mark);
  return { ok: true, instance, feed: made.id, pluginName: 'pl-dircopy' };
}

/**
 * Names a feed.
 *
 * @param feed - The feed's id.
 * @param name - Its name.
 * @returns Null when CUBE took it; else CUBE's reason.
 *
 * @example
 * ```ts
 * await feedName_set(12, 'seg run'); // null
 * ```
 */
export async function feedName_set(feed: number, name: string): Promise<string | null> {
  const { feed_rename } = await import('@fnndsc/cumin');
  const mark: number = errorStack.checkpoint_mark();
  const renamed: Result<boolean> = await feed_rename(feed, name);
  if (!renamed.ok) return cubeReason_take(mark, `CUBE did not name feed ${feed}`);
  errorStack.checkpoint_drain(mark);
  return null;
}
