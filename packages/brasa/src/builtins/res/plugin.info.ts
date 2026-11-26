/**
 * @file One registered plugin, as data — and the manual as a projection of it.
 *
 * A plugin is the one-node case of the compute graph, and until now its
 * substance existed only as a rendered manual: `cat /bin/<plugin>` scraped
 * CUBE and printed a table, and that table was the whole of what any surface
 * could have. Nothing downstream could use it — not a card, not a parameter
 * list, not a form.
 *
 * This module builds the model first and renders from it, so the text a
 * terminal prints and the data a graphical surface reads are the same facts
 * said twice rather than two independent scrapes that can disagree.
 *
 * Parameters are drained to exhaustion. The `{ limit: 100 }` this replaces
 * dropped the tail of any plugin declaring more and said nothing about it —
 * and a parameter table that stops early is worse than no table, because it
 * still looks complete.
 *
 * @module
 */
import chalk from 'chalk';
import { Client, plugin_find, pluginParameters_drain, type PluginFound, type PluginParameterData } from '@fnndsc/cumin';
import { type PluginInfoModel, type PluginParameter } from '@fnndsc/menu';
import { session } from '../../session/index.js';
import { errorStack, type Result, Ok, Err } from '@fnndsc/fond';

/** How a `/bin` entry names a plugin: `<name>-v<version>`. */
const BIN_VERSION_SEPARATOR: string = '-v';

/** A plugin's identity, as a `/bin` entry or a command line spells it. */
export interface PluginSpecifier {
  name: string;
  version: string;
  /** The `/bin` basename that runs it. */
  command: string;
}

/**
 * Splits a `/bin` entry name into the plugin identity it addresses.
 *
 * @param entry - A `/bin` basename or full path (`pl-dcm2niix-v1.0.0`).
 * @returns The name and version, or null when the entry names no version.
 */
export function pluginSpecifier_parse(entry: string): PluginSpecifier | null {
  const command: string = entry.replace(/^.*\//, '');
  const cut: number = command.lastIndexOf(BIN_VERSION_SEPARATOR);
  if (cut === -1) return null;
  const name: string = command.substring(0, cut);
  const version: string = command.substring(cut + BIN_VERSION_SEPARATOR.length);
  if (name === '' || version === '') return null;
  return { name, version, command };
}

/**
 * Projects one wire parameter row onto the model's parameter shape.
 *
 * @param row - The parameter as CUBE serves it.
 * @returns The typed parameter.
 */
function parameter_project(row: PluginParameterData): PluginParameter {
  const name: string = row.name;
  const declaredFlag: unknown = row.flag;
  const flag: string = typeof declaredFlag === 'string' && declaredFlag !== ''
    ? declaredFlag
    : `--${name}`;
  return {
    name,
    type: row.type ?? 'string',
    optional: row.optional ?? false,
    flag,
    ...(row.default === undefined ? {} : { default: row.default }),
    ...(row.help === undefined || row.help === '' ? {} : { help: row.help }),
  };
}

/**
 * Reads one registered plugin whole: its identity, its authoring facts, and
 * every parameter it declares.
 *
 * @param specifier - The plugin's name, version and `/bin` command.
 * @returns The model, or a failure with the reason on the error stack.
 */
export async function pluginInfo_build(
  specifier: PluginSpecifier,
): Promise<Result<PluginInfoModel>> {
  const client: Client | null = await session.connection.client_get();
  if (!client) {
    errorStack.stack_push('error', 'No active ChRIS connection to read a plugin.');
    return Err();
  }

  const found: PluginFound | null = await plugin_find(client, specifier.name, specifier.version);
  if (found === null) {
    errorStack.stack_push(
      'error',
      `Plugin not found on server: ${specifier.name} v${specifier.version}`,
    );
    return Err();
  }

  const rows: PluginParameterData[] = await pluginParameters_drain(found.handle);
  const data = found.data;
  return Ok({
    ...(typeof data.id === 'number' ? { id: data.id } : {}),
    name: data.name ?? specifier.name,
    version: data.version ?? specifier.version,
    type: data.type ?? 'ds',
    ...(typeof data.title !== 'string' || data.title === '' ? {} : { title: data.title }),
    ...(typeof data.description !== 'string' || data.description === '' ? {} : { description: data.description }),
    ...(typeof data.authors !== 'string' || data.authors === '' ? {} : { authors: data.authors }),
    ...(typeof data.documentation !== 'string' || data.documentation === '' ? {} : { documentation: data.documentation }),
    ...(typeof data.category !== 'string' || data.category === '' ? {} : { category: data.category }),
    parameters: rows.map(parameter_project),
    command: specifier.command,
  });
}

/** Column widths of the rendered parameter table. */
const FLAG_WIDTH: number = 22;
const TYPE_WIDTH: number = 11;
const REQUIRED_WIDTH: number = 11;
const DEFAULT_WIDTH: number = 13;
/** Width of the rules that bracket the manual's sections. */
const RULE_WIDTH: number = 74;

/**
 * Renders a parameter's default the way an operator reads it: the value, an
 * explicit pair of quotes for the empty string, and `None` for no default at
 * all — an empty cell would read as the empty string.
 *
 * @param parameter - The declared parameter.
 * @returns The cell text.
 */
function defaultCell_render(parameter: PluginParameter): string {
  if (parameter.default === undefined || parameter.default === null) return 'None';
  const shown: string = String(parameter.default);
  return shown === '' ? '""' : shown;
}

/**
 * Renders the plugin manual — the same text `cat /bin/<plugin>` has always
 * printed, now a projection of the model rather than the only thing there is.
 *
 * @param model - The plugin model.
 * @returns The formatted manual.
 */
export function pluginInfoText_render(model: PluginInfoModel): string {
  const command: string = model.command ?? `${model.name}${BIN_VERSION_SEPARATOR}${model.version}`;
  const lines: string[] = [];
  lines.push('');
  lines.push(chalk.bold.magenta(`${model.name.toUpperCase()} (Version ${model.version})`));
  lines.push(chalk.gray('─'.repeat(RULE_WIDTH)));
  lines.push(`${chalk.bold.blue('Type:')}         ${model.type}`);
  lines.push(`${chalk.bold.blue('Author:')}       ${model.authors ?? 'FNNDSC <dev@babymri.org>'}`);
  if (model.documentation !== undefined) {
    lines.push(`${chalk.bold.blue('Repository:')}   ${model.documentation}`);
  }
  lines.push('');

  lines.push(chalk.bold.blue('DESCRIPTION'));
  lines.push(`  ${model.description ?? 'No description provided.'}`);
  lines.push('');

  lines.push(chalk.bold.blue('PARAMETERS'));
  lines.push(`  ${chalk.bold.white('Flag'.padEnd(FLAG_WIDTH))}${chalk.bold.white('Type'.padEnd(TYPE_WIDTH))}${chalk.bold.white('Required'.padEnd(REQUIRED_WIDTH))}${chalk.bold.white('Default'.padEnd(DEFAULT_WIDTH))}${chalk.bold.white('Description')}`);
  lines.push(`  ${chalk.gray('─'.repeat(RULE_WIDTH))}`);
  for (const parameter of model.parameters) {
    const required: string = parameter.optional ? 'No' : 'Yes';
    lines.push(`  ${chalk.yellow(parameter.flag.padEnd(FLAG_WIDTH))}${parameter.type.padEnd(TYPE_WIDTH)}${required.padEnd(REQUIRED_WIDTH)}${defaultCell_render(parameter).padEnd(DEFAULT_WIDTH)}${parameter.help ?? ''}`);
  }
  lines.push('');

  lines.push(chalk.bold.blue('USAGE EXAMPLES'));
  const required: PluginParameter[] = model.parameters.filter(
    (parameter: PluginParameter): boolean => !parameter.optional,
  );
  const optional: PluginParameter[] = model.parameters.filter(
    (parameter: PluginParameter): boolean => parameter.optional,
  );
  const requiredFlags: string = required
    .map((parameter: PluginParameter): string => `${parameter.flag} "value"`)
    .join(' ');
  const basic: string = requiredFlags ? `${command} ${requiredFlags}` : command;
  lines.push(`  ${chalk.white(basic)}                     ${chalk.gray('# Basic execution')}`);
  const first: PluginParameter | undefined = optional[0];
  if (first !== undefined) {
    const withOptional: string = requiredFlags
      ? `${command} ${requiredFlags} ${first.flag} "value"`
      : `${command} ${first.flag} "value"`;
    lines.push(`  ${chalk.white(withOptional)}     ${chalk.gray('# With optional parameter')}`);
  }
  lines.push('');

  return lines.join('\n');
}
