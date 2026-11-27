/**
 * @file Tests for PACS server/query/retrieve operations.
 *
 * The connection is mocked at the client boundary and retrieve deletion at
 * the adapter seam; the query-result decode chain (base64 → zlib/gzip →
 * JSON) and the status-report composition run for real.
 */

import zlib from 'zlib';

jest.mock('../src/connect/chrisConnection', () => ({
  chrisConnection: { client_get: jest.fn() },
}));
jest.mock('../src/chrisapi/adapter', () => ({
  ...jest.requireActual('../src/chrisapi/adapter'),
  pacsRetrieve_deleteByUrl: jest.fn(),
}));

import { chrisConnection } from '../src/connect/chrisConnection';
import { pacsRetrieve_deleteByUrl } from '../src/chrisapi/adapter';
import {
  pacsServer_resolve,
  pacsServers_list,
  pacsServers_forget,
  pacsQueries_list,
  pacsQueries_create,
  pacsQuery_resultDecode,
  pacsQuery_get,
  pacsRetrieve_create,
  pacsRetrieves_list,
  pacsRetrieve_delete,
  pacsRetrieve_statusForQuery,
  PACSQueryStatusReport,
} from '../src/pacs/chrisPACS';
import { errorStack } from '../src/error/errorStack';
import { Result } from '../src/utils/result';
import { listResource_make } from './fixtures';

const mockClientGet: jest.Mock = chrisConnection.client_get as unknown as jest.Mock;
const mockRetrieveDelete: jest.Mock = pacsRetrieve_deleteByUrl as unknown as jest.Mock;

/** Encodes a payload the way CUBE stores PACS query results. */
const result_encode = (payload: unknown): string =>
  zlib.deflateSync(Buffer.from(JSON.stringify(payload))).toString('base64');

let pushSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  pacsServers_forget();
  pushSpy = jest.spyOn(errorStack, 'stack_push').mockImplementation(() => undefined);
});
afterEach(() => {
  pushSpy.mockRestore();
});

describe('pacsServer_resolve', () => {
  it('passes a numeric id straight through', async () => {
    mockClientGet.mockResolvedValue({});
    const result = await pacsServer_resolve('3');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ id: 3, identifier: undefined });
  });

  it('resolves a unique identifier to its id', async () => {
    mockClientGet.mockResolvedValue({
      getPACSList: jest.fn(async () => ({ data: [{ id: 5, identifier: 'PACSDCM' }] })),
    });
    const result = await pacsServer_resolve('PACSDCM');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ id: 5, identifier: 'PACSDCM' });
  });

  it('errors when no server matches', async () => {
    mockClientGet.mockResolvedValue({ getPACSList: jest.fn(async () => ({ data: [] })) });
    expect((await pacsServer_resolve('ghost')).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('No PACS server found'));
  });

  it('errors when the identifier is ambiguous', async () => {
    mockClientGet.mockResolvedValue({
      getPACSList: jest.fn(async () => ({ data: [{ id: 1, identifier: 'A' }, { id: 2, identifier: 'A2' }] })),
    });
    expect((await pacsServer_resolve('A')).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('Multiple PACS servers'));
  });

  it('errors when not connected or the lookup throws', async () => {
    mockClientGet.mockResolvedValue(null);
    expect((await pacsServer_resolve('A')).ok).toBe(false);

    mockClientGet.mockResolvedValue({ getPACSList: jest.fn(async () => { throw new Error('502'); }) });
    expect((await pacsServer_resolve('A')).ok).toBe(false);
  });
});

describe('pacsServers_list', () => {
  it('lists servers through the real resource spine', async () => {
    mockClientGet.mockResolvedValue({
      getPACSList: jest.fn(async () => listResource_make([
        { id: 1, identifier: 'PACSDCM', name: 'main', description: 'primary' },
      ], 'pacs')),
    });
    const result = await pacsServers_list();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0].identifier).toBe('PACSDCM');
    }
  });

  it('keeps the whole list a minute for the same client, and asks again for another', async () => {
    const getPACSList: jest.Mock = jest.fn(async () => listResource_make([{ id: 1, identifier: 'PACSDCM', name: 'main' }], 'pacs'));
    const client = { getPACSList };
    mockClientGet.mockResolvedValue(client);
    await pacsServers_list();
    await pacsServers_list();
    expect(getPACSList).toHaveBeenCalledTimes(1);
    mockClientGet.mockResolvedValue({ getPACSList });   // a new login: a new client
    await pacsServers_list();
    expect(getPACSList).toHaveBeenCalledTimes(2);
  });

  it('returns an empty list when no servers exist', async () => {
    mockClientGet.mockResolvedValue({ getPACSList: jest.fn(async () => listResource_make([], 'pacs')) });
    const result = await pacsServers_list();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it('errors when not connected', async () => {
    mockClientGet.mockResolvedValue(null);
    expect((await pacsServers_list()).ok).toBe(false);
  });
});

describe('pacsQueries_list', () => {
  it('lists queries through the resource spine', async () => {
    mockClientGet.mockResolvedValue({
      getPACSQueries: jest.fn(async () => listResource_make([{ id: 9, title: 'q' }], 'pacs/queries')),
    });
    const result = await pacsQueries_list();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.tableData).toHaveLength(1);
  });
});

describe('pacsQueries_create', () => {
  it('creates a query against a numeric server id', async () => {
    const createPACSQuery = jest.fn(async () => ({
      data: { id: 11, title: 'T', status: 'created', pacs_id: 3 },
    }));
    mockClientGet.mockResolvedValue({ createPACSQuery });
    const result = await pacsQueries_create('3', { title: 'T', query: '{"PatientID":"X"}' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(11);
    expect(createPACSQuery).toHaveBeenCalledWith(3, { title: 'T', query: '{"PatientID":"X"}' });
  });

  it('fails, once, when CUBE gives no receipt for the query it made, or one with no numeric id', async () => {
    for (const answer of [{}, { data: null }, { data: { title: 'T' } }, { data: { id: '11' } }, { data: { id: 11, title: 7 } }]) {
      const createPACSQuery = jest.fn(async () => answer);
      mockClientGet.mockResolvedValue({ createPACSQuery });
      expect((await pacsQueries_create('3', { title: 'T', query: '{}' })).ok).toBe(false);
      expect(createPACSQuery).toHaveBeenCalledTimes(1);
    }
  });

  it('hands on the receipt\'s optional fields as they came, null and absent included', async () => {
    mockClientGet.mockResolvedValue({ createPACSQuery: jest.fn(async () => ({ data: { id: 12, title: null } })) });
    const result = await pacsQueries_create('3', { title: 'T', query: '{}' });
    expect(result.ok && result.value).toEqual({ id: 12, title: null, status: undefined, pacs_id: undefined, result: undefined });
  });

  it('errors when the server cannot be resolved', async () => {
    mockClientGet.mockResolvedValue({ getPACSList: jest.fn(async () => ({ data: [] })) });
    expect((await pacsQueries_create('ghost', { title: 'T', query: '{}' })).ok).toBe(false);
  });

  it('errors when the create throws', async () => {
    mockClientGet.mockResolvedValue({
      createPACSQuery: jest.fn(async () => { throw new Error('400'); }),
    });
    expect((await pacsQueries_create('3', { title: 'T', query: '{}' })).ok).toBe(false);
  });
});

describe('pacsQuery_resultDecode', () => {
  it('decodes a zlib+base64 JSON payload', async () => {
    const payload = { studies: [{ StudyInstanceUID: '1.2' }] };
    mockClientGet.mockResolvedValue({
      getPACSQuery: jest.fn(async () => ({ data: { result: result_encode(payload) } })),
    });
    const result = await pacsQuery_resultDecode(9);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.json).toEqual(payload);
      expect(result.value.zlibDecoded).toBeDefined();
    }
  });

  it('decodes a gzip payload', async () => {
    const payload = [1, 2, 3];
    const encoded: string = zlib.gzipSync(Buffer.from(JSON.stringify(payload))).toString('base64');
    mockClientGet.mockResolvedValue({
      getPACSQuery: jest.fn(async () => ({ data: { result: encoded } })),
    });
    const result = await pacsQuery_resultDecode(9);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.json).toEqual(payload);
  });

  it('keeps non-JSON text as text', async () => {
    const encoded: string = Buffer.from('plain text').toString('base64');
    mockClientGet.mockResolvedValue({
      getPACSQuery: jest.fn(async () => ({ data: { result: encoded } })),
    });
    const result = await pacsQuery_resultDecode(9);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.json).toBeUndefined();
      expect(result.value.text).toContain('plain text');
    }
  });

  it('errors when the query has no result payload', async () => {
    mockClientGet.mockResolvedValue({ getPACSQuery: jest.fn(async () => ({ data: {} })) });
    expect((await pacsQuery_resultDecode(9)).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('no result payload'));
  });

  it('errors when the query is missing', async () => {
    mockClientGet.mockResolvedValue({ getPACSQuery: jest.fn(async () => null) });
    expect((await pacsQuery_resultDecode(9)).ok).toBe(false);
  });
});

describe('pacsQuery_get', () => {
  it('returns the query record', async () => {
    mockClientGet.mockResolvedValue({
      getPACSQuery: jest.fn(async () => ({ data: { title: 'T', status: 'succeeded', pacs_id: 3, result: 'r' } })),
    });
    const result = await pacsQuery_get(9);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ id: 9, status: 'succeeded' });
  });

  it('errors when the query is missing', async () => {
    mockClientGet.mockResolvedValue({ getPACSQuery: jest.fn(async () => null) });
    expect((await pacsQuery_get(9)).ok).toBe(false);
  });
});

describe('pacsRetrieve_create / pacsRetrieves_list', () => {
  it('creates a retrieve for a query', async () => {
    mockClientGet.mockResolvedValue({
      createPACSRetrieve: jest.fn(async () => ({ data: { id: 21, status: 'created', creation_date: 'd' } })),
    });
    const result = await pacsRetrieve_create(9);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ id: 21, pacs_query_id: 9 });
  });

  it('errors when the retrieve create throws', async () => {
    mockClientGet.mockResolvedValue({
      createPACSRetrieve: jest.fn(async () => { throw new Error('503'); }),
    });
    expect((await pacsRetrieve_create(9)).ok).toBe(false);
  });

  it('lists retrieves for a query', async () => {
    mockClientGet.mockResolvedValue({
      getPACSQuery: jest.fn(async () => ({
        data: { id: 9 },
        getRetrieves: jest.fn(async () => ({
          getItems: (): unknown[] => [
            { data: { id: 1, pacs_query_id: 9, status: 'done', creation_date: 'a' } },
            { data: { id: 2, pacs_query_id: 9, status: 'working', creation_date: 'b' } },
          ],
        })),
      })),
    });
    const result = await pacsRetrieves_list(9);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map(r => r.id)).toEqual([1, 2]);
  });

  it('errors when the parent query is missing', async () => {
    mockClientGet.mockResolvedValue({ getPACSQuery: jest.fn(async () => null) });
    expect((await pacsRetrieves_list(9)).ok).toBe(false);
  });
});

describe('pacsRetrieve_delete', () => {
  it('deletes by constructed resource URL', async () => {
    mockClientGet.mockResolvedValue({ auth: { cubeUrl: 'https://cube/', token: 'T' } });
    const result = await pacsRetrieve_delete(7);
    expect(result.ok).toBe(true);
    expect(mockRetrieveDelete).toHaveBeenCalledWith(
      'https://cube/api/v1/pacsfiles/retrieves/7/',
      { cubeUrl: 'https://cube/', token: 'T' },
    );
  });

  it('errors when the CUBE URL cannot be determined', async () => {
    mockClientGet.mockResolvedValue({ auth: { token: 'T' } });
    expect((await pacsRetrieve_delete(7)).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('Could not determine CUBE URL'));
  });

  it('errors when the delete throws', async () => {
    mockClientGet.mockResolvedValue({ auth: { cubeUrl: 'https://cube/', token: 'T' } });
    mockRetrieveDelete.mockRejectedValue(new Error('403'));
    expect((await pacsRetrieve_delete(7)).ok).toBe(false);
  });

  it('errors when not connected', async () => {
    mockClientGet.mockResolvedValue(null);
    expect((await pacsRetrieve_delete(7)).ok).toBe(false);
  });
});

describe('pacsRetrieve_statusForQuery', () => {
  it('builds a per-series status report from the decoded query result', async () => {
    const payload = [{
      StudyInstanceUID: { value: '1.2' },
      StudyDescription: { value: 'Brain' },
      series: [
        { SeriesInstanceUID: { value: 'S.pending' }, NumberOfSeriesRelatedInstances: { value: '4' } },
        { SeriesInstanceUID: { value: 'S.pulling' }, NumberOfSeriesRelatedInstances: { value: '4' } },
        { SeriesInstanceUID: { value: 'S.pulled' }, NumberOfSeriesRelatedInstances: { value: '4' } },
        { SeriesInstanceUID: { value: 'S.error' }, NumberOfSeriesRelatedInstances: { value: '4' } },
        { SeriesDescription: 'no uid — skipped' },
      ],
    }];
    const countByUID: Record<string, number> = {
      'S.pending': 0, 'S.pulling': 2, 'S.pulled': 4, 'S.error': 6,
    };
    let currentUID: string = '';
    mockClientGet.mockResolvedValue({
      getPACSQuery: jest.fn(async () => ({
        data: { id: 9, result: result_encode(payload) },
        getRetrieves: jest.fn(async () => ({
          getItems: (): unknown[] => [{ data: { id: 21, pacs_query_id: 9, status: 'working', creation_date: 'd' } }],
        })),
      })),
      getPACSSeriesList: jest.fn(async (params: { SeriesInstanceUID: string }) => {
        currentUID = params.SeriesInstanceUID;
        return { getItems: (): unknown[] => [{ data: { folder_path: `SERVICES/PACS/${currentUID}` } }] };
      }),
      getPACSFiles: jest.fn(async (params: { fname: string }) => {
        const uid: string = params.fname.split('/').pop() ?? '';
        return { getItems: (): unknown[] => [], totalCount: countByUID[uid] ?? 0 };
      }),
    });

    const result: Result<PACSQueryStatusReport> = await pacsRetrieve_statusForQuery(9);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.retrieveId).toBe(21);
      expect(result.value.retrieveStatus).toBe('working');
      expect(result.value.studies).toHaveLength(1);
      const statuses: string[] = result.value.studies[0].series.map(s => s.status);
      expect(statuses).toEqual(['pending', 'pulling', 'pulled', 'error']);
      expect(result.value.studies[0].series).toHaveLength(4);
    }
  });

  it('errors when the decoded result has no JSON', async () => {
    const encoded: string = Buffer.from('not json').toString('base64');
    mockClientGet.mockResolvedValue({
      getPACSQuery: jest.fn(async () => ({ data: { id: 9, result: encoded } })),
    });
    expect((await pacsRetrieve_statusForQuery(9)).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('no decoded JSON'));
  });

  it('errors when the decode itself fails', async () => {
    mockClientGet.mockResolvedValue({ getPACSQuery: jest.fn(async () => null) });
    expect((await pacsRetrieve_statusForQuery(9)).ok).toBe(false);
  });
});
