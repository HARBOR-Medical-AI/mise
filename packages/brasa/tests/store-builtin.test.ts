import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

// utils.commandArgs_process runs for real; stub only its load-time boundary.
jest.unstable_mockModule('@fnndsc/salsa', () => ({ context_getSingle: jest.fn() }));
cuminMock_install(() => ({
  envelope_ok: (rendered: string) => ({ status: 'ok', rendered }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
  errorStack: { stack_pop: jest.fn(() => ({ message: 'store unreachable' })) },
}));
jest.unstable_mockModule('@fnndsc/chili/models/listing.js', () => ({}));
jest.unstable_mockModule('../src/session/index.js', () => ({ session: {} }));

const mockListPlugins = jest.fn();
const mockSearchPlugins = jest.fn();
jest.unstable_mockModule('@fnndsc/chili/commands/store/list.js', () => ({
  store_listPlugins: mockListPlugins,
  store_searchPlugins: mockSearchPlugins,
}));

const mockGrid = jest.fn(() => 'GRID');
const mockLong = jest.fn(() => 'LONG');
jest.unstable_mockModule('@fnndsc/chili/views/ls.js', () => ({ grid_render: mockGrid, long_render: mockLong }));

const mockStart = jest.fn();
const mockStop = jest.fn();
jest.unstable_mockModule('../src/lib/spinner.js', () => ({ spinner: { start: mockStart, stop: mockStop } }));

// res/plugin.js drags in the whole chili plugin chain (figlet et al.); stub it.
const mockAddInteractive = jest.fn();
jest.unstable_mockModule('../src/builtins/res/plugin.js', () => ({ plugin_addInteractive: mockAddInteractive }));

const mockPersist = jest.fn();
let storeUrl: string | undefined;
const STORE_DEFAULT = 'https://default/api/v1/';
jest.unstable_mockModule('../src/config/storeConfig.js', () => ({
  DEFAULT_STORE_URL: STORE_DEFAULT,
  storeUrl_get: (): string => storeUrl ?? STORE_DEFAULT,
  storeUrl_isDefault: (): boolean => storeUrl === undefined,
  storeUrl_set: (url: string): void => { storeUrl = url; },
  storeUrl_clear: (): void => { storeUrl = undefined; },
  storeConfig_persist: mockPersist,
}));

const { builtin_store } = await import('../src/builtins/store.js');
// --compute is the ChRIS kind `compute`, which the ChRIS backend registers.
(await import('../src/core/backend.js')).backend_install({ id: 'test', session: {} as never, argumentKinds: (await import('../src/chris/kinds.js')).chrisArgumentKinds });

let logSpy: jest.SpiedFunction<typeof console.log>;
let errSpy: jest.SpiedFunction<typeof console.error>;
beforeEach(() => {
  jest.clearAllMocks();
  storeUrl = undefined;
  process.exitCode = 0;
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('builtin_store', () => {
  it('refuses a line with no subcommand, with the usage', async () => {
    const env = await builtin_store([]);
    expect(env.renderedErr).toContain('store: missing subcommand (list, search, install, inspect, set, reset); usage: store [--store <url>] <list');
    expect(process.exitCode).toBe(1);
  });

  it('lists store plugins with the grid view', async () => {
    mockListPlugins.mockResolvedValue({ ok: true, value: [{ name: 'pl-a' }] });
    const env = await builtin_store(['list']);
    expect(mockGrid).toHaveBeenCalled();
    expect(env.rendered).toContain('GRID');
  });

  it('uses the long view with -l', async () => {
    mockListPlugins.mockResolvedValue({ ok: true, value: [{ name: 'pl-a' }] });
    const env = await builtin_store(['list', '-l']);
    expect(mockLong).toHaveBeenCalled();
    expect(env.rendered).toContain('LONG');
  });

  it('notes an empty listing', async () => {
    mockListPlugins.mockResolvedValue({ ok: true, value: [] });
    const env = await builtin_store(['list']);
    expect(env.rendered).toContain('No plugins found');
  });

  it('surfaces a store fetch failure as an error envelope', async () => {
    mockListPlugins.mockResolvedValue({ ok: false });
    const env = await builtin_store(['list']);
    expect(env.status).toBe('error');
    expect(env.renderedErr).toContain('store unreachable');
    expect(process.exitCode).toBe(1);
  });

  it('surfaces a search fetch failure as an error envelope', async () => {
    mockSearchPlugins.mockResolvedValue({ ok: false });
    const env = await builtin_store(['search', 'brain']);
    expect(env.status).toBe('error');
    expect(env.renderedErr).toContain('store unreachable');
  });

  it('requires a query for search', async () => {
    const env = await builtin_store(['search']);
    expect(env.renderedErr).toContain('store: search: missing operand <query>; usage: store search [-l] <query>');
    expect(mockSearchPlugins).not.toHaveBeenCalled();
  });

  it('searches the store', async () => {
    mockSearchPlugins.mockResolvedValue({ ok: true, value: [{ name: 'pl-b' }] });
    const env = await builtin_store(['search', 'brain']);
    expect(mockSearchPlugins).toHaveBeenCalledWith('brain', expect.anything());
    expect(env.rendered).toContain('GRID');
  });

  it('notes no search matches', async () => {
    mockSearchPlugins.mockResolvedValue({ ok: true, value: [] });
    const env = await builtin_store(['search', 'nope']);
    expect(env.rendered).toContain("matching 'nope'");
  });

  it('installs via plugin_addInteractive', async () => {
    mockAddInteractive.mockResolvedValue({ status: 'ok', rendered: '' });
    await builtin_store(['install', 'pl-c']);
    expect(mockAddInteractive).toHaveBeenCalledWith({ _: ['install', 'pl-c'] });
  });

  it('installs on the compute resources --compute names, from the store --store names', async () => {
    mockAddInteractive.mockResolvedValue({ status: 'ok', rendered: '' });
    await builtin_store(['install', 'pl-c', '--compute', 'host,moc', '--store=https://peer/api/v1/']);
    expect(mockAddInteractive).toHaveBeenCalledWith({ _: ['install', 'pl-c'], compute: 'host,moc', store: 'https://peer/api/v1/' });
  });

  it('inspects the current store URL', async () => {
    const env = await builtin_store(['inspect']);
    expect(env.rendered).toContain('Peer store URL');
  });

  it('sets a custom store URL and saves', async () => {
    const env = await builtin_store(['set', 'http://custom/api/']);
    expect(storeUrl).toBe('http://custom/api/');
    expect(mockPersist).toHaveBeenCalled();
    expect(env.rendered).toContain('Store URL set');
  });

  it('rejects set with no URL', async () => {
    const env = await builtin_store(['set']);
    expect(env.renderedErr).toContain('store: set: missing operand <url>; usage: store set <url>');
    expect(process.exitCode).toBe(1);
  });

  it('resets the store URL and saves', async () => {
    storeUrl = 'http://custom/';
    await builtin_store(['reset']);
    expect(storeUrl).toBeUndefined();
    expect(mockPersist).toHaveBeenCalled();
  });

  it('rejects an unknown subcommand', async () => {
    const env = await builtin_store(['frobnicate']);
    expect(env.renderedErr).toContain("store: unknown subcommand 'frobnicate'");
  });

  it('reports an error from the store command', async () => {
    mockListPlugins.mockRejectedValue(new Error('boom'));
    const env = await builtin_store(['list']);
    expect(env.renderedErr).toContain('boom');
  });
});
