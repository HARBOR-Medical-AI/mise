/**
 * @file Builtin proc command.
 * Manages the /proc VFS cache (job monitoring). Declared in one record
 * (`procCommand`): one subcommand per question asked of the job index.
 *
 * Key components:
 * - procCommand: the declaration.
 * - builtin_proc: the declaration run over words already split.
 * - procUniverseModel_build: the universe as the index holds it.
 *
 * Typical usage:
 * ```ts
 * await builtin_proc(['jobs', 'list', '--sort', 'erroredJobs', '--reverse']);
 * ```
 *
 * Dependencies: salsa's /proc index (roster, topology, warm-up); cumin's
 * proc cache; the session's cwd for `here` and `jump`.
 *
 * @module
 */
import chalk from 'chalk';
import { context_getSingle, procCache_refresh, procFeed_ensureLoaded, procFeed_probe, procTarget_locate, type ProcLocation, procFeed_refreshStart, type FeedTopologyReadiness, procRoster_sync, procTopologyCatchup_status, procPipelineBackfill_status, procRoster_syncStart, procTopology_await, procTopology_retry, procTopology_status, procTopology_warmup, jobs_find, type ProcTopologyStatus } from '@fnndsc/salsa';
import { path_extractFeedID, path_extractPluginInstanceID, path_isInFeed, procCache_get, feedStatus_deriveFromCounts, procLayout_get, procLayout_set, procLayoutName_check, procLayoutPositions_check, type ProcLayoutRecord, type ProcCacheLifecycle, type ProcFeed, type ProcFeedScopeCounts, type ProcInstance, type ProcWarmupProgress, type SingleContext, feedTags_readByFeed } from '@fnndsc/cumin';
import { FEED_LIST_MODEL_KIND, PROC_JUMP_MODEL_KIND, type ProcJumpModel, PROC_LAYOUT_MODEL_KIND, PROC_UNIVERSE_MODEL_KIND, type FeedListModel, type ProcLayoutModel, type ProcUniverseModel, type CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { spinner } from '../lib/spinner.js';
import { universeLayout_underWay, universeLayouts_warm } from '../chris/universeLayout.js';
import { command_declare, type CommandArguments, type CommandGrammar, type SubcommandArguments } from '../core/commandDeclaration.js';
import { declaredCommand_run } from '../core/commandParse.js';
import { builtin_cd } from './fs/cd.js';
import { procWatch_add, procWatch_remove, procWatch_list, watchSubject_parse, type ProcWatchEntry } from './procWatch.js';
import { feedIndexing_envelope } from './res/feed.diagram.js';
import { feedTotals_derive } from './feedTotals.js';
import { session } from '../session/index.js';
import { list_applySort } from '@fnndsc/chili/utils/sort.js';
import { screen, table_render } from '@fnndsc/chili/screen/screen.js';
import {
  ProcJobEntry, ALL_JOB_FIELDS,
  feedStatus_derive, statusColor, jobFields_select,
  procEntries_filterBySearch, procCsv_render, feedId_parse,
} from './proc.helpers.js';
import { type Result, errorStack } from '@fnndsc/fond';
import { exitCode_set } from '../core/handlerRun.js';

type ProcCache = ReturnType<typeof procCache_get>;

/**
 * Refuses a global cache query while topology warm-up is incomplete.
 *
 * @param command - Command the user can repeat with `--force`.
 * @param force - Whether to await the active warm-up instead of refusing.
 * @returns An error envelope when blocked, otherwise null.
 */
async function procWarmup_guard(command: string, force: boolean): Promise<CommandEnvelope | null> {
  const cache: ProcCache = procCache_get();
  const progress: ProcWarmupProgress = cache.warmupProgress_get();
  const topology: ProcTopologyStatus = procTopology_status();
  if (cache.lifecycle_get().checkpointAt && !force) return null;
  if (!progress.active && topology.state !== 'running' && topology.state !== 'failed') return null;

  if (topology.state === 'failed') {
    exitCode_set(1);
    const reason: string = topology.failure ? `: ${topology.failure}` : '';
    return envelope_error('', undefined,
      `${chalk.red(`proc: the visible-job index failed to warm${reason}.`)}\n` +
      'Global queries are disabled to avoid incomplete results. Run `proc retry` to continue from the failed page.\n'
    );
  }

  if (force) {
    spinner.start('Waiting for the complete /proc job index...');
    try {
      await procTopology_await();
      const cache: ProcCache = procCache_get();
      const settled: ProcTopologyStatus = procTopology_status();
      if (settled.state !== 'complete' || cache.warmupProgress_get().active || !cache.warmupComplete) {
        throw new Error('the topology sweep did not complete');
      }
      spinner.stop();
      return null;
    } catch (error: unknown) {
      spinner.stop();
      const message: string = error instanceof Error ? error.message : String(error);
      exitCode_set(1);
      return envelope_error('', undefined, `${chalk.red(`proc warm-up failed: ${message}`)}\n`);
    }
  }

  const percent: number = progress.total > 0
    ? Math.min(99, Math.floor((progress.loaded / progress.total) * 100))
    : 0;
  const count: string = progress.total > 0
    ? `${progress.loaded}/${progress.total}, ${percent}%`
    : 'initializing';
  exitCode_set(1);
  return envelope_error('', undefined,
    `${chalk.yellow(`proc: the visible-job index is still warming (${count}).`)}\n` +
    'This query could return incomplete results.\n\n' +
    'Wait for warm-up to finish, or run:\n' +
    `  ${command} --force\n\n` +
    '--force waits for the complete index and may take some time.\n'
  );
}

// ── proc jobs ─────────────────────────────────────────────────────────────────

/**
 * Builds flat job entries from the proc cache.
 *
 * @param cache - The proc cache.
 * @returns One entry per known feed.
 */
function procEntries_build(cache: ProcCache): ProcJobEntry[] {
  return cache.feedIDs_get().map((feedID: number): ProcJobEntry => {
    const feed: ProcFeed = cache.feed_get(feedID)!;
    const topoLoaded: boolean = cache.topologyLoaded_has(feedID);
    return {
      id:            feed.id,
      title:         feed.title,
      status:        feedStatus_derive(feed),
      finishedJobs:  feed.finishedJobs,
      erroredJobs:   feed.erroredJobs,
      startedJobs:   feed.startedJobs,
      scheduledJobs: feed.scheduledJobs,
      cancelledJobs: feed.cancelledJobs,
      createdJobs:   feed.createdJobs,
      creationDate:  feed.creationDate ? feed.creationDate.substring(0, 10) : '',
      instances:     topoLoaded ? cache.instancesForFeed_count(feedID) : '-',
    };
  });
}

/**
 * Renders job entries as a bordered table.
 *
 * @param page - The entries to render.
 * @param selectedFields - The columns to show.
 * @returns The rendered table.
 */
function procJobs_renderTable(page: ProcJobEntry[], selectedFields: string[]): string {
  const tableData: Record<string, unknown>[] = page.map((e: ProcJobEntry) => {
    const row: Record<string, unknown> = {};
    selectedFields.forEach((f: string) => { row[f] = e[f] ?? ''; });
    return row;
  });
  return `${screen.table_output(tableData, {
    head: selectedFields,
    title: { title: 'proc jobs', justification: 'center' },
    typeColors: { string: 'green', number: 'yellow', boolean: 'cyan', object: 'magenta' },
  })}\n`;
}

/**
 * Renders job entries as colorized, tab-separated lines.
 *
 * @param page - The entries to render.
 * @param selectedFields - The columns to show.
 * @returns The rendered lines.
 */
function procJobs_renderLines(page: ProcJobEntry[], selectedFields: string[]): string {
  let out: string = '';
  for (const e of page) {
    const cols: string[] = selectedFields.map((f: string) => {
      const val: string = String(e[f] ?? '');
      if (f === 'id')     return chalk.bold(val);
      if (f === 'title')  return chalk.cyan(val);
      if (f === 'status') return statusColor(val);
      if (f === 'erroredJobs' && e.erroredJobs > 0) return chalk.red(val);
      return val;
    });
    out += `${cols.join('\t')}\n`;
  }
  return out;
}

/**
 * Handles `proc jobs [inspect|list]`: lists cached feed jobs with optional
 * search, sort, paging, field selection, and CSV/table output.
 *
 * @param args - The `proc jobs` line.
 * @returns An envelope carrying the listing.
 */
async function jobs_subcmd(args: SubcommandArguments<typeof PROC_GRAMMAR, 'jobs'>): Promise<CommandEnvelope> {
  if (args.operands.view === 'inspect') {
    return envelope_ok(table_render(
      [...ALL_JOB_FIELDS].map((f: string) => ({ field: f })),
      ['field'],
      { title: { title: 'proc jobs fields', justification: 'center' } }
    ));
  }

  const options = args.options;
  const blocked: CommandEnvelope | null = await procWarmup_guard('proc jobs list', options.force);
  if (blocked) return blocked;
  // The roster is index movement: answered from the cache now, walked off the lane.
  procRoster_syncStart();

  let entries: ProcJobEntry[] = procEntries_build(procCache_get());
  entries = procEntries_filterBySearch(entries, options.search ?? '');

  if (entries.length === 0) {
    return envelope_ok(`${chalk.gray('No feeds in cache.')}\n`);
  }

  const sortField: string = options.sort ?? '';
  if (sortField) entries = list_applySort(entries, sortField, options.reverse);

  const showAll: boolean = options.all;
  const limit: number = showAll ? entries.length : options.limit ?? JOBS_LIMIT;
  const page: ProcJobEntry[] = entries.slice(0, limit);
  const selectedFields: string[] = jobFields_select(options.fields ?? '');

  if (options.csv) {
    return envelope_ok(`${procCsv_render(page, selectedFields)}\n`);
  }
  if (options.table) {
    return envelope_ok(procJobs_renderTable(page, selectedFields));
  }

  let rendered: string = procJobs_renderLines(page, selectedFields);
  if (!showAll && entries.length > limit) {
    rendered += `${chalk.gray(`  … ${entries.length - limit} more. Use --all or --limit <n>.`)}\n`;
  }
  return envelope_ok(rendered);
}

// ── proc subcommand handlers ────────────────────────────────────────────────

/**
 * Handles `proc refresh [feed]`: refreshes the cache for one feed or all.
 *
 * @param feedArg - The feed, as typed; none refreshes every feed.
 * @returns An envelope reporting the refresh outcome.
 */
async function procRefresh_handle(feedArg: string | undefined): Promise<CommandEnvelope> {
  let feedID: number | undefined;

  if (feedArg) {
    const parsedId: number | null = feedId_parse(feedArg);
    if (parsedId === null) {
      exitCode_set(1);
      return envelope_error('', undefined, `${chalk.red(`proc refresh: invalid feed ID '${feedArg}'`)}\n`);
    }
    feedID = parsedId;
  }

  const scope: string = feedID !== undefined ? `feed_${feedID}` : 'all feeds';
  spinner.start(`Refreshing /proc cache (${scope})...`);

  try {
    if (feedID !== undefined) {
      // One feed's re-walk is index movement: started here, finished off
      // the lane, annunciated on the prompt. The command ends now.
      const readiness: FeedTopologyReadiness = await procFeed_refreshStart(feedID);
      spinner.stop();
      return readiness === 'pending'
        ? feedIndexing_envelope(feedID, { model: false })
        : envelope_ok(`${chalk.green(`/proc cache refreshed (${scope})`)}\n`);
    }
    await procCache_refresh(feedID);
    void procTopology_warmup().catch((): void => { /* surfaced by proc topology status */ });
    spinner.stop();
    return envelope_ok(`${chalk.green(`/proc cache refreshed (${scope})`)}\n`);
  } catch (error: unknown) {
    spinner.stop();
    const msg: string = error instanceof Error ? error.message : String(error);
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`proc refresh failed: ${msg}`)}\n`);
  }
}

/**
 * Resumes the session's failed global topology sweep at its failed page.
 *
 * @returns An envelope confirming the retained progress, or a clear error when
 * there is no failed sweep to retry.
 */
function procRetry_handle(): CommandEnvelope {
  const topology: ProcTopologyStatus = procTopology_status();
  if (topology.state !== 'failed') {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.yellow('proc retry: no failed topology sweep to retry')}\n`);
  }

  const progress: ProcWarmupProgress = procCache_get().warmupProgress_get();
  try {
    const resumed: Promise<void> = procTopology_retry();
    void resumed.catch((): void => { /* surfaced by proc topology status */ });
    return envelope_ok(
      `${chalk.green(`/proc topology retry resumed at ${progress.loaded}/${progress.total}`)}\n`,
    );
  } catch (error: unknown) {
    const message: string = error instanceof Error ? error.message : String(error);
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`proc retry failed: ${message}`)}\n`);
  }
}

/**
 * Handles `proc find <query>`: locates instances by id/plugin-name and reports
 * their /proc paths.
 *
 * @param query - An instance id, or a plugin name substring.
 * @param force - Whether a name search waits for the warm-up.
 * @returns An envelope carrying the matched paths.
 */
async function procFind_handle(query: string, force: boolean): Promise<CommandEnvelope> {

  const numeric: number = parseInt(query, 10);
  const isInstanceID: boolean = !isNaN(numeric) && String(numeric) === query;
  if (!isInstanceID) {
    const blocked: CommandEnvelope | null = await procWarmup_guard(`proc find ${query}`, force);
    if (blocked) return blocked;
  }

  spinner.start(`Finding "${query}"...`);

  try {
    const cache: ProcCache = procCache_get();
    const result: Result<Array<{ id: number; feedID: number; pluginName: string }>> = await jobs_find(query);
    if (!result.ok) {
      spinner.stop();
      exitCode_set(1);
      return envelope_error('', undefined, `${chalk.red(`Search failed.`)}\n`);
    }

    const matches: Array<{ id: number; feedID: number; pluginName: string }> = result.value;
    if (matches.length === 0) {
      spinner.stop();
      exitCode_set(1);
      return envelope_error('', undefined, `${chalk.yellow(`No instances found matching "${query}".`)}\n`);
    }

    const feedIDs: number[] = [...new Set(matches.map((m) => m.feedID))];
    await Promise.all(feedIDs.map((feedID: number) => procFeed_ensureLoaded(feedID)));

    spinner.stop();
    let rendered: string = '';
    for (const m of matches) {
      const path: string | null = cache.path_build(m.id);
      if (path) rendered += `${path}\n`;
    }
    return envelope_ok(rendered);
  } catch (error: unknown) {
    spinner.stop();
    const msg: string = error instanceof Error ? error.message : String(error);
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`proc find failed: ${msg}`)}\n`);
  }
}

/**
 * Maps a canonical CFS feed path into its matching `/proc` location.
 *
 * The CFS feed namespace and `/proc` share CUBE's feed and plugin-instance
 * identifiers. A feed root maps directly; a job path maps only after its
 * cached node confirms the same feed. An unknown node is loaded scoped to that
 * one feed rather than by a global scan.
 *
 * @param cwd - Current CFS path to examine.
 * @param cache - Current `/proc` cache.
 * @returns The matching `/proc` path, or null when the CFS path is not canonical.
 */
async function procHere_canonicalPath_get(cwd: string, cache: ProcCache): Promise<string | null> {
  if (!path_isInFeed(cwd)) return null;
  const feedID: number | null = path_extractFeedID(cwd);
  if (feedID === null || !cache.feed_get(feedID)) return null;

  const instanceID: number | null = path_extractPluginInstanceID(cwd);
  if (instanceID === null) return `/proc/jobs/feed_${feedID}`;

  let instance: ProcInstance | undefined = cache.instance_get(instanceID);
  if (!instance || instance.feedID !== feedID) {
    await procFeed_ensureLoaded(feedID);
    instance = cache.instance_get(instanceID);
  }
  if (!instance || instance.feedID !== feedID) return null;
  return cache.path_build(instanceID);
}

/**
 * Returns from a CFS output directory to its producing `/proc` job node.
 *
 * Canonical `/home/<user>/feeds/feed_<id>` paths map directly using CUBE's
 * stable feed and plugin-instance IDs. Other CFS output locations use the
 * session's CUBE-supplied output-path provenance as a fallback.
 *
 * @returns The directory-change envelope, or a clear error when provenance is unknown.
 */
async function procHere_handle(): Promise<CommandEnvelope> {
  const cache: ProcCache = procCache_get();
  const cwd: string = await session.getCWD();
  const canonicalPath: string | null = await procHere_canonicalPath_get(cwd, cache);
  if (canonicalPath) return builtin_cd([canonicalPath]);

  const source: ProcInstance | undefined = cache.outputPath_match(cwd);
  if (!source) {
    exitCode_set(1);
    return envelope_error('', undefined,
      `${chalk.yellow('proc here: no matching /proc job is known for this path in the current session.')}\n` +
      'Use a canonical CFS feed path, follow a job\'s `data` link first, or use `cd -` to return to the previous directory.\n'
    );
  }

  const procPath: string | null = cache.path_build(source.id);
  if (!procPath) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red('proc here: producing job is no longer available in /proc.')}\n`);
  }
  return builtin_cd([procPath]);
}

/**
 * Handles `proc jump [--where] <target>`: goes to a feed or a node named by
 * its id or its `/proc` name, asking CUBE for what the roster and the index
 * lack (a feed shared since the walk, a node in one). A bare number that is
 * both a feed and a node is not guessed: both are named, with the line that
 * reaches each. `--where` only answers (a surface lands its own pane there
 * and leaves the session's cwd alone).
 *
 * @param target - The feed or node: an id, feed_N or plugin_N.
 * @param whereOnly - Answer where it is, leaving the cwd alone.
 * @returns The cd envelope, or the answer with its `proc.jump` model.
 */
async function procJump_handle(target: string, whereOnly: boolean): Promise<CommandEnvelope> {
  let places: ProcLocation[];
  try {
    places = await procTarget_locate(target);
  } catch (error: unknown) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`proc jump: ${error instanceof Error ? error.message : String(error)}`)}\n`);
  }
  const model: ProcJumpModel = { target, choices: places.map((place: ProcLocation): ProcJumpModel['choices'][number] => ({ ...place })) };
  if (places.length === 0) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.yellow(`proc jump: no feed or node ${target} is visible to you: not shared with you, or shared to a group you are not in.`)}\n`);
  }
  if (places.length > 1) {
    exitCode_set(1);
    const lines: string = places.map((place: ProcLocation): string =>
      `  proc jump ${place.name}   ${chalk.dim(place.kind === 'feed' ? `the feed "${place.title}"` : `a node in feed_${place.feedId} "${place.title}"`)}`).join('\n');
    // The choices ride the refusal as its model: a surface asks which.
    return { ...envelope_error('', undefined, `${chalk.yellow(`proc jump: ${target} is both a feed and a node; say which:`)}\n${lines}\n`), model: { kind: PROC_JUMP_MODEL_KIND, data: model } };
  }
  const place: ProcLocation = places[0] as ProcLocation;
  let where: string = `/proc/jobs/feed_${place.feedId}`;
  if (place.kind === 'node' && place.nodeId !== undefined) {
    await procFeed_ensureLoaded(place.feedId);
    where = procCache_get().path_build(place.nodeId) ?? where;
  }
  if (whereOnly) return envelope_ok(`${where}\n`, { kind: PROC_JUMP_MODEL_KIND, data: model });
  return builtin_cd([where]);
}

/**
 * Handles `proc seen <feed ...> | all`: takes the NEW mark off feeds the
 * operator has looked at (a surface does it when one is opened; CLEAR NEW
 * does it for all). The marks are kept with the roster, so what is NEW
 * survives a login until it is seen.
 *
 * @param words - The feeds (feed_N or N), or `all`.
 * @returns An envelope saying how many marks were taken off.
 */
function procSeen_handle(words: readonly string[]): Promise<CommandEnvelope> {
  const cache: ProcCache = procCache_get();
  const ids: number[] = [];
  if (!words.includes('all')) {
    for (const word of words) {
      const match: RegExpExecArray | null = /^(?:feed_)?(\d+)$/.exec(word);
      if (match === null) {
        exitCode_set(1);
        return Promise.resolve(envelope_error('', undefined, `${chalk.red(`proc seen: not a feed: ${word}`)}\n`));
      }
      ids.push(Number(match[1]));
    }
  }
  const cleared: number = cache.unseen_clear(words.includes('all') ? 'all' : ids);
  return Promise.resolve(envelope_ok(`${chalk.dim(`${cleared} NEW mark${cleared === 1 ? '' : 's'} taken off.`)}\n`));
}

/**
 * Every feed's tags, for the roster: the kernel's tags index, read once per
 * tag and kept. A read that fails leaves the roster without marks and
 * leaves nothing on the error stack: the roster asked, it did not fail.
 *
 * @returns Feed id to its tag names, or null when the index could not be read.
 */
async function feedTags_read(): Promise<Map<number, string[]> | null> {
  const mark: number = errorStack.checkpoint_mark();
  const read: Result<Map<number, string[]>> = await feedTags_readByFeed();
  if (read.ok) return read.value;
  errorStack.checkpoint_drain(mark);
  return null;
}

/**
 * Handles `proc feeds <query> [--fresh]`: lists the roster's feeds whose
 * title, `feed_N` name or id matches. A bare id the roster lacks is asked
 * of CUBE live — a feed shared to this identity since the roster was walked
 * is adopted and listed, with a line saying so; one CUBE does not list is
 * answered with why. `--fresh` walks the whole feed index off the lane
 * now, so a share, an unshare or a deletion lands without waiting for the
 * roster to age.
 *
 * @param args - The `proc feeds` line.
 * @returns An envelope carrying the matched feeds.
 */
async function procFeeds_handle(args: SubcommandArguments<typeof PROC_GRAMMAR, 'feeds'>): Promise<CommandEnvelope> {
  // No query lists the whole cache-resident roster — the chooser's case.
  const query: string = args.operands.query ?? '';

  const blocked: CommandEnvelope | null = await procWarmup_guard(
    `proc feeds${query ? ` ${query}` : ''}`, args.options.force,
  );
  if (blocked) return blocked;
  // The roster is index movement: answered from the cache now, walked off
  // the lane, named on the prompt while it runs; arrivals bring the pane
  // back for the rest. `--fresh` walks the whole index now, whatever the
  // roster's age: the operator's way of asking CUBE again.
  procRoster_syncStart(args.options.fresh);

  const cache: ProcCache = procCache_get();
  const unseen: Set<number> = new Set(cache.unseen_get());
  const matches: ProcFeed[] = cache.feeds_find(query)
    .filter((feed: ProcFeed): boolean => !args.options.new || unseen.has(feed.id))
    .sort((a: ProcFeed, b: ProcFeed) => b.creationDate.localeCompare(a.creationDate));

  // Asking is an answer: a bare id the roster lacks is asked of CUBE, and
  // the answer either lists the feed or names why there is none.
  let rendered: string = '';
  if (matches.length === 0 && /^\d+$/.test(query)) {
    const asked: CommandEnvelope | ProcFeed = await procFeedAbsent_ask(Number(query));
    if (!('id' in asked)) return asked;
    matches.push(asked);
    rendered += chalk.dim(`feed_${asked.id} was not in the roster; CUBE lists it for you (owner ${asked.ownerUsername || 'unknown'}) — added.`) + '\n';
  }

  if (matches.length === 0 && args.options.new) {
    return envelope_ok(`${chalk.dim('Nothing new since your last visit.')}\n`, { kind: FEED_LIST_MODEL_KIND, data: { feeds: [] } });
  }
  if (matches.length === 0) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.yellow(
      query ? `No feed in the roster matches "${query}" (title, feed_N or id).` : 'No feeds in the cache.',
    )}\n`);
  }

  for (const feed of matches) {
    const status: string = feedStatus_derive(feed);
    rendered += `/proc/jobs/feed_${feed.id}  ${statusColor(status)}  ${chalk.dim(feed.title)}${unseen.has(feed.id) ? `  ${chalk.yellow(`NEW · from ${feed.ownerUsername}`)}` : ''}\n`;
  }
  const tagsOf: Map<number, string[]> | null = await feedTags_read();
  const model: FeedListModel = {
    feeds: matches.map((feed: ProcFeed): FeedListModel['feeds'][number] => ({
      id: feed.id,
      title: feed.title,
      owner: feed.ownerUsername,
      status: feedStatus_derive(feed),
      createdAt: feed.creationDate,
      ...(unseen.has(feed.id) ? { new: true } : {}),
      ...feedJobs_count(feed),
      ...feedTotals_derive(cache, feed.id),
      ...(tagsOf === null ? {} : { tags: tagsOf.get(feed.id) ?? [] }),
    })),
  };
  return envelope_ok(rendered, { kind: FEED_LIST_MODEL_KIND, data: model });
}

/**
 * Asks CUBE live for a feed the roster lacks.
 *
 * @param feedID - The feed asked for.
 * @returns The adopted feed, or the error envelope that says why there is none.
 */
async function procFeedAbsent_ask(feedID: number): Promise<CommandEnvelope | ProcFeed> {
  try {
    const feed: ProcFeed | null = await procFeed_probe(feedID);
    if (feed !== null) return feed;
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.yellow(
      `CUBE does not list feed_${feedID} for you: not shared with you, or shared to a group you are not in.`,
    )}\n`);
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`proc feeds: asking CUBE for feed_${feedID} failed (${msg})`)}\n`);
  }
}

/**
 * The space of everything run here: every feed whose topology the index
 * holds, as it landed — size, status, and the shape of its pipeline.
 *
 * Answered from the cache at once, whole or not: while the index warms
 * the answer is what has landed so far and says so, and a surface that
 * draws it keeps drawing as the prompt reports more. No guard, because
 * the answer is honest about its own extent.
 *
 * @returns The universe model, rendered as a count and a whole/warming word.
 */
function procUniverse_handle(): Promise<CommandEnvelope> {
  const model: ProcUniverseModel = procUniverseModel_build();
  const feeds: ProcUniverseModel['feeds'] = model.feeds;
  const whole: boolean = model.whole;
  const shapes: number = new Set(feeds.map((feed): string => feed.chain.join('>'))).size;
  const rendered: string =
    `${chalk.cyan('universe:')} ${feeds.length} feeds across ${shapes} pipeline shapes` +
    `${whole ? '' : chalk.yellow(' — the index is still warming; this is what has landed so far')}
`;
  return Promise.resolve(envelope_ok(rendered, { kind: PROC_UNIVERSE_MODEL_KIND, data: model }));
}

/**
 * The universe as the index holds it: every feed whose topology is loaded,
 * as it landed, and whether the index is whole.
 *
 * @returns The universe model.
 */
export function procUniverseModel_build(): ProcUniverseModel {
  const cache: ProcCache = procCache_get();
  const feeds: ProcUniverseModel['feeds'] = cache.feedIDs_get()
    .filter((feedID: number): boolean => cache.topologyLoaded_has(feedID))
    .map((feedID: number): ProcUniverseModel['feeds'][number] => {
      const feed: ProcFeed = cache.feed_get(feedID)!;
      const data = cache.dataFacts_read(feedID);
      return { id: feedID, title: feed.title, jobs: cache.instancesForFeed_count(feedID), status: feedStatus_deriveFromCounts(feed), chain: cache.pluginChain_derive(feedID), groups: cache.pluginGroups_build(feedID), createdAt: feed.creationDate ?? '', ...(data === undefined ? {} : { data }) };
    });
  const whole: boolean = !cache.warmupProgress_get().active && procTopology_status().state === 'complete';
  return { feeds, whole };
}

/**
 * Handles `proc layout <name>` and `proc layout put <name> <places>`: where
 * a surface last laid the universe out under a layout, kept by the session
 * so the universe is placed once per identity rather than once per browser.
 * A surface asks before it settles and draws at once from what is kept;
 * after it settles, it puts what it found.
 *
 * @param args - The `proc layout` line: a name, or `put`, a name and the places.
 * @returns The kept layout as a model, or what was kept.
 */
async function procLayout_handle(args: SubcommandArguments<typeof PROC_GRAMMAR, 'layout'>): Promise<CommandEnvelope> {
  const putting: boolean = args.operands.layout === 'put';
  const name: string = (putting ? args.operands.name : args.operands.layout) ?? '';
  if (!putting && args.operands.name !== undefined) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`proc layout: unexpected operand '${args.operands.name}'; usage: proc layout <name> | proc layout put <name> <places>`)}\n`);
  }
  if (!procLayoutName_check(name)) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`proc layout: not a layout: '${name}'`)}\n`);
  }
  if (putting) {
    let places: unknown = null;
    try {
      places = JSON.parse(args.operands.places ?? '');
    } catch {
      places = null;
    }
    if (!procLayoutPositions_check(places)) {
      exitCode_set(1);
      return envelope_error('', undefined, `${chalk.red('proc layout put: the places must be node ids to [x, y, z]')}\n`);
    }
    const kept: ProcLayoutRecord = await procLayout_set(name, places);
    return envelope_ok(`${chalk.green(`layout ${name}:`)} ${Object.keys(kept.positions).length.toLocaleString('en-US')} places kept\n`);
  }
  const kept: ProcLayoutRecord | null = await procLayout_get(name);
  // None kept and the index whole: the session lays the universe out, and
  // says how far it has come to whoever asks meanwhile.
  if (kept === null && procUniverseModel_build().whole) void universeLayouts_warm((): ProcUniverseModel['feeds'] => procUniverseModel_build().feeds);
  const laying = universeLayout_underWay(name);
  const model: ProcLayoutModel = { name, positions: kept?.positions ?? null, writtenAt: kept?.writtenAt ?? null, laying };
  const rendered: string = kept !== null
    ? `${chalk.cyan(`layout ${name}:`)} ${Object.keys(kept.positions).length.toLocaleString('en-US')} places, kept ${kept.writtenAt}\n`
    : laying !== null
      ? `${chalk.cyan(`layout ${name}:`)} laying out ${laying.nodes.toLocaleString('en-US')} spheres · ${Math.floor(laying.fraction * 100)}%\n`
      : `${chalk.cyan(`layout ${name}:`)} none kept\n`;
  return envelope_ok(rendered, { kind: PROC_LAYOUT_MODEL_KIND, data: model });
}

/**
 * A feed's settled and total job counts, from CUBE's own counters.
 *
 * These come with the feed row rather than needing resident topology, so a
 * roster can report progress for a feed nobody has opened. A feed with no
 * jobs reports zero of zero — a surface draws that as an empty track, which
 * says nothing has happened yet rather than there is nothing here.
 *
 * @param feed - The cached feed row.
 * @returns Its job counts.
 */
function feedJobs_count(feed: ProcFeed): { jobsDone: number; jobsTotal: number; jobsErrored: number } {
  // Settled means it will not change again: finished, errored or cancelled.
  const errored: number = feed.erroredJobs + feed.cancelledJobs;
  const done: number = feed.finishedJobs + errored;
  const total: number = done + feed.startedJobs + feed.scheduledJobs + feed.createdJobs;
  // The failed count travels too, so a surface can fill an errored feed's bar
  // to the work that actually succeeded rather than run it full in the error
  // hue: `jobsDone - jobsErrored` is the nodes that finished cleanly.
  return { jobsDone: done, jobsTotal: total, jobsErrored: errored };
}

/**
 * Handles `proc stat [feed]`: reports a cache summary or a single feed's detail.
 *
 * @param feedArg - The feed, as typed; none summarises the cache.
 * @returns An envelope carrying the summary or feed detail.
 */
async function procStat_handle(feedArg: string | undefined): Promise<CommandEnvelope> {
  const cache: ProcCache = procCache_get();

  if (!feedArg) {
    const warmup: ProcWarmupProgress = cache.warmupProgress_get();
    const topology: ProcTopologyStatus = procTopology_status();
    const lifecycle: ProcCacheLifecycle = cache.lifecycle_get();
    const context: SingleContext = await context_getSingle();
    const counts: ProcFeedScopeCounts = cache.feedScopeCounts_get(context.user ?? '');
    const warmupLine: string = topology.state === 'failed'
      ? chalk.red(`failed${topology.failure ? `: ${topology.failure}` : ''}`)
      : topology.state === 'running' || warmup.active
        ? chalk.yellow(warmup.active ? 'in progress' : 'initializing')
        : cache.warmupComplete
          ? chalk.green('complete')
          : chalk.dim('not started');
    const jobCount: string = warmup.total > 0
      ? `${warmup.loaded}/${warmup.total}`
      : cache.warmupComplete
        ? `${warmup.loaded}/0`
        : `${warmup.loaded}/?`;

    let rendered: string = `${chalk.bold('proc cache summary')}\n`;
    rendered += `  visible feeds  : ${chalk.cyan(String(counts.total))}\n`;
    rendered += `    user         : ${chalk.cyan(String(counts.user))}\n`;
    rendered += `    public       : ${chalk.cyan(String(counts.public))}\n`;
    rendered += `    shared       : ${chalk.cyan(String(counts.shared))}\n`;
    rendered += `  jobs loaded    : ${chalk.cyan(jobCount)}\n`;
    rendered += `  topology sweep : ${warmupLine}\n`;
    // Feeds the roster gained after the sweep land behind the prompt, one
    // walk at a time; while any wait, the readout says so.
    const catchup: { queued: number; running: boolean } = procTopologyCatchup_status();
    if (catchup.queued > 0 || catchup.running) {
      rendered += `  topology catch-up : ${chalk.yellow(`${catchup.queued + (catchup.running ? 1 : 0)} feed(s) landing`)}\n`;
    }
    // Which pipeline run made each job, read again behind the prompt for
    // rows an older checkpoint lacked: until it is done, find cannot judge
    // -pipeline for those jobs, and this says how far it has come.
    const backfill: { pages: number; read: number; running: boolean } = procPipelineBackfill_status();
    if (backfill.running) {
      rendered += `  pipeline runs  : ${chalk.yellow(`reading behind the prompt, ${backfill.read}/${backfill.pages} pages`)}\n`;
    }
    rendered += `  cache state    : ${chalk.cyan(lifecycle.state)}\n`;
    if (lifecycle.checkpointAt) rendered += `  checkpoint     : ${chalk.cyan(lifecycle.checkpointAt)}\n`;
    return envelope_ok(rendered);
  }

  const feedID: number | null = feedId_parse(feedArg);
  if (feedID === null) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`proc stat: invalid feed ID '${feedArg}'`)}\n`);
  }
  const feed: ProcFeed | undefined = cache.feed_get(feedID);
  if (!feed) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.yellow(`proc stat: feed_${feedID} not in cache`)}\n`);
  }

  const topoLoaded: boolean = cache.topologyLoaded_has(feedID);
  const instCount: number   = topoLoaded ? cache.instancesForFeed_count(feedID) : -1;
  const status: string      = feedStatus_derive(feed);

  let rendered: string = `${chalk.bold(`feed_${feedID}`)}\n`;
  rendered += `  title          : ${chalk.cyan(feed.title)}\n`;
  rendered += `  status         : ${statusColor(status)}\n`;
  rendered += `  finishedJobs   : ${feed.finishedJobs}\n`;
  rendered += `  erroredJobs    : ${chalk[feed.erroredJobs > 0 ? 'red' : 'white'](String(feed.erroredJobs))}\n`;
  rendered += `  startedJobs    : ${feed.startedJobs}\n`;
  rendered += `  scheduledJobs  : ${feed.scheduledJobs}\n`;
  rendered += `  cancelledJobs  : ${feed.cancelledJobs}\n`;
  rendered += `  createdJobs    : ${feed.createdJobs}\n`;
  rendered += `  topology       : ${topoLoaded ? chalk.green(`loaded (${instCount} instances)`) : chalk.dim('not loaded')}\n`;
  return envelope_ok(rendered);
}

// ── Watches ───────────────────────────────────────────────────────────────────

/** The operator at a console owns its watches under one name. */
const OPERATOR_OWNER: string = 'operator';

/**
 * Handles `proc watch [feed]`: opens an operator watch on a feed (its DAG is
 * then sampled while it runs, and every surface receives the refreshed
 * model), or with no argument lists the session's watches.
 *
 * @param subject - The feed, as typed; none lists the watches.
 * @returns An envelope reporting the watch state or the watch list.
 */
async function procWatch_handle(subject: string | undefined): Promise<CommandEnvelope> {
  if (subject === undefined) {
    const entries: ProcWatchEntry[] = procWatch_list();
    if (entries.length === 0) return envelope_ok(`${chalk.gray('No watches.')}\n`);
    let rendered: string = '';
    for (const entry of entries) {
      rendered += `/proc/jobs/feed_${entry.feedID}  ${chalk.cyan(entry.state)}  ${chalk.dim(`${entry.owners} owner(s)`)}\n`;
    }
    return envelope_ok(rendered);
  }
  const feedID: number | null = watchSubject_parse(subject);
  if (feedID === null) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`proc watch: not a feed: '${subject}'`)}\n`);
  }
  const state: string = procWatch_add(feedID, OPERATOR_OWNER);
  return envelope_ok(`${chalk.green(`watching /proc/jobs/feed_${feedID}`)} ${chalk.cyan(state)}\n`);
}

/**
 * Handles `proc unwatch <feed>`: releases the operator's watch on a feed.
 *
 * @param subject - The feed, as typed.
 * @returns An envelope confirming the release.
 */
async function procUnwatch_handle(subject: string): Promise<CommandEnvelope> {
  const feedID: number | null = watchSubject_parse(subject);
  if (feedID === null) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`proc unwatch: a feed is required, not '${subject}'`)}\n`);
  }
  procWatch_remove(feedID, OPERATOR_OWNER);
  return envelope_ok(`${chalk.green(`released /proc/jobs/feed_${feedID}`)}\n`);
}

// ── The declaration ───────────────────────────────────────────────────────────

/** Feeds `proc jobs list` shows when not told how many. */
const JOBS_LIMIT: number = 20;

/** A feed, as `proc` subcommands take one: feed_N, N, or its /proc path. */
const FEED_OPERAND = { name: 'feed', kind: 'word', summary: 'The feed: feed_N or its id' } as const;

/** Waits for the complete index rather than refusing while it warms. */
const FORCE_OPTION = { long: 'force', summary: 'Wait for warm-up, then answer from the complete index' } as const;

/** What a `proc` line may hold. */
const PROC_GRAMMAR = {
  bare: { summary: 'Rebuild the entire proc cache (as refresh)' },
  subcommands: {
    jobs: {
      summary: 'List all feeds with their counter fields (default 20), or inspect the field names',
      operands: [{ name: 'view', kind: 'enum', values: ['list', 'inspect'], optional: true, summary: 'list (the default), or inspect: every field name' }],
      options: {
        fields: { long: 'fields', summary: 'Select columns', value: { name: 'f,f', kind: 'word' } },
        sort: { long: 'sort', summary: 'Sort by field', value: { name: 'field', kind: 'word' } },
        reverse: { long: 'reverse', summary: 'Reverse the sort' },
        table: { long: 'table', summary: 'Tabular output' },
        csv: { long: 'csv', summary: 'CSV output' },
        all: { long: 'all', summary: 'All feeds (no limit)' },
        limit: { long: 'limit', summary: 'Feeds to show (default 20)', value: { name: 'n', kind: 'int', min: 1 } },
        search: { long: 'search', summary: 'Filter by title substring', value: { name: 'term', kind: 'word' } },
        force: FORCE_OPTION,
      },
    },
    stat: {
      summary: 'Show the cache summary, or one feed\'s raw counters and topology state',
      operands: [{ ...FEED_OPERAND, optional: true }],
    },
    feeds: {
      summary: 'Find feeds by title, feed_N name or id; an id the roster lacks is asked of CUBE',
      operands: [{ name: 'query', kind: 'word', optional: true, summary: 'Title substring, feed_N or id; none lists the whole roster' }],
      options: {
        fresh: { long: 'fresh', summary: 'Walk the whole feed index now' },
        new: { long: 'new', summary: 'Feeds shared with you since your last visit, not yet opened (NEW)' },
        force: FORCE_OPTION,
      },
    },
    seen: {
      summary: 'Take the NEW mark off feeds you have looked at',
      operands: [{ name: 'feeds', kind: 'word', repeat: true, summary: 'feed_N or N, or all' }],
    },
    universe: { summary: 'Every feed the index holds as it landed: size, status, pipeline shape; honest while warming' },
    layout: {
      summary: 'Where a surface last laid the universe out under a layout; put keeps one (node ids to [x, y, z], as JSON)',
      operands: [
        { name: 'layout', kind: 'word', summary: 'The layout\'s name; or put, to keep one' },
        { name: 'name', kind: 'word', optional: true, summary: 'With put: the layout\'s name' },
        { name: 'places', kind: 'word', optional: true, summary: 'With put: node ids to [x, y, z], as JSON' },
      ],
    },
    refresh: {
      summary: 'Rebuild the entire proc cache, or one feed\'s',
      operands: [{ ...FEED_OPERAND, optional: true }],
    },
    retry: { summary: 'Resume a failed topology sweep at its failed page' },
    find: {
      summary: 'Find a job: an instance id (available during warm-up), or a plugin name',
      operands: [{ name: 'query', kind: 'word', summary: 'An instance id, or a plugin name substring' }],
      options: { force: FORCE_OPTION },
    },
    here: { summary: 'Navigate from a CFS feed/output path to its matching job' },
    jump: {
      summary: 'Go to a feed or node by id or /proc name (feed_N, plugin_N); a number that is both is not guessed',
      operands: [{ name: 'target', kind: 'word', summary: 'A feed id, node id, feed_N or plugin_N' }],
      options: { where: { long: 'where', summary: 'Only answer where it is; the cwd stays' } },
    },
    watch: {
      summary: 'Keep a running feed live: sample it while it runs, push its DAG to every surface; none lists the watches',
      operands: [{ ...FEED_OPERAND, optional: true }],
    },
    unwatch: {
      summary: 'Release the watch on a feed',
      operands: [FEED_OPERAND],
    },
  },
} as const satisfies CommandGrammar;

/**
 * `proc <jobs|stat|feeds|seen|universe|layout|refresh|retry|find|here|jump|watch|unwatch>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [procCommand] }, 'backend');
 * ```
 */
export const procCommand = command_declare({
  name: 'proc',
  grammar: PROC_GRAMMAR,
  help: {
    summary: 'Job history inspector — navigate, query and monitor ChRIS pipeline execution via /proc/jobs',
    description: '/proc/jobs is a job history inspector for every computation visible to the current ChRIS identity. Each plugin instance is a discrete job with a parent, zero or more children, a status, parameters, and a log. Jobs are grouped into feeds (pipeline runs), and the parent-child relationships form a DAG: the execution tree of a full computation. /proc/jobs exposes this as a navigable filesystem. The daemon restores an identity-scoped local topology checkpoint, validates feed visibility with CUBE, and reconciles all plugin instances in the background. Restored queries remain usable while syncing; a cold cache still guards global queries until complete. CUBE remains authoritative.',
    category: 'Monitoring',
    examples: [
      'proc jobs list',
      'proc jobs list --sort erroredJobs --reverse --table',
      'proc jobs list --fields id,title,erroredJobs,startedJobs --all',
      'proc jobs list --search failed',
      'proc jobs inspect',
      'proc stat',
      'proc stat 899',
      'proc feeds failed',
      'proc feeds --fresh',
      'proc feeds --new',
      'proc seen all',
      'proc universe',
      'proc refresh',
      'proc retry',
      'proc find 64306',
      'proc find pl-fshack',
      'proc here',
      'proc jump 639204',
      'proc jump feed_4389',
      'proc watch feed_2583',
      'proc unwatch 2583',
    ],
  },
  handler: async (args: CommandArguments<typeof PROC_GRAMMAR>): Promise<CommandEnvelope> => {
    switch (args.subcommand) {
      case null: return procRefresh_handle(undefined);
      case 'refresh': return procRefresh_handle(args.operands.feed);
      case 'retry': return procRetry_handle();
      case 'jobs': return jobs_subcmd(args);
      case 'find': return procFind_handle(args.operands.query, args.options.force);
      case 'here': return procHere_handle();
      case 'jump': return procJump_handle(args.operands.target, args.options.where);
      case 'seen': return procSeen_handle(args.operands.feeds);
      case 'feeds': return procFeeds_handle(args);
      case 'universe': return procUniverse_handle();
      case 'layout': return procLayout_handle(args);
      case 'stat': return procStat_handle(args.operands.feed);
      case 'watch': return procWatch_handle(args.operands.feed);
      case 'unwatch': return procUnwatch_handle(args.operands.feed);
    }
  },
});

/**
 * `proc` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `proc`.
 * @returns An envelope carrying the subcommand's output, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_proc(['stat']);
 * ```
 */
export async function builtin_proc(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(procCommand, args);
}
