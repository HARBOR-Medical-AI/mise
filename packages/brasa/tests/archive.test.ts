/**
 * @file Tests for the directory-archive workflow.
 *
 * The archive exists because CUBE cannot hand over a directory (issue #233),
 * so what matters here is not only that it works but that every way it can
 * fail says which part of the platform is missing. A run that dies silently
 * leaves an operator with an unexplained feed and no file.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

const dataGet = jest.fn();
const feedCreate = jest.fn();
const pipelineRun = jest.fn();
const pipelineReadiness = jest.fn();
const feedDelete = jest.fn();
const statusFetch = jest.fn();
const outputPathFetch = jest.fn();
const listRecursive = jest.fn();
const stackPush = jest.fn();

jest.unstable_mockModule('../src/lib/vfs/vfs.js', () => ({
  vfs: { data_get: dataGet },
}));
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  feed_create: feedCreate,
  pipeline_run: pipelineRun,
  pipeline_readiness: pipelineReadiness,
  feed_delete: feedDelete,
  job_statusFetch: statusFetch,
  job_outputPathFetch: outputPathFetch,
  files_listRecursive: listRecursive,
}));
cuminMock_install(() => ({
  errorStack: { stack_push: stackPush, stack_search: () => [] },
}));

const { directory_archive } = await import('../src/builtins/fs/archive.js');

/** A `/bin` listing containing pl-dircopy, which feed creation requires. */
const binWithDircopy = { ok: true, value: [{ name: 'pl-dircopy-v1.1.0' }] };

/** A feed whose pl-dircopy instance is 41. */
const feed = { id: 9, pluginInstance: { data: { id: 41 } } };

/**
 * Where CUBE keeps the archive job's output: under its owner's home, as
 * `output_path` records it. No other folder holds anything, as on a real
 * store, where `feeds/feed_9/…` names nothing.
 */
const OUTPUT: string = '/home/me/feeds/feed_9/pl-dircopy_41/pl-pfdorun_42/data';

/** The store's listing: CUBE's `fname`s, from its root, without a leading slash. */
const store: Record<string, unknown[]> = {
  [OUTPUT]: [{ path: 'home/me/feeds/feed_9/pl-dircopy_41/pl-pfdorun_42/data/series.zip', type: 'file', size: 4096 }],
};

describe('directory_archive', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dataGet.mockResolvedValue(binWithDircopy as never);
    feedCreate.mockResolvedValue(feed as never);
    pipelineReadiness.mockResolvedValue({ ready: true } as never);
    pipelineRun.mockResolvedValue({ ok: true, value: { workflowId: 3, pluginInstanceIds: [42] } } as never);
    feedDelete.mockResolvedValue(true as never);
    statusFetch.mockResolvedValue({ ok: true, value: 'finishedSuccessfully' } as never);
    outputPathFetch.mockImplementation(async (id: unknown) =>
      (id === 42 ? { ok: true, value: OUTPUT } : { ok: false }) as never);
    listRecursive.mockImplementation(async (root: unknown) => (store[String(root)] ?? []) as never);
  });

  it('returns the file the pipeline produced, at the path a session reads', async () => {
    const result = await directory_archive('/home/me/series');

    expect(feedCreate).toHaveBeenCalledWith(['/home/me/series'], { title: 'Archive of series' });
    expect(pipelineRun).toHaveBeenCalledWith('zip v20240311', 41);
    expect(result).toEqual({
      path: '/home/me/feeds/feed_9/pl-dircopy_41/pl-pfdorun_42/data/series.zip',
      filename: 'series.zip',
      size: 4096,
    });
  });

  it('names the archive after the folder, keeping the pipeline its own file and extension', async () => {
    // The zip pipeline names its file after the folder above the one it
    // archived, so every folder arrived as `parent.zip`.
    const PARENT: string = '/home/me/feeds/feed_9/pl-dircopy_41/pl-pfdorun_42/data';
    listRecursive.mockResolvedValueOnce([
      { path: 'home/me/feeds/feed_9/pl-dircopy_41/pl-pfdorun_42/data/parent.zip', type: 'file', size: 4096 },
    ] as never);
    const zipped = await directory_archive('/home/me/sub-01.anat');
    expect(zipped).toEqual({ path: `${PARENT}/parent.zip`, filename: 'sub-01.anat.zip', size: 4096 });

    listRecursive.mockResolvedValueOnce([
      { path: 'home/me/feeds/feed_9/pl-dircopy_41/pl-pfdorun_42/data/parent.tar.gz', type: 'file' },
    ] as never);
    const tarred = await directory_archive('/home/me/series/');
    expect(tarred).toEqual({ path: `${PARENT}/parent.tar.gz`, filename: 'series.tar.gz' });

    // The produced name is a folder's too, and a dot inside it is not an extension.
    listRecursive.mockResolvedValueOnce([
      { path: 'home/me/feeds/feed_9/pl-dircopy_41/pl-pfdorun_42/data/ses.1.zip', type: 'file' },
    ] as never);
    const dotted = await directory_archive('/home/me/ses.1/anat');
    expect(dotted).toEqual({ path: `${PARENT}/ses.1.zip`, filename: 'anat.zip' });
  });

  it('lists the folder CUBE says the archive job wrote, not one built from ids', async () => {
    // The store keeps a feed under its owner's home. `feeds/feed_9/…` names
    // nothing there, and every browser download of a folder ended as
    // "produced no file".
    await directory_archive('/home/me/series');

    expect(outputPathFetch).toHaveBeenCalledWith(42);
    expect(listRecursive).toHaveBeenCalledWith(OUTPUT);
  });

  it('says so when CUBE names no output folder for the archive job', async () => {
    outputPathFetch.mockResolvedValueOnce({ ok: false } as never);

    const result = await directory_archive('/home/me/series');

    expect(result).toBeNull();
    expect(listRecursive).not.toHaveBeenCalled();
    const [, message] = stackPush.mock.calls.at(-1) as [string, string];
    expect(message).toContain('no output folder');
  });

  it('names the missing pipeline and where to get it', async () => {
    pipelineReadiness.mockResolvedValueOnce({ ready: false, reason: 'unregistered' } as never);

    const result = await directory_archive('/home/me/series');

    expect(result).toBeNull();
    const [, message] = stackPush.mock.calls.at(-1) as [string, string];
    expect(message).toContain('zip v20240311');
    expect(message).toContain('store');
  });

  it('distinguishes a pipeline that will not run from one that is absent', async () => {
    // Sending someone to the store for a pipeline already registered wastes
    // their time and contradicts the reason printed directly above.
    pipelineReadiness.mockResolvedValueOnce({ ready: false, reason: 'unpreparable' } as never);

    const result = await directory_archive('/home/me/series');

    expect(result).toBeNull();
    const [, message] = stackPush.mock.calls.at(-1) as [string, string];
    expect(message).toContain('registered but cannot run');
    expect(message).toContain('compute');
  });

  it('creates no feed when the pipeline cannot run', async () => {
    // A feed for a run that never happens is litter in someone's feed list and
    // an analysis in the compute graph that produced nothing.
    pipelineReadiness.mockResolvedValueOnce({ ready: false, reason: 'unpreparable' } as never);

    await directory_archive('/home/me/series');

    expect(feedCreate).not.toHaveBeenCalled();
  });

  it('removes the feed when the run fails after it was created', async () => {
    pipelineRun.mockResolvedValueOnce({ ok: false } as never);

    const result = await directory_archive('/home/me/series');

    expect(result).toBeNull();
    expect(feedDelete).toHaveBeenCalledWith(9);
  });

  it('names a feed it could not remove, so someone can', async () => {
    pipelineRun.mockResolvedValueOnce({ ok: false } as never);
    feedDelete.mockResolvedValueOnce(false as never);

    await directory_archive('/home/me/series');

    const [, message] = stackPush.mock.calls.at(-1) as [string, string];
    expect(message).toContain('feed 9');
  });

  it('names pl-dircopy when a feed cannot be created at all', async () => {
    dataGet.mockResolvedValueOnce({ ok: true, value: [{ name: 'pl-dcm2niix-v1.0.0' }] } as never);

    const result = await directory_archive('/home/me/series');

    expect(result).toBeNull();
    expect(feedCreate).not.toHaveBeenCalled();
    const [, message] = stackPush.mock.calls.at(-1) as [string, string];
    expect(message).toContain('pl-dircopy');
  });

  it('reports a failed archive job rather than looking for its output', async () => {
    statusFetch.mockResolvedValue({ ok: true, value: 'finishedWithError' } as never);

    const result = await directory_archive('/home/me/series');

    expect(result).toBeNull();
    expect(listRecursive).not.toHaveBeenCalled();
    expect(feedDelete).toHaveBeenCalledWith(9);
    const messages = stackPush.mock.calls.map((call) => (call as [string, string])[1]);
    expect(messages.some((m) => m.includes('finishedWithError'))).toBe(true);
  });

  it('leaves the feed alone when the job merely ran out of time', async () => {
    // It may yet finish. Deleting the feed would remove it from under a job
    // that is still going.
    statusFetch.mockResolvedValue({ ok: true, value: 'started' } as never);
    jest.useFakeTimers();
    const pending = directory_archive('/home/me/series');
    await jest.advanceTimersByTimeAsync(16 * 60 * 1000);
    const result = await pending;
    jest.useRealTimers();

    expect(result).toBeNull();
    expect(feedDelete).not.toHaveBeenCalled();
  });

  it('reports an empty output rather than returning a directory as the archive', async () => {
    listRecursive.mockResolvedValueOnce([
      { path: 'home/me/feeds/feed_9/pl-dircopy_41/pl-pfdorun_42/data/empty', type: 'dir' },
    ] as never);

    const result = await directory_archive('/home/me/series');

    expect(result).toBeNull();
    const [, message] = stackPush.mock.calls.at(-1) as [string, string];
    expect(message).toContain('produced no file');
  });

  it('honours a deployment own archive pipeline', async () => {
    const previous: string | undefined = process.env['CHRIS_ARCHIVE_PIPELINE'];
    process.env['CHRIS_ARCHIVE_PIPELINE'] = 'local-zip v1';
    jest.resetModules();
    try {
      const fresh = await import('../src/builtins/fs/archive.js');
      await fresh.directory_archive('/home/me/series');
      expect(pipelineRun).toHaveBeenCalledWith('local-zip v1', 41);
    } finally {
      if (previous === undefined) delete process.env['CHRIS_ARCHIVE_PIPELINE'];
      else process.env['CHRIS_ARCHIVE_PIPELINE'] = previous;
    }
  });
});
