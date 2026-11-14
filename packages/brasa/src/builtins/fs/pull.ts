/**
 * @file Builtin pull command.
 *
 * Blocking PACS series retrieve with parallel execution and per-series structured progress.
 * Accepts one or more `/net/pacs/queries/...` VFS paths (query, study, or series level)
 * and materialises the matching DICOM series into ChRIS storage.
 *
 * Progress is driven by LONK WebSocket push notifications (api/v1/pacs/ws/).
 * Use `--retry N` to automatically re-fire retrieves for series that received no LONK activity.
 *
 * @module
 */

import chalk from 'chalk';
import { Client, seriesStorage_resolve } from '@fnndsc/cumin';
import {
  feed_create,
  retrieveTask_make,
  retrieveTasks_fire,
  retrieveTasks_skipComplete,
  retrieve_fireAndWatch,
  retrieve_confirmLoop,
  retrieveProgress_classify,
  type FeedCreationResult,
  type RetrieveTask,
  type RetrieveWatchEvents,
  type RetrieveProgressStatus,
} from '@fnndsc/salsa';
import { session } from '../../session/index.js';
import { args_checkHasHelpFlag, help_render } from '../help.js';
import { pacsQuery_createAndWait, queryExpr_parse } from '../net/query.js';
import { spinner } from '../../lib/spinner.js';
import { path_resolve } from '../utils.js';
import {
  PACSSeriesInfo,
  pacs_seriesCollect,
  pacsServer_resolve,
} from '../net/pacsUtils.js';
import { builtin_cubepath } from '../net/cubepath.js';
import { pullArgs_parse, type PullArgs } from './pull.args.js';
import { sink_get, sink_dataLine, sink_errLine } from '../../core/sink.js';
import { repl_confirm } from '../../core/question.js';
import { jobletCurrent_get } from '../../core/jobletScope.js';
import type { ProgressStatus } from '../../core/progress.js';
import { newFeed_cacheAdd, run_follow } from '../feedCreation.js';
import { cohort_read, cohortFolders_note, cohortModel_wrap } from '../res/gather.store.js';
import { ambient_publish } from '../../core/ambient.js';
import { type CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';

interface PullPathResolution {
  paths: string[];
  complete: boolean;
}

interface PulledFeedResult {
  feedID: number;
  rootInstanceID: number;
  owner: string;
}

function pullProgress_emit(task: RetrieveTask, status?: ProgressStatus, phase: 'watching' | 'retrying' = 'watching'): void {
  const current: number = task.actualFiles;
  const total: number = task.expectedFiles > 0 ? Math.max(task.expectedFiles, current, 1) : Math.max(current, 1);
  sink_get().progress_write({
    operation: 'pull',
    kind: 'retrieve',
    phase,
    itemId: task.seriesUID,
    label: task.label,
    current,
    total,
    percent: total > 0 ? Math.min(100, (current / total) * 100) : undefined,
    unit: 'files',
    status: status ?? retrieveProgress_classify(task),
    ...(task.cubePathDir !== null ? { path: task.cubePathDir } : {}),
    ...(task.reason !== undefined ? { reason: task.reason } : {}),
  });
}

/**
 * Says where each landed series was filed.
 *
 * LONK confirms a retrieve by count, and CUBE registers the folder a beat
 * later, so the watch ends knowing that a series is home but not where. A
 * surface offering IMAGE on the row needs the folder, and only the kernel
 * can name it: it is resolved here, once per series that landed, and said
 * on the same channel the retrieve reported on. A folder CUBE cannot yet
 * name is left for the next query to fill in.
 *
 * @param allTasks - Every task this pull covered.
 */
async function pulledFolders_announce(allTasks: RetrieveTask[]): Promise<void> {
  const landed: RetrieveTask[] = allTasks.filter(
    (t: RetrieveTask) => t.status === 'pulled' && t.lonkConfirmed,
  );
  await Promise.all(landed.map(async (task: RetrieveTask): Promise<void> => {
    if (task.cubePathDir === null) {
      const stateResult = await seriesStorage_resolve(task.seriesUID, { attempts: 4, delayMs: 2_000 });
      if (!stateResult.ok || stateResult.value.folderPath === null) return;
      task.cubePathDir = stateResult.value.folderPath;
      if (stateResult.value.fileCount > task.actualFiles) task.actualFiles = stateResult.value.fileCount;
    }
    pullProgress_emit(task, 'done');
  }));
}

/**
 * Notes on the cohort where each series this pull holds landed, so a cohort
 * pulled from a script reads as home (`expect gather unpulled`, `gather
 * process`) without a surface to tell it.
 *
 * @param allTasks - Every task this pull covered.
 * @returns How many members changed.
 */
async function cohortFolders_noteFromTasks(allTasks: RetrieveTask[]): Promise<number> {
  const landed: Map<string, string> = new Map();
  for (const task of allTasks) {
    if (task.status === 'pulled' && task.cubePathDir !== null) landed.set(task.seriesUID, task.cubePathDir);
  }
  return await cohortFolders_note(landed);
}

/** How long a pull with nobody to ask waits on a silent PACS, in seconds. */
const UNASKED_WAIT_S: number = 60;

/**
 * Asks whether to keep waiting on a silent PACS.
 *
 * A silent PACS is the operator's call, not a timer's: CUBE has been
 * checked already, and the question says what it found.
 *
 * @param waiting - The series still waiting on a first file.
 * @param waitedS - How long the PACS has been silent, in seconds.
 * @returns True to keep waiting.
 */
async function stillWaiting_ask(waiting: RetrieveTask[], waitedS: number): Promise<boolean> {
  const which: string = waiting.length === 1 ? (waiting[0] as RetrieveTask).label : `${waiting.length} series`;
  try {
    return await repl_confirm(`No files from the PACS yet for ${which} after ${waitedS}s, and none in CUBE. Keep waiting? (y/n)`);
  } catch {
    // Nobody to ask (a script, a pipe): wait the longer window, then stop.
    return waitedS < UNASKED_WAIT_S;
  }
}

/**
 * Engine progress events rendered onto this surface's structured sink, plus
 * the retry-round banner line.
 *
 * @param detached - Whether the pull runs in the background (a joblet). A
 *   question asked there waits for an `fg` nobody knows to type while every
 *   silent series goes on reading as in flight, so a detached pull asks
 *   nothing: the engine waits its long window and ends the silent series.
 * @returns Event callbacks for the retrieve engine.
 */
function pullEvents_make(detached: boolean): RetrieveWatchEvents {
  return {
    ...(detached ? {} : { stillWaiting: stillWaiting_ask }),
    task: (task: RetrieveTask, status: RetrieveProgressStatus, phase: 'watching' | 'retrying'): void =>
      pullProgress_emit(task, status, phase),
    retryRound: (attempt: number, retryMax: number, count: number): void =>
      sink_dataLine(chalk.yellow(`\nRetry ${attempt}/${retryMax} for ${count} unconfirmed series...`)),
    // Said out loud: a silent reconnection during a long pull is
    // indistinguishable from a stall, and this one takes seconds.
    reconnect: (attempt: number, maxAttempts: number, watching: number): void =>
      sink_dataLine(chalk.gray(
        `  Retrieve watch reconnecting (${attempt}/${maxAttempts}) — ${watching} series still in flight; ` +
        'the retrieves themselves are unaffected.',
      )),
  };
}

/**
 * Closes the pull's progress channel with an honest terminal state.
 *
 * A pull that lost its watch is neither a success nor a failure: the surface
 * should stop showing work in flight without claiming an outcome nobody
 * observed.
 *
 * @param allTasks - Every task this pull covered.
 * @param failed - Whether any series genuinely failed or was never fired.
 * @param unconfirmed - How many series the watch stopped following.
 */
function pullProgress_complete(allTasks: RetrieveTask[], failed: boolean, unconfirmed: number): void {
  const done: number = allTasks.filter((t: RetrieveTask) => t.status === 'pulled').length;
  const label: string = failed
    ? 'Pull incomplete'
    : (unconfirmed > 0 ? `Pull ended — ${unconfirmed} series unconfirmed` : 'Pull complete');
  sink_get().progress_write({
    operation: 'pull',
    kind: 'retrieve',
    phase: failed ? 'failed' : 'complete',
    label,
    current: done,
    total: allTasks.length,
    percent: allTasks.length > 0 ? (done / allTasks.length) * 100 : 100,
    unit: 'series',
    status: failed ? 'error' : (unconfirmed > 0 ? 'unconfirmed' : 'done'),
  });
}

/**
 * Walks a VFS path and returns RetrieveTask array, delegating collection to pacsUtils.
 *
 * @param pathStr - Absolute VFS path to a query, study, or series directory.
 * @param fallbackPacsName - PACS identifier used when RetrieveAETitle is absent.
 * @returns Array of RetrieveTask ready for firing.
 */
async function path_seriesCollect(pathStr: string, fallbackPacsName: string): Promise<RetrieveTask[]> {
  const infos: PACSSeriesInfo[] = await pacs_seriesCollect(pathStr, fallbackPacsName, 'pull');
  return infos.map((info: PACSSeriesInfo): RetrieveTask => retrieveTask_make({
    label: info.label,
    seriesUID: info.seriesUID,
    studyUID: info.studyUID,
    pacsName: info.pacsName,
    expectedFiles: info.expectedFiles,
  }));
}

/**
 * Resolves raw path/query arguments to concrete `/net/pacs` VFS paths,
 * running PACS queries for query expressions.
 *
 * @param paths - Raw path or query-expression operands.
 * @param pacsserver - The resolved PACS server identifier.
 * @returns Resolved VFS paths and whether every operand resolved.
 */
async function paths_resolveToVfs(
  paths: string[],
  pacsserver: string,
): Promise<PullPathResolution> {
  const resolvedPaths: string[] = [];
  let complete: boolean = true;
  for (const rawPath of paths) {
    const p: string = rawPath.startsWith('/') ? rawPath : await path_resolve(rawPath);
    if (p.startsWith('/net/pacs')) {
      resolvedPaths.push(p);
    } else if (queryExpr_parse(rawPath)) {
      // Query with the RAW expression: path resolution prefixes the CWD,
      // which would corrupt the first DICOM key (e.g. '/AccessionNumber').
      spinner.start(`Querying PACS for ${rawPath}...`, true);
      const qResult: Awaited<ReturnType<typeof pacsQuery_createAndWait>> = await pacsQuery_createAndWait(
        rawPath,
        `pull_${rawPath}`,
        pacsserver,
        (msg: string) => spinner.updateMessage(msg),
      );
      spinner.stop();
      if (qResult) {
        sink_dataLine(chalk.gray(`  → ${qResult.vfsPath}`));
        resolvedPaths.push(qResult.vfsPath);
      } else {
        sink_errLine(chalk.red(`pull: Query failed for: ${rawPath}`));
        complete = false;
      }
    } else {
      sink_errLine(chalk.red(`pull: Not a PACS VFS path or valid query expression: ${rawPath}`));
      complete = false;
    }
  }
  return { paths: resolvedPaths, complete };
}

/**
 * Prints the pull summary and sets a non-zero exit code on any failure.
 *
 * @param allTasks - All pull tasks.
 * @param totalFiringErrors - Count of retrieve-firing errors across all attempts.
 */
function pullSummary_print(allTasks: RetrieveTask[], totalFiringErrors: number): void {
  const pulled: number = allTasks.filter((t: RetrieveTask) => t.status === 'pulled').length;
  const totalCount: number = allTasks.length;
  // Not seeing the end of a retrieve is not the same as it failing. The PACS
  // keeps pushing and CUBE keeps registering after a watch drops, so a series
  // the client lost sight of is reported as unknown rather than lost — and it
  // does not fail the command, because nothing here knows that it failed.
  const unconfirmed: RetrieveTask[] = allTasks.filter((t: RetrieveTask) => t.status === 'unconfirmed');
  const failures: RetrieveTask[] = allTasks.filter(
    (t: RetrieveTask) => t.status !== 'pulled' && t.status !== 'unconfirmed',
  );

  if (failures.length === 0 && unconfirmed.length === 0) {
    sink_dataLine(chalk.green(`\n✓ ${pulled}/${totalCount} series pulled successfully.`));
  } else {
    sink_dataLine(chalk.yellow(`\n⚠ ${pulled}/${totalCount} series confirmed.`));
    // An unfired series is permanent loss for this run: no retrieve exists, so
    // nothing will ever arrive for it.
    for (const f of failures) {
      if (f.status === 'unfired') {
        sink_dataLine(chalk.red(`  ✗ ${f.label} [FAILED TO FIRE — will not arrive; re-run pull]`));
      } else {
        sink_dataLine(chalk.yellow(`  ✗ ${f.label} [${f.status.toUpperCase()} — verify with: pacs status]`));
        if (f.reason !== undefined) sink_dataLine(chalk.yellow(`      ${f.reason}`));
      }
    }
    for (const u of unconfirmed) {
      sink_dataLine(chalk.gray(`  ? ${u.label} [WATCH ENDED — may still be arriving; check with: pacs status]`));
      if (u.reason !== undefined) sink_dataLine(chalk.gray(`      ${u.reason}`));
    }
    if (unconfirmed.length > 0) {
      sink_dataLine(chalk.gray(
        `  The retrieve watch ended before ${unconfirmed.length} series finished. ` +
        'That is a lost connection, not a failed retrieve.',
      ));
    }
    // Only a real failure fails the command.
    if (failures.length > 0) {
      exitCode_set(1);
    }
  }

  if (totalFiringErrors > 0) {
    sink_dataLine(chalk.red(`  ${totalFiringErrors} retrieve(s) were never fired — re-run pull to fetch them.`));
    exitCode_set(1);
  }

  pullProgress_complete(allTasks, failures.length > 0 || totalFiringErrors > 0, unconfirmed.length);
}

/**
 * Resolves the exact CUBE directories materialised by a completed pull.
 *
 * @param allTasks - Successfully pulled series tasks.
 * @param client - Authenticated ChRIS API client.
 * @returns De-duplicated CUBE directories, or null if any series is unresolved.
 */
async function feedInputDirs_resolve(
  allTasks: RetrieveTask[],
  client: Client,
): Promise<string[] | null> {
  const resolved: Array<{ task: RetrieveTask; folderPath: string | null }> = await Promise.all(
    allTasks.map(async (task: RetrieveTask) => {
      if (task.cubePathDir !== null) return { task, folderPath: task.cubePathDir };
      const stateResult = await seriesStorage_resolve(task.seriesUID, { attempts: 4, delayMs: 2_000 });
      return { task, folderPath: stateResult.ok ? stateResult.value.folderPath : null };
    }),
  );

  const missing = resolved.find(({ folderPath }) => folderPath === null);
  if (missing) {
    sink_errLine(chalk.red(
      `pull: Could not resolve CUBE storage for series ${missing.task.seriesUID}; new feed not created.`,
    ));
    return null;
  }

  return [...new Set(resolved.map(({ folderPath }) => folderPath as string))];
}

/**
 * Creates a feed whose pl-dircopy root contains exactly the pulled series.
 *
 * @param title - Requested feed title.
 * @param allTasks - Successfully pulled series tasks.
 * @param client - Authenticated ChRIS API client.
 * @returns True when a valid feed and root instance were created.
 */
async function pulledFeed_create(
  title: string,
  allTasks: RetrieveTask[],
  client: Client,
): Promise<PulledFeedResult | null> {
  const dirs: string[] | null = await feedInputDirs_resolve(allTasks, client);
  if (dirs === null) return null;

  const feed: FeedCreationResult | null = await feed_create(dirs, { title });
  const feedID: number = Number(feed?.id);
  const rootInstanceID: number = Number(feed?.pluginInstance?.data?.id);
  const owner: string = typeof feed?.owner_username === 'string'
    ? feed.owner_username.trim()
    : '';
  if (!feed || !Number.isInteger(feedID) || feedID <= 0 ||
      !Number.isInteger(rootInstanceID) || rootInstanceID <= 0 || owner.length === 0) {
    sink_errLine(chalk.red(`pull: Failed to create feed '${title}'.`));
    return null;
  }

  newFeed_cacheAdd({
    feedID,
    title,
    ownerUsername: owner,
    rootInstanceID,
  });
  // A pull's feed is a run like any other: followed until it settles, so
  // the header's pulse counts it while it works and stops when it is done.
  run_follow(feedID);

  sink_dataLine(chalk.green(`Feed created: ${feedID}`));
  sink_dataLine(chalk.green(`Root job: pl-dircopy (ID: ${rootInstanceID})`));
  sink_dataLine(`Input: ${allTasks.length} PACS series`);
  sink_dataLine(chalk.cyan(
    `Feed path: /home/${owner}/feeds/feed_${feedID}/pl-dircopy_${rootInstanceID}/data/`,
  ));
  return { feedID, rootInstanceID, owner };
}


/**
 * Pulls one or more `/net/pacs/queries/...` VFS paths into ChRIS storage.
 *
 * Blocking by default: emits per-series structured progress via LONK WebSocket,
 * exits non-zero on partial failure.
 * With `--nowait`: fires retrieves and prints `<seriesUID> <retrieveId>` per line, then returns.
 * With `--retry N`: re-fires retrieves for [NO LONK] series up to N additional times.
 * With `--new-feed TITLE`: creates one feed from the exact successfully retrieved set.
 *
 * @param args - Command arguments (VFS paths, optional flags).
 * @example
 * pull /net/pacs/queries/42_AccessionNumber:12345678
 * pull --retry 3 /net/pacs/queries/42_AccessionNumber:12345678/Study_1.2.3_US-Hips
 */
export async function builtin_pull(args: string[]): Promise<CommandEnvelope> {
  if (args_checkHasHelpFlag(args, 'pull')) {
    return envelope_ok(help_render('pull'));
  }

  const parsed: PullArgs = pullArgs_parse(args);
  const { nowait, retryMax, newFeedTitle, parseError, paths } = parsed;

  if (parseError !== null) {
    sink_errLine(chalk.red(`pull: ${parseError}.`));
    exitCode_set(1);
    return envelope_error('');
  }

  if (nowait && newFeedTitle !== null) {
    sink_errLine(chalk.red('pull: --new-feed cannot be combined with --detach.'));
    exitCode_set(1);
    return envelope_error('');
  }

  if (paths.length === 0) {
    sink_errLine(chalk.red(
      'pull: No paths specified. Usage: pull [--detach] [--retry N] [--new-feed <title>] <vfs-path> [...]',
    ));
    exitCode_set(1);
    return envelope_error('');
  }

  const pacsIdentifier: string | null = await pacsServer_resolve();
  if (!pacsIdentifier) {
    sink_errLine(chalk.red('pull: No PACS server available. Set one with: pacs connect <id>'));
    exitCode_set(1);
    return envelope_error('');
  }
  const pacsserver: string = pacsIdentifier;

  const pathResolution: PullPathResolution = await paths_resolveToVfs(paths, pacsserver);
  const resolvedPaths: string[] = pathResolution.paths;
  let selectionComplete: boolean = pathResolution.complete;

  const allTasks: RetrieveTask[] = [];
  for (const p of resolvedPaths) {
    const tasks: RetrieveTask[] = await path_seriesCollect(p, pacsIdentifier);
    if (tasks.length === 0) {
      sink_errLine(chalk.yellow(`pull: No series found under: ${p}`));
      selectionComplete = false;
    }
    allTasks.push(...tasks);
  }

  if (allTasks.length === 0) {
    sink_errLine(chalk.red('pull: No series to retrieve.'));
    exitCode_set(1);
    return envelope_error('');
  }

  const client: Client | null = await session.connection.client_get();
  if (!client) {
    sink_errLine(chalk.red('pull: Not connected to ChRIS.'));
    exitCode_set(1);
    return envelope_error('');
  }

  // Idempotent recovery: skip series whose expected file count is already
  // registered in CUBE, so re-running the same pull fetches only what is
  // missing instead of re-firing the whole study.
  const skipped: number = await retrieveTasks_skipComplete(allTasks);
  if (skipped > 0) {
    sink_dataLine(chalk.gray(`pull: ${skipped}/${allTasks.length} series already in CUBE — skipped.`));
  }
  const toFetch: RetrieveTask[] = allTasks.filter((t: RetrieveTask) => t.status !== 'pulled');

  // --nowait: fire retrieves and exit without watching
  if (nowait) {
    await retrieveTasks_fire(toFetch, pacsserver);
    for (const t of toFetch) {
      if (t.retrieveId !== null) {
        sink_dataLine(`${t.seriesUID} ${t.retrieveId}`);
      } else {
        sink_dataLine(`${t.seriesUID} ERROR`);
        exitCode_set(1);
      }
    }
    return envelope_ok('');
  }

  const events: RetrieveWatchEvents = pullEvents_make(jobletCurrent_get() !== null);
  let totalFiringErrors: number = toFetch.length > 0
    ? await retrieve_fireAndWatch(toFetch, pacsserver, client, events)
    : 0;
  totalFiringErrors += await retrieve_confirmLoop(allTasks, retryMax, pacsserver, client, events);

  // Where each series landed, before the channel closes: a surface can offer
  // the image the moment the pull says it is home.
  await pulledFolders_announce(allTasks);
  const cohortChanged: number = await cohortFolders_noteFromTasks(allTasks);
  pullSummary_print(allTasks, totalFiringErrors);

  // Report CUBE paths via cubepath; --retry handles pacsseries DB lag post-pull
  const cubeEnvelope: CommandEnvelope = await builtin_cubepath([...resolvedPaths, '--retry']);
  if (cubeEnvelope.rendered.length > 0) sink_get().data_write(cubeEnvelope.rendered);
  if (cubeEnvelope.renderedErr !== undefined && cubeEnvelope.renderedErr.length > 0) sink_get().err_write(cubeEnvelope.renderedErr);

  let created: PulledFeedResult | null = null;
  if (newFeedTitle !== null) {
    if (!selectionComplete) {
      sink_errLine(chalk.red(
        'pull: New feed not created because the requested selection was incomplete.',
      ));
      exitCode_set(1);
      return envelope_error('');
    }
    const incomplete: boolean = totalFiringErrors > 0 || allTasks.some(
      (task: RetrieveTask) => task.status !== 'pulled',
    );
    if (incomplete) {
      sink_errLine(chalk.red('pull: New feed not created because retrieval was incomplete.'));
      exitCode_set(1);
      return envelope_error('');
    }
    const feedResult: PulledFeedResult | null = await pulledFeed_create(newFeedTitle, allTasks, client);
    if (feedResult === null) {
      exitCode_set(1);
      return envelope_error('');
    }
    created = feedResult;
  }

  if (newFeedTitle === null) {
    sink_dataLine(chalk.gray('Detached — use `pacsretrieve report <queryId>` to verify.'));
    // A pull that moved the cohort says so in data: a surface showing the
    // cohort redraws from the kernel's copy rather than waiting for the
    // next gather verb to learn its members are home.
    if (cohortChanged > 0) return envelope_ok('', cohortModel_wrap(await cohort_read()));
    return envelope_ok('');
  }
  if (created === null) return envelope_ok('');
  // The cohort's members are home, but this line answers with the feed it
  // made (what `F=$(pull --new-feed …)` holds): the cohort goes out on the
  // session bus instead, so a surface showing it redraws (#1252).
  if (cohortChanged > 0) {
    ambient_publish({ kind: 'envelope', envelope: { status: 'ok', rendered: '', model: cohortModel_wrap(await cohort_read()) } });
  }
  // The feed a pull created is a model, so a surface binds to its root
  // (the place a run appended to it takes as input) rather than reading
  // the id and the path out of the text above.
  return envelope_ok('', {
    kind: 'feed.created',
    data: {
      feedId: created.feedID,
      rootInstanceId: created.rootInstanceID,
      owner: created.owner,
      path: `/home/${created.owner}/feeds/feed_${created.feedID}/pl-dircopy_${created.rootInstanceID}/data`,
    },
  });
}
