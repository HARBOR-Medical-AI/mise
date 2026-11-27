/**
 * @file Read-only registered-pipeline invocation manifest.
 *
 * The manifest is the CUBE-specific executable projection behind `/bin`: it
 * carries assigned pipeline/piping identities and the stored values required
 * to prepare a Workflow invocation without changing the authoring source.
 */
import {
  Err,
  Ok,
  Result,
  chrisConnection,
  errorStack,
  pipeline_get,
  pipeline_resolve,
  listPages_drain,
  type PipelineHandle,
  type PluginPipingItem,
  type PluginHandle,
  type PipingDefaultParameterData,
  type PipelineRecord,
} from '@fnndsc/cumin';

/** One parameter value stored on a registered plugin piping. */
export interface PipelineManifestParameterDefault {
  /** Hosted plugin parameter name. */
  name: string;
  /** Registered value, preserved without scalar coercion. */
  value: unknown;
}

/** One CUBE-assigned piping in a registered pipeline. */
export interface PipelineManifestNode {
  /** Registration-specific plugin piping ID. */
  pipingID: number;
  /** Authored node title used as the portable selector when unique. */
  title: string;
  /** Hosted plugin name. */
  pluginName: string;
  /** Hosted plugin version. */
  pluginVersion: string;
  /** Parent piping ID, or null for a root. */
  parentID: number | null;
  /** Effective registered compute placement. */
  computeResourceName: string;
  /** Registered CPU limit. */
  cpuLimit?: unknown;
  /** Registered memory limit. */
  memoryLimit?: unknown;
  /** Registered GPU limit. */
  gpuLimit?: unknown;
  /** Registered worker count. */
  numberOfWorkers?: unknown;
  /** Parameter values stored by the pipeline registration. */
  parameterDefaults: PipelineManifestParameterDefault[];
  /** Compute resources on which the hosted plugin is registered. */
  computeResources?: string[];
  /** Hosted plugin parameter schema used for help and validation. */
  parameterDefinitions?: Array<{
    /** Hosted parameter name. */
    name: string;
    /** CUBE plugin parameter type. */
    type: string;
    /** Whether the plugin permits omission. */
    optional: boolean;
    /** Plugin-declared default value. */
    default?: unknown;
    /** Plugin-declared help text. */
    help?: string;
  }>;
}

/** CUBE-specific executable projection of one registered pipeline. */
export interface PipelineManifest {
  /** Registered Pipeline ID. */
  pipelineID: number;
  /** Registered Pipeline name. */
  name: string;
  /** Root plugin piping IDs. */
  rootIDs: number[];
  /** Complete registered piping set. */
  nodes: PipelineManifestNode[];
}

/** Controls how much remote metadata is included in a Pipeline manifest. */
export interface PipelineManifestGetOptions {
  /** `registered` omits hosted schemas; `execution` includes validation metadata. */
  detail?: 'registered' | 'execution';
}

interface PipingData {
  id: number;
  title?: string;
  plugin_name?: string;
  plugin_version?: string;
  previous_id?: number | null;
  cpu_limit?: unknown;
  memory_limit?: unknown;
  gpu_limit?: unknown;
  number_of_workers?: unknown;
}

interface PluginParameterData {
  name: string;
  type?: string;
  optional?: boolean;
  default?: unknown;
  help?: string;
}

interface DefaultParameterData {
  plugin_piping_id: number;
  param_name: string;
  value: unknown;
  plugin_piping_cpu_limit?: unknown;
  plugin_piping_memory_limit?: unknown;
  plugin_piping_gpu_limit?: unknown;
  plugin_piping_number_of_workers?: unknown;
}

/**
 * Narrows a wire default-parameter row to the manifest's required shape.
 *
 * @param row - Stored default row from the contract.
 * @returns The narrowed row, or null when required fields are absent.
 */
function defaultParameter_narrow(row: PipingDefaultParameterData): DefaultParameterData | null {
  if (typeof row.plugin_piping_id !== 'number' || typeof row.param_name !== 'string') return null;
  return { ...row, plugin_piping_id: row.plugin_piping_id, param_name: row.param_name, value: row.value };
}

interface TimedCacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface PipelineManifestClientCache {
  aliases: Map<string, TimedCacheEntry<PipelineRecord>>;
  manifests: Map<string, TimedCacheEntry<PipelineManifest>>;
  pluginMetadata: Map<string, TimedCacheEntry<Promise<PluginMetadata>>>;
}

interface PluginMetadata {
  computeResources: string[];
  parameterDefinitions: NonNullable<PipelineManifestNode['parameterDefinitions']>;
}

const PIPELINE_MANIFEST_TTL_MS: number = 5 * 60 * 1000;
const manifestCaches: WeakMap<object, PipelineManifestClientCache> = new WeakMap();

function timedCache_get<T>(entries: Map<string, TimedCacheEntry<T>>, key: string): T | undefined {
  const entry: TimedCacheEntry<T> | undefined = entries.get(key);
  if (entry === undefined) return undefined;
  if (entry.expiresAt <= Date.now()) {
    entries.delete(key);
    return undefined;
  }
  return entry.value;
}

function timedCache_set<T>(entries: Map<string, TimedCacheEntry<T>>, key: string, value: T): void {
  entries.set(key, { value, expiresAt: Date.now() + PIPELINE_MANIFEST_TTL_MS });
}

function manifestClientCache_get(client: object): PipelineManifestClientCache {
  let cache: PipelineManifestClientCache | undefined = manifestCaches.get(client);
  if (cache === undefined) {
    cache = { aliases: new Map(), manifests: new Map(), pluginMetadata: new Map() };
    manifestCaches.set(client, cache);
  }
  return cache;
}

async function pluginMetadata_get(
  cache: PipelineManifestClientCache,
  item: PluginPipingItem,
  piping: PipingData,
): Promise<PluginMetadata | undefined> {
  const key: string = piping.plugin_name !== undefined && piping.plugin_version !== undefined
    ? `${piping.plugin_name}@${piping.plugin_version}`
    : `piping:${piping.id}`;
  let metadataPromise: Promise<PluginMetadata> | undefined = timedCache_get(cache.pluginMetadata, key);
  if (metadataPromise === undefined) {
    metadataPromise = (async (): Promise<PluginMetadata> => {
      const plugin: PluginHandle | null = await item.plugin_get();
      if (plugin === null) throw new Error('piping exposes no plugin link');
      const [parameterRows, computeRows] = await Promise.all([
        listPages_drain((offset: number, limit: number) => plugin.parametersPage_get({ limit, offset })),
        listPages_drain((offset: number, limit: number) => plugin.computeResourcesPage_get({ limit, offset })),
      ]);
      return {
        parameterDefinitions: parameterRows.map(
          (parameter) => ({
            name: parameter.name,
            type: parameter.type ?? 'string',
            optional: parameter.optional ?? false,
            default: parameter.default,
            help: parameter.help,
          }),
        ),
        computeResources: computeRows
          .map((compute): string | null | undefined => compute.name)
          .filter((name: string | null | undefined): name is string => typeof name === 'string'),
      };
    })();
    timedCache_set(cache.pluginMetadata, key, metadataPromise);
  }
  try {
    return await metadataPromise;
  } catch (error: unknown) {
    cache.pluginMetadata.delete(key);
    throw error;
  }
}

/**
 * Fetch a manifest for an already-resolved Pipeline without resolving it again.
 *
 * @param pipeline - Exact Pipeline record already resolved by the caller.
 * @param resource - Typed pipeline handle obtained during that resolution.
 * @param options - Projection detail required by the caller.
 * @returns Result containing the requested registered Pipeline projection.
 */
export async function pipelineManifestForPipeline_get(
  pipeline: PipelineRecord,
  resource: PipelineHandle,
  options: PipelineManifestGetOptions = {},
): Promise<Result<PipelineManifest>> {
  const client = await chrisConnection.client_get();
  if (!client) {
    errorStack.stack_push('error', 'Not connected to ChRIS. Cannot inspect pipeline.');
    return Err();
  }
  const cache: PipelineManifestClientCache = manifestClientCache_get(client as object);
  timedCache_set(cache.aliases, String(pipeline.id), pipeline);
  if (typeof pipeline.slug === 'string') timedCache_set(cache.aliases, pipeline.slug, pipeline);
  const detail: 'registered' | 'execution' = options.detail ?? 'execution';
  const manifestKey: string = `${pipeline.id}:${detail}`;
  const cachedManifest: PipelineManifest | undefined = timedCache_get(cache.manifests, manifestKey);
  if (cachedManifest !== undefined) return Ok(cachedManifest);
  return pipelineManifest_project(pipeline, resource, detail, cache);
}

function definedValue_getFirst(...values: unknown[]): unknown {
  return values.find((value: unknown): boolean => value !== undefined);
}

/**
 * Picks the compute a node runs on when the run names none.
 *
 * `host` is what a stock ChRIS calls its compute, so it stays the choice
 * wherever the plugin is registered there, or where the plugin's computes
 * were not read. A CUBE that names its computes otherwise (ekanite's
 * `argentum`) would refuse every node on `host`, so the plugin's first
 * registered compute is taken instead.
 *
 * @param computeResources - The computes the plugin is registered on, when read.
 * @returns The compute's name.
 */
export function computeResourceName_choose(computeResources: ReadonlyArray<string> | undefined): string {
  if (computeResources === undefined || computeResources.length === 0 || computeResources.includes('host')) return 'host';
  return computeResources[0] as string;
}

async function pipelineManifest_project(
  pipelineRecord: PipelineRecord,
  pipeline: PipelineHandle,
  detail: 'registered' | 'execution',
  cache: PipelineManifestClientCache,
): Promise<Result<PipelineManifest>> {
  const manifestKey: string = `${pipelineRecord.id}:${detail}`;
  try {
    const [pipingItems, defaultRows] = await Promise.all([
      listPages_drain((offset: number, limit: number) => pipeline.pluginPipingsPage_get({ limit, offset })),
      listPages_drain((offset: number, limit: number) => pipeline.defaultParametersPage_get({ limit, offset })),
    ]);
    const defaults: DefaultParameterData[] = defaultRows
      .map((row: PipingDefaultParameterData): DefaultParameterData | null => defaultParameter_narrow(row))
      .filter((row: DefaultParameterData | null): row is DefaultParameterData => row !== null);
    const defaultsByPiping: Map<number, DefaultParameterData[]> = new Map();
    for (const parameter of defaults) {
      const current: DefaultParameterData[] = defaultsByPiping.get(parameter.plugin_piping_id) ?? [];
      current.push(parameter);
      defaultsByPiping.set(parameter.plugin_piping_id, current);
    }

    const nodes: PipelineManifestNode[] = await Promise.all(pipingItems.map(async (item: PluginPipingItem): Promise<PipelineManifestNode> => {
      const piping: PipingData = item.data;
      const stored: DefaultParameterData[] = defaultsByPiping.get(piping.id) ?? [];
      const resource: DefaultParameterData | undefined = stored[0];
      let computeResources: string[] | undefined;
      let parameterDefinitions: PipelineManifestNode['parameterDefinitions'];
      if (detail === 'execution') {
        const metadata: PluginMetadata | undefined = await pluginMetadata_get(cache, item, piping);
        parameterDefinitions = metadata?.parameterDefinitions;
        computeResources = metadata?.computeResources;
      }
      return {
        pipingID: piping.id,
        title: piping.title ?? `piping_${piping.id}`,
        pluginName: piping.plugin_name ?? '?',
        pluginVersion: piping.plugin_version ?? '',
        parentID: piping.previous_id ?? null,
        computeResourceName: computeResourceName_choose(computeResources),
        cpuLimit: definedValue_getFirst(resource?.plugin_piping_cpu_limit, piping.cpu_limit),
        memoryLimit: definedValue_getFirst(resource?.plugin_piping_memory_limit, piping.memory_limit),
        gpuLimit: definedValue_getFirst(resource?.plugin_piping_gpu_limit, piping.gpu_limit),
        numberOfWorkers: definedValue_getFirst(resource?.plugin_piping_number_of_workers, piping.number_of_workers),
        parameterDefaults: stored.map((parameter: DefaultParameterData): PipelineManifestParameterDefault => ({
          name: parameter.param_name,
          value: parameter.value,
        })),
        computeResources,
        parameterDefinitions,
      };
    }));

    const manifest: PipelineManifest = {
      pipelineID: pipelineRecord.id,
      name: pipelineRecord.name,
      rootIDs: nodes.filter((node: PipelineManifestNode): boolean => node.parentID === null)
        .map((node: PipelineManifestNode): number => node.pipingID),
      nodes,
    };
    timedCache_set(cache.manifests, manifestKey, manifest);
    return Ok(manifest);
  } catch (error: unknown) {
    const message: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push('error', `pipelineManifest_get: ${message}`);
    return Err();
  }
}

/**
 * Fetch one registered pipeline as its CUBE-specific invocation manifest.
 *
 * @param specifier - Pipeline name or numeric ID string.
 * @param options - Projection detail required by the caller.
 * @returns Result containing the complete registered invocation manifest.
 */
export async function pipelineManifest_get(
  specifier: string,
  options: PipelineManifestGetOptions = {},
): Promise<Result<PipelineManifest>> {
  const detail: 'registered' | 'execution' = options.detail ?? 'execution';
  const client = await chrisConnection.client_get();
  if (!client) {
    errorStack.stack_push('error', 'Not connected to ChRIS. Cannot inspect pipeline.');
    return Err();
  }
  const cache: PipelineManifestClientCache = manifestClientCache_get(client as object);
  let pipelineRecord: PipelineRecord | undefined = timedCache_get(cache.aliases, specifier);
  if (pipelineRecord === undefined) {
    const resolved: Result<PipelineRecord> = await pipeline_resolve(specifier);
    if (!resolved.ok) return Err();
    pipelineRecord = resolved.value;
    timedCache_set(cache.aliases, specifier, pipelineRecord);
    timedCache_set(cache.aliases, String(pipelineRecord.id), pipelineRecord);
  }
  const manifestKey: string = `${pipelineRecord.id}:${detail}`;
  const cachedManifest: PipelineManifest | undefined = timedCache_get(cache.manifests, manifestKey);
  if (cachedManifest !== undefined) return Ok(cachedManifest);

  try {
    const pipeline: PipelineHandle | null = await pipeline_get(client, pipelineRecord.id);
    if (!pipeline) {
      errorStack.stack_push('error', `Pipeline ${pipelineRecord.id} not found.`);
      return Err();
    }
    return pipelineManifest_project(pipelineRecord, pipeline, detail, cache);
  } catch (error: unknown) {
    const message: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push('error', `pipelineManifest_get: ${message}`);
    return Err();
  }
}
