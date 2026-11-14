/**
 * @file `physicalmode`: shows or sets whether paths are used as CUBE stores
 * them, past the logical-to-physical mapping.
 *
 * Declared in one record (`physicalmodeCommand`): `on` and `off` are its
 * subcommands; with neither it says how it stands.
 *
 * Key components:
 * - physicalmodeCommand: the declaration.
 * - builtin_physicalmode: the declaration run over words already split.
 *
 * Typical usage:
 * ```ts
 * await builtin_physicalmode(['on']);
 * ```
 *
 * Dependencies: the session's physical-mode flag.
 *
 * @module
 */
import chalk from 'chalk';
import { session } from '../../session/index.js';
import { CommandEnvelope, envelope_ok } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** What a `physicalmode` line may hold. */
const PHYSICALMODE_GRAMMAR = {
  bare: { summary: 'Show whether physical mode is on' },
  subcommands: {
    on: { summary: 'Enable physical mode (paths used directly)' },
    off: { summary: 'Disable physical mode (use logical-to-physical mapping)' },
  },
} as const satisfies CommandGrammar;

/**
 * Shows or sets physical filesystem mode.
 *
 * @param args - The line, parsed: `on`, `off`, or neither.
 * @returns An envelope describing the (possibly updated) physical mode state.
 */
async function physicalmode_run(args: CommandArguments<typeof PHYSICALMODE_GRAMMAR>): Promise<CommandEnvelope> {
  if (args.subcommand === null) {
    const enabled: boolean = session.physicalMode_get();
    const status: string = enabled ? 'enabled' : 'disabled';
    const detail: string = enabled
      ? chalk.gray('  Paths are used directly without logical-to-physical mapping.')
      : chalk.gray('  Paths are resolved through logical-to-physical mapping.');
    return envelope_ok(
      `Physical filesystem mode: ${chalk.yellow(status)}\n${detail}\n${chalk.gray('\nUsage: physicalmode [on|off]')}\n`,
      { kind: 'sys.physicalMode', data: { enabled } },
    );
  }

  if (args.subcommand === 'on') {
    session.physicalMode_set(true);
    return envelope_ok(
      `${chalk.yellow('[!] Physical filesystem mode enabled')}\n${chalk.gray('    Paths will be used directly without logical-to-physical mapping.')}\n`,
      { kind: 'sys.physicalMode', data: { enabled: true } },
    );
  }

  session.physicalMode_set(false);
  return envelope_ok(
    `${chalk.green('[+] Physical filesystem mode disabled')}\n${chalk.gray('    Paths will be resolved through logical-to-physical mapping.')}\n`,
    { kind: 'sys.physicalMode', data: { enabled: false } },
  );
}

/**
 * `physicalmode [on | off]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [physicalmodeCommand] }, 'backend');
 * ```
 */
export const physicalmodeCommand = command_declare({
  name: 'physicalmode',
  grammar: PHYSICALMODE_GRAMMAR,
  help: {
    summary: 'Toggle or display physical filesystem mode',
    description: 'Shows whether paths are used directly, as CUBE stores them, or resolved through the logical-to-physical mapping; or turns physical mode on or off.',
    category: 'Settings',
    examples: [
      'physicalmode          # Show current status',
      'physicalmode on       # Enable physical mode',
      'physicalmode off      # Disable physical mode',
    ],
  },
  handler: physicalmode_run,
});

/**
 * `physicalmode` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `physicalmode`.
 * @returns The physical mode state, or the refusal of a bad line.
 */
export async function builtin_physicalmode(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(physicalmodeCommand, args);
}
