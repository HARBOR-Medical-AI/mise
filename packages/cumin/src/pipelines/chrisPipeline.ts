/**
 * @file ChRIS Pipeline and Workflow operations.
 *
 * Provides functions to list registered pipelines, resolve them by name or ID,
 * and create workflow instances (the runtime execution of a pipeline on a feed node).
 *
 * Terminology:
 *   Pipeline  — the registered DAG template in CUBE
 *   Workflow  — a pipeline instantiated on a specific plugin instance node
 *
 * @module
 */

import { chrisConnection } from "../connect/chrisConnection.js";
import { DATA_CARRIER_SHAPE, itemData_get, items_get, listData_get, resource_call, type Client, type DataCarrier, shape_nullable, shape_object, shape_build, type Shape } from "../chrisapi/adapter.js";
import { pipelineRecord_keep, pipelineRecord_recall, pipelineResource_keep } from "./pipelineMemo.js";
import { listPages_drain, type ListPage } from "../chrisapi/contract.js";
import { ChRISResourceGroup } from "../resources/chrisResourceGroup.js";
import { errorStack } from "../error/errorStack.js";
import { Result, Ok, Err } from "../utils/result.js";

/** Optional name filter for pipeline list queries. */
interface PipelineSearchParams {
  name?: string;
  [key: string]: unknown;
}

/** Slice of a pipeline source file item as returned by the API. */
interface PipelineSourceFileItem {
  data: { fname: string; pipeline_name?: string };
}

/** Slice of a list resource that only exposes its items. */
interface ItemListSlice {
  getItems: () => unknown[];
  hasNextPage?: boolean;
}

/** Record slice carrying just a numeric id. */
interface IdRecord {
  id: number;
}

/** A record whose id is used as a number. */
const ID_SHAPE: Shape<IdRecord> = shape_build<IdRecord>('a record')(['id', 'number']);

/** A record whose id is looked at before it is used: nothing in it is read unchecked. */
const ID_SEEN_SHAPE: Shape<IdRecord> = shape_object<IdRecord>('a record');

/** A list item that carries a record with an id. */
interface IdItem {
  /** The record. */
  data: IdRecord;
}

/** A list item whose data's id is used as a number. */
const ID_ITEM_SHAPE: Shape<IdItem> = shape_build<IdItem>('a list item')(['data', ID_SHAPE]);

/** A list resource read for its items: they are fetched by calling it; whether there is a next page is read when it says. */
const ITEM_LIST_SLICE_SHAPE: Shape<ItemListSlice> = shape_build<ItemListSlice>('a list')(['getItems', 'function'], ['hasNextPage', 'boolean?']);

/** A pipeline source file in a list: its file name is split as text, and its pipeline's name read as text when there. */
const SOURCE_FILE_ITEM_SHAPE: Shape<PipelineSourceFileItem> = shape_build<PipelineSourceFileItem>('a pipeline source file')(
  ['data', shape_build<PipelineSourceFileItem['data']>('a pipeline source file')(['fname', 'string'], ['pipeline_name', 'string?'])],
);

/** A page of pipelines: its items are fetched by calling it, and its rows read from its data. */
interface PipelinePage {
  /** Fetches the page's items. */
  getItems: () => unknown;
  /** The page's rows; read through a shape of their own. */
  data?: unknown;
}

/** A page of pipelines as searched by name. */
const PIPELINE_PAGE_SHAPE: Shape<PipelinePage> = shape_build<PipelinePage>('a page of pipelines')(['getItems', 'function']);

/** A workflow just made: a resource whose data and instances are read through checks of their own. */
const WORKFLOW_SHAPE: Shape<DataCarrier> = shape_object<DataCarrier>('a workflow');

/** How many pipelines a name search reads: exact names seldom collide. */
const PIPELINE_SEARCH_LIMIT: number = 100;


/**
 * Group handler for ChRIS pipelines.
 */
export class ChRISPipelineGroup extends ChRISResourceGroup {
  constructor() {
    super('Pipelines', 'getPipelines');
  }
}

/**
 * Minimal shape of a pipeline record as returned by the ChRIS API.
 */
export interface PipelineRecord {
  id: number;
  name: string;
  description?: string | null;
  authors?: string | null;
  category?: string | null;
  locked?: boolean | null;
  /** Filesystem-safe slug derived from the pipeline source filename (e.g. "Varus_valgus_full_4crg2N7"). */
  slug?: string | null;
  [key: string]: unknown;
}

/** A pipeline as CUBE answers: its id is used as a number (a key, an argument) and its name as text. */
const PIPELINE_RECORD_SHAPE: Shape<PipelineRecord> = shape_build<PipelineRecord>('a pipeline')(['id', 'number'], ['name', 'string']);

/**
 * A pipeline as a row of a listing table. Such a row holds the fields that
 * were asked for, as the table made them (its id is text cut from an
 * address unless the id field was asked for), so nothing in it is held to
 * a kind here; those who read it check what they read.
 */
const PIPELINE_TABLE_ROW_SHAPE: Shape<PipelineRecord> = shape_build<PipelineRecord>('a pipeline row')(
  ['id', 'number'], ['name', 'string'], ['description', 'string?|null'], ['authors', 'string?|null'], ['category', 'string?|null'], ['locked', 'boolean?|null'], ['slug', 'string?|null'],
);

/**
 * Per-node override for a workflow execution.
 * All fields are optional — omitted fields use the pipeline's defaults.
 */
export interface WorkflowNodeOverride {
  piping_id: number;
  compute_resource_name?: string;
  title?: string;
  cpu_limit?: unknown;
  memory_limit?: unknown;
  gpu_limit?: unknown;
  number_of_workers?: unknown;
  plugin_parameter_defaults?: Array<{ name: string; default: unknown }>;
}

/**
 * Options for creating a workflow.
 */
export interface WorkflowCreateOptions {
  /** Numeric ID of the previous plugin instance to attach the workflow root to. */
  previousPluginInstId: number;
  /** Per-node overrides. If omitted, all nodes run with pipeline defaults. */
  nodeOverrides?: WorkflowNodeOverride[];
}

/**
 * Result of a successful workflow creation.
 */
export interface WorkflowResult {
  workflowId: number;
  /** Plugin instance IDs created by this workflow, in DAG order. */
  pluginInstanceIds: number[];
}

/**
 * Lists all registered pipelines, optionally filtered by name substring.
 *
 * @param search - Optional name substring filter.
 * @returns Result containing array of PipelineRecord on success.
 */
export async function pipelines_list(
  search?: string
): Promise<Result<PipelineRecord[]>> {
  try {
    const group: ChRISPipelineGroup = new ChRISPipelineGroup();
    const params: PipelineSearchParams = search ? { name: search } : {};
    const result = await group.asset.resources_getAll(params);
    if (!result || !result.tableData) return Ok([]);
    return Ok(listData_get({ data: result.tableData }, PIPELINE_TABLE_ROW_SHAPE));
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push('error', `pipelines_list: ${msg}`);
    return Err();
  }
}

/**
 * Resolves a pipeline by name (exact match first, then substring) or numeric ID string.
 *
 * One resolution per specifier per session: the answer is kept on the
 * connection's client (see pipelineMemo), so a diagram asked again — the
 * browser asks one per pipeline card on every visit to /bin — costs no
 * search. A miss is never kept.
 *
 * @param nameOrId - Pipeline name or numeric ID.
 * @returns Result containing the matched PipelineRecord.
 */
export async function pipeline_resolve(
  nameOrId: string
): Promise<Result<PipelineRecord>> {
  const client = await chrisConnection.client_get();
  if (!client) {
    errorStack.stack_push('error', 'Not connected to ChRIS');
    return Err();
  }
  const kept: PipelineRecord | null = pipelineRecord_recall(client, nameOrId);
  if (kept !== null) return Ok(kept);
  const resolved: Result<PipelineRecord> = await pipelineResolve_fetch(client, nameOrId);
  if (resolved.ok) pipelineRecord_keep(client, nameOrId, resolved.value);
  return resolved;
}

/** A pipeline's item as a listing served it, with the id it is kept under. */
interface KeptItem {
  /** The pipeline's id. */
  id: number;
  /** The chrisapi item. */
  item: DataCarrier;
}

/**
 * Reads the chrisapi items a pipeline listing served, each with its id,
 * so that they can be kept and the pipings read off them without listing
 * the pipeline again. Nothing is kept here: the whole page is read, and
 * may be refused, before any of it goes into the memo.
 *
 * @param page - The list response.
 * @returns The items that carry a numeric id, with it.
 * @throws {ShapeError} When the page's items are not a list of resources.
 */
function pipelineItems_read(page: PipelinePage): KeptItem[] {
  const items: DataCarrier[] = items_get(page, DATA_CARRIER_SHAPE);
  const kept: KeptItem[] = [];
  for (const item of items) {
    const data: IdRecord | null = itemData_get(item, ID_SEEN_SHAPE);
    if (data && typeof data.id === 'number') kept.push({ id: data.id, item });
  }
  return kept;
}

/**
 * Resolves a pipeline against CUBE: the wire half of pipeline_resolve.
 *
 * @param client - The connection's client.
 * @param nameOrId - Pipeline name or numeric ID.
 * @returns Result containing the matched PipelineRecord.
 */
async function pipelineResolve_fetch(
  client: Client,
  nameOrId: string
): Promise<Result<PipelineRecord>> {
  const isNumericID: boolean = /^\d+$/.test(nameOrId);
  if (isNumericID) {
    const numericId: number = parseInt(nameOrId, 10);
    try {
      const pipeline = await client.getPipeline(numericId);
      const data: PipelineRecord | null = itemData_get(pipeline, PIPELINE_RECORD_SHAPE);
      if (!data) {
        errorStack.stack_push('error', `Pipeline with ID ${numericId} not found`);
        return Err();
      }
      pipelineResource_keep(client, data.id, pipeline as object);
      return Ok(data);
    } catch (error: unknown) {
      const msg: string = error instanceof Error ? error.message : String(error);
      errorStack.stack_push('error', `pipeline_resolve: ${msg}`);
      return Err();
    }
  }

  // A /bin slug names its pipeline's id (`<base>_id<N>`, minted by the
  // listing from the record), so the id is the identity: one list by id
  // answers, where a name search for the slug is a certain miss and the
  // id only its fallback — two requests. A pipeline CUBE itself named
  // `..._idN` is listed in /bin under its own id, so a bare slug never
  // means it.
  const slugID: RegExpMatchArray | null = nameOrId.match(/_id(\d+)$/);
  if (slugID) {
    try {
      const pipeline = await client.getPipeline(parseInt(slugID[1], 10));
      const data: PipelineRecord | null = itemData_get(pipeline, PIPELINE_RECORD_SHAPE);
      if (data) {
        pipelineResource_keep(client, data.id, pipeline as object);
        return Ok(data);
      }
    } catch (_e: unknown) {}
  }

  // The search is read as a page, not through pipelines_list, so the items
  // it served can be kept: a pipeline's pipings hang off its item.
  // The whole answer is read, and held to what is read of it, before any of it is kept: a page whose items
  // or rows are not what they should be is an error on the stack, and leaves the memo as it was.
  let found: PipelineRecord[];
  let served: KeptItem[];
  try {
    const page: PipelinePage = await resource_call(client, PIPELINE_PAGE_SHAPE, 'getPipelines', { name: nameOrId, limit: PIPELINE_SEARCH_LIMIT });
    found = listData_get(page, PIPELINE_RECORD_SHAPE);
    served = pipelineItems_read(page);
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push('error', `pipelines_list: ${msg}`);
    return Err();
  }
  for (const one of served) pipelineResource_keep(client, one.id, one.item);
  const exact: PipelineRecord | undefined = found.find(
    (p: PipelineRecord) => p.name === nameOrId
  );
  if (exact) return Ok(exact);
  if (found.length === 1) return Ok(found[0]);
  if (found.length === 0) {
    const fallbackClient: Client = client;
    // ID-suffix fallback: slug of form "{name}_id{N}" generated for pipelines without source files
    const idSuffixMatch: RegExpMatchArray | null = nameOrId.match(/_id(\d+)$/);
    if (idSuffixMatch) {
      const directId: number = parseInt(idSuffixMatch[1], 10);
      try {
        const pipeline = await fallbackClient.getPipeline(directId);
        const directData: PipelineRecord | null = itemData_get(pipeline, PIPELINE_RECORD_SHAPE);
        if (directData) {
          pipelineResource_keep(client, directData.id, pipeline as object);
          return Ok(directData);
        }
      } catch (_e: unknown) {}
    }

    // Slug fallback: treat nameOrId as a source file fname fragment
    try {
      const sfList: ItemListSlice = await resource_call(
        fallbackClient, ITEM_LIST_SLICE_SHAPE, 'getPipelineSourceFiles', { fname: nameOrId, limit: 1 }
      );
      const sfItems: PipelineSourceFileItem[] = items_get(sfList, SOURCE_FILE_ITEM_SHAPE).filter(
        (item: PipelineSourceFileItem) => {
          const base: string = item.data.fname.split('/').pop() ?? '';
          return base.replace(/\.(ya?ml)$/i, '') === nameOrId;
        }
      );
      if (sfItems.length > 0 && sfItems[0].data.pipeline_name) {
        const byName: Result<PipelineRecord[]> = await pipelines_list(sfItems[0].data.pipeline_name);
        if (byName.ok) {
          const exactByName: PipelineRecord | undefined = byName.value.find(
            (p: PipelineRecord) => p.name === sfItems[0].data.pipeline_name
          );
          if (exactByName) return Ok(exactByName);
        }
      }
    } catch (_e: unknown) {}
    
    errorStack.stack_push('error', `No pipeline matching '${nameOrId}'`);
    return Err();
  }

  errorStack.stack_push(
    'error',
    `Ambiguous: ${found.length} pipelines match '${nameOrId}'. Use ID or full name.`
  );
  return Err();
}

/**
 * Creates a workflow — instantiates a pipeline on a specific plugin instance node.
 *
 * @param pipelineId - Numeric ID of the registered pipeline.
 * @param options - Execution options including the previous node and optional overrides.
 * @returns Result containing workflow ID and created plugin instance IDs.
 */
export async function pipeline_createWorkflow(
  pipelineId: number,
  options: WorkflowCreateOptions
): Promise<Result<WorkflowResult>> {
  const client = await chrisConnection.client_get();
  if (!client) {
    errorStack.stack_push('error', 'Not connected to ChRIS');
    return Err();
  }

  try {
    let nodes_info: WorkflowNodeOverride[];

    if (options.nodeOverrides && options.nodeOverrides.length > 0) {
      nodes_info = options.nodeOverrides;
    } else {
      const pipeline = await client.getPipeline(pipelineId);
      if (!pipeline) {
        errorStack.stack_push('error', `Pipeline ${pipelineId} not found`);
        return Err();
      }

      const pipings: Array<{ data: IdRecord }> = await listPages_drain(
        async (offset: number, limit: number): Promise<ListPage<{ data: IdRecord }>> => {
          const response: ItemListSlice = await resource_call(
            pipeline, ITEM_LIST_SLICE_SHAPE, 'getPluginPipings', { limit, offset }
          );
          return { data: items_get(response, ID_ITEM_SHAPE), totalCount: null, hasMore: response.hasNextPage };
        },
      );
      nodes_info = pipings.map((p: { data: IdRecord }) => ({ piping_id: p.data.id }));
    }

    const workflow: object | null = await resource_call(client, shape_nullable(WORKFLOW_SHAPE), 'createWorkflow', pipelineId, {
      previous_plugin_inst_id: options.previousPluginInstId,
      nodes_info: JSON.stringify(nodes_info),
    });

    if (!workflow) {
      errorStack.stack_push('error', 'createWorkflow returned empty response');
      return Err();
    }

    const workflowRecord: IdRecord | null = itemData_get(workflow, ID_SHAPE);
    if (!workflowRecord) {
      errorStack.stack_push('error', 'createWorkflow response carried no data');
      return Err();
    }
    const workflowId: number = workflowRecord.id;

    const instances: Array<{ data: IdRecord }> = await listPages_drain(
      async (offset: number, limit: number): Promise<ListPage<{ data: IdRecord }>> => {
        const response: ItemListSlice = await resource_call(
          workflow, ITEM_LIST_SLICE_SHAPE, 'getPluginInstances', { limit, offset }
        );
        return { data: items_get(response, ID_ITEM_SHAPE), totalCount: null, hasMore: response.hasNextPage };
      },
    );
    const pluginInstanceIds: number[] = instances.map(
      (inst: { data: IdRecord }) => inst.data.id
    );

    return Ok({ workflowId, pluginInstanceIds });
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push('error', `pipeline_createWorkflow: ${msg}`);
    return Err();
  }
}
