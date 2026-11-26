/**
 * @file `/scripts`: the library mounted in the session (docs/stratus.adoc,
 * D17). `/scripts/<source>/…` is a source's folder in its clone, read-only;
 * `/scripts/mine/…` is this host's own folder, written to. `.git` is never
 * shown. `play` reads a script through this mount, so the console and the
 * script screen name one path.
 *
 * @module
 */
import * as fs from 'fs';
import * as path from 'path';
import { Err, Ok, errorStack, vfs_fail, vfs_ok, wireName_place, type HostPlace, type Result, type VFSItem, type VFSProvider, type VfsOutcome } from '@fnndsc/fond';
import { MINE, type ScriptLibrary, type ScriptSource } from '../scripts/library.js';

/** The prefix the library is mounted at. */
export const SCRIPTS_PREFIX: string = '/scripts';

/** The item type a source shows as. */
export const SOURCE_TYPE: string = 'source';

/** The item type a `.mise` file shows as. */
export const SCRIPT_TYPE: string = 'script';

/** A path under the mount, placed on disk. */
interface Placed {
  /** The folder on disk the path's first segment names. */
  readonly base: string;
  /** The path on disk. */
  readonly disk: string;
  /** Whether it may be written. */
  readonly writable: boolean;
}

/** A path whose way on disk could not be looked at, with the words for why. */
interface Unseen {
  /** Why. */
  readonly unseen: string;
  /** The file system's code for it. */
  readonly code: string;
}

/**
 * The failure a path whose way could not be looked at answers with: the
 * file system's own kind, in words. Not being allowed in is permission
 * denied; a file standing where a folder was wanted is not a directory;
 * anything else is the host's failure.
 *
 * @param pathStr - The path asked for.
 * @param placed - Why its way could not be looked at.
 * @returns The failure.
 */
function unseen_fail(pathStr: string, placed: Unseen): VfsOutcome<never> {
  if (placed.code === 'EACCES' || placed.code === 'EPERM') return vfs_fail('EACCES', `${pathStr}: permission denied on the session's host`);
  if (placed.code === 'ENOTDIR') return vfs_fail('ENOTDIR', `${pathStr}: a part of the path is a file, not a folder`);
  return vfs_fail('EIO', `${pathStr}: could not be looked at on the session's host (${placed.code})`);
}

/** Whether a placing came back as a way that could not be looked at. */
function unseen_is(placed: Placed | null | 'unknown' | Unseen): placed is Unseen {
  return placed !== null && placed !== 'unknown' && 'unseen' in placed;
}

/** The library as a mount. */
export class ScriptsProvider implements VFSProvider {
  readonly prefix: string = SCRIPTS_PREFIX;
  private readonly library: ScriptLibrary;
  private readonly owner: () => string;

  constructor(library: ScriptLibrary, owner: () => string) {
    this.library = library;
    this.owner = owner;
  }

  private segments_split(pathStr: string): string[] {
    const absolute: string = pathStr.startsWith('/') ? pathStr : `/${pathStr}`;
    const clean: string = absolute.length > 1 && absolute.endsWith('/') ? absolute.slice(0, -1) : absolute;
    if (clean === this.prefix) return [];
    return clean.slice(this.prefix.length + 1).split('/');
  }

  /** Where a path below the mount is on disk, or null for the mount itself or an unknown source. */
  private place(segments: ReadonlyArray<string>): Placed | null | 'unknown' | Unseen {
    const [first, ...rest] = segments;
    if (first === undefined) return null;
    if (rest.some((segment: string): boolean => segment === '..' || segment === '.git')) return 'unknown';
    const source: ScriptSource | null = first === MINE ? null : this.library.source_read(first);
    if (first !== MINE && source === null) return 'unknown';
    // The folder itself is placed inside the library's root first: this host's own, or a source's clone and
    // the folder configured in it. One that leads out shows nothing; one that could not be looked at says so.
    const base: HostPlace = source === null ? this.library.mine_place() : this.library.shown_place(source);
    if (!base.ok) return base.unseen !== undefined ? { unseen: base.reason, code: base.unseen } : 'unknown';
    return this.within_place(base.place, rest, source === null);
  }

  /**
   * A path below a base folder of the library, held inside it: the words
   * of the path are a name in that folder (`wireName_place`), so one that
   * passes through a link leading out of the folder, a clone's own link to
   * somewhere on this host included, has no place and is unknown.
   */
  private within_place(base: string, rest: ReadonlyArray<string>, writable: boolean): Placed | 'unknown' | Unseen {
    if (rest.length === 0) return { base, disk: base, writable };
    const placed: HostPlace = wireName_place(base, rest.join('/'));
    if (placed.ok) return { base, disk: placed.place, writable };
    // A way that could not be looked at is a failure of this host, said as one: not a path that is not there.
    return placed.unseen !== undefined ? { unseen: placed.reason, code: placed.unseen } : 'unknown';
  }

  private item_make(name: string, disk: string, type: string): VFSItem {
    let size: number = 0;
    let date: string = new Date().toISOString();
    try {
      // The entry as itself: a link is not followed to wherever it points for its size or its date.
      const stat: fs.Stats = fs.lstatSync(disk);
      size = stat.isDirectory() ? fs.readdirSync(disk).filter((entry: string): boolean => entry !== '.git').length : stat.size;
      date = stat.mtime.toISOString();
    } catch {
      // A source not yet cloned lists as empty.
    }
    return { name, type, size, owner: this.owner(), date };
  }

  /** The folder a source's row is read from for its size and date: its shown folder, else the library's root, never a path outside it. */
  private shown_disk(source: ScriptSource): string {
    const shown: HostPlace = this.library.shown_place(source);
    return shown.ok ? shown.place : this.library.root;
  }

  private root_list(): VFSItem[] {
    const sources: VFSItem[] = this.library.sources_list().map((source: ScriptSource): VFSItem => ({
      ...this.item_make(source.name, this.shown_disk(source), SOURCE_TYPE),
      title: `${source.repo}${source.folder !== undefined && source.folder !== '' ? ` ${source.folder}` : ''}`,
      // Where the clone stands, read from git: its head's commit, date and subject, so a pull's receipt is the head moving.
      status: this.library.cloned(source.name) ? `cloned · at ${this.library.head_read(source.name)}` : 'not cloned',
    }));
    const mine: HostPlace = this.library.mine_place();
    return [...sources, { ...this.item_make(MINE, mine.ok ? mine.place : this.library.root, 'dir'), title: 'this host\'s own scripts' }];
  }

  private folder_list(disk: string): VFSItem[] {
    return fs.readdirSync(disk, { withFileTypes: true })
      .filter((entry: fs.Dirent): boolean => entry.name !== '.git')
      .sort((a: fs.Dirent, b: fs.Dirent): number => a.name.localeCompare(b.name))
      .map((entry: fs.Dirent): VFSItem => this.item_make(entry.name, path.join(disk, entry.name), entry.isDirectory() ? 'dir' : entry.name.endsWith('.mise') ? SCRIPT_TYPE : 'file'));
  }

  /**
   * Proves that a path under the library is not there: the file system
   * itself answered `ENOENT` for its place on disk. A place that cannot be
   * looked at (`EACCES`, or any other answer), the mount's own root, and a
   * source the library does not know prove nothing.
   *
   * @param pathStr - A path at or under `/scripts`.
   * @returns True only on that answer.
   */
  async absence_prove(pathStr: string): Promise<boolean> {
    const placed = this.place(this.segments_split(pathStr));
    if (placed === null || placed === 'unknown' || unseen_is(placed)) return false;
    try {
      fs.lstatSync(placed.disk);
      return false;
    } catch (error: unknown) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }

  async list(pathStr: string): Promise<Result<VFSItem[]>> {
    const placed = this.place(this.segments_split(pathStr));
    if (placed === null) return Ok(this.root_list());
    if (placed === 'unknown') {
      errorStack.stack_push('error', `Cannot list ${pathStr}: No such file or directory`);
      return Err();
    }
    if (unseen_is(placed)) {
      const failed: VfsOutcome<never> = unseen_fail(pathStr, placed);
      errorStack.stack_push('error', `Cannot list ${failed.ok ? pathStr : (failed.reason ?? pathStr)}`);
      return Err();
    }
    if (!fs.existsSync(placed.disk)) {
      errorStack.stack_push('error', `Cannot list ${pathStr}: ${placed.writable || this.library.cloned(this.segments_split(pathStr)[0] as string) ? 'No such file or directory' : 'the source is not cloned (scripts pull)'}`);
      return Err();
    }
    // A folder that may not be read is said so, in the mount's words, not thrown at whoever asked.
    try {
      if (!fs.statSync(placed.disk).isDirectory()) {
        errorStack.stack_push('error', `Cannot list ${pathStr}: Not a directory`);
        return Err();
      }
      return Ok(this.folder_list(placed.disk));
    } catch (error: unknown) {
      const code: string | undefined = (error as NodeJS.ErrnoException).code;
      errorStack.stack_push('error', `Cannot list ${pathStr}: ${code === 'EACCES' || code === 'EPERM' ? "permission denied on the session's host" : (error instanceof Error ? error.message : String(error))}`);
      return Err();
    }
  }

  async read(pathStr: string): Promise<VfsOutcome<string>> {
    const bytes: VfsOutcome<Buffer> = await this.readBinary(pathStr);
    return bytes.ok ? vfs_ok(bytes.value.toString('utf-8')) : bytes;
  }

  async readBinary(pathStr: string): Promise<VfsOutcome<Buffer>> {
    const placed = this.place(this.segments_split(pathStr));
    if (placed === null) return vfs_fail('EISDIR');
    if (placed === 'unknown') return vfs_fail('ENOENT');
    if (unseen_is(placed)) return unseen_fail(pathStr, placed);
    // The file system's own answer is kept: a script that may not be read is not a script that is not there.
    try {
      if (fs.statSync(placed.disk).isDirectory()) return vfs_fail('EISDIR');
      return vfs_ok(fs.readFileSync(placed.disk));
    } catch (error: unknown) {
      const code: string | undefined = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return vfs_fail('ENOENT');
      if (code === 'EACCES' || code === 'EPERM') return vfs_fail('EACCES', `${pathStr}: permission denied on the session's host`);
      return vfs_fail('EIO', `${pathStr}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async write(pathStr: string, content: string | Buffer): Promise<VfsOutcome> {
    const segments: string[] = this.segments_split(pathStr);
    const placed = this.place(segments);
    if (placed === null || placed === 'unknown') return vfs_fail('ENOENT');
    if (unseen_is(placed)) return unseen_fail(pathStr, placed);
    if (!placed.writable) return vfs_fail('EROFS', `${segments[0]} is a source's clone: the way back into it is git; write under /scripts/${MINE}/`);
    if (segments.length < 2) return vfs_fail('EISDIR');
    fs.mkdirSync(path.dirname(placed.disk), { recursive: true, mode: 0o700 });
    fs.writeFileSync(placed.disk, content, { mode: 0o600 });
    return vfs_ok(true);
  }

  async cp(src: string, dest: string): Promise<VfsOutcome> {
    const from: VfsOutcome<Buffer> = await this.readBinary(src);
    if (!from.ok) return from;
    return this.write(dest, from.value);
  }
}
