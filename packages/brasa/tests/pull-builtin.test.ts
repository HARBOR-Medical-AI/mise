/**
 * Tests for the pull builtin as a consumer of the shared retrieve engine:
 * argument guards, path/expression resolution, the idempotency skip line,
 * summary rendering (unfired vs watch-failure labels), progress adaptation,
 * and feed/pipeline/plugin creation from the retrieved set. The engine itself
 * (firing, LONK watch, confirm loop) is mocked here and tested in salsa's
 * retrieveWatch suite.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { chrisHelp_install } from './support/chrisHelp.js';

chrisHelp_install();
import { cuminMock_install } from './support/cuminMock.js';
import type { OutputSink } from '../src/core/sink.js';
import type { ProgressEvent } from '../src/core/progress.js';

const mockProcFeedAdd = jest.fn();
const mockProcInstanceAdd = jest.fn();
const mockStorageResolve = jest.fn();
cuminMock_install(() => ({
  envelope_ok: (rendered: string, model?: unknown) => (model === undefined ? { status: 'ok', rendered } : { status: 'ok', rendered, model }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
  errorStack: { stack_push: jest.fn(), stack_getAll: jest.fn(() => []) },
  procCache_get: () => ({ feed_add: mockProcFeedAdd, instance_add: mockProcInstanceAdd }),
  seriesStorage_resolve: mockStorageResolve,
  Client: class {},
}));

/** A pending engine task, mirroring salsa's RetrieveTask shape. */
interface TestTask {
  label: string;
  seriesUID: string;
  studyUID: string;
  pacsName: string;
  expectedFiles: number;
  syntheticQueryId: number | null;
  retrieveId: number | null;
  status: string;
  actualFiles: number;
  lastProgressFiles: number;
  lastProgressTime: number;
  startTime: number;
  lonkConfirmed: boolean;
  cubePathDir: string | null;
}

const mockFeedCreate = jest.fn();
const mockPluginRun = jest.fn();
const mockTasksFire = jest.fn();
const mockSkipComplete = jest.fn();
const mockFireAndWatch = jest.fn();
const mockConfirmLoop = jest.fn();
// A pull's feed is followed until it settles (the header's pulse counts it
// while it works). The sampler is a live thing that visits CUBE, so it is
// mocked here the way the rest of the outside world is.
jest.unstable_mockModule('../src/builtins/procWatch.js', () => ({
  procWatch_add: jest.fn(() => 'live'),
  procWatch_remove: jest.fn(),
  procWatch_release: jest.fn(),
  procWatch_state: jest.fn(() => 'idle'),
  procWatch_list: jest.fn(() => []),
  procWatch_reset: jest.fn(),
  watchSubject_parse: jest.fn(() => null),
  WATCH_FLOOR_MS: 3000,
  WATCH_CAP_MS: 30000,
}));
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  feed_create: mockFeedCreate,
  plugin_run: mockPluginRun,
  retrieveTask_make: (info: Record<string, unknown>): TestTask => ({
    ...(info as Pick<TestTask, 'label' | 'seriesUID' | 'studyUID' | 'pacsName' | 'expectedFiles'>),
    syntheticQueryId: null,
    retrieveId: null,
    status: 'pending',
    actualFiles: 0,
    lastProgressFiles: 0,
    lastProgressTime: 0,
    startTime: 0,
    lonkConfirmed: false,
    cubePathDir: null,
  }),
  retrieveTasks_fire: mockTasksFire,
  retrieveTasks_skipComplete: mockSkipComplete,
  retrieve_fireAndWatch: mockFireAndWatch,
  retrieve_confirmLoop: mockConfirmLoop,
  retrieveProgress_classify: (task: TestTask): string => {
    if (task.status === 'pulled') return task.lonkConfirmed ? 'done' : 'unconfirmed';
    if (task.status === 'pending' || task.status === 'pulling') return 'running';
    if (task.status === 'unfired') return 'error';
    return task.status;
  },
}));

const mockPipelineBuiltin = jest.fn();
jest.unstable_mockModule('../src/builtins/res/pipeline.js', () => ({
  builtin_pipeline: mockPipelineBuiltin,
}));

const mockCreateAndWait = jest.fn();
jest.unstable_mockModule('../src/builtins/net/query.js', () => ({
  pacsQuery_createAndWait: mockCreateAndWait,
  queryExpr_parse: (s: string): Record<string, string> | null => (s.includes(':') ? { PatientID: 'X' } : null),
}));

const mockCollect = jest.fn();
const mockServerResolve = jest.fn(async () => 'PACSDCM' as string | null);
jest.unstable_mockModule('../src/builtins/net/pacsUtils.js', () => ({
  pacs_seriesCollect: mockCollect,
  pacsServer_resolve: mockServerResolve,
}));

const mockCubepath = jest.fn();
jest.unstable_mockModule('../src/builtins/net/cubepath.js', () => ({ builtin_cubepath: mockCubepath }));

const mockPathResolve = jest.fn(async (p: string) => `/home/chris/${p}`);
jest.unstable_mockModule('../src/builtins/utils.js', () => ({ path_resolve: mockPathResolve }));

const mockClientGet = jest.fn();
jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { connection: { client_get: mockClientGet } },
}));
jest.unstable_mockModule('../src/lib/spinner.js', () => ({
  spinner: { start: jest.fn(), stop: jest.fn(), updateMessage: jest.fn() },
}));

const { sink_set, StdoutSink } = await import('../src/core/sink.js');
const mockCohortFoldersNote = jest.fn(async (): Promise<number> => 0);
const mockCohortRead = jest.fn(async () => ({ version: 1, name: null, feed: null, series: [{ vfsPath: '/q/1.2.3', kind: 'series', folderPath: '/SERVICES/PACS/A/series-1' }] }));
jest.unstable_mockModule('../src/builtins/res/gather.store.js', () => ({
  cohortFolders_note: mockCohortFoldersNote,
  cohort_read: mockCohortRead,
  cohortModel_wrap: (state: unknown) => ({ kind: 'gather.cohort', data: state }),
}));
/** What went out on the session bus. */
const published: Array<{ kind: string; envelope?: { model?: { kind: string } } }> = [];
jest.unstable_mockModule('../src/core/ambient.js', () => ({ ambient_publish: (event: (typeof published)[number]): void => { published.push(event); } }));

const { builtin_pull } = await import('../src/builtins/fs/pull.js');
const { jobletScope_run } = await import('../src/core/jobletScope.js');
const { surface_set, HeadlessSurface } = await import('../src/core/surface.js');

/** The engine callbacks a pull hands over, as far as these tests read them. */
interface WatchEvents {
  stillWaiting?: (waiting: TestTask[], waitedS: number) => Promise<boolean>;
  task?: (t: TestTask, s: string, p: string) => void;
}

/** A surface with someone at it, answering every question through `answer`. */
function surface_make(answer: (message: string) => Promise<string>): InstanceType<typeof HeadlessSurface> {
  const surface: InstanceType<typeof HeadlessSurface> = new HeadlessSurface();
  surface.prompt = (request: { message: string }): Promise<string> => answer(request.message);
  return surface;
}

const QUERY_PATH: string = '/net/pacs/queries/q_qid:1';
const info = (seriesUID: string = '1.2.3', expectedFiles: number = 2) => ({
  label: `q|study|series-${seriesUID}`,
  seriesLabel: `series-${seriesUID}`,
  studyLabel: 'study',
  queryLabel: 'q',
  seriesUID,
  studyUID: '1.2',
  pacsName: 'AET',
  expectedFiles,
});
const fakeClient = {};

/** Drives every fired task to the given status through the mock engine. */
function fireOutcome_set(status: string, confirmed: boolean = true, dir: string | null = null): void {
  mockFireAndWatch.mockImplementation(async (tasks: TestTask[], _srv: unknown, _c: unknown, events?: { task?: (t: TestTask, s: string, p: string) => void }) => {
    for (const t of tasks) {
      t.status = status;
      t.lonkConfirmed = status === 'pulled' ? confirmed : false;
      if (dir !== null) t.cubePathDir = dir;
      if (status === 'pulled') t.actualFiles = t.expectedFiles;
      events?.task?.(t, status === 'pulled' ? (confirmed ? 'done' : 'unconfirmed') : 'error', 'watching');
    }
    return status === 'unfired' ? tasks.length : 0;
  });
}

const progressEvents: ProgressEvent[] = [];
let sinkData: string = '';
let sinkErr: string = '';
beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = 0;
  progressEvents.length = 0;
  sinkData = '';
  sinkErr = '';
  const progressSink: OutputSink = {
    data_write: (c: string | Buffer): void => { sinkData += typeof c === 'string' ? c : c.toString('utf-8'); },
    err_write: (c: string | Buffer): void => { sinkErr += typeof c === 'string' ? c : c.toString('utf-8'); },
    status_write: (): void => { /* not used */ },
    progress_write: (event: ProgressEvent): void => { progressEvents.push(event); },
  };
  sink_set(progressSink);
  mockCubepath.mockResolvedValue({ status: 'ok', rendered: '' });
  mockServerResolve.mockResolvedValue('PACSDCM');
  mockClientGet.mockResolvedValue(fakeClient);
  mockCollect.mockResolvedValue([info()]);
  mockSkipComplete.mockResolvedValue(0);
  mockConfirmLoop.mockResolvedValue(0);
  mockStorageResolve.mockResolvedValue({ ok: true, value: { fileCount: 2, folderPath: '/SERVICES/PACS/A/series-1' } });
  mockTasksFire.mockImplementation(async (tasks: TestTask[]) => {
    for (const t of tasks) t.retrieveId = 200;
  });
  fireOutcome_set('pulled');
  mockFeedCreate.mockResolvedValue({
    id: 300,
    name: 'Brain MRI',
    owner_username: 'chris',
    pluginInstance: { data: { id: 400 } },
  });
  mockPipelineBuiltin.mockResolvedValue({ status: 'ok', rendered: '' });
  mockPluginRun.mockResolvedValue({ id: 500, plugin_name: 'pl-dcm2niix' });
  mockPathResolve.mockImplementation(async (p: string) => `/home/chris/${p}`);
});
afterEach(() => {
  sink_set(new StdoutSink());
  process.exitCode = 0;
});

describe('builtin_pull guards and path resolution', () => {
  it('returns help for --help', async () => {
    const env = await builtin_pull(['--help']);
    expect(env.rendered).toContain('USAGE');
    expect(env.rendered).toContain('--new-feed <title>');
    expect(mockCollect).not.toHaveBeenCalled();
  });

  it('requires at least one path', async () => {
    await builtin_pull([]);
    expect(sinkErr).toContain('No paths specified');
    expect(process.exitCode).toBe(1);
  });

  it('errors when no PACS server is available', async () => {
    mockServerResolve.mockResolvedValue(null);
    await builtin_pull([QUERY_PATH]);
    expect(sinkErr).toContain('No PACS server available');
    expect(process.exitCode).toBe(1);
  });

  it('rejects an operand that is neither a PACS path nor a query', async () => {
    await builtin_pull(['/home/chris/feeds']);
    expect(sinkErr).toContain('Not a PACS VFS path');
    expect(sinkErr).toContain('No series to retrieve');
    expect(process.exitCode).toBe(1);
  });

  it('warns when a path yields no series', async () => {
    mockCollect.mockResolvedValue([]);
    await builtin_pull([QUERY_PATH]);
    expect(sinkErr).toContain(`No series found under: ${QUERY_PATH}`);
    expect(process.exitCode).toBe(1);
  });

  it('errors when not connected to ChRIS', async () => {
    mockClientGet.mockResolvedValue(null);
    await builtin_pull([QUERY_PATH]);
    expect(sinkErr).toContain('Not connected to ChRIS');
    expect(process.exitCode).toBe(1);
  });

  it('runs a query for an expression operand, then fires with --nowait', async () => {
    mockCreateAndWait.mockResolvedValue({ queryId: 9, vfsPath: '/net/pacs/queries/x_qid:9', decoded: { raw: '' } });
    await builtin_pull(['PatientID:77', '--nowait']);
    expect(mockCreateAndWait).toHaveBeenCalledWith('PatientID:77', 'pull_PatientID:77', 'PACSDCM', expect.any(Function));
    expect(mockTasksFire).toHaveBeenCalled();
    expect(sinkData).toContain('1.2.3 200');
  });

  it('reports a failed query expression', async () => {
    mockCreateAndWait.mockResolvedValue(null);
    await builtin_pull(['PatientID:77']);
    expect(sinkErr).toContain('Query failed for: PatientID:77');
  });

  it('prints seriesUID ERROR when a --nowait retrieve fails to fire', async () => {
    mockTasksFire.mockImplementation(async (tasks: TestTask[]) => {
      for (const t of tasks) t.status = 'unfired';
    });
    await builtin_pull([QUERY_PATH, '--nowait']);
    expect(sinkData).toContain('1.2.3 ERROR');
    expect(process.exitCode).toBe(1);
  });

  it('rejects --new-feed without a title', async () => {
    await builtin_pull([QUERY_PATH, '--new-feed']);
    expect(sinkErr).toContain('--new-feed requires a title');
    expect(process.exitCode).toBe(1);
  });

  it('rejects --new-feed with --nowait', async () => {
    await builtin_pull([QUERY_PATH, '--nowait', '--new-feed', 'Brain MRI']);
    expect(sinkErr).toContain('--new-feed cannot be combined with --detach');
    expect(mockCollect).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  // `--detach` is the language's word for what pull already did under
  // `--nowait`, and both must mean the same thing on the same line.
  it('rejects --new-feed with --detach, the same way', async () => {
    await builtin_pull([QUERY_PATH, '--detach', '--new-feed', 'Brain MRI']);
    expect(sinkErr).toContain('--new-feed cannot be combined with --detach');
    expect(mockCollect).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe('builtin_pull engine consumption', () => {
  it('pulls a series to completion and renders the success summary', async () => {
    await builtin_pull([QUERY_PATH]);
    expect(mockFireAndWatch).toHaveBeenCalledTimes(1);
    expect(sinkData).toContain('1/1 series pulled successfully');
    expect(mockCubepath).toHaveBeenCalledWith([QUERY_PATH, '--retry']);
    expect(progressEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'pull', itemId: '1.2.3', status: 'done' }),
      expect.objectContaining({ operation: 'pull', phase: 'complete', unit: 'series', status: 'done' }),
    ]));
    expect(process.exitCode).toBe(0);
  });

  it('says where each landed series was filed, on the retrieve channel', async () => {
    await builtin_pull([QUERY_PATH]);
    expect(mockStorageResolve).toHaveBeenCalledWith('1.2.3', expect.objectContaining({ attempts: 4 }));
    expect(progressEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'pull', itemId: '1.2.3', status: 'done', path: '/SERVICES/PACS/A/series-1' }),
    ]));
    // The folder is said before the channel closes, never after.
    const said: number = progressEvents.findIndex((e: ProgressEvent) => e.path !== undefined);
    const closed: number = progressEvents.findIndex((e: ProgressEvent) => e.phase === 'complete');
    expect(said).toBeGreaterThanOrEqual(0);
    expect(said).toBeLessThan(closed);
  });

  it('notes on the cohort where each landed series was filed', async () => {
    await builtin_pull([QUERY_PATH]);
    expect(mockCohortFoldersNote).toHaveBeenCalledWith(new Map([['1.2.3', '/SERVICES/PACS/A/series-1']]));
  });

  it('answers with the cohort when it moved it, so a surface redraws from the kernel', async () => {
    mockCohortFoldersNote.mockResolvedValueOnce(1);
    const envelope = await builtin_pull([QUERY_PATH]);
    expect(envelope.model).toEqual(expect.objectContaining({ kind: 'gather.cohort' }));
  });

  it('answers no model when the cohort did not move', async () => {
    const envelope = await builtin_pull([QUERY_PATH]);
    expect(envelope.model).toBeUndefined();
  });

  it('leaves a folder CUBE cannot yet name for the next query', async () => {
    mockStorageResolve.mockResolvedValue({ ok: true, value: { fileCount: 0, folderPath: null } });
    await builtin_pull([QUERY_PATH]);
    expect(progressEvents.some((e: ProgressEvent) => e.path !== undefined)).toBe(false);
    expect(sinkData).toContain('1/1 series pulled successfully');
  });

  it('labels unfired series as permanent loss and watch failures as verifiable', async () => {
    mockCollect.mockResolvedValue([info('1.2.3'), info('4.5.6')]);
    mockFireAndWatch.mockImplementation(async (tasks: TestTask[]) => {
      tasks[0].status = 'unfired';
      tasks[1].status = 'error';
      return 1;
    });
    await builtin_pull([QUERY_PATH]);
    expect(sinkData).toContain('0/2 series confirmed');
    expect(sinkData).toContain('FAILED TO FIRE');
    expect(sinkData).toContain('[ERROR — verify with: pacs status]');
    expect(sinkData).toContain('1 retrieve(s) were never fired');
    expect(process.exitCode).toBe(1);
  });

  it('reports a lost watch as unknown, and does not fail the command for it', async () => {
    // The socket dying says nobody is watching, not that a retrieve failed:
    // the PACS keeps pushing and CUBE keeps registering afterwards. Calling
    // that a failure sends an operator looking for files that are arriving.
    mockCollect.mockResolvedValue([info('1.2.3'), info('4.5.6')]);
    mockFireAndWatch.mockImplementation(async (tasks: TestTask[]) => {
      tasks[0].status = 'pulled';
      tasks[0].lonkConfirmed = true;
      tasks[1].status = 'unconfirmed';
      return 0;
    });
    process.exitCode = 0;

    await builtin_pull([QUERY_PATH]);

    expect(sinkData).toContain('1/2 series confirmed');
    expect(sinkData).toContain('WATCH ENDED');
    expect(sinkData).toContain('not a failed retrieve');
    expect(sinkData).not.toContain('FAILED TO FIRE');
    expect(process.exitCode).toBe(0);
  });

  it('in front, asks whether to keep waiting on a silent PACS, and takes the answer', async () => {
    const asked: string[] = [];
    const answers: string[] = ['y', 'n'];
    const previous = surface_set(surface_make(async (message: string): Promise<string> => { asked.push(message); return answers.shift() ?? 'n'; }));
    try {
      await builtin_pull([QUERY_PATH]);
      const events = mockFireAndWatch.mock.calls[0]?.[3] as WatchEvents;
      const waiting: TestTask[] = mockFireAndWatch.mock.calls[0]?.[0] as TestTask[];
      expect(asked).toEqual([]);
      expect(await events.stillWaiting?.(waiting, 22)).toBe(true);
      expect(await events.stillWaiting?.(waiting, 44)).toBe(false);
    } finally {
      surface_set(previous);
    }
    expect(asked).toEqual([
      'No files from the PACS yet for q|study|series-1.2.3 after 22s, and none in CUBE. Keep waiting? (y/n)',
      'No files from the PACS yet for q|study|series-1.2.3 after 44s, and none in CUBE. Keep waiting? (y/n)',
    ]);
  });

  it('in front with nobody to ask, waits the long window and then stops', async () => {
    await builtin_pull([QUERY_PATH]);
    const events = mockFireAndWatch.mock.calls[0]?.[3] as WatchEvents;
    const waiting: TestTask[] = mockFireAndWatch.mock.calls[0]?.[0] as TestTask[];
    expect(await events.stillWaiting?.(waiting, 44)).toBe(true);
    expect(await events.stillWaiting?.(waiting, 66)).toBe(false);
  });

  it('as a joblet, never asks: the engine is handed no question, in the watch or the confirm loop', async () => {
    const asked: string[] = [];
    const previous = surface_set(surface_make(async (message: string): Promise<string> => { asked.push(message); return 'y'; }));
    try {
      await jobletScope_run(1, async (): Promise<unknown> => await builtin_pull([QUERY_PATH]));
    } finally {
      surface_set(previous);
    }
    const watchEvents = mockFireAndWatch.mock.calls[0]?.[3] as WatchEvents;
    const confirmEvents = mockConfirmLoop.mock.calls[0]?.[4] as WatchEvents;
    expect(watchEvents.stillWaiting).toBeUndefined();
    expect(confirmEvents.stillWaiting).toBeUndefined();
    expect(watchEvents.task).toBeDefined();
    expect(asked).toEqual([]);
  });

  it('carries the reason a silent series ended with to the surface and the summary', async () => {
    const reason: string = 'the PACS sent nothing for 60 s and CUBE has none of it';
    mockFireAndWatch.mockImplementation(async (tasks: TestTask[]) => { tasks[0].status = 'pulled'; tasks[0].lonkConfirmed = false; return 0; });
    mockConfirmLoop.mockImplementation(async (tasks: TestTask[], _retry: unknown, _srv: unknown, _c: unknown, events?: WatchEvents) => {
      const t = tasks[0] as TestTask & { reason?: string };
      t.status = 'unconfirmed';
      t.reason = reason;
      events?.task?.(t, 'unconfirmed', 'retrying');
      return 0;
    });
    await jobletScope_run(1, async (): Promise<unknown> => await builtin_pull([QUERY_PATH]));
    const last = progressEvents.filter((e: ProgressEvent) => e.itemId === '1.2.3').pop();
    expect(last).toMatchObject({ status: 'unconfirmed', current: 0, reason });
    expect(sinkData).toContain(reason);
    // The pull's own end follows every series' last word.
    expect(progressEvents[progressEvents.length - 1]).toMatchObject({ operation: 'pull', phase: 'complete', status: 'unconfirmed' });
    expect(progressEvents[progressEvents.length - 1]?.itemId).toBeUndefined();
  });

  it('skips series already fully registered and fires only the missing', async () => {
    mockCollect.mockResolvedValue([info('1.2.3'), info('4.5.6')]);
    mockSkipComplete.mockImplementation(async (tasks: TestTask[]) => {
      tasks[0].status = 'pulled';
      tasks[0].lonkConfirmed = true;
      return 1;
    });
    await builtin_pull([QUERY_PATH]);
    expect(sinkData).toContain('1/2 series already in CUBE — skipped');
    const watched: TestTask[] = mockFireAndWatch.mock.calls[0][0] as TestTask[];
    expect(watched).toHaveLength(1);
    expect(watched[0].seriesUID).toBe('4.5.6');
    expect(sinkData).toContain('2/2 series pulled successfully');
  });

  it('skips the watch entirely when every series is already registered', async () => {
    mockSkipComplete.mockImplementation(async (tasks: TestTask[]) => {
      for (const t of tasks) { t.status = 'pulled'; t.lonkConfirmed = true; }
      return 1;
    });
    await builtin_pull([QUERY_PATH]);
    expect(mockFireAndWatch).not.toHaveBeenCalled();
    expect(sinkData).toContain('1/1 series pulled successfully');
  });

  it('runs the confirm loop with the requested retry budget', async () => {
    await builtin_pull([QUERY_PATH, '--retry', '3']);
    expect(mockConfirmLoop).toHaveBeenCalledWith(expect.any(Array), 3, 'PACSDCM', fakeClient, expect.any(Object));
  });

  it('renders the retry-round banner when the engine announces a refire', async () => {
    mockConfirmLoop.mockImplementation(async (_tasks: unknown, _max: unknown, _srv: unknown, _c: unknown, events?: { retryRound?: (a: number, m: number, n: number) => void }) => {
      events?.retryRound?.(1, 3, 2);
      return 0;
    });
    await builtin_pull([QUERY_PATH, '--retry', '3']);
    expect(sinkData).toContain('Retry 1/3 for 2 unconfirmed series');
  });

  it('creates one named feed from the resolved directories after a complete pull', async () => {
    mockCollect.mockResolvedValue([info('1.2.3'), info('4.5.6')]);
    fireOutcome_set('pulled', true, null);
    mockStorageResolve
      .mockResolvedValueOnce({ ok: true, value: { fileCount: 2, folderPath: '/SERVICES/PACS/A/series-1' } })
      .mockResolvedValueOnce({ ok: true, value: { fileCount: 2, folderPath: '/SERVICES/PACS/A/series-2' } });

    await builtin_pull([QUERY_PATH, '--new-feed', 'Brain MRI']);

    expect(mockFeedCreate).toHaveBeenCalledWith(
      ['/SERVICES/PACS/A/series-1', '/SERVICES/PACS/A/series-2'],
      { title: 'Brain MRI' },
    );
    expect(sinkData).toContain('Feed created: 300');
    expect(sinkData).toContain('Root job: pl-dircopy (ID: 400)');
    expect(mockProcFeedAdd).toHaveBeenCalledWith(expect.objectContaining({ id: 300, title: 'Brain MRI' }));
    expect(mockProcInstanceAdd).toHaveBeenCalledWith(expect.objectContaining({ id: 400, feedID: 300 }));
    expect(process.exitCode).toBe(0);
  });

  it('answers --new-feed with the feed it made, and sends the moved cohort on the session bus (#1252)', async () => {
    mockCollect.mockResolvedValue([info('1.2.3')]);
    fireOutcome_set('pulled', true, null);
    mockStorageResolve.mockResolvedValueOnce({ ok: true, value: { fileCount: 2, folderPath: '/SERVICES/PACS/A/series-1' } });
    mockCohortFoldersNote.mockResolvedValueOnce(1);
    published.length = 0;
    const envelope = await builtin_pull([QUERY_PATH, '--new-feed', 'Brain MRI']);
    // F=$(pull --new-feed …) holds the feed; the cohort rides the bus.
    expect(envelope.model?.kind).toBe('feed.created');
    expect(published.map((event) => event.envelope?.model?.kind)).toEqual(['gather.cohort']);
  });

  it('prefers the engine-resolved cube path over a fresh storage lookup', async () => {
    fireOutcome_set('pulled', true, '/SERVICES/PACS/A/from-engine');
    await builtin_pull([QUERY_PATH, '--new-feed', 'Brain MRI']);
    expect(mockStorageResolve).not.toHaveBeenCalled();
    expect(mockFeedCreate).toHaveBeenCalledWith(['/SERVICES/PACS/A/from-engine'], { title: 'Brain MRI' });
  });

  it('refuses the retired attachments before it fires anything', async () => {
    fireOutcome_set('pulled', true, '/SERVICES/PACS/A/series-1');
    const result = await builtin_pull([QUERY_PATH, '--new-feed', 'Brain MRI', '--pipeline', 'brain-preprocessing']);
    expect(result.status).toBe('error');
    expect(mockFeedCreate).not.toHaveBeenCalled();
  });

  it('does not create a requested feed after a partial pull', async () => {
    mockCollect.mockResolvedValue([info('1.2.3'), info('4.5.6')]);
    mockFireAndWatch.mockImplementation(async (tasks: TestTask[]) => {
      tasks[0].status = 'pulled';
      tasks[0].lonkConfirmed = true;
      tasks[1].status = 'error';
      return 0;
    });
    const result = await builtin_pull([QUERY_PATH, '--new-feed', 'Incomplete']);
    expect(mockFeedCreate).not.toHaveBeenCalled();
    expect(sinkErr).toContain('New feed not created because retrieval was incomplete');
    expect(result.status).toBe('error');
    expect(process.exitCode).toBe(1);
  });

  it('does not create a requested feed when any operand is invalid', async () => {
    const result = await builtin_pull([QUERY_PATH, '/not/a/pacs/path', '--new-feed', 'Partial selection']);
    expect(mockFeedCreate).not.toHaveBeenCalled();
    expect(sinkErr).toContain('New feed not created because the requested selection was incomplete');
    expect(result.status).toBe('error');
  });

  it('does not create a requested feed when any operand contains no series', async () => {
    mockCollect
      .mockResolvedValueOnce([info('1.2.3')])
      .mockResolvedValueOnce([]);
    const emptyPath: string = '/net/pacs/queries/q_qid:2';
    const result = await builtin_pull([QUERY_PATH, emptyPath, '--new-feed', 'Partial selection']);
    expect(mockFeedCreate).not.toHaveBeenCalled();
    expect(sinkErr).toContain(`No series found under: ${emptyPath}`);
    expect(result.status).toBe('error');
  });

  it('preserves punctuation in the requested feed title', async () => {
    fireOutcome_set('pulled', true, '/SERVICES/PACS/A/series-1');
    await builtin_pull([QUERY_PATH, '--new-feed', 'Baseline, repeat: 2']);
    expect(mockFeedCreate).toHaveBeenCalledWith(expect.any(Array), { title: 'Baseline, repeat: 2' });
  });

  it('fails when a pulled series cannot be resolved to a CUBE directory', async () => {
    fireOutcome_set('pulled', true, null);
    mockStorageResolve.mockResolvedValue({ ok: true, value: { fileCount: 0, folderPath: null } });
    const result = await builtin_pull([QUERY_PATH, '--new-feed', 'Missing path']);
    expect(mockFeedCreate).not.toHaveBeenCalled();
    expect(sinkErr).toContain('Could not resolve CUBE storage for series 1.2.3');
    expect(result.status).toBe('error');
    expect(process.exitCode).toBe(1);
  });

  it('reports feed creation failure after a successful pull', async () => {
    fireOutcome_set('pulled', true, '/SERVICES/PACS/A/series-1');
    mockFeedCreate.mockResolvedValue(null);
    const result = await builtin_pull([QUERY_PATH, '--new-feed', 'Brain MRI']);
    expect(sinkErr).toContain("Failed to create feed 'Brain MRI'");
    expect(result.status).toBe('error');
    expect(process.exitCode).toBe(1);
  });

  it('requires an owner so every successful creation can print its feed path', async () => {
    fireOutcome_set('pulled', true, '/SERVICES/PACS/A/series-1');
    mockFeedCreate.mockResolvedValue({
      id: 300,
      name: 'Brain MRI',
      owner_username: '',
      pluginInstance: { data: { id: 400 } },
    });
    const result = await builtin_pull([QUERY_PATH, '--new-feed', 'Brain MRI']);
    expect(sinkErr).toContain("Failed to create feed 'Brain MRI'");
    expect(sinkData).not.toContain('Feed path:');
    expect(result.status).toBe('error');
  });
});
