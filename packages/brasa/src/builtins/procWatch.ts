/**
 * @file Watches: keeping a running feed live while someone is looking.
 *
 * A watch is a refcounted subscription on one feed. While any owner (a
 * surface id, or the operator at a console) holds it, a sampler visits the
 * feed on an adaptive cadence — {@link WATCH_FLOOR_MS} while it changes,
 * doubling on quiet ticks to {@link WATCH_CAP_MS} — and, whenever the visit
 * changed the cache, publishes the feed's refreshed `feed.dag` model on the
 * ambient bus. When the feed settles (every node terminal, no work pending)
 * the sampler reports `settled` and stops: a settled feed cannot change, so
 * there is nothing left to keep live. A visit that fails reports `stale` and
 * keeps trying at the capped cadence.
 *
 * The kernel never polls on its own. The open pane is the subscription.
 *
 * @module
 */
import type { ProcCache, ProcCacheChange, ProcFeed } from '@fnndsc/cumin';
import { identityChange_listen, identityCache_usable, identityEpoch_get, identityScope_hold } from '@fnndsc/cumin/identity-epoch';
import type { WatchState, CommandEnvelope } from '@fnndsc/menu';
import { ambient_publish } from '../core/ambient.js';

// The cache, the visit, and the model builder are reached lazily: a host
// that never opens a watch never loads the DAG projection, and the engine's
// static import graph stays what it was.
type Cumin = typeof import('@fnndsc/cumin');
type SalsaVisit = typeof import('@fnndsc/salsa');
type DagBuilder = typeof import('./res/feed.diagram.js');

interface WatchDeps {
  cumin: Cumin;
  salsa: SalsaVisit;
  dag: DagBuilder;
}

let depsLoading: Promise<WatchDeps> | null = null;

/** Loads the sampler's collaborators once, on the first watch. */
function deps_get(): Promise<WatchDeps> {
  if (depsLoading === null) {
    depsLoading = Promise.all([
      import('@fnndsc/cumin'),
      import('@fnndsc/salsa'),
      import('./res/feed.diagram.js'),
    ]).then(([cumin, salsa, dag]: [Cumin, SalsaVisit, DagBuilder]): WatchDeps => ({ cumin, salsa, dag }));
  }
  return depsLoading;
}

/** Sampling period while a watched feed keeps changing. */
export const WATCH_FLOOR_MS: number = 3000;
/** Sampling period a quiet watched feed backs off to. */
export const WATCH_CAP_MS: number = 30000;

/**
 * One watch as the session reports it.
 *
 * @property feedID - The watched feed.
 * @property owners - How many owners hold the watch.
 * @property state - What the sampler last found.
 */
export interface ProcWatchEntry {
  feedID: number;
  owners: number;
  state: WatchState;
}

interface Watch {
  feedID: number;
  owners: Set<string>;
  state: WatchState;
  delayMs: number;
  timer: NodeJS.Timeout | null;
  ticking: boolean;
  first: boolean;
  /** The last build answered `feed.indexing`: the topology is on its way. */
  pending: boolean;
  /** The identity epoch the watch was asked for under: it is that identity's, whoever's work wakes it. */
  began: number;
}

const watches: Map<number, Watch> = new Map();

// Each watch's own place: every tick of it runs there, whoever's work armed or kicked it.
const places: WeakMap<Watch, <T>(work: () => T) => T> = new WeakMap<Watch, <T>(work: () => T) => T>();

// A pending watch is kicked by the cache itself: the walk that lands a
// feed's topology emits the feed's change event, and the watch answers it
// at once rather than on its next scheduled tick. One listener for all.
let kickListener_remove: (() => void) | null = null;

async function kickListener_ensure(): Promise<void> {
  if (kickListener_remove !== null) return;
  const { cumin }: WatchDeps = await deps_get();
  if (kickListener_remove !== null) return;
  kickListener_remove = cumin.procCache_get().changeListener_add((change: ProcCacheChange): void => {
    if (change.scope !== 'feed') return;
    const watch: Watch | undefined = watches.get(change.feedID);
    if (watch !== undefined && watch.pending && !watch.ticking) watch_arm(watch, 0);
  });
}

/**
 * Parses a watch subject into a feed id: `/proc/jobs/feed_N`, `feed_N`, or
 * a bare number.
 *
 * @param subject - The subject address as a surface or operator wrote it.
 * @returns The feed id, or null when the subject is not a feed.
 */
export function watchSubject_parse(subject: string): number | null {
  const match: RegExpMatchArray | null = /(?:^|\/)feed_(\d+)\/?$/.exec(subject.trim()) ?? /^(\d+)$/.exec(subject.trim());
  if (!match) return null;
  const feedID: number = Number(match[1]);
  return Number.isInteger(feedID) && feedID > 0 ? feedID : null;
}

/** The subject address a feed watch is reported under. */
function subject_format(feedID: number): string {
  return `/proc/jobs/feed_${feedID}`;
}

/** Records and publishes a watch's state when it changed. */
function state_set(watch: Watch, state: WatchState): void {
  if (watch.state === state) return;
  watch.state = state;
  ambient_publish({ kind: 'watched', subject: subject_format(watch.feedID), state });
}

/** Whether a feed can no longer change: every cached node terminal and no work pending. */
function feed_isSettled(cumin: Cumin, salsa: SalsaVisit, cache: ProcCache, feedID: number): boolean {
  const feed: ProcFeed | undefined = cache.feed_get(feedID);
  return feed !== undefined && salsa.feedCached_isSettled(cache, feedID) && !cumin.feed_isActive(feed);
}

/**
 * Builds and publishes the feed's current model. The build itself runs the
 * visit delta (coalesced with any visit of the last second), so a first
 * tick on a never-visited feed loads it here.
 *
 * @param watch - The watch being sampled.
 * @returns True when a model went out.
 */
async function model_publish(dag: DagBuilder, watch: Watch): Promise<boolean> {
  const envelope: CommandEnvelope = await dag.feedDag_handle(watch.feedID, undefined, 0, false);
  if (envelope.status !== 'ok') return false;
  // A cold feed answers `feed.indexing`: nothing to publish yet. The watch
  // holds the floor and is kicked when the topology lands.
  if (envelope.model?.kind === 'feed.indexing') {
    watch.pending = true;
    return false;
  }
  watch.pending = false;
  // Someone else connected while the graph was being built: it is the one before's, and is not sent.
  if (identityEpoch_get() !== watch.began) return false;
  ambient_publish({ kind: 'envelope', envelope });
  return true;
}

/**
 * One sampler tick: visit the feed, publish a model when the visit changed
 * anything, then either settle, back off, or re-arm at the floor.
 *
 * @param watch - The watch being sampled.
 */
async function watch_tick(watch: Watch): Promise<void> {
  if (watch.ticking) return;
  watch.ticking = true;
  const { cumin, salsa, dag }: WatchDeps = await deps_get();
  const cache: ProcCache = cumin.procCache_get();
  try {
    // A kicked pending watch builds regardless: the change it answers
    // happened before this tick's own listener was on.
    let changed: boolean = watch.first || watch.pending;
    const listener_remove: () => void = cache.changeListener_add((change: ProcCacheChange): void => {
      if (change.scope === 'all' || (change.scope === 'feed' && change.feedID === watch.feedID)) changed = true;
    });
    let synced: boolean;
    try {
      synced = watch.first ? true : await salsa.feedVisit_sync(watch.feedID);
      if (changed) {
        const published: boolean = await model_publish(dag, watch);
        synced = synced && published;
      }
    } finally {
      listener_remove();
    }
    watch.first = false;
    // A watch is one identity's: begun as whoever was connected when it was asked for. Once someone else
    // has connected it says nothing more, arms nothing more, and gives up its place (which the next
    // identity's watch of a feed of the same number may already have taken).
    if (identityEpoch_get() !== watch.began) {
      watch_stop(watch);
      return;
    }
    if (watches.get(watch.feedID) !== watch) return;

    if (watch.pending) {
      // Indexing: not stale, not settled (an empty topology looks settled
      // to the cache), and never backed off, so a landed walk is answered
      // within one floor even without the kick.
      state_set(watch, 'live');
      watch.delayMs = WATCH_FLOOR_MS;
    } else if (!synced) {
      state_set(watch, 'stale');
      watch.delayMs = WATCH_CAP_MS;
    } else if (feed_isSettled(cumin, salsa, cache, watch.feedID)) {
      state_set(watch, 'settled');
      watch_stop(watch);
      return;
    } else {
      state_set(watch, 'live');
      watch.delayMs = changed ? WATCH_FLOOR_MS : Math.min(WATCH_CAP_MS, watch.delayMs * 2);
    }
    watch_arm(watch, watch.delayMs);
  } finally {
    watch.ticking = false;
  }
}

/**
 * Runs one tick of a watch in the watch's own place.
 *
 * @param watch - The watch.
 * @returns When the tick is done.
 */
function place_run(watch: Watch): Promise<void> {
  const held_run: (<T>(work: () => T) => T) | undefined = places.get(watch);
  return held_run === undefined ? watch_tick(watch) : held_run((): Promise<void> => watch_tick(watch));
}

/** Schedules the next tick. */
function watch_arm(watch: Watch, delayMs: number): void {
  if (watch.timer) clearTimeout(watch.timer);
  watch.timer = setTimeout((): void => {
    watch.timer = null;
    // In the watch's own place, not that of whoever armed it (a change in the cache made by other work).
    void place_run(watch);
  }, delayMs);
  watch.timer.unref();
}

/** Ends a watch entirely: no timer, no entry. */
function watch_stop(watch: Watch): void {
  if (watch.timer) clearTimeout(watch.timer);
  watch.timer = null;
  // Its own place only: a watch that has been replaced does not remove its replacement.
  if (watches.get(watch.feedID) === watch) watches.delete(watch.feedID);
}

// At a change of identity every watch is retired: what it watched was the one before's feed, whatever its
// number. A surface that still wants a feed watched asks again, and is given a watch begun as who is
// connected now.
identityChange_listen((): void => {
  for (const watch of Array.from(watches.values())) watch_stop(watch);
});

/**
 * Opens (or joins) a watch on a feed for one owner. A new watch samples
 * immediately; joining an existing one changes nothing but the owner set.
 * A watch on a feed that turns out settled runs one tick, reports
 * `settled`, and ends.
 *
 * @param feedID - The feed to keep live.
 * @param owner - Who holds the watch.
 * @returns The watch's current state.
 */
export function procWatch_add(feedID: number, owner: string): WatchState | null {
  // A watch outlives the command that asked for it and says what it sees to every surface: it is the
  // session's own. It is not made, or joined, for work done as another user, nor for work begun as someone
  // who is no longer connected (a launch answered after a change of identity: the feed of that number now
  // is another's).
  if (!identityCache_usable()) return null;
  const existing: Watch | undefined = watches.get(feedID);
  if (existing) {
    existing.owners.add(owner);
    return existing.state;
  }
  const watch: Watch = {
    feedID,
    owners: new Set([owner]),
    state: 'live',
    delayMs: WATCH_FLOOR_MS,
    timer: null,
    ticking: false,
    first: true,
    pending: false,
    began: identityEpoch_get(),
  };
  watches.set(feedID, watch);
  places.set(watch, identityScope_hold());
  void kickListener_ensure();
  // Begun in a place of its own, under whoever is connected now: its ticks are there for as long as the
  // watch lives.
  void place_run(watch);
  return watch.state;
}

/**
 * Releases one owner's hold on a feed watch; the last release stops the
 * sampler.
 *
 * @param feedID - The watched feed.
 * @param owner - The owner letting go.
 */
export function procWatch_remove(feedID: number, owner: string): void {
  const watch: Watch | undefined = watches.get(feedID);
  if (!watch) return;
  watch.owners.delete(owner);
  if (watch.owners.size === 0) watch_stop(watch);
}

/**
 * Releases every watch one owner holds.
 *
 * @param owner - The owner letting go of everything.
 */
export function procWatch_release(owner: string): void {
  for (const watch of Array.from(watches.values())) procWatch_remove(watch.feedID, owner);
}

/**
 * Reports a feed's watch state: the sampler's last finding while watched,
 * or `settled` once nothing watches it (a released or settled watch has
 * nothing live to say).
 *
 * @param feedID - The feed in question.
 * @returns The state.
 */
export function procWatch_state(feedID: number): WatchState {
  return watches.get(feedID)?.state ?? 'settled';
}

/**
 * Lists the session's watches.
 *
 * @returns One entry per watched feed.
 */
export function procWatch_list(): ProcWatchEntry[] {
  return Array.from(watches.values()).map((watch: Watch): ProcWatchEntry => ({
    feedID: watch.feedID,
    owners: watch.owners.size,
    state: watch.state,
  }));
}

/**
 * Ends every watch (tests, and engine teardown).
 */
export function procWatch_reset(): void {
  for (const watch of Array.from(watches.values())) watch_stop(watch);
  if (kickListener_remove !== null) {
    kickListener_remove();
    kickListener_remove = null;
  }
}
