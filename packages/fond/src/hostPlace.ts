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
import { lstatSync, realpathSync } from 'node:fs';
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
