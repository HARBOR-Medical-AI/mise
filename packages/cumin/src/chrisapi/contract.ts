/**
 * @file Typed ChRIS API contract — domain-typed access to the hot wire surfaces.
 *
 * The adapter (`adapter.ts`) is the unsafe seam: the only module that imports
 * `@fnndsc/chrisapi` and the only one allowed to cast against it. This module
 * is the typed floor above that seam. It declares the wire shapes for the two
 * surfaces that have produced live defects (the jobs surface: plugin
 * instances, feeds; the PACS surface: download tokens, PACS files) and exposes
 * domain-typed accessors built purely on the adapter's generics. Downstream
 * packages call these instead of casting the opaque client per call site,
 * which is what this module exists to end.
 *
 * Key components:
 *   - ListPage<T>: normalized page shape (data + totalCount) for CUBE lists
 *   - FeedData / PluginInstanceData / InstanceParameterData: wire row shapes
 *   - feedsPage_get / publicFeedsPage_get / pluginInstancesPage_get: paged reads
 *   - pluginInstance_get: detail handle (data, parameters, status, logs, delete)
 *   - downloadToken_create: PACS/LONK download token
 *
 * Dependencies: only `adapter.ts`. This file must contain no unchecked double
 * casts and no `@fnndsc/chrisapi` import; the cast ratchet and the seam lint
 * enforce that shape.
 *
 * @module
 */

import {
  Client,
  FEED_LIST_TIMEOUT_MS,
  itemData_get,
  items_get,
  listData_get,
  method_exists,
  resource_call,
  resource_invoke,
  DATA_CARRIER_SHAPE,
  type DataCarrier,
  shape_nullable,
  shape_object,
  shape_build,
  type Shape,
} from './adapter';
import type { PipelineRecord } from '../pipelines/chrisPipeline';
import { pipelineResource_keep, pipelineResource_recall } from '../pipelines/pipelineMemo';

/**
 * One normalized page of a paginated CUBE list.
 *
 * @property data - The rows of this page, in server order.
 * @property totalCount - The collection's total row count when the server
 *   reported one, otherwise null. A null total means "unknown", not zero.
 * @property hasMore - Whether the server says further pages exist, when it
 *   says anything at all. Servers may serve fewer rows than the requested
 *   limit while more remain, so a walk must trust this over page fullness.
 * @property fetchedCount - Rows the server actually served for this page,
 *   when client-side normalization dropped some before `data` was built. A
 *   walk advances its offset by this, never by `data.length`, so a dropped
 *   row cannot cause refetching or a false end-of-collection.
 */
export interface ListPage<T> {
  data: T[];
  totalCount: number | null;
  hasMore?: boolean;
  fetchedCount?: number;
}

/**
 * Options controlling one paginated walk over a CUBE list.
 *
 * @property pageSize - Rows requested per page. Defaults to 100.
 * @property startOffset - Offset at which the walk begins. Defaults to 0; a
 *   resumed walk passes the offset its previous attempt had reached.
 * @property startTotal - Server total already latched by a previous attempt,
 *   or null when unknown. Defaults to null.
 */
export interface PageWalkOptions {
  pageSize?: number;
  startOffset?: number;
  startTotal?: number | null;
}

/**
 * One yielded step of a paginated walk.
 *
 * @property items - The rows of this page, in server order. May be empty on
 *   the final step.
 * @property offset - Offset at which this page was fetched.
 * @property total - The latched server total, or null while the server has
 *   not reported one. A null total means "unknown", not zero.
 */
export interface PageWalkStep<T> {
  items: T[];
  offset: number;
  total: number | null;
}

/**
 * Walks every page of a paginated CUBE list, yielding one step per page.
 *
 * This is the one pagination loop: it owns offset advancement, total
 * latching, and termination, so callers only consume rows. The walk ends
 * when a page comes back empty, when the latched total has been reached, or
 * when a short page arrives while the total is still unknown. Fetch errors
 * propagate to the caller; a resumed walk continues from `startOffset`.
 *
 * @param page_fetch - Fetches one page at the given offset and limit.
 * @param options - Page size and resume position. See PageWalkOptions.
 * @returns Async generator yielding a PageWalkStep per fetched page.
 *
 * @example
 * ```
 * for await (const step of listPages_walk((offset, limit) =>
 *   feedsPage_get(client, { limit, offset }))) {
 *   for (const feed of step.items) index.set(feed.id, feed);
 * }
 * ```
 */
export async function* listPages_walk<T>(
  page_fetch: (offset: number, limit: number) => Promise<ListPage<T>>,
  options: PageWalkOptions = {},
): AsyncGenerator<PageWalkStep<T>, void, void> {
  const pageSize: number = options.pageSize ?? 100;
  let offset: number = options.startOffset ?? 0;
  let total: number | null = options.startTotal ?? null;

  while (true) {
    const page: ListPage<T> = await page_fetch(offset, pageSize);
    const items: T[] = page.data;
    if (total === null && page.totalCount !== null) {
      total = page.totalCount;
    }
    // Offset arithmetic and termination count rows the server served, not
    // rows that survived normalization: a page whose rows were all dropped
    // client-side is still a served page, not the end of the collection.
    const advance: number = page.fetchedCount ?? items.length;
    yield { items, offset, total };
    if (advance === 0) return;
    if (page.hasMore === false) return;
    if (total !== null && offset + advance >= total) return;
    // A short page ends the walk only when the server gave no better signal:
    // a page can be shorter than the requested limit (server-side caps)
    // while hasMore says further pages exist.
    if (total === null && page.hasMore !== true && advance < pageSize) return;
    offset += advance;
  }
}

/**
 * Options for a windowed walk. See {@link listPages_walkWindowed}.
 *
 * @property pageSize - Rows requested per page. Defaults to 100.
 * @property inFlight - Pages fetched concurrently once the total is known.
 *   Defaults to 4.
 */
export interface WindowedPageWalkOptions {
  pageSize?: number;
  inFlight?: number;
}

/**
 * Walks every page of a paginated CUBE list with several pages in flight.
 *
 * The one pagination loop, windowed: the first page is fetched alone to
 * learn the server's total, and every further offset is then known, so up
 * to `inFlight` pages are fetched at once and yielded as each lands — in
 * completion order, which is why this walk suits a consumer that keys rows
 * by id and commits the whole set when it is done, and not one that reads
 * rows in server order or resumes from an offset. A server that reports no
 * total is walked one page at a time, exactly as {@link listPages_walk}
 * does. A fetch error ends the walk once the pages already in flight have
 * settled, and propagates.
 *
 * @param page_fetch - Fetches one page at the given offset and limit.
 * @param options - Page size and window width. See WindowedPageWalkOptions.
 * @returns Async generator yielding a PageWalkStep per fetched page.
 */
export async function* listPages_walkWindowed<T>(
  page_fetch: (offset: number, limit: number) => Promise<ListPage<T>>,
  options: WindowedPageWalkOptions = {},
): AsyncGenerator<PageWalkStep<T>, void, void> {
  const pageSize: number = options.pageSize ?? 100;
  const inFlight: number = Math.max(1, options.inFlight ?? 4);

  const first: ListPage<T> = await page_fetch(0, pageSize);
  const total: number | null = first.totalCount ?? null;
  const firstAdvance: number = first.fetchedCount ?? first.data.length;
  yield { items: first.data, offset: 0, total };
  if (firstAdvance === 0 || first.hasMore === false) return;
  if (total === null) {
    // No total, no window: the sequential loop owns termination from here.
    yield* listPages_walk(page_fetch, { pageSize, startOffset: firstAdvance, startTotal: null });
    return;
  }
  if (firstAdvance >= total) return;

  interface Landed { key: number; step: PageWalkStep<T>; }
  const flying: Map<number, Promise<Landed>> = new Map();
  let nextOffset: number = firstAdvance;
  let key: number = 0;
  let failure: unknown = null;

  const launch = (): void => {
    const offset: number = nextOffset;
    nextOffset += pageSize;
    const id: number = key++;
    flying.set(id, page_fetch(offset, pageSize).then((page: ListPage<T>): Landed => ({
      key: id,
      step: { items: page.data, offset, total },
    })));
  };

  while (flying.size > 0 || (failure === null && nextOffset < total)) {
    while (failure === null && nextOffset < total && flying.size < inFlight) launch();
    if (flying.size === 0) break;
    try {
      const landed: Landed = await Promise.race(flying.values());
      flying.delete(landed.key);
      yield landed.step;
    } catch (error: unknown) {
      // Remember the first failure, let the rest of the window settle, then throw.
      if (failure === null) failure = error;
      const settled: PromiseSettledResult<Landed>[] = await Promise.allSettled(flying.values());
      flying.clear();
      for (const result of settled) {
        if (result.status === 'fulfilled') yield result.value.step;
      }
    }
  }
  if (failure !== null) throw failure;
}

/**
 * Drains every page of a paginated CUBE list into one array.
 *
 * Convenience over listPages_walk for callers that need the complete
 * collection and nothing per-page. The single-shot `{ limit: 1000 }` idiom
 * this replaces silently truncated collections past its guess; the drain
 * walks to the actual end.
 *
 * @param page_fetch - Fetches one page at the given offset and limit.
 * @param options - Page size and resume position. See PageWalkOptions.
 * @returns Every row of the collection, in server order.
 */
export async function listPages_drain<T>(
  page_fetch: (offset: number, limit: number) => Promise<ListPage<T>>,
  options: PageWalkOptions = {},
): Promise<T[]> {
  const rows: T[] = [];
  for await (const step of listPages_walk(page_fetch, options)) {
    rows.push(...step.items);
  }
  return rows;
}

/**
 * Wire shape of one CUBE feed row, as served by the feeds list endpoints.
 *
 * @property id - Feed id.
 * @property name - Feed title.
 * @property owner_username - Owning user, when serialized.
 * @property public - Public visibility flag.
 * @property creation_date - ISO creation timestamp.
 * @property finished_jobs - Count of jobs finished successfully.
 * @property errored_jobs - Count of jobs finished with error.
 * @property started_jobs - Count of running jobs.
 * @property scheduled_jobs - Count of scheduled jobs.
 * @property cancelled_jobs - Count of cancelled jobs.
 * @property created_jobs - Count of created (not yet scheduled) jobs.
 */
export interface FeedData {
  id: number;
  name: string;
  owner_username?: string;
  public?: boolean;
  creation_date?: string;
  finished_jobs?: number;
  errored_jobs?: number;
  started_jobs?: number;
  scheduled_jobs?: number;
  cancelled_jobs?: number;
  created_jobs?: number;
  [key: string]: unknown;
}

/**
 * Wire shape of one CUBE plugin-instance row.
 *
 * @property id - Instance id.
 * @property feed_id - Owning feed id.
 * @property previous_id - Parent instance id, or null for a feed root.
 * @property plugin_name - Name of the plugin this instance runs.
 * @property plugin_type - Plugin type (`fs`, `ds`, `ts`), when serialized.
 * @property status - Current job status string.
 * @property output_path - CFS output directory, once CUBE records one.
 * @property raw - Base64 zlib-compressed pfcon response, when present.
 */
export interface PluginInstanceData {
  id: number;
  feed_id: number;
  previous_id?: number | null;
  plugin_name: string;
  plugin_type?: string;
  status?: string;
  output_path?: string;
  /** ISO timestamp CUBE recorded for execution start. */
  start_date?: string;
  /** ISO timestamp CUBE recorded for execution end. */
  end_date?: string;
  /** Output size in bytes, as CUBE reports it on the list row. */
  size?: number;
  /** The compute resource the instance ran on, as CUBE reports it. */
  compute_resource_name?: string;
  raw?: string;
  [key: string]: unknown;
}

/**
 * One resolved parameter value recorded on a plugin instance.
 *
 * @property param_name - The parameter's flag name.
 * @property value - The recorded invocation value.
 */
export interface InstanceParameterData {
  param_name?: string;
  value?: unknown;
}

/**
 * A CUBE file-download token, used for authenticated downloads and the LONK
 * WebSocket.
 *
 * @property token - The token string.
 * @property url - REST URL of the token resource (its origin hosts the LONK
 *   WebSocket endpoint).
 */
export interface DownloadToken {
  token: string;
  url: string;
}

/**
 * Typed handle over one plugin-instance detail resource.
 *
 * Wraps the live chrisapi resource so callers can read its payload and drive
 * its lifecycle without touching the unsafe object.
 *
 * @property data - The instance's wire payload, or null when the resource
 *   carries none (the sub-resources and lifecycle methods still work).
 */
export interface PluginInstanceHandle {
  data: PluginInstanceData | null;
  /**
   * Reads one page of the instance's effective parameter values.
   *
   * @param params - Page window (limit, offset).
   * @returns The page of recorded parameter values.
   */
  parametersPage_get(params: { limit: number; offset: number }): Promise<ListPage<InstanceParameterData>>;
  /**
   * Writes a new status to the instance (e.g. `cancelled`).
   *
   * @param status - The status string to PUT.
   */
  status_set(status: string): Promise<void>;
  /** Deletes the instance record from CUBE. */
  delete(): Promise<void>;
  /**
   * Fetches the instance's log text via its logs sub-resource.
   *
   * @returns The joined log text, or null when this instance's resource does
   *   not expose logs.
   */
  logs_get(): Promise<string | null>;
}

/** Loose wire shape of a chrisapi list response (data + optional total). */
interface WirePage {
  data?: unknown;
  totalCount?: unknown;
  getItems?: unknown;
}

/**
 * A page as CUBE serves one, or nothing. Each thing read off a page (its
 * rows, its count, its items) is looked at before it is used, so the page
 * itself is held only to being an object; a call that answers nothing is
 * an empty page, as it has always been.
 */
const WIRE_PAGE_SHAPE: Shape<WirePage | null> = shape_nullable(shape_object<WirePage>('a page'));

/** A resource that may carry data, or nothing: a lookup by id answers nothing when there is none. */
const DATA_CARRIER_OR_NONE_SHAPE: Shape<DataCarrier | null> = shape_nullable(DATA_CARRIER_SHAPE);

/** A feed in a listing: its id is a number and its name text; everything else is read through a conversion. */
const FEED_DATA_SHAPE: Shape<FeedData> = shape_build<FeedData>('a feed')(['id', 'number'], ['name', 'string']);

/**
 * A plugin instance as this contract hands it on. Those it is handed to read
 * each field through a conversion, a default or a check of their own (its
 * id through `Number`, its status through `?? ''`, its output path through
 * `?.`), so nothing in it is read unchecked and it is held only to being an
 * object.
 */
const PLUGIN_INSTANCE_DATA_SHAPE: Shape<PluginInstanceData> = shape_object<PluginInstanceData>('a plugin instance');

/** A parameter set on a plugin instance: its name and value are read through checks of their own. */
const INSTANCE_PARAMETER_SHAPE: Shape<InstanceParameterData> = shape_object<InstanceParameterData>('a plugin instance parameter');

/** A row of a plugin instance's log. */
interface LogRow {
  /** The row's text; looked at before it is used. */
  log?: unknown;
}

/** A row of a plugin instance's log: an object, its text looked at before it is used. */
const LOG_ROW_SHAPE: Shape<LogRow> = shape_object<LogRow>('a log row');

/** A pipeline source file: its file name is joined into a path as text. */
const PIPELINE_SOURCE_FILE_DATA_SHAPE: Shape<PipelineSourceFileData> = shape_build<PipelineSourceFileData>('a pipeline source file')(['fname', 'string']);

/** A piping of a pipeline: its id is a number (a key, an argument). */
const PLUGIN_PIPING_DATA_SHAPE: Shape<PluginPipingData> = shape_build<PluginPipingData>('a plugin piping')(['id', 'number']);

/** A default parameter of a piping: the piping's id is a number when it is given. */
const PIPING_DEFAULT_PARAMETER_SHAPE: Shape<PipingDefaultParameterData> = shape_build<PipingDefaultParameterData>('a piping default parameter')(['plugin_piping_id', 'number?']);

/** A parameter a plugin declares: its name is text. */
const PLUGIN_PARAMETER_SHAPE: Shape<PluginParameterData> = shape_build<PluginParameterData>('a plugin parameter')(['name', 'string']);

/** A compute resource a plugin runs on: its name is read through a check of its own. */
const COMPUTE_RESOURCE_DATA_SHAPE: Shape<ComputeResourceData> = shape_object<ComputeResourceData>('a compute resource');

/** A plugin: each of its fields is read through a check or a default. */
const PLUGIN_DATA_SHAPE: Shape<PluginData> = shape_object<PluginData>('a plugin');

/** A plugin resource fetched from a piping, or nothing: its parameters and compute resources are fetched by calls that check the method is there. */
const PLUGIN_RESOURCE_OR_NONE_SHAPE: Shape<object | null> = shape_nullable(shape_object<object>('a plugin'));

/**
 * A pipeline's own record: its id is a number and its name text. (The same
 * fields as the pipelines module holds a pipeline to; said again here
 * because that module is built on this one.)
 */
const PIPELINE_DATA_SHAPE: Shape<PipelineRecord> = shape_build<PipelineRecord>('a pipeline')(['id', 'number'], ['name', 'string']);

/** A download token's resource. */
interface DownloadTokenResource {
  /** The token's data; read through a shape of its own. */
  data?: unknown;
  /** The address the token is used at; read through a conversion. */
  url?: unknown;
}

/** A download token's data. */
interface DownloadTokenData {
  /** The token; read through a conversion. */
  token?: unknown;
}

/** A download token's resource: an object, its address read through a conversion. */
const DOWNLOAD_TOKEN_RESOURCE_SHAPE: Shape<DownloadTokenResource> = shape_object<DownloadTokenResource>('a download token');

/** A download token's data: an object, the token read through a conversion. */
const DOWNLOAD_TOKEN_SHAPE: Shape<DownloadTokenData> = shape_object<DownloadTokenData>('a download token');

/**
 * Normalizes a raw chrisapi list response into a typed ListPage.
 *
 * @param shape - The shape of a row.
 * @param page - The raw list resource (or null/undefined).
 * @returns The typed page; totalCount is null when the server sent none.
 */
function listPage_wrap<T>(shape: Shape<T>, page: WirePage | null | undefined): ListPage<T> {
  const total: unknown = page?.totalCount;
  return {
    data: listData_get(page ?? undefined, shape),
    totalCount: typeof total === 'number' && total >= 0 ? total : null,
  };
}

/**
 * Reads one page of the session user's feeds (owned and shared).
 *
 * @param client - Connected chrisapi client.
 * @param params - CUBE search/pagination params (limit, offset, id, ...).
 * @returns The typed feed page.
 * @throws {Error} Propagates chrisapi/network errors.
 */
export async function feedsPage_get(
  client: Client,
  params: Record<string, unknown>,
): Promise<ListPage<FeedData>> {
  return listPage_wrap(FEED_DATA_SHAPE, await resource_call(client, WIRE_PAGE_SHAPE, 'getFeeds', params, FEED_LIST_TIMEOUT_MS));
}

/**
 * Reads one page of public feeds, when the connected CUBE offers them.
 *
 * @param client - Connected chrisapi client.
 * @param params - CUBE search/pagination params.
 * @returns The typed feed page, or null when the client has no public-feeds
 *   endpoint (older CUBE versions).
 * @throws {Error} Propagates chrisapi/network errors.
 */
export async function publicFeedsPage_get(
  client: Client,
  params: Record<string, unknown>,
): Promise<ListPage<FeedData> | null> {
  if (!method_exists(client, 'getPublicFeeds')) return null;
  return listPage_wrap(FEED_DATA_SHAPE, await resource_call(client, WIRE_PAGE_SHAPE, 'getPublicFeeds', params, FEED_LIST_TIMEOUT_MS));
}

/**
 * Reads one page of plugin instances, optionally filtered.
 *
 * @param client - Connected chrisapi client.
 * @param params - CUBE search/pagination params (feed_id, id, plugin_name, ...).
 * @returns The typed instance page.
 * @throws {Error} Propagates chrisapi/network errors.
 */
export async function pluginInstancesPage_get(
  client: Client,
  params: Record<string, unknown>,
): Promise<ListPage<PluginInstanceData>> {
  return listPage_wrap(PLUGIN_INSTANCE_DATA_SHAPE, await resource_call(client, WIRE_PAGE_SHAPE, 'getPluginInstances', params),
  );
}

/**
 * Fetches one plugin instance's detail resource as a typed handle.
 *
 * @param client - Connected chrisapi client.
 * @param instanceID - The plugin instance id.
 * @returns The typed handle, or null when CUBE returns no such instance.
 * @throws {Error} Propagates chrisapi/network errors.
 */
export async function pluginInstance_get(
  client: Client,
  instanceID: number,
): Promise<PluginInstanceHandle | null> {
  const resource: { data?: unknown } | null = await resource_call(
    client,
    DATA_CARRIER_OR_NONE_SHAPE,
    'getPluginInstance',
    instanceID,
  );
  if (!resource) return null;
  const data: PluginInstanceData | null = itemData_get(resource, PLUGIN_INSTANCE_DATA_SHAPE);

  return {
    data,

    async parametersPage_get(
      params: { limit: number; offset: number },
    ): Promise<ListPage<InstanceParameterData>> {
      // Some chrisapi versions serve rows in `data`, others only via getItems().
      return listPageFlexible_wrap(INSTANCE_PARAMETER_SHAPE, await resource_call(resource, WIRE_PAGE_SHAPE, 'getParameters', params),
      );
    },

    async status_set(status: string): Promise<void> {
      await resource_invoke(resource, 'put', { status });
    },

    async delete(): Promise<void> {
      await resource_invoke(resource, 'delete');
    },

    async logs_get(): Promise<string | null> {
      if (!method_exists(resource, 'getLogs')) return null;
      const logs: { data?: unknown } = await resource_call(resource, DATA_CARRIER_SHAPE, 'getLogs');
      const rows: Array<{ log?: unknown }> = listData_get(logs, LOG_ROW_SHAPE);
      return rows.map((row: { log?: unknown }): string => (typeof row.log === 'string' ? row.log : '')).join('\n');
    },
  };
}

/**
 * Wire shape of one registered pipeline source file row.
 *
 * @property fname - CFS path of the uploaded pipeline source.
 * @property pipeline_name - Name of the pipeline it registered.
 * @property pipeline_id - Id of the pipeline it registered.
 */
export interface PipelineSourceFileData {
  fname: string;
  pipeline_name?: string;
  pipeline_id?: number;
  [key: string]: unknown;
}

/**
 * Wire shape of one plugin piping row in a registered pipeline.
 *
 * @property id - Piping id.
 * @property title - Piping title, when authored.
 * @property plugin_name - Name of the plugin this piping runs.
 * @property plugin_version - Version of that plugin.
 * @property previous_id - Parent piping id, or null for the root.
 */
export interface PluginPipingData {
  id: number;
  title?: string;
  plugin_name?: string;
  plugin_version?: string;
  previous_id?: number | null;
  [key: string]: unknown;
}

/**
 * Wire shape of one stored piping default-parameter row.
 *
 * @property plugin_piping_id - Piping the default belongs to.
 * @property param_name - The parameter's flag name.
 * @property value - The stored default value.
 */
export interface PipingDefaultParameterData {
  plugin_piping_id?: number;
  param_name?: string;
  value?: unknown;
  [key: string]: unknown;
}

/**
 * Wire shape of one plugin parameter definition row.
 *
 * @property name - The parameter's flag name.
 * @property type - Declared value type (e.g. "string").
 * @property optional - Whether the parameter may be omitted.
 * @property default - Declared default value.
 * @property help - Author-provided help text.
 */
export interface PluginParameterData {
  name: string;
  type?: string;
  optional?: boolean;
  default?: unknown;
  help?: string;
  [key: string]: unknown;
}

/**
 * Wire shape of one compute-resource row attached to a plugin.
 *
 * @property name - The compute environment's name.
 */
export interface ComputeResourceData {
  name?: string;
  [key: string]: unknown;
}

/**
 * Wire shape of one registered plugin row, as served by `getPlugins`.
 *
 * @property id - Plugin id.
 * @property name - The plugin's registered name (`pl-dcm2niix`).
 * @property version - Its registered version.
 * @property type - `ds`, `fs` or `ts`: what the node consumes and produces.
 * @property title - The human title, when the plugin declared one.
 * @property authors - Declared authorship.
 * @property description - What the plugin does.
 * @property documentation - Where its source or docs live.
 * @property category - The plugin's declared category.
 * @property creation_date - ISO registration timestamp.
 */
export interface PluginData {
  id?: number;
  name?: string;
  version?: string;
  type?: string;
  title?: string;
  authors?: string;
  description?: string;
  documentation?: string;
  category?: string;
  creation_date?: string;
  [key: string]: unknown;
}

/**
 * Typed handle over one plugin detail resource (metadata surfaces only).
 */
export interface PluginHandle {
  /**
   * Reads one page of the plugin's declared parameters.
   *
   * @param params - Page window (limit, offset).
   * @returns The page of parameter definitions.
   */
  parametersPage_get(params: Record<string, unknown>): Promise<ListPage<PluginParameterData>>;
  /**
   * Reads one page of the plugin's registered compute resources.
   *
   * @param params - Page window (limit, offset).
   * @returns The page of compute-resource rows.
   */
  computeResourcesPage_get(params: Record<string, unknown>): Promise<ListPage<ComputeResourceData>>;
}

/**
 * One plugin piping of a registered pipeline, with its plugin reachable.
 *
 * @property data - The piping's wire payload.
 */
export interface PluginPipingItem {
  data: PluginPipingData;
  /**
   * Fetches the plugin this piping runs, when the item links one.
   *
   * @returns The plugin handle, or null when the item exposes no plugin link.
   */
  plugin_get(): Promise<PluginHandle | null>;
}

/**
 * Typed handle over one registered pipeline resource.
 *
 * @property data - The pipeline's wire payload, or null when absent.
 */
export interface PipelineHandle {
  data: PipelineRecord | null;
  /**
   * Reads the pipeline's plugin pipings as items (plugin link preserved).
   *
   * @param params - Page window (limit, offset).
   * @returns The piping items of that page.
   */
  pluginPipings_get(params: Record<string, unknown>): Promise<PluginPipingItem[]>;
  /**
   * Reads one page of the pipeline's plugin pipings with its pagination
   * signals intact, so a paginated walk can advance correctly even when a
   * served row carries no data and is dropped from the items.
   *
   * @param params - Page window (limit, offset).
   * @returns The typed page; fetchedCount reflects rows served.
   */
  pluginPipingsPage_get(params: Record<string, unknown>): Promise<ListPage<PluginPipingItem>>;
  /**
   * Reads one page of the stored piping default parameters.
   *
   * @param params - Page window (limit, offset).
   * @returns The page of stored defaults.
   */
  defaultParametersPage_get(params: Record<string, unknown>): Promise<ListPage<PipingDefaultParameterData>>;
}

/**
 * Normalizes a chrisapi list response that may serve rows in `data` or only
 * via `getItems()` into a typed ListPage.
 *
 * @param shape - The shape of a row.
 * @param page - The raw list resource.
 * @returns The typed page; totalCount is null when the server sent none.
 */
function listPageFlexible_wrap<T>(shape: Shape<T>, page: WirePage | null | undefined): ListPage<T> {
  if (Array.isArray(page?.data) || typeof page?.getItems !== 'function') {
    return listPage_wrap(shape, page);
  }
  const served: Array<{ data?: unknown }> = items_get(page, DATA_CARRIER_SHAPE);
  const rows: T[] = served
    .map((item: { data?: unknown }): T | null => itemData_get(item, shape))
    .filter((row: T | null): row is T => row !== null);
  const total: unknown = page?.totalCount;
  return {
    data: rows,
    totalCount: typeof total === 'number' && total >= 0 ? total : null,
    fetchedCount: served.length,
  };
}

/**
 * Wraps one page of a chrisapi collection resource as a typed ListPage.
 *
 * The collection carries the pagination signals (`totalCount`,
 * `hasNextPage`) as typed getters; the caller extracts the rows in whatever
 * shape it needs (data records or item resources) and passes both here.
 *
 * @param collection - The chrisapi list resource the page came from.
 * @param rows - The page's rows, already extracted by the caller.
 * @returns The typed page; totalCount is null when the server sent none.
 */
export function collectionPage_wrap<T>(
  collection: { totalCount: number; hasNextPage: boolean },
  rows: T[],
): ListPage<T> {
  return {
    data: rows,
    totalCount: collection.totalCount >= 0 ? collection.totalCount : null,
    hasMore: collection.hasNextPage,
  };
}

/**
 * Wraps a plugin detail resource as a typed metadata handle.
 *
 * @param resource - The chrisapi plugin resource.
 * @returns The typed handle.
 */
function pluginHandle_wrap(resource: object): PluginHandle {
  return {
    async parametersPage_get(params: Record<string, unknown>): Promise<ListPage<PluginParameterData>> {
      return listPageFlexible_wrap(PLUGIN_PARAMETER_SHAPE, await resource_call(resource, WIRE_PAGE_SHAPE, 'getPluginParameters', params),
      );
    },
    async computeResourcesPage_get(params: Record<string, unknown>): Promise<ListPage<ComputeResourceData>> {
      return listPageFlexible_wrap(COMPUTE_RESOURCE_DATA_SHAPE, await resource_call(resource, WIRE_PAGE_SHAPE, 'getPluginComputeResources', params),
      );
    },
  };
}

/**
 * One registered plugin resolved from CUBE: its row, and a handle onto the
 * sub-collections that hang off it.
 *
 * @property data - The plugin's wire payload.
 * @property handle - Typed access to its parameters and compute resources.
 */
export interface PluginFound {
  data: PluginData;
  handle: PluginHandle;
}

/**
 * Fetches one page of the plugins registered in the connected CUBE.
 *
 * @param client - Connected chrisapi client.
 * @param params - Page window and search filters (limit, offset, name_exact…).
 * @returns The page of plugin rows.
 * @throws {Error} Propagates chrisapi/network errors.
 */
export async function pluginsPage_get(
  client: Client,
  params: Record<string, unknown>,
): Promise<ListPage<PluginData>> {
  return listPage_wrap(PLUGIN_DATA_SHAPE, await resource_call(client, WIRE_PAGE_SHAPE, 'getPlugins', params));
}

/**
 * Fetches one registered plugin by exact name and version.
 *
 * @param client - Connected chrisapi client.
 * @param name - Exact plugin name.
 * @param version - Exact plugin version.
 * @returns The plugin and a handle onto it, or null when CUBE has no such
 *   plugin at that version.
 * @throws {Error} Propagates chrisapi/network errors.
 */
export async function plugin_find(
  client: Client,
  name: string,
  version: string,
): Promise<PluginFound | null> {
  const page: WirePage | null = await resource_call(client, WIRE_PAGE_SHAPE, 'getPlugins', {
    name_exact: name,
    version,
    limit: 1,
  });
  const resources: Array<{ data?: unknown }> =
    typeof page?.getItems === 'function'
      ? items_get(page, DATA_CARRIER_SHAPE)
      : [];
  const resource: { data?: unknown } | undefined = resources[0];
  if (resource === undefined) return null;
  const data: PluginData | null = itemData_get(resource, PLUGIN_DATA_SHAPE);
  if (data === null) return null;
  return { data, handle: pluginHandle_wrap(resource) };
}

/**
 * Reads every parameter a plugin declares, to exhaustion.
 *
 * A plugin's parameter list is the one collection a surface cannot ask
 * twice about: a form built from a truncated list silently omits flags the
 * plugin requires. The single-page `{ limit: 100 }` idiom this replaces lost
 * the tail of any plugin with more, and said nothing.
 *
 * @param handle - A plugin handle.
 * @returns Every declared parameter, in server order.
 * @throws {Error} Propagates chrisapi/network errors.
 */
export async function pluginParameters_drain(
  handle: PluginHandle,
): Promise<PluginParameterData[]> {
  return listPages_drain<PluginParameterData>(
    (offset: number, limit: number): Promise<ListPage<PluginParameterData>> =>
      handle.parametersPage_get({ limit, offset }),
  );
}

/**
 * Fetches one registered pipeline's detail resource as a typed handle.
 *
 * @param client - Connected chrisapi client.
 * @param pipelineID - The pipeline id.
 * @returns The typed handle, or null when CUBE returns no such pipeline.
 * @throws {Error} Propagates chrisapi/network errors.
 */
export async function pipeline_get(
  client: Client,
  pipelineID: number,
): Promise<PipelineHandle | null> {
  // The item a search or an earlier get served answers first: chrisapi's
  // getPipeline is a list-by-id, and the pipings hang off the item either way.
  const kept: object | null = pipelineResource_recall(client, pipelineID);
  const resource: { data?: unknown } | null = kept !== null
    ? (kept as { data?: unknown })
    : await resource_call(client, DATA_CARRIER_OR_NONE_SHAPE, 'getPipeline', pipelineID);
  if (!resource) return null;
  if (kept === null) pipelineResource_keep(client, pipelineID, resource);

  const pipingsPage_get = async (params: Record<string, unknown>): Promise<ListPage<PluginPipingItem>> => {
    const page: WirePage | null = await resource_call(resource, WIRE_PAGE_SHAPE, 'getPluginPipings', params);
    const rawItems: Array<{ data?: unknown }> =
      typeof page?.getItems === 'function'
        ? items_get(page, DATA_CARRIER_SHAPE)
        : listData_get(page, PLUGIN_PIPING_DATA_SHAPE).map((row: PluginPipingData): { data?: unknown } => ({ data: row }));
    const pipings: PluginPipingItem[] = rawItems
      .map((item: { data?: unknown }): PluginPipingItem | null => {
        const data: PluginPipingData | null = itemData_get(item, PLUGIN_PIPING_DATA_SHAPE);
        if (!data) return null;
        return {
          data,
          async plugin_get(): Promise<PluginHandle | null> {
            if (!method_exists(item, 'getPlugin')) return null;
            const plugin: object | null = await resource_call(item, PLUGIN_RESOURCE_OR_NONE_SHAPE, 'getPlugin');
            return plugin ? pluginHandle_wrap(plugin) : null;
          },
        };
      })
      .filter((item: PluginPipingItem | null): item is PluginPipingItem => item !== null);
    const total: unknown = page?.totalCount;
    return {
      data: pipings,
      totalCount: typeof total === 'number' && total >= 0 ? total : null,
      fetchedCount: rawItems.length,
    };
  };

  return {
    data: itemData_get(resource, PIPELINE_DATA_SHAPE),

    pluginPipingsPage_get: pipingsPage_get,

    async pluginPipings_get(params: Record<string, unknown>): Promise<PluginPipingItem[]> {
      return (await pipingsPage_get(params)).data;
    },

    async defaultParametersPage_get(
      params: Record<string, unknown>,
    ): Promise<ListPage<PipingDefaultParameterData>> {
      return listPageFlexible_wrap(PIPING_DEFAULT_PARAMETER_SHAPE, await resource_call(resource, WIRE_PAGE_SHAPE, 'getDefaultParameters', params),
      );
    },
  };
}

/**
 * Reads one page of registered pipeline source files.
 *
 * @param client - Connected chrisapi client.
 * @param params - CUBE search/pagination params (pipeline_id, limit, ...).
 * @returns The typed source-file page.
 * @throws {Error} Propagates chrisapi/network errors.
 */
export async function pipelineSourceFilesPage_get(
  client: Client,
  params: Record<string, unknown>,
): Promise<ListPage<PipelineSourceFileData>> {
  return listPageFlexible_wrap(PIPELINE_SOURCE_FILE_DATA_SHAPE, await resource_call(client, WIRE_PAGE_SHAPE, 'getPipelineSourceFiles', params),
  );
}

/**
 * Drains every pipeline source file matching a filter.
 *
 * The registered pipelines' source files are a collection, not a page: a
 * caller asking which file a pipeline came from wants the answer, and
 * `{ limit: 1000 }` was a guess at how many that could be (#401).
 *
 * @param client - Connected chrisapi client.
 * @param filter - Server-side filter (a `pipeline_id`, an `fname`), or none.
 * @returns Every matching source file, in server order.
 * @throws {Error} Propagates chrisapi/network errors.
 */
export async function pipelineSourceFiles_drain(
  client: Client,
  filter: Record<string, unknown> = {},
): Promise<PipelineSourceFileData[]> {
  return listPages_drain<PipelineSourceFileData>(
    (offset: number, limit: number): Promise<ListPage<PipelineSourceFileData>> =>
      pipelineSourceFilesPage_get(client, { ...filter, limit, offset }),
  );
}

/**
 * Creates a CUBE download token for authenticated file access and LONK.
 *
 * @param client - Connected chrisapi client.
 * @returns The token string and the token resource's REST URL.
 * @throws {Error} Propagates chrisapi/network errors.
 */
export async function downloadToken_create(client: Client): Promise<DownloadToken> {
  const resource: { data?: unknown; url?: unknown } =
    await resource_call(client, DOWNLOAD_TOKEN_RESOURCE_SHAPE, 'createDownloadToken');
  const data: { token?: unknown } | null = itemData_get(resource, DOWNLOAD_TOKEN_SHAPE);
  return {
    token: String(data?.token ?? ''),
    url: String(resource?.url ?? ''),
  };
}
