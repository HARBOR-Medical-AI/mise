/**
 * @file The filesystem of a ChRIS session, as the core's listings read it:
 * salsa's dispatcher (CUBE's mounts, and `/bin` from `mounts.ts`), cumin's
 * listing cache, a feed's tags, and CUBE's link walk (salsa's path mapper),
 * which `storePath_resolve` asks for every file command.
 *
 * @module
 */
import { vfsDispatcher } from '@fnndsc/salsa';
import { listCache_get, feedTags_readByFeed } from '@fnndsc/cumin';
import { Result, errorStack } from '@fnndsc/fond';
import type { ListingItem } from '@fnndsc/menu';
import type { BackendFilesystem, ListingCache } from '../core/backend.js';
import { CHRIS_STRUCTURAL_PATHS, chrisFolder_enter, chrisSegment_title } from './navigation.js';

/**
 * Hangs each feed's tags on its row, for a long listing that holds feeds
 * (`feed_N` rows). A listing with no feed in it reads nothing; a map that
 * cannot be read leaves the rows as they were.
 *
 * @param items - The rows.
 * @returns The rows, feeds carrying their tags.
 */
async function feedTags_annotate(items: ListingItem[]): Promise<ListingItem[]> {
  const feedOf = (name: string): number | null => {
    const match: RegExpMatchArray | null = name.match(/^feed_(\d+)$/);
    return match === null ? null : Number(match[1]);
  };
  if (!items.some((item: ListingItem): boolean => feedOf(item.name) !== null)) return items;
  const map: Result<Map<number, string[]>> = await feedTags_readByFeed();
  if (!map.ok) {
    errorStack.stack_pop();
    return items;
  }
  return items.map((item: ListingItem): ListingItem => {
    const feedId: number | null = feedOf(item.name);
    const tags: string[] | undefined = feedId === null ? undefined : map.value.get(feedId);
    return tags === undefined ? item : { ...item, tags };
  });
}

/** The ChRIS session's filesystem. */
export const chrisFilesystem: BackendFilesystem = {
  dispatcher: vfsDispatcher,
  get cache(): ListingCache {
    return listCache_get();
  },
  // /proc is backed by the process cache, which keeps its own freshness.
  cache_holds: (path: string): boolean => !path.startsWith('/proc'),
  longRows_annotate: feedTags_annotate,
  // The link walk is read when a listing first asks, not with the backend.
  unreadLinks_take: async (): Promise<string[]> => (await import('@fnndsc/salsa')).pathMapper_get().blindParents_take(),
  structural: CHRIS_STRUCTURAL_PATHS,
  folder_enter: chrisFolder_enter,
  segment_title: chrisSegment_title,
  // CUBE's link walk (salsa): a path that does not resolve stands as asked.
  path_physical: async (path: string): Promise<string> => {
    const followed: Result<string> = await (await import('@fnndsc/salsa')).logicalPath_resolve(path);
    return followed.ok ? followed.value : path;
  },
};
