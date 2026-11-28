/**
 * @file `touch`: makes files in ChRIS's filesystem (CFS), empty or with text.
 *
 * Declared in one record (`touchCommand`): files, which glob, and the text
 * to write, given inline (`--withContents`) or from a file on this machine
 * (`--withContentsFromFile`). A path through a link is written where the
 * link points.
 *
 * Key components:
 * - touchCommand: the declaration.
 * - builtin_touch: the declaration run over words already split.
 * - touch_run: the typed core behind both, and the typed API.
 *
 * Typical usage:
 * ```ts
 * await builtin_touch(['--withContents', 'Hello!', 'greeting.txt']);
 * await touch_run({ paths: ['greeting.txt'], contents: 'Hello!' });
 * ```
 *
 * Dependencies: the session's filesystem and listing cache, the store-path
 * resolver, and this machine's disk (for `--withContentsFromFile`).
 *
 * @module
 */
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { path_resolve, storePath_resolve } from '../utils.js';
import { listingCache_get, vfsDispatcher_get } from '../../core/filesystem.js';
import { pathEntry_find, entry_isFolder } from './entries.js';
import { errno_words, touch_render, vfs_fail, type VFSDispatcher, type VFSItem, type VfsOutcome } from '@fnndsc/fond';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { hostDisk_refusal } from '../../core/hostGate.js';

/** Outcome of one touch target, for the envelope model. */
export interface TouchOutcome {
  path: string;
  created: boolean;
}

/** Typed invocation options for touch. */
export interface TouchRunOptions {
  /** File paths to create or update, absolute or relative to the session cwd. */
  paths: string[];
  /** Literal content to write into the (single) target file. */
  contents?: string | undefined;
  /** Local file whose content is uploaded into the (single) target file. */
  contentsFromFile?: string | undefined;
}

/**
 * Reads the local file whose text a touch writes.
 *
 * @param localFilePath - The path on this host.
 * @returns Its text, or why it could not be read.
 */
function localFile_read(localFilePath: string): { text: string } | { reason: string } {
  const refused: string | null = hostDisk_refusal(`touch --withContentsFromFile ${localFilePath}`);
  if (refused !== null) return { reason: refused };
  try {
    if (!fs.existsSync(localFilePath)) return { reason: `Local file not found: ${localFilePath}` };
    return { text: fs.readFileSync(localFilePath, 'utf-8') };
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    return { reason: `Failed to read local file ${localFilePath}: ${msg}` };
  }
}

/**
 * Touches one file. With content it is written whole, replacing what was
 * there. Without, a file already there is left as it is (its content kept)
 * and a missing one is made empty. A projected file takes text only. A
 * missing parent folder is `No such file or directory`, as on a disk:
 * touch makes no folders (mkdir -p does).
 *
 * @param dispatcher - The session's filesystem.
 * @param targetPath - The absolute path.
 * @param content - The text to write, or none.
 * @returns Done, or why not.
 */
async function file_touch(dispatcher: VFSDispatcher, targetPath: string, content: string | undefined): Promise<VfsOutcome> {
  if (content === undefined) {
    if (dispatcher.path_isVirtual(targetPath)) {
      return vfs_fail('EROFS', `touch: ${targetPath}: a projected file takes text (--withContents)`);
    }
    const there: VFSItem | null = await pathEntry_find(dispatcher, targetPath);
    if (entry_isFolder(there)) return vfs_fail('EISDIR', `Is a directory: a folder already holds ${targetPath}`);
    if (there !== null) return { ok: true, value: true };
  }
  const written: VfsOutcome = await dispatcher.write(targetPath, content ?? '');
  return written.ok || written.errno !== 'EISDIR' ? written : vfs_fail('EISDIR', `Is a directory: a folder already holds ${targetPath}`);
}

/**
 * Forgets the listing of the folder that holds a touched file, by the
 * session's path and by the store's.
 *
 * @param shown - The file as the session names it.
 * @param targetPath - The file in the store.
 */
function parentListings_forget(shown: string, targetPath: string): void {
  for (const at of new Set([shown, targetPath])) listingCache_get().cache_invalidate?.(path.posix.dirname(at));
}

/** What a `touch` line may hold. */
const TOUCH_GRAMMAR = {
  operands: [
    { name: 'paths', kind: 'cfsPath', repeat: true, glob: true, summary: 'The files to make; with text, only the first takes it' },
  ],
  options: {
    withContents: { long: 'withContents', summary: 'Create the file with this text inline', value: { name: 'string', kind: 'word' } },
    withContentsFromFile: { long: 'withContentsFromFile', summary: 'Create the file with the text of a file on this machine', value: { name: 'file', kind: 'hostPath' } },
  },
} as const satisfies CommandGrammar;

/**
 * `touch [--withContents <string>] [--withContentsFromFile <file>] <file…>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [touchCommand] });
 * ```
 */
export const touchCommand = command_declare({
  name: 'touch',
  grammar: TOUCH_GRAMMAR,
  help: {
    summary: 'Create empty files or files with content',
    description: "Makes each file in ChRIS's filesystem: a file already there is left as it is, a missing one is made empty. With --withContents or --withContentsFromFile the first file is written whole with that text. A path through a link is written where the link points. touch makes no folders (mkdir -p does).",
    category: 'Files',
    posix: { group: 'Files', differs: 'makes a CFS file; --withContents writes text into it' },
    examples: [
      'touch file.txt                                   # Create empty file',
      'touch --withContents "Hello!" greeting.txt       # Create file with string',
      'touch --withContentsFromFile template.json config.json  # Create from local file',
    ],
  },
  handler: async (args: CommandArguments<typeof TOUCH_GRAMMAR>): Promise<CommandEnvelope> => touch_run({
    paths: args.operands.paths,
    contents: args.options.withContents,
    contentsFromFile: args.options.withContentsFromFile,
  }),
});

/**
 * `touch` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `touch`.
 * @returns The envelope from {@link touch_run}, or the refusal of a bad line.
 */
export async function builtin_touch(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(touchCommand, args);
}

/**
 * Creates empty files or updates timestamps: the shared typed core behind
 * the parsed builtin and the typed API.
 *
 * @param runOptions - Target paths and optional content source.
 * @returns An envelope whose rendered text reports each created file and
 *   whose model lists per-target outcomes.
 */
export async function touch_run(runOptions: TouchRunOptions): Promise<CommandEnvelope> {
  const pathArgs: string[] = runOptions.paths;

  if (pathArgs.length === 0) {
    return envelope_error(
      '',
      undefined,
      `${chalk.red('Usage: touch [--withContents <string>] [--withContentsFromFile <file>] <file>')}\n`,
    );
  }

  // Empty text is text: `--withContents ''` writes an empty file.
  let content: string | undefined = runOptions.contents;
  if (runOptions.contentsFromFile) {
    const read: { text: string } | { reason: string } = localFile_read(runOptions.contentsFromFile);
    if ('reason' in read) {
      return envelope_error('', undefined, `${chalk.red(`Failed to write file: ${pathArgs[0]}`)}\n${chalk.gray(`  ${read.reason}`)}\n`);
    }
    content = read.text;
  }
  const wrote: boolean = content !== undefined;

  // Only the first path takes content.
  const filesToTouch: string[] = wrote ? pathArgs.slice(0, 1) : pathArgs;

  let rendered: string = '';
  let renderedErr: string = '';
  const outcomes: TouchOutcome[] = [];
  const dispatcher: VFSDispatcher = vfsDispatcher_get();

  for (const pathArg of filesToTouch) {
    try {
      const shown: string = await path_resolve(pathArg);
      const targetPath: string = await storePath_resolve(pathArg);
      const done: VfsOutcome = await file_touch(dispatcher, targetPath, content);

      if (done.ok) {
        rendered += `${touch_render(shown, true, wrote)}\n`;
        outcomes.push({ path: shown, created: true });
        parentListings_forget(shown, targetPath);
      } else {
        renderedErr += `${chalk.red(`Failed to create file: ${shown}`)}\n`;
        renderedErr += `${chalk.gray(`  ${done.reason ?? errno_words(done.errno)}`)}\n`;
        outcomes.push({ path: shown, created: false });
      }
    } catch (e: unknown) {
      const msg: string = e instanceof Error ? e.message : String(e);
      renderedErr += `${chalk.red(`touch: ${pathArg}: ${msg}`)}\n`;
      outcomes.push({ path: pathArg, created: false });
    }
  }

  const anyFailed: boolean = outcomes.some((outcome: TouchOutcome): boolean => !outcome.created);
  const model: { kind: string; data: TouchOutcome[] } = { kind: 'fs.touch', data: outcomes };
  if (anyFailed) {
    const envelope: CommandEnvelope = envelope_error(rendered, undefined, renderedErr || undefined);
    envelope.model = model;
    return envelope;
  }
  return envelope_ok(rendered, model);
}
