/**
 * @file Tests for the ustar reader: the real index archive, pax headers, and refusals.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { tarArchive_read, type TarArchive } from '../src/plugins/tar_read';
import { pax_encode, tar_build } from './tarFixture';

const FIXTURE: string = join(__dirname, 'fixtures', 'chris-plugins-8c9a1f6.tar.gz');

describe('tarArchive_read', () => {
  it('reads GitHub\'s archive of the index: every file and the commit', () => {
    const archive: TarArchive = tarArchive_read(readFileSync(FIXTURE));
    expect(archive.globals['comment']).toBe('8c9a1f61c6fe2b72483f5ffc0c7ddbffb1f73b55');
    const plugins: string[] = archive.files.map((f) => f.path).filter((p) => /\/plugins\/[^/]+\.json$/.test(p));
    expect(plugins).toHaveLength(175);
    expect(archive.files.some((f) => f.path.endsWith('/schema/plugin.schema.json'))).toBe(true);
  });

  it('reads a plain archive, with a prefix and a pax path', () => {
    const read: TarArchive = tarArchive_read(tar_build([
      { name: 'a.json', content: '{"a":1}', prefix: 'root/plugins' },
      { name: 'PaxHeader', type: 'x', content: pax_encode({ path: 'root/plugins/long-name.json' }) },
      { name: 'short', content: '{}' },
      { name: 'root/dir', type: '5' },
    ]));
    expect(read.files.map((f) => f.path)).toEqual(['root/plugins/a.json', 'root/plugins/long-name.json']);
    expect(read.files[0]?.content.toString()).toBe('{"a":1}');
  });

  it('reads a gzipped archive and a global header', () => {
    const bytes: Buffer = tar_build([
      { name: 'pax_global_header', type: 'g', content: pax_encode({ comment: 'abc123' }) },
      { name: 'x/one.json', content: '1' },
    ], true);
    const read: TarArchive = tarArchive_read(bytes);
    expect(read.globals).toEqual({ comment: 'abc123' });
    expect(read.files).toHaveLength(1);
  });

  it('refuses a path that climbs out', () => {
    expect(() => tarArchive_read(tar_build([{ name: 'x/../../etc/passwd', content: 'no' }]))).toThrow('climbs out');
  });

  it('refuses an absolute path, from the header or from pax', () => {
    expect(() => tarArchive_read(tar_build([{ name: '/etc/passwd', content: 'no' }]))).toThrow('absolute');
    expect(() => tarArchive_read(tar_build([
      { name: 'PaxHeader', type: 'x', content: pax_encode({ path: '/root/x' }) },
      { name: 'x', content: '' },
    ]))).toThrow('absolute');
  });

  it('refuses bytes that are not ustar, a truncated entry, and a bad size', () => {
    expect(() => tarArchive_read(Buffer.alloc(1024, 1))).toThrow('no ustar magic');
    const whole: Buffer = tar_build([{ name: 'a', content: 'x'.repeat(600) }]);
    expect(() => tarArchive_read(whole.subarray(0, 700))).toThrow('ends inside');
    const bad: Buffer = tar_build([{ name: 'a', content: 'x' }]);
    bad.write('zzzzzzzzzzz\0', 124);
    expect(() => tarArchive_read(bad)).toThrow('unreadable entry size');
  });

  it('refuses an unreadable pax record', () => {
    expect(() => tarArchive_read(tar_build([
      { name: 'PaxHeader', type: 'x', content: '99 path=x\n' },
      { name: 'x', content: '' },
    ]))).toThrow('unreadable pax');
  });

  it('stops at the end marker and tolerates a record without a key', () => {
    const read: TarArchive = tarArchive_read(tar_build([
      { name: 'PaxHeader', type: 'g', content: '8 nokey\n' },
      { name: 'a', content: 'x' },
    ]));
    expect(read.files.map((f) => f.path)).toEqual(['a']);
    expect(read.globals).toEqual({});
  });
});
