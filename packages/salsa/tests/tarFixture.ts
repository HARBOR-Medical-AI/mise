/**
 * @file Builds small ustar archives for the tar and index tests.
 */
import { gzipSync } from 'node:zlib';

/** One entry to write. */
export interface TarSpec {
  name: string;
  content?: string;
  type?: string;
  prefix?: string;
}

/**
 * Builds one ustar header block.
 *
 * @param spec - The entry.
 * @param size - Its data size.
 * @returns The 512-byte header.
 */
function header_build(spec: TarSpec, size: number): Buffer {
  const header: Buffer = Buffer.alloc(512);
  header.write(spec.name, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(spec.type ?? '0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  if (spec.prefix !== undefined) header.write(spec.prefix, 345, 155, 'utf8');
  let sum: number = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

/**
 * Encodes pax records.
 *
 * @param records - Key/value pairs.
 * @returns The pax data.
 */
export function pax_encode(records: Record<string, string>): string {
  return Object.entries(records).map(([key, value]: [string, string]): string => {
    const body: string = ` ${key}=${value}\n`;
    let length: number = body.length + 1;
    while (`${length}${body}`.length !== length) length = `${length}${body}`.length;
    return `${length}${body}`;
  }).join('');
}

/**
 * Builds an archive from entries.
 *
 * @param specs - The entries, in order.
 * @param gzip - Whether to gzip the result.
 * @returns The archive bytes.
 */
export function tar_build(specs: TarSpec[], gzip: boolean = false): Buffer {
  const blocks: Buffer[] = [];
  for (const spec of specs) {
    const data: Buffer = Buffer.from(spec.content ?? '', 'utf8');
    blocks.push(header_build(spec, data.length));
    const padded: Buffer = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    data.copy(padded);
    blocks.push(padded);
  }
  blocks.push(Buffer.alloc(1024));
  const tar: Buffer = Buffer.concat(blocks);
  return gzip ? gzipSync(tar) : tar;
}
