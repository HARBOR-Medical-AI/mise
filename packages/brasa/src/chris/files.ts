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
 * Writes bytes to one ChRIS path through the kernel's own create, where the
 * store keeps it (`storePath_resolve`).
 *
 * A browser surface holds bytes the daemon's machine has never seen; this
 * is how they reach the store without any surface talking to CUBE.
 *
 * @param filePath - The destination path (absolute or cwd-relative).
 * @param bytes - The content to write.
 * @throws {Error} When the store refused the write.
 */
async function file_write(filePath: string, bytes: Buffer): Promise<void> {
  const { storePath_resolve } = await import('../builtins/utils.js');
  const { files_create } = await import('@fnndsc/salsa');
  const { listCache_get } = await import('@fnndsc/cumin');
  // Where the store keeps it, as every writer asks: a `/proc` job's `data` and any link on the way.
  const resolved: string = await storePath_resolve(filePath);
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
 * Reads one ChRIS file's raw bytes where the store keeps it.
 *
 * The path is resolved as every reader resolves it (`storePath_resolve`):
 * against the working directory, through a `/proc` job's `data` link to its
 * output, and through the store's links at any depth. One file has many
 * names (its feed path, the node's own `data` in the graph, the folder a
 * `pl-dircopy` link points at) and all of them read the same bytes.
 *
 * @param filePath - The file's path (absolute, cwd-relative, or projected).
 * @returns The file's bytes.
 * @throws {FileReadRefusal} When the path does not lead to a readable file, with the kernel's reason.
 */
async function file_read(filePath: string): Promise<Buffer> {
  const { storePath_resolve } = await import('../builtins/utils.js');
  const { errorStack } = await import('@fnndsc/fond');
  const since: number = errorStack.checkpoint_mark();
  const stored: string = await storePath_resolve(filePath);
  const { vfsDispatcher } = await import('@fnndsc/salsa');
  const read: Result<Buffer> = vfsOutcome_convertToResult(await vfsDispatcher.readBinary(stored), 'readBinary', stored);
  const notes: string[] = errorStack.checkpoint_drain(since).map((note: { message: string }): string => note.message);
  if (!read.ok) throw fileRefusal_name(filePath, notes);
  return read.value;
}

/**
 * Opens one ChRIS file's bytes as a stream, at the path {@link file_read}
 * resolves, so a download is served as CUBE sends it and never held whole
 * in the daemon. A file a mount makes itself (a job's `log`) is small and
 * read whole.
 *
 * @param filePath - The file's path (absolute, cwd-relative, or projected).
 * @returns The stream and its size when CUBE gave one.
 * @throws {FileReadRefusal} When the file cannot be opened, with the kernel's reason.
 */
async function file_stream(filePath: string): Promise<FileByteStream> {
  const { storePath_resolve } = await import('../builtins/utils.js');
  const { vfsDispatcher, fileContent_getBinaryStream } = await import('@fnndsc/salsa');
  const stored: string = await storePath_resolve(filePath);
  if (vfsDispatcher.path_isVirtual(stored)) {
    const bytes: Buffer = await file_read(filePath);
    const { Readable } = await import('node:stream');
    return { stream: Readable.from(bytes), size: bytes.length };
  }
  const { errorStack } = await import('@fnndsc/fond');
  const since: number = errorStack.checkpoint_mark();
  const opened = await fileContent_getBinaryStream(stored);
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
