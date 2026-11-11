/**
 * @file Tests for the engine facade: line-level orchestration (shell escape,
 * semicolon batching, redirects, pipes), envelope collection, completion,
 * and engine creation.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { coreBuiltins_mock } from './support/coreBuiltins.js';
import { cuminMock_install } from './support/cuminMock.js';

// Minimal cumin surface used by the dispatch layer (Result helpers + error stack).
const Ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
const Err = (): { ok: false } => ({ ok: false });
cuminMock_install(() => ({
  path_isInFeed: (): boolean => false,
  path_extractPluginInstanceID: (): number | null => null,
  feedTags_readByFeed: jest.fn(),
  listCache_get: jest.fn(() => ({ cache_get: (): null => null, cache_set: jest.fn() })),
  feedStatus_deriveFromCounts: (): string => 'finishedSuccessfully',
  envelope_ok: (rendered: string) => ({ status: 'ok', rendered }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
  Ok,
  Err,
  errorStack: {
    stack_pop: jest.fn(() => undefined),
    stack_push: jest.fn(),
    checkpoint_mark: jest.fn(() => 0),
    checkpoint_drain: jest.fn(() => []),
    scope_run: (fn: () => unknown) => fn(),
  },
  procCache_get: () => ({ feeds_find: () => [], feedScopeCounts_get: () => ({ user: 0, public: 0, shared: 0, total: 0 }), warmupProgress_get: () => ({ active: false, loaded: 0, total: 0 }), lifecycle_get: () => ({ state: 'cold' }) }),
  requestLedger_snapshot: () => ({ since: '', total: 0, ms: 0, families: [], last: [] }),
  chrisContext: { ChRISURL_get: async () => null, ChRISuser_get: async () => null },
}));

// The /bin listing model is type-only at runtime.
jest.unstable_mockModule('@fnndsc/chili/models/listing.js', () => ({}));

// chili delegation target.
const mockChiliRun = jest.fn(async () => ({ out: '', err: '' }));
const mockCommandNames = jest.fn(async () => new Set<string>(['frobnicate']));
jest.unstable_mockModule('@fnndsc/chili/run.js', () => ({ run: jest.fn(), run_capture: mockChiliRun, commandNames_get: mockCommandNames }));

// Session — the engine reads the timing toggle and initializes on creation.
const mockTiming = jest.fn(() => false);
const mockSessionInit = jest.fn(async () => undefined);
const mockPhysicalMode = jest.fn(() => false);
jest.unstable_mockModule('../src/session/index.js', () => ({
  session: {
    timingEnabled_get: mockTiming,
    init: mockSessionInit,
    physicalMode_get: mockPhysicalMode,
  },
}));

// Watches: the engine facade delegates to the sampler registry.
const mockWatchAdd = jest.fn((): string => 'live');
const mockWatchRemove = jest.fn();
const mockWatchRelease = jest.fn();
const mockWatchState = jest.fn((): string => 'settled');
jest.unstable_mockModule('../src/builtins/procWatch.js', () => ({
  procWatch_add: mockWatchAdd,
  procWatch_remove: mockWatchRemove,
  procWatch_release: mockWatchRelease,
  procWatch_state: mockWatchState,
  watchSubject_parse: (subject: string): number | null => (/feed_(\d+)$/.exec(subject) ? Number(/feed_(\d+)$/.exec(subject)![1]) : null),
}));

// Redirect targets: real preprocess resolves the path (statSync), dispatch writes it.
const mockWriteFile = jest.fn();
const mockAppendFile = jest.fn();
const enoent = (): never => { const e: NodeJS.ErrnoException = new Error('nope'); e.code = 'ENOENT'; throw e; };
const mockStatSync = jest.fn(enoent);
jest.unstable_mockModule('fs', () => ({
  statSync: mockStatSync,
  writeFileSync: mockWriteFile,
  appendFileSync: mockAppendFile,
  // Every session's runner looks for joblets kept by an earlier one.
  existsSync: (): boolean => false,
}));

// VFS — command dispatch consults /bin for plugin/pipeline names.
const mockDataGet = jest.fn();
jest.unstable_mockModule('../src/lib/vfs/vfs.js', () => ({ vfs: { data_get: mockDataGet } }));

// Built-in command table. Every name is a jest.fn() so COMMAND_HANDLERS is
// fully populated; the ones asserted on are captured by reference.
const mockLs = jest.fn();
const mockWhoami = jest.fn();
const mockPipeline = jest.fn();
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
  exports.builtin_whoami = mockWhoami;
  exports.builtin_pipeline = mockPipeline;
  exports.error_stripDebugPrefix = (s: string): string => s;
  return exports;
}
jest.unstable_mockModule('../src/builtins/index.js', builtinStubs_make);
coreBuiltins_mock(builtinStubs_make());
jest.unstable_mockModule('../src/builtins/res/pipeline.js', () => ({ builtin_pipeline: mockPipeline }));

const mockExecutePlugin = jest.fn();
jest.unstable_mockModule('../src/builtins/pluginExecute.js', () => ({ builtin_executePlugin: mockExecutePlugin }));
jest.unstable_mockModule('../src/builtins/proc.js', () => ({ builtin_proc: jest.fn() }));
jest.unstable_mockModule('../src/lib/wildcard.js', () => ({ shellWords_expand: jest.fn(async (words) => Ok(words)) }));

const mockHelpRender = jest.fn((cmd: string) => `HELP:${cmd}\n`);
const mockHasHelpFlag = jest.fn(() => false);
jest.unstable_mockModule('../src/builtins/help.js', () => ({
  builtin_help: jest.fn(),
  help_render: mockHelpRender,
  commandHelp_get: jest.fn(() => 'known help'),
  pipelineExecutableHelp_render: jest.fn((name: string): string => `PIPELINE HELP:${name}\n`),
  args_checkHasHelpFlag: mockHasHelpFlag,
  helpMissing_render: (name: string): string => `No help available for '${name}'\n`,
  verb_available: (): boolean => true,
  pluginExecutableHelp_render: jest.fn((name: string): string => `PLUGIN HELP:${name}\n`),
}));

const mockPluginExecutable = jest.fn(async () => false);
jest.unstable_mockModule('../src/builtins/executable.js', () => ({ pluginExecutable_handle: mockPluginExecutable }));
jest.unstable_mockModule('../src/core/elevation.js', () => ({
  sudoCommand_run: jest.fn(async (): Promise<{ status: string; rendered: string }> => ({ status: 'ok', rendered: '' })),
}));

// Pipe segments now run through the active surface; the test installs a
// surface whose pipeSegment delegates to this mock.
const mockSegmentPipe = jest.fn();
const mockShellCommand = jest.fn(async (_command: string): Promise<number> => 0);
jest.unstable_mockModule('../src/lib/pipe.js', () => ({ segment_pipeThrough: mockSegmentPipe }));

// Engine creation registers the static VFS providers on the salsa dispatcher.
const mockProviderRegister = jest.fn();
const mockPathResolverRegister = jest.fn();
const mockIsVirtual = jest.fn((path: string): boolean => path.startsWith('/proc/'));
const mockReadBinary = jest.fn(async (_path: string): Promise<{ ok: boolean; value?: Buffer }> => ({ ok: false }));
const mockLinkTarget = jest.fn(async (_path: string): Promise<{ ok: boolean; value?: string }> => ({ ok: false }));
jest.unstable_mockModule('../src/builtins/res/runWait.js', () => ({
  runs_awaitSettled: async () => ({ outcome: 'settled', failed: 0 }), settlement_render: () => 'settled', settlementStatus_derive: () => 'finishedSuccessfully',
}));
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  feed_create: jest.fn(),
  dicomSeries_summarize: jest.fn(),
  dicomFolder_list: jest.fn(),
  dicomHeader_get: jest.fn(),
  dicomTags_summarize: jest.fn(),
  dicomFiles_sample: jest.fn(),
  vfsDispatcher: {
    provider_register: mockProviderRegister,
    pathResolver_register: mockPathResolverRegister,
    containerTest_register: jest.fn(),
    path_isVirtual: mockIsVirtual,
    readBinary: mockReadBinary,
    linkTarget_resolve: mockLinkTarget,
  },
  context_getSingle: jest.fn(() => ({ user: 'u', URL: 'http://x' })),
}));

// The two doors `file_read` reaches for: ChILI's binary cat, and the link
// walk that turns a logical path into the file CUBE actually stores.
const mockCatBinary = jest.fn(async (_path: string): Promise<{ ok: boolean; value?: Buffer }> => ({ ok: false }));
const mockToPhysical = jest.fn(async (path: string): Promise<{ ok: boolean; value?: string }> => ({ ok: true, value: path }));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/cat.js', () => ({ files_cat: jest.fn(), files_catBinary: mockCatBinary }));
jest.unstable_mockModule('@fnndsc/chili/utils', () => ({ logicalPath_resolve: mockToPhysical }));

// The path a caller gave, already absolute in these cases.
jest.unstable_mockModule('../src/builtins/utils.js', () => ({
  path_resolve: jest.fn(async (path: string): Promise<string> => path),
  path_resolvePure: jest.fn((path: string): string => path),
  commandArgs_process: jest.fn(),
  error_stripDebugPrefix: (s: string): string => s,
}));
class FakeStaticProvider { constructor(public readonly root: string) {} }
jest.unstable_mockModule('../src/lib/vfs/providers/static.js', () => ({ StaticVfsProvider: FakeStaticProvider }));

// Completion delegates to the callback-style completer.
type CompleterCallback = (err: Error | null, result: [string[], string]) => void;
const mockInputComplete = jest.fn((line: string, callback: CompleterCallback): void => {
  callback(null, [['ls', 'logout'], line]);
});
jest.unstable_mockModule('../src/lib/completer/index.js', () => ({ input_complete: mockInputComplete }));

const {
  line_execute,
  line_complete,
  command_handle,
  engine_create,
  stopOnError_set,
  file_read,
} = await import('../src/core/engine.js');
// The ChRIS backend's commands, registered as brasa's entry registers them for
// every consumer (the engine's core imports none of them).
const { chrisCommands } = await import('../src/chris/chrisCommands.js');
(await import('../src/core/commandRegistry.js')).commands_register(chrisCommands);
const { builtinCommand_has } = await import('../src/core/commandRegistry.js');
// The ChRIS backend's fallback, watch and files: the session itself is mocked.
(await import('../src/core/backend.js')).backend_install({
  id: 'chris',
  session: {} as never,
  fallback: (await import('../src/chris/commandFallback.js')).chrisFallback,
  watch: (await import('../src/chris/watch.js')).chrisWatch,
  files: (await import('../src/chris/files.js')).chrisFiles,
  vfs: (await import('../src/chris/filesystem.js')).chrisFilesystem,
});

const { surface_set } = await import('../src/core/surface.js');
const { BufferSink, CaptureSink, sink_set } = await import('../src/core/sink.js');

let output: InstanceType<typeof CaptureSink>;
beforeEach(() => {
  jest.clearAllMocks();
  mockHasHelpFlag.mockReturnValue(false);
  mockTiming.mockReturnValue(false);
  mockStatSync.mockImplementation(enoent);
  // Install a surface that can run local process capabilities, delegating to mocks.
  surface_set({
    capabilities: {
      hiddenInput: false,
      localEdit: false,
      tty: false,
      pipeSegments: true,
      shellCommands: true,
    },
    prompt: async (): Promise<string> => '',
    pipeSegment: (command: string, input: Buffer): Promise<Buffer> => mockSegmentPipe(command, input) as Promise<Buffer>,
    shellCommand: (command: string): Promise<number> => mockShellCommand(command),
    localEdit: async (r: { content: string }): Promise<{ content: string; changed: boolean }> => ({ content: r.content, changed: false }),
  });
  output = new CaptureSink(new BufferSink());
  sink_set(output);
});

/**
 * Command names the core and the ChRIS backend must register between them.
 */
const EXPECTED_HANDLERS: string[] = [
  // filesystem
  'cd', 'pwd', 'ls', 'cat', 'cp', 'mv', 'rm', 'touch', 'mkdir', 'tree', 'du',
  'upload', 'download', 'pull',
  // net
  'connect', 'logout', 'pacs', 'query', 'cubepath',
  // sys
  'context', 'physicalmode', 'timing', 'id', 'whoami', 'whereami', 'debug', 'help',
  // resources — canonical
  'plugin', 'plugins', 'feed', 'feeds',
  'pipeline', 'pipelines',
  'compute', 'computes',
  'files', 'links', 'dirs',
  'store',
  'tag', 'tags',
  'group', 'groups',
  'pluginmeta', 'pluginmetas', 'meta', 'metas',
  'plugininstance', 'plugininstances', 'instance', 'instances', 'job', 'jobs',
  'workflow', 'workflows',
  'parametersofplugin',
];

describe('the registered commands', () => {
  it('contains all expected handler keys', () => {
    for (const key of EXPECTED_HANDLERS) {
      expect(builtinCommand_has(key)).toBe(true);
    }
  });

  it('job/jobs are registered', () => {
    expect(builtinCommand_has('job')).toBe(true);
    expect(builtinCommand_has('jobs')).toBe(true);
  });

  it('meta/metas aliases are registered', () => {
    expect(builtinCommand_has('meta')).toBe(true);
    expect(builtinCommand_has('metas')).toBe(true);
  });

  it('instance/instances aliases are registered', () => {
    expect(builtinCommand_has('instance')).toBe(true);
    expect(builtinCommand_has('instances')).toBe(true);
  });
});

describe('line_execute', () => {
  it('ignores a blank line and returns no envelopes', async () => {
    const envelopes = await line_execute('   ');
    expect(envelopes).toEqual([]);
    expect(mockLs).not.toHaveBeenCalled();
    expect(mockChiliRun).not.toHaveBeenCalled();
  });

  it('refuses a line whose quote never closes, by name, and runs none of it (#1260)', async () => {
    const said: string[] = [];
    const { sink_set, sink_get } = await import('../src/core/sink.js');
    const before = sink_get();
    sink_set({ ...before, err_write: (text: string): void => { said.push(text); } } as typeof before);
    for (const line of ["whoami 'it\\'s'", 'whoami; ls "a', "whoami | ls 'x; pwd"]) {
      process.exitCode = 0;
      const envelopes = await line_execute(line);
      expect(envelopes).toEqual([{ status: 'error', rendered: '' }]);
      expect(process.exitCode).toBe(2);
    }
    expect(mockWhoami).not.toHaveBeenCalled();
    expect(mockLs).not.toHaveBeenCalled();
    sink_set(before);
    expect(said.join('')).toContain("the ' at column 14 never closes; nothing of the line ran");
    process.exitCode = 0;
  });

  it('runs a line whose quotes all close, an apostrophe written the POSIX way included', async () => {
    await line_execute("whoami 'it'\\''s' \"a\\\"b\" it\\'s");
    expect(mockWhoami).toHaveBeenCalledTimes(1);
  });

  it('dispatches a plain command end-to-end and returns one envelope', async () => {
    const envelopes = await line_execute('whoami');
    expect(mockWhoami).toHaveBeenCalledWith([]);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].status).toBe('ok');
  });

  it('short-circuits on a --help flag, returning the help envelope without dispatching', async () => {
    mockHasHelpFlag.mockReturnValue(true);
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const envelopes = await line_execute('ls --help');
    expect(mockHelpRender).toHaveBeenCalledWith('ls');
    expect(mockLs).not.toHaveBeenCalled();
    expect(envelopes).toEqual([{ status: 'ok', rendered: 'HELP:ls\n' }]);
    writeSpy.mockRestore();
  });

  it('runs each command in a semicolon-separated list, one envelope per segment', async () => {
    const envelopes = await line_execute('whoami; whoami');
    expect(mockWhoami).toHaveBeenCalledTimes(2);
    expect(envelopes).toHaveLength(2);
  });

  it('captures the first segment and pipes it through the rest', async () => {
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mockSegmentPipe.mockResolvedValue(Buffer.from('piped'));
    const envelopes = await line_execute('whoami | awk 1');
    expect(mockWhoami).toHaveBeenCalled();
    expect(mockSegmentPipe).toHaveBeenCalledWith('awk 1', expect.any(Buffer));
    expect(envelopes).toEqual([{ status: 'ok', rendered: 'piped' }]);
    writeSpy.mockRestore();
  });

  it('pipes SignalFlow YAML from a pipeline executable alias', async () => {
    mockDataGet.mockResolvedValue(Ok([{ name: 'myPipe', type: 'pipeline' }]));
    mockPipeline.mockResolvedValue({ status: 'ok', rendered: 'pipeline: myPipe\n' });
    mockSegmentPipe.mockImplementation(async (_command: string, input: Buffer): Promise<Buffer> => input);

    const envelopes = await line_execute('myPipe --signalflow | signalflow -');

    expect(mockPipeline).toHaveBeenCalledWith(['diagram', 'myPipe', '--signalflow']);
    expect(mockSegmentPipe).toHaveBeenCalledWith('signalflow -', Buffer.from('pipeline: myPipe\n'));
    expect(envelopes).toEqual([{ status: 'ok', rendered: 'pipeline: myPipe\n' }]);
  });

  it('keeps output redirection in the final local pipe segment', async () => {
    mockDataGet.mockResolvedValue(Ok([{ name: 'myPipe', type: 'pipeline' }]));
    mockPipeline.mockResolvedValue({ status: 'ok', rendered: 'pipeline: myPipe\n' });
    mockSegmentPipe.mockResolvedValue(Buffer.alloc(0));

    const envelopes = await line_execute('myPipe --signalflow | signalflow - > ~/tmp/pipeline.txt');

    expect(mockPipeline).toHaveBeenCalledWith(['diagram', 'myPipe', '--signalflow']);
    expect(mockSegmentPipe).toHaveBeenCalledWith(
      'signalflow - > ~/tmp/pipeline.txt',
      Buffer.from('pipeline: myPipe\n'),
    );
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(envelopes).toEqual([{ status: 'ok', rendered: '' }]);
  });

  it('delegates an unknown piped command to chili during capture', async () => {
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mockSegmentPipe.mockResolvedValue(Buffer.from(''));
    await line_execute('frobnicate | grep foo');
    expect(mockChiliRun).toHaveBeenCalledWith(['frobnicate', '-s']);
    writeSpy.mockRestore();
  });

  it('fails a pipeline clearly when the surface cannot run segments', async () => {
    surface_set({
      capabilities: {
        hiddenInput: false,
        localEdit: false,
        tty: false,
        pipeSegments: false,
        shellCommands: false,
      },
      prompt: async (): Promise<string> => '',
      pipeSegment: (_c: string, i: Buffer): Promise<Buffer> => Promise.resolve(i),
      shellCommand: async (): Promise<number> => 0,
      localEdit: async (r: { content: string }): Promise<{ content: string; changed: boolean }> => ({ content: r.content, changed: false }),
    });
    const envelopes = await line_execute('whoami | awk 1');
    expect(output.errText_get()).toContain('cannot run pipeline segments');
    expect(envelopes).toEqual([{ status: 'error', rendered: '' }]);
    expect(mockSegmentPipe).not.toHaveBeenCalled();
  });

  it('yields an error envelope when a pipe segment fails', async () => {
    mockSegmentPipe.mockRejectedValue(new Error('broken pipe'));
    const envelopes = await line_execute('whoami | awk 1');
    expect(output.errText_get()).toContain('broken pipe');
    expect(envelopes).toEqual([{ status: 'error', rendered: '' }]);
  });

  it('prints elapsed time when timing is enabled', async () => {
    mockTiming.mockReturnValue(true);
    await line_execute('whoami');
    expect(mockWhoami).toHaveBeenCalled();
    expect(output.dataText_get()).toContain('ms');
  });
});

describe('shell escape', () => {
  it('delegates a !-prefixed command to the active surface', async () => {
    const envelopes = await line_execute('!echo hi');
    expect(mockShellCommand).toHaveBeenCalledWith('echo hi');
    expect(envelopes).toEqual([{ status: 'ok', rendered: '' }]);
  });

  it('reports a non-zero host exit code as an error envelope', async () => {
    mockShellCommand.mockResolvedValueOnce(3);
    const envelopes = await line_execute('!false');
    expect(envelopes).toEqual([{ status: 'error', rendered: '' }]);
  });

  it('reports a surface shell failure in the returned envelope', async () => {
    mockShellCommand.mockRejectedValueOnce(new Error('nope'));
    const envelopes = await line_execute('!badcmd');
    expect(envelopes).toEqual([{
      status: 'error',
      rendered: '',
      renderedErr: expect.stringContaining('nope'),
    }]);
  });

  it('ignores a bare "!" with no command', async () => {
    const envelopes = await line_execute('!');
    expect(mockShellCommand).not.toHaveBeenCalled();
    expect(envelopes).toEqual([]);
  });
});

describe('output redirection', () => {
  it('writes captured output to the target with >', async () => {
    const envelopes = await line_execute('whoami > out.txt');
    expect(mockWhoami).toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalledWith('out.txt', expect.any(Buffer));
    expect(envelopes).toEqual([{ status: 'ok', rendered: '' }]);
  });

  it('appends captured output with >>', async () => {
    await line_execute('whoami >> out.txt');
    expect(mockAppendFile).toHaveBeenCalledWith('out.txt', expect.any(Buffer));
  });

  it('numbers the rows a redirected listing answered with, as the listing itself would', async () => {
    const { answerAdapters_register } = await import('../src/session/answerAdapters.js');
    const { answer_get } = await import('../src/session/answer.js');
    answerAdapters_register();
    mockPluginExecutable.mockResolvedValueOnce({
      status: 'ok',
      rendered: 'a/  b\n',
      model: { kind: 'fs.listing', data: [{ path: '/home/chris', items: [{ name: 'a', type: 'dir' }, { name: 'b', type: 'file' }] }] },
    } as never);
    await line_execute('listme > out.txt');
    expect(mockWriteFile).toHaveBeenCalledWith('out.txt', expect.any(Buffer));
    expect(answer_get()?.source).toBe('listme');
    expect(answer_get()?.rows.map((row) => row.values[0])).toEqual(['/home/chris/a', '/home/chris/b']);
  });

  it('errors and skips the write when the target is a directory', async () => {
    mockStatSync.mockReturnValue({ isDirectory: () => true } as unknown as ReturnType<typeof mockStatSync>);
    const envelopes = await line_execute('whoami > somedir');
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(output.errText_get()).not.toBe('');
    expect(envelopes).toEqual([{ status: 'error', rendered: '' }]);
  });
});

describe('line_execute — control flow', () => {
  it('short-circuits when a simulated plugin handles the command', async () => {
    mockPluginExecutable.mockResolvedValueOnce({ status: 'ok', rendered: 'PLUGIN OUTPUT\n' });
    const envelopes = await line_execute('whoami');
    expect(mockPluginExecutable).toHaveBeenCalledWith('whoami', []);
    expect(mockWhoami).not.toHaveBeenCalled();
    expect(envelopes).toEqual([{ status: 'ok', rendered: 'PLUGIN OUTPUT\n' }]);
  });

  it('aborts a semicolon batch on error when stop-on-error is set', async () => {
    mockWhoami.mockRejectedValueOnce(new Error('boom'));
    stopOnError_set(true);
    const envelopes = await line_execute('whoami; whoami');
    // First segment throws and aborts; the second never runs.
    expect(mockWhoami).toHaveBeenCalledTimes(1);
    expect(output.errText_get()).toContain('boom');
    expect(envelopes).toEqual([{ status: 'error', rendered: '' }]);
    stopOnError_set(false);
  });

  it('continues a semicolon batch past an error when stop-on-error is unset', async () => {
    mockWhoami.mockRejectedValueOnce(new Error('boom'));
    const envelopes = await line_execute('whoami; whoami');
    expect(mockWhoami).toHaveBeenCalledTimes(2);
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0].status).toBe('error');
    expect(envelopes[1].status).toBe('ok');
  });
});

describe('command_handle', () => {
  it('executes a line without exposing envelopes', async () => {
    await command_handle('whoami');
    expect(mockWhoami).toHaveBeenCalledWith([]);
  });
});

describe('line_complete', () => {
  it('resolves the completer callback into candidates and prefix', async () => {
    const result = await line_complete('l');
    expect(mockInputComplete).toHaveBeenCalledWith('l', expect.any(Function));
    expect(result).toEqual({ candidates: ['ls', 'logout'], prefix: 'l' });
  });

  it('resolves to no candidates when the completer reports an error', async () => {
    mockInputComplete.mockImplementationOnce((_line: string, callback: CompleterCallback): void => {
      callback(new Error('boom'), [[], '']);
    });
    const result = await line_complete('l');
    expect(result).toEqual({ candidates: [], prefix: 'l' });
  });
});

describe('engine_create', () => {
  it('initializes the session, adds the core\'s mounts to the backend\'s filesystem, and returns the facade', async () => {
    const engine = await engine_create();
    expect(mockSessionInit).toHaveBeenCalledTimes(1);
    // /bin and the path resolver are the ChRIS backend's, added as it starts (chris-mounts.test).
    expect(mockPathResolverRegister).not.toHaveBeenCalled();
    const roots: string[] = mockProviderRegister.mock.calls.map(
      (call: unknown[]) => (call[0] as FakeStaticProvider).root,
    );
    expect(roots).toEqual(['/usr', '/usr/bin', '/usr/games', '/usr/share', '/usr/share/doc']);

    const envelopes = await engine.line_execute('whoami');
    expect(envelopes).toHaveLength(1);
    const completion = await engine.line_complete('l');
    expect(completion.candidates).toContain('ls');
  });

  it('exposes watches on the facade: open, release one, release an owner, refuse a non-feed', async () => {
    const engine = await engine_create();
    expect(engine.watch_set!('/proc/jobs/feed_7', 'pane-a', true)).toBe('live');
    expect(mockWatchAdd).toHaveBeenCalledWith(7, 'pane-a');
    expect(engine.watch_set!('/proc/jobs/feed_7', 'pane-a', false)).toBe('settled');
    expect(mockWatchRemove).toHaveBeenCalledWith(7, 'pane-a');
    expect(engine.watch_set!('/vfs/home', 'pane-a', true)).toBeNull();
    engine.watch_release!('pane-a');
    expect(mockWatchRelease).toHaveBeenCalledWith('pane-a');
    const stop: () => void = engine.ambient_listen!((): void => undefined);
    expect(typeof stop).toBe('function');
    stop();
  });
});

describe('file_read: one file, three names', () => {
  const PROC: string = '/proc/jobs/feed_42/pl-dircopy_7/data/series/0001.dcm';
  const CFS: string = '/home/me/feeds/feed_42/pl-dircopy_7/data/series/0001.dcm';

  beforeEach((): void => {
    mockIsVirtual.mockClear();
    mockReadBinary.mockClear();
    mockLinkTarget.mockClear();
    mockCatBinary.mockClear();
    mockToPhysical.mockClear();
    mockReadBinary.mockResolvedValue({ ok: false });
    mockLinkTarget.mockResolvedValue({ ok: false });
    mockCatBinary.mockResolvedValue({ ok: false });
    mockToPhysical.mockImplementation(async (path: string) => ({ ok: true, value: path }));
  });

  it('reads a CFS path through the session cat', async (): Promise<void> => {
    mockCatBinary.mockResolvedValue({ ok: true, value: Buffer.from('cfs') });
    await expect(file_read(CFS)).resolves.toEqual(Buffer.from('cfs'));
    expect(mockCatBinary).toHaveBeenCalledWith(CFS);
  });

  it('reads a projection through the provider that owns it', async (): Promise<void> => {
    mockReadBinary.mockResolvedValue({ ok: true, value: Buffer.from('proc') });
    await expect(file_read(PROC)).resolves.toEqual(Buffer.from('proc'));
    expect(mockCatBinary).not.toHaveBeenCalled();
  });

  it('follows a data link whose folder is itself a link, rather than refusing', async (): Promise<void> => {
    // What a pl-dircopy of a PACS pull looks like: the provider hands back a
    // logical name no file id answers to, and the bytes live somewhere else.
    mockLinkTarget.mockResolvedValue({ ok: true, value: '/home/me/feeds/feed_42/pl-dircopy_7/data' });
    mockToPhysical.mockResolvedValue({ ok: true, value: '/SERVICES/PACS/x/0001.dcm' });
    mockCatBinary.mockResolvedValue({ ok: true, value: Buffer.from('linked') });
    await expect(file_read(PROC)).resolves.toEqual(Buffer.from('linked'));
    expect(mockLinkTarget).toHaveBeenCalledWith('/proc/jobs/feed_42/pl-dircopy_7/data');
    expect(mockCatBinary).toHaveBeenCalledWith('/SERVICES/PACS/x/0001.dcm');
  });

  it('refuses by name when nothing can read it', async (): Promise<void> => {
    await expect(file_read(PROC)).rejects.toThrow(`cannot read ${PROC}`);
    await expect(file_read(CFS)).rejects.toThrow(`cannot read ${CFS}`);
  });

  it('leaves a projection that is not a data path alone', async (): Promise<void> => {
    await expect(file_read('/proc/jobs/feed_42/status')).rejects.toThrow('cannot read');
    expect(mockLinkTarget).not.toHaveBeenCalled();
  });
});

const { variable_get, variable_unset } = await import('../src/core/variables.js');

describe('an assignment line', () => {
  const RUN = { kind: 'run.scheduled', data: { instanceId: 4812, feedId: 977, outputPath: '/o' } };

  beforeEach(() => {
    variable_unset('A');
    process.exitCode = 0;
  });

  it("holds the command's model, and returns the command's own envelopes", async () => {
    mockWhoami.mockResolvedValue({ status: 'ok', rendered: 'Job scheduled\n', model: RUN });
    const envelopes = await line_execute('A=$(whoami)');
    expect(mockWhoami).toHaveBeenCalledWith([]);
    expect(envelopes).toEqual([{ status: 'ok', rendered: 'Job scheduled\n', model: RUN }]);
    expect(variable_get('A')?.answer).toMatchObject({ kind: 'run.scheduled', data: RUN.data, source: 'whoami' });
  });

  it('holds the text a command printed when it answers no model', async () => {
    mockWhoami.mockResolvedValue({ status: 'ok', rendered: '\u001b[1mrudolph\u001b[0m\n' });
    await line_execute('A=$(whoami)');
    expect(variable_get('A')?.answer).toMatchObject({ kind: 'text', data: 'rudolph\n' });
  });

  it('holds what a pipe ends with', async () => {
    mockWhoami.mockResolvedValue({ status: 'ok', rendered: 'rudolph\n' });
    mockSegmentPipe.mockResolvedValue(Buffer.from('RUDOLPH\n'));
    await line_execute('A=$(whoami | tr a-z A-Z)');
    expect(mockSegmentPipe).toHaveBeenCalledWith('tr a-z A-Z', expect.any(Buffer));
    expect(variable_get('A')?.answer).toMatchObject({ kind: 'text', data: 'RUDOLPH\n' });
  });

  it('leaves the name as it was when the command fails, and fails the line', async () => {
    mockWhoami.mockResolvedValueOnce({ status: 'ok', rendered: '', model: RUN });
    await line_execute('A=$(whoami)');
    mockWhoami.mockResolvedValueOnce({ status: 'error', rendered: '' });
    const envelopes = await line_execute('A=$(whoami)');
    expect(envelopes.at(-1)?.status).toBe('error');
    expect(variable_get('A')?.answer.data).toEqual(RUN.data);
  });

  it('holds one word, and refuses a value that is several', async () => {
    expect(await line_execute("A='sag cohort'")).toEqual([]);
    expect(variable_get('A')?.answer).toMatchObject({ kind: 'text', data: 'sag cohort' });
    const refused = await line_execute('A=sag cohort');
    expect(refused).toEqual([{ status: 'error', rendered: '' }]);
    expect(variable_get('A')?.answer.data).toBe('sag cohort');
  });

  it("refuses the session's own names, and a capture that is not the whole value", async () => {
    expect((await line_execute('cwd=/tmp'))[0]?.status).toBe('error');
    expect((await line_execute('A=$(whoami) extra'))[0]?.status).toBe('error');
    expect((await line_execute('A=$(whoami'))[0]?.status).toBe('error');
    expect(variable_get('cwd')).toBeUndefined();
    expect(mockWhoami).not.toHaveBeenCalled();
  });
});
