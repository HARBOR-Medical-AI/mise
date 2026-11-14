/**
 * @file `du`: how much of ChRIS's filesystem (CFS) each folder takes, as
 * Linux du says it.
 *
 * Declared in one record (`duCommand`): paths that glob, and du's options;
 * one it does not have is refused by name.
 *
 * Key components:
 * - duCommand: the declaration.
 * - builtin_du: the declaration run over words already split.
 * - dirSizes_compute: each folder's size from a scan.
 *
 * Typical usage:
 * ```ts
 * await builtin_du(['-sh', '~/uploads']);
 * ```
 *
 * Dependencies: chili's scan for the walk; the listing for what a path is.
 *
 * @module
 */
import chalk from 'chalk';
import path from 'path';
import { path_resolve } from '../utils.js';
import { vfs } from '../../lib/vfs/vfs.js';
import { spinner } from '../../lib/spinner.js';
import { commandCancellation_enable, commandCancellation_signalGet } from '../../core/cancellation.js';
import { scan_do, type CLIscan, type ScanRecord } from '@fnndsc/chili/path/pathCommand.js';
import { bytes_format } from '@fnndsc/chili/commands/fs/upload.js';
import { type ListingItem, type CommandEnvelope } from '@fnndsc/menu';
import type { Result } from '@fnndsc/fond';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/**
 * Parsed flags controlling `du` output.
 */
export interface DuOptions {
  humanReadable: boolean;
  summarize: boolean;
  showAll: boolean;
  showTotal: boolean;
  separateDirs: boolean;
  maxDepth: number | undefined;
}

/** What a `du` line may hold. */
const DU_GRAMMAR = {
  operands: [
    { name: 'path', kind: 'cfsPath', optional: true, repeat: true, glob: true, summary: 'What to measure; the working directory when none is given' },
  ],
  options: {
    humanReadable: { short: 'h', long: 'human-readable', summary: 'Print sizes in human readable format' },
    summarize: { short: 's', long: 'summarize', summary: 'Display only total for each argument' },
    all: { short: 'a', long: 'all', summary: 'Show counts for all files, not just directories' },
    total: { short: 'c', long: 'total', summary: 'Produce a grand total' },
    separateDirs: { short: 'S', long: 'separate-dirs', summary: 'Do not include size of subdirectories' },
    maxDepth: { short: 'd', long: 'max-depth', summary: 'Print total only if N or fewer levels below', value: { name: 'N', kind: 'int', min: 0 } },
  },
} as const satisfies CommandGrammar;

/**
 * `du [-hsacS] [-d <N>] [path…]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [duCommand] }, 'backend');
 * ```
 */
export const duCommand = command_declare({
  name: 'du',
  grammar: DU_GRAMMAR,
  help: {
    summary: 'Display disk usage statistics (mimics Linux du)',
    description: "Says how much of ChRIS's filesystem each folder under a path takes, its subfolders included, as Linux du does: the working directory when no path is given, each path given otherwise (a wildcard matches paths). A file is its own size.",
    category: 'Navigation',
    posix: { group: 'Files', differs: 'sizes in CFS' },
    examples: [
      'du                    # Disk usage of current directory',
      'du -h                 # Human-readable sizes (1K, 234M, 2G)',
      'du -s /home/user/data # Summary only for specified path',
      'du -a                 # Show all files, not just directories',
      'du -c                 # Show grand total at end',
      'du -d 2               # Max depth of 2 levels',
      'du -sh                # Human-readable summary',
    ],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof DU_GRAMMAR>): Promise<CommandEnvelope> => du_run(args.operands.path, {
    humanReadable: args.options.humanReadable,
    summarize: args.options.summarize,
    showAll: args.options.all,
    showTotal: args.options.total,
    separateDirs: args.options.separateDirs,
    maxDepth: args.options.maxDepth,
  }),
});

/**
 * `du` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `du`.
 * @returns The sizes, or the refusal of a bad line.
 */
export async function builtin_du(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(duCommand, args);
}

/**
 * Stat summary for a single `du` target.
 */
interface TargetStat {
  isDirectory: boolean;
  fileSize: number;
}

/**
 * Formats a byte count for `du` output: human-readable string or KB integer,
 * right-padded to 12 characters for column alignment.
 *
 * @param bytes - Raw byte count.
 * @param humanReadable - If true, format as human-readable (e.g. `1.2M`).
 * @returns Right-aligned size string.
 */
export function duSize_format(bytes: number, humanReadable: boolean): string {
  const formatted: string = humanReadable
    ? bytes_format(bytes)
    : Math.ceil(bytes / 1024).toString();
  return formatted.padStart(12, ' ');
}

/**
 * Resolves whether a target path is a directory or a file (with size).
 *
 * @param targetPath - The resolved ChRIS path to stat.
 * @returns A TargetStat on success, or an error message string on failure.
 */
async function targetStat_resolve(targetPath: string): Promise<TargetStat | string> {
  try {
    const result: Result<ListingItem[]> = await vfs.data_get(targetPath, { directory: true });
    if (result.ok && result.value.length > 0) {
      const item: ListingItem = result.value[0];
      if (item.type === 'dir' || item.type === 'vfs') {
        return { isDirectory: true, fileSize: 0 };
      }
      return { isDirectory: false, fileSize: item.size || 0 };
    }
    return `du: cannot access '${targetPath}': No such file or directory`;
  } catch (e: unknown) {
    return `du: cannot access '${targetPath}': ${e}`;
  }
}

/**
 * Accumulates per-directory sizes from a scan result, attributing each file's
 * size to its ancestor directories up to (and including) the target path.
 *
 * @param scanResult - The recursive scan result.
 * @param targetPath - The directory being measured.
 * @param opts - The du options (separateDirs / showAll affect attribution).
 * @returns A map of directory path to accumulated size.
 */
export function dirSizes_compute(
  scanResult: ScanRecord,
  targetPath: string,
  opts: DuOptions
): Map<string, number> {
  const dirSizes: Map<string, number> = new Map<string, number>();

  scanResult.fileInfo.forEach((fileInfo) => {
    const filePath: string = fileInfo.chrisPath;
    const fSize: number = fileInfo.size;

    if (fileInfo.isDirectory) {
      if (!dirSizes.has(filePath)) {
        dirSizes.set(filePath, 0);
      }
      return;
    }

    // File: add to its parent directory and all ancestor directories,
    // but only up to the targetPath currently being scanned.
    let currentPath: string = path.posix.dirname(filePath);
    while (currentPath && currentPath.startsWith(targetPath)) {
      const currentSize: number = dirSizes.get(currentPath) || 0;
      dirSizes.set(currentPath, currentSize + fSize);

      if (currentPath === targetPath) break;
      if (opts.separateDirs) break;
      currentPath = path.posix.dirname(currentPath);
    }

    if (opts.showAll) {
      dirSizes.set(filePath, fSize);
    }
  });

  // Ensure the target directory itself exists in the map with total size.
  if (!dirSizes.has(targetPath)) {
    dirSizes.set(targetPath, scanResult.totalSize);
  }

  return dirSizes;
}

/**
 * Renders accumulated directory sizes to stdout, honouring summary and
 * max-depth options.
 *
 * @param dirSizes - Map of directory path to size.
 * @param targetPath - The directory being measured.
 * @param opts - The du options.
 */
function dirUsage_render(
  dirSizes: Map<string, number>,
  targetPath: string,
  opts: DuOptions
): string {
  if (opts.summarize) {
    const size: number = dirSizes.get(targetPath) || 0;
    return `${duSize_format(size, opts.humanReadable)}\t${targetPath}\n`;
  }

  const entries: Array<[string, number]> = Array.from(dirSizes.entries());
  entries.sort((a, b) => a[0].localeCompare(b[0]));

  let out: string = '';
  for (const [dirPath, dirSize] of entries) {
    if (opts.maxDepth !== undefined) {
      const rel: string = path.posix.relative(targetPath, dirPath);
      const depth: number = rel === '' ? 0 : rel.split('/').length;
      if (depth > opts.maxDepth) continue;
    }
    out += `${duSize_format(dirSize, opts.humanReadable)}\t${dirPath}\n`;
  }
  return out;
}

/**
 * Displays disk usage statistics for ChRIS filesystem directories.
 * Mimics standard Linux du command behavior and flags.
 * Uses chili's scan_do machinery for recursive filesystem traversal.
 *
 * @param pathArgs - The paths to measure; none measures the working directory.
 * @param opts - The du options.
 * @returns The sizes, and on the error channel each path that could not be read.
 */
async function du_run(pathArgs: readonly string[], opts: DuOptions): Promise<CommandEnvelope> {
  commandCancellation_enable();
  const signal: AbortSignal | undefined = commandCancellation_signalGet();

  const rawTargets: string[] = pathArgs.length > 0 ? [...pathArgs] : ['.'];

  const resolvedTargets: string[] = [];
  for (const raw of rawTargets) {
    resolvedTargets.push(await path_resolve(raw));
  }

  let grandTotal: number = 0;
  let rendered: string = '';
  let errOut: string = '';

  try {
    for (const targetPath of resolvedTargets) {
      if (signal?.aborted) {
        return { status: 'error', rendered: '', renderedErr: 'du: cancelled\n' };
      }
      const argLabel: string = path.basename(targetPath);
      spinner.start(`Scanning ${argLabel}...`);

      const stat: TargetStat | string = await targetStat_resolve(targetPath);
      if (typeof stat === 'string') {
        spinner.stop();
        errOut += `${chalk.red(stat)}\n`;
        continue;
      }

      if (!stat.isDirectory) {
        grandTotal += stat.fileSize;
        spinner.stop();
        rendered += `${duSize_format(stat.fileSize, opts.humanReadable)}\t${targetPath}\n`;
        continue;
      }

      // Scanned where it stands: the shared directory stays put.
      const scanOptions: CLIscan = {
        silent: true,
        tree: false,
        follow: false,
        dirsOnly: false,
        signal,
        folder: targetPath,
      };
      const scanResult: ScanRecord | null = await scan_do(scanOptions);

      if (signal?.aborted) {
        return { status: 'error', rendered: '', renderedErr: 'du: cancelled\n' };
      }

      if (!scanResult) {
        spinner.stop();
        continue;
      }

      const dirSizes: Map<string, number> = dirSizes_compute(scanResult, targetPath, opts);
      grandTotal += scanResult.totalSize;
      spinner.stop();

      rendered += dirUsage_render(dirSizes, targetPath, opts);
    }

    if (opts.showTotal && rawTargets.length > 0) {
      rendered += `${duSize_format(grandTotal, opts.humanReadable)}\ttotal\n`;
    }
    const envelope: CommandEnvelope = { status: 'ok', rendered };
    if (errOut.length > 0) {
      envelope.renderedErr = errOut;
    }
    return envelope;
  } finally {
    spinner.stop();
  }
}
