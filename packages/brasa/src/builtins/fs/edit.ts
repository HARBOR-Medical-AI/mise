/**
 * @file `edit`: a ChRIS file opened in the surface's local editor, and
 * saved back when it changed.
 *
 * The editor mechanics live in the surface, so this command knows nothing
 * of processes or terminals: it reads the file, hands the content to the
 * surface, and writes the result back. The file is read and written where
 * the store keeps it (`storePath_resolve`): a path through a link edits the
 * file the link points at.
 *
 * Declared in one record (`editCommand`): one CFS path.
 *
 * Key components:
 * - editCommand: the declaration.
 * - builtin_edit: the declaration run over words already split.
 * - EDIT_OPENED_LINE: what `edit` says when a pane took the file.
 *
 * Typical usage:
 * ```ts
 * await builtin_edit(['~/uploads/config.yaml']);
 * ```
 *
 * Dependencies: chili's read and replace for a store file; salsa's
 * dispatcher for a projected one; the session's surface for the editor.
 *
 * @module
 */
import { privateTemp_write, suffix_safe, vfsOutcome_convertToResult, type PrivateTemp } from '@fnndsc/fond';
import { extname, posix } from 'path';
import chalk from 'chalk';
import { path_resolve, storePath_resolve, error_stripDebugPrefix } from '../utils.js';
import { surface_get, capability_require, CapabilityError, type LocalEditResult } from '../../core/surface.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { files_cat } from '@fnndsc/chili/commands/fs/cat.js';
import { file_replaceContent, EditResult } from '@fnndsc/chili/commands/fs/edit.js';
import { listCache_get } from '@fnndsc/cumin';
import { path_isEditable, type CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { errorStack, Result, StackMessage } from '@fnndsc/fond';
import { exitCode_set } from '../../core/handlerRun.js';


/** What `edit` says when the surface opened an editor that stays open. */
export const EDIT_OPENED_LINE: string = '(opened in the editor)';

/** What an `edit` line may hold: one ChRIS file (a wildcard may name it, when it matches one). */
const EDIT_GRAMMAR = {
  operands: [
    { name: 'file', kind: 'cfsPath', glob: true, summary: 'The ChRIS file to edit' },
  ],
} as const satisfies CommandGrammar;

/**
 * `edit <file>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [editCommand] }, 'backend');
 * ```
 */
export const editCommand = command_declare({
  name: 'edit',
  grammar: EDIT_GRAMMAR,
  help: {
    summary: 'Edit a ChRIS file in $EDITOR',
    description: 'Edit a ChRIS file in $EDITOR: fetches it, opens it, and saves it back on write. Uses $EDITOR (or $VISUAL, or vi as fallback). Does nothing if the file is unchanged on exit. On save it deletes the original and re-uploads: the file path is preserved, its ID changes. On upload failure the edited content is preserved in /tmp.',
    category: 'Files',
    examples: [
      'edit /home/chris/uploads/config.yaml',
      'edit notes.txt',
      'EDITOR=nano edit report.json',
    ],
  },
  handler: async (args: CommandArguments<typeof EDIT_GRAMMAR>): Promise<CommandEnvelope> => edit_run(args.operands.file),
});

/**
 * `edit` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `edit`.
 * @returns The edit outcome, or the refusal of a bad line.
 */
export async function builtin_edit(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(editCommand, args);
}

/**
 * Opens a ChRIS file in the surface's local editor. On save, replaces the
 * original via delete + re-upload. No-ops if content is unchanged.
 *
 * @param named - The file as the operator typed it.
 * @returns An envelope carrying the edit outcome.
 */
async function edit_run(named: string): Promise<CommandEnvelope> {
  // Editing needs a surface that can open a local editor. A surface without
  // the capability (a headless or browser host) fails here with a clear
  // message instead of assuming a terminal exists.
  try {
    capability_require('localEdit', 'edit: this surface cannot open a local editor.');
  } catch (err: unknown) {
    const message: string = err instanceof CapabilityError ? err.message : String(err);
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(message)}\n`);
  }

  // Read and written where the store keeps it: a path through a link (a
  // run's output under /proc/jobs, a `.chrislink`) edits what it points at.
  const target: string = await storePath_resolve(named);
  const ext: string = extname(target).toLowerCase();

  if (!path_isEditable(target)) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`edit: ${named}: binary file (${ext}), cannot edit as text`)}\n`);
  }

  // A projection's file (a feed's note under /proc) is read and written
  // through the projection that owns it, never through CUBE's store.
  const { vfsDispatcher } = await import('@fnndsc/salsa');
  if (vfsDispatcher.path_isVirtual(target)) {
    return projectedFile_edit(named, target, ext, {
      read: async (at: string): Promise<Result<string>> => vfsOutcome_convertToResult(await vfsDispatcher.read(at), 'read', at),
      write: async (at: string, content: string): Promise<boolean> => vfsOutcome_convertToResult(await vfsDispatcher.write(at, content), 'write', at).ok,
    });
  }

  const catResult: Result<string> = await files_cat(target);
  if (!catResult.ok) {
    const err: StackMessage | undefined = errorStack.stack_pop();
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`edit: ${err ? error_stripDebugPrefix(err.message) : 'Failed to read file'}`)}\n`);
  }

  // Hand the content to the surface's editor.
  let edit: LocalEditResult;
  try {
    edit = await surface_get().localEdit({ content: catResult.value, extension: ext || '.txt', path: target });
  } catch (err: unknown) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`edit: ${err instanceof Error ? err.message : String(err)}`)}\n`);
  }

  // An editor that stays open (a browser pane) has taken the file; each save
  // made there runs as its own command line, so there is nothing to save here.
  if (edit.opened) {
    return envelope_ok(`${chalk.gray(EDIT_OPENED_LINE)}\n`);
  }
  if (!edit.changed) {
    return envelope_ok(`${chalk.gray('(no changes)')}\n`);
  }

  // Upload the edited content: write it to a temp file the replace command
  // reads, and preserve that file (reporting its path) if the save fails.
  // In a folder of its own only this account can open (0700), created anew and 0600: nothing at a predictable
  // name is followed, and nobody else reads the edit.
  const temp: PrivateTemp = privateTemp_write('chell-edit-', `edit${suffix_safe(ext, '.txt')}`, edit.content);
  const tmpPath: string = temp.path;
  // The copy is kept until the save is confirmed: a rejected save, or one that throws, says where it is.
  let result: EditResult;
  try {
    result = await file_replaceContent(target, tmpPath);
  } catch (error: unknown) {
    result = { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!result.success) return editSave_fail(result.error, tmpPath);
  // Saved: the copy goes; then the folder's listing is stale by both its names: where the store keeps it, and the
  // path the file was reached by.
  temp.folder_remove();
  listCache_get().cache_invalidate(posix.dirname(target));
  listCache_get().cache_invalidate(posix.dirname(await path_resolve(named)));
  return envelope_ok(`${chalk.green(`Saved: ${named}`)}\n`);
}

/**
 * Says a save that did not go through, and where the edit is kept.
 *
 * @param reason - Why the save failed.
 * @param kept - The private copy that holds the edit.
 * @returns The failure.
 */
function editSave_fail(reason: string | undefined, kept: string): CommandEnvelope {
  const apiErr: StackMessage | undefined = errorStack.stack_pop();
  let renderedErr: string = `${chalk.red(`edit: Save failed — ${String(reason)}`)}\n`;
  if (apiErr) renderedErr += `${chalk.red(`  API error: ${error_stripDebugPrefix(apiErr.message)}`)}\n`;
  renderedErr += `${chalk.yellow(`Your edits are preserved at: ${kept}`)}\n`;
  exitCode_set(1);
  return envelope_error('', undefined, renderedErr);
}

/**
 * Edits a file a projection holds (a feed's note at
 * /proc/jobs/feed_N/note): read through the projection, handed to the
 * surface's editor, written back through the projection. A read-only
 * projected file is refused by the projection, in its own words.
 *
 * @param named - The path as the operator typed it.
 * @param target - The resolved path.
 * @param ext - Its extension, for the editor's highlighting.
 * @param dispatcher - The VFS dispatcher.
 * @returns An envelope carrying the outcome.
 */
async function projectedFile_edit(
  named: string,
  target: string,
  ext: string,
  dispatcher: { read: (path: string) => Promise<Result<string>>; write: (path: string, content: string) => Promise<boolean> },
): Promise<CommandEnvelope> {
  const read: Result<string> = await dispatcher.read(target);
  if (!read.ok) {
    const err: StackMessage | undefined = errorStack.stack_pop();
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`edit: ${err ? error_stripDebugPrefix(err.message) : `${named}: could not read`}`)}\n`);
  }
  let edit: LocalEditResult;
  try {
    edit = await surface_get().localEdit({ content: read.value, extension: ext || '.txt', path: target });
  } catch (err: unknown) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`edit: ${err instanceof Error ? err.message : String(err)}`)}\n`);
  }
  if (edit.opened) return envelope_ok(`${chalk.gray(EDIT_OPENED_LINE)}\n`);
  if (!edit.changed) return envelope_ok(`${chalk.gray('(no changes)')}\n`);
  if (await dispatcher.write(target, edit.content)) return envelope_ok(`${chalk.green(`Saved: ${named}`)}\n`);
  const err: StackMessage | undefined = errorStack.stack_pop();
  exitCode_set(1);
  return envelope_error('', undefined, `${chalk.red(`edit: ${err ? error_stripDebugPrefix(err.message) : `${named}: could not save`}`)}\n`);
}
