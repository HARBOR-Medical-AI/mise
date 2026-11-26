/**
 * @file Unit tests for the typed chrisapi wire contract (contract.ts).
 *
 * The contract is exercised against plain fake client/resource objects: the
 * adapter generics it builds on only require structural shapes, so no
 * chrisapi mocking is involved.
 */

import {
  feedsPage_get,
  publicFeedsPage_get,
  pluginInstancesPage_get,
  pluginInstance_get,
  plugin_find,
  pluginParameters_drain,
  pipeline_get,
  pipelineSourceFilesPage_get,
  downloadToken_create,
  listPages_walk,
  listPages_walkWindowed,
  collectionPage_wrap,
  ListPage,
  PageWalkStep,
  FeedData,
  PluginInstanceData,
  InstanceParameterData,
  DownloadToken,
  PluginInstanceHandle,
} from '../src/chrisapi/contract';
import { FEED_LIST_TIMEOUT_MS, type Client } from '../src/chrisapi/adapter';

/** Builds a fake client exposing the given methods. */
function client_fake(methods: Record<string, unknown>): Client {
  return methods as unknown as Client;
}

describe('page reads', () => {
  test('feedsPage_get wraps data and totalCount', async () => {
    const client: Client = client_fake({
      getFeeds: async (params: Record<string, unknown>) => ({
        data: [{ id: 7, name: 'brainy' }],
        totalCount: 42,
        received: params,
      }),
    });
    const page: ListPage<FeedData> = await feedsPage_get(client, { limit: 10, offset: 0 });
    expect(page.data).toEqual([{ id: 7, name: 'brainy' }]);
    expect(page.totalCount).toBe(42);
  });

  test('feed list pages wait as long as the feed list takes, not chrisapi\'s 30 s', async () => {
    const getFeeds: jest.Mock = jest.fn(async () => ({ data: [], totalCount: 0 }));
    const getPublicFeeds: jest.Mock = jest.fn(async () => ({ data: [], totalCount: 0 }));
    const client: Client = client_fake({ getFeeds, getPublicFeeds });
    await feedsPage_get(client, { limit: 100, offset: 0 });
    await publicFeedsPage_get(client, { limit: 100, offset: 0 });
    expect(getFeeds).toHaveBeenCalledWith({ limit: 100, offset: 0 }, FEED_LIST_TIMEOUT_MS);
    expect(getPublicFeeds).toHaveBeenCalledWith({ limit: 100, offset: 0 }, FEED_LIST_TIMEOUT_MS);
  });

  test('feedsPage_get normalizes missing data and totalCount', async () => {
    const client: Client = client_fake({ getFeeds: async () => ({ data: null }) });
    const page: ListPage<FeedData> = await feedsPage_get(client, {});
    expect(page.data).toEqual([]);
    expect(page.totalCount).toBeNull();
  });

  test('publicFeedsPage_get returns null when the endpoint is absent', async () => {
    const client: Client = client_fake({ getFeeds: async () => ({ data: [] }) });
    expect(await publicFeedsPage_get(client, {})).toBeNull();
  });

  test('publicFeedsPage_get pages when the endpoint exists', async () => {
    const client: Client = client_fake({
      getPublicFeeds: async () => ({ data: [{ id: 1, name: 'pub' }], totalCount: 1 }),
    });
    const page: ListPage<FeedData> | null = await publicFeedsPage_get(client, {});
    expect(page?.data[0]?.name).toBe('pub');
  });

  test('pluginInstancesPage_get forwards search params', async () => {
    let seen: Record<string, unknown> | null = null;
    const client: Client = client_fake({
      getPluginInstances: async (params: Record<string, unknown>) => {
        seen = params;
        return { data: [{ id: 3, feed_id: 9, plugin_name: 'pl-dircopy' }], totalCount: 1 };
      },
    });
    const page: ListPage<PluginInstanceData> = await pluginInstancesPage_get(client, { feed_id: 9 });
    expect(seen).toEqual({ feed_id: 9 });
    expect(page.data[0]?.plugin_name).toBe('pl-dircopy');
  });
});

describe('pluginInstance_get', () => {
  /** Builds a fake instance resource with the given payload and methods. */
  function resource_fake(
    data: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { data, ...extra };
  }

  test('returns null when the client yields no resource', async () => {
    const client: Client = client_fake({ getPluginInstance: async () => null });
    expect(await pluginInstance_get(client, 5)).toBeNull();
  });

  test('exposes the wire payload as data', async () => {
    const client: Client = client_fake({
      getPluginInstance: async () =>
        resource_fake({ id: 5, feed_id: 2, plugin_name: 'pl-x', status: 'started' }),
    });
    const handle: PluginInstanceHandle | null = await pluginInstance_get(client, 5);
    expect(handle?.data?.status).toBe('started');
    expect(handle?.data?.feed_id).toBe(2);
  });

  test('tolerates a resource without a payload (sub-resources still usable)', async () => {
    const client: Client = client_fake({
      getPluginInstance: async () => ({
        getParameters: async () => ({ data: [{ param_name: 'p', value: 1 }], totalCount: 1 }),
      }),
    });
    const handle: PluginInstanceHandle | null = await pluginInstance_get(client, 5);
    expect(handle).not.toBeNull();
    expect(handle?.data).toBeNull();
    const page: ListPage<InstanceParameterData> | undefined =
      await handle?.parametersPage_get({ limit: 10, offset: 0 });
    expect(page?.data).toEqual([{ param_name: 'p', value: 1 }]);
  });

  test('status_set PUTs the new status to the resource', async () => {
    const put = jest.fn(async () => ({}));
    const client: Client = client_fake({
      getPluginInstance: async () => resource_fake({ id: 5, feed_id: 2, plugin_name: 'pl-x' }, { put }),
    });
    const handle: PluginInstanceHandle | null = await pluginInstance_get(client, 5);
    await handle?.status_set('cancelled');
    expect(put).toHaveBeenCalledWith({ status: 'cancelled' });
  });

  test('delete forwards to the resource', async () => {
    const del = jest.fn(async () => undefined);
    const client: Client = client_fake({
      getPluginInstance: async () =>
        resource_fake({ id: 5, feed_id: 2, plugin_name: 'pl-x' }, { delete: del }),
    });
    const handle: PluginInstanceHandle | null = await pluginInstance_get(client, 5);
    await handle?.delete();
    expect(del).toHaveBeenCalled();
  });

  test('logs_get joins log rows and returns null without a logs endpoint', async () => {
    const withLogs: Client = client_fake({
      getPluginInstance: async () =>
        resource_fake({ id: 5, feed_id: 2, plugin_name: 'pl-x' }, {
          getLogs: async () => ({ data: [{ log: 'line one' }, { log: 'line two' }] }),
        }),
    });
    const handleWith: PluginInstanceHandle | null = await pluginInstance_get(withLogs, 5);
    expect(await handleWith?.logs_get()).toBe('line one\nline two');

    const withoutLogs: Client = client_fake({
      getPluginInstance: async () => resource_fake({ id: 5, feed_id: 2, plugin_name: 'pl-x' }),
    });
    const handleWithout: PluginInstanceHandle | null = await pluginInstance_get(withoutLogs, 5);
    expect(await handleWithout?.logs_get()).toBeNull();
  });

  test('parametersPage_get reads data-style pages', async () => {
    const client: Client = client_fake({
      getPluginInstance: async () =>
        resource_fake({ id: 5, feed_id: 2, plugin_name: 'pl-x' }, {
          getParameters: async () => ({
            data: [{ param_name: 'dir', value: '/in' }],
            totalCount: 1,
          }),
        }),
    });
    const handle: PluginInstanceHandle | null = await pluginInstance_get(client, 5);
    const page: ListPage<InstanceParameterData> | undefined =
      await handle?.parametersPage_get({ limit: 10, offset: 0 });
    expect(page?.data).toEqual([{ param_name: 'dir', value: '/in' }]);
    expect(page?.totalCount).toBe(1);
  });

  test('parametersPage_get falls back to getItems-style pages', async () => {
    const client: Client = client_fake({
      getPluginInstance: async () =>
        resource_fake({ id: 5, feed_id: 2, plugin_name: 'pl-x' }, {
          getParameters: async () => ({
            getItems: () => [{ data: { param_name: 'thresh', value: 3 } }],
            totalCount: 1,
          }),
        }),
    });
    const handle: PluginInstanceHandle | null = await pluginInstance_get(client, 5);
    const page: ListPage<InstanceParameterData> | undefined =
      await handle?.parametersPage_get({ limit: 10, offset: 0 });
    expect(page?.data).toEqual([{ param_name: 'thresh', value: 3 }]);
  });
});

describe('pipeline surface', () => {
  test('pipeline_get returns null when the client yields no resource', async () => {
    const client: Client = client_fake({ getPipeline: async () => null });
    expect(await pipeline_get(client, 9)).toBeNull();
  });

  test('pipeline_get exposes the record and pages the stored defaults', async () => {
    const client: Client = client_fake({
      getPipeline: async () => ({
        data: { id: 9, name: 'brain-flow' },
        getDefaultParameters: async () => ({
          data: [{ plugin_piping_id: 3, param_name: 'dir', value: '/in' }],
          totalCount: 1,
        }),
      }),
    });
    const handle = await pipeline_get(client, 9);
    expect(handle?.data).toEqual({ id: 9, name: 'brain-flow' });
    const page = await handle?.defaultParametersPage_get({ limit: 10, offset: 0 });
    expect(page?.data).toEqual([{ plugin_piping_id: 3, param_name: 'dir', value: '/in' }]);
  });

  test('pluginPipings_get yields items whose plugin link resolves to a handle', async () => {
    const client: Client = client_fake({
      getPipeline: async () => ({
        data: { id: 9, name: 'brain-flow' },
        getPluginPipings: async () => ({
          getItems: () => [
            {
              data: { id: 1, plugin_name: 'pl-a', previous_id: null },
              getPlugin: async () => ({
                getPluginParameters: async () => ({
                  getItems: () => [{ data: { name: 'thresh', type: 'float' } }],
                }),
                getPluginComputeResources: async () => ({ data: [{ name: 'host' }] }),
              }),
            },
            { data: { id: 2, plugin_name: 'pl-b', previous_id: 1 } },
          ],
        }),
      }),
    });
    const handle = await pipeline_get(client, 9);
    const items = (await handle?.pluginPipings_get({ limit: 100 })) ?? [];
    expect(items.map((item) => item.data.id)).toEqual([1, 2]);

    const plugin = await items[0].plugin_get();
    const parameterPage = await plugin?.parametersPage_get({ limit: 10 });
    expect(parameterPage?.data).toEqual([{ name: 'thresh', type: 'float' }]);
    const computePage = await plugin?.computeResourcesPage_get({ limit: 10 });
    expect(computePage?.data).toEqual([{ name: 'host' }]);

    // The second item declares no getPlugin: its link resolves to null.
    expect(await items[1].plugin_get()).toBeNull();
  });

  test('pluginPipings_get accepts data-style piping lists', async () => {
    const client: Client = client_fake({
      getPipeline: async () => ({
        data: { id: 9, name: 'brain-flow' },
        getPluginPipings: async () => ({
          data: [{ id: 4, plugin_name: 'pl-c', previous_id: null }],
        }),
      }),
    });
    const handle = await pipeline_get(client, 9);
    const items = (await handle?.pluginPipings_get({ limit: 100 })) ?? [];
    expect(items.map((item) => item.data.plugin_name)).toEqual(['pl-c']);
    expect(await items[0].plugin_get()).toBeNull();
  });

  test('pipelineSourceFilesPage_get normalizes getItems-style lists', async () => {
    const client: Client = client_fake({
      getPipelineSourceFiles: async () => ({
        getItems: () => [{ data: { fname: 'flows/brain.yml', pipeline_id: 9 } }],
        totalCount: 1,
      }),
    });
    const page = await pipelineSourceFilesPage_get(client, { pipeline_id: 9, limit: 10 });
    expect(page.data).toEqual([{ fname: 'flows/brain.yml', pipeline_id: 9 }]);
    expect(page.totalCount).toBe(1);
  });
});

describe('downloadToken_create', () => {
  test('extracts token and url from the resource', async () => {
    const client: Client = client_fake({
      createDownloadToken: async () => ({
        data: { token: 'tok-123' },
        url: 'https://cube/api/v1/downloadtokens/9/',
      }),
    });
    const token: DownloadToken = await downloadToken_create(client);
    expect(token).toEqual({ token: 'tok-123', url: 'https://cube/api/v1/downloadtokens/9/' });
  });

  test('degrades to empty strings on a malformed resource', async () => {
    const client: Client = client_fake({ createDownloadToken: async () => ({}) });
    const token: DownloadToken = await downloadToken_create(client);
    expect(token).toEqual({ token: '', url: '' });
  });
});

describe('listPages_walk', () => {
  /**
   * Builds a page fetcher over a canned row array, recording every
   * (offset, limit) request it receives.
   *
   * @param rows - The full collection the fake server holds.
   * @param totalCount - The total the server reports, or null for none.
   * @param calls - Receives one [offset, limit] entry per fetch.
   * @returns Fetcher slicing rows by offset and limit.
   */
  function pageFetch_fake(
    rows: number[],
    totalCount: number | null,
    calls: Array<[number, number]>,
  ): (offset: number, limit: number) => Promise<ListPage<number>> {
    return async (offset: number, limit: number): Promise<ListPage<number>> => {
      calls.push([offset, limit]);
      return { data: rows.slice(offset, offset + limit), totalCount };
    };
  }

  /** Drains a walk into a flat row list. */
  async function walk_collect(
    steps: AsyncGenerator<PageWalkStep<number>, void, void>,
  ): Promise<number[]> {
    const collected: number[] = [];
    for await (const step of steps) collected.push(...step.items);
    return collected;
  }

  test('walks every page up to the reported total', async () => {
    const rows: number[] = Array.from({ length: 25 }, (_, i) => i);
    const calls: Array<[number, number]> = [];
    const collected: number[] = await walk_collect(
      listPages_walk(pageFetch_fake(rows, 25, calls), { pageSize: 10 }),
    );
    expect(collected).toEqual(rows);
    expect(calls).toEqual([[0, 10], [10, 10], [20, 10]]);
  });

  describe('windowed', () => {
    /** A fetcher whose pages resolve only when released, counting how many are in flight at once. */
    function gatedFetch_fake(rows: number[], totalCount: number | null) {
      const gates: Array<() => void> = [];
      let inFlight: number = 0;
      let peak: number = 0;
      const calls: number[] = [];
      const fetch = (offset: number, limit: number): Promise<ListPage<number>> => {
        calls.push(offset);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        return new Promise<ListPage<number>>((resolve: (page: ListPage<number>) => void): void => {
          gates.push((): void => { inFlight -= 1; resolve({ data: rows.slice(offset, offset + limit), totalCount }); });
        });
      };
      return { fetch, calls, release: (): void => { const g = gates.shift(); if (g) g(); }, releaseAll: (): void => { while (gates.length) (gates.shift() as () => void)(); }, peak: (): number => peak, waiting: (): number => gates.length };
    }

    test('fetches the first page alone, then up to the window at once, and lands every row', async () => {
      const rows: number[] = Array.from({ length: 95 }, (_, i) => i);
      const fake = gatedFetch_fake(rows, 95);
      const landed: number[] = [];
      const walk = (async (): Promise<void> => {
        for await (const step of listPages_walkWindowed(fake.fetch, { pageSize: 10, inFlight: 4 })) landed.push(...step.items);
      })();
      await new Promise((r) => setImmediate(r));
      expect(fake.waiting()).toBe(1); // the first page, alone: it tells the total
      fake.release();
      await new Promise((r) => setImmediate(r));
      expect(fake.waiting()).toBe(4); // then the window opens
      fake.releaseAll();
      for (let i = 0; i < 20; i++) { await new Promise((r) => setImmediate(r)); fake.releaseAll(); }
      await walk;
      expect(landed.sort((a, b) => a - b)).toEqual(rows);
      expect(fake.peak()).toBe(4);
      expect(fake.calls.sort((a, b) => a - b)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    });

    test('walks one page at a time when the server reports no total', async () => {
      const rows: number[] = Array.from({ length: 25 }, (_, i) => i);
      const calls: Array<[number, number]> = [];
      const collected: number[] = await walk_collect(
        listPages_walkWindowed(pageFetch_fake(rows, null, calls), { pageSize: 10, inFlight: 4 }),
      );
      expect(collected).toEqual(rows);
      expect(calls).toEqual([[0, 10], [10, 10], [20, 10]]);
    });

    test('a failing page ends the walk after the window settles, and the failure propagates', async () => {
      const rows: number[] = Array.from({ length: 50 }, (_, i) => i);
      let n: number = 0;
      const fetch = async (offset: number, limit: number): Promise<ListPage<number>> => {
        n += 1;
        if (offset === 20) throw new Error('CUBE 502');
        return { data: rows.slice(offset, offset + limit), totalCount: 50 };
      };
      await expect(walk_collect(listPages_walkWindowed(fetch, { pageSize: 10, inFlight: 4 }))).rejects.toThrow('CUBE 502');
      expect(n).toBeLessThanOrEqual(5);
    });
  });

  test('stops without an extra fetch when the total lands on a page boundary', async () => {
    const rows: number[] = Array.from({ length: 20 }, (_, i) => i);
    const calls: Array<[number, number]> = [];
    const collected: number[] = await walk_collect(
      listPages_walk(pageFetch_fake(rows, 20, calls), { pageSize: 10 }),
    );
    expect(collected).toEqual(rows);
    expect(calls).toEqual([[0, 10], [10, 10]]);
  });

  test('stops on a short page when the server reports no total', async () => {
    const rows: number[] = Array.from({ length: 13 }, (_, i) => i);
    const calls: Array<[number, number]> = [];
    const collected: number[] = await walk_collect(
      listPages_walk(pageFetch_fake(rows, null, calls), { pageSize: 10 }),
    );
    expect(collected).toEqual(rows);
    expect(calls).toEqual([[0, 10], [10, 10]]);
  });

  test('stops on an empty page when full pages carry no total', async () => {
    const rows: number[] = Array.from({ length: 20 }, (_, i) => i);
    const calls: Array<[number, number]> = [];
    const collected: number[] = await walk_collect(
      listPages_walk(pageFetch_fake(rows, null, calls), { pageSize: 10 }),
    );
    expect(collected).toEqual(rows);
    expect(calls).toEqual([[0, 10], [10, 10], [20, 10]]);
  });

  test('yields one empty step for an empty collection', async () => {
    const calls: Array<[number, number]> = [];
    const steps: PageWalkStep<number>[] = [];
    for await (const step of listPages_walk(pageFetch_fake([], 0, calls))) {
      steps.push(step);
    }
    expect(steps).toEqual([{ items: [], offset: 0, total: 0 }]);
    expect(calls).toEqual([[0, 100]]);
  });

  test('latches a total first reported after the opening page', async () => {
    const rows: number[] = Array.from({ length: 15 }, (_, i) => i);
    const calls: Array<[number, number]> = [];
    let requestIndex: number = 0;
    const fetch = async (offset: number, limit: number): Promise<ListPage<number>> => {
      calls.push([offset, limit]);
      requestIndex += 1;
      return {
        data: rows.slice(offset, offset + limit),
        totalCount: requestIndex === 1 ? null : 15,
      };
    };
    const collected: number[] = await walk_collect(listPages_walk(fetch, { pageSize: 10 }));
    expect(collected).toEqual(rows);
    expect(calls).toEqual([[0, 10], [10, 10]]);
  });

  test('resumes from a prior offset and latched total', async () => {
    const rows: number[] = Array.from({ length: 30 }, (_, i) => i);
    const calls: Array<[number, number]> = [];
    const collected: number[] = await walk_collect(
      listPages_walk(pageFetch_fake(rows, 30, calls), {
        pageSize: 10, startOffset: 20, startTotal: 30,
      }),
    );
    expect(collected).toEqual(rows.slice(20));
    expect(calls).toEqual([[20, 10]]);
  });

  test('continues past a short page while the server says more exist', async () => {
    // Servers may cap the requested limit: full pages here are 3 rows even
    // though the walk asks for 10, and no total is reported.
    const rows: number[] = Array.from({ length: 8 }, (_, i) => i);
    const calls: Array<[number, number]> = [];
    const fetch = async (offset: number, limit: number): Promise<ListPage<number>> => {
      calls.push([offset, limit]);
      const items: number[] = rows.slice(offset, offset + Math.min(limit, 3));
      return { data: items, totalCount: null, hasMore: offset + items.length < rows.length };
    };
    const collected: number[] = await walk_collect(listPages_walk(fetch, { pageSize: 10 }));
    expect(collected).toEqual(rows);
    expect(calls).toEqual([[0, 10], [3, 10], [6, 10]]);
  });

  test('stops without an extra fetch when the server says no more exist', async () => {
    const calls: Array<[number, number]> = [];
    const fetch = async (offset: number, limit: number): Promise<ListPage<number>> => {
      calls.push([offset, limit]);
      return { data: [1, 2, 3].slice(0, limit), totalCount: null, hasMore: false };
    };
    const collected: number[] = await walk_collect(listPages_walk(fetch, { pageSize: 3 }));
    expect(collected).toEqual([1, 2, 3]);
    expect(calls).toEqual([[0, 3]]);
  });

  test('advances by rows served, not rows surviving normalization', async () => {
    // A wrap may drop malformed rows from data while reporting the served
    // count; the offset must advance by what the server sent, or the walk
    // refetches rows and can end early.
    const calls: Array<[number, number]> = [];
    const fetch = async (offset: number, limit: number): Promise<ListPage<number>> => {
      calls.push([offset, limit]);
      const pages: Array<{ kept: number[]; served: number }> = [
        { kept: [1, 2], served: 4 },
        { kept: [3], served: 4 },
        { kept: [4], served: 2 },
      ];
      const page = pages[offset / 4];
      return { data: page.kept, totalCount: 10, fetchedCount: page.served };
    };
    const collected: number[] = await walk_collect(listPages_walk(fetch, { pageSize: 4 }));
    expect(collected).toEqual([1, 2, 3, 4]);
    expect(calls).toEqual([[0, 4], [4, 4], [8, 4]]);
  });

  test('a served page whose rows were all dropped does not end the walk', async () => {
    const calls: Array<[number, number]> = [];
    const fetch = async (offset: number, limit: number): Promise<ListPage<number>> => {
      calls.push([offset, limit]);
      if (offset === 0) return { data: [], totalCount: 6, fetchedCount: 3 };
      return { data: [7, 8, 9], totalCount: 6, fetchedCount: 3 };
    };
    const collected: number[] = await walk_collect(listPages_walk(fetch, { pageSize: 3 }));
    expect(collected).toEqual([7, 8, 9]);
    expect(calls).toEqual([[0, 3], [3, 3]]);
  });

  test('propagates a fetch failure to the consumer', async () => {
    const fetch = async (): Promise<ListPage<number>> => {
      throw new Error('wire down');
    };
    await expect(walk_collect(listPages_walk(fetch))).rejects.toThrow('wire down');
  });
});

describe('collectionPage_wrap', () => {
  test('carries totalCount and hasNextPage from the collection', () => {
    const page = collectionPage_wrap({ totalCount: 12, hasNextPage: true }, ['a', 'b']);
    expect(page).toEqual({ data: ['a', 'b'], totalCount: 12, hasMore: true });
  });

  test('translates a negative totalCount to unknown', () => {
    const page = collectionPage_wrap({ totalCount: -1, hasNextPage: false }, []);
    expect(page).toEqual({ data: [], totalCount: null, hasMore: false });
  });
});

describe('plugin_find', () => {
  test('resolves a plugin by exact name and version, with a handle onto it', async () => {
    const getPlugins = jest.fn(async () => ({
      getItems: () => [{
        data: { id: 7, name: 'pl-example', version: '1.0.0', type: 'fs' },
        getPluginParameters: async () => ({ getItems: () => [{ data: { name: 'input', type: 'path' } }] }),
      }],
    }));
    const client: Client = client_fake({ getPlugins });

    const found = await plugin_find(client, 'pl-example', '1.0.0');
    expect(getPlugins).toHaveBeenCalledWith({ name_exact: 'pl-example', version: '1.0.0', limit: 1 });
    expect(found?.data.id).toBe(7);
    const page = await found?.handle.parametersPage_get({ limit: 10, offset: 0 });
    expect(page?.data).toEqual([{ name: 'input', type: 'path' }]);
  });

  test('answers null when CUBE registers no such plugin at that version', async () => {
    const client: Client = client_fake({ getPlugins: async () => ({ getItems: () => [] }) });
    expect(await plugin_find(client, 'pl-example', '9.9.9')).toBeNull();
  });

  test('answers null for a served row carrying no data', async () => {
    const client: Client = client_fake({ getPlugins: async () => ({ getItems: () => [{}] }) });
    expect(await plugin_find(client, 'pl-example', '1.0.0')).toBeNull();
  });
});

describe('pluginParameters_drain', () => {
  /** A parameter list of the given size, served in pages of 100. */
  function parameters_serve(total: number): {
    handle: { parametersPage_get: (params: Record<string, unknown>) => Promise<ListPage<{ name: string }>> };
    windows: Array<Record<string, unknown>>;
  } {
    const windows: Array<Record<string, unknown>> = [];
    return {
      windows,
      handle: {
        parametersPage_get: async (params: Record<string, unknown>): Promise<ListPage<{ name: string }>> => {
          windows.push(params);
          const offset: number = Number(params.offset ?? 0);
          const limit: number = Number(params.limit ?? 100);
          const rows = Array.from(
            { length: Math.max(Math.min(total - offset, limit), 0) },
            (_unused: unknown, index: number) => ({ name: `p${offset + index}` }),
          );
          return { data: rows, totalCount: total, fetchedCount: rows.length };
        },
      },
    };
  }

  test('reads a parameter list that fits one page', async () => {
    const served = parameters_serve(3);
    const rows = await pluginParameters_drain(served.handle as never);
    expect(rows).toHaveLength(3);
    expect(served.windows).toHaveLength(1);
  });

  // The single-page `{ limit: 100 }` idiom this replaces lost every
  // parameter past the hundredth and reported nothing missing.
  test('reads past the hundredth parameter rather than stopping at a page', async () => {
    const served = parameters_serve(237);
    const rows = await pluginParameters_drain(served.handle as never);
    expect(rows).toHaveLength(237);
    expect(rows[236]).toEqual({ name: 'p236' });
    expect(served.windows.length).toBeGreaterThan(1);
  });

  test('reads an empty parameter list as an empty list', async () => {
    const served = parameters_serve(0);
    expect(await pluginParameters_drain(served.handle as never)).toEqual([]);
  });
});

describe('a page that is malformed is refused, not read as empty', () => {
  /** An instance handle whose parameters answer with the given page. */
  async function parameters_ask(page: unknown): Promise<unknown> {
    const client: Client = client_fake({
      getPluginInstance: async () => ({ data: { id: 5, feed_id: 2, plugin_name: 'pl-x' }, getParameters: async () => page }),
    });
    const handle: PluginInstanceHandle | null = await pluginInstance_get(client, 5);
    return handle?.parametersPage_get({ limit: 10, offset: 0 });
  }

  test('data that is there and is not a list fails, even when the page also serves items', async () => {
    await expect(parameters_ask({ data: { param_name: 'dir' }, getItems: () => [{ data: { param_name: 'dir' } }] }))
      .rejects.toThrow('whose data is an object, where an array is read');
    await expect(parameters_ask({ data: 'none', getItems: () => [] })).rejects.toThrow('whose data is a string, where an array is read');
  });

  test('a served item with no data, or with data of another kind, fails the page at its place', async () => {
    await expect(parameters_ask({ getItems: () => [{ data: { param_name: 'a' } }, {}] })).rejects.toThrow('whose items[1].data is missing, where an object is read');
    await expect(parameters_ask({ getItems: () => [{ data: null }] })).rejects.toThrow('whose items[0].data is null, where an object is read');
    await expect(parameters_ask({ getItems: () => [{ data: { param_name: 'a' } }, { data: { param_name: 4 } }] })).rejects.toThrow('items[1].data.param_name is a number, where a string is read');
  });

  test('a page with no data and no items is still an empty page', async () => {
    expect(await parameters_ask({ getItems: () => [], totalCount: 0 })).toEqual({ data: [], totalCount: 0, fetchedCount: 0 });
  });

  test('a piping served with no data fails the pipings at its place', async () => {
    const client: Client = client_fake({
      getPipeline: async () => ({
        data: { id: 9, name: 'brain-flow' },
        getPluginPipings: async () => ({ getItems: () => [{ data: { id: 1, plugin_name: 'pl-a', previous_id: null } }, { getPlugin: async () => null }] }),
      }),
    });
    const handle = await pipeline_get(client, 9);
    await expect(handle?.pluginPipings_get({ limit: 100 })).rejects.toThrow('whose items[1].data is missing, where an object is read');
  });

  test('a field read as text is refused when it is there and is not text; absent or null it is as before', async () => {
    const instance_ask = (data: Record<string, unknown>): Promise<PluginInstanceHandle | null> =>
      pluginInstance_get(client_fake({ getPluginInstance: async () => ({ data }) }), 5);
    await expect(instance_ask({ id: 5, feed_id: 2, plugin_name: 'pl-x', output_path: 7 })).rejects.toThrow('CUBE answered a plugin instance whose data.output_path is a number, where a string is read');
    await expect(instance_ask({ id: 5, feed_id: 2, plugin_name: 'pl-x', status: {} })).rejects.toThrow('whose data.status is an object, where a string is read');
    expect((await instance_ask({ id: 5, feed_id: 2, plugin_name: 'pl-x', output_path: null }))?.data?.output_path).toBeNull();
    expect((await instance_ask({ id: 5, feed_id: 2, plugin_name: 'pl-x' }))?.data?.output_path).toBeUndefined();
  });
});
