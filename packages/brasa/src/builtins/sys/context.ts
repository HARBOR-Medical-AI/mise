/**
 * @file `context`: the session's ChRIS context as a table: user, CUBE,
 * folder, feed, plugin, PACS server and physical mode.
 *
 * Declared in one record (`contextCommand`): it takes no operand or option.
 *
 * Key components:
 * - contextCommand: the declaration.
 * - builtin_context: the declaration run over words already split.
 *
 * Typical usage:
 * ```ts
 * await builtin_context([]);
 * ```
 *
 * Dependencies: salsa's context; chili's table.
 *
 * @module
 */
import chalk from 'chalk';
import { context_getSingle } from '@fnndsc/salsa';
import { session } from '../../session/index.js';
import { SingleContext } from '@fnndsc/cumin';
import { table_render } from '@fnndsc/chili/screen/screen.js';
import { CommandEnvelope, envelope_ok } from '@fnndsc/menu';
import { command_declare, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** A single context key/value row for tabular display. */
interface ContextRow {
  Context: string;
  Value: string;
  [key: string]: string;
}

/** What a `context` line may hold: nothing after the command. */
const CONTEXT_GRAMMAR = {} as const satisfies CommandGrammar;

/**
 * `context`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [contextCommand] }, 'backend');
 * ```
 */
export const contextCommand = command_declare({
  name: 'context',
  grammar: CONTEXT_GRAMMAR,
  help: {
    summary: 'Display current ChRIS context information',
    description: "Shows the session's ChRIS context as a table: the user, the CUBE URL, the folder, feed and plugin, the PACS server, and whether physical mode is on.",
    category: 'Connection',
    examples: ['context'],
  },
  handler: async (): Promise<CommandEnvelope> => context_run(),
});

/**
 * `context` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `context`: none.
 * @returns The context table, or the refusal of a bad line.
 */
export async function builtin_context(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(contextCommand, args);
}

/**
 * Displays the current ChRIS context.
 *
 * @returns The context as a table.
 */
async function context_run(): Promise<CommandEnvelope> {
  const context: SingleContext = await context_getSingle();

  const tableData: ContextRow[] = [
    {
      Context: 'ChRIS User',
      Value: context.user || chalk.gray('Not set'),
    },
    {
      Context: 'ChRIS URL',
      Value: context.URL || chalk.gray('Not set'),
    },
    {
      Context: 'ChRIS Folder',
      Value: context.folder || chalk.gray('Not set'),
    },
    {
      Context: 'ChRIS Feed',
      Value: context.feed || chalk.gray('Not set'),
    },
    {
      Context: 'ChRIS Plugin',
      Value: context.plugin || chalk.gray('Not set'),
    },
    {
      Context: 'PACS Server',
      Value: context.pacsserver || chalk.gray('Not set'),
    },
    {
      Context: 'Physical Mode',
      Value: session.physicalMode_get() ? chalk.magenta('Enabled') : chalk.gray('Disabled'),
    },
  ];

  return envelope_ok(
    table_render(tableData, ['Context', 'Value'], {
      title: { title: 'ChRIS Context', justification: 'center' },
    }),
  );
}
