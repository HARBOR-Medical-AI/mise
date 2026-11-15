/**
 * @file What a ChRIS session adds to completion: its plugins as command
 * words, and the names completed at `/`. A `/bin` line's options and
 * operands complete from its declaration, made from CUBE's parameters
 * (`binDeclarations.ts`), as a builtin's line completes from its own.
 *
 * Key components:
 * - plugins_getNames: the plugins `/bin` lists, by their `/bin` names.
 * - binNames_list: every plugin and pipeline `/bin` lists.
 * - chrisCompletion: what the backend adds to completion.
 *
 * @module
 */
import { plugins_listAll } from '@fnndsc/salsa';
import { listCache_get } from '@fnndsc/cumin';
import type { ListingItem } from '@fnndsc/menu';
import type { BackendCompletion } from '../core/backend.js';
import { vfs } from '../lib/vfs/vfs.js';

/**
 * Fetches available plugin names from /bin in the format: name-vVersion.
 * This matches the display format used in /bin listings.
 * Uses cache first for fast completion.
 *
 * @returns Array of plugin names with version suffixes.
 *
 * @example
 * ```ts
 * await plugins_getNames(); // ['pl-dircopy-v2.1.1', …]
 * ```
 */
export async function plugins_getNames(): Promise<string[]> {
  try {
    // Check cache first for /bin
    const listCache = listCache_get();
    const cached = listCache.cache_get<ListingItem[]>('/bin');

    if (cached && cached.data) {
      // Return cached plugin names immediately
      return cached.data.map((item: ListingItem) => item.name);
    }

    // Cache miss - fetch from API (only on first tab completion)
    const plugins = await plugins_listAll({});
    if (plugins && plugins.tableData) {
      const pluginNames: string[] = plugins.tableData.map((p: Record<string, unknown>) => {
        const name: string = typeof p.name === 'string' ? p.name : String(p.name ?? '');
        const version: string = typeof p.version === 'string' ? p.version : String(p.version ?? '');
        // Format as name-vVersion to match /bin display format
        return version ? `${name}-v${version}` : name;
      });

      // Cache it for next time
      const lsItems: ListingItem[] = plugins.tableData.map((p: Record<string, unknown>) => {
        const name: string = typeof p.name === 'string' ? p.name : String(p.name ?? '');
        const version: string = typeof p.version === 'string' ? p.version : String(p.version ?? '');
        return {
          name: version ? `${name}-v${version}` : name,
          type: 'plugin' as const,
          size: 0,
          owner: 'system',
          date: p.creation_date ? String(p.creation_date) : '',
        };
      });
      listCache.cache_set('/bin', lsItems);

      return pluginNames;
    }
  } catch {
    // Silently fail if plugins cannot be fetched
  }
  return [];
}

/**
 * The entries `/bin` lists of one type, by name.
 *
 * @param type - `plugin` or `pipeline`.
 * @returns The names; none when `/bin` cannot be read.
 *
 * @example
 * ```ts
 * await binEntries_list('pipeline'); // ['PHI_detection_id12', …]
 * ```
 */
export async function binEntries_list(type: 'plugin' | 'pipeline'): Promise<string[]> {
  try {
    const bin = await vfs.data_get('/bin');
    return bin.ok ? bin.value.filter((item: ListingItem): boolean => item.type === type).map((item: ListingItem): string => item.name) : [];
  } catch {
    return [];
  }
}

/**
 * Every word that runs a `/bin` entry: each plugin version and each
 * pipeline, by its `/bin` name.
 *
 * @returns The names.
 *
 * @example
 * ```ts
 * await binNames_list(); // ['pl-dircopy-v2.1.1', 'PHI_detection_id12', …]
 * ```
 */
export async function binNames_list(): Promise<string[]> {
  const [plugins, pipelines] = await Promise.all([plugins_getNames(), binEntries_list('pipeline')]);
  return [...new Set([...plugins, ...pipelines])];
}

/** What the ChRIS session adds to completion. */
export const chrisCompletion: BackendCompletion = {
  commandWords: plugins_getNames,
  rootWords: ['bin', 'usr'],
};
