/**
 * @file `pwd`: where the session stands in ChRIS's filesystem (CFS).
 *
 * Declared in one record (`pwdCommand`): `--title` shows the feed and
 * plugin instance folders by their titles.
 *
 * Key components:
 * - pwdCommand: the declaration.
 * - builtin_pwd: the declaration run over words already split.
 * - pwd_run: the typed core behind both, and the typed API.
 *
 * Typical usage:
 * ```ts
 * await builtin_pwd(['--title']);
 * await pwd_run({ titles: true });
 * ```
 *
 * Dependencies: the session's cwd; the backend's segment titles.
 *
 * @module
 */
import { session } from '../../session/index.js';
import { backendInstalled_get } from '../../core/backend.js';
import { CommandEnvelope, envelope_ok } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** What a `pwd` line may hold. */
const PWD_GRAMMAR = {
  options: {
    title: { long: 'title', summary: 'Replace feed_XXXX and pl-<name>_XXXX with titles in path' },
  },
} as const satisfies CommandGrammar;

/**
 * `pwd [--title]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [pwdCommand] });
 * ```
 */
export const pwdCommand = command_declare({
  name: 'pwd',
  grammar: PWD_GRAMMAR,
  help: {
    summary: 'Print current working directory',
    description: "Prints where the session stands in ChRIS's filesystem. --title shows each feed and plugin instance folder by its title instead.",
    category: 'Navigation',
    posix: { group: 'Files', differs: 'where the session stands in CFS' },
    examples: [
      'pwd                  # Show actual path',
      'pwd --title          # Show path with feed/plugin titles',
      '',
      '# Example output:',
      '# pwd',
      '# /home/chris/feeds/feed_2326/pl-dircopy_176660/data',
      '',
      '# pwd --title',
      '# /home/chris/feeds/Brain MRI Analysis/dircopy v2.1.1/data',
    ],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof PWD_GRAMMAR>): Promise<CommandEnvelope> => pwd_run({ titles: args.options.title }),
});

/**
 * `pwd` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `pwd`.
 * @returns The directory, or the refusal of a bad line.
 */
export async function builtin_pwd(args: string[] = []): Promise<CommandEnvelope> {
  return declaredCommand_run(pwdCommand, args);
}

/** Typed invocation options for pwd. */
export interface PwdOptions {
  /** Replace feed/plugin path segments with their human titles. */
  titles?: boolean;
}

/**
 * Reports the current working directory: the shared typed core behind the
 * parsed builtin and the typed API.
 *
 * @param options - Title substitution preference.
 * @returns An envelope carrying the fs.cwd model.
 */
export async function pwd_run(options: PwdOptions = {}): Promise<CommandEnvelope> {
  const showTitles: boolean = options.titles ?? false;
  const cwd: string = await session.getCWD();
  const shown: string = showTitles ? await path_resolveTitles(cwd) : cwd;
  return envelope_ok(`${shown}\n`, { kind: 'fs.cwd', data: { path: cwd, shown } });
}

/**
 * Replaces each path segment the backend titles (ChRIS: a feed, a plugin
 * instance) with its title.
 *
 * @param path - The path to process.
 * @returns The path with titles in place of the segments that have them.
 */
async function path_resolveTitles(path: string): Promise<string> {
  const title: ((segment: string) => Promise<string | null>) | undefined = backendInstalled_get()?.vfs?.segment_title;
  if (title === undefined) return path;
  const parts: string[] = path.split('/');
  const replacedParts: string[] = await Promise.all(
    parts.map(async (part: string): Promise<string> => (await title(part)) ?? part),
  );
  return replacedParts.join('/');
}
