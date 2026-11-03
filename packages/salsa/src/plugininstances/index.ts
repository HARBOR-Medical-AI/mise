/**
 * @file PluginInstance resource operations.
 * @module
 */

import { ChRISPluginInstanceGroup, chrisConnection, pluginInstancesPage_get, FilteredResourceData, ListOptions } from '@fnndsc/cumin';

/**
 * Lists all plugin instances / jobs across all pages.
 *
 * @param options - Search options (limit/offset managed internally).
 */
export async function pluginInstances_listAll(options: Partial<ListOptions> = {}): Promise<FilteredResourceData | null> {
  const group: ChRISPluginInstanceGroup = new ChRISPluginInstanceGroup();
  return await group.asset.resources_getAll(options);
}

/**
 * Returns available field names for plugin instances.
 */
export async function pluginInstanceFields_get(): Promise<string[] | null> {
  const group: ChRISPluginInstanceGroup = new ChRISPluginInstanceGroup();
  const result = await group.asset.resourceFields_get();
  return result ? result.fields : null;
}

/**
 * The feeds one pipeline run's jobs are in, asked of CUBE by the workflow:
 * its instances walked page by page, their feed ids once each. A search
 * scoped to a run reads those feeds and no other (#1364).
 *
 * @param workflowId - The workflow CUBE made for the run.
 * @returns The feed ids, in the order CUBE listed the jobs; none when not connected or the run is unknown.
 */
export async function workflowFeedIDs_get(workflowId: number): Promise<number[]> {
  const client = await chrisConnection.client_get();
  if (!client) return [];
  const feeds: number[] = [];
  const limit: number = 100;
  for (let offset: number = 0; ; offset += limit) {
    const page = await pluginInstancesPage_get(client, { workflow_id: workflowId, limit, offset });
    for (const row of page.data) {
      const feedID: number = Number((row as { feed_id?: unknown }).feed_id);
      if (Number.isFinite(feedID) && !feeds.includes(feedID)) feeds.push(feedID);
    }
    if (page.data.length < limit) break;
  }
  return feeds;
}
