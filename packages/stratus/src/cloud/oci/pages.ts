/**
 * @file Reading every page of an OCI list call.
 *
 * Every OCI list call answers one page and, when more follow, a token for
 * the next. A caller that reads `.items` of the first answer has read one
 * page, and a thing looked for on the second is taken as not there. Each
 * list call in this folder goes through `pages_drain`.
 *
 * Key components:
 * - Page: one page, as a list call answers it.
 * - pages_drain: every item of a paged list call.
 *
 * Typical usage:
 * ```ts
 * const zones = await pages_drain(async (page) => {
 *   const answer = await dnsClient.listZones({ compartmentId, page });
 *   return { items: answer.items, opcNextPage: answer.opcNextPage };
 * });
 * ```
 *
 * Dependencies: none; the SDK's clients are the caller's.
 *
 * @module
 */

/** A page of items and the token for the next, as every OCI list call answers. */
export interface Page<T> {
  /** The page's items. An answer without them is not an empty page: the walk fails on it. */
  readonly items: T[];
  /** The token of the next page; absent or empty on the last. */
  readonly opcNextPage?: string;
}

/**
 * Every item of a paged list call.
 *
 * @param page_get - Fetches one page, given the token of the previous (undefined first).
 * @returns Every item, in order.
 * @throws {Error} When a page carries no list of items.
 *
 * @example
 * ```ts
 * const all: string[] = await pages_drain(async (page) => ({ items: ['a'], opcNextPage: undefined }));
 * ```
 */
export async function pages_drain<T>(page_get: (page: string | undefined) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  let token: string | undefined = undefined;
  do {
    const page: Page<T> = await page_get(token);
    // The SDK gives an empty list for an empty page and leaves the list out
    // for an answer with no body. The second is not "nothing there": read
    // so, a vault or a compartment that exists would be made again.
    if (!Array.isArray(page.items)) throw new Error('a page of the cloud\'s answer carries no list of items');
    items.push(...page.items);
    token = page.opcNextPage === '' ? undefined : page.opcNextPage;
  } while (token !== undefined);
  return items;
}
