/**
 * @file `cd`: changes where the session stands in ChRIS's filesystem (CFS),
 * the /proc and /net projections included.
 *
 * Declared in one record (`cdCommand`): one path, which may be a wildcard
 * that matches one folder; none goes home, `-` goes back.
 *
 * Key components:
 * - cdCommand: the declaration.
 * - builtin_cd: the declaration run over words already split.
 * - cd_run: the typed core behind both, and the typed API.
 *
 * Typical usage:
 * ```ts
 * await builtin_cd(['~/feeds']);
 * await cd_run({ path: '-' });
 * ```
 *
 * Dependencies: the session's cwd, the filesystem's providers and listing
 * cache, and the backend's way of entering a folder.
 *
 * @module
 */
import chalk from 'chalk';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import path from 'path';
import { session } from '../../session/index.js';
import { path_resolve, error_stripDebugPrefix } from '../utils.js';
import { Ok, Err, type Result, type StackMessage, type VFSItem } from '@fnndsc/fond';
import { backendInstalled_get, type FolderEntry } from '../../core/backend.js';
import { listingCache_get, vfsDispatcher_get } from '../../core/filesystem.js';
import { itemType_isContainer } from '../../core/itemKinds.js';
import { envelope_ok, envelope_error, type CommandEnvelope } from '@fnndsc/menu';

/**
 * The paths that are always folders, entered without asking: the backend's
 * (ChRIS: the root and its projections' own places), or the root alone.
 *
 * @returns The paths.
 */
function structuralPaths_get(): ReadonlyArray<string> {
  return backendInstalled_get()?.vfs?.structural ?? ['/'];
}

/**
 * Normalizes a logical path for VFS comparison by stripping a single trailing
 * slash (except for the root path).
 *
 * @param logicalPath - The resolved logical path.
 * @returns The normalized path.
 */
export function vfsPath_normalize(logicalPath: string): string {
  return logicalPath.endsWith('/') && logicalPath.length > 1 ? logicalPath.slice(0, -1) : logicalPath;
}

/**
 * Reports whether a path is a structural VFS container (always valid).
 *
 * @param cleanPath - The normalized path.
 * @returns True if the path is a known structural VFS container.
 */
export function vfsPath_isStructural(cleanPath: string): boolean {
  return structuralPaths_get().includes(cleanPath);
}

/**
 * A parent's listing, from the cache when it holds one — the parent is
 * almost always the listing on screen, and `cd` needs an entry's kind, not
 * its freshest row, so a stale listing serves — and from CUBE only when the
 * cache never held it. Every `cd` used to list the parent from CUBE (three
 * requests) to learn whether the entry was a link.
 *
 * @param parentPath - The parent directory.
 * @returns Its entries, or Err when it cannot be listed.
 */
async function parentListing_get(parentPath: string): Promise<Result<VFSItem[]>> {
  const kept: { data: VFSItem[]; fresh: boolean } | null = listingCache_get().cache_get<VFSItem[]>(parentPath);
  if (kept) return Ok(kept.data);
  // Through the listing façade, so what CUBE answers is cached for the
  // next cd (and the ls that follows): listed live and uncached, the root
  // was fetched again on every cd into /bin.
  const { vfs } = await import('../../lib/vfs/vfs.js');
  const listed: Result<{ items: unknown[] }> = await vfs.listing_get(parentPath);
  return listed.ok ? Ok(listed.value.items as VFSItem[]) : Err();
}

/**
 * The target of a CFS link at a path, from its parent's listing; null when
 * the path is not a link (or its parent cannot be listed).
 *
 * @param cleanPath - The normalized absolute path.
 * @returns The absolute target path, or null.
 */
export async function cfsLink_target(cleanPath: string): Promise<string | null> {
  if (cleanPath === '/' || !cleanPath.startsWith('/')) return null;
  const parentResult: Result<VFSItem[]> = await parentListing_get(path.posix.dirname(cleanPath));
  if (!parentResult.ok) return null;
  const entryName: string = path.posix.basename(cleanPath);
  const entry: VFSItem | undefined = parentResult.value.find((item: VFSItem): boolean => item.name === entryName);
  return entry?.type === 'link' && entry.target ? entry.target : null;
}

/**
 * Builds the success envelope for a completed directory change.
 *
 * @param newCwd - The working directory that is now current.
 * @param rendered - Any stdout text (debug traces) produced along the way.
 * @returns An ok envelope carrying the fs.cwd model.
 */
function cdSuccess_envelope(newCwd: string, rendered: string): CommandEnvelope {
  return envelope_ok(rendered, { kind: 'fs.cwd', data: { path: newCwd } });
}

/**
 * Handles `cd` into a virtual (VFS) path: structural containers are accepted
 * directly, deeper VFS paths are validated and their listing cached.
 *
 * @param cleanPath - The normalized virtual path.
 * @param pathArg - The original user-supplied path (for error messages).
 * @returns The command envelope for the attempt.
 */
async function cdVirtual_handle(cleanPath: string, pathArg: string): Promise<CommandEnvelope> {
  if (vfsPath_isStructural(cleanPath)) {
    await session.directory_change(cleanPath);
    return cdSuccess_envelope(cleanPath, '');
  }

  // Resolve the target from its parent listing before asking the target provider
  // to list its children. Some providers deliberately return a containing-node
  // listing for virtual files such as /proc/.../status; a successful list alone
  // therefore does not establish that `cleanPath` is navigable.
  const vfsDispatcher = vfsDispatcher_get();
  const parentPath: string = path.posix.dirname(cleanPath);
  const entryName: string = path.posix.basename(cleanPath);
  const parentResult: Result<VFSItem[]> = await parentListing_get(parentPath);
  const entry: VFSItem | undefined = parentResult.ok
    ? parentResult.value.find((item: VFSItem) => item.name === entryName)
    : undefined;
  if (entry?.type === 'link') {
    let target: string | undefined = entry.target;
    if (!target) {
      const linkResult: Result<string> = await vfsDispatcher.linkTarget_resolve(cleanPath);
      if (linkResult.ok) target = linkResult.value;
    }
    if (!target) {
      return envelope_error('', undefined, `${chalk.red(`cd: ${pathArg}: No such file or directory`)}\n`);
    }
    // A link may point into another projection (a tag's feed_N is a link to
    // /proc/jobs/feed_N): that target is entered as the projection it is.
    if (vfsDispatcher.path_isVirtual(target)) return cdVirtual_handle(vfsPath_normalize(target), pathArg);
    return cdReal_handle(target, pathArg);
  }
  if (entry && !itemType_isContainer(entry.type)) {
    return envelope_error('', undefined, `${chalk.red(`cd: ${pathArg}: Not a directory`)}\n`);
  }

  // A directory-like VFS entry is listed to validate it and to prime the
  // `ls` that follows — through the one listing façade, so the cache the
  // boot warmed and `ls` fills serves at once: `cd /bin` used to fetch the
  // whole of /bin from CUBE every time (plugins, pipelines, their sources;
  // seconds) and then overwrite a cache that already held it. A stale
  // entry is served and refreshed behind the prompt (listing_get), the
  // way a stale `ls` is; a path the cache never held is listed as before.
  const { vfs } = await import('../../lib/vfs/vfs.js');
  const listResult: Result<{ items: unknown[] }> = await vfs.listing_get(cleanPath);
  if (!listResult.ok) {
    const { errorStack } = await import('@fnndsc/fond');
    const lastError: StackMessage | undefined = errorStack.stack_pop();
    const detail: string = lastError ? error_stripDebugPrefix(lastError.message) : 'No such file or directory';
    return envelope_error('', undefined, `${chalk.red(`cd: ${pathArg}: ${detail}`)}\n`);
  }

  await session.directory_change(cleanPath);
  return cdSuccess_envelope(cleanPath, '');
}

/**
 * Enters a folder outside the mounts. The backend says whether it is one
 * and where the session then stands (ChRIS asks CUBE for the folder); a
 * backend that does not say has a folder that lists.
 *
 * @param logicalPath - The folder, as the session names it.
 * @param pathArg - The path as typed, for what cd says.
 * @returns The cd envelope.
 */
async function cdReal_handle(logicalPath: string, pathArg: string): Promise<CommandEnvelope> {
  const enter: ((at: string, typed: string) => Promise<FolderEntry>) | undefined = backendInstalled_get()?.vfs?.folder_enter;
  const entry: FolderEntry = enter !== undefined ? await enter(logicalPath, pathArg) : await folderEntry_resolveByListing(logicalPath);
  if (entry.cwd === null) {
    return envelope_error(entry.rendered, undefined, entry.renderedErr || `${chalk.red(`cd: ${pathArg}: No such file or directory`)}\n`);
  }
  await session.directory_change(entry.cwd);
  return cdSuccess_envelope(entry.cwd, entry.rendered);
}

/**
 * A folder is one that lists: how a backend with no way of its own enters one.
 *
 * @param logicalPath - The folder.
 * @returns Where to stand, or not a folder.
 */
async function folderEntry_resolveByListing(logicalPath: string): Promise<FolderEntry> {
  const { vfs } = await import('../../lib/vfs/vfs.js');
  const listed: Result<{ items: unknown[] }> = await vfs.listing_get(logicalPath);
  if (listed.ok) return { cwd: logicalPath, rendered: '', renderedErr: '' };
  const { errorStack } = await import('@fnndsc/fond');
  errorStack.stack_pop();
  return { cwd: null, rendered: '', renderedErr: '' };
}

/** What a `cd` line may hold. */
const CD_GRAMMAR = {
  operands: [
    { name: 'path', kind: 'cfsPath', optional: true, glob: true, summary: 'Where to go: a folder, .., ~, or - for the last; home when none is given' },
  ],
} as const satisfies CommandGrammar;

/**
 * `cd [path]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [cdCommand] });
 * ```
 */
export const cdCommand = command_declare({
  name: 'cd',
  grammar: CD_GRAMMAR,
  help: {
    summary: 'Change current working directory',
    description: "Moves the session to a folder of ChRIS's filesystem, the /proc and /net projections included. A link is entered at its target. With no path cd goes home; cd - goes back to the folder before.",
    category: 'Navigation',
    posix: { group: 'Files', differs: 'moves in CFS, including /proc and /net' },
    examples: [
      'cd /home/user/data    # Absolute path',
      'cd experiments        # Relative path',
      'cd ..                 # Parent directory',
      'cd ~                  # Home directory',
      'cd -                  # The folder before',
      'cd                    # Home directory',
    ],
  },
  holds: ['cwd'],
  handler: async (args: CommandArguments<typeof CD_GRAMMAR>): Promise<CommandEnvelope> => cd_run({ path: args.operands.path }),
});

/**
 * `cd` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `cd`.
 * @returns The new working directory, or the refusal of a bad line.
 */
export async function builtin_cd(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(cdCommand, args);
}

/** Typed invocation options for cd. */
export interface CdOptions {
  /** Target directory; omitted means home, '-' means the previous cwd. */
  path?: string;
}

/**
 * Changes the working directory: the shared typed core behind the parsed
 * builtin and the typed API.
 *
 * @param options - The target directory.
 * @returns An envelope carrying the fs.cwd model on success.
 */
export async function cd_run(options: CdOptions): Promise<CommandEnvelope> {
  const pathArg: string | undefined = options.path;

  // 'cd' with no args goes to home
  if (!pathArg) {
    return cd_run({ path: '~' });
  }

  if (pathArg === '-') {
    const previousCWD: string | undefined = session.previousCWD_get();
    if (!previousCWD) {
      return envelope_error('', undefined, `${chalk.red('cd: OLDPWD not set')}\n`);
    }
    const result: CommandEnvelope = await cd_run({ path: previousCWD });
    return result.status === 'ok'
      ? { ...result, rendered: `${previousCWD}\n${result.rendered}` }
      : result;
  }

  try {
    const logicalPath: string = await path_resolve(pathArg);

    const vfsDispatcher = vfsDispatcher_get();
    const cleanPath: string = vfsPath_normalize(logicalPath);
    // Treat the path as virtual if it is, or is a parent of, any registered
    // provider prefix (e.g. /proc is parent of /proc/jobs).
    const isParentOfVfs: boolean = vfsDispatcher.providers_get().some(
      (p: { prefix: string }) => p.prefix.startsWith(cleanPath + '/')
    );
    const isVirtual: boolean =
      cleanPath === '/' ||
      vfsPath_isStructural(cleanPath) ||
      isParentOfVfs ||
      vfsDispatcher.provider_get(cleanPath).prefix !== '';

    if (isVirtual) {
      return cdVirtual_handle(cleanPath, pathArg);
    }

    // A CFS link names a place: entering it moves to its target. The link's
    // own path is not a folder CUBE would validate, so it must be followed
    // here, and a refusal names the target the link points at.
    const linkTarget: string | null = await cfsLink_target(cleanPath);
    if (linkTarget !== null) {
      const followed: CommandEnvelope = await cdReal_handle(linkTarget, pathArg);
      if (followed.status === 'ok') return followed;
      return envelope_error('', undefined, `${chalk.red(`cd: ${pathArg}: link target ${linkTarget}: No such file or directory`)}\n`);
    }

    return cdReal_handle(logicalPath, pathArg);
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    return envelope_error('', undefined, `${chalk.red(`Failed to cd: ${msg}`)}\n`);
  }
}
