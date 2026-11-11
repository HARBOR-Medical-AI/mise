/**
 * @file Plugin Execute Builtin
 *
 * This module implements the builtin for executing plugins "in place"
 * based on current directory context.
 *
 * @module
 */

import { plugin_executeInPlace, plugins_list, PluginExecutionResult } from '@fnndsc/salsa';
import { Dictionary, procCache_get } from '@fnndsc/cumin';
import { type ListingItem, envelope_error, envelope_ok, type CommandEnvelope } from '@fnndsc/menu';
import chalk from 'chalk';
import { session } from '../session/index.js';
import { vfs } from '../lib/vfs/vfs.js';
import { newFeed_cacheAdd, run_follow } from './feedCreation.js';
import { runs_awaitSettled, settlement_render, settlementStatus_derive, type RunSettlement } from './res/runWait.js';
import { executableArguments_parse } from './argumentTokens.js';
import { pluginSelector_normalize } from './pluginSelector.js';
import { sink_dataLine, sink_errLine } from '../core/sink.js';
import { errorStack, Result, type StackMessage } from '@fnndsc/fond';
import { exitCode_set } from '../core/handlerRun.js';
import { path_resolve } from '../core/paths.js';
import { OperandRefusal, operands_read, stage_lines, stage_make, stageMade_lines, type BinOperands, type Stage } from './operands.js';
import { operandRuns_split } from './operandRuns.js';

/**
 * Reads a plugin's kind from CUBE: `fs`, `ds` or `ts`.
 *
 * @param pluginName - The `/bin` name, `<name>-v<version>`.
 * @returns The kind, or null when CUBE did not say.
 */
async function pluginKind_read(pluginName: string): Promise<string | null> {
  const match: RegExpMatchArray | null = pluginName.match(/^(.+)-v(.+)$/);
  if (match === null) return null;
  const listed: unknown = await plugins_list({ search: { name_exact: match[1] as string, version: match[2] as string } });
  const row: Record<string, unknown> | undefined = (listed as { tableData?: Array<Record<string, unknown>> } | null)?.tableData?.[0];
  const kind: unknown = row?.['type'];
  return typeof kind === 'string' ? kind : null;
}

/**
 * Executes a plugin in the current directory context.
 *
 * This function is called when the user types a plugin name that exists in /bin.
 * It handles parameter parsing, interactive prompts, and delegates execution to salsa.
 *
 * @param pluginName - Full plugin name with version (e.g., pl-dcm2niix-v2.1.1).
 * @param args - Array of command line arguments.
 * @param place - Where the run stands instead of the session's cwd, so a
 *   caller can run off a node without moving the operator (`gather process`
 *   runs off its cohort's feed root).
 * @returns Command envelope whose status matches parsing and execution.
 *
 * @example
 * ```typescript
 * // User types: pl-dcm2niix-v2.1.1 --outputdir results -- feed_title="Brain MRI"
 * await builtin_executePlugin('pl-dcm2niix-v2.1.1', [
 *   '--outputdir', 'results', '--', 'feed_title=Brain MRI'
 * ]);
 * ```
 */
export async function builtin_executePlugin(
  pluginName: string,
  args: string[],
  place?: string,
): Promise<CommandEnvelope> {
  if (place !== undefined) return pluginRun_execute(pluginName, args, place);
  // Several directory operands are several runs, one each; to an fs plugin
  // they are its one `dir`, untranslated, so that line stays one run.
  let runs: string[][];
  try {
    runs = await operandRuns_split(args);
    if (runs.length > 1 && await pluginKind_read(pluginName) === 'fs') runs = [args];
  } catch (error: unknown) {
    if (!(error instanceof OperandRefusal)) throw error;
    sink_errLine(chalk.red(`${pluginName}: ${error.message}`));
    return envelope_error('');
  }
  if (runs.length === 1) return pluginRun_execute(pluginName, args);
  // Every run is dispatched before any is waited for; then one wait holds the line for them all.
  const detach: boolean = args.includes('--detach');
  const instanceIDs: number[] = [];
  let last: CommandEnvelope = envelope_ok('');
  let failed: boolean = false;
  for (const words of runs) {
    sink_dataLine(chalk.gray(`${pluginName} ${words[0]}:`));
    last = await pluginRun_execute(pluginName, detach ? words : [...words, '--detach']);
    failed ||= last.status === 'error';
    const instanceID: unknown = last.model?.kind === 'run.scheduled' ? (last.model.data as { instanceId?: unknown }).instanceId : undefined;
    if (typeof instanceID === 'number') instanceIDs.push(instanceID);
  }
  if (!detach && instanceIDs.length > 0) {
    const settlement: RunSettlement = await runs_awaitSettled(instanceIDs, pluginName);
    sink_dataLine(settlement_render(settlement, pluginName));
    if (settlement.outcome === 'settled' && settlement.failed > 0) exitCode_set(1);
  }
  return failed ? { ...last, status: 'error' } : last;
}

/**
 * Executes one plugin run: at most one directory operand, or file operands.
 *
 * @param pluginName - Full plugin name with version.
 * @param args - Array of command line arguments.
 * @param place - Where the run stands instead of the session's cwd.
 * @returns Command envelope whose status matches parsing and execution.
 */
async function pluginRun_execute(
  pluginName: string,
  args: string[],
  place?: string,
): Promise<CommandEnvelope> {
  try {
    // 0. `--detach` is the SESSION's flag, never the plugin's: it says the
    //    operator wants the handle now rather than the outcome later, so it
    //    is taken out of the line before the plugin's own parameters are
    //    read. Left in, it would be posted to CUBE as a plugin parameter.
    const detach: boolean = args.includes('--detach');
    args = args.filter((arg: string): boolean => arg !== '--detach');

    // 0b. The input operand (operands.ts): a directory replaces cwd; files
    //     are shaped into a stage the run roots the feed with; to an fs
    //     plugin an operand is its `dir`, untranslated.
    let operandPlace: string | null = null;
    let stage: Stage | null = null;
    let operandDir: string | null = null;
    if (place === undefined) {
      let operands: BinOperands;
      try {
        operands = await operands_read(args);
      } catch (error: unknown) {
        if (!(error instanceof OperandRefusal)) throw error;
        sink_errLine(chalk.red(`${pluginName}: ${error.message}`));
        return envelope_error('');
      }
      args = operands.rest;
      if (operands.directory !== null || operands.subjects.length > 0) {
        const kind: string | null = await pluginKind_read(pluginName);
        if (kind === null) {
          sink_errLine(chalk.red(`${pluginName}: could not read the plugin's kind from CUBE, so the operand cannot be placed`));
          return envelope_error('');
        }
        if (kind === 'fs') {
          const named = operands.subjects.find((subject): boolean => subject.named);
          if (named !== undefined) {
            sink_errLine(chalk.red(`${pluginName}: as ${named.name}: an fs plugin takes paths as its dir, not subjects`));
            return envelope_error('');
          }
          operandDir = [...operands.directories, ...operands.subjects.flatMap((subject): string[] => subject.files)].join(',');
        } else if (operands.directory !== null) {
          operandPlace = operands.directory;
        } else {
          try {
            stage = await stage_make(operands.subjects, await path_resolve('~'));
          } catch (error: unknown) {
            if (!(error instanceof OperandRefusal)) throw error;
            sink_errLine(chalk.red(`${pluginName}: ${error.message}`));
            return envelope_error('');
          }
          for (const line of stage_lines(stage)) sink_dataLine(chalk.cyan(line));
          operandPlace = stage.path;
        }
      }
    }

    // 1. Split the already-tokenized arguments on the context delimiter.
    const delimiterIndex: number = args.indexOf('--');
    const pluginArgTokens: string[] = delimiterIndex === -1 ? args : args.slice(0, delimiterIndex);
    const contextArgTokens: string[] = delimiterIndex === -1 ? [] : args.slice(delimiterIndex + 1);

    // 2. Parse both sets of parameters
    let pluginParams: Dictionary = {};
    let contextParams: Dictionary = {};

    if (pluginArgTokens.length > 0) {
      try {
        pluginParams = executableArguments_parse(pluginArgTokens);
      } catch (e: unknown) {
        const msg: string = e instanceof Error ? e.message : String(e);
        sink_errLine(chalk.red(`Error parsing plugin parameters: ${msg}`));
        return envelope_error('');
      }
    }

    if (operandDir !== null) pluginParams['dir'] = operandDir;

    if (contextArgTokens.length > 0) {
      try {
        contextParams = executableArguments_parse(contextArgTokens);
      } catch (e: unknown) {
        const msg: string = e instanceof Error ? e.message : String(e);
        sink_errLine(chalk.red(`Error parsing context parameters: ${msg}`));
        return envelope_error('');
      }
    }

    // 3. Set default context params if not provided
    const cwd: string = place ?? operandPlace ?? await session.getCWD();
    const isInFeed: boolean = cwd.includes('/feeds/feed_');

    // If no context params provided and not in a feed, use directory name as
    // feed title; a stage is named by its subjects, not its id.
    if (contextArgTokens.length === 0 && !isInFeed) {
      const defaultTitle: string = stage !== null ? stage.subjects.map((subject): string => subject.name).join(', ') : cwd.split('/').pop() || 'Untitled';
      contextParams.feed_title = defaultTitle;
      sink_dataLine(chalk.cyan(`Using feed title: "${defaultTitle}" (customize with -- feed_title="Custom Title")`));
    }

    // 4. Get /bin listing for finding pl-dircopy
    const binResult: Result<ListingItem[]> = await vfs.data_get('/bin');
    if (!binResult.ok) {
      sink_errLine(chalk.red('Failed to access /bin directory'));
      return envelope_error('');
    }

    const binListing: string[] = binResult.value.map((item: ListingItem) => item.name);

    // 5. Convert plugin name from /bin format to ChRIS search format
    // Example: pl-dcm2niix-v1.0.2 → name_exact:pl-dcm2niix,version:1.0.2
    const pluginSearchString: string = pluginSelector_normalize(pluginName);

    // 6. Execute via salsa
    const result: PluginExecutionResult | null = await plugin_executeInPlace(
      pluginSearchString,
      pluginParams,
      contextParams,
      cwd,
      binListing
    );

    if (!result) {
      // Display all errors from the stack for better debugging
      sink_errLine(chalk.red('Plugin execution failed:'));
      let error: StackMessage | undefined = errorStack.stack_pop();
      while (error) {
        sink_errLine(chalk.red(`  - ${error.message}`));
        error = errorStack.stack_pop();
      }
      return envelope_error('');
    }

    // 7. Push to procCache so /proc reflects new jobs immediately
    if (result.feedID !== undefined && result.dircopyInstanceID !== undefined) {
      // New feed: push dircopy root node + plugin node
      const feedTitle: string = typeof contextParams.feed_title === 'string'
        ? contextParams.feed_title
        : cwd.split('/').pop() || `feed_${result.feedID}`;
      newFeed_cacheAdd({
        feedID: result.feedID,
        title: feedTitle,
        ownerUsername: cwd.split('/')[2] ?? '',
        rootInstanceID: result.dircopyInstanceID,
        child: { id: result.pluginInstanceID, pluginName: result.pluginName },
      });
      // The run follows itself until it settles, so the header's pulse is
      // right whether or not anyone has a pane open on this feed.
      run_follow(result.feedID);
    } else if (result.parentID !== null) {
      // Continue feed: push just the new instance
      const feedID: number | null = (() => {
        const inst = procCache_get().instance_get(result.parentID!);
        return inst ? inst.feedID : null;
      })();
      if (feedID !== null) {
        procCache_get().instance_add({
          id: result.pluginInstanceID, feedID,
          parentID: result.parentID, pluginName: result.pluginName, params: null, status: 'scheduled',
        });
        // Work added to an existing feed is a run starting too: follow it,
        // or the header counts it as scheduled for the cache's whole life.
        run_follow(feedID);
      }
    }

    // 8. Render output
    if (result.feedID) {
      sink_dataLine(chalk.green(`Feed created: ${result.feedID}`));
    }
    // What CUBE made of the stage: the real paths, since the data moved.
    if (stage !== null && result.feedID !== undefined && result.dircopyInstanceID !== undefined) {
      const rootOutput: string = `/home/${cwd.split('/')[2] ?? ''}/feeds/feed_${result.feedID}/pl-dircopy_${result.dircopyInstanceID}/data`;
      for (const line of stageMade_lines(stage, rootOutput)) sink_dataLine(chalk.cyan(line));
    }
    const feedIDOfRun: number | null = result.feedID !== undefined
      ? result.feedID
      : result.parentID !== null ? (procCache_get().instance_get(result.parentID)?.feedID ?? null) : null;
    sink_dataLine(chalk.green(`Job scheduled: ${pluginName} (ID: ${result.pluginInstanceID})`));
    sink_dataLine(chalk.cyan(`Output will be in: ${result.outputPath}`));

    // A run that returns when CUBE accepts it reads as finished and is not:
    // the next line of a script would work on output that does not exist.
    // The wait holds this LINE, never the session — progress goes out while
    // it waits, and Esc detaches, which is what `--detach` asks for up front.
    let status: string = 'detached';
    if (!detach) {
      const settlement: RunSettlement = await runs_awaitSettled([result.pluginInstanceID], pluginName);
      sink_dataLine(settlement_render(settlement, pluginName));
      if (settlement.outcome === 'settled' && settlement.failed > 0) exitCode_set(1);
      status = settlementStatus_derive(settlement, result.pluginInstanceID);
    }
    // The run as a model, so a surface can point at what it started — the
    // feed it landed in and the instance it is — rather than parse the lines.
    const feedID: number | null = feedIDOfRun;
    if (feedID === null) return envelope_ok('');
    return envelope_ok('', {
      kind: 'run.scheduled',
      data: {
        pluginName,
        instanceId: result.pluginInstanceID,
        feedId: feedID,
        newFeed: result.feedID !== undefined,
        outputPath: result.outputPath,
        status,
      },
    });
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    sink_errLine(chalk.red(`Error executing plugin: ${msg}`));
    return envelope_error('');
  }
}
