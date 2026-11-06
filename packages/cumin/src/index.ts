#!/usr/bin/env node

/**
 * @file Cumin Package Main Entry Point.
 *
 * This file serves as the main entry point and export aggregator for the Cumin infrastructure
 * library. It exports error stacks, config utilities, PACs handlers, connections, file browsers,
 * and result Monads for downstream consumption by Salsa, Chili, and Chell.
 *
 * @module
 */

export * from "./";
export * from "./error/errorStack";
export * from "./config/config";
export * from "./feeds/chrisFeed";
export * from "./feeds/chrisTags";
export * from "./feeds/chrisAccess";
export * from "./connect/chrisConnection";
export * from "./connect/loginFailure";
export * from "./context/chrisContext";
export * from "./plugins/chrisPlugins";
export * from "./plugins/chrisPluginMetaPlugins";
export * from "./compute/computeResources";
export * from "./pacs/chrisPACS";
export * from "./pacs/queryIndexSweep";
export * from "./pacs/dicomPayload";
export * from "./resources/chrisResources";
export * from "./resources/chrisResourceGroup";
export * from "./resources/chrisObjContext";
export * from "./resources/chrisEmbeddedResourceGroup";
export * from "./filebrowser/chrisFileBrowser";
export * from "./filebrowser/folderMemo";
export * from "./filebrowser/chrisFiles";
export * from "./filebrowser/chrisPACS";
export * from "./filebrowser/chrisPipeline";
export * from "./io/chrisIO";
export * from "./io/streamWatch";
export * from "./net/requestLedger";
export * from "./io/io";
export * from "./io/node_io";
export * from "./utils/keypair";
export * from "./utils/searchable";
export * from "./utils/result";
export * from "./utils/retry";
export * from "./utils/envelope";
export * from "./cache";
export * from "./path/chrisPath";
export * from "./pipelines/chrisPipeline";
export * from "./pipelines/pipelineMemo";
export * from "./users/chrisUsers";
export * from "./tags/chrisTags";
export * from "./groups/chrisGroups";
export * from "./pluginmetas/chrisPluginMetas";
export * from "./workflows/chrisWorkflows";
export * from "./output/runtimeOutput";

// Re-export chrisapi types so downstream packages don't import chrisapi directly
export { listData_get, itemData_get, items_get, client_adminPluginUpload, type PluginAdminSource } from "./chrisapi/adapter";
export { pace_get, pace_note, pace_reset, pace_isPageMethod, PACE_WINDOW, type CubePace } from "./chrisapi/pace";

// Typed wire contract over the hot API surfaces (jobs, PACS): downstream
// packages call these instead of casting the opaque client per call site.
export {
  feedsPage_get,
  publicFeedsPage_get,
  pluginInstancesPage_get,
  pluginInstance_get,
  plugin_find,
  pluginsPage_get,
  pluginParameters_drain,
  pipeline_get,
  pipelineSourceFilesPage_get,
  pipelineSourceFiles_drain,
  downloadToken_create,
  listPages_walk, listPages_walkWindowed, type WindowedPageWalkOptions,
  listPages_drain,
  collectionPage_wrap,
} from "./chrisapi/contract";
export type {
  ListPage,
  PageWalkOptions,
  PageWalkStep,
  FeedData,
  PluginInstanceData,
  InstanceParameterData,
  DownloadToken,
  PluginInstanceHandle,
  PipelineHandle,
  PluginPipingItem,
  PluginPipingData,
  PipingDefaultParameterData,
  PipelineSourceFileData,
  PluginParameterData,
  ComputeResourceData,
  PluginHandle,
  PluginData,
  PluginFound,
} from "./chrisapi/contract";
export type {
  ListResource,
  Resource,
  ItemResource,
  PluginInstance,
  Feed,
  FileBrowserFolder,
  UserFile,
  PACSFile,
} from "./chrisapi/adapter";

/**
 * Shape of a single node (file, directory, or link) in a ChRIS path listing.
 */
export interface ChrisPathNode {
  path: string;
  fname?: string;
  fsize?: number;
  id?: number;
  isDir?: boolean;
  isLink?: boolean;
  linkTarget?: string;
}

/**
 * Summary metadata describing a ChRIS plugin.
 */
export interface ChrisPluginSummary {
  id?: number;
  name?: string;
}

/**
 * Gets the ChRIS version from the given URL.
 *
 * @param url - The URL of the ChRIS instance.
 * @returns A Promise resolving to the version string.
 */
export async function chrisVersion_get(url: string): Promise<string> {
  const version: string = "1.0.0";
  // const client = Client.getClient(url);
  // const version = await client.getVersion();
  return version;
}

/**
 * Main entry point for the module when run directly.
 */
async function main() {
  console.log("In main...");
}

// Only run the main function if this file is being run directly
// Use CommonJS check for main module
if (require.main === module) {
  main().catch((error) => {
    console.error("An error occurred:", error);
    process.exit(1);
  });
}
