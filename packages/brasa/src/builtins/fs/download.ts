/**
 * @file `download`: ChRIS files and folders to the local filesystem, with
 * progress; under a daemon, handed to the surface instead.
 *
 * Declared in one record (`downloadCommand`): a CFS path operand that globs
 * and a host path operand on one line, never globbed.
 *
 * Key components:
 * - downloadCommand: the declaration.
 * - builtin_download: the declaration run over words already split.
 *
 * Typical usage:
 * ```ts
 * await builtin_download(['/home/chris/uploads/a.nii', './data/']);
 * ```
 *
 * Dependencies: chili's transfer, salsa's file listing, the session's surface.
 *
 * @module
 */
import path from 'path';

import chalk from 'chalk';

import {
  files_downloadWithProgress as chefs_download_cmd,
  files_downloadManyWithProgress as chefs_downloadMany_cmd,
  type DownloadOptions,
  type DownloadProgressEvent,
  type DownloadSummary,
  bytes_format
} from '@fnndsc/chili/commands/fs/download.js';
import { sink_get } from '../../core/sink.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { storePath_resolve } from '../utils.js';
import { surface_get, type Surface } from '../../core/surface.js';
import { repl_confirm } from '../../core/question.js';
import { files_path_isDirectory, files_listRecursive, type FsItem } from '@fnndsc/salsa';
import { directory_archive, type ArchiveResult } from './archive.js';
import { type FileDeliverResult, type CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { errorStack } from '@fnndsc/fond';
import { exitCode_set } from '../../core/handlerRun.js';
import { commandCancellation_enable, commandCancellation_signalGet } from '../../core/cancellation.js';
import { TRANSFER_JOBS_OPTION, transferJobs_resolve, transferLeftovers_render, type TransferJobs } from './transferJobs.js';

/**
 * A source as the transfer reads it: where the store keeps it, resolved as
 * every reader resolves a path (a `/proc/jobs/.../data` path through the
 * job's link to its output, #1364; the store's links at any depth).
 *
 * @param source - The source as typed.
 * @returns The store path.
 */
async function source_resolve(source: string): Promise<string> {
  return storePath_resolve(source);
}

/**
 * Asks the issuing surface to confirm a local download overwrite or merge.
 *
 * @param message - Confirmation question prepared by the transfer command.
 * @returns Nothing when the surface accepts the operation.
 * @throws {Error} When the surface declines the operation.
 */
async function downloadConfirmation_request(message: string): Promise<void> {
  // A yes/no says so on the wire, so a graphical surface can offer two
  // capsules rather than make an operator know that `y` is the word. A
  // terminal reads the same line it always did.
  if (!await repl_confirm(message)) {
    throw new Error('Operation cancelled by user.');
  }
}

/**
 * Hands each requested file to the surface, for a session whose engine runs
 * somewhere its operator is not.
 *
 * Only the request travels: the surface fetches the bytes itself, through
 * whichever route suits it. Multiple sources become multiple deliveries, since
 * a surface with no filesystem — a browser — has no directory to fill.
 *
 * @param surface - The surface running this command.
 * @param sourceArgs - The requested source paths, before resolution.
 * @param destination - Where the operator asked for it. A surface with a
 *   filesystem treats an existing directory as a place to fill and anything
 *   else as the filename; a surface without one ignores it.
 * @returns An envelope summarising where the files landed.
 */
async function surfaceDownload_run(
  surface: Surface,
  sourceArgs: string[],
  destination: string,
): Promise<CommandEnvelope> {
  if (!surface.capabilities.fileDelivery) {
    exitCode_set(1);
    return envelope_error('', undefined,
      `${chalk.red('download: this surface cannot receive a file, and the engine will not write to its own host.')}\n`);
  }

  const sources: string[] = await Promise.all(sourceArgs.map(source_resolve));

  // A directory has no bytes to hand over, and what to do about that depends on
  // what the surface has. A shell — remote or not — owns a filesystem, so it
  // receives the tree file by file and gets the folder it asked for. A browser
  // owns no directory and can only take files one at a time, so several hundred
  // DICOM instances would be several hundred saves; for that surface alone the
  // directory is archived into one CUBE file first. See issue #233 for why an
  // archive is a workaround rather than a feature.
  const targets: { path: string; filename: string; size?: number }[] = [];
  for (const source of sources) {
    if (!(await files_path_isDirectory(source))) {
      targets.push({ path: source, filename: source.split('/').filter(Boolean).pop() ?? 'download' });
      continue;
    }

    if (surface.capabilities.localFilesystem) {
      const items: FsItem[] = await files_listRecursive(source);
      for (const item of items) {
        if (item.type === 'dir') continue;
        targets.push({
          path: item.path,
          // Keep the tree: a surface with directories reproduces the shape
          // under the destination rather than flattening it.
          filename: item.path.startsWith(source)
            ? item.path.slice(source.length).replace(/^\/+/, '')
            : (item.path.split('/').filter(Boolean).pop() ?? 'download'),
          ...(typeof item.size === 'number' ? { size: item.size } : {}),
        });
      }
      continue;
    }

    const archived: ArchiveResult | null = await directory_archive(source);
    if (!archived) {
      exitCode_set(1);
      const reasons: string = errorStack.stack_getAll?.()
        .map((entry: unknown): string =>
          typeof entry === 'string' ? entry : ((entry as { message?: string }).message ?? String(entry)))
        .join('\n  ') ?? '';
      return envelope_error('', undefined,
        `${chalk.red(`download: could not archive ${source}.`)}\n${reasons ? `  ${chalk.red(reasons)}\n` : ''}`);
    }
    targets.push(archived);
  }

  const delivered: string[] = [];
  const failed: string[] = [];

  for (const target of targets) {
    const filename: string = target.filename;
    try {
      const result: FileDeliverResult = await surface.fileDeliver({
        path: target.path,
        filename,
        destination,
        ...(target.size !== undefined ? { size: target.size } : {}),
      });
      delivered.push(`${chalk.gray(`  ${filename} → ${result.location}`)} ${chalk.gray(`(${bytes_format(result.bytes)})`)}`);
    } catch (error: unknown) {
      const reason: string = error instanceof Error ? error.message : String(error);
      failed.push(`${chalk.red(`  ${filename}: ${reason}`)}`);
    }
  }

  let rendered: string = '\n';
  if (failed.length === 0) {
    rendered += `${chalk.green(`✓ Delivered ${delivered.length} file(s)`)}\n`;
  } else {
    rendered += `${chalk.yellow(`⚠ Delivered ${delivered.length} file(s), ${failed.length} failed`)}\n`;
    exitCode_set(1);
  }
  rendered += [...delivered, ...failed].join('\n');
  if (delivered.length > 0 || failed.length > 0) rendered += '\n';
  return failed.length === 0 ? envelope_ok(rendered) : envelope_error(rendered, undefined, '');
}

/** What a `download` line may hold: ChRIS paths (a wildcard matches them), then one place on this machine. */
const DOWNLOAD_GRAMMAR = {
  operands: [
    { name: 'source', kind: 'cfsPath', repeat: true, glob: true, summary: 'What to download: a ChRIS file or folder; a wildcard matches paths' },
    { name: 'destination', kind: 'hostPath', summary: "Where it goes on this machine's disk; several sources go into one folder" },
  ],
  options: {
    force: { short: 'f', long: 'force', summary: 'Overwrite local paths that exist' },
    jobs: TRANSFER_JOBS_OPTION,
  },
} as const satisfies CommandGrammar;

/**
 * `download [-f] [-j N] <source…> <destination>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [downloadCommand] }, 'backend');
 * ```
 */
export const downloadCommand = command_declare({
  name: 'download',
  grammar: DOWNLOAD_GRAMMAR,
  help: {
    summary: 'Download ChRIS files or folders to this machine',
    description: 'Download a ChRIS file, folder, or the paths a wildcard matches to the local filesystem with progress tracking: files, ETA, bytes transferred. Several sources, typed or matched, go together into one folder. The files of a folder move 8 at a time (-j N, or the session variable TRANSFER_JOBS, says how many, 1 to 32); a file that fails is tried once more, the rest continue, and the summary names each that failed. Under a daemon the files are handed to the surface, which puts them on its own disk or in a browser\'s downloads.',
    category: 'Files',
    examples: [
      'download /home/user/data ./data',
      'download /home/user/results/*.nii ./results/',
      'download /feeds/feed_123 ./downloads -f',
      'download -j 16 /home/user/uploads/study ./study',
      'TRANSFER_JOBS=1; download /home/user/uploads/study ./study  # one at a time',
    ],
  },
  handler: async (args: CommandArguments<typeof DOWNLOAD_GRAMMAR>): Promise<CommandEnvelope> =>
    download_run(args.operands.source, args.operands.destination, args.options.force, args.expanded.source, args.options.jobs),
});

/**
 * `download` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `download`.
 * @returns The download summary, or the refusal of a bad line.
 */
export async function builtin_download(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(downloadCommand, args);
}

/**
 * Downloads remote ChRIS files or folders to the local filesystem, or hands
 * them to the surface when the engine's disk is not the operator's.
 *
 * @param sourceArgs - The ChRIS paths, as typed or matched.
 * @param localPathArg - Where they go.
 * @param force - Overwrite local paths that exist.
 * @param sourceWasExpanded - The sources came from a wildcard, so even one goes into a folder.
 * @param jobsGiven - The line's `-j`; undefined when it gives none.
 * @returns An envelope carrying the download summary.
 */
async function download_run(
  sourceArgs: string[],
  localPathArg: string,
  force: boolean,
  sourceWasExpanded: boolean,
  jobsGiven: number | undefined,
): Promise<CommandEnvelope> {
  const jobs: TransferJobs = transferJobs_resolve(jobsGiven);
  if ('refused' in jobs) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`download: ${jobs.refused}`)}\n`);
  }

  // A path resolved here is a path on the *engine's* disk. That is the
  // operator's disk only when a local shell hosts the engine in its own
  // process; under a daemon it is a machine nobody attending the session is
  // sitting at. So when the surface does not share the engine's filesystem,
  // the file is handed to the surface, which puts it somewhere its operator
  // can actually reach — the client's disk for a remote shell, the download
  // manager for a browser.
  const surface: Surface = surface_get();
  if (!surface.capabilities.engineFilesystem) {
    return surfaceDownload_run(surface, sourceArgs, localPathArg);
  }

  const targetLocal: string = path.resolve(localPathArg);
  commandCancellation_enable();
  const signal: AbortSignal | undefined = commandCancellation_signalGet();

  try {
    const progress: DownloadOptions = {
      force,
      jobs: jobs.jobs,
      ...(signal !== undefined ? { signal } : {}),
      confirm: downloadConfirmation_request,
      onNotice: (message: string, channel: 'status' | 'err'): void => {
        const sink = sink_get();
        if (channel === 'status') sink.status_write(`${message}\n`);
        else sink.err_write(`${message}\n`);
      },
      onProgress: (event: DownloadProgressEvent): void => sink_get().progress_write(event),
    };
    let summary: DownloadSummary;
    if (!sourceWasExpanded && sourceArgs.length === 1) {
      const targetRemote: string = await source_resolve(sourceArgs[0]);
      summary = await chefs_download_cmd(targetRemote, targetLocal, progress);
    } else {
      // Several sources, typed or expanded, go together into one directory.
      const sources: string[] = await Promise.all(sourceArgs.map(source_resolve));
      summary = await chefs_downloadMany_cmd(sources, targetLocal, progress);
    }

    let rendered: string = '\n';
    if (summary.failedCount === 0) {
      rendered += `${chalk.green(`✓ Successfully downloaded ${summary.transferredCount} file(s)`)}\n`;
    } else {
      rendered += `${chalk.yellow(`⚠ Downloaded ${summary.transferredCount} file(s), ${summary.failedCount} failed`)}\n`;
    }
    rendered += `${chalk.gray(`  Total: ${bytes_format(summary.transferSize)} in ${summary.duration.toFixed(1)}s (${bytes_format(summary.speed)}/s)`)}\n`;
    rendered += transferLeftovers_render(summary.failedPaths, summary.cancelledCount, 'downloaded');
    if (summary.failedCount > 0 || summary.cancelledCount > 0) {
      exitCode_set(1);
      return envelope_error(rendered, undefined, '');
    }
    return envelope_ok(rendered);
  } catch (e: unknown) {
    const msg: string = e instanceof Error ? e.message : String(e);
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`Download error: ${msg}`)}\n`);
  }
}
