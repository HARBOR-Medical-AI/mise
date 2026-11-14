/**
 * @file `mkdir`: makes folders in ChRIS's filesystem (CFS).
 *
 * Declared in one record (`mkdirCommand`): folders, which glob, and `-p`.
 * A path through a link is made where the link points; a path a projection
 * holds itself (a tag under /proc/tags) is the projection's to make.
 *
 * Key components:
 * - mkdirCommand: the declaration.
 * - builtin_mkdir: the declaration run over words already split.
 * - mkdir_run: the typed core behind both, and the typed API.
 *
 * Typical usage:
 * ```ts
 * await builtin_mkdir(['-p', 'experiments/run1']);
 * await mkdir_run({ paths: ['experiments/run1'], parents: true });
 * ```
 *
 * Dependencies: the session's filesystem and listing cache, the store-path
 * resolver, and the error stack (a provider's reason).
 *
 * @module
 */
import { errno_words, vfsOutcome_convertToResult, mkdir_render, type VFSDispatcher, type VFSItem, type VfsOutcome } from '@fnndsc/fond';
import chalk from 'chalk';
import { path_resolve, storePath_resolve, error_stripDebugPrefix } from '../utils.js';
import { listingCache_get, vfsDispatcher_get } from '../../core/filesystem.js';
import { pathEntry_find, entry_isFolder, folderTree_make } from './entries.js';
import { errorStack, type Result, type StackMessage } from '@fnndsc/fond';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** Outcome of one mkdir target, for the envelope model. */
export interface MkdirOutcome {
  path: string;
  created: boolean;
  /** Already a folder, and `-p` says that is fine. */
  existed?: boolean;
}

/** Typed invocation options for mkdir. */
export interface MkdirOptions {
  /** Directory paths to create, absolute or relative to the session cwd. */
  paths: string[];
  /**
   * Make missing parents too, and take a folder already there as done
   * (`-p`). Without it, as POSIX has it, a missing parent or an existing
   * target is an error.
   */
  parents?: boolean;
}

/**
 * Makes a folder in a projection. Under `-p` a folder already there is
 * fine, as it is on a disk; without it the projection's own refusal stands.
 *
 * @param targetPath - The absolute virtual path.
 * @param parents - Whether `-p` was given.
 * @returns The outcome.
 */
async function virtualFolder_make(targetPath: string, parents: boolean): Promise<MkdirOutcome> {
  if (parents) {
    const slash: number = targetPath.lastIndexOf('/');
    const siblings: Result<VFSItem[]> = await vfsDispatcher_get().list(targetPath.slice(0, slash) || '/');
    if (siblings.ok && siblings.value.some((item: VFSItem): boolean => item.name === targetPath.slice(slash + 1))) {
      return { path: targetPath, created: false, existed: true };
    }
  }
  return { path: targetPath, created: vfsOutcome_convertToResult(await vfsDispatcher_get().mkdir(targetPath), 'mkdir', targetPath).ok };
}

/**
 * The kernel's reason a verb failed, after what it was doing.
 *
 * @param doing - The verb and its operand, as the refusal opens.
 * @returns `doing: reason`, the reason the stack held (its debug prefix stripped).
 */
function refusal_said(doing: string): string {
  const reason: StackMessage | undefined = errorStack.stack_pop();
  if (reason === undefined) return `${doing}: failed`;
  const said: string = error_stripDebugPrefix(reason.message);
  // The dispatcher's refusal already names the verb; a provider's names the operand first.
  return said.startsWith('mkdir:') ? said : `${doing}: ${said.replace(/^[^:]*: /, '')}`;
}

/**
 * Forgets every listing above a folder `-p` made that does not yet hold the
 * folder it leads to: the store makes missing parents in one step and names
 * none of them, so each listing up to the first that already held its child
 * is behind.
 *
 * @param targetPath - The folder made.
 */
function ancestors_invalidate(targetPath: string): void {
  const cache = listingCache_get();
  let child: string = targetPath;
  while (child !== '/') {
    const parent: string = child.substring(0, child.lastIndexOf('/')) || '/';
    const name: string = child.substring(child.lastIndexOf('/') + 1);
    const kept: { data: unknown; fresh: boolean } | null = cache.cache_get(parent);
    const holds: boolean = kept !== null && Array.isArray(kept.data)
      && (kept.data as VFSItem[]).some((item: VFSItem): boolean => item.name === name);
    // The folder made is new, so its own parent is always behind.
    if (holds && child !== targetPath) break;
    cache.cache_invalidate?.(parent);
    child = parent;
  }
}

/**
 * Forgets the listings a made folder changed, by the session's path and by
 * the store's: its parent's, or under `-p` every one above it that is behind.
 *
 * @param shown - The folder as the session names it.
 * @param targetPath - The folder in the store.
 * @param parents - Whether `-p` was given.
 */
function listings_forget(shown: string, targetPath: string, parents: boolean): void {
  for (const at of new Set([shown, targetPath])) {
    if (parents) ancestors_invalidate(at);
    else listingCache_get().cache_invalidate?.(at.substring(0, at.lastIndexOf('/')) || '/');
  }
}

/** What an `mkdir` line may hold. */
const MKDIR_GRAMMAR = {
  operands: [
    { name: 'paths', kind: 'cfsPath', repeat: true, glob: true, summary: 'The folders to make' },
  ],
  options: {
    parents: { short: 'p', long: 'parents', summary: 'Make missing parents too, and take a folder already there as done' },
  },
} as const satisfies CommandGrammar;

/**
 * `mkdir [-p] <directory…>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [mkdirCommand] });
 * ```
 */
export const mkdirCommand = command_declare({
  name: 'mkdir',
  grammar: MKDIR_GRAMMAR,
  help: {
    summary: 'Create directories',
    description: 'Makes each folder in ChRIS\'s filesystem. Without -p, as on Linux: a missing parent is "No such file or directory" and an existing folder is "File exists". A path through a link is made where the link points. Under /proc/tags a folder is a tag.',
    category: 'Files',
    posix: { group: 'Files', differs: 'makes CFS folders; -p for parents' },
    examples: [
      'mkdir newdir               # Create single directory',
      'mkdir dir1 dir2            # Create multiple directories',
      'mkdir -p experiments/run1  # Create nested directory, parents included',
      'mkdir /proc/tags/urgent    # Make a tag (setfattr hangs it on a feed)',
    ],
  },
  handler: async (args: CommandArguments<typeof MKDIR_GRAMMAR>): Promise<CommandEnvelope> =>
    mkdir_run({ paths: args.operands.paths, parents: args.options.parents }),
});

/**
 * `mkdir` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `mkdir`.
 * @returns The envelope from {@link mkdir_run}, or the refusal of a bad line.
 */
export async function builtin_mkdir(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(mkdirCommand, args);
}

/**
 * Creates directories: the shared typed core behind the parsed builtin and
 * the typed API.
 *
 * @param options - The directories to create, and whether parents come too.
 * @returns An envelope whose rendered text reports each directory and whose
 *   model lists per-target outcomes.
 */
export async function mkdir_run(options: MkdirOptions): Promise<CommandEnvelope> {
  const args: string[] = options.paths;
  const parents: boolean = options.parents === true;
  if (args.length === 0) {
    return envelope_error('', undefined, `${chalk.red('Usage: mkdir [-p] <directory> [directory...]')}\n`);
  }

  let rendered: string = '';
  let renderedErr: string = '';
  const outcomes: MkdirOutcome[] = [];

  for (const pathArg of args) {
    try {
      const shown: string = await path_resolve(pathArg);
      const targetPath: string = await storePath_resolve(pathArg);
      // A projection that makes folders (a tag under /proc/tags) makes them
      // itself; one that makes none refuses by name.
      const dispatcher: VFSDispatcher = vfsDispatcher_get();
      if (dispatcher.path_isVirtual(targetPath)) {
        const made: MkdirOutcome = await virtualFolder_make(targetPath, parents);
        if (made.created) rendered += `${mkdir_render(shown, true)}\n`;
        else if (made.existed !== true) renderedErr += `${chalk.red(refusal_said(`mkdir: cannot create directory '${pathArg}'`))}\n`;
        outcomes.push({ ...made, path: shown });
        if (made.created) listings_forget(shown, targetPath, false);
        continue;
      }
      const made: VfsOutcome = parents ? await folderTree_make(dispatcher, targetPath) : await dispatcher.mkdir(targetPath);
      if (made.ok) {
        rendered += `${mkdir_render(shown, true)}\n`;
        outcomes.push({ path: shown, created: true });
        listings_forget(shown, targetPath, parents);
        continue;
      }
      if (made.errno === 'EEXIST') {
        if (parents && entry_isFolder(await pathEntry_find(dispatcher, targetPath))) {
          outcomes.push({ path: shown, created: false, existed: true });
        } else {
          renderedErr += `${chalk.red(`mkdir: cannot create directory '${pathArg}': File exists`)}\n`;
          outcomes.push({ path: shown, created: false });
        }
        continue;
      }
      if (made.errno === 'ENOENT') {
        renderedErr += `${chalk.red(`mkdir: cannot create directory '${pathArg}': No such file or directory`)}\n`;
        outcomes.push({ path: shown, created: false });
        continue;
      }
      if (made.errno === 'ENOTDIR') {
        // A file above the target: CUBE would otherwise have made a folder over it.
        renderedErr += `${chalk.red(`mkdir: cannot create directory '${pathArg}': Not a directory`)}\n`;
        outcomes.push({ path: shown, created: false });
        continue;
      }
      rendered += `${mkdir_render(shown, false)}\n`;
      // A refusal with no words of its own (a store that will not, EACCES) still says why.
      renderedErr += `${chalk.red(made.reason ?? `mkdir: cannot create directory '${pathArg}': ${errno_words(made.errno)}`)}\n`;
      outcomes.push({ path: shown, created: false });
    } catch (e: unknown) {
      const msg: string = e instanceof Error ? e.message : String(e);
      renderedErr += `${chalk.red(`mkdir: ${pathArg}: ${msg}`)}\n`;
      outcomes.push({ path: pathArg, created: false });
    }
  }

  const anyFailed: boolean = outcomes.some((outcome: MkdirOutcome): boolean => !outcome.created && outcome.existed !== true);
  const model: { kind: string; data: MkdirOutcome[] } = { kind: 'fs.mkdir', data: outcomes };
  if (anyFailed) {
    const envelope: CommandEnvelope = envelope_error(rendered, undefined, renderedErr || undefined);
    envelope.model = model;
    return envelope;
  }
  return envelope_ok(rendered, model);
}
