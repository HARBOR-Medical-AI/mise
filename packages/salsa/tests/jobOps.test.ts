import { deflateSync } from 'node:zlib';

/**
 * Boundary-only tests for salsa job operations. The only external seam is
 * cumin's chrisConnection.client_get(); everything else (Result/errorStack/
 * procCache) is the real cumin implementation so jobOps logic actually runs.
 */
jest.mock('@fnndsc/cumin', () => {
  const actual = jest.requireActual('@fnndsc/cumin');
  return { ...actual, chrisConnection: { client_get: jest.fn() } };
});

import { chrisConnection, procCache_get } from '@fnndsc/cumin';
import {
  job_cancel,
  job_delete,
  job_statusFetch,
  job_outputPathFetch,
  jobs_statusBatch,
  jobs_find,
  job_feedID_get,
  job_logFetch,
} from '../src/jobs/jobOps';

const clientGet = chrisConnection.client_get as jest.Mock;

interface FakeInstance {
  data: { status?: string; [k: string]: unknown };
  put: jest.Mock;
  delete: jest.Mock;
  getLogs?: jest.Mock;
}

function instance(status?: string, extra: Partial<FakeInstance> = {}): FakeInstance {
  // An instance as CUBE serves one: its id, its feed's and its plugin's name are always there.
  const whole = { id: 42, feed_id: 9, plugin_name: 'pl-pfdorun', previous_id: null };
  return {
    put: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    ...extra,
    data: { ...whole, ...(status === undefined ? {} : { status }), ...(extra.data ?? {}) },
  };
}

function client(methods: Record<string, unknown>): unknown {
  return methods;
}

beforeEach(() => {
  clientGet.mockReset();
  procCache_get().cache_clear();
});

describe('job_cancel', () => {
  it('errors when not connected', async () => {
    clientGet.mockResolvedValue(null);
    expect((await job_cancel(1)).ok).toBe(false);
  });

  it('errors when the instance is missing', async () => {
    clientGet.mockResolvedValue(client({ getPluginInstance: jest.fn().mockResolvedValue(null) }));
    expect((await job_cancel(1)).ok).toBe(false);
  });

  it('is a no-op for a terminal instance', async () => {
    const inst = instance('cancelled');
    clientGet.mockResolvedValue(client({ getPluginInstance: jest.fn().mockResolvedValue(inst) }));
    const r = await job_cancel(1);
    expect(r.ok).toBe(true);
    expect(inst.put).not.toHaveBeenCalled();
  });

  it('puts status=cancelled for a running instance', async () => {
    const inst = instance('started');
    clientGet.mockResolvedValue(client({ getPluginInstance: jest.fn().mockResolvedValue(inst) }));
    expect((await job_cancel(1)).ok).toBe(true);
    expect(inst.put).toHaveBeenCalledWith({ status: 'cancelled' });
  });

  it('errors when the API throws', async () => {
    clientGet.mockResolvedValue(
      client({ getPluginInstance: jest.fn().mockRejectedValue(new Error('boom')) })
    );
    expect((await job_cancel(1)).ok).toBe(false);
  });
});

describe('job_delete', () => {
  it('errors when not connected', async () => {
    clientGet.mockResolvedValue(null);
    expect((await job_delete(1)).ok).toBe(false);
  });

  it('cancels first when non-terminal, then deletes', async () => {
    const inst = instance('started');
    clientGet.mockResolvedValue(client({ getPluginInstance: jest.fn().mockResolvedValue(inst) }));
    expect((await job_delete(1)).ok).toBe(true);
    expect(inst.put).toHaveBeenCalledWith({ status: 'cancelled' });
    expect(inst.delete).toHaveBeenCalled();
  });

  it('deletes directly when terminal', async () => {
    const inst = instance('finishedSuccessfully');
    clientGet.mockResolvedValue(client({ getPluginInstance: jest.fn().mockResolvedValue(inst) }));
    expect((await job_delete(1)).ok).toBe(true);
    expect(inst.put).not.toHaveBeenCalled();
    expect(inst.delete).toHaveBeenCalled();
  });

  it('errors when the instance is missing', async () => {
    clientGet.mockResolvedValue(client({ getPluginInstance: jest.fn().mockResolvedValue(null) }));
    expect((await job_delete(1)).ok).toBe(false);
  });

  it('errors when the API throws', async () => {
    clientGet.mockResolvedValue(
      client({ getPluginInstance: jest.fn().mockRejectedValue(new Error('x')) })
    );
    expect((await job_delete(1)).ok).toBe(false);
  });
});

describe('job_statusFetch', () => {
  it('returns the status string', async () => {
    clientGet.mockResolvedValue(
      client({ getPluginInstance: jest.fn().mockResolvedValue(instance('running')) })
    );
    const r = await job_statusFetch(1);
    expect(r.ok && r.value).toBe('running');
  });

  it('defaults to "unknown" when status is absent', async () => {
    clientGet.mockResolvedValue(
      client({ getPluginInstance: jest.fn().mockResolvedValue(instance(undefined)) })
    );
    const r = await job_statusFetch(1);
    expect(r.ok && r.value).toBe('unknown');
  });

  it('errors when the instance is missing', async () => {
    clientGet.mockResolvedValue(client({ getPluginInstance: jest.fn().mockResolvedValue(null) }));
    expect((await job_statusFetch(1)).ok).toBe(false);
  });

  it('errors when the API throws', async () => {
    clientGet.mockResolvedValue(
      client({ getPluginInstance: jest.fn().mockRejectedValue(new Error('x')) })
    );
    expect((await job_statusFetch(1)).ok).toBe(false);
  });

  it('errors when not connected', async () => {
    clientGet.mockResolvedValue(null);
    expect((await job_statusFetch(1)).ok).toBe(false);
  });
});

describe('job_outputPathFetch', () => {
  it('answers the output folder CUBE records, absolute', async () => {
    clientGet.mockResolvedValue(client({ getPluginInstance: jest.fn().mockResolvedValue(
      instance('finishedSuccessfully', { data: { output_path: 'home/me/feeds/feed_9/pl-dircopy_41/pl-pfdorun_42/data' } }),
    ) }));
    const r = await job_outputPathFetch(42);
    expect(r.ok && r.value).toBe('/home/me/feeds/feed_9/pl-dircopy_41/pl-pfdorun_42/data');
  });

  it('keeps a path CUBE already gave absolute', async () => {
    clientGet.mockResolvedValue(client({ getPluginInstance: jest.fn().mockResolvedValue(
      instance(undefined, { data: { output_path: '/home/me/feeds/feed_9/x_42/data' } }),
    ) }));
    const r = await job_outputPathFetch(42);
    expect(r.ok && r.value).toBe('/home/me/feeds/feed_9/x_42/data');
  });

  it('errors when CUBE records no output folder', async () => {
    clientGet.mockResolvedValue(client({ getPluginInstance: jest.fn().mockResolvedValue(instance('scheduled')) }));
    expect((await job_outputPathFetch(42)).ok).toBe(false);
  });

  it('errors when the instance is missing', async () => {
    clientGet.mockResolvedValue(client({ getPluginInstance: jest.fn().mockResolvedValue(null) }));
    expect((await job_outputPathFetch(42)).ok).toBe(false);
  });

  it('errors when the API throws', async () => {
    clientGet.mockResolvedValue(client({ getPluginInstance: jest.fn().mockRejectedValue(new Error('x')) }));
    expect((await job_outputPathFetch(42)).ok).toBe(false);
  });

  it('errors when not connected', async () => {
    clientGet.mockResolvedValue(null);
    expect((await job_outputPathFetch(42)).ok).toBe(false);
  });
});

describe('jobs_statusBatch', () => {
  it('returns an empty map for no ids (no client call)', async () => {
    const map = await jobs_statusBatch([]);
    expect(map.size).toBe(0);
    expect(clientGet).not.toHaveBeenCalled();
  });

  it('returns an empty map when not connected', async () => {
    clientGet.mockResolvedValue(null);
    expect((await jobs_statusBatch([1, 2])).size).toBe(0);
  });

  it('maps ids to statuses, skipping failures and misses', async () => {
    const getPluginInstance = jest.fn(async (id: number) => {
      if (id === 1) return { data: { id: 1, feed_id: 9, plugin_name: 'pl-x', status: 'running' } };
      if (id === 2) throw new Error('nope');
      return null; // id === 3
    });
    clientGet.mockResolvedValue(client({ getPluginInstance }));
    const map = await jobs_statusBatch([1, 2, 3]);
    expect(map.get(1)).toBe('running');
    expect(map.has(2)).toBe(false);
    expect(map.has(3)).toBe(false);
  });
});

describe('jobs_find', () => {
  it('uses the in-memory cache once warm-up is complete', async () => {
    const cache = procCache_get();
    cache.instance_add({ id: 5, feedID: 9, parentID: null, pluginName: 'pl-fshack', params: null, status: 'finishedSuccessfully' });
    cache.warmup_complete();

    const r = await jobs_find('pl-fshack');
    expect(r.ok && r.value).toEqual([{ id: 5, feedID: 9, pluginName: 'pl-fshack' }]);
    expect(clientGet).not.toHaveBeenCalled();
  });

  it('returns an exact-ID cache hit during partial warm-up', async () => {
    const cache = procCache_get();
    cache.instance_add({ id: 42, feedID: 1, parentID: null, pluginName: 'pl-x', params: null, status: 'finishedSuccessfully' });

    const r = await jobs_find('42');
    expect(r.ok && r.value).toEqual([{ id: 42, feedID: 1, pluginName: 'pl-x' }]);
    expect(clientGet).not.toHaveBeenCalled();
  });

  it('falls back to the paginated API for a name search', async () => {
    const pageA = { data: Array.from({ length: 100 }, (_, i) => ({ id: i, feed_id: 1, plugin_name: 'pl-a' })) };
    const pageB = { data: [{ id: 100, feed_id: 1, plugin_name: 'pl-a' }] };
    const getPluginInstances = jest.fn().mockResolvedValueOnce(pageA).mockResolvedValueOnce(pageB);
    clientGet.mockResolvedValue(client({ getPluginInstances }));

    const r = await jobs_find('pl-a');
    expect(r.ok && r.value.length).toBe(101);
    expect(getPluginInstances).toHaveBeenCalledTimes(2);
  });

  it('errors when not connected during API fallback', async () => {
    clientGet.mockResolvedValue(null);
    expect((await jobs_find('pl-a')).ok).toBe(false);
  });

  it('errors when the API throws during fallback', async () => {
    clientGet.mockResolvedValue(
      client({ getPluginInstances: jest.fn().mockRejectedValue(new Error('x')) })
    );
    expect((await jobs_find('pl-a')).ok).toBe(false);
  });
});

describe('job_feedID_get', () => {
  it('returns the feed id', async () => {
    clientGet.mockResolvedValue(
      client({ getPluginInstances: jest.fn().mockResolvedValue({ data: [{ id: 1, feed_id: 1107, plugin_name: 'pl-x' }] }) })
    );
    const r = await job_feedID_get(1);
    expect(r.ok && r.value).toBe(1107);
  });

  it('errors when the instance is not found', async () => {
    clientGet.mockResolvedValue(
      client({ getPluginInstances: jest.fn().mockResolvedValue({ data: [] }) })
    );
    expect((await job_feedID_get(1)).ok).toBe(false);
  });

  it('errors when the API throws', async () => {
    clientGet.mockResolvedValue(
      client({ getPluginInstances: jest.fn().mockRejectedValue(new Error('x')) })
    );
    expect((await job_feedID_get(1)).ok).toBe(false);
  });

  it('errors when not connected', async () => {
    clientGet.mockResolvedValue(null);
    expect((await job_feedID_get(1)).ok).toBe(false);
  });
});

describe('job_logFetch', () => {
  it('decodes the complete log from CUBE\'s compressed raw pfcon response', async () => {
    const raw: string = deflateSync(Buffer.from(JSON.stringify({
      compute: { logs: 'first line\nlast line' },
    }), 'utf8')).toString('base64');
    const inst = instance('completed', { data: { status: 'completed', raw } });
    clientGet.mockResolvedValue(client({ getPluginInstance: jest.fn().mockResolvedValue(inst) }));

    const r = await job_logFetch(1);

    expect(r.ok && r.value).toBe('first line\nlast line');
  });

  it('joins log entries', async () => {
    const inst = instance('completed', {
      getLogs: jest.fn().mockResolvedValue({ data: [{ log: 'line1' }, { log: 'line2' }] }),
    });
    clientGet.mockResolvedValue(client({ getPluginInstance: jest.fn().mockResolvedValue(inst) }));
    const r = await job_logFetch(1);
    expect(r.ok && r.value).toBe('line1\nline2');
  });

  it('returns a placeholder when getLogs is unavailable', async () => {
    const inst = instance('completed');
    clientGet.mockResolvedValue(client({ getPluginInstance: jest.fn().mockResolvedValue(inst) }));
    const r = await job_logFetch(1);
    expect(r.ok && r.value).toBe('(log not available for this instance)');
  });

  it('returns a placeholder when the log is empty', async () => {
    const inst = instance('completed', {
      getLogs: jest.fn().mockResolvedValue({ data: [] }),
    });
    clientGet.mockResolvedValue(client({ getPluginInstance: jest.fn().mockResolvedValue(inst) }));
    const r = await job_logFetch(1);
    expect(r.ok && r.value).toBe('(no log output yet)');
  });

  it('errors when the instance is missing', async () => {
    clientGet.mockResolvedValue(client({ getPluginInstance: jest.fn().mockResolvedValue(null) }));
    expect((await job_logFetch(1)).ok).toBe(false);
  });

  it('errors when the API throws', async () => {
    clientGet.mockResolvedValue(
      client({ getPluginInstance: jest.fn().mockRejectedValue(new Error('x')) })
    );
    expect((await job_logFetch(1)).ok).toBe(false);
  });

  it('errors when not connected', async () => {
    clientGet.mockResolvedValue(null);
    expect((await job_logFetch(1)).ok).toBe(false);
  });
});
