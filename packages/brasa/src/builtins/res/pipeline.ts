/**
 * @file Builtin pipeline command.
 *
 * Manages registered ChRIS pipelines. Subcommands:
 * - `list`   — list all registered pipelines
 * - `info`   — show a pipeline's nodes and default parameters
 * - `manifest` — emit the complete registered invocation YAML
 * - `run`    — instantiate a pipeline as a workflow from the feed node cwd is in
 * - `source` — display the pipeline's YAML source file
 * - `diagram` — render the registered pipeline as a shallow tree or SignalFlow YAML
 *
 * Pipelines also appear as executables in `/bin` (colored distinctly from plugins)
 * and can be invoked directly by name. `cat /bin/<name>` returns a cache-only
 * executable summary; `pipeline manifest <name>` performs complete inspection.
 *
 * @module
 */

import chalk from 'chalk';
import { path_extractPluginInstanceID, path_isInFeed, pipeline_resolve, procCache_get, type PipelineRecord } from '@fnndsc/cumin';
import { session } from '../../session/index.js';
import {
  pipelines_list,
  pipeline_run,
  pipeline_sourceGet,
  pipelineManifest_get,
  pipelineManifestBySlug_get,
  pipelineInvocation_prepare,
  fileContent_get,
  type PipelineManifest,
  type PipelineManifestNode,
  type PreparedPipelineInvocation,
  type PreparedWorkflowNode,
  type PipelineRunOptions,
  type WorkflowResult,
  procCache_refresh,
} from '@fnndsc/salsa';
import { load as yamlLoad } from 'js-yaml';
import { pipelineFields_fetch } from '@fnndsc/chili/commands/pipeline/fields.js';
import { table_render } from '@fnndsc/chili/screen/screen.js';
import { sink_get, sink_dataLine, sink_errLine } from '../../core/sink.js';
import { echoValue_render } from '../runEcho.js';
import { argumentValue_coerce } from '../argumentTokens.js';
import type { PipelineInvocationBinding } from '@fnndsc/salsa';
import { command_declare, type CommandArguments, type CommandGrammar, type FamilyValue, type SubcommandArguments } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { path_resolve as pathLogical_resolve, storePath_resolve } from '../../core/paths.js';
import { runs_awaitSettled, settlement_render, settlementStatus_derive, type RunSettlement } from './runWait.js';
import type { PipelineNode, PipelineScheduled } from '../../api/models.js';
import { pipelineDiagram_handle, type PipelineDiagramMode } from './pipeline.diagram.js';
import { pipelineManifest_render, pipelineParameters_render } from './pipeline.manifest.js';
import { errorStack, type Result, type StackMessage } from '@fnndsc/fond';
import { type CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';

const PIPELINE_PROGRESS_DELAY_MS: number = 300;
const PIPELINE_PROGRESS_LABEL: string = 'Reading registered pipeline…';

/**
 * Handles `pipeline list [search]`.
 *
 * @param search - The filter, if any.
 */
async function pipelineList_handle(search: string | undefined): Promise<void> {
  const data = await pipelines_list(search);
  if (!data || data.tableData.length === 0) {
    sink_dataLine(chalk.yellow('No pipelines registered.'));
    return;
  }
  sink_dataLine('');
  sink_dataLine(
    `  ${chalk.bold('ID'.padEnd(6))}${chalk.bold('Name'.padEnd(40))}${chalk.bold('Category'.padEnd(16))}${chalk.bold('Authors')}`
  );
  sink_dataLine(`  ${chalk.gray('─'.repeat(80))}`);
  for (const row of data.tableData) {
    const id: string = String(row.id ?? '').padEnd(6);
    const name: string = String(row.name ?? '').padEnd(40);
    const cat: string = String(row.category ?? '').padEnd(16);
    const authors: string = String(row.authors ?? '');
    sink_dataLine(`  ${chalk.cyan(id)}${chalk.magenta(name)}${chalk.gray(cat)}${chalk.gray(authors)}`);
  }
  sink_dataLine('');
}

/**
 * Handles `pipeline info <name|id>`.
 *
 * @param nameOrId - The pipeline.
 * @returns Command envelope whose status matches resolution and manifest fetching.
 *
 * @example
 * ```ts
 * await pipelineInfo_handle('PHI_detection');
 * ```
 */
export async function pipelineInfo_handle(nameOrId: string): Promise<CommandEnvelope> {
  const result: Result<PipelineRecord> = await pipeline_resolve(nameOrId);
  if (!result.ok) {
    const err: StackMessage | undefined = errorStack.stack_pop();
    sink_errLine(chalk.red(`pipeline info: ${err?.message ?? 'not found'}`));
    exitCode_set(1);
    return envelope_error('');
  }
  const p: PipelineRecord = result.value;
  sink_dataLine('');
  sink_dataLine(`${chalk.bold.magenta(p.name)}  ${chalk.gray(`[id: ${p.id}]`)}`);
  if (p.description) sink_dataLine(chalk.white(`  ${p.description}`));
  if (p.authors)     sink_dataLine(chalk.gray(`  Authors: ${p.authors}`));
  if (p.category)    sink_dataLine(chalk.gray(`  Category: ${p.category}`));
  sink_dataLine(chalk.gray(`  Locked: ${p.locked ? 'yes' : 'no'}`));
  const manifestResult: Result<PipelineManifest> = await pipelineManifest_get(nameOrId);
  if (!manifestResult.ok) {
    const err: StackMessage | undefined = errorStack.stack_pop();
    sink_errLine(chalk.red(`pipeline info: ${err?.message ?? 'manifest unavailable'}`));
    exitCode_set(1);
    return envelope_error('');
  }
  sink_dataLine(pipelineParameters_render(manifestResult.value as PipelineManifest));
  return envelope_ok('');
}

/**
 * The plugin instance of the feed node a path is in: the deepest
 * `pl-*_ID` on it, so a node and its `data` folder name the same one.
 *
 * @param place - A path.
 * @returns The instance id, or null outside a feed node.
 */
function feedNodeInstance_find(place: string): number | null {
  return path_isInFeed(place) ? path_extractPluginInstanceID(place) : null;
}

/**
 * Resolves the "previous" plugin-instance id for `pipeline run`: the
 * explicit override, else the feed node the working directory is in, as a
 * plugin run from `/bin` finds it (#1263). A saved context `cd` never sets
 * is not read, so a manifest's `cd ${FEED.path}; ${PIPELINE}` runs where it
 * stands.
 *
 * @param previousOverride - Explicit `--previous` value, if any.
 * @returns The instance id, or null if it could not be resolved (error printed).
 */
async function pipelineRun_previousInstId(previousOverride: number | undefined): Promise<number | null> {
  if (previousOverride !== undefined) return previousOverride;
  const cwd: string = await session.getCWD();
  const here: number | null = feedNodeInstance_find(cwd);
  if (here === null) {
    sink_errLine(chalk.red(`pipeline run: ${cwd} is not in a feed node; cd into one (…/feeds/feed_N/pl-x_ID), or give --previous <id>`));
    exitCode_set(1);
    return null;
  }
  return here;
}

/**
 * The resolved call of a pipeline run, one line per piping: the parameters
 * the line changed from the registration, or every parameter with the
 * unchanged ones marked `(default)` and the compute resource named.
 *
 * @param nameOrId - Pipeline name or numeric ID string.
 * @param options - The overlays the run uses.
 * @param full - Whether to list every parameter of every piping.
 * @returns The lines, or null when the call cannot be prepared (detail on the error stack).
 */
async function pipelineEcho_build(nameOrId: string, options: PipelineRunOptions, full: boolean): Promise<string[] | null> {
  const manifest: Result<PipelineManifest> = await pipelineManifest_get(nameOrId);
  if (!manifest.ok) return null;
  const prepared: Result<PreparedPipelineInvocation> = pipelineInvocation_prepare({
    manifest: manifest.value,
    globalCompute: options.globalCompute,
    parameterFile: options.parameterFile,
    cliBindings: options.cliBindings,
  });
  if (!prepared.ok) return null;
  return prepared.value.nodeOverrides.map((node: PreparedWorkflowNode): string => {
    const registered: PipelineManifestNode | undefined = manifest.value.nodes.find((one: PipelineManifestNode): boolean => one.pipingID === node.piping_id);
    const words: string[] = [];
    for (const parameter of node.plugin_parameter_defaults) {
      const before: unknown = registered?.parameterDefaults.find((one): boolean => one.name === parameter.name)?.value;
      const changed: boolean = JSON.stringify(before) !== JSON.stringify(parameter.default);
      if (changed || full) words.push(`--${parameter.name} ${echoValue_render(parameter.default ?? '')}${changed ? '' : ' (default)'}`);
    }
    const computeChanged: boolean = registered !== undefined && registered.computeResourceName !== node.compute_resource_name;
    const compute: string = full || computeChanged ? `  on ${node.compute_resource_name}` : '';
    return `  with ${node.title}: ${words.length > 0 ? words.join('  ') : 'registered parameters'}${compute}`;
  });
}

/** One pipeline run, as a line asks for it: the pipeline, where it attaches, its overlays, and how the line holds it. */
export interface PipelineRunRequest {
  /** The pipeline: its name, id or `/bin` name. */
  readonly pipeline: string;
  /** The compute resource every node runs on, when given. */
  readonly compute?: string;
  /** The instance the run attaches to; absent, the feed node the session stands in. */
  readonly previous?: number;
  /** A CFS file of sparse YAML overrides, when given. */
  readonly paramFile?: string;
  /** The node overrides, `--<node>.<field> <value>`. */
  readonly bindings: readonly PipelineInvocationBinding[];
  /** Return the handles at once rather than wait for the run. */
  readonly detach: boolean;
  /** Echo every parameter of every piping. */
  readonly verbose: boolean;
  /** Resolve the run and print it, creating nothing (`whatif`). */
  readonly dry: boolean;
  /** A dry run on a feed that would be rooted first, so no node exists to attach to. */
  readonly dryNewFeed: boolean;
}

/**
 * Runs one pipeline: from the instance the request names or the feed node
 * the session stands in, with the overlays it gives; the resolved call is
 * echoed first, and a dry run stops there.
 *
 * @param request - The run.
 * @returns Command envelope whose status matches Workflow creation.
 *
 * @example
 * ```ts
 * await pipelineRun_execute({ pipeline: 'PHI_detection', bindings: [], detach: false, verbose: false, dry: true, dryNewFeed: false });
 * ```
 */
export async function pipelineRun_execute(request: PipelineRunRequest): Promise<CommandEnvelope> {
  const nameOrId: string = request.pipeline;
  const parsed: PipelineRunRequest = request;
  const computeOverride: string | undefined = request.compute;
  const previousOverride: number | undefined = request.previous;

  // A dry run on a feed that would be rooted first has no node yet: the caller said where it would attach.
  const previousInstId: number | null = parsed.dryNewFeed ? null : await pipelineRun_previousInstId(previousOverride);
  if (previousInstId === null && !parsed.dryNewFeed) return envelope_error('');

  const pipelineResult: Result<PipelineRecord> = await pipeline_resolve(nameOrId);
  if (!pipelineResult.ok) {
    const err: StackMessage | undefined = errorStack.stack_pop();
    sink_errLine(chalk.red(`pipeline run: ${err?.message ?? 'pipeline not found'}`));
    exitCode_set(1);
    return envelope_error('');
  }

  if (previousInstId !== null) {
    sink_dataLine(chalk.gray(parsed.dry
      ? `pipeline '${pipelineResult.value.name}' on instance ${previousInstId}`
      : `Running pipeline '${pipelineResult.value.name}' on instance ${previousInstId}...`));
  }

  let parameterFile: unknown;
  if (parsed.paramFile !== undefined) {
    const resolvedPath: string = await pathLogical_resolve(parsed.paramFile);
    const virtualPrefix: string | undefined = ['/bin', '/usr', '/etc', '/proc', '/net']
      .find((prefix: string): boolean => resolvedPath === prefix || resolvedPath.startsWith(`${prefix}/`));
    if (virtualPrefix !== undefined) {
      sink_errLine(chalk.red(`pipeline run: --paramFile must name a readable CFS file, not '${resolvedPath}'`));
      exitCode_set(1);
      return envelope_error('');
    }
    // The file is read where the store keeps it: a link inside a feed is followed, as every reader follows it.
    const contentResult: Result<string> = await fileContent_get(await storePath_resolve(resolvedPath));
    if (!contentResult.ok) {
      const err: StackMessage | undefined = errorStack.stack_pop();
      sink_errLine(chalk.red(`pipeline run: ${err?.message ?? `cannot read ${resolvedPath}`}`));
      exitCode_set(1);
      return envelope_error('');
    }
    try {
      parameterFile = yamlLoad(contentResult.value);
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      sink_errLine(chalk.red(`pipeline run: invalid parameter YAML: ${message}`));
      exitCode_set(1);
      return envelope_error('');
    }
  }
  const hasInvocationOptions: boolean = computeOverride !== undefined || parameterFile !== undefined || parsed.bindings.length > 0;
  const invocationOptions: PipelineRunOptions | undefined = hasInvocationOptions ? {
    globalCompute: computeOverride,
    parameterFile,
    cliBindings: [...parsed.bindings],
  } : undefined;
  // The resolved call, said before it is dispatched; `whatif` stops here.
  const echo: string[] | null = await pipelineEcho_build(nameOrId, invocationOptions ?? {}, parsed.verbose || parsed.dry);
  if (echo === null) {
    const err: StackMessage | undefined = errorStack.stack_pop();
    sink_errLine(chalk.red(`pipeline run: ${err?.message ?? 'the run cannot be prepared'}`));
    exitCode_set(1);
    return envelope_error('');
  }
  for (const line of echo) sink_dataLine(chalk.gray(line));
  if (parsed.dry || previousInstId === null) {
    sink_dataLine(chalk.gray(`whatif: ${pipelineResult.value.name} was not run; nothing was created`));
    return envelope_ok('');
  }
  const runResult: Result<WorkflowResult> = await pipeline_run(nameOrId, previousInstId, invocationOptions);
  if (!runResult.ok) {
    const err: StackMessage | undefined = errorStack.stack_pop();
    sink_errLine(chalk.red(`pipeline run: ${err?.message ?? 'workflow creation failed'}`));
    exitCode_set(1);
    return envelope_error('');
  }

  const { workflowId, pluginInstanceIds } = runResult.value;
  const feedID: number | undefined = procCache_get().instance_get(previousInstId)?.feedID;
  if (feedID !== undefined) {
    try {
      await procCache_refresh(feedID);
    } catch {
      // Workflow creation succeeded; the background/full reconciliation remains authoritative.
    }
  }
  sink_dataLine(chalk.green(`✓ Workflow ${workflowId} created — ${pluginInstanceIds.length} node(s) queued`));
  sink_dataLine(chalk.gray(`  Instance IDs: ${pluginInstanceIds.join(', ')}`));

  // A workflow that returns when CUBE accepts it reads as finished and is
  // not: the wait holds this line, never the session, and Esc detaches it.
  // `--detach` asks for the handle up front instead.
  let settlement: RunSettlement | null = null;
  if (!parsed.detach) {
    settlement = await runs_awaitSettled(pluginInstanceIds, pipelineResult.value.name);
    sink_dataLine(settlement_render(settlement, pipelineResult.value.name));
    if (settlement.outcome === 'settled' && settlement.failed > 0) exitCode_set(1);
    if (feedID !== undefined) {
      try {
        await procCache_refresh(feedID);
      } catch {
        // The nodes settled; a stale projection is the reconciler's problem.
      }
    }
  }

  // A scheduled pipeline is a model, as a plugin's run is: a surface lights
  // the feed it landed in, and a capture holds every node it made.
  if (feedID === undefined || pluginInstanceIds.length === 0) return envelope_ok('');
  return envelope_ok('', {
    kind: PIPELINE_SCHEDULED_KIND,
    data: pipelineScheduled_make(pipelineResult.value.name, workflowId, feedID, pluginInstanceIds, settlement),
  });
}

/** The model kind a scheduled pipeline travels under. */
export const PIPELINE_SCHEDULED_KIND: string = 'pipeline.scheduled';

/**
 * A scheduled pipeline as a model: every node, as the process cache knows it
 * once the feed was refreshed, and the nodes nothing in it runs off.
 *
 * @param pipelineName - The pipeline.
 * @param workflowId - The workflow CUBE made.
 * @param feedId - The feed its nodes joined.
 * @param instanceIds - The nodes, in the order CUBE scheduled them.
 * @param settlement - How the wait ended, or null when the line did not wait.
 * @param newFeed - Whether the run rooted a new feed first.
 * @returns The model.
 */
export function pipelineScheduled_make(
  pipelineName: string,
  workflowId: number,
  feedId: number,
  instanceIds: ReadonlyArray<number>,
  settlement: RunSettlement | null,
  newFeed: boolean = false,
): PipelineScheduled {
  const cache = procCache_get();
  const instances: PipelineNode[] = instanceIds.map((instanceId: number): PipelineNode => {
    const known = cache.instance_get(instanceId);
    return {
      instanceId,
      pluginName: known?.pluginName ?? 'unknown',
      outputPath: known?.outputPath ?? null,
      status: settlement === null ? 'detached' : settlementStatus_derive(settlement, instanceId),
    };
  });
  const parents: Set<number> = new Set(instanceIds
    .map((instanceId: number): number | null | undefined => cache.instance_get(instanceId)?.parentID)
    .filter((parent: number | null | undefined): parent is number => typeof parent === 'number'));
  const leaves: number[] = instanceIds.filter((instanceId: number): boolean => !parents.has(instanceId));
  // Where the work ends, as paths: a play downloads a leaf's output without reaching through every node.
  const leafPaths: string[] = leaves
    .map((instanceId: number): string | null => cache.instance_get(instanceId)?.outputPath ?? null)
    .filter((outputPath: string | null): outputPath is string => outputPath !== null);
  return { pipelineName, workflowId, feedId, newFeed, instances, leaves, leafPaths };
}

/**
 * Handles `pipeline source <name|id>`.
 *
 * @param nameOrId - The pipeline.
 * @returns Command envelope whose status matches source retrieval.
 *
 * @example
 * ```ts
 * await pipelineSource_handle('PHI_detection');
 * ```
 */
export async function pipelineSource_handle(nameOrId: string): Promise<CommandEnvelope> {
  const sourceResult: Result<string> = await pipeline_sourceGet(nameOrId);
  if (!sourceResult.ok) {
    const err: StackMessage | undefined = errorStack.stack_pop();
    sink_errLine(chalk.red(`pipeline source: ${err?.message ?? 'source not found'}`));
    exitCode_set(1);
    return envelope_error('');
  }
  sink_dataLine(sourceResult.value);
  return envelope_ok('');
}

/**
 * Handles `pipeline manifest <name|id|slug>`.
 *
 * @param specifier - The pipeline, its words joined.
 * @returns Complete registered invocation manifest as serializable YAML.
 *
 * @example
 * ```ts
 * await pipelineManifestCommand_handle('PHI_detection');
 * ```
 */
export async function pipelineManifestCommand_handle(specifier: string): Promise<CommandEnvelope> {
  const result: Result<PipelineManifest> = await pipelineManifestWithProgress_get(specifier);
  if (!result.ok) {
    const err: StackMessage | undefined = errorStack.stack_pop();
    exitCode_set(1);
    return envelope_error(
      '',
      undefined,
      `${chalk.red(`pipeline manifest: ${err?.message ?? 'manifest unavailable'}`)}\n`,
    );
  }
  return envelope_ok(pipelineManifest_render(result.value));
}

/**
 * Fetches a registered manifest while emitting delayed semantic progress.
 *
 * @param specifier - Pipeline name, numeric ID, or exact registered slug.
 * @returns The complete registered invocation manifest result.
 */
async function pipelineManifestWithProgress_get(specifier: string): Promise<Result<PipelineManifest>> {
  let progressStarted: boolean = false;
  let progressFailed: boolean = false;
  const progressTimer: NodeJS.Timeout = setTimeout((): void => {
    progressStarted = true;
    sink_get().progress_write({
      operation: 'pipeline',
      kind: 'inspection',
      phase: 'reading',
      label: PIPELINE_PROGRESS_LABEL,
      status: 'running',
    });
  }, PIPELINE_PROGRESS_DELAY_MS);
  try {
    if (/_id\d+$/.test(specifier)) {
      const checkpoint: number = errorStack.checkpoint_mark();
      const exact: Result<PipelineManifest> = await pipelineManifestBySlug_get(specifier);
      if (exact.ok) return exact;
      errorStack.checkpoint_drain(checkpoint);
    }
    return await pipelineManifest_get(specifier, { detail: 'registered' });
  } catch (error: unknown) {
    progressFailed = true;
    throw error;
  } finally {
    clearTimeout(progressTimer);
    if (progressStarted) {
      sink_get().progress_write({
        operation: 'pipeline',
        kind: 'inspection',
        phase: progressFailed ? 'failed' : 'complete',
        label: PIPELINE_PROGRESS_LABEL,
        status: progressFailed ? 'error' : 'done',
      });
    }
  }
}

/**
 * Handles `pipeline inspect`: lists available pipeline fields.
 */
async function pipelineInspect_handle(): Promise<void> {
  const fields: string[] | null = await pipelineFields_fetch();
  if (fields && fields.length > 0) {
    sink_get().data_write(table_render(fields.map((f: string) => ({ field: f })), ['field'], { title: { title: 'Pipeline fields', justification: 'center' } }));
  } else {
    sink_dataLine(chalk.gray('No fields found.'));
  }
}

/**
 * Handles shallow and SignalFlow pipeline diagram output.
 *
 * @param specifier - The pipeline, its words joined.
 * @param withArguments - Each node's stored arguments inline.
 * @param signalflow - SignalFlow YAML instead of the tree.
 * @returns The diagram, or the refusal.
 *
 * @example
 * ```ts
 * await pipelineDiagramCommand_handle('PHI_detection', false, true);
 * ```
 */
export async function pipelineDiagramCommand_handle(specifier: string, withArguments: boolean, signalflow: boolean): Promise<CommandEnvelope> {
  if (withArguments && signalflow) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red('pipeline diagram: --withargs is only available for shallow rendering')}\n`);
  }
  const mode: PipelineDiagramMode = signalflow
    ? 'signalflow'
    : withArguments ? 'shallow-withargs' : 'shallow';
  return pipelineDiagram_handle(specifier, mode);
}

/** A node override's name: `<node>.<field>`, the node a title or `@<piping id>`. */
const NODE_FIELD: RegExp = /^[^.=\s]+\.[^.=\s]+$/;

/** A pipeline, as `pipeline` names one: its name, its id, or its `/bin` name. */
const PIPELINE_OPERAND = { name: 'pipeline', kind: 'pipeline', summary: 'The pipeline: its name, its id, or its /bin name' } as const;

/** A pipeline named in several words (`pipeline diagram PHI detection`): the words are joined. */
const PIPELINE_WORDS_OPERAND = { name: 'pipeline', kind: 'pipeline', repeat: true, summary: 'The pipeline: its name (in several words, joined), its id, or its /bin name' } as const;

/** What a `pipeline` line may hold. */
const PIPELINE_GRAMMAR = {
  bare: { summary: 'Name the subcommands, and the feed node a run here starts from' },
  subcommands: {
    list: { summary: 'List the registered pipelines', operands: [{ name: 'search', kind: 'word', optional: true, summary: 'Only those whose name holds this' }] },
    search: { summary: 'List the pipelines whose name holds a word (list <word>)', operands: [{ name: 'term', kind: 'word', optional: true, summary: 'The word' }] },
    inspect: { summary: 'Name the fields a pipeline has' },
    info: { summary: "Show a pipeline's nodes, plugins and topology", operands: [PIPELINE_OPERAND] },
    manifest: { summary: 'Emit the complete registered invocation YAML', operands: [PIPELINE_WORDS_OPERAND] },
    run: {
      summary: 'Run a pipeline from the feed node you are in, and wait for it',
      operands: [PIPELINE_OPERAND],
      options: {
        compute: { long: 'compute', summary: 'Run every node on this compute resource', value: { name: 'resource', kind: 'compute' } },
        previous: { long: 'previous', summary: 'Start from this instance (default: the feed node you are in)', value: { name: 'instance', kind: 'int', min: 1 } },
        paramFile: { long: 'paramFile', summary: 'Apply one sparse YAML invocation overlay, a CFS file', value: { name: 'file', kind: 'cfsPath' } },
        detach: { long: 'detach', summary: 'Return the instance ids at once, without waiting' },
        verbose: { long: 'verbose', summary: 'Echo every parameter of every piping before the run' },
        bindings: {
          long: '<node>.<field>',
          summary: 'Override one parameter or execution control of one node (@<piping id> names a node whose title is ambiguous)',
          value: { name: 'value', kind: 'word' },
          family: {
            pattern: NODE_FIELD,
            names_list: async (operands: readonly string[]): Promise<string[]> => {
              const named: string | undefined = operands[0];
              if (named === undefined) return [];
              const { pipelineNodeOptions_list } = await import('../../chris/binDeclarations.js');
              return pipelineNodeOptions_list(named);
            },
          },
        },
      },
    },
    source: { summary: 'Show the pipeline YAML source', operands: [PIPELINE_OPERAND] },
    diagram: {
      summary: 'Draw the pipeline as a shallow tree',
      operands: [PIPELINE_WORDS_OPERAND],
      options: {
        withargs: { long: 'withargs', summary: "Each node's stored non-null arguments inline" },
        signalflow: { long: 'signalflow', summary: 'Emit SignalFlow YAML instead of the tree' },
      },
    },
  },
} as const satisfies CommandGrammar;

/**
 * The bindings a `pipeline run` line gave, each value read as CUBE reads a
 * scalar (`true`, `false`, a number, else the text).
 *
 * @param given - The family's options, in order.
 * @returns The bindings.
 */
function familyBindings_read(given: readonly FamilyValue[]): PipelineInvocationBinding[] {
  return given.map((one: FamilyValue): PipelineInvocationBinding => {
    const dot: number = one.name.lastIndexOf('.');
    return { node: one.name.slice(0, dot), field: one.name.slice(dot + 1), value: one.value === true ? true : argumentValue_coerce(one.value) };
  });
}

/**
 * `pipeline` with no subcommand: the subcommands, and where a run here starts.
 *
 * @returns An ok envelope; the lines went out on the sink.
 */
async function pipelineBare_handle(): Promise<CommandEnvelope> {
  const current: number | null = feedNodeInstance_find(await session.getCWD());
  sink_dataLine(chalk.gray('Usage: pipeline <list|search|inspect|info|manifest|run|source|diagram> [args]'));
  if (current !== null) {
    sink_dataLine(chalk.gray(`  A run here starts from instance ${current}, the feed node you are in`));
  }
  return envelope_ok('');
}

/**
 * Runs one `pipeline run` line.
 *
 * @param args - The line, parsed.
 * @returns The run's envelope.
 */
async function pipelineRunLine_handle(args: SubcommandArguments<typeof PIPELINE_GRAMMAR, 'run'>): Promise<CommandEnvelope> {
  const options = args.options;
  return pipelineRun_execute({
    pipeline: args.operands.pipeline,
    ...(options.compute !== undefined ? { compute: options.compute } : {}),
    ...(options.previous !== undefined ? { previous: options.previous } : {}),
    ...(options.paramFile !== undefined ? { paramFile: options.paramFile } : {}),
    bindings: familyBindings_read(options.bindings),
    detach: options.detach,
    verbose: options.verbose,
    dry: false,
    dryNewFeed: false,
  });
}

/**
 * Runs one `pipeline` line.
 *
 * @param args - The line, parsed.
 * @returns What the subcommand answers.
 */
async function pipelineLine_run(args: CommandArguments<typeof PIPELINE_GRAMMAR>): Promise<CommandEnvelope> {
  switch (args.subcommand) {
    case null: return pipelineBare_handle();
    case 'list':
      await pipelineList_handle(args.operands.search);
      return envelope_ok('');
    case 'search':
      await pipelineList_handle(args.operands.term ?? '');
      return envelope_ok('');
    case 'inspect':
      await pipelineInspect_handle();
      return envelope_ok('');
    case 'info': return pipelineInfo_handle(args.operands.pipeline);
    case 'manifest': return pipelineManifestCommand_handle(args.operands.pipeline.join(' ').trim());
    case 'run': return pipelineRunLine_handle(args);
    case 'source': return pipelineSource_handle(args.operands.pipeline);
    case 'diagram': return pipelineDiagramCommand_handle(args.operands.pipeline.join(' ').trim(), args.options.withargs, args.options.signalflow);
  }
}

/**
 * `pipeline <list|search|inspect|info|manifest|run|source|diagram> …`: the
 * declaration. `pipelines` is the same command, and a read.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [pipelineCommand] }, 'backend');
 * ```
 */
export const pipelineCommand = command_declare({
  name: 'pipeline',
  aliases: [{ name: 'pipelines', holds: [] }],
  grammar: PIPELINE_GRAMMAR,
  help: {
    summary: 'The registered ChRIS pipelines (DAG workflows): list them, read them, draw them, run them',
    description: "List the pipelines registered in CUBE, show one's nodes and topology, its YAML source and its complete registered invocation, draw it as a tree or as SignalFlow YAML, and run it from the feed node you are in, waiting for every node to settle unless --detach. A run takes --compute, --previous, a --paramFile of sparse YAML overrides, and --<node>.<field> <value> to override one parameter or execution control of one node, the node named by its title or @<piping id>. A pipeline also stands in /bin under its own name and runs as a line of its own, on operands as a plugin does (help <pipeline>). pipeline and pipelines are one command.",
    category: 'Resources',
    examples: [
      'pipeline list',
      'pipeline list PHI',
      'pipeline info PHI_detection',
      'pipeline manifest PHI_detection',
      'pipeline run PHI_detection',
      'pipeline run PHI_detection --compute gpu',
      'pipeline run PHI_detection --segmentation.threshold 0.5',
      'pipeline run PHI_detection --paramFile ~/params/run.yaml',
      'pipeline source PHI_detection',
      'pipeline diagram PHI_detection',
      'pipeline diagram --withargs PHI_detection',
      'pipeline diagram --signalflow PHI_detection | signalflow -',
      'PHI_detection --diagram                # the pipeline as a /bin line of its own',
    ],
  },
  handler: pipelineLine_run,
});

/**
 * Manages ChRIS pipeline registration, inspection, and execution: a
 * `pipeline` line over words already split, through the declaration.
 *
 * @param args - The words after `pipeline`.
 * @returns The answer, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_pipeline(['run', 'PHI_detection', '--previous', '42']);
 * ```
 */
export async function builtin_pipeline(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(pipelineCommand, args);
}
