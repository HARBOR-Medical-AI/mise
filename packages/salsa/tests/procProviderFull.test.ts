/**
 * Boundary-only tests for the /proc provider and its cache/warmup functions.
 * Seams: cumin chrisConnection.client_get (stub) and salsa jobs/index (stub).
 * Real procCache / Result run.
 */
const mockClientGet = jest.fn();
const mockUserGet = jest.fn(async (): Promise<string | null> => null);
const mockJobs = {
  job_cancel: jest.fn(),
  job_delete: jest.fn(),
  job_statusFetch: jest.fn(),
  job_logFetch: jest.fn(),
  jobs_statusBatch: jest.fn(),
};

const mockFeedNoteGet = jest.fn();
const mockFeedNoteUpdate = jest.fn();
const mockFeedRename = jest.fn();
jest.mock('@fnndsc/cumin', () => ({
  ...jest.requireActual('@fnndsc/cumin'),
  chrisConnection: { client_get: mockClientGet, user_get: () => mockUserGet() },
  feedNote_get: (...args: unknown[]) => mockFeedNoteGet(...args),
  feedNote_update: (...args: unknown[]) => mockFeedNoteUpdate(...args),
  feed_rename: (...args: unknown[]) => mockFeedRename(...args),
}));
jest.mock('../src/jobs/index', () => mockJobs);

import { procCache_get, Ok, Err, ProcFeed, ProcInstance } from '@fnndsc/cumin';
import {
  ProcVfsProvider,
  feedStatus_derive,
  procPath_parse,
  procTopology_warmup,
  procTopology_retry,
  procTopology_status,
  procTopology_await,
  procTopology_reconcileFeeds,
  procCache_refresh,
  procFeed_ensureLoaded,
  feedInstances_ensureLoaded,
  feedMeta_ensure,
  feedStatus_refresh,
  feedVisit_sync,
  feedCached_isSettled,
  procRoster_sync,
  procRoster_bootSync,
  procTopologyCatchup_enqueue,
  procTopologyCatchup_status,
  procTopologyCatchup_await,
  procVisitState_reset,
  procPipelineBackfill_status,
  FEED_RECHECK_MS,
  ROSTER_FULL_WALK_MS,
  ROSTER_DELTA_PAGE,
  ROSTER_LIST_BUDGET_MS,
  procFeed_probe,
  procTarget_parse,
  procTarget_locate,
} from '../src/vfs/providers/proc';

// Feed-list pages wait as long as CUBE's feed list takes (#1280).
const FEED_LIST_TIMEOUT_MS: number = 120_000;
const cache = procCache_get();
const provider = new ProcVfsProvider();
const { errorStack } = jest.requireActual<typeof import('@fnndsc/cumin')>('@fnndsc/cumin');

function feed(over: Partial<ProcFeed> = {}): ProcFeed {
  return {
    id: 1, title: 'f', creationDate: '', finishedJobs: 0, erroredJobs: 0,
    startedJobs: 0, scheduledJobs: 0, cancelledJobs: 0, createdJobs: 0, ...over,
    ownerUsername: over.ownerUsername ?? '', public: over.public ?? false,
  };
}

/** Fake chrisapi client that paginates a fixed set of rows. */
function pagingClient(feeds: unknown[] = [], instances: unknown[] = []) {
  return {
    getFeeds: jest.fn().mockResolvedValue({ data: feeds, totalCount: feeds.length }),
    getPluginInstances: jest.fn().mockResolvedValue({ data: instances, totalCount: instances.length }),
    getPluginInstance: jest.fn(),
  };
}

beforeEach(() => {
  cache.cache_clear();
  procVisitState_reset();
  jest.clearAllMocks();
});

describe('feedStatus_derive', () => {
  it('prioritises errors', () => {
    expect(feedStatus_derive(feed({ erroredJobs: 1, finishedJobs: 5 }))).toBe('finishedWithError');
  });
  it('reports running when jobs are active', () => {
    expect(feedStatus_derive(feed({ startedJobs: 1 }))).toBe('running');
    expect(feedStatus_derive(feed({ scheduledJobs: 1 }))).toBe('running');
    expect(feedStatus_derive(feed({ createdJobs: 1 }))).toBe('running');
  });
  it('reports cancelled only when nothing finished', () => {
    expect(feedStatus_derive(feed({ cancelledJobs: 1 }))).toBe('cancelled');
  });
  it('reports success when finished', () => {
    expect(feedStatus_derive(feed({ finishedJobs: 2 }))).toBe('finishedSuccessfully');
  });
  it('reports empty otherwise', () => {
    expect(feedStatus_derive(feed())).toBe('empty');
  });
});

describe('procPath_parse', () => {
  it('parses a feed path', () => {
    expect(procPath_parse('/proc/jobs/feed_5')).toEqual({ feedID: 5, instanceID: null, virtualFile: null, dataRemainder: null });
  });
  it('parses an instance path', () => {
    expect(procPath_parse('/proc/jobs/feed_5/pl-dircopy_10')).toEqual({
      feedID: 5, instanceID: 10, virtualFile: null, dataRemainder: null });
  });
  it('parses a feed virtual file', () => {
    expect(procPath_parse('/proc/jobs/feed_5/status')).toEqual({
      feedID: 5, instanceID: null, virtualFile: 'status', dataRemainder: null });
  });
  it('parses an instance virtual file', () => {
    expect(procPath_parse('/proc/jobs/feed_5/pl-x_10/status')).toEqual({
      feedID: 5, instanceID: 10, virtualFile: 'status', dataRemainder: null });
  });
  it('parses an instance data link', () => {
    expect(procPath_parse('/proc/jobs/feed_5/pl-x_10/data')).toEqual({
      feedID: 5, instanceID: 10, virtualFile: 'data', dataRemainder: '' });
  });
  it('returns nulls for a non-feed path', () => {
    expect(procPath_parse('/proc/jobs/other')).toEqual({ feedID: null, instanceID: null, virtualFile: null, dataRemainder: null });
  });
});

describe('ProcVfsProvider.list', () => {
  beforeEach(() => cache.built_set());

  it('lists all feeds at /proc/jobs with derived status', async () => {
    cache.feed_add(feed({ id: 1, title: 'brain', finishedJobs: 1 }));
    cache.feed_add(feed({ id: 2, title: 'spine', erroredJobs: 1 }));
    const r = await provider.list('/proc/jobs');
    expect(r.ok).toBe(true);
    const items = r.ok ? r.value : [];
    expect(items.map((i) => i.name).sort()).toEqual(['feed_1', 'feed_2']);
    expect(items.find((i) => i.name === 'feed_2')?.status).toBe('finishedWithError');
  });

  it('lists root instances from cache; terminal status needs no API call', async () => {
    cache.feed_add(feed({ id: 5 }));
    cache.instance_add({ id: 10, feedID: 5, parentID: null, pluginName: 'pl-dircopy', params: null, status: 'finishedSuccessfully' });
    cache.topologyLoaded_mark(5);
    const client = pagingClient([], []);
    mockClientGet.mockResolvedValue(client);

    const r = await provider.list('/proc/jobs/feed_5');
    const items = r.ok ? r.value : [];
    expect(items.filter((i) => i.type === 'file').map((i) => i.name)).toEqual(['status', 'title', 'note']);
    expect(items.find((i) => i.type === 'job')).toMatchObject({ name: 'pl-dircopy_10', status: 'finishedSuccessfully' });
    expect(client.getPluginInstances).not.toHaveBeenCalled();
    expect(mockJobs.jobs_statusBatch).not.toHaveBeenCalled();
  });

  it('revisiting an active feed runs the visit delta: feed row, then the moved rows', async () => {
    cache.feed_add(feed({ id: 5, startedJobs: 1 }));
    cache.instance_add({ id: 10, feedID: 5, parentID: null, pluginName: 'pl-dircopy', params: null, status: 'started' });
    cache.topologyLoaded_mark(5);
    const client = pagingClient([{ id: 5, name: 'f', finished_jobs: 1 }], [
      { id: 10, feed_id: 5, previous_id: null, plugin_name: 'pl-dircopy', status: 'finishedSuccessfully' },
    ]);
    mockClientGet.mockResolvedValue(client);

    const r = await provider.list('/proc/jobs/feed_5');
    const items = r.ok ? r.value : [];
    expect(client.getFeeds).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }), FEED_LIST_TIMEOUT_MS);
    // No cursor yet (no row carried a timestamp): the delta is one unfiltered
    // walk, then the active sweep.
    expect(client.getPluginInstances).toHaveBeenCalledTimes(2);
    expect(client.getPluginInstances).toHaveBeenLastCalledWith(expect.objectContaining({ feed_id: 5, active: true }));
    expect(mockJobs.jobs_statusBatch).not.toHaveBeenCalled();
    expect(items.find((i) => i.type === 'job')).toMatchObject({ name: 'pl-dircopy_10', status: 'finishedSuccessfully' });
  });

  it('returns [] for an unknown feed', async () => {
    cache.topologyLoaded_mark(9);
    const r = await provider.list('/proc/jobs/feed_9');
    expect(r.ok && r.value).toEqual([]);
  });

  it('answers a subtree from the cache in listing order, leaving an unindexed feed to the walk', async () => {
    cache.feed_add(feed({ id: 5 }));
    cache.feed_add(feed({ id: 6 }));
    cache.instance_add({ id: 10, feedID: 5, parentID: null, pluginName: 'pl-root', params: null, status: 'finishedSuccessfully', startedAt: '2026-10-02T00:00:00Z' });
    cache.instance_add({ id: 11, feedID: 5, parentID: 10, pluginName: 'pl-child', params: null, status: 'finishedWithError' });
    cache.topologyLoaded_mark(5);
    cache.built_set();
    const client = pagingClient([], []);
    mockClientGet.mockResolvedValue(client);

    const all = await provider.subtree('/proc/jobs');
    const rels: string[] = (all?.entries ?? []).map((e) => e.rel);
    expect(rels).toEqual(expect.arrayContaining(['feed_5', 'feed_5/status', 'feed_5/title', 'feed_5/note', 'feed_5/pl-root_10', 'feed_5/pl-root_10/status', 'feed_5/pl-root_10/pl-child_11', 'feed_6']));
    expect(rels.indexOf('feed_5/pl-root_10')).toBeLessThan(rels.indexOf('feed_5/pl-root_10/pl-child_11'));
    const child = all?.entries.find((e) => e.rel === 'feed_5/pl-root_10/pl-child_11');
    expect(child).toMatchObject({ depth: 3, attrs: { status: 'finishedWithError', plugin: 'pl-child' } });
    expect(all?.entries.find((e) => e.rel === 'feed_5/pl-root_10')?.item.date).toBe('2026-10-02T00:00:00Z');
    expect(all?.unanswered).toEqual(['feed_6']);
    expect((await provider.subtree('/proc/jobs/feed_5/pl-root_10'))?.entries.map((e) => e.rel)).toEqual(expect.arrayContaining(['status', 'params', 'log', 'pl-child_11']));
    expect(await provider.subtree('/proc/jobs/feed_6')).toBeNull();     // its jobs are not indexed: walk it
    // The only rows read are the pipeline backfill's, behind the answer, feed by feed.
    for (const call of client.getPluginInstances.mock.calls) expect(call[0]).toMatchObject({ feed_id: 5 });
    expect(client.getFeeds).not.toHaveBeenCalled();
  });

  it('learns which pipeline run made each job once, behind the prompt, and the subtree then says', async () => {
    cache.feed_add(feed({ id: 5 }));
    cache.instance_add({ id: 10, feedID: 5, parentID: null, pluginName: 'pl-root', params: null, status: 'finishedSuccessfully' });
    cache.instance_add({ id: 11, feedID: 5, parentID: 10, pluginName: 'pl-child', params: null, status: 'finishedSuccessfully' });
    cache.topologyLoaded_mark(5);
    cache.built_set();
    const client = pagingClient([], [
      // A direct run: the client drops null fields, so the row carries none.
      { id: 10, feed_id: 5, plugin_name: 'pl-root', status: 'finishedSuccessfully' },
      { id: 11, feed_id: 5, plugin_name: 'pl-child', status: 'finishedSuccessfully', pipeline_name: 'FreeSurfer 8.2.0', workflow_id: 51177 },
    ]);
    mockClientGet.mockResolvedValue(client);

    const first = await provider.subtree('/proc/jobs/feed_5');
    expect(first?.entries.find((e) => e.rel.endsWith('pl-child_11'))?.attrs?.['pipeline']).toBeUndefined();   // not known yet
    for (let i = 0; i < 20 && cache.instance_get(11)?.pipelineName === undefined; i++) await new Promise((r) => setImmediate(r));
    expect(cache.instance_get(11)).toMatchObject({ pipelineName: 'FreeSurfer 8.2.0', workflowID: 51177 });
    expect(cache.instance_get(10)).toMatchObject({ pipelineName: null, workflowID: null });
    const second = await provider.subtree('/proc/jobs/feed_5');
    expect(second?.entries.find((e) => e.rel.endsWith('pl-child_11'))?.attrs).toMatchObject({ pipeline: 'FreeSurfer 8.2.0', workflow: '51177' });
    expect(second?.entries.find((e) => e.rel === 'pl-root_10')?.attrs).toMatchObject({ pipeline: '', workflow: '' });
    expect(client.getPluginInstances).toHaveBeenCalledTimes(1);     // read once, not again
  });

  it('reads a big feed\'s pages in parallel lanes, each page once, and says how far it has come (#1253)', async () => {
    cache.feed_add(feed({ id: 7 }));
    const rows = Array.from({ length: 250 }, (_: unknown, n: number) => ({ id: 1000 + n, feed_id: 7, plugin_name: 'pl-x', status: 'finishedSuccessfully', pipeline_name: 'FS', workflow_id: 9 }));
    for (const row of rows) cache.instance_add({ id: row.id, feedID: 7, parentID: null, pluginName: 'pl-x', params: null, status: 'finishedSuccessfully' });
    cache.topologyLoaded_mark(7);
    cache.built_set();
    let inFlight: number = 0;
    let most: number = 0;
    const offsets: number[] = [];
    const client = pagingClient([], []);
    client.getPluginInstances.mockImplementation(async (params: { offset: number; limit: number }) => {
      offsets.push(params.offset);
      inFlight += 1; most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { data: rows.slice(params.offset, params.offset + params.limit), totalCount: rows.length };
    });
    mockClientGet.mockResolvedValue(client);
    await provider.subtree('/proc/jobs/feed_7');
    for (let i = 0; i < 200 && rows.some((row) => cache.instance_get(row.id)?.pipelineName === undefined); i++) await new Promise((r) => setTimeout(r, 5));
    expect(rows.every((row) => cache.instance_get(row.id)?.pipelineName === 'FS')).toBe(true);
    expect(offsets.sort((a, b) => a - b)).toEqual([0, 100, 200]);
    // The first page says the feed's length; the other two are read together.
    expect(most).toBeGreaterThan(1);
    for (let i = 0; i < 50 && procPipelineBackfill_status().running; i++) await new Promise((r) => setTimeout(r, 5));
    expect(procPipelineBackfill_status()).toEqual({ pages: 3, read: 3, running: false });
  });

  /** A feed CUBE lists newest first, its jobs `known` of them already knowing their pipeline run. */
  function feedListed_make(feedID: number, jobs: number, known: number) {
    const rows = Array.from({ length: jobs }, (_: unknown, n: number) => ({ id: 5000 + jobs - n, feed_id: feedID, plugin_name: 'pl-x', status: 'finishedSuccessfully', pipeline_name: 'FS', workflow_id: 9 }));
    cache.feed_add(feed({ id: feedID }));
    rows.forEach((row, at: number) => {
      cache.instance_add({ id: row.id, feedID, parentID: null, pluginName: 'pl-x', params: null, status: 'finishedSuccessfully' });
      if (at < known) cache.instanceMetrics_set(row.id, { pipelineName: 'FS', workflowID: 9 });
    });
    cache.topologyLoaded_mark(feedID);
    cache.built_set();
    return rows;
  }

  it('starts a restarted pass where the unknown jobs begin, not at the known head (#1253)', async () => {
    const rows = feedListed_make(8, 500, 400);
    const offsets: number[] = [];
    const client = pagingClient([], []);
    client.getPluginInstances.mockImplementation(async (params: { offset: number; limit: number }) => {
      offsets.push(params.offset);
      return { data: rows.slice(params.offset, params.offset + params.limit), totalCount: rows.length };
    });
    mockClientGet.mockResolvedValue(client);
    await provider.subtree('/proc/jobs/feed_8');
    for (let i = 0; i < 200 && procPipelineBackfill_status().running !== false; i++) await new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < 200 && rows.some((row) => cache.instance_get(row.id)?.pipelineName === undefined); i++) await new Promise((r) => setTimeout(r, 5));
    expect(rows.every((row) => cache.instance_get(row.id)?.pipelineName === 'FS')).toBe(true);
    // The first page, then from a page before the unknown block: 100 and 200 are known and skipped.
    expect(offsets.sort((a, b) => a - b)).toEqual([0, 300, 400]);
  });

  it('reads the skipped head after all when the unknown jobs were not where they were expected', async () => {
    const rows = feedListed_make(9, 500, 400);
    // The cache still holds 200 newer jobs CUBE no longer lists (removed since):
    // counted as known above, they push the start past the unknown block.
    for (let n = 1; n <= 200; n++) {
      cache.instance_add({ id: 9000 + n, feedID: 9, parentID: null, pluginName: 'pl-x', params: null, status: 'finishedSuccessfully' });
      cache.instanceMetrics_set(9000 + n, { pipelineName: 'FS', workflowID: 9 });
    }
    const offsets: number[] = [];
    const client = pagingClient([], []);
    client.getPluginInstances.mockImplementation(async (params: { offset: number; limit: number }) => {
      offsets.push(params.offset);
      return { data: rows.slice(params.offset, params.offset + params.limit), totalCount: rows.length };
    });
    mockClientGet.mockResolvedValue(client);
    await provider.subtree('/proc/jobs/feed_9');
    for (let i = 0; i < 300 && rows.some((row) => cache.instance_get(row.id)?.pipelineName === undefined); i++) await new Promise((r) => setTimeout(r, 5));
    expect(rows.every((row) => cache.instance_get(row.id)?.pipelineName === 'FS')).toBe(true);
    // The skip read nothing past the first page; the fallback read the feed from page 100 on.
    expect(offsets.sort((a, b) => a - b)).toEqual([0, 100, 200, 300, 400]);
  });

  it('lists children from cache; terminal status needs no API call', async () => {
    cache.feed_add(feed({ id: 5 }));
    cache.instance_add({ id: 10, feedID: 5, parentID: null, pluginName: 'pl-root', params: null, status: 'finishedSuccessfully' });
    cache.instance_add({ id: 11, feedID: 5, parentID: 10, pluginName: 'pl-child', params: null, status: 'finishedSuccessfully' });
    cache.topologyLoaded_mark(5);
    const client = pagingClient([], []);
    mockClientGet.mockResolvedValue(client);

    const r = await provider.list('/proc/jobs/feed_5/pl-root_10');
    const items = r.ok ? r.value : [];
    expect(items.filter((i) => i.type === 'file').map((i) => i.name)).toEqual(['status', 'params', 'log']);
    expect(items.find((i) => i.type === 'job')).toMatchObject({ name: 'pl-child_11', status: 'finishedSuccessfully' });
    expect(client.getPluginInstances).not.toHaveBeenCalled();
  });

  it('delegates everything under the data link to its CFS target', async () => {
    // `ls .../data` must show the target's real contents — not silently
    // re-list the instance (the defect: the browser rooted at the link
    // showed status/params/log and built .../data/log paths from them).
    cache.feed_add(feed({ id: 5 }));
    cache.instance_add({
      id: 10, feedID: 5, parentID: null, pluginName: 'pl-root', params: null,
      status: 'finishedSuccessfully', outputPath: '/home/alice/outputs/result-set',
    } as ProcInstance);
    cache.topologyLoaded_mark(5);
    const { vfsDispatcher } = await import('../src/vfs/dispatcher');
    const listSpy = jest.spyOn(vfsDispatcher, 'list').mockResolvedValue(
      Ok([{ name: 'brain.mgz', type: 'file', size: 7, owner: 'alice', date: '' }]),
    );
    // A file under the link is read through the door that knows both
    // worlds: the target is a CFS file, and the dispatcher's own default
    // provider is the HOST filesystem, which refuses it.
    const files = await import('../src/files/index');
    const readSpy = jest.spyOn(files, 'fileContent_get').mockResolvedValue(Ok('bytes'));
    const binSpy = jest.spyOn(files, 'fileContent_getBinary').mockResolvedValue(Ok(Buffer.from('img')));
    const dispatcherBinSpy = jest.spyOn(vfsDispatcher, 'readBinary');
    try {
      const listing = await provider.list('/proc/jobs/feed_5/pl-root_10/data');
      expect(listSpy).toHaveBeenCalledWith('/home/alice/outputs/result-set', undefined);
      expect(listing.ok && listing.value[0]?.name).toBe('brain.mgz');

      const deep = await provider.list('/proc/jobs/feed_5/pl-root_10/data/sub/dir');
      expect(deep.ok).toBe(true);
      expect(listSpy).toHaveBeenLastCalledWith('/home/alice/outputs/result-set/sub/dir', undefined);

      const text = await provider.read('/proc/jobs/feed_5/pl-root_10/data/notes.txt');
      expect(text.ok && text.value).toBe('bytes');
      expect(readSpy).toHaveBeenCalledWith('/home/alice/outputs/result-set/notes.txt');

      const bytes = await provider.readBinary('/proc/jobs/feed_5/pl-root_10/data/brain.mgz');
      expect(bytes.ok).toBe(true);
      expect(binSpy).toHaveBeenCalledWith('/home/alice/outputs/result-set/brain.mgz');

      // Outside the data subtree every file is synthesized text, served as
      // its bytes so a byte reader sees what `cat` does.
      const synthesized = await provider.readBinary('/proc/jobs/feed_5/pl-root_10/status');
      expect(synthesized.ok && synthesized.value.toString('utf8')).toBe('finishedSuccessfully');
      expect(binSpy).toHaveBeenCalledTimes(1);
      // Never back through the dispatcher: that is the bounce that refused
      // every byte a node's data holds.
      expect(dispatcherBinSpy).not.toHaveBeenCalled();
    } finally {
      listSpy.mockRestore();
      readSpy.mockRestore();
      dispatcherBinSpy.mockRestore();
      binSpy.mockRestore();
    }
  });

  it('refuses the data subtree when the job has no output space', async () => {
    cache.feed_add(feed({ id: 5 }));
    cache.instance_add({
      id: 10, feedID: 5, parentID: null, pluginName: 'pl-root', params: null,
      status: 'finishedSuccessfully', outputPath: null,
    } as ProcInstance);
    cache.topologyLoaded_mark(5);

    expect((await provider.list('/proc/jobs/feed_5/pl-root_10/data')).ok).toBe(false);
    expect((await provider.readBinary('/proc/jobs/feed_5/pl-root_10/data/x')).ok).toBe(false);
  });

  it('projects a job output as a navigable data link', async () => {
    cache.feed_add(feed({ id: 5 }));
    cache.instance_add({
      id: 10,
      feedID: 5,
      parentID: null,
      pluginName: 'pl-root',
      params: null,
      status: 'finishedSuccessfully',
      outputPath: '/home/alice/outputs/result-set',
    } as ProcInstance);
    cache.topologyLoaded_mark(5);

    const r = await provider.list('/proc/jobs/feed_5/pl-root_10');

    expect(r.ok && r.value).toContainEqual({
      name: 'data',
      type: 'link',
      target: '/home/alice/outputs/result-set',
      size: 0,
      owner: '',
      date: '',
    });
  });

  it('lists an unresolved data link without fetching CUBE instance metadata', async () => {
    cache.feed_add(feed({ id: 5 }));
    cache.instance_add({
      id: 10,
      feedID: 5,
      parentID: null,
      pluginName: 'pl-root',
      params: null,
      status: 'finishedSuccessfully',
    });
    cache.topologyLoaded_mark(5);
    const getPluginInstance = jest.fn().mockResolvedValue({
      data: { output_path: 'home/alice/outputs/result-set' },
    });
    mockClientGet.mockResolvedValue({ getPluginInstance });

    const r = await provider.list('/proc/jobs/feed_5/pl-root_10');

    expect(r.ok && r.value.find((item) => item.name === 'data')).toMatchObject({
      type: 'link',
    });
    expect(r.ok && r.value.find((item) => item.name === 'data')?.target).toBeUndefined();
    expect(cache.instance_get(10)?.outputPath).toBeUndefined();
    expect(getPluginInstance).not.toHaveBeenCalled();
  });

  it('resolves an unresolved data link only when it is followed', async () => {
    cache.feed_add(feed({ id: 5 }));
    cache.instance_add({
      id: 10,
      feedID: 5,
      parentID: null,
      pluginName: 'pl-root',
      params: null,
      status: 'finishedSuccessfully',
    });
    cache.topologyLoaded_mark(5);
    const getPluginInstance = jest.fn().mockResolvedValue({
      data: { output_path: 'home/alice/outputs/result-set' },
    });
    mockClientGet.mockResolvedValue({ getPluginInstance });

    const r = await provider.linkTarget_resolve('/proc/jobs/feed_5/pl-root_10/data');

    expect(r).toEqual({ ok: true, value: '/home/alice/outputs/result-set' });
    expect(cache.instance_get(10)?.outputPath).toBe('/home/alice/outputs/result-set');
    expect(getPluginInstance).toHaveBeenCalledWith(10);
  });
});

describe("a feed's note under /proc", () => {
  const puts: Array<Record<string, string>> = [];
  beforeEach(() => {
    puts.length = 0;
    cache.built_set();
    cache.feed_add(feed({ id: 5, title: 'brain', finishedJobs: 1 }));
    cache.topologyLoaded_mark(5);
    mockFeedNoteGet.mockResolvedValue(Ok({ title: 'kept', content: 'the scratchpad' }));
    mockFeedNoteUpdate.mockImplementation(async (_id: number, data: Record<string, string>) => { puts.push(data); return Ok(true); });
  });

  it('reads the note as a file', async () => {
    const r = await provider.read('/proc/jobs/feed_5/note');
    expect(r.ok && r.value).toBe('the scratchpad');
  });

  it('writes the note whole, leaving its title', async () => {
    expect((await provider.write('/proc/jobs/feed_5/note', 'new words')).ok).toBe(true);
    expect(puts).toEqual([{ content: 'new words' }]);
  });

  it('renames the feed by its title, first line trimmed, and the cache says so at once', async () => {
    mockFeedRename.mockResolvedValueOnce(Ok(true));
    expect((await provider.write('/proc/jobs/feed_5/title', '  Brain run v2  \nignored')).ok).toBe(true);
    expect(mockFeedRename).toHaveBeenCalledWith(5, 'Brain run v2');
    expect((await provider.read('/proc/jobs/feed_5/title')).ok && (await provider.read('/proc/jobs/feed_5/title'))).toEqual({ ok: true, value: 'Brain run v2' });
    mockFeedRename.mockResolvedValueOnce(Err());
    expect((await provider.write('/proc/jobs/feed_5/title', 'x')).ok).toBe(false);
  });

  it('refuses any other write by name', async () => {
    const refused = await provider.write('/proc/jobs/feed_5/status', 'x');
    expect(refused.ok === false && refused.errno).toBe('EROFS');
    expect(refused.ok === false && refused.reason).toMatch(/Read-only file system/);
  });

  it('fails the read when the note cannot be fetched', async () => {
    mockFeedNoteGet.mockResolvedValueOnce(Err());
    expect((await provider.read('/proc/jobs/feed_5/note')).ok).toBe(false);
  });
});

describe('ProcVfsProvider.read', () => {
  beforeEach(() => {
    cache.built_set();
    cache.feed_add(feed({ id: 5, title: 'brain', finishedJobs: 1 }));
    cache.instance_add({ id: 10, feedID: 5, parentID: null, pluginName: 'pl-x', params: null, status: 'started' });
    cache.topologyLoaded_mark(5);
  });

  it('reads feed status and title', async () => {
    const s = await provider.read('/proc/jobs/feed_5/status');
    expect(s.ok && s.value).toBe('finishedSuccessfully');
    const t = await provider.read('/proc/jobs/feed_5/title');
    expect(t.ok && t.value).toBe('brain');
  });

  it('reads no folder and no unknown file as text: they fail, so a folder can be said to be one', async () => {
    for (const where of ['/proc', '/proc/jobs', '/proc/jobs/feed_5', '/proc/jobs/feed_5/pl-x_10', '/proc/jobs/feed_5/bogus', '/proc/jobs/feed_5/pl-x_10/bogus']) {
      expect((await provider.read(where)).ok).toBe(false);
    }
  });

  it('reads active instance status live and caches it', async () => {
    mockJobs.job_statusFetch.mockResolvedValue(Ok('running'));
    const r = await provider.read('/proc/jobs/feed_5/pl-x_10/status');
    expect(r.ok && r.value).toBe('running');
    expect(cache.instance_get(10)?.status).toBe('running');
  });

  it('returns a cached terminal status without any API call', async () => {
    cache.status_update(10, 'finishedSuccessfully');
    const r = await provider.read('/proc/jobs/feed_5/pl-x_10/status');
    expect(r.ok && r.value).toBe('finishedSuccessfully');
    expect(mockJobs.job_statusFetch).not.toHaveBeenCalled();
  });

  it('falls back to last-known status when a live fetch fails', async () => {
    mockJobs.job_statusFetch.mockResolvedValue(Err());
    const r = await provider.read('/proc/jobs/feed_5/pl-x_10/status');
    expect(r.ok && r.value).toBe('started');
  });

  it('falls back to "unknown" when status is unknown and the fetch fails', async () => {
    cache.instance_add({ id: 10, feedID: 5, parentID: null, pluginName: 'pl-x', params: null, status: null });
    mockJobs.job_statusFetch.mockResolvedValue(Err());
    const r = await provider.read('/proc/jobs/feed_5/pl-x_10/status');
    expect(r.ok && r.value).toBe('unknown');
  });

  it('fetches and caches the complete effective parameter collection, not instance metadata', async () => {
    const getParameters = jest.fn().mockImplementation(({ offset }: { offset: number }) => ({
      data: offset === 0
        ? [{ param_name: 'inputdir', value: '/in', type: 'path' }]
        : [{ param_name: 'threshold', value: '0.5', type: 'float' }],
      totalCount: 2,
    }));
    mockClientGet.mockResolvedValue({
      getPluginInstance: jest.fn().mockResolvedValue({ getParameters }),
    });
    const r = await provider.read('/proc/jobs/feed_5/pl-x_10/params');
    expect(r.ok && r.value).toContain('inputdir=/in');
    expect(r.ok && r.value).toContain('threshold=0.5');
    expect(r.ok && r.value).not.toContain('plugin_name');
    expect(r.ok && r.value).not.toContain('raw=');
    expect(getParameters).toHaveBeenNthCalledWith(1, { limit: 100, offset: 0 });
    expect(getParameters).toHaveBeenNthCalledWith(2, { limit: 100, offset: 1 });
    // cached now -> params_render from cache
    expect(cache.instance_get(10)?.params).toMatchObject({ inputdir: '/in', threshold: '0.5' });
  });

  it('reads instance log', async () => {
    mockJobs.job_logFetch.mockResolvedValue(Ok('hello log'));
    const r = await provider.read('/proc/jobs/feed_5/pl-x_10/log');
    expect(r.ok && r.value).toBe('hello log');
  });

  it('returns "" for an unknown feed file', async () => {
    const r = await provider.read('/proc/jobs/feed_999/status');
    expect(r.ok && r.value).toBe('');
  });
});

describe('ProcVfsProvider.rm', () => {
  beforeEach(() => {
    cache.built_set();
    cache.feed_add(feed({ id: 5 }));
    cache.instance_add({ id: 10, feedID: 5, parentID: null, pluginName: 'pl-x', params: null, status: 'running' });
    cache.topologyLoaded_mark(5);
  });

  it('cancels non-terminal jobs then removes a feed', async () => {
    mockJobs.jobs_statusBatch.mockResolvedValue(new Map([[10, 'running']]));
    mockJobs.job_cancel.mockResolvedValue(Ok(true));
    expect(await provider.feedJobs_cancel('/proc/jobs/feed_5')).toBe(true);
    expect(mockJobs.job_cancel).toHaveBeenCalledWith(10);
    expect(cache.feed_get(5)).toBeUndefined();
  });

  it('fails the feed removal when a job cancel fails, keeping the feed', async () => {
    mockJobs.jobs_statusBatch.mockResolvedValue(new Map([[10, 'running']]));
    mockJobs.job_cancel.mockResolvedValue(Err());
    expect(await provider.feedJobs_cancel('/proc/jobs/feed_5')).toBe(false);
    expect(cache.feed_get(5)).toBeDefined();
  });

  it('cancels a non-terminal instance', async () => {
    mockJobs.job_statusFetch.mockResolvedValue(Ok('running'));
    mockJobs.job_cancel.mockResolvedValue(Ok(true));
    expect(await provider.feedJobs_cancel('/proc/jobs/feed_5/pl-x_10')).toBe(true);
    expect(mockJobs.job_cancel).toHaveBeenCalledWith(10);
  });

  it('deletes a terminal instance and drops it from the cache', async () => {
    mockJobs.job_statusFetch.mockResolvedValue(Ok('finishedSuccessfully'));
    mockJobs.job_delete.mockResolvedValue(Ok(true));
    expect(await provider.feedJobs_cancel('/proc/jobs/feed_5/pl-x_10')).toBe(true);
    expect(cache.instance_get(10)).toBeUndefined();
  });

  it('returns false for an unparseable path', async () => {
    expect(await provider.feedJobs_cancel('/proc/jobs/garbage')).toBe(false);
  });

  it('cp/mv/touch/upload/write are unsupported; mkdir is refused by the dispatcher', async () => {
    expect((await provider.cp('a', 'b')).ok).toBe(false);
    expect(await provider.mv('a', 'b')).toBe(false);
    expect(await provider.touch('a')).toBe(false);
    expect(await provider.upload('a', 'b')).toBe(false);
    expect((await provider.write('a', 'b')).ok).toBe(false);
  });
});

describe('cache build / warmup / refresh', () => {
  it('indexes every feed when the server caps pages below the requested limit', async () => {
    const privateRows = [
      { id: 1, name: 'mine', owner_username: 'chris', public: false },
      { id: 2, name: 'shared-public', owner_username: 'other', public: true },
    ];
    const publicRows = [
      { id: 2, name: 'shared-public', owner_username: 'other', public: true },
      { id: 3, name: 'public-only', owner_username: 'another', public: true },
    ];
    const client = {
      getFeeds: jest.fn().mockImplementation(({ offset }: { offset: number }) => ({
        data: privateRows.slice(offset, offset + 1),
        totalCount: privateRows.length,
      })),
      getPublicFeeds: jest.fn().mockImplementation(({ offset }: { offset: number }) => ({
        data: publicRows.slice(offset, offset + 1),
        totalCount: publicRows.length,
      })),
      getPluginInstances: jest.fn(),
    };
    mockClientGet.mockResolvedValue(client);

    await procCache_refresh();

    expect(cache.feedIDs_get().sort()).toEqual([1, 2, 3]);
    expect(cache.feed_get(1)).toMatchObject({ ownerUsername: 'chris', public: false });
    expect(cache.feed_get(2)).toMatchObject({ ownerUsername: 'other', public: true });
    expect(cache.feed_get(3)).toMatchObject({ ownerUsername: 'another', public: true });
    expect(client.getFeeds).toHaveBeenCalledTimes(2);
    expect(client.getPublicFeeds).toHaveBeenCalledTimes(2);
  });

  it('a /proc read that arrives during the feed-index walk joins it instead of walking again', async () => {
    let releasePage: ((page: { data: unknown[]; totalCount: number }) => void) | undefined;
    const page: Promise<{ data: unknown[]; totalCount: number }> = new Promise((resolve) => {
      releasePage = resolve;
    });
    const client = {
      getFeeds: jest.fn().mockReturnValueOnce(page).mockResolvedValue({ data: [], totalCount: 1 }),
      getPublicFeeds: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      getPluginInstances: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
    };
    mockClientGet.mockResolvedValue(client);

    const walk: Promise<number[]> = procCache_refresh();
    const read = provider.list('/proc/jobs');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(client.getFeeds).toHaveBeenCalledTimes(1);

    releasePage?.({ data: [{ id: 4, name: 'four', owner_username: 'chris' }], totalCount: 1 });
    await walk;
    const listed = await read;
    expect(listed.ok).toBe(true);
    expect(cache.feedIDs_get()).toEqual([4]);
    // One walk: the first page fetched once, never a second walk from the read.
    expect(client.getFeeds.mock.calls.filter((call: unknown[]) => (call[0] as { offset: number }).offset === 0)).toHaveLength(1);
  });

  it('joins the active topology sweep without starting another', async () => {
    cache.built_set();
    let releasePage: ((page: { data: unknown[]; totalCount: number }) => void) | undefined;
    const page: Promise<{ data: unknown[]; totalCount: number }> = new Promise((resolve) => {
      releasePage = resolve;
    });
    const client = {
      getFeeds: jest.fn().mockResolvedValue({ data: [] }),
      getPluginInstances: jest.fn().mockReturnValue(page),
    };
    mockClientGet.mockResolvedValue(client);

    const sweep: Promise<void> = procTopology_warmup();
    const waiter: Promise<void> = procTopology_await();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(client.getPluginInstances).toHaveBeenCalledTimes(1);
    expect(procTopology_status()).toEqual({ state: 'running', failure: undefined });
    expect(cache.warmupProgress_get().active).toBe(false);
    releasePage?.({ data: [], totalCount: 0 });
    await Promise.all([sweep, waiter]);
    expect(client.getPluginInstances).toHaveBeenCalledTimes(1);
    expect(procTopology_status()).toEqual({ state: 'complete', failure: undefined });
  });

  it('preserves a failure that occurs before the first topology page', async () => {
    cache.built_set();
    const client = {
      getPluginInstances: jest.fn().mockRejectedValue(new Error('connection lost')),
    };
    mockClientGet.mockResolvedValue(client);

    await expect(procTopology_warmup()).rejects.toThrow('connection lost');

    expect(cache.warmupProgress_get().active).toBe(false);
    expect(procTopology_status()).toEqual({ state: 'failed', failure: 'connection lost' });
  });

  it('clears active prompt progress when a later topology page fails', async () => {
    cache.built_set();
    interface TestInstancePage {
      data: unknown[];
      totalCount: number;
    }
    const page_fetch = jest.fn<Promise<TestInstancePage>, [{ offset: number }]>()
      .mockResolvedValueOnce({
        data: [{ id: 10, feed_id: 5, previous_id: null, plugin_name: 'pl-x', status: 'started' }],
        totalCount: 2,
      })
      .mockRejectedValueOnce(new Error('second page lost'));
    mockClientGet.mockResolvedValue({ getPluginInstances: page_fetch });

    await expect(procTopology_warmup()).rejects.toThrow('second page lost');

    expect(cache.warmupProgress_get()).toEqual({ loaded: 1, total: 2, active: false });
    expect(procTopology_status()).toEqual({ state: 'failed', failure: 'second page lost' });
  });

  it('retries a failed topology sweep from the failed page', async () => {
    cache.built_set();
    cache.feed_add(feed({ id: 5 }));
    let failSecondPage: boolean = true;
    const pageFetch = jest.fn(({ offset }: { offset: number }) => {
      if (offset === 0) {
        return Promise.resolve({
          data: [{ id: 10, feed_id: 5, previous_id: null, plugin_name: 'pl-root', status: 'started' }],
          totalCount: 2,
        });
      }
      if (failSecondPage) {
        failSecondPage = false;
        return Promise.reject(new Error('second page lost'));
      }
      return Promise.resolve({
        data: [{ id: 11, feed_id: 5, previous_id: 10, plugin_name: 'pl-child', status: 'scheduled' }],
        totalCount: 2,
      });
    });
    mockClientGet.mockResolvedValue({ getPluginInstances: pageFetch });

    await expect(procTopology_warmup()).rejects.toThrow('second page lost');
    await procTopology_retry();

    expect(pageFetch.mock.calls.map(([params]) => params.offset)).toEqual([0, 1, 1]);
    expect(cache.instance_get(10)).toBeDefined();
    expect(cache.instance_get(11)).toBeDefined();
    expect(cache.warmupComplete).toBe(true);
    expect(procTopology_status()).toEqual({ state: 'complete', failure: undefined });
  });

  it('discards a failed continuation when a full refresh starts over', async () => {
    cache.built_set();
    mockClientGet.mockResolvedValue({
      getPluginInstances: jest.fn().mockRejectedValue(new Error('page lost')),
    });
    await expect(procTopology_warmup()).rejects.toThrow('page lost');

    mockClientGet.mockResolvedValue(pagingClient([], []));
    await procCache_refresh();

    expect(() => procTopology_retry()).toThrow('no failed topology sweep to retry');
    expect(procTopology_status()).toEqual({ state: 'idle', failure: undefined });
  });

  it('procTopology_warmup sweeps instances and completes', async () => {
    cache.built_set();
    cache.feed_add(feed({ id: 5 }));
    mockClientGet.mockResolvedValue(
      pagingClient([], [{
        id: 10, feed_id: 5, previous_id: null, plugin_name: 'pl-x', status: 's',
        start_date: '2026-08-31T10:00:00Z', end_date: '2026-08-31T10:01:00Z', size: 2048, compute_resource_name: 'galena',
      }])
    );
    await procTopology_warmup();
    expect(cache.warmupComplete).toBe(true);
    expect(cache.warmupProgress_get()).toEqual({ loaded: 1, total: 1, active: false });
    expect(cache.instance_get(10)).toBeDefined();
    // Execution metrics ride the same warmup rows — captured, not fetched.
    expect(cache.instance_get(10)).toMatchObject({
      startedAt: '2026-08-31T10:00:00Z',
      finishedAt: '2026-08-31T10:01:00Z',
      outputBytes: 2048,
      computeResource: 'galena',
    });
    expect(cache.feed_get(5)).toBeDefined();
  });

  it('procTopology_warmup bails when not connected', async () => {
    cache.built_set();
    mockClientGet.mockResolvedValue(null);
    await expect(procTopology_warmup()).rejects.toThrow('not connected');
    expect(cache.warmupComplete).toBe(false);
  });

  it('procFeed_ensureLoaded adds a placeholder feed and loads instances', async () => {
    cache.built_set();
    mockClientGet.mockResolvedValue(
      pagingClient([], [{ id: 20, feed_id: 7, previous_id: null, plugin_name: 'pl-y', status: 's' }])
    );
    await procFeed_ensureLoaded(7);
    expect(cache.feed_get(7)).toBeDefined();
    expect(cache.instance_get(20)).toBeDefined();
  });

  it('loads complete targeted feed topology when server pages are capped', async () => {
    cache.built_set();
    const rows = [
      { id: 20, feed_id: 7, previous_id: null, plugin_name: 'pl-root', status: 'started' },
      { id: 21, feed_id: 7, previous_id: 20, plugin_name: 'pl-child', status: 'scheduled' },
    ];
    const client = {
      getPluginInstances: jest.fn().mockImplementation(({ offset }: { offset: number }) => ({
        data: rows.slice(offset, offset + 1),
        totalCount: rows.length,
      })),
    };
    mockClientGet.mockResolvedValue(client);

    await feedInstances_ensureLoaded(7);

    expect(cache.instance_get(20)).toBeDefined();
    expect(cache.instance_get(21)).toBeDefined();
    expect(cache.topologyLoaded_has(7)).toBe(true);
    expect(client.getPluginInstances).toHaveBeenCalledTimes(2);
  });

  it('refreshes every targeted status when server pages are capped', async () => {
    cache.instance_add({
      id: 20, feedID: 7, parentID: null, pluginName: 'pl-root', params: null, status: 'started',
    });
    cache.instance_add({
      id: 21, feedID: 7, parentID: 20, pluginName: 'pl-child', params: null, status: 'scheduled',
    });
    const rows = [
      { id: 20, feed_id: 7, previous_id: null, plugin_name: 'pl-root', status: 'finishedSuccessfully' },
      { id: 21, feed_id: 7, previous_id: 20, plugin_name: 'pl-child', status: 'started' },
    ];
    const client = {
      getPluginInstances: jest.fn().mockImplementation(({ offset }: { offset: number }) => ({
        data: rows.slice(offset, offset + 1),
        totalCount: rows.length,
      })),
    };
    mockClientGet.mockResolvedValue(client);

    await feedStatus_refresh(7);

    expect(cache.instance_get(20)?.status).toBe('finishedSuccessfully');
    expect(cache.instance_get(21)?.status).toBe('started');
    expect(client.getPluginInstances).toHaveBeenCalledTimes(2);
  });

  it('procCache_refresh(feedID) re-fetches a single feed', async () => {
    cache.built_set();
    cache.feed_add(feed({ id: 5, title: 'old' }));
    mockClientGet.mockResolvedValue(
      pagingClient([{ id: 5, name: 'new', finished_jobs: 3 }], [])
    );
    await procCache_refresh(5);
    expect(cache.feed_get(5)?.title).toBe('new');
  });

  it('feedMeta_ensure skips fetching when real metadata is already cached', async () => {
    cache.feed_add(feed({ id: 5, title: 'known', creationDate: '2026-01-01', finishedJobs: 1 }));
    const client = pagingClient([{ id: 5, name: 'fresh', finished_jobs: 9 }], []);
    mockClientGet.mockResolvedValue(client);
    await feedMeta_ensure(5);
    expect(client.getFeeds).not.toHaveBeenCalled();
    expect(cache.feed_get(5)?.title).toBe('known');
  });

  it('feedMeta_ensure fetches counters for a missing feed', async () => {
    mockClientGet.mockResolvedValue(pagingClient([{ id: 8, name: 'new', finished_jobs: 3, creation_date: '2026-01-01' }], []));
    await feedMeta_ensure(8);
    expect(cache.feed_get(8)?.title).toBe('new');
    expect(cache.feed_get(8)?.finishedJobs).toBe(3);
  });

  it('feedMeta_ensure refreshes a zero-counter placeholder feed', async () => {
    cache.feed_add(feed({ id: 8, title: 'placeholder', creationDate: '' }));
    mockClientGet.mockResolvedValue(pagingClient([{ id: 8, name: 'real', finished_jobs: 2, creation_date: '2026-01-01' }], []));
    await feedMeta_ensure(8);
    expect(cache.feed_get(8)?.title).toBe('real');
    expect(cache.feed_get(8)?.finishedJobs).toBe(2);
  });

  it('procCache_refresh() rebuilds the whole feed index', async () => {
    mockClientGet.mockResolvedValue(pagingClient([{ id: 1, name: 'f1' }], []));
    await procCache_refresh();
    expect(cache.built).toBe(true);
    expect(cache.feed_get(1)).toBeDefined();
  });

  it('returns only new, changed, or active feeds as restored-cache reconciliation targets', async () => {
    cache.feed_add(feed({ id: 1, title: 'settled', finishedJobs: 4 }));
    cache.feed_add(feed({ id: 2, title: 'changed', finishedJobs: 1 }));
    cache.feed_add(feed({ id: 3, title: 'active', startedJobs: 1 }));
    mockClientGet.mockResolvedValue(pagingClient([
      { id: 1, name: 'settled', finished_jobs: 4 },
      { id: 2, name: 'changed', finished_jobs: 2 },
      { id: 3, name: 'active', started_jobs: 1 },
      { id: 4, name: 'new' },
    ], []));

    const targets: number[] = await procCache_refresh();

    expect(targets).toEqual([2, 3, 4]);
  });

  it('reconciles only supplied feeds without opening a global instance sweep', async () => {
    cache.feed_add(feed({ id: 5, title: 'target' }));
    const client = pagingClient([{ id: 5, name: 'target' }], [
      { id: 10, feed_id: 5, previous_id: null, plugin_name: 'pl-x', status: 'finishedSuccessfully' },
    ]);
    mockClientGet.mockResolvedValue(client);

    await procTopology_reconcileFeeds([5]);

    expect(client.getPluginInstances).toHaveBeenCalledWith({ feed_id: 5, limit: 100, offset: 0 });
    expect(client.getPluginInstances).not.toHaveBeenCalledWith({ limit: 100, offset: 0 });
    expect(cache.instance_get(10)).toBeDefined();
  });

  it('retries a failed scoped reconciliation from its retained feed set', async () => {
    cache.feed_add(feed({ id: 5, title: 'target' }));
    const client = pagingClient([{ id: 5, name: 'target' }], []);
    client.getPluginInstances
      .mockRejectedValueOnce(new Error('temporary connection loss'))
      .mockResolvedValueOnce({
        data: [{ id: 10, feed_id: 5, previous_id: null, plugin_name: 'pl-x', status: 'finishedSuccessfully' }],
        totalCount: 1,
      });
    mockClientGet.mockResolvedValue(client);

    await expect(procTopology_reconcileFeeds([5])).rejects.toThrow('temporary connection loss');
    expect(procTopology_status()).toEqual({ state: 'failed', failure: 'temporary connection loss' });

    await procTopology_retry();

    expect(cache.instance_get(10)).toBeDefined();
  });

  it('resets completed topology lifecycle before a full cache rebuild', async () => {
    cache.built_set();
    mockClientGet.mockResolvedValue(pagingClient([], []));
    await procTopology_warmup();
    expect(procTopology_status().state).toBe('complete');

    mockClientGet.mockResolvedValue(pagingClient([{ id: 2, name: 'fresh' }], []));
    await procCache_refresh();

    expect(procTopology_status()).toEqual({ state: 'idle', failure: undefined });
    expect(cache.warmupComplete).toBe(false);
    expect(cache.feed_get(2)).toBeDefined();
  });

  it('procCache_build (via refresh) records an error when not connected', async () => {
    const { errorStack } = jest.requireActual('@fnndsc/cumin');
    errorStack.stack_clear();
    mockClientGet.mockResolvedValue(null);
    await expect(procCache_refresh()).rejects.toThrow('not connected');
    expect(errorStack.stack_search('not connected').length).toBeGreaterThan(0);
  });
});

describe('visit-driven freshness', () => {
  /** A client whose instance listing answers by filter: since-cursor rows, active rows, or everything. */
  function deltaClient(
    feedRow: Record<string, unknown>,
    rows: { since: unknown[]; active: unknown[]; all?: unknown[] },
  ) {
    return {
      getFeeds: jest.fn().mockImplementation((params: Record<string, unknown>) =>
        ({ data: params.id !== undefined ? [feedRow] : [], totalCount: 1 })),
      getPublicFeeds: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      getPluginInstances: jest.fn().mockImplementation((params: Record<string, unknown>) => {
        const data: unknown[] = params.active === true
          ? rows.active
          : params.min_end_date !== undefined ? rows.since : (rows.all ?? rows.since);
        return { data, totalCount: data.length };
      }),
      getPluginInstance: jest.fn(),
    };
  }

  function loadedFeed(over: Partial<ProcFeed> = {}): void {
    cache.feed_add(feed({ id: 7, finishedJobs: 1, ...over }));
    cache.instance_add({
      id: 70, feedID: 7, parentID: null, pluginName: 'pl-dircopy', params: null,
      status: 'finishedSuccessfully', startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:01:00Z',
    });
    cache.topologyLoaded_mark(7);
  }

  it('a settled feed within its re-check window costs nothing', async () => {
    loadedFeed();
    const client = deltaClient({ id: 7, name: 'f', finished_jobs: 1 }, { since: [], active: [] });
    mockClientGet.mockResolvedValue(client);

    expect(await feedVisit_sync(7)).toBe(true);
    expect(client.getFeeds).toHaveBeenCalledTimes(1);
    expect(await feedVisit_sync(7)).toBe(true);
    expect(client.getFeeds).toHaveBeenCalledTimes(1);
    expect(client.getPluginInstances).not.toHaveBeenCalled();
  });

  it('visits within a second of each other on an active feed share one sync', async () => {
    loadedFeed({ startedJobs: 1 });
    cache.instance_add({ id: 71, feedID: 7, parentID: 70, pluginName: 'pl-ctl', params: null, status: 'started' });
    const client = deltaClient({ id: 7, name: 'f', finished_jobs: 1, started_jobs: 1 }, { since: [], active: [] });
    mockClientGet.mockResolvedValue(client);
    const now: number = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);

    await feedVisit_sync(7);
    await feedVisit_sync(7);
    expect(client.getFeeds).toHaveBeenCalledTimes(1);
    nowSpy.mockReturnValue(now + 1500);
    await feedVisit_sync(7);
    expect(client.getFeeds).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('a settled feed past its window pays one feed-row fetch, and nothing more when counters hold', async () => {
    loadedFeed();
    const client = deltaClient({ id: 7, name: 'f', finished_jobs: 1 }, { since: [], active: [] });
    mockClientGet.mockResolvedValue(client);
    const now: number = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);

    await feedVisit_sync(7);
    nowSpy.mockReturnValue(now + FEED_RECHECK_MS + 1);
    await feedVisit_sync(7);
    expect(client.getFeeds).toHaveBeenCalledTimes(2);
    expect(client.getPluginInstances).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  it('appended work on a settled feed is found through the counters: a min_end_date delta from the cached cursor', async () => {
    loadedFeed();
    const client = deltaClient({ id: 7, name: 'f', finished_jobs: 1, scheduled_jobs: 1 }, {
      since: [{ id: 71, feed_id: 7, previous_id: 70, plugin_name: 'pl-new', status: 'scheduled', start_date: '2026-09-02T11:00:00Z', end_date: '2026-09-02T11:00:00Z' }],
      active: [{ id: 71, feed_id: 7, previous_id: 70, plugin_name: 'pl-new', status: 'scheduled', start_date: '2026-09-02T11:00:00Z', end_date: '2026-09-02T11:00:00Z' }],
    });
    mockClientGet.mockResolvedValue(client);

    await feedVisit_sync(7);
    expect(client.getPluginInstances).toHaveBeenCalledWith(expect.objectContaining({ feed_id: 7, min_end_date: '2026-09-02T10:01:00Z' }));
    expect(cache.instance_get(71)).toMatchObject({ parentID: 70, pluginName: 'pl-new', status: 'scheduled' });
    expect(cache.children_get(70)).toEqual([71]);
    expect(cache.feed_get(7)?.scheduledJobs).toBe(1);
    expect(feedCached_isSettled(cache, 7)).toBe(false);
  });

  it('a growing feed advances its cursor and freezes finished nodes on the next visit', async () => {
    loadedFeed({ startedJobs: 1 });
    cache.instance_add({ id: 71, feedID: 7, parentID: 70, pluginName: 'pl-ctl', params: null, status: 'started', startedAt: '2026-09-02T10:02:00Z' });
    const client = deltaClient({ id: 7, name: 'f', finished_jobs: 1, started_jobs: 1 }, {
      since: [{ id: 72, feed_id: 7, previous_id: 71, plugin_name: 'pl-child', status: 'created', start_date: '2026-09-02T10:05:00Z', end_date: '2026-09-02T10:05:00Z' }],
      active: [
        { id: 71, feed_id: 7, previous_id: 70, plugin_name: 'pl-ctl', status: 'started', start_date: '2026-09-02T10:02:00Z' },
        { id: 72, feed_id: 7, previous_id: 71, plugin_name: 'pl-child', status: 'created', start_date: '2026-09-02T10:05:00Z' },
      ],
    });
    mockClientGet.mockResolvedValue(client);

    const now: number = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    await feedVisit_sync(7);
    expect(client.getPluginInstances).toHaveBeenNthCalledWith(1, expect.objectContaining({ min_end_date: '2026-09-02T10:02:00Z' }));
    expect(cache.instance_get(72)?.status).toBe('created');
    nowSpy.mockReturnValue(now + 2000);

    client.getPluginInstances.mockImplementation((params: Record<string, unknown>) => {
      const data: unknown[] = params.active === true
        ? []
        : [{ id: 72, feed_id: 7, previous_id: 71, plugin_name: 'pl-child', status: 'finishedSuccessfully', start_date: '2026-09-02T10:05:00Z', end_date: '2026-09-02T10:09:00Z' },
           { id: 71, feed_id: 7, previous_id: 70, plugin_name: 'pl-ctl', status: 'finishedSuccessfully', start_date: '2026-09-02T10:02:00Z', end_date: '2026-09-02T10:10:00Z' }];
      return { data, totalCount: data.length };
    });
    await feedVisit_sync(7);
    expect(client.getPluginInstances).toHaveBeenNthCalledWith(3, expect.objectContaining({ min_end_date: '2026-09-02T10:05:00Z' }));
    expect(cache.instance_get(71)?.status).toBe('finishedSuccessfully');
    expect(cache.instance_get(72)?.finishedAt).toBe('2026-09-02T10:09:00Z');
    nowSpy.mockRestore();
  });

  it('a failed sync leaves the cache as it was and warns', async () => {
    loadedFeed({ startedJobs: 1 });
    mockClientGet.mockResolvedValue({ getFeeds: jest.fn().mockRejectedValue(new Error('cube down')) });
    await expect(feedVisit_sync(7)).resolves.toBe(false);
    expect(cache.instance_get(70)?.status).toBe('finishedSuccessfully');
  });

  it('/proc/jobs picks up feeds newer than the highest known id, from both collections', async () => {
    cache.feed_add(feed({ id: 3, title: 'old' }));
    cache.built_set();
    cache.lifecycle_set('current');
    // Each collection's newest page, unfiltered and newest first.
    const client = {
      getFeeds: jest.fn().mockResolvedValue({ data: [{ id: 9, name: 'fresh', owner_username: 'chris' }, { id: 3, name: 'old', owner_username: 'chris' }], totalCount: 2 }),
      getPublicFeeds: jest.fn().mockResolvedValue({ data: [{ id: 8, name: 'pub', owner_username: 'other', public: true }], totalCount: 1 }),
      getPluginInstances: jest.fn(),
    };
    mockClientGet.mockResolvedValue(client);
    jest.spyOn(Date, 'now').mockReturnValue(1);

    const r = await provider.list('/proc/jobs');
    const names: string[] = (r.ok ? r.value : []).map((i) => i.name).sort();
    expect(names).toEqual(['feed_3', 'feed_8', 'feed_9']);
    expect(client.getFeeds).toHaveBeenCalledTimes(1);
    expect(client.getFeeds).toHaveBeenCalledWith(expect.objectContaining({ limit: ROSTER_DELTA_PAGE, offset: 0 }), FEED_LIST_TIMEOUT_MS);
    expect(client.getFeeds).toHaveBeenCalledWith(expect.not.objectContaining({ min_id: expect.anything() }), FEED_LIST_TIMEOUT_MS);
    jest.restoreAllMocks();
  });

  it('/proc/jobs answers from the cache when CUBE is slow, and the sync lands behind it', async () => {
    cache.feed_add(feed({ id: 3, title: 'old' }));
    cache.built_set();
    cache.lifecycle_set('current');
    let release: () => void = (): void => undefined;
    const slow = new Promise<{ data: unknown[]; totalCount: number }>((resolve) => { release = (): void => resolve({ data: [{ id: 9, name: 'fresh', owner_username: 'chris' }, { id: 3, name: 'old', owner_username: 'chris' }], totalCount: 2 }); });
    const client = { getFeeds: jest.fn(() => slow), getPublicFeeds: jest.fn(() => slow.then(() => ({ data: [], totalCount: 0 }))), getPluginInstances: jest.fn() };
    mockClientGet.mockResolvedValue(client);
    jest.spyOn(Date, 'now').mockReturnValue(1);

    const started: number = performance.now();
    const r = await provider.list('/proc/jobs');
    const waited: number = performance.now() - started;
    expect((r.ok ? r.value : []).map((i) => i.name)).toEqual(['feed_3']);
    expect(waited).toBeLessThan(ROSTER_LIST_BUDGET_MS + 200);
    expect(cache.rosterSync_get()).toBe('delta');            // still running, behind the answer

    release();
    for (let i = 0; i < 20 && cache.rosterSync_get() !== null; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(cache.feedIDs_get().sort()).toEqual([3, 9]);     // landed for the next look
    jest.restoreAllMocks();
  });

  /** A roster walked whole once, so its yardsticks are known. */
  async function rosterWalked(client: { getFeeds: jest.Mock; getPublicFeeds: jest.Mock }): Promise<void> {
    cache.built_set();
    cache.lifecycle_set('current');
    mockClientGet.mockResolvedValue({ ...client, getPluginInstances: jest.fn() });
    await procRoster_sync(true);
    client.getFeeds.mockClear();
    client.getPublicFeeds.mockClear();
  }

  it('a feed shared to this identity, with an old id, is seen on the next visit: the total moved, so the visit walks whole', async () => {
    const own = [{ id: 7, name: 'mine', owner_username: 'chris' }, { id: 3, name: 'older', owner_username: 'chris' }];
    const client = {
      getFeeds: jest.fn().mockResolvedValue({ data: own, totalCount: own.length }),
      getPublicFeeds: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
    };
    await rosterWalked(client);
    expect(cache.feedIDs_get().sort()).toEqual([3, 7]);

    // A colleague shares feed 5: no new id, one more row in the collection.
    const shared = [{ id: 7, name: 'mine', owner_username: 'chris' }, { id: 5, name: 'shared', owner_username: 'sandip' }, { id: 3, name: 'older', owner_username: 'chris' }];
    client.getFeeds.mockResolvedValue({ data: shared, totalCount: shared.length });
    jest.spyOn(Date, 'now').mockReturnValue(1);

    const r = await provider.list('/proc/jobs');
    expect((r.ok ? r.value : []).map((i) => i.name).sort()).toEqual(['feed_3', 'feed_5', 'feed_7']);
    expect(cache.rosterSync_get()).toBeNull();
    // The newest page first, then the whole walk the moved total asked for.
    expect(client.getFeeds.mock.calls[0]?.[0]).toMatchObject({ limit: ROSTER_DELTA_PAGE, offset: 0 });
    expect(client.getFeeds.mock.calls.length).toBeGreaterThan(1);
    jest.restoreAllMocks();
  });

  it('a feed unshared or deleted leaves the roster on the next visit the same way', async () => {
    const own = [{ id: 7, name: 'mine', owner_username: 'chris' }, { id: 5, name: 'shared', owner_username: 'sandip' }];
    const client = {
      getFeeds: jest.fn().mockResolvedValue({ data: own, totalCount: own.length }),
      getPublicFeeds: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
    };
    await rosterWalked(client);
    client.getFeeds.mockResolvedValue({ data: [own[0]], totalCount: 1 });
    jest.spyOn(Date, 'now').mockReturnValue(1);

    await procRoster_sync();
    expect(cache.feedIDs_get()).toEqual([7]);
    jest.restoreAllMocks();
  });

  it('a steady total with new ids is a delta: the newer rows are adopted and nothing else is walked', async () => {
    const own = [{ id: 7, name: 'mine', owner_username: 'chris' }];
    const client = {
      getFeeds: jest.fn().mockResolvedValue({ data: own, totalCount: 1 }),
      getPublicFeeds: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
    };
    await rosterWalked(client);
    client.getFeeds.mockResolvedValue({ data: [{ id: 9, name: 'new', owner_username: 'chris' }, ...own], totalCount: 2 });
    jest.spyOn(Date, 'now').mockReturnValue(1);

    expect(await procRoster_sync()).toEqual([9]);
    expect(cache.feedIDs_get().sort()).toEqual([7, 9]);
    expect(client.getFeeds).toHaveBeenCalledTimes(1);
    expect(cache.arrivals_recent(1)).toEqual([9]);
    jest.restoreAllMocks();
  });

  it('a newest page that is all new, with more behind it, is followed by the walk of everything newer by id', async () => {
    const own = [{ id: 7, name: 'mine', owner_username: 'chris' }];
    const client = {
      getFeeds: jest.fn().mockResolvedValue({ data: own, totalCount: 1 }),
      getPublicFeeds: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
    };
    await rosterWalked(client);
    const burst = Array.from({ length: ROSTER_DELTA_PAGE + 5 }, (_: unknown, i: number) => ({ id: 100 + ROSTER_DELTA_PAGE + 5 - i, name: `b${i}`, owner_username: 'chris' }));
    client.getFeeds.mockImplementation(async (params: Record<string, unknown>) => {
      if (params.min_id !== undefined) return { data: burst.filter((f) => f.id >= Number(params.min_id)), totalCount: burst.length };
      return { data: burst.slice(0, Number(params.limit)), totalCount: burst.length + own.length };
    });
    jest.spyOn(Date, 'now').mockReturnValue(1);

    const added: number[] = await procRoster_sync();
    expect(added.length).toBe(burst.length);
    expect(client.getFeeds).toHaveBeenCalledWith(expect.objectContaining({ min_id: 8 }), FEED_LIST_TIMEOUT_MS);
    expect(cache.feedIDs_get().length).toBe(burst.length + 1);
    jest.restoreAllMocks();
  });

  it('an aged roster is walked whole on visit, and feeds gone from CUBE leave the roster', async () => {
    cache.feed_add(feed({ id: 3, title: 'gone' }));
    cache.feed_add(feed({ id: 4, title: 'kept' }));
    cache.built_set();
    cache.lifecycle_set('current');
    const client = {
      getFeeds: jest.fn().mockImplementation((params: Record<string, unknown>) =>
        ({ data: params.min_id === undefined ? [{ id: 4, name: 'kept', owner_username: 'chris' }] : [], totalCount: 1 })),
      getPublicFeeds: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      getPluginInstances: jest.fn(),
    };
    mockClientGet.mockResolvedValue(client);
    jest.spyOn(Date, 'now').mockReturnValue(ROSTER_FULL_WALK_MS + 1);

    await procRoster_sync();
    expect(cache.feedIDs_get()).toEqual([4]);
    expect(client.getFeeds).toHaveBeenCalledWith(expect.not.objectContaining({ min_id: expect.anything() }), FEED_LIST_TIMEOUT_MS);
    jest.restoreAllMocks();
  });

  it('a roster still owned by warmup is left alone', async () => {
    cache.feed_add(feed({ id: 3 }));
    cache.built_set();
    cache.lifecycle_set('reconciling');
    const client = { getFeeds: jest.fn(), getPublicFeeds: jest.fn(), getPluginInstances: jest.fn() };
    mockClientGet.mockResolvedValue(client);
    await procRoster_sync();
    expect(client.getFeeds).not.toHaveBeenCalled();
  });
});

describe('roster boot sync', () => {
  it('brings a restored roster into service on a delta and marks the cache built', async () => {
    cache.feed_add(feed({ id: 3, title: 'restored' }));
    cache.lifecycle_set('restored');
    const client = {
      getFeeds: jest.fn().mockResolvedValue({ data: [{ id: 9, name: 'fresh', owner_username: 'chris' }, { id: 3, name: 'restored', owner_username: 'chris' }], totalCount: 2 }),
      getPublicFeeds: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      getPluginInstances: jest.fn(),
    };
    mockClientGet.mockResolvedValue(client);

    expect(await procRoster_bootSync()).toEqual([9]);
    expect(cache.built).toBe(true);
    expect(cache.feedIDs_get().sort()).toEqual([3, 9]);
    // One newest-page read per collection; a restored roster has no yardstick, so nothing is promoted.
    expect(client.getFeeds).toHaveBeenCalledTimes(1);
    expect(client.getFeeds).toHaveBeenCalledWith(expect.objectContaining({ limit: ROSTER_DELTA_PAGE, offset: 0 }), FEED_LIST_TIMEOUT_MS);
  });

  it('refuses when nothing was restored, so the host falls back to the full build', async () => {
    await expect(procRoster_bootSync()).rejects.toThrow('no restored roster');
  });

  it('a forced roster sync reports the reconciliation targets of the full walk', async () => {
    cache.feed_add(feed({ id: 3, title: 'old', finishedJobs: 1 }));
    cache.built_set();
    cache.lifecycle_set('current');
    const client = {
      getFeeds: jest.fn().mockResolvedValue({ data: [{ id: 3, name: 'old', owner_username: 'chris', finished_jobs: 2 }, { id: 5, name: 'new', owner_username: 'chris' }], totalCount: 2 }),
      getPublicFeeds: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      getPluginInstances: jest.fn(),
    };
    mockClientGet.mockResolvedValue(client);
    expect((await procRoster_sync(true)).sort()).toEqual([3, 5]);
  });
});

describe('topology catch-up', () => {
  /** A client whose feed index and per-feed job pages are fixed. */
  function catchupClient(feedRows: unknown[], jobsByFeed: Record<number, unknown[]>) {
    return {
      getFeeds: jest.fn().mockImplementation((params: Record<string, unknown>) =>
        ({ data: params.min_id === undefined ? feedRows : [], totalCount: feedRows.length })),
      getPublicFeeds: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      getPluginInstances: jest.fn().mockImplementation((params: Record<string, unknown>) => {
        const rows: unknown[] = jobsByFeed[Number(params.feed_id)] ?? [];
        return { data: rows, totalCount: rows.length };
      }),
    };
  }

  it('lands the topology of roster feeds the sweep never saw, one walk at a time', async () => {
    cache.feed_add(feed({ id: 3, title: 'restored, no shard' }));
    cache.built_set();
    cache.lifecycle_set('current');
    cache.warmup_complete();
    const client = catchupClient(
      [{ id: 3, name: 'restored, no shard', owner_username: 'chris' }, { id: 7, name: 'arrived', owner_username: 'chris' }],
      { 3: [{ id: 30, feed_id: 3, plugin_name: 'pl-a', status: 'finishedSuccessfully', size: 10 }],
        7: [{ id: 70, feed_id: 7, plugin_name: 'pl-b', status: 'finishedSuccessfully', size: 20 }] },
    );
    mockClientGet.mockResolvedValue(client);

    await procRoster_sync(true);
    expect(procTopologyCatchup_status().running).toBe(true);
    await procTopologyCatchup_await();

    expect(cache.topologyLoaded_has(3)).toBe(true);
    expect(cache.topologyLoaded_has(7)).toBe(true);
    expect(cache.instance_get(30)?.outputBytes).toBe(10);
    expect(cache.instance_get(70)?.outputBytes).toBe(20);
    expect(client.getPluginInstances).toHaveBeenCalledWith(expect.objectContaining({ feed_id: 3 }));
    expect(client.getPluginInstances).toHaveBeenCalledWith(expect.objectContaining({ feed_id: 7 }));
    expect(procTopologyCatchup_status()).toEqual({ queued: 0, running: false });
  });

  it('queues nothing while the global sweep is the one bringing topology in', async () => {
    cache.feed_add(feed({ id: 3 }));
    cache.built_set();
    cache.lifecycle_set('current');
    expect(cache.warmupComplete).toBe(false);
    expect(procTopologyCatchup_enqueue([3])).toBe(0);
    expect(procTopologyCatchup_status()).toEqual({ queued: 0, running: false });
  });

  it('skips a feed already loaded, already queued, or not in the roster', async () => {
    cache.feed_add(feed({ id: 3 }));
    cache.feed_add(feed({ id: 4 }));
    cache.topologyLoaded_mark(3);
    cache.built_set();
    cache.lifecycle_set('current');
    cache.warmup_complete();
    let release: (() => void) | undefined;
    const held: Promise<{ data: unknown[]; totalCount: number }> = new Promise((resolve) => {
      release = (): void => resolve({ data: [], totalCount: 0 });
    });
    mockClientGet.mockResolvedValue({ getPluginInstances: jest.fn().mockReturnValue(held) });

    expect(procTopologyCatchup_enqueue([3, 4, 4, 99])).toBe(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(procTopologyCatchup_enqueue([4])).toBe(0);
    release?.();
    await procTopologyCatchup_await();
    expect(cache.topologyLoaded_has(4)).toBe(true);
  });
});

describe('a feed the roster lacks', () => {
  it('ls /proc/jobs/feed_N asks CUBE and adopts a feed shared since the walk', async () => {
    cache.built_set();
    cache.lifecycle_set('current');
    const client = {
      getFeeds: jest.fn().mockImplementation(async (params: Record<string, unknown>) =>
        params.id === 4389 ? { data: [{ id: 4389, name: 'shared', owner_username: 'sandip', finished_jobs: 1 }], totalCount: 1 } : { data: [], totalCount: 0 }),
      getPublicFeeds: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      getPluginInstances: jest.fn().mockResolvedValue({ data: [{ id: 1, feed_id: 4389, plugin_name: 'pl-dircopy', status: 'finishedSuccessfully' }], totalCount: 1 }),
    };
    mockClientGet.mockResolvedValue(client);

    const r = await provider.list('/proc/jobs/feed_4389');
    expect(r.ok).toBe(true);
    expect((r.ok ? r.value : []).map((i) => i.name)).toContain('pl-dircopy_1');
    expect(cache.feed_get(4389)?.ownerUsername).toBe('sandip');
    expect(cache.arrivals_recent()).toEqual([4389]);
  });

  it('procFeed_probe answers null when CUBE lists the feed in neither collection, and adopts nothing', async () => {
    cache.built_set();
    const client = {
      getFeeds: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      getPublicFeeds: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
    };
    mockClientGet.mockResolvedValue(client);
    expect(await procFeed_probe(4389)).toBeNull();
    expect(cache.feed_get(4389)).toBeUndefined();
    expect(client.getPublicFeeds).toHaveBeenCalledWith(expect.objectContaining({ id: 4389 }), FEED_LIST_TIMEOUT_MS);
  });

  it('procFeed_probe finds a public feed through the public collection', async () => {
    cache.built_set();
    const client = {
      getFeeds: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      getPublicFeeds: jest.fn().mockResolvedValue({ data: [{ id: 42, name: 'open', owner_username: 'other', public: true }], totalCount: 1 }),
    };
    mockClientGet.mockResolvedValue(client);
    expect((await procFeed_probe(42))?.public).toBe(true);
    expect(cache.feed_get(42)?.title).toBe('open');
  });
});

describe('a jump target', () => {
  it('parses a feed name, a node name, and a bare number', () => {
    expect(procTarget_parse('feed_4389')).toEqual({ id: 4389, feed: true, node: false });
    expect(procTarget_parse('pl-dicom_repack_639204')).toEqual({ id: 639204, feed: false, node: true });
    expect(procTarget_parse('_639204')).toEqual({ id: 639204, feed: false, node: true });
    expect(procTarget_parse(' 4389 ')).toEqual({ id: 4389, feed: true, node: true });
    expect(procTarget_parse('brain')).toBeNull();
  });

  it('a bare number that is both a feed and a node answers both', async () => {
    cache.feed_add(feed({ id: 4389, title: '3d-anon' }));
    cache.feed_add(feed({ id: 12, title: 'old run' }));
    cache.instance_add({ id: 4389, feedID: 12, pluginName: 'pl-dircopy', previousID: null, status: 'finishedSuccessfully' } as unknown as Parameters<typeof cache.instance_add>[0]);
    const places = await procTarget_locate('4389');
    expect(places.map((p) => p.name).sort()).toEqual(['feed_4389', 'pl-dircopy_4389']);
    expect(places.find((p) => p.kind === 'node')).toMatchObject({ feedId: 12, nodeId: 4389, title: 'old run' });
  });

  it('a node the index lacks is asked of CUBE, and its feed adopted', async () => {
    cache.built_set();
    const client = {
      getPluginInstance: jest.fn().mockResolvedValue({ data: { id: 639204, feed_id: 4389, plugin_name: 'pl-dicom_repack' } }),
      getFeeds: jest.fn().mockImplementation(async (params: Record<string, unknown>) =>
        params.id === 4389 ? { data: [{ id: 4389, name: '3d-anon', owner_username: 'sandip.samal' }], totalCount: 1 } : { data: [], totalCount: 0 }),
      getPublicFeeds: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      getPluginInstances: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
    };
    mockClientGet.mockResolvedValue(client);
    const places = await procTarget_locate('pl-dicom_repack_639204');
    expect(places).toEqual([{ kind: 'node', feedId: 4389, nodeId: 639204, name: 'pl-dicom_repack_639204', title: '3d-anon' }]);
    expect(cache.feed_get(4389)?.ownerUsername).toBe('sandip.samal');
  });

  it('nothing visible answers nothing', async () => {
    cache.built_set();
    mockClientGet.mockResolvedValue({
      getPluginInstance: jest.fn().mockRejectedValue(new Error('404')),
      getFeeds: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      getPublicFeeds: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
    });
    expect(await procTarget_locate('999999')).toEqual([]);
  });
});

describe('NEW since the last visit', () => {
  it('a full walk marks a shared feed NEW, never one of mine or a public one', async () => {
    const own = [{ id: 7, name: 'mine', owner_username: 'chris' }];
    const client = {
      getFeeds: jest.fn().mockResolvedValue({ data: own, totalCount: own.length }),
      getPublicFeeds: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      getPluginInstances: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
    };
    cache.built_set();
    cache.lifecycle_set('current');
    mockClientGet.mockResolvedValue(client);
    await procRoster_sync(true);
    const after = [
      { id: 7, name: 'mine', owner_username: 'chris' },
      { id: 8, name: 'my new run', owner_username: 'chris' },
      { id: 5, name: 'shared', owner_username: 'sandip' },
    ];
    client.getFeeds.mockResolvedValue({ data: after, totalCount: after.length });
    client.getPublicFeeds.mockResolvedValue({ data: [{ id: 6, name: 'open', owner_username: 'other', public: true }], totalCount: 1 });
    mockUserGet.mockResolvedValueOnce('chris');
    await procRoster_sync(true);
    expect(cache.unseen_get()).toEqual([5]);
  });
});


describe('a cold cache answers one feed alone (#1364)', () => {
  it('lists /proc/jobs/feed_N from its own row and topology while the index builds behind', async () => {
    // The index walk takes as long as CUBE's feed list takes; the one feed is asked for by id and answers at once.
    const indexSlow: Promise<{ data: unknown[]; totalCount: number }> = new Promise((resolve) => { setTimeout(() => resolve({ data: [], totalCount: 0 }), 1500); });
    const client = {
      getFeeds: jest.fn().mockImplementation(async (params: { id?: number }) =>
        params.id === 7 ? { data: [{ id: 7, name: 'mine', owner_username: 'chris' }], totalCount: 1 } : indexSlow),
      getPublicFeeds: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      getPluginInstances: jest.fn().mockResolvedValue({ data: [
        { id: 70, feed_id: 7, previous_id: null, plugin_name: 'pl-dircopy', status: 'finishedSuccessfully' },
      ], totalCount: 1 }),
      getPluginInstance: jest.fn(),
    };
    mockClientGet.mockResolvedValue(client);
    expect(cache.built).toBe(false);
    const started: number = Date.now();
    const listed = await provider.list('/proc/jobs/feed_7');
    expect(listed.ok).toBe(true);
    expect(listed.ok ? listed.value.map((item) => item.name) : []).toEqual(['status', 'title', 'note', 'pl-dircopy_70']);
    // Answered in the feed's time, not the index's: the index is still on its way.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(cache.built).toBe(false);
    expect(client.getFeeds).toHaveBeenCalledWith(expect.objectContaining({ id: 7, limit: 1 }), expect.anything());
    await indexSlow;
  });

  it('still needs the whole index for /proc/jobs itself', async () => {
    const client = pagingClient([{ id: 7, name: 'mine', owner_username: 'chris' }]);
    (client as { getPublicFeeds?: unknown }).getPublicFeeds = jest.fn().mockResolvedValue({ data: [], totalCount: 0 });
    mockClientGet.mockResolvedValue(client);
    const listed = await provider.list('/proc/jobs');
    expect(listed.ok).toBe(true);
    expect(cache.built).toBe(true);
  });
});

describe('a job\'s data link on a cold cache (#1364)', () => {
  it('resolves through the feed read first: the job was unknown to the session until then', async () => {
    const client = {
      getFeeds: jest.fn().mockImplementation(async (params: { id?: number }) =>
        ({ data: [{ id: 7, name: 'mine', owner_username: 'chris' }], totalCount: 1 })),
      getPublicFeeds: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      getPluginInstances: jest.fn().mockResolvedValue({ data: [
        { id: 70, feed_id: 7, previous_id: null, plugin_name: 'pl-dircopy', status: 'finishedSuccessfully' },
        { id: 71, feed_id: 7, previous_id: 70, plugin_name: 'pl-whisper', status: 'finishedSuccessfully' },
      ], totalCount: 2 }),
      getPluginInstance: jest.fn().mockResolvedValue({ data: { id: 71, output_path: 'home/chris/feeds/feed_7/pl-dircopy_70/pl-whisper_71/data' } }),
    };
    mockClientGet.mockResolvedValue(client);
    expect(cache.instance_get(71)).toBeUndefined();
    const target = await provider.linkTarget_resolve('/proc/jobs/feed_7/pl-dircopy_70/pl-whisper_71/data');
    expect(target.ok).toBe(true);
    expect(target.ok ? target.value : null).toBe('/home/chris/feeds/feed_7/pl-dircopy_70/pl-whisper_71/data');
    expect(cache.instance_get(71)?.pluginName).toBe('pl-whisper');
  });
});
