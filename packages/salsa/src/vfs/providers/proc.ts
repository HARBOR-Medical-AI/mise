/**
 * @file /proc VFS Provider
 *
 * Surfaces ChRIS plugin instances as a navigable DAG under /proc/jobs/.
 * Backed by ProcCache: an accumulating index whose terminal entries are
 * immutable and whose freshness is visit-driven.
 *
 * Freshness model (every visit is a cheap delta, never a re-crawl):
 * - ls /proc/jobs        → roster delta: each collection's newest page, read
 *                          unfiltered, brings in the feeds newer than the
 *                          highest known id, and its total is compared with
 *                          the last walk's — a total that moved (a share, an
 *                          unshare, a deletion) promotes the visit to the
 *                          full index walk, which also runs once the roster
 *                          is older than {@link ROSTER_FULL_WALK_MS};
 * - a feed the roster lacks, asked for by name or id, is asked of CUBE live
 *                          and adopted ({@link procFeed_probe});
 * - ls /proc/jobs/N      → first visit loads the topology once; every later
 *                          visit runs {@link feedVisit_sync}: one feed-row
 *                          fetch (job counters), then, only when something
 *                          moved, a `min_end_date` delta walk (nodes created
 *                          or finished since the cursor) plus an `active=true`
 *                          sweep for the nodes still running;
 * - settled feeds        → re-checked at most once per {@link FEED_RECHECK_MS},
 *                          so work appended to a finished feed is still seen;
 * - cat .../status       → getPluginInstance(id), always live.
 *
 * @module
 */

import { vfsOutcome_convertFromBoolean, vfsOutcome_convertFromResult, type VfsOutcome, type VFSSubtree, type VFSSubtreeEntry } from '@fnndsc/fond';
import { type ProcRosterSyncKind,
  chrisConnection,
  errorStack,
  procCache_get,
  ProcCache,
  ProcInstance,
  ProcFeed,
  status_isTerminal,
  feed_isActive,
  feedTopology_changed,
  Result,
  Ok,
  Err,
  feedsPage_get,
  publicFeedsPage_get,
  pluginInstancesPage_get,
  pluginInstance_get,
  listPages_walk, listPages_walkWindowed,
  ListPage,
  FeedData,
  PluginInstanceData,
  PluginInstanceHandle,
  InstanceParameterData,
  feedNote_get,
  feedNote_update,
  feed_rename,
  type FeedNote,
} from '@fnndsc/cumin';
import { VFSProvider, VFSItem, CpOptions } from '../provider.js';
import { job_cancel, job_delete, job_statusFetch, job_logFetch, jobs_statusBatch } from '../../jobs/index.js';
import { procJoins_sweep } from '../../dag/feedJoins.js';
import { dataFactsIO_build, procDataFacts_feed, procDataFacts_sweep, type DataFactsIO } from '../../dag/feedData.js';
import { pipelinePackages_sweep } from '../../pipelines/packages.js';

/** Fetches one page of a paginated feed collection through the wire contract. */
type FeedPageFetch = (params: Record<string, unknown>) => Promise<ListPage<FeedData>>;

/** Virtual filenames inside each instance directory. */
const INSTANCE_FILES: ReadonlySet<string> = new Set(['status', 'params', 'log', 'data']);
/** Virtual filenames inside each feed directory. */
const FEED_FILES: ReadonlySet<string> = new Set(['status', 'title', 'note']);

const PROC_JOBS_PREFIX: string = '/proc/jobs';
const PAGE: number = 100;
/** Pages of one feed's topology walk fetched at once (PACS plural's precedent: four). */
export const FEED_WALK_IN_FLIGHT: number = 4;
/** How long a settled feed's counters are trusted before a visit re-checks them. */
export const FEED_RECHECK_MS: number = 10 * 60 * 1000;
/** How old the roster may be before a visit walks the whole feed index again. */
export const ROSTER_FULL_WALK_MS: number = 10 * 60 * 1000;
/** Visits to one feed closer together than this share the first visit's result. */
export const FEED_VISIT_COALESCE_MS: number = 1000;
/**
 * Rows of a collection's newest page a roster delta reads. CUBE orders feeds
 * newest first, so the page holds every feed newer than the roster unless
 * more than this many arrived between two visits; it is small because the
 * surfaces re-ask the roster on a timer.
 */
export const ROSTER_DELTA_PAGE: number = 20;

/**
 * How long listing `/proc/jobs` waits for the roster's sync before answering
 * from the cache: long enough for a quick CUBE to show a feed shared since
 * the last look, short enough that a slow one is never felt.
 */
export const ROSTER_LIST_BUDGET_MS: number = 250;

/** The least time between two unforced roster deltas. */
export const ROSTER_DELTA_MIN_MS: number = 60 * 1000;

/**
 * Per-feed visit bookkeeping. Session memory only — never checkpointed; a
 * restart simply re-derives the cursor from the cached instance timestamps.
 *
 * @property checkedAt - Wall-clock ms of the last feed-row check.
 * @property cursor - Newest CUBE timestamp seen on this feed's rows, the
 *   `min_end_date` lower bound for the next delta walk; null when no row has
 *   carried a timestamp yet (the next delta is then a full walk).
 */
interface FeedVisit {
  checkedAt: number;
  cursor: string | null;
}

const feedVisits: Map<number, FeedVisit> = new Map();
const feedVisitInflight: Map<number, Promise<boolean>> = new Map();
let rosterWalkedAt: number = 0;
let rosterSyncInflight: Promise<number[]> | null = null;
/** Whether the sync in flight walks the whole index (a forced one waits out a delta, then walks). */
let rosterSyncInflightFull: boolean = false;
/** When the last roster sync settled (0: none yet). */
let rosterSyncedAt: number = 0;

/**
 * Each feed collection's total as the last walk read it: the yardstick a
 * roster delta holds its newest page against. A total that moved by more
 * than the page's newer rows account for means a feed arrived or left
 * without a new id — a share, an unshare, a deletion — which only a full
 * walk can place. Null until a walk has read the collection (a restored
 * roster has no yardstick yet; its first delta takes what it reads).
 *
 * @property owned - The owned-and-shared collection (`/api/v1/`).
 * @property public - The public collection; null as well when its source failed.
 */
interface RosterTotals {
  owned: number | null;
  public: number | null;
}

let rosterTotals: RosterTotals = { owned: null, public: null };

/**
 * What a roster delta reads from one collection's newest page.
 *
 * @property newer - The page's feeds newer than the roster's highest id.
 * @property total - The collection's total as the page reported it.
 * @property overflow - Every row of the page was newer and more rows exist,
 *   so feeds newer than the roster may lie beyond the page.
 */
interface RosterPeek {
  newer: ProcFeed[];
  total: number | null;
  overflow: boolean;
}
let procTopologyPromise: Promise<void> | null = null;
let procTopologyFailure: string | undefined;

/** Private continuation state retained when a topology page request fails. */
interface ProcTopologySweepState {
  offset: number;
  total: number;
  fetchedInstanceIDs: Set<number>;
  seenInstanceIDs: Set<number>;
  seenFeedIDs: Set<number>;
}

let procTopologyResumeState: ProcTopologySweepState | null = null;
let procTopologyScopedResumeFeedIDs: number[] | null = null;

/** Lifecycle states for the session's global topology sweep. */
export type ProcTopologyState = 'idle' | 'running' | 'complete' | 'failed';

/**
 * Observable lifecycle of the session's global topology sweep.
 *
 * @property state - Current topology sweep lifecycle state.
 * @property failure - Failure reason when `state` is `failed`.
 */
export interface ProcTopologyStatus {
  state: ProcTopologyState;
  failure?: string;
}

/** Converts a CUBE feed row into the cache's feed model. */
function procFeed_create(feed: FeedData): ProcFeed {
  return {
    id: Number(feed.id),
    title: String(feed.name),
    ownerUsername: String(feed.owner_username ?? ''),
    public: Boolean(feed.public ?? false),
    creationDate: String(feed.creation_date ?? ''),
    finishedJobs: Number(feed.finished_jobs ?? 0),
    erroredJobs: Number(feed.errored_jobs ?? 0),
    startedJobs: Number(feed.started_jobs ?? 0),
    scheduledJobs: Number(feed.scheduled_jobs ?? 0),
    cancelledJobs: Number(feed.cancelled_jobs ?? 0),
    createdJobs: Number(feed.created_jobs ?? 0),
  };
}

/**
 * Indexes one complete paginated CUBE feed collection into the shared cache.
 *
 * @param page_fetch - Fetches one page of the collection.
 * @param indexed - The feeds indexed so far, keyed by id; this walk adds to it.
 * @returns The collection's total as the walk latched it, or null when no page carried one.
 */
async function procFeeds_index(page_fetch: FeedPageFetch, indexed: Map<number, ProcFeed>): Promise<number | null> {
  let total: number | null = null;
  for await (const step of listPages_walk(
    (offset: number, limit: number): Promise<ListPage<FeedData>> => page_fetch({ limit, offset }),
    { pageSize: PAGE },
  )) {
    total = step.total ?? total;
    for (const feed of step.items) {
      const procFeed: ProcFeed = procFeed_create(feed);
      indexed.set(procFeed.id, procFeed);
    }
  }
  return total;
}

// ── Cache build ────────────────────────────────────────────────────────────

/** The feed-index walk in flight, which every caller that needs one joins. */
let procCacheBuildPromise: Promise<number[]> | null = null;

/**
 * Builds the feed index, joining a walk already in flight. A cold boot
 * walks it behind the listening daemon (#1280), so a `/proc` read can
 * arrive before it lands: the read waits on that walk instead of starting
 * a second one.
 *
 * @returns IDs whose topology is new, changed, or currently active.
 */
function procCache_build(): Promise<number[]> {
  if (procCacheBuildPromise) return procCacheBuildPromise;
  const build: Promise<number[]> = procCache_buildRun().finally((): void => {
    if (procCacheBuildPromise === build) procCacheBuildPromise = null;
  });
  procCacheBuildPromise = build;
  return build;
}

/**
 * Builds the feed index (fast). Fetches owned/shared and public feeds with job counters.
 * Instance topology is loaded separately via procTopology_warmup().
 */
async function procCache_buildRun(): Promise<number[]> {
  const cache: ProcCache = procCache_get();

  const client = await chrisConnection.client_get();
  if (!client) {
    errorStack.stack_push('error', 'procCache_build: not connected');
    throw new Error('not connected');
  }

  const indexed: Map<number, ProcFeed> = new Map();
  const ownedTotal: number | null = await procFeeds_index(
    (params: Record<string, unknown>): Promise<ListPage<FeedData>> => feedsPage_get(client, params),
    indexed,
  );
  // Older CUBEs lack a public-feeds endpoint: the contract answers null
  // without a wire call, and an empty first page ends the index loop.
  const publicBefore: number = indexed.size;
  let publicTotal: number | null = await procFeeds_index(
    async (params: Record<string, unknown>): Promise<ListPage<FeedData>> =>
      (await publicFeedsPage_get(client, params)) ?? { data: [], totalCount: 0 },
    indexed,
  );

  // An empty public walk while the cache already holds public feeds is a
  // failed SOURCE, not an authoritative absence: reconciling against it
  // would amputate every public feed from the roster (and the checkpoint
  // watcher would persist the amputation). Keep what we know and say so.
  if (indexed.size === publicBefore) {
    const knownPublic: ProcFeed[] = cache.feeds_find('').filter((feed: ProcFeed): boolean => feed.public);
    if (knownPublic.length > 0) {
      errorStack.stack_push(
        'warning',
        `proc roster: public-feeds source returned nothing while ${knownPublic.length} public feeds are known; keeping them`,
      );
      for (const feed of knownPublic) indexed.set(feed.id, feed);
      // No yardstick from a failed source: the next delta takes what it reads.
      publicTotal = null;
    }
  }
  rosterTotals = { owned: ownedTotal, public: publicTotal };

  const knownBefore: Set<number> = new Set(cache.feedIDs_get());
  const reconciliationTargets: number[] = cache.feeds_reconcile(Array.from(indexed.values()));
  for (const feedID of reconciliationTargets) feedVisits.delete(feedID);
  // Feeds the walk brought in — created since, or shared to this identity —
  // are annunciated; a first build has no "before", so nothing arrives.
  if (knownBefore.size > 0) {
    const arrived: number[] = Array.from(indexed.keys()).filter((feedID: number): boolean => !knownBefore.has(feedID));
    cache.arrivals_note(arrived);
    await arrivalsUnseen_mark(cache, arrived);
  }
  cache.built_set();
  rosterWalkedAt = Date.now();
  // The feeds this walk leaves without topology — arrivals, and a restored
  // roster's feeds whose shards were never written — land behind the prompt.
  procTopologyCatchup_roster(cache);
  return reconciliationTargets;
}

/** Ensures the feed index is built, building it on first access. */
async function cache_ensure(): Promise<void> {
  if (!procCache_get().built) {
    await procCache_build();
  }
}

/**
 * Ensures what one path needs. `/proc/jobs` itself needs the whole index. A
 * path naming one feed needs that feed alone: its row is read and kept while
 * the index builds on behind, so a fresh session's `ls /proc/jobs/feed_N` (or
 * a `cd` into its `data`) answers in that feed's time, not every feed's
 * (#1364: minutes before the first line, with the index warming).
 *
 * @param pathStr - The path asked for.
 */
async function cacheFor_ensure(pathStr: string): Promise<void> {
  const cache: ProcCache = procCache_get();
  if (cache.built) return;
  const { feedID } = procPath_parse(pathStr.replace(/\/$/, ''));
  if (feedID === null) {
    await cache_ensure();
    return;
  }
  // The index lands behind the prompt; this read does not wait for it.
  procCache_build().catch((): void => { /* named on the error stack by the build */ });
  if (cache.feed_get(feedID) !== undefined) return;
  const client = await chrisConnection.client_get();
  if (!client) return;
  const row: FeedRow | null = await feedRow_fetch(client, feedID);
  if (row !== null) cache.feed_add(procFeed_create(row.feed));
}

/**
 * Loads instance topology for a single feed.
 * Uses in-flight map to prevent duplicate API calls.
 */
/** Pulls the execution metrics a CUBE list row carries, defined-only. */
function instanceMetrics_extract(inst: PluginInstanceData): {
  startedAt?: string; finishedAt?: string; outputBytes?: number; computeResource?: string; pipelineName: string | null; workflowID: number | null;
} {
  // Which pipeline run made the job: null is a direct run. The client drops
  // a row's null fields, so a run made by no pipeline arrives without them.
  const row = inst as PluginInstanceData & { pipeline_name?: unknown; workflow_id?: unknown };
  const pipelineName: string | null = typeof row.pipeline_name === 'string' && row.pipeline_name !== '' ? row.pipeline_name : null;
  const workflowID: number | null = row.workflow_id === null || row.workflow_id === undefined ? null : Number(row.workflow_id);
  return {
    pipelineName,
    workflowID,
    ...(typeof inst.start_date === 'string' ? { startedAt: inst.start_date } : {}),
    ...(typeof inst.end_date === 'string' ? { finishedAt: inst.end_date } : {}),
    ...(typeof inst.size === 'number' ? { outputBytes: inst.size } : {}),
    ...(typeof inst.compute_resource_name === 'string' && inst.compute_resource_name !== '' ? { computeResource: inst.compute_resource_name } : {}),
  };
}

/**
 * Converts a CUBE plugin-instance list row into the cache's instance model.
 *
 * @param inst - One list row.
 * @returns The instance as ProcCache stores it (params unresolved).
 */
function procInstance_buildFromRow(inst: PluginInstanceData): ProcInstance {
  const prevID: number | null = (inst.previous_id !== null && inst.previous_id !== undefined)
    ? Number(inst.previous_id)
    : null;
  return {
    id: Number(inst.id),
    feedID: Number(inst.feed_id),
    parentID: prevID,
    pluginName: String(inst.plugin_name),
    pluginType: inst.plugin_type !== undefined ? String(inst.plugin_type) : undefined,
    params: null,
    outputPath: outputPath_normalize(inst.output_path) ?? undefined,
    status: String(inst.status ?? 'unknown'),
    ...instanceMetrics_extract(inst),
  };
}

/**
 * Merges one CUBE list row into the cache: a known instance takes the row's
 * status and metrics (terminal status never regresses), an unknown one is
 * added to the topology.
 *
 * @param cache - The process cache.
 * @param inst - One list row.
 * @returns True when the row introduced a new instance.
 */
function procInstanceRow_merge(cache: ProcCache, inst: PluginInstanceData): boolean {
  const id: number = Number(inst.id);
  if (cache.instance_get(id)) {
    cache.status_update(id, String(inst.status ?? 'unknown'));
    cache.instanceMetrics_set(id, instanceMetrics_extract(inst));
    return false;
  }
  cache.instance_add(procInstance_buildFromRow(inst));
  return true;
}

/**
 * The newer of two ISO timestamps, tolerant of absent values.
 *
 * @param a - A timestamp or null.
 * @param b - A timestamp, or undefined when the row carried none.
 * @returns The later of the two, or whichever exists.
 */
function isoNewest_pick(a: string | null, b: unknown): string | null {
  if (typeof b !== 'string' || b === '') return a;
  if (a === null) return b;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

async function feedInstances_load(feedID: number): Promise<void> {
  const cache: ProcCache = procCache_get();
  const client = await chrisConnection.client_get();
  if (!client) throw new Error('not connected');

  const instances: Map<number, PluginInstanceData> = new Map();
  // A first visit to a large feed is a page walk of a minute or more; the
  // prompt and the status strip carry its progress so it never reads as a
  // hang. The register is cleared on every exit, including failure.
  cache.feedLoad_progress(feedID, 0, 0);
  try {
    // Several pages in flight: the rows are keyed by id and committed as a
    // whole when the walk lands, so the order pages arrive in is nothing
    // to this consumer, and the walk is as long as the slowest page in
    // each window rather than the sum of every page.
    for await (const step of listPages_walkWindowed(
      (offset: number, limit: number): Promise<ListPage<PluginInstanceData>> =>
        pluginInstancesPage_get(client, { feed_id: feedID, limit, offset }),
      { pageSize: PAGE, inFlight: FEED_WALK_IN_FLIGHT },
    )) {
      for (const instance of step.items) instances.set(Number(instance.id), instance);
      cache.feedLoad_progress(feedID, instances.size, step.total ?? 0);
    }
    for (const inst of instances.values()) cache.instance_add(procInstance_buildFromRow(inst));
    cache.topologyLoaded_mark(feedID);
    cache.feedLoad_clear(feedID);
    // What the feed's data is: read once, now its root is known.
    void procDataFacts_feed(feedID, dataFactsIO_get());
  } catch (error: unknown) {
    // A walk that stops names where it stopped and stays annunciated for a
    // minute; the next visit starts again from the beginning.
    cache.feedLoad_fail(feedID, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** Whether a feed's topology is in the cache, or still on its way. */
export type FeedTopologyReadiness = 'ready' | 'pending';

/**
 * Ensures a feed's topology walk is at least under way, without waiting for
 * it. Index movement never holds the session's lane: a cold feed's walk is
 * started here and runs detached, deduped by the in-flight map, annunciated
 * by the load register, and committed to the cache when it lands (which
 * emits the feed's change event, the signal a watch answers).
 *
 * @param feedID - The feed whose topology is wanted.
 * @returns `ready` when the cache has it, `pending` when a walk is running.
 */
export function feedInstances_ensureStarted(feedID: number): FeedTopologyReadiness {
  const cache: ProcCache = procCache_get();
  if (cache.topologyLoaded_has(feedID)) return 'ready';
  if (cache.loading_get(feedID) !== undefined) return 'pending';
  const walk: Promise<void> = feedInstances_load(feedID);
  cache.loading_set(feedID, walk);
  walk
    .catch((): void => { /* named in the load register; the next visit retries */ })
    .finally((): void => { cache.loading_clear(feedID); });
  return 'pending';
}

/**
 * Drops one feed's topology from the cache and re-reads its row (job
 * counters), so the next walk starts from nothing the cache remembers
 * about the graph. The roster row STAYS: a feed the identity sees through
 * the public listing is not in the own-feeds endpoint, and a refresh that
 * removed the row and could not re-read it left the feed "not found".
 *
 * @param feedID - The feed to evict.
 */
async function procFeed_evict(feedID: number): Promise<void> {
  const cache: ProcCache = procCache_get();
  feedVisits.delete(feedID);
  cache.feedTopology_evict(feedID);
  const client = await chrisConnection.client_get();
  if (!client) return;
  const row: FeedRow | null = await feedRow_fetch(client, feedID);
  if (row) cache.feed_add(procFeed_create(row.feed));
}

/**
 * The operator's `proc refresh <feed>`: evicts the feed and STARTS its
 * re-walk. The walk is index movement, finished off the lane; the caller
 * answers `pending` and the prompt carries the count.
 *
 * @param feedID - The feed to re-index.
 * @returns `pending` while the walk runs (always, right after an eviction).
 */
export async function procFeed_refreshStart(feedID: number): Promise<FeedTopologyReadiness> {
  await procFeed_evict(feedID);
  return feedInstances_ensureStarted(feedID);
}

/**
 * Ensures topology for a feed is loaded.
 * Per-feed loads proceed immediately even while the global sweep is running —
 * instance_add is idempotent so concurrent additions are safe.
 */
export async function feedInstances_ensureLoaded(feedID: number): Promise<void> {
  const cache: ProcCache = procCache_get();
  if (feedInstances_ensureStarted(feedID) === 'ready') return;
  const inflight: Promise<void> | undefined = cache.loading_get(feedID);
  if (inflight) await inflight;
}

// ── Aggregate status ───────────────────────────────────────────────────────

/** Derives aggregate feed status from stored job counters — no API call. */
export function feedStatus_derive(feed: ProcFeed): string {
  if (feed.erroredJobs > 0) return 'finishedWithError';
  const running: number = feed.startedJobs + feed.scheduledJobs + feed.createdJobs;
  if (running > 0) return 'running';
  if (feed.cancelledJobs > 0 && feed.finishedJobs === 0) return 'cancelled';
  if (feed.finishedJobs > 0) return 'finishedSuccessfully';
  return 'empty';
}

// ── Path parsing ───────────────────────────────────────────────────────────

export function procPath_parse(pathStr: string): {
  feedID: number | null;
  instanceID: number | null;
  virtualFile: string | null;
  /**
   * Set when the path descends THROUGH an instance's `data` link: the
   * portion after `data`, '' for the link itself. Everything under the
   * link belongs to the link's CFS target, not to `/proc`.
   */
  dataRemainder: string | null;
} {
  let relativePath: string = pathStr;
  if (pathStr === PROC_JOBS_PREFIX) {
    relativePath = '';
  } else if (pathStr.startsWith(`${PROC_JOBS_PREFIX}/`)) {
    relativePath = pathStr.slice(PROC_JOBS_PREFIX.length + 1);
  }
  const parts: string[] = relativePath.split('/').filter(Boolean);
  let feedID: number | null = null;
  let instanceID: number | null = null;
  let virtualFile: string | null = null;
  let dataRemainder: string | null = null;

  if (parts.length >= 1) {
    const feedMatch: RegExpMatchArray | null = parts[0].match(/^feed_(\d+)$/);
    if (feedMatch) feedID = parseInt(feedMatch[1], 10);
  }

  // A `data` segment directly after an instance segment starts the link's
  // subtree: the instance is the one before it, whatever follows is the
  // remainder inside the CFS target.
  for (let index: number = 2; index < parts.length; index++) {
    if (parts[index] !== 'data') continue;
    const instMatch: RegExpMatchArray | null = parts[index - 1].match(/_(\d+)$/);
    if (!instMatch) continue;
    instanceID = parseInt(instMatch[1], 10);
    virtualFile = 'data';
    dataRemainder = parts.slice(index + 1).join('/');
    return { feedID, instanceID, virtualFile, dataRemainder };
  }

  if (parts.length >= 2) {
    const lastPart: string = parts[parts.length - 1];
    if (FEED_FILES.has(lastPart) || INSTANCE_FILES.has(lastPart)) {
      virtualFile = lastPart;
      if (parts.length >= 3) {
        const instMatch: RegExpMatchArray | null = parts[parts.length - 2].match(/_(\d+)$/);
        if (instMatch) instanceID = parseInt(instMatch[1], 10);
      }
    } else {
      const instMatch: RegExpMatchArray | null = lastPart.match(/_(\d+)$/);
      if (instMatch) instanceID = parseInt(instMatch[1], 10);
    }
  }

  return { feedID, instanceID, virtualFile, dataRemainder };
}

/** Formats instance params as key=value lines. */
function params_render(inst: ProcInstance): string {
  if (!inst.params || Object.keys(inst.params).length === 0) return '(no parameters)';
  return Object.entries(inst.params)
    .map(([k, v]: [string, unknown]) => `${k}=${String(v)}`)
    .join('\n');
}

/**
 * Normalizes CUBE's output-path spelling into an absolute CFS path.
 *
 * @param value - Raw `output_path` value from a plugin-instance resource.
 * @returns Absolute CFS path, or null when no usable path was supplied.
 */
function outputPath_normalize(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const clean: string = value.trim();
  return clean.startsWith('/') ? clean : `/${clean}`;
}

/**
 * Resolves and memoizes the authoritative CFS output directory for one job.
 *
 * @param instanceID - Plugin-instance ID whose output path is needed.
 * @returns Absolute output path, or null when CUBE has not recorded one.
 */
/**
 * Resolves a path inside an instance's `data` link to its CFS target.
 *
 * @param instanceID - The instance whose output space the path enters.
 * @param remainder - The path below `data`, '' for the link itself.
 * @returns The absolute CFS path, or Err when the job has no output space.
 */
async function dataTarget_resolve(instanceID: number, remainder: string, feedID: number | null = null): Promise<Result<string>> {
  // A fresh session knows no job until its feed's topology is read: read it, as a listing of the node would.
  if (feedID !== null && procCache_get().instance_get(instanceID) === undefined) await feedInstances_ensureLoaded(feedID);
  const outputPath: string | null = await instanceOutputPath_ensure(instanceID);
  if (!outputPath) {
    errorStack.stack_push('error', `No CFS output path is available for job ${instanceID}`);
    return Err();
  }
  return Ok(remainder === '' ? outputPath : `${outputPath}/${remainder}`);
}

async function instanceOutputPath_ensure(instanceID: number): Promise<string | null> {
  const cache: ProcCache = procCache_get();
  const inst: ProcInstance | undefined = cache.instance_get(instanceID);
  if (!inst) return null;
  if (inst.outputPath !== undefined) return inst.outputPath;

  const client = await chrisConnection.client_get();
  if (!client) return null;
  try {
    const handle: PluginInstanceHandle | null = await pluginInstance_get(client, instanceID);
    const outputPath: string | null = outputPath_normalize(handle?.data?.output_path);
    cache.outputPath_update(instanceID, outputPath);
    return outputPath;
  } catch (error: unknown) {
    // "No CFS output path" downstream must not mask a failed fetch.
    const msg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push("warning", `Could not fetch output path for instance ${instanceID}: ${msg}`);
    return null;
  }
}

/**
 * Reads every page of effective parameter values from one plugin instance.
 *
 * @param handle - Typed handle for the instance being inspected.
 * @returns Parameter names mapped to their recorded invocation values.
 */
async function instanceParams_fetch(handle: PluginInstanceHandle): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = {};
  for await (const step of listPages_walk(
    (offset: number, limit: number): Promise<ListPage<InstanceParameterData>> =>
      handle.parametersPage_get({ limit, offset }),
    { pageSize: PAGE },
  )) {
    for (const item of step.items) {
      if (item.param_name) params[item.param_name] = item.value;
    }
  }

  return params;
}

/** Collects all instance IDs for a feed recursively. */
function feedInstanceIDs_list(feedID: number, cache: ProcCache): number[] {
  const result: number[] = [];
  const queue: number[] = [...cache.feedRoots_get(feedID)];
  while (queue.length > 0) {
    const id: number = queue.shift()!;
    result.push(id);
    queue.push(...cache.children_get(id));
  }
  return result;
}

// ── Provider ───────────────────────────────────────────────────────────────

/**
 * VFS provider exposing running jobs and feeds under the /proc namespace.
 */
export class ProcVfsProvider implements VFSProvider {
  readonly prefix: string = PROC_JOBS_PREFIX;

  /**
   * Resolves the synthetic `data` link for one job only when navigation asks
   * to follow it. This keeps `/proc` topology listings and recursive trees
   * entirely cache-backed.
   *
   * @param pathStr - Absolute `/proc/jobs/.../data` path to resolve.
   * @returns The authoritative CFS output path, or an error when absent.
   */
  async linkTarget_resolve(pathStr: string): Promise<Result<string>> {
    await cacheFor_ensure(pathStr);
    const clean: string = pathStr.replace(/\/$/, '');
    const { feedID, instanceID, virtualFile } = procPath_parse(clean);
    if (feedID === null || instanceID === null || virtualFile !== 'data') {
      errorStack.stack_push('error', `Not a /proc job data link: ${pathStr}`);
      return Err();
    }
    // The link's target: the job's output, its feed read first when this session has not (#1364: `download` of
    // the link on a fresh session found no job and said the file could not be opened).
    return dataTarget_resolve(instanceID, '', feedID);
  }

  /**
   * Everything beneath a `/proc/jobs` path from the cache, in the order its
   * listings give it (a feed's `status`, `title`, `note` and root jobs; a
   * job's `status`, `params`, `log`, `data` and children), so `find` asks
   * CUBE nothing. Each job carries its status and plugin for a test to ask;
   * a feed whose jobs are not indexed yet is left to the walk.
   *
   * @param pathStr - The subtree's root.
   * @returns The subtree, or null when the cache is not in service.
   */
  async subtree(pathStr: string): Promise<VFSSubtree | null> {
    const cache: ProcCache = procCache_get();
    if (!cache.built) return null;
    const clean: string = pathStr.replace(/\/$/, '');
    const { feedID, instanceID, virtualFile } = procPath_parse(clean);
    if (virtualFile !== null) return { entries: [], unanswered: [] };
    const entries: VFSSubtreeEntry[] = [];
    const unanswered: string[] = [];
    const file = (rel: string, name: string, depth: number): void => {
      entries.push({ rel: rel === '' ? name : `${rel}/${name}`, depth, item: { name, type: 'file', size: 0, owner: '', date: '' } });
    };
    const job = (id: number, rel: string, depth: number): void => {
      const inst: ProcInstance | undefined = cache.instance_get(id);
      if (inst === undefined) return;
      const name: string = `${inst.pluginName}_${id}`;
      const here: string = rel === '' ? name : `${rel}/${name}`;
      entries.push({
        rel: here, depth,
        item: { name, type: 'job', size: 0, owner: '', date: inst.startedAt ?? '', status: inst.status ?? 'unknown' },
        attrs: {
          status: inst.status ?? 'unknown',
          plugin: inst.pluginName,
          // Which pipeline run made it: '' for a direct run; absent until a row said.
          ...(inst.pipelineName !== undefined ? { pipeline: inst.pipelineName ?? '' } : {}),
          ...(inst.workflowID !== undefined ? { workflow: inst.workflowID === null ? '' : String(inst.workflowID) } : {}),
        },
      });
      jobInside(id, here, depth + 1);
    };
    const jobInside = (id: number, rel: string, depth: number): void => {
      const inst: ProcInstance | undefined = cache.instance_get(id);
      if (inst === undefined) return;
      for (const name of ['status', 'params', 'log']) file(rel, name, depth);
      if (inst.outputPath !== null) entries.push({ rel: `${rel}/data`, depth, item: { name: 'data', type: 'link', size: 0, owner: '', date: '' } });
      for (const child of cache.children_get(id)) job(child, rel, depth);
    };
    const feedInside = (id: number, rel: string, depth: number): void => {
      if (!cache.topologyLoaded_has(id)) { unanswered.push(rel); return; }
      for (const name of ['status', 'title', 'note']) file(rel, name, depth);
      for (const root of cache.feedRoots_get(id)) job(root, rel, depth);
    };
    // Rows restored from before the cache kept a job's pipeline run are read
    // again once, behind the prompt; until then those jobs say they do not know.
    procPipeline_backfillStart();
    if (clean === PROC_JOBS_PREFIX) {
      for (const id of cache.feedIDs_get()) {
        const feed: ProcFeed | undefined = cache.feed_get(id);
        const name: string = `feed_${id}`;
        const status: string = feed ? feedStatus_derive(feed) : 'unknown';
        entries.push({ rel: name, depth: 1, item: { name, type: 'job', size: 0, owner: '', date: feed?.creationDate ?? '', title: feed?.title ?? name, status }, attrs: { status } });
        feedInside(id, name, 2);
      }
    } else if (feedID !== null && instanceID === null) {
      if (cache.feed_get(feedID) === undefined) return null;
      feedInside(feedID, '', 1);
      if (unanswered.length > 0) return null;
    } else if (feedID !== null && instanceID !== null) {
      if (cache.instance_get(instanceID) === undefined) return null;
      jobInside(instanceID, '', 1);
    } else {
      return null;
    }
    return { entries, unanswered };
  }

  async list(
    pathStr: string,
    _options?: { sort?: 'name' | 'size' | 'date' | 'owner'; reverse?: boolean }
  ): Promise<Result<VFSItem[]>> {
    await cacheFor_ensure(pathStr);
    const cache: ProcCache = procCache_get();
    const clean: string = pathStr.replace(/\/$/, '');

    // /proc/jobs — list all feeds with aggregate status from counters
    if (clean === PROC_JOBS_PREFIX) {
      await procRoster_syncWithin(ROSTER_LIST_BUDGET_MS);
      const items: VFSItem[] = cache.feedIDs_get().map((feedID: number): VFSItem => {
        const feed: ProcFeed | undefined = cache.feed_get(feedID);
        const status: string = feed ? feedStatus_derive(feed) : 'unknown';
        return {
          name: `feed_${feedID}`,
          type: 'job',
          size: 0,
          owner: '',
          date: '',
          title: feed?.title ?? `feed_${feedID}`,
          status,
        };
      });
      return Ok(items);
    }

    const { feedID, instanceID, virtualFile, dataRemainder } = procPath_parse(clean);

    // Anything under an instance's `data` link belongs to the link's CFS
    // target: resolve and delegate, so `ls .../data` (and deeper) shows the
    // target's real contents instead of silently re-listing the instance.
    if (instanceID !== null && virtualFile === 'data' && dataRemainder !== null) {
      const target: Result<string> = await dataTarget_resolve(instanceID, dataRemainder, feedID);
      if (!target.ok) return Err();
      const { vfsDispatcher } = await import('../dispatcher.js');
      return vfsDispatcher.list(target.value, _options);
    }

    // /proc/jobs/feed_N — list root instances + feed virtual files
    if (feedID !== null && instanceID === null) {
      // A feed the roster lacks is asked of CUBE first: shared to this
      // identity, or made public, since the walk, it is adopted here and
      // listed as any other; a feed CUBE does not list is an empty listing.
      if (cache.feed_get(feedID) === undefined && (await procFeedAbsent_probe(feedID)) === null) return Ok([]);
      const wasLoaded: boolean = cache.topologyLoaded_has(feedID);
      await feedInstances_ensureLoaded(feedID);
      const feed: ProcFeed | undefined = cache.feed_get(feedID);
      if (!feed) return Ok([]);

      // The initial load already carried live status and topology; a revisit
      // is a delta (feed counters, then only what moved).
      if (wasLoaded) await feedVisit_sync(feedID);
      const rootIDs: number[] = cache.feedRoots_get(feedID);

      const items: VFSItem[] = [];
      items.push({ name: 'status', type: 'file', size: 0, owner: '', date: '' });
      items.push({ name: 'title',  type: 'file', size: 0, owner: '', date: '' });
      // The feed's note: CUBE's one scratchpad per feed, read and written as a file.
      items.push({ name: 'note',   type: 'file', size: 0, owner: '', date: '' });

      for (const rootID of rootIDs) {
        const inst: ProcInstance | undefined = cache.instance_get(rootID);
        if (!inst) continue;
        items.push({
          name: `${inst.pluginName}_${rootID}`,
          type: 'job',
          size: 0,
          owner: '',
          date: '',
          status: inst.status ?? 'unknown',
        });
      }
      return Ok(items);
    }

    // /proc/jobs/feed_N/plugin_ID — list children + virtual files
    if (feedID !== null && instanceID !== null) {
      const wasLoaded: boolean = cache.topologyLoaded_has(feedID);
      await feedInstances_ensureLoaded(feedID);
      const inst: ProcInstance | undefined = cache.instance_get(instanceID);
      if (!inst) return Ok([]);

      if (wasLoaded) await feedVisit_sync(feedID);
      const childIDs: number[] = cache.children_get(instanceID);

      const items: VFSItem[] = [];
      items.push({ name: 'status', type: 'file', size: 0, owner: '', date: '' });
      items.push({ name: 'params', type: 'file', size: 0, owner: '', date: '' });
      items.push({ name: 'log',    type: 'file', size: 0, owner: '', date: '' });
      // `data` is structural: list it without fetching the per-instance detail
      // endpoint. Its target is resolved only when `cd data` follows the link.
      // A known null means CUBE has no output directory, so omit it entirely.
      if (inst.outputPath !== null) {
        const dataLink: VFSItem = { name: 'data', type: 'link', size: 0, owner: '', date: '' };
        if (inst.outputPath) dataLink.target = inst.outputPath;
        items.push(dataLink);
      }

      for (const childID of childIDs) {
        const child: ProcInstance | undefined = cache.instance_get(childID);
        if (!child) continue;
        items.push({
          name: `${child.pluginName}_${childID}`,
          type: 'job',
          size: 0,
          owner: '',
          date: '',
          status: child.status ?? 'unknown',
        });
      }
      return Ok(items);
    }

    return Ok([]);
  }

  /** @inheritdoc */
  async readBinary(pathStr: string): Promise<VfsOutcome<Buffer>> {
    return vfsOutcome_convertFromResult(await this.bytes_read(pathStr), 'ENOENT');
  }

  /**
   * Raw bytes exist only under the `data` link (an image in a job's output
   * space); everything else in `/proc` is synthesized text, served as its
   * UTF-8 bytes so a byte reader (the daemon's `/vfs` route, a preview)
   * sees the same file `cat` does.
   *
   * @param pathStr - Absolute `/proc/...` path.
   * @returns The file's bytes.
   */
  private async bytes_read(pathStr: string): Promise<Result<Buffer>> {
    await cacheFor_ensure(pathStr);
    const clean: string = pathStr.replace(/\/$/, '');
    const { feedID, instanceID, virtualFile, dataRemainder } = procPath_parse(clean);
    if (instanceID !== null && virtualFile === 'data' && dataRemainder !== null && dataRemainder !== '') {
      const target: Result<string> = await dataTarget_resolve(instanceID, dataRemainder, feedID);
      if (!target.ok) return Err();
      // The target is a CFS file, and the dispatcher's default provider is
      // the HOST filesystem — handing it back there refused every byte a
      // node's data holds. `fileContent_getBinary` is the whole door: it
      // routes a projection to its provider and a CFS path to CUBE.
      const { fileContent_getBinary } = await import('../../files/index.js');
      return fileContent_getBinary(target.value);
    }
    const text: Result<string> = await this.read(pathStr);
    return text.ok ? Ok(Buffer.from(text.value, 'utf8')) : text;
  }

  /** @inheritdoc */
  async read(pathStr: string): Promise<VfsOutcome<string>> {
    return vfsOutcome_convertFromResult(await this.text_read(pathStr), 'ENOENT');
  }

  private async text_read(pathStr: string): Promise<Result<string>> {
    await cacheFor_ensure(pathStr);
    const cache: ProcCache = procCache_get();
    const clean: string = pathStr.replace(/\/$/, '');
    const { feedID, instanceID, virtualFile, dataRemainder } = procPath_parse(clean);

    // A file under the `data` link is the CFS target's file.
    if (instanceID !== null && virtualFile === 'data' && dataRemainder !== null && dataRemainder !== '') {
      const target: Result<string> = await dataTarget_resolve(instanceID, dataRemainder, feedID);
      if (!target.ok) return Err();
      const { fileContent_get } = await import('../../files/index.js');
      return fileContent_get(target.value);
    }

    // Feed-level virtual files
    if (feedID !== null && instanceID === null && virtualFile !== null) {
      const feed: ProcFeed | undefined = cache.feed_get(feedID);
      if (!feed) return Ok('');
      if (virtualFile === 'status') return Ok(feedStatus_derive(feed));
      if (virtualFile === 'title') return Ok(feed.title);
      if (virtualFile === 'note') {
        const note: Result<FeedNote> = await feedNote_get(feedID);
        return note.ok ? Ok(note.value.content) : Err();
      }
      return Err();
    }

    // Instance-level virtual files — all live or cached-on-first-read
    if (instanceID !== null && virtualFile !== null) {
      await feedInstances_ensureLoaded(feedID!);
      const inst: ProcInstance | undefined = cache.instance_get(instanceID);
      if (!inst) return Ok('');

      if (virtualFile === 'status') {
        // Settled jobs never change — return the cached terminal status, no call.
        if (status_isTerminal(inst.status)) return Ok(inst.status as string);
        const fresh: Result<string> = await job_statusFetch(instanceID);
        if (fresh.ok) cache.status_update(instanceID, fresh.value);
        return Ok(fresh.ok ? fresh.value : (inst.status ?? 'unknown'));
      }

      if (virtualFile === 'params') {
        if (inst.params === null) {
          // CUBE stores the effective run values in the parameter sub-resource;
          // the instance detail payload itself is operational metadata.
          const client = await chrisConnection.client_get();
          if (client) {
            try {
              const handle: PluginInstanceHandle | null = await pluginInstance_get(client, instanceID);
              if (handle) cache.params_update(instanceID, await instanceParams_fetch(handle));
            } catch {
              // Deliberate absorption, adjudicated 2026-08: parameters are a
              // lazy display enrichment; a failed fetch renders as
              // "(no parameters)" and the next read retries.
            }
          }
        }
        return Ok(params_render(inst));
      }

      if (virtualFile === 'log') {
        const logResult: Result<string> = await job_logFetch(instanceID);
        return Ok(logResult.ok ? logResult.value : '(log unavailable)');
      }
    }

    // Anything else is no file /proc reads: a folder (the dispatcher then
    // says it is a directory) or nothing there.
    return Err();
  }

  async feedJobs_cancel(pathStr: string, _options?: { recursive?: boolean; force?: boolean }): Promise<boolean> {
    await cache_ensure();
    const cache: ProcCache = procCache_get();
    const clean: string = pathStr.replace(/\/$/, '');
    const { feedID, instanceID } = procPath_parse(clean);

    if (feedID !== null && instanceID === null) {
      const allIDs: number[] = feedInstanceIDs_list(feedID, cache);
      const statusMap: Map<number, string> = await jobs_statusBatch(allIDs);
      // Every cancel Result is checked: reporting success while jobs kept
      // running would leave the user believing the feed's work was stopped.
      const failedCancels: number[] = [];
      await Promise.all(allIDs.map(async (id: number) => {
        const s: string = statusMap.get(id) ?? '';
        if (!status_isTerminal(s)) {
          const cancelResult: Result<boolean> = await job_cancel(id);
          if (!cancelResult.ok) failedCancels.push(id);
        }
      }));
      if (failedCancels.length > 0) {
        errorStack.stack_push(
          'error',
          `rm: failed to cancel ${failedCancels.length} running job(s) in feed ${feedID}: instance(s) ${failedCancels.sort((a, b) => a - b).join(', ')}`,
        );
        return false;
      }
      cache.feed_remove(feedID);
      return true;
    }

    if (instanceID !== null) {
      const statusResult: Result<string> = await job_statusFetch(instanceID);
      const status: string = statusResult.ok ? statusResult.value : '';
      const isTerminal: boolean = status_isTerminal(status);

      let result: Result<boolean>;
      if (!isTerminal) {
        result = await job_cancel(instanceID);
      } else {
        result = await job_delete(instanceID);
        if (result.ok) cache.instance_remove(instanceID);
      }
      return result.ok;
    }

    return false;
  }

  /** @inheritdoc */
  async cp(_src: string, _dst: string, _options?: CpOptions): Promise<VfsOutcome> {
    return vfsOutcome_convertFromBoolean(await this.copy_run(_src, _dst, _options), 'EROFS');
  }

  private async copy_run(_src: string, _dst: string, _options?: CpOptions): Promise<boolean> { return false; }
  async mv(_src: string, _dst: string): Promise<boolean> { return false; }
  async touch(_pathStr: string): Promise<boolean> { return false; }
  async upload(_localPath: string, _remotePath: string): Promise<boolean> { return false; }
  /** @inheritdoc */
  async write(pathStr: string, content: string): Promise<VfsOutcome> {
    return vfsOutcome_convertFromBoolean(await this.file_write(pathStr, content), 'EROFS');
  }

  /**
   * Writes a projected file. One file under /proc takes writes: a feed's
   * note (`/proc/jobs/feed_N/note`), whose content is replaced whole; its
   * title stands. Anything else is refused by name.
   *
   * @param pathStr - The projected path.
   * @param content - The new content, whole.
   * @returns True when it was written.
   */
  private async file_write(pathStr: string, content: string): Promise<boolean> {
    const { feedID, instanceID, virtualFile } = procPath_parse(pathStr.replace(/\/$/, ''));
    if (feedID !== null && instanceID === null && virtualFile === 'note') {
      const done: Result<boolean> = await feedNote_update(feedID, { content });
      return done.ok;
    }
    if (feedID !== null && instanceID === null && virtualFile === 'title') {
      // The title is the feed's name: its first line, trimmed, renames it,
      // and the roster the cache serves says so at once.
      const name: string = (content.split('\n')[0] ?? '').trim();
      const done: Result<boolean> = await feed_rename(feedID, name);
      if (done.ok) {
        const feed: ProcFeed | undefined = procCache_get().feed_get(feedID);
        if (feed !== undefined) feed.title = name;
      }
      return done.ok;
    }
    errorStack.stack_push('error', `${pathStr}: Read-only file system (a feed's note and title are written under /proc, nothing else)`);
    return false;
  }
}

/**
 * Ensures instance topology is loaded for a feed without clearing existing data.
 * Use this from proc find — it respects already-loaded feeds and the in-flight map.
 * Use procCache_refresh(feedID) only when a forced reload is desired.
 */
export async function procFeed_ensureLoaded(feedID: number): Promise<void> {
  const cache: ProcCache = procCache_get();
  if (!cache.feed_get(feedID)) {
    cache.feed_add({
      id: feedID, title: `feed_${feedID}`, ownerUsername: '', public: false, creationDate: '',
      finishedJobs: 0, erroredJobs: 0, startedJobs: 0,
      scheduledJobs: 0, cancelledJobs: 0, createdJobs: 0,
    });
  }
  await feedInstances_ensureLoaded(feedID);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Refreshes volatile job status for one feed via a single paginated LIST sweep.
 *
 * The plugin-instance list response carries `status`, so one feed-scoped list call
 * updates every node — far cheaper than per-node detail fetches. Terminal statuses
 * are frozen by {@link ProcCache.status_update} and never regress.
 *
 * @param feedID - Feed whose instance statuses should be refreshed.
 */
/**
 * Ensures a feed's metadata (title + job counters, needed for aggregate status) is cached
 * with real values. No-op when the feed is already present with real metadata; fetches one
 * `getFeeds({id})` only when the feed is missing or a zero-counter placeholder. Does NOT
 * touch instance topology — reuse of the warm cache is the whole point.
 *
 * @param feedID - Feed whose metadata to ensure.
 */
export async function feedMeta_ensure(feedID: number): Promise<void> {
  const cache: ProcCache = procCache_get();
  const existing: ProcFeed | undefined = cache.feed_get(feedID);
  if (existing && existing.creationDate !== '') return;
  await procFeed_probe(feedID);
}

/**
 * One feed's row and the collection it was found in.
 *
 * @property feed - The row as CUBE lists it.
 * @property collection - The collection that listed it, the owned one first.
 */
interface FeedRow {
  feed: FeedData;
  collection: keyof RosterTotals;
}

/**
 * Reads one feed's row, from the owned-and-shared collection first and the
 * public one after.
 *
 * @param client - Connected chrisapi client.
 * @param feedID - The feed to read.
 * @returns The row and its collection, or null when neither lists the feed for this identity.
 */
async function feedRow_fetch(
  client: NonNullable<Awaited<ReturnType<typeof chrisConnection.client_get>>>,
  feedID: number,
): Promise<FeedRow | null> {
  const own: ListPage<FeedData> = await feedsPage_get(client, { id: feedID, limit: 1, offset: 0 });
  const ownRow: FeedData | undefined = own.data[0];
  if (ownRow) return { feed: ownRow, collection: 'owned' };
  const pub: ListPage<FeedData> = (await publicFeedsPage_get(client, { id: feedID, limit: 1, offset: 0 })) ?? { data: [], totalCount: 0 };
  const pubRow: FeedData | undefined = pub.data[0];
  return pubRow ? { feed: pubRow, collection: 'public' } : null;
}

/**
 * Asks CUBE for one feed, live, and adopts it into the roster: the way a
 * feed shared to this identity, or made public, since the roster was
 * walked is seen when it is asked for by name or id. A feed the roster
 * already holds has its row refreshed. The yardsticks move with an
 * adoption, so the next delta does not walk again for what this ask found.
 *
 * @param feedID - The feed to ask for.
 * @returns The feed as the roster now holds it, or null when CUBE lists it
 *   in neither collection for this identity — not shared, or shared to a
 *   group the identity is not in.
 * @throws {Error} When not connected.
 */
export async function procFeed_probe(feedID: number): Promise<ProcFeed | null> {
  const cache: ProcCache = procCache_get();
  const client = await chrisConnection.client_get();
  if (!client) throw new Error('not connected');
  const row: FeedRow | null = await feedRow_fetch(client, feedID);
  if (row === null) return null;
  const feed: ProcFeed = procFeed_create(row.feed);
  const known: boolean = cache.feed_get(feedID) !== undefined;
  cache.feed_add(feed);
  if (!known) {
    rosterTotal_bump(row.collection);
    // A public feed is in the public collection whichever one listed it first.
    if (feed.public && row.collection === 'owned') rosterTotal_bump('public');
    cache.arrivals_note([feedID]);
    await arrivalsUnseen_mark(cache, [feedID]);
    procTopologyCatchup_enqueue([feedID]);
  }
  return feed;
}

/**
 * Marks arrivals shared with this identity as NEW since the last visit: a
 * feed another identity owns and has not made public. A feed this
 * identity made is not news to it, and a public feed anyone on CUBE made
 * is not addressed to it; neither is marked.
 *
 * @param cache - The process cache.
 * @param feedIDs - The feeds that just arrived.
 */
async function arrivalsUnseen_mark(cache: ProcCache, feedIDs: number[]): Promise<void> {
  if (feedIDs.length === 0) return;
  // Who this identity is decides what is news; not knowing, nothing is marked.
  let me: string | null = null;
  try {
    me = await chrisConnection.user_get();
  } catch {
    return;
  }
  if (me === null) return;
  cache.unseen_add(feedIDs.filter((feedID: number): boolean => {
    const feed: ProcFeed | undefined = cache.feed_get(feedID);
    return feed !== undefined && !feed.public && feed.ownerUsername !== '' && feed.ownerUsername !== me;
  }));
}

/**
 * Asks CUBE for a feed the roster lacks, on a visit to its path, and says
 * on the error stack when the ask itself failed; an absent feed is a null.
 *
 * @param feedID - The feed to ask for.
 * @returns The adopted feed, or null.
 */
async function procFeedAbsent_probe(feedID: number): Promise<ProcFeed | null> {
  try {
    return await procFeed_probe(feedID);
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push('warning', `proc: asking CUBE for feed_${feedID} failed (${msg})`);
    return null;
  }
}

/** Moves one collection's yardstick by one adopted feed; an unknown yardstick stays unknown. */
function rosterTotal_bump(collection: keyof RosterTotals): void {
  const total: number | null = rosterTotals[collection];
  if (total !== null) rosterTotals[collection] = total + 1;
}

export async function feedStatus_refresh(feedID: number): Promise<void> {
  const cache: ProcCache = procCache_get();
  const client = await chrisConnection.client_get();
  if (!client) return;

  for await (const step of listPages_walk(
    (offset: number, limit: number): Promise<ListPage<PluginInstanceData>> =>
      pluginInstancesPage_get(client, { feed_id: feedID, limit, offset }),
    { pageSize: PAGE },
  )) {
    for (const inst of step.items) {
      cache.status_update(Number(inst.id), String(inst.status ?? 'unknown'));
      cache.instanceMetrics_set(Number(inst.id), instanceMetrics_extract(inst));
    }
  }
}

// ── Visit-driven freshness ─────────────────────────────────────────────────

/**
 * Whether every cached instance of a feed carries a terminal status. A fully
 * settled feed can only change by having work appended to it, which the
 * feed-row counters reveal.
 *
 * @param cache - The process cache.
 * @param feedID - The feed to inspect.
 * @returns True when no cached instance could still change status.
 */
export function feedCached_isSettled(cache: ProcCache, feedID: number): boolean {
  for (const id of cache.feedInstanceIDs_get(feedID)) {
    const inst: ProcInstance | undefined = cache.instance_get(id);
    if (inst === undefined || !status_isTerminal(inst.status)) return false;
  }
  return true;
}

/**
 * Derives a feed's delta cursor from what the cache already holds: the newest
 * start or end timestamp across its instances.
 *
 * @param cache - The process cache.
 * @param feedID - The feed whose rows to scan.
 * @returns The newest timestamp, or null when no row carried one.
 */
function feedCursor_derive(cache: ProcCache, feedID: number): string | null {
  let newest: string | null = null;
  for (const id of cache.feedInstanceIDs_get(feedID)) {
    const inst: ProcInstance | undefined = cache.instance_get(id);
    if (!inst) continue;
    newest = isoNewest_pick(newest, inst.startedAt);
    newest = isoNewest_pick(newest, inst.finishedAt);
  }
  return newest;
}

/** How many pages the pipeline backfill reads at once. */
const PIPELINE_BACKFILL_LANES: number = 6;

/** The backfill of jobs' pipeline runs, once per session; null until started. */
let pipelineBackfill: Promise<void> | null = null;

/** How far the backfill has read: pages known so far, pages read, and whether it is reading. */
const pipelineBackfillProgress: { pages: number; read: number; running: boolean } = { pages: 0, read: 0, running: false };

/**
 * How far the backfill of jobs' pipeline runs has read, for `proc stat`.
 *
 * @returns Pages known so far, pages read, and whether it is reading now.
 */
export function procPipelineBackfill_status(): { pages: number; read: number; running: boolean } {
  return { ...pipelineBackfillProgress };
}

/**
 * Runs tasks a few at a time, in the order given.
 *
 * @param tasks - The work, each started when a lane is free.
 * @param lanes - How many run at once.
 */
async function tasks_runInLanes(tasks: ReadonlyArray<() => Promise<void>>, lanes: number): Promise<void> {
  let next: number = 0;
  const lane = async (): Promise<void> => {
    for (let at: number = next++; at < tasks.length; at = next++) await (tasks[at] as () => Promise<void>)();
  };
  await Promise.all(Array.from({ length: Math.min(lanes, tasks.length) }, lane));
}

/**
 * Reads every visible job's row once more so the cache learns which
 * pipeline run made each (rows restored from an older checkpoint lack it),
 * behind the prompt: started the first time a `find` needs it, and never
 * again once every job knows. Off the lane; a failure leaves the jobs as
 * they were.
 *
 * Page by page across all lanes, not feed by feed: the unknown jobs sit in
 * a few feeds of tens of thousands of jobs each (on one account, three
 * feeds held all 118k), and a feed read one page after another kept every
 * other lane idle for hours (#1253). Each feed's first page says how long
 * it is; every page after it goes in one queue the lanes share.
 *
 * @returns Nothing; the walk runs on.
 */
export function procPipeline_backfillStart(): void {
  if (pipelineBackfill !== null) return;
  const cache: ProcCache = procCache_get();
  let unknown: boolean = false;
  for (const id of cache.feedIDs_get()) {
    for (const instID of cache.feedInstanceIDs_get(id)) {
      if (cache.instance_get(instID)?.pipelineName === undefined) { unknown = true; break; }
    }
    if (unknown) break;
  }
  if (!unknown) return;
  pipelineBackfill = (async (): Promise<void> => {
    const client = await chrisConnection.client_get();
    if (!client) return;
    pipelineBackfillProgress.running = true;
    const feeds: number[] = cache.feedIDs_get().filter((id: number): boolean =>
      cache.feedInstanceIDs_get(id).some((instID: number): boolean => cache.instance_get(instID)?.pipelineName === undefined));
    const merge = (page: ListPage<PluginInstanceData>): void => {
      for (const inst of page.data) {
        const instID: number = Number(inst.id);
        if (cache.instance_get(instID) !== undefined) cache.instanceMetrics_set(instID, instanceMetrics_extract(inst));
      }
      pipelineBackfillProgress.read += 1;
    };
    const page_read = async (feedID: number, offset: number): Promise<ListPage<PluginInstanceData>> =>
      await pluginInstancesPage_get(client, { feed_id: feedID, limit: PAGE, offset });
    const unknownIn = (feedID: number): number[] => cache.feedInstanceIDs_get(feedID)
      .filter((instID: number): boolean => cache.instance_get(instID)?.pipelineName === undefined);
    // Pages from `from` to the feed's end, queued for the lanes.
    const pages_queue = async (lists: Array<{ feedID: number; from: number; total: number }>): Promise<void> => {
      const rest: Array<{ feedID: number; offset: number }> = [];
      for (const { feedID, from, total } of lists) {
        for (let offset: number = from; offset < total; offset += PAGE) rest.push({ feedID, offset });
      }
      pipelineBackfillProgress.pages += rest.length;
      await tasks_runInLanes(rest.map(({ feedID, offset }) => async (): Promise<void> => {
        merge(await page_read(feedID, offset));
      }), PIPELINE_BACKFILL_LANES);
    };
    pipelineBackfillProgress.pages = feeds.length;
    const lists: Array<{ feedID: number; from: number; total: number }> = [];
    await tasks_runInLanes(feeds.map((feedID: number) => async (): Promise<void> => {
      const first: ListPage<PluginInstanceData> = await page_read(feedID, 0);
      merge(first);
      const total: number = first.totalCount ?? first.data.length;
      // CUBE lists a feed newest first, and the jobs an older checkpoint
      // lacks are its older ones: an earlier pass learned the newest, so a
      // pass after a restart starts where the unknown ones begin rather
      // than reading the known head again. One page before it, in case the
      // count drifted; a feed not listed newest first is read whole.
      const ids: number[] = first.data.map((row: PluginInstanceData): number => Number(row.id));
      const newestFirst: boolean = ids.every((id: number, at: number): boolean => at === 0 || id < (ids[at - 1] as number));
      const unknown: number[] = unknownIn(feedID);
      const newestUnknown: number = unknown.length === 0 ? 0 : Math.max(...unknown);
      const knownAbove: number = cache.feedInstanceIDs_get(feedID).filter((instID: number): boolean => instID > newestUnknown).length;
      const from: number = newestFirst ? Math.max(PAGE, Math.floor(knownAbove / PAGE) * PAGE - PAGE) : PAGE;
      lists.push({ feedID, from, total });
    }), PIPELINE_BACKFILL_LANES);
    await pages_queue(lists);
    // What the skip passed over and should not have: read those feeds whole.
    const missed: Array<{ feedID: number; from: number; total: number }> = lists
      .filter(({ feedID, from }: { feedID: number; from: number }): boolean => from > PAGE && unknownIn(feedID).length > 0)
      .map(({ feedID, from }: { feedID: number; from: number }) => ({ feedID, from: PAGE, total: from }));
    if (missed.length > 0) await pages_queue(missed);
  })().catch((error: unknown): void => {
    const msg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push('warning', `proc: reading jobs' pipeline runs failed (${msg})`);
    pipelineBackfill = null;
  }).finally((): void => {
    pipelineBackfillProgress.running = false;
  });
}

/**
 * Walks one filtered plugin-instance listing for a feed, merging every row.
 *
 * @param cache - The process cache.
 * @param client - Connected chrisapi client.
 * @param params - CUBE filter params beyond feed_id/limit/offset.
 * @param feedID - The feed being walked.
 * @param cursor - The cursor to advance with the rows' timestamps.
 * @returns The advanced cursor.
 */
async function feedRows_merge(
  cache: ProcCache,
  client: NonNullable<Awaited<ReturnType<typeof chrisConnection.client_get>>>,
  params: Record<string, unknown>,
  feedID: number,
  cursor: string | null,
): Promise<string | null> {
  let newest: string | null = cursor;
  for await (const step of listPages_walk(
    (offset: number, limit: number): Promise<ListPage<PluginInstanceData>> =>
      pluginInstancesPage_get(client, { ...params, feed_id: feedID, limit, offset }),
    { pageSize: PAGE },
  )) {
    for (const inst of step.items) {
      procInstanceRow_merge(cache, inst);
      newest = isoNewest_pick(newest, inst.start_date);
      newest = isoNewest_pick(newest, inst.end_date);
    }
  }
  return newest;
}

/**
 * Brings one already-loaded feed up to date with CUBE at the cost the change
 * warrants: a settled feed pays one feed-row fetch per {@link FEED_RECHECK_MS};
 * a feed with running work pays that fetch on every visit; and only when the
 * counters moved (or work is running) does the visit walk the delta —
 * `min_end_date` from the cursor, which yields nodes created OR finished since
 * (CUBE stamps end_date at creation and again at completion) — followed by an
 * `active=true` sweep for the nodes still in flight.
 *
 * Concurrent visits share one in-flight sync, and visits within
 * {@link FEED_VISIT_COALESCE_MS} of each other share the first one's result
 * (a pane tick and an `ls` in the same second are one visit). Failures are
 * surfaced as warnings and never fail the visit: the cache stays as it was.
 *
 * @param feedID - A feed whose topology is already loaded.
 * @param force - Ignore the settled-feed throttle (an explicit refresh).
 * @returns True when the cache reflects CUBE as of this visit (including a
 *   visit that needed no wire), false when the sync failed.
 */
export async function feedVisit_sync(feedID: number, force: boolean = false): Promise<boolean> {
  const inflight: Promise<boolean> | undefined = feedVisitInflight.get(feedID);
  if (inflight) return inflight;
  const run: Promise<boolean> = feedVisit_run(feedID, force)
    .then((): boolean => true)
    .catch((error: unknown): boolean => {
      const msg: string = error instanceof Error ? error.message : String(error);
      errorStack.stack_push('warning', `proc feed_${feedID}: live sync failed (${msg}); showing cached state`);
      return false;
    })
    .finally((): void => { feedVisitInflight.delete(feedID); });
  feedVisitInflight.set(feedID, run);
  return run;
}

async function feedVisit_run(feedID: number, force: boolean): Promise<void> {
  const cache: ProcCache = procCache_get();
  const feed: ProcFeed | undefined = cache.feed_get(feedID);
  if (!feed || !cache.topologyLoaded_has(feedID)) return;

  const visit: FeedVisit | undefined = feedVisits.get(feedID);
  const settled: boolean = feedCached_isSettled(cache, feedID) && !feed_isActive(feed);
  const now: number = Date.now();
  if (!force && visit && now - visit.checkedAt < FEED_VISIT_COALESCE_MS) return;
  if (!force && settled && visit && now - visit.checkedAt < FEED_RECHECK_MS) return;

  const client = await chrisConnection.client_get();
  if (!client) return;

  const page: ListPage<FeedData> = await feedsPage_get(client, { id: feedID, limit: 1, offset: 0 });
  const row: FeedData | undefined = page.data[0];
  let moved: boolean = !settled || force;
  if (row) {
    const fresh: ProcFeed = procFeed_create(row);
    if (feedTopology_changed(feed, fresh)) moved = true;
    cache.feed_add(fresh);
  }
  if (!moved) {
    feedVisits.set(feedID, { checkedAt: now, cursor: visit?.cursor ?? null });
    return;
  }

  let cursor: string | null = visit?.cursor ?? feedCursor_derive(cache, feedID);
  const since: Record<string, unknown> = cursor ? { min_end_date: cursor } : {};
  cursor = await feedRows_merge(cache, client, since, feedID, cursor);
  cursor = await feedRows_merge(cache, client, { active: true }, feedID, cursor);
  feedVisits.set(feedID, { checkedAt: Date.now(), cursor });
}

/**
 * Brings the feed roster up to date on a `/proc/jobs` visit. While the roster
 * is younger than {@link ROSTER_FULL_WALK_MS} this is a delta: feeds whose id
 * exceeds the highest known one, from both the owned/shared and the public
 * collections (one call each when nothing is new). Once older, it is the full
 * index walk, which is the only way a feed shared later, or one deleted, is
 * seen. A roster still owned by warmup (not yet `current`) is left alone.
 *
 * @param force - Walk the whole index regardless of age.
 * @returns Feed IDs the sync brought in or found changed: after a full
 *   walk, the reconciliation targets (new, changed, or active feeds); after
 *   a delta, the newly seen feeds. Empty when nothing moved or the roster
 *   was left alone.
 */
export async function procRoster_sync(force: boolean = false): Promise<number[]> {
  if (rosterSyncInflight) {
    // A forced walk asked during a delta is not that delta: it waits for it,
    // then walks (the operator's REFRESH would otherwise see nothing new).
    if (!force || rosterSyncInflightFull) return rosterSyncInflight;
    await rosterSyncInflight.catch((): number[] => []);
    return procRoster_sync(true);
  }
  const cache: ProcCache = procCache_get();
  const kind: ProcRosterSyncKind | null = procRosterSync_kind(cache, force);
  if (rosterDelta_throttled(kind, force)) return [];
  if (kind !== null) cache.rosterSync_progress(kind);
  const run: Promise<number[]> = procRoster_run(force)
    .catch((error: unknown): number[] => {
      const msg: string = error instanceof Error ? error.message : String(error);
      errorStack.stack_push('warning', `proc roster: live sync failed (${msg}); showing cached roster`);
      return [];
    })
    .finally((): void => { rosterSyncInflight = null; rosterSyncInflightFull = false; rosterSyncedAt = Date.now(); cache.rosterSync_clear(); });
  rosterSyncInflight = run;
  rosterSyncInflightFull = kind === 'full';
  return run;
}

/**
 * Whether an unforced delta comes too soon after the last sync to be worth
 * a word to CUBE: every `/proc/jobs` listing (and every `cd` into a feed,
 * which lists it) would otherwise ask, and the surfaces re-ask on a timer.
 * REFRESH forces one; a full walk is never throttled.
 *
 * @param kind - The sync that would run.
 * @param force - Whether the operator asked for it.
 * @returns True when it is skipped.
 */
function rosterDelta_throttled(kind: ProcRosterSyncKind | null, force: boolean): boolean {
  if (force || kind !== 'delta' || rosterSyncedAt === 0) return false;
  const since: number = Date.now() - rosterSyncedAt;
  return since >= 0 && since < ROSTER_DELTA_MIN_MS;
}

/** Which roster walk a sync would run now, or null when the cache is not in service. */
function procRosterSync_kind(cache: ProcCache, force: boolean): ProcRosterSyncKind | null {
  if (!cache.built || cache.lifecycle_get().state !== 'current') return null;
  return force || Date.now() - rosterWalkedAt >= ROSTER_FULL_WALK_MS ? 'full' : 'delta';
}

/**
 * Waits for the roster's sync at most `budgetMs`: a quick CUBE lands what it
 * found in the answer (a share is seen on the next look), a slow one is left
 * to land behind it, announced as arrivals, and the listing answers from the
 * cache. A listing never waits on CUBE longer than the budget.
 *
 * @param budgetMs - How long the caller may wait.
 */
export async function procRoster_syncWithin(budgetMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const budget: Promise<void> = new Promise((resolve: () => void): void => {
    timer = setTimeout(resolve, budgetMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    await Promise.race([procRoster_sync().then((): void => undefined), budget]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Starts the roster's sync and returns at once. The roster is index
 * movement: a command that lists it answers from the cache now, the walk
 * runs off the session's lane (deduped with any sync in flight), the
 * prompt names it while it runs, and arrivals land as they do today.
 *
 * @param force - Whether to run the full walk regardless of the timer.
 * @returns The walk started or already in flight, or `none` when the cache is not in service.
 */
export function procRoster_syncStart(force: boolean = false): ProcRosterSyncKind | 'none' {
  const cache: ProcCache = procCache_get();
  const inflight: ProcRosterSyncKind | null = cache.rosterSync_get();
  if (inflight === 'delta' && force) {
    // The operator's REFRESH during a delta: the whole walk follows it.
    void procRoster_sync(true);
    return 'full';
  }
  if (inflight !== null) return inflight;
  const kind: ProcRosterSyncKind | null = procRosterSync_kind(cache, force);
  if (kind === null || rosterDelta_throttled(kind, force)) return 'none';
  void procRoster_sync(force);
  return kind;
}

async function procRoster_run(force: boolean): Promise<number[]> {
  const cache: ProcCache = procCache_get();
  if (!cache.built || cache.lifecycle_get().state !== 'current') return [];

  if (force || Date.now() - rosterWalkedAt >= ROSTER_FULL_WALK_MS) {
    return procCache_build();
  }

  const client = await chrisConnection.client_get();
  if (!client) return [];
  return procRosterDelta_run(cache, client);
}

/**
 * One collection's newest page, read unfiltered. CUBE orders feeds newest
 * first, so the page carries every feed newer than the roster's highest id
 * unless more than a page arrived, and its total is the collection's whole
 * count — the yardstick a share, an unshare or a deletion moves.
 *
 * @param page_fetch - Fetches one page of the collection.
 * @param maxKnown - The roster's highest feed id (0 for an empty roster).
 * @returns The newer feeds, the total, and whether the page overflowed.
 */
async function rosterCollection_peek(page_fetch: FeedPageFetch, maxKnown: number): Promise<RosterPeek> {
  const page: ListPage<FeedData> = await page_fetch({ limit: ROSTER_DELTA_PAGE, offset: 0 });
  const rows: ProcFeed[] = page.data.map(procFeed_create);
  const newer: ProcFeed[] = rows.filter((feed: ProcFeed): boolean => feed.id > maxKnown);
  const overflow: boolean = rows.length > 0 && newer.length === rows.length
    && page.totalCount !== null && page.totalCount > rows.length;
  return { newer, total: page.totalCount, overflow };
}

/**
 * Whether a collection's total moved by more than its newer rows account
 * for: a feed arrived or left under the newest page, which only the full
 * walk can place. An overflowed page, or a collection without a yardstick,
 * cannot say.
 *
 * @param collection - The collection peeked.
 * @param peek - What its newest page read.
 * @returns True when the total moved.
 */
function rosterTotal_moved(collection: keyof RosterTotals, peek: RosterPeek): boolean {
  const expected: number | null = rosterTotals[collection];
  if (expected === null || peek.total === null || peek.overflow) return false;
  return peek.total !== expected + peek.newer.length;
}

/**
 * Brings the roster up to date without walking the whole index: each
 * collection's newest page is read, its feeds newer than the roster are
 * adopted, and its total is held against the last walk's. A total that
 * moved otherwise — a feed shared to this identity, one unshared, one
 * deleted — promotes the visit to the full walk, which places it. A page
 * that overflowed is followed by the walk of everything newer than the
 * roster, by id.
 *
 * @param cache - The process cache.
 * @param client - Connected chrisapi client.
 * @returns The feed IDs added; after a promotion, the full walk's reconciliation targets.
 */
async function procRosterDelta_run(
  cache: ProcCache,
  client: NonNullable<Awaited<ReturnType<typeof chrisConnection.client_get>>>,
): Promise<number[]> {
  const knownIDs: number[] = cache.feedIDs_get();
  const maxKnown: number = knownIDs.length > 0 ? Math.max(...knownIDs) : 0;
  const ownedFetch: FeedPageFetch = (params: Record<string, unknown>): Promise<ListPage<FeedData>> =>
    feedsPage_get(client, params);
  const publicFetch: FeedPageFetch = async (params: Record<string, unknown>): Promise<ListPage<FeedData>> =>
    (await publicFeedsPage_get(client, params)) ?? { data: [], totalCount: 0 };

  const owned: RosterPeek = await rosterCollection_peek(ownedFetch, maxKnown);
  const pub: RosterPeek = await rosterCollection_peek(publicFetch, maxKnown);
  if (rosterTotal_moved('owned', owned) || rosterTotal_moved('public', pub)) {
    cache.rosterSync_progress('full');
    return procCache_build();
  }

  const fresh: Map<number, ProcFeed> = new Map();
  for (const feed of [...owned.newer, ...pub.newer]) fresh.set(feed.id, feed);
  if (owned.overflow || pub.overflow) {
    const minID: number = maxKnown + 1;
    await procFeeds_index(
      (params: Record<string, unknown>): Promise<ListPage<FeedData>> => ownedFetch({ ...params, min_id: minID }),
      fresh,
    );
    await procFeeds_index(
      (params: Record<string, unknown>): Promise<ListPage<FeedData>> => publicFetch({ ...params, min_id: minID }),
      fresh,
    );
  }
  rosterTotals = { owned: owned.total, public: pub.total };
  for (const feed of fresh.values()) cache.feed_add(feed);
  cache.arrivals_note(Array.from(fresh.keys()));
  await arrivalsUnseen_mark(cache, Array.from(fresh.keys()));
  procTopologyCatchup_roster(cache);
  return Array.from(fresh.keys());
}

/**
 * Brings a restored roster into service at boot without walking the whole
 * feed index: feeds newer than the highest restored id are added (one call
 * per collection when nothing is new), and the cache is marked built so
 * visits can begin. Counters of restored feeds stay as checkpointed until a
 * visit or the full walk the host runs in the background afterwards.
 *
 * @returns The feed IDs added.
 * @throws {Error} When not connected or the roster is empty (nothing was
 *   restored) — the host then falls back to the full index build.
 */
export async function procRoster_bootSync(): Promise<number[]> {
  const cache: ProcCache = procCache_get();
  if (cache.feedIDs_get().length === 0) throw new Error('no restored roster to bring into service');
  const client = await chrisConnection.client_get();
  if (!client) throw new Error('not connected');
  const added: number[] = await procRosterDelta_run(cache, client);
  cache.built_set();
  return added;
}

// ── Topology catch-up ──────────────────────────────────────────────────────
//
// A feed the roster gains after the sweep — found by the watcher's delta,
// shared to this identity, or restored from a roster whose shard was never
// written — has a row but no jobs, so its SIZE and TIME read as dashes
// until someone opens it (the only thing that walked a feed's jobs). Every
// roster sync now queues the feeds it leaves without topology, and one
// detached walk at a time lands them: a feed-scoped page or two each, off
// the lane, annunciated by the load register like a visit's walk.

/** Feeds waiting for their topology walk, in the order the roster found them. */
const topologyCatchupQueue: number[] = [];
/** The feeds queued, for a cheap membership test. */
const topologyCatchupQueued: Set<number> = new Set();
/** The runner draining the queue, when one is. */
let topologyCatchupRun: Promise<void> | null = null;

/**
 * Queues roster feeds whose topology the cache lacks, and starts the walk
 * when none is running. Nothing is queued while the global sweep is the
 * one bringing topology in (it covers every feed), nor for a feed already
 * loaded, loading or queued.
 *
 * @param feedIDs - Candidate feed IDs (a sync's arrivals, or the roster).
 * @returns How many feeds this call queued.
 */
export function procTopologyCatchup_enqueue(feedIDs: number[]): number {
  const cache: ProcCache = procCache_get();
  if (!cache.warmupComplete || procTopologyPromise !== null) return 0;
  let queued: number = 0;
  for (const feedID of feedIDs) {
    if (!cache.feed_get(feedID) || cache.topologyLoaded_has(feedID)) continue;
    if (cache.loading_get(feedID) !== undefined || topologyCatchupQueued.has(feedID)) continue;
    topologyCatchupQueue.push(feedID);
    topologyCatchupQueued.add(feedID);
    queued++;
  }
  if (queued > 0 && topologyCatchupRun === null) {
    topologyCatchupRun = procTopologyCatchup_run().finally((): void => { topologyCatchupRun = null; });
  }
  return queued;
}

/** Walks the queued feeds one at a time until the queue is empty. */
async function procTopologyCatchup_run(): Promise<void> {
  const cache: ProcCache = procCache_get();
  for (;;) {
    const feedID: number | undefined = topologyCatchupQueue.shift();
    if (feedID === undefined) return;
    topologyCatchupQueued.delete(feedID);
    if (!cache.feed_get(feedID) || cache.topologyLoaded_has(feedID)) continue;
    // A sweep that started meanwhile covers the rest.
    if (procTopologyPromise !== null) { procTopologyCatchup_reset(); return; }
    feedInstances_ensureStarted(feedID);
    const walk: Promise<void> | undefined = cache.loading_get(feedID);
    if (walk) await walk.catch((): void => { /* named in the load register; the next sync queues it again */ });
  }
}

/**
 * How many feeds still wait for their topology, and whether a walk runs.
 *
 * @returns The catch-up's state.
 */
export function procTopologyCatchup_status(): { queued: number; running: boolean } {
  return { queued: topologyCatchupQueue.length, running: topologyCatchupRun !== null };
}

/**
 * Waits for the catch-up to drain (tests, and a readout that wants whole numbers).
 *
 * @returns Resolves when no walk is queued or running.
 */
export async function procTopologyCatchup_await(): Promise<void> {
  while (topologyCatchupRun !== null) await topologyCatchupRun;
}

/** Forgets the queue (a sweep took over, or a cache cleared underneath us). */
function procTopologyCatchup_reset(): void {
  topologyCatchupQueue.length = 0;
  topologyCatchupQueued.clear();
}

/**
 * Queues every roster feed without topology — what a roster sync leaves
 * behind when the sweep is already over.
 *
 * @param cache - The process cache.
 * @returns How many feeds were queued.
 */
function procTopologyCatchup_roster(cache: ProcCache): number {
  return procTopologyCatchup_enqueue(cache.feedIDs_get());
}

/**
 * One place a jump can land: a feed, or a node within one.
 *
 * @property kind - A feed, or a node (plugin instance).
 * @property feedId - The feed, or the node's feed.
 * @property nodeId - The node, for a node.
 * @property name - The `/proc` name: `feed_4389`, or `pl-dicom_repack_639204`.
 * @property title - The feed's title.
 */
export interface ProcLocation {
  kind: 'feed' | 'node';
  feedId: number;
  nodeId?: number;
  name: string;
  title: string;
}

/**
 * What a jump target names: a feed only (`feed_4389`), a node only
 * (`pl-dicom_repack_639204`, or `_639204`), or a bare number that may be
 * either. Null for anything else.
 *
 * @param target - What the operator typed.
 * @returns The id and which kinds it may name, or null.
 */
export function procTarget_parse(target: string): { id: number; feed: boolean; node: boolean } | null {
  const text: string = target.trim();
  const feed: RegExpExecArray | null = /^feed_(\d+)$/.exec(text);
  if (feed !== null) return { id: Number(feed[1]), feed: true, node: false };
  const node: RegExpExecArray | null = /^[\w.-]*_(\d+)$/.exec(text);
  if (node !== null) return { id: Number(node[1]), feed: false, node: true };
  if (/^\d+$/.test(text)) return { id: Number(text), feed: true, node: true };
  return null;
}

/**
 * Finds where a jump target lands, asking CUBE live for what the roster
 * and the index lack: a feed shared since the roster was walked, or a node
 * in one. A node's feed is adopted into the roster on the way, so the
 * place the answer names can be entered at once. A bare number that is
 * both a feed and a node answers both; the caller asks which.
 *
 * @param target - A feed id, a node id, or a `feed_N` / `<plugin>_N` name.
 * @returns Every place it names that this identity can see; empty for none.
 */
export async function procTarget_locate(target: string): Promise<ProcLocation[]> {
  const parsed: { id: number; feed: boolean; node: boolean } | null = procTarget_parse(target);
  if (parsed === null) return [];
  const cache: ProcCache = procCache_get();
  const found: ProcLocation[] = [];
  if (parsed.feed) {
    const feed: ProcFeed | null = cache.feed_get(parsed.id) ?? (await procFeedAbsent_probe(parsed.id));
    if (feed !== null) found.push({ kind: 'feed', feedId: feed.id, name: `feed_${feed.id}`, title: feed.title });
  }
  if (parsed.node) {
    const node: { feedId: number; pluginName: string } | null = await procNode_find(parsed.id);
    if (node !== null) {
      const feed: ProcFeed | null = cache.feed_get(node.feedId) ?? (await procFeedAbsent_probe(node.feedId));
      if (feed !== null) {
        found.push({ kind: 'node', feedId: node.feedId, nodeId: parsed.id, name: `${node.pluginName}_${parsed.id}`, title: feed.title });
      }
    }
  }
  return found;
}

/**
 * A node's feed and plugin, from the index or, when the index lacks it,
 * from CUBE.
 *
 * @param nodeId - The plugin instance id.
 * @returns Its feed and plugin name, or null when CUBE shows no such node to this identity.
 */
async function procNode_find(nodeId: number): Promise<{ feedId: number; pluginName: string } | null> {
  const known: ProcInstance | undefined = procCache_get().instance_get(nodeId);
  if (known !== undefined) return { feedId: known.feedID, pluginName: known.pluginName };
  const client = await chrisConnection.client_get();
  if (!client) return null;
  try {
    const handle: PluginInstanceHandle | null = await pluginInstance_get(client, nodeId);
    const feedId: number = Number(handle?.data?.feed_id);
    const pluginName: string = String(handle?.data?.plugin_name ?? '');
    return Number.isFinite(feedId) && feedId > 0 && pluginName !== '' ? { feedId, pluginName } : null;
  } catch {
    return null;
  }
}

/**
 * Forgets all visit bookkeeping (tests, and a cache cleared underneath us).
 */
export function procVisitState_reset(): void {
  feedVisits.clear();
  feedVisitInflight.clear();
  rosterWalkedAt = 0;
  rosterSyncInflight = null;
  rosterSyncInflightFull = false;
  rosterSyncedAt = 0;
  pipelineBackfill = null;
  Object.assign(pipelineBackfillProgress, { pages: 0, read: 0, running: false });
  rosterTotals = { owned: null, public: null };
  procTopologyCatchup_reset();
}

/**
 * Background topology warm-up — single paginated sweep of all plugin instances
 * across all feeds. Replaces the per-feed fan-out that was O(feeds) round trips.
 *
 * Scoped per-feed loads may run concurrently for navigation; the completed
 * global sweep reconciles the cache to its authoritative instance set.
 *
 * @param state - Private pagination and reconciliation state for this sweep.
 * @returns A promise that settles when the complete topology has been reconciled.
 */
async function procTopology_run(state: ProcTopologySweepState): Promise<void> {
  await cache_ensure();
  const cache: ProcCache = procCache_get();
  cache.lifecycle_set('reconciling');
  if (state.total > 0) {
    cache.warmup_progress(state.fetchedInstanceIDs.size, state.total);
  }
  const client = await chrisConnection.client_get();
  if (!client) throw new Error('not connected');

  // state.total of 0 encodes "unknown" in the persisted sweep state; the
  // walker's null encoding is translated at this boundary so a resumed
  // sweep keeps its latched total and offset.
  for await (const step of listPages_walk(
    (offset: number, limit: number): Promise<ListPage<PluginInstanceData>> =>
      pluginInstancesPage_get(client, { limit, offset }),
    { pageSize: PAGE, startOffset: state.offset, startTotal: state.total > 0 ? state.total : null },
  )) {
    if (state.total === 0 && step.total !== null) {
      state.total = step.total;
      if (state.total > 0) cache.warmup_progress(0, state.total);
    }

    for (const inst of step.items) {
      const instanceID: number = Number(inst.id);
      const feedID: number = Number(inst.feed_id);
      state.fetchedInstanceIDs.add(instanceID);

      if (!cache.feed_get(feedID)) continue;

      cache.instance_add(procInstance_buildFromRow(inst));
      state.seenInstanceIDs.add(instanceID);
      state.seenFeedIDs.add(feedID);
    }

    state.offset = step.offset + step.items.length;
    if (state.total > 0) cache.warmup_progress(state.fetchedInstanceIDs.size, state.total);
  }

  cache.topology_reconcile(state.seenInstanceIDs);
  for (const feedID of state.seenFeedIDs) cache.topologyLoaded_mark(feedID);
  if (state.total === 0) {
    cache.warmup_progress(state.fetchedInstanceIDs.size, state.fetchedInstanceIDs.size);
  }
  cache.warmup_complete();
}

/**
 * Creates an empty continuation for a fresh global topology sweep.
 *
 * @returns New private pagination and reconciliation state.
 */
function procTopologyState_create(): ProcTopologySweepState {
  return {
    offset: 0,
    total: 0,
    fetchedInstanceIDs: new Set<number>(),
    seenInstanceIDs: new Set<number>(),
    seenFeedIDs: new Set<number>(),
  };
}

/**
 * Starts one topology sweep from the supplied private continuation state.
 *
 * @param state - Private pagination and reconciliation state to run or resume.
 * @returns The in-flight topology sweep promise.
 */
function procTopology_start(state: ProcTopologySweepState): Promise<void> {
  procTopologyFailure = undefined;
  procTopologyResumeState = state;
  procTopologyScopedResumeFeedIDs = null;
  const sweep: Promise<void> = procTopology_run(state);
  procTopologyPromise = sweep;
  sweep.then(
    (): void => {
      if (procTopologyPromise !== sweep) return;
      procTopologyPromise = null;
      if (procCache_get().warmupComplete) {
        procTopologyFailure = undefined;
        procTopologyResumeState = null;
        procSettlementTails_run();
      } else {
        procTopologyFailure = 'the topology sweep ended before the index completed';
      }
    },
    (error: unknown): void => {
      if (procTopologyPromise !== sweep) return;
      procTopologyPromise = null;
      procCache_get().warmup_abort();
      procTopologyFailure = error instanceof Error ? error.message : String(error);
    },
  );
  return sweep;
}

/** The data-facts reader, with this provider's output paths. */
function dataFactsIO_get(): DataFactsIO {
  return dataFactsIO_build(instanceOutputPath_ensure);
}

/**
 * Reads the data facts of every feed that has none yet (see
 * `dag/feedData.ts`): the index's tail after a sweep, and the one a daemon
 * that restored its checkpoint starts itself, since no sweep runs then.
 *
 * @returns How many feeds were read; zero when a sweep is already under way.
 */
export async function procDataFacts_start(): Promise<number> {
  try {
    return await procDataFacts_sweep(dataFactsIO_get());
  } catch {
    return 0;
  }
}

/**
 * Kicks the quiet settlement tails once the topology index is complete:
 * every unresolved `ts` join resolves in the background (so first diagrams
 * are pure cache, and the checkpoint persists them), and the pipeline
 * package store sweeps unseen registered pipelines. Both are best-effort —
 * a failure leaves the lazy paths intact.
 */
function procSettlementTails_run(): void {
  void procJoins_sweep().catch((): void => { /* lazy resolution remains */ });
  void procDataFacts_start();
  void pipelinePackages_sweep().catch((): void => { /* lazy fetch remains */ });
}

/**
 * Runs a feed-scoped topology reconciliation selected after checkpoint restore.
 *
 * @param feedIDs - Canonical feed IDs whose topology needs a fresh load.
 * @returns A promise that settles after the supplied feeds are reconciled.
 */
async function procTopologyScoped_run(feedIDs: number[]): Promise<void> {
  const cache: ProcCache = procCache_get();
  cache.lifecycle_set('reconciling');
  for (const feedID of feedIDs) await procCache_refresh(feedID);
  cache.warmup_complete();
  procSettlementTails_run();
}

/**
 * Starts one scoped reconciliation and retains its targets for `proc retry`.
 *
 * @param feedIDs - Canonical feed IDs selected by the fresh feed index.
 * @returns The in-flight scoped reconciliation promise.
 */
function procTopologyScoped_start(feedIDs: number[]): Promise<void> {
  const targets: number[] = [...feedIDs];
  procTopologyFailure = undefined;
  procTopologyResumeState = null;
  procTopologyScopedResumeFeedIDs = targets;
  const sweep: Promise<void> = procTopologyScoped_run(targets);
  procTopologyPromise = sweep;
  sweep.then(
    (): void => {
      if (procTopologyPromise !== sweep) return;
      procTopologyPromise = null;
      if (procCache_get().warmupComplete) {
        procTopologyFailure = undefined;
        procTopologyScopedResumeFeedIDs = null;
      } else {
        procTopologyFailure = 'the scoped topology reconciliation ended before the index completed';
      }
    },
    (error: unknown): void => {
      if (procTopologyPromise !== sweep) return;
      procTopologyPromise = null;
      procCache_get().warmup_abort();
      procTopologyFailure = error instanceof Error ? error.message : String(error);
    },
  );
  return sweep;
}

/**
 * Starts or joins the session's global plugin-instance topology sweep.
 *
 * @returns The single in-flight sweep promise.
 */
export function procTopology_warmup(): Promise<void> {
  if (procTopologyPromise) return procTopologyPromise;
  return procTopology_start(procTopologyState_create());
}

/**
 * Reconciles topology only for feed IDs selected by a restored-cache feed-index
 * comparison. This preserves the checkpointed topology for unchanged terminal
 * feeds while refreshing new, changed, and active feeds from CUBE.
 *
 * @param feedIDs - Canonical CUBE feed IDs whose topology must be reloaded.
 * @returns A promise that resolves after all supplied feeds have been refreshed.
 */
export function procTopology_reconcileFeeds(feedIDs: number[]): Promise<void> {
  if (procTopologyPromise) return procTopologyPromise;
  return procTopologyScoped_start(feedIDs);
}

/**
 * Continues a failed topology reconciliation from its retained global page or
 * scoped feed set.
 *
 * @returns The resumed sweep promise, or the active sweep when one is running.
 * @throws {Error} When there is no failed sweep continuation to retry.
 */
export function procTopology_retry(): Promise<void> {
  if (procTopologyPromise) return procTopologyPromise;
  if (procTopologyFailure === undefined) {
    throw new Error('no failed topology sweep to retry');
  }
  if (procTopologyResumeState) return procTopology_start(procTopologyResumeState);
  if (procTopologyScopedResumeFeedIDs) return procTopologyScoped_start(procTopologyScopedResumeFeedIDs);
  throw new Error('no failed topology sweep to retry');
}

/**
 * Reports the session topology sweep lifecycle.
 *
 * @returns A snapshot of the lifecycle state and any failure reason.
 */
export function procTopology_status(): ProcTopologyStatus {
  if (procTopologyPromise) return { state: 'running', failure: undefined };
  if (procTopologyFailure !== undefined) return { state: 'failed', failure: procTopologyFailure };
  if (procCache_get().warmupComplete) return { state: 'complete', failure: undefined };
  return { state: 'idle', failure: undefined };
}

/**
 * Waits for the active topology sweep without starting another.
 *
 * @returns A promise that resolves when the active sweep finishes, or
 * immediately when no sweep is running.
 */
export async function procTopology_await(): Promise<void> {
  const sweep: Promise<void> | null = procTopologyPromise;
  if (sweep) await sweep;
}

/**
 * Rebuilds the ProcCache, optionally scoped to one feed.
 *
 * A full refresh returns feeds whose topology merits reload after the feed-index
 * comparison. Callers performing an explicit `proc refresh` can ignore that
 * result and run a global topology sweep; restored startup uses it to stay scoped.
 *
 * @param feedID - One feed to force-refresh, or undefined for the full feed index.
 * @returns IDs whose topology is new, changed, or currently active.
 */
export async function procCache_refresh(feedID?: number): Promise<number[]> {
  if (feedID !== undefined) {
    await procFeed_evict(feedID);
    await feedInstances_ensureLoaded(feedID);
    return [feedID];
  } else {
    const activeSweep: Promise<void> | null = procTopologyPromise;
    if (activeSweep) {
      try {
        await activeSweep;
      } catch {
        // A full refresh replaces any failed sweep with a new idle lifecycle.
      }
    }
    procTopologyPromise = null;
    procTopologyFailure = undefined;
    procTopologyResumeState = null;
    procTopologyScopedResumeFeedIDs = null;
    procCache_get().warmup_reset();
    feedVisits.clear();
    return procCache_build();
  }
}
