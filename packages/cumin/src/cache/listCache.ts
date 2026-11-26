/**
 * @file Enhanced Directory Listing Cache with TTL and dirty tracking.
 *
 * Provides a singleton cache for directory listings to avoid redundant API calls
 * during tab completion and file operations. Features:
 * - TTL-based expiration (different TTLs per path pattern)
 * - Dirty flag tracking (local mutations mark cache as needing refresh)
 * - LRU eviction (bounded memory usage)
 * - Optimistic serving (serve stale cache while refreshing)
 *
 * Generic implementation - stores any data type keyed by path.
 *
 * @module
 */
import { identityCache_usable, identityChange_listen } from '../connect/identityEpoch';
import { errorStack } from '../error/errorStack';

/**
 * Lifetime for a path `/proc` reports movement on.
 *
 * Long by design: arrivals, departures and job completions mark these
 * dirty as they happen, so the clock is a backstop against a missed
 * notification rather than the mechanism.
 */
export const LIST_CACHE_SIGNAL_BACKED_TTL_MS: number = 60 * 60 * 1000;

/** Lifetime for a path nothing reports movement on. */
export const LIST_CACHE_SIGNAL_FREE_TTL_MS: number = 3 * 60 * 1000;

/**
 * Lifetime for the plugin and pipeline indexes.
 *
 * Registration is an administrative act on a CUBE, not something a
 * session causes, and it happens on a scale of months.
 */
export const LIST_CACHE_PLUGIN_INDEX_TTL_MS: number = 24 * 60 * 60 * 1000;

/** How many path listings the cache retains before evicting the oldest. */
export const LIST_CACHE_MAX_ENTRIES: number = 500;

/** How many folders' invalidations are remembered for fetches still in flight. */
export const LIST_CACHE_INVALIDATIONS_KEPT: number = 4096;

/**
 * Cache entry with metadata.
 */
interface CacheEntry<T = unknown> {
  /** The cached data (ListingItem[], plugin list, etc.) */
  data: T;

  /** Timestamp when cached (milliseconds since epoch) */
  timestamp: number;

  /** True if local mutation happened (rm, mkdir, touch, upload) */
  dirty: boolean;

  /** Time-to-live in milliseconds */
  ttl: number;
}

/**
 * Result returned by cache_get with freshness information.
 */
export interface CacheResult<T = unknown> {
  /** The cached data */
  data: T;

  /** True if within TTL and not dirty */
  fresh: boolean;

  /** Age in milliseconds */
  age: number;
}

/**
 * Options for cache_set.
 */
export interface CacheOptions {
  /** Override default TTL for this entry (milliseconds) */
  ttl?: number;

  /** Mark as dirty immediately */
  dirty?: boolean;

  /**
   * The `stamp_take()` taken before the listing was fetched. A listing
   * fetched before its folder (or a tree above it, or the whole cache) was
   * invalidated is not kept: it holds what the change took away.
   */
  since?: number;
}

/**
 * A persistence-safe copy of one cache entry.
 *
 * @property path - The listed path.
 * @property data - The cached listing.
 * @property timestamp - When it was cached (ms since epoch); age is judged
 *   against this on restore, so a restored entry is as stale as it really is.
 * @property dirty - Whether a local mutation invalidated it.
 * @property ttl - Its time-to-live in milliseconds.
 */
export interface ListCacheEntrySnapshot {
  path: string;
  data: unknown;
  timestamp: number;
  dirty: boolean;
  ttl: number;
}

/** The whole cache, oldest entry first (the LRU order). */
export interface ListCacheSnapshot {
  entries: ListCacheEntrySnapshot[];
}

/**
 * Statistics about cache usage.
 */
export interface CacheStats {
  /** Total number of cache hits (fresh). */
  hits: number;

  /** Total number of cache misses. */
  misses: number;

  /** Total number of stale hits (served but expired). */
  staleHits: number;

  /** Number of LRU evictions. */
  evictions: number;

  /** Number of entries currently in cache. */
  entries: number;

  /** Estimated total memory usage in bytes. */
  totalSize: number;

  /** Age of the oldest retained entry in milliseconds, or null when empty. */
  oldestAge: number | null;
}

/**
 * Spells a folder's path the one way its record is kept under: one leading
 * slash, none trailing. A caller that writes `home/a`, `/home/a` or
 * `/home/a/` means one folder, and is given, and drops, one record.
 *
 * @param path - The path as its caller spelled it.
 * @returns The path as records are keyed.
 *
 * @example
 * folderKey_spell('home/a/'); // '/home/a'
 */
export function folderKey_spell(path: string): string {
  return `/${path.replace(/^\/+|\/+$/g, '')}`;
}

/**
 * Singleton cache for directory listings with TTL and dirty tracking.
 *
 * Generic cache that stores any data type keyed by path. Eliminates redundant
 * API calls by caching directory contents after ls operations.
 *
 * Enhanced features:
 * - TTL-based expiration: Different paths have different TTLs
 * - Dirty flag tracking: Local mutations mark cache as needing refresh
 * - LRU eviction: Bounded memory usage
 * - Optimistic serving: Serve stale cache immediately, refresh in background
 *
 * Usage:
 * ```typescript
 * const cache = listCache_get();
 *
 * // Check cache (returns CacheResult with freshness info)
 * const cached = cache.cache_get("/PUBLIC");
 * if (cached) {
 *   console.log(cached.data);  // Show immediately
 *   if (!cached.fresh) {
 *     console.log('Refreshing...');
 *     // Fetch fresh data in background
 *   }
 * }
 *
 * // Store data
 * cache.cache_set("/PUBLIC", items);
 *
 * // Mark dirty after mutation
 * cache.cache_markDirty("/home/user");
 *
 * // Optimistic update
 * cache.cache_update("/home/user", (items) => items.filter(i => i.name !== 'deleted.txt'));
 * ```
 */
export class ListCache {
  private static instance: ListCache;

  /** Cache storage: path → entry. */
  private cache: Map<string, CacheEntry<unknown>> = new Map();

  /** Maximum cache entries (LRU eviction). */
  private maxEntries: number = LIST_CACHE_MAX_ENTRIES;

  /** Lifetime for a path no configured prefix covers. */
  private defaultTTL: number = LIST_CACHE_SIGNAL_FREE_TTL_MS;

  /**
   * Prefix-keyed lifetimes, longest prefix winning.
   *
   * A path is governed by a signal or by a clock, never argued over by
   * both. Where `/proc` reports movement, the clock is only a backstop
   * against a missed notification and can be long. Where nothing reports,
   * a guess is all that is available and it stays short.
   */
  private ttlConfig: Map<string, number> = new Map([
    // Signal-covered: the roster and job-completion notifications decide
    // when these go stale (see listing_dirtyByFeed).
    ['/home', LIST_CACHE_SIGNAL_BACKED_TTL_MS],
    ['/SHARED', LIST_CACHE_SIGNAL_BACKED_TTL_MS],
    ['/PUBLIC', LIST_CACHE_SIGNAL_BACKED_TTL_MS],
    // Signal-free: nothing reports movement, so a clock is the only option.
    // Plugin registration is an administrative act on a scale of months,
    // so a day is closer to true than an hour; `refresh` is the escape
    // hatch when an operator knows a plugin was just registered.
    ['/bin', LIST_CACHE_PLUGIN_INDEX_TTL_MS],
    ['/usr/share', LIST_CACHE_PLUGIN_INDEX_TTL_MS],
    ['/PIPELINES', LIST_CACHE_PLUGIN_INDEX_TTL_MS],
  ]);

  /** Whether this session has already reported that the cache filled. */
  private evictionReported: boolean = false;

  /** Cache statistics. */
  private stats = {
    hits: 0,
    misses: 0,
    staleHits: 0,
    evictions: 0,
  };
  /** Listeners told after any mutation a persister would want to see. */
  private listeners: Set<() => void> = new Set();
  /**
   * The folder records CUBE answered for a path (`filebrowser/search?path=`),
   * kept beside the listings and dropped by the same invalidations. Three
   * callers resolved the same path independently on every navigation —
   * three identical requests — and the next visit asked again. The value
   * is the lookup's promise, so callers in flight together share one
   * request; a miss (null) or a failure is never kept.
   */
  private folders: Map<string, { promise: Promise<unknown>; timestamp: number; ttl: number; missed?: boolean }> = new Map();

  /**
   * Invalidations so far. A fetch takes the count before it asks CUBE; a
   * listing it brings back after the count moved past an invalidation of
   * its folder is the folder as it was before the change (an
   * `ls` that began before an `rm -r` wrote the removed folder back).
   */
  private invalidations: number = 0;

  /** The invalidation count when each folder was invalidated; a tree is keyed by its path and a trailing slash. */
  private invalidatedAt: Map<string, number> = new Map();

  /** The invalidation count when the whole cache was last cleared. */
  private clearedAt: number = 0;

  /**
   * Registers a callback for checkpoint-worthy mutations (set, update,
   * dirty, invalidate).
   *
   * @param listener - Callback invoked after a mutation.
   * @returns Function that unregisters the callback.
   */
  changeListener_add(listener: () => void): () => void {
    this.listeners.add(listener);
    return (): void => { this.listeners.delete(listener); };
  }

  private change_emit(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * Creates a persistence-safe copy of every entry, oldest first.
   *
   * @returns The snapshot.
   */
  snapshot_create(): ListCacheSnapshot {
    const entries: ListCacheEntrySnapshot[] = [];
    for (const [path, entry] of this.cache) {
      entries.push({ path, data: entry.data, timestamp: entry.timestamp, dirty: entry.dirty, ttl: entry.ttl });
    }
    return { entries };
  }

  /**
   * Merges a snapshot's entries into the cache, keeping their original
   * timestamps: what was stale stays stale and is revalidated on its next
   * visit. A path already cached in this process is newer than anything on
   * disk and is kept as is. Entries beyond the LRU bound are dropped
   * oldest-first.
   *
   * @param snapshot - A validated snapshot.
   */
  snapshot_restore(snapshot: ListCacheSnapshot): void {
    // A checkpoint is put back only by the session's own identity's work.
    if (!identityCache_usable()) return;
    const live: Map<string, CacheEntry<unknown>> = new Map(this.cache);
    this.cache.clear();
    for (const entry of snapshot.entries) {
      if (live.has(entry.path)) continue;
      this.cache.set(entry.path, { data: entry.data, timestamp: entry.timestamp, dirty: entry.dirty, ttl: entry.ttl });
    }
    for (const [path, entry] of live) this.cache.set(path, entry);
    this.evict_lru();
    this.change_emit();
  }

  /**
   * Private constructor to enforce singleton pattern.
   */
  private constructor() {}

  /**
   * Gets the singleton instance of ListCache.
   *
   * @returns The ListCache singleton instance.
   */
  static instance_get(): ListCache {
    if (!ListCache.instance) {
      const made: ListCache = new ListCache();
      ListCache.instance = made;
      // What is listed is what one identity sees: at a change of identity all of it goes.
      identityChange_listen((): void => { made.cache_invalidate(); });
    }
    return ListCache.instance;
  }

  /**
   * Retrieves data from cache with freshness information.
   *
   * @param path - The path to retrieve.
   * @returns CacheResult with freshness info, or null if not cached.
   */
  cache_get<T = unknown>(path: string): CacheResult<T> | null {
    // Work done as another user (a `sudo`), or begun before the identity changed, is answered by CUBE, not
    // by what the session's identity was shown.
    if (!identityCache_usable()) {
      this.stats.misses++;
      return null;
    }
    const entry: CacheEntry<unknown> | undefined = this.cache.get(path);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // LRU: Move to end (mark as recently used)
    this.cache.delete(path);
    this.cache.set(path, entry);

    // Calculate freshness
    const age: number = Date.now() - entry.timestamp;
    const fresh: boolean = !entry.dirty && age < entry.ttl;

    if (fresh) {
      this.stats.hits++;
    } else {
      this.stats.staleHits++;
    }

    return { data: entry.data as T, fresh, age };
  }

  /**
   * Stores data in cache with optional TTL override.
   *
   * @param path - The path to cache.
   * @param data - The data to cache.
   * @param options - Optional TTL and dirty flag.
   */
  cache_set<T = unknown>(path: string, data: T, options?: CacheOptions): void {
    // A listing fetched as another user, or by work begun under an identity since replaced, is its caller's
    // to use and is not kept: it is not what the identity now connected would be shown.
    if (!identityCache_usable()) return;
    if (options?.since !== undefined && this.stamp_isStale(path, options.since)) return;
    // LRU: If exists, delete and re-add (moves to end)
    if (this.cache.has(path)) {
      this.cache.delete(path);
    }

    const ttl: number = options?.ttl ?? this.ttl_get(path);

    this.cache.set(path, {
      data,
      timestamp: Date.now(),
      dirty: options?.dirty ?? false,
      ttl,
    });

    // LRU eviction if over limit
    this.evict_lru();
    this.change_emit();
  }

  /**
   * The invalidation count now, taken before a fetch and handed back to
   * `cache_set` as `since`.
   *
   * @returns A stamp.
   */
  stamp_take(): number {
    return this.invalidations;
  }

  /**
   * Records an invalidation, so a fetch that began before it is not kept.
   *
   * @param path - The folder, or undefined for the whole cache.
   * @param tree - Whether everything beneath the folder went too.
   */
  private invalidation_note(path: string | undefined, tree: boolean): void {
    this.invalidations += 1;
    // Kept bounded: past the cap, every fetch still in flight is treated as
    // stale, which costs a re-read and never keeps an old listing.
    if (path === undefined || this.invalidatedAt.size >= LIST_CACHE_INVALIDATIONS_KEPT) {
      this.invalidatedAt.clear();
      this.clearedAt = this.invalidations;
      if (path === undefined) return;
    }
    this.invalidatedAt.set(path, this.invalidations);
    if (tree) this.invalidatedAt.set(path.endsWith('/') ? path : `${path}/`, this.invalidations);
  }

  /**
   * Whether a listing fetched at a stamp was overtaken by an invalidation
   * of its folder, of a tree above it, or of the whole cache.
   *
   * @param path - The folder the listing is of.
   * @param since - The stamp taken before the fetch.
   * @returns True when the listing must not be kept.
   */
  private stamp_isStale(path: string, since: number): boolean {
    if (this.clearedAt > since) return true;
    if ((this.invalidatedAt.get(path) ?? 0) > since) return true;
    for (let at: string = path; ; ) {
      if ((this.invalidatedAt.get(at.endsWith('/') ? at : `${at}/`) ?? 0) > since) return true;
      const parent: string = at.slice(0, Math.max(at.lastIndexOf('/'), 0)) || '/';
      if (parent === at) return false;
      at = parent;
    }
  }

  /**
   * Every path the cache currently holds.
   *
   * Returned as a snapshot so a caller may mark or invalidate while
   * iterating without mutating the map underneath itself.
   *
   * @returns The cached paths, least recently used first.
   */
  paths_get(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Marks a cached path as dirty (needs refresh).
   * Used when local mutations might have changed the data.
   *
   * @param path - The path to mark dirty.
   */
  /**
   * The folder record kept for a path, while its listing's TTL holds.
   *
   * @param path - The folder's path.
   * @returns The lookup's promise, or null when none is kept or it expired.
   */
  folder_get(path: string): Promise<unknown> | null {
    if (!identityCache_usable()) return null;
    const key: string = folderKey_spell(path);
    const kept = this.folders.get(key);
    if (kept === undefined) return null;
    if (Date.now() - kept.timestamp > kept.ttl) {
      this.folders.delete(key);
      return null;
    }
    return kept.promise;
  }

  /**
   * Keeps a folder lookup for a path, under the listing's own TTL (one
   * clock). A lookup that rejects is forgotten as it settles: a failure is
   * not an answer. One that answers no folder is an answer and is kept like
   * any other: a shared feed's logical path has no folder of its own, and
   * every resolver, check and listing asked CUBE so again. A folder made
   * here invalidates its parent, which drops the misses kept for it and
   * every folder above; one made elsewhere is seen when the TTL runs out,
   * as a listing's change is.
   *
   * @param path - The folder's path.
   * @param promise - The lookup under way.
   */
  folder_set(path: string, promise: Promise<unknown>): void {
    if (!identityCache_usable()) return;
    // One record for a folder however its path was spelled, kept as long as its listing would be.
    const key: string = folderKey_spell(path);
    const record: { promise: Promise<unknown>; timestamp: number; ttl: number; missed?: boolean } = { promise, timestamp: Date.now(), ttl: this.ttl_get(key) };
    this.folders.set(key, record);
    promise.then(
      (folder: unknown): void => { if (folder === null || folder === undefined) record.missed = true; },
      (): void => { if (this.folders.get(key) === record) this.folders.delete(key); },
    );
  }

  /**
   * Drops the folder records a listing invalidation calls into question:
   * the path's own and everything beneath it (a removed or renamed entry
   * takes its subtree's records with it), and a miss kept for any folder
   * above it: a path changed here is there, so its ancestors are too
   * (`mkdir -p a/b` makes `a` without a word about it).
   *
   * @param path - The invalidated listing's path; omitted, every record.
   */
  private folders_drop(path?: string): void {
    if (path === undefined) { this.folders.clear(); return; }
    const own: string = folderKey_spell(path);
    this.folders.delete(own);
    const prefix: string = own.endsWith('/') ? own : `${own}/`;
    for (const [key, record] of this.folders) {
      if (key.startsWith(prefix)) this.folders.delete(key);
      else if (record.missed === true && (key === '/' || prefix.startsWith(`${key}/`))) this.folders.delete(key);
    }
  }

  /** How many folder records are kept (for a readout or a test). */
  folders_count(): number {
    return this.folders.size;
  }

  cache_markDirty(path: string): void {
    const entry: CacheEntry<unknown> | undefined = this.cache.get(path);
    if (entry) {
      entry.dirty = true;
      this.change_emit();
    }
  }

  /**
   * Optimistically updates cache after a mutation.
   * Example: After rm, remove item from parent directory cache.
   *
   * @param path - The parent directory path.
   * @param updater - Function to transform cached data.
   */
  cache_update<T = unknown>(path: string, updater: (data: T) => T): void {
    if (!identityCache_usable()) return;
    const entry: CacheEntry<unknown> | undefined = this.cache.get(path);
    if (entry) {
      entry.data = updater(entry.data as T);
      entry.timestamp = Date.now();  // Reset timestamp
      entry.dirty = false;            // Clean after update
      this.change_emit();
    }
  }

  /**
   * Invalidates cache for a specific path or clears entire cache.
   * Called by file operations that modify directory contents (mkdir, touch, rm, upload).
   *
   * @param path - Optional specific path to invalidate. If omitted, clears entire cache.
   */
  cache_invalidate(path?: string): void {
    this.invalidation_note(path, false);
    if (path !== undefined) {
      this.cache.delete(path);
    } else {
      this.cache.clear();
    }
    this.folders_drop(path);
    this.change_emit();
  }

  /**
   * Invalidates a path and every cached listing beneath it.
   * Called by operations that remove or replace an entire directory tree
   * (rm -r, a directory re-upload): nested listings cached before the
   * mutation would otherwise serve the old tree's contents until their TTL
   * expires, with no refresh hint.
   *
   * @param path - Root of the subtree to invalidate. The entry for the path
   *     itself is removed along with all entries under `path + '/'`.
   */
  cache_invalidateTree(path: string): void {
    this.invalidation_note(path, true);
    this.folders_drop(path);
    this.cache.delete(path);
    const prefix: string = path.endsWith("/") ? path : `${path}/`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
    this.change_emit();
  }

  /**
   * @deprecated Use cache without cwd tracking. Cache persists across navigation.
   * This method is kept for backward compatibility but does nothing.
   *
   * @param _newCwd - Ignored.
   */
  cwd_update(_newCwd: string): void {
    // No-op: Cache no longer flushes on directory change
    // Kept for backward compatibility during transition
  }

  /**
   * Gets TTL for a specific path based on configuration.
   *
   * @param path - The path to get TTL for.
   * @returns TTL in milliseconds.
   */
  private ttl_get(path: string): number {
    const exact: number | undefined = this.ttlConfig.get(path);
    if (exact !== undefined) return exact;

    // Longest matching prefix wins, so a deeper entry can override a
    // shallower one. Matching is on whole segments: `/bindings` must not
    // inherit `/bin`'s lifetime.
    let bestLength: number = -1;
    let bestTTL: number = this.defaultTTL;
    for (const [prefix, ttl] of this.ttlConfig) {
      if (!path.startsWith(prefix + '/')) continue;
      if (prefix.length > bestLength) {
        bestLength = prefix.length;
        bestTTL = ttl;
      }
    }
    return bestTTL;
  }

  /**
   * Evicts oldest entries if cache exceeds max size.
   */
  private evict_lru(): void {
    while (this.cache.size > this.maxEntries) {
      const oldestKey: string | undefined = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
        this.stats.evictions++;
        // An eviction is not an error, but it is worth knowing about: the
        // dropped listing also leaves the checkpoint, so a restart comes
        // back thinner than the session that wrote it. Said once, because
        // a session that crosses the cap will cross it repeatedly.
        if (!this.evictionReported) {
          this.evictionReported = true;
          errorStack.stack_push(
            'warning',
            `listing cache is full at ${this.maxEntries} paths; the least recently used listings are being dropped and will not survive to the next session`,
          );
        }
      } else {
        break;  // Should never happen, but safety check
      }
    }
  }

  /**
   * Gets cache statistics.
   *
   * @returns Cache statistics including hits, misses, and current state.
   */
  stats_get(): CacheStats {
    let totalSize: number = 0;
    let oldestTimestamp: number | null = null;
    for (const entry of this.cache.values()) {
      // Rough estimate: JSON string length
      totalSize += JSON.stringify(entry.data).length;
      if (oldestTimestamp === null || entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
      }
    }

    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      staleHits: this.stats.staleHits,
      evictions: this.stats.evictions,
      entries: this.cache.size,
      totalSize,
      oldestAge: oldestTimestamp === null ? null : Date.now() - oldestTimestamp,
    };
  }

  /**
   * Resets cache statistics.
   * Useful for testing and monitoring.
   */
  stats_reset(): void {
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.staleHits = 0;
    this.stats.evictions = 0;
    this.evictionReported = false;
  }
}

/**
 * Convenience function to get the ListCache singleton instance.
 *
 * @returns The ListCache singleton instance.
 */
export function listCache_get(): ListCache {
  return ListCache.instance_get();
}
