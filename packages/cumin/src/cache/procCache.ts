/**
 * @file Process Cache
 *
 * Session-scoped cache of ChRIS feed topology. Separates permanent data
 * (instance DAG structure and terminal status) from volatile active status.
 *
 * Design decisions:
 * - Topology (id, feedID, parentID, pluginName) is permanent once written.
 * - Terminal status is immutable and checkpointed; active status refreshes live.
 * - Feed job counters (finishedJobs etc.) give aggregate feed status
 *   without per-instance API calls.
 * - topologyLoaded distinguishes "loaded but 0 instances" from "not yet loaded".
 * - loading map prevents duplicate API calls when background loader and
 *   user navigation race on the same feed.
 * - warmupComplete enables pure in-memory path for proc find <name>.
 *
 * @module
 */
import { identityCache_usable, identityChange_listen } from '../connect/identityEpoch';
import { listingsForFeeds_note, listingsForFeeds_drop, listingsForRoster_note, listingInvalidation_reset } from './listingInvalidation';

/**
 * Feed-level metadata including job count fields for aggregate status.
 *
 * @property ownerUsername - Username that owns the feed.
 * @property public - Whether the feed is publicly visible.
 */
export interface ProcFeed {
  id: number;
  title: string;
  ownerUsername: string;
  public: boolean;
  creationDate: string;   // ISO string — used to filter warmup to recent feeds
  finishedJobs: number;
  erroredJobs: number;
  startedJobs: number;
  scheduledJobs: number;
  cancelledJobs: number;
  createdJobs: number;
}

/**
 * Exclusive feed counts by how the current identity can see each feed.
 *
 * @property user - Feeds owned by the current identity.
 * @property public - Public feeds owned by another identity.
 * @property shared - Non-public feeds shared by another identity.
 * @property total - Unique visible feeds across all three buckets.
 */
export interface ProcFeedScopeCounts {
  user: number;
  public: number;
  shared: number;
  total: number;
}

/** Feed counters whose changes can alter a feed's plugin-instance topology. */
const FEED_TOPOLOGY_COUNTERS: ReadonlyArray<keyof Pick<ProcFeed,
  'finishedJobs' | 'erroredJobs' | 'startedJobs' | 'scheduledJobs' | 'cancelledJobs' | 'createdJobs'
>> = [
  'finishedJobs',
  'erroredJobs',
  'startedJobs',
  'scheduledJobs',
  'cancelledJobs',
  'createdJobs',
];

/**
 * Reports whether a feed has work which can still change after checkpointing.
 *
 * @param feed - Feed summary with CUBE job counters.
 * @returns True when any job is created, scheduled, or started.
 */
export function feed_isActive(feed: ProcFeed): boolean {
  return feed.startedJobs > 0 || feed.scheduledJobs > 0 || feed.createdJobs > 0;
}

/**
 * Reports whether two feed summaries indicate different instance topology.
 *
 * @param previous - The cached feed summary.
 * @param current - A freshly fetched feed summary.
 * @returns True when any job counter differs.
 */
export function feedTopology_changed(previous: ProcFeed, current: ProcFeed): boolean {
  return FEED_TOPOLOGY_COUNTERS.some(
    (counter: keyof Pick<ProcFeed,
      'finishedJobs' | 'erroredJobs' | 'startedJobs' | 'scheduledJobs' | 'cancelledJobs' | 'createdJobs'
    >): boolean => previous[counter] !== current[counter],
  );
}

/**
 * Instance entry. Topology (id/feedID/parentID/pluginName) is permanent.
 * Status is cached only once terminal (settled); active status is refreshed live.
 */
export interface ProcInstance {
  id: number;
  feedID: number;
  /** null for root nodes (direct children of a feed). */
  parentID: number | null;
  pluginName: string;
  /**
   * Plugin type (`fs` | `ds` | `ts`), immutable. Authoritative for detecting a
   * topological-join node (`ts`). Optional — absent for nodes added before this was
   * tracked; callers should fall back to a name match when undefined.
   */
  pluginType?: string;
  /** ISO execution start, from the CUBE list row; undefined when unobserved. */
  startedAt?: string;
  /** ISO execution end; undefined until the job is terminal. */
  finishedAt?: string;
  /** Output size in bytes, as CUBE reports it; undefined when unobserved. */
  outputBytes?: number;
  /** The compute resource the job ran on; undefined when unobserved. */
  computeResource?: string;
  /** The pipeline whose run made the job; null when it was run directly, undefined until a row said. */
  pipelineName?: string | null;
  /** The workflow (pipeline run) that made the job; null when run directly, undefined until a row said. */
  workflowID?: number | null;
  /** null until first cat — immutable once populated. */
  params: Record<string, unknown> | null;
  /**
   * Authoritative CUBE output directory, resolved lazily for the `/proc` data
   * link. `undefined` means not looked up; `null` means CUBE reported none.
   * This navigation convenience is deliberately excluded from checkpoints.
   */
  outputPath?: string | null;
  /**
   * Last known job status. Terminal statuses (see {@link PROC_TERMINAL_STATUSES})
   * are immutable and kept permanently; active statuses are refreshed live.
   * null when topology is known but status has not been observed yet.
   */
  status: string | null;
  /**
   * Extra parent instance IDs for a topological-join (`ts`) node — the sources it
   * merges beyond its anchor {@link ProcInstance.parentID}. Immutable once a feed has
   * run; populated lazily (only ts nodes have any). Absent/undefined = not yet
   * resolved; empty array = resolved, no joins. See the feed-DAG design notes.
   */
  joinParentIDs?: number[];
}

/**
 * Job statuses that never change once reached. An instance in one of these states
 * is settled — its status can be cached permanently rather than re-fetched.
 */
export const PROC_TERMINAL_STATUSES: ReadonlySet<string> = new Set<string>([
  'finishedSuccessfully',
  'finishedWithError',
  'cancelled',
]);

/**
 * Reports whether a status is terminal (settled) and therefore safe to cache.
 *
 * @param status - Job status string, or null/undefined when unknown.
 * @returns True if the status is terminal and immutable.
 */
export function status_isTerminal(status: string | null | undefined): boolean {
  return status != null && PROC_TERMINAL_STATUSES.has(status);
}

/**
 * Warm-up progress counters for the prompt indicator.
 * total is zero until the server reports the visible plugin-instance count.
 * active becomes true when observable page progress begins, and false when the
 * sweep completes or aborts. Use the topology lifecycle to detect an earlier
 * running state before the first page arrives.
 */
export interface ProcWarmupProgress {
  loaded: number;
  total: number;
  active: boolean;
}

/**
 * One feed's first-visit topology load in flight: the prompt shows it so a
 * 20k-node feed's walk is never a silent hang.
 *
 * @property feedID - The feed being loaded.
 * @property loaded - Instances fetched so far.
 * @property total - The server's count for the feed, zero until reported.
 */
export interface ProcFeedLoadProgress {
  feedID: number;
  loaded: number;
  total: number;
  /** What the walk said when it failed; absent while it runs. A failed entry is kept for {@link PROC_FEED_LOAD_FAILURE_TTL_MS}. */
  failed?: string;
}

/** The roster walks the cache can have in flight: the delta, or the ten-minute full walk. */
export type ProcRosterSyncKind = 'delta' | 'full';

/** How long a failed feed load stays annunciated before the register forgets it. */
export const PROC_FEED_LOAD_FAILURE_TTL_MS: number = 60_000;

/**
 * Where a feed appears for one identity, by how that identity sees it.
 *
 * @property owner - The identity's own username, used to tell an owned
 *   feed from one shared to it.
 * @property own - Folder holding feeds this identity owns.
 * @property shared - Folder holding feeds shared to this identity.
 * @property public - Folder holding public feeds.
 */
export interface RosterFolders {
  owner?: string;
  own?: string;
  shared?: string;
  public?: string;
}

/**
 * A feed's status from its job counts: an error anywhere is the feed's
 * error; else anything still moving is the feed moving; else it finished.
 *
 * @param feed - The feed's counts.
 * @returns A DAG status word: `finishedWithError`, `started`, `scheduled`, `created`, `cancelled` or `finishedSuccessfully`.
 */
export function feedStatus_deriveFromCounts(feed: ProcFeed): string {
  // The words are a node's own (the DAG status vocabulary), so a feed on
  // a surface wears the hue its jobs would.
  if (feed.erroredJobs > 0) return 'finishedWithError';
  if (feed.startedJobs > 0) return 'started';
  if (feed.scheduledJobs > 0) return 'scheduled';
  if (feed.createdJobs > 0) return 'created';
  if (feed.cancelledJobs > 0 && feed.finishedJobs === 0) return 'cancelled';
  return 'finishedSuccessfully';
}

/** How long a roster arrival stays annunciated after it lands. */
export const PROC_ARRIVAL_TTL_MS: number = 30 * 1000;

/**
 * How long a feed whose topology just landed stays reported as landed.
 * The prompt is pushed about once a second while the index moves, so a
 * surface that reads every push sees each landing several times and keeps
 * one; a surface that missed a push still sees it on the next.
 */
export const PROC_LANDED_TTL_MS: number = 10 * 1000;

/**
 * One feed as it landed in the index: enough to place it in the space of
 * everything run here, and nothing a surface would have to ask for.
 *
 * @property id - The feed.
 * @property jobs - How many plugin instances it holds.
 * @property status - The feed's own status, derived from its job counts.
 * @property chain - Its plugin names by first appearance, root first: the
 *   shape a pipeline leaves, shared with every feed that ran the same way.
 * @property groups - Its jobs collapsed by plugin per place in the
 *   pipeline: the feed's shape with counts for weight, a handful of
 *   entries however many jobs it holds.
 */
export interface ProcLandedFeed {
  id: number;
  /** The feed's name, for a surface that names what it draws. */
  title: string;
  jobs: number;
  status: string;
  chain: string[];
  groups: ProcJobGroup[];
}

/**
 * One node of a feed's collapsed shape: every job of one plugin hanging
 * from the same parent group, as one node with a count.
 *
 * @property plugin - The plugin name.
 * @property count - How many jobs the node stands for.
 * @property status - The worst word among them: an error anywhere is the
 *   group's, else anything still moving, else finished.
 * @property parent - The index of the parent group, or null at the root.
 */
export interface ProcJobGroup {
  plugin: string;
  count: number;
  /** How many of them ended in error, so a surface can hue by share rather than by the worst. */
  errored: number;
  status: string;
  parent: number | null;
}

/** Availability and freshness states for the persistent process cache. */
export type ProcCacheState = 'empty' | 'restored' | 'reconciling' | 'current' | 'failed';

/**
 * Persistent process-cache freshness metadata.
 *
 * @property state - Current availability and reconciliation state.
 * @property checkpointAt - ISO timestamp of the latest durable checkpoint.
 */
export interface ProcCacheLifecycle {
  state: ProcCacheState;
  checkpointAt?: string;
}

/** What kind of data a feed began from. */
export type ProcDataFormat = 'dicom' | 'nifti' | 'mgz' | 'jpeg' | 'png' | 'other' | 'unknown';

/**
 * What a feed's data is, read once from the first file its root produced:
 * the format, and for DICOM the modality and series description.
 *
 * @property format - The kind of data.
 * @property modality - DICOM Modality (0008,0060), when the header says.
 * @property seriesDescription - DICOM SeriesDescription (0008,103E), when it says.
 * @property reason - Why the format is `unknown` or `other`, in words.
 * @property reader - The version of the reader that wrote them: a newer
 *   reader reads a feed again rather than trust an older one's answer.
 */
export interface ProcFeedDataFacts {
  format: ProcDataFormat;
  modality?: string;
  seriesDescription?: string;
  reason?: string;
  /** The feed whose output this feed's data is, when it began from another feed's work. */
  sourceFeed?: number;
  reader?: number;
}

/**
 * Serializable topology retained across daemon restarts.
 *
 * @property feeds - Visible feed metadata.
 * @property instances - Normalized plugin-instance topology.
 * @property topologyLoaded - Feed IDs whose instance topology is complete.
 */
export interface ProcCacheSnapshot {
  feeds: ProcFeed[];
  instances: ProcInstance[];
  topologyLoaded: number[];
  /** Each feed's data facts, by feed id; absent from a checkpoint written before they existed. */
  dataFacts?: Record<number, ProcFeedDataFacts>;
  /** Feeds that arrived and have not been looked at (NEW since the last visit); absent in older checkpoints. */
  unseen?: number[];
}

/**
 * One feed's persistence-safe topology: what a per-feed checkpoint shard holds.
 *
 * @property feedID - The feed these instances belong to.
 * @property loaded - Whether the feed's topology is known to be complete.
 * @property instances - Normalized instances with terminal status only.
 */
export interface ProcFeedSnapshot {
  feedID: number;
  loaded: boolean;
  instances: ProcInstance[];
  /** The feed's data facts, once read; absent until then. */
  dataFacts?: ProcFeedDataFacts;
}

/**
 * What a cache mutation touched, so a persister can write only that part.
 *
 * - `roster`: the feed index (a feed row added, updated, or removed);
 * - `feed`: one feed's topology, status, metrics, joins, or loaded mark;
 * - `all`: every feed at once (a completed global sweep);
 * - `lifecycle`: freshness state only — nothing durable changed.
 */
export type ProcCacheChange =
  | { scope: 'roster' }
  | { scope: 'feed'; feedID: number }
  | { scope: 'all' }
  | { scope: 'lifecycle' };

/** A cache mutation listener, told what the mutation touched. */
export type ProcCacheListener = (change: ProcCacheChange) => void;

/**
 * Strips an instance to its persistence-safe form: no params, no output
 * path, and only a terminal status (an active one is re-observed live).
 *
 * @param inst - A cached instance.
 * @returns A copy safe to checkpoint.
 */
function procInstance_persistent(inst: ProcInstance): ProcInstance {
  const { outputPath: _outputPath, ...persistent }: ProcInstance = inst;
  return {
    ...persistent,
    params: null,
    status: status_isTerminal(inst.status) ? inst.status : null,
    joinParentIDs: inst.joinParentIDs ? [...inst.joinParentIDs] : undefined,
  };
}

/**
 * Session-scoped cache of feed and instance topology with restorable terminal state.
 */
export class ProcCache {
  private static _instance: ProcCache | null = null;

  private feeds: Map<number, ProcFeed> = new Map();
  private instances: Map<number, ProcInstance> = new Map();
  private feedRoots: Map<number, number[]> = new Map();
  private children: Map<number, number[]> = new Map();
  /**
   * Every instance known for a feed, root or not. The root walk above is
   * the feed's TOPOLOGY; this is its ROLL, and it is what a landing reads:
   * CUBE lists instances newest first, so a cold sweep meets a feed's
   * leaves before its root, and a shape walked from roots stayed empty
   * for the whole of a big feed until its oldest instance arrived.
   */
  private byFeed: Map<number, Set<number>> = new Map();

  /** Feed IDs whose instance topology has been fully fetched. */
  private topologyLoaded: Set<number> = new Set();
  /** What each feed's data is, once read: about the data, not the graph, so a re-walk keeps it. */
  private dataFacts: Map<number, ProcFeedDataFacts> = new Map();

  /** In-flight topology fetch promises — prevents duplicate API calls. */
  private loading: Map<number, Promise<void>> = new Map();

  /** True when background warm-up has finished all feeds. */
  private _warmupComplete: boolean = false;

  private _warmupProgress: ProcWarmupProgress = { loaded: 0, total: 0, active: false };

  /** Per-feed topology loads in flight, keyed by feed id. */
  private feedLoads: Map<number, ProcFeedLoadProgress> = new Map();
  private feedLoadFailedAt: Map<number, number> = new Map();
  private rosterSync: ProcRosterSyncKind | null = null;

  /** Feeds the roster gained (created or shared) with the moment they landed. */
  private arrivals: Map<number, number> = new Map();
  /**
   * Feeds another identity owns that arrived (a share, or a feed made
   * public) and that the operator has not looked at since: NEW since the
   * last visit. Saved with the roster, so a share found while nobody was
   * looking is still news at the next login. Not touched by `cache_clear`:
   * it is the operator's memory, not the index's.
   */
  private unseen: Set<number> = new Set();

  /**
   * Feeds the index read something of lately, by when it last did: a feed
   * lands when its first instance is seen and lands again as more are, so
   * a surface drawing the space sees each feed appear and fill out while
   * the global sweep pages through everything.
   */
  private landed: Map<number, number> = new Map();

  /**
   * Folder listings whose membership changes when a feed arrives or
   * departs, addressed by how the identity can see the feed. Empty until
   * a host declares them, so a cache used outside a session never guesses
   * at paths.
   */
  private rosterFolders: RosterFolders = {};

  /** Whether initial feed index has been built. */
  private _built: boolean = false;

  private lifecycle: ProcCacheLifecycle = { state: 'empty' };
  private listeners: Set<ProcCacheListener> = new Set();

  private constructor() {}

  static instance_get(): ProcCache {
    if (!ProcCache._instance) {
      const made: ProcCache = new ProcCache();
      ProcCache._instance = made;
      // The tree is one identity's feeds and jobs: at a change of identity all of it goes.
      identityChange_listen((): void => { made.cache_clear(); });
    }
    return ProcCache._instance;
  }

  get built(): boolean { return this._built; }
  get warmupComplete(): boolean { return this._warmupComplete; }

  /**
   * Returns a copy of the current cache lifecycle metadata.
   *
   * @returns Current cache state and checkpoint timestamp.
   */
  lifecycle_get(): ProcCacheLifecycle { return { ...this.lifecycle }; }

  /**
   * Changes the cache freshness state.
   *
   * @param state - New lifecycle state.
   * @returns Nothing.
   */
  lifecycle_set(state: ProcCacheState): void {
    this.lifecycle = { ...this.lifecycle, state };
    this.change_emit({ scope: 'lifecycle' });
  }

  /**
   * Registers a callback for checkpoint-worthy cache mutations.
   *
   * @param listener - Callback invoked after a cache mutation with what it touched.
   * @returns Function that unregisters the callback.
   */
  changeListener_add(listener: ProcCacheListener): () => void {
    this.listeners.add(listener);
    return (): void => { this.listeners.delete(listener); };
  }

  private change_emit(change: ProcCacheChange): void {
    for (const listener of this.listeners) listener(change);
  }

  // ── Feed ──────────────────────────────────────────────────────────────────

  /**
   * Adds or updates a feed entry.
   */
  feed_add(feed: ProcFeed): void {
    // What is learnt of the tree as another user, or by work begun under an identity since replaced, is not kept.
    if (!identityCache_usable()) return;
    this.feeds.set(feed.id, feed);
    if (!this.feedRoots.has(feed.id)) {
      this.feedRoots.set(feed.id, []);
    }
    this.change_emit({ scope: 'roster' });
  }

  feed_get(feedID: number): ProcFeed | undefined {
    return this.feeds.get(feedID);
  }

  feedIDs_get(): number[] {
    return Array.from(this.feeds.keys());
  }

  /**
   * Counts visible feeds in exclusive ownership, sharing, and public buckets.
   *
   * Ownership takes precedence over public visibility so the buckets sum to
   * the unique feed total.
   *
   * @param username - Authenticated username whose owned feeds form `user`.
   * @returns Exclusive scope counts whose components sum to `total`.
   */
  feedScopeCounts_get(username: string): ProcFeedScopeCounts {
    const counts: ProcFeedScopeCounts = { user: 0, public: 0, shared: 0, total: this.feeds.size };
    for (const feed of this.feeds.values()) {
      if (feed.ownerUsername === username) counts.user++;
      else if (feed.public) counts.public++;
      else counts.shared++;
    }
    return counts;
  }

  feedRoots_get(feedID: number): number[] {
    return this.feedRoots.get(feedID) ?? [];
  }

  /**
   * Drops a feed's topology — its instances, roots and the loaded mark —
   * and keeps its roster row, so a re-walk starts from nothing the cache
   * remembers about the graph while the feed stays where the roster put it.
   *
   * @param feedID - The feed whose topology is dropped.
   */
  feedTopology_evict(feedID: number): void {
    this.topologyLoaded.delete(feedID);
    for (const inst of Array.from(this.instances.values())) {
      if (inst.feedID === feedID) this.instance_remove(inst.id);
    }
    this.feedRoots.delete(feedID);
    this.change_emit({ scope: 'feed', feedID });
  }

  /**
   * Removes a feed and all its instances from the cache.
   */
  feed_remove(feedID: number): void {
    this.feeds.delete(feedID);
    this.topologyLoaded.delete(feedID);
    this.dataFacts.delete(feedID);
    const allInstances: ProcInstance[] = Array.from(this.instances.values())
      .filter((i: ProcInstance) => i.feedID === feedID);
    for (const inst of allInstances) {
      this.instance_remove(inst.id);
    }
    this.feedRoots.delete(feedID);
    this.change_emit({ scope: 'feed', feedID });
    this.change_emit({ scope: 'roster' });
  }

  /**
   * Replaces the visible feed set while preserving topology for retained feeds.
   *
   * @param feeds - Authoritative feeds visible to the current identity.
   * @returns IDs requiring topology reconciliation because they are new, their
   *   aggregate job counts changed, or they still have active work.
   */
  feeds_reconcile(feeds: ProcFeed[]): number[] {
    // What is learnt of the tree as another user, or by work begun under an identity since replaced, is not kept.
    if (!identityCache_usable()) return [];
    const reconciliationTargets: number[] = [];
    const visible: Set<number> = new Set(feeds.map((feed: ProcFeed): number => feed.id));
    const departed: number[] = [];
    for (const feedID of this.feedIDs_get()) {
      if (!visible.has(feedID)) departed.push(feedID);
    }
    // Placing a feed needs its row, so resolve the folders before the rows
    // are dropped.
    const departedFolders: string[] = this.rosterFolders_list(departed);
    for (const feedID of departed) this.feed_remove(feedID);
    if (departed.length > 0) {
      // A feed that vanished leaves a row behind in its parent listing,
      // and its own cached listings describe a tree this identity can no
      // longer reach. The parent is merely behind; the tree is gone.
      listingsForRoster_note([], departedFolders);
      listingsForFeeds_drop(departed);
    }
    for (const feed of feeds) {
      const previous: ProcFeed | undefined = this.feed_get(feed.id);
      if (!previous || feedTopology_changed(previous, feed) || feed_isActive(feed)) {
        reconciliationTargets.push(feed.id);
      }
      this.feed_add(feed);
    }
    return reconciliationTargets;
  }

  // ── Instance ──────────────────────────────────────────────────────────────

  /**
   * Adds a plugin instance to the topology cache.
   */
  instance_add(inst: ProcInstance): void {
    // What is learnt of the tree as another user, or by work begun under an identity since replaced, is not kept.
    if (!identityCache_usable()) return;
    this.landed.set(inst.feedID, Date.now());
    this.instances.set(inst.id, inst);
    let roll: Set<number> | undefined = this.byFeed.get(inst.feedID);
    if (roll === undefined) {
      roll = new Set();
      this.byFeed.set(inst.feedID, roll);
    }
    roll.add(inst.id);
    if (inst.parentID === null) {
      const roots: number[] = this.feedRoots.get(inst.feedID) ?? [];
      if (!roots.includes(inst.id)) {
        roots.push(inst.id);
        this.feedRoots.set(inst.feedID, roots);
      }
    } else {
      const kids: number[] = this.children.get(inst.parentID) ?? [];
      if (!kids.includes(inst.id)) {
        kids.push(inst.id);
        this.children.set(inst.parentID, kids);
      }
    }
    this.change_emit({ scope: 'feed', feedID: inst.feedID });
  }

  /**
   * Merges observed execution metrics onto an instance. Only defined values
   * land, so a refresh that carries no timing never erases what warmup saw.
   */
  instanceMetrics_set(
    id: number,
    metrics: { startedAt?: string; finishedAt?: string; outputBytes?: number; computeResource?: string; pipelineName?: string | null; workflowID?: number | null },
  ): void {
    const inst: ProcInstance | undefined = this.instances.get(id);
    if (!inst) return;
    let changed: boolean = false;
    if (metrics.startedAt !== undefined && inst.startedAt !== metrics.startedAt) { inst.startedAt = metrics.startedAt; changed = true; }
    if (metrics.finishedAt !== undefined && inst.finishedAt !== metrics.finishedAt) { inst.finishedAt = metrics.finishedAt; changed = true; }
    if (metrics.outputBytes !== undefined && inst.outputBytes !== metrics.outputBytes) { inst.outputBytes = metrics.outputBytes; changed = true; }
    if (metrics.computeResource !== undefined && inst.computeResource !== metrics.computeResource) { inst.computeResource = metrics.computeResource; changed = true; }
    if (metrics.pipelineName !== undefined && inst.pipelineName !== metrics.pipelineName) { inst.pipelineName = metrics.pipelineName; changed = true; }
    if (metrics.workflowID !== undefined && inst.workflowID !== metrics.workflowID) { inst.workflowID = metrics.workflowID; changed = true; }
    if (changed) this.change_emit({ scope: 'feed', feedID: inst.feedID });
  }

  instance_get(id: number): ProcInstance | undefined {
    return this.instances.get(id);
  }

  instances_count(): number {
    return this.instances.size;
  }

  instancesForFeed_count(feedID: number): number {
    return this.byFeed.get(feedID)?.size ?? 0;
  }

  /**
   * Every instance the cache holds for a feed, whether or not its parent
   * has arrived: the roll, in id order.
   *
   * @param feedID - The feed.
   * @returns The instance ids, ascending.
   */
  feedInstanceIDs_all(feedID: number): number[] {
    return [...(this.byFeed.get(feedID) ?? [])].sort((a: number, b: number): number => a - b);
  }

  children_get(parentID: number): number[] {
    return this.children.get(parentID) ?? [];
  }

  /**
   * Returns every instance ID belonging to a feed, walking the anchor tree from its
   * roots (breadth-first). Order is roots-first, then descendants.
   *
   * @param feedID - Feed to enumerate.
   * @returns All instance IDs in the feed's anchor tree.
   */
  feedInstanceIDs_get(feedID: number): number[] {
    const result: number[] = [];
    const queue: number[] = [...this.feedRoots_get(feedID)];
    while (queue.length > 0) {
      const id: number = queue.shift()!;
      result.push(id);
      queue.push(...this.children_get(id));
    }
    return result;
  }

  /**
   * Removes an instance from the topology cache.
   */
  instance_remove(id: number): void {
    const inst: ProcInstance | undefined = this.instances.get(id);
    if (!inst) return;
    this.instances.delete(id);
    this.byFeed.get(inst.feedID)?.delete(id);
    if (inst.parentID === null) {
      const roots: number[] = this.feedRoots.get(inst.feedID) ?? [];
      this.feedRoots.set(inst.feedID, roots.filter((r: number) => r !== id));
    } else {
      const kids: number[] = this.children.get(inst.parentID) ?? [];
      this.children.set(inst.parentID, kids.filter((k: number) => k !== id));
    }
    this.change_emit({ scope: 'feed', feedID: inst.feedID });
  }

  /**
   * Removes instances absent from an authoritative topology sweep.
   *
   * @param instanceIDs - Instance IDs returned by the completed CUBE sweep.
   * @returns Nothing.
   */
  topology_reconcile(instanceIDs: Set<number>): void {
    for (const id of Array.from(this.instances.keys())) {
      if (!instanceIDs.has(id)) this.instance_remove(id);
    }
    for (const feedID of this.feedIDs_get()) this.topologyLoaded.add(feedID);
    this.change_emit({ scope: 'all' });
  }

  /**
   * Updates cached params for an instance (on first cat).
   */
  params_update(id: number, params: Record<string, unknown>): void {
    // What is learnt of the tree as another user, or by work begun under an identity since replaced, is not kept.
    if (!identityCache_usable()) return;
    const inst: ProcInstance | undefined = this.instances.get(id);
    if (inst) inst.params = params;
  }

  /**
   * Stores the lazily resolved CUBE output path for one instance.
   *
   * @param id - Plugin-instance ID whose output location was resolved.
   * @param outputPath - Absolute CFS output directory, or null when absent.
   * @returns Nothing.
   */
  outputPath_update(id: number, outputPath: string | null): void {
    // What is learnt of the tree as another user, or by work begun under an identity since replaced, is not kept.
    if (!identityCache_usable()) return;
    const inst: ProcInstance | undefined = this.instances.get(id);
    if (inst) inst.outputPath = outputPath;
  }

  /**
   * Finds the closest cached job output containing a CFS path.
   *
   * An output path is a directory boundary: `/home/alice/run` contains
   * `/home/alice/run/result.txt`, but not `/home/alice/run-old`.
   *
   * @param cfsPath - Absolute CFS path to resolve against live-session outputs.
   * @returns The closest producing instance, or undefined when no output path
   *   known in this session contains the path.
   */
  outputPath_match(cfsPath: string): ProcInstance | undefined {
    const cleanPath: string = cfsPath.length > 1 && cfsPath.endsWith('/')
      ? cfsPath.slice(0, -1)
      : cfsPath;
    let closest: ProcInstance | undefined;
    for (const inst of this.instances.values()) {
      const outputPath: string | null | undefined = inst.outputPath;
      if (!outputPath) continue;
      const isAncestor: boolean = outputPath === '/'
        ? cleanPath.startsWith('/')
        : cleanPath === outputPath || cleanPath.startsWith(`${outputPath}/`);
      if (isAncestor && (!closest || outputPath.length > (closest.outputPath?.length ?? 0))) {
        closest = inst;
      }
    }
    return closest;
  }

  /**
   * Updates the cached status for an instance. Terminal (settled) statuses are
   * never overwritten — once finished, a job's status is immutable.
   *
   * @param id - Instance ID.
   * @param status - Fresh status observed from the API.
   */
  status_update(id: number, status: string): void {
    // What is learnt of the tree as another user, or by work begun under an identity since replaced, is not kept.
    if (!identityCache_usable()) return;
    const inst: ProcInstance | undefined = this.instances.get(id);
    if (!inst) return;
    if (status_isTerminal(inst.status)) return;
    if (inst.status === status) return;
    inst.status = status;
    this.change_emit({ scope: 'feed', feedID: inst.feedID });
    // Crossing into a terminal state is the moment a job's output becomes
    // visible, and so the moment the feed's cached folder listings fell
    // behind. A merely-running job has produced nothing to list yet.
    if (status_isTerminal(status)) listingsForFeeds_note([inst.feedID]);
  }

  /**
   * Records the resolved topological-join parent IDs for a `ts` instance. Immutable
   * data — set once when the feed's join edges are first fetched.
   *
   * @param id - Instance ID of the join (ts) node.
   * @param ids - Source instance IDs it merges (beyond its anchor parent).
   */
  joinParents_update(id: number, ids: number[]): void {
    // What is learnt of the tree as another user, or by work begun under an identity since replaced, is not kept.
    if (!identityCache_usable()) return;
    const inst: ProcInstance | undefined = this.instances.get(id);
    if (inst) { inst.joinParentIDs = ids; this.change_emit({ scope: 'feed', feedID: inst.feedID }); }
  }

  /**
   * Returns the resolved join parent IDs for an instance, or an empty array when the
   * node has none or they have not been resolved yet.
   *
   * @param id - Instance ID.
   * @returns Source instance IDs, or `[]`.
   */
  joinParents_get(id: number): number[] {
    return this.instances.get(id)?.joinParentIDs ?? [];
  }

  // ── Topology loaded tracking ───────────────────────────────────────────────

  topologyLoaded_mark(feedID: number, at: number = Date.now()): void {
    // What is learnt of the tree as another user, or by work begun under an identity since replaced, is not kept.
    if (!identityCache_usable()) return;
    // Completing is a landing too — a feed with no instances lands only
    // here — but a feed marked again (a re-sweep) is not news, and a restore
    // from a checkpoint marks without landing at all.
    if (!this.topologyLoaded.has(feedID)) this.landed.set(feedID, at);
    this.topologyLoaded.add(feedID);
    this.change_emit({ scope: 'feed', feedID });
  }

  topologyLoaded_has(feedID: number): boolean {
    return this.topologyLoaded.has(feedID);
  }

  /**
   * Records what a feed's data is.
   *
   * @param feedID - The feed.
   * @param facts - What its first file said.
   */
  dataFacts_set(feedID: number, facts: ProcFeedDataFacts): void {
    // What is learnt of the tree as another user, or by work begun under an identity since replaced, is not kept.
    if (!identityCache_usable()) return;
    if (!this.feeds.has(feedID)) return;
    this.dataFacts.set(feedID, { ...facts });
    this.change_emit({ scope: 'feed', feedID });
  }

  /**
   * What a feed's data is, once read.
   *
   * @param feedID - The feed.
   * @returns Its facts, or undefined before they are read.
   */
  dataFacts_read(feedID: number): ProcFeedDataFacts | undefined {
    const facts: ProcFeedDataFacts | undefined = this.dataFacts.get(feedID);
    return facts === undefined ? undefined : { ...facts };
  }

  // ── In-flight map ─────────────────────────────────────────────────────────

  loading_set(feedID: number, promise: Promise<void>): void {
    // What is learnt of the tree as another user, or by work begun under an identity since replaced, is not kept.
    if (!identityCache_usable()) return;
    this.loading.set(feedID, promise);
  }

  loading_get(feedID: number): Promise<void> | undefined {
    return this.loading.get(feedID);
  }

  loading_clear(feedID: number): void {
    this.loading.delete(feedID);
  }

  // ── Warm-up state ─────────────────────────────────────────────────────────

  warmup_complete(): void {
    this._warmupComplete = true;
    this._warmupProgress = { ...this._warmupProgress, active: false };
    this.lifecycle = { ...this.lifecycle, state: 'current' };
    this.change_emit({ scope: 'lifecycle' });
  }

  /**
   * Stops an unsuccessful warm-up without marking its topology complete.
   *
   * @returns Nothing.
   */
  warmup_abort(): void {
    this._warmupComplete = false;
    this._warmupProgress = { ...this._warmupProgress, active: false };
    this.lifecycle = { ...this.lifecycle, state: 'failed' };
    this.change_emit({ scope: 'lifecycle' });
  }

  warmup_progress(loaded: number, total: number): void {
    this._warmupProgress = { loaded, total, active: true };
  }

  warmupProgress_get(): ProcWarmupProgress {
    return { ...this._warmupProgress };
  }

  // ── The roster's own movement ─────────────────────────────────────────────

  /**
   * Notes that the roster is being brought up to date: a delta (feeds newer
   * than the highest known id) or the ten-minute full walk. Index movement
   * no command announces; the prompt says it while it runs.
   *
   * @param kind - Which walk is in flight.
   */
  rosterSync_progress(kind: ProcRosterSyncKind): void {
    this.rosterSync = kind;
  }

  /** Ends the roster's annunciation. */
  rosterSync_clear(): void {
    this.rosterSync = null;
  }

  /**
   * The roster walk in flight, if any.
   *
   * @returns The kind, or null when the roster is not moving.
   */
  rosterSync_get(): ProcRosterSyncKind | null {
    return this.rosterSync;
  }

  // ── Per-feed load and roster arrivals ─────────────────────────────────────

  /**
   * Records progress of one feed's topology load.
   *
   * @param feedID - The feed being loaded.
   * @param loaded - Instances fetched so far.
   * @param total - The server's count, or zero while unknown.
   */
  feedLoad_progress(feedID: number, loaded: number, total: number): void {
    this.feedLoads.set(feedID, { feedID, loaded, total });
    this.feedLoadFailedAt.delete(feedID);
  }

  /**
   * Marks one feed's load as failed where it stopped. The entry stays
   * annunciated for a minute so the failure is seen, then is forgotten; the
   * next visit starts a fresh walk.
   *
   * @param feedID - The feed whose walk failed.
   * @param message - What the failure said.
   * @param at - When it failed (default now).
   */
  feedLoad_fail(feedID: number, message: string, at: number = Date.now()): void {
    const current: ProcFeedLoadProgress | undefined = this.feedLoads.get(feedID);
    this.feedLoads.set(feedID, { feedID, loaded: current?.loaded ?? 0, total: current?.total ?? 0, failed: message });
    this.feedLoadFailedAt.set(feedID, at);
  }

  /**
   * Ends one feed's load annunciation.
   *
   * @param feedID - The feed whose load finished or failed.
   */
  feedLoad_clear(feedID: number): void {
    this.feedLoads.delete(feedID);
    this.feedLoadFailedAt.delete(feedID);
  }

  /**
   * Every feed load worth showing, earliest first: the walks in flight and
   * the failures still remembered. Two feeds can walk at once (an operator
   * and a pane, or two panes), and each is index movement of its own.
   *
   * @param now - The clock (default now), against which failures expire.
   * @returns The loads, earliest first; empty when nothing moves.
   */
  feedLoads_all(now: number = Date.now()): ProcFeedLoadProgress[] {
    this.feedLoadFailures_expire(now);
    return Array.from(this.feedLoads.values(), (entry: ProcFeedLoadProgress): ProcFeedLoadProgress => ({ ...entry }));
  }

  /**
   * One feed's load annunciation, by feed.
   *
   * @param feedID - The feed in question.
   * @param now - The clock (default now), against which a failure expires.
   * @returns The load in flight or lately failed, or null.
   */
  feedLoad_read(feedID: number, now: number = Date.now()): ProcFeedLoadProgress | null {
    this.feedLoadFailures_expire(now);
    const entry: ProcFeedLoadProgress | undefined = this.feedLoads.get(feedID);
    return entry === undefined ? null : { ...entry };
  }

  private feedLoadFailures_expire(now: number): void {
    for (const [feedID, at] of this.feedLoadFailedAt) {
      if (now - at > PROC_FEED_LOAD_FAILURE_TTL_MS) this.feedLoad_clear(feedID);
    }
  }

  /**
   * The feed load currently worth showing: the earliest still in flight.
   *
   * @returns The load in progress, or null when none is.
   */
  feedLoad_get(now: number = Date.now()): ProcFeedLoadProgress | null {
    this.feedLoadFailures_expire(now);
    const first: ProcFeedLoadProgress | undefined = this.feedLoads.values().next().value;
    return first === undefined ? null : { ...first };
  }

  /**
   * Notes feeds the roster just gained, so surfaces can annunciate them.
   *
   * @param feedIDs - The arriving feed ids.
   * @param at - When they landed (default now).
   */
  /**
   * Marks feeds as NEW since the last visit.
   *
   * @param feedIDs - The feeds to mark.
   */
  unseen_add(feedIDs: number[]): void {
    const before: number = this.unseen.size;
    for (const feedID of feedIDs) if (this.feeds.has(feedID)) this.unseen.add(feedID);
    if (this.unseen.size !== before) this.change_emit({ scope: 'roster' });
  }

  /**
   * Takes the NEW mark off feeds the operator has looked at.
   *
   * @param feedIDs - The feeds seen, or `all`.
   * @returns How many marks were taken off.
   */
  unseen_clear(feedIDs: number[] | 'all'): number {
    const before: number = this.unseen.size;
    if (feedIDs === 'all') this.unseen.clear();
    else for (const feedID of feedIDs) this.unseen.delete(feedID);
    const cleared: number = before - this.unseen.size;
    if (cleared > 0) this.change_emit({ scope: 'roster' });
    return cleared;
  }

  /**
   * The feeds marked NEW that the roster still holds.
   *
   * @returns Their ids.
   */
  unseen_get(): number[] {
    return Array.from(this.unseen).filter((feedID: number): boolean => this.feeds.has(feedID));
  }

  arrivals_note(feedIDs: number[], at: number = Date.now()): void {
    for (const feedID of feedIDs) this.arrivals.set(feedID, at);
    // An arrival changes the folder the feed appears in, not anything
    // inside it. A public feed landing on a busy CUBE must not dirty this
    // identity's own feeds folder, which did not change.
    listingsForRoster_note(feedIDs, this.rosterFolders_list(feedIDs));
  }

  /**
   * Declares which folder each kind of feed appears in, so an arrival
   * dirties the one listing whose membership actually changed.
   *
   * A host may declare only what it knows. An unnamed folder is simply
   * never marked, rather than every folder being marked because the
   * roster could not tell them apart.
   *
   * @param folders - Folders by how this identity sees a feed.
   */
  rosterFolders_set(folders: RosterFolders): void {
    // What is learnt of the tree as another user, or by work begun under an identity since replaced, is not kept.
    if (!identityCache_usable()) return;
    this.rosterFolders = { ...folders };
  }

  /**
   * The folder a feed appears in for this identity.
   *
   * @param feedID - The feed to place.
   * @returns Its folder, or null when the feed is unknown or its folder
   *   was never declared.
   */
  private rosterFolder_find(feedID: number): string | null {
    const feed: ProcFeed | undefined = this.feeds.get(feedID);
    if (!feed) return null;
    if (feed.public) return this.rosterFolders.public ?? null;
    if (this.rosterFolders.owner !== undefined && feed.ownerUsername === this.rosterFolders.owner) {
      return this.rosterFolders.own ?? null;
    }
    return this.rosterFolders.shared ?? null;
  }

  /**
   * The distinct folders whose membership the given feeds changed.
   *
   * @param feedIDs - Feeds that arrived or departed.
   * @returns Folder paths, without repeats.
   */
  private rosterFolders_list(feedIDs: readonly number[]): string[] {
    const folders: Set<string> = new Set();
    for (const feedID of feedIDs) {
      const folder: string | null = this.rosterFolder_find(feedID);
      if (folder !== null) folders.add(folder);
    }
    return Array.from(folders);
  }

  /**
   * Arrivals still within their annunciation window, oldest first; expired
   * ones are forgotten on the way.
   *
   * @param now - The current time (default now).
   * @returns Feed ids that arrived within {@link PROC_ARRIVAL_TTL_MS}.
   */
  /**
   * The feeds the index read something of in the last while, each as it
   * stands now: its size so far, its status, and the shape of its pipeline
   * so far.
   *
   * @param now - The clock, for the window.
   * @returns The landed feeds, earliest landing first.
   */
  topologyLanded_recent(now: number = Date.now()): ProcLandedFeed[] {
    const recent: Array<{ feedID: number; at: number }> = [];
    for (const [feedID, at] of this.landed) {
      if (now - at > PROC_LANDED_TTL_MS) this.landed.delete(feedID);
      else recent.push({ feedID, at });
    }
    recent.sort((a, b): number => a.at - b.at);
    const landed: ProcLandedFeed[] = [];
    for (const { feedID } of recent) {
      const feed: ProcFeed | undefined = this.feed_get(feedID);
      if (feed === undefined) continue;
      landed.push({ id: feedID, title: feed.title, jobs: this.instancesForFeed_count(feedID), status: feedStatus_deriveFromCounts(feed), chain: this.pluginChain_derive(feedID), groups: this.pluginGroups_build(feedID) });
    }
    return landed;
  }

  /**
   * A feed's plugin names by first appearance, root first — the shape its
   * pipeline left. A feed that ran dircopy, then dcm2niix, then fastsurfer
   * shares its first two names with every feed that began the same way.
   *
   * Read from the feed's roll, not its root walk: while a sweep is still
   * bringing a feed in, an instance whose parent has not arrived counts as
   * depth zero, and the chain settles as the parents land.
   *
   * @param feedID - The feed.
   * @returns The names, in order of the shallowest instance that bore each.
   */
  pluginChain_derive(feedID: number): string[] {
    const ids: number[] = this.feedInstanceIDs_all(feedID);
    const depth_compute = (id: number, seen: Set<number> = new Set()): number => {
      const inst: ProcInstance | undefined = this.instance_get(id);
      if (inst === undefined || inst.parentID === null || seen.has(id)) return 0;
      seen.add(id);
      return 1 + depth_compute(inst.parentID, seen);
    };
    const firstDepth: Map<string, number> = new Map();
    for (const id of ids) {
      const inst: ProcInstance | undefined = this.instance_get(id);
      if (inst === undefined) continue;
      const depth: number = depth_compute(id);
      const known: number | undefined = firstDepth.get(inst.pluginName);
      if (known === undefined || depth < known) firstDepth.set(inst.pluginName, depth);
    }
    return [...firstDepth.entries()].sort((a, b): number => a[1] - b[1] || a[0].localeCompare(b[0])).map(([name]): string => name);
  }

  /**
   * A feed's jobs collapsed by plugin per place in the pipeline: the shape
   * with counts for weight. Jobs of one plugin under one parent group are
   * one node; a fan of three hundred conversions is a node of 300.
   *
   * @param feedID - The feed.
   * @returns The groups, parents before children, root first.
   */
  pluginGroups_build(feedID: number): ProcJobGroup[] {
    // The roll, not the root walk: an instance whose parent has not landed
    // yet is grouped as a root of its own until it has, so a feed takes a
    // shape from its first instance rather than from its last.
    const ids: number[] = this.feedInstanceIDs_all(feedID);
    const byId: Map<number, ProcInstance> = new Map();
    for (const id of ids) {
      const inst: ProcInstance | undefined = this.instance_get(id);
      if (inst !== undefined) byId.set(id, inst);
    }
    const groups: ProcJobGroup[] = [];
    const groupIndexByKey: Map<string, number> = new Map();
    const groupOfInstance: Map<number, number> = new Map();
    const worst = (a: string, b: string): string => {
      const rank = (word: string): number => (word === 'finishedWithError' ? 3 : (word === 'started' || word === 'scheduled' || word === 'created' || word === 'waiting' || word === 'registeringFiles') ? 2 : word === 'cancelled' ? 1 : 0);
      return rank(a) >= rank(b) ? a : b;
    };
    const status_derive = (inst: ProcInstance): string => {
      const word: string = inst.status ?? 'unknown';
      return word === 'finishedWithError' || word === 'finishedSuccessfully' || word === 'cancelled' ? word : (word === 'unknown' ? 'finishedSuccessfully' : word);
    };
    // Parents before children: a child's group needs its parent's index.
    const place = (id: number, seen: Set<number>): number | null => {
      const known: number | undefined = groupOfInstance.get(id);
      if (known !== undefined) return known;
      const inst: ProcInstance | undefined = byId.get(id);
      if (inst === undefined || seen.has(id)) return null;
      seen.add(id);
      const parentGroup: number | null = inst.parentID === null ? null : place(inst.parentID, seen);
      const key: string = `${parentGroup ?? 'root'}|${inst.pluginName}`;
      let index: number | undefined = groupIndexByKey.get(key);
      if (index === undefined) {
        index = groups.length;
        groups.push({ plugin: inst.pluginName, count: 0, errored: 0, status: status_derive(inst), parent: parentGroup });
        groupIndexByKey.set(key, index);
      }
      const group: ProcJobGroup = groups[index] as ProcJobGroup;
      group.count += 1;
      if (status_derive(inst) === 'finishedWithError') group.errored += 1;
      group.status = worst(group.status, status_derive(inst));
      groupOfInstance.set(id, index);
      return index;
    };
    for (const id of [...byId.keys()].sort((a, b): number => a - b)) place(id, new Set());
    return groups;
  }

  arrivals_recent(now: number = Date.now()): number[] {
    const recent: number[] = [];
    for (const [feedID, at] of this.arrivals) {
      if (now - at > PROC_ARRIVAL_TTL_MS) this.arrivals.delete(feedID);
      else recent.push(feedID);
    }
    return recent;
  }

  /**
   * Resets reconciliation progress while retaining restored topology.
   *
   * @returns Nothing.
   */
  warmup_reset(): void {
    this._warmupComplete = false;
    this._warmupProgress = { loaded: this.instances.size, total: this.instances.size, active: false };
    this.lifecycle = this.lifecycle.checkpointAt
      ? { ...this.lifecycle, state: 'restored' }
      : { state: 'empty' };
    this.change_emit({ scope: 'lifecycle' });
  }

  // ── Path reconstruction ───────────────────────────────────────────────────

  /**
   * Reconstructs the full /proc/jobs path for a given instance ID.
   *
   * @param id - Instance ID.
   * @returns Full path string, or null if instance not in cache.
   *
   * @example
   * ```typescript
   * cache.path_build(64306)
   * // '/proc/jobs/feed_1107/pl-dircopy_64267/.../pl-neurofiles-push_64306'
   * ```
   */
  path_build(id: number): string | null {
    const inst: ProcInstance | undefined = this.instances.get(id);
    if (!inst) return null;
    const segments: string[] = [];
    let current: ProcInstance | undefined = inst;
    while (current) {
      segments.unshift(`${current.pluginName}_${current.id}`);
      if (current.parentID === null) break;
      current = this.instances.get(current.parentID);
    }
    return `/proc/jobs/feed_${inst.feedID}/${segments.join('/')}`;
  }

  /**
   * Searches cached feeds by title or by name: a term is matched
   * case-insensitively against the title and against the feed's `feed_N`
   * name, so a bare id (`4389`), a name (`feed_4389`) and a title word all
   * find their feed.
   *
   * @param term - The search term; empty matches every feed.
   * @returns The matching feeds, in cache order.
   */
  feeds_find(term: string): ProcFeed[] {
    const lower: string = term.toLowerCase();
    return Array.from(this.feeds.values())
      .filter((f: ProcFeed): boolean => f.title.toLowerCase().includes(lower) || `feed_${f.id}`.includes(lower));
  }

  /**
   * Searches cached instances by numeric ID or plugin name substring.
   */
  instances_find(term: string): ProcInstance[] {
    const numeric: number = parseInt(term, 10);
    const isID: boolean = !isNaN(numeric) && String(numeric) === term;
    if (isID) {
      const hit: ProcInstance | undefined = this.instances.get(numeric);
      return hit ? [hit] : [];
    }
    const lower: string = term.toLowerCase();
    return Array.from(this.instances.values())
      .filter((i: ProcInstance) => i.pluginName.toLowerCase().includes(lower));
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  built_set(): void {
    this._built = true;
  }

  /**
   * Creates a persistence-safe snapshot without parameters or active statuses.
   *
   * @returns Serializable feed and terminal-topology state.
   */
  snapshot_create(): ProcCacheSnapshot {
    const instances: ProcInstance[] = Array.from(this.instances.values()).map(procInstance_persistent);
    return {
      feeds: Array.from(this.feeds.values()).map((feed: ProcFeed): ProcFeed => ({ ...feed })),
      instances,
      topologyLoaded: Array.from(this.topologyLoaded),
      dataFacts: Object.fromEntries(Array.from(this.dataFacts).map(([id, facts]): [number, ProcFeedDataFacts] => [id, { ...facts }])),
    };
  }

  /**
   * Creates one feed's persistence-safe snapshot: its instances (terminal
   * status only, no params or output paths) and whether its topology is
   * complete. A per-feed checkpoint shard is exactly this.
   *
   * @param feedID - The feed to snapshot.
   * @returns The feed's shard content; empty when the feed holds no instances.
   */
  feedSnapshot_create(feedID: number): ProcFeedSnapshot {
    const instances: ProcInstance[] = [];
    for (const inst of this.instances.values()) {
      if (inst.feedID === feedID) instances.push(procInstance_persistent(inst));
    }
    const facts: ProcFeedDataFacts | undefined = this.dataFacts.get(feedID);
    return { feedID, loaded: this.topologyLoaded.has(feedID), instances, ...(facts === undefined ? {} : { dataFacts: { ...facts } }) };
  }

  /**
   * Feed IDs that hold any instances or a loaded mark — the feeds a full
   * checkpoint must shard.
   *
   * @returns Feed IDs with persistent topology state.
   */
  shardedFeedIDs_get(): number[] {
    const ids: Set<number> = new Set(this.topologyLoaded);
    for (const inst of this.instances.values()) ids.add(inst.feedID);
    for (const id of this.dataFacts.keys()) ids.add(id);
    return Array.from(ids);
  }

  /**
   * Replaces in-memory topology with a validated persistent snapshot.
   *
   * @param snapshot - Previously validated snapshot data.
   * @param checkpointAt - ISO timestamp when the checkpoint was written.
   * @returns Nothing.
   */
  snapshot_restore(snapshot: ProcCacheSnapshot, checkpointAt: string): void {
    this.cache_clear();
    for (const feed of snapshot.feeds) {
      this.feeds.set(feed.id, { ...feed });
      this.feedRoots.set(feed.id, []);
    }
    for (const inst of snapshot.instances) {
      const { outputPath: _outputPath, ...restored }: ProcInstance = inst;
      this.instance_add({ ...restored, params: null, status: status_isTerminal(inst.status) ? inst.status : null });
    }
    this.topologyLoaded = new Set(snapshot.topologyLoaded.filter((id: number): boolean => this.feeds.has(id)));
    for (const [id, facts] of Object.entries(snapshot.dataFacts ?? {})) {
      if (this.feeds.has(Number(id))) this.dataFacts.set(Number(id), { ...facts });
    }
    this.unseen = new Set((snapshot.unseen ?? []).filter((id: number): boolean => this.feeds.has(id)));
    this._warmupProgress = { loaded: this.instances.size, total: this.instances.size, active: false };
    this.lifecycle = { state: 'restored', checkpointAt };
    this.change_emit({ scope: 'lifecycle' });
  }

  /**
   * Records the timestamp of a successful durable save.
   *
   * @param checkpointAt - ISO timestamp written into the checkpoint.
   * @returns Nothing.
   */
  checkpoint_mark(checkpointAt: string): void {
    this.lifecycle = { ...this.lifecycle, checkpointAt };
  }

  /**
   * Clears all cache data. Called before a full rebuild.
   */
  cache_clear(): void {
    this.landed.clear();
    listingInvalidation_reset();
    this.feeds.clear();
    this.instances.clear();
    this.byFeed.clear();
    this.feedRoots.clear();
    this.children.clear();
    this.topologyLoaded.clear();
    this.dataFacts.clear();
    this.loading.clear();
    this.feedLoads.clear();
    this.arrivals.clear();
    this._warmupComplete = false;
    this._warmupProgress = { loaded: 0, total: 0, active: false };
    this._built = false;
    this.lifecycle = { state: 'empty' };
    this.change_emit({ scope: 'all' });
  }
}

/**
 * Returns the singleton ProcCache instance.
 *
 * @example
 * ```typescript
 * const cache = procCache_get();
 * cache.instance_add({ id: 789, feedID: 123, parentID: 456,
 *                      pluginName: 'pl-fshack', params: null, status: 'scheduled' });
 * ```
 */
export function procCache_get(): ProcCache {
  return ProcCache.instance_get();
}
