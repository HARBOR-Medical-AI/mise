/**
 * @file Plugin management operations.
 * @module
 */

import {
  ChRISPlugin,
  QueryHits,
  Dictionary,
  ChRISPluginMetaPluginGroup, // Not directly used in functions yet, but for potential future logic
  ChRISPluginGroup,
  ChRISPluginInstanceGroup,
  FilteredResourceData,
  ListOptions,
  Searchable,
  objContext_create,
  errorStack
} from '@fnndsc/cumin';
import axios from 'axios';

// ... existing interfaces ...

/**
 * List plugins based on options.
 *
 * @param options - Search and pagination options.
 * @returns A Promise resolving to FilteredResourceData or null.
 */
export async function plugins_list(options: ListOptions): Promise<FilteredResourceData | null> {
  const pluginGroup: ChRISPluginGroup = new ChRISPluginGroup();

  if (!pluginGroup) {
    return null;
  }

  return await pluginGroup.asset.resources_listAndFilterByOptions(options);
}

/**
 * List *all* plugins by automatically handling pagination.
 *
 * @param options - Search options (limit and offset will be overridden/managed internally).
 * @returns A Promise resolving to FilteredResourceData containing all matching plugins, or null.
 */
export async function plugins_listAll(options: ListOptions = {}): Promise<FilteredResourceData | null> {
  const pluginGroup: ChRISPluginGroup = new ChRISPluginGroup();
  if (!pluginGroup) return null;
  return await pluginGroup.asset.resources_getAll(options);
}

/**
 * Get the list of available fields for plugins.
 *
 * @returns A Promise resolving to an array of field names or null.
 */
export async function pluginFields_get(): Promise<string[] | null> {
  const pluginGroup: ChRISPluginGroup = new ChRISPluginGroup();

  if (!pluginGroup) {
    return null;
  }

  const results = await pluginGroup.asset.resourceFields_get();
  return results ? results.fields : null;
}

/**
 * List plugin instances based on options.
 *
 * @param options - Search and pagination options (e.g., { id: 123 }).
 * @returns A Promise resolving to FilteredResourceData or null.
 */
export async function pluginInstances_list(options: ListOptions): Promise<FilteredResourceData | null> {
  const pluginInstanceGroup: ChRISPluginInstanceGroup = new ChRISPluginInstanceGroup();

  if (!pluginInstanceGroup) {
    return null;
  }

  return await pluginInstanceGroup.asset.resources_listAndFilterByOptions(options);
}

/**
 * Interface for options when searching for a plugin.
 * This should be expanded as needed to reflect actual search parameters.
 */
export interface PluginSearchOptions {
  search?: string;
  name?: string;
  id?: string;
  // Add other search parameters as they become known and needed
  [key: string]: unknown; // Allow for arbitrary key-value pairs initially
}

/**
 * README content together with source metadata needed by presentation layers.
 *
 * @property content - Original README text.
 * @property format - Markup format inferred from the source filename.
 * @property sourceUrl - Exact URL from which the README was fetched.
 */
export interface PluginReadmeDocument {
  content: string;
  format: 'markdown' | 'rst';
  sourceUrl: string;
}

/**
 * Converts a Dictionary to CLI-style parameter string.
 *
 * @param params - Dictionary of parameters.
 * @returns CLI-style string (e.g., "--key1 value1 --key2 value2").
 */
export function dictionary_formatAsCLI(params: Dictionary): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      parts.push(`--${key} ${value}`);
    }
  }
  return parts.join(' ');
}

/**
 * Run a plugin instance.
 *
 * This function orchestrates the execution of a ChRIS plugin with specified parameters.
 *
 * @param searchable - A string that identifies the plugin (e.g., name, ID, or a partial match).
 * @param parameters - An object containing the parameters for the plugin execution.
 * @returns A Promise resolving to a Dictionary representing the created plugin instance, or null if execution failed.
 */
export async function plugin_run(searchable: string, parameters: Dictionary): Promise<Dictionary | null> {
  const chrisPlugin: ChRISPlugin = new ChRISPlugin();
  return await chrisPlugin.plugin_run(searchable, parameters);
}

/**
 * Resolve a searchable plugin string to a list of plugin IDs.
 *
 * @param searchable - A string or Searchable object that identifies the plugin (e.g., name, ID, or a partial match).
 * @returns A Promise resolving to an array of plugin IDs, or null if no plugins match.
 */
export async function plugins_searchableToIDs(searchable: string | Searchable): Promise<string[] | null> {
  const chrisPlugin: ChRISPlugin = new ChRISPlugin();
  const queryHits: QueryHits | null = await chrisPlugin.pluginIDs_resolve(searchable);
  if (!queryHits) {
    return null;
  }
  return queryHits.hits as string[];
}

/**
 * Fetch the raw README content from a plugin's repository URL.
 *
 * This function attempts to retrieve README files (Markdown or reStructuredText)
 * from common locations within a given repository URL.
 *
 * @param repoUrl - The base URL of the plugin's Git repository.
 * @returns A Promise resolving to the README content as a string, or null if no README is found or accessible.
 */
export async function pluginMeta_readmeContentFetch(repoUrl: string): Promise<string | null> {
  const document: PluginReadmeDocument | null = await pluginReadme_fetchFromRepository(repoUrl);
  return document?.content ?? null;
}

/**
 * Fetch a README while retaining its source URL and markup format.
 *
 * @param repoUrl - The base URL of the plugin's Git repository.
 * @returns README content and format metadata, or null when none is reachable.
 */
export async function pluginReadme_fetchFromRepository(repoUrl: string): Promise<PluginReadmeDocument | null> {
  const readmeUrls: string[] = [
    `${repoUrl}/raw/master/README.md`,
    `${repoUrl}/raw/master/README.rst`,
    `${repoUrl}/raw/main/README.md`,
    `${repoUrl}/raw/main/README.rst`,
  ];

  for (const url of readmeUrls) {
    try {
      const response = await axios.get(url);
      if (response.status === 200) {
        return {
          content: String(response.data),
          format: url.endsWith('.rst') ? 'rst' : 'markdown',
          sourceUrl: url,
        };
      }
    } catch (error: unknown) {
      // Deliberate absorption, adjudicated 2026-08: candidate README URLs are
      // expected to 404 (main vs master, .md vs .rst); each miss falls through
      // to the next candidate and an all-miss returns null, which callers
      // render as "no README".
    }
  }
  return null;
}

/**
 * Fetch the README for an installed plugin using its repository metadata.
 *
 * `public_repo` is the canonical source. `documentation` remains a fallback
 * for older CUBE records which stored the repository URL in that field.
 *
 * @param pluginId - The installed plugin ID.
 * @returns README content and format metadata, or null.
 */
export async function pluginReadmeDocument_fetch(pluginId: string): Promise<PluginReadmeDocument | null> {
  const chrisPlugin: ChRISPlugin = new ChRISPlugin();
  const query: QueryHits | null = await chrisPlugin.pluginData_getFromSearch(
    { search: `id: ${pluginId}` },
    ['public_repo', 'documentation'],
  );
  if (!query || !query.hits.length) {
    return null;
  }

  const metadata: Dictionary = query.hits[0] as Dictionary;
  const repositoryUrls: string[] = [metadata.public_repo, metadata.documentation]
    .filter((url: unknown): url is string => typeof url === 'string' && url.trim().length > 0)
    .filter((url: string, index: number, urls: string[]) => urls.indexOf(url) === index);

  for (const repositoryUrl of repositoryUrls) {
    const document: PluginReadmeDocument | null = await pluginReadme_fetchFromRepository(repositoryUrl.replace(/\/$/, ''));
    if (document) {
      return document;
    }
  }
  return null;
}

/**
 * Retrieve the documentation URL for a specific plugin ID.
 *
 * @param pluginId - The ID of the plugin.
 * @returns A Promise resolving to the documentation URL as a string, or null if not found.
 */
export async function pluginMeta_documentationUrlGet(pluginId: string): Promise<string | null> {
  const chrisPlugin: ChRISPlugin = new ChRISPlugin(); // Re-instantiate as it might not be shared
  const query: QueryHits | null = await chrisPlugin.pluginData_getFromSearch(
    { search: `id: ${pluginId}` }, // Assuming cumin can parse this search string
    'documentation'
  );
  if (!query || !query.hits.length) {
    return null;
  }
  return query.hits[0] as string;
}

/**
 * Retrieve a single plugin ID based on search options.
 *
 * This function performs a search for plugins using the provided criteria and
 * returns the ID of the first matching plugin.
 *
 * @param options - An object containing search parameters (e.g., name, id).
 * @returns A Promise resolving to a plugin ID string, or null if no plugin is found or if the search is ambiguous (multiple results).
 */
export async function pluginMeta_pluginIDFromSearch(options: PluginSearchOptions): Promise<string | null> {
  const chrisPlugin: ChRISPlugin = new ChRISPlugin(); // Re-instantiate
  const queryHits: QueryHits | null = await chrisPlugin.pluginData_getFromSearch(options, ['id', 'name', 'version']);
  if (queryHits && queryHits.hits.length === 1) { // Assuming we want a single, unambiguous result
    return (queryHits.hits[0] as Dictionary).id as string;
  } else if (queryHits && queryHits.hits.length > 1) {
    // Optionally log a warning about ambiguity, but for library, just return null or throw.
    const found: string = queryHits.hits.map(h => {
      const plugin: Dictionary = h as Dictionary;
      const byId: string = `"id:${plugin.id}"`;
      const byNameAndVersion: string = `"name_exact:${plugin.name},version:${plugin.version}"`;
      return `- ${byNameAndVersion} -OR- ${byId}`;
    }).join('\n');
    errorStack.stack_push('warning', `Multiple plugins found for search "${options.search}" -- try:\n${found}\nPlease be more specific.`);
    return null; // Return null for ambiguous search results
  }
  return null;
}

/**
 * Delete a plugin by its ID.
 *
 * @param id - The ID of the plugin to delete.
 * @returns A Promise resolving to true on success, false on failure.
 */
export async function plugin_delete(id: number): Promise<boolean> {
  const pluginGroup: ChRISPluginGroup = new ChRISPluginGroup();

  if (!pluginGroup) {
    return false;
  }

  return await pluginGroup.asset.resourceItem_delete(id);
}

/**
 * Provides an overview of plugin operations.
 * Currently a placeholder.
 *
 * @returns A Promise resolving to void.
 */
export async function plugins_overview(): Promise<void> {
  return Promise.resolve();
}

/**
 * Fetch the README for a plugin given its ID.
 *
 * @param pluginId - The ID of the plugin.
 * @returns A Promise resolving to the README content or null.
 */
export async function plugin_readme(pluginId: string): Promise<string | null> {
  const document: PluginReadmeDocument | null = await pluginReadmeDocument_fetch(pluginId);
  return document?.content ?? null;
}

// Re-export other utility functions or classes if needed, following the RPN style.
export * from './plugin_register.js';
export * from './peer_search.js';
export * from './store_import.js';
export * from './plugin_executeInPlace.js';
export * from './plugin_add.js';
export * from './plugin_docker.js';
export * from './plugin_index.js';
export * from './plugin_sync.js';
export * from './plugin_validate.js';
export * from './pool.js';
export * from './tar_read.js';
