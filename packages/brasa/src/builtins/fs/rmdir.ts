/**
 * @file `rmdir`: removes empty folders, as on Linux.
 *
 * Declared in one record (`rmdirCommand`): folders only, which glob; it
 * has no options. Each path names the entry itself: `rmdir` of a link is
 * asked of the link, never of the folder it points at.
 *
 * Inside a projection that holds folders a user makes (a tag under
 * /proc/tags) the projection removes it, and a tag still worn by a feed is
 * "Directory not empty". On the CUBE store a folder that holds anything is
 * refused by name and an empty one is removed; a projection that removes
 * no folders refuses by name.
 *
 * Key components:
 * - rmdirCommand: the declaration.
 * - builtin_rmdir: the declaration run over words already split.
 * - rmdir_run: the typed core behind both.
 *
 * Typical usage:
 * ```ts
 * await builtin_rmdir(['scratch']);
 * await rmdir_run(['scratch', '/proc/tags/old']);
 * ```
 *
 * Dependencies: the session's filesystem and listing cache, and the
 * store-path resolver.
 *
 * @module
 */
import chalk from 'chalk';
import path from 'path';
import { path_resolve, storePath_resolve } from '../utils.js';
import { listingCache_get, vfsDispatcher_get } from '../../core/filesystem.js';
import { vfsRefusal_text, type VfsErrno, type VfsOutcome } from '@fnndsc/fond';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** Outcome of one rmdir target, for the envelope model. */
export interface RmdirOutcome {
  path: string;
  removed: boolean;
}

/**
 * What rmdir says when a folder was not removed: the mount's reason after
 * the operand (unless the mount already named the verb), else the errno's
 * sentence.
 *
 * @param refused - The failure.
 * @param pathArg - The operand as typed.
 * @returns The line.
 */
function rmdirRefusal_text(refused: { errno: VfsErrno; reason?: string }, pathArg: string): string {
  if (refused.reason === undefined) return vfsRefusal_text('rmdir', refused, pathArg);
  if (refused.reason.startsWith('rmdir:')) return refused.reason;
  // A projection names the folder first (`urgent: Directory not empty`); rmdir has named it already.
  return `rmdir: failed to remove '${pathArg}': ${refused.reason.replace(/^[^:]*: /, '')}`;
}

/** What an `rmdir` line may hold. */
const RMDIR_GRAMMAR = {
  operands: [
    { name: 'paths', kind: 'cfsPath', repeat: true, glob: true, summary: 'The empty folders to remove; a wildcard matches paths' },
  ],
} as const satisfies CommandGrammar;

/**
 * `rmdir <directory…>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [rmdirCommand] });
 * ```
 */
export const rmdirCommand = command_declare({
  name: 'rmdir',
  grammar: RMDIR_GRAMMAR,
  help: {
    summary: 'Remove empty directories',
    description: 'Removes each folder only when it is empty, as on Linux: one that holds anything is "Directory not empty". Under /proc/tags a folder is a tag: rmdir deletes a tag no feed wears.',
    category: 'Files',
    posix: { group: 'Files', differs: 'removes empty CFS folders' },
    examples: [
      'rmdir scratch              # Remove an empty folder',
      'rmdir /proc/tags/old       # Delete a tag no feed wears',
    ],
  },
  handler: async (args: CommandArguments<typeof RMDIR_GRAMMAR>): Promise<CommandEnvelope> => rmdir_run(args.operands.paths),
});

/**
 * `rmdir` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `rmdir`.
 * @returns An envelope whose model lists each folder's outcome, or the refusal of a bad line.
 */
export async function builtin_rmdir(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(rmdirCommand, args);
}

/**
 * Forgets the listing of the folder that held a removed one, by the
 * session's path and by the store's.
 *
 * @param shown - The folder as the session names it.
 * @param target - The folder's entry in the store.
 */
function parentListings_forget(shown: string, target: string): void {
  for (const at of new Set([shown, target])) listingCache_get().cache_invalidate?.(path.posix.dirname(at));
}

/**
 * Removes empty folders: the typed core behind the declaration.
 *
 * @param paths - The folders, as typed.
 * @returns An envelope whose model lists each folder's outcome; silent on success.
 *
 * @example
 * ```ts
 * const envelope: CommandEnvelope = await rmdir_run(['scratch']);
 * ```
 */
export async function rmdir_run(paths: readonly string[]): Promise<CommandEnvelope> {
  if (paths.length === 0) return envelope_error('', undefined, `${chalk.red('Usage: rmdir <directory> [directory...]')}\n`);
  let renderedErr: string = '';
  const outcomes: RmdirOutcome[] = [];
  for (const pathArg of paths) {
    const shown: string = await path_resolve(pathArg);
    const target: string = await storePath_resolve(pathArg, { entry: true });
    // Every mount says why it will not: a folder that is not there, that
    // holds something, or a tag a feed still wears.
    const removed: VfsOutcome = await vfsDispatcher_get().rmdir(target);
    const refusal: string | null = removed.ok ? null : rmdirRefusal_text(removed, pathArg);
    if (refusal !== null) renderedErr += `${chalk.red(refusal)}\n`;
    else parentListings_forget(shown, target);
    outcomes.push({ path: shown, removed: refusal === null });
  }
  const model: { kind: string; data: RmdirOutcome[] } = { kind: 'fs.rmdir', data: outcomes };
  if (renderedErr !== '') {
    exitCode_set(1);
    const envelope: CommandEnvelope = envelope_error('', undefined, renderedErr);
    envelope.model = model;
    return envelope;
  }
  return envelope_ok('', model);
}
