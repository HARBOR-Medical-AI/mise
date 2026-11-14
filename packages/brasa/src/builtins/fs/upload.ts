/**
 * @file `upload`: files, folders or the matches of a wildcard on this
 * machine's disk, into ChRIS, with progress.
 *
 * The destination is where the store keeps it (`storePath_resolve`): an
 * upload into a link lands in the folder the link points at.
 *
 * Declared in one record (`uploadCommand`): a host path operand, then one
 * CFS path. The host path is never globbed by the line: chili matches a
 * wildcard in it against the engine's disk.
 *
 * Key components:
 * - uploadCommand: the declaration.
 * - builtin_upload: the declaration run over words already split.
 *
 * Typical usage:
 * ```ts
 * await builtin_upload(['~/data/file.csv', '/home/user/uploads/']);
 * ```
 *
 * Dependencies: chili's transfer, cumin's listing cache, the session's surface.
 *
 * @module
 */
import chalk from 'chalk';
import { path_resolve, storePath_resolve } from '../utils.js';
import { files_uploadWithProgress as chefs_upload_cmd, UploadSummary, bytes_format } from '@fnndsc/chili/commands/fs/upload.js';
import { listCache_get } from '@fnndsc/cumin';
import { sink_get } from '../../core/sink.js';
import { surface_get } from '../../core/surface.js';
import { repl_confirm } from '../../core/question.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { errorStack, type StackMessage } from '@fnndsc/fond';
import { type CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';

/** The characters that make a host path a pattern chili matches against the disk. */
const HOST_WILDCARD: RegExp = /[*?[]/;

/**
 * Asks the issuing surface to confirm replacement of an existing CFS target.
 *
 * @param message - Confirmation question prepared by the transfer command.
 * @returns Nothing when the surface accepts the operation.
 * @throws {Error} When the surface declines the operation.
 */
async function uploadConfirmation_request(message: string): Promise<void> {
  // A yes/no says so on the wire, so a graphical surface offers two
  // capsules rather than expecting an operator to know the word is `y`.
  if (!await repl_confirm(message)) {
    throw new Error('Operation cancelled by user.');
  }
}

/** What an `upload` line may hold: one place on this machine, then one ChRIS path. */
const UPLOAD_GRAMMAR = {
  operands: [
    { name: 'source', kind: 'hostPath', summary: "What to upload from this machine's disk: a file, a folder, or a wildcard chili matches there" },
    { name: 'destination', kind: 'cfsPath', summary: 'The ChRIS folder it goes into' },
  ],
} as const satisfies CommandGrammar;

/**
 * `upload <source> <destination>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [uploadCommand] }, 'backend');
 * ```
 */
export const uploadCommand = command_declare({
  name: 'upload',
  grammar: UPLOAD_GRAMMAR,
  help: {
    summary: 'Upload local files, directories, or glob matches to ChRIS',
    description: 'Upload local files, directories, or glob matches to ChRIS with progress tracking. A progress bar shows the file count and percentage complete, the estimated time remaining (ETA) and the data transferred; summary statistics follow the upload.',
    category: 'Files',
    examples: [
      'upload ~/data/file.csv /home/user/uploads/',
      'upload ~/Pictures/earthandmoon* .',
      'upload ./results/ ~/data/',
      'upload ~/experiment/data /home/user/projects/',
    ],
  },
  handler: async (args: CommandArguments<typeof UPLOAD_GRAMMAR>): Promise<CommandEnvelope> =>
    upload_run(args.operands.source, args.operands.destination),
});

/**
 * `upload` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `upload`.
 * @returns The upload summary, or the refusal of a bad line.
 */
export async function builtin_upload(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(uploadCommand, args);
}

/**
 * Uploads a local file or directory to ChRIS.
 *
 * @param localPath - The host path, as typed: a wildcard in it is matched on the engine's disk.
 * @param remotePath - The ChRIS destination, as typed.
 * @returns An envelope carrying the upload summary.
 */
async function upload_run(localPath: string, remotePath: string): Promise<CommandEnvelope> {
  // The local path is read by the ENGINE: under a daemon that is the daemon
  // host's disk, which belongs to nobody attending the session unless the
  // operator declared it theirs (--host-control=files). Without that, refuse
  // — as download already refuses to write there.
  if (!surface_get().capabilities.engineFilesystem) {
    exitCode_set(1);
    return envelope_error('', undefined,
      `${chalk.red("upload: calypso's host disk is nobody's; start calypso with --host-control=files, or upload from a surface that can supply the bytes.")}\n`);
  }
  // chili reads an exact path first and matches a pattern only when nothing
  // stands at it.
  const localGlob: boolean = HOST_WILDCARD.test(localPath);

  // Where the store keeps the destination: a link's target, not the link.
  const targetRemote: string = await storePath_resolve(remotePath);

  try {
    const summary: UploadSummary = await chefs_upload_cmd(localPath, targetRemote, {
      expandLocalGlob: localGlob,
      confirm: uploadConfirmation_request,
      onNotice: (message: string, channel: 'status' | 'err'): void => {
        const sink = sink_get();
        if (channel === 'status') sink.status_write(`${message}\n`);
        else sink.err_write(`${message}\n`);
      },
      onProgress: event => sink_get().progress_write(event),
    });

    let rendered: string = '\n';
    if (summary.failedCount === 0) {
      rendered += `${chalk.green(`✓ Successfully uploaded ${summary.transferredCount} file(s)`)}\n`;
    } else {
      rendered += `${chalk.yellow(`⚠ Uploaded ${summary.transferredCount} file(s), ${summary.failedCount} failed`)}\n`;
    }
    rendered += `${chalk.gray(`  Total: ${bytes_format(summary.transferSize)} in ${summary.duration.toFixed(1)}s (${bytes_format(summary.speed)}/s)`)}\n`;

    // A file that landed under another name because its own was taken must
    // say so: the store has no overwrite, and an upload reported as plain
    // success leaves the operator believing they replaced something.
    for (;;) {
      const note: StackMessage | undefined = errorStack.stack_pop();
      if (note === undefined) break;
      rendered += `${chalk.yellow(`  ${note.message}`)}\n`;
    }

    // Invalidate cache for actual target directory where files were uploaded,
    // including nested listings: a directory re-upload replaces a whole tree,
    // and still-fresh entries below the target would serve the old contents.
    if (summary.transferredCount > 0) {
      const listCache = listCache_get();
      listCache.cache_invalidateTree(summary.actualTargetPath);
      // The destination's own listing, by both its names: where the store
      // keeps it, and the path it was reached by.
      listCache.cache_invalidate(targetRemote);
      listCache.cache_invalidate(await path_resolve(remotePath));
    }
    if (summary.failedCount > 0) {
      exitCode_set(1);
      return envelope_error(rendered, undefined, '');
    }
    return envelope_ok(rendered);
  } catch (e: unknown) {
    const msg: string = e instanceof Error ? e.message : String(e);
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`Upload error: ${msg}`)}\n`);
  }
}
