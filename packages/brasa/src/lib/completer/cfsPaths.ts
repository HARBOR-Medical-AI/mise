/**
 * @file Completion of a path in ChRIS's filesystem (CFS): the entries of the
 * folder a partial path names that start with its last part, read through
 * the session's filesystem and kept in the listing cache.
 *
 * Key components:
 * - cfsPaths_complete: the candidates for a partial path.
 *
 * Typical usage:
 * ```ts
 * const candidates: string[] = await cfsPaths_complete('~/uploads/sub');
 * ```
 *
 * Dependencies: the session's working directory and home, its filesystem
 * dispatcher and listing cache.
 *
 * @module
 */
import * as path from 'path';

import type { ListingItem } from '@fnndsc/menu';

import { session } from '../../session/index.js';
import { listingItemsFromVfs_make } from '../vfs/listing.js';
import { partialPath_split, completions_build } from './pathComplete.helpers.js';
import { backendInstalled_get, type ListingCache } from '../../core/backend.js';
import { listingCache_get, vfsDispatcher_get } from '../../core/filesystem.js';

/**
 * The entries of the folder a partial path names that start with its last
 * part, in the partial's own style (tilde or relative kept), a folder
 * ending in `/`.
 *
 * @param partial - The path typed so far.
 * @returns The candidates; none when the folder cannot be listed.
 *
 * @example
 * ```ts
 * await cfsPaths_complete('/home/mise-e2e/'); // ['/home/mise-e2e/feeds/', '/home/mise-e2e/uploads/', …]
 * ```
 */
export async function cfsPaths_complete(partial: string): Promise<string[]> {
  let effectivePartial: string = partial;

  if (partial.startsWith('~')) {
    const home: string = (await backendInstalled_get()?.session.home_get()) ?? '/';
    if (partial === '~' || partial === '~/') {
      effectivePartial = home + (partial.endsWith('/') ? '/' : '');
    } else if (partial.startsWith('~/')) {
      effectivePartial = path.posix.join(home, partial.substring(2));
    }
  }

  const { dirToList, prefix } = partialPath_split(effectivePartial);

  let absDirToList: string;
  if (dirToList.startsWith('/')) {
    absDirToList = dirToList;
  } else {
    const cwd: string = await session.getCWD();
    absDirToList = dirToList ? path.posix.resolve(cwd, dirToList) : cwd;
  }

  let items: ListingItem[] = [];
  const listCache: ListingCache = listingCache_get();

  const cached: { data: ListingItem[]; fresh: boolean } | null = listCache.cache_get<ListingItem[]>(absDirToList);
  if (cached) {
    items = cached.data;
  } else {
    try {
      // The session's filesystem answers every path: the backend's mounts and fallback, and the core's.
      const vfsResult = await vfsDispatcher_get().list(absDirToList);
      if (vfsResult.ok) {
        items = listingItemsFromVfs_make(vfsResult.value);
      }

      // Names completed at the root even when its listing lacks them.
      if (absDirToList === '/' || absDirToList === '') {
        const hasItem = (name: string): boolean => items.some((item: ListingItem): boolean => item.name === name);
        for (const name of backendInstalled_get()?.completion?.rootWords ?? ['usr']) {
          if (!hasItem(name)) {
            items.push({ name, type: 'vfs', size: 0, owner: 'root', date: new Date().toISOString() });
          }
        }
      }

      if (items.length > 0) {
        listCache.cache_set(absDirToList, items);
      }
    } catch {
      // A folder that cannot be listed (permissions, not a folder) completes nothing.
    }
  }

  // The partial's own style (tilde or relative) is kept, and a folder ends in "/".
  return completions_build(items, prefix, partial);
}
