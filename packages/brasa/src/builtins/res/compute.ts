/**
 * @file `compute` and `computes`: the compute resources registered with
 * CUBE, where a plugin's job runs, listed, searched, and their fields named.
 *
 * CUBE answers every compute resource in one read, so the listing takes no
 * paging; a search filters what that read answered.
 *
 * Declared in one record (`computeCommand`, `computes` among its aliases).
 *
 * Key components:
 * - computeCommand: the declaration, answered as `compute` and `computes`.
 * - builtin_compute: the declaration run over words already split.
 *
 * @module
 */
import chalk from 'chalk';
import { computeResources_fetchList, ComputeListResult } from '@fnndsc/chili/commands/compute/list.js';
import { computeFields_fetch } from '@fnndsc/chili/commands/compute/fields.js';
import { computeList_render } from '@fnndsc/chili/views/compute.js';
import { table_render } from '@fnndsc/chili/screen/screen.js';
import { errorStack, type Result } from '@fnndsc/fond';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import type { ComputeResource } from '@fnndsc/cumin';
import { exitCode_set } from '../../core/handlerRun.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { RESOURCE_ID_OPERANDS, resourceRecord_render, type ResourceRecordSource } from './resourceRecord.js';

/** How a listing is drawn. */
interface ComputeListShape {
  /** Tabular output. */
  readonly table: boolean;
  /** CSV output. */
  readonly csv: boolean;
}

/**
 * Whether a compute resource matches a search term: `field:value` matches
 * a field holding the value, a bare word the name holding it.
 *
 * @param resource - The compute resource.
 * @param term - The term.
 * @returns True when it matches.
 */
function computeResource_matches(resource: ComputeResource, term: string): boolean {
  const colon: number = term.indexOf(':');
  const field: string = colon === -1 ? 'name' : term.slice(0, colon);
  const value: string = (colon === -1 ? term : term.slice(colon + 1)).toLowerCase();
  const held: unknown = Object.entries(resource).find(([key]: [string, unknown]): boolean => key === field)?.[1];
  return held !== undefined && held !== null && String(held).toLowerCase().includes(value);
}

/**
 * Lists the compute resources, those a term matches when one is given.
 *
 * @param shape - How the listing is drawn.
 * @param term - The search term, or none for every resource.
 * @returns The listing, or the error.
 */
async function computeList_answer(shape: ComputeListShape, term?: string): Promise<CommandEnvelope> {
  try {
    const listResult: Result<ComputeListResult> = await computeResources_fetchList();
    if (!listResult.ok) {
      const lastError = errorStack.stack_pop();
      exitCode_set(1);
      return envelope_error('', undefined, `${chalk.red(lastError ? lastError.message : 'compute list failed')}\n`);
    }
    const resources: ComputeResource[] = term === undefined
      ? listResult.value.resources
      : listResult.value.resources.filter((resource: ComputeResource): boolean => computeResource_matches(resource, term));
    return envelope_ok(`${computeList_render(resources, { table: shape.table, csv: shape.csv })}\n`);
  } catch (e: unknown) {
    const msg: string = e instanceof Error ? e.message : String(e);
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`compute error: ${msg}`)}\n`);
  }
}

/**
 * Names the fields a compute resource has.
 *
 * @returns The fields' table, or that there are none.
 */
async function computeFields_render(): Promise<CommandEnvelope> {
  const fields: string[] | null = await computeFields_fetch();
  if (fields && fields.length > 0) {
    return envelope_ok(table_render(fields.map((f: string) => ({ field: f })), ['field'], { title: { title: 'Compute fields', justification: 'center' } }));
  }
  return envelope_ok(`${chalk.gray('No fields found.')}\n`);
}

/** How a compute listing may be drawn. */
const COMPUTE_SHAPE_OPTIONS = {
  table: { long: 'table', summary: 'Tabular output' },
  csv: { long: 'csv', summary: 'CSV output' },
} as const;

/**
 * How `compute inspect <id>` reads one compute resource: CUBE answers every
 * one in a single read, so the read is filtered here.
 */
const COMPUTE_RECORD: ResourceRecordSource = {
  command: 'compute',
  noun: 'compute resource',
  title: 'Compute',
  fields_fetch: computeFields_fetch,
  rows_fetch: async (): Promise<readonly object[]> => {
    const listed: Result<ComputeListResult> = await computeResources_fetchList();
    if (!listed.ok) throw new Error(errorStack.stack_pop()?.message ?? 'compute list failed');
    return listed.value.resources;
  },
};

/** What a `compute` line may hold. */
const COMPUTE_GRAMMAR = {
  bare: { summary: 'List every compute resource, as list does', options: COMPUTE_SHAPE_OPTIONS },
  subcommands: {
    list: { summary: 'List every compute resource', options: COMPUTE_SHAPE_OPTIONS },
    search: {
      summary: 'List the compute resources a term matches: field:value, or part of a name',
      operands: [{ name: 'term', kind: 'word', summary: 'The filter, field:value, or part of a name' }],
      options: COMPUTE_SHAPE_OPTIONS,
    },
    inspect: { summary: 'One compute resource, every field with its value; with no id, the fields a compute resource has', operands: RESOURCE_ID_OPERANDS },
  },
} as const satisfies CommandGrammar;

/**
 * Runs one `compute` line.
 *
 * @param args - The line, parsed.
 * @returns The listing, the fields, or the error.
 */
async function compute_run(args: CommandArguments<typeof COMPUTE_GRAMMAR>): Promise<CommandEnvelope> {
  switch (args.subcommand) {
    case null:
    case 'list': return computeList_answer(args.options);
    case 'search': return computeList_answer(args.options, args.operands.term);
    case 'inspect': return args.operands.id === undefined ? computeFields_render() : resourceRecord_render(COMPUTE_RECORD, args.operands.id);
  }
}

/**
 * `compute [[--table] [--csv] | list [--table] [--csv] | search <term> [--table] [--csv] | inspect [id]]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [computeCommand] }, 'backend');
 * ```
 */
export const computeCommand = command_declare({
  name: 'compute',
  aliases: ['computes'],
  grammar: COMPUTE_GRAMMAR,
  help: {
    summary: 'The compute resources registered with CUBE, where jobs run',
    description: 'List the compute resources registered with CUBE, every one in a single read, as a table or CSV when asked; search keeps those a field:value, or part of a name, matches; inspect <id> shows the fields and values of one compute resource, and inspect alone names the fields a compute resource has. compute and computes are one command. A plugin or pipeline run takes one with --compute <name>.',
    category: 'Resources',
    examples: ['compute list', 'compute list --table', 'compute search moc', 'compute list --csv', 'compute inspect', 'compute inspect 1'],
  },
  handler: compute_run,
});

/**
 * `compute` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `compute`.
 * @returns The answer, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_compute(['list', '--table']);
 * ```
 */
export async function builtin_compute(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(computeCommand, args);
}
