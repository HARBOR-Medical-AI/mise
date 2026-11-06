import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

// Real commandArgs_process runs; stub its load-time boundary.
const mockAdd = jest.fn();
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  // The wait for a run to settle asks for statuses in one batch.
  jobs_statusBatch: async (ids: number[]): Promise<Map<number, string>> =>
    new Map(ids.map((id: number): [number, string] => [id, 'finishedSuccessfully'])), context_getSingle: jest.fn(),
  plugin_add: mockAdd,
}));
jest.unstable_mockModule('@fnndsc/chili/models/listing.js', () => ({}));
jest.unstable_mockModule('@fnndsc/chili/models/plugin.js', () => ({}));
jest.unstable_mockModule('@fnndsc/chili/utils/cli.js', () => ({}));
jest.unstable_mockModule('../src/session/index.js', () => ({ session: {} }));

const mockStackClear = jest.fn();
const mockAllOfType = jest.fn(() => [] as string[]);
cuminMock_install(() => ({
  envelope_ok: (rendered: string) => ({ status: 'ok', rendered }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
  errorStack: { stack_clear: mockStackClear, allOfType_get: mockAllOfType, stack_push: jest.fn(), stack_pop: jest.fn() },
  // `plugin info` reads a plugin through the contract; this suite covers the
  // subject's other verbs, so the reader is stubbed rather than exercised.
  Ok: (value: unknown) => ({ ok: true, value }),
  Err: () => ({ ok: false }),
  plugin_find: jest.fn(async () => null),
  pluginParameters_drain: jest.fn(async () => []),
}));

const mockFetchList = jest.fn();
const mockFieldsFetch = jest.fn();
const mockExecute = jest.fn();
jest.unstable_mockModule('@fnndsc/chili/commands/plugins/list.js', () => ({ plugins_fetchList: mockFetchList }));
jest.unstable_mockModule('@fnndsc/chili/commands/plugins/fields.js', () => ({ pluginFields_fetch: mockFieldsFetch }));
jest.unstable_mockModule('@fnndsc/chili/commands/plugin/run.js', () => ({ plugin_execute: mockExecute }));

const mockListRender = jest.fn(() => 'PLUGIN_LIST');
const mockRunRender = jest.fn(() => 'PLUGIN_RUN');
jest.unstable_mockModule('@fnndsc/chili/views/plugin.js', () => ({ pluginList_render: mockListRender, pluginRun_render: mockRunRender }));
const mockTableDisplay = jest.fn();
const mockTableRender = jest.fn(() => 'FIELDS_TABLE');
jest.unstable_mockModule('@fnndsc/chili/screen/screen.js', () => ({ table_display: mockTableDisplay, table_render: mockTableRender }));

const mockChiliRun = jest.fn();
jest.unstable_mockModule('../src/chris/chiliDelegate.js', () => ({ chiliCommand_run: mockChiliRun }));
jest.unstable_mockModule('../src/lib/spinner.js', () => ({ spinner: { start: jest.fn(), stop: jest.fn() } }));
jest.unstable_mockModule('../src/core/elevation.js', () => ({
  authorizationFailure_is: (message: string): boolean => message.includes('403'),
  sudoHint_build: (command: string, args: string[]): string => `Try: sudo ${[command, ...args].join(' ')}\n`,
}));

const { builtin_plugin, plugin_addInteractive } = await import('../src/builtins/res/plugin.js');

let logSpy: jest.SpiedFunction<typeof console.log>;
let errSpy: jest.SpiedFunction<typeof console.error>;
beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = 0;
  mockAllOfType.mockReturnValue([]);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('builtin_plugin', () => {
  it('renders usage with no subcommand', async () => {
    const env = await builtin_plugin([]);
    expect(env.rendered).toContain('Usage: plugin');
  });

  it('lists plugins and shows a pagination hint', async () => {
    mockFetchList.mockResolvedValue({ plugins: [{ id: 1 }], selectedFields: ['id'], totalCount: 10 });
    const env = await builtin_plugin(['list']);
    expect(env.rendered).toContain('PLUGIN_LIST');
    expect(env.rendered).toContain('showing 1 of 10');
  });

  it('refuses the retired run, naming how a plugin runs', async () => {
    const env = await builtin_plugin(['run', 'pl-dircopy', '--dir', '/a']);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(env.status).toBe('error');
    expect(env.renderedErr).toContain('plugin run is retired: run a plugin by its name');
  });

  it('inspects fields via table_render', async () => {
    mockFieldsFetch.mockResolvedValue(['id', 'name']);
    const env = await builtin_plugin(['inspect']);
    expect(mockTableRender).toHaveBeenCalled();
    expect(env.rendered).toContain('FIELDS_TABLE');
  });

  it('notes empty fields on inspect', async () => {
    mockFieldsFetch.mockResolvedValue([]);
    const env = await builtin_plugin(['inspect']);
    expect(env.rendered).toContain('No fields');
  });

  it('routes search to a filtered list', async () => {
    mockFetchList.mockResolvedValue({ plugins: [], selectedFields: [], totalCount: 0 });
    await builtin_plugin(['search', 'brain']);
    expect(mockFetchList).toHaveBeenCalled();
  });

  it('returns an error envelope for an unknown subcommand', async () => {
    const env = await builtin_plugin(['frobnicate']);
    expect(mockChiliRun).not.toHaveBeenCalled();
    expect(env.renderedErr).toContain('Unknown subcommand');
  });

  it('reports an error from a handler', async () => {
    mockFetchList.mockRejectedValue(new Error('boom'));
    const env = await builtin_plugin(['list']);
    expect(env.renderedErr).toContain('boom');
  });
});

describe('plugin_addInteractive', () => {
  it('requires a plugin name', async () => {
    const env = await plugin_addInteractive({ _: ['add'] } as never);
    expect(env.rendered).toContain('Usage: plugin add');
  });

  it('reports a successful install, with the lines salsa wrote', async () => {
    mockAdd.mockImplementation(async (_input: unknown, _options: unknown, note: (line: string) => void) => {
      note('Searching the peer store for pl-x…');
      return { outcome: 'installed', name: 'pl-x', version: '1.0' };
    });
    const env = await plugin_addInteractive({ _: ['add', 'pl-x'] } as never);
    expect(env.rendered).toContain('Registered pl-x 1.0.');
    expect(env.rendered).toContain('Searching the peer store');
  });

  it('reports an already-registered plugin', async () => {
    mockAdd.mockResolvedValue({ outcome: 'already_exists', name: 'pl-x' });
    const env = await plugin_addInteractive({ _: ['add', 'pl-x'] } as never);
    expect(env.rendered).toContain('already registered');
  });

  it('reports a failure with collected errors and warnings', async () => {
    mockAdd.mockResolvedValue({ outcome: 'failed' });
    mockAllOfType.mockImplementation((type: string) => type === 'error' ? ['[x] | bad thing'] : ['[y] | heads up']);
    const env = await plugin_addInteractive({ _: ['add', 'pl-x'] } as never);
    expect(process.exitCode).toBe(1);
    expect(env.renderedErr).toContain('Not registered: pl-x.');
    expect(env.renderedErr).toContain('bad thing');
    expect(env.renderedErr).toContain('heads up');
  });

  it('suggests sudo after a CUBE authorization failure', async () => {
    mockAdd.mockResolvedValue({ outcome: 'failed' });
    mockAllOfType.mockImplementation((type: string) => type === 'error' ? ['Request failed with status code 403'] : []);

    const env = await plugin_addInteractive({ _: ['add', 'pl-x'] } as never);

    expect(env.renderedErr).toContain('Try: sudo plugin add pl-x');
  });
});

describe('the registering subcommands', () => {
  it('route add, sync, validate and index', async () => {
    expect((await builtin_plugin(['add'])).rendered).toContain('Usage: plugin add');
    expect((await builtin_plugin(['validate'])).rendered).toContain('Usage: plugin validate');
    expect((await builtin_plugin(['index'])).rendered).toContain('Plugin index:');
    // This suite's salsa has no index reader: the sync fails, and says so.
    expect((await builtin_plugin(['sync', '--plan'])).renderedErr).toContain('Plugin error');
  });
});

