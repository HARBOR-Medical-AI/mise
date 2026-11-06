/**
 * @file Tests for the administrative plugin upload: multipart, CUBE's reason, the token path.
 */

jest.mock('../src/connect/chrisConnection', () => ({
  chrisConnection: { client_get: jest.fn(), chrisURL_get: jest.fn() },
}));
jest.mock('../src/chrisapi/adapter', () => ({
  ...jest.requireActual('../src/chrisapi/adapter'),
  client_create: jest.fn(),
}));

import { chrisConnection } from '../src/connect/chrisConnection';
import { client_adminPluginUpload, client_create, collectionItemFields_decode } from '../src/chrisapi/adapter';
import { pluginsPage_get } from '../src/chrisapi/contract';
import { pluginAdmin_upload } from '../src/plugins/chrisPlugins';
import { errorStack } from '../src/error/errorStack';

const mockClientGet: jest.Mock = chrisConnection.client_get as unknown as jest.Mock;
const mockUrlGet: jest.Mock = chrisConnection.chrisURL_get as unknown as jest.Mock;
const mockClientCreate: jest.Mock = client_create as unknown as jest.Mock;
const mockFetch: jest.Mock = jest.fn();

const ITEM: string = JSON.stringify({ collection: { items: [{ data: [{ name: 'name', value: 'pl-x' }, { name: 'version', value: '1.0' }, { value: 'nameless' }] }] } });

/**
 * A client whose admin link is known.
 *
 * @param adminUrl - The admin URL, or undefined for a non-admin.
 * @returns The fake client.
 */
function client_fake(adminUrl?: string): Record<string, unknown> {
  return { adminUrl, auth: { token: 'TOK' }, setUrls: async (): Promise<void> => undefined };
}

beforeEach(() => {
  jest.clearAllMocks();
  errorStack.stack_clear();
  global.fetch = mockFetch as unknown as typeof fetch;
});

describe('client_adminPluginUpload', () => {
  it('posts a descriptor as multipart fname with the compute names', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 201, text: async () => ITEM });
    const fields = await client_adminPluginUpload(client_fake('https://cube/chris-admin/api/v1/') as never, ['host', 'gpu'], { descriptor: '{"name":"pl-x"}' });
    expect(fields).toEqual({ name: 'pl-x', version: '1.0' });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cube/chris-admin/api/v1/');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Token TOK');
    const form: FormData = init.body as FormData;
    expect(form.get('compute_names')).toBe('host,gpu');
    expect(await (form.get('fname') as Blob).text()).toBe('{"name":"pl-x"}');
  });

  it('posts a store URL as plugin_store_url', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 201, text: async () => ITEM });
    await client_adminPluginUpload(client_fake('https://cube/chris-admin/api/v1/') as never, ['host'], { storeUrl: 'https://peer/api/v1/plugins/9/' });
    const form: FormData = (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(form.get('plugin_store_url')).toBe('https://peer/api/v1/plugins/9/');
    expect(form.get('fname')).toBeNull();
  });

  it('carries CUBE\'s reason on a refusal, and refuses a non-administrator', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, text: async () => JSON.stringify({ non_field_errors: ['Plugin with name pl-x and version 1.0 already exists.'] }) });
    await expect(client_adminPluginUpload(client_fake('https://cube/a/') as never, ['host'], { descriptor: '{}' }))
      .rejects.toThrow('CUBE refused the plugin (HTTP 400): non_field_errors: Plugin with name pl-x and version 1.0 already exists.');
    await expect(client_adminPluginUpload(client_fake() as never, ['host'], { descriptor: '{}' })).rejects.toThrow('Administrator privileges');
  });
});

describe('collectionItemFields_decode', () => {
  it('reads the first item, or nothing', () => {
    expect(collectionItemFields_decode('not json')).toEqual({});
    expect(collectionItemFields_decode('{"collection":{"items":[]}}')).toEqual({});
    expect(collectionItemFields_decode('null')).toEqual({});
  });
});

describe('pluginAdmin_upload', () => {
  it('uploads as the session', async () => {
    mockClientGet.mockResolvedValue(client_fake('https://cube/a/'));
    mockFetch.mockResolvedValue({ ok: true, status: 201, text: async () => ITEM });
    expect(await pluginAdmin_upload({ descriptor: '{}' }, ['host'])).toEqual({ ok: true, value: { name: 'pl-x', version: '1.0' } });
  });

  it('uploads as an administrator token', async () => {
    mockUrlGet.mockResolvedValue('https://cube/api/v1/');
    mockClientCreate.mockReturnValue(client_fake('https://cube/a/'));
    mockFetch.mockResolvedValue({ ok: true, status: 201, text: async () => ITEM });
    expect((await pluginAdmin_upload({ descriptor: '{}' }, ['host'], 'ADMIN')).ok).toBe(true);
    expect(mockClientCreate).toHaveBeenCalledWith('https://cube/api/v1/', 'ADMIN');
  });

  it('puts the reason on the error stack', async () => {
    mockUrlGet.mockResolvedValue(null);
    expect((await pluginAdmin_upload({ descriptor: '{}' }, ['host'], 'ADMIN')).ok).toBe(false);
    expect(errorStack.stack_pop()?.message).toContain('ChRIS URL not found');
    mockClientGet.mockResolvedValue(null);
    expect((await pluginAdmin_upload({ descriptor: '{}' }, ['host'])).ok).toBe(false);
    expect(errorStack.stack_pop()?.message).toContain('Not connected');
  });
});

describe('pluginsPage_get', () => {
  it('reads a page of plugins through getPlugins', async () => {
    const client = { getPlugins: jest.fn().mockResolvedValue({ data: [{ name: 'pl-a' }], totalCount: 1, hasNextPage: false }) };
    const page = await pluginsPage_get(client as never, { limit: 10, offset: 0 });
    expect(client.getPlugins).toHaveBeenCalledWith({ limit: 10, offset: 0 });
    expect(page.data).toEqual([{ name: 'pl-a' }]);
  });
});
