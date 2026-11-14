/**
 * @file `plugininstance` and its other names (`plugininstances`, `instance`,
 * `instances`, `job`, `jobs`): CUBE's plugin instances, the jobs, listed,
 * searched, and their fields named. A job is worked where it lives, in
 * /proc/jobs; the verbs that would do it here say how instead.
 *
 * Declared in one record (`plugininstanceCommand`, and its other names): the
 * subcommands and the listing options every resource command reads.
 *
 * Key components:
 * - plugininstanceCommand and its aliases: the declaration, under each name.
 * - builtin_plugininstance: the declaration run over words already split.
 *
 * @module
 */
import chalk from 'chalk';
import { pluginInstances_fetchList, PluginInstanceListResult } from '@fnndsc/chili/commands/plugininstances/list.js';
import { pluginInstanceFields_fetch } from '@fnndsc/chili/commands/plugininstances/fields.js';
import { table_render } from '@fnndsc/chili/screen/screen.js';
import type { CLIoptions } from '@fnndsc/chili/utils/cli.js';
import type { PluginInstanceRow } from '../../api/models.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { RESOURCE_LIST_OPTIONS_GRAMMAR, commandAlias_make, resourceListBag_build } from './resourceList.js';

/**
 * Projects a listed row onto the wire's instance model: the fields the
 * listing selected, typed; a field the listing did not select is absent.
 *
 * @param row - One table row as chili fetched it.
 * @returns The typed row.
 */
function instanceRow_project(row: Record<string, unknown>): PluginInstanceRow {
  const text = (key: string): string | undefined => (typeof row[key] === 'string' && row[key] !== '' ? String(row[key]) : undefined);
  const numeric = (key: string): number | undefined => {
    const value: unknown = row[key];
    if (value === undefined || value === null || value === '') return undefined;
    const parsed: number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const pluginName: string | undefined = text('plugin_name');
  const pluginVersion: string | undefined = text('plugin_version');
  const feedId: number | undefined = numeric('feed_id');
  const owner: string | undefined = text('owner_username');
  const status: string | undefined = text('status');
  const startedAt: string | undefined = text('start_date');
  return {
    id: numeric('id') ?? 0,
    ...(pluginName !== undefined ? { pluginName } : {}),
    ...(pluginVersion !== undefined ? { pluginVersion } : {}),
    ...(feedId !== undefined ? { feedId } : {}),
    ...(owner !== undefined ? { owner } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
  };
}

/** What /proc/jobs does for each job verb the tree already answers. */
const PROC_WAYS = {
  cancel: '`rm <path>` cancels it while it runs',
  delete: '`rm <path>` removes it once it is done (while it runs, rm cancels it)',
  rm: '`rm <path>` removes it once it is done (while it runs, rm cancels it)',
  output: '`<path>/data` is its output folder',
  parameters: '`cat <path>/params` lists its parameters',
  params: '`cat <path>/params` lists its parameters',
  log: '`cat <path>/log` is its log',
} as const;

/**
 * Lists the plugin instances a listing's options ask for, as a table and as
 * the run history a surface reads (a catalogue's RECENT block) rather than scrapes.
 *
 * @param options - The bag chili's listing reads.
 * @returns The table and model, or that there are none, or the error.
 */
async function plugininstanceList_render(options: CLIoptions): Promise<CommandEnvelope> {
  try {
    const { pluginInstances, selectedFields, totalCount }: PluginInstanceListResult = await pluginInstances_fetchList(options);
    const model = { kind: 'plugininstance.list' as const, data: pluginInstances.map(instanceRow_project) };
    if (pluginInstances.length === 0) { return envelope_ok(`${chalk.gray('No plugin instances found.')}\n`, model); }
    return envelope_ok(table_render(pluginInstances, selectedFields, { title: { title: 'Plugin Instances', justification: 'center' }, pagination: totalCount !== undefined ? { shown: pluginInstances.length, total: totalCount } : undefined }), model);
  } catch (e: unknown) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`plugininstance error: ${e instanceof Error ? e.message : String(e)}`)}\n`);
  }
}

/**
 * Names the fields a plugin instance has.
 *
 * @returns The fields' table, or that there are none.
 */
async function plugininstanceFields_render(): Promise<CommandEnvelope> {
  const fields: string[] | null = await pluginInstanceFields_fetch();
  if (fields && fields.length > 0) {
    return envelope_ok(table_render(fields.map((f: string) => ({ field: f })), ['field'], { title: { title: 'Plugin Instance fields', justification: 'center' } }));
  }
  return envelope_ok(`${chalk.gray('No fields found for plugin instances.')}\n`);
}

/**
 * A job verb the tree already answers: names the /proc/jobs path and what to
 * do there, rather than keep a second way to do what the tree does.
 *
 * @param verb - The verb asked for.
 * @param id - The job's id as typed, if any.
 * @returns The refusal that says how.
 */
function procWay_say(verb: keyof typeof PROC_WAYS, id: string | undefined): CommandEnvelope {
  exitCode_set(1);
  return envelope_error('', undefined, `${chalk.red(`plugininstance ${verb}: a job is worked in /proc/jobs; \`proc find ${id ?? '<id>'}\` names its path, then ${PROC_WAYS[verb]}`)}\n`);
}

/** The operand of a job verb /proc/jobs answers: the job's id, which it names in the way it says. */
const JOB_ID_OPERANDS = [{ name: 'id', kind: 'word', optional: true, summary: "The job's id" }] as const;

/** What a `plugininstance` line may hold. */
const PLUGININSTANCE_GRAMMAR = {
  bare: { summary: 'List the first page of plugin instances' },
  subcommands: {
    list: { summary: 'List the plugin instances, 20 to a page', options: RESOURCE_LIST_OPTIONS_GRAMMAR },
    search: {
      summary: 'List the plugin instances a filter matches (list --search <term>)',
      operands: [{ name: 'term', kind: 'word', summary: 'The filter, field:value (inspect names the fields)' }],
      options: RESOURCE_LIST_OPTIONS_GRAMMAR,
    },
    inspect: { summary: 'Name the fields a plugin instance has' },
    cancel: { summary: 'Says how: rm <path> in /proc/jobs cancels a running job', operands: JOB_ID_OPERANDS },
    delete: { summary: 'Says how: rm <path> in /proc/jobs removes a finished job', operands: JOB_ID_OPERANDS },
    rm: { summary: 'Says how: rm <path> in /proc/jobs removes a finished job', operands: JOB_ID_OPERANDS },
    output: { summary: 'Says how: <path>/data in /proc/jobs is its output folder', operands: JOB_ID_OPERANDS },
    parameters: { summary: 'Says how: cat <path>/params in /proc/jobs lists its parameters', operands: JOB_ID_OPERANDS },
    params: { summary: 'Says how: cat <path>/params in /proc/jobs lists its parameters', operands: JOB_ID_OPERANDS },
    log: { summary: 'Says how: cat <path>/log in /proc/jobs is its log', operands: JOB_ID_OPERANDS },
  },
} as const satisfies CommandGrammar;

/**
 * Runs one `plugininstance` line.
 *
 * @param args - The line, parsed.
 * @returns The listing, the fields, or the way /proc/jobs does it.
 */
async function plugininstance_run(args: CommandArguments<typeof PLUGININSTANCE_GRAMMAR>): Promise<CommandEnvelope> {
  switch (args.subcommand) {
    case null: return plugininstanceList_render({});
    case 'list': return plugininstanceList_render(resourceListBag_build(args.options));
    case 'search': return plugininstanceList_render(resourceListBag_build(args.options, args.operands.term));
    case 'inspect': return plugininstanceFields_render();
    default: return procWay_say(args.subcommand, args.operands.id);
  }
}

/**
 * `plugininstance [list [listing options] | search <term> [listing options] | inspect | <job verb> [id]]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [plugininstanceCommand, jobsCommand] }, 'backend');
 * ```
 */
export const plugininstanceCommand = command_declare({
  name: 'plugininstance',
  grammar: PLUGININSTANCE_GRAMMAR,
  help: {
    summary: "CUBE's plugin instances, the jobs: list them, search them, name their fields",
    description: 'List the plugin instances in CUBE, the jobs, a page at a time or every page, filtered by a field:value search and in the columns asked for; inspect names the fields a job has. A job is worked in /proc/jobs: proc find <id> names its path, rm <path> cancels it while it runs and removes it once done, cat <path>/params and cat <path>/log read it, and <path>/data is its output; the verbs that would do these here say so. plugininstance, plugininstances, instance, instances, job and jobs are one command.',
    category: 'Resources',
    examples: ['jobs list', 'jobs list --all', 'jobs search status:started', 'jobs list --search feed_id:5536', 'jobs inspect', 'proc find 42'],
  },
  handler: plugininstance_run,
});

/** `plugininstances`: the same command as `plugininstance`; a read, which holds nothing of the session. */
export const plugininstancesCommand = commandAlias_make(plugininstanceCommand, 'plugininstances', []);

/** `instance`: the same command as `plugininstance`. */
export const instanceCommand = commandAlias_make(plugininstanceCommand, 'instance');

/** `instances`: the same command as `plugininstance`. */
export const instancesCommand = commandAlias_make(plugininstanceCommand, 'instances');

/** `job`: the same command as `plugininstance`. */
export const jobCommand = commandAlias_make(plugininstanceCommand, 'job');

/** `jobs`: the same command as `plugininstance`. */
export const jobsCommand = commandAlias_make(plugininstanceCommand, 'jobs');

/**
 * `plugininstance` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `plugininstance`.
 * @returns The answer, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_plugininstance(['search', 'status:started']);
 * ```
 */
export async function builtin_plugininstance(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(plugininstanceCommand, args);
}
