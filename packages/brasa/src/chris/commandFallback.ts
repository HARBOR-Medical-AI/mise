/**
 * @file What the ChRIS backend does with a word the registry does not answer.
 *
 * A plugin named with its version runs as that plugin. A word naming a
 * plugin or a pipeline in `/bin` runs it (a captured line runs only a
 * pipeline: a plugin's run prints live). Its line is parsed first against
 * the declaration made from CUBE's parameters (`binDeclarations.ts`), and a
 * bad line is refused before anything runs. Anything else goes to chili,
 * when chili has the command, with a notice ahead of its output.
 *
 * @module
 */
import chalk from 'chalk';
import { variablesPage_render } from '../builtins/variablesPage.js';
import type { CommandEnvelope } from '@fnndsc/menu';
import type { BackendFallback } from '../core/backend.js';
import type { CommandDeclaration, ExpressionDeclaration } from '../core/commandDeclaration.js';
import { envelope_deliver, sink_get } from '../core/sink.js';
import { exitCode_read, exitCode_set, handler_runDirect } from '../core/handlerRun.js';
import { runs_awaitSettled, settlement_render, type RunSettlement } from '../builtins/res/runWait.js';
import { binExecutableMatches_get, binPluginHighest_find, type BinExecutableMatches, type BinPluginHighest } from './binExecutables.js';
import {
  pipelineDiagramCommand_handle, pipelineInfo_handle, pipelineManifestCommand_handle, pipelineRun_execute, pipelineSource_handle, type PipelineRunRequest,
} from '../builtins/res/pipeline.js';
import type { PipelineScheduled } from '../api/models.js';
import { builtin_executePlugin } from '../builtins/pluginExecute.js';
import { pluginExecutable_handle } from '../builtins/executable.js';
import { pipelineExecutableHelp_render, pluginExecutableHelp_render } from '../builtins/help.js';
import { chiliCommand_run, chiliCommand_exists, chiliDelegationNotice_build } from './chiliDelegate.js';
import { feed_create, type FeedCreationResult } from '@fnndsc/salsa';
import { path_extractPluginInstanceID, path_isInFeed } from '@fnndsc/cumin';
import path from 'path';
import { path_resolve } from '../core/paths.js';
import { newFeed_cacheAdd } from '../builtins/feedCreation.js';
import { OperandRefusal, operands_read, stage_lines, stage_make, stageMade_lines, stageWriter_default, stageWriter_none, type BinOperands, type Stage } from '../builtins/operands.js';
import { echoNode_render } from '../builtins/runEcho.js';
import { operandRuns_split } from '../builtins/operandRuns.js';
import { shellWords_values, type ShellArguments, type ShellWord } from '../lib/parser.js';
import {
  binDeclaration_get, binEntry_resolve, pipelineDeclaration_get, pipelineWords_parse, pluginDeclaration_get,
  type BinEntry, type PipelineLine, type PipelineLineParse,
} from './binDeclarations.js';

/** The built-in names the ChRIS session answers, for `help variables`. */
export const CHRIS_BUILTIN_LINES: ReadonlyArray<string> = [
  '  ${gather}        every gathered member, as operands (where it was gathered FROM); read live',
  '  ${gather.series.folderPath}  the same members, where they LANDED in CUBE',
  '  ${gather.name}  ${gather.feed.id}  any field of the cohort, as `gather` answers it',
];

/** Where a pipeline run starts: the instance it attaches to, or, dry, a feed that would be rooted first. */
interface RunPlace {
  /** The instance; absent, the feed node the session stands in. */
  readonly previous?: number;
  /** A dry run on a feed that would be rooted first. */
  readonly dryNewFeed: boolean;
  /** Whether the run rooted a feed first. */
  readonly rooted: boolean;
}

/**
 * The node a pipeline run starts from, read from its operand (#1303): a
 * directory inside a feed is that node; outside one, or a set of files
 * shaped into a stage, pl-dircopy roots a new feed first, the directory's
 * name (or the subjects') as its title, and the run goes on from that root.
 *
 * @param name - The pipeline's `/bin` name, for the refusal lines.
 * @param line - The line, read.
 * @param dry - Say where the run would start, staging and rooting nothing (`whatif`).
 * @returns Where the run starts, or null after a refusal was said.
 */
async function pipelineOperand_place(name: string, line: PipelineLine, dry: boolean = false): Promise<RunPlace | null> {
  let operands: BinOperands;
  try {
    operands = await operands_read(line.operands);
  } catch (error: unknown) {
    if (!(error instanceof OperandRefusal)) throw error;
    sink_get().err_write(chalk.red(`${name}: ${error.message}\n`));
    return null;
  }
  if (operands.directory === null && operands.subjects.length === 0) {
    // No operand: the working directory is the input, as it is for a plugin run from /bin. Inside a feed node the
    // run goes on from that node (`pipeline run` reads it); outside one, pl-dircopy roots a new feed on it first,
    // as the directory operand would (#1364).
    if (line.previous !== undefined) return { previous: line.previous, dryNewFeed: false, rooted: false };
    const cwd: string = await path_resolve('.');
    if (path_isInFeed(cwd)) return { dryNewFeed: false, rooted: false };
    operands = { ...operands, directory: cwd, typed: [cwd] };
  }
  if (line.previous !== undefined) {
    sink_get().err_write(chalk.red(`${name}: the operand and --previous say the input twice\n`));
    return null;
  }
  if (operands.directory !== null && path_isInFeed(operands.directory)) {
    const here: number | null = path_extractPluginInstanceID(operands.directory);
    if (here === null) {
      sink_get().err_write(chalk.red(`${name}: ${operands.typed[0]} is in a feed but not at a node (…/feeds/feed_N/pl-x_ID)\n`));
      return null;
    }
    return { previous: here, dryNewFeed: false, rooted: false };
  }
  let stage: Stage | null = null;
  let root: string = operands.directory ?? '';
  let title: string = path.posix.basename(root);
  if (operands.directory === null) {
    try {
      stage = await stage_make(operands.subjects, await path_resolve('~'), dry ? stageWriter_none() : stageWriter_default());
    } catch (error: unknown) {
      if (!(error instanceof OperandRefusal)) throw error;
      sink_get().err_write(chalk.red(`${name}: ${error.message}\n`));
      return null;
    }
    if (dry) sink_get().data_write(chalk.cyan(`would stage under ${stage.path}\n`));
    for (const stageLine of stage_lines(stage)) sink_get().data_write(chalk.cyan(`${stageLine}\n`));
    root = stage.path;
    title = stage.subjects.map((subject): string => subject.name).join(', ');
  }
  if (dry) {
    sink_get().data_write(chalk.gray(`${echoNode_render(root, title)}\n`));
    return { dryNewFeed: true, rooted: false };
  }
  const feed: FeedCreationResult | null = await feed_create([root], { title });
  if (feed === null) {
    sink_get().err_write(chalk.red(`${name}: could not root a feed with pl-dircopy of ${operands.typed.join(' ')}\n`));
    return null;
  }
  const rootInstanceID: number = feed.pluginInstance.data.id;
  newFeed_cacheAdd({ feedID: feed.id, title, ownerUsername: feed.owner_username, rootInstanceID });
  sink_get().data_write(chalk.green(`Feed created: ${feed.id}\n`));
  if (stage !== null) {
    for (const made of stageMade_lines(stage, `/home/${feed.owner_username}/feeds/feed_${feed.id}/pl-dircopy_${rootInstanceID}/data`)) sink_get().data_write(chalk.cyan(`${made}\n`));
  }
  return { previous: rootInstanceID, dryNewFeed: false, rooted: true };
}

/**
 * Runs a pipeline once from the node its operand names.
 *
 * @param name - The pipeline's `/bin` name.
 * @param line - The line, read: at most one directory operand.
 * @param dry - Resolve the run and print it, creating and running nothing.
 * @returns The run's envelope; an error envelope after a refusal was said.
 */
async function pipelineRun_start(name: string, line: PipelineLine, dry: boolean = false): Promise<CommandEnvelope> {
  // The operand says where the run starts (#1303); refused, nothing runs.
  const placed: RunPlace | null = await pipelineOperand_place(name, line, dry);
  if (placed === null) return { status: 'error', rendered: '' };
  const request: PipelineRunRequest = {
    pipeline: name,
    ...(line.compute !== undefined ? { compute: line.compute } : {}),
    ...(placed.previous !== undefined ? { previous: placed.previous } : {}),
    ...(line.paramFile !== undefined ? { paramFile: line.paramFile } : {}),
    bindings: line.bindings.map((binding) => ({ node: binding.node, field: binding.field, value: binding.value })),
    detach: line.detach,
    verbose: line.verbose,
    dry,
    dryNewFeed: placed.dryNewFeed,
  };
  const envelope: CommandEnvelope = await pipelineRun_execute(request);
  // The model says when the run rooted a feed first: the fallback rooted it, so the fallback says so (the kind is
  // `pipeline.scheduled`, PIPELINE_SCHEDULED_KIND; named here so a test's stub of the pipeline module need not carry it).
  if (placed.rooted && envelope.model?.kind === 'pipeline.scheduled') (envelope.model.data as PipelineScheduled).newFeed = true;
  return envelope;
}

/**
 * Runs a pipeline line: once, or once per directory operand when the line
 * names several, each run headed by its operand.
 *
 * @param name - The pipeline's `/bin` name.
 * @param line - The line, read.
 * @param dry - Resolve every run and print it, creating and running nothing.
 * @returns The last run's envelope, an error when any run failed or the line was refused.
 */
async function pipelineRuns_start(name: string, line: PipelineLine, dry: boolean = false): Promise<CommandEnvelope> {
  let runs: string[][];
  try {
    runs = await operandRuns_split(line.operands);
  } catch (error: unknown) {
    if (!(error instanceof OperandRefusal)) throw error;
    sink_get().err_write(chalk.red(`${name}: ${error.message}\n`));
    return { status: 'error', rendered: '' };
  }
  if (runs.length === 1) return pipelineRun_start(name, line, dry);
  // Every run is dispatched before any is waited for; then one wait holds the line for them all.
  const instanceIDs: number[] = [];
  let last: CommandEnvelope = { status: 'ok', rendered: '' };
  let failed: boolean = false;
  for (const words of runs) {
    sink_get().data_write(chalk.gray(`${name} ${words[0]}:\n`));
    last = await pipelineRun_start(name, { ...line, operands: words, detach: true }, dry);
    failed ||= last.status === 'error';
    if (last.model?.kind === 'pipeline.scheduled') {
      instanceIDs.push(...(last.model.data as PipelineScheduled).instances.map((node): number => node.instanceId));
    }
  }
  if (!line.detach && instanceIDs.length > 0) {
    const settlement: RunSettlement = await runs_awaitSettled(instanceIDs, name);
    sink_get().data_write(`${settlement_render(settlement, name)}\n`);
    if (settlement.outcome === 'settled' && settlement.failed > 0) exitCode_set(1);
  }
  return failed ? { ...last, status: 'error' } : last;
}

/**
 * Answers a pipeline line already read: the look it asks for, or its runs.
 *   --diagram (with --withargs, or --signalflow) → the diagram
 *   --signalflow             → SignalFlow YAML
 *   --help / -h              → the pipeline's page
 *   --nodes / --parameters   → pipeline info
 *   --manifest               → pipeline manifest
 *   --source / --readme      → pipeline source
 *   otherwise                → a run
 *
 * @param name - The pipeline's `/bin` name.
 * @param line - The line, read against its declaration.
 * @param dry - Resolve a run and print it, creating and running nothing.
 * @returns The answer's envelope.
 *
 * @example
 * ```ts
 * await pipelineParsed_run('PHI_detection_id12', line);
 * ```
 */
export async function pipelineParsed_run(name: string, line: PipelineLine, dry: boolean = false): Promise<CommandEnvelope> {
  const exitCodeBefore: number = exitCode_read();
  let envelope: CommandEnvelope;
  switch (line.look) {
    case 'help': envelope = { status: 'ok', rendered: pipelineExecutableHelp_render(name, (await pipelineDeclaration_get(name)) ?? undefined) }; break;
    case 'diagram': envelope = await pipelineDiagramCommand_handle(name, line.withArguments, line.signalflow); break;
    case 'signalflow': envelope = await pipelineDiagramCommand_handle(name, false, true); break;
    case 'manifest': envelope = await pipelineManifestCommand_handle(name); break;
    case 'nodes': envelope = await pipelineInfo_handle(name); break;
    case 'source': envelope = await pipelineSource_handle(name); break;
    case null: envelope = await pipelineRuns_start(name, line, dry); break;
  }
  const exitCodeAfter: number = exitCode_read();
  if (exitCodeAfter !== 0 && exitCodeAfter !== exitCodeBefore) envelope.status = 'error';
  return envelope;
}

/**
 * Handles a pipeline name invoked directly as an executable from /bin: its
 * line parsed against the declaration made from its manifest, a bad line
 * refused before anything runs.
 *
 * @param name - The pipeline's `/bin` name.
 * @param args - Arguments following the pipeline name.
 * @param dry - Resolve a run and print it, creating and running nothing.
 * @returns The answer's envelope; an error after a refusal.
 */
async function pipelineExecutable_handle(name: string, args: string[], dry: boolean = false): Promise<CommandEnvelope> {
  const declaration: CommandDeclaration | null = await pipelineDeclaration_get(name);
  if (declaration === null) {
    sink_get().err_write(chalk.red(`${name}: could not read the pipeline's manifest from CUBE, so the line cannot be read\n`));
    exitCode_set(1);
    return { status: 'error', rendered: '' };
  }
  const parsed: PipelineLineParse = await pipelineWords_parse(declaration, args);
  if (!parsed.ok) {
    sink_get().err_write(`${chalk.red(parsed.refusal)}\n`);
    exitCode_set(1);
    return { status: 'error', rendered: '' };
  }
  return pipelineParsed_run(name, parsed.line, dry);
}

/**
 * Hands a word to chili when chili has it, with the hand-off notice on the
 * live sink first, so it appears ahead of chili's (possibly slow) output.
 *
 * @param command - The word.
 * @param args - Its arguments.
 * @returns chili's delivered envelope, or null when chili has no such command.
 */
async function chili_delegate(command: string, args: string[]): Promise<CommandEnvelope | null> {
  if (!(await chiliCommand_exists(command))) return null;
  sink_get().data_write(chiliDelegationNotice_build(command));
  const chiliEnvelope: CommandEnvelope = await chiliCommand_run(command, ['-s', ...args]);
  envelope_deliver(chiliEnvelope);
  return chiliEnvelope;
}

/**
 * `whatif <plugin or Pipeline line>`: resolves the line as a run would, to
 * the version, the operands, the stage, the node and the parameters, prints
 * that, and stops before anything is created or run. A prefix, as `time`
 * and `env` are, since every flag after a `/bin` name is the plugin's: the
 * line after it is parsed against that plugin's or pipeline's declaration,
 * and refused as the real line would be.
 *
 * @param args - The line: the `/bin` name and its words.
 * @returns An ok envelope when the real line would be accepted; an error after the refusal the real line would give.
 */
export async function builtin_whatif(args: string[]): Promise<CommandEnvelope> {
  const [command, ...words] = args;
  if (command === undefined) {
    sink_get().err_write(chalk.red('whatif: usage: whatif <plugin or Pipeline> [operands] [options]\n'));
    return { status: 'error', rendered: '' };
  }
  // The words after the /bin name keep the shell words the line carried, so its operands glob by kind.
  const carried: readonly ShellWord[] | undefined = (args as ShellArguments).words;
  const lineWords: string[] = carried !== undefined && carried.length === args.length ? shellWords_values(carried.slice(1)) : words;
  const binMatches: BinExecutableMatches = await binExecutableMatches_get(command);
  if (binMatches.plugin) return builtin_executePlugin(command, lineWords, undefined, true);
  if (binMatches.pipeline) {
    const envelope: CommandEnvelope = await pipelineExecutable_handle(binMatches.pipeline.name, lineWords, true);
    envelope_deliver(envelope);
    return { ...envelope, rendered: '' };
  }
  const highest: BinPluginHighest | null = await binPluginHighest_find(command);
  if (highest !== null) {
    sink_get().data_write(chalk.gray(`running ${highest.executable} (highest of ${highest.versions.join(', ')})\n`));
    return builtin_executePlugin(highest.executable, lineWords, undefined, true);
  }
  sink_get().err_write(chalk.red(`whatif: ${command}: not a plugin or a Pipeline in /bin\n`));
  return { status: 'error', rendered: '' };
}

/**
 * Completes a word of a `whatif` line as the line after it completes: its
 * first word a plugin or pipeline `/bin` lists, then the rest from that
 * entry's declaration (its options, and its input paths).
 *
 * @param words - The words after `whatif`, before the one completed.
 * @param word - The word typed so far.
 * @returns The candidates.
 */
async function whatifWord_complete(words: readonly string[], word: string): Promise<string[]> {
  const first: string | undefined = words[0];
  if (first === undefined) {
    const { binNames_list } = await import('./completion.js');
    return (await binNames_list()).filter((name: string): boolean => name.startsWith(word));
  }
  const declaration: CommandDeclaration | null = await binDeclaration_get(first);
  if (declaration === null) return [];
  const { declaredWord_complete } = await import('../lib/completer/declared.js');
  return declaredWord_complete(declaration, words.slice(1), word);
}

/**
 * `whatif <plugin or Pipeline line>`: the declaration. Its words are a whole
 * line of another command, whose grammar is that command's (the declaration
 * CUBE's parameters make), so it hands them on as they came, as `time` and
 * `env` would.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [whatifCommand] }, 'backend');
 * ```
 */
export const whatifCommand: ExpressionDeclaration = {
  name: 'whatif',
  grammar: 'expression',
  help: {
    usage: 'whatif <plugin or Pipeline> [operands] [options]',
    summary: 'Print what a plugin or Pipeline line would do, and run nothing',
    description: 'Resolve the line as a run would and print it: the version picked, the operands as read, the stage, the node it would attach to or the feed it would root, and every parameter with defaults marked. Nothing is staged, no feed is made, no job starts. When the real line would refuse, whatif prints the same refusal and exits non-zero: the line is parsed against the plugin\'s or Pipeline\'s own declaration, made from CUBE\'s parameters. A prefix, as time and env are: every flag after a /bin name belongs to the plugin, and several directory operands print one resolution per run.',
    category: 'Resources',
    examples: ['whatif pl-freesurfer ~/uploads/t1.nii as sub-01', 'whatif pl-dcm2niix ~/feeds/feed_12/pl-dircopy_40/data'],
  },
  holds: [],
  handler: builtin_whatif,
  complete: whatifWord_complete,
};

/**
 * The page of a `/bin` entry, its usage and every option from the
 * declaration CUBE's parameters make.
 *
 * @param entry - The entry.
 * @returns The page.
 */
async function binEntryHelp_render(entry: BinEntry): Promise<string> {
  if (entry.kind === 'plugin') return pluginExecutableHelp_render(entry.executable, (await pluginDeclaration_get(entry.executable)) ?? undefined);
  return pipelineExecutableHelp_render(entry.name, (await pipelineDeclaration_get(entry.name)) ?? undefined);
}

/** The ChRIS backend's fallback. */
export const chrisFallback: BackendFallback = {
  claim: async (command: string, args: string[]): Promise<CommandEnvelope | null> => {
    // A plugin version's page is its declaration's, read from CUBE.
    if (/-v[^/]+$/.test(command) && (args.includes('--help') || args.includes('-h'))) {
      return { status: 'ok', rendered: pluginExecutableHelp_render(command, (await pluginDeclaration_get(command)) ?? undefined) };
    }
    return pluginExecutable_handle(command, args);
  },
  unknown: async (command: string, args: string[], captured: boolean): Promise<CommandEnvelope | null> => {
    const binMatches: BinExecutableMatches = await binExecutableMatches_get(command);
    // A bare /bin plugin name runs the plugin, and a run is a CUBE job: typed
    // at the prompt it starts one; inside a pipe or a redirect it does not, so
    // a pipeline of words never starts a job as a side effect.
    if (!captured && binMatches.plugin) {
      return handler_runDirect(
        (pluginArgs: string[]): Promise<CommandEnvelope> => builtin_executePlugin(command, pluginArgs),
        args,
      );
    }
    if (binMatches.pipeline) {
      // By its /bin name, as when it was typed: a pipeline named by its own
      // name runs as exactly the one /bin lists.
      const envelope: CommandEnvelope = await pipelineExecutable_handle(binMatches.pipeline.name, args);
      envelope_deliver(envelope);
      return envelope;
    }
    // A bare plugin name runs the highest version /bin lists for it, and
    // says which, so the line read back names exactly what ran (#1303).
    // The same job rule as above: typed at the prompt it starts one, in a
    // pipe or a redirect it does not.
    const highest: BinPluginHighest | null = captured ? null : await binPluginHighest_find(command);
    if (highest !== null) {
      sink_get().data_write(chalk.gray(`running ${highest.executable} (highest of ${highest.versions.join(', ')})\n`));
      return handler_runDirect(
        (pluginArgs: string[]): Promise<CommandEnvelope> => builtin_executePlugin(highest.executable, pluginArgs),
        args,
      );
    }
    return chili_delegate(command, args);
  },
  help: async (command: string): Promise<string | null> => {
    // The variables page: the core's, with this backend's built-in lines.
    if (command === 'variables') return variablesPage_render(CHRIS_BUILTIN_LINES);
    // A plugin version (`pl-dircopy-v2.1.2`) is its own executable.
    if (/-v[^/]+$/.test(command)) return pluginExecutableHelp_render(command, (await pluginDeclaration_get(command)) ?? undefined);
    // A pipeline, or a bare plugin name (its highest version's page).
    const entry: BinEntry | null = await binEntry_resolve(command);
    return entry === null ? null : binEntryHelp_render(entry);
  },
  declaration: binDeclaration_get,
};
