/**
 * @file Builtin Utilities
 * Pure functions for argument parsing and path resolution logic.
 */
import * as path from 'path';
import { session } from '../session/index.js';
import { path_resolveFrom } from '../core/paths.js';
import type { ListingItem } from '@fnndsc/menu';
import { CLIoptions } from '@fnndsc/chili/utils/cli.js';

/**
 * Structure for parsed command line arguments.
 */
export interface ParsedArgs {
  _: string[];
  [key: string]: string | boolean | string[];
}

/**
 * Bridges POSIX-parsed builtin arguments to chili's CLI option bag.
 *
 * ParsedArgs and CLIoptions carry incompatible index signatures, so the
 * conversion is a real copy (positional `_` dropped), not a cast.
 *
 * @param parsed - Arguments from `commandArgs_process`.
 * @returns The same flags as a chili CLIoptions object.
 */
export function cliOptions_extract(parsed: ParsedArgs): CLIoptions {
  const options: CLIoptions = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== '_') options[key] = value;
  }
  return options;
}

/**
 * Parsing policy for command-specific long options.
 *
 * @property booleanLongOptions - Flags that must retain a following operand.
 */
export interface CommandArgsOptions {
  /** Long options which are flags and must never consume a following operand. */
  booleanLongOptions?: readonly string[];
}


/**
 * Names the first option a verb does not have, in the words the shell
 * uses on Linux, so a verb refuses it rather than skipping it: an ignored
 * flag reads as done.
 *
 * @param verb - The command, for the message.
 * @param parsed - The parsed arguments.
 * @param known - The option keys the verb reads (single letters for short
 *   flags, names for long ones).
 * @returns The refusal line, or null when every option is known.
 */
export function optionsUnknown_refusal(verb: string, parsed: ParsedArgs, known: ReadonlyArray<string>): string | null {
  for (const key of Object.keys(parsed)) {
    if (key === '_' || known.includes(key)) continue;
    return key.length === 1 ? `${verb}: invalid option -- '${key}'` : `${verb}: unrecognized option '--${key}'`;
  }
  return null;
}

/**
 * Parses raw argument strings into a structured object.
 * Supports `--` as an end-of-options marker (everything after is treated as positional args).
 *
 * @param args - Tokenized command arguments.
 * @param options - Command-specific long-option policy.
 * @returns Parsed option values and positional operands.
 */
export function commandArgs_process(args: string[], options: CommandArgsOptions = {}): ParsedArgs {
  const result: ParsedArgs = { _: [] };
  const booleanLongOptions: Set<string> = new Set(options.booleanLongOptions);
  let endOfOptions: boolean = false;

  for (let i = 0; i < args.length; i++) {
    const arg: string = args[i];

    // Check for -- (end of options marker)
    if (arg === '--') {
      endOfOptions = true;
      continue; // Skip the -- itself
    }

    // After --, everything is a positional argument
    if (endOfOptions) {
      (result._ as string[]).push(arg);
      continue;
    }

    if (arg.startsWith('--')) {
      const rawKey: string = arg.substring(2);
      const separator: number = rawKey.indexOf('=');
      const key: string = separator === -1 ? rawKey : rawKey.slice(0, separator);
      if (separator !== -1) {
        result[key] = rawKey.slice(separator + 1);
      } else if (!booleanLongOptions.has(key) && args[i + 1] !== undefined && !args[i + 1].startsWith('-')) {
        // An empty word is a value (`--flag ''`), never a missing one.
        result[key] = args[i + 1];
        i++;
      } else {
        result[key] = true;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      const flags: string[] = arg.substring(1).split('');
      flags.forEach(flag => result[flag] = true);
    } else {
      (result._ as string[]).push(arg);
    }
  }
  return result;
}

/**
 * Context required for path resolution.
 */
export interface PathContext {
    user: string | null;
    cwd: string;
}

/**
 * Resolves a path argument, handling `~` expansion and relative paths.
 * Pure function version that takes context as argument.
 * 
 * @param inputPath - The path to resolve.
 * @param context - User and CWD context.
 * @returns The absolute path.
 */
/**
 * The identity's home directory in the CUBE filesystem.
 *
 * CUBE roots every user at `/home/<username>`; with no identity there is no
 * home, and the root stands in.
 *
 * @param user - The identity's username, or null when there is none.
 * @returns The home path.
 */
export function homePath_derive(user: string | null | undefined): string {
  return user ? `/home/${user}` : '/';
}

export function path_resolvePure(inputPath: string, context: PathContext): string {
  return path_resolveFrom(inputPath, homePath_derive(context.user), context.cwd);
}

// A path argument as the session means it: `~` and relative paths resolved.
export { path_resolve, storePath_resolve } from '../core/paths.js';

/**
 * Resolves links in a path without using PathMapper (for physical mode).
 * Checks each component to see if it's a link and follows it.
 *
 * @param targetPath - The path to resolve.
 * @returns The resolved path with links followed.
 */
export async function path_resolveLinks(targetPath: string): Promise<string> {
  // We need to dynamically import files_list to avoid circular dependency
  // because builtins/fs/ls.ts imports path_resolve from here
  const { files_list } = await import('@fnndsc/chili/commands/fs/ls.js');

  const components: string[] = targetPath.split('/').filter(c => c);
  let currentPath: string = '';

  for (const component of components) {
    const parentPath: string = currentPath || '/';
    currentPath = `${currentPath}/${component}`;

    try {
      // List parent directory to check if component is a link
      const items: ListingItem[] = await files_list({ path: parentPath }, parentPath);

      // Find the component in the listing
      const item: ListingItem | undefined = items.find((i: ListingItem) => i.name === component);

      if (item && item.type === 'link' && item.target) {
        // Component is a link - resolve it
        if (item.target.startsWith('/')) {
          // Absolute link target
          currentPath = item.target;
        } else {
          // Relative link target
          currentPath = `${parentPath}/${item.target}`.replace('//', '/');
        }
      }
    } catch (_error: unknown) {
      // If we can't list the directory, continue with the current path
      continue;
    }
  }

  return currentPath || '/';
}

export { error_stripDebugPrefix } from '../core/errorText.js';
