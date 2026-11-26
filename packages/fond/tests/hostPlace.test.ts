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
