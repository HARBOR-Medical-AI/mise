/**
 * @file Run a list of tasks a few at a time.
 *
 * Plugin uploads and registry lookups each run four at a time: enough to
 * finish 175 in seconds, few enough not to hammer a CUBE or a registry. Each
 * task's failure stays its own; the pool never stops early.
 *
 * Key components:
 * - POOL_WIDTH: the number of tasks run at once.
 * - items_mapPooled: map items through an async function, a few at a time, in order.
 *
 * Typical usage:
 * ```ts
 * const sizes: number[] = await items_mapPooled(urls, POOL_WIDTH, async (url: string): Promise<number> => size_get(url));
 * ```
 *
 * Dependencies: none.
 *
 * @module
 */

/** Tasks run at once by the plugin verbs. */
export const POOL_WIDTH: number = 4;

/**
 * Maps items through an async function, at most `width` at a time.
 *
 * Results come back in the items' order, whatever order the tasks finish in.
 * A task that throws is not caught here: map to a value that records the
 * failure when each failure must stay its own.
 *
 * A stop (the signal aborting) lets the tasks already running finish and
 * starts no more, so what was sent is all accounted for; the items never
 * started have no result.
 *
 * @param items - The items.
 * @param width - Tasks run at once; at least 1.
 * @param task - The work for one item.
 * @param signal - Stops the map; absent, it runs to the end.
 * @returns The started items' results, in the items' order: every item's
 *   unless stopped.
 *
 * @example
 * ```ts
 * await items_mapPooled([1, 2, 3], 2, async (n: number): Promise<number> => n * 2); // [2, 4, 6]
 * ```
 */
export async function items_mapPooled<T, R>(
  items: readonly T[],
  width: number,
  task: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next: number = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && signal?.aborted !== true) {
      const index: number = next;
      next += 1;
      results[index] = await task(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, worker));
  return results.slice(0, next);
}
