/**
 * @file A name from elsewhere is placed inside its folder or refused: by
 * what the name says, and by where the links already on the disk lead.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

