/**
 * @file Tests for plugin validate: the five rules, on the real index and on cases.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

jest.mock('@fnndsc/cumin', () => ({
  errorStack: { stack_push: jest.fn(), stack_pop: jest.fn() },
  Ok: <T>(value: T): { ok: true; value: T } => ({ ok: true, value }),
  Err: (): { ok: false } => ({ ok: false }),
}));
jest.mock('../src/files/index', () => ({}));

import { pluginIndexArchive_read, type PluginIndex } from '../src/plugins/plugin_index';
import {
  descriptors_checkLocal,
  image_resolve,
  imageReference_parse,
  pluginIndex_validate,
  type ValidateReport,
} from '../src/plugins/plugin_validate';

const FIXTURE: Buffer = readFileSync(join(__dirname, 'fixtures', 'chris-plugins-8c9a1f6.tar.gz'));
const REAL: PluginIndex = pluginIndexArchive_read(FIXTURE, 'FNNDSC/chris-plugins@main');
const SCHEMA: unknown = REAL.schema;

const GOOD: Record<string, unknown> = {
  name: 'pl-good', version: '1.0.0', dock_image: 'fnndsc/pl-good:1.0.0', type: 'ds',
  execshell: 'python3', selfpath: '/usr/local/bin', selfexec: 'good', parameters: [],
};

/**
 * Builds an index from descriptor objects or raw text.
 *
 * @param files - File name to descriptor.
 * @param schema - The schema, or null.
 * @returns The index.
 */
function index_build(files: Record<string, unknown>, schema: unknown = SCHEMA): PluginIndex {
  return {
    source: 'test', label: 'test', commit: null, schema,
    descriptors: Object.entries(files).map(([file, data]) => ({ file, text: typeof data === 'string' ? data : JSON.stringify(data) })),
  };
}

/**
 * A fetch whose answers come from a table of URL prefixes.
 *
 * @param answers - Prefix to response.
 * @returns The fake fetch.
 */
function fetch_fake(answers: Array<[string, Partial<Response> | Error]>): typeof fetch {
  return (async (url: string): Promise<Response> => {
    const hit = answers.find(([prefix]) => String(url).startsWith(prefix));
    if (hit === undefined) throw new Error(`unexpected ${url}`);
    if (hit[1] instanceof Error) throw hit[1];
    return { ok: (hit[1].status ?? 200) < 400, status: 200, headers: new Headers(), ...hit[1] } as Response;
  }) as unknown as typeof fetch;
}

describe('the real index', () => {
  it('passes every rule but one descriptor, offline', async () => {
    const report: ValidateReport = await pluginIndex_validate(REAL, { offline: true });
    expect(report.descriptors).toBe(175);
    expect(report.findings.map((f) => `${f.file} ${f.rule}`)).toEqual(['pl-s3path.json 1', 'pl-s3path.json 2']);
    expect(report.rules.find((r) => r.rule === 5)).toMatchObject({ checked: false, note: '--offline' });
    expect(report.ok).toBe(false);
  });
});

describe('rules 1–4', () => {
  it('passes a good descriptor', async () => {
    const report: ValidateReport = await pluginIndex_validate(index_build({ 'pl-good.json': GOOD }), { offline: true });
    expect(report.ok).toBe(true);
    expect(report.rules.filter((r) => r.checked).map((r) => r.rule)).toEqual([1, 2, 3, 4]);
  });

  it('rule 1: the schema, and says when there is none', async () => {
    const extra: ValidateReport = await pluginIndex_validate(index_build({ 'pl-good.json': { ...GOOD, colour: 'red' } }), { offline: true });
    expect(extra.findings[0]).toMatchObject({ rule: 1, message: expect.stringContaining("'colour'") });
    const typed: ValidateReport = await pluginIndex_validate(index_build({ 'pl-good.json': { ...GOOD, type: 'zz' } }), { offline: true });
    expect(typed.findings[0]?.message).toContain('/type');
    const none: ValidateReport = await pluginIndex_validate(index_build({ 'pl-good.json': GOOD }, null), { offline: true });
    expect(none.rules[0]).toMatchObject({ checked: false, note: 'no schema' });
  });

  it('refuses a schema that does not compile', () => {
    expect(() => descriptors_checkLocal(index_build({ 'pl-good.json': GOOD }, { type: 'nonsense' }))).toThrow('does not compile');
  });

  it('rule 2: a file that is not JSON, or not an object', async () => {
    const report: ValidateReport = await pluginIndex_validate(index_build({ 'a.json': '{', 'b.json': '[1]' }, null), { offline: true });
    expect(report.findings.map((f) => [f.file, f.rule, f.message.slice(0, 8)])).toEqual([['a.json', 2, 'not JSON'], ['b.json', 2, 'not a JS']]);
  });

  it('rule 2: CUBE\'s upload rules', async () => {
    const bad: Record<string, unknown> = {
      name: 'pl-bad', version: 'v1', dock_image: 'x/y:1', execshell: 'sh', selfpath: '', selfexec: 'x',
      min_number_of_workers: 0, max_gpu_limit: -1, min_gpu_limit: '',
      parameters: [
        null,
        { name: 'untyped' },
        { name: 'wrongtype', type: 'string' },
        { name: 'optpath', type: 'path', optional: true },
        { name: 'nodefault', type: 'int', optional: true, default: null },
        { name: 'hidden', type: 'str', optional: false, ui_exposed: false },
        { name: 'fine', type: 'bool', optional: true, default: false },
      ],
    };
    const report: ValidateReport = await pluginIndex_validate(index_build({ 'pl-bad.json': bad }, null), { offline: true });
    const messages: string[] = report.findings.filter((f) => f.rule === 2).map((f) => f.message);
    expect(messages).toEqual([
      'version "v1" is not a dotted number',
      'min_number_of_workers must be a positive integer',
      'max_gpu_limit must be a non-negative integer',
      'parameter 0 is not an object',
      "parameter 'untyped': type is required",
      "parameter 'wrongtype': type \"string\" is not one the upload takes (str|int|float|bool|path|unextpath)",
      "parameter 'optpath': a path parameter cannot be optional",
      "parameter 'nodefault': an optional parameter needs a default",
      "parameter 'hidden': a required parameter must be exposed to the UI",
    ]);
    const missing: ValidateReport = await pluginIndex_validate(index_build({ 'pl-x.json': { name: 'pl-x', parameters: 'no', min_number_of_workers: '2' } }, null), { offline: true });
    expect(missing.findings.map((f) => f.message)).toContain('descriptor dock_image is required');
    expect(missing.findings.map((f) => f.message)).toContain('parameters must be a list');
  });

  it('rule 3: the file is named for the plugin', async () => {
    const report: ValidateReport = await pluginIndex_validate(index_build({ 'pl-other.json': GOOD }), { offline: true });
    expect(report.findings).toEqual([{ file: 'pl-other.json', rule: 3, message: "names the plugin 'pl-good': the file should be pl-good.json" }]);
  });

  it('rule 4: names that differ only in case', async () => {
    const report: ValidateReport = await pluginIndex_validate(index_build({
      'pl-good.json': GOOD, 'pl-Good.json': { ...GOOD, name: 'pl-Good' }, 'nameless.json': { version: '1' },
    }, null), { offline: true });
    expect(report.findings.filter((f) => f.rule === 4).map((f) => f.file).sort()).toEqual(['pl-Good.json', 'pl-good.json']);
  });
});

describe('rule 5', () => {
  it('resolves every image, four at a time, and names the ones that do not', async () => {
    const fetcher = fetch_fake([
      ['https://registry-1.docker.io/v2/fnndsc/pl-good/', { status: 200 }],
      ['https://ghcr.io/v2/fnndsc/pl-gone/', { status: 404 }],
    ]);
    const report: ValidateReport = await pluginIndex_validate(index_build({
      'pl-good.json': GOOD,
      'pl-gone.json': { ...GOOD, name: 'pl-gone', dock_image: 'ghcr.io/fnndsc/pl-gone:2' },
      'pl-noimage.json': { ...GOOD, name: 'pl-noimage', dock_image: '' },
    }, null), { offline: false, fetcher });
    expect(report.findings.filter((f) => f.rule === 5)).toEqual([{ file: 'pl-gone.json', rule: 5, message: 'ghcr.io/fnndsc/pl-gone:2: not found on ghcr.io' }]);
    expect(report.rules[4]).toMatchObject({ checked: true, failed: 1 });
  });
});

describe('imageReference_parse', () => {
  it('reads Docker Hub, other registries, tags and digests', () => {
    expect(imageReference_parse('alpine')).toEqual({ registry: 'registry-1.docker.io', repository: 'library/alpine', reference: 'latest' });
    expect(imageReference_parse('docker.io/fnndsc/pl-x:1.0')).toEqual({ registry: 'registry-1.docker.io', repository: 'fnndsc/pl-x', reference: '1.0' });
    expect(imageReference_parse('ghcr.io/a/b:2@sha256:abc')).toEqual({ registry: 'ghcr.io', repository: 'a/b', reference: 'sha256:abc' });
    expect(imageReference_parse('localhost:5000/x')).toEqual({ registry: 'localhost:5000', repository: 'x', reference: 'latest' });
    expect(imageReference_parse('has space')).toBeNull();
    expect(imageReference_parse('ghcr.io/:tag')).toBeNull();
  });
});

describe('image_resolve', () => {
  const challenge: Headers = new Headers({ 'www-authenticate': 'Bearer realm="https://auth.example/token",service="reg",scope="repository:a/b:pull"' });

  it('follows the anonymous token challenge', async () => {
    let asked: number = 0;
    const fetcher = (async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.startsWith('https://auth.example/token?service=reg&scope=')) return { ok: true, json: async () => ({ token: 'T' }) } as Response;
      asked += 1;
      const authorized: boolean = (init?.headers as Record<string, string>)['Authorization'] === 'Bearer T';
      return { ok: authorized, status: authorized ? 200 : 401, headers: challenge } as Response;
    }) as unknown as typeof fetch;
    expect(await image_resolve('reg.example/a/b:1', fetcher)).toBeNull();
    expect(asked).toBe(2);
  });

  it('says why an image does not resolve', async () => {
    expect(await image_resolve('bad ref', fetch_fake([]))).toBe('not an image reference');
    expect(await image_resolve('reg.example/a/b', fetch_fake([['https://reg.example/', { status: 401, headers: new Headers() }]]))).toBe('reg.example refuses anonymous reads');
    expect(await image_resolve('reg.example/a/b', fetch_fake([['https://reg.example/', { status: 403 }]]))).toBe('reg.example refuses anonymous reads (HTTP 403)');
    expect(await image_resolve('reg.example/a/b', fetch_fake([['https://reg.example/', { status: 500 }]]))).toBe('reg.example answered HTTP 500');
    expect(await image_resolve('reg.example/a/b', fetch_fake([['https://reg.example/', new Error('ENOTFOUND')]]))).toBe('reg.example could not be reached (ENOTFOUND)');
  });

  it('fails when the token service will not answer', async () => {
    const noRealm: Headers = new Headers({ 'www-authenticate': 'Bearer service="x"' });
    expect(await image_resolve('reg.example/a/b', fetch_fake([['https://reg.example/', { status: 401, headers: noRealm }]]))).toBe('reg.example refuses anonymous reads');
    const fetcher = fetch_fake([
      ['https://auth.example/', { status: 500 }],
      ['https://reg.example/', { status: 401, headers: challenge }],
    ]);
    expect(await image_resolve('reg.example/a/b', fetcher)).toBe('reg.example refuses anonymous reads');
    const tokenless = fetch_fake([
      ['https://auth.example/', { status: 200, json: async () => ({}) }],
      ['https://reg.example/', { status: 401, headers: challenge }],
    ]);
    expect(await image_resolve('reg.example/a/b', tokenless)).toBe('reg.example refuses anonymous reads');
  });
});
