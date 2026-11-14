/**
 * @file `pluginmeta`, `pluginmetas`, `meta` and `metas`: CUBE's plugin
 * metas, each a plugin's identity across its versions, listed, searched, and
 * their fields named.
 *
 * Declared in one record (`pluginmetaCommand`, its other names as aliases): the
 * subcommands and the listing options every resource command reads.
 *
 * Key components:
 * - pluginmetaCommand: the declaration, answered under each of its names.
 * - builtin_pluginmeta: the declaration run over words already split.
 *
 * @module
 */
import chalk from 'chalk';
import { pluginMetas_fetchList, PluginMetaListResult } from '@fnndsc/chili/commands/pluginmetas/list.js';
import { pluginMetaFields_fetch } from '@fnndsc/chili/commands/pluginmetas/fields.js';
import { table_render } from '@fnndsc/chili/screen/screen.js';
import type { CLIoptions } from '@fnndsc/chili/utils/cli.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { RESOURCE_LIST_OPTIONS_GRAMMAR, resourceListBag_build } from './resourceList.js';

/**
 * Lists the plugin metas a listing's options ask for.
 *
 * @param options - The bag chili's listing reads.
 * @returns The table, or that there are none, or the error.
 */
async function pluginmetaList_render(options: CLIoptions): Promise<CommandEnvelope> {
  try {
    const { pluginMetas, selectedFields, totalCount }: PluginMetaListResult = await pluginMetas_fetchList(options);
    if (pluginMetas.length === 0) { return envelope_ok(`${chalk.gray('No plugin metas found.')}\n`); }
    return envelope_ok(table_render(pluginMetas, selectedFields, { title: { title: 'Plugin Metas', justification: 'center' }, pagination: totalCount !== undefined ? { shown: pluginMetas.length, total: totalCount } : undefined }));
  } catch (e: unknown) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`pluginmeta error: ${e instanceof Error ? e.message : String(e)}`)}\n`);
  }
}

/**
 * Names the fields a plugin meta has.
 *
 * @returns The fields' table, or that there are none.
 */
async function pluginmetaFields_render(): Promise<CommandEnvelope> {
  const fields: string[] | null = await pluginMetaFields_fetch();
  if (fields && fields.length > 0) {
    return envelope_ok(table_render(fields.map((f: string) => ({ field: f })), ['field'], { title: { title: 'Plugin Meta fields', justification: 'center' } }));
  }
  return envelope_ok(`${chalk.gray('No fields found for plugin metas.')}\n`);
}

/** What a `pluginmeta` line may hold. */
const PLUGINMETA_GRAMMAR = {
  bare: { summary: 'List the plugin metas, as list does', options: RESOURCE_LIST_OPTIONS_GRAMMAR },
  subcommands: {
    list: { summary: 'List the plugin metas, 20 to a page', options: RESOURCE_LIST_OPTIONS_GRAMMAR },
    search: {
      summary: 'List the plugin metas a filter matches (list --search <term>)',
      operands: [{ name: 'term', kind: 'word', summary: 'The filter, field:value (inspect names the fields)' }],
      options: RESOURCE_LIST_OPTIONS_GRAMMAR,
    },
    inspect: { summary: 'Name the fields a plugin meta has' },
  },
} as const satisfies CommandGrammar;

/**
 * Runs one `pluginmeta` line.
 *
 * @param args - The line, parsed.
 * @returns The listing, the fields, or the error.
 */
async function pluginmeta_run(args: CommandArguments<typeof PLUGINMETA_GRAMMAR>): Promise<CommandEnvelope> {
  switch (args.subcommand) {
    case null:
    case 'list': return pluginmetaList_render(resourceListBag_build(args.options));
    case 'search': return pluginmetaList_render(resourceListBag_build(args.options, args.operands.term));
    case 'inspect': return pluginmetaFields_render();
  }
}

/**
 * `pluginmeta [[listing options] | list [listing options] | search <term> [listing options] | inspect]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [pluginmetaCommand] }, 'backend');
 * ```
 */
export const pluginmetaCommand = command_declare({
  name: 'pluginmeta',
  aliases: ['pluginmetas', 'meta', 'metas'],
  grammar: PLUGINMETA_GRAMMAR,
  help: {
    summary: "CUBE's plugin metas, each a plugin across its versions: list them, search them, name their fields",
    description: 'List the plugin metas in CUBE, a page at a time or every page, filtered by a field:value search and in the columns asked for; inspect names the fields a plugin meta has. A plugin meta is a tool across its versions (pl-dircopy); a plugin is one version of it. pluginmeta, pluginmetas, meta and metas are one command.',
    category: 'Resources',
    examples: ['pluginmetas list', 'pluginmetas search name:dircopy', 'metas list --fields name,category', 'meta inspect'],
  },
  handler: pluginmeta_run,
});

/**
 * `pluginmeta` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `pluginmeta`.
 * @returns The answer, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_pluginmeta(['search', 'name:dircopy']);
 * ```
 */
export async function builtin_pluginmeta(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(pluginmetaCommand, args);
}
