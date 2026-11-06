/**
 * @file Tests for plugin index sources: parsing, GitHub, host and CUBE reads.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockFileContentGet = jest.fn();
const mockFileContentGetBinary = jest.fn();
const mockFilesListRecursive = jest.fn();
const mockStackPush = jest.fn();
const mockStackPop = jest.fn();

jest.mock('@fnndsc/cumin', () => ({
  errorStack: {
    stack_push: (...args: unknown[]): unknown => mockStackPush(...args),
    stack_pop: (...args: unknown[]): unknown => mockStackPop(...args),
  },
  Ok: <T>(value: T): { ok: true; value: T } => ({ ok: true, value }),
  Err: (): { ok: false } => ({ ok: false }),
}));

jest.mock('../src/files/index', () => ({
  fileContent_get: (...args: unknown[]): unknown => mockFileContentGet(...args),
  fileContent_getBinary: (...args: unknown[]): unknown => mockFileContentGetBinary(...args),
  files_listRecursive: (...args: unknown[]): unknown => mockFilesListRecursive(...args),
}));

import {
  pluginIndexArchive_read,
  pluginIndex_load,
  pluginIndexSource_format,
  pluginIndexSource_parse,
  type PluginIndex,
} from '../src/plugins/plugin_index';
import { tar_build } from './tarFixture';

const FIXTURE: Buffer = readFileSync(join(__dirname, 'fixtures', 'chris-plugins-8c9a1f6.tar.gz'));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('pluginIndexSource_parse', () => {
  it('reads a GitHub repository, with and without a ref, and a --ref override', () => {
    expect(pluginIndexSource_parse('FNNDSC/chris-plugins', 'cube')).toEqual({ kind: 'github', owner: 'FNNDSC', repo: 'chris-plugins', ref: 'main' });
    expect(pluginIndexSource_parse('FNNDSC/chris-plugins@v1', 'cube')).toEqual({ kind: 'github', owner: 'FNNDSC', repo: 'chris-plugins', ref: 'v1' });
    expect(pluginIndexSource_parse('FNNDSC/chris-plugins@v1', 'cube', 'abc')).toMatchObject({ ref: 'abc' });
  });

  it('reads host: and cube: prefixes, and a bare path where told', () => {
    expect(pluginIndexSource_parse('host:./plugins', 'cube')).toEqual({ kind: 'host', path: './plugins' });
    expect(pluginIndexSource_parse('cube:/home/u/p', 'host')).toEqual({ kind: 'cube', path: '/home/u/p' });
    expect(pluginIndexSource_parse('./plugins/x', 'host')).toEqual({ kind: 'host', path: './plugins/x' });
    expect(pluginIndexSource_parse('/home/u/index.tar.gz', 'cube')).toEqual({ kind: 'cube', path: '/home/u/index.tar.gz' });
    expect(pluginIndexSource_parse('  ', 'cube')).toBeNull();
  });

  it('formats a source back as it is written', () => {
    expect(pluginIndexSource_format({ kind: 'github', owner: 'a', repo: 'b', ref: 'c' })).toBe('a/b@c');
    expect(pluginIndexSource_format({ kind: 'host', path: '/x' })).toBe('host:/x');
  });
});

describe('pluginIndexArchive_read', () => {
  it('reads the real index: 175 descriptors, the schema and the commit', () => {
    const index: PluginIndex = pluginIndexArchive_read(FIXTURE, 'FNNDSC/chris-plugins@main');
    expect(index.descriptors).toHaveLength(175);
    expect(index.commit).toBe('8c9a1f61c6fe2b72483f5ffc0c7ddbffb1f73b55');
    expect(index.label).toBe('chris-plugins @ 8c9a1f6');
    expect(index.schema).toMatchObject({ title: 'ChRIS plugin descriptor' });
    expect(index.descriptors[0]?.file.endsWith('.json')).toBe(true);
  });

  it('reads an archive with no single top folder and no schema', () => {
    const index: PluginIndex = pluginIndexArchive_read(tar_build([
      { name: 'pl-a.json', content: '{}' },
      { name: 'plugins/pl-b.json', content: '{}' },
      { name: 'README.md', content: 'x' },
    ]), 'cube:/u/index.tar');
    expect(index.descriptors.map((d) => d.file)).toEqual(['pl-a.json', 'pl-b.json']);
    expect(index.schema).toBeNull();
    expect(index.label).toBe('cube:/u/index.tar');
  });

  it('refuses a schema that is not JSON', () => {
    expect(() => pluginIndexArchive_read(tar_build([{ name: 'r/schema/plugin.schema.json', content: '{' }]), 'x')).toThrow('not JSON');
  });
});

describe('pluginIndex_load', () => {
  it('fetches GitHub\'s archive of the ref', async () => {
    const fetcher = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => FIXTURE });
    const loaded = await pluginIndex_load({ kind: 'github', owner: 'FNNDSC', repo: 'chris-plugins', ref: '8c9a1f6' }, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledWith('https://api.github.com/repos/FNNDSC/chris-plugins/tarball/8c9a1f6', expect.anything());
    expect(loaded.ok && loaded.value.label).toBe('chris-plugins @ 8c9a1f6');
  });

  it('says why when GitHub refuses', async () => {
    const fetcher = jest.fn().mockResolvedValue({ ok: false, status: 404 });
    const loaded = await pluginIndex_load({ kind: 'github', owner: 'x', repo: 'y', ref: 'z' }, fetcher as unknown as typeof fetch);
    expect(loaded.ok).toBe(false);
    expect(mockStackPush).toHaveBeenCalledWith('error', expect.stringContaining('HTTP 404'));
  });

  it('reads a host directory: plugins/ and the schema beside it', async () => {
    const root: string = mkdtempSync(join(tmpdir(), 'idx-'));
    mkdirSync(join(root, 'plugins'));
    mkdirSync(join(root, 'schema'));
    writeFileSync(join(root, 'plugins', 'pl-a.json'), '{"name":"pl-a"}');
    writeFileSync(join(root, 'schema', 'plugin.schema.json'), '{"type":"object"}');
    const loaded = await pluginIndex_load({ kind: 'host', path: root });
    expect(loaded.ok && loaded.value.descriptors.map((d) => d.file)).toEqual(['pl-a.json']);
    expect(loaded.ok && loaded.value.schema).toEqual({ type: 'object' });
  });

  it('reads a host plugins/ directory handed over alone, the schema one level up', async () => {
    const root: string = mkdtempSync(join(tmpdir(), 'idx-'));
    mkdirSync(join(root, 'plugins'));
    mkdirSync(join(root, 'schema'));
    writeFileSync(join(root, 'plugins', 'pl-a.json'), '{}');
    writeFileSync(join(root, 'schema', 'plugin.schema.json'), '{}');
    const loaded = await pluginIndex_load({ kind: 'host', path: join(root, 'plugins') });
    expect(loaded.ok && loaded.value.descriptors).toHaveLength(1);
    expect(loaded.ok && loaded.value.schema).toEqual({});
  });

  it('reads a host archive, and fails on a host path that is not there', async () => {
    const root: string = mkdtempSync(join(tmpdir(), 'idx-'));
    writeFileSync(join(root, 'index.tar.gz'), FIXTURE);
    const loaded = await pluginIndex_load({ kind: 'host', path: join(root, 'index.tar.gz') });
    expect(loaded.ok && loaded.value.descriptors).toHaveLength(175);
    const missing = await pluginIndex_load({ kind: 'host', path: join(root, 'absent.tgz') });
    expect(missing.ok).toBe(false);
    const notDir = await pluginIndex_load({ kind: 'host', path: join(root, 'index.tar.gz', 'x') });
    expect(notDir.ok && notDir.value.descriptors).toEqual([]);
  });

  it('reads a CUBE directory, with the schema one level up', async () => {
    mockFilesListRecursive.mockResolvedValue([
      { path: 'home/u/idx/pl-a.json', type: 'file' },
      { path: 'home/u/idx/notes.txt', type: 'file' },
      { path: 'home/u/idx/sub', type: 'dir' },
    ]);
    mockFileContentGet.mockImplementation(async (p: string) =>
      p === '/home/u/idx/pl-a.json' ? { ok: true, value: '{"name":"pl-a"}' } : { ok: true, value: '{"type":"object"}' });
    const loaded = await pluginIndex_load({ kind: 'cube', path: '/home/u/idx/' });
    expect(loaded.ok && loaded.value.descriptors.map((d) => d.file)).toEqual(['pl-a.json']);
    expect(mockFileContentGet).toHaveBeenCalledWith('/home/u/schema/plugin.schema.json');
    expect(loaded.ok && loaded.value.schema).toEqual({ type: 'object' });
  });

  it('reads a CUBE directory with no schema anywhere', async () => {
    mockFilesListRecursive.mockResolvedValue([{ path: 'home/u/idx/schema/plugin.schema.json', type: 'file' }]);
    mockFileContentGet.mockResolvedValue({ ok: true, value: '{}' });
    const withSchema = await pluginIndex_load({ kind: 'cube', path: '/home/u/idx' });
    expect(withSchema.ok && withSchema.value.schema).toEqual({});

    mockFilesListRecursive.mockResolvedValue([]);
    mockFileContentGet.mockResolvedValue({ ok: false });
    const bare = await pluginIndex_load({ kind: 'cube', path: '/home/u/idx' });
    expect(bare.ok && bare.value.schema).toBeNull();
    expect(mockStackPop).toHaveBeenCalled();
  });

  it('fails when a CUBE descriptor cannot be read', async () => {
    mockFilesListRecursive.mockResolvedValue([{ path: 'home/u/idx/pl-a.json', type: 'file' }]);
    mockFileContentGet.mockResolvedValue({ ok: false });
    expect((await pluginIndex_load({ kind: 'cube', path: '/home/u/idx' })).ok).toBe(false);
  });

  it('reads a CUBE archive, and fails when it cannot be read', async () => {
    mockFileContentGetBinary.mockResolvedValueOnce({ ok: true, value: FIXTURE });
    const loaded = await pluginIndex_load({ kind: 'cube', path: '/home/u/index.tar.gz' });
    expect(loaded.ok && loaded.value.label).toBe('cube:/home/u/index.tar.gz @ 8c9a1f6');
    mockFileContentGetBinary.mockResolvedValueOnce({ ok: false });
    expect((await pluginIndex_load({ kind: 'cube', path: '/home/u/index.tgz' })).ok).toBe(false);
  });
});
