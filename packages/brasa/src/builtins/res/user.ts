/**
 * @file CUBE-local account administration builtin.
 *
 * This is a targeted control-plane command rather than a ChRIS Resource
 * Command: federated identities remain outside its authority. Declared in one
 * record (`userCommand`), answered as `user` and `users`.
 *
 * Key components:
 * - userCommand: the declaration.
 * - builtin_user: the declaration run over words already split.
 * - user_run: one account operation, typed.
 *
 * Typical usage:
 * ```ts
 * await builtin_user(['inspect', 'jack.bivowac']);
 * await user_run('inspect', 'jack.bivowac');
 * ```
 *
 * Dependencies: chili's local-account seam; the active surface for the
 * hidden password prompt.
 *
 * @module
 */
import chalk from 'chalk';
import { table_render } from '@fnndsc/chili/screen/screen.js';
import {
  localAccount_action,
  localAccount_adminAccessEnsure,
  localAccount_create,
  localAccount_find,
  type LocalAccount,
  type LocalAccountAction,
} from '@fnndsc/chili/commands/users/local.js';
import { surface_get } from '../../core/surface.js';
import { authorizationFailure_is, sudoHint_build } from '../../core/elevation.js';
import { errorStack } from '@fnndsc/fond';
import { envelope_error, envelope_ok, type CommandEnvelope } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/**
 * Renders a local-account command error and records a failing process status.
 *
 * @param message - User-facing error text.
 * @returns Error envelope for the active command surface.
 */
function user_error(message: string): CommandEnvelope {
  exitCode_set(1);
  return envelope_error('', undefined, `${chalk.red(message)}\n`);
}

/**
 * Renders an account-operation failure, including elevation guidance when apt.
 *
 * @param verb - Failed local-account operation.
 * @param username - Target local username.
 * @returns Error envelope for the active command surface.
 */
function user_operationError(verb: string, username: string): CommandEnvelope {
  const detail = errorStack.stack_pop()?.message ?? `user ${verb} failed.`;
  const hint = authorizationFailure_is(detail) ? sudoHint_build(`user ${verb}`, [username]) : '';
  return user_error(`${detail}\n${hint}`);
}

/**
 * Renders one local account as a stable, operator-oriented table.
 *
 * @param account - Local account returned by CUBE.
 * @returns Success envelope containing the rendered account.
 */
function user_render(account: LocalAccount): CommandEnvelope {
  return envelope_ok(table_render([{ ...account }], ['id', 'username', 'email', 'is_active', 'disabled_at', 'removed_at']));
}

/** The account a subcommand acts on. */
const USERNAME_OPERAND = { name: 'username', kind: 'word', summary: 'The CUBE-local account' } as const;

/** What a `user` line may hold: one operation on one account. */
const USER_GRAMMAR = {
  subcommands: {
    add: { summary: 'Make a local account: prompts for its email, then a hidden password twice', operands: [USERNAME_OPERAND] },
    inspect: { summary: 'Show a local account', operands: [USERNAME_OPERAND] },
    disable: { summary: 'Disable a local account', operands: [USERNAME_OPERAND] },
    enable: { summary: 'Enable a disabled local account', operands: [USERNAME_OPERAND] },
    remove: { summary: 'Remove a local account', operands: [USERNAME_OPERAND] },
  },
} as const satisfies CommandGrammar;

/** One operation `user` performs. */
export type UserVerb = keyof typeof USER_GRAMMAR.subcommands;

/**
 * `user <add|inspect|disable|enable|remove> <username>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [userCommand] }, 'backend');
 * ```
 */
export const userCommand = command_declare({
  name: 'user',
  aliases: ['users'],
  grammar: USER_GRAMMAR,
  help: {
    summary: 'Manage CUBE-local accounts; federated identities remain externally managed',
    description: 'Manage CUBE-local accounts; federated identities remain externally managed. Use `sudo user …` for lifecycle operations; add prompts for the email and a hidden password, with a confirmation.',
    category: 'Admin',
    examples: ['sudo user add jack.bivowac', 'sudo user disable jack.bivowac', 'sudo user remove jack.bivowac'],
  },
  handler: async (args: CommandArguments<typeof USER_GRAMMAR>): Promise<CommandEnvelope> => user_run(args.subcommand, args.operands.username),
});

/**
 * `user` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `user`.
 * @returns The account operation's result, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_user(['disable', 'jack.bivowac']);
 * ```
 */
export async function builtin_user(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(userCommand, args);
}

/**
 * Performs one local-account lifecycle operation, after making sure the
 * identity may administer accounts.
 *
 * @param verb - The operation.
 * @param username - The local account it acts on.
 * @returns Envelope containing a local-account result or operation error.
 *
 * @example
 * ```ts
 * await user_run('inspect', 'jack.bivowac');
 * ```
 */
export async function user_run(verb: UserVerb, username: string): Promise<CommandEnvelope> {
  const access = await localAccount_adminAccessEnsure();
  if (!access.ok) return user_operationError(verb, username);
  if (verb === 'add') {
    const surface = surface_get();
    if (!surface.capabilities.hiddenInput) return user_error('user add: this surface cannot securely collect a password.');
    const email = await surface.prompt({ message: 'Email address: ' });
    const password = await surface.prompt({ message: 'New password: ', hidden: true });
    const confirmation = await surface.prompt({ message: 'Retype new password: ', hidden: true });
    if (password !== confirmation) return user_error('user add: passwords do not match.');
    const result = await localAccount_create(username, email, password);
    return result.ok ? user_render(result.value) : user_operationError('add', username);
  }
  if (verb === 'inspect') {
    const result = await localAccount_find(username);
    return result.ok ? user_render(result.value) : user_error(errorStack.stack_pop()?.message ?? `No CUBE-local account named '${username}'.`);
  }
  const found = await localAccount_find(username);
  if (!found.ok) return user_error(errorStack.stack_pop()?.message ?? `No CUBE-local account named '${username}'.`);
  const action: LocalAccountAction = verb;
  const result = await localAccount_action(found.value.id, action);
  return result.ok ? user_render(result.value) : user_operationError(verb, username);
}
