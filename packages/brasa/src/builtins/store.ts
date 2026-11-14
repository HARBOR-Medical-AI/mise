/**
 * @file `store`: the peer store, another ChRIS whose plugins this CUBE can
 * install. Browse and search it, install a plugin from it, and say, set or
 * reset which store it is.
 *
 * Declared in one record (`storeCommand`): the subcommands, their operands
 * and options.
 *
 * Key components:
 * - storeCommand: the declaration.
 * - builtin_store: the declaration run over words already split.
 *
 * @module
 */
import chalk from 'chalk';
import type { ParsedArgs } from './utils.js';
import { store_listPlugins, store_searchPlugins } from '@fnndsc/chili/commands/store/list.js';
import { grid_render, long_render } from '@fnndsc/chili/views/ls.js';
import { spinner } from '../lib/spinner.js';
import { plugin_addInteractive } from './res/plugin.js';
import { type ListingItem, type CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import {
  DEFAULT_STORE_URL,
  storeUrl_get,
  storeUrl_isDefault,
  storeUrl_set,
  storeUrl_clear,
  storeConfig_persist,
} from '../config/storeConfig.js';
import { errorStack, type Result } from '@fnndsc/fond';
import { exitCode_set } from '../core/handlerRun.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../core/commandDeclaration.js';
import { declaredCommand_run } from '../core/commandParse.js';

/**
 * Renders a store fetch failure as an error envelope, draining the reason the
 * fetch pushed onto the error stack.
 *
 * @param fallback - Message used when the stack holds no detail.
 * @returns An error envelope with the failure on the err channel.
 */
function storeFailure_envelope(fallback: string): CommandEnvelope {
  const lastError = errorStack.stack_pop();
  const detail: string = lastError ? lastError.message : fallback;
  exitCode_set(1);
  return envelope_error('', undefined, `${chalk.red(detail)}\n`);
}

/**
 * The store's plugins as a listing draws them: a grid, or one per line with `-l`.
 *
 * @param items - The plugins.
 * @param long - Whether to draw one per line.
 * @returns The listing.
 */
function storeItems_render(items: ListingItem[], long: boolean): string {
  return long ? `${long_render(items, { human: false })}\n` : `${grid_render(items)}\n`;
}

/** What a `store` line may hold. */
const STORE_GRAMMAR = {
  options: {
    store: { long: 'store', summary: 'Ask this peer store instead of the one set (store inspect names it)', value: { name: 'url', kind: 'word' } },
  },
  subcommands: {
    list: { summary: "Browse every plugin in the peer store", options: { long: { short: 'l', summary: 'One plugin per line, with its details' } } },
    search: {
      summary: 'Search the peer store\'s plugins by name',
      operands: [{ name: 'query', kind: 'word', summary: 'Part of a plugin name' }],
      options: { long: { short: 'l', summary: 'One plugin per line, with its details' } },
    },
    install: {
      summary: 'Install a plugin from the peer store into this CUBE (an administrator: sudo store install …)',
      operands: [{ name: 'plugin', kind: 'word', summary: 'The plugin: its name, name-vVersion, or its image' }],
      options: { compute: { long: 'compute', summary: 'The compute resources it runs on, comma-separated', value: { name: 'names', kind: 'compute' } } },
    },
    inspect: { summary: 'Name the peer store, and whether it is the default' },
    set: { summary: 'Set the peer store (kept in ~/.config/chell/settings.json)', operands: [{ name: 'url', kind: 'word', summary: "The store's API URL" }] },
    reset: { summary: `Set the peer store back to the default (${DEFAULT_STORE_URL})` },
  },
} as const satisfies CommandGrammar;

/**
 * Runs one `store` line.
 *
 * @param args - The line, parsed.
 * @returns The answer, or the error.
 */
async function store_run(args: CommandArguments<typeof STORE_GRAMMAR>): Promise<CommandEnvelope> {
  const storeOptions = { store: args.options.store };
  try {
    spinner.start('Fetching from store...');
    switch (args.subcommand) {
      case 'list': {
        const listResult: Result<ListingItem[]> = await store_listPlugins(storeOptions);
        spinner.stop();
        if (!listResult.ok) return storeFailure_envelope('store list failed');
        if (listResult.value.length === 0) return envelope_ok('No plugins found in store.\n');
        return envelope_ok(storeItems_render(listResult.value, args.options.long));
      }
      case 'search': {
        const query: string = args.operands.query;
        const searchResult: Result<ListingItem[]> = await store_searchPlugins(query, storeOptions);
        spinner.stop();
        if (!searchResult.ok) return storeFailure_envelope(`store search failed for '${query}'`);
        if (searchResult.value.length === 0) return envelope_ok(`No plugins found matching '${query}'.\n`);
        return envelope_ok(storeItems_render(searchResult.value, args.options.long));
      }
      case 'install': {
        spinner.stop();
        // The add is the plugin verb's, which reads its words as parsed.
        const install: ParsedArgs = {
          _: ['install', args.operands.plugin],
          ...(args.options.compute !== undefined ? { compute: args.options.compute } : {}),
          ...(args.options.store !== undefined ? { store: args.options.store } : {}),
        };
        return await plugin_addInteractive(install);
      }
      case 'inspect': {
        spinner.stop();
        const current: string = storeUrl_get();
        const isDefault: boolean = storeUrl_isDefault();
        return envelope_ok(`${chalk.bold('Peer store URL:')} ${chalk.blue(current)}${isDefault ? chalk.gray(' (default)') : chalk.yellow(' (custom)')}\n`);
      }
      case 'set': {
        spinner.stop();
        storeUrl_set(args.operands.url);
        await storeConfig_persist();
        return envelope_ok(`${chalk.green(`Store URL set to: ${chalk.blue(args.operands.url)}`)}\n`);
      }
      case 'reset': {
        spinner.stop();
        storeUrl_clear();
        await storeConfig_persist();
        return envelope_ok(`${chalk.green(`Store URL reset to default: ${chalk.blue(DEFAULT_STORE_URL)}`)}\n`);
      }
    }
  } catch (e: unknown) {
    spinner.stop();
    const msg: string = e instanceof Error ? e.message : String(e);
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`Store error: ${msg}`)}\n`);
  }
}

/**
 * `store <list | search <query> | install <plugin> | inspect | set <url> | reset>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [storeCommand] }, 'backend');
 * ```
 */
export const storeCommand = command_declare({
  name: 'store',
  grammar: STORE_GRAMMAR,
  help: {
    summary: 'The peer store: browse and search its plugins, install one, say or set which store it is',
    description: "The peer store is another ChRIS, by default cube.chrisproject.org, whose plugins this CUBE can install; it is not a resource of this CUBE, so the resource listing options do not apply. list and search browse it; install registers one of its plugins here, on the compute resources --compute names, and needs an administrator (sudo store install …); inspect names the store, set and reset change it.",
    category: 'Resources',
    examples: [
      'store list',
      'store search dicom',
      'store install pl-dcm2niix',
      'store install pl-dcm2niix-v1.2.3',
      'store install fnndsc/pl-dcm2niix:1.2.3',
      'store install pl-dcm2niix --compute moc',
      'store inspect',
      'store set https://my-cube.org/api/v1/',
      'store reset',
    ],
  },
  handler: store_run,
});

/**
 * `store` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `store`.
 * @returns The answer, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_store(['search', 'dicom']);
 * ```
 */
export async function builtin_store(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(storeCommand, args);
}
