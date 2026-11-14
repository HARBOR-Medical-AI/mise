/**
 * @file Virtual File System Router.
 *
 * Handles path resolution and dispatching to the session's filesystem: the
 * backend's mounts and fallback, and the core's own (`/usr`).
 *
 * @module
 */
import { session } from '../../session/index.js';
import chalk from 'chalk';
import * as path from 'path';
import { ambient_publish, ambient_hasListeners } from '../../core/ambient.js';
import { type ListingItem, type CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { listingCache_get, listingCache_holds, vfsDispatcher_get } from '../../core/filesystem.js';
import { storePath_resolve } from '../../core/paths.js';
import type { ListingCache } from '../../core/backend.js';
import { spinner } from '../spinner.js';
import { error_stripDebugPrefix } from '../../core/errorText.js';
import { listingItemsFromVfs_make } from './listing.js';
import { Result, Ok, Err, errorStack, grid_render, long_render, listingItems_sort, type ListingLook } from '@fnndsc/fond';
import { itemType_isContainer, listingLook_get } from '../../core/itemKinds.js';
import { backendInstalled_get } from '../../core/backend.js';

/**
 * Virtual File System Router.
 * Dispatches operations to Virtual or Native providers.
 */
/**
 * A resolved directory listing with its freshness.
 *
 * @property path - The absolute path listed.
 * @property items - The entries.
 * @property fresh - True when current; false when served stale with a
 *   revalidation running behind it.
 */
export interface VfsListing {
  path: string;
  items: ListingItem[];
  fresh: boolean;
}

export class VFS {
  /**
   * Gets data for a directory (Virtual or Native).
   * Separated from rendering to allow Result<T> pattern.
   *
   * @param targetPath - The path to get data for. If empty, uses CWD.
   * @param options - Options including directory flag and sort.
   * @returns Result<ListingItem[]> - Ok with items or Err with error message.
   */
  async data_get(targetPath?: string, options: { sort?: 'name' | 'size' | 'date' | 'owner', reverse?: boolean, directory?: boolean } = {}): Promise<Result<ListingItem[]>> {
    const resolved: Result<VfsListing> = await this.listing_get(targetPath, options);
    return resolved.ok ? Ok(resolved.value.items) : Err();
  }

  /** Background revalidations in flight, one per path. */
  private revalidating: Map<string, Promise<void>> = new Map();

  /**
   * Re-fetches one listing behind a stale serve and publishes the fresh
   * result as an ambient `fs.listing` envelope, so every surface showing
   * that path repaints. One fetch per path at a time.
   *
   * @param effectivePath - The absolute path to refresh.
   */
  private listing_revalidate(effectivePath: string): Promise<void> {
    const inflight: Promise<void> | undefined = this.revalidating.get(effectivePath);
    if (inflight) return inflight;
    const run: Promise<void> = (async (): Promise<void> => {
      // A change while this read is out (an rm, an upload) makes what it
      // brings back the folder as it was: the cache does not keep it.
      const since: number | undefined = listingCache_get().stamp_take?.();
      const fetched = await vfsDispatcher_get().list(await storePath_resolve(effectivePath), {});
      if (!fetched.ok) return;
      const items: ListingItem[] = listingItemsFromVfs_make(fetched.value);
      if (since === undefined) listingCache_get().cache_set(effectivePath, items);
      else listingCache_get().cache_set(effectivePath, items, { since });
      ambient_publish({
        kind: 'envelope',
        envelope: { status: 'ok', rendered: '', model: { kind: 'fs.listing', data: [{ path: effectivePath, items, fresh: true }] } },
      });
    })()
      .catch((): void => { /* the stale listing stands until the next visit */ })
      .finally((): void => { this.revalidating.delete(effectivePath); });
    this.revalidating.set(effectivePath, run);
    return run;
  }

  /**
   * Resolves a directory listing with its freshness. A fresh cached
   * listing is served as is. A stale one is served at once only when a
   * host can carry the refresh (an ambient listener exists — the daemon),
   * with the revalidation running behind it; at a plain console the stale
   * entry is refetched in line, because nobody would deliver the refresh.
   * `/proc` paths never touch this cache.
   *
   * @param targetPath - The path to list; the working directory when empty.
   * @param options - Sort and `-d` options.
   * @returns The listing, its absolute path, and whether it is current.
   */
  async listing_get(targetPath?: string, options: { sort?: 'name' | 'size' | 'date' | 'owner', reverse?: boolean, directory?: boolean } = {}): Promise<Result<VfsListing>> {
    try {
      const cwd: string = await session.getCWD();
      const effectivePath: string = targetPath
        ? path.posix.resolve(cwd, targetPath)
        : cwd;

      // -d: show the target entry itself rather than descending into it
      if (options.directory && targetPath) {
        const entry: Result<ListingItem[]> = await this.directoryEntry_get(effectivePath, options);
        return entry.ok ? Ok({ path: effectivePath, items: entry.value, fresh: true }) : Err();
      }

      // A path the backend keeps its own freshness for (ChRIS: /proc) skips
      // the listing cache entirely, so its refreshes and live reads show.
      const cacheable: boolean = listingCache_holds(effectivePath);

      // Check cache first
      const listCache: ListingCache = listingCache_get();
      if (cacheable) {
        const cached = listCache.cache_get<ListingItem[]>(effectivePath);
        if (cached && (cached.fresh || ambient_hasListeners())) {
          if (!cached.fresh) void this.listing_revalidate(effectivePath);
          const sortField: 'name' | 'size' | 'date' | 'owner' = options.sort || 'name';
          const sortedItems: ListingItem[] = listingItems_sort(cached.data, sortField, options.reverse);
          return Ok({ path: effectivePath, items: sortedItems, fresh: cached.fresh });
        }

        // Shell wildcard expansion reads and caches the parent directory before
        // passing each matched path to ls. Leaf entries are not directories to
        // descend into, so return the matching cached entry itself.
        const parentLeaf: ListingItem | null = this.leafFromParentCache_get(effectivePath);
        if (parentLeaf) {
          return Ok({ path: effectivePath, items: [parentLeaf], fresh: true });
        }
      }

      // Delegate path queries to the unified vfsDispatcher (which handles both virtual and native paths)
      const beforeList: number = errorStack.checkpoint_mark();
      const since: number | undefined = listCache.stamp_take?.();
      // Listed where the store keeps it (a /proc data path, a link); kept and said under the name asked.
      const vfsResult = await vfsDispatcher_get().list(await storePath_resolve(effectivePath), options);
      if (vfsResult.ok) {
        const items: ListingItem[] = listingItemsFromVfs_make(vfsResult.value);

        // Cache the results, where the backend lets them be kept, unless a
        // change to the folder landed while they were being read.
        if (cacheable) {
          if (since === undefined) listCache.cache_set(effectivePath, items);
          else listCache.cache_set(effectivePath, items, { since });
        }

        return Ok({ path: effectivePath, items, fresh: true });
      }

      // `ls FILE` names the file, as POSIX ls does: a path that will not
      // list as a folder is looked for in its parent, and an entry that is
      // not a folder is the answer. The failed listing's complaint goes with
      // it; a path the parent does not hold still fails as it did.
      const entry: ListingItem | null = await this.entryFromParent_fetch(effectivePath);
      if (entry !== null) {
        errorStack.checkpoint_drain(beforeList);
        return Ok({ path: effectivePath, items: [entry], fresh: true });
      }
      return Err();
    } catch (error: unknown) {
      const errorMsg: string = error instanceof Error ? error.message : String(error);
      errorStack.stack_push("error", `Failed to get directory data: ${errorMsg}`);
      return Err();
    }
  }

  /**
   * Returns the directory entry for `absolutePath` itself (not its contents).
   * Looks up the entry in the parent's listing — used to implement `ls -d`.
   *
   * @param absolutePath - The fully resolved path of the target.
   * @param options - Sort options forwarded to the parent listing.
   */
  private async directoryEntry_get(
    absolutePath: string,
    options: { sort?: 'name' | 'size' | 'date' | 'owner'; reverse?: boolean },
  ): Promise<Result<ListingItem[]>> {
    const baseName: string = path.posix.basename(absolutePath);
    const parentPath: string = path.posix.dirname(absolutePath);

    if (!baseName || absolutePath === '/') {
      return Ok([{ name: '/', type: 'vfs', size: 0, owner: 'root', date: '' }]);
    }

    // Fetch parent listing (use cache when available)
    const listCache: ListingCache = listingCache_get();
    let parentItems: ListingItem[] | null = null;

    const cached = listCache.cache_get<ListingItem[]>(parentPath);
    if (cached) {
      parentItems = cached.data;
    } else {
      // The parent is read only to find one name; what it could not read is not this answer's.
      const parentMark: number = errorStack.checkpoint_mark();
      const parentResult = await vfsDispatcher_get().list(parentPath, options);
      errorStack.checkpoint_drain(parentMark);
      if (parentResult.ok) {
        parentItems = listingItemsFromVfs_make(parentResult.value);
        listCache.cache_set(parentPath, parentItems);
      }
    }

    if (parentItems) {
      const match: ListingItem | undefined = parentItems.find((item: ListingItem) => item.name === baseName);
      if (match) return Ok([match]);
    }

    // The parent does not name it. A path that lists is a folder all the
    // same (a mount the parent's listing does not show); one that does not
    // is not there, and saying so is the answer: a folder made up from the
    // path's name read as one that exists, to `ls -d` and to `du` alike.
    const mark: number = errorStack.checkpoint_mark();
    const itself = await vfsDispatcher_get().list(absolutePath, options);
    errorStack.checkpoint_drain(mark);
    if (itself.ok) {
      return Ok([{ name: baseName, type: 'dir', size: 0, owner: 'system', date: '' }]);
    }
    errorStack.stack_push('error', `Cannot list ${absolutePath}: No such file or directory`);
    return Err();
  }

  /**
   * Finds a path's own entry in its parent's listing, read afresh when it is
   * not kept: the answer to `ls FILE` when the path does not list as a
   * folder.
   *
   * @param absolutePath - The path that did not list.
   * @returns Its entry when the parent holds it and it is not a folder, else null.
   */
  private async entryFromParent_fetch(absolutePath: string): Promise<ListingItem | null> {
    if (absolutePath === '/') return null;
    const baseName: string = path.posix.basename(absolutePath);
    const parentPath: string = path.posix.dirname(absolutePath);
    let parentItems: ListingItem[] | null = listingCache_get().cache_get<ListingItem[]>(parentPath)?.data ?? null;
    if (parentItems === null) {
      const parentMark: number = errorStack.checkpoint_mark();
      const parent = await vfsDispatcher_get().list(parentPath, {});
      // The parent was only asked to find one name; what it could not read is not this listing's.
      errorStack.checkpoint_drain(parentMark);
      if (!parent.ok) return null;
      parentItems = listingItemsFromVfs_make(parent.value);
      if (listingCache_holds(parentPath)) listingCache_get().cache_set(parentPath, parentItems);
    }
    const item: ListingItem | undefined = parentItems.find((candidate: ListingItem): boolean => candidate.name === baseName);
    if (!item || itemType_isContainer(item.type)) return null;
    return item;
  }

  /**
   * Finds a non-directory target in its cached parent listing.
   *
   * @param absolutePath - Absolute path whose parent was previously listed.
   * @returns The matching leaf item, or null when absent or directory-like.
   */
  private leafFromParentCache_get(absolutePath: string): ListingItem | null {
    const baseName: string = path.posix.basename(absolutePath);
    const parentPath: string = path.posix.dirname(absolutePath);
    const cached = listingCache_get().cache_get<ListingItem[]>(parentPath);
    if (!cached) return null;

    const item: ListingItem | undefined = cached.data.find(
      (candidate: ListingItem): boolean => candidate.name === baseName,
    );
    // A link is not a leaf: plain `ls` follows a link to a directory (POSIX),
    // so it must fall through to the dispatcher, whose PathMapper resolves
    // the target. Returning the link entry here rendered `ls ~/public` as
    // the link itself whenever the parent listing happened to be cached.
    if (!item || itemType_isContainer(item.type) || item.type === 'link') {
      return null;
    }
    return item;
  }

  /**
   * List contents of a directory (Virtual or Native).
   * Convenience method that fetches data and renders it.
   * Implements optimistic rendering with progress feedback:
   * - Stale cache: serve immediately with "(cached, refreshing...)" indicator
   * - Cache miss: show "Fetching..." after 500ms if still loading
   *
   * @param targetPath - The path to list. If empty, uses CWD.
   * @param options - Listing options (long, human, sort, reverse, directory).
   */
  async list(targetPath?: string, options: { long?: boolean, human?: boolean, oneColumn?: boolean, sort?: 'name' | 'size' | 'date' | 'owner', reverse?: boolean, directory?: boolean } = {}, kept?: { listing?: VfsListing }): Promise<CommandEnvelope> {
    // Resolve effective path for cache checking
    const cwd: string = await session.getCWD();
    const effectivePath: string = targetPath
      ? path.posix.resolve(cwd, targetPath)
      : cwd;

    // A cache miss will wait on the wire; a stale entry may be served at
    // once (listing_get decides, and revalidates behind it where a host can
    // carry the refresh).
    const isCacheMiss: boolean = !listingCache_get().cache_get(effectivePath);

    // For cache miss, show loading indicator after 500ms timeout
    let spinnerStarted: boolean = false; // Flag to track if spinner was actually started
    let spinnerDelayTimeout: NodeJS.Timeout | null = null;

    if (isCacheMiss) {
      spinnerDelayTimeout = setTimeout(() => {
        spinner.start('Fetching directory from remote', true); // The spinner message with timing
        spinnerStarted = true;
      }, 500);
    }

    // Only this listing's walk may name a parent whose links went unchecked.
    const unreadLinks_take = async (): Promise<string[]> => (await backendInstalled_get()?.vfs?.unreadLinks_take?.()) ?? [];
    await unreadLinks_take();

    // Fetch data (may be from cache)
    const listing: Result<VfsListing> = await this.listing_get(targetPath, options);
    // The caller that wants the entries too takes them here, not by a second
    // read: a path the cache never holds (/proc) would be asked of CUBE again.
    if (kept !== undefined && listing.ok) kept.listing = listing.value;
    const blindParents: string[] = await unreadLinks_take();
    const result: Result<ListingItem[]> = listing.ok ? Ok(listing.value.items) : Err();

    // Clear loading timeout and indicator
    if (spinnerDelayTimeout) {
      clearTimeout(spinnerDelayTimeout);
    }
    if (spinnerStarted) {
      spinner.stop();
    }

    if (!result.ok) {
      const lastError = errorStack.stack_pop();
      let renderedErr: string = lastError ? `${chalk.red(error_stripDebugPrefix(lastError.message))}\n` : '';
      // The walk to this path passed a folder whose links this identity may
      // not read (a shared feed's owner's home): a link there was not seen,
      // and may be why the path is not where the walk looked.
      for (const parent of blindParents) {
        renderedErr += `${chalk.yellow(`ls: links in '${parent}' could not be read; the path was walked as written`)}\n`;
      }
      return envelope_error('', undefined, renderedErr);
    }

    // A listing that could not read part of what it holds says so, and
    // still shows what it read: the provider names the sub-resource that
    // failed, and that reason travels with the answer rather than being
    // dropped for looking like success (#462).
    const unread: string[] = errorStack.stack_search('Cannot fully list');
    const partial: string = unread.length === 0
      ? ''
      : `${chalk.yellow(error_stripDebugPrefix(unread[unread.length - 1] ?? ''))}\n`;

    if (result.value.length === 0) {
      return partial === '' ? envelope_ok('') : envelope_error('', undefined, partial);
    }

    // Render based on options. A long listing over feeds shows their tags:
    // one map for the whole listing, never a read per feed.
    const look: ListingLook = listingLook_get();
    let rendered: string = options.long
      ? `${long_render(await longRows_annotate(result.value), { human: !!options.human }, look)}\n`
      : `${grid_render(result.value, { oneColumn: !!options.oneColumn }, look)}\n`;

    // Served stale: say so. The refresh is already running behind this
    // answer and reaches every surface as an ambient listing.
    if (listing.ok && !listing.value.fresh) {
      rendered += `${chalk.gray('(cached, refreshing...)')}\n`;
    }

    if (partial !== '') {
      const envelope: CommandEnvelope = envelope_error(rendered, undefined, partial);
      return envelope;
    }
    return envelope_ok(rendered);
  }

  // Removed legacy virtual directory list helpers (fully unified under StaticVfsProvider and VFSDispatcher)
}

/**
 * Shared VFS singleton.
 */
export const vfs: VFS = new VFS();

/**
 * What a long listing's rows carry beyond the listing, from the backend
 * (ChRIS: a feed's tags).
 *
 * @param items - The rows.
 * @returns The rows, annotated.
 */
async function longRows_annotate(items: ListingItem[]): Promise<ListingItem[]> {
  const annotate: ((rows: ListingItem[]) => Promise<ListingItem[]>) | undefined = backendInstalled_get()?.vfs?.longRows_annotate;
  return annotate === undefined ? items : await annotate(items);
}
