/**
 * @file `cp`: copies files and folders within ChRIS's filesystem (CFS),
 * reported as a command envelope.
 *
 * Declared in one record (`cpCommand`): the sources, then the destination,
 * each a path that may be a wildcard; a lone source, or `-t`, asks where.
 * Each path is acted on where the store keeps it (`storePath_resolve`): a
 * source through a link is what the link points at, and a destination
 * through a link lands in the link's target. What cp says names the paths
 * as the session resolves them.
 *
 * Key components:
 * - cpCommand: the declaration.
 * - builtin_cp: the declaration run over words already split.
 * - cp_run: the typed core behind both, and the typed API.
 *
 * Typical usage:
 * ```ts
 * await builtin_cp(['-r', 'data', 'backup/']);
 * await cp_run({ sources: ['a.txt'], dest: 'b.txt' });
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
import { cp_render, vfsRefusal_text, type VFSDispatcher, type VfsOutcome } from '@fnndsc/fond';
import { pathEntry_find, entry_isFolder } from './entries.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';

/** Outcome of one copy source, for the envelope model. */
export interface CpOutcome {
  source: string;
  copied: boolean;
}

/** Model payload for the fs.cp envelope. */
export interface CpModelData {
  dest: string;
  outcomes: CpOutcome[];
  copied: number;
  failed: number;
}

/** What a `cp` line may hold. */
const CP_GRAMMAR = {
  operands: [
    { name: 'paths', kind: 'cfsPath', repeat: true, glob: true, summary: 'The sources, then the destination; a lone source asks where it goes' },
  ],
  options: {
    recursive: { short: 'r', long: 'recursive', summary: 'Recursive copy (for directories)' },
    askTarget: { short: 't', summary: 'Every operand is a source; asks for the target directory, and the answer must be one' },
    targetDirectory: { long: 'target-directory', summary: 'Every operand is a source; copy into this directory', value: { name: 'dir', kind: 'cfsPath' } },
  },
} as const satisfies CommandGrammar;

/**
 * Runs a parsed `cp` line: into a target directory given or asked for, to a
 * destination asked for a lone source, or to the last operand.
 *
 * @param args - The typed line.
 * @returns The copy's envelope, or the refusal of an abandoned question.
 */
async function cp_handle(args: CommandArguments<typeof CP_GRAMMAR>): Promise<CommandEnvelope> {
  const paths: string[] = args.operands.paths;
  const recursive: boolean = args.options.recursive;
  // `--target-directory <dir>` names the TARGET DIRECTORY, so every operand
  // is a source: the shell's own answer to "several things, one destination".
  const target: string | undefined = args.options.targetDirectory;
  if (target !== undefined) return cp_run({ sources: paths, dest: target, recursive });
  // `-t` alone is that line with the directory not said: a question
  // (an-absent-value-is-a-question), and the answer wants a directory:
  // `cp a b` without it means copy a ONTO b, the right reading of that line
  // and the wrong thing for a set. One operand names what to copy and not
  // where: a question too, not a usage error. See `destination_ask`.
  if (args.options.askTarget || paths.length === 1) {
    // The sources are fixed before the question: other commands run while it is open.
    const sources: string[] = await operands_fix(paths);
    const chosen: string = await destination_ask({
      verb: 'cp', commit: 'COPY HERE', sources, ...(args.options.askTarget ? { wantsDirectory: true } : {}),
    });
    if (chosen === '') {
      exitCode_set(1);
      return envelope_error('', undefined, `${chalk.red(destination_missing('cp'))}\n`);
    }
    return cp_run({ sources, dest: chosen, recursive });
  }
  // The last operand is the destination, all others are sources.
  return cp_run({ sources: paths.slice(0, -1), dest: paths[paths.length - 1] ?? '', recursive });
}

/**
 * `cp [-rt] [--target-directory <dir>] <paths…>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [cpCommand] });
 * ```
 */
export const cpCommand = command_declare({
  name: 'cp',
  grammar: CP_GRAMMAR,
  help: {
    summary: 'Copy files or directories (supports wildcards and multiple sources)',
    description: "Copies files or folders within ChRIS's filesystem: the last operand is the destination, and several sources want a folder there. Given only a source, the destination is asked for. A path through a link is the link's target: a copy into a linked folder lands in the folder it points at. PACS sources: a /net/pacs/queries/... source names query results, not stored files, and cp materializes the series: if its DICOMs are not yet in CUBE it fires a PACS retrieve and waits for them to land (the same engine as pull), then copies the landed files to the destination. A series already fully in CUBE is copied without a retrieve.",
    category: 'Files',
    posix: { group: 'Files', differs: 'copies within CFS; -r for folders' },
    examples: [
      'cp file.txt copy.txt              # Copy single file',
      'cp -r dir1/ dir2/                 # Copy directory recursively',
      'cp file1 file2 file3 dest/        # Copy multiple files',
      'cp uploads/*.txt backup/          # Copy with wildcard',
      'cp --target-directory backup/ a b # Copy several into one folder',
      'cp -t a.txt b.txt                 # Ask which folder they go to',
      'cp "file with spaces.txt" dest/   # Use quotes for spaces',
      'cp -r /net/pacs/queries/AccessionNumber:123_qid:7/Study_1.2.3_Head/Series_1.2.3.4_AX_T2 results/',
      '                                  # Retrieve-if-needed, then copy the series',
    ],
  },
  handler: cp_handle,
});

/**
 * `cp` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `cp`.
 * @returns An envelope whose rendered text reports progress and results and
 *   whose model carries per-source outcomes, or the refusal of a bad line.
 */
export async function builtin_cp(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(cpCommand, args);
}

/** Typed invocation options for cp. */
export interface CpOptions {
  /** Source paths, absolute or relative to the session cwd. */
  sources: string[];
  /** Destination path (a directory when several sources are given). */
  dest: string;
  /** Copy directories recursively. */
  recursive?: boolean;
}

/**
 * Forgets the cached listings a write to a destination changes: beneath it
 * (a recursive copy replaces them) and of its parent, by each name it has.
 *
 * @param listCache - The session's listing cache.
 * @param names - The destination as the session names it and as the store keeps it.
 */
function destination_invalidate(listCache: ListingCache, names: readonly string[]): void {
  for (const name of new Set(names)) {
    listCache.cache_invalidateTree?.(name);
    listCache.cache_invalidate?.(path.posix.dirname(name));
  }
}

/**
 * Copies files or directories: the shared typed core behind the parsed
 * builtin and the typed API.
 *
 * @param options - Sources, destination, and the recursive flag.
 * @returns An envelope whose rendered text reports results and whose
 *   `fs.cp` model carries per-source outcomes.
 */
export async function cp_run(options: CpOptions): Promise<CommandEnvelope> {
  const sources: string[] = options.sources;
  const dest: string = options.dest;

  if (sources.length === 0 || dest === '') {
    return envelope_error(`${chalk.red('Usage: cp [-r] <source...> <dest>')}\n`);
  }

  const recursive: boolean = options.recursive ?? false;

  const destPath: string = await path_resolve(dest);
  // Written where the store keeps it: into a linked folder lands in the link's target.
  const destStore: string = await storePath_resolve(destPath);
  const listCache: ListingCache = listingCache_get();
  let successCount: number = 0;
  let failCount: number = 0;
  let rendered: string = '';
  let renderedErr: string = '';
  const outcomes: CpOutcome[] = [];

  for (const src of sources) {
    try {
      const srcPath: string = await path_resolve(src);

      // For multiple sources, show which file we're copying
      if (sources.length > 1) {
        rendered += `${chalk.gray(`Copying ${srcPath}...`)}\n`;
      } else {
        rendered += `Copying ${srcPath} to ${destPath}...\n`;
      }

      // Into a folder the destination names, the copy keeps its name.
      const dispatcher: VFSDispatcher = vfsDispatcher_get();
      const finalDest: string = entry_isFolder(await pathEntry_find(dispatcher, destStore)) && !dispatcher.path_isVirtual(destStore)
        ? path.posix.join(destStore, path.posix.basename(srcPath))
        : destStore;
      // Copied from where the store keeps it (a /proc data path, a link); named as it was asked.
      const copied: VfsOutcome = await dispatcher.cp(await storePath_resolve(srcPath), finalDest, { recursive });
      const success: boolean = copied.ok;

      if (sources.length === 1) {
        rendered += `${cp_render(srcPath, destPath, success)}\n`;
      }

      if (!copied.ok) {
        // The mount said WHY; a bare "Failed to copy" makes an operator
        // guess at a reason that was already known. One `cp:`, as mv says its own.
        const said: string = copied.reason ?? vfsRefusal_text('cp', copied, srcPath, destPath);
        renderedErr += `${chalk.red(said.startsWith('cp:') ? said : `cp: ${said}`)}\n`;
      }
      outcomes.push({ source: srcPath, copied: success });
      if (success) {
        successCount++;
      } else {
        failCount++;
      }
    } catch (e: unknown) {
      const msg: string = e instanceof Error ? e.message : String(e);
      renderedErr += `${chalk.red(`cp: ${src}: ${msg}`)}\n`;
      outcomes.push({ source: src, copied: false });
      failCount++;
    }
  }

  destination_invalidate(listCache, [destPath, destStore]);

  // Summary for multiple files
  if (sources.length > 1) {
    if (failCount === 0) {
      rendered += `${chalk.green(`✓ Copied ${successCount} file(s) to ${destPath}`)}\n`;
    } else {
      rendered += `${chalk.yellow(`⚠ Copied ${successCount} file(s), ${failCount} failed`)}\n`;
    }
  }

  const modelData: CpModelData = { dest: destPath, outcomes, copied: successCount, failed: failCount };
  if (failCount > 0) {
    const envelope: CommandEnvelope = envelope_error(rendered, undefined, renderedErr || undefined);
    envelope.model = { kind: 'fs.cp', data: modelData };
    return envelope;
  }
  return envelope_ok(rendered, { kind: 'fs.cp', data: modelData });
}
