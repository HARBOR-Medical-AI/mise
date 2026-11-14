/**
 * @file Unit tests for `gather process`: one run over the whole cohort, off
 * the cohort's own feed when it has one, refusing what it cannot process.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

/** The cohort the fake store holds, and what was written back. */
let cohort: { version: number; name: string | null; feed: { feedId: number; rootInstanceId: number; path: string } | null; series: Array<Record<string, unknown>> };
const written: unknown[] = [];
jest.unstable_mockModule('../src/builtins/res/gather.store.js', () => ({
  cohort_read: async () => cohort,
  cohortFolders_resolve: async (state: unknown) => state,
  cohort_write: async (state: unknown): Promise<void> => { written.push(state); },
  cohortModel_wrap: (state: unknown) => ({ kind: 'gather.cohort', data: state }),
}));
/** What went out on the session bus. */
const published: Array<{ kind: string; envelope?: { model?: { kind: string; data: unknown } } }> = [];
jest.unstable_mockModule('../src/core/ambient.js', () => ({ ambient_publish: (event: (typeof published)[number]): void => { published.push(event); } }));

const mockFeedCreate = jest.fn();
jest.unstable_mockModule('@fnndsc/salsa', () => ({ feed_create: mockFeedCreate }));

let bin: { plugin?: { name: string }; pipeline?: { name: string; title?: string } } = {};
jest.unstable_mockModule('../src/chris/binExecutables.js', () => ({ binExecutableMatches_get: async () => bin }));

const mockExecutePlugin = jest.fn();
jest.unstable_mockModule('../src/builtins/pluginExecute.js', () => ({ builtin_executePlugin: mockExecutePlugin }));
const mockPipeline = jest.fn();
jest.unstable_mockModule('../src/builtins/res/pipeline.js', () => ({ builtin_pipeline: mockPipeline }));
jest.unstable_mockModule('../src/builtins/feedCreation.js', () => ({ newFeed_cacheAdd: jest.fn(), run_follow: jest.fn() }));
// A pull lands every series it is asked for: the cohort reads them as home after.
const mockPull = jest.fn(async (paths: string[]) => {
  for (const member of cohort.series) {
    if (paths.includes(member.vfsPath as string)) member.folderPath = `/home/u/SERVICES/PACS/${String(member.vfsPath).split('/').pop()}`;
  }
  return { status: 'ok', rendered: '' };
});
jest.unstable_mockModule('../src/builtins/fs/pull.js', () => ({ builtin_pull: mockPull }));
const lines: string[] = [];
jest.unstable_mockModule('../src/core/sink.js', () => ({ sink_dataLine: (line: string): void => { lines.push(line); } }));

const { gather_process, cohortFeed_make } = await import('../src/builtins/res/gather.process.js');

/** A `gather process` request: a name, and what else the line gave. */
const asked = (name: string, more: { title?: string | null; detach?: boolean; forwarded?: string[] } = {}) => ({ name, title: null, detach: false, forwarded: [], ...more });

const RUN = { kind: 'run.scheduled', data: { pluginName: 'pl-x', instanceId: 9, feedId: 300, newFeed: false, outputPath: '/o', status: 'finishedSuccessfully' } };

beforeEach(() => {
  cohort = {
    version: 1, name: 'sag cohort', feed: null,
    series: [
      { vfsPath: '/net/pacs/q/S1', kind: 'series', folderPath: '/home/u/SERVICES/PACS/s1' },
      { vfsPath: '/home/u/uploads/brain', kind: 'dir' },
    ],
  };
  written.length = 0;
  published.length = 0;
  lines.length = 0;
  bin = { plugin: { name: 'pl-x' } };
  mockFeedCreate.mockReset();
  mockFeedCreate.mockResolvedValue({ id: 300, owner_username: 'u', pluginInstance: { data: { id: 400 } } });
  mockExecutePlugin.mockReset();
  mockExecutePlugin.mockResolvedValue({ status: 'ok', rendered: '', model: RUN });
  mockPull.mockClear();
  mockPipeline.mockReset();
  mockPipeline.mockResolvedValue({ status: 'ok', rendered: '', model: { kind: 'pipeline.scheduled', data: { feedId: 300, newFeed: false } } });
  process.exitCode = 0;
});

describe('gather process', () => {
  it('makes one feed holding every member, notes it on the cohort, and runs the plugin once off its root', async () => {
    const envelope = await gather_process(asked('pl-x', { forwarded: ['--threshold', '0.5'] }));
    expect(mockFeedCreate).toHaveBeenCalledWith(['/home/u/SERVICES/PACS/s1', '/home/u/uploads/brain'], { title: 'sag cohort' });
    expect(written).toEqual([{ ...cohort, feed: { feedId: 300, rootInstanceId: 400, path: '/home/u/feeds/feed_300/pl-dircopy_400/data' } }]);
    expect(mockExecutePlugin).toHaveBeenCalledWith('pl-x', ['--threshold', '0.5'], '/home/u/feeds/feed_300/pl-dircopy_400/data');
    // The feed was made by this line, so the answer says so.
    expect(envelope.model).toEqual({ ...RUN, data: { ...RUN.data, newFeed: true } });
  });

  it('sends the cohort with its new feed on the session bus, and keeps the run as the line\'s answer (#1252)', async () => {
    const envelope = await gather_process(asked('pl-x'));
    // R=$(gather process …) holds the line's last model: the run, never the cohort.
    expect(envelope.model?.kind).toBe('run.scheduled');
    expect(published).toHaveLength(1);
    expect(published[0]?.envelope?.model).toEqual({
      kind: 'gather.cohort',
      data: { ...cohort, feed: { feedId: 300, rootInstanceId: 400, path: '/home/u/feeds/feed_300/pl-dircopy_400/data' } },
    });
  });

  it("runs off the cohort's own feed when it has one, copying nothing", async () => {
    cohort.feed = { feedId: 77, rootInstanceId: 78, path: '/home/u/feeds/feed_77/pl-dircopy_78/data' };
    const envelope = await gather_process(asked('pl-x', { detach: true }));
    expect(mockFeedCreate).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    expect(mockExecutePlugin).toHaveBeenCalledWith('pl-x', ['--detach'], '/home/u/feeds/feed_77/pl-dircopy_78/data');
    expect(envelope.model).toEqual(RUN);
  });

  it('runs a pipeline off the root by --previous', async () => {
    bin = { pipeline: { name: 'dcm-pipe' } };
    cohort.feed = { feedId: 77, rootInstanceId: 78, path: '/p' };
    await gather_process(asked('dcm-pipe', { forwarded: ['--x.memory_limit=8Gi'] }));
    expect(mockPipeline).toHaveBeenCalledWith(['run', 'dcm-pipe', '--previous', '78', '--x.memory_limit=8Gi']);
  });

  it('refuses an unpulled series by name, before it makes anything', async () => {
    cohort.series.push({ vfsPath: '/net/pacs/q/S2', kind: 'series', description: 'SAG T1' });
    const envelope = await gather_process(asked('pl-x'));
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('1 series is not pulled yet (SAG T1); pull ${gather} first');
    expect(mockFeedCreate).not.toHaveBeenCalled();
  });

  it('runs a pipeline named by its CUBE name under its /bin name, which names the id', async () => {
    bin = { pipeline: { name: 'FreeSurfer_8_2_0_mri_convert_id291', title: 'FreeSurfer 8.2.0 mri_convert' } };
    await gather_process(asked('FreeSurfer 8.2.0 mri_convert'));
    expect(mockPipeline).toHaveBeenCalledWith(['run', 'FreeSurfer_8_2_0_mri_convert_id291', '--previous', '400']);
  });

  it('refuses an empty cohort, a name /bin lacks, and a name that is both', async () => {
    cohort.series = [];
    expect((await gather_process(asked('pl-x'))).renderedErr).toContain('the cohort is empty');
    cohort.series = [{ vfsPath: '/d', kind: 'dir' }];
    bin = {};
    expect((await gather_process(asked('pl-nope'))).renderedErr).toContain('no plugin or pipeline named pl-nope in /bin');
    bin = { plugin: { name: 'x' }, pipeline: { name: 'x' } };
    expect((await gather_process(asked('x'))).renderedErr).toContain('names both a plugin and a pipeline');
    expect(mockFeedCreate).not.toHaveBeenCalled();
  });
});

describe('gather feed', () => {
  it('roots one feed on every member, titled by the cohort, and notes it on the cohort', async () => {
    const made = await cohortFeed_make(null);
    expect(mockFeedCreate).toHaveBeenCalledWith(['/home/u/SERVICES/PACS/s1', '/home/u/uploads/brain'], { title: 'sag cohort' });
    expect(made).toEqual({ state: expect.objectContaining({ feed: { feedId: 300, rootInstanceId: 400, path: '/home/u/feeds/feed_300/pl-dircopy_400/data' } }), made: true });
    expect(written).toHaveLength(1);
    expect(mockPull).not.toHaveBeenCalled();
  });

  it('pulls the series still at the PACS first, in one pull, then roots the feed on them all', async () => {
    cohort.series.push({ vfsPath: '/net/pacs/q/S2', kind: 'series' });
    await cohortFeed_make('T');
    expect(mockPull).toHaveBeenCalledWith(['/net/pacs/q/S2']);
    expect(mockFeedCreate).toHaveBeenCalledWith(['/home/u/SERVICES/PACS/s1', '/home/u/uploads/brain', '/home/u/SERVICES/PACS/S2'], { title: 'T' });
  });

  it('makes nothing when a series did not land, and says which', async () => {
    cohort.series.push({ vfsPath: '/net/pacs/q/S2', kind: 'series', description: 'SAG T1' });
    mockPull.mockImplementationOnce(async () => ({ status: 'error', rendered: '' }));
    expect(await cohortFeed_make(null)).toBe('1 series did not land (SAG T1); no feed was made');
    expect(mockFeedCreate).not.toHaveBeenCalled();
  });

  it('answers the feed the cohort has, making none', async () => {
    cohort.feed = { feedId: 77, rootInstanceId: 78, path: '/p' };
    expect(await cohortFeed_make(null)).toEqual({ state: cohort, made: false });
    expect(mockFeedCreate).not.toHaveBeenCalled();
  });

  it('refuses an empty cohort and an empty title', async () => {
    expect(await cohortFeed_make(' ')).toBe('--title needs a title');
    cohort.series = [];
    expect(await cohortFeed_make(null)).toContain('the cohort is empty');
  });
});
