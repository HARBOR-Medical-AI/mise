/**
 * @file Tests for plugin add: every way in, the shared upload, and the docker path.
 */
const mockUpload = jest.fn();
const mockFind = jest.fn();
const mockClientGet = jest.fn();
const mockUrlGet = jest.fn();
const mockGetAll = jest.fn();
const mockValidate = jest.fn();
const mockStackPush = jest.fn();
const mockAuthToken = jest.fn();
const mockCheckExists = jest.fn();
const mockSearchPeers = jest.fn();
const mockImport = jest.fn();

jest.mock('@fnndsc/cumin', () => ({
  Client: { getAuthToken: (...a: unknown[]): unknown => mockAuthToken(...a) },
  chrisConnection: {
    client_get: (...a: unknown[]): unknown => mockClientGet(...a),
    chrisURL_get: (...a: unknown[]): unknown => mockUrlGet(...a),
  },
  computeResourceNames_parse: (value: string): string[] => value.split(',').map((s) => s.trim()),
  computeResources_getAll: (...a: unknown[]): unknown => mockGetAll(...a),
  computeResources_validate: (...a: unknown[]): unknown => mockValidate(...a),
  errorStack: { stack_push: (...a: unknown[]): unknown => mockStackPush(...a) },
  pluginAdmin_upload: (...a: unknown[]): unknown => mockUpload(...a),
  plugin_find: (...a: unknown[]): unknown => mockFind(...a),
  Ok: <T>(value: T): { ok: true; value: T } => ({ ok: true, value }),
  Err: (): { ok: false } => ({ ok: false }),
}));
jest.mock('../src/plugins/plugin_register', () => ({
  plugin_checkExists: (...a: unknown[]): unknown => mockCheckExists(...a),
}));
jest.mock('../src/plugins/peer_search', () => ({
  plugins_searchPeers: (...a: unknown[]): unknown => mockSearchPeers(...a),
}));
jest.mock('../src/plugins/store_import', () => ({
  plugin_importFromStore: (...a: unknown[]): unknown => mockImport(...a),
}));

import {
  computeNames_resolve,
  plugin_add,
  plugin_addDescriptor,
  plugin_addJson,
  pluginInput_detect,
  type PluginAddResult,
} from '../src/plugins/plugin_add';
import { descriptorFromImage_extract, dockerImage_ensure, docker_isAvailable, type DockerAnswer, type DockerRun } from '../src/plugins/plugin_docker';
import { items_mapPooled } from '../src/plugins/pool';

const notes: string[] = [];
const note = (line: string): void => { notes.push(line); };

/**
 * A docker seam answering from a table of argument prefixes.
 *
 * @param answers - Joined-argument prefix to answer.
 * @returns The seam, and the calls it saw.
 */
function docker_fake(answers: Array<[string, Partial<DockerAnswer>]>): DockerRun & { calls: string[] } {
  const calls: string[] = [];
  const run = (async (args: readonly string[]): Promise<DockerAnswer> => {
    const joined: string = args.join(' ');
    calls.push(joined);
    const hit = answers.find(([prefix]) => joined.startsWith(prefix));
    return { ok: false, stdout: '', stderr: 'unexpected', ...(hit?.[1] ?? {}) };
  }) as DockerRun & { calls: string[] };
  run.calls = calls;
  return run;
}

beforeEach(() => {
  jest.clearAllMocks();
  notes.length = 0;
  mockGetAll.mockResolvedValue({ ok: true, value: [{ name: 'host' }, { name: 'gpu' }] });
  mockValidate.mockResolvedValue({ ok: true, value: ['host'] });
  mockClientGet.mockResolvedValue({ client: true });
  mockUrlGet.mockResolvedValue('https://cube/api/v1/');
  mockUpload.mockResolvedValue({ ok: true, value: { name: 'pl-x', version: '1.0' } });
  mockFind.mockResolvedValue(null);
  mockCheckExists.mockResolvedValue(null);
  mockSearchPeers.mockResolvedValue(null);
});

describe('pluginInput_detect', () => {
  it('tells a URL, an image and a name apart', () => {
    expect(pluginInput_detect(' https://cube/api/v1/plugins/9/ ')).toMatchObject({ kind: 'url', value: 'https://cube/api/v1/plugins/9/' });
    expect(pluginInput_detect('fnndsc/pl-x:1.2')).toEqual({ kind: 'image', value: 'fnndsc/pl-x:1.2', name: 'pl-x', version: '1.2' });
    expect(pluginInput_detect('ghcr.io/a/pl-y@sha256:ab')).toEqual({ kind: 'image', value: 'ghcr.io/a/pl-y@sha256:ab', name: 'pl-y' });
    expect(pluginInput_detect('pl-x-v2.0.1')).toEqual({ kind: 'name', value: 'pl-x', name: 'pl-x', version: '2.0.1' });
    expect(pluginInput_detect('pl-vtk')).toEqual({ kind: 'name', value: 'pl-vtk', name: 'pl-vtk' });
  });
});

describe('computeNames_resolve', () => {
  it('validates named resources, else takes all, and never guesses', async () => {
    expect(await computeNames_resolve('host, gpu')).toEqual({ ok: true, value: ['host', 'gpu'] });
    mockValidate.mockResolvedValueOnce({ ok: false });
    expect((await computeNames_resolve('nope')).ok).toBe(false);
    expect(await computeNames_resolve()).toEqual({ ok: true, value: ['host', 'gpu'] });
    mockGetAll.mockResolvedValueOnce({ ok: false });
    expect((await computeNames_resolve()).ok).toBe(false);
    mockGetAll.mockResolvedValueOnce({ ok: true, value: [] });
    expect((await computeNames_resolve()).ok).toBe(false);
    expect(mockStackPush).toHaveBeenCalledWith('error', expect.stringContaining('no compute resources'));
  });
});

describe('plugin_addDescriptor', () => {
  it('uploads as the session, or as an administrator token', async () => {
    await plugin_addDescriptor('{"a":1}', ['host']);
    expect(mockUpload).toHaveBeenLastCalledWith({ descriptor: '{"a":1}' }, ['host'], undefined);
    mockAuthToken.mockResolvedValueOnce('TOKEN');
    await plugin_addDescriptor('{}', ['host'], { username: 'chris', password: 'p' });
    expect(mockAuthToken).toHaveBeenCalledWith('https://cube/api/v1/auth-token/', 'chris', 'p');
    expect(mockUpload).toHaveBeenLastCalledWith({ descriptor: '{}' }, ['host'], 'TOKEN');
  });

  it('uploads as the session when the administrator login fails or there is no URL', async () => {
    mockAuthToken.mockRejectedValueOnce(new Error('bad creds'));
    await plugin_addDescriptor('{}', ['host'], { username: 'chris', password: 'p' });
    expect(mockStackPush).toHaveBeenCalledWith('warning', 'Failed to get admin token: bad creds');
    mockUrlGet.mockResolvedValueOnce(null);
    await plugin_addDescriptor('{}', ['host'], { username: 'chris', password: 'p' });
    expect(mockUpload).toHaveBeenLastCalledWith({ descriptor: '{}' }, ['host'], undefined);
  });
});

describe('plugin_addJson', () => {
  const text: string = JSON.stringify({ name: 'pl-x', version: '1.0', dock_image: 'x' });

  it('uploads a descriptor not yet registered', async () => {
    const result: PluginAddResult = await plugin_addJson(text, { compute: 'host' }, note);
    expect(result).toEqual({ outcome: 'installed', name: 'pl-x', version: '1.0' });
    expect(mockUpload).toHaveBeenCalledWith({ descriptor: text }, ['host'], undefined);
    expect(notes).toEqual(['Registering pl-x 1.0 on host…']);
  });

  it('leaves a registered version alone, reads failures as not there', async () => {
    mockFind.mockResolvedValueOnce({ data: {} });
    expect((await plugin_addJson(text, {}, note)).outcome).toBe('already_exists');
    mockFind.mockRejectedValueOnce(new Error('net'));
    expect((await plugin_addJson(text, {}, note)).outcome).toBe('installed');
    mockClientGet.mockResolvedValueOnce(null);
    expect((await plugin_addJson(text, {}, note)).outcome).toBe('installed');
  });

  it('fails on a file that is not a descriptor, a bad compute, or a refusal', async () => {
    expect(await plugin_addJson('{', {}, note)).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('not JSON') });
    expect(await plugin_addJson('[]', {}, note)).toMatchObject({ outcome: 'failed', reason: 'the descriptor names no plugin name and version' });
    mockValidate.mockResolvedValueOnce({ ok: false });
    expect(await plugin_addJson(text, { compute: 'zz' }, note)).toEqual({ outcome: 'failed', name: 'pl-x', version: '1.0' });
    mockUpload.mockResolvedValueOnce({ ok: false });
    expect((await plugin_addJson(text, {}, note)).outcome).toBe('failed');
  });
});

describe('plugin_add', () => {
  it('passes a URL straight to the upload as plugin_store_url', async () => {
    mockAuthToken.mockResolvedValueOnce('T');
    const result: PluginAddResult = await plugin_add('https://cube.chrisproject.org/api/v1/plugins/96/', { adminUser: 'a', adminPassword: 'b' }, note);
    expect(mockUpload).toHaveBeenCalledWith({ storeUrl: 'https://cube.chrisproject.org/api/v1/plugins/96/' }, ['host', 'gpu'], 'T');
    expect(result).toEqual({ outcome: 'installed', name: 'pl-x', version: '1.0' });
    mockUpload.mockResolvedValueOnce({ ok: false });
    expect((await plugin_add('https://x/plugins/1/', {}, note)).outcome).toBe('failed');
    mockUpload.mockResolvedValueOnce({ ok: true, value: {} });
    expect(await plugin_add('https://x/plugins/1/', {}, note)).toEqual({ outcome: 'installed' });
  });

  it('fails before anything when the compute resources cannot be had', async () => {
    mockGetAll.mockResolvedValueOnce({ ok: false });
    expect(await plugin_add('pl-x', {}, note)).toEqual({ outcome: 'failed' });
  });

  it('leaves a registered plugin alone', async () => {
    mockCheckExists.mockResolvedValueOnce({ name: 'pl-x', version: '1' });
    expect(await plugin_add('pl-x', {}, note)).toEqual({ outcome: 'already_exists', name: 'pl-x' });
    mockCheckExists.mockResolvedValueOnce({ name: 'pl-x', version: '1' });
    expect(await plugin_add('fnndsc/pl-x:1', {}, note)).toEqual({ outcome: 'already_exists', name: 'pl-x', version: '1' });
  });

  it('imports from the peer store it is given', async () => {
    mockCheckExists.mockResolvedValueOnce({ name: 'pl-x', version: '0.9' });
    mockSearchPeers.mockResolvedValueOnce({ plugin: { name: 'pl-x' }, storeName: 'cube.chrisproject.org' });
    mockImport.mockResolvedValueOnce({ success: true, plugin: { name: 'pl-x', version: '1' } });
    expect(await plugin_add('pl-x-v1', { store: 'https://peer/api/v1/' }, note)).toEqual({ outcome: 'installed', name: 'pl-x', version: '1' });
    expect(mockSearchPeers).toHaveBeenCalledWith('pl-x', '1', ['https://peer/api/v1/']);
    mockSearchPeers.mockResolvedValueOnce({ plugin: {}, storeName: 's' });
    mockImport.mockResolvedValueOnce({ success: false });
    expect(await plugin_add('pl-x', {}, note)).toMatchObject({ outcome: 'failed', reason: 'the peer store import failed', name: 'pl-x' });
    mockSearchPeers.mockResolvedValueOnce({ plugin: {}, storeName: 's' });
    mockImport.mockResolvedValueOnce({ success: true });
    expect(await plugin_add('pl-x', {}, note)).toEqual({ outcome: 'installed' });
  });

  it('reads the descriptor out of the image when no store has it', async () => {
    const run = docker_fake([
      ['info', { ok: true }],
      ['image inspect --format {{.Id}}', { ok: true }],
      ['run --rm fnndsc/pl-x:1 chris_plugin_info --dock-image', { ok: true, stdout: '{"version":"1"}' }],
    ]);
    const result: PluginAddResult = await plugin_add('fnndsc/pl-x:1', { publicRepo: 'https://github.com/FNNDSC/pl-x' }, note, run);
    expect(result.outcome).toBe('installed');
    const uploaded: Record<string, unknown> = JSON.parse(String((mockUpload.mock.calls[0]?.[0] as { descriptor: string }).descriptor)) as Record<string, unknown>;
    expect(uploaded).toMatchObject({ name: 'pl-x', dock_image: 'fnndsc/pl-x:1', public_repo: 'https://github.com/FNNDSC/pl-x' });
    expect(run.calls[2]).toBe('run --rm fnndsc/pl-x:1 chris_plugin_info --dock-image fnndsc/pl-x:1 --public-repo https://github.com/FNNDSC/pl-x');
  });

  it('says why the image path failed', async () => {
    expect(await plugin_add('pl-x', {}, note, docker_fake([]))).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('docker is not installed') });
    expect(await plugin_add('pl-x', {}, note, docker_fake([['info', { ok: true }], ['pull', { stderr: 'denied' }]])))
      .toMatchObject({ reason: 'docker pull pl-x:latest failed: denied' });
    expect(await plugin_add('pl-x', {}, note, docker_fake([['info', { ok: true }], ['image inspect --format {{.Id}}', { ok: true }]])))
      .toMatchObject({ reason: 'pl-x:latest printed no plugin descriptor (is it a ChRIS plugin?)' });
    mockUpload.mockResolvedValueOnce({ ok: false });
    const run = docker_fake([['info', { ok: true }], ['image inspect --format {{.Id}}', { ok: true }], ['run --rm pl-x:latest chris_plugin_info', { ok: true, stdout: '{"name":"pl-x"}' }]]);
    expect(await plugin_add('pl-x', {}, note, run)).toEqual({ outcome: 'failed', name: 'pl-x' });
  });
});

describe('plugin_docker', () => {
  it('tries the three descriptor prints in order', async () => {
    const oldApp = docker_fake([
      ['image inspect --format {{json .Config.Cmd}}', { ok: true, stdout: '["oldapp.py"]' }],
      ['run --rm img oldapp.py --json', { ok: true, stdout: '{"name":"old"}' }],
    ]);
    expect(await descriptorFromImage_extract('img', undefined, oldApp)).toEqual({ name: 'old' });
    const noCmd = docker_fake([['image inspect --format {{json .Config.Cmd}}', { ok: true, stdout: 'null' }]]);
    expect(await descriptorFromImage_extract('img', undefined, noCmd)).toBeNull();
    const garbage = docker_fake([
      ['run --rm img chris_plugin_info --dock-image', { ok: true, stdout: 'not json' }],
      ['run --rm img chris_plugin_info', { ok: true, stdout: '[1]' }],
      ['image inspect', { ok: true, stdout: '{' }],
    ]);
    expect(await descriptorFromImage_extract('img', undefined, garbage)).toBeNull();
    expect(await descriptorFromImage_extract('img', undefined, docker_fake([]))).toBeNull();
  });

  it('pulls only an image it does not have', async () => {
    const run = docker_fake([['image inspect', { ok: false }], ['pull', { ok: true }]]);
    expect(await dockerImage_ensure('img', run)).toBeNull();
    expect(run.calls).toEqual(['image inspect --format {{.Id}} img', 'pull --quiet img']);
    expect(await dockerImage_ensure('img', docker_fake([]))).toBe('docker pull img failed: unexpected');
    expect(await dockerImage_ensure('img', docker_fake([['pull', { stderr: '' }]]))).toBe('docker pull img failed: no reason given');
    expect(await docker_isAvailable(docker_fake([['info', { ok: true }]]))).toBe(true);
  });
});

describe('items_mapPooled', () => {
  it('keeps order and runs no more than the width at once', async () => {
    let running: number = 0;
    let most: number = 0;
    const out: number[] = await items_mapPooled([5, 1, 4, 2, 3, 6], 2, async (n: number): Promise<number> => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, n));
      running -= 1;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 60]);
    expect(most).toBe(2);
    expect(await items_mapPooled([], 4, async () => 1)).toEqual([]);
  });
});
