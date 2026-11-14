/**
 * @file The ChRIS backend's own mounts: `/bin` lists CUBE's plugins and
 * pipelines, and a logical path is mapped to the one CUBE stores unless the
 * session is in physical mode. Added once, as the backend starts.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

const providerRegister = jest.fn();
const pathResolverRegister = jest.fn();
const pluginsListAll = jest.fn();
const pipelinesGetAll = jest.fn();
const logicalToPhysical = jest.fn();
let physical: boolean = false;

cuminMock_install(() => ({ listCache_get: () => ({ cache_get: (): null => null }) }));
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  vfsDispatcher: { provider_register: providerRegister, pathResolver_register: pathResolverRegister },
  plugins_listAll: pluginsListAll,
  pipelines_getAll: pipelinesGetAll,
}));
// The dispatcher's hook is the one store-path resolver every file command asks.
jest.unstable_mockModule('../src/core/paths.js', () => ({ storePath_resolve: logicalToPhysical }));
jest.unstable_mockModule('../src/session/index.js', () => ({ session: { physicalMode_get: (): boolean => physical } }));
jest.unstable_mockModule('../src/builtins/res/plugin.info.js', () => ({
  pluginInfo_build: jest.fn(), pluginInfoText_render: jest.fn(), pluginSpecifier_parse: jest.fn(),
}));

const { chrisMounts_register } = await import('../src/chris/mounts.js');
const { BinVfsProvider } = await import('../src/chris/binMount.js');

describe('the ChRIS mounts', () => {
  it('adds /bin and the path resolver, once', async () => {
    chrisMounts_register();
    chrisMounts_register();
    expect(providerRegister).toHaveBeenCalledTimes(1);
    expect((providerRegister.mock.calls[0][0] as { prefix: string }).prefix).toBe('/bin');
    expect(pathResolverRegister).toHaveBeenCalledTimes(1);

    const resolve = pathResolverRegister.mock.calls[0][0] as (path: string) => Promise<string>;
    logicalToPhysical.mockResolvedValueOnce('/home/chris/uploads' as never);
    await expect(resolve('/home/chris/up')).resolves.toBe('/home/chris/uploads');
    expect(logicalToPhysical).toHaveBeenCalledWith('/home/chris/up');
    physical = true;
    await expect(resolve('/as/typed')).resolves.toBe('/as/typed');
    physical = false;
  });
});

describe('/bin', () => {
  it('removes nothing: it is the plugins and pipelines CUBE holds', async () => {
    expect(await new BinVfsProvider().rm()).toEqual({ ok: false, errno: 'EROFS', reason: 'virtual /bin directory' });
    expect(await new BinVfsProvider().rmTree()).toEqual({ ok: false, errno: 'EROFS', reason: 'virtual /bin directory' });
  });

  beforeEach(() => { jest.clearAllMocks(); });

  it('lists plugins as name-vVERSION and pipelines by slug, sorted', async () => {
    pluginsListAll.mockResolvedValueOnce({ tableData: [{ name: 'pl-dircopy', version: '2.1.1', creation_date: '2026-01-01' }, { name: 'pl-bare' }] } as never);
    pipelinesGetAll.mockResolvedValueOnce({ ok: true, value: [{ name: 'Brain Pipe', id: 4, authors: 'A' }, { name: 'x', slug: 'civet_id1', id: 1 }] } as never);
    const listed = await new BinVfsProvider().list('/bin/');
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((item) => `${item.type}:${item.name}`)).toEqual([
      'pipeline:Brain_Pipe', 'pipeline:civet_id1', 'plugin:pl-bare', 'plugin:pl-dircopy-v2.1.1',
    ]);
  });

  it('lists nothing beneath an entry, says why a listing failed, and copies nothing', async () => {
    await expect(new BinVfsProvider().list('/bin/pl-x')).resolves.toEqual({ ok: true, value: [] });
    pluginsListAll.mockRejectedValueOnce(new Error('CUBE down') as never);
    pipelinesGetAll.mockResolvedValueOnce({ ok: false } as never);
    await expect(new BinVfsProvider().list('/bin')).resolves.toEqual({ ok: false });
    await expect(new BinVfsProvider().cp('/bin/x', '/home/y', {})).resolves.toMatchObject({ ok: false, errno: 'EROFS' });
  });
});
