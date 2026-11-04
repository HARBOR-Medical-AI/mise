/**
 * @file Builtin download command.
 * Downloads files from ChRIS to the local filesystem with progress.
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
import { shellArguments_pathnameExpanded } from '../../lib/parser.js';
import { path_resolve } from '../utils.js';
import { vfsDispatcher_get } from '../../core/filesystem.js';
import { surface_get, type Surface } from '../../core/surface.js';
import { repl_confirm } from '../../core/question.js';
import { files_path_isDirectory, files_listRecursive, type FsItem } from '@fnndsc/salsa';
import { directory_archive, type ArchiveResult } from './archive.js';
import { type FileDeliverResult, type CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { errorStack } from '@fnndsc/fond';
import { exitCode_set } from '../../core/handlerRun.js';

/** A `/proc/jobs` path at or under a job's `data` link: the link, and what follows it. */
const PROC_DATA_PATH: RegExp = /^(\/proc\/jobs\/feed_\d+(?:\/[^/]+_\d+)+\/data)(\/.*)?$/;

/**
 * A source as the transfer reads it: a CFS path. A `/proc/jobs/.../data`
 * path, which `ls` and `cd` enter as the run's output, resolves through the
 * same link to that output (#1364); anything else is the path as resolved.
 *
 * @param source - The source as typed.
 * @returns The CFS path.
 */
async function source_resolve(source: string): Promise<string> {
  const resolved: string = await path_resolve(source);
  const link: RegExpMatchArray | null = resolved.match(PROC_DATA_PATH);
  if (link === null) return resolved;
  const target = await vfsDispatcher_get().linkTarget_resolve(link[1] as string);
  if (!target.ok) return resolved;
  return `${target.value}${link[2] ?? ''}`;
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

/**
 * Downloads a remote ChRIS file or directory to the local filesystem, or hands
 * it to the surface when the engine's disk is not the operator's.
 *
 * @param args - [remotePathOrGlob, localPath] plus optional -f/--force to overwrite.
 * @returns An envelope carrying the download summary.
 */
export async function builtin_download(args: string[]): Promise<CommandEnvelope> {
  const force: boolean = args.includes('-f') || args.includes('--force');
  const positionalIndexes: number[] = args.reduce((indexes: number[], arg: string, index: number): number[] => {
    if (arg !== '-f' && arg !== '--force') indexes.push(index);
    return indexes;
  }, []);
  const cleanArgs: string[] = positionalIndexes.map((index: number): string => args[index]);

  if (cleanArgs.length < 2) {
    return envelope_ok(`${chalk.red('Usage: download <remote_path_or_glob> <local_path> [-f|--force]')}\n`);
  }

  const localPathArg: string = cleanArgs[cleanArgs.length - 1];
  const sourceArgs: string[] = cleanArgs.slice(0, -1);
  const sourceWasExpanded: boolean = positionalIndexes
    .slice(0, -1)
    .some((index: number): boolean => shellArguments_pathnameExpanded(args, index));

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

  try {
    const progress: DownloadOptions = {
      force,
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
    return envelope_ok(rendered);
  } catch (e: unknown) {
    const msg: string = e instanceof Error ? e.message : String(e);
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`Download error: ${msg}`)}\n`);
  }
}
