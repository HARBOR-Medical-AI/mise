/**
 * @file `debug`: shows or sets the backend's debug mode (verbose error
 * logging).
 *
 * Declared in one record (`debugCommand`): `on` and `off` are its
 * subcommands; with neither it says how it stands.
 *
 * Key components:
 * - debugCommand: the declaration.
 * - builtin_debug: the declaration run over words already split.
 *
 * Typical usage:
 * ```ts
 * await builtin_debug(['on']);
 * ```
 *
 * Dependencies: the installed backend's debug flag.
 *
 * @module
 */
import chalk from 'chalk';
import { backendInstalled_get, type Backend } from '../core/backend.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../core/commandDeclaration.js';
import { declaredCommand_run } from '../core/commandParse.js';

/** What a `debug` line may hold. */
const DEBUG_GRAMMAR = {
  bare: { summary: 'Show whether debug mode is on' },
  subcommands: {
    on: { summary: 'Enable debug logging' },
    off: { summary: 'Disable debug logging' },
  },
} as const satisfies CommandGrammar;

/**
 * Shows or sets debug mode.
 *
 * @param args - The line, parsed: `on`, `off`, or neither.
 * @returns An envelope describing the (possibly updated) debug state.
 */
async function debug_run(args: CommandArguments<typeof DEBUG_GRAMMAR>): Promise<CommandEnvelope> {
  const backend: Backend | null = backendInstalled_get();
  if (backend?.debug_get === undefined || backend.debug_set === undefined) {
    return envelope_error('', undefined, `${chalk.red('debug: this session has no debug mode.')}\n`);
  }
  const enabledNow: boolean | null = backend.debug_get();

  if (enabledNow === null) {
    return envelope_error(
      '',
      [{ type: 'error', message: 'Error: Connection configuration not initialized.' }],
      `${chalk.red('Error: Connection configuration not initialized.')}\n`,
    );
  }

  if (args.subcommand === null) {
    const enabled: boolean = enabledNow;
    const status: string = enabled ? 'enabled' : 'disabled';
    const detail: string = enabled
      ? chalk.gray('  Verbose error logging is enabled.')
      : chalk.gray('  Verbose error logging is disabled.');
    return envelope_ok(
      `Debug mode: ${chalk.yellow(status)}\n${detail}\n${chalk.gray('\nUsage: debug [on|off]')}\n`,
      { kind: 'sys.debug', data: { enabled } },
    );
  }

  if (args.subcommand === 'on') {
    backend.debug_set(true);
    return envelope_ok(
      `${chalk.yellow('[!] Debug mode enabled')}\n${chalk.gray('    Verbose error logging activated.')}\n`,
      { kind: 'sys.debug', data: { enabled: true } },
    );
  }

  backend.debug_set(false);
  return envelope_ok(
    `${chalk.green('[+] Debug mode disabled')}\n${chalk.gray('    Verbose error logging deactivated.')}\n`,
    { kind: 'sys.debug', data: { enabled: false } },
  );
}

/**
 * `debug [on | off]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [debugCommand] });
 * ```
 */
export const debugCommand = command_declare({
  name: 'debug',
  grammar: DEBUG_GRAMMAR,
  help: {
    summary: 'Toggle or display debug mode (verbose logging)',
    description: "Shows whether the session's debug mode, verbose error logging, is on, or turns it on or off. A session whose backend has no debug mode says so.",
    category: 'Settings',
    examples: [
      'debug                 # Show current status',
      'debug on              # Enable debug mode',
      'debug off             # Disable debug mode',
    ],
  },
  handler: debug_run,
});

/**
 * `debug` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `debug`.
 * @returns The debug state, or the refusal of a bad line.
 */
export async function builtin_debug(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(debugCommand, args);
}
