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
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  if (!PRIVATE_NAME.test(name)) throw new Error(`a private temporary file's name is a plain name: ${JSON.stringify(name)}`);
  if (typeof data !== 'string' && !(data instanceof Uint8Array)) throw new Error('a private temporary file holds text or bytes');
  if (!PRIVATE_PREFIX.test(prefix)) throw new Error(`a private temporary folder's prefix is a plain name: ${JSON.stringify(prefix)}`);
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

