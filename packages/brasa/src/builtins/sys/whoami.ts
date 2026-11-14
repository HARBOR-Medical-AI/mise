/**
 * @file `id`, `whoami` and `whereami`: who the session is on CUBE, and
 * which CUBE, each in a line.
 *
 * Declared in one record each (`idCommand`, `whoamiCommand`,
 * `whereamiCommand`): none takes an operand or an option.
 *
 * Key components:
 * - idCommand, whoamiCommand, whereamiCommand: the declarations.
 * - builtin_id, builtin_whoami, builtin_whereami: each declaration run over words already split.
 *
 * Typical usage:
 * ```ts
 * await builtin_whoami([]);
 * ```
 *
 * Dependencies: the session's context and identity (salsa, cumin).
 *
 * @module
 */
import chalk from 'chalk';
import { context_getSingle } from '@fnndsc/salsa';
import { currentIdentity_get, type ChrisGroup, type ChrisIdentity, type SingleContext } from '@fnndsc/cumin';
import type { Result } from '@fnndsc/fond';
import { envelope_error, envelope_ok, type CommandEnvelope } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';
import { command_declare, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** What an `id`, `whoami` or `whereami` line may hold: nothing after the command. */
const IDENTITY_GRAMMAR = {} as const satisfies CommandGrammar;

/** A Unix-style group entry projected from CUBE identity data. */
interface PosixGroupIdentity {
  gid: number;
  group: string;
}

/**
 * Reports the current ChRIS identity using Unix `id` notation.
 *
 * CUBE exposes a numeric user ID but no primary-group field. ChELL therefore
 * uses the same POSIX projection as `/etc/passwd`: the primary GID and group
 * name equal the user's ID and username.
 *
 * @returns An envelope carrying numeric UID/GID identity and every CUBE group
 *   membership, or an error envelope when identity cannot be resolved.
 */
async function id_run(): Promise<CommandEnvelope> {
  const result: Result<ChrisIdentity> = await currentIdentity_get();
  if (!result.ok) {
    exitCode_set(1);
    return envelope_error(`${chalk.gray('(identity unavailable)')}\n`);
  }

  const identity: ChrisIdentity = result.value;
  const primaryGroup: PosixGroupIdentity = {
    gid: identity.user.id,
    group: identity.user.username,
  };
  const memberships: PosixGroupIdentity[] = identity.groups
    .map((membership: ChrisGroup): PosixGroupIdentity => ({
      gid: membership.id,
      group: membership.name,
    }))
    .filter((membership: PosixGroupIdentity): boolean =>
      membership.gid !== primaryGroup.gid || membership.group !== primaryGroup.group)
    .sort((left: PosixGroupIdentity, right: PosixGroupIdentity): number =>
      left.gid - right.gid || left.group.localeCompare(right.group));
  const groups: PosixGroupIdentity[] = [primaryGroup, ...memberships];
  const renderedGroups: string = groups
    .map((membership: PosixGroupIdentity): string => `${membership.gid}(${membership.group})`)
    .join(',');

  return envelope_ok(
    `uid=${identity.user.id}(${identity.user.username}) `
      + `gid=${primaryGroup.gid}(${primaryGroup.group}) groups=${renderedGroups}\n`,
    {
      kind: 'session.posixIdentity',
      data: {
        uid: identity.user.id,
        user: identity.user.username,
        gid: primaryGroup.gid,
        group: primaryGroup.group,
        groups,
      },
    },
  );
}

/**
 * Reports the current authenticated ChRIS username.
 *
 * @returns An envelope carrying the username, or an error envelope with a
 *   not-connected notice when no user is authenticated.
 */
async function whoami_run(): Promise<CommandEnvelope> {
  const context: SingleContext = await context_getSingle();
  if (context.user) {
    return envelope_ok(`${chalk.cyan(context.user)}\n`, {
      kind: 'session.identity',
      data: { user: context.user },
    });
  }
  exitCode_set(1);
  return envelope_error(`${chalk.gray('(not connected)')}\n`);
}

/**
 * Reports the current CUBE URI.
 *
 * @returns An envelope carrying the CUBE URL, or an error envelope with a
 *   not-connected notice when no connection exists.
 */
async function whereami_run(): Promise<CommandEnvelope> {
  const context: SingleContext = await context_getSingle();
  if (context.URL) {
    return envelope_ok(`${chalk.blue(context.URL)}\n`, {
      kind: 'session.cube',
      data: { url: context.URL },
    });
  }
  exitCode_set(1);
  return envelope_error(`${chalk.gray('(not connected)')}\n`);
}

/**
 * `id`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [idCommand] }, 'backend');
 * ```
 */
export const idCommand = command_declare({
  name: 'id',
  grammar: IDENTITY_GRAMMAR,
  help: {
    summary: 'Print the CUBE user as a Unix-style uid, gid and groups',
    description: 'Print the current CUBE user as a Unix-style UID, projected primary GID, and complete list of CUBE group memberships.',
    category: 'Connection',
    examples: ['id'],
  },
  holds: [],
  handler: async (): Promise<CommandEnvelope> => id_run(),
});

/**
 * `whoami`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [whoamiCommand] }, 'backend');
 * ```
 */
export const whoamiCommand = command_declare({
  name: 'whoami',
  grammar: IDENTITY_GRAMMAR,
  help: {
    summary: 'Print the currently authenticated ChRIS username',
    description: 'Print the currently authenticated ChRIS username; a session not connected says so.',
    category: 'Connection',
    examples: ['whoami'],
  },
  holds: [],
  handler: async (): Promise<CommandEnvelope> => whoami_run(),
});

/**
 * `whereami`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [whereamiCommand] }, 'backend');
 * ```
 */
export const whereamiCommand = command_declare({
  name: 'whereami',
  grammar: IDENTITY_GRAMMAR,
  help: {
    summary: 'Print the current CUBE URL',
    description: 'Print the URL of the CUBE this session talks to; a session not connected says so.',
    category: 'Connection',
    examples: ['whereami'],
  },
  holds: [],
  handler: async (): Promise<CommandEnvelope> => whereami_run(),
});

/**
 * `id` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `id`: none.
 * @returns The identity, or the refusal of a bad line.
 */
export async function builtin_id(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(idCommand, args);
}

/**
 * `whoami` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `whoami`: none.
 * @returns The username, or the refusal of a bad line.
 */
export async function builtin_whoami(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(whoamiCommand, args);
}

/**
 * `whereami` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `whereami`: none.
 * @returns The CUBE URL, or the refusal of a bad line.
 */
export async function builtin_whereami(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(whereamiCommand, args);
}
