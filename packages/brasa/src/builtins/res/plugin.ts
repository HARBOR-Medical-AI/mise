/**
 * @file `plugin` and `plugins`: the plugins registered in CUBE, listed,
 * searched, read whole, and registered.
 *
 * Declared in one record (`pluginCommand`, `plugins` an alias and a read):
 * `list`, `search` and `inspect` read the collection; `info` reads one
 * version whole; `add`, `sync`, `validate` and `index` register plugins
 * (`./plugin.sync.ts`). A plugin RUNS by its name, as a `/bin` line of its
 * own; `plugin run` says so and runs nothing.
 *
 * Key components:
 * - pluginCommand: the declaration.
 * - builtin_plugin: the declaration run over words already split.
 *
 * @module
 */
import chalk from 'chalk';
import { plugins_fetchList } from '@fnndsc/chili/commands/plugins/list.js';
import { pluginFields_fetch } from '@fnndsc/chili/commands/plugins/fields.js';
import { pluginList_render } from '@fnndsc/chili/views/plugin.js';
import { table_render } from '@fnndsc/chili/screen/screen.js';
import { PLUGIN_INFO_MODEL_KIND, type PluginInfoModel, type CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import {
  pluginInfo_build,
  pluginInfoText_render,
  pluginSpecifier_parse,
  type PluginSpecifier,
} from './plugin.info.js';
import { errorStack, type Result } from '@fnndsc/fond';
import { exitCode_set } from '../../core/handlerRun.js';
import { command_declare, type CommandArguments, type CommandGrammar, type SubcommandArguments } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import type { ParsedArgs } from '../utils.js';
import { RESOURCE_LIST_OPTIONS_GRAMMAR, resourceListBag_build } from './resourceList.js';
import {
  pluginAdd_run,
  pluginIndexVerb_run,
  pluginSync_run,
  pluginValidate_run,
} from './plugin.sync.js';

export { plugin_addInteractive } from './plugin.sync.js';

/** A source of plugin descriptors, as sync and validate read one. */
const SOURCE_OPERAND = {
  name: 'source',
  kind: 'word',
  optional: true,
  summary: 'owner/repo[@ref] on GitHub, a CUBE path (cube:<path>: a directory of .json, or a .tar.gz), or host:<path>',
} as const;

/** What a `plugin` line may hold. */
const PLUGIN_GRAMMAR = {
  subcommands: {
    list: { summary: 'List the plugins, 20 to a page', options: RESOURCE_LIST_OPTIONS_GRAMMAR },
    search: {
      summary: 'List the plugins a filter matches (list --search <term>)',
      operands: [{ name: 'term', kind: 'word', optional: true, summary: 'The filter: a name, field:value, id:42, or id:77++id:33' }],
      options: RESOURCE_LIST_OPTIONS_GRAMMAR,
    },
    inspect: { summary: 'Name the fields a plugin has' },
    info: {
      summary: 'Show one plugin version whole: its facts and every parameter',
      operands: [
        { name: 'plugin', kind: 'plugin', summary: 'The version as /bin names it, <name>-v<version>; or the name, with the version after' },
        { name: 'version', kind: 'word', optional: true, summary: 'The version, when the plugin is given by name' },
      ],
    },
    add: {
      summary: 'Register a plugin: by name or image (the peer store, then the image), a plugin URL in another CUBE, or a descriptor file',
      operands: [{ name: 'input', kind: 'word', optional: true, unless: 'json', summary: 'A plugin name, a Docker image, or a plugin URL in another CUBE' }],
      options: {
        json: { long: 'json', summary: 'Register one descriptor file: a host path, or cube:<path> for one in CUBE', value: { name: 'file', kind: 'word' } },
        compute: { long: 'compute', summary: 'The compute resources to register it on, comma-separated (default: all)', value: { name: 'resources', kind: 'compute' } },
        store: { long: 'store', summary: 'The peer store to look in (default: cube.chrisproject.org)', value: { name: 'url', kind: 'word' } },
        adminUser: { long: 'adminUser', summary: 'An administrator to act as (sudo asks instead)', value: { name: 'username', kind: 'word' } },
        adminPassword: { long: 'adminPassword', summary: "That administrator's password (sudo asks instead)", value: { name: 'password', kind: 'word' } },
        publicRepo: { long: 'publicRepo', summary: "The plugin's public repository", value: { name: 'url', kind: 'word' } },
      },
    },
    sync: {
      summary: 'Fill this CUBE from a plugin index: show the plan, ask, register what is missing',
      operands: [SOURCE_OPERAND],
      options: {
        ref: { long: 'ref', summary: 'Pin the index at a tag or commit', value: { name: 'ref', kind: 'word' } },
        plan: { long: 'plan', summary: 'Show the plan and stop' },
        yes: { long: 'yes', summary: 'Apply the plan without asking' },
        compute: { long: 'compute', summary: 'Register on these compute resources (default: all of them)', value: { name: 'resources', kind: 'compute' } },
      },
    },
    validate: {
      summary: 'Check descriptors without a CUBE',
      operands: [{ ...SOURCE_OPERAND, summary: 'A descriptor file or directory (a host path), owner/repo[@ref], or cube:<path>' }],
      options: {
        ref: { long: 'ref', summary: 'Pin the index at a tag or commit', value: { name: 'ref', kind: 'word' } },
        offline: { long: 'offline', summary: 'Skip rule 5, the registry lookups; the report says it was not checked' },
      },
    },
    index: {
      summary: 'Show or set the index sync reads',
      operands: [{ name: 'source', kind: 'word', optional: true, summary: 'owner/repo[@ref] to read from now on' }],
      options: { reset: { long: 'reset', summary: 'Restore FNNDSC/chris-plugins@main' } },
    },
    run: {
      summary: 'Retired: a plugin runs by its name, as a line of its own',
      operands: [{ name: 'words', kind: 'word', optional: true, repeat: true, summary: 'Anything; nothing runs' }],
      // The line it once took (`plugin run pl-x --dir a`) is read, so the refusal says how a plugin runs now.
      options: { anything: { long: '<option>', summary: 'Any option the old line took; nothing runs', value: { name: 'value', kind: 'word' }, family: { pattern: /^.+$/ } } },
    },
  },
} as const satisfies CommandGrammar;

/** The options sync and validate read, as their bag holds them. */
type BagValue = string | boolean | string[];

/**
 * The bag a registering verb reads: its subcommand and operand as `_`, its
 * options by name, those not given left out.
 *
 * @param subcommand - The subcommand.
 * @param operand - Its operand, if given.
 * @param options - Its options.
 * @returns The bag.
 */
function syncBag_make(subcommand: string, operand: string | undefined, options: Readonly<Record<string, BagValue | number | undefined>>): ParsedArgs {
  const bag: ParsedArgs = { _: operand === undefined ? [subcommand] : [subcommand, operand] };
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === false) continue;
    bag[key] = typeof value === 'number' ? String(value) : value;
  }
  return bag;
}

/**
 * The words a registering line read as, for the `sudo` hint a refusal ends with.
 *
 * @param bag - The bag.
 * @returns The words after `plugin`.
 */
function bagWords_render(bag: ParsedArgs): string[] {
  const words: string[] = [...bag._];
  for (const [key, value] of Object.entries(bag)) {
    if (key === '_') continue;
    if (value === true) words.push(`--${key}`);
    else if (typeof value === 'string') words.push(`--${key}`, value);
  }
  return words;
}

/**
 * Lists the plugins a listing's options ask for.
 *
 * @param args - The `list` or `search` line.
 * @param search - The filter, for `search`.
 * @returns The table, with a hint when it shows one page of more.
 */
async function pluginList_show(args: SubcommandArguments<typeof PLUGIN_GRAMMAR, 'list' | 'search'>, search?: string): Promise<CommandEnvelope> {
  const { plugins, selectedFields, totalCount } = await plugins_fetchList(resourceListBag_build(args.options, search));
  let rendered: string = `${pluginList_render(plugins, selectedFields, { table: args.options.table, csv: args.options.csv })}\n`;
  if (totalCount !== undefined && plugins.length < totalCount) {
    rendered += `${chalk.dim(`  ↓ showing ${plugins.length} of ${totalCount}  ·  --all to fetch all  ·  --limit <n> for page size`)}\n`;
  }
  return envelope_ok(rendered);
}

/**
 * Names the fields a plugin has.
 *
 * @returns The fields' table, or that there are none.
 */
async function pluginFields_show(): Promise<CommandEnvelope> {
  const fields: string[] | null = await pluginFields_fetch();
  if (fields && fields.length > 0) {
    return envelope_ok(table_render(fields.map((f: string) => ({ field: f })), ['field'], { title: { title: 'Plugin fields', justification: 'center' } }));
  }
  return envelope_ok(`${chalk.gray('No fields found.')}\n`);
}

/**
 * Runs one `plugin` line.
 *
 * @param args - The line, parsed.
 * @returns What the subcommand answers.
 */
async function pluginLine_run(args: CommandArguments<typeof PLUGIN_GRAMMAR>): Promise<CommandEnvelope> {
  try {
    switch (args.subcommand) {
      case 'list': return await pluginList_show(args);
      case 'search': return await pluginList_show(args, args.operands.term ?? '');
      case 'inspect': return await pluginFields_show();
      case 'info': return await pluginInfo_show(args.operands.plugin, args.operands.version);
      case 'add': {
        const bag: ParsedArgs = syncBag_make('add', args.operands.input, args.options);
        return await pluginAdd_run(bag, bagWords_render(bag));
      }
      case 'sync': {
        const bag: ParsedArgs = syncBag_make('sync', args.operands.source, args.options);
        return await pluginSync_run(bag, bagWords_render(bag));
      }
      case 'validate': return await pluginValidate_run(syncBag_make('validate', args.operands.source, args.options));
      case 'index': return await pluginIndexVerb_run(syncBag_make('index', args.operands.source, args.options));
      case 'run':
        // A plugin runs by its name, as a line of its own: `pl-dcm2niix …`
        // runs where the session stands, makes or joins the feed, and answers
        // the run as a model. `plugin run` was a thin pass to CUBE that did
        // none of that.
        exitCode_set(1);
        return envelope_error('', undefined, `${chalk.red('plugin run is retired: run a plugin by its name, where you stand — pl-dcm2niix-v1.0.2 …, or A=$(pl-dcm2niix-v1.0.2 …) to name the run.')}\n`);
    }
  } catch (e: unknown) {
    const msg: string = e instanceof Error ? e.message : String(e);
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`Plugin error: ${msg}`)}\n`);
  }
}

/**
 * `plugin <list|search|inspect|info|add|sync|validate|index> …`: the
 * declaration. `plugins` is the same command, and a read.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [pluginCommand] }, 'backend');
 * ```
 */
export const pluginCommand = command_declare({
  name: 'plugin',
  aliases: [{ name: 'plugins', holds: [] }],
  grammar: PLUGIN_GRAMMAR,
  help: {
    summary: 'The plugins registered in CUBE: list them, search them, read one whole, register them',
    description: "Plugins are CUBE's computational units. List them a page at a time or every page, filter them by a searchable (pl-dircopy, name:dcm2niix, id:42, id:77++id:33), name their fields, or read one version whole: its facts and every parameter, the manual cat /bin/<entry> prints. add registers one plugin by name or image (the peer store first, then the image), by a plugin URL in another CUBE, or from a descriptor file; sync fills this CUBE from a plugin index (owner/repo[@ref] on GitHub, a CUBE path, or host:<path>), showing the plan and asking first, never deleting or changing a plugin already there; validate checks descriptors without a CUBE (rules: 1 schema, 2 CUBE upload rules, 3 file name is the name, 4 no case clash, 5 images resolve); index shows or sets the index sync reads. Anyone may see a plan; registering needs an administrator (sudo). A plugin RUNS by its name, as a line of its own, where the session stands: pl-dcm2niix-v1.0.2 … (help <plugin> for its options). plugin and plugins are one command.",
    category: 'Resources',
    examples: [
      'plugins list',
      'plugins list --search name:dircopy --fields name,version,dock_image',
      'plugin search pl-dircopy',
      'plugin search id:42',
      'plugin info pl-dircopy-v1.0.0',
      'plugin info pl-dircopy 1.0.0',
      'plugins inspect',
      'sudo plugin add pl-dircopy',
      'sudo plugin add fnndsc/pl-dircopy:2.1.1 --compute host',
      'sudo plugin add --json ./pl-dircopy.json',
      'plugin sync --plan',
      'sudo plugin sync FNNDSC/chris-plugins --ref 8c9a1f6',
      'plugin validate ./plugins --offline',
      'plugin index',
      'A=$(pl-dcm2niix-v1.0.2)               # run a plugin where you stand, and name the run',
    ],
  },
  handler: pluginLine_run,
});

/**
 * `plugin` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `plugin`.
 * @returns The answer, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_plugin(['search', 'name:dircopy']);
 * ```
 */
export async function builtin_plugin(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(pluginCommand, args);
}

/**
 * Shows one registered plugin: the manual on the terminal, the whole plugin
 * on the wire.
 *
 * Spelled the way `/bin` spells it — `plugin info pl-dcm2niix-v1.0.0`, or the
 * path itself — with `<name> <version>` accepted for an operator who has the
 * two halves and not the entry name.
 *
 * @param entry - One `/bin` entry, or a plugin's name.
 * @param version - The version, when the entry is a name.
 * @returns An envelope carrying the manual and the `plugin.info` model.
 */
async function pluginInfo_show(entry: string, version: string | undefined): Promise<CommandEnvelope> {
  const specifier: PluginSpecifier | null = version === undefined
    ? pluginSpecifier_parse(entry)
    : { name: entry.replace(/^.*\//, ''), version, command: `${entry.replace(/^.*\//, '')}-v${version}` };
  if (specifier === null) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`Not a versioned plugin entry: ${entry}. Spell it '<name>-v<version>'.`)}\n`);
  }

  const built: Result<PluginInfoModel> = await pluginInfo_build(specifier);
  if (!built.ok) {
    const problem: { message: string } | undefined = errorStack.stack_pop();
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(problem?.message ?? 'Plugin not found.')}\n`);
  }
  return envelope_ok(pluginInfoText_render(built.value), {
    kind: PLUGIN_INFO_MODEL_KIND,
    data: built.value,
  });
}
