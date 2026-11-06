/**
 * @file A small reader for ustar archives, gzipped or not.
 *
 * A plugin index arrives as GitHub's archive of a ref (a gzipped ustar file
 * with a pax global header naming the commit) or as a `.tar.gz` an operator
 * uploaded. Both need only regular files and pax headers read, so this is a
 * reader for that much of the format and no more: no links, no devices, no
 * sparse files. Entries are returned in archive order with their paths as
 * the archive names them.
 *
 * A path that climbs out of the archive (`..`) or starts at the root is
 * refused outright rather than skipped: an archive that carries one is not
 * one this reader should be trusted to have read correctly.
 *
 * Key components:
 * - TarFile: one regular file of the archive, its path and bytes.
 * - TarArchive: the files and the pax global header's records.
 * - tarArchive_read: read an archive's regular files and global header.
 *
 * Typical usage:
 * ```ts
 * const archive: TarArchive = tarArchive_read(bytes);
 * const commit: string | undefined = archive.globals['comment'];
 * ```
 *
 * Dependencies: Node.js built-ins only (`node:zlib` for gzip).
 *
 * @module
 */

import { gunzipSync } from 'node:zlib';

/** The tar block size: headers and padded data both come in these. */
const BLOCK_BYTES: number = 512;

/** The first two bytes of a gzip stream. */
const GZIP_MAGIC: readonly number[] = [0x1f, 0x8b];

/** Header field offsets and widths, as the ustar format fixes them. */
const FIELD = {
  name: [0, 100],
  size: [124, 12],
  typeflag: [156, 1],
  magic: [257, 6],
  prefix: [345, 155],
} as const;

/**
 * One regular file read from an archive.
 *
 * @example
 * ```ts
 * const file: TarFile = { path: 'repo-abc/plugins/pl-x.json', content: Buffer.from('{}') };
 * ```
 */
export interface TarFile {
  /** The file's path as the archive names it, prefix and pax `path` applied. */
  readonly path: string;
  /** The file's bytes. */
  readonly content: Buffer;
}

/**
 * What an archive holds that a reader of plugin indexes needs.
 *
 * @example
 * ```ts
 * const archive: TarArchive = tarArchive_read(bytes);
 * archive.files.length;
 * ```
 */
export interface TarArchive {
  /** Every regular file, in archive order. */
  readonly files: TarFile[];
  /** The pax global header's records (GitHub writes the commit under `comment`). */
  readonly globals: Record<string, string>;
}

/**
 * Reads an archive's regular files and its pax global header.
 *
 * @param bytes - The archive, gzipped or plain ustar.
 * @returns The regular files in archive order and the global records.
 * @throws {Error} When the bytes are not a readable archive, or an entry's
 *   path is absolute or climbs out with `..`.
 *
 * @example
 * ```ts
 * const archive: TarArchive = tarArchive_read(readFileSync('index.tar.gz'));
 * archive.files.map((file: TarFile): string => file.path);
 * ```
 */
export function tarArchive_read(bytes: Buffer): TarArchive {
  const tar: Buffer = gzip_is(bytes) ? gunzipSync(bytes) : bytes;
  const files: TarFile[] = [];
  const globals: Record<string, string> = {};
  let pending: Record<string, string> = {};
  let offset: number = 0;
  while (offset + BLOCK_BYTES <= tar.length) {
    const header: Buffer = tar.subarray(offset, offset + BLOCK_BYTES);
    if (block_isZero(header)) break;
    if (!header.subarray(FIELD.magic[0], FIELD.magic[0] + 5).equals(Buffer.from('ustar'))) {
      throw new Error(`not a ustar archive (no ustar magic at byte ${offset})`);
    }
    const size: number = headerSize_parse(header);
    const type: string = field_read(header, FIELD.typeflag);
    const body: Buffer = tar.subarray(offset + BLOCK_BYTES, offset + BLOCK_BYTES + size);
    if (body.length < size) throw new Error('archive ends inside an entry');
    offset += BLOCK_BYTES + Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES;

    if (type === 'g') {
      Object.assign(globals, paxRecords_parse(body));
    } else if (type === 'x') {
      pending = paxRecords_parse(body);
    } else {
      const named: string = headerPath_read(header);
      const path: string = pending['path'] ?? named;
      pending = {};
      path_check(path);
      if (type === '0' || type === '' || type === '\0') files.push({ path, content: Buffer.from(body) });
    }
  }
  return { files, globals };
}

/**
 * Reports whether bytes start a gzip stream.
 *
 * @param bytes - The candidate bytes.
 * @returns True on the gzip magic number.
 */
function gzip_is(bytes: Buffer): boolean {
  return bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
}

/**
 * Reports whether a block is all zero bytes (the archive's end marker).
 *
 * @param block - One 512-byte block.
 * @returns True when every byte is zero.
 */
function block_isZero(block: Buffer): boolean {
  return block.every((byte: number): boolean => byte === 0);
}

/**
 * Reads a NUL-terminated header field as text.
 *
 * @param header - The header block.
 * @param field - The field's offset and width.
 * @returns The field's text, up to its first NUL.
 */
function field_read(header: Buffer, field: readonly [number, number]): string {
  const raw: string = header.subarray(field[0], field[0] + field[1]).toString('utf8');
  const nul: number = raw.indexOf('\0');
  return nul === -1 ? raw : raw.slice(0, nul);
}

/**
 * Reads an entry's size from its octal header field.
 *
 * @param header - The header block.
 * @returns The size in bytes.
 * @throws {Error} When the field is not octal (base-256 sizes are not read).
 */
function headerSize_parse(header: Buffer): number {
  const text: string = field_read(header, FIELD.size).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error(`unreadable entry size '${text}'`);
  return text === '' ? 0 : parseInt(text, 8);
}

/**
 * Reads an entry's path from the header's prefix and name fields.
 *
 * @param header - The header block.
 * @returns The joined path.
 */
function headerPath_read(header: Buffer): string {
  const name: string = field_read(header, FIELD.name);
  const prefix: string = field_read(header, FIELD.prefix);
  return prefix === '' ? name : `${prefix}/${name}`;
}

/**
 * Parses pax extended-header records (`<len> <key>=<value>\n`).
 *
 * @param body - The header's data.
 * @returns The records by key.
 * @throws {Error} When a record's length does not fit the data.
 */
function paxRecords_parse(body: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let at: number = 0;
  while (at < body.length) {
    const space: number = body.indexOf(0x20, at);
    if (space === -1) break;
    const length: number = parseInt(body.subarray(at, space).toString('utf8'), 10);
    if (!Number.isInteger(length) || length <= 0 || at + length > body.length) {
      throw new Error('unreadable pax header record');
    }
    const record: string = body.subarray(space + 1, at + length - 1).toString('utf8');
    const equals: number = record.indexOf('=');
    if (equals !== -1) records[record.slice(0, equals)] = record.slice(equals + 1);
    at += length;
  }
  return records;
}

/**
 * Refuses a path that is absolute or climbs out of the archive.
 *
 * @param path - The entry's path.
 * @throws {Error} When the path starts at the root or holds a `..` segment.
 */
function path_check(path: string): void {
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`archive entry '${path}' is an absolute path`);
  }
  if (path.split(/[\\/]/).includes('..')) {
    throw new Error(`archive entry '${path}' climbs out of the archive`);
  }
}
