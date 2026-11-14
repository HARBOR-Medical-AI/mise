/**
 * @file Singleton path mapper for logical-to-physical ChRIS path resolution.
 *
 * Maintains a cached mapping of logical paths to physical locations,
 * enabling incremental resolution by reusing cached path prefixes.
 *
 * Example:
 *   - First call: '/home/user/public/feed_4' → Full resolution, cache prefix
 *   - Second call: '/home/user/public/feed_5' → Reuse '/home/user/public', resolve only 'feed_5'
 *
 * This eliminates redundant tree walking and API calls for paths with common prefixes.
 *
 * It is CUBE's own mechanics (a `.chrislink` is a file CUBE lists among a
 * folder's links), so it lives with the file reads. The kernel asks it
 * through one door: the ChRIS backend's link walk, which brasa's
 * `storePath_resolve` calls for every file command.
 *
 * @module
 */

import { Result, Ok, Err, errorStack, type StackMessage } from '@fnndsc/cumin';
import { files_listAll } from './index.js';
import * as path from 'path';
import { listCache_get } from '@fnndsc/cumin';

/**
 * Cached mapping entry with TTL metadata.
 */
interface CachedMapping {
  physicalPath: string;
  timestamp: number;
  ttl: number;
}

/**
 * Listing item from ChRIS filesystem.
 */
interface ListingItem {
  name: string;
  type?: string;
  target?: string;
  [key: string]: unknown;
}

/**
 * Statistics for cache performance monitoring.
 */
export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  hitRate: number;
}

/**
 * Result of finding the longest cached prefix for a logical path.
 */
interface PrefixMatch {
  prefixLogical: string;
  prefixPhysical: string;
  suffix: string;
}

/**
 * Singleton PathMapper class for logical-to-physical path resolution.
 *
 * Maintains hierarchical cache of path mappings to minimize repeated
 * link resolution operations.
 *
 * @example
 * ```typescript
 * const mapper = PathMapper.instance_get();
 *
 * // First resolution
 * const result1 = await mapper.logicalPath_resolve('/home/user/public/feed_4');
 * // → Resolves /home/user/public → /SHARED, then feed_4
 * // → Caches intermediate mappings
 *
 * // Second resolution - prefix reuse
 * const result2 = await mapper.logicalPath_resolve('/home/user/public/feed_5');
 * // → Reuses cached '/home/user/public' → '/SHARED'
 * // → Resolves only 'feed_5'
 * ```
 */
export class PathMapper {
  private static instance: PathMapper | null = null;
  private cache: Map<string, CachedMapping> = new Map();
  private readonly defaultTTL: number = 30000; // 30 seconds
  private stats: { hits: number; misses: number } = { hits: 0, misses: 0 };
  /** Walked paths whose parent could not be asked for links, by the parent. */
  private blind: Map<string, string> = new Map();
  /** Parents found blind by resolutions since the last {@link blindParents_take}. */
  private blindSeen: Set<string> = new Set();

  /**
   * Private constructor enforces singleton pattern.
   */
  private constructor() {}

  /**
   * Gets the singleton PathMapper instance.
   *
   * @returns The singleton PathMapper instance.
   */
  static instance_get(): PathMapper {
    if (!PathMapper.instance) {
      PathMapper.instance = new PathMapper();
    }
    return PathMapper.instance;
  }

  /**
   * Resets the singleton instance (for testing).
   *
   * @internal
   */
  static instance_reset(): void {
    PathMapper.instance = null;
  }

  /**
   * Resolves a logical path to its physical location.
   *
   * Uses cached path prefixes when available, resolving only the
   * uncached suffix to minimize API calls.
   *
   * @param logicalPath - The logical path to resolve.
   * @returns Result containing the physical path, or Err on failure.
   *
   * @example
   * ```typescript
   * const mapper = PathMapper.instance_get();
   *
   * // First call: full resolution
   * const result1 = await mapper.logicalPath_resolve('/home/user/public/feed_4');
   * // → Resolves /home/user/public → /SHARED, then feed_4
   * // → Caches: '/home/user/public' → '/SHARED'
   * // → Caches: '/home/user/public/feed_4' → '/SHARED/feed_4'
   *
   * // Second call: prefix reuse
   * const result2 = await mapper.logicalPath_resolve('/home/user/public/feed_5');
   * // → Reuses cached '/home/user/public' → '/SHARED'
   * // → Resolves only 'feed_5'
   * ```
   */
  async logicalPath_resolve(logicalPath: string): Promise<Result<string>> {
    // 1. Validate input
    if (!logicalPath || typeof logicalPath !== 'string') {
      errorStack.stack_push('error', 'Invalid path: path must be a non-empty string');
      return Err();
    }

    // 2. Normalize path
    const normalizedPath: string = logicalPath.startsWith('/')
      ? logicalPath
      : `/${logicalPath}`;

    // 3. Check exact cache hit
    const exactMatch: string | null = this.cache_get(normalizedPath);
    if (exactMatch !== null) {
      this.stats.hits++;
      this.blind_note(normalizedPath);
      return Ok(exactMatch);
    }

    // 4. Find longest cached prefix
    const prefixMatch: PrefixMatch = this.longestCachedPrefix_find(normalizedPath);

    // 5. Resolve suffix incrementally
    const resolvedPhysical: Result<string> = await this.suffix_resolve(
      prefixMatch.suffix,
      prefixMatch.prefixPhysical,
      prefixMatch.prefixLogical
    );

    this.blind_note(normalizedPath);
    if (!resolvedPhysical.ok) {
      this.stats.misses++;
      return Err();
    }

    // 6. Cache the full resolution
    this.cache_set(normalizedPath, resolvedPhysical.value);
    this.stats.misses++;

    return Ok(resolvedPhysical.value);
  }

  /**
   * Finds the longest cached prefix of a logical path.
   *
   * Walks up the path hierarchy to find the deepest cached mapping,
   * returning the cached physical prefix and remaining suffix.
   *
   * @param logicalPath - The full logical path.
   * @returns Object with cached prefix and remaining suffix.
   *
   * @example
   * ```typescript
   * // Cache contains: '/home/user/public' → '/SHARED'
   * const result = mapper.longestCachedPrefix_find('/home/user/public/feed_4/files');
   * // Returns:
   * // {
   * //   prefixLogical: '/home/user/public',
   * //   prefixPhysical: '/SHARED',
   * //   suffix: 'feed_4/files'
   * // }
   * ```
   */
  private longestCachedPrefix_find(logicalPath: string): PrefixMatch {
    const parts: string[] = logicalPath.split('/').filter((p: string) => p.length > 0);

    // Walk down from full path to root
    for (let i: number = parts.length; i >= 0; i--) {
      const candidatePrefix: string = i === 0
        ? '/'
        : '/' + parts.slice(0, i).join('/');

      const cached: string | null = this.cache_get(candidatePrefix);

      if (cached !== null) {
        const suffixParts: string[] = parts.slice(i);
        const suffix: string = suffixParts.join('/');

        return {
          prefixLogical: candidatePrefix,
          prefixPhysical: cached,
          suffix: suffix
        };
      }
    }

    // No cached prefix found, start from root
    return {
      prefixLogical: '/',
      prefixPhysical: '/',
      suffix: parts.join('/')
    };
  }

  /**
   * Resolves a path suffix by checking each component for links.
   *
   * Walks the suffix path, checking each component to see if it's a link.
   * Caches intermediate mappings along the way for future prefix reuse.
   *
   * @param suffix - The path suffix to resolve (e.g., 'feed_4/files').
   * @param physicalBase - The physical base path to build upon.
   * @param logicalBase - The logical base path (for caching intermediate results).
   * @returns Result containing the resolved physical path.
   */
  private async suffix_resolve(
    suffix: string,
    physicalBase: string,
    logicalBase: string
  ): Promise<Result<string>> {
    if (!suffix || suffix.length === 0) {
      return Ok(physicalBase);
    }

    const parts: string[] = suffix.split('/').filter((p: string) => p.length > 0);
    let physicalCurrent: string = physicalBase;
    let logicalCurrent: string = logicalBase;

    for (let i: number = 0; i < parts.length; i++) {
      const part: string = parts[i];

      const candidatePhysical: string = physicalCurrent === '/'
        ? `/${part}`
        : `${physicalCurrent}/${part}`;

      const candidateLogical: string = logicalCurrent === '/'
        ? `/${part}`
        : `${logicalCurrent}/${part}`;

      try {
        const linkTarget: string | null = await this.link_checkAndResolve(candidatePhysical, candidateLogical);

        if (linkTarget) {
          // It's a link! Jump to target
          physicalCurrent = linkTarget;
          logicalCurrent = candidateLogical;

          // Cache this intermediate mapping
          this.cache_set(candidateLogical, linkTarget);
        } else {
          // Not a link, continue building path
          physicalCurrent = candidatePhysical;
          logicalCurrent = candidateLogical;

          // Cache this intermediate mapping
          this.cache_set(candidateLogical, candidatePhysical);
        }
      } catch (error: unknown) {
        // Link resolution failed - log warning but continue
        const msg: string = error instanceof Error ? error.message : String(error);
        errorStack.stack_push(
          'warning',
          `Failed to check if '${candidatePhysical}' is a link: ${msg}. Treating as regular path.`
        );
        // Assume it's not a link and continue
        physicalCurrent = candidatePhysical;
        logicalCurrent = candidateLogical;
        this.cache_set(candidateLogical, candidatePhysical);
      }
    }

    return Ok(physicalCurrent);
  }

  /**
   * Checks if a path is a link and returns its target.
   *
   * Optimizes resolution by checking ListCache first. If the parent directory
   * is cached, we can determine if the candidate is a link without an API call.
   * Falls back to API (fetching all links in parent) if not cached.
   *
   * @param candidatePhysical - The physical path to check.
   * @param candidateLogical - The logical path (used for cache lookup).
   * @returns The link target if it's a link, null otherwise.
   */
  private async link_checkAndResolve(candidatePhysical: string, candidateLogical: string): Promise<string | null> {
    // 1. Fast Path: Check ListCache using logical path
    // If we have the parent directory cached, we can check if the item is a link there.
    const logicalParent: string = path.dirname(candidateLogical);
    const itemName: string = path.basename(candidateLogical);
    
    const listCache = listCache_get();
    const cached = listCache.cache_get(logicalParent);
    
    if (cached && cached.data && Array.isArray(cached.data)) {
      // Look for the item in the cached listing
      const item: ListingItem | undefined = (cached.data as ListingItem[]).find((i: ListingItem) => i.name === itemName);
      
      if (item) {
        // Item found in cache!
        if (item.type === 'link' && item.target) {
          return item.target;
        }
        // Found but not a link (or has no target) -> return null
        return null;
      }
      // Item not found in cache. 
      // It might be hidden or newly created. Fall back to API.
    }

    // 2. Slow Path: Check API using physical path
    const parts: string[] = candidatePhysical.split('/');
    parts.pop(); // Remove filename
    const parentDir: string = parts.join('/') || '/';

    const normalizedCandidate: string = candidatePhysical.startsWith('/')
      ? candidatePhysical
      : `/${candidatePhysical}`;

    // The probe is a side question: a parent this identity may not read (a
    // shared feed's owner's home, walked on the way to the feed) says so on
    // the error stack, and that refusal would mark the command it serves an
    // error though its answer came. The refusal is kept here instead: the
    // walk goes on as written, and a command whose answer then fails can say
    // which parent's links went unchecked (blindParents_take).
    const probeMark: number = errorStack.checkpoint_mark();
    const fetchOpts: Record<string, string | number> = { limit: 1000, offset: 0 };
    let linksResult: Awaited<ReturnType<typeof files_listAll>> = null;
    let refused: boolean = false;
    try {
      linksResult = await files_listAll(fetchOpts, 'links', parentDir);
    } catch {
      refused = true;
    }
    const said: StackMessage[] = errorStack.checkpoint_drain(probeMark);
    if (refused || (linksResult === null && said.some((message: StackMessage): boolean => message.type === 'error'))) {
      this.blind.set(candidateLogical, parentDir);
      return null;
    }
    this.blind.delete(candidateLogical);

    if (linksResult && linksResult.tableData) {
      for (const linkRaw of linksResult.tableData) {
        const linkFname: string = (linkRaw.fname as string) || '';
        const linkPath: string = (linkRaw.path as string) || '';

        const normalizedLinkFname: string = linkFname.startsWith('/')
          ? linkFname
          : `/${linkFname}`;

        if (normalizedLinkFname.endsWith('.chrislink')) {
          const logicalPath: string = normalizedLinkFname.slice(0, -10);

          if (logicalPath === normalizedCandidate) {
            const target: string = linkPath.startsWith('/') ? linkPath : `/${linkPath}`;
            return target;
          }
        }
      }
    }

    return null;
  }

  /**
   * Records the parents a resolution of this path walked past without
   * seeing their links.
   *
   * @param logicalPath - The path just resolved.
   */
  private blind_note(logicalPath: string): void {
    for (const [walked, parent] of this.blind) {
      if (logicalPath === walked || logicalPath.startsWith(walked + '/')) {
        this.blindSeen.add(parent);
      }
    }
  }

  /**
   * The parents whose links could not be read by the resolutions since the
   * last call, emptied by the call. A command whose answer failed reports
   * them: a link in one of them, had it been seen, would have led elsewhere.
   *
   * @returns The parents, in the order first met.
   */
  blindParents_take(): string[] {
    const parents: string[] = [...this.blindSeen];
    this.blindSeen.clear();
    return parents;
  }

  /**
   * Gets a cached mapping if it exists and hasn't expired.
   *
   * @param logicalPath - The logical path to look up.
   * @returns The cached physical path, or null if not cached or expired.
   */
  private cache_get(logicalPath: string): string | null {
    const cached: CachedMapping | undefined = this.cache.get(logicalPath);

    if (!cached) {
      return null;
    }

    const now: number = Date.now();
    const age: number = now - cached.timestamp;

    if (age > cached.ttl) {
      // Expired, remove from cache
      this.cache.delete(logicalPath);
      return null;
    }

    return cached.physicalPath;
  }

  /**
   * Caches a logical-to-physical path mapping.
   *
   * @param logicalPath - The logical path.
   * @param physicalPath - The corresponding physical path.
   * @param ttl - Optional TTL in milliseconds (defaults to 30s).
   */
  private cache_set(
    logicalPath: string,
    physicalPath: string,
    ttl: number = this.defaultTTL
  ): void {
    this.cache.set(logicalPath, {
      physicalPath,
      timestamp: Date.now(),
      ttl
    });
  }

  /**
   * Invalidates all cached mappings with a given logical path prefix.
   *
   * Call this when links are created/deleted/modified.
   *
   * @param logicalPathPrefix - The logical path prefix to invalidate.
   *
   * @example
   * ```typescript
   * // Link changed: /home/user/public → /SHARED becomes → /PUBLIC
   * mapper.cache_invalidate('/home/user/public');
   * // Invalidates:
   * //   - /home/user/public
   * //   - /home/user/public/feed_4
   * //   - /home/user/public/feed_5
   * //   - ... etc
   * ```
   */
  cache_invalidate(logicalPathPrefix: string): void {
    const keysToDelete: string[] = [];

    for (const [key] of this.cache) {
      if (key === logicalPathPrefix || key.startsWith(logicalPathPrefix + '/')) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
      this.blind.delete(key);
    }
  }

  /**
   * Clears all cached mappings.
   */
  cache_clear(): void {
    this.cache.clear();
    this.blind.clear();
    this.blindSeen.clear();
    this.stats = { hits: 0, misses: 0 };
  }

  /**
   * Gets cache statistics.
   *
   * @returns Cache statistics including hit rate and size.
   */
  stats_get(): CacheStats {
    const total: number = this.stats.hits + this.stats.misses;
    const hitRate: number = total === 0 ? 0 : this.stats.hits / total;

    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      size: this.cache.size,
      hitRate
    };
  }
}

/**
 * Convenience function to get the singleton PathMapper instance.
 *
 * @returns The singleton PathMapper instance.
 */
export function pathMapper_get(): PathMapper {
  return PathMapper.instance_get();
}

/**
 * Resolves a logical path to its physical path by following links.
 *
 * Delegates to the PathMapper singleton, which uses hierarchical caching to
 * optimize repeated resolutions with common prefixes.
 *
 * @param logicalPath - The logical (apparent) path the user sees/navigates.
 * @returns A Result containing the physical path, or Err if path is invalid.
 *
 * @example
 * ```ts
 * await logicalPath_resolve('/home/user/public/data'); // Ok('/PUBLIC/data') where public -> /PUBLIC
 * ```
 */
export async function logicalPath_resolve(logicalPath: string): Promise<Result<string>> {
  return pathMapper_get().logicalPath_resolve(logicalPath);
}

/**
 * Clears the path mapping cache. Useful when links are created/deleted.
 *
 * @example
 * ```ts
 * linkCache_clear();
 * ```
 */
export function linkCache_clear(): void {
  pathMapper_get().cache_clear();
}
