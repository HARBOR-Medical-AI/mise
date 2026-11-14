/**
 * @file A path as the session means it: `~` is the session's home, a
 * relative path stands under the working directory, and where the store
 * keeps it (`storePath_resolve`), which every reader and lister asks.
 *
 * @module
 */
import * as path from 'path';
import { errorStack, type Result, type VFSDispatcher, type VFSProvider } from '@fnndsc/fond';
import { session } from '../session/index.js';
import { backendInstalled_get } from './backend.js';
import { vfsDispatcher_get } from './filesystem.js';

/**
 * Resolves a path against a home and a working directory, without asking
 * anything: `~` and `~/x` under the home, a relative path under the working
 * directory, and no trailing slash.
 *
 * @param inputPath - The path as typed.
 * @param home - The session's home.
 * @param cwd - The working directory.
 * @returns The absolute path.
 */
export function path_resolveFrom(inputPath: string, home: string, cwd: string): string {
  let resolved: string = inputPath;

  if (inputPath.startsWith('~')) {
    if (inputPath === '~' || inputPath === '~/') {
      resolved = home;
    } else if (inputPath.startsWith('~/')) {
      resolved = path.posix.join(home, inputPath.substring(2));
    }
  }

  if (!resolved.startsWith('/')) {
    resolved = path.posix.resolve(cwd, resolved);
  }

  if (resolved.length > 1 && resolved.endsWith('/')) {
    resolved = resolved.slice(0, -1);
  }

  return resolved;
}

/**
 * Resolves a path argument as the session means it.
 *
 * @param inputPath - The path as typed.
 * @returns The absolute path.
 */
export async function path_resolve(inputPath: string): Promise<string> {
  const home: string = (await backendInstalled_get()?.session.home_get()) ?? '/';
  const cwd: string = await session.getCWD();
  return path_resolveFrom(inputPath, home, cwd);
}

/** How many mount-and-link hops a path may take before it is read where it stands. */
const STORE_HOPS_MAX: number = 8;

/**
 * Where a path lives in the backend's store: the one answer every reader
 * and lister asks before it goes to the dispatcher.
 *
 * The session's namespace first (`~`, a relative path), then, hop by hop,
 * whatever stands in the way: a mount that stands for a store folder hands
 * back the store path (`/proc/jobs/…/data/…` is the job's output folder and
 * the rest of the path in it), and the backend follows the store's own links
 * on a store path (ChRIS: `.chrislink`s at any depth). A link may land
 * under another mount, and a mount's answer may pass through links, so the
 * two are asked in turn until neither moves the path.
 *
 * Best effort by design: a path that resolves no further stands as it is,
 * and the read that follows refuses it by its own name.
 *
 * @param inputPath - The path as typed or as a surface gave it.
 * @returns The store path; a path a mount holds itself (a file it makes),
 *   as resolved in the namespace.
 * @example
 * await storePath_resolve('/proc/jobs/feed_7/pl-dircopy_12/data/home_alice_uploads_set/a.txt');
 * // '/home/alice/uploads/set/a.txt', the dircopy's output holding a link to ~/uploads/set
 */
export async function storePath_resolve(inputPath: string): Promise<string> {
  // An absolute path needs no session to stand where it is.
  let at: string = inputPath.startsWith('/') ? path_resolveFrom(inputPath, '/', '/') : await path_resolve(inputPath);
  const dispatcher: VFSDispatcher = vfsDispatcher_get();
  const links: ((path: string) => Promise<string>) | undefined = backendInstalled_get()?.vfs?.path_physical;
  // A dispatcher that cannot say where its mounts are holds none.
  const mounted = (candidate: string): boolean => typeof dispatcher.path_isVirtual === 'function' && dispatcher.path_isVirtual(candidate);
  for (let hop: number = 0; hop < STORE_HOPS_MAX; hop++) {
    if (mounted(at)) {
      const mount: VFSProvider = dispatcher.provider_get(at);
      if (mount.storePath_resolve === undefined) return at;
      let mapped: Result<string | null>;
      try {
        mapped = await mount.storePath_resolve(at);
      } catch {
        return at;
      }
      if (!mapped.ok || mapped.value === null || mapped.value === at) return at;
      at = mapped.value;
      continue;
    }
    if (links === undefined) return at;
    // A walk that cannot follow a link (one that fails, or throws) leaves
    // the path as it was; what it noted on the way is not the read's
    // reason, which the read gives.
    const mark: number = errorStack.checkpoint_mark();
    let followed: string = at;
    try {
      followed = await links(at);
    } catch {
      // The path stands as asked.
    }
    errorStack.checkpoint_drain(mark);
    if (followed === at || !mounted(followed)) return followed;
    at = followed;
  }
  return at;
}
