/**
 * @file ChRIS Resource Management
 *
 * This module defines the base class and interfaces for managing ChRIS resources.
 * It provides functionality for listing, filtering, and manipulating resource items.
 *
 * @module
 */

import {
  resource_isList,
  collectionItems_get,
  type Client,
  type ListResource,
  type Resource,
  type ItemResource,
} from "../chrisapi/adapter.js";
import { chrisConnection } from "../connect/chrisConnection.js";
import { connectionConfig } from "../config/config.js";
import { errorStack } from "../error/errorStack.js";

/**
 * The part of a collection+json document a page walk reads.
 */
interface CollectionPage {
  /** The page's items. */
  items?: unknown;
  /** The page's link relations; one of rel `next` says more follows. */
  links?: unknown;
}

/**
 * A simple record with string keys and unknown values.
 */
export interface SimpleRecord {
  [key: string]: unknown;
}

/**
 * Options for listing resources, including pagination.
 */
export interface ListOptions extends SimpleRecord {
  limit?: number;
  offset?: number;
}

/**
 * Represents an item in a resource collection.
 */
export interface Item {
  data: Array<{ name: string; value: unknown }>;
  href: string;
  links: Array<unknown>;
}

interface ResourcesFromOptions {
  resources: ListResource | Resource | null;
  options?: ListOptions | null;
}

/**
 * Contains items and the fields available for them.
 */
export interface ResourceFieldsPerItem {
  items: Item[];
  fields: string[];
}

/**
 * Contains resources, items, options, and selected fields.
 */
export interface ResourcesByFields extends ResourcesFromOptions {
  items: Item[] | null;
  fields: string[];
}

/**
 * Contains data filtered for table display and selected fields.
 */
export interface FilteredResourceData {
  tableData: Record<string, unknown>[];
  selectedFields: string[];
  /** Total count of items in the full collection (may exceed tableData.length when paginated). */
  totalCount?: number;
  /**
   * Set when the walk could not finish — a page the server refused, or a
   * bound the caller asked for and the collection exceeded. A listing that
   * is short must say so; a surface that renders `tableData` without
   * reading this is showing a page and calling it the answer.
   */
  incomplete?: {
    /** How many were gathered before it stopped. */
    gathered: number;
    /** Why it stopped, in words a surface can render. */
    reason: string;
  };
}

/**
 * A dictionary with string keys and primitive values.
 */
/**
 * How many records a page asks for.
 *
 * One number for every walk in this class: the paging loop and the bounded
 * default read the same constant, so a page size cannot drift between the
 * thing that walks and the thing that stops.
 */
const PAGE_SIZE: number = 100;

/**
 * A dictionary with string keys and primitive values.
 */
export interface Dictionary {
  [key: string]: string | number | boolean;
}

/**
 * Base class for managing ChRIS resources.
 */
export class ChRISResource {
  private _client: Client | null = null;
  private _resourceName: string = "";
  private _resourceCollection: ListResource | Resource | null = null;
  private _resourceArrayItems: Item[] | null = null;
  private _resourceArray: ItemResource[] | null | undefined = null;
  private _resourceItem: ItemResource | null = null;
  private resourceMethod: ((params: ListOptions) => Promise<ListResource | Resource>) | null = null;
  private _lazyMethodName: string | null = null;
  private _lazyObjProvider: (() => Promise<unknown>) | null = null;

  constructor() {
    // Client initialization is deferred
  }

  /**
   * Retrieves the ChRIS client instance asynchronously.
   * @returns A Promise resolving to the Client instance or null.
   */
  async client_get(): Promise<Client | null> {
    if (!this._client) {
      this._client = await chrisConnection.client_get();
    }
    return this._client;
  }

  get resourceName(): string {
    return this._resourceName;
  }

  set resourceName(name: string) {
    this._resourceName = name;
  }

  set resourceCollection(collection: ListResource | Resource) {
    this._resourceCollection = collection;
  }

  /**
   * Converts a resource item to a dictionary.
   * @param item - The item to convert.
   * @returns A dictionary representation of the item.
   */
  resourceItem_convertToDict(item: Item): Dictionary {
    return item.data.reduce((acc: Dictionary, { name, value }) => {
      acc[name] = value as string | number | boolean;
      return acc;
    }, {});
  }

  /**
   * Converts a list of resource items to dictionaries.
   * @param items - The list of items to convert.
   * @returns An array of dictionaries.
   */
  resourceItems_mapToDicts(items: Item[]): Dictionary[] {
    return items.map(this.resourceItem_convertToDict);
  }

  /**
   * Deletes a resource item by its ID.
   * @param id - The ID of the item to delete.
   * @returns A Promise resolving to true on success, false otherwise.
   */
  async resourceItem_delete(id: number): Promise<boolean> {
    if (!resource_isList(this._resourceCollection)) {
      errorStack.stack_push("error", `Cannot delete item ${id}: no list collection loaded.`);
      return false;
    }
    const res: ItemResource = this._resourceCollection?.getItem(id) as ItemResource;
    try {
      await res._delete();
      return true;
    } catch (e: unknown) {
      const msg: string = e instanceof Error ? e.message : String(e);
      errorStack.stack_push("error", `Failed to delete item ${id}: ${msg}`);
      return false;
    }
  }

  /**
   * Builds a list of items from a resource collection.
   * @param resources - The resource collection.
   * @returns An array of Items or null.
   */
  resourceItems_buildFromCollection(
    resources: ListResource | Resource | null
  ): Item[] | null {
    if (!resources || !resources.collection) {
      return null;
    }
    return collectionItems_get<Item>(resources).map((item: Item) => ({
      data: item.data,
      href: item.href,
      links: item.links,
    }));
  }

  /**
   * Binds a resource fetching method to an object.
   * @param obj - The object context.
   * @param resourceMethod - The method to bind.
   * @param resourceName - Optional name for the resource.
   */
  binding_applyGet(
    obj: unknown,
    resourceMethod: (params: ListOptions) => Promise<ListResource | Resource>,
    resourceName?: string
  ): void {
    // this._resourceObj = obj;
    this.resourceMethod = resourceMethod.bind(obj);
    if (resourceName) this._resourceName = resourceName;
  }

  /**
   * Binds a resource fetching method lazily.
   * @param objProvider - A function returning a Promise to the object context.
   * @param methodName - The name of the method to bind.
   * @param resourceName - Optional name for the resource.
   */
  binding_applyLazy(
    objProvider: () => Promise<unknown>,
    methodName: string,
    resourceName?: string
  ): void {
    this._lazyObjProvider = objProvider;
    this._lazyMethodName = methodName;
    if (resourceName) this._resourceName = resourceName;
  }

  private async lazyBinding_resolve(): Promise<void> {
    if (!this.resourceMethod && this._lazyObjProvider && this._lazyMethodName) {
      const obj: unknown = await this._lazyObjProvider();
      if (obj) {
        const method: unknown = (obj as Record<string, unknown>)[this._lazyMethodName];
        if (typeof method === 'function') {
            this.resourceMethod = method.bind(obj);
        } else {
            console.error(`Method ${this._lazyMethodName} not found on object.`);
        }
      }
    }
  }

  /**
   * What the page last fetched says about a page after it.
   *
   * The SDK derives this from the collection's `next` link and names it
   * `hasNextPage`. It was read here as `hasNext`, which the SDK does not
   * have, so the answer was always undefined and a walk could only guess
   * from the length of a page.
   *
   * @returns True when a `next` link is there, false when the page carries
   *   links and none is `next`, and null when it carries no links at all:
   *   such a page has said nothing either way, and the SDK's getter would
   *   fail on it.
   */
  private nextPage_read(): boolean | null {
    const page: ListResource | Resource | null = this._resourceCollection;
    if (!resource_isList(page)) return null;
    if (!Array.isArray((page.collection as CollectionPage | undefined)?.links)) return null;
    return page.hasNextPage;
  }

  /** Whether the server says another page follows the one last fetched; false when it does not say. */
  get hasNextPage(): boolean {
    return this.nextPage_read() === true;
  }

  /**
   * How many rows the server sent on the page last fetched, before any
   * filter applied on this side.
   *
   * @returns The count, or null when the page is not a list that says.
   */
  private rawCount_read(): number | null {
    const page: ListResource | Resource | null = this._resourceCollection;
    if (!resource_isList(page)) return null;
    const items: unknown = (page.collection as CollectionPage | undefined)?.items;
    return Array.isArray(items) ? items.length : null;
  }

  /**
   * Lists *all* resources by automatically handling pagination.
   *
   * The walk is steered by what the server sent, never by what was kept of
   * it. When the server refuses a query, the fetch is made again without
   * the filters and they are applied here, so a full page of a hundred may
   * keep three rows, or none: the page was still full, and the next one is
   * read. Each step moves on by the number of rows received, since a
   * server may send fewer than were asked for and still have more.
   *
   * @param options - Filtering options. Limit and offset will be managed internally.
   * @returns Every matching resource, or null when there is none. When the
   *   walk could not finish, the rows it has and `incomplete`.
   * @throws {Error} When the first page cannot be fetched, or the walk
   *   stalls with nothing gathered: neither is an empty collection.
   */
  async resources_getAll(
    options?: Partial<ListOptions>
  ): Promise<FilteredResourceData | null> {
    const limit: number = PAGE_SIZE;
    let offset: number = 0;
    let allTableData: Record<string, unknown>[] = [];
    let selectedFields: string[] = [];
    let stopped: string | null = null;

    while (true) {
      const pageOptions: Partial<ListOptions> = { ...options, limit, offset };
      let result: FilteredResourceData | null;
      // A fetch that yields nothing leaves the last page's collection in
      // place; cleared, what is read below is this page's or nobody's.
      this._resourceCollection = null;
      try {
        const asked: ListOptions | null = await this.resources_getList(pageOptions);
        if (this.collection_read() === null) break;
        result = this.resources_filterByFields(await this.resourceFields_get(asked));
      } catch (error: unknown) {
        // A walk that never started is a FAILED listing and stays a failure:
        // callers check for one. A walk that started and then hit a page the
        // server refused keeps its rows and says where it stopped — CUBE is
        // known to fail some queries beyond a certain offset, and a short
        // answer that reads as a complete one is the defect this fixes.
        if (allTableData.length === 0) throw error;
        stopped = error instanceof Error ? error.message : String(error);
        break;
      }

      if (result !== null && result.tableData) {
        if (selectedFields.length === 0) selectedFields = result.selectedFields;
        allTableData = allTableData.concat(result.tableData);
      }

      // What the server sent, whatever was kept of it. A page that is not a
      // list says nothing of the kind, and the kept rows stand in for it.
      const received: number = this.rawCount_read() ?? result?.tableData?.length ?? 0;
      const more: boolean | null = this.nextPage_read();

      if (received === 0) {
        if (more !== true) break;
        // No rows and "more follows": following it would ask for the same
        // offset for ever, and stopping here quietly would pass a short
        // listing off as a whole one.
        const stall: string = `${this._resourceName}: the server sent no rows at offset ${offset} and said that more follow`;
        errorStack.stack_push("warning", stall);
        if (allTableData.length === 0) throw new Error(stall);
        stopped = stall;
        break;
      }

      // The server's own word when it gives one; when it gives none, a page
      // shorter than was asked for is the last, as it always was.
      if (more === false) break;
      if (more === null && received < limit) break;

      offset += received;
    }

    if (allTableData.length === 0) {
      return null;
    }

    return {
      tableData: allTableData,
      selectedFields,
      totalCount: allTableData.length,
      ...(stopped === null ? {} : {
        incomplete: {
          gathered: allTableData.length,
          reason: `stopped after ${allTableData.length}: ${stopped}`,
        },
      }),
    };
  }

  /**
   * The collection the last fetch left, read after the fetch.
   *
   * A method, so the compiler does not carry what was assigned before the
   * fetch across the `await` that replaced it.
   *
   * @returns The collection, or null when the fetch left none.
   */
  private collection_read(): ListResource | Resource | null {
    return this._resourceCollection;
  }

  /**
   * Walks the whole collection and answers only when it has all of it.
   *
   * {@link resources_getAll} is forgiving, which suits a listing meant to be
   * shown: a page it cannot read ends the walk with the rows it has, a page
   * shorter than the bound is taken as the last, and an answer that is not
   * a list reads as "nothing here". An act that destroys on the strength of
   * a listing cannot use an answer like that. Here every page must be a
   * list that carries an array of items, the walk follows the server's own
   * word on whether more follows and never infers the end from a short
   * page, and anything else is an error.
   *
   * @param options - Filtering options. Limit and offset are managed here.
   * @returns Every row of the collection. `tableData` is empty, not absent,
   *   when the collection holds nothing.
   * @throws {Error} When a page could not be fetched, is not a list, carries
   *   no array of items or of links, or says that more follows and gives no
   *   rows.
   */
  async resources_getWhole(options?: Partial<ListOptions>): Promise<FilteredResourceData> {
    const tableData: Record<string, unknown>[] = [];
    let selectedFields: string[] = [];
    let offset: number = 0;
    for (;;) {
      // A fetch that yields nothing leaves the last page's collection in
      // place; cleared, such a fetch is seen for what it is.
      this._resourceCollection = null;
      const asked: ListOptions | null = await this.resources_getList({ ...options, limit: PAGE_SIZE, offset });
      const page: ListResource | Resource | null = this.collection_read();
      if (!resource_isList(page)) {
        throw new Error(`${this._resourceName}: the answer at offset ${offset} is not a list`);
      }
      const collection: CollectionPage | undefined = page.collection as CollectionPage | undefined;
      const items: unknown = collection?.items;
      if (!Array.isArray(items)) {
        throw new Error(`${this._resourceName}: the list at offset ${offset} carries no items`);
      }
      // Whether more follows is read from the page's links. A page without
      // them has not said that nothing follows.
      if (!Array.isArray(collection?.links)) {
        throw new Error(`${this._resourceName}: the list at offset ${offset} carries no links, so it does not say whether more follows`);
      }
      const rows: FilteredResourceData | null = this.resources_filterByFields(await this.resourceFields_get(asked));
      if (rows !== null && rows.tableData) {
        tableData.push(...rows.tableData);
        if (selectedFields.length === 0) selectedFields = rows.selectedFields;
      }
      if (!this.hasNextPage) break;
      if (items.length === 0) {
        throw new Error(`${this._resourceName}: more is said to follow offset ${offset}, and the page is empty`);
      }
      offset += items.length;
    }
    return { tableData, selectedFields, totalCount: tableData.length };
  }

  /**
   * Lists and filters resources based on options.
   * @param options - Filtering and listing options.
   * @returns A Promise resolving to filtered resource data or null.
   */
  async resources_listAndFilterByOptions(
    options?: Partial<ListOptions>
  ): Promise<FilteredResourceData | null> {
    // No limit named means the whole collection: walk it. A caller that
    // names one has asked a bounded question and gets exactly that page,
    // marked short when the collection is bigger than the bound — a listing
    // shows what is there, or says what it is not showing (#401).
    if (options?.limit === undefined) {
      return await this.resources_getAll(options);
    }
    const results: FilteredResourceData | null = this.resources_filterByFields(
      await this.resourceFields_get(await this.resources_getList(options))
    );
    if (results && resource_isList(this._resourceCollection)) {
      const total: number = this._resourceCollection.totalCount;
      if (total >= 0) results.totalCount = total;
      if (total > results.tableData.length) {
        results.incomplete = {
          gathered: results.tableData.length,
          reason: `showing ${results.tableData.length} of ${total} — the caller asked for ${options.limit}`,
        };
      }
    }
    return results;
  }

  /**
   * Filters resources by specific fields.
   * @param resourcesByFields - The resources and fields to filter.
   * @returns Filtered data suitable for table display.
   */
  resources_filterByFields(
    resourcesByFields: ResourcesByFields | null
  ): FilteredResourceData | null {
    if (!resourcesByFields) {
      return null;
    }
    const resources: Item[] | null = resourcesByFields.items;
    const selectedFields: string[] = resourcesByFields.fields;

    if (!resources) return null;

    const tableData: Record<string, unknown>[] = resources.map((resource) => {
      const rowData: Record<string, unknown> = {
        id: resource.href.split("/").slice(-2)[0],
      };
      resource.data.forEach((item) => {
        if (selectedFields.includes(item.name)) {
          rowData[item.name] = item.value;
        }
      });
      return rowData;
    });
    return { tableData, selectedFields };
  }

  resourcesByFields_enumerate(
    items: Item[] | null
  ): ResourceFieldsPerItem | null {
    if (!items || !items.length) {
      return null;
    }
    const allFields: string[] = ["id", ...items[0].data.map((item) => item.name)];
    const resourcesFieldsPerItem: ResourceFieldsPerItem = {
      items: items,
      fields: allFields,
    };
    return resourcesFieldsPerItem;
  }

  fieldSpec_resolve(
    fieldFilter?: string,
    options?: ListOptions | null
  ): string[] {
    let selectedFields: string[] = [];
    let fieldSpec: string = "";
    if (typeof options?.fields === "string") {
      fieldSpec = options.fields;
    } else if (fieldFilter) {
      fieldSpec = fieldFilter;
    }
    if (fieldSpec) {
      selectedFields = fieldSpec.split(",").map((f) => f.trim());
    }
    return selectedFields;
  }

  async resourceFields_get(
    options?: ListOptions | null,
    fields?: string
  ): Promise<ResourcesByFields | null> {
    if (!this._resourceCollection) {
      await this.resources_getList();
    }
    if (!this._resourceArrayItems) {
      return null;
    }
    let selectedFields: string[] = this.fieldSpec_resolve(fields, options);
    const resourcesFields: ResourceFieldsPerItem | null =
      this.resourcesByFields_enumerate(this._resourceArrayItems);
    if (!resourcesFields) {
      return null;
    }
    if (!selectedFields.length) {
      if (resourcesFields) {
        selectedFields = resourcesFields.fields;
      }
    }

    selectedFields = Array.from(new Set(selectedFields));

    const resourcesByFields: ResourcesByFields = {
      resources: this._resourceCollection,
      items: this._resourceArrayItems,
      options: options,
      fields: selectedFields,
    };
    return resourcesByFields;
  }

  async resources_getItems(
    options?: Partial<ListOptions>
  ): Promise<ItemResource[] | null> {
    const params: ListOptions = {
      limit: options?.limit ?? 20,
      offset: options?.offset ?? 0,
    };
    
    await this.lazyBinding_resolve();

    if (!this.resourceMethod) {
      return null;
    }
    // The collection just fetched, not the one a call before this left.
    const resources: ListResource | Resource | null = await this.resourceMethod(params);
    if (!resource_isList(resources)) {
      return null;
    }
    this._resourceArray = resources.getItems() as ItemResource[] | null;
    if (this._resourceArray) {
      // console.log(this._resourceArray);
      return this._resourceArray;
    }
    return null;
  }

  options_simplify(options: ListOptions): ListOptions {
    const params: ListOptions = {
      limit: options?.limit ?? 20,
      offset: options?.offset ?? 0,
    };
    return params;
  }

  private filtering_applyAdditional(originalParams: ListOptions): Item[] | null {
    if (!this._resourceArrayItems || this._resourceArrayItems.length === 0) {
      return null;
    }

    const filteredItems: Item[] = this._resourceArrayItems.filter((item) => {
      return Object.entries(originalParams).every(([paramKey, paramValue]) => {
        // Skip non-search related parameters
        if (["limit", "offset"].includes(paramKey)) {
          return true;
        }

        const dataItem: { name: string; value: unknown } | undefined = item.data.find((d) => d.name === paramKey);
        if (!dataItem) {
          return false; // If the field is not found, it doesn't match the filter
        }

        const itemValue: string = String(dataItem.value).toLowerCase();
        const searchValue: string = String(paramValue).toLowerCase();

        // Perform exact match for 'id', partial match for other fields
        if (paramKey === "id") {
          return itemValue === searchValue;
        } else {
          return itemValue.includes(searchValue);
        }
      });
    });

    return filteredItems.length > 0 ? filteredItems : null;
  }

  async resources_getList(
    options?: Partial<ListOptions>,
    resourceMethod?: (params: ListOptions) => Promise<ListResource | Resource>
  ): Promise<ListOptions | null> {
    // A caller that named no bound is asking for the collection, not for the
    // first twenty of it. The default that used to sit here answered a
    // different question than the one asked (#401), and said nothing about
    // the difference. `resources_getAll` pages explicitly and passes its own
    // limit, so it is unaffected.
    const params: ListOptions = {
      limit: PAGE_SIZE,
      offset: 0,
      ...options,
    };
    // Remove the "fields" otherwise some list resource ops break
    const { fields, ...pureparams }: ListOptions = params;
    let simplifiedParams: ListOptions = pureparams;
    if (resourceMethod) {
      this.resourceMethod = resourceMethod;
    }
    
    await this.lazyBinding_resolve();

    if (!this.resourceMethod) return params;
    let resources: ListResource | Resource | null = null;
    try {
      resources = await this.resourceMethod(pureparams);
    } catch (error: unknown) {
      if (connectionConfig && connectionConfig.debug) {
        console.error(`Error fetching ${this._resourceName}:`, error);
      }
      // Attempt simplified params as fallback
      try {
        simplifiedParams = this.options_simplify(pureparams);
        resources = await this.resourceMethod(simplifiedParams);
      } catch (retryError: unknown) {
        if (connectionConfig && connectionConfig.debug) {
          console.error(`Retry failed for ${this._resourceName}:`, retryError);
        }
        throw retryError; // Re-throw the error if retry fails
      }
    }
    if (resources == undefined || resources == null) {
      console.log(
        this._resourceName + " resource list returned 'undefined' or 'null'"
      );
      return params;
    }

    this._resourceCollection = resources;
    if (!resource_isList(this._resourceCollection)) {
      return null;
    }
    this._resourceArray = this._resourceCollection?.getItems() as ItemResource[] | null;
    this._resourceArrayItems =
      this.resourceItems_buildFromCollection(resources);
    if (Object.keys(pureparams).length > Object.keys(simplifiedParams).length) {
      const filteredItems: Item[] | null = this.filtering_applyAdditional(pureparams);
      if (filteredItems === null) {
        console.log("Warning: No items match the search criteria.");
      }
      this._resourceArrayItems = filteredItems;
    }

    return params;
  }
}

/**
 * Helper to get resource fields from a resource object.
 * @param obj - The resource object.
 * @param fields - The fields to extract.
 * @returns A SimpleRecord of fields or null.
 */
export function resourceFields_get(
  obj: Resource | ListResource,
  fields: string[]
): SimpleRecord | null {
  const chrisResource: ChRISResource = new ChRISResource();
  const item: Item[] | null =
    chrisResource.resourceItems_buildFromCollection(obj);
  const resourceData: FilteredResourceData | null =
    chrisResource.resources_filterByFields({
      resources: obj,
      items: item,
      fields: fields,
    });
  if (!resourceData) {
    return null;
  }
  return resourceData.tableData[0];
}