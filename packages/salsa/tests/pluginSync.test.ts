/**
 * @file Tests for plugin sync: the plan's groups, drift beside CUBE's defaults, the apply.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mockClientGet = jest.fn();
const mockListPagesDrain = jest.fn();
const mockPluginsPageGet = jest.fn();
const mockPluginFind = jest.fn();
const mockParametersDrain = jest.fn();
const mockStackPop = jest.fn();
const mockAddDescriptor = jest.fn();

jest.mock('@fnndsc/cumin', () => ({
  chrisConnection: { client_get: (...a: unknown[]): unknown => mockClientGet(...a) },
  errorStack: { stack_push: jest.fn(), stack_pop: (...a: unknown[]): unknown => mockStackPop(...a) },
  listPages_drain: (...a: unknown[]): unknown => mockListPagesDrain(...a),
  pluginsPage_get: (...a: unknown[]): unknown => mockPluginsPageGet(...a),
  plugin_find: (...a: unknown[]): unknown => mockPluginFind(...a),
  pluginParameters_drain: (...a: unknown[]): unknown => mockParametersDrain(...a),
  Ok: <T>(value: T): { ok: true; value: T } => ({ ok: true, value }),
  Err: (): { ok: false } => ({ ok: false }),
}));
jest.mock('../src/files/index', () => ({}));
jest.mock('../src/plugins/plugin_add', () => ({
  plugin_addDescriptor: (...a: unknown[]): unknown => mockAddDescriptor(...a),
}));

import { pluginIndexArchive_read, type PluginIndex } from '../src/plugins/plugin_index';
import {
  descriptorDrift_find,
  syncPlan_apply,
  syncPlan_build,
  syncPlanAdds_list,
  syncSeams_cube,
  version_compare,
  type CubePluginRow,
  type SyncPlan,
  type SyncResult,
  type SyncSeams,
} from '../src/plugins/plugin_sync';

const REAL: PluginIndex = pluginIndexArchive_read(readFileSync(join(__dirname, 'fixtures', 'chris-plugins-8c9a1f6.tar.gz')), 'FNNDSC/chris-plugins@main');

/**
 * A descriptor with the fields every check wants.
 *
 * @param name - Plugin name.
 * @param version - Version.
 * @param extra - Fields to add or override.
 * @returns The descriptor.
 */
function descriptor(name: string, version: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, version, dock_image: `fnndsc/${name}:${version}`, type: 'ds', execshell: 'python3', selfpath: '/b', selfexec: name, parameters: [], ...extra };
}

/**
 * An index of descriptors (no schema: the plan's own checks are rules 2–4).
 *
 * @param items - The descriptors, or raw text by file name.
 * @returns The index.
 */
function index_of(items: Array<Record<string, unknown> | [string, string]>): PluginIndex {
  return {
    source: 'test', label: 'test', commit: 'c0ffee', schema: null,
    descriptors: items.map((item) => Array.isArray(item)
      ? { file: item[0], text: item[1] }
      : { file: `${String(item['name'])}.json`, text: JSON.stringify(item) }),
  };
}

/**
 * Seams over a fixed CUBE.
 *
 * @param rows - What the CUBE holds.
 * @param held - Whole descriptors CUBE answers for a name and version.
 * @returns The seams, with the upload recording its calls.
 */
function seams_fake(rows: CubePluginRow[], held: Record<string, Record<string, unknown>> = {}): SyncSeams & { uploads: string[] } {
  const uploads: string[] = [];
  return {
    uploads,
    cubePlugins_read: async () => rows,
    cubeDescriptor_read: async (name: string, version: string) => held[`${name}@${version}`] ?? null,
    descriptor_upload: async (text: string) => {
      uploads.push(text);
      const name: string = String((JSON.parse(text) as { name: string }).name);
      if (name === 'pl-refused') return { ok: false, reason: 'Plugin with name pl-refused and version 1.0 already exists.' };
      if (name === 'pl-throws') throw new Error('socket hang up');
      return { ok: true };
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('syncPlan_build', () => {
  it('puts each plugin in its group', async () => {
    const index: PluginIndex = index_of([
      descriptor('pl-new', '1.0'),
      descriptor('pl-newer', '2.0'),
      descriptor('pl-same', '1.0'),
      descriptor('pl-drift', '1.0', { execshell: 'python' }),
      descriptor('pl-older', '1.0'),
      descriptor('pl-image', '3.0', { dock_image: 'fnndsc/pl-image:2.0' }),
      ['pl-bad.json', '{"name":"pl-bad"}'],
      ['broken.json', '{'],
    ]);
    const rows: CubePluginRow[] = [
      { name: 'pl-newer', version: '1.10', dock_image: 'fnndsc/pl-newer:1.10' },
      { name: 'pl-same', version: '1.0', dock_image: 'fnndsc/pl-same:1.0' },
      { name: 'pl-drift', version: '1.0', dock_image: 'fnndsc/pl-drift:1.0' },
      { name: 'pl-older', version: '2.0', dock_image: 'fnndsc/pl-older:2.0' },
      { name: 'pl-image', version: '2.0', dock_image: 'fnndsc/pl-image:2.0' },
      { name: 'pl-only', version: '1.0', dock_image: 'x' },
      { name: 'pl-only', version: '0.9', dock_image: 'y' },
      { name: 'pl-bad', version: '0.1', dock_image: 'z' },
    ];
    const seams = seams_fake(rows, {
      'pl-same@1.0': descriptor('pl-same', '1.0'),
      'pl-drift@1.0': descriptor('pl-drift', '1.0'),
    });
    const plan: SyncPlan = await syncPlan_build(index, ['host'], seams);
    expect(plan.entries.map((e) => `${e.group}:${e.name}`)).toEqual([
      'add:pl-new', 'newer:pl-newer', 'skip:pl-same', 'cubeNewer:pl-older', 'drift:pl-drift',
      'imageTaken:pl-image', 'cubeOnly:pl-only', 'invalid:broken', 'invalid:pl-bad',
    ]);
    expect(plan.entries.find((e) => e.name === 'pl-drift')?.detail).toBe('differs in execshell');
    expect(plan.entries.find((e) => e.name === 'pl-only')?.cubeVersions).toEqual(['0.9', '1.0']);
    expect(plan.entries.find((e) => e.name === 'pl-image')?.detail).toBe('fnndsc/pl-image:2.0 is registered as pl-image 2.0');
    expect(plan.entries.find((e) => e.name === 'pl-bad')?.detail).toMatch(/^rule 2: descriptor version is required \(\+\d+ more\)$/);
    expect(plan.entries.find((e) => e.name === 'pl-older')?.detail).toBe('the CUBE holds 2.0');
    expect(syncPlanAdds_list(plan).map((e) => e.name)).toEqual(['pl-new', 'pl-newer']);
    expect(plan).toMatchObject({ label: 'test', commit: 'c0ffee', indexed: 8, computes: ['host'] });
  });

  it('skips a same version CUBE cannot read back whole', async () => {
    const plan: SyncPlan = await syncPlan_build(index_of([descriptor('pl-a', '1')]), ['host'],
      seams_fake([{ name: 'pl-a', version: '1', dock_image: 'fnndsc/pl-a:1' }]));
    expect(plan.entries.map((e) => e.group)).toEqual(['skip']);
  });

  it('plans the real index into an empty CUBE: 174 adds, pl-s3path invalid', async () => {
    const plan: SyncPlan = await syncPlan_build(REAL, ['host'], seams_fake([]));
    expect(syncPlanAdds_list(plan)).toHaveLength(174);
    expect(plan.entries.filter((e) => e.group === 'invalid').map((e) => e.name)).toEqual(['pl-s3path']);
  });
});

describe('syncPlan_apply', () => {
  it('uploads the adds, each failure its own, and counts', async () => {
    const seams = seams_fake([{ name: 'pl-same', version: '1', dock_image: 'fnndsc/pl-same:1' }, { name: 'pl-x', version: '1', dock_image: 'q' }]);
    const plan: SyncPlan = await syncPlan_build(index_of([
      descriptor('pl-a', '1'), descriptor('pl-refused', '1.0'), descriptor('pl-throws', '1'), descriptor('pl-same', '1'),
    ]), ['host', 'gpu'], seams);
    const seen: SyncResult[] = [];
    const receipt = await syncPlan_apply(plan, seams, (r: SyncResult): void => { seen.push(r); });
    expect(seams.uploads).toHaveLength(3);
    expect(seen).toHaveLength(3);
    expect(receipt).toMatchObject({ added: 1, skipped: 1, reported: 1, failed: 2 });
    expect(receipt.results.find((r) => r.name === 'pl-throws')?.reason).toBe('socket hang up');
    expect(receipt.results.find((r) => r.name === 'pl-refused')?.reason).toContain('already exists');
  });
});

describe('descriptorDrift_find', () => {
  it('ignores what only reflects CUBE\'s defaults', () => {
    const indexed: Record<string, unknown> = descriptor('pl-a', '1', {
      min_cpu_limit: '1000m', max_memory_limit: '2Gi', min_gpu_limit: 1,
      parameters: [
        { name: 'dir', type: 'unextpath', optional: false, default: null, flag: '--dir', help: '' },
        { name: 'n', type: 'int', optional: true, default: 3, flag: '-n' },
      ],
    });
    const held: Record<string, unknown> = descriptor('pl-a', '1', {
      title: 'a newer meta title', min_cpu_limit: 1000, max_memory_limit: 2048, min_gpu_limit: 1, max_gpu_limit: 2_147_483_647,
      min_number_of_workers: 1, max_number_of_workers: 2_147_483_647, min_memory_limit: 200,
      parameters: [
        { name: 'dir', type: 'unextpath', optional: false, default: '', flag: '--dir', help: null, short_flag: '--dir', action: 'store', ui_exposed: true },
        { name: 'n', type: 'integer', optional: true, default: '3', flag: '-n' },
      ],
    });
    expect(descriptorDrift_find(indexed, held)).toEqual([]);
  });

  it('names what does differ', () => {
    const indexed: Record<string, unknown> = descriptor('pl-a', '1', {
      dock_image: 'new', max_cpu_limit: '2000m', min_memory_limit: 'lots',
      parameters: [{ name: 'a', type: 'str', flag: '--a', optional: true, default: 'x' }, { name: 'gone' }],
    });
    const held: Record<string, unknown> = descriptor('pl-a', '1', {
      parameters: [{ name: 'a', type: 'string', flag: '--b', optional: false, default: 'y' }, { name: 'extra' }, null],
    });
    expect(descriptorDrift_find(indexed, held)).toEqual([
      'dock_image', 'max_cpu_limit', 'min_memory_limit',
      'parameters.a.optional', 'parameters.a.flag', 'parameters.a.default', 'parameters.gone', 'parameters.extra',
    ]);
    expect(descriptorDrift_find({ parameters: 'x' }, { parameters: [] })).toEqual([]);
  });
});

describe('version_compare', () => {
  it('orders dotted numbers numerically', () => {
    expect(['1.10.0', '1.2.0', '1.9'].sort(version_compare)).toEqual(['1.2.0', '1.9', '1.10.0']);
    expect(version_compare('1.2', '1.2.0')).toBe(0);
    expect(version_compare('a', 'b')).toBeLessThan(0);
  });
});

describe('syncSeams_cube', () => {
  it('reads the CUBE\'s plugins, every page', async () => {
    mockClientGet.mockResolvedValue({ client: true });
    mockListPagesDrain.mockImplementation(async (fetchPage: (o: number, l: number) => Promise<unknown>) => {
      await fetchPage(0, 50);
      return [{ name: 'pl-a', version: '1', dock_image: 'i' }, { name: 'pl-b', version: '2' }, { id: 3 }];
    });
    expect(await syncSeams_cube.cubePlugins_read()).toEqual([
      { name: 'pl-a', version: '1', dock_image: 'i' },
      { name: 'pl-b', version: '2', dock_image: '' },
    ]);
    expect(mockPluginsPageGet).toHaveBeenCalledWith({ client: true }, { offset: 0, limit: 50 });
  });

  it('reads one version whole, or none', async () => {
    mockClientGet.mockResolvedValue({ client: true });
    mockPluginFind.mockResolvedValueOnce({ data: { name: 'pl-a' }, handle: 'H' }).mockResolvedValueOnce(null);
    mockParametersDrain.mockResolvedValue([{ name: 'p' }]);
    expect(await syncSeams_cube.cubeDescriptor_read('pl-a', '1')).toEqual({ name: 'pl-a', parameters: [{ name: 'p' }] });
    expect(await syncSeams_cube.cubeDescriptor_read('pl-a', '2')).toBeNull();
  });

  it('fails when not connected', async () => {
    mockClientGet.mockResolvedValue(null);
    await expect(syncSeams_cube.cubePlugins_read()).rejects.toThrow('Not connected');
  });

  it('uploads through plugin_addDescriptor and carries CUBE\'s reason', async () => {
    mockAddDescriptor.mockResolvedValueOnce({ ok: true, value: {} }).mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: false });
    mockStackPop.mockReturnValueOnce({ message: 'CUBE refused the plugin (HTTP 400): nope' }).mockReturnValueOnce(undefined);
    expect(await syncSeams_cube.descriptor_upload('{}', ['host'])).toEqual({ ok: true });
    expect(await syncSeams_cube.descriptor_upload('{}', ['host'])).toEqual({ ok: false, reason: 'CUBE refused the plugin (HTTP 400): nope' });
    expect(await syncSeams_cube.descriptor_upload('{}', ['host'])).toEqual({ ok: false, reason: 'CUBE refused the plugin' });
  });
});
