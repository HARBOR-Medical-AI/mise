import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { coreBuiltins_mock } from './support/coreBuiltins.js';
import { cuminMock_install } from './support/cuminMock.js';
import type { CommandEnvelope } from '@fnndsc/cumin';

// Minimal cumin surface used by the dispatch layer (Result helpers + error stack).
const Ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
const Err = (): { ok: false } => ({ ok: false });
const mockCheckpointDrain = jest.fn((): { type: string; message: string }[] => []);
cuminMock_install(() => ({
  feedStatus_deriveFromCounts: (): string => 'finishedSuccessfully',
  path_isInFeed: (p: string): boolean => p.includes('/feeds/feed_'),
  path_extractPluginInstanceID: (p: string): number | null => { const m = [...p.matchAll(/\/pl-[^/]+_(\d+)(?=\/|$)/g)].pop(); return m ? Number(m[1]) : null; },
  envelope_ok: (rendered: string) => ({ status: 'ok', rendered }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
  Ok,
  Err,
  errorStack: {
    stack_pop: jest.fn(() => undefined),
    stack_push: jest.fn(),
    checkpoint_mark: jest.fn(() => 0),
    checkpoint_drain: mockCheckpointDrain,
    scope_run: (fn: () => unknown) => fn(),
  },
  procCache_get: () => ({ feed_add: () => undefined, instance_add: () => undefined, feeds_find: () => [], feedScopeCounts_get: () => ({ user: 0, public: 0, shared: 0, total: 0 }), warmupProgress_get: () => ({ active: false, loaded: 0, total: 0 }), lifecycle_get: () => ({ state: 'cold' }) }),
  requestLedger_snapshot: () => ({ since: '', total: 0, ms: 0, families: [], last: [] }),
  chrisContext: { ChRISURL_get: async () => null, ChRISuser_get: async () => null },
  listCache_get: jest.fn(),
  Context: jest.fn(),
  keyPairParams_apply: jest.fn(),
}));

// The /bin listing model is type-only at runtime.
jest.unstable_mockModule('@fnndsc/chili/models/listing.js', () => ({}));

// chili delegation target: chiliCommand_run captures via run_capture, and
// commandNames_get backs the "is this even a chili command?" guard.
const mockChiliRun = jest.fn(async () => ({ out: '', err: '' }));
const mockCommandNames = jest.fn(async () => new Set<string>(['frobnicate', 'feeds']));
jest.unstable_mockModule('@fnndsc/chili/run.js', () => ({ run: jest.fn(), run_capture: mockChiliRun, commandNames_get: mockCommandNames }));

// Session — dispatch only reads the timing toggle.
const mockTiming = jest.fn(() => false);
jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { timingEnabled_get: mockTiming },
}));

// VFS — command_dispatch consults /bin for plugin/pipeline names.
const mockDataGet = jest.fn();
jest.unstable_mockModule('../src/lib/vfs/vfs.js', () => ({ vfs: { data_get: mockDataGet } }));
// The operand of a /bin run looks at CFS through the dispatcher (#1303); a
// small world stands in, and the paths resolve as given.
const world: Record<string, 'dir' | 'file'> = {};
jest.unstable_mockModule('../src/core/filesystem.js', () => ({
  vfsDispatcher_get: () => ({
    list: async (parent: string) => ({ ok: true, value: Object.entries(world).filter(([path]) => path.slice(0, path.lastIndexOf('/')) === parent).map(([path, type]) => ({ name: path.slice(path.lastIndexOf('/') + 1), type })) }),
    mkdir: async (path: string) => { world[path] = 'dir'; return { ok: true, value: true }; },
    cp: async (_source: string, destination: string) => { world[destination] = 'file'; return { ok: true, value: true }; },
    path_isVirtual: () => false,
  }),
}));
/** Where the session stands, for a `/bin` run with no operand: a feed node unless a test moves it. */
let cwdNow: string = '/home/u/feeds/feed_3/pl-dircopy_12/data';
jest.unstable_mockModule('../src/core/paths.js', () => ({ path_resolve: async (input: string) => (input === '~' ? '/home/u' : input === '.' ? cwdNow : input), path_resolveFrom: (input: string) => input }));
const mockFeedCreate = jest.fn();
jest.unstable_mockModule('../src/builtins/res/runWait.js', () => ({
  runs_awaitSettled: async () => ({ outcome: 'settled', failed: 0 }), settlement_render: () => 'settled', settlementStatus_derive: () => 'finishedSuccessfully',
}));
jest.unstable_mockModule('@fnndsc/salsa', () => ({ feed_create: mockFeedCreate }));

// Built-in command table. Every name is a jest.fn() so COMMAND_HANDLERS is
// fully populated; the ones asserted on are captured by reference.
const mockLs = jest.fn();
const mockId = jest.fn<(args: string[]) => Promise<CommandEnvelope>>();
const mockWhoami = jest.fn();
const mockPipeline = jest.fn();
const mockUpload = jest.fn();
const mockDownload = jest.fn();
const BUILTIN_NAMES = [
  'builtin_config', 'builtin_cd', 'builtin_ls', 'builtin_pwd', 'builtin_connect', 'builtin_logout',
  'builtin_cat', 'builtin_cp', 'builtin_mv', 'builtin_upload', 'builtin_pacs',
  'builtin_pipeline', 'builtin_pull', 'builtin_query', 'builtin_cubepath', 'builtin_dcm', 'builtin_image',
  'builtin_rm', 'builtin_touch', 'builtin_mkdir', 'builtin_rmdir', 'builtin_chmod', 'builtin_plugin', 'builtin_feed',
  'builtin_compute', 'builtin_tag', 'builtin_expect', 'builtin_play', 'builtin_record', 'builtin_gather', 'builtin_group', 'builtin_user', 'builtin_pluginmeta',
  'builtin_plugininstance', 'builtin_workflow', 'builtin_download', 'builtin_edit',
  'builtin_files', 'builtin_links', 'builtin_dirs', 'builtin_context',
  'builtin_parametersofplugin', 'builtin_physicalmode', 'builtin_prompt',
  'builtin_timing', 'builtin_id', 'builtin_whoami', 'builtin_whereami', 'builtin_version', 'builtin_fortune', 'builtin_weather', 'builtin_motd', 'builtin_date', 'builtin_cal',
  'builtin_debug', 'builtin_help', 'builtin_tree', 'builtin_du', 'builtin_store', 'builtin_setfacl', 'builtin_getfacl', 'builtin_setfattr', 'builtin_getfattr',
];
function builtinStubs_make(): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  for (const name of BUILTIN_NAMES) exports[name] = jest.fn();
  exports.builtin_ls = mockLs;
  exports.builtin_id = mockId;
  exports.builtin_whoami = mockWhoami;
  exports.builtin_pipeline = mockPipeline;
  exports.builtin_upload = mockUpload;
  exports.builtin_download = mockDownload;
  exports.error_stripDebugPrefix = (s: string): string => s;
  return exports;
}
jest.unstable_mockModule('../src/builtins/index.js', builtinStubs_make);
coreBuiltins_mock(builtinStubs_make());
jest.unstable_mockModule('../src/builtins/res/pipeline.js', () => ({ builtin_pipeline: mockPipeline }));

const mockExecutePlugin = jest.fn();
jest.unstable_mockModule('../src/builtins/pluginExecute.js', () => ({ builtin_executePlugin: mockExecutePlugin }));
jest.unstable_mockModule('../src/builtins/proc.js', () => ({ builtin_proc: jest.fn() }));
const mockShellWordsExpand = jest.fn(async (words) => Ok(words));
jest.unstable_mockModule('../src/lib/wildcard.js', () => ({ shellWords_expand: mockShellWordsExpand }));

const mockHelpRender = jest.fn((cmd: string) => `HELP:${cmd}\n`);
const mockHasHelpFlag = jest.fn(() => false);
const mockCommandHelpGet = jest.fn((): string | undefined => 'known help');
const mockPipelineExecutableHelpRender = jest.fn((name: string): string => `PIPELINE HELP:${name}\n`);
const mockPluginExecutableHelpRender = jest.fn((name: string): string => `PLUGIN HELP:${name}\n`);
jest.unstable_mockModule('../src/builtins/help.js', () => ({
  builtin_help: jest.fn(),
  help_render: mockHelpRender,
  args_checkHasHelpFlag: mockHasHelpFlag,
  commandHelp_get: mockCommandHelpGet,
  pluginExecutableHelp_render: mockPluginExecutableHelpRender,
  pipelineExecutableHelp_render: mockPipelineExecutableHelpRender,
  helpMissing_render: (name: string): string => `No help available for '${name}'\n`,
  verb_available: (): boolean => true,
}));

const mockPluginExecutable = jest.fn(async () => false);
jest.unstable_mockModule('../src/builtins/executable.js', () => ({ pluginExecutable_handle: mockPluginExecutable }));

const mockSudoCommandRun = jest.fn();
jest.unstable_mockModule('../src/core/elevation.js', () => ({ sudoCommand_run: mockSudoCommandRun }));

const { command_dispatch, command_dispatchEnvelope, command_executeToEnvelope } = await import('../src/core/dispatch.js');
// The ChRIS backend's commands, registered as brasa's entry registers them for
// every consumer (the engine's core imports none of them).
const { chrisCommands } = await import('../src/chris/chrisCommands.js');
(await import('../src/core/commandRegistry.js')).commands_register(chrisCommands);
// The ChRIS backend's fallback, watch and files: the session itself is mocked.
(await import('../src/core/backend.js')).backend_install({
  id: 'chris',
  session: {} as never,
  fallback: (await import('../src/chris/commandFallback.js')).chrisFallback,
  watch: (await import('../src/chris/watch.js')).chrisWatch,
  files: (await import('../src/chris/files.js')).chrisFiles,
});


let logSpy: jest.SpiedFunction<typeof console.log>;
let errSpy: jest.SpiedFunction<typeof console.error>;
let exitSpy: jest.SpiedFunction<typeof process.exit>;
beforeEach(() => {
  jest.clearAllMocks();
  mockCheckpointDrain.mockReturnValue([]);
  mockHasHelpFlag.mockReturnValue(false);
  mockCommandHelpGet.mockReturnValue('known help');
  mockTiming.mockReturnValue(false);
  mockExecutePlugin.mockResolvedValue({ status: 'ok', rendered: '' });
  mockSudoCommandRun.mockResolvedValue({ status: 'ok', rendered: 'elevated\n' });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((): never => {
    throw new Error('__exit__');
  }) as never);
});

describe('command_dispatch', () => {
  it('passes shell-expanded operands to a builtin without a command allow-list', async () => {
    mockExecutePlugin.mockResolvedValueOnce(null);
    mockShellWordsExpand.mockResolvedValueOnce(Ok([
      { value: '/home/chris/a.nii', pathnameExpanded: true },
      { value: '/home/chris/b.nii', pathnameExpanded: true },
    ]));

    await command_executeToEnvelope('ls *.nii', 0, false);

    expect(mockShellWordsExpand).toHaveBeenCalled();
    expect(mockLs).toHaveBeenCalledWith(['/home/chris/a.nii', '/home/chris/b.nii']);
  });

  it('preserves pathname-expansion provenance through normal dispatch', async () => {
    mockShellWordsExpand.mockResolvedValueOnce(Ok([
      { value: '/home/chris/a.nii', pathnameExpansion: false, pathnameExpanded: true },
      { value: '/home/chris/b.nii', pathnameExpansion: false, pathnameExpanded: true },
      { value: '/tmp/out', pathnameExpansion: false, pathnameExpanded: false },
    ]));

    await command_executeToEnvelope('download *.nii /tmp/out', 0, false);

    expect((mockDownload.mock.calls[0][0] as { pathnameExpanded?: readonly boolean[] }).pathnameExpanded)
      .toEqual([true, true, false]);
  });

  it('routes sudo through the scoped-elevation command seam', async () => {
    const envelope: CommandEnvelope = await command_dispatchEnvelope(
      'sudo',
      ['group', 'adduser', 'pacs_users', 'peter.hong'],
    );

    expect(mockSudoCommandRun).toHaveBeenCalledWith(
      ['group', 'adduser', 'pacs_users', 'peter.hong'],
      expect.any(Function),
    );
    expect(envelope).toEqual({ status: 'ok', rendered: 'elevated\n' });
  });

  it('says sudo\'s own refusal (bare sudo\'s usage), and the nested command\'s output only once', async () => {
    const { sink_get } = await import('../src/core/sink.js');
    const errWrite = jest.spyOn(sink_get(), 'err_write').mockImplementation(() => undefined);
    const dataWrite = jest.spyOn(sink_get(), 'data_write').mockImplementation(() => undefined);
    mockSudoCommandRun.mockResolvedValueOnce({ status: 'error', rendered: '', renderedErr: 'Usage: sudo <command> [arguments...]\n' });
    await command_dispatchEnvelope('sudo', []);
    expect(errWrite).toHaveBeenCalledWith('Usage: sudo <command> [arguments...]\n');
    errWrite.mockClear();
    mockSudoCommandRun.mockImplementationOnce(async (_args: unknown, run: unknown) =>
      (run as (c: string, a: string[]) => Promise<CommandEnvelope>)('ls', []));
    mockLs.mockResolvedValueOnce({ status: 'ok', rendered: 'listed\n' });
    errWrite.mockClear();
    dataWrite.mockClear();
    try {
      await command_dispatchEnvelope('sudo', ['ls']);
      expect(dataWrite.mock.calls.map((call) => String(call[0]))).toEqual(['listed\n']);
      expect(errWrite).not.toHaveBeenCalled();
    } finally {
      errWrite.mockRestore();
      dataWrite.mockRestore();
    }
  });

  it('applies transfer pathname policy beneath sudo', async () => {
    mockShellWordsExpand.mockResolvedValueOnce(Ok([
      { value: '/remote/a.nii', pathnameExpansion: false, pathnameExpanded: true },
      { value: '/remote/b.nii', pathnameExpansion: false, pathnameExpanded: true },
      { value: '/tmp/out', pathnameExpansion: false, pathnameExpanded: false },
    ]));

    await command_executeToEnvelope('sudo download *.nii /tmp/out', 0, false);

    const call = mockShellWordsExpand.mock.calls[0];
    expect(call[0]).toHaveLength(2);
    const eligible = call[1] as (_word: unknown, index: number) => boolean;
    expect(eligible({}, 0)).toBe(true);
    expect(eligible({}, 1)).toBe(false);
    const elevatedArgs = mockSudoCommandRun.mock.calls[0][0] as { pathnameExpanded?: readonly boolean[] };
    expect(elevatedArgs.pathnameExpanded).toEqual([false, true, true, false]);
  });

  it('routes a known command to its built-in handler', async () => {
    await command_dispatch('ls', ['-l']);
    expect(mockLs).toHaveBeenCalledWith(['-l']);
    expect(mockChiliRun).not.toHaveBeenCalled();
  });

  it('routes id to the identity builtin', async () => {
    await command_dispatch('id', []);
    expect(mockId).toHaveBeenCalledWith([]);
    expect(mockChiliRun).not.toHaveBeenCalled();
  });

  // Expansion belongs to the LINE path now, where quoting is still known.
  // `command_dispatch` takes words a caller has already split, so it has
  // nothing left to expand — and nothing in the stack calls it with raw
  // references.
  it('takes already-expanded words without expanding again', async () => {
    await command_dispatch('ls', ['/home/chris/data with spaces', '-l']);
    expect(mockLs).toHaveBeenCalledWith(['/home/chris/data with spaces', '-l']);
  });

  it('runs an exact /bin plugin match via builtin_executePlugin', async () => {
    mockDataGet.mockResolvedValue(Ok([{ name: 'pl-dircopy', type: 'plugin' }]));
    await command_dispatch('pl-dircopy', ['--dir', '/a']);
    expect(mockExecutePlugin).toHaveBeenCalledWith('pl-dircopy', ['--dir', '/a']);
  });

  it('runs a bare plugin name as the highest version /bin lists, and says which', async () => {
    mockDataGet.mockResolvedValue(Ok([{ name: 'pl-freesurfer-v1.0.1', type: 'plugin' }, { name: 'pl-freesurfer-v1.0.4', type: 'plugin' }]));
    const { sink_get } = await import('../src/core/sink.js');
    const dataWrite = jest.spyOn(sink_get(), 'data_write').mockImplementation(() => undefined);
    await command_dispatch('pl-freesurfer', ['--threads', '2']);
    expect(mockExecutePlugin).toHaveBeenCalledWith('pl-freesurfer-v1.0.4', ['--threads', '2']);
    expect(dataWrite.mock.calls.map((call) => String(call[0]))).toContainEqual(expect.stringContaining('running pl-freesurfer-v1.0.4 (highest of 1.0.1, 1.0.4)'));
    dataWrite.mockRestore();
  });

  it('does not start a job for a bare plugin name inside a pipe', async () => {
    mockDataGet.mockResolvedValue(Ok([{ name: 'pl-freesurfer-v1.0.4', type: 'plugin' }]));
    const { chrisFallback } = await import('../src/chris/commandFallback.js');
    await chrisFallback.unknown!('pl-freesurfer', [], true);
    expect(mockExecutePlugin).not.toHaveBeenCalled();
  });

  it('runs a /bin pipeline on a directory operand: a feed node by --previous, elsewhere a new feed pl-dircopy roots', async () => {
    mockDataGet.mockResolvedValue(Ok([{ name: 'myPipe', type: 'pipeline' }]));
    mockPipeline.mockResolvedValue({ status: 'ok', rendered: '' });
    world['/home/u/feeds/feed_3/pl-dircopy_12'] = 'dir';
    world['/home/u/uploads/subjects'] = 'dir';
    await command_dispatch('myPipe', ['/home/u/feeds/feed_3/pl-dircopy_12', '--compute', 'host']);
    expect(mockPipeline).toHaveBeenLastCalledWith(['run', 'myPipe', '--previous', '12', '--compute', 'host']);
    mockFeedCreate.mockResolvedValue({ id: 9, name: 'subjects', owner_username: 'u', pluginInstance: { data: { id: 40 } } });
    await command_dispatch('myPipe', ['/home/u/uploads/subjects']);
    expect(mockFeedCreate).toHaveBeenCalledWith(['/home/u/uploads/subjects'], { title: 'subjects' });
    expect(mockPipeline).toHaveBeenLastCalledWith(['run', 'myPipe', '--previous', '40']);
  });

  it('runs a bare /bin pipeline from a plain folder by rooting a feed on it, as a plugin does; from a feed node, as before (#1364)', async () => {
    mockDataGet.mockResolvedValue(Ok([{ name: 'myPipe', type: 'pipeline' }]));
    const scheduled = { kind: 'pipeline.scheduled', data: { pipelineName: 'myPipe', workflowId: 1, feedId: 9, newFeed: false, instances: [], leaves: [], leafPaths: [] } };
    mockPipeline.mockResolvedValue({ status: 'ok', rendered: '', model: scheduled });
    mockFeedCreate.mockResolvedValue({ id: 9, name: 'try-1', owner_username: 'u', pluginInstance: { data: { id: 41 } } });
    cwdNow = '/home/u/uploads/transcribe/try-1';
    world[cwdNow] = 'dir';
    const rooted = await command_dispatchEnvelope('myPipe', ['--compute', 'host']);
    expect(mockFeedCreate).toHaveBeenLastCalledWith(['/home/u/uploads/transcribe/try-1'], { title: 'try-1' });
    expect(mockPipeline).toHaveBeenLastCalledWith(['run', 'myPipe', '--previous', '41', '--compute', 'host']);
    expect((rooted.model as { data: { newFeed: boolean } }).data.newFeed).toBe(true);
    // Inside a feed node nothing is rooted: the run reads the node from where it stands.
    cwdNow = '/home/u/feeds/feed_3/pl-dircopy_12/data';
    mockFeedCreate.mockClear();
    await command_dispatch('myPipe', []);
    expect(mockFeedCreate).not.toHaveBeenCalled();
    expect(mockPipeline).toHaveBeenLastCalledWith(['run', 'myPipe']);
    // --previous typed says the input itself; nothing is rooted either.
    cwdNow = '/home/u/uploads/transcribe/try-1';
    await command_dispatch('myPipe', ['--previous', '5']);
    expect(mockFeedCreate).not.toHaveBeenCalled();
    expect(mockPipeline).toHaveBeenLastCalledWith(['run', 'myPipe', '--previous', '5']);
    cwdNow = '/home/u/feeds/feed_3/pl-dircopy_12/data';
  });

  it('runs a /bin pipeline once per directory operand, each placed on its own, as a glob of directories arrives (#1439, #1449)', async () => {
    mockDataGet.mockResolvedValue(Ok([{ name: 'myPipe', type: 'pipeline' }]));
    mockPipeline.mockClear();
    mockPipeline.mockResolvedValue({ status: 'ok', rendered: '' });
    mockFeedCreate.mockClear();
    for (const name of ['sub-01', 'sub-02', 'sub-03']) world[`/home/u/uploads/${name}`] = 'dir';
    world['/home/u/feeds/feed_3/pl-dircopy_12'] = 'dir';
    mockFeedCreate.mockResolvedValueOnce({ id: 9, name: 'sub-01', owner_username: 'u', pluginInstance: { data: { id: 40 } } })
      .mockResolvedValueOnce({ id: 10, name: 'sub-02', owner_username: 'u', pluginInstance: { data: { id: 41 } } })
      .mockResolvedValueOnce({ id: 11, name: 'sub-03', owner_username: 'u', pluginInstance: { data: { id: 42 } } });
    // The shell hands the fallback the three words `~/uploads/sub-*` expanded to.
    mockShellWordsExpand.mockResolvedValueOnce(Ok([
      { value: '/home/u/uploads/sub-01', pathnameExpanded: true },
      { value: '/home/u/uploads/sub-02', pathnameExpanded: true },
      { value: '/home/u/uploads/sub-03', pathnameExpanded: true },
    ]));
    await command_executeToEnvelope('myPipe /home/u/uploads/sub-*', 0, false);
    expect(mockFeedCreate.mock.calls.map((call) => call[1])).toEqual([{ title: 'sub-01' }, { title: 'sub-02' }, { title: 'sub-03' }]);
    expect(mockPipeline.mock.calls.map((call) => call[0])).toEqual([
      ['run', 'myPipe', '--previous', '40', '--detach'],
      ['run', 'myPipe', '--previous', '41', '--detach'],
      ['run', 'myPipe', '--previous', '42', '--detach'],
    ]);
    // A node inside the tree beside a folder outside it: one attaches, the other roots a feed.
    mockPipeline.mockClear();
    mockFeedCreate.mockClear();
    mockFeedCreate.mockResolvedValue({ id: 12, name: 'sub-01', owner_username: 'u', pluginInstance: { data: { id: 43 } } });
    await command_dispatch('myPipe', ['/home/u/feeds/feed_3/pl-dircopy_12', '/home/u/uploads/sub-01', '--detach']);
    expect(mockPipeline.mock.calls.map((call) => call[0])).toEqual([
      ['run', 'myPipe', '--previous', '12', '--detach'],
      ['run', 'myPipe', '--previous', '43', '--detach'],
    ]);
  });

  it('refuses a /bin pipeline line of several directories whole when one would refuse, creating nothing', async () => {
    mockDataGet.mockResolvedValue(Ok([{ name: 'myPipe', type: 'pipeline' }]));
    mockPipeline.mockClear();
    mockFeedCreate.mockClear();
    world['/home/u/uploads/sub-01'] = 'dir';
    world['/home/u/feeds/feed_3/data'] = 'dir';
    world['/home/u/uploads/t1.nii'] = 'file';
    const { sink_get } = await import('../src/core/sink.js');
    const errWrite = jest.spyOn(sink_get(), 'err_write').mockImplementation(() => undefined);
    expect((await command_dispatchEnvelope('myPipe', ['/home/u/uploads/sub-01', '/home/u/uploads/none'])).status).toBe('error');
    expect((await command_dispatchEnvelope('myPipe', ['/home/u/uploads/sub-01', '/home/u/feeds/feed_3/data'])).status).toBe('error');
    expect((await command_dispatchEnvelope('myPipe', ['/home/u/uploads/sub-01', '/home/u/uploads/t1.nii'])).status).toBe('error');
    expect((await command_dispatchEnvelope('myPipe', ['/home/u/uploads/sub-9*'])).status).toBe('error');
    const said: string = errWrite.mock.calls.map((call) => String(call[0])).join('');
    expect(said).toContain('/home/u/uploads/none: no such file or directory');
    expect(said).toContain('/home/u/feeds/feed_3/data is in a feed but not at a node');
    expect(said).toContain('do not mix');
    expect(said).toContain('/home/u/uploads/sub-9*: no match');
    expect(mockFeedCreate).not.toHaveBeenCalled();
    expect(mockPipeline).not.toHaveBeenCalled();
    errWrite.mockRestore();
  });

  it('refuses a /bin pipeline given files of two nodes, staging nothing and making no feed (#1440)', async () => {
    mockDataGet.mockResolvedValue(Ok([{ name: 'myPipe', type: 'pipeline' }]));
    mockPipeline.mockClear();
    mockFeedCreate.mockClear();
    world['/home/u/feeds/feed_3/pl-dircopy_12/a.nii'] = 'file';
    world['/home/u/feeds/feed_3/pl-x_13/b.nii'] = 'file';
    const { sink_get } = await import('../src/core/sink.js');
    const errWrite = jest.spyOn(sink_get(), 'err_write').mockImplementation(() => undefined);
    const refused = await command_dispatchEnvelope('myPipe', ['/home/u/feeds/feed_3/pl-dircopy_12/a.nii', '/home/u/feeds/feed_3/pl-x_13/b.nii']);
    expect(refused.status).toBe('error');
    expect(errWrite.mock.calls.map((call) => String(call[0])).join('')).toContain('the operands are in two nodes');
    expect(Object.keys(world).some((path) => path.includes('/.mise/stage/'))).toBe(false);
    expect(mockFeedCreate).not.toHaveBeenCalled();
    expect(mockPipeline).not.toHaveBeenCalled();
    errWrite.mockRestore();
  });

  it('refuses a /bin pipeline operand beside --previous, and a missing path, running nothing', async () => {
    mockDataGet.mockResolvedValue(Ok([{ name: 'myPipe', type: 'pipeline' }]));
    world['/home/u/uploads/subjects'] = 'dir';
    const { sink_get } = await import('../src/core/sink.js');
    const errWrite = jest.spyOn(sink_get(), 'err_write').mockImplementation(() => undefined);
    const twice = await command_dispatchEnvelope('myPipe', ['/home/u/uploads/subjects', '--previous', '5']);
    expect(twice.status).toBe('error');
    const twiceAssigned = await command_dispatchEnvelope('myPipe', ['/home/u/uploads/subjects', '--previous=5']);
    expect(twiceAssigned.status).toBe('error');
    const twiceBefore = await command_dispatchEnvelope('myPipe', ['--previous=5', '/home/u/uploads/subjects']);
    expect(twiceBefore.status).toBe('error');
    const missing = await command_dispatchEnvelope('myPipe', ['/home/u/uploads/none']);
    expect(missing.status).toBe('error');
    expect(errWrite.mock.calls.map((call) => String(call[0])).join('')).toContain('no such file or directory');
    expect(mockPipeline).not.toHaveBeenCalled();
    errWrite.mockRestore();
  });

  it('preserves a direct plugin failure envelope', async () => {
    mockDataGet.mockResolvedValue(Ok([{ name: 'pl-dircopy', type: 'plugin' }]));
    mockExecutePlugin.mockResolvedValue({ status: 'error', rendered: '' });

    const result = await command_dispatchEnvelope('pl-dircopy', ['unexpected']);

    expect(result.status).toBe('error');
  });

  it('runs a /bin pipeline name as a pipeline run', async () => {
    mockDataGet.mockResolvedValue(Ok([{ name: 'myPipe', type: 'pipeline' }]));
    await command_dispatch('myPipe', ['--compute', 'host']);
    expect(mockPipeline).toHaveBeenCalledWith(['run', 'myPipe', '--compute', 'host']);
  });

  it('routes pipeline --nodes to pipeline info', async () => {
    mockDataGet.mockResolvedValue(Ok([{ name: 'myPipe', type: 'pipeline' }]));
    await command_dispatch('myPipe', ['--nodes']);
    expect(mockPipeline).toHaveBeenCalledWith(['info', 'myPipe']);
  });

  it('routes pipeline --source to pipeline source', async () => {
    mockDataGet.mockResolvedValue(Ok([{ name: 'myPipe', type: 'pipeline' }]));
    await command_dispatch('myPipe', ['--source']);
    expect(mockPipeline).toHaveBeenCalledWith(['source', 'myPipe']);
  });

  it('routes pipeline --manifest to the registered invocation manifest', async () => {
    mockDataGet.mockResolvedValue(Ok([{ name: 'myPipe', type: 'pipeline' }]));
    await command_dispatch('myPipe', ['--manifest']);
    expect(mockPipeline).toHaveBeenCalledWith(['manifest', 'myPipe']);
  });

  it('routes pipeline executable diagram flags through pipeline diagram', async () => {
    mockDataGet.mockResolvedValue(Ok([{ name: 'myPipe', type: 'pipeline' }]));

    await command_dispatch('myPipe', ['--diagram']);
    await command_dispatch('myPipe', ['--diagram', '--withargs']);
    await command_dispatch('myPipe', ['--diagram', '--signalflow']);

    expect(mockPipeline).toHaveBeenNthCalledWith(1, ['diagram', 'myPipe']);
    expect(mockPipeline).toHaveBeenNthCalledWith(2, ['diagram', 'myPipe', '--withargs']);
    expect(mockPipeline).toHaveBeenNthCalledWith(3, ['diagram', 'myPipe', '--signalflow']);
  });

  it('routes bare pipeline --signalflow through the diagram emitter', async () => {
    mockDataGet.mockResolvedValue(Ok([{ name: 'myPipe', type: 'pipeline' }]));

    await command_dispatch('myPipe', ['--signalflow']);

    expect(mockPipeline).toHaveBeenCalledWith(['diagram', 'myPipe', '--signalflow']);
  });

  it('renders contextual help for a pipeline executable', async () => {
    mockHasHelpFlag.mockReturnValue(true);
    mockCommandHelpGet.mockReturnValue(undefined);
    mockDataGet.mockResolvedValue(Ok([{ name: 'myPipe', type: 'pipeline' }]));

    const envelope: CommandEnvelope | null = await command_executeToEnvelope('myPipe --help', 0, false);

    expect(envelope?.rendered).toBe('PIPELINE HELP:myPipe\n');
    expect(mockPipelineExecutableHelpRender).toHaveBeenCalledWith('myPipe');
    expect(mockPipeline).not.toHaveBeenCalled();
  });

  it('retains generic help for an unknown command', async () => {
    mockHasHelpFlag.mockReturnValue(true);
    mockCommandHelpGet.mockReturnValue(undefined);
    mockDataGet.mockResolvedValue(Ok([]));

    const envelope: CommandEnvelope | null = await command_executeToEnvelope('missing --help', 0, false);

    expect(envelope?.rendered).toBe("No help available for 'missing'\n");
    expect(mockPipelineExecutableHelpRender).not.toHaveBeenCalled();
  });

  it('returns the pipeline diagram envelope from the executable alias', async () => {
    mockDataGet.mockResolvedValue(Ok([{ name: 'myPipe', type: 'pipeline' }]));
    mockPipeline.mockResolvedValue({
      status: 'ok', rendered: 'PIPELINE TREE\n', model: { kind: 'pipeline.diagram', data: { pipelineID: 7 } },
    });

    const envelope: CommandEnvelope = await command_dispatchEnvelope('myPipe', ['--diagram']);

    expect(envelope.rendered).toBe('PIPELINE TREE\n');
    expect(envelope.model).toMatchObject({ kind: 'pipeline.diagram' });
  });

  it('delegates a known chili command with -s, emitting the notice before running it', async () => {
    mockDataGet.mockResolvedValue(Ok([]));
    // The notice goes to the live sink *before* chili runs, so it is written to
    // stdout rather than glued onto the returned envelope.
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await command_dispatchEnvelope('frobnicate', ['x']);
    const written: string = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(mockChiliRun).toHaveBeenCalledWith(['frobnicate', '-s', 'x']);
    expect(written).toContain('delegating to chili');
    writeSpy.mockRestore();
  });

  it('carries the captured chili output in the fallback envelope', async () => {
    mockDataGet.mockResolvedValue(Ok([]));
    mockChiliRun.mockResolvedValueOnce({ out: 'CHILI_SAYS_HI\n', err: '' });
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const envelope = await command_dispatchEnvelope('frobnicate', ['x']);
    expect(envelope.status).toBe('ok');
    expect(envelope.rendered).toContain('CHILI_SAYS_HI');
    expect(mockChiliRun).toHaveBeenCalledWith(['frobnicate', '-s', 'x']);
    writeSpy.mockRestore();
  });

  it('reports "command not found" for a command chili does not know, without delegating', async () => {
    mockDataGet.mockResolvedValue(Ok([]));
    const envelope = await command_dispatchEnvelope('definitelynotacommand', ['x']);
    expect(mockChiliRun).not.toHaveBeenCalled();
    expect(envelope.status).toBe('error');
    expect(envelope.renderedErr).toContain('command not found');
  });

  it('carries --help output in an envelope through the sink, not the console', async () => {
    // A --help flag must route the help text through the envelope/sink so it
    // reaches the surface (a remote client), never printing to a daemon's
    // terminal via console.log.
    mockHasHelpFlag.mockReturnValueOnce(true);
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const envelope = await command_executeToEnvelope('feeds --help', 0, false);
    expect(mockHelpRender).toHaveBeenCalledWith('feeds');
    expect(envelope?.status).toBe('ok');
    expect(envelope?.rendered).toContain('HELP:feeds');
    // Delivered through the sink (default StdoutSink -> process.stdout).
    expect(writeSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('HELP:feeds');
    writeSpy.mockRestore();
  });

  it('carries plugin executable output in an envelope through the sink', async () => {
    mockPluginExecutable.mockResolvedValueOnce({ status: 'ok', rendered: 'PLUGIN HELP:pl-x-v1\n' });
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const envelope = await command_executeToEnvelope('pl-x-v1 --help', 0, false);

    expect(envelope?.rendered).toBe('PLUGIN HELP:pl-x-v1\n');
    expect(writeSpy.mock.calls.map((call) => String(call[0])).join('')).toContain('PLUGIN HELP:pl-x-v1');
    expect(logSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('yields a placeholder envelope for a direct-run handler', async () => {
    mockDataGet.mockResolvedValue(Ok([{ name: 'pl-x', type: 'plugin' }]));
    mockExecutePlugin.mockResolvedValueOnce(undefined);
    const envelope = await command_dispatchEnvelope('pl-x', []);
    expect(envelope).toEqual({ status: 'ok', rendered: '' });
  });

  it('marks the placeholder envelope as failed when the handler sets a nonzero exit code', async () => {
    const previousExitCode: number | string | undefined = process.exitCode;
    process.exitCode = 0;
    mockDataGet.mockResolvedValue(Ok([{ name: 'pl-x', type: 'plugin' }]));
    mockExecutePlugin.mockImplementationOnce(async () => { process.exitCode = 1; });
    const envelope = await command_dispatchEnvelope('pl-x', []);
    expect(envelope.status).toBe('error');
    process.exitCode = previousExitCode;
  });

  it('drains errorStack messages into the envelope and escalates status', async () => {
    // A command that left an error on the stack but did not change exitCode:
    // the drain still records it and the envelope reads error.
    mockCheckpointDrain.mockReturnValueOnce([{ type: 'error', message: 'boom from ls' }]);
    const envelope = await command_dispatchEnvelope('ls', []);
    expect(envelope.status).toBe('error');
    expect(envelope.errors).toEqual([{ type: 'error', message: 'boom from ls' }]);
  });

  it('attaches drained warnings without escalating status', async () => {
    mockCheckpointDrain.mockReturnValueOnce([{ type: 'warning', message: 'heads up' }]);
    const envelope = await command_dispatchEnvelope('ls', []);
    expect(envelope.status).toBe('ok');
    expect(envelope.errors).toEqual([{ type: 'warning', message: 'heads up' }]);
  });

  it('delegates to chili when the /bin lookup fails', async () => {
    mockDataGet.mockResolvedValue(Err());
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await command_dispatch('frobnicate', []);
    expect(mockChiliRun).toHaveBeenCalledWith(['frobnicate', '-s']);
    writeSpy.mockRestore();
  });

  it('delegates the pacsservers alias to chili', async () => {
    await command_dispatch('pacsservers', ['--query', 'x']);
    expect(mockChiliRun).toHaveBeenCalledWith(['pacsservers', '-s', '--query', 'x']);
  });

  it('delegates the pacsqueries and pacsretrieve aliases to chili', async () => {
    await command_dispatch('pacsqueries', ['a']);
    expect(mockChiliRun).toHaveBeenCalledWith(['pacsqueries', '-s', 'a']);
    await command_dispatch('pacsretrieve', ['b']);
    expect(mockChiliRun).toHaveBeenCalledWith(['pacsretrieve', '-s', 'b']);
  });

  it('exits the process on "exit"', async () => {
    await expect(command_dispatch('exit', [])).rejects.toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

// Line-level orchestration (shell escape, semicolon batching, redirects,
// pipes) is tested through the engine facade in engine.test.ts.
