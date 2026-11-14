/**
 * @file `mv`: moves or renames files and folders within ChRIS's filesystem
 * (CFS), reported as a command envelope.
 *
 * Declared in one record (`mvCommand`): the sources, then the destination,
 * each a path that may be a wildcard; a lone source, or `-t`, asks where.
 * Each path is acted on where the store keeps it (`storePath_resolve`): a
 * source is the entry itself, so moving a link moves the link, never what
 * it points at; a destination through a link lands in the link's target.
 * What mv says names the paths as the session resolves them.
 *
 * Key components:
 * - mvCommand: the declaration.
 * - builtin_mv: the declaration run over words already split.
 * - mv_run: the typed core behind both, and the typed API.
 *
 * Typical usage:
 * ```ts
 * await builtin_mv(['old.txt', 'new.txt']);
 * await mv_run({ sources: ['a.txt', 'b.txt'], dest: 'archive/' });
 * ```
 *
 * Dependencies: the session's filesystem and listing cache, and the
 * destination question.
 *
 * @module
 */
import chalk from 'chalk';
import path from 'path';
import { path_resolve, storePath_resolve } from '../utils.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { listingCache_get, vfsDispatcher_get } from '../../core/filesystem.js';
import type { ListingCache } from '../../core/backend.js';
import { destination_ask, destination_missing, operands_fix } from './destination.js';
import { pathEntry_find, entry_isFolder } from './entries.js';
import { mv_render, vfs_fail, vfsRefusal_text, type VFSDispatcher, type VfsOutcome } from '@fnndsc/fond';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';

/** Outcome of one move source, for the envelope model. */
export interface MvOutcome {
  source: string;
  moved: boolean;
}

/** Model payload for the fs.mv envelope. */
export interface MvModelData {
  dest: string;
  outcomes: MvOutcome[];
  moved: number;
  failed: number;
}

/** What an `mv` line may hold. */
const MV_GRAMMAR = {
  operands: [
    { name: 'paths', kind: 'cfsPath', repeat: true, glob: true, summary: 'The sources, then the destination; a lone source asks where it goes' },
  ],
  options: {
    askTarget: { short: 't', summary: 'Every operand is a source; asks for the target directory, and the answer must be one' },
    targetDirectory: { long: 'target-directory', summary: 'Every operand is a source; move into this directory', value: { name: 'dir', kind: 'cfsPath' } },
  },
} as const satisfies CommandGrammar;

/**
 * Runs a parsed `mv` line: into a target directory given or asked for, to a
 * destination asked for a lone source, or to the last operand.
 *
 * @param args - The typed line.
 * @returns The move's envelope, or the refusal of an abandoned question.
 */
async function mv_handle(args: CommandArguments<typeof MV_GRAMMAR>): Promise<CommandEnvelope> {
  const paths: string[] = args.operands.paths;
  // `--target-directory <dir>` names the TARGET DIRECTORY, so every operand
  // is a source: the shell's own answer to "several things, one destination".
  const target: string | undefined = args.options.targetDirectory;
  if (target !== undefined) return mv_run({ sources: paths, dest: target });
  // `-t` alone is that line with the directory not said: a question
  // (an-absent-value-is-a-question), and the answer wants a directory:
  // `mv a b` without it means rename a ONTO b, the right reading of that
  // line and the wrong thing for a set. One operand names what to move and
  // not where: a question too, not a usage error. The answer opens where
  // the file already lives, so the ordinary case is a rename.
  if (args.options.askTarget || paths.length === 1) {
    // The sources are fixed before the question: other commands run while it is open.
    const sources: string[] = await operands_fix(paths);
    const chosen: string = await destination_ask({
      verb: 'mv', commit: 'MOVE HERE', sources, ...(args.options.askTarget ? { wantsDirectory: true } : {}),
    });
    if (chosen === '') {
      exitCode_set(1);
      return envelope_error('', undefined, `${chalk.red(destination_missing('mv'))}\n`);
    }
    return mv_run({ sources, dest: chosen });
  }
  // The last operand is the destination, all others are sources.
  return mv_run({ sources: paths.slice(0, -1), dest: paths[paths.length - 1] ?? '' });
}

/**
 * `mv [-t] [--target-directory <dir>] <paths…>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [mvCommand] });
 * ```
 */
export const mvCommand = command_declare({
  name: 'mv',
  grammar: MV_GRAMMAR,
  help: {
    summary: 'Move or rename files or directories (supports wildcards and multiple sources)',
    description: "Moves or renames files or folders within ChRIS's filesystem: the last operand is the destination, and into a folder it names an entry keeps its name. Given only a source, the destination is asked for. A link is moved as itself, never what it points at; a destination through a link lands in the folder it points at.",
    category: 'Files',
    posix: { group: 'Files', differs: 'moves within CFS' },
    examples: [
      'mv old.txt new.txt                # Rename file',
      'mv dir1/ dir2/                    # Move directory into dir2',
      'mv file.txt /home/user/archive/   # Move into existing directory',
      'mv file1 file2 file3 dest/        # Move multiple files',
      'mv uploads/* backup/              # Move with wildcard',
      'mv --target-directory backup/ a b # Move several into one folder',
      'mv -t a.txt b.txt                 # Ask which folder they go to',
      'mv "file with spaces.txt" dest/   # Use quotes for spaces',
    ],
  },
  handler: mv_handle,
});

/**
 * `mv` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `mv`.
 * @returns An envelope whose rendered text reports progress and results and
 *   whose model carries per-source outcomes, or the refusal of a bad line.
 */
export async function builtin_mv(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(mvCommand, args);
}

/** One move, as the store is asked it and as mv says it. */
interface EntryMove {
  /** The source entry, where the store keeps it. */
  srcStore: string;
  /** The destination, where the store keeps it. */
  destStore: string;
  /** The source as the session names it, for what mv says. */
  srcPath: string;
  /** Whether the destination was written with a trailing slash. */
  intoFolder: boolean;
}

/**
 * Moves one entry. Into a folder the destination names (or one named with a
 * trailing slash) it keeps its name; otherwise it takes the destination's.
 * A rename inside a projection (a tag under /proc/tags) is the projection's,
 * and across one it refuses.
 *
 * @param dispatcher - The session's filesystem.
 * @param move - The source and destination, as the store keeps them.
 * @returns Done, or why not.
 */
async function entry_move(dispatcher: VFSDispatcher, move: EntryMove): Promise<VfsOutcome> {
  const { srcStore, destStore, srcPath, intoFolder }: EntryMove = move;
  if (dispatcher.path_isVirtual(srcStore) || dispatcher.path_isVirtual(destStore)) return dispatcher.rename(srcStore, destStore);
  if ((await pathEntry_find(dispatcher, srcStore)) === null) return vfs_fail('ENOENT', `Source not found: ${srcPath}`);
  const finalDest: string = intoFolder || entry_isFolder(await pathEntry_find(dispatcher, destStore))
    ? path.posix.join(destStore, path.posix.basename(srcStore))
    : destStore;
  return dispatcher.rename(srcStore, finalDest);
}

/**
 * Forgets the cached listings a move changes at a path: beneath it and of
 * its parent, by each name it has.
 *
 * @param listCache - The session's listing cache.
 * @param names - The path as the session names it and as the store keeps it.
 */
function listings_invalidate(listCache: ListingCache, names: readonly string[]): void {
  for (const name of new Set(names)) {
    listCache.cache_invalidate?.(path.posix.dirname(name));
    listCache.cache_invalidateTree?.(name);
  }
}

/** Typed invocation options for mv. */
export interface MvOptions {
  /** Source paths, absolute or relative to the session cwd. */
  sources: string[];
  /** Destination path (a directory when several sources are given). */
  dest: string;
}

/**
 * Moves or renames files or directories: the shared typed core behind the
 * parsed builtin and the typed API.
 *
 * @param options - Sources and destination.
 * @returns An envelope whose rendered text reports results and whose
 *   `fs.mv` model carries per-source outcomes.
 */
export async function mv_run(options: MvOptions): Promise<CommandEnvelope> {
  const sources: string[] = options.sources;
  const dest: string = options.dest;

  if (sources.length === 0 || dest === '') {
    return envelope_error(`${chalk.red('Usage: mv <source...> <dest>')}\n`);
  }

  const destPath: string = await path_resolve(dest);
  // Written where the store keeps it: into a linked folder lands in the link's target.
  const destStore: string = await storePath_resolve(destPath);
  const listCache: ListingCache = listingCache_get();
  const dispatcher: VFSDispatcher = vfsDispatcher_get();
  let successCount: number = 0;
  let failCount: number = 0;
  let rendered: string = '';
  let renderedErr: string = '';
  const outcomes: MvOutcome[] = [];

  for (const src of sources) {
    try {
      const srcPath: string = await path_resolve(src);
      // The entry itself: moving a link moves the link, not what it points at.
      const srcStore: string = await storePath_resolve(srcPath, { entry: true });

      // For multiple sources, show which file we're moving
      if (sources.length > 1) {
        rendered += `${chalk.gray(`Moving ${srcPath}...`)}\n`;
      } else {
        rendered += `Moving ${srcPath} to ${destPath}...\n`;
      }

      const moved: VfsOutcome = await entry_move(dispatcher, { srcStore, destStore, srcPath, intoFolder: dest.endsWith('/') });
      const success: boolean = moved.ok;

      if (sources.length === 1) {
        rendered += `${mv_render(srcPath, destPath, success)}\n`;
      }
      if (!moved.ok) {
        // The mount said WHY; a bare "Failed to move" makes an operator
        // guess at a reason that was already known.
        const said: string = moved.reason ?? vfsRefusal_text('rename', moved, srcPath, destPath);
        renderedErr += `${chalk.red(said.startsWith('mv:') ? said : `mv: ${said}`)}\n`;
      }

      outcomes.push({ source: srcPath, moved: success });
      if (success) {
        successCount++;
        // Invalidate the source's parent AND the moved subtree: listings
        // cached beneath the old path would otherwise serve the vanished
        // tree until their TTL expires.
        listings_invalidate(listCache, [srcPath, srcStore]);
      } else {
        failCount++;
      }
    } catch (e: unknown) {
      const msg: string = e instanceof Error ? e.message : String(e);
      renderedErr += `${chalk.red(`mv: ${src}: ${msg}`)}\n`;
      outcomes.push({ source: src, moved: false });
      failCount++;
    }
  }

  // Invalidate the destination subtree (a moved directory replaces whatever
  // listings were cached beneath it) and its parent.
  listings_invalidate(listCache, [destPath, destStore]);

  // Summary for multiple files
  if (sources.length > 1) {
    if (failCount === 0) {
      rendered += `${chalk.green(`✓ Moved ${successCount} file(s) to ${destPath}`)}\n`;
    } else {
      rendered += `${chalk.yellow(`⚠ Moved ${successCount} file(s), ${failCount} failed`)}\n`;
    }
  }

  const modelData: MvModelData = { dest: destPath, outcomes, moved: successCount, failed: failCount };
  if (failCount > 0) {
    const envelope: CommandEnvelope = envelope_error(rendered, undefined, renderedErr || undefined);
    envelope.model = { kind: 'fs.mv', data: modelData };
    return envelope;
  }
  return envelope_ok(rendered, { kind: 'fs.mv', data: modelData });
}
