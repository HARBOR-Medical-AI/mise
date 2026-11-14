/**
 * @file `connect`: logs the session in to a ChRIS CUBE.
 *
 * Declared in one record (`connectCommand`): the CUBE's URL, and the user
 * and password as options; both are needed.
 *
 * Key components:
 * - connectCommand: the declaration.
 * - builtin_connect: the declaration run over words already split.
 *
 * Typical usage:
 * ```ts
 * await builtin_connect(['--user', 'chris', '--password', secret, 'https://cube.chrisproject.org/api/v1/']);
 * ```
 *
 * Dependencies: chili's login and its view; the session's context.
 *
 * @module
 */
import chalk from 'chalk';
import { connect_login } from '@fnndsc/chili/commands/connect/login.js';
import { login_render } from '@fnndsc/chili/views/connect.js';
import { session } from '../../session/index.js';
import { chrisContext } from '@fnndsc/cumin';
import { type CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { commandUsage_render } from '../../core/commandUsage.js';

/** What a `connect` line may hold. */
const CONNECT_GRAMMAR = {
  operands: [
    { name: 'url', kind: 'word', summary: "The CUBE's API URL (…/api/v1/)" },
  ],
  options: {
    user: { long: 'user', summary: 'The ChRIS username', value: { name: 'username', kind: 'word' } },
    password: { long: 'password', summary: "The user's password", value: { name: 'password', kind: 'word' } },
  },
} as const satisfies CommandGrammar;

/**
 * Connects to a ChRIS CUBE instance with the credentials given.
 *
 * @param args - The line, parsed.
 * @returns An envelope carrying the login result, or a refusal when the user or the password is missing.
 */
async function connect_run(args: CommandArguments<typeof CONNECT_GRAMMAR>): Promise<CommandEnvelope> {
  const user: string | undefined = args.options.user;
  const password: string | undefined = args.options.password;
  const url: string = args.operands.url;
  if (!user || !password) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`connect: --user and --password are both needed; usage: ${commandUsage_render(connectCommand)}`)}\n`);
  }
  try {
    const success: boolean = await connect_login({ user, password, url, debug: false });
    if (success) {
      session.offline = false;
      // Refresh context to update prompt with new user/url
      await chrisContext.currentContext_update();
    }
    return envelope_ok(`${login_render(success, url, user)}\n`);
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    exitCode_set(1);
    return envelope_error(`${login_render(false, url, user)}\n`, undefined, `${chalk.red(`Connection failed: ${msg}`)}\n`);
  }
}

/**
 * `connect --user <username> --password <password> <url>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [connectCommand] }, 'backend');
 * ```
 */
export const connectCommand = command_declare({
  name: 'connect',
  grammar: CONNECT_GRAMMAR,
  help: {
    summary: 'Connect to ChRIS server',
    description: "Logs the session in to the CUBE at a URL as a user, with that user's password; both --user and --password are needed.",
    category: 'Connection',
    examples: [
      'connect --user alice --password <password> https://cube.chrisproject.org/api/v1/',
      'connect --user bob --password <password> http://localhost:8000/api/v1/',
    ],
  },
  handler: connect_run,
});

/**
 * `connect` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `connect`.
 * @returns The login result, or the refusal of a bad line.
 */
export async function builtin_connect(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(connectCommand, args);
}
