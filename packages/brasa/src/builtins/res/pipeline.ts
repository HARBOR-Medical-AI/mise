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
import { args_checkHasHelpFlag, help_render } from '../help.js';
import { sink_get, sink_dataLine, sink_errLine } from '../../core/sink.js';
import { echoValue_render } from '../runEcho.js';
import { pipelineRunArgs_parse, type PipelineRunOverrides } from './pipeline.args.js';
import { runs_awaitSettled, settlement_render, settlementStatus_derive, type RunSettlement } from './runWait.js';
import type { PipelineNode, PipelineScheduled } from '../../api/models.js';
import { pipelineDiagram_handle, type PipelineDiagramMode } from './pipeline.diagram.js';
import { pipelineManifest_render, pipelineParameters_render } from './pipeline.manifest.js';
import { path_resolve } from '../utils.js';
import { errorStack, type Result, type StackMessage } from '@fnndsc/fond';
import { type CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';

const PIPELINE_PROGRESS_DELAY_MS: number = 300;
const PIPELINE_PROGRESS_LABEL: string = 'Reading registered pipeline…';

/**
 * Handles `pipeline list [search]`.
 *
 * @param args - Command arguments.
 */
async function pipelineList_handle(args: string[]): Promise<void> {
  const search: string | undefined = args[1];
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
 * @param args - Command arguments.
 * @returns Command envelope whose status matches resolution and manifest fetching.
 */
async function pipelineInfo_handle(args: string[]): Promise<CommandEnvelope> {
  const nameOrId: string | undefined = args[1];
  if (!nameOrId) {
    sink_errLine(chalk.red('Usage: pipeline info <name|id>'));
    exitCode_set(1);
    return envelope_error('');
  }
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

/**
 * Handles `pipeline run <name|id> [--compute <r>] [--previous <id>]`.
 *
 * @param args - Command arguments.
 * @returns Command envelope whose status matches Workflow creation.
 */
async function pipelineRun_handle(args: string[]): Promise<CommandEnvelope> {
  const nameOrId: string | undefined = args[1];
  if (!nameOrId) {
    sink_errLine(chalk.red('Usage: pipeline run <name|id> [--compute <resource>] [--previous <inst_id>]'));
    exitCode_set(1);
    return envelope_error('');
  }

  const parsed: PipelineRunOverrides = pipelineRunArgs_parse(args);
  const { computeOverride, previousOverride } = parsed;
  if (parsed.parseError !== null) {
    sink_errLine(chalk.red(`pipeline run: ${parsed.parseError}`));
    exitCode_set(1);
    return envelope_error('');
  }

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
    const resolvedPath: string = await path_resolve(parsed.paramFile);
    const virtualPrefix: string | undefined = ['/bin', '/usr', '/etc', '/proc', '/net']
      .find((prefix: string): boolean => resolvedPath === prefix || resolvedPath.startsWith(`${prefix}/`));
    if (virtualPrefix !== undefined) {
      sink_errLine(chalk.red(`pipeline run: --paramFile must name a readable CFS file, not '${resolvedPath}'`));
      exitCode_set(1);
      return envelope_error('');
    }
    const contentResult: Result<string> = await fileContent_get(resolvedPath);
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
    cliBindings: parsed.bindings,
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
 * @param args - Command arguments.
 * @returns Command envelope whose status matches source retrieval.
 */
async function pipelineSource_handle(args: string[]): Promise<CommandEnvelope> {
  const nameOrId: string | undefined = args[1];
  if (!nameOrId) {
    sink_errLine(chalk.red('Usage: pipeline source <name|id>'));
    exitCode_set(1);
    return envelope_error('');
  }
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
 * @param args - Command arguments.
 * @returns Complete registered invocation manifest as serializable YAML.
 */
async function pipelineManifestCommand_handle(args: string[]): Promise<CommandEnvelope> {
  const specifier: string = args.slice(1).join(' ').trim();
  if (specifier.length === 0) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red('Usage: pipeline manifest <name|id|slug>')}\n`);
  }
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

/** Parsed arguments for `pipeline diagram`. */
interface PipelineDiagramArgs {
  specifier: string;
  withArguments: boolean;
  signalflow: boolean;
}

/** Parses diagram flags while preserving every non-flag word as the search specifier. */
function pipelineDiagramArgs_parse(args: string[]): PipelineDiagramArgs {
  const words: string[] = [];
  let withArguments: boolean = false;
  let signalflow: boolean = false;
  for (const argument of args.slice(1)) {
    if (argument === '--withargs') withArguments = true;
    else if (argument === '--signalflow') signalflow = true;
    else words.push(argument);
  }
  return { specifier: words.join(' ').trim(), withArguments, signalflow };
}

/** Handles shallow and SignalFlow pipeline diagram output. */
async function pipelineDiagramCommand_handle(args: string[]): Promise<CommandEnvelope> {
  const parsed: PipelineDiagramArgs = pipelineDiagramArgs_parse(args);
  if (!parsed.specifier) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red('Usage: pipeline diagram [--withargs | --signalflow] <name|id>')}\n`);
  }
  if (parsed.withArguments && parsed.signalflow) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red('pipeline diagram: --withargs is only available for shallow rendering')}\n`);
  }
  const mode: PipelineDiagramMode = parsed.signalflow
    ? 'signalflow'
    : parsed.withArguments ? 'shallow-withargs' : 'shallow';
  return pipelineDiagram_handle(parsed.specifier, mode);
}

/**
 * Manages ChRIS pipeline registration, inspection, and execution.
 *
 * @param args - Command arguments.
 */
export async function builtin_pipeline(args: string[]): Promise<CommandEnvelope> {
  if (args_checkHasHelpFlag(args, 'pipeline')) {
    return envelope_ok(help_render('pipeline'));
  }

  const subcommand: string | undefined = args[0];

  if (!subcommand) {
    const current: number | null = feedNodeInstance_find(await session.getCWD());
    sink_dataLine(chalk.gray('Usage: pipeline <list|info|manifest|run|source|diagram> [args]'));
    if (current !== null) {
      sink_dataLine(chalk.gray(`  A run here starts from instance ${current}, the feed node you are in`));
    }
    return envelope_ok('');
  }

  switch (subcommand) {
    case 'list':
      await pipelineList_handle(args);
      return envelope_ok('');
    case 'info':
      return pipelineInfo_handle(args);
    case 'run':
      return pipelineRun_handle(args);
    case 'source':
      return pipelineSource_handle(args);
    case 'manifest':
      return pipelineManifestCommand_handle(args);
    case 'diagram':
      return pipelineDiagramCommand_handle(args);
    case 'inspect':
      await pipelineInspect_handle();
      return envelope_ok('');
    case 'search':
      return builtin_pipeline(['list', args[1] ?? '']);
    default:
      sink_errLine(chalk.red(`pipeline: unknown subcommand '${subcommand}'`));
      sink_dataLine(chalk.gray('  Subcommands: list, search, inspect, info, manifest, run, source, diagram'));
      exitCode_set(1);
      return envelope_error('');
  }
}
