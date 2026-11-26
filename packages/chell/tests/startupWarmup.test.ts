/**
 * @file Tests shared interactive and daemon startup cache warming.
 *
 * @module
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { BrasaEngine } from '@fnndsc/brasa';
import type { StartupWarmupReporter } from '../src/core/startupWarmup.js';

const mockDataGet = jest.fn();
const mockSession: { offline: boolean } = { offline: false };
const mockStackPop = jest.fn((): { message: string } | undefined => undefined);
const mockPrefetchPath = jest.fn();
const mockQuestion = jest.fn(async (): Promise<string> => '');
const mockPrefetchWithSpinner = jest.fn(
  async (_label: string, _message: string, _interactive: boolean, action: () => Promise<unknown>): Promise<unknown> => action(),
);
const mockTopologyWarmup = jest.fn(async (): Promise<void> => undefined);
const mockTopologyReconcileFeeds = jest.fn(async (_feedIDs: number[]): Promise<void> => undefined);
const mockProcCacheRefresh = jest.fn(async (): Promise<number[]> => []);
const mockVfsRead = jest.fn();
const mockCheckpointRestore = jest.fn(async () => ({ restored: false, count: 0 }));
const mockRosterBootSync = jest.fn(async (): Promise<number[]> => []);
const mockRosterSync = jest.fn(async (): Promise<number[]> => []);
/** Reads what each feed's data is, after a restore. */
const mockDataFactsStart = jest.fn(async (): Promise<number> => 0);
const mockWarmupComplete = jest.fn();
const mockCheckpointWatch = jest.fn();
const mockCacheClear = jest.fn();
let mockCacheLifecycle: { state: string; checkpointAt?: string } = { state: 'empty' };
const mockDaemonListen = jest.fn();
const mockLaunchInfo = {
  identity: 'me@https://cube.example.org/api/v1/',
  url: 'ws://pangea:42479',
  token: 'tok',
  berthPath: '/run/user/1/calypso/berth.json',
  argusUrl: 'http://pangea:42479/?token=tok',
  daemon: { surfaces_count: (): number => 0, busy_get: (): boolean => false },
  hostControl: { tiers: new Set<string>(), exposed: false },
  bindHost: '127.0.0.1',
};
const mockDaemonLaunch = jest.fn(
  async (_engine: BrasaEngine, beforeListen?: () => Promise<void>): Promise<typeof mockLaunchInfo> => {
    await beforeListen?.();
    mockDaemonListen();
    return mockLaunchInfo;
  },
);
/** The console put on the daemon's terminal once it is up; inert here. */
const mockConsole = jest.fn(async (_target: { identity: string; url: string; token: string }): Promise<void> => undefined);

// The daemon console would spawn a real surface on this terminal; every
// daemon test runs against this inert stand-in instead.
jest.unstable_mockModule('../src/core/daemonConsole.js', () => ({
  daemonConsole_run: mockConsole,
  CHELL_LAUNCH: { exec: 'node', prefixArgs: ['chell.js'] },
}));
const mockUniverseLayoutsWarm = jest.fn(async (): Promise<number> => 0);
// Who the backend says the session is; each block names its own user.
let identityUser: string = 'chris';
let identityConnected: boolean = true;
jest.unstable_mockModule('@fnndsc/brasa', () => ({
  backend_get: () => ({
    session: {
      identity_get: async () => ({ user: identityUser, where: 'https://cube.example.org/api/v1/', connected: identityConnected }),
    },
  }),
  warmupFailure_note: mockWarmupFailureNote,
  procUniverseModel_build: jest.fn(() => ({ feeds: [], whole: true })),
  universeLayouts_warm: mockUniverseLayoutsWarm,
  warmupFailure_clear: mockWarmupFailureClear,
  warmupPending_note: mockWarmupPendingNote,
  warmupPending_clear: mockWarmupPendingClear,
  session: mockSession,
  vfs: { data_get: mockDataGet },
  prefetch_path: mockPrefetchPath,
  prefetchWithSpinner_run: mockPrefetchWithSpinner,
  count_noun: (count: number, singular: string, plural: string = `${singular}s`): string =>
    `${count} ${count === 1 ? singular : plural}`,
  repl_question: mockQuestion,
  error_stripDebugPrefix: (message: string): string => message,
  // Daemon warm-up installs a real progress renderer so its spinners reach
  // the terminal it is booting in; the sink itself is inert here.
  sink_set: jest.fn(),
  StdoutSink: class MockStdoutSink {},
  procIndex_snapshot: (): { jobs: number; feeds: number } => ({ jobs: 12, feeds: 3 }),
  // The boot logo module rides along with startupWarmup's import graph.
  logo_frameRender: (): string[] => [],
  logo_linesRender: (): string[] => [],
  logoRows_count: (): number => 0,
  logoColumns_count: (): number => 0,
}));
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  vfsDispatcher: { read: mockVfsRead },
  procCache_refresh: mockProcCacheRefresh,
  procRoster_bootSync: mockRosterBootSync,
  procRoster_sync: mockRosterSync,
  procTopology_status: jest.fn(() => ({ state: 'complete', failure: undefined })),
  procTopology_reconcileFeeds: mockTopologyReconcileFeeds,
  procTopology_warmup: mockTopologyWarmup,
  procDataFacts_start: mockDataFactsStart,
}));
/** Age of the oldest restored folder listing, in milliseconds. */
let mockOldestAge: number | null = null;

/** Records a deferred warm-up failure so a surface can announce it. */
const mockWarmupFailureNote = jest.fn<(label: string, message: string) => void>();

/** Clears a held failure when a later attempt succeeds. */
const mockWarmupFailureClear = jest.fn<(label: string) => void>();

/** Holds a deferred step as still warming, from its start. */
const mockWarmupPendingNote = jest.fn<(label: string) => void>();

/** Lets a deferred step go once it settles, whatever its outcome. */
const mockWarmupPendingClear = jest.fn<(label: string) => void>();

/** Records the folders a roster arrival or departure changes. */
const mockRosterFoldersSet = jest.fn<(folders: Record<string, string>) => void>();

/** Steerable folder-listing checkpoint restore. */
const mockListCheckpointRestore = jest.fn<() => Promise<{ restored: boolean; count: number; reason?: string }>>(
  async () => ({ restored: false, count: 0, reason: 'no listing checkpoint' }),
);

const mockQueryIndexRestore = jest.fn<(identity: string) => Promise<{ restored: boolean; count: number; reason?: string }>>(
  async () => ({ restored: false, count: 0, reason: 'no query index' }),
);
const mockQueryIndexSave = jest.fn<(identity: string) => Promise<void>>(async () => undefined);

jest.unstable_mockModule('@fnndsc/cumin', () => ({
  chrisContext: { ChRISURL_get: jest.fn(async () => 'https://cube.example.org/api/v1/') },
  errorStack: {
    stack_pop: mockStackPop,
    scope_run: (callback: () => void): void => callback(),
  },
  procCache_get: jest.fn(() => ({
    rosterFolders_set: mockRosterFoldersSet,
    cache_clear: mockCacheClear,
    warmup_complete: mockWarmupComplete,
    lifecycle_get: (): { state: string; checkpointAt?: string } => ({ ...mockCacheLifecycle }),
    feedIDs_get: (): number[] => [1, 2, 3],
    warmupProgress_get: (): { loaded: number; total: number; active: boolean } => ({
      loaded: 12,
      total: 12,
      active: false,
    }),
  })),
  procCheckpoint_restore: mockCheckpointRestore,
  listCheckpoint_restore: mockListCheckpointRestore,
  listCheckpoint_watch: jest.fn(() => (): void => undefined),
  queryIndexCheckpoint_restore: mockQueryIndexRestore,
  queryIndexCheckpoint_save: mockQueryIndexSave,
  queryIndexCheckpoint_watch: jest.fn(() => (): void => undefined),
  queryIndex_sweep: jest.fn(async () => ({ ok: true, value: { indexed: 0, total: 1905, pages: 1, bounded: false } })),
  listCache_get: jest.fn(() => ({
    stats_get: (): { oldestAge: number | null } => ({ oldestAge: mockOldestAge }),
  })),
  procCheckpoint_watch: mockCheckpointWatch,
}));
jest.unstable_mockModule('@fnndsc/calypso', () => ({
  daemon_launch: mockDaemonLaunch,
  consoleCage_start: jest.fn(),
  consoleCage_stop: jest.fn((): string[] => []),
  identity_normalise: (user: string, url: string): string => `${user}@${url}`,
  hostControl_build: (): { policy: { tiers: Set<string>; exposed: boolean } } => ({ policy: { tiers: new Set<string>(), exposed: false } }),
  hostControl_describe: (): string => '',
  packageWebRoot_find: (name: string): string => `/installed/${name}/dist`,
}));

const {
  daemonSession_run,
  startupWarmup_run,
  queryCheckpoint_flush,
  queryCheckpoint_prime,
} = await import('../src/core/startupWarmup.js');

describe('daemonSession_run', () => {
  beforeEach(() => {
    identityUser = 'rudolph';
    jest.clearAllMocks();
    mockSession.offline = false;
    process.exitCode = undefined;
    mockStackPop.mockReturnValue(undefined);
    mockProcCacheRefresh.mockResolvedValue([]);
    mockTopologyWarmup.mockResolvedValue(undefined);
    mockTopologyReconcileFeeds.mockResolvedValue(undefined);
    mockVfsRead.mockResolvedValue({ ok: true, value: 'all_users:x:1:rudolph\npacs_users:x:2:rudolph\n' });
    mockCacheLifecycle = { state: 'empty' };
    mockCheckpointRestore.mockResolvedValue({ restored: false, count: 0 });
    mockDataGet.mockResolvedValue({
      ok: true,
      value: [
        { name: 'pl-a', type: 'plugin' },
        { name: 'pl-b', type: 'plugin' },
        { name: 'pipeline-a', type: 'pipeline' },
      ],
    });
    mockPrefetchPath.mockImplementation(async (path: string) => ({
      ok: true,
      count: path === '/PUBLIC' ? 9 : 4,
    }));
  });

  it('ends an interactive boot at a login: the console attaches to the daemon just published', async () => {
    const engine: BrasaEngine = {
      line_execute: jest.fn(async () => []),
      line_complete: jest.fn(async (prefix: string) => ({ candidates: [], prefix })),
      sink_install: jest.fn(),
      surface_install: jest.fn(),
    };
    const flags = { plugins: false, feeds: false, publicFeeds: false, jobs: false };
    const report = jest.fn<StartupWarmupReporter['log']>();

    await daemonSession_run(engine, 'rudolph', flags, true, { log: report });
    // The console is given the launch's own address and token, verbatim.
    expect(mockConsole).toHaveBeenCalledTimes(1);
    expect(mockConsole).toHaveBeenCalledWith({
      identity: 'me@https://cube.example.org/api/v1/',
      url: 'ws://pangea:42479',
      token: 'tok',
    });
    // And only once the daemon is listening: the login comes after boot.
    const readyOrder: number = report.mock.invocationCallOrder[report.mock.calls.findIndex((call: unknown[]) => call[1] === 'Engine')];
    expect(mockDaemonListen.mock.invocationCallOrder[0]).toBeGreaterThan(readyOrder);
    expect(mockConsole.mock.invocationCallOrder[0]).toBeGreaterThan(mockDaemonListen.mock.invocationCallOrder[0]);

    // A non-interactive host (systemd) never takes the terminal over.
    mockConsole.mockClear();
    await daemonSession_run(engine, 'rudolph', flags, false, { log: jest.fn() });
    expect(mockConsole).not.toHaveBeenCalled();
  });

  it('warms and reports every startup cache before advertising the daemon', async () => {
    const report = jest.fn();
    const engine: BrasaEngine = {
      line_execute: jest.fn(async () => []),
      line_complete: jest.fn(async (prefix: string) => ({ candidates: [], prefix })),
      sink_install: jest.fn(),
      surface_install: jest.fn(),
    };

    await daemonSession_run(engine, 'rudolph', {
      plugins: true,
      feeds: true,
      publicFeeds: true,
      jobs: true,
    }, true, { log: report });

    expect(report).toHaveBeenCalledWith('ok', 'Plugins', 'Cached 2 plugins');
    expect(report).toHaveBeenCalledWith('ok', 'Pipelines', 'Cached 1 pipeline');
    // Feeds, Public and Shared warm behind the prompt now: boot blocks
    // only on what the shell cannot work without, which is /bin.
    expect(report).toHaveBeenCalledWith('pending', 'Feeds', 'Warming /home/rudolph/feeds behind the prompt');
    expect(report).toHaveBeenCalledWith('pending', 'Public', 'Warming /PUBLIC behind the prompt');
    expect(report).toHaveBeenCalledWith('pending', 'Shared', 'Warming /SHARED behind the prompt');
    // A cold boot walks the feed index behind the listening daemon (#1280).
    expect(report).toHaveBeenCalledWith('ok', 'Jobs', 'Indexing the feed list in background — /proc/jobs fills in as it lands');
    expect(report).toHaveBeenCalledWith('ok', 'Engine', 'Ready');
    expect(report).toHaveBeenCalledWith('ok', 'Topology', 'Ready — 12/12 jobs indexed');
    expect(mockTopologyWarmup).toHaveBeenCalledTimes(1);
    // chell passes ARGUS's installed bundle: calypso depends on no surface.
    expect(mockDaemonLaunch).toHaveBeenCalledWith(engine, expect.any(Function), {
      hostControl: { tiers: new Set<string>(), exposed: false },
      webRoot: '/installed/@fnndsc/argus/dist',
      // A browser's terminal runs this chell.
      surfaceLaunch: { exec: 'node', prefixArgs: ['chell.js'] },
    });

    // The gate says the engine listens with steps still warming, before it
    // listens; Engine Ready comes once they settle, after it.
    const gateOrder: number = report.mock.invocationCallOrder[report.mock.calls.findIndex((call: unknown[]) => call[0] === 'pending' && call[1] === 'Engine')];
    const readyOrder: number = report.mock.invocationCallOrder[report.mock.calls.findIndex((call: unknown[]) => call[0] === 'ok' && call[1] === 'Engine')];
    expect(gateOrder).toBeLessThan(mockDaemonListen.mock.invocationCallOrder[0]);
    expect(readyOrder).toBeGreaterThan(mockDaemonListen.mock.invocationCallOrder[0]);

    // Every deferred step settled before Engine Ready, and before the
    // login: the console sees no open pending row.
    expect(mockConsole.mock.invocationCallOrder[0]).toBeGreaterThan(readyOrder);
    for (const label of ['Groups', 'Feeds', 'Public', 'Shared', 'Queries']) {
      const settled: number = report.mock.calls.findIndex(
        (call: unknown[]): boolean => (call[0] === 'ok' || call[0] === 'fail') && call[1] === label,
      );
      expect(settled).toBeGreaterThanOrEqual(0);
      expect(report.mock.invocationCallOrder[settled]).toBeLessThan(readyOrder);
    }
  });

  it('listens and writes its berth before a slow /PUBLIC warm-up ends, and holds the step as warming meanwhile', async () => {
    let publicDone: ((result: { ok: boolean; count: number }) => void) | undefined;
    mockPrefetchPath.mockImplementation(async (path: string) => (
      path === '/PUBLIC'
        ? new Promise<{ ok: boolean; count: number }>((resolve) => { publicDone = resolve; })
        : { ok: true, count: 4 }
    ));
    const report = jest.fn<StartupWarmupReporter['log']>();
    const engine: BrasaEngine = {
      line_execute: jest.fn(async () => []),
      line_complete: jest.fn(async (prefix: string) => ({ candidates: [], prefix })),
      sink_install: jest.fn(),
      surface_install: jest.fn(),
    };

    const booted: Promise<void> = daemonSession_run(engine, 'rudolph', { plugins: true, feeds: true, publicFeeds: true, jobs: false }, false, { log: report });
    for (let turn: number = 0; turn < 50 && mockDaemonListen.mock.calls.length === 0; turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // Listening, with /PUBLIC still out: the berth file is not held by it.
    expect(mockDaemonListen).toHaveBeenCalledTimes(1);
    expect(mockWarmupPendingNote).toHaveBeenCalledWith('Public');
    expect(mockWarmupPendingClear).not.toHaveBeenCalledWith('Public');
    expect(report).toHaveBeenCalledWith('pending', 'Engine', '5 steps warming behind the prompt; the daemon answers meanwhile');
    expect(report).not.toHaveBeenCalledWith('ok', 'Engine', 'Ready');

    publicDone?.({ ok: true, count: 9 });
    await booted;
    expect(mockWarmupPendingClear).toHaveBeenCalledWith('Public');
    expect(report).toHaveBeenCalledWith('ok', 'Public', 'Cached 9 items from /PUBLIC');
    expect(report).toHaveBeenCalledWith('ok', 'Engine', 'Ready');
    expect(mockDaemonListen).toHaveBeenCalledTimes(1);
  });

  it('says that a checkpoint was refused, and why, instead of reading like a first boot', async () => {
    mockCheckpointRestore.mockResolvedValueOnce({ restored: false, count: 0, reason: 'incompatible checkpoint' });
    const report = jest.fn();
    const engine: BrasaEngine = {
      line_execute: jest.fn(async () => []),
      line_complete: jest.fn(async (prefix: string) => ({ candidates: [], prefix })),
      sink_install: jest.fn(),
      surface_install: jest.fn(),
    };

    await daemonSession_run(engine, 'rudolph', { plugins: false, feeds: false, publicFeeds: false, jobs: true }, false, { log: report });

    expect(report).toHaveBeenCalledWith('ok', 'Jobs', 'Checkpoint refused (incompatible checkpoint); indexing the feed list in background — /proc/jobs fills in as it lands');
    expect(mockProcCacheRefresh).toHaveBeenCalled();
  });

  it('names the feeds a restore left out for a torn shard', async () => {
    mockCheckpointRestore.mockResolvedValueOnce({
      restored: true, count: 209535, writtenAt: '2026-07-16T00:00:00Z',
      torn: ['feed 800: instance 7209 names parent 7203, which the shard does not hold'],
    });
    mockRosterBootSync.mockResolvedValueOnce([]);
    mockRosterSync.mockResolvedValueOnce([]);
    const report = jest.fn();
    const engine: BrasaEngine = {
      line_execute: jest.fn(async () => []),
      line_complete: jest.fn(async (prefix: string) => ({ candidates: [], prefix })),
      sink_install: jest.fn(),
      surface_install: jest.fn(),
    };

    await daemonSession_run(engine, 'rudolph', { plugins: false, feeds: false, publicFeeds: false, jobs: true }, false, { log: report });

    expect(report).toHaveBeenCalledWith('ok', 'Jobs', 'Restored 209535 jobs; 3 feeds, 0 new — full roster refresh in background; 1 feed with a torn shard walks again');
  });

  it('brings a restored checkpoint into service on a roster delta, with the full walk behind the listening daemon', async () => {
    mockCheckpointRestore.mockResolvedValueOnce({ restored: true, count: 7009, writtenAt: '2026-07-16T00:00:00Z' });
    mockRosterBootSync.mockResolvedValueOnce([4446]);
    mockRosterSync.mockResolvedValueOnce([17, 23]);
    const report = jest.fn();
    const engine: BrasaEngine = {
      line_execute: jest.fn(async () => []),
      line_complete: jest.fn(async (prefix: string) => ({ candidates: [], prefix })),
      sink_install: jest.fn(),
      surface_install: jest.fn(),
    };

    await daemonSession_run(engine, 'rudolph', { plugins: false, feeds: false, publicFeeds: false, jobs: true }, false, { log: report });

    expect(mockCheckpointRestore).toHaveBeenCalledWith('rudolph@https://cube.example.org/api/v1/');
    expect(mockCheckpointWatch).toHaveBeenCalledWith('rudolph@https://cube.example.org/api/v1/');
    expect(report).toHaveBeenCalledWith('ok', 'Jobs', 'Restored 7009 jobs; 3 feeds, 1 new — full roster refresh in background');
    expect(mockProcCacheRefresh).not.toHaveBeenCalled();
    expect(mockWarmupComplete).toHaveBeenCalled();
    expect(mockRosterSync).toHaveBeenCalledWith(true);
    expect(mockTopologyWarmup).not.toHaveBeenCalled();
    expect(mockTopologyReconcileFeeds).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith('ok', 'Roster', '2 feeds moved while away; each refreshes on its next visit');
    // No sweep runs after a restore, so the data facts are read here.
    expect(mockDataFactsStart).toHaveBeenCalled();
  });

  it('reports a background topology failure after publishing engine readiness', async () => {
    mockTopologyWarmup.mockRejectedValueOnce(new Error('topology connection lost'));
    const statusLog_mock = jest.fn<StartupWarmupReporter['log']>();
    const engine: BrasaEngine = {
      line_execute: jest.fn(async () => []),
      line_complete: jest.fn(async (prefix: string) => ({ candidates: [], prefix })),
      sink_install: jest.fn(),
      surface_install: jest.fn(),
    };

    await daemonSession_run(engine, 'rudolph', {
      plugins: true,
      feeds: true,
      publicFeeds: true,
      jobs: true,
    }, false, { log: statusLog_mock });
    await Promise.resolve();

    expect(statusLog_mock).toHaveBeenCalledWith('ok', 'Engine', 'Ready');
    expect(statusLog_mock).toHaveBeenCalledWith('fail', 'Topology', 'Warm-up failed: topology connection lost');
    expect(mockDaemonListen).toHaveBeenCalledTimes(1);
  });

  it('reports incomplete readiness while still publishing a lazily loadable daemon', async () => {
    mockStackPop.mockReturnValue({ message: 'bin failed' });
    mockDataGet.mockResolvedValue({ ok: false });
    mockPrefetchPath.mockResolvedValue({ ok: false, message: 'path failed' });
    mockProcCacheRefresh.mockRejectedValue(new Error('jobs failed'));
    const report = jest.fn();
    const engine: BrasaEngine = {
      line_execute: jest.fn(async () => []),
      line_complete: jest.fn(async (prefix: string) => ({ candidates: [], prefix })),
      sink_install: jest.fn(),
      surface_install: jest.fn(),
    };

    await daemonSession_run(engine, 'rudolph', {
      plugins: true,
      feeds: true,
      publicFeeds: true,
      jobs: true,
    }, false, { log: report });

    expect(report).toHaveBeenCalledWith('fail', 'Plugins', 'bin failed');
    // A deferred step's failure is not a boot row: it left the gate, and is
    // annunciated afterwards instead.
    expect(report).toHaveBeenCalledWith('pending', 'Feeds', expect.stringContaining('behind the prompt'));
    expect(report).toHaveBeenCalledWith(
      'fail',
      'Engine',
      'Starting with incomplete warm-up: Plugins',
    );
    expect(mockDaemonListen).toHaveBeenCalledTimes(1);
  });

  it('listens before a cold feed-index walk ends, and says when the walk fails behind it', async () => {
    let failWalk: ((error: Error) => void) | undefined;
    mockProcCacheRefresh.mockReturnValueOnce(new Promise<number[]>((_resolve, reject) => { failWalk = reject; }));
    const report = jest.fn();
    const engine: BrasaEngine = {
      line_execute: jest.fn(async () => []),
      line_complete: jest.fn(async (prefix: string) => ({ candidates: [], prefix })),
      sink_install: jest.fn(),
      surface_install: jest.fn(),
    };

    // The walk never ends on its own: a boot that waited on it would hang here.
    await daemonSession_run(engine, 'rudolph', { plugins: false, feeds: false, publicFeeds: false, jobs: true }, false, { log: report });

    expect(mockDaemonListen).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith('ok', 'Engine', 'Ready');
    expect(mockTopologyWarmup).not.toHaveBeenCalled();

    failWalk?.(new Error('feed list timed out'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(report).toHaveBeenCalledWith('fail', 'Topology', 'Warm-up failed: feed list timed out');
    expect(mockTopologyWarmup).not.toHaveBeenCalled();
  });

  it('starts only after the operator elects to continue an exhausted warm-up', async () => {
    mockVfsRead.mockResolvedValue({ ok: false });
    mockStackPop.mockReturnValue({ message: 'membership service unavailable' });
    const recovery = jest.fn(async () => 'continue' as const);
    const report = jest.fn<StartupWarmupReporter['log']>();
    const engine: BrasaEngine = {
      line_execute: jest.fn(async () => []),
      line_complete: jest.fn(async (prefix: string) => ({ candidates: [], prefix })),
      sink_install: jest.fn(),
      surface_install: jest.fn(),
    };

    await daemonSession_run(
      engine,
      'rudolph',
      { plugins: false, feeds: false, publicFeeds: false, jobs: false },
      false,
      { log: report },
      recovery,
    );

    // Groups warms behind the prompt, so it no longer gates: the daemon
    // publishes its berth and the failure is annunciated afterwards.
    expect(recovery).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith('pending', 'Groups', 'Resolving /etc/group behind the prompt');
    expect(mockDaemonListen).toHaveBeenCalledTimes(1);
  });

  it('does not bind a daemon when the operator exits after exhausted warm-up', async () => {
    // Only a blocking step can gate a boot. `/bin` is the one thing the
    // shell cannot work without, so it is the one that still can.
    mockDataGet.mockResolvedValue({ ok: false });
    mockStackPop.mockReturnValue({ message: 'bin failed' });
    const recovery = jest.fn(async () => 'exit' as const);
    const report = jest.fn<StartupWarmupReporter['log']>();
    const engine: BrasaEngine = {
      line_execute: jest.fn(async () => []),
      line_complete: jest.fn(async (prefix: string) => ({ candidates: [], prefix })),
      sink_install: jest.fn(),
      surface_install: jest.fn(),
    };

    await daemonSession_run(
      engine,
      'rudolph',
      { plugins: true, feeds: false, publicFeeds: false, jobs: false },
      false,
      { log: report },
      recovery,
    );

    expect(recovery).toHaveBeenCalledWith(['Plugins']);
    expect(report).toHaveBeenCalledWith('fail', 'Engine', 'Startup aborted after incomplete warm-up: Plugins');
    expect(mockDaemonListen).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('quarantines restored topology when CUBE visibility validation fails', async () => {
    mockCacheLifecycle = { state: 'restored', checkpointAt: '2026-07-16T00:00:00Z' };
    mockCheckpointRestore.mockResolvedValueOnce({ restored: true, count: 10 });
    mockRosterBootSync.mockRejectedValueOnce(new Error('visibility unavailable'));
    const engine: BrasaEngine = {
      line_execute: jest.fn(async () => []),
      line_complete: jest.fn(async (prefix: string) => ({ candidates: [], prefix })),
      sink_install: jest.fn(),
      surface_install: jest.fn(),
    };

    await daemonSession_run(engine, 'rudolph', { plugins: false, feeds: false, publicFeeds: false, jobs: true }, false, { log: jest.fn() });

    expect(mockCacheClear).toHaveBeenCalled();
    expect(mockTopologyWarmup).not.toHaveBeenCalled();
  });

  it('reports disabled caches without trying to warm them', async () => {
    const report = jest.fn();

    const cache = await startupWarmup_run({
      plugins: false,
      feeds: false,
      publicFeeds: false,
      jobs: false,
    }, 'rudolph', false, { log: report });

    expect(cache.failures).toEqual([]);
    expect(report).toHaveBeenCalledWith('skip', 'Plugins', 'Prefetch disabled');
    expect(report).toHaveBeenCalledWith('skip', 'Pipelines', 'Prefetch disabled');
    expect(report).toHaveBeenCalledWith('skip', 'Feeds', 'Prefetch disabled');
    expect(report).toHaveBeenCalledWith('skip', 'Jobs', 'Prefetch disabled');
    expect(mockDataGet).not.toHaveBeenCalled();
  });

  it('says which folder each kind of feed appears in, so an arrival dirties only that one', async () => {
    await startupWarmup_run({
      plugins: false,
      feeds: false,
      publicFeeds: false,
      jobs: false,
    }, 'rudolph', false, { log: jest.fn<StartupWarmupReporter['log']>() });

    expect(mockRosterFoldersSet).toHaveBeenCalledWith({
      owner: 'rudolph',
      own: '/home/rudolph/feeds',
      shared: '/SHARED',
      public: '/PUBLIC',
    });
  });

  describe('folder-listing restore row', () => {
    /** Restores a checkpoint of the given size and returns the row's message. */
    async function restoreRow_message(count: number, oldestAge: number | null): Promise<string> {
      mockOldestAge = oldestAge;
      mockListCheckpointRestore.mockResolvedValueOnce({ restored: true, count });
      const report = jest.fn<StartupWarmupReporter['log']>();
      await startupWarmup_run({
        plugins: false,
        feeds: false,
        publicFeeds: false,
        jobs: false,
      }, 'rudolph', false, { log: report });
      const row = report.mock.calls.find((call) => call[1] === 'Folders');
      return row === undefined ? '' : row[2];
    }

    it('names the row Folders and says folder listings, not the plugin index', async () => {
      const message: string = await restoreRow_message(47, 5 * 60_000);
      expect(message).toContain('Restored 47 folder listings');
      expect(message).toContain('stale until revisited');
    });

    it('reports age as well as count, because a count alone says nothing', async () => {
      expect(await restoreRow_message(47, 5 * 60_000)).toContain('oldest 5 min');
      expect(await restoreRow_message(47, 3 * 60 * 60_000)).toContain('oldest 3 hours');
      expect(await restoreRow_message(47, 3 * 24 * 60 * 60_000)).toContain('oldest 3 days');
    });

    it('says one hour and one day in the singular: the count is known before the row prints', async () => {
      expect(await restoreRow_message(1, 60 * 60_000)).toContain('Restored 1 folder listing, oldest 1 hour');
      expect(await restoreRow_message(1, 2 * 24 * 60 * 60_000)).toContain('oldest 2 days');
    });

    it('says all fresh when nothing has aged a minute', async () => {
      expect(await restoreRow_message(2, 500)).toContain('all fresh');
    });

    it('omits the age phrase when the cache holds nothing to age', async () => {
      const message: string = await restoreRow_message(0, null);
      expect(message).toBe('Restored 0 folder listings, stale until revisited');
    });

    it('reports the absent checkpoint in folder-listing words', async () => {
      mockOldestAge = null;
      mockListCheckpointRestore.mockResolvedValueOnce({ restored: false, count: 0 });
      const report = jest.fn<StartupWarmupReporter['log']>();
      await startupWarmup_run({
        plugins: false,
        feeds: false,
        publicFeeds: false,
        jobs: false,
      }, 'rudolph', false, { log: report });
      expect(report).toHaveBeenCalledWith('skip', 'Folders', 'No folder-listing checkpoint');
    });
  });

  it('hydrates /etc/group before the host becomes ready', async () => {
    const report = jest.fn<StartupWarmupReporter['log']>();

    await startupWarmup_run({
      plugins: false,
      feeds: false,
      publicFeeds: false,
      jobs: false,
    }, 'rudolph', false, { log: report });

    expect(mockVfsRead).toHaveBeenCalledWith('/etc/group');
    // Deferred: the row says pending, and the outcome is awaited.
    expect(report).toHaveBeenCalledWith('pending', 'Groups', 'Resolving /etc/group behind the prompt');
  });

  it('retries a transient group projection failure before declaring Groups failed', async () => {
    mockVfsRead
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, value: 'all_users:x:1:rudolph\npacs_users:x:2:rudolph\n' });
    mockStackPop.mockReturnValueOnce({ message: 'No server response!' });
    const report = jest.fn<StartupWarmupReporter['log']>();

    const cache = await startupWarmup_run({
      plugins: false,
      feeds: false,
      publicFeeds: false,
      jobs: false,
    }, 'rudolph', false, { log: report });

    // A deferred step keeps its retry policy; the outcome is awaited
    // rather than read off the boot readout it no longer prints to.
    const groups = cache.deferred.find((step) => step.label === 'Groups');
    const outcome = await groups!.settled;
    expect(cache.failures).toEqual([]);
    expect(mockVfsRead).toHaveBeenCalledTimes(2);
    expect(outcome.ok).toBe(true);
    expect(outcome.count).toBe(2);
  });

  it('reports a failed group warm-up without preventing later startup work', async () => {
    mockVfsRead.mockResolvedValue({ ok: false });
    mockStackPop.mockReturnValue({ message: 'membership service unavailable' });
    const report = jest.fn<StartupWarmupReporter['log']>();

    const cache = await startupWarmup_run({
      plugins: false,
      feeds: false,
      publicFeeds: false,
      jobs: false,
    }, 'rudolph', false, { log: report });

    // Deferred steps do not gate; they are reported and awaited by the host.
    expect(cache.failures).toEqual([]);
    expect(cache.deferred.map((step) => step.label)).toContain('Groups');
    expect(report).toHaveBeenCalledWith('pending', 'Groups', 'Resolving /etc/group behind the prompt');
    const groups = cache.deferred.find((step) => step.label === 'Groups');
    expect((await groups!.settled).ok).toBe(false);
  });

  it('records a deferred failure so a surface can announce it, and clears it on success', async () => {
    mockVfsRead.mockResolvedValue({ ok: false });
    mockStackPop.mockReturnValue({ message: 'membership service unavailable' });
    const report = jest.fn<StartupWarmupReporter['log']>();

    const cache = await startupWarmup_run({
      plugins: false,
      feeds: false,
      publicFeeds: false,
      jobs: false,
    }, 'rudolph', false, { log: report });

    const groups = cache.deferred.find((step) => step.label === 'Groups');
    await groups!.settled;

    // A step that left the boot gate has no readout left to print to, so
    // the failure is held until a later attempt clears it.
    expect(mockWarmupFailureNote).toHaveBeenCalledWith('Groups', 'membership service unavailable');
    expect(mockWarmupFailureClear).not.toHaveBeenCalledWith('Groups');
  });

  it('prints a deferred step once: the pending row, never the spinner\'s plain-log stand-in beneath it', async () => {
    mockVfsRead.mockResolvedValue({ ok: true, value: 'all_users:x:1:rudolph\n' });
    const report = jest.fn<StartupWarmupReporter['log']>();

    const cache = await startupWarmup_run({
      plugins: false,
      feeds: true,
      publicFeeds: true,
      jobs: false,
    }, 'rudolph', false, { log: report });
    await Promise.all(cache.deferred.map((step) => step.settled));

    // The spinner helper logs its label and message as a plain line when it
    // cannot animate, which put an untagged copy of every pending row
    // directly under the tagged one. Deferred attempts bypass it.
    expect(mockPrefetchWithSpinner).not.toHaveBeenCalled();
    expect(report.mock.calls.filter(([, label]) => label === 'Groups')).toHaveLength(1);
  });

  it('lands the outcome row on a readout that persists, tagged [ OK ] with what it cached', async () => {
    mockVfsRead.mockResolvedValue({ ok: true, value: 'all_users:x:1:rudolph\npacs_users:x:2:rudolph\n' });
    mockPrefetchPath.mockImplementation(async (target: string) => ({ ok: true, count: target === '/PUBLIC' ? 9 : 4 }));
    const report = jest.fn<StartupWarmupReporter['log']>();

    const cache = await startupWarmup_run({
      plugins: false,
      feeds: true,
      publicFeeds: true,
      jobs: false,
    }, 'rudolph', false, { log: report }, true);
    await Promise.all(cache.deferred.map((step) => step.settled));

    // The daemon face keeps its boot log, so a step that started as
    // [PENDING] finishes there as [ OK ] rather than leaving the row open.
    expect(report).toHaveBeenCalledWith('ok', 'Groups', 'Cached 2 groups');
    expect(report).toHaveBeenCalledWith('ok', 'Feeds', 'Cached 4 items from /home/rudolph/feeds');
    expect(report).toHaveBeenCalledWith('ok', 'Public', 'Cached 9 items from /PUBLIC');
    expect(report).toHaveBeenCalledWith('ok', 'Shared', 'Cached 4 items from /SHARED');
    expect(report).toHaveBeenCalledWith('ok', 'Queries', '1905 PACS queries indexed');
  });

  it('lands a deferred failure on a persisting readout as [FAIL], and still holds it for the prompt', async () => {
    mockVfsRead.mockResolvedValue({ ok: false });
    mockStackPop.mockReturnValue({ message: 'membership service unavailable' });
    const report = jest.fn<StartupWarmupReporter['log']>();

    const cache = await startupWarmup_run({
      plugins: false,
      feeds: false,
      publicFeeds: false,
      jobs: false,
    }, 'rudolph', false, { log: report }, true);
    await cache.deferred.find((step) => step.label === 'Groups')!.settled;

    expect(report).toHaveBeenCalledWith('fail', 'Groups', 'membership service unavailable');
    expect(mockWarmupFailureNote).toHaveBeenCalledWith('Groups', 'membership service unavailable');
  });

  it('keeps an interactive readout silent on settle: it has scrolled away, and the prompt carries a failure', async () => {
    mockVfsRead.mockResolvedValue({ ok: true, value: 'all_users:x:1:rudolph\n' });
    const report = jest.fn<StartupWarmupReporter['log']>();

    const cache = await startupWarmup_run({
      plugins: false,
      feeds: false,
      publicFeeds: false,
      jobs: false,
    }, 'rudolph', true, { log: report });
    await cache.deferred.find((step) => step.label === 'Groups')!.settled;

    expect(report).not.toHaveBeenCalledWith('ok', 'Groups', expect.anything());
    expect(report).not.toHaveBeenCalledWith('fail', 'Groups', expect.anything());
  });

  it('warms /SHARED, where another identity\'s work becomes visible', async () => {
    const report = jest.fn<StartupWarmupReporter['log']>();

    const cache = await startupWarmup_run({
      plugins: false,
      feeds: true,
      publicFeeds: true,
      jobs: false,
    }, 'rudolph', false, { log: report });

    // It had no step at all before: nothing to fail, so a CUBE that
    // stopped serving shared paths stayed silent.
    expect(cache.deferred.map((step) => step.label)).toContain('Shared');
    expect(report).toHaveBeenCalledWith('pending', 'Shared', 'Warming /SHARED behind the prompt');
  });

  it('reports offline caches and skips network work', async () => {
    mockSession.offline = true;
    const report = jest.fn();

    await startupWarmup_run({
      plugins: true,
      feeds: true,
      publicFeeds: true,
      jobs: true,
    }, 'rudolph', false, { log: report });

    expect(report).toHaveBeenCalledWith('skip', 'Plugins', 'Offline mode');
    expect(report).toHaveBeenCalledWith('skip', 'Pipelines', 'Offline mode');
    expect(report).toHaveBeenCalledWith('skip', 'Feeds', 'Offline mode');
    expect(report).toHaveBeenCalledWith('skip', 'Jobs', 'Offline mode');
    expect(mockDataGet).not.toHaveBeenCalled();
  });

  it('keeps asynchronous topology settlement out of the interactive logger', async () => {
    const statusLog_mock = jest.fn<StartupWarmupReporter['log']>();

    await startupWarmup_run({
      plugins: false,
      feeds: false,
      publicFeeds: false,
      jobs: true,
    }, 'rudolph', true, { log: statusLog_mock });
    await Promise.resolve();

    expect(mockTopologyWarmup).toHaveBeenCalledTimes(1);
    expect(statusLog_mock.mock.calls.some((call: unknown[]) => call[1] === 'Topology')).toBe(false);
  });

  it('skips private feeds without a user while still warming public feeds', async () => {
    const report = jest.fn();

    await startupWarmup_run({
      plugins: false,
      feeds: true,
      publicFeeds: true,
      jobs: false,
    }, undefined, false, { log: report });

    expect(report).toHaveBeenCalledWith('skip', 'Feeds', 'No user context');
    expect(mockPrefetchPath).toHaveBeenCalledWith('/PUBLIC');
  });
});

describe('the replay index in a run with no warm-up', () => {
  // `chell -c` skips the boot warm-up, correctly — but skipping the replay
  // index with it meant a scripted cohort re-asked the PACS every time,
  // which is the one workflow the fan-out exists for.
  beforeEach((): void => {
    identityUser = 'chris';
    identityConnected = true;
    jest.clearAllMocks();
    mockSession.offline = false;
  });

  it('restores what a previous run already paid to build', async () => {
    await queryCheckpoint_prime('chris');
    expect(mockQueryIndexRestore).toHaveBeenCalledWith('chris@https://cube.example.org/api/v1/');
  });

  it('writes what this run learned, since the debounced writer never fires', async () => {
    await queryCheckpoint_prime('chris');
    await queryCheckpoint_flush();
    expect(mockQueryIndexSave).toHaveBeenCalledWith('chris@https://cube.example.org/api/v1/');
  });

  it('writes nothing under the first identity\'s name once another has connected, and writes the second\'s under its own', async () => {
    const { identityEpoch_raise } = await import('@fnndsc/cumin/identity-epoch');
    // A run that begins as the first identity.
    await queryCheckpoint_prime('chris');
    // Someone else connects in the same run: what the index holds from here is theirs.
    identityEpoch_raise();
    await queryCheckpoint_flush();
    // The first one's checkpoint is left as it was last written: not overwritten, and given none of the second's entries.
    expect(mockQueryIndexSave).not.toHaveBeenCalled();
    // Primed for the second, the exit writes the second's, under the second's name.
    identityUser = 'other';
    await queryCheckpoint_prime('other');
    await queryCheckpoint_flush();
    expect(mockQueryIndexSave).toHaveBeenCalledTimes(1);
    expect(mockQueryIndexSave).toHaveBeenCalledWith('other@https://cube.example.org/api/v1/');
  });

  it('does nothing without an identity to key the index by', async () => {
    await queryCheckpoint_prime(undefined);
    expect(mockQueryIndexRestore).not.toHaveBeenCalled();
  });

  it('does nothing when the backend says the session is not connected', async () => {
    identityConnected = false;
    await queryCheckpoint_prime('chris');
    expect(mockQueryIndexRestore).not.toHaveBeenCalled();
  });

  it('does nothing offline, where there is no CUBE to have asked', async () => {
    mockSession.offline = true;
    await queryCheckpoint_prime('chris');
    expect(mockQueryIndexRestore).not.toHaveBeenCalled();
  });

  // Nothing an operator asked for failed if the index could not be kept.
  it('stays silent when the checkpoint cannot be read or written', async () => {
    mockQueryIndexRestore.mockRejectedValueOnce(new Error('disk full'));
    await expect(queryCheckpoint_prime('chris')).resolves.toBeUndefined();
    mockQueryIndexSave.mockRejectedValueOnce(new Error('disk full'));
    await expect(queryCheckpoint_flush()).resolves.toBeUndefined();
  });
});
