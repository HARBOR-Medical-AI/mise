/**
 * @file `logout`: disconnects the session from ChRIS.
 *
 * Declared in one record (`logoutCommand`): it takes no operand or option.
 *
 * Key components:
 * - logoutCommand: the declaration.
 * - builtin_logout: the declaration run over words already split.
 *
 * Typical usage:
 * ```ts
 * await builtin_logout();
 * ```
 *
 * Dependencies: chili's logout and its view.
 *
 * @module
 */
import chalk from 'chalk';
import { connect_logout } from '@fnndsc/chili/commands/connect/logout.js';
import { logout_render } from '@fnndsc/chili/views/connect.js';
import { CommandEnvelope, envelope_ok } from '@fnndsc/menu';
import { command_declare, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** What a `logout` line may hold: nothing after the command. */
const LOGOUT_GRAMMAR = {} as const satisfies CommandGrammar;

/**
 * Logs out from the current ChRIS CUBE session.
 *
 * @returns An envelope carrying the logout notice; on failure the data channel
 *   still reports the logout and the error channel carries the reason.
 */
async function logout_run(): Promise<CommandEnvelope> {
  try {
    await connect_logout();
    return envelope_ok(`${logout_render(true)}\n`);
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    const envelope: CommandEnvelope = envelope_ok(`${logout_render(false)}\n`);
    envelope.renderedErr = `${chalk.red(`Logout failed: ${msg}`)}\n`;
    return envelope;
  }
}

/**
 * `logout`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [logoutCommand] }, 'backend');
 * ```
 */
export const logoutCommand = command_declare({
  name: 'logout',
  grammar: LOGOUT_GRAMMAR,
  help: {
    summary: 'Disconnect from ChRIS server',
    description: "Disconnects the session from the CUBE it is connected to and clears the session's authentication.",
    category: 'Connection',
    examples: ['logout'],
  },
  handler: async (): Promise<CommandEnvelope> => logout_run(),
});

/**
 * `logout` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `logout`: none.
 * @returns The logout notice, or the refusal of a bad line.
 */
export async function builtin_logout(args: string[] = []): Promise<CommandEnvelope> {
  return declaredCommand_run(logoutCommand, args);
}
