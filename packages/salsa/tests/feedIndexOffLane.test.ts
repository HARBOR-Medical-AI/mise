/**
 * Index movement never holds the lane: a cold feed's topology walk is
 * started and left to run, deduped while in flight, committed when it lands,
 * and named where it stopped when it fails.
 *
 * Seams: cumin chrisConnection.client_get (stub) and salsa jobs/index (stub).
 * Real procCache runs.
 */
const mockClientGet = jest.fn();
jest.mock('@fnndsc/cumin', () => ({
  ...jest.requireActual('@fnndsc/cumin'),
  chrisConnection: { client_get: mockClientGet },
}));
jest.mock('../src/jobs/index', () => ({}));

import { procCache_get, identityEpoch_raise, identityScope_run } from '@fnndsc/cumin';
import { feedInstances_ensureStarted, feedInstances_ensureLoaded, procFeed_refreshStart, procRoster_sync, procRoster_syncStart, procVisitState_reset, ROSTER_DELTA_MIN_MS } from '../src/vfs/providers/proc';

const cache = procCache_get();

/** A client whose plugin-instance pages release one at a time, on demand. */
function gatedClient(rows: Array<{ id: number; feed_id: number }>, pageSize: number = 100) {
  const gates: Array<() => void> = [];
  const client = {
    getPluginInstances: jest.fn(async (params: { offset?: number; limit?: number }) => {
      await new Promise<void>((resolve: () => void): void => { gates.push(resolve); });
      const offset: number = params.offset ?? 0;
      const limit: number = params.limit ?? pageSize;
      return { data: rows.slice(offset, offset + limit), totalCount: rows.length };
    }),
  };
  const release = (): void => { const gate = gates.shift(); if (gate) gate(); };
  return { client, release, pending: (): number => gates.length };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve: () => void): void => { setImmediate(resolve); });
}

function rows_make(feedID: number, n: number): Array<{ id: number; feed_id: number; plugin_name: string; status: string }> {
  return Array.from({ length: n }, (_: unknown, i: number) => ({ id: 1000 + i, feed_id: feedID, plugin_name: 'pl-x', status: 'finishedSuccessfully' }));
}

beforeEach(() => {
  cache.cache_clear();
  procVisitState_reset();
  jest.clearAllMocks();
});

describe('feedInstances_ensureStarted', () => {
  it('a cold feed answers pending at once, walks off the lane, and is ready when the walk lands', async () => {
    const gated = gatedClient(rows_make(21, 250));
    mockClientGet.mockResolvedValue(gated.client);

    expect(feedInstances_ensureStarted(21)).toBe('pending');
    await flush();
    // The first page is in flight and the register names the walk.
    expect(gated.pending()).toBe(1);
    expect(cache.feedLoad_read(21)).toEqual({ feedID: 21, loaded: 0, total: 0 });
    // Asking again while it runs starts no second walk.
    expect(feedInstances_ensureStarted(21)).toBe('pending');
    await flush();
    expect(gated.client.getPluginInstances).toHaveBeenCalledTimes(1);

    gated.release(); await flush();
    expect(cache.feedLoad_read(21)).toEqual({ feedID: 21, loaded: 100, total: 250 });
    expect(cache.topologyLoaded_has(21)).toBe(false); // committed only when whole
    // The first page told the total: the remaining two pages fly together.
    expect(gated.pending()).toBe(2);
    gated.release(); await flush();
    gated.release(); await flush();

    expect(cache.topologyLoaded_has(21)).toBe(true);
    expect(cache.feedInstanceIDs_get(21)).toHaveLength(250);
    expect(cache.feedLoad_read(21)).toBeNull();
    expect(feedInstances_ensureStarted(21)).toBe('ready');
    expect(cache.loading_get(21)).toBeUndefined();
  });

  it('a walk that fails names where it stopped, and the next ask starts again', async () => {
    const rows = rows_make(22, 150);
    let calls: number = 0;
    const client = {
      getPluginInstances: jest.fn(async (params: { offset?: number; limit?: number }) => {
        calls += 1;
        if (calls === 2) throw new Error('CUBE 502');
        const offset: number = params.offset ?? 0;
        return { data: rows.slice(offset, offset + (params.limit ?? 100)), totalCount: rows.length };
      }),
    };
    mockClientGet.mockResolvedValue(client);

    expect(feedInstances_ensureStarted(22)).toBe('pending');
    await flush();
    expect(cache.topologyLoaded_has(22)).toBe(false);
    expect(cache.feedLoad_read(22)).toEqual({ feedID: 22, loaded: 100, total: 150, failed: 'CUBE 502' });
    expect(cache.loading_get(22)).toBeUndefined();

    // The next visit retries from the beginning; this one succeeds.
    expect(feedInstances_ensureStarted(22)).toBe('pending');
    await flush();
    expect(cache.topologyLoaded_has(22)).toBe(true);
    expect(cache.feedLoad_read(22)).toBeNull();
    expect(client.getPluginInstances).toHaveBeenCalledTimes(4);
  });

  it('a refresh of a feed the own-feeds endpoint does not list keeps its roster row and re-walks it', async () => {
    cache.feed_add({ id: 834, title: 'shared', ownerUsername: 'someone', public: true, creationDate: 'd', finishedJobs: 1, erroredJobs: 0, startedJobs: 0, scheduledJobs: 0, cancelledJobs: 0, createdJobs: 0 });
    cache.instance_add({ id: 1, feedID: 834, parentID: null, pluginName: 'pl-old', params: null, status: 'finishedSuccessfully' });
    cache.topologyLoaded_mark(834);
    const rows = rows_make(834, 3);
    const client = {
      getFeeds: jest.fn(async () => ({ data: [], totalCount: 0 })),
      getPluginInstances: jest.fn(async (params: { offset?: number; limit?: number }) => ({ data: rows.slice(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? 100)), totalCount: rows.length })),
    };
    mockClientGet.mockResolvedValue(client);

    await expect(procFeed_refreshStart(834)).resolves.toBe('pending');
    expect(cache.feed_get(834)?.title).toBe('shared'); // the row stayed
    expect(cache.instance_get(1)).toBeUndefined();       // the old topology went
    await flush();
    expect(cache.topologyLoaded_has(834)).toBe(true);
    expect(cache.feedInstanceIDs_get(834)).toHaveLength(3);
  });

  it('the roster sync is started and named, deduped while it runs, and cleared when it lands', async () => {
    expect(procRoster_syncStart()).toBe('none'); // not in service yet
    cache.feed_add({ id: 5, title: 'f', ownerUsername: 'u', public: false, creationDate: 'd', finishedJobs: 0, erroredJobs: 0, startedJobs: 0, scheduledJobs: 0, cancelledJobs: 0, createdJobs: 0 });
    cache.built_set();
    cache.warmup_complete();
    const gates: Array<() => void> = [];
    const client = {
      getFeeds: jest.fn(() => new Promise<{ data: unknown[]; totalCount: number }>((resolve) => { gates.push(() => resolve({ data: [], totalCount: 0 })); })),
      getPublicFeeds: jest.fn(async () => ({ data: [], totalCount: 0 })),
    };
    mockClientGet.mockResolvedValue(client);

    const kind = procRoster_syncStart();
    expect(kind === 'full' || kind === 'delta').toBe(true);
    expect(cache.rosterSync_get()).toBe(kind);           // named while it runs
    expect(procRoster_syncStart()).toBe(kind);            // deduped
    await flush();
    expect(client.getFeeds).toHaveBeenCalledTimes(1);
    while (gates.length > 0) { (gates.shift() as () => void)(); await flush(); }
    for (let i = 0; i < 5 && cache.rosterSync_get() !== null; i++) { while (gates.length > 0) (gates.shift() as () => void)(); await flush(); }
    expect(cache.rosterSync_get()).toBeNull();            // cleared when it lands
  });

  it('a forced sync asked while a delta runs is not that delta: the whole walk follows it', async () => {
    cache.feed_add({ id: 5, title: 'f', ownerUsername: 'u', public: false, creationDate: 'd', finishedJobs: 0, erroredJobs: 0, startedJobs: 0, scheduledJobs: 0, cancelledJobs: 0, createdJobs: 0 });
    cache.built_set();
    cache.warmup_complete();
    let gated: boolean = false;
    const gates: Array<() => void> = [];
    const page = (): Promise<{ data: unknown[]; totalCount: number }> => gated
      ? new Promise((resolve) => { gates.push(() => resolve({ data: [], totalCount: 0 })); })
      : Promise.resolve({ data: [], totalCount: 0 });
    mockClientGet.mockResolvedValue({ getFeeds: jest.fn(page), getPublicFeeds: jest.fn(page), getPluginInstances: jest.fn(async () => ({ data: [], totalCount: 0 })) });
    await procRoster_sync(true); // walked just now: the next unforced sync is a delta
    const walkedAt: number = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(walkedAt + ROSTER_DELTA_MIN_MS + 1); // past the delta's least interval
    const kinds: string[] = [];
    const progress = cache.rosterSync_progress.bind(cache);
    jest.spyOn(cache, 'rosterSync_progress').mockImplementation((kind) => { kinds.push(kind); progress(kind); });

    gated = true;
    expect(procRoster_syncStart()).toBe('delta');
    expect(procRoster_syncStart(true)).toBe('full');   // the operator's REFRESH
    for (let i = 0; i < 10 && (gates.length > 0 || cache.rosterSync_get() !== null); i++) { while (gates.length > 0) (gates.shift() as () => void)(); await flush(); }
    expect(kinds).toEqual(['delta', 'full']);
    expect(cache.rosterSync_get()).toBeNull();
    jest.restoreAllMocks();
  });

  it('an unforced delta within a minute of the last sync asks CUBE nothing; REFRESH still walks', async () => {
    cache.feed_add({ id: 5, title: 'f', ownerUsername: 'u', public: false, creationDate: 'd', finishedJobs: 0, erroredJobs: 0, startedJobs: 0, scheduledJobs: 0, cancelledJobs: 0, createdJobs: 0 });
    cache.built_set();
    cache.warmup_complete();
    const getFeeds: jest.Mock = jest.fn(async () => ({ data: [], totalCount: 0 }));
    mockClientGet.mockResolvedValue({ getFeeds, getPublicFeeds: jest.fn(async () => ({ data: [], totalCount: 0 })), getPluginInstances: jest.fn(async () => ({ data: [], totalCount: 0 })) });
    await procRoster_sync(true);
    getFeeds.mockClear();
    expect(procRoster_syncStart()).toBe('none');          // too soon: nothing asked
    await procRoster_sync();
    expect(getFeeds).not.toHaveBeenCalled();
    expect(procRoster_syncStart(true)).toBe('full');       // the operator's REFRESH
  });

  it('feedInstances_ensureLoaded still waits for the walk it shares', async () => {
    const gated = gatedClient(rows_make(23, 50));
    mockClientGet.mockResolvedValue(gated.client);
    let done: boolean = false;
    const waiting: Promise<void> = feedInstances_ensureLoaded(23).then((): void => { done = true; });
    await flush();
    expect(done).toBe(false);
    expect(feedInstances_ensureStarted(23)).toBe('pending');
    gated.release(); await flush();
    await waiting;
    expect(done).toBe(true);
    expect(cache.topologyLoaded_has(23)).toBe(true);
  });
});

describe('a walk through a change of identity', () => {
  it('begun for one identity, it is not joined by the next, and when it lands it leaves the next one\'s tree alone', async () => {
    // The first identity's walk of feed 21 is under way, its first page still out.
    const first = gatedClient(rows_make(21, 3));
    mockClientGet.mockResolvedValue(first.client);
    const firstWalk: Promise<unknown> = identityScope_run((): Promise<unknown> => feedInstances_ensureLoaded(21));
    await flush();
    expect(first.pending()).toBe(1);
    // Someone else connects. Their feed 21 is another feed altogether: other jobs, other numbers.
    identityEpoch_raise();
    const theirs = Array.from({ length: 2 }, (_: unknown, i: number) => ({ id: 2000 + i, feed_id: 21, plugin_name: 'pl-theirs', status: 'finishedSuccessfully' }));
    const getPluginInstances = jest.fn(async () => ({ data: theirs, totalCount: theirs.length }));
    mockClientGet.mockResolvedValue({ getPluginInstances });
    await identityScope_run((): Promise<unknown> => feedInstances_ensureLoaded(21));
    // Asked of CUBE for themselves, not handed the first one's walk.
    expect(getPluginInstances).toHaveBeenCalled();
    expect(procCache_get().feedInstanceIDs_all(21).sort()).toEqual([2000, 2001]);
    // The first one's walk lands now.
    while (first.pending() > 0) { first.release(); await flush(); }
    await firstWalk.catch((): undefined => undefined);
    await flush();
    expect(procCache_get().feedInstanceIDs_all(21).sort()).toEqual([2000, 2001]);
    expect(procCache_get().instance_get(1000)).toBeUndefined();
    expect(procCache_get().topologyLoaded_has(21)).toBe(true);
  });
});

