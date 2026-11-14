/**
 * @file The ChRIS backend's file bytes for a surface: read from and written
 * to CUBE at a path the session resolves, `/proc` projections included.
 *
 * @module
 */
import { vfsOutcome_convertToResult } from '@fnndsc/fond';
import type { Result } from '@fnndsc/fond';
import type { Backend, FileByteStream } from '../core/backend.js';
import { FileReadRefusal } from '../core/fileRefusal.js';

/**
 * Reads the kernel's notes since a checkpoint and names the refusal: a
 * status for the route and a line for the operator. CUBE's own status is
 * taken from the note when it carries one; a file the lookup could not
 * find is 404; anything else is the kernel's own failure, 502, so a 404
 * never again stands for "something went wrong".
 *
 * @param filePath - The file asked for.
 * @param notes - The kernel's error notes since the read began, oldest first.
 * @returns The refusal to throw.
 */
export function fileRefusal_name(filePath: string, notes: ReadonlyArray<string>): FileReadRefusal {
  const last: string = notes[notes.length - 1] ?? '';
  const status: number | undefined = notes.map((note: string): number => Number(/\b(40[0-9]|41[0-9]|5[0-9][0-9])\b/.exec(note)?.[1] ?? NaN)).find((n: number): boolean => !Number.isNaN(n));
  if (status === 403 || status === 401) return new FileReadRefusal(filePath, 403, 'not yours to read: CUBE refused the bytes (403)');
  if (status === 404 || /not found|no files found/i.test(last)) return new FileReadRefusal(filePath, 404, 'no such file in CUBE (404)');
  if (status !== undefined && status >= 500) return new FileReadRefusal(filePath, 502, `CUBE could not serve it (${status})`);
  // A note reads `[function     ] | message`; the operator gets the message.
  return new FileReadRefusal(filePath, 502, last.replace(/^\[[^\]]*\]\s*\|\s*/, '').trim() || 'could not be read');
}


/**
 * Writes bytes to one ChRIS path through the kernel's own create.
 *
 * A browser surface holds bytes the daemon's machine has never seen; this
 * is how they reach the store without any surface talking to CUBE.
 *
 * @param filePath - The destination path (absolute or cwd-relative).
 * @param bytes - The content to write.
 * @throws {Error} When the store refused the write.
 */
async function file_write(filePath: string, bytes: Buffer): Promise<void> {
  const { path_resolve } = await import('../builtins/utils.js');
  const { files_create } = await import('@fnndsc/salsa');
  const { listCache_get } = await import('@fnndsc/cumin');
  const resolved: string = await path_resolve(filePath);
  const written: boolean = await files_create(bytes, resolved);
  if (!written) {
    throw new Error(`cannot write ${filePath}`);
  }
  // A write invalidates the listing it changed, as every writing builtin
  // does. Without this the browser that delivered the file asks for the
  // folder again and is served the folder as it was before the delivery —
  // which reads as an upload that silently did nothing.
  const parent: string = resolved.replace(/\/[^/]*$/, '') || '/';
  listCache_get().cache_invalidate(parent);
}

/**
 * A `/proc` job data path as the physical file behind it, when the node's
 * output folder is a link. Returns the input unchanged when it is not a
 * data path or resolves no further.
 *
 * @param projected - A path under a projection.
 * @returns The physical path, or the input.
 */
async function projectedPath_physical(projected: string): Promise<string> {
  try {
    const link: RegExpExecArray | null = /^(\/proc\/jobs\/feed_\d+\/[^/]+\/data)(\/.*)?$/.exec(projected);
    if (link === null) return projected;
    const { vfsDispatcher } = await import('@fnndsc/salsa');
    const target: Result<string> = await vfsDispatcher.linkTarget_resolve(link[1] as string);
    if (!target.ok) return projected;
    const { logicalPath_resolve } = await import('@fnndsc/chili/utils');
    const physical: Result<string> = await logicalPath_resolve(`${target.value}${link[2] ?? ''}`);
    return physical.ok ? physical.value : projected;
  } catch {
    return projected;
  }
}

/**
 * Reads one ChRIS file's raw bytes through ChILI, resolved against the
 * session's working directory.
 *
 * Resolved, as its twin {@link file_write} is: a surface addresses a file
 * the way the session does, and the session's paths include the relative
 * ones and the `/proc` projections. Handing the raw path to ChILI meant a
 * volume produced by a run could not be read at the address the graph
 * itself gives for it — the node's own `data` — while the same bytes read
 * fine under `/home`. One file, two names, one of them refused.
 *
 * @param filePath - The file's path (absolute, cwd-relative, or projected).
 * @returns The file's bytes.
 * @throws {Error} When the path does not resolve to a readable file.
 */
async function file_read(filePath: string): Promise<Buffer> {
  const { path_resolve } = await import('../builtins/utils.js');
  const { errorStack } = await import('@fnndsc/fond');
  const since: number = errorStack.checkpoint_mark();
  const refusal = (): FileReadRefusal => fileRefusal_name(filePath, errorStack.checkpoint_drain(since).map((note: { message: string }): string => note.message));
  const resolved: string = await path_resolve(filePath);
  const { vfsDispatcher } = await import('@fnndsc/salsa');
  // A projection is read by the provider that owns it — `/proc/jobs/…/data`
  // follows the node's own data link and delegates to the file behind it.
  // ChILI's cat knows only CFS, so a path under a projection reached this
  // route and 404'd: the volume a run had just produced could not be read
  // at the address its own graph gives for it.
  if (vfsDispatcher.path_isVirtual(resolved)) {
    const projected: Result<Buffer> = vfsOutcome_convertToResult(await vfsDispatcher.readBinary(resolved), 'readBinary', resolved);
    if (projected.ok) return projected.value;
    // A node's data link can point at a folder that is ITSELF a link — a
    // `pl-dircopy` of a PACS pull stores its DICOM under `/SERVICES/PACS`
    // — and the provider hands back the logical name, which no file id
    // answers to. Follow it the rest of the way rather than refusing a
    // file the same graph just listed.
    const physical: string = await projectedPath_physical(resolved);
    if (physical !== resolved) {
      const { files_catBinary: catLinked } = await import('@fnndsc/chili/commands/fs/cat.js');
      const followed: Result<Buffer> = await catLinked(physical);
      if (followed.ok) return followed.value;
    }
    throw refusal();
  }
  const { files_catBinary } = await import('@fnndsc/chili/commands/fs/cat.js');
  const result: Result<Buffer> = await files_catBinary(resolved);
  if (!result.ok) {
    throw refusal();
  }
  errorStack.checkpoint_drain(since);
  return result.value;
}

/**
 * Opens one ChRIS file's bytes as a stream, resolved as {@link file_read}
 * resolves, so a download is served as CUBE sends it and never held whole
 * in the daemon. A projection (`/proc/…/data`) is read whole, as before:
 * those are small virtual files or links the read already follows.
 *
 * @param filePath - The file's path (absolute, cwd-relative, or projected).
 * @returns The stream and its size when CUBE gave one.
 * @throws {FileReadRefusal} When the file cannot be opened, with the kernel's reason.
 */
async function file_stream(filePath: string): Promise<FileByteStream> {
  const { path_resolve } = await import('../builtins/utils.js');
  const { vfsDispatcher, fileContent_getBinaryStream } = await import('@fnndsc/salsa');
  const resolved: string = await path_resolve(filePath);
  // A node's `/proc/…/data` path streams the file behind its data link; any
  // other projection is small and read whole.
  let target: string = resolved;
  if (vfsDispatcher.path_isVirtual(resolved)) {
    target = await projectedPath_physical(resolved);
    if (target === resolved) {
      const bytes: Buffer = await file_read(filePath);
      const { Readable } = await import('node:stream');
      return { stream: Readable.from(bytes), size: bytes.length };
    }
  }
  const { errorStack } = await import('@fnndsc/fond');
  const since: number = errorStack.checkpoint_mark();
  const { path_resolveChrisFs } = await import('@fnndsc/chili/utils/cli.js');
  const physical: string = await path_resolveChrisFs(target, {});
  const opened = await fileContent_getBinaryStream(physical);
  const notes: string[] = errorStack.checkpoint_drain(since).map((note: { message: string }): string => note.message);
  if (!opened.ok) throw fileRefusal_name(filePath, notes);
  const value = opened.value as { stream: unknown; size?: number };
  // A PACS file comes back whole, as a Buffer in the stream's place: it is
  // handed on as a stream of that one chunk, which is what a reader expects.
  if (Buffer.isBuffer(value.stream)) {
    const { Readable } = await import('node:stream');
    return { stream: Readable.from(value.stream), size: value.size ?? value.stream.length };
  }
  return { stream: value.stream as NodeJS.ReadableStream, ...(value.size !== undefined ? { size: value.size } : {}) };
}

/** The ChRIS backend's files. */
export const chrisFiles: NonNullable<Backend['files']> = {
  read: file_read,
  write: file_write,
  stream: file_stream,
};
