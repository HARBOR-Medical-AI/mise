/**
 * @file `workflow` and `workflows`: CUBE's workflows, a pipeline's runs,
 * listed, searched, and their fields named. A pipeline runs with `pipeline run`.
 *
 * Declared in one record (`workflowCommand`, and `workflowsCommand` its
 * second name): the subcommands and the listing options every resource
 * command reads.
 *
 * Key components:
 * - workflowCommand / workflowsCommand: the declaration, under each name.
 * - builtin_workflow: the declaration run over words already split.
 *
 * @module
 */
import chalk from 'chalk';
import { workflows_fetchList, WorkflowListResult } from '@fnndsc/chili/commands/workflows/list.js';
import { workflowFields_fetch } from '@fnndsc/chili/commands/workflows/fields.js';
import { table_render } from '@fnndsc/chili/screen/screen.js';
import type { CLIoptions } from '@fnndsc/chili/utils/cli.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { RESOURCE_LIST_OPTIONS_GRAMMAR, commandAlias_make, resourceListBag_build } from './resourceList.js';

/**
 * Lists the workflows a listing's options ask for.
 *
 * @param options - The bag chili's listing reads.
 * @returns The table, or that there are none, or the error.
 */
async function workflowList_render(options: CLIoptions): Promise<CommandEnvelope> {
  try {
    const { workflows, selectedFields, totalCount }: WorkflowListResult = await workflows_fetchList(options);
    if (workflows.length === 0) { return envelope_ok(`${chalk.gray('No workflows found.')}\n`); }
    return envelope_ok(table_render(workflows, selectedFields, { title: { title: 'Workflows', justification: 'center' }, pagination: totalCount !== undefined ? { shown: workflows.length, total: totalCount } : undefined }));
  } catch (e: unknown) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`workflow error: ${e instanceof Error ? e.message : String(e)}`)}\n`);
  }
}

/**
 * Names the fields a workflow has.
 *
 * @returns The fields' table, or that there are none.
 */
async function workflowFields_render(): Promise<CommandEnvelope> {
  const fields: string[] | null = await workflowFields_fetch();
  if (fields && fields.length > 0) {
    return envelope_ok(table_render(fields.map((f: string) => ({ field: f })), ['field'], { title: { title: 'Workflow fields', justification: 'center' } }));
  }
  return envelope_ok(`${chalk.gray('No fields found for workflows.')}\n`);
}

/** What a `workflow` line may hold. */
const WORKFLOW_GRAMMAR = {
  bare: { summary: 'List the workflows, as list does', options: RESOURCE_LIST_OPTIONS_GRAMMAR },
  subcommands: {
    list: { summary: 'List the workflows, 20 to a page', options: RESOURCE_LIST_OPTIONS_GRAMMAR },
    search: {
      summary: 'List the workflows a filter matches (list --search <term>)',
      operands: [{ name: 'term', kind: 'word', summary: 'The filter, field:value (inspect names the fields)' }],
      options: RESOURCE_LIST_OPTIONS_GRAMMAR,
    },
    inspect: { summary: 'Name the fields a workflow has' },
  },
} as const satisfies CommandGrammar;

/**
 * Runs one `workflow` line.
 *
 * @param args - The line, parsed.
 * @returns The listing, the fields, or the error.
 */
async function workflow_run(args: CommandArguments<typeof WORKFLOW_GRAMMAR>): Promise<CommandEnvelope> {
  switch (args.subcommand) {
    case null:
    case 'list': return workflowList_render(resourceListBag_build(args.options));
    case 'search': return workflowList_render(resourceListBag_build(args.options, args.operands.term));
    case 'inspect': return workflowFields_render();
  }
}

/**
 * `workflow [[listing options] | list [listing options] | search <term> [listing options] | inspect]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [workflowCommand, workflowsCommand] }, 'backend');
 * ```
 */
export const workflowCommand = command_declare({
  name: 'workflow',
  grammar: WORKFLOW_GRAMMAR,
  help: {
    summary: "CUBE's workflows, a pipeline's runs: list them, search them, name their fields",
    description: 'List the workflows in CUBE, each one run of a pipeline, a page at a time or every page, filtered by a field:value search and in the columns asked for; inspect names the fields a workflow has. workflow and workflows are one command. pipeline run starts one.',
    category: 'Resources',
    examples: ['workflows list', 'workflows list --all', 'workflows search pipeline_name:PHI_detection', 'workflows inspect'],
  },
  handler: workflow_run,
});

/** `workflows`: the same command as `workflow`. */
export const workflowsCommand = commandAlias_make(workflowCommand, 'workflows');

/**
 * `workflow` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `workflow`.
 * @returns The answer, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_workflow(['list', '--all']);
 * ```
 */
export async function builtin_workflow(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(workflowCommand, args);
}
