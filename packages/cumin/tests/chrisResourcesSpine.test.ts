/**
 * @file Tests for the ChRISResource spine driven directly: list fetching
 * with retry and client-side filtering, pagination in resources_getAll,
 * item deletion, field selection and dictionary conversion.
 */

jest.mock('../src/connect/chrisConnection', () => ({
  chrisConnection: { client_get: jest.fn() },
}));

import { ListResource } from '@fnndsc/chrisapi';
import { chrisConnection } from '../src/connect/chrisConnection';
import {
  ChRISResource,
  resourceFields_get,
  Item,
  FilteredResourceData,
  Dictionary,
} from '../src/resources/chrisResources';
import { listResource_make } from './fixtures';
import { errorStack } from '../src/error/errorStack';

const mockClientGet: jest.Mock = chrisConnection.client_get as unknown as jest.Mock;

const rows_make = (count: number, offset: number = 0): Array<Record<string, unknown>> =>
  Array.from({ length: count }, (_v: unknown, i: number) => ({
    id: offset + i + 1,
    name: `item-${offset + i + 1}`,
  }));

let logSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe('client access', () => {
  it('fetches and caches the shared client', async () => {
    mockClientGet.mockResolvedValue({ me: true });
    const resource: ChRISResource = new ChRISResource();
    expect(await resource.client_get()).toEqual({ me: true });
    expect(await resource.client_get()).toEqual({ me: true });
    expect(mockClientGet).toHaveBeenCalledTimes(1);
  });
});

describe('resources_getList', () => {
  it('returns bare params when no fetch method is bound', async () => {
    const resource: ChRISResource = new ChRISResource();
    expect(await resource.resources_getList({ limit: 5 })).toMatchObject({ limit: 5 });
  });

  it('logs and returns params when the method yields nothing', async () => {
    const resource: ChRISResource = new ChRISResource();
    resource.resourceName = 'Ghosts';
    resource.binding_applyGet({}, jest.fn(async () => null) as never);
    await resource.resources_getList();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Ghosts resource list returned 'undefined' or 'null'"));
  });

  it('retries with simplified params and filters client-side', async () => {
    const fetch = jest.fn()
      .mockRejectedValueOnce(new Error('400 unknown query param'))
      .mockResolvedValue(listResource_make(rows_make(3)));
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never, 'Filtered');
    await resource.resources_getList({ name: 'item-2' });
    const fields = await resource.resourceFields_get();
    expect(fields?.items).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    // A page is a page of a hundred now, not of twenty: an unbounded caller
    // gets the collection, and a page size is what the walk asks for (#401).
    expect(fetch).toHaveBeenLastCalledWith({ limit: 100, offset: 0 });
  });

  it('filters by exact id match client-side', async () => {
    const fetch = jest.fn()
      .mockRejectedValueOnce(new Error('400'))
      .mockResolvedValue(listResource_make(rows_make(12)));
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never);
    await resource.resources_getList({ id: '1' });
    const fields = await resource.resourceFields_get();
    // exact match: only id 1, not 10/11/12
    expect(fields?.items).toHaveLength(1);
  });

  it('warns when the client-side filter matches nothing', async () => {
    const fetch = jest.fn()
      .mockRejectedValueOnce(new Error('400'))
      .mockResolvedValue(listResource_make(rows_make(2)));
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never);
    await resource.resources_getList({ name: 'zzz' });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No items match'));
  });

  it('rethrows when the simplified retry also fails', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('hard down'));
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never);
    await expect(resource.resources_getList({ name: 'x' })).rejects.toThrow('hard down');
  });

  it('resolves a lazy binding before fetching', async () => {
    const obj = { getThings: jest.fn(async () => listResource_make(rows_make(1))) };
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyLazy(async () => obj, 'getThings', 'Things');
    await resource.resources_getList();
    expect(obj.getThings).toHaveBeenCalled();
  });

  it('reports a lazy method that does not exist', async () => {
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyLazy(async () => ({}), 'getMissing');
    await resource.resources_getList();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('getMissing not found'));
  });
});

describe('resources_getWhole: the whole collection, or an error', () => {
  /** A list resource whose collection carries no `items` at all. */
  const malformed_make = (): ListResource => {
    const list: ListResource = Object.create(ListResource.prototype) as ListResource;
    Object.defineProperties(list, {
      collection: { value: {} },
      getItems: { value: (): unknown[] => [] },
      totalCount: { value: -1 },
      hasNext: { value: false },
    });
    return list;
  };

  it('answers an empty table, not null, for a collection that holds nothing', async () => {
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, jest.fn(async () => listResource_make([])) as never);
    expect((await resource.resources_getWhole()).tableData).toEqual([]);
  });

  it('follows a short page when the server says more follows', async () => {
    const fetch = jest.fn(async (params: { offset?: number }) =>
      (params.offset ?? 0) === 0
        ? listResource_make(rows_make(2), 'resources', true)
        : listResource_make(rows_make(1, 2)),
    );
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never);
    const whole: FilteredResourceData = await resource.resources_getWhole();
    expect(whole.tableData.map((row: Record<string, unknown>) => row.id)).toEqual([1, 2, 3]);
    expect(fetch).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: 2 }));
  });

  it('stops on a full page when the server says nothing follows', async () => {
    const fetch = jest.fn(async () => listResource_make(rows_make(100), 'resources', false));
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never);
    expect((await resource.resources_getWhole()).tableData).toHaveLength(100);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a list that carries no items, where the lenient walk reads it as empty', async () => {
    const resource: ChRISResource = new ChRISResource();
    resource.resourceName = 'Files';
    resource.binding_applyGet({}, jest.fn(async () => malformed_make()) as never);
    expect(await resource.resources_getAll()).toBeNull();
    await expect(resource.resources_getWhole()).rejects.toThrow('Files: the list at offset 0 carries no items');
  });

  it('refuses a list that carries no links, which has not said that nothing follows', async () => {
    const list: ListResource = Object.create(ListResource.prototype) as ListResource;
    Object.defineProperties(list, { collection: { value: { items: [] } }, getItems: { value: (): unknown[] => [] } });
    const resource: ChRISResource = new ChRISResource();
    resource.resourceName = 'Files';
    resource.binding_applyGet({}, jest.fn(async () => list) as never);
    await expect(resource.resources_getWhole()).rejects.toThrow('Files: the list at offset 0 carries no links');
  });

  it('reads "more follows" from the collection\'s own next link, through the SDK\'s getter', async () => {
    const first: ListResource = listResource_make(rows_make(2), 'resources', true);
    expect(Object.getOwnPropertyNames(first)).not.toContain('hasNext');
    expect(Object.getOwnPropertyNames(first)).not.toContain('hasNextPage');
    expect(first.hasNextPage).toBe(true);
    expect(listResource_make(rows_make(2)).hasNextPage).toBe(false);
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, jest.fn(async () => first) as never);
    await resource.resources_getList();
    expect(resource.hasNextPage).toBe(true);
  });

  it('refuses an answer that is not a list', async () => {
    const resource: ChRISResource = new ChRISResource();
    resource.resourceName = 'Files';
    resource.binding_applyGet({}, jest.fn(async () => null) as never);
    await expect(resource.resources_getWhole()).rejects.toThrow('Files: the answer at offset 0 is not a list');
  });

  it('refuses a later page that yields nothing, and never reuses the page before it', async () => {
    const fetch = jest.fn(async (params: { offset?: number }) =>
      (params.offset ?? 0) === 0 ? listResource_make(rows_make(2), 'resources', true) : null,
    );
    const resource: ChRISResource = new ChRISResource();
    resource.resourceName = 'Files';
    resource.binding_applyGet({}, fetch as never);
    await expect(resource.resources_getWhole()).rejects.toThrow('Files: the answer at offset 2 is not a list');
  });

  it('refuses a page that says more follows and gives no rows', async () => {
    const resource: ChRISResource = new ChRISResource();
    resource.resourceName = 'Files';
    resource.binding_applyGet({}, jest.fn(async () => listResource_make([], 'resources', true)) as never);
    await expect(resource.resources_getWhole()).rejects.toThrow('Files: more is said to follow offset 0, and the page is empty');
  });

  it('lets a failed fetch be a failure', async () => {
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, jest.fn(async () => { throw new Error('500 Internal Server Error'); }) as never);
    await expect(resource.resources_getWhole()).rejects.toThrow('500 Internal Server Error');
  });
});

describe('resources_getAll', () => {
  it('follows a full page that says nothing about a next one, where the strict walk refuses that page', async () => {
    /** A page whose collection carries items and no links at all. */
    const unlinked_make = (rows: Array<Record<string, unknown>>): ListResource => {
      const list: ListResource = listResource_make(rows);
      delete (list.collection as { links?: unknown }).links;
      return list;
    };
    const fetch = jest.fn(async (params: { offset?: number }) =>
      (params.offset ?? 0) === 0 ? unlinked_make(rows_make(100)) : listResource_make(rows_make(1, 100)),
    );
    const lenient: ChRISResource = new ChRISResource();
    lenient.binding_applyGet({}, fetch as never);
    expect((await lenient.resources_getAll())?.tableData).toHaveLength(101);

    const strict: ChRISResource = new ChRISResource();
    strict.resourceName = 'Files';
    strict.binding_applyGet({}, fetch as never);
    await expect(strict.resources_getWhole()).rejects.toThrow('Files: the list at offset 0 carries no links');
  });

  it('walks pages until a short page arrives', async () => {
    const fetch = jest.fn(async (params: { offset?: number }) =>
      (params.offset ?? 0) === 0
        ? listResource_make(rows_make(100), 'resources', true)
        : listResource_make(rows_make(5, 100)),
    );
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never);
    const all: FilteredResourceData | null = await resource.resources_getAll();
    expect(all?.tableData).toHaveLength(105);
    expect(all?.totalCount).toBe(105);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops when the API reports no next page', async () => {
    const fetch = jest.fn(async () => listResource_make(rows_make(100), 'resources', false));
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never);
    const all: FilteredResourceData | null = await resource.resources_getAll();
    expect(all?.tableData).toHaveLength(100);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns null when nothing is found', async () => {
    const fetch = jest.fn(async () => listResource_make([]));
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never);
    expect(await resource.resources_getAll()).toBeNull();
  });

  it('says a walk stopped short rather than passing it off as the end', async () => {
    // CUBE is known to refuse some queries beyond an offset. Returning what
    // was gathered as though it were everything is the defect (#401): the
    // walk keeps the rows AND says where it stopped.
    const fetch = jest.fn(async (params: { offset?: number }) => {
      if ((params.offset ?? 0) === 0) return listResource_make(rows_make(100), 'resources', true);
      throw new Error('Internal server error');
    });
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never);
    const all: FilteredResourceData | null = await resource.resources_getAll();
    expect(all?.tableData).toHaveLength(100);
    expect(all?.incomplete?.gathered).toBe(100);
    expect(all?.incomplete?.reason).toContain('Internal server error');
  });
});

describe('resources_getAll is steered by what the server sent, not by what was kept', () => {
  /** A server that refuses any query naming a field, so the filter is applied on this side. */
  const refusing = (pages: (offset: number) => ListResource) => jest.fn(async (params: Record<string, unknown>) => {
    if ('name' in params) throw new Error('400 unknown query param');
    return pages(Number(params.offset ?? 0));
  });
  /** The offsets of the fetches the server answered. */
  const offsets_answered = (fetch: jest.Mock): number[] => fetch.mock.calls
    .map(([params]: [Record<string, unknown>]) => params)
    .filter((params: Record<string, unknown>): boolean => !('name' in params))
    .map((params: Record<string, unknown>): number => Number(params.offset));

  it('reads past a full page that kept no row, to the only match on the next', async () => {
    const fetch = refusing((offset: number): ListResource => (offset === 0 ? listResource_make(rows_make(100), 'resources', true) : listResource_make(rows_make(5, 100))));
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never, 'Filtered');
    const all: FilteredResourceData | null = await resource.resources_getAll({ name: 'item-103' });
    expect(all?.tableData).toEqual([{ id: 103, name: 'item-103' }]);
    expect(all?.incomplete).toBeUndefined();
    expect(offsets_answered(fetch)).toEqual([0, 100]);
  });

  it('reads past a full page that kept three rows of a hundred, which is not a short page', async () => {
    const fetch = refusing((offset: number): ListResource => (offset === 0 ? listResource_make(rows_make(100)) : listResource_make(rows_make(20, 100))));
    const resource: ChRISResource = new ChRISResource();
    // No links on these pages: the walk has only the count to go by, and it is the raw count.
    const bare = (list: ListResource): ListResource => { delete (list.collection as { links?: unknown }).links; return list; };
    const served = jest.fn(async (params: Record<string, unknown>) => bare(await fetch(params)));
    resource.binding_applyGet({}, served as never, 'Filtered');
    const all: FilteredResourceData | null = await resource.resources_getAll({ name: 'item-11' });
    // item-11, item-110 to item-119 on the two pages.
    expect(all?.tableData.map((row: Record<string, unknown>) => row.name)).toEqual(['item-11', 'item-110', 'item-111', 'item-112', 'item-113', 'item-114', 'item-115', 'item-116', 'item-117', 'item-118', 'item-119']);
    expect(offsets_answered(fetch)).toEqual([0, 100]);
  });

  it('moves on by the rows received when the server sends fewer than asked and says more follow', async () => {
    const fetch = refusing((offset: number): ListResource => (offset === 0 ? listResource_make(rows_make(40), 'resources', true) : listResource_make(rows_make(5, 40))));
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never, 'Filtered');
    const all: FilteredResourceData | null = await resource.resources_getAll({ name: 'item-41' });
    expect(all?.tableData).toEqual([{ id: 41, name: 'item-41' }]);
    // The second page is asked for at 40, where the first ended, not at 100.
    expect(offsets_answered(fetch)).toEqual([0, 40]);
  });

  it('keeps its rows and says so when a later page has no rows and says more follow', async () => {
    const fetch = jest.fn(async (params: { offset?: number }) => ((params.offset ?? 0) === 0
      ? listResource_make(rows_make(100), 'resources', true)
      : listResource_make([], 'resources', true)));
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never, 'Stalled');
    errorStack.stack_clear();
    const all: FilteredResourceData | null = await resource.resources_getAll();
    expect(all?.tableData).toHaveLength(100);
    expect(all?.incomplete?.gathered).toBe(100);
    expect(all?.incomplete?.reason).toContain('no rows at offset 100');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(errorStack.stack_search('no rows at offset 100').length).toBe(1);
  });

  it('keeps the one match it has when the walk stalls under a filter applied here', async () => {
    const fetch = refusing((offset: number): ListResource => (offset === 0 ? listResource_make(rows_make(100), 'resources', true) : listResource_make([], 'resources', true)));
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never, 'Stalled');
    const all: FilteredResourceData | null = await resource.resources_getAll({ name: 'item-100' });
    expect(all?.tableData).toEqual([{ id: 100, name: 'item-100' }]);
    expect(all?.incomplete?.gathered).toBe(1);
    expect(all?.incomplete?.reason).toContain('no rows at offset 100');
  });

  it('fails, and does not answer as an empty collection, when the first page has no rows and says more follow', async () => {
    const fetch = jest.fn(async () => listResource_make([], 'resources', true));
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never, 'Stalled');
    await expect(resource.resources_getAll()).rejects.toThrow('Stalled: the server sent no rows at offset 0 and said that more follow');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('says the walk stopped short when a later page does not come, and does not read the page before it again', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(listResource_make(rows_make(100), 'resources', true))
      .mockResolvedValue(null);
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never, 'Missing');
    const all: FilteredResourceData | null = await resource.resources_getAll();
    expect(all?.tableData).toHaveLength(100);
    expect(all?.incomplete?.gathered).toBe(100);
    expect(all?.incomplete?.reason).toContain('the page at offset 100 did not come as a list');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('says the walk stopped short when a later page is not a list, with no row counted twice', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(listResource_make(rows_make(100), 'resources', true))
      .mockResolvedValue({ data: { id: 7 } });
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never, 'Missing');
    const all: FilteredResourceData | null = await resource.resources_getAll();
    expect(all?.tableData).toHaveLength(100);
    expect(new Set(all?.tableData.map((row: Record<string, unknown>) => row.id)).size).toBe(100);
    expect(all?.incomplete?.reason).toContain('the page at offset 100 did not come as a list');
  });

  it('says the walk stopped short when a later page is a list the SDK made of a body with no collection', async () => {
    // What the SDK's own get() leaves for such a body: a real ListResource, its collection null, its items none.
    const hollow: ListResource = Object.create(ListResource.prototype) as ListResource;
    Object.defineProperties(hollow, { collection: { value: null }, getItems: { value: (): unknown[] => [] } });
    const fetch = jest.fn()
      .mockResolvedValueOnce(listResource_make(rows_make(100), 'resources', true))
      .mockResolvedValue(hollow);
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never, 'Missing');
    const all: FilteredResourceData | null = await resource.resources_getAll();
    expect(all?.tableData).toHaveLength(100);
    expect(all?.incomplete?.gathered).toBe(100);
    expect(all?.incomplete?.reason).toContain('the page at offset 100 did not come as a list of items');
  });

  it('still takes a later page with an empty list of items and no next link as the end', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce((() => { const list: ListResource = listResource_make(rows_make(100)); delete (list.collection as { links?: unknown }).links; return list; })())
      .mockResolvedValue(listResource_make([]));
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never);
    const all: FilteredResourceData | null = await resource.resources_getAll();
    expect(all?.tableData).toHaveLength(100);
    expect(all?.incomplete).toBeUndefined();
  });

  it('fails when a later page does not come and nothing had matched: the match may be on it', async () => {
    const fetch = jest.fn(async (params: Record<string, unknown>) => {
      if ('name' in params) throw new Error('400 unknown query param');
      return Number(params.offset ?? 0) === 0 ? listResource_make(rows_make(100), 'resources', true) : null;
    });
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never, 'Missing');
    await expect(resource.resources_getAll({ name: 'item-150' })).rejects.toThrow('the page at offset 100 did not come as a list');
  });
});

describe('a listing shows what is there', () => {
  it('walks the collection when the caller named no limit', async () => {
    // The old default answered with twenty and said nothing about the rest.
    const fetch = jest.fn(async (params: { offset?: number }) =>
      (params.offset ?? 0) === 0
        ? listResource_make(rows_make(100), 'resources', true)
        : listResource_make(rows_make(37, 100)),
    );
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never);
    const all: FilteredResourceData | null = await resource.resources_listAndFilterByOptions();
    expect(all?.tableData).toHaveLength(137);
    expect(all?.incomplete).toBeUndefined();
  });

  it('honours a limit the caller asked for, and says it is a window', async () => {
    const fetch = jest.fn(async () => listResource_make(rows_make(10), 'resources', true, 1817));
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never);
    const page: FilteredResourceData | null = await resource.resources_listAndFilterByOptions({ limit: 10 });
    expect(page?.tableData).toHaveLength(10);
    expect(page?.totalCount).toBe(1817);
    expect(page?.incomplete?.reason).toContain('10 of 1817');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('resourceItem_delete and resources_getItems', () => {
  it('deletes an item from the current collection', async () => {
    const del = jest.fn(async () => undefined);
    const list: ListResource = listResource_make(rows_make(1));
    Object.defineProperty(list, 'getItem', { value: () => ({ _delete: del }) });
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, jest.fn(async () => list) as never);
    await resource.resources_getList();
    expect(await resource.resourceItem_delete(1)).toBe(true);
    expect(del).toHaveBeenCalled();
  });

  it('returns false when the delete throws or no collection exists', async () => {
    const list: ListResource = listResource_make(rows_make(1));
    Object.defineProperty(list, 'getItem', {
      value: () => ({ _delete: jest.fn(async () => { throw new Error('403'); }) }),
    });
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, jest.fn(async () => list) as never);
    await resource.resources_getList();
    expect(await resource.resourceItem_delete(1)).toBe(false);

    expect(await new ChRISResource().resourceItem_delete(1)).toBe(false);
  });

  it('returns the item resources after a list fetch', async () => {
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, jest.fn(async () => listResource_make(rows_make(2))) as never);
    await resource.resources_getList();
    const items = await resource.resources_getItems();
    expect(items).toHaveLength(2);
  });

  it('answers the items of the collection it just fetched, not of one a call before it left', async () => {
    const itemsOf = (label: string, count: number): ListResource => {
      const list: ListResource = Object.create(ListResource.prototype) as ListResource;
      Object.defineProperties(list, {
        collection: { value: { links: [], items: [] } },
        getItems: { value: (): unknown[] => Array.from({ length: count }, (_v: unknown, i: number) => ({ from: label, at: i })) },
      });
      return list;
    };
    const fetch = jest.fn().mockResolvedValueOnce(itemsOf('A', 2)).mockResolvedValueOnce(itemsOf('B', 2));
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, fetch as never);
    await resource.resources_getList();
    expect(await resource.resources_getItems()).toEqual([{ from: 'B', at: 0 }, { from: 'B', at: 1 }]);
  });

  it('returns null from getItems without a bound method', async () => {
    expect(await new ChRISResource().resources_getItems()).toBeNull();
  });
});

describe('field selection and dictionary conversion', () => {
  it('honours a fields option over the full field set', async () => {
    const resource: ChRISResource = new ChRISResource();
    resource.binding_applyGet({}, jest.fn(async () => listResource_make(rows_make(1))) as never);
    const filtered: FilteredResourceData | null =
      await resource.resources_listAndFilterByOptions({ fields: 'name' });
    expect(filtered?.selectedFields).toEqual(['name']);
    expect(filtered?.tableData[0]).toEqual({ id: '1', name: 'item-1' });
  });

  it('resolves a field filter argument when options carry none', () => {
    const resource: ChRISResource = new ChRISResource();
    expect(resource.fieldSpec_resolve('a, b')).toEqual(['a', 'b']);
    expect(resource.fieldSpec_resolve(undefined, { fields: 'c' })).toEqual(['c']);
    expect(resource.fieldSpec_resolve()).toEqual([]);
  });

  it('converts items to dictionaries', () => {
    const resource: ChRISResource = new ChRISResource();
    const items: Item[] = [{
      data: [{ name: 'id', value: 1 }, { name: 'name', value: 'x' }],
      href: 'https://cube/api/v1/things/1/',
      links: [],
    }];
    const dicts: Dictionary[] = resource.resourceItems_mapToDicts(items);
    expect(dicts).toEqual([{ id: 1, name: 'x' }]);
  });

  it('builds null from a collection-less resource', () => {
    const resource: ChRISResource = new ChRISResource();
    expect(resource.resourceItems_buildFromCollection(null)).toBeNull();
  });
});

describe('resourceFields_get (module helper)', () => {
  it('extracts selected fields from a single resource', () => {
    const list: ListResource = listResource_make([{ id: 7, name: 'solo', extra: 'e' }]);
    expect(resourceFields_get(list, ['name'])).toEqual({ id: '7', name: 'solo' });
  });

  it('yields no record for a resource without items', () => {
    const list: ListResource = listResource_make([]);
    expect(resourceFields_get(list, ['name'])).toBeUndefined();
  });
});
