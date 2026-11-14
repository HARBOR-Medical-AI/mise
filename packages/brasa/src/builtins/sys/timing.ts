/**
 * @file `timing`: shows or sets whether each command's run time is shown.
 *
 * Declared in one record (`timingCommand`): `on` and `off` are its
 * subcommands; with neither it says how it stands.
 *
 * Key components:
 * - timingCommand: the declaration.
 * - builtin_timing: the declaration run over words already split.
 *
 * Typical usage:
 * ```ts
 * await builtin_timing(['on']);
 * ```
 *
 * Dependencies: the session's timing flag.
 *
 * @module
 */
import chalk from 'chalk';
import { session } from '../../session/index.js';
import { CommandEnvelope, envelope_ok } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** What a `timing` line may hold. */
const TIMING_GRAMMAR = {
  bare: { summary: 'Show whether command timing is on' },
  subcommands: {
    on: { summary: 'Show the run time after each command' },
    off: { summary: 'Hide the run time' },
  },
} as const satisfies CommandGrammar;

/**
 * Shows or sets command timing.
 *
 * @param args - The line, parsed: `on`, `off`, or neither.
 * @returns An envelope describing the (possibly updated) timing state.
 */
async function timing_run(args: CommandArguments<typeof TIMING_GRAMMAR>): Promise<CommandEnvelope> {
  if (args.subcommand === null) {
    const enabled: boolean = session.timingEnabled_get();
    const status: string = enabled ? 'enabled' : 'disabled';
    const detail: string = enabled
      ? chalk.gray('  Execution times will be displayed after each command.')
      : chalk.gray('  Execution times are hidden.');
    return envelope_ok(
      `Command timing: ${chalk.yellow(status)}\n${detail}\n${chalk.gray('\nUsage: timing [on|off]')}\n`,
      { kind: 'sys.timing', data: { enabled } },
    );
  }

  if (args.subcommand === 'on') {
    session.timingEnabled_set(true);
    return envelope_ok(
      `${chalk.green('[+] Command timing enabled')}\n${chalk.gray('    Execution times will be displayed after each command.')}\n`,
      { kind: 'sys.timing', data: { enabled: true } },
    );
  }

  session.timingEnabled_set(false);
  return envelope_ok(
    `${chalk.gray('[-] Command timing disabled')}\n${chalk.gray('    Execution times will no longer be displayed.')}\n`,
    { kind: 'sys.timing', data: { enabled: false } },
  );
}

/**
 * `timing [on | off]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [timingCommand] });
 * ```
 */
export const timingCommand = command_declare({
  name: 'timing',
  grammar: TIMING_GRAMMAR,
  help: {
    summary: 'Toggle or display command timing mode',
    description: 'Shows whether the run time of each command is displayed after it, or turns that on or off.',
    category: 'Settings',
    examples: [
      'timing                # Show current status',
      'timing on             # Enable timing display',
      'timing off            # Disable timing display',
    ],
  },
  handler: timing_run,
});

/**
 * `timing` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `timing`.
 * @returns The timing state, or the refusal of a bad line.
 */
export async function builtin_timing(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(timingCommand, args);
}
