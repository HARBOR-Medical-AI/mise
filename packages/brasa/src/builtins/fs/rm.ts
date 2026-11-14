/**
 * @file `rm`: removes files and folders of ChRIS's filesystem (CFS).
 *
 * Declared in one record (`rmCommand`): paths, which glob, and the switches
 * `-r`/`-R`, `-f`, `-i` and `-I`. Each path names the entry itself: `rm` of
 * a link removes the link, never what it points at.
 *
 * Key components:
 * - rmCommand: the declaration.
 * - builtin_rm: the declaration run over words already split.
 * - rm_run: the typed core behind both, and the typed API.
 * - rmSummary_format: the line that sums up several removals.
 *
 * Typical usage:
 * ```ts
 * await builtin_rm(['-r', 'scratch']);
 * await rm_run({ recursive: true, force: false, interactive: false, once: false, paths: ['scratch'] });
 * ```
 *
 * Dependencies: the session's filesystem and listing cache, the store-path
 * resolver, and the surface (which asks `-i` and `-I`'s questions).
 *
 * @module
 */
import chalk from 'chalk';
import path from 'path';
import { path_resolve, storePath_resolve } from '../utils.js';
import { repl_confirm } from '../../core/question.js';
import { listingCache_get, vfsDispatcher_get } from '../../core/filesystem.js';
import type { ListingCache } from '../../core/backend.js';
import { pathEntry_find, entry_isFolder, folderTree_remove } from './entries.js';
import { errno_words, rm_render, vfs_fail, vfs_ok, type VFSDispatcher, type VFSItem, type VfsOutcome } from '@fnndsc/fond';
import { sink_get } from '../../core/sink.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/**
 * Prompts the user for confirmation.
 *
 * @param message - The prompt message.
 * @returns A Promise resolving to true if user confirms (y/Y), false otherwise.
 */
async function prompt_confirm(message: string): Promise<boolean> {
  // Asked through the SURFACE, never through this process's stdin. Under a
  // daemon that stdin belongs to whoever started the daemon — not to the
  // operator running `rm -i` from a browser three rooms away, who would
  // have waited forever for a question asked of somebody else's terminal.
  return repl_confirm(message);
}

/**
 * Why a question came back with no answer.
 *
 * A question can end without a yes or a no: the operator abandoned it, or
 * the surface that was asked lost the ability to answer. Neither is a
 * removal failing — nothing was attempted — so `rm` keeps the file, says
 * which one it kept and why, and reports an ordinary outcome.
 *
 * @param error - Whatever the ask rejected with.
 * @returns A phrase that finishes 'skipped x: ...'.
 */
function unanswered_reason(error: unknown): string {
  return error instanceof Error && error.message !== ''
    ? error.message
    : 'the question could not be answered';
}

/**
 * What `rm` is asked to do: its switches, and its operands as typed.
 *
 * @example
 * ```ts
 * const args: RmArgs = { recursive: true, force: false, interactive: false, once: false, paths: ['scratch'] };
 * ```
 */
export interface RmArgs {
  /** Remove folders with all they hold (`-r`, `-R`). */
  recursive: boolean;
  /** Nothing there is fine (`-f`). */
  force: boolean;
  /** Ask before each removal (`-i`). */
  interactive: boolean;
  /**
   * Ask ONCE for the whole list rather than once per target (`-I`), which
   * is what a set deserves: twenty questions to remove twenty files is a
   * confirmation an operator learns to dismiss without reading.
   */
  once: boolean;
  /** The operands, as typed. */
  paths: string[];
}

/**
 * Formats the multi-target removal summary line.
 *
 * @param successCount - Number of items removed successfully.
 * @param failCount - Number of items that failed to remove.
 * @returns The summary string, or null if there is nothing to summarise.
 */
export function rmSummary_format(successCount: number, failCount: number): string | null {
  if (!(successCount > 0 || failCount > 0)) return null;
  if (successCount > 0 && failCount === 0) {
    return chalk.green(`Successfully removed ${successCount} item${successCount !== 1 ? 's' : ''}`);
  }
  if (successCount > 0 && failCount > 0) {
    return chalk.yellow(`Removed ${successCount} item${successCount !== 1 ? 's' : ''}, failed ${failCount}`);
  }
  return chalk.red(`Failed to remove ${failCount} item${failCount !== 1 ? 's' : ''}`);
}

/** Outcome of one removal target, for the envelope model. */
export interface RmOutcome {
  path: string;
  removed: boolean;
  skipped: boolean;
}

/** What one removal did: the kind of thing removed (null when nothing was there), and its outcome. */
interface EntryRemoval {
  type: 'file' | 'dir' | 'link' | null;
  outcome: VfsOutcome;
}

/**
 * Removes one path. A projection's path is its mount's to remove or refuse
 * (a tag names its own verbs). Elsewhere what holds the path decides: a file
 * or link is removed, a folder only with `-r` (with all it holds), and
 * nothing there is fine under `-f`.
 *
 * @param dispatcher - The session's filesystem.
 * @param target - The absolute path.
 * @param recursive - `-r`.
 * @param force - `-f`.
 * @returns What was removed, and the outcome.
 */
async function entry_remove(dispatcher: VFSDispatcher, target: string, recursive: boolean, force: boolean): Promise<EntryRemoval> {
  if (dispatcher.path_isVirtual(target)) {
    return { type: null, outcome: recursive ? await dispatcher.rmTree(target) : await dispatcher.rm(target) };
  }
  const entry: VFSItem | null = await pathEntry_find(dispatcher, target);
  if (entry === null) return { type: null, outcome: force ? vfs_ok(true) : vfs_fail('ENOENT') };
  if (entry_isFolder(entry)) {
    return { type: 'dir', outcome: recursive ? await folderTree_remove(dispatcher, target) : vfs_fail('EISDIR') };
  }
  return { type: entry.type === 'link' ? 'link' : 'file', outcome: await dispatcher.rm(target) };
}

/** What an `rm` line may hold. */
const RM_GRAMMAR = {
  operands: [
    { name: 'paths', kind: 'cfsPath', repeat: true, glob: true, summary: 'What to remove: files, or folders with -r; a wildcard matches paths' },
  ],
  options: {
    recursive: { short: 'r', long: 'recursive', summary: 'Remove folders and all they hold (without it a folder is "Is a directory")' },
    recursiveAlias: { short: 'R', summary: 'The same as -r' },
    force: { short: 'f', long: 'force', summary: 'Force removal: a path not there is fine' },
    interactive: { short: 'i', long: 'interactive', summary: 'Ask before every removal' },
    once: { short: 'I', summary: 'Ask ONCE for the whole list, naming how many' },
  },
} as const satisfies CommandGrammar;

/**
 * `rm [-rRfiI] <path…>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [rmCommand] });
 * ```
 */
export const rmCommand = command_declare({
  name: 'rm',
  grammar: RM_GRAMMAR,
  help: {
    summary: 'Remove files or directories',
    description: "Removes each path from ChRIS's filesystem (a wildcard matches paths). A folder goes only with -r, with all it holds. A link is removed itself, never what it points at. With -i each removal is asked first; with -I one question covers the whole list. Every target is fixed before any question, so a cd while one is open moves nothing.",
    category: 'Files',
    posix: { group: 'Files', differs: 'removes from CFS; -r for folders, -i asks' },
    examples: [
      'rm file.txt           # Remove single file',
      'rm file1 file2        # Remove multiple files',
      'rm *.json             # Remove all .json files (wildcard)',
      'rm -i *.log           # Prompt before removing each .log file',
      'rm -r directory/      # Remove directory recursively',
      'rm -rf temp_*         # Force remove all temp_* dirs',
      'rm -- --weird-name    # Remove file starting with --',
      'rm -- -dash-file      # Remove file starting with -',
    ],
  },
  handler: async (args: CommandArguments<typeof RM_GRAMMAR>): Promise<CommandEnvelope> => rm_run({
    recursive: args.options.recursive || args.options.recursiveAlias,
    force: args.options.force,
    interactive: args.options.interactive,
    once: args.options.once,
    paths: args.operands.paths,
  }),
});

/**
 * `rm` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `rm`.
 * @returns An envelope whose model lists per-target outcomes, or the refusal of a bad line.
 */
export async function builtin_rm(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(rmCommand, args);
}

/** One operand fixed before any question: where it is shown, and the store entry acted on. */
interface FixedTarget {
  /** The path as the session names it, for what rm says. */
  shown: string;
  /** The entry itself in the store: a link, not what it points at. */
  target: string;
}

/**
 * Forgets the listings a removal changed: the folder that held the entry and
 * everything cached beneath it, by the session's path and by the store's.
 *
 * @param fixed - The operand, as shown and in the store.
 */
function listings_forget(fixed: FixedTarget): void {
  const listCache: ListingCache = listingCache_get();
  for (const at of new Set([fixed.shown, fixed.target])) {
    listCache.cache_invalidate?.(path.posix.dirname(at));
    // Also drop the removed target and any listings cached beneath it:
    // a later re-upload to the same path must not inherit still-fresh
    // nested listings from the deleted tree.
    listCache.cache_invalidateTree?.(at);
  }
}

/**
 * Removes files or directories: the shared typed core behind the parsed
 * builtin and the typed API.
 *
 * In interactive mode (-i, -I) output is streamed live through the sink so
 * each confirmation prompt appears in sequence with its result; the envelope
 * then carries only the model. Otherwise output is buffered into the envelope.
 *
 * @param runArgs - Flags and target paths.
 * @returns An envelope whose model lists per-target outcomes.
 */
export async function rm_run(runArgs: RmArgs): Promise<CommandEnvelope> {
  const { recursive, force, interactive, once, paths }: RmArgs = runArgs;

  if (paths.length === 0) {
    return envelope_error('', undefined, `${chalk.red('Usage: rm [-rfiI] <path> [path...]')}\n`);
  }

  // Every target is fixed before any question is asked: while a question is
  // open the session runs other commands, and a `cd` among them must not
  // turn the answer into a removal somewhere else. A path that does not
  // resolve keeps its failure, reported in its place below.
  const fixed: Array<FixedTarget | { failure: unknown }> = [];
  for (const pathArg of paths) {
    try {
      fixed.push({ shown: await path_resolve(pathArg), target: await storePath_resolve(pathArg, { entry: true }) });
    } catch (failure: unknown) {
      fixed.push({ failure });
    }
  }

  // One question for the whole list, asked before anything is removed and
  // naming what will go. A refusal removes nothing at all — there is no
  // half of a set.
  if (once) {
    const many: string = paths.length === 1
      ? `'${paths[0]}'`
      : `${paths.length} items`;
    let agreed: boolean = false;
    let unanswered: string | null = null;
    try {
      agreed = await prompt_confirm(`rm: remove ${many}? (y/n): `);
    } catch (e: unknown) {
      // A question with no answer keeps everything, the same as a no. It
      // says why, so a surface that has quietly lost its voice is not read
      // as an operator who declined.
      unanswered = unanswered_reason(e);
    }
    if (!agreed) {
      const why: string = unanswered === null ? '' : `: ${unanswered}`;
      return envelope_ok(`${chalk.gray(`nothing removed (${paths.length} kept)${why}`)}\n`, {
        kind: 'fs.rm',
        data: paths.map((path: string): RmOutcome => ({ path, removed: false, skipped: true })),
      });
    }
  }

  const dispatcher: VFSDispatcher = vfsDispatcher_get();
  let successCount: number = 0;
  let failCount: number = 0;
  let rendered: string = '';
  let renderedErr: string = '';
  const outcomes: RmOutcome[] = [];

  /**
   * Emits one line of stdout output: streamed live in interactive mode,
   * buffered into the envelope otherwise.
   *
   * @param line - The line to emit (without trailing newline).
   */
  const out_emit = (line: string): void => {
    if (interactive || once) {
      sink_get().data_write(`${line}\n`);
    } else {
      rendered += `${line}\n`;
    }
  };

  /**
   * Emits one line of error output: streamed live in interactive mode,
   * buffered into the envelope otherwise.
   *
   * @param line - The line to emit (without trailing newline).
   */
  const err_emit = (line: string): void => {
    if (interactive || once) {
      sink_get().err_write(`${line}\n`);
    } else {
      renderedErr += `${line}\n`;
    }
  };

  // Where the operator walked away, when they did: everything after it was
  // never put to them, and a set of files silently left alone is worse than
  // a set left alone out loud.
  let abandonedAt: number | null = null;

  for (let index: number = 0; index < paths.length; index++) {
    const pathArg: string = paths[index] as string;
    try {
      const resolution: FixedTarget | { failure: unknown } = fixed[index] as FixedTarget | { failure: unknown };
      if ('failure' in resolution) throw resolution.failure;
      const target: string = resolution.target;

      if (interactive) {
        let confirmed: boolean = false;
        try {
          confirmed = await prompt_confirm(`rm: remove '${pathArg}'? (y/n): `);
        } catch (e: unknown) {
          // Abandoning is an answer, and it answers for the rest of the
          // walk: an operator who backed out of this question is not
          // waiting to be asked the next nineteen.
          out_emit(chalk.gray(`skipped '${pathArg}': ${unanswered_reason(e)}`));
          outcomes.push({ path: pathArg, removed: false, skipped: true });
          abandonedAt = index;
          break;
        }
        if (!confirmed) {
          out_emit(chalk.gray(`skipped '${pathArg}'`));
          outcomes.push({ path: pathArg, removed: false, skipped: true });
          continue;
        }
      }

      const removed: EntryRemoval = await entry_remove(dispatcher, target, recursive, force);

      if (removed.outcome.ok && removed.type === null && !dispatcher.path_isVirtual(target)) {
        // `-f` on something not there: nothing removed, nothing to say.
        outcomes.push({ path: pathArg, removed: false, skipped: false });
        continue;
      }
      if (removed.outcome.ok) {
        if (paths.length > 1) {
          out_emit(chalk.gray(`removed '${pathArg}'`));
        } else {
          out_emit(rm_render({ success: true, path: resolution.shown, type: removed.type }));
        }
        outcomes.push({ path: pathArg, removed: true, skipped: false });
        successCount++;
        listings_forget(resolution);
      } else {
        const reason: string = removed.outcome.reason ?? errno_words(removed.outcome.errno);
        err_emit(chalk.red(`rm: cannot remove '${pathArg}': ${reason}`));
        outcomes.push({ path: pathArg, removed: false, skipped: false });
        failCount++;
      }
    } catch (e: unknown) {
      const msg: string = e instanceof Error ? e.message : String(e);
      err_emit(chalk.red(`rm: cannot remove '${pathArg}': ${msg}`));
      outcomes.push({ path: pathArg, removed: false, skipped: false });
      failCount++;
    }
  }

  if (abandonedAt !== null) {
    const notAsked: string[] = paths.slice(abandonedAt + 1);
    if (notAsked.length > 0) {
      out_emit(chalk.gray(`${notAsked.length} more not asked about, and kept`));
      for (const kept of notAsked) {
        outcomes.push({ path: kept, removed: false, skipped: true });
      }
    }
  }

  if (paths.length > 1) {
    const summary: string | null = rmSummary_format(successCount, failCount);
    if (summary) {
      out_emit('');
      out_emit(summary);
    }
  }

  const model: { kind: string; data: RmOutcome[] } = { kind: 'fs.rm', data: outcomes };
  if (failCount > 0) {
    const envelope: CommandEnvelope = envelope_error(rendered, undefined, renderedErr || undefined);
    envelope.model = model;
    return envelope;
  }
  const envelope: CommandEnvelope = envelope_ok(rendered, model);
  return envelope;
}
