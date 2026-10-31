/**
 * @file A zip of a few text files, stored without compression: what Resource
 * Manager takes as a stack's Terraform. The modules stratus keeps are small
 * and written in code, so no archive library is needed; every entry carries
 * the same time (1980-01-01), so the same files make the same bytes and a
 * module's digest says whether a stack runs this release's Terraform.
 *
 * @module
 */
import { crc32 } from 'node:zlib';

/** The DOS date of 1980-01-01, the format's first day; the time is midnight. */
const DOS_DATE: number = (0 << 9) | (1 << 5) | 1;

/**
 * Zips files, stored.
 *
 * @param files - Each file's path in the zip and its text, in order.
 * @returns The zip.
 */
export function files_zip(files: ReadonlyArray<{ path: string; text: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset: number = 0;
  for (const file of files) {
    const name: Buffer = Buffer.from(file.path, 'utf-8');
    const data: Buffer = Buffer.from(file.text, 'utf-8');
    const sum: number = crc32(data);
    const local: Buffer = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central: Buffer = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory: Buffer = Buffer.concat(centrals);
  const end: Buffer = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
