/**
 * @file Job (plugin instance) cancel and delete operations.
 *
 * All CUBE access flows through cumin's typed wire contract
 * (`pluginInstance_get`, `pluginInstancesPage_get`) — no casts against the
 * opaque client belong here.
 *
 * @module
 */

import {
  chrisConnection,
  errorStack,
  Result,
  Ok,
  Err,
  procCache_get,
  pluginInstance_get,
  pluginInstancesPage_get,
  listPages_walk,
  PluginInstanceHandle,
  ListPage,
  PluginInstanceData,
} from '@fnndsc/cumin';
import { inflateSync } from 'node:zlib';

/** Statuses that cannot be cancelled — operation is already done. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'finishedSuccessfully',
  'finishedWithError',
  'cancelled',
]);

/** Tests whether an unknown value is a non-null record. */
function record_is(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Decodes CUBE's base64-encoded, zlib-compressed raw pfcon response and
 * extracts its complete compute log.
 *
 * @param raw - The `PluginInstance.raw` value returned by CUBE.
 * @returns The complete compute log, or undefined when no decodable log exists.
 */
function pfconLog_decode(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;

  try {
    const json: unknown = JSON.parse(inflateSync(Buffer.from(raw, 'base64')).toString('utf8'));
    if (!record_is(json) || !record_is(json['compute'])) return undefined;
    const logs: unknown = json['compute']['logs'];
    return typeof logs === 'string' ? logs : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Cancels a running or scheduled plugin instance.
 * No-op if already terminal (returns Ok).
 *
 * @param instanceID - The plugin instance ID.
 * @returns Ok(true) on success, Err on failure.
 *
 * @example
 * ```typescript
 * const result = await job_cancel(789);
 * if (!result.ok) console.error('Cancel failed');
 * ```
 */
export async function job_cancel(instanceID: number): Promise<Result<boolean>> {
  try {
    const client = await chrisConnection.client_get();
    if (!client) {
      errorStack.stack_push('error', 'Not connected to ChRIS.');
      return Err();
    }

    const handle: PluginInstanceHandle | null = await pluginInstance_get(client, instanceID);
    if (!handle) {
      errorStack.stack_push('error', `Plugin instance ${instanceID} not found.`);
      return Err();
    }

    const status: string = handle.data?.status ?? '';
    if (TERMINAL_STATUSES.has(status)) {
      return Ok(true);
    }

    await handle.status_set('cancelled');
    return Ok(true);
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push('error', `Failed to cancel instance ${instanceID}: ${msg}`);
    return Err();
  }
}

/**
 * Deletes a plugin instance record from ChRIS.
 * Only call on terminal instances — cancels first if non-terminal.
 *
 * @param instanceID - The plugin instance ID.
 * @returns Ok(true) on success, Err on failure.
 *
 * @example
 * ```typescript
 * const result = await job_delete(789);
 * if (!result.ok) console.error('Delete failed');
 * ```
 */
export async function job_delete(instanceID: number): Promise<Result<boolean>> {
  try {
    const client = await chrisConnection.client_get();
    if (!client) {
      errorStack.stack_push('error', 'Not connected to ChRIS.');
      return Err();
    }

    const handle: PluginInstanceHandle | null = await pluginInstance_get(client, instanceID);
    if (!handle) {
      errorStack.stack_push('error', `Plugin instance ${instanceID} not found.`);
      return Err();
    }

    const status: string = handle.data?.status ?? '';
    if (!TERMINAL_STATUSES.has(status)) {
      await handle.status_set('cancelled');
    }

    await handle.delete();
    return Ok(true);
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push('error', `Failed to delete instance ${instanceID}: ${msg}`);
    return Err();
  }
}

/**
 * Fetches the current status string for a plugin instance directly from the API.
 *
 * @param instanceID - The plugin instance ID.
 * @returns Ok(statusString) or Err on failure.
 *
 * @example
 * ```typescript
 * const result = await job_statusFetch(789);
 * if (result.ok) console.log(result.value); // 'finishedSuccessfully'
 * ```
 */
export async function job_statusFetch(instanceID: number): Promise<Result<string>> {
  try {
    const client = await chrisConnection.client_get();
    if (!client) {
      errorStack.stack_push('error', 'Not connected to ChRIS.');
      return Err();
    }

    const handle: PluginInstanceHandle | null = await pluginInstance_get(client, instanceID);
    if (!handle) {
      errorStack.stack_push('error', `Plugin instance ${instanceID} not found.`);
      return Err();
    }

    return Ok(handle.data?.status ?? 'unknown');
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push('error', `Failed to fetch status for instance ${instanceID}: ${msg}`);
    return Err();
  }
}

/**
 * Fetches the folder a plugin instance writes its output to, as CUBE records it.
 *
 * Where a job's output lands is CUBE's answer (`output_path`), not a client's
 * guess: the store keeps it under its owner's home
 * (`home/<user>/feeds/feed_N/…`), a layout a client that builds the path from
 * ids gets wrong. The path is answered absolute, as every other store path
 * in a session is.
 *
 * @param instanceID - The plugin instance ID.
 * @returns Ok(absolute output folder), or Err when CUBE records none or the fetch fails.
 *
 * @example
 * ```typescript
 * const result = await job_outputPathFetch(864596);
 * if (result.ok) console.log(result.value);
 * // '/home/alice/feeds/feed_5982/pl-dircopy_864595/pl-pfdorun_864596/data'
 * ```
 */
export async function job_outputPathFetch(instanceID: number): Promise<Result<string>> {
  try {
    const client = await chrisConnection.client_get();
    if (!client) {
      errorStack.stack_push('error', 'Not connected to ChRIS.');
      return Err();
    }

    const handle: PluginInstanceHandle | null = await pluginInstance_get(client, instanceID);
    const recorded: string = handle?.data?.output_path?.trim() ?? '';
    if (recorded === '') {
      errorStack.stack_push('error', `CUBE records no output folder for plugin instance ${instanceID}.`);
      return Err();
    }
    return Ok(recorded.startsWith('/') ? recorded : `/${recorded}`);
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push('error', `Failed to fetch the output folder of instance ${instanceID}: ${msg}`);
    return Err();
  }
}

/**
 * Fetches current status for a batch of plugin instances in parallel.
 * Used by ls -l /proc/jobs/feed_N to get all node statuses in one round-trip.
 *
 * @param ids - Array of instance IDs.
 * @returns Map from instance ID to status string. Missing entries on failure.
 *
 * @example
 * ```typescript
 * const statuses = await jobs_statusBatch([456, 789, 1011]);
 * statuses.get(789); // 'finishedSuccessfully'
 * ```
 */
export async function jobs_statusBatch(ids: number[]): Promise<Map<number, string>> {
  const result: Map<number, string> = new Map();
  if (ids.length === 0) return result;

  const client = await chrisConnection.client_get();
  if (!client) {
    // An empty map from a disconnected client is not "no jobs": say so, so
    // callers rendering stale status have a visible reason.
    errorStack.stack_push("warning", `jobs_statusBatch: not connected; status for ${ids.length} instance(s) unavailable.`);
    return result;
  }

  const failedIDs: number[] = [];
  const entries: Array<[number, string]> = (
    await Promise.all(
      ids.map(async (id: number): Promise<[number, string] | null> => {
        try {
          const handle: PluginInstanceHandle | null = await pluginInstance_get(client, id);
          if (!handle) {
            failedIDs.push(id);
            return null;
          }
          return [id, handle.data?.status ?? 'unknown'];
        } catch {
          failedIDs.push(id);
          return null;
        }
      })
    )
  ).filter((e): e is [number, string] => e !== null);

  // Partial results are by design (one dead instance must not blank a whole
  // listing), but the gaps must be visible rather than reading as absent.
  if (failedIDs.length > 0) {
    errorStack.stack_push(
      "warning",
      `jobs_statusBatch: could not fetch status for instance(s) ${failedIDs.sort((a, b) => a - b).join(", ")}.`,
    );
  }

  for (const [id, status] of entries) {
    result.set(id, status);
  }
  return result;
}

/**
 * Finds plugin instances by numeric ID or plugin name substring.
 * After warm-up completes uses pure in-memory cache; otherwise falls back to API.
 *
 * @param term - Numeric instance ID or plugin name substring.
 * @returns Ok(array of matches) or Err.
 *
 * @example
 * ```typescript
 * await jobs_find('64306');     // exact ID
 * await jobs_find('pl-fshack'); // all instances whose name contains 'pl-fshack'
 * ```
 */
export async function jobs_find(
  term: string
): Promise<Result<Array<{ id: number; feedID: number; pluginName: string }>>> {
  try {
    const cache = procCache_get();

    const numeric: number = parseInt(term, 10);
    const isID: boolean = !isNaN(numeric) && String(numeric) === term;

    // After warm-up: topology is complete — pure in-memory, zero API calls.
    if (cache.warmupComplete) {
      const hits = cache.instances_find(term);
      return Ok(hits.map(i => ({ id: i.id, feedID: i.feedID, pluginName: i.pluginName })));
    }

    // Exact ID: cache-first (only one possible result when warm-up is partial)
    if (isID) {
      const cached = cache.instances_find(term);
      if (cached.length > 0) {
        return Ok(cached.map(i => ({ id: i.id, feedID: i.feedID, pluginName: i.pluginName })));
      }
    }
    // Name substring or ID miss: fall back to API during warm-up

    const client = await chrisConnection.client_get();
    if (!client) {
      errorStack.stack_push('error', 'Not connected to ChRIS.');
      return Err();
    }

    const apiResults: Array<{ id: number; feedID: number; pluginName: string }> = [];
    const result_collect = (inst: PluginInstanceData): void => {
      apiResults.push({
        id: Number(inst.id),
        feedID: Number(inst.feed_id),
        pluginName: String(inst.plugin_name),
      });
    };

    if (isID) {
      const page: ListPage<PluginInstanceData> = await pluginInstancesPage_get(client, {
        id: numeric, limit: 1, offset: 0,
      });
      page.data.forEach(result_collect);
    } else {
      for await (const step of listPages_walk(
        (offset: number, limit: number): Promise<ListPage<PluginInstanceData>> =>
          pluginInstancesPage_get(client, { plugin_name: term, limit, offset }),
      )) {
        step.items.forEach(result_collect);
      }
    }

    return Ok(apiResults);
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push('error', `jobs_find failed: ${msg}`);
    return Err();
  }
}

/**
 * Looks up which feed a plugin instance belongs to.
 *
 * @param instanceID - The plugin instance ID.
 * @returns Ok(feedID) or Err if not found.
 *
 * @example
 * ```typescript
 * const r = await job_feedID_get(64306);
 * if (r.ok) console.log(r.value); // 1107
 * ```
 */
export async function job_feedID_get(instanceID: number): Promise<Result<number>> {
  try {
    const client = await chrisConnection.client_get();
    if (!client) {
      errorStack.stack_push('error', 'Not connected to ChRIS.');
      return Err();
    }

    const page: ListPage<PluginInstanceData> = await pluginInstancesPage_get(client, {
      id: instanceID,
      limit: 1,
    });

    const hit: PluginInstanceData | undefined = page.data[0];
    if (!hit || hit.feed_id === undefined || hit.feed_id === null) {
      errorStack.stack_push('error', `Instance ${instanceID} not found.`);
      return Err();
    }

    return Ok(Number(hit.feed_id));
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push('error', `Failed to find feed for instance ${instanceID}: ${msg}`);
    return Err();
  }
}

/**
 * Fetches the log output for a plugin instance from the API.
 *
 * @param instanceID - The plugin instance ID.
 * @returns Ok(logString) or Err on failure.
 */
export async function job_logFetch(instanceID: number): Promise<Result<string>> {
  try {
    const client = await chrisConnection.client_get();
    if (!client) {
      errorStack.stack_push('error', 'Not connected to ChRIS.');
      return Err();
    }

    const handle: PluginInstanceHandle | null = await pluginInstance_get(client, instanceID);
    if (!handle) {
      errorStack.stack_push('error', `Plugin instance ${instanceID} not found.`);
      return Err();
    }

    const rawLog: string | undefined = pfconLog_decode(handle.data?.raw);
    if (rawLog !== undefined) {
      return Ok(rawLog || '(no log output yet)');
    }

    const logText: string | null = await handle.logs_get();
    if (logText === null) {
      return Ok('(log not available for this instance)');
    }
    return Ok(logText || '(no log output yet)');
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push('error', `Failed to fetch log for instance ${instanceID}: ${msg}`);
    return Err();
  }
}
