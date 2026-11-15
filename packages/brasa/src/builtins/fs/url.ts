/**
 * @file Builtin url: a web address that opens ARGUS at a path.
 *
 * A colleague handed a node used to paste a long `pwd` into chat, and the
 * one receiving it walked down to it by hand. `url <path>` prints the
 * door's address with the path as its fragment; ARGUS reads the fragment
 * when it opens and lands there: a feed or a node in RUNS, anything else
 * in FILES. The path is the session's resolved absolute path, so the link
 * names the same place for anyone the feed is shared with.
 *
 * Declared in one record (`urlCommand`).
 *
 * @module
 */
import chalk from 'chalk';
import { CommandEnvelope, envelope_ok } from '@fnndsc/menu';
import { session } from '../../session/index.js';
import { path_resolve } from '../utils.js';
import { command_declare, type CommandDeclaration, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** The environment variable naming the door (porter) a link opens through. */
export const URL_DOOR_ENV: string = 'CHELL_DOOR';

/**
 * The address a link opens: the door with the path as its fragment.
 *
 * @param door - The door's base address, or empty for none.
 * @param absolutePath - The resolved path.
 * @returns The link, or the bare fragment when there is no door.
 */
export function url_compose(door: string, absolutePath: string): string {
  const fragment: string = `#${encodeURI(absolutePath)}`;
  if (door === '') return fragment;
  return `${door.replace(/\/+$/, '')}/${fragment}`;
}

/** What a `url` line may hold. */
const URL_GRAMMAR = {
  operands: [{ name: 'path', kind: 'cfsPath', optional: true, summary: 'Where the link opens: a feed or a node lands in RUNS, anything else in FILES (default: where you stand)' }],
} as const satisfies CommandGrammar;

/**
 * Prints a web address that opens ARGUS at a path (the cwd when none).
 *
 * @param path - The path, if given.
 * @param env - The environment the door is read from.
 * @returns An envelope carrying the link and its `fs.url` model.
 */
async function url_answer(path: string | undefined, env: NodeJS.ProcessEnv): Promise<CommandEnvelope> {
  const absolute: string = path === undefined ? await session.getCWD() : await path_resolve(path);
  const door: string = (env[URL_DOOR_ENV] ?? '').trim();
  const link: string = url_compose(door, absolute);
  const rendered: string = door === ''
    ? `${link}\n${chalk.dim(`No door is known to this session (${URL_DOOR_ENV} is unset): put the door's address in front, e.g. https://titan.tch.harvard.edu/${link}`)}\n`
    : `${link}\n`;
  return envelope_ok(rendered, { kind: 'fs.url', data: { path: absolute, url: link } });
}

/**
 * The `url` declaration over one environment, the one its door is read from.
 *
 * @param env - The environment.
 * @returns The declaration.
 */
function urlCommand_make(env: NodeJS.ProcessEnv): CommandDeclaration<typeof URL_GRAMMAR> {
  return command_declare({
    name: 'url',
    grammar: URL_GRAMMAR,
    help: {
      summary: 'Print a link (a web address) that opens ARGUS at a path, to send to a colleague',
      description: `Print a web address that opens ARGUS at a path: a feed or a node lands in RUNS, anything else in FILES. The path is the session's resolved absolute path, so the link names the same place for anyone the feed is shared with. The door comes from ${URL_DOOR_ENV}; without it the fragment alone is printed, with a word on what to put in front.`,
      category: 'Sharing',
      examples: [
        'url                                   # Where you stand',
        'url /home/sandip.samal/feeds/feed_4389/pl-dicom_repack_639204',
        'url .                                 # Paste it to a colleague the feed is shared with',
      ],
    },
    holds: [],
    handler: async (args): Promise<CommandEnvelope> => url_answer(args.operands.path, env),
  });
}

/**
 * `url [path]`: the declaration, its door read from the process's environment.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [urlCommand] });
 * ```
 */
export const urlCommand: CommandDeclaration<typeof URL_GRAMMAR> = urlCommand_make(process.env);

/**
 * `url` over words already split.
 *
 * @param args - The path, optionally.
 * @param env - The environment the door is read from.
 * @returns An envelope carrying the link and its `fs.url` model, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_url(['.']);
 * ```
 */
export async function builtin_url(args: string[] = [], env: NodeJS.ProcessEnv = process.env): Promise<CommandEnvelope> {
  return declaredCommand_run(env === process.env ? urlCommand : urlCommand_make(env), args);
}
