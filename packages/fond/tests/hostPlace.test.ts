/**
 * @file A name from elsewhere is placed inside its folder or refused: by
 * what the name says, and by where the links already on the disk lead.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { wireName_place, type HostPlace } from '../src/hostPlace';

let base: string;
let folder: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'fond-place-'));
  folder = path.join(base, 'in');
  outside = path.join(base, 'out');
  mkdirSync(folder);
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** The reason a name was refused; fails the test when it was placed. */
function reason_of(placed: HostPlace): string {
  if (placed.ok) throw new Error(`placed at ${placed.place}`);
  return placed.reason;
}

describe('wireName_place, by what the name says', () => {
  it('places a plain name and a name with folders of its own, under either separator', () => {
    expect(wireName_place(folder, 'b.txt')).toEqual({ ok: true, place: path.join(folder, 'b.txt') });
    expect(wireName_place(folder, 'a/b.txt')).toEqual({ ok: true, place: path.join(folder, 'a', 'b.txt') });
    expect(wireName_place(folder, 'a\\b.txt')).toEqual({ ok: true, place: path.join(folder, 'a', 'b.txt') });
    expect(wireName_place(folder, '..hidden/...')).toEqual({ ok: true, place: path.join(folder, '..hidden', '...') });
  });

  it('places a name in a folder that does not exist yet', () => {
    const fresh: string = path.join(base, 'not', 'made', 'yet');
    expect(wireName_place(fresh, 'a/b.txt')).toEqual({ ok: true, place: path.join(fresh, 'a', 'b.txt') });
  });

  it.each([
    ['../x', "has a '..' part"],
    ['a/../../x', "has a '..' part"],
    ['a/../b', "has a '..' part"],
    ['a\\..\\x', "has a '..' part"],
    ['./x', "has a '.' part"],
    ['/etc/x', 'is an absolute path'],
    ['\\\\server\\share\\x', 'is an absolute path'],
    ['C:\\x', 'is an absolute path'],
    ['C:x', 'is an absolute path'],
    ['a//b', 'has an empty part'],
    ['a/', 'has an empty part'],
    ['a\0b', 'holds a NUL'],
  ])('refuses %j', (name: string, why: string) => {
    expect(reason_of(wireName_place(folder, name))).toContain(why);
  });

  it('refuses an empty name', () => {
    expect(reason_of(wireName_place(folder, ''))).toBe('an empty name');
  });
});

describe('wireName_place, by where the links on the disk lead', () => {
  it('refuses a name that passes through a link to a folder outside', () => {
    symlinkSync(outside, path.join(folder, 'sub'));
    expect(reason_of(wireName_place(folder, 'sub/x.txt'))).toContain('a link that leads outside');
  });

  it('refuses a name whose own place is a link to a file outside', () => {
    writeFileSync(path.join(outside, 'target.txt'), 'theirs');
    symlinkSync(path.join(outside, 'target.txt'), path.join(folder, 'x.txt'));
    expect(reason_of(wireName_place(folder, 'x.txt'))).toContain('a link that leads outside');
  });

  it('refuses a name whose place is a link that leads nowhere', () => {
    symlinkSync(path.join(base, 'gone'), path.join(folder, 'x.txt'));
    expect(reason_of(wireName_place(folder, 'x.txt'))).toContain('a link that leads nowhere');
  });

  it('refuses a name whose way cannot be looked at, rather than taking that for absence', () => {
    // A part of the way that is a file: the file system answers ENOTDIR for what lies under it, which is not ENOENT.
    writeFileSync(path.join(folder, 'afile'), 'x');
    expect(reason_of(wireName_place(folder, 'afile/x.txt'))).toContain('a place that could not be looked at');
  });

  it('refuses a name under a folder it may not look into', () => {
    if (process.getuid?.() === 0) return;
    const closed: string = path.join(folder, 'closed');
    mkdirSync(closed);
    chmodSync(closed, 0o000);
    try {
      expect(reason_of(wireName_place(folder, 'closed/x.txt'))).toContain('a place that could not be looked at');
    } finally {
      chmodSync(closed, 0o700);
    }
  });

  it('places a name through a link that stays inside the folder', () => {
    mkdirSync(path.join(folder, 'real'));
    symlinkSync(path.join(folder, 'real'), path.join(folder, 'alias'));
    expect(wireName_place(folder, 'alias/x.txt')).toEqual({ ok: true, place: path.join(folder, 'alias', 'x.txt') });
  });

  it('places a name when the folder itself is reached through a link', () => {
    const alias: string = path.join(base, 'alias-of-in');
    symlinkSync(folder, alias);
    expect(wireName_place(alias, 'a/x.txt')).toEqual({ ok: true, place: path.join(alias, 'a', 'x.txt') });
  });
});

describe('privateTemp_write, a write that fails', () => {
  it('removes the folder it made when the file cannot be written', async () => {
    const { readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const prefix: string = `fond-fail-${String(process.pid)}-`;
    const before: string[] = readdirSync(tmpdir()).filter((one: string) => one.startsWith(prefix));
    // A name that exists already in a fresh folder cannot happen; a write refused is made by data the file cannot take.
    const { privateTemp_write } = await import('../src/hostPlace.js');
    const huge = { length: 1 } as unknown as Uint8Array;
    expect(() => privateTemp_write(prefix, 'x.bin', Object.setPrototypeOf(huge, Uint8Array.prototype))).toThrow();
    expect(readdirSync(tmpdir()).filter((one: string) => one.startsWith(prefix))).toEqual(before);
    // From JavaScript, a name or a prefix that is not a string: refused before any folder is made.
    const loose = privateTemp_write as unknown as (prefix: unknown, name: unknown, data: unknown) => unknown;
    expect(() => loose(prefix, undefined, 'x')).toThrow('a plain name');
    expect(() => loose(undefined, 'x.txt', 'x')).toThrow('a plain name');
    expect(() => loose(prefix, ['a'], 'x')).toThrow('a plain name');
    expect(readdirSync(tmpdir()).filter((one: string) => one.startsWith(prefix))).toEqual(before);
  });
});

describe('privateTemp_write', () => {
  it('writes a 0600 file in a fresh 0700 folder of its own, refuses a name that is not a plain name, and removes both', async () => {
    const { privateTemp_write, suffix_safe } = await import('../src/hostPlace.js');
    const { statSync, readFileSync, existsSync } = await import('node:fs');
    const temp = privateTemp_write('fond-test-', 'edit.txt', 'held');
    expect([statSync(temp.path).mode & 0o777, statSync(temp.folder).mode & 0o777, readFileSync(temp.path, 'utf8')]).toEqual([0o600, 0o700, 'held']);
    temp.folder_remove();
    expect(existsSync(temp.folder)).toBe(false);
    for (const name of ['../x', 'a/b', '..', '.', 'a\u0000b', '']) expect(() => privateTemp_write('fond-test-', name, 'x')).toThrow('a plain name');
    expect(() => privateTemp_write('fond-test-', 'x.txt', 42)).toThrow('text or bytes');
    for (const prefix of ['../x-', 'a/b-', '.hidden', '']) expect(() => privateTemp_write(prefix, 'x.txt', 'x')).toThrow("prefix is a plain name");
    const bytes = privateTemp_write('fond-test-', 'x.bin', new Uint8Array([1, 2, 3]));
    expect([...readFileSync(bytes.path)]).toEqual([1, 2, 3]);
    bytes.folder_remove();
    expect([suffix_safe('.mise', '.txt'), suffix_safe('/../x', '.txt'), suffix_safe('.a/b', '.txt'), suffix_safe(undefined, '.txt')]).toEqual(['.mise', '.txt', '.txt', '.txt']);
  });
});

describe('owner-only places', () => {
  const uid: number = process.getuid?.() ?? 0;
  const base = (): string => mkdtempSync(path.join(tmpdir(), 'fond-own-'));

  it('holds a folder of this account\'s, 0700, through a trusted path; refuses another\'s, a wider one, a link, and a missing one to a reader', async () => {
    const { ownFolder_settle } = await import('../src/hostPlace.js');
    const root: string = base();
    const folder: string = path.join(root, 'calypso');
    expect(ownFolder_settle(folder, false)).toMatchObject({ ok: false, reason: expect.stringContaining('not there'), missing: true });
    expect(ownFolder_settle(folder, true)).toEqual({ ok: true, path: path.join(realpathSync(root), 'calypso') });
    expect(ownFolder_settle(folder, false, uid + 1)).toMatchObject({ ok: false });
    chmodSync(folder, 0o755);
    expect(ownFolder_settle(folder, false)).toMatchObject({ ok: false, reason: expect.stringContaining('wider than 0700') });
    chmodSync(folder, 0o700);
    const link: string = path.join(root, 'linked');
    symlinkSync(folder, link);
    expect(ownFolder_settle(link, false)).toMatchObject({ ok: false, reason: expect.stringContaining('a link') });
    // A parent open to others (not root's and sticky) is no trusted path.
    const open: string = path.join(root, 'open');
    mkdirSync(open, { mode: 0o777 });
    chmodSync(open, 0o777);
    expect(ownFolder_settle(path.join(open, 'calypso'), true)).toMatchObject({ ok: false, reason: expect.stringContaining('open to other accounts') });
    // A link inside an open folder, to a trusted folder of this account's: the open folder is on the way, so refused.
    const trusted: string = path.join(root, 'trusted');
    mkdirSync(trusted, { mode: 0o700 });
    symlinkSync(trusted, path.join(open, 'link'));
    expect(ownFolder_settle(path.join(open, 'link', 'calypso'), true)).toMatchObject({ ok: false, reason: expect.stringContaining('open to other accounts') });
    // A link inside a trusted folder is followed, and the place it reaches named.
    symlinkSync(trusted, path.join(root, 'alias'));
    expect(ownFolder_settle(path.join(root, 'alias', 'calypso'), true)).toEqual({ ok: true, path: path.join(realpathSync(trusted), 'calypso') });
  });

  it('says where a host\'s state root is not on a trusted path; a missing tail below trusted folders is a first start', async () => {
    const { pathTrust_refusal } = await import('../src/hostPlace.js');
    const root: string = base();
    expect(pathTrust_refusal(path.join(root, 'not', 'yet'))).toBeNull();
    const shared: string = path.join(root, 'shared');
    mkdirSync(shared, { mode: 0o775 });
    chmodSync(shared, 0o775);
    mkdirSync(path.join(shared, 'porter'), { mode: 0o700 });
    expect(pathTrust_refusal(path.join(shared, 'porter'))).toBe(`${path.join(realpathSync(root), 'shared')}: open to other accounts`);
    expect(pathTrust_refusal(path.join(shared, 'porter', 'missing'))).toContain('open to other accounts');
  });

  it('reads only a regular 0600 file of this account\'s, bounded; writes by rename; refuses a standing link or wider file and leaves it as it is', async () => {
    const { ownFolder_settle, ownFile_read, ownFile_write, ownFile_take, bytes_writeAll } = await import('../src/hostPlace.js');
    const { readFileSync, lstatSync, readdirSync } = await import('node:fs');
    const folder: string = path.join(base(), 'calypso');
    ownFolder_settle(folder, true);
    expect(ownFile_write(folder, 'berth-1.json', '{"a":1}')).toEqual({ ok: true });
    expect(lstatSync(path.join(folder, 'berth-1.json')).mode & 0o777).toBe(0o600);
    expect(ownFile_read(path.join(folder, 'berth-1.json'), 64)).toEqual({ ok: true, text: '{"a":1}' });
    expect(ownFile_read(path.join(folder, 'berth-1.json'), 3)).toMatchObject({ ok: false, reason: expect.stringContaining('larger than 3 bytes') });
    expect(ownFile_read(path.join(folder, 'berth-1.json'), 64, uid + 1)).toMatchObject({ ok: false, reason: expect.stringContaining("another account's") });
    // A valid standing record is replaced; no temporary is left beside it.
    expect(ownFile_write(folder, 'berth-1.json', '{"a":2}')).toEqual({ ok: true });
    expect(readFileSync(path.join(folder, 'berth-1.json'), 'utf8')).toBe('{"a":2}');
    expect(readdirSync(folder)).toEqual(['berth-1.json']);
    // A link planted at a record's name: refused, the link and its target untouched; a reader refuses it too.
    const target: string = path.join(base(), 'target.txt');
    writeFileSync(target, 'theirs');
    symlinkSync(target, path.join(folder, 'berth-2.json'));
    expect(ownFile_write(folder, 'berth-2.json', '{"stolen":true}')).toMatchObject({ ok: false, reason: expect.stringContaining('a link, left as it is') });
    expect(readFileSync(target, 'utf8')).toBe('theirs');
    expect(lstatSync(path.join(folder, 'berth-2.json')).isSymbolicLink()).toBe(true);
    expect(ownFile_read(path.join(folder, 'berth-2.json'), 64)).toMatchObject({ ok: false, reason: expect.stringContaining('a link') });
    // A wider standing record: refused, left; a reader refuses it.
    writeFileSync(path.join(folder, 'berth-3.json'), '{}', { mode: 0o644 });
    chmodSync(path.join(folder, 'berth-3.json'), 0o644);
    expect(ownFile_write(folder, 'berth-3.json', '{}')).toMatchObject({ ok: false, reason: expect.stringContaining('wider than 0600') });
    expect(ownFile_read(path.join(folder, 'berth-3.json'), 64)).toMatchObject({ ok: false, reason: expect.stringContaining('wider than 0600') });
    // A note taken is had once.
    ownFile_write(folder, 'closing-1.json', '{"cause":"stop"}');
    expect(ownFile_take(folder, 'closing-1.json', 64)).toEqual({ ok: true, text: '{"cause":"stop"}' });
    expect(ownFile_take(folder, 'closing-1.json', 64)).toMatchObject({ ok: false, reason: expect.stringContaining('not there'), missing: true });
    // A note that is a link, or wider: refused where it stands, and left as it is.
    symlinkSync(target, path.join(folder, 'closing-2.json'));
    expect(ownFile_take(folder, 'closing-2.json', 64)).toMatchObject({ ok: false, reason: expect.stringContaining('a link') });
    expect(lstatSync(path.join(folder, 'closing-2.json')).isSymbolicLink()).toBe(true);
    writeFileSync(path.join(folder, 'closing-3.json'), '{}', { mode: 0o644 });
    chmodSync(path.join(folder, 'closing-3.json'), 0o644);
    expect(ownFile_take(folder, 'closing-3.json', 64)).toMatchObject({ ok: false, reason: expect.stringContaining('wider than 0600') });
    expect(readFileSync(path.join(folder, 'closing-3.json'), 'utf8')).toBe('{}');
    // A write that takes several calls writes every byte; one that makes no progress fails and keeps the record.
    const short = (handle: number, bytes: Uint8Array, offset: number, length: number): number => writeSync(handle, bytes, offset, Math.min(3, length));
    expect(ownFile_write(folder, 'berth-1.json', '{"a":"complete"}', undefined, short)).toEqual({ ok: true });
    expect(readFileSync(path.join(folder, 'berth-1.json'), 'utf8')).toBe('{"a":"complete"}');
    expect(ownFile_write(folder, 'berth-1.json', '{"a":"lost"}', undefined, () => 0)).toMatchObject({ ok: false, reason: expect.stringContaining('no progress') });
    expect(readFileSync(path.join(folder, 'berth-1.json'), 'utf8')).toBe('{"a":"complete"}');
    expect(readdirSync(folder).filter((name: string): boolean => name.endsWith('.tmp'))).toEqual([]);
    expect(() => bytes_writeAll(0, new Uint8Array(4), () => -1)).toThrow('no progress');
  });
});

