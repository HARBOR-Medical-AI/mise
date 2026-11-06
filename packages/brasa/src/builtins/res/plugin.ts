/**
 * @file Builtin plugin/plugins command.
 *
 * Handles plugin management in chell. Subcommands:
 * - `list`  — fetch and render the plugin collection via chili
 * - `run`   — execute a plugin instance by searchable name/id
 * - `add`, `sync`, `validate`, `index` — registering plugins, in `./plugin.sync.ts`
 *
 * Unknown subcommands fall through to a spawned chili process.
 * `plugin` and `plugins` are both registered as aliases in COMMAND_HANDLERS.
 *
 * @module
 */
import chalk from 'chalk';
import { commandArgs_process, ParsedArgs, cliOptions_extract } from '../utils.js';
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
import {
  PLUGIN_BOOLEAN_FLAGS,
  pluginAdd_run,
  pluginIndexVerb_run,
  pluginSync_run,
  pluginValidate_run,
} from './plugin.sync.js';

export { plugin_addInteractive } from './plugin.sync.js';

/** The plugin verb's subcommands, as its usage line names them. */
const PLUGIN_USAGE: string = 'plugin <list|add|sync|validate|index|info|inspect|search> ...';

/**
 * Handles plugin commands.
 *
 * @param args - command arguments.
 * @returns An envelope carrying the rendered plugin output.
 */
export async function builtin_plugin(args: string[]): Promise<CommandEnvelope> {
  const parsed: ParsedArgs = commandArgs_process(args, { booleanLongOptions: PLUGIN_BOOLEAN_FLAGS });
  const subcommand: string = parsed._[0];

  if (!subcommand) {
     return envelope_ok(`${chalk.red(`Usage: ${PLUGIN_USAGE}`)}\n`);
  }

  try {
    if (subcommand === 'list') {
       const { plugins, selectedFields, totalCount } = await plugins_fetchList(cliOptions_extract(parsed));
       let rendered: string = `${pluginList_render(plugins, selectedFields, { table: !!parsed.table, csv: !!parsed.csv })}\n`;
       if (totalCount !== undefined && plugins.length < totalCount) {
         rendered += `${chalk.dim(`  ↓ showing ${plugins.length} of ${totalCount}  ·  --all to fetch all  ·  --limit <n> for page size`)}\n`;
       }
       return envelope_ok(rendered);
    } else if (subcommand === 'run') {
       // A plugin runs by its name, as a line of its own: `pl-dcm2niix …`
       // runs where the session stands, makes or joins the feed, and answers
       // the run as a model. `plugin run` was a thin pass to CUBE that did
       // none of that.
       exitCode_set(1);
       return envelope_error('', undefined, `${chalk.red('plugin run is retired: run a plugin by its name, where you stand — pl-dcm2niix-v1.0.2 …, or A=$(pl-dcm2niix-v1.0.2 …) to name the run.')}\n`);
    } else if (subcommand === 'add') {
       return await pluginAdd_run(parsed, args);
    } else if (subcommand === 'sync') {
       return await pluginSync_run(parsed, args);
    } else if (subcommand === 'validate') {
       return await pluginValidate_run(parsed);
    } else if (subcommand === 'index') {
       return await pluginIndexVerb_run(parsed);
    } else if (subcommand === 'inspect') {
       const fields: string[] | null = await pluginFields_fetch();
       if (fields && fields.length > 0) {
         return envelope_ok(table_render(fields.map((f: string) => ({ field: f })), ['field'], { title: { title: 'Plugin fields', justification: 'center' } }));
       }
       return envelope_ok(`${chalk.gray('No fields found.')}\n`);
    } else if (subcommand === 'info') {
       return await pluginInfo_show(parsed._.slice(1));
    } else if (subcommand === 'search') {
       const query: string = parsed._[1] ?? '';
       return await builtin_plugin(['list', `--search`, query]);
    }
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.yellow(`Unknown subcommand: ${subcommand}. Usage: ${PLUGIN_USAGE}`)}\n`);
  } catch (e: unknown) {
    const msg: string = e instanceof Error ? e.message : String(e);
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`Plugin error: ${msg}`)}\n`);
  }
}


/**
 * Shows one registered plugin: the manual on the terminal, the whole plugin
 * on the wire.
 *
 * Spelled the way `/bin` spells it — `plugin info pl-dcm2niix-v1.0.0`, or the
 * path itself — with `<name> <version>` accepted for an operator who has the
 * two halves and not the entry name.
 *
 * @param words - The specifier: one `/bin` entry, or a name and a version.
 * @returns An envelope carrying the manual and the `plugin.info` model.
 */
async function pluginInfo_show(words: string[]): Promise<CommandEnvelope> {
  const entry: string | undefined = words[0];
  if (entry === undefined) {
    return envelope_ok(`${chalk.red('Usage: plugin info <name>-v<version> | <name> <version>')}\n`);
  }
  const version: string | undefined = words[1];
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
