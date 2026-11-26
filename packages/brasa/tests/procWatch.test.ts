/**
 * @file Sampler tests for feed watches: refcounted ownership, adaptive
 * cadence, publish-on-change, settle-and-stop, stale-on-failure.
 *
 * Seams: salsa's visit (stub) and the feed.dag builder (stub); the real
 * ProcCache runs so change events drive the sampler as they would live.
 */
import { jest } from '@jest/globals';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A change of identity is made in this file: anything kept "in the default place" because of it goes to a
// folder of the file's own, never to the cache of whoever runs the tests.
process.env['XDG_CACHE_HOME'] = mkdtempSync(join(tmpdir(), 'procwatch-cache-'));
import { cuminMock_install } from './support/cuminMock.js';
import type { ProcFeed, ProcInstance, ProcCacheChange } from '@fnndsc/cumin';

const feedVisit_sync = jest.fn<(feedID: number) => Promise<boolean>>();
const feedDag_handle = jest.fn<(feedID: number) => Promise<{ status: string; rendered: string }>>();

const TERMINAL: ReadonlySet<string> = new Set(['finishedSuccessfully', 'finishedWithError', 'cancelled']);

/** A small stand-in for ProcCache: feeds, instances, and scoped change events. */
class FakeCache {
  feeds: Map<number, ProcFeed> = new Map();
  instances: Map<number, ProcInstance> = new Map();
  loaded: Set<number> = new Set();
  listeners: Set<(change: ProcCacheChange) => void> = new Set();
  emit(change: ProcCacheChange): void { for (const l of this.listeners) l(change); }
  cache_clear(): void { this.feeds.clear(); this.instances.clear(); this.loaded.clear(); }
  feed_add(feed: ProcFeed): void { this.feeds.set(feed.id, feed); this.emit({ scope: 'roster' }); }
  feed_get(id: number): ProcFeed | undefined { return this.feeds.get(id); }
  instance_add(inst: ProcInstance): void { this.instances.set(inst.id, inst); this.emit({ scope: 'feed', feedID: inst.feedID }); }
  instance_get(id: number): ProcInstance | undefined { return this.instances.get(id); }
  status_update(id: number, status: string): void {
    const inst: ProcInstance | undefined = this.instances.get(id);
    if (inst && inst.status !== status) { inst.status = status; this.emit({ scope: 'feed', feedID: inst.feedID }); }
  }
  feedInstanceIDs_get(feedID: number): number[] {
    return Array.from(this.instances.values()).filter((i: ProcInstance): boolean => i.feedID === feedID).map((i: ProcInstance): number => i.id);
  }
  topologyLoaded_mark(feedID: number): void { this.loaded.add(feedID); this.emit({ scope: 'feed', feedID }); }
  changeListener_add(l: (change: ProcCacheChange) => void): () => void { this.listeners.add(l); return (): void => { this.listeners.delete(l); }; }
}
const cache: FakeCache = new FakeCache();

cuminMock_install(() => ({
  procCache_get: (): FakeCache => cache,
  feed_isActive: (feed: ProcFeed): boolean => feed.startedJobs > 0 || feed.scheduledJobs > 0 || feed.createdJobs > 0,
}));
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  feedVisit_sync,
  feedCached_isSettled: (c: FakeCache, feedID: number): boolean =>
    c.feedInstanceIDs_get(feedID).every((id: number): boolean => TERMINAL.has(c.instance_get(id)?.status ?? '')),
}));
jest.unstable_mockModule('../src/builtins/res/feed.diagram.js', () => ({ feedDag_handle }));

const { procWatch_add, procWatch_remove, procWatch_release, procWatch_list, procWatch_reset, procWatch_state, watchSubject_parse, WATCH_FLOOR_MS, WATCH_CAP_MS } =
  await import('../src/builtins/procWatch.js');
const { ambient_listen } = await import('../src/core/ambient.js');

function feed(over: Partial<ProcFeed> = {}): ProcFeed {
  return {
    id: 7, title: 'f', ownerUsername: 'u', public: false, creationDate: '', finishedJobs: 0, erroredJobs: 0,
    startedJobs: 1, scheduledJobs: 0, cancelledJobs: 0, createdJobs: 0, ...over,
  };
}

function activeFeed_seed(): void {
  cache.feed_add(feed());
  cache.instance_add({ id: 70, feedID: 7, parentID: null, pluginName: 'pl-root', params: null, status: 'finishedSuccessfully' });
  cache.instance_add({ id: 71, feedID: 7, parentID: 70, pluginName: 'pl-ctl', params: null, status: 'started' });
  cache.topologyLoaded_mark(7);
}

/** Lets in-flight sampler work (lazy imports, awaited stubs) run to completion under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve: () => void): void => { setImmediate(resolve); });
}

let events: unknown[];
let unlisten: () => void;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  cache.cache_clear();
  procWatch_reset();
  feedVisit_sync.mockReset();
  feedDag_handle.mockReset();
  feedVisit_sync.mockResolvedValue(true);
  feedDag_handle.mockResolvedValue({ status: 'ok', rendered: 'dag' });
  events = [];
  unlisten = ambient_listen((event): void => { events.push(event); });
});

afterEach(async () => {
  unlisten();
  procWatch_reset();
  await flush();
  jest.useRealTimers();
});

describe('watchSubject_parse', () => {
  it('accepts the address, the name, and the bare id', () => {
    expect(watchSubject_parse('/proc/jobs/feed_12')).toBe(12);
    expect(watchSubject_parse('/proc/jobs/feed_12/')).toBe(12);
    expect(watchSubject_parse('feed_12')).toBe(12);
    expect(watchSubject_parse('12')).toBe(12);
    expect(watchSubject_parse('/vfs/home')).toBeNull();
    expect(watchSubject_parse('feed_0')).toBeNull();
  });
});

describe('a watch on a feed still being indexed', () => {
  it('holds the floor, never settles or backs off, and publishes the graph the moment the topology lands', async () => {
    // The roster knows the feed but its topology is not in the cache: an
    // empty topology would look settled to the cache, and must not.
    cache.feed_add(feed({ startedJobs: 0 }));
    feedDag_handle.mockResolvedValue({ status: 'ok', rendered: 'indexing', model: { kind: 'feed.indexing', data: { feedId: 7, loaded: 0, total: 3 } } });
    expect(procWatch_add(7, 'pane-a')).toBe('live');
    await flush();
    expect(events).toEqual([]); // nothing to publish yet
    expect(procWatch_list()).toEqual([{ feedID: 7, owners: 1, state: 'live' }]);

    // Quiet ticks while the walk runs: still live, still at the floor.
    jest.advanceTimersByTime(WATCH_FLOOR_MS);
    await flush();
    jest.advanceTimersByTime(WATCH_FLOOR_MS);
    await flush();
    expect(procWatch_list()).toEqual([{ feedID: 7, owners: 1, state: 'live' }]);
    expect(events).toEqual([]);

    // The walk lands: the cache emits the feed's change, the watch is kicked
    // (0 ms, no floor to wait out), and the graph goes out on the next build.
    feedDag_handle.mockResolvedValue({ status: 'ok', rendered: 'dag', model: { kind: 'feed.dag', data: {} } });
    cache.instance_add({ id: 70, feedID: 7, parentID: null, pluginName: 'pl-root', params: null, status: 'started' });
    cache.topologyLoaded_mark(7);
    jest.advanceTimersByTime(0);
    await flush();
    expect(events).toEqual([{ kind: 'envelope', envelope: { status: 'ok', rendered: 'dag', model: { kind: 'feed.dag', data: {} } } }]);
    expect(procWatch_list()).toEqual([{ feedID: 7, owners: 1, state: 'live' }]);
  });
});

describe('feed watches', () => {
  it('a new watch samples at once and publishes the model without a visit of its own', async () => {
    activeFeed_seed();
    expect(procWatch_add(7, 'pane-a')).toBe('live');
    await flush();
    expect(feedDag_handle).toHaveBeenCalledTimes(1);
    expect(feedVisit_sync).not.toHaveBeenCalled(); // the model build carries the first visit
    expect(events).toEqual([{ kind: 'envelope', envelope: { status: 'ok', rendered: 'dag' } }]);
    expect(procWatch_list()).toEqual([{ feedID: 7, owners: 1, state: 'live' }]);
  });

  it('a quiet tick publishes nothing and backs off; a changed tick publishes and returns to the floor', async () => {
    activeFeed_seed();
    procWatch_add(7, 'pane-a');
    await flush();
    events.length = 0;

    jest.advanceTimersByTime(WATCH_FLOOR_MS);
    await flush();
    expect(feedVisit_sync).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]); // nothing changed: no model

    // The next tick is due after twice the floor — not before.
    jest.advanceTimersByTime(WATCH_FLOOR_MS);
    await flush();
    expect(feedVisit_sync).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(WATCH_FLOOR_MS);
    await flush();
    expect(feedVisit_sync).toHaveBeenCalledTimes(2);

    // A visit that moves the cache publishes, and the cadence resets.
    feedVisit_sync.mockImplementationOnce(async (): Promise<boolean> => {
      cache.instance_add({ id: 72, feedID: 7, parentID: 71, pluginName: 'pl-child', params: null, status: 'created' });
      return true;
    });
    jest.advanceTimersByTime(4 * WATCH_FLOOR_MS);
    await flush();
    expect(events).toEqual([{ kind: 'envelope', envelope: { status: 'ok', rendered: 'dag' } }]);
    events.length = 0;
    jest.advanceTimersByTime(WATCH_FLOOR_MS);
    await flush();
    expect(feedVisit_sync).toHaveBeenCalledTimes(4);
  });

  it('the cadence never exceeds the cap', async () => {
    activeFeed_seed();
    procWatch_add(7, 'pane-a');
    await flush();
    for (let i = 0; i < 8; i++) {
      jest.advanceTimersByTime(WATCH_CAP_MS);
      await flush();
    }
    const before: number = feedVisit_sync.mock.calls.length;
    jest.advanceTimersByTime(WATCH_CAP_MS);
    await flush();
    expect(feedVisit_sync.mock.calls.length).toBe(before + 1);
  });

  it('a feed that settles reports settled and the watch ends', async () => {
    activeFeed_seed();
    procWatch_add(7, 'pane-a');
    await flush();
    feedVisit_sync.mockImplementationOnce(async (): Promise<boolean> => {
      cache.status_update(71, 'finishedSuccessfully');
      cache.feed_add(feed({ startedJobs: 0, finishedJobs: 2 }));
      return true;
    });
    jest.advanceTimersByTime(WATCH_FLOOR_MS);
    await flush();
    expect(events.at(-1)).toEqual({ kind: 'watched', subject: '/proc/jobs/feed_7', state: 'settled' });
    expect(procWatch_list()).toEqual([]);
    expect(procWatch_state(7)).toBe('settled');
    jest.advanceTimersByTime(10 * WATCH_CAP_MS);
    await flush();
    expect(feedVisit_sync).toHaveBeenCalledTimes(1); // no further sampling
  });

  it('a failed visit reports stale and keeps trying at the cap', async () => {
    activeFeed_seed();
    procWatch_add(7, 'pane-a');
    await flush();
    feedVisit_sync.mockResolvedValueOnce(false);
    jest.advanceTimersByTime(WATCH_FLOOR_MS);
    await flush();
    expect(events.at(-1)).toEqual({ kind: 'watched', subject: '/proc/jobs/feed_7', state: 'stale' });
    jest.advanceTimersByTime(WATCH_CAP_MS);
    await flush();
    expect(events.at(-1)).toEqual({ kind: 'watched', subject: '/proc/jobs/feed_7', state: 'live' });
  });

  it('a tick still out when someone else connects says nothing more and arms nothing; the next identity\'s watch of the same number is its own', async () => {
    const { identityEpoch_raise } = await import('@fnndsc/cumin/identity-epoch');
    activeFeed_seed();
    feedDag_handle.mockResolvedValue({ status: 'ok', rendered: 'the first one\'s graph' });
    procWatch_add(7, 'pane-a');
    await flush();
    // The first identity's watch ticks, and its visit is out.
    let land: (ok: boolean) => void = (): void => undefined;
    feedVisit_sync.mockImplementationOnce((): Promise<boolean> => new Promise((resolve: (ok: boolean) => void): void => { land = resolve; }));
    await jest.advanceTimersByTimeAsync(WATCH_FLOOR_MS);
    await flush();
    expect(feedVisit_sync).toHaveBeenCalledTimes(1);
    // Someone else connects. Every watch is retired; a surface asks again for feed 7, now theirs.
    identityEpoch_raise('other@cube');
    expect(procWatch_list()).toEqual([]);
    feedDag_handle.mockResolvedValue({ status: 'ok', rendered: 'the second one\'s graph' });
    procWatch_add(7, 'pane-a');
    await flush();
    expect(procWatch_list()).toEqual([{ feedID: 7, owners: 1, state: 'live' }]);
    const before: number = events.length;
    // The first one's visit lands now, with a change it would have published.
    feedDag_handle.mockResolvedValue({ status: 'ok', rendered: 'the first one\'s graph, late' });
    cache.emit({ scope: 'feed', feedID: 7 });
    land(true);
    await flush();
    // Nothing was said for it, and the second one's watch is still the one in place.
    expect(events.slice(before).filter((event: unknown): boolean => JSON.stringify(event).includes('late'))).toEqual([]);
    expect(procWatch_list()).toEqual([{ feedID: 7, owners: 1, state: 'live' }]);
  });

  it('a watch woken by a change that other work made ticks in its own place, not in that work\'s', async () => {
    const { identityElevated_run, identityElevated_is, identityScope_run } = await import('@fnndsc/cumin/identity-epoch');
    cache.feed_add(feed({ id: 7 }));
    // Indexing: the watch holds the floor and waits to be kicked.
    feedDag_handle.mockResolvedValue({ status: 'ok', rendered: '', model: { kind: 'feed.indexing' } } as never);
    procWatch_add(7, 'pane-a');
    await flush();
    const seen: boolean[] = [];
    feedDag_handle.mockImplementation(async (): Promise<{ status: string; rendered: string }> => {
      seen.push(identityElevated_is());
      return { status: 'ok', rendered: 'dag' };
    });
    // The topology lands in a walk done as another user: the cache says so from inside that work.
    await identityScope_run((): Promise<void> => identityElevated_run({ of: 'the admin' }, async (): Promise<void> => {
      cache.topologyLoaded_mark(7);
    }));
    await jest.advanceTimersByTimeAsync(1);
    await flush();
    expect(seen).toEqual([false]);
  });

  it('a watch is not kept for work done as another user: it would outlive the command and speak to every surface', async () => {
    const { identityElevated_run, identityScope_run } = await import('@fnndsc/cumin/identity-epoch');
    activeFeed_seed();
    const state = await identityScope_run((): Promise<unknown> => identityElevated_run({ of: 'the admin' }, async (): Promise<unknown> => procWatch_add(7, 'pane-a')));
    await flush();
    expect(state).toBeNull();
    expect(procWatch_list()).toEqual([]);
    expect(feedDag_handle).not.toHaveBeenCalled();
    // The ordinary watch of the same feed is the session's, and is made as usual.
    expect(procWatch_add(7, 'pane-a')).toBe('live');
    await flush();
    expect(procWatch_list()).toEqual([{ feedID: 7, owners: 1, state: 'live' }]);
  });

  it('a launch answered after someone else connected makes no watch and joins none: the feed of that number is now another\'s', async () => {
    const { identityEpoch_raise, identityScope_run } = await import('@fnndsc/cumin/identity-epoch');
    activeFeed_seed();
    let launched: () => void = (): void => undefined;
    // The first identity launches a run; CUBE is slow to answer, and the run is followed when it does.
    const followed: Promise<unknown> = identityScope_run(async (): Promise<unknown> => {
      await new Promise<void>((resolve: () => void): void => { launched = resolve; });
      return procWatch_add(7, 'run');
    });
    identityEpoch_raise('other@cube');
    // No watch yet for the second: the late follow makes none.
    launched();
    expect(await followed).toBeNull();
    await flush();
    expect(procWatch_list()).toEqual([]);
    expect(feedDag_handle).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    // The second has its own watch of feed 7: a late follow from the first adds no owner to it.
    procWatch_add(7, 'pane-a');
    await flush();
    const before: number = events.length;
    const late: Promise<unknown> = identityScope_run(async (): Promise<unknown> => {
      await new Promise<void>((resolve: () => void): void => { launched = resolve; });
      return procWatch_add(7, 'run');
    });
    identityEpoch_raise('third@cube');
    procWatch_add(7, 'pane-a');
    await flush();
    const published: number = events.length;
    launched();
    expect(await late).toBeNull();
    await flush();
    expect(procWatch_list()).toEqual([{ feedID: 7, owners: 1, state: 'live' }]);
    expect(events.length).toBe(published);
    expect(before).toBeGreaterThan(0);
  });

  it('watches are refcounted per owner, and a release drops every watch an owner held', async () => {
    activeFeed_seed();
    cache.feed_add(feed({ id: 8 }));
    cache.instance_add({ id: 80, feedID: 8, parentID: null, pluginName: 'pl-root', params: null, status: 'started' });
    cache.topologyLoaded_mark(8);
    procWatch_add(7, 'pane-a');
    procWatch_add(7, 'pane-b');
    procWatch_add(8, 'pane-a');
    await flush();
    expect(procWatch_list().map((w): [number, number] => [w.feedID, w.owners])).toEqual([[7, 2], [8, 1]]);

    procWatch_remove(7, 'pane-b');
    expect(procWatch_list().find((w): boolean => w.feedID === 7)?.owners).toBe(1);

    procWatch_release('pane-a');
    expect(procWatch_list()).toEqual([]);
    const calls: number = feedVisit_sync.mock.calls.length;
    jest.advanceTimersByTime(10 * WATCH_CAP_MS);
    await flush();
    expect(feedVisit_sync.mock.calls.length).toBe(calls); // nothing samples after release
  });
});
