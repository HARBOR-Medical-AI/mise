/**
 * @file `parametersofplugin`: the parameters a plugin takes, as a manual
 * page, or the fields a parameter has.
 *
 * A plugin's own `/bin` entry reads them too: `pl-dircopy-v2.1.1 --parameters`
 * asks this command for the plugin it names.
 *
 * Declared in one record (`parametersofpluginCommand`).
 *
 * Key components:
 * - parametersofpluginCommand: the declaration.
 * - builtin_parametersofplugin: the declaration run over words already split.
 *
 * @module
 */

import chalk from 'chalk';
import type { CLIoptions } from '@fnndsc/chili/utils/cli.js';
import { PluginContextGroupHandler } from '@fnndsc/chili/plugins/pluginGroupHandler.js';
import { type CommandEnvelope, envelope_error } from '@fnndsc/menu';
import { exitCode_set } from '../core/handlerRun.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../core/commandDeclaration.js';
import { declaredCommand_run } from '../core/commandParse.js';

/** What a `parametersofplugin` line may hold. */
const PARAMETERSOFPLUGIN_GRAMMAR = {
  options: {
    pluginId: { long: 'plugin-id', summary: "The plugin's id; without it, the plugin of the current context", value: { name: 'id', kind: 'int', min: 1 } },
  },
  subcommands: {
    list: {
      summary: "The plugin's parameters, as a manual page",
      options: {
        limit: { long: 'limit', summary: 'At most this many (default 20)', value: { name: 'n', kind: 'int', min: 1 } },
        offset: { long: 'offset', summary: 'Start this many in', value: { name: 'n', kind: 'int', min: 0 } },
        fields: { long: 'fields', summary: 'The fields to show, comma-separated (fieldslist names them)', value: { name: 'field,…', kind: 'word' } },
        search: { long: 'search', summary: 'Filter by field:value, comma-separated', value: { name: 'field:value', kind: 'word' } },
      },
    },
    fieldslist: { summary: 'Name the fields a parameter has' },
  },
} as const satisfies CommandGrammar;

/**
 * Runs one `parametersofplugin` line.
 *
 * @param args - The line, parsed.
 * @returns The parameters or the fields, or the error.
 */
async function parametersofplugin_run(args: CommandArguments<typeof PARAMETERSOFPLUGIN_GRAMMAR>): Promise<CommandEnvelope> {
  try {
    const handler: PluginContextGroupHandler = await PluginContextGroupHandler.handler_create('parametersofplugin', args.options.pluginId);
    if (args.subcommand === 'fieldslist') return await handler.parameters_fieldsRender();
    const { limit, offset, fields, search } = args.options;
    const options: CLIoptions = {
      ...(limit !== undefined ? { limit: String(limit) } : {}),
      ...(offset !== undefined ? { offset: String(offset) } : {}),
      ...(fields !== undefined ? { fields } : {}),
      ...(search !== undefined ? { search } : {}),
    };
    return await handler.parameters_listManRender(options);
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`Error in parametersofplugin: ${msg}`)}\n`);
  }
}

/**
 * `parametersofplugin [--plugin-id <id>] <list | fieldslist>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [parametersofpluginCommand] }, 'backend');
 * ```
 */
export const parametersofpluginCommand = command_declare({
  name: 'parametersofplugin',
  grammar: PARAMETERSOFPLUGIN_GRAMMAR,
  help: {
    summary: 'The parameters a plugin takes, as a manual page',
    description: "List a plugin's parameters as a manual page: each flag, its type, its default and its help. --plugin-id names the plugin by its id; without it, the plugin of the current context is read. fieldslist names the fields a parameter has. A plugin's /bin entry answers the same: pl-dircopy-v2.1.1 --parameters.",
    category: 'Resources',
    examples: ['parametersofplugin list --plugin-id 42', 'parametersofplugin fieldslist', 'pl-dircopy-v2.1.1 --parameters'],
  },
  handler: parametersofplugin_run,
});

/**
 * `parametersofplugin` over words already split: the declaration's parse and handler.
 *
 * @param args - Arguments passed to the command.
 * @returns An envelope carrying the rendered parameters or fields.
 *
 * @example
 * ```ts
 * await builtin_parametersofplugin(['list', '--plugin-id', '42']);
 * ```
 */
export async function builtin_parametersofplugin(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(parametersofpluginCommand, args);
}
