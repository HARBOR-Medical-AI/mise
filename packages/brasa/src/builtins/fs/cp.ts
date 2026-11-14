/**
 * @file Builtin cp command.
 * Copies files or directories, reported as a command envelope.
 */
import chalk from 'chalk';
import path from 'path';
import { ParsedArgs, commandArgs_process, optionsUnknown_refusal, path_resolve, storePath_resolve } from '../utils.js';
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

/**
 * Copies a file or directory.
 * Supports multiple sources when destination is a directory.
 *
 * @param args - [flags, src1, src2, ..., dest]
 * @returns An envelope whose rendered text reports progress and results and
 *   whose model carries per-source outcomes.
 */
export async function builtin_cp(args: string[]): Promise<CommandEnvelope> {
  const parsed: ParsedArgs = commandArgs_process(args, { booleanLongOptions: ['recursive'] });
  const refusal: string | null = optionsUnknown_refusal('cp', parsed, ['t', 'r', 'recursive']);
  if (refusal !== null) return envelope_error('', undefined, `${chalk.red(refusal)}\n`);
  const pathArgs: string[] = parsed._ as string[];

  // `-t <dir>` names the TARGET DIRECTORY, so every operand is a source —
  // the shell's own answer to "several things, one destination". Given no
  // value it is a question (an-absent-value-is-a-question), and the answer
  // wants a directory: `cp a b` without it means rename a ONTO b, which
  // is the right reading of that line and the wrong thing for a set.
  const target: unknown = parsed.t;
  if (target !== undefined && pathArgs.length > 0) {
    if (typeof target === 'string' && target !== '') {
      return cp_run({ sources: pathArgs, dest: target });
    }
    // The sources are fixed before the question: other commands run while it is open.
    const sources: string[] = await operands_fix(pathArgs);
    const chosen: string = await destination_ask({
      verb: 'cp', commit: 'COPY HERE', sources, wantsDirectory: true,
    });
    if (chosen === '') {
      exitCode_set(1);
      return envelope_error('', undefined, `${chalk.red(destination_missing('cp'))}\n`);
    }
    return cp_run({ sources, dest: chosen });
  }
  const recursive: boolean = !!parsed['r'] || !!parsed['recursive'];

  // One operand names what to copy and not where: a question, not a usage
  // error. See `destination_ask`.
  if (pathArgs.length === 1) {
    // The sources are fixed before the question: other commands run while it is open.
    const sources: string[] = await operands_fix(pathArgs);
    const chosen: string = await destination_ask({
      verb: 'cp', commit: 'COPY HERE', sources,
    });
    if (chosen === '') {
      exitCode_set(1);
      return envelope_error('', undefined, `${chalk.red(destination_missing('cp'))}\n`);
    }
    return cp_run({ sources, dest: chosen, recursive });
  }

  // Last arg is destination, all others are sources
  return cp_run({
    sources: pathArgs.slice(0, -1),
    dest: pathArgs.length > 0 ? pathArgs[pathArgs.length - 1] : '',
    recursive,
  });
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
      const finalDest: string = entry_isFolder(await pathEntry_find(dispatcher, destPath)) && !dispatcher.path_isVirtual(destPath)
        ? path.posix.join(destPath, path.posix.basename(srcPath))
        : destPath;
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

  // Invalidate the destination subtree (a recursive copy replaces whatever
  // listings were cached beneath it) and its parent.
  listCache.cache_invalidateTree?.(destPath);
  const destParent: string = path.posix.dirname(destPath);
  listCache.cache_invalidate?.(destParent);

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
