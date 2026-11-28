/**
 * @file Placing a name that came from elsewhere inside a folder on this host.
 *
 * A file name that arrives over a wire, or out of a listing another system
 * made, is a claim about where to write. Joined to a folder as it comes, a
 * name of `../../x`, an absolute one, or one that passes through a link
 * already on this disk writes wherever it says. `wireName_place` gives back
 * the place inside the folder, or the reason there is none.
 *
 * The check is made before the write and the disk can change between the
 * two; it closes what a name can ask for, not a race with a second program
 * on the same host.
 *
 * @module
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/** Where a name belongs under a folder, or why it has no place there. */
export type HostPlace =
  | { readonly ok: true; readonly place: string }
  /**
   * `unseen` is set when the name was not refused for what it says but because a part of its way could not be
   * looked at: a failure of this host, not of the name. It is the file system's own code for why (`EACCES`
   * for a folder that may not be entered, `ENOTDIR` for a file standing where a folder was wanted).
   */
  | { readonly ok: false; readonly reason: string; readonly unseen?: string };

/** A path that could not be looked at: neither there nor proved missing. */
class Uninspectable extends Error {
  /** The file system's code for why. */
  constructor(public readonly code: string) {
    super(code);
  }
}

/**
 * Whether a path exists, as itself: a link counts, wherever it leads.
 *
 * Only the file system saying `ENOENT` means it is not there. Any other
 * answer (no permission to look, a part that is not a folder, an I/O
 * error) is not knowing, and not knowing is not absence.
 *
 * @param target - The path.
 * @returns True when something is there, false when the file system says nothing is.
 * @throws {Uninspectable} When it could not be looked at.
 */
function path_stands(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch (error: unknown) {
    const code: string | undefined = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw new Uninspectable(code ?? 'unknown');
  }
}

/**
 * The real path of the deepest part of a path that exists, with the rest
 * appended as written.
 *
 * @param target - An absolute path.
 * @returns The path with every link in its existing part followed; `dangling` when a link in it leads nowhere; `uninspectable` when a part of it could not be looked at.
 */
function existingPart_resolve(target: string): string | { readonly failed: 'dangling' | 'uninspectable'; readonly code?: string } {
  let existing: string = target;
  const rest: string[] = [];
  try {
    while (!path_stands(existing)) {
      const parent: string = path.dirname(existing);
      if (parent === existing) break;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  } catch (error: unknown) {
    return { failed: 'uninspectable', code: error instanceof Uninspectable ? error.code : 'EIO' };
  }
  try {
    return path.join(realpathSync(existing), ...rest);
  } catch (error: unknown) {
    const code: string = (error as NodeJS.ErrnoException).code ?? 'EIO';
    return code === 'ENOENT' ? { failed: 'dangling' } : { failed: 'uninspectable', code };
  }
}

/**
 * Whether one path is another or lies under it.
 *
 * @param inner - The path asked about.
 * @param outer - The folder.
 * @returns True when `inner` is `outer` or inside it.
 */
function path_within(inner: string, outer: string): boolean {
  const relative: string = path.relative(outer, inner);
  if (relative === '') return true;
  // A name may itself begin with two dots (`..cache`); only the part `..` leaves.
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Places a name from another system inside a folder on this host.
 *
 * The name may have folders of its own (`anat/t1.nii`), under either
 * separator. It is refused when it is empty, holds a NUL, is absolute by
 * either system's rules, has an empty, `.` or `..` part, or when the place
 * it comes to, with every link already on this disk followed, is not
 * inside the folder, or when a part of it could not be looked at.
 *
 * @param folder - The folder the name belongs in.
 * @param name - The name as it arrived.
 * @returns The absolute place inside the folder, or the reason it has none.
 *
 * @example
 * ```ts
 * wireName_place('/data/in', 'anat/t1.nii'); // { ok: true, place: '/data/in/anat/t1.nii' }
 * wireName_place('/data/in', '../x');        // { ok: false, reason: "'../x' has a '..' part" }
 * ```
 */
export function wireName_place(folder: string, name: string): HostPlace {
  const shown: string = JSON.stringify(name);
  if (name.length === 0) return { ok: false, reason: 'an empty name' };
  if (name.includes('\0')) return { ok: false, reason: `${shown} holds a NUL` };
  if (path.posix.isAbsolute(name) || path.win32.isAbsolute(name) || /^[A-Za-z]:/.test(name)) {
    return { ok: false, reason: `${shown} is an absolute path, not a name` };
  }
  const parts: string[] = name.split(/[\\/]/);
  for (const part of parts) {
    if (part === '') return { ok: false, reason: `${shown} has an empty part` };
    if (part === '.' || part === '..') return { ok: false, reason: `${shown} has a '${part}' part` };
  }
  const root: string = path.resolve(folder);
  const place: string = path.join(root, ...parts);
  if (!path_within(place, root) || place === root) return { ok: false, reason: `${shown} does not stay inside ${root}` };
  const realRoot = existingPart_resolve(root);
  const realPlace = existingPart_resolve(place);
  for (const resolved of [realRoot, realPlace]) {
    if (typeof resolved === 'string') continue;
    if (resolved.failed === 'dangling') return { ok: false, reason: `${shown} passes through a link that leads nowhere` };
    return { ok: false, reason: `${shown} passes through a place that could not be looked at (${resolved.code ?? 'EIO'})`, unseen: resolved.code ?? 'EIO' };
  }
  if (typeof realRoot !== 'string' || typeof realPlace !== 'string') return { ok: false, reason: `${shown} could not be placed` };
  if (!path_within(realPlace, realRoot) || realPlace === realRoot) {
    return { ok: false, reason: `${shown} passes through a link that leads outside ${root}` };
  }
  return { ok: true, place };
}

/** A name a private temporary file may take: a plain name, never a path, `..` or NUL. */
const PRIVATE_NAME: RegExp = /^(?!\.\.?$)[A-Za-z0-9._+-]{1,64}$/;

/** A folder prefix: a plain name, under the temporary folder. */
const PRIVATE_PREFIX: RegExp = /^[A-Za-z0-9_+-][A-Za-z0-9._+-]{0,31}$/;

/** A file suffix a caller may ask for (`.mise`, `.json`): a dot and a few plain characters. */
export const SAFE_SUFFIX: RegExp = /^\.[A-Za-z0-9_+-]{1,16}$/;

/**
 * A temporary file only this account can open: in a fresh folder of its own (`mkdtemp`, 0700), created anew
 * (`wx`, so nothing standing at the name is followed or reused), 0600.
 *
 * @example
 * ```ts
 * const temp: PrivateTemp = privateTemp_write('chell-edit-', 'edit.txt', 'text');
 * try { use(temp.path); } finally { temp.folder_remove(); }
 * ```
 */
export interface PrivateTemp {
  /** The private folder. */
  folder: string;
  /** The file in it. */
  path: string;
  /** Removes the folder and the file. */
  folder_remove: () => void;
}

/**
 * Writes a private temporary file.
 *
 * @param prefix - The folder's prefix under the system's temporary folder (`chell-edit-`).
 * @param name - The file's name inside it: a plain name (no separator, `..` or NUL), else refused.
 * @param data - What it holds: text or bytes.
 * @returns The file, its folder, and how to remove them.
 * @throws {Error} When the name or the prefix is not a plain name, the data neither text nor bytes, or the file cannot be written (the folder is then removed).
 *
 * @example
 * ```ts
 * const temp: PrivateTemp = privateTemp_write('chell-config-', 'config.tmp', bytes);
 * ```
 */
export function privateTemp_write(prefix: string, name: string, data: unknown): PrivateTemp {
  // Each checked as the string it must be before anything is made: a test coerces, a name that is not a string is not one.
  if (typeof name !== 'string' || !PRIVATE_NAME.test(name)) throw new Error(`a private temporary file's name is a plain name: ${JSON.stringify(name)}`);
  if (typeof data !== 'string' && !(data instanceof Uint8Array)) throw new Error('a private temporary file holds text or bytes');
  if (typeof prefix !== 'string' || !PRIVATE_PREFIX.test(prefix)) throw new Error(`a private temporary folder's prefix is a plain name: ${JSON.stringify(prefix)}`);
  const folder: string = mkdtempSync(path.join(tmpdir(), prefix));
  const file: string = path.join(folder, name);
  try {
    chmodSync(folder, 0o700);
    writeFileSync(file, data, { flag: 'wx', mode: 0o600 });
  } catch (error: unknown) {
    // A folder half made (a full disk mid-write, say) is not left behind.
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
  return { folder, path: file, folder_remove: (): void => { rmSync(folder, { recursive: true, force: true }); } };
}

/**
 * A suffix as asked, when it is a safe one; else the default.
 *
 * @param asked - The suffix asked for (a remote surface's, an operand's).
 * @param fallback - What is used otherwise.
 * @returns The suffix.
 *
 * @example
 * ```ts
 * suffix_safe('../x', '.txt'); // '.txt'
 * ```
 */
export function suffix_safe(asked: string | undefined, fallback: string): string {
  return asked !== undefined && SAFE_SUFFIX.test(asked) ? asked : fallback;
}

/**
 * Why an owner-only place was not taken: its path and what was wrong with it, never what it holds.
 *
 * @example
 * ```ts
 * const refused: OwnRefusal = { ok: false, reason: '/tmp/calypso-1000: another account\'s' };
 * ```
 */
export interface OwnRefusal {
  /** Refused. */
  ok: false;
  /** The path and why. */
  reason: string;
  /** Set when the place is simply not there (ENOENT): absence, not a fault. */
  missing?: true;
  /** For a trusted walk that met a missing name: the trusted folder it stood in, links before it resolved. */
  stoppedAt?: string;
  /** For a trusted walk that met a missing name: that name and the ones after it, as the walk would have taken them. */
  stillToGo?: string[];
}

/**
 * An owner-only place taken.
 *
 * @example
 * ```ts
 * const held: OwnHeld = { ok: true };
 * ```
 */
export interface OwnHeld {
  /** Taken. */
  ok: true;
}

/**
 * An owner-only folder held: its path as resolved through the trusted walk, the one every later use names.
 *
 * @example
 * ```ts
 * const held: OwnFolder = { ok: true, path: '/run/user/1000/calypso' };
 * ```
 */
export interface OwnFolder {
  /** Held. */
  ok: true;
  /** The folder, every link on the way resolved. */
  path: string;
}

/**
 * This account's uid.
 *
 * @returns The uid, or null where the platform has none (then no ownership is asked).
 */
function uid_get(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/**
 * An error's code, read off the object (an error made in another realm is no `instanceof Error` here).
 *
 * @param error - What was thrown.
 * @returns Its code, or 'unknown'.
 */
function errorCode_read(error: unknown): string {
  const code: unknown = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' ? code : 'unknown';
}

/**
 * A refusal for a failed filesystem call: absence when the error is ENOENT, else the code.
 *
 * @param place - The path.
 * @param error - What was thrown.
 * @param doing - What failed, for the words.
 * @returns The refusal.
 */
function fsRefusal_make(place: string, error: unknown, doing: string): OwnRefusal {
  const code: string = errorCode_read(error);
  if (code === 'ENOENT') return { ok: false, reason: `${place}: not there`, missing: true };
  if (code === 'ELOOP') return { ok: false, reason: `${place}: a link` };
  return { ok: false, reason: `${place}: ${doing} failed (${code})` };
}

/**
 * Whether a folder on the way to an owner-only place is one no other account can replace what is under it in:
 * root's or this account's, and writable by group or others only when it is root's and sticky (`/tmp`).
 *
 * @param stats - The folder's lstat.
 * @param uid - This account's uid.
 * @returns True when it is trusted.
 */
function ancestor_isTrusted(stats: Stats, uid: number): boolean {
  if (!stats.isDirectory()) return false;
  if (stats.uid !== 0 && stats.uid !== uid) return false;
  const opened: boolean = (stats.mode & 0o022) !== 0;
  return !opened || (stats.uid === 0 && (stats.mode & 0o1000) !== 0);
}

/** The most links a trusted walk follows. */
const LINK_HOPS_MAX: number = 40;

/** Where a trusted walk is: the folder reached, and the names still to go. */
interface WalkPlace {
  /** The folder reached, trusted. */
  at: string;
  /** The names still to go. */
  rest: string[];
  /** Links followed so far. */
  hops: number;
}

/**
 * Takes one name of a trusted walk: a trusted folder is entered; a link is followed (its folder is trusted, so no
 * other account can change it), its target's names put first; anything else ends the walk.
 *
 * @param place - Where the walk is.
 * @param name - The next name.
 * @param uid - This account's uid.
 * @returns Where the walk goes on from, or why it stops.
 */
function walkStep_take(place: WalkPlace, name: string, uid: number): WalkPlace | OwnRefusal {
  if (name === '.' || name.length === 0) return place;
  if (name === '..') return { ...place, at: path.dirname(place.at) };
  const next: string = path.join(place.at, name);
  let stats: Stats;
  try {
    stats = lstatSync(next);
  } catch (error: unknown) {
    const refused: OwnRefusal = fsRefusal_make(next, error, 'lstat');
    // Not there: where the walk stood (a trusted folder, every link before resolved) and the names still to go.
    return refused.missing === true ? { ...refused, stoppedAt: place.at, stillToGo: [name, ...place.rest] } : refused;
  }
  if (stats.isSymbolicLink()) {
    if (place.hops >= LINK_HOPS_MAX) return { ok: false, reason: `${next}: too many links` };
    // In a shared sticky folder (`/tmp`) an entry is its owner's to replace: a link is followed only when it is
    // root's or this account's.
    if (stats.uid !== 0 && stats.uid !== uid) return { ok: false, reason: `${next}: a link of another account's` };
    let link: string;
    try {
      link = readlinkSync(next);
    } catch (error: unknown) {
      return fsRefusal_make(next, error, 'readlink');
    }
    const at: string = path.isAbsolute(link) ? path.parse(link).root : place.at;
    return { at, rest: [...link.split(path.sep), ...place.rest], hops: place.hops + 1 };
  }
  if (!ancestor_isTrusted(stats, uid)) return { ok: false, reason: `${next}: ${stats.isDirectory() ? 'open to other accounts' : 'not a folder'}` };
  return { ...place, at: next };
}

/**
 * Whether a path as spelled names `..`.
 *
 * @param spelled - The path.
 * @returns True when it does.
 */
function spelling_climbs(spelled: string): boolean {
  return spelled.split(/[\\/]/).includes('..');
}

/**
 * Resolves a folder's path through trusted folders only: from `/` (itself trusted), each name as spelled, every
 * folder root's or this account's and not open to others (unless root's and sticky), every link found in such a
 * folder followed the same way. No folder another account could change is passed through, by any spelling.
 *
 * @param folder - The folder.
 * @param uid - This account's uid.
 * @returns The resolved path, or why not (`missing` when a name on the way is not there).
 *
 * @example
 * ```ts
 * const walked: OwnFolder | OwnRefusal = trustedPath_resolve('/home/me/.local/state/porter', uid);
 * ```
 */
export function trustedPath_resolve(folder: string, uid: number | null = uid_get()): OwnFolder | OwnRefusal {
  // `..` as spelled would be folded away before any link on the way is walked: refused, not guessed at.
  if (spelling_climbs(folder)) return { ok: false, reason: `${folder}: names '..'` };
  const absolute: string = path.resolve(folder);
  if (uid === null) {
    try {
      return { ok: true, path: realpathSync(absolute) };
    } catch (error: unknown) {
      return fsRefusal_make(absolute, error, 'realpath');
    }
  }
  const root: string = path.parse(absolute).root;
  let rootStats: Stats;
  try {
    rootStats = lstatSync(root);
  } catch (error: unknown) {
    return fsRefusal_make(root, error, 'lstat');
  }
  if (!ancestor_isTrusted(rootStats, uid)) return { ok: false, reason: `${root}: open to other accounts` };
  let place: WalkPlace = { at: root, rest: absolute.slice(root.length).split(path.sep), hops: 0 };
  while (place.rest.length > 0) {
    const [name, ...rest]: string[] = place.rest;
    const stepped: WalkPlace | OwnRefusal = walkStep_take({ ...place, rest }, name, uid);
    if ('ok' in stepped) return stepped;
    place = stepped;
  }
  return { ok: true, path: place.at };
}

/**
 * Holds a host's state root: its path resolved through trusted folders only, and the root itself, when it is there,
 * root's or this account's and not writable by group or others, sticky or not (a shared `/tmp` is a fine place to
 * pass through and no place to keep state in). A root not made yet, below trusted folders, is a first start: its
 * path is the resolved folder that is there joined with the names still to make.
 *
 * @param folder - The state root.
 * @param uid - This account's uid (a test's seam).
 * @returns The root's resolved path, or the first thing on the way another account could change.
 *
 * @example
 * ```ts
 * const root: OwnFolder | OwnRefusal = trustedRoot_settle(stateDir);
 * if (root.ok) host_start(root.path);
 * ```
 */
export function trustedRoot_settle(folder: string, uid: number | null = uid_get()): OwnFolder | OwnRefusal {
  const walked: OwnFolder | OwnRefusal = trustedPath_resolve(folder, uid);
  if (walked.ok) {
    let stats: Stats;
    try {
      stats = lstatSync(walked.path);
    } catch (error: unknown) {
      return fsRefusal_make(walked.path, error, 'lstat');
    }
    if (uid !== null && stats.uid !== 0 && stats.uid !== uid) return { ok: false, reason: `${walked.path}: another account's` };
    if ((stats.mode & 0o022) !== 0) return { ok: false, reason: `${walked.path}: open to other accounts` };
    return walked;
  }
  if (walked.missing !== true || walked.stoppedAt === undefined || walked.stillToGo === undefined) return walked;
  // Not there yet: the folder the walk stood in (every link before it resolved, so a link to nothing is never taken
  // for the place it names), held as a root is, and the names still to make. Those are plain names, made below it.
  const toMake: string[] = walked.stillToGo.filter((name: string): boolean => name.length > 0 && name !== '.');
  if (toMake.includes('..')) return { ok: false, reason: `${folder}: names '..' past ${walked.stoppedAt}` };
  const stood: OwnFolder | OwnRefusal = trustedRoot_settle(walked.stoppedAt, uid);
  return stood.ok ? { ok: true, path: path.join(stood.path, ...toMake) } : stood;
}

/**
 * Holds a folder only this account can use: its parent resolved through trusted folders only
 * (`trustedPath_resolve`); the folder itself a real directory, not a link, this account's, with no group or other
 * bits. Once that holds, no other account can swap the folder or write in it, so its resolved path is as good as a
 * handle: every later use names `path`, never the spelling it was asked by.
 *
 * @param folder - The folder.
 * @param create - Make it (0700) when it is missing; a reader passes false and a missing folder is refused.
 * @param uid - This account's uid (a test's seam).
 * @returns Held with its path, or why not (`missing` when it, or its parent, is simply not there).
 *
 * @example
 * ```ts
 * const held: OwnFolder | OwnRefusal = ownFolder_settle(berthDir, true);
 * ```
 */
export function ownFolder_settle(folder: string, create: boolean, uid: number | null = uid_get()): OwnFolder | OwnRefusal {
  if (spelling_climbs(folder)) return { ok: false, reason: `${folder}: names '..'` };
  const absolute: string = path.resolve(folder);
  const parent: OwnFolder | OwnRefusal = trustedPath_resolve(path.dirname(absolute), uid);
  if (!parent.ok) return { ...parent, reason: `${absolute}: ${parent.reason}` };
  const target: string = path.join(parent.path, path.basename(absolute));
  let stats: Stats;
  try {
    stats = lstatSync(target);
  } catch (error: unknown) {
    if (!create || errorCode_read(error) !== 'ENOENT') return fsRefusal_make(target, error, 'lstat');
    try {
      mkdirSync(target, { mode: 0o700 });
      stats = lstatSync(target);
    } catch (made: unknown) {
      return { ok: false, reason: `${target}: could not be made (${errorCode_read(made)})` };
    }
  }
  return ownFolder_judge(target, stats, uid);
}

/**
 * Whether a folder's lstat is one only this account can use.
 *
 * @param target - The folder.
 * @param stats - Its lstat.
 * @param uid - This account's uid.
 * @returns Held with its path, or why not.
 */
function ownFolder_judge(target: string, stats: Stats, uid: number | null): OwnFolder | OwnRefusal {
  if (stats.isSymbolicLink()) return { ok: false, reason: `${target}: a link` };
  if (!stats.isDirectory()) return { ok: false, reason: `${target}: not a folder` };
  if (uid !== null && stats.uid !== uid) return { ok: false, reason: `${target}: another account's` };
  if ((stats.mode & 0o077) !== 0) return { ok: false, reason: `${target}: wider than 0700` };
  return { ok: true, path: target };
}

/**
 * An owner-only file read whole.
 *
 * @example
 * ```ts
 * const read: OwnText = { ok: true, text: '{}' };
 * ```
 */
export interface OwnText {
  /** Read. */
  ok: true;
  /** What it holds. */
  text: string;
}

/** What an owner-only read gave: the text, or why it was refused. */
export type OwnRead = OwnText | OwnRefusal;

/**
 * Whether a file's stat is one of this account's own: a regular file of this uid with no group or other bits.
 *
 * @param file - The file.
 * @param stats - Its stat or lstat.
 * @param uid - This account's uid.
 * @returns Null when it is, else why not.
 */
function ownFile_judge(file: string, stats: Stats, uid: number | null): OwnRefusal | null {
  if (stats.isSymbolicLink()) return { ok: false, reason: `${file}: a link, left as it is` };
  if (!stats.isFile()) return { ok: false, reason: `${file}: not a regular file, left as it is` };
  if (uid !== null && stats.uid !== uid) return { ok: false, reason: `${file}: another account's, left as it is` };
  if ((stats.mode & 0o077) !== 0) return { ok: false, reason: `${file}: wider than 0600, left as it is` };
  return null;
}

/**
 * Reads an owner-only file in a held folder: opened without following a link, a regular file of this account's
 * with no group or other bits, at most `maxBytes` (more is refused).
 *
 * @param file - The file, named under a held folder's `path`.
 * @param maxBytes - The most it may hold.
 * @param uid - This account's uid (a test's seam).
 * @returns Its text, or why not (`missing` when it is not there).
 *
 * @example
 * ```ts
 * const read: OwnRead = ownFile_read(join(held.path, 'berth-0123.json'), 64 * 1024);
 * ```
 */
export function ownFile_read(file: string, maxBytes: number, uid: number | null = uid_get()): OwnRead {
  let handle: number;
  try {
    handle = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error: unknown) {
    return fsRefusal_make(file, error, 'open');
  }
  try {
    const refused: OwnRefusal | null = ownFile_judge(file, fstatSync(handle), uid);
    if (refused !== null) return refused;
    const buffer: Buffer = Buffer.alloc(maxBytes + 1);
    let filled: number = 0;
    for (;;) {
      const got: number = readSync(handle, buffer, filled, buffer.length - filled, null);
      if (got === 0) break;
      filled += got;
      if (filled > maxBytes) return { ok: false, reason: `${file}: larger than ${String(maxBytes)} bytes` };
    }
    return { ok: true, text: buffer.subarray(0, filled).toString('utf8') };
  } catch (error: unknown) {
    return fsRefusal_make(file, error, 'read');
  } finally {
    closeSync(handle);
  }
}

/**
 * Writes every byte of a buffer on an open descriptor, however many calls it takes.
 *
 * @param handle - The descriptor.
 * @param bytes - What to write.
 * @param write - The write call (a test's seam).
 * @throws {Error} When a write makes no progress.
 *
 * @example
 * ```ts
 * bytes_writeAll(handle, Buffer.from(text, 'utf8'));
 * ```
 */
export function bytes_writeAll(handle: number, bytes: Uint8Array, write: (handle: number, bytes: Uint8Array, offset: number, length: number) => number = writeSync): void {
  let done: number = 0;
  while (done < bytes.length) {
    const wrote: number = write(handle, bytes, done, bytes.length - done);
    if (wrote <= 0) throw new Error(`a write made no progress at byte ${String(done)} of ${String(bytes.length)}`);
    done += wrote;
  }
}

/**
 * Writes an owner-only file in a held folder, atomically: a fresh temporary file (`O_EXCL|O_NOFOLLOW`, 0600), every
 * byte written, synced, renamed over the name. A standing entry that is not this account's regular 0600 file (a
 * link, another account's, wider) is refused and left as it is, its target untouched; a failed write leaves the
 * standing record as it was.
 *
 * @param folder - The held folder's `path`.
 * @param name - The file's name in it (a plain name).
 * @param text - What it holds.
 * @param uid - This account's uid (a test's seam).
 * @param write - The write call (a test's seam).
 * @returns Held, or why not.
 *
 * @example
 * ```ts
 * ownFile_write(held.path, 'berth-0123456789abcdef.json', JSON.stringify(record));
 * ```
 */
export function ownFile_write(folder: string, name: string, text: string, uid: number | null = uid_get(), write?: (handle: number, bytes: Uint8Array, offset: number, length: number) => number): OwnHeld | OwnRefusal {
  if (!PRIVATE_NAME.test(name)) return { ok: false, reason: `${JSON.stringify(name)}: not a plain name` };
  const target: string = path.join(folder, name);
  const standing: OwnRefusal | null = standing_judge(target, uid);
  if (standing !== null) return standing;
  const temporary: string = path.join(folder, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  let handle: number;
  try {
    handle = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  } catch (error: unknown) {
    return { ok: false, reason: `${target}: could not be written (${errorCode_read(error)})` };
  }
  try {
    try {
      bytes_writeAll(handle, Buffer.from(text, 'utf8'), write);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
    return { ok: true };
  } catch (error: unknown) {
    rmSync(temporary, { force: true });
    return { ok: false, reason: `${target}: could not be written (${error instanceof Error ? error.message : errorCode_read(error)})` };
  }
}

/**
 * Whether what stands at a name may be replaced or taken: nothing, or this account's regular 0600 file.
 *
 * @param target - The name's path.
 * @param uid - This account's uid.
 * @returns Null when it may, else why not (`missing` is not returned: absence is fine).
 */
function standing_judge(target: string, uid: number | null): OwnRefusal | null {
  try {
    return ownFile_judge(target, lstatSync(target), uid);
  } catch (error: unknown) {
    return errorCode_read(error) === 'ENOENT' ? null : fsRefusal_make(target, error, 'lstat');
  }
}

/**
 * Takes an owner-only file: judged where it stands (a link, another account's or a wider file is refused and left
 * as it is), then renamed aside (atomic), read and the aside name removed. What is taken is never put back; a note
 * taken by two readers is had by one.
 *
 * @param folder - The held folder's `path`.
 * @param name - The file's name.
 * @param maxBytes - The most it may hold.
 * @param uid - This account's uid (a test's seam).
 * @returns Its text, or why not.
 *
 * @example
 * ```ts
 * const note: OwnRead = ownFile_take(held.path, 'closing-0123.json', 4096);
 * ```
 */
export function ownFile_take(folder: string, name: string, maxBytes: number, uid: number | null = uid_get()): OwnRead {
  if (!PRIVATE_NAME.test(name)) return { ok: false, reason: `${JSON.stringify(name)}: not a plain name` };
  const file: string = path.join(folder, name);
  let standing: Stats;
  try {
    standing = lstatSync(file);
  } catch (error: unknown) {
    return fsRefusal_make(file, error, 'lstat');
  }
  const refused: OwnRefusal | null = ownFile_judge(file, standing, uid);
  if (refused !== null) return refused;
  const aside: string = path.join(folder, `.${name}.${randomBytes(6).toString('hex')}.taken`);
  try {
    renameSync(file, aside);
  } catch (error: unknown) {
    return fsRefusal_make(file, error, 'rename');
  }
  try {
    return ownFile_read(aside, maxBytes, uid);
  } finally {
    rmSync(aside, { force: true });
  }
}
