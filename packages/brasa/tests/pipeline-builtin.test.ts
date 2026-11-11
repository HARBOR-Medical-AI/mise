import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { chrisHelp_install } from './support/chrisHelp.js';

chrisHelp_install();
import { cuminMock_install } from './support/cuminMock.js';
import type { CommandEnvelope } from '@fnndsc/cumin';

/** Where the session stands; a feed node's data folder names its instance. */
let mockCwd: string = '/home/me';
const mockStackPop = jest.fn(() => undefined as { message: string } | undefined);
const mockCheckpointMark = jest.fn(() => 5);
const mockCheckpointDrain = jest.fn();
const mockResolve = jest.fn();
const mockInstanceGet = jest.fn();
cuminMock_install(() => ({
  envelope_ok: (rendered: string, model?: unknown) => ({ status: 'ok', rendered, model }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
  // The real path readers: a pipeline runs from the feed node cwd is in (#1263).
  path_isInFeed: (place: string): boolean => /\/feeds\/feed_\d+(\/|$)/.test(place),
  path_extractPluginInstanceID: (place: string): number | null => {
    const hits: RegExpMatchArray[] = [...place.matchAll(/\/[^/]+_(\d+)(?=\/|$)/g)].filter((m) => !m[0].startsWith('/feed_'));
    const last: RegExpMatchArray | undefined = hits[hits.length - 1];
    return last === undefined ? null : Number(last[1]);
  },
  errorStack: {
    stack_pop: mockStackPop,
    checkpoint_mark: mockCheckpointMark,
    checkpoint_drain: mockCheckpointDrain,
  },
  pipeline_resolve: mockResolve,
  procCache_get: () => ({ instance_get: mockInstanceGet }),
}));

const mockList = jest.fn();
const mockRun = jest.fn();
const mockSourceGet = jest.fn();
const mockProcRefresh = jest.fn(async () => undefined);
const mockDiagramGet: jest.Mock = jest.fn();
const mockManifestGet: jest.Mock = jest.fn();
const mockManifestBySlugGet: jest.Mock = jest.fn();
const mockFileContentGet: jest.Mock = jest.fn();
const mockPrepare = jest.fn();
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  // The wait for a run to settle asks for statuses in one batch.
  jobs_statusBatch: async (ids: number[]): Promise<Map<number, string>> =>
    new Map(ids.map((id: number): [number, string] => [id, 'finishedSuccessfully'])),
  pipelines_list: mockList,
  pipeline_run: mockRun,
  pipeline_sourceGet: mockSourceGet,
  procCache_refresh: mockProcRefresh,
  pipelineDiagram_get: mockDiagramGet,
  pipelineManifest_get: mockManifestGet,
  pipelineInvocation_prepare: mockPrepare,
  pipelineManifestBySlug_get: mockManifestBySlugGet,
  fileContent_get: mockFileContentGet,
  context_getSingle: jest.fn(async () => ({ user: 'me' })),
}));

const mockFieldsFetch = jest.fn();
jest.unstable_mockModule('@fnndsc/chili/commands/pipeline/fields.js', () => ({ pipelineFields_fetch: mockFieldsFetch }));
const mockTableDisplay = jest.fn();
const mockTableRender = jest.fn(() => 'FIELDS_TABLE');
jest.unstable_mockModule('@fnndsc/chili/screen/screen.js', () => ({ table_display: mockTableDisplay, table_render: mockTableRender }));

// pipeline streams through the sink line writers; inspect writes a table via sink_get().
const mockDataLine = jest.fn();
const mockErrLine = jest.fn();
const mockSinkWrite = jest.fn();
const mockProgressWrite = jest.fn();
jest.unstable_mockModule('../src/core/sink.js', () => ({
  sink_dataLine: mockDataLine,
  sink_errLine: mockErrLine,
  sink_get: () => ({
    data_write: mockSinkWrite,
    err_write: jest.fn(),
    progress_write: mockProgressWrite,
  }),
}));

const mockClientGet = jest.fn(async () => null);
jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { connection: { client_get: mockClientGet }, getCWD: jest.fn(async () => mockCwd) },
}));

const { builtin_pipeline } = await import('../src/builtins/res/pipeline.js');
// `~` is the session's home, read from the context this file mocks.
await (await import('./support/chrisPieces.js')).chrisPieces_install({ home_get: async (): Promise<string> => { const { context_getSingle } = await import('@fnndsc/salsa'); const user: string | null = (await context_getSingle()).user; return user ? `/home/${user}` : '/'; } });

const ok = <T>(value: T) => ({ ok: true as const, value });
const err = () => ({ ok: false as const });

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = 0;
  mockCwd = '/home/me';
  mockClientGet.mockResolvedValue(null);
  mockInstanceGet.mockReturnValue(undefined);
  mockFileContentGet.mockResolvedValue(err());
  mockPrepare.mockReturnValue(ok({ pipelineID: 7, nodeOverrides: [] }));
  mockManifestGet.mockResolvedValue(ok({
    pipelineID: 7,
    name: 'MyPipe',
    rootIDs: [1],
    nodes: [{
      pipingID: 1,
      title: 'root',
      pluginName: 'pl-a',
      pluginVersion: '1.0',
      parentID: null,
      computeResourceName: 'host',
      memoryLimit: '4Gi',
      parameterDefaults: [{ name: 'threshold', value: 0.4 }],
      parameterDefinitions: [{ name: 'threshold', type: 'float', optional: true, default: 0.25 }],
    }],
  }));
  mockManifestBySlugGet.mockImplementation((specifier: string) => mockManifestGet(specifier));
  mockDiagramGet.mockResolvedValue(ok({
    pipelineID: 7,
    name: 'Brain Segmentation',
    rootIDs: [31],
    nodes: [
      {
        id: 31, title: 'input', pluginName: 'pl-mri-convert', parentID: null,
        joinParentIDs: [],
        arguments: [
          { name: 'threshold', value: 0 },
          { name: 'label', value: 'T1 weighted' },
          { name: 'unused', value: null },
        ],
      },
      {
        id: 32, title: 'segment', pluginName: 'pl-segment', parentID: 31,
        joinParentIDs: [], arguments: [{ name: 'normalize', value: false }],
      },
    ],
  }));
});

describe('builtin_pipeline', () => {
  it('shows usage with no subcommand', async () => {
    await builtin_pipeline([]);
    expect(mockDataLine).toHaveBeenCalledWith(expect.stringContaining('Usage: pipeline'));
  });

  it('shows the feed node a run would start from, when cwd is in one', async () => {
    mockCwd = '/home/me/feeds/feed_1/pl-dircopy_42/data';
    await builtin_pipeline([]);
    expect(mockDataLine).toHaveBeenCalledWith(expect.stringContaining('instance 42'));
  });

  it('returns help for --help', async () => {
    const env = await builtin_pipeline(['--help']);
    expect(env.rendered).toContain('USAGE');
    expect(env.rendered).toContain('--paramFile');
    expect(env.rendered).toContain('--<node>.<parameter>');
    expect(env.rendered).toContain('manifest <name|id|slug>');
  });

  it('lists registered pipelines', async () => {
    mockList.mockResolvedValue({ tableData: [{ id: 1, name: 'MyPipe', category: 'seg', authors: 'me' }] });
    await builtin_pipeline(['list']);
    expect(mockDataLine).toHaveBeenCalledWith(expect.stringContaining('MyPipe'));
  });

  it('notes when no pipelines are registered', async () => {
    mockList.mockResolvedValue({ tableData: [] });
    await builtin_pipeline(['list']);
    expect(mockDataLine).toHaveBeenCalledWith(expect.stringContaining('No pipelines registered'));
  });

  it('requires a name for info', async () => {
    await builtin_pipeline(['info']);
    expect(mockErrLine).toHaveBeenCalledWith(expect.stringContaining('Usage: pipeline info'));
    expect(process.exitCode).toBe(1);
  });

  it('prints registered pipeline metadata before its invocation parameters', async () => {
    mockResolve.mockResolvedValue(ok({ name: 'MyPipe', id: 7, locked: false }));
    await builtin_pipeline(['info', 'MyPipe']);
    expect(mockDataLine).toHaveBeenCalledWith(expect.stringContaining('MyPipe'));
  });

  it('reports an info resolve failure', async () => {
    mockResolve.mockResolvedValue(err());
    mockStackPop.mockReturnValue({ message: 'no such pipeline' });
    const result = await builtin_pipeline(['info', 'ghost']);
    expect(mockErrLine).toHaveBeenCalledWith(expect.stringContaining('no such pipeline'));
    expect(process.exitCode).toBe(1);
    expect(result.status).toBe('error');
  });

  it('requires a name for run', async () => {
    await builtin_pipeline(['run']);
    expect(mockErrLine).toHaveBeenCalledWith(expect.stringContaining('Usage: pipeline run'));
  });

  it('runs a pipeline on the feed node cwd is in', async () => {
    mockCwd = '/home/me/feeds/feed_1/pl-dircopy_5/data';
    mockResolve.mockResolvedValue(ok({ name: 'MyPipe' }));
    mockRun.mockResolvedValue(ok({ workflowId: 99, pluginInstanceIds: [1, 2] }));
    mockInstanceGet.mockReturnValue({ feedID: 77 });
    await builtin_pipeline(['run', 'MyPipe']);
    expect(mockRun).toHaveBeenCalledWith('MyPipe', 5, undefined);
    expect(mockDataLine).toHaveBeenCalledWith(expect.stringContaining('Workflow 99 created'));
    expect(mockProcRefresh).toHaveBeenCalledWith(77);
  });

  it('echoes the resolved call before dispatch: a line per piping, the changed parameters, all of them under --verbose (#1443)', async () => {
    mockCwd = '/home/me/feeds/feed_1/pl-dircopy_5/data';
    mockResolve.mockResolvedValue(ok({ name: 'MyPipe' }));
    mockRun.mockResolvedValue(ok({ workflowId: 99, pluginInstanceIds: [] }));
    const root = { piping_id: 1, title: 'root', compute_resource_name: 'host', plugin_parameter_defaults: [{ name: 'threshold', default: 0.4 }] };
    mockPrepare.mockReturnValue(ok({ pipelineID: 7, nodeOverrides: [root] }));
    await builtin_pipeline(['run', 'MyPipe']);
    expect(mockDataLine).toHaveBeenCalledWith(expect.stringContaining('with root: registered parameters'));
    mockPrepare.mockReturnValue(ok({ pipelineID: 7, nodeOverrides: [{ ...root, plugin_parameter_defaults: [{ name: 'threshold', default: 0.9 }] }] }));
    await builtin_pipeline(['run', 'MyPipe', '--root.threshold', '0.9']);
    expect(mockDataLine).toHaveBeenCalledWith(expect.stringContaining('with root: --threshold 0.9'));
    mockPrepare.mockReturnValue(ok({ pipelineID: 7, nodeOverrides: [root] }));
    await builtin_pipeline(['run', 'MyPipe', '--verbose']);
    expect(mockDataLine).toHaveBeenCalledWith(expect.stringContaining('with root: --threshold 0.4 (default)  on host'));
    expect(mockRun).toHaveBeenCalledTimes(3);
  });

  it('resolves and prints under --whatif, creating no workflow; refuses as the run would (#1442)', async () => {
    mockCwd = '/home/me/feeds/feed_1/pl-dircopy_5/data';
    mockResolve.mockResolvedValue(ok({ name: 'MyPipe' }));
    mockPrepare.mockReturnValue(ok({ pipelineID: 7, nodeOverrides: [{ piping_id: 1, title: 'root', compute_resource_name: 'host', plugin_parameter_defaults: [{ name: 'threshold', default: 0.4 }] }] }));
    const dry = await builtin_pipeline(['run', 'MyPipe', '--whatif']);
    expect(dry.status).toBe('ok');
    expect(mockDataLine).toHaveBeenCalledWith(expect.stringContaining("pipeline 'MyPipe' on instance 5"));
    expect(mockDataLine).toHaveBeenCalledWith(expect.stringContaining('--threshold 0.4 (default)  on host'));
    expect(mockDataLine).toHaveBeenCalledWith(expect.stringContaining('was not run; nothing was created'));
    // On a feed that would be rooted first there is no node to name; outside a node the plain form refuses.
    mockCwd = '/home/me';
    expect((await builtin_pipeline(['run', 'MyPipe', '--whatif-new-feed'])).status).toBe('ok');
    expect((await builtin_pipeline(['run', 'MyPipe', '--whatif'])).status).toBe('error');
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockProcRefresh).not.toHaveBeenCalled();
  });

  it('answers every node it made, with where each writes and the nodes nothing runs off', async () => {
    mockCwd = '/home/me/feeds/feed_1/pl-dircopy_5/data';
    mockResolve.mockResolvedValue(ok({ name: 'MyPipe' }));
    mockRun.mockResolvedValue(ok({ workflowId: 99, pluginInstanceIds: [1, 2, 3] }));
    const nodes: Record<number, unknown> = {
      5: { feedID: 77 },
      1: { feedID: 77, pluginName: 'pl-a', parentID: 5, outputPath: '/o/1' },
      2: { feedID: 77, pluginName: 'pl-b', parentID: 1, outputPath: '/o/2' },
      3: { feedID: 77, pluginName: 'pl-c', parentID: 1 },
    };
    mockInstanceGet.mockImplementation((id: unknown) => nodes[id as number]);
    const env = await builtin_pipeline(['run', 'MyPipe', '--detach']);
    expect(env.model).toEqual({
      kind: 'pipeline.scheduled',
      data: {
        pipelineName: 'MyPipe', workflowId: 99, feedId: 77, newFeed: false,
        instances: [
          { instanceId: 1, pluginName: 'pl-a', outputPath: '/o/1', status: 'detached' },
          { instanceId: 2, pluginName: 'pl-b', outputPath: '/o/2', status: 'detached' },
          { instanceId: 3, pluginName: 'pl-c', outputPath: null, status: 'detached' },
        ],
        leaves: [2, 3],
        leafPaths: ['/o/2'],
      },
    });
    mockInstanceGet.mockReset();
  });

  it('refuses to run outside a feed node, naming cwd and --previous (#1263)', async () => {
    mockCwd = '/home/me/uploads';
    await builtin_pipeline(['run', 'MyPipe']);
    expect(mockErrLine).toHaveBeenCalledWith(expect.stringContaining('/home/me/uploads is not in a feed node'));
    expect(mockErrLine).toHaveBeenCalledWith(expect.stringContaining('--previous <id>'));
    expect(mockRun).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('prints pipeline source', async () => {
    mockSourceGet.mockResolvedValue(ok('yaml: source'));
    await builtin_pipeline(['source', 'MyPipe']);
    expect(mockDataLine).toHaveBeenCalledWith('yaml: source');
  });

  it('emits the complete registered invocation YAML through pipeline manifest', async () => {
    const result: CommandEnvelope = await builtin_pipeline(['manifest', 'example_pipeline_id42']);

    expect(mockManifestBySlugGet).toHaveBeenCalledWith('example_pipeline_id42');
    expect(mockProgressWrite).not.toHaveBeenCalled();
    expect(result.rendered).toContain('pipeline_id: 7');
    expect(result.rendered).toContain('piping_id: 1');
    expect(result.rendered).toContain('memory_limit: 4Gi');
  });

  it('requests the lightweight registered projection for a Pipeline name', async () => {
    await builtin_pipeline(['manifest', 'Example Pipeline']);

    expect(mockManifestGet).toHaveBeenCalledWith(
      'Example Pipeline',
      { detail: 'registered' },
    );
    expect(mockManifestBySlugGet).not.toHaveBeenCalled();
  });

  it('falls back to name resolution when an id-shaped name is not an exact slug', async () => {
    mockManifestBySlugGet.mockResolvedValue(err());

    const result: CommandEnvelope = await builtin_pipeline(['manifest', 'Example_id42']);

    expect(result.status).toBe('ok');
    expect(mockManifestBySlugGet).toHaveBeenCalledWith('Example_id42');
    expect(mockCheckpointDrain).toHaveBeenCalledWith(5);
    expect(mockManifestGet).toHaveBeenCalledWith('Example_id42', { detail: 'registered' });
  });

  it('requires a Pipeline specifier for manifest output', async () => {
    const result: CommandEnvelope = await builtin_pipeline(['manifest']);

    expect(result.status).toBe('error');
    expect(result.renderedErr).toContain('Usage: pipeline manifest');
  });

  it('emits delayed semantic progress for a slow pipeline manifest read', async () => {
    jest.useFakeTimers();
    let resolveManifest: ((value: unknown) => void) | undefined;
    mockManifestBySlugGet.mockReturnValue(new Promise((resolve: (value: unknown) => void) => {
      resolveManifest = resolve;
    }));

    try {
      const pending: Promise<CommandEnvelope> = builtin_pipeline(['manifest', 'example_pipeline_id42']);
      await jest.advanceTimersByTimeAsync(299);
      expect(mockProgressWrite).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      expect(mockProgressWrite).toHaveBeenCalledWith({
        operation: 'pipeline',
        kind: 'inspection',
        phase: 'reading',
        label: 'Reading registered pipeline…',
        status: 'running',
      });

      resolveManifest?.({
        ok: true,
        value: { pipelineID: 42, name: 'Example Pipeline', rootIDs: [], nodes: [] },
      });
      await pending;
      expect(mockProgressWrite).toHaveBeenLastCalledWith({
        operation: 'pipeline',
        kind: 'inspection',
        phase: 'complete',
        label: 'Reading registered pipeline…',
        status: 'done',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('marks delayed manifest progress failed when hydration rejects', async () => {
    jest.useFakeTimers();
    let rejectManifest: ((reason: Error) => void) | undefined;
    mockManifestBySlugGet.mockReturnValue(new Promise((
      _resolve: (value: unknown) => void,
      reject: (reason: Error) => void,
    ) => {
      rejectManifest = reject;
    }));

    try {
      const pending: Promise<CommandEnvelope> = builtin_pipeline(['manifest', 'example_pipeline_id42']);
      const rejection: Promise<void> = expect(pending).rejects.toThrow('CUBE unavailable');
      await jest.advanceTimersByTimeAsync(300);
      rejectManifest?.(new Error('CUBE unavailable'));
      await rejection;
      expect(mockProgressWrite).toHaveBeenLastCalledWith({
        operation: 'pipeline',
        kind: 'inspection',
        phase: 'failed',
        label: 'Reading registered pipeline…',
        status: 'error',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports a source failure', async () => {
    mockSourceGet.mockResolvedValue(err());
    mockStackPop.mockReturnValue({ message: 'no source' });
    const result = await builtin_pipeline(['source', 'MyPipe']);
    expect(mockErrLine).toHaveBeenCalledWith(expect.stringContaining('no source'));
    expect(result.status).toBe('error');
  });

  it('inspects fields via table_render', async () => {
    mockFieldsFetch.mockResolvedValue(['id', 'name']);
    await builtin_pipeline(['inspect']);
    expect(mockTableRender).toHaveBeenCalled();
  });

  it('notes empty fields on inspect', async () => {
    mockFieldsFetch.mockResolvedValue([]);
    await builtin_pipeline(['inspect']);
    expect(mockDataLine).toHaveBeenCalledWith(expect.stringContaining('No fields'));
  });

  it('routes search to list', async () => {
    mockList.mockResolvedValue({ tableData: [] });
    await builtin_pipeline(['search', 'brain']);
    expect(mockList).toHaveBeenCalledWith('brain');
  });

  it('draws a pipeline as a shallow tree from a multi-word specifier', async () => {
    const env: CommandEnvelope = await builtin_pipeline(['diagram', 'Brain', 'Segmentation']);
    expect(mockDiagramGet).toHaveBeenCalledWith('Brain Segmentation');
    expect(env.rendered).toContain('pipeline 7');
    expect(env.rendered).toContain('input');
    expect(env.rendered).toContain('pl-mri-convert');
    expect(env.rendered).toContain('[piping 31]');
    expect(env.rendered).not.toContain('--threshold');
  });

  it('adds concrete pipeline defaults with --withargs', async () => {
    const env: CommandEnvelope = await builtin_pipeline(['diagram', '--withargs', 'Brain', 'Segmentation']);
    expect(env.rendered).toContain("--threshold 0 --label 'T1 weighted'");
    expect(env.rendered).toContain('--normalize false');
    expect(env.rendered).not.toContain('--unused');
  });

  it('keeps similar authored pipings distinct and annotates joins', async () => {
    mockDiagramGet.mockResolvedValue(ok({
      pipelineID: 8, name: 'Fan in', rootIDs: [1], nodes: [
        { id: 1, title: 'input', pluginName: 'pl-root', parentID: null, joinParentIDs: [], arguments: [] },
        { id: 2, title: 'left', pluginName: 'pl-same', parentID: 1, joinParentIDs: [], arguments: [] },
        { id: 3, title: 'right', pluginName: 'pl-same', parentID: 1, joinParentIDs: [], arguments: [] },
        { id: 4, title: 'combine', pluginName: 'pl-ts', parentID: 2, joinParentIDs: [3], arguments: [] },
      ],
    }));

    const env: CommandEnvelope = await builtin_pipeline(['diagram', 'Fan in']);

    expect(env.rendered).toContain('left');
    expect(env.rendered).toContain('right');
    expect(env.rendered).not.toContain('×2');
    expect(env.rendered).toContain('⋈ joins 3');
  });

  it('emits pipeline SignalFlow YAML', async () => {
    const env: CommandEnvelope = await builtin_pipeline(['diagram', '--signalflow', 'Brain', 'Segmentation']);
    expect(env.rendered).toContain('tree:');
    expect(env.rendered).toContain('input');
    expect(env.model).toMatchObject({ kind: 'pipeline.diagram', data: { pipelineId: 7 } });
  });

  it('carries the full authored topology in the pipeline.diagram model', async () => {
    mockDiagramGet.mockResolvedValue(ok({
      pipelineID: 8, name: 'Fan in', rootIDs: [1], nodes: [
        { id: 1, title: 'input', pluginName: 'pl-root', parentID: null, joinParentIDs: [], arguments: [] },
        { id: 2, title: 'left', pluginName: 'pl-same', parentID: 1, joinParentIDs: [], arguments: [] },
        { id: 4, title: 'combine', pluginName: 'pl-ts', parentID: 2, joinParentIDs: [3], arguments: [{ name: 'plugininstances', value: '2,3' }] },
      ],
    }));

    const env: CommandEnvelope = await builtin_pipeline(['diagram', 'Fan in']);

    expect(env.model?.kind).toBe('pipeline.diagram');
    const data = env.model?.data as { name: string; nodes: Array<Record<string, unknown>> };
    expect(data.name).toBe('Fan in');
    expect(data.nodes).toHaveLength(3);
    expect(data.nodes[0]).toMatchObject({ id: '1', label: 'input', parentIds: [], joinParentIds: [], pluginName: 'pl-root' });
    expect(data.nodes[2]).toMatchObject({ id: '4', parentIds: ['2'], joinParentIds: ['3'] });
  });

  it('rejects --withargs with --signalflow', async () => {
    const env: CommandEnvelope = await builtin_pipeline(['diagram', '--withargs', '--signalflow', 'Brain']);
    expect(env.status).toBe('error');
    expect(env.renderedErr).toContain('--withargs is only available for shallow rendering');
    expect(mockDiagramGet).not.toHaveBeenCalled();
  });

  it('rejects an unknown subcommand', async () => {
    await builtin_pipeline(['frobnicate']);
    expect(mockErrLine).toHaveBeenCalledWith(expect.stringContaining("unknown subcommand 'frobnicate'"));
    expect(process.exitCode).toBe(1);
  });

  it('prints compound parameters and execution controls from the registered manifest', async () => {
    mockResolve.mockResolvedValue(ok({ name: 'MyPipe', id: 7, locked: false }));
    await builtin_pipeline(['info', 'MyPipe']);
    expect(mockDataLine).toHaveBeenCalledWith(expect.stringContaining('--root.threshold'));
    expect(mockDataLine).toHaveBeenCalledWith(expect.stringContaining('--root.memory_limit'));
  });

  it('reports an error while fetching the registered manifest', async () => {
    mockResolve.mockResolvedValue(ok({ name: 'MyPipe', id: 7, locked: false }));
    mockManifestGet.mockResolvedValue(err());
    mockStackPop.mockReturnValueOnce({ message: 'api down' });
    await builtin_pipeline(['info', 'MyPipe']);
    expect(mockErrLine).toHaveBeenCalledWith(expect.stringContaining('api down'));
  });

  it('takes the deepest node on the path, from the node itself or from inside its data', async () => {
    for (const place of ['/home/me/feeds/feed_9/pl-dircopy_1/pl-x_77', '/home/me/feeds/feed_9/pl-dircopy_1/pl-x_77/data/sub']) {
      mockRun.mockClear();
      mockCwd = place;
      await builtin_pipeline(['run', 'MyPipe']);
      expect(mockRun.mock.calls[0]?.slice(0, 2)).toEqual(['MyPipe', 77]);
    }
  });

  it('reports a run resolve failure', async () => {
    mockCwd = '/home/me/feeds/feed_1/pl-dircopy_5/data';
    mockResolve.mockResolvedValue(err());
    mockStackPop.mockReturnValue({ message: 'gone' });
    const result = await builtin_pipeline(['run', 'MyPipe']);
    expect(mockErrLine).toHaveBeenCalledWith(expect.stringContaining('gone'));
    expect(result.status).toBe('error');
  });

  it('reports a workflow creation failure', async () => {
    mockCwd = '/home/me/feeds/feed_1/pl-dircopy_5/data';
    mockResolve.mockResolvedValue(ok({ name: 'MyPipe' }));
    mockRun.mockResolvedValue(err());
    mockStackPop.mockReturnValue({ message: 'queue full' });
    const result = await builtin_pipeline(['run', 'MyPipe']);
    expect(mockErrLine).toHaveBeenCalledWith(expect.stringContaining('queue full'));
    expect(result.status).toBe('error');
  });

  it('loads a CFS parameter file and forwards its overlay with compound CLI bindings', async () => {
    mockCwd = '/home/me/feeds/feed_1/pl-dircopy_5/data';
    mockResolve.mockResolvedValue(ok({ name: 'MyPipe', id: 7 }));
    mockFileContentGet.mockResolvedValue(ok(
      'plugin_tree:\n  tree:\n    - title: root\n      memory_limit: 8Gi\n',
    ));
    mockRun.mockResolvedValue(ok({ workflowId: 9, pluginInstanceIds: [10] }));

    await builtin_pipeline([
      'run', 'MyPipe', '--paramFile', '~/params/run.yaml', '--root.threshold', '0.6',
    ]);

    expect(mockFileContentGet).toHaveBeenCalledWith('/home/me/params/run.yaml');
    expect(mockRun).toHaveBeenCalledWith('MyPipe', 5, {
      globalCompute: undefined,
      parameterFile: {
        plugin_tree: { tree: [{ title: 'root', memory_limit: '8Gi' }] },
      },
      cliBindings: [{ node: 'root', field: 'threshold', value: 0.6 }],
    });
  });

  it('requires a name for source', async () => {
    const result = await builtin_pipeline(['source']);
    expect(mockErrLine).toHaveBeenCalledWith(expect.stringContaining('Usage: pipeline source'));
    expect(process.exitCode).toBe(1);
    expect(result.status).toBe('error');
  });
});
