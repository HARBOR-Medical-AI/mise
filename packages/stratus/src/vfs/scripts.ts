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
import { Err, Ok, errorStack, vfs_fail, vfs_ok, type Result, type VFSItem, type VFSProvider, type VfsOutcome } from '@fnndsc/fond';
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
  private place(segments: ReadonlyArray<string>): Placed | null | 'unknown' {
    const [first, ...rest] = segments;
    if (first === undefined) return null;
    if (rest.some((segment: string): boolean => segment === '..' || segment === '.git')) return 'unknown';
    if (first === MINE) {
      const base: string = this.library.mine_derive();
      return { base, disk: path.join(base, ...rest), writable: true };
    }
    const source: ScriptSource | null = this.library.source_read(first);
    if (source === null) return 'unknown';
    const base: string = this.library.shown_derive(source);
    return { base, disk: path.join(base, ...rest), writable: false };
  }

  private item_make(name: string, disk: string, type: string): VFSItem {
    let size: number = 0;
    let date: string = new Date().toISOString();
    try {
      const stat: fs.Stats = fs.statSync(disk);
      size = stat.isDirectory() ? fs.readdirSync(disk).filter((entry: string): boolean => entry !== '.git').length : stat.size;
      date = stat.mtime.toISOString();
    } catch {
      // A source not yet cloned lists as empty.
    }
    return { name, type, size, owner: this.owner(), date };
  }

  private root_list(): VFSItem[] {
    const sources: VFSItem[] = this.library.sources_list().map((source: ScriptSource): VFSItem => ({
      ...this.item_make(source.name, this.library.shown_derive(source), SOURCE_TYPE),
      title: `${source.repo}${source.folder !== undefined && source.folder !== '' ? ` ${source.folder}` : ''}`,
      status: this.library.cloned(source.name) ? 'cloned' : 'not cloned',
    }));
    return [...sources, { ...this.item_make(MINE, this.library.mine_derive(), 'dir'), title: 'this host\'s own scripts' }];
  }

  private folder_list(disk: string): VFSItem[] {
    return fs.readdirSync(disk, { withFileTypes: true })
      .filter((entry: fs.Dirent): boolean => entry.name !== '.git')
      .sort((a: fs.Dirent, b: fs.Dirent): number => a.name.localeCompare(b.name))
      .map((entry: fs.Dirent): VFSItem => this.item_make(entry.name, path.join(disk, entry.name), entry.isDirectory() ? 'dir' : entry.name.endsWith('.mise') ? SCRIPT_TYPE : 'file'));
  }

  async list(pathStr: string): Promise<Result<VFSItem[]>> {
    const placed = this.place(this.segments_split(pathStr));
    if (placed === null) return Ok(this.root_list());
    if (placed === 'unknown') {
      errorStack.stack_push('error', `Cannot list ${pathStr}: No such file or directory`);
      return Err();
    }
    if (!fs.existsSync(placed.disk)) {
      errorStack.stack_push('error', `Cannot list ${pathStr}: ${placed.writable || this.library.cloned(this.segments_split(pathStr)[0] as string) ? 'No such file or directory' : 'the source is not cloned (scripts pull)'}`);
      return Err();
    }
    if (!fs.statSync(placed.disk).isDirectory()) {
      errorStack.stack_push('error', `Cannot list ${pathStr}: Not a directory`);
      return Err();
    }
    return Ok(this.folder_list(placed.disk));
  }

  async read(pathStr: string): Promise<VfsOutcome<string>> {
    const bytes: VfsOutcome<Buffer> = await this.readBinary(pathStr);
    return bytes.ok ? vfs_ok(bytes.value.toString('utf-8')) : bytes;
  }

  async readBinary(pathStr: string): Promise<VfsOutcome<Buffer>> {
    const placed = this.place(this.segments_split(pathStr));
    if (placed === null) return vfs_fail('EISDIR');
    if (placed === 'unknown' || !fs.existsSync(placed.disk)) return vfs_fail('ENOENT');
    if (fs.statSync(placed.disk).isDirectory()) return vfs_fail('EISDIR');
    return vfs_ok(fs.readFileSync(placed.disk));
  }

  async write(pathStr: string, content: string | Buffer): Promise<VfsOutcome> {
    const segments: string[] = this.segments_split(pathStr);
    const placed = this.place(segments);
    if (placed === null || placed === 'unknown') return vfs_fail('ENOENT');
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
