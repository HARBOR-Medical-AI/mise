/**
 * @file Shared test fixtures for cumin resource-spine tests.
 */

import { ListResource } from '@fnndsc/chrisapi';

/**
 * Builds a collection+json list response on ListResource.prototype so the
 * resource spine's instanceof narrowing accepts it. Own value properties
 * shadow the prototype's getter-only accessors.
 *
 * @param rows - Row objects; each becomes one collection item.
 * @param resourcePath - REST path segment used to fabricate item hrefs.
 * @returns A ListResource-compatible fixture.
 */
export function listResource_make(
  rows: Array<Record<string, unknown>>,
  resourcePath: string = 'resources',
  hasNext: boolean = false,
  totalCount?: number,
): ListResource {
  const list: ListResource = Object.create(ListResource.prototype) as ListResource;
  Object.defineProperties(list, {
    collection: {
      value: {
        // More follows when the page carries a link of rel `next`: that is
        // what CUBE sends and what the SDK's own `hasNextPage` reads.
        links: hasNext ? [{ rel: 'next', href: `https://cube/api/v1/${resourcePath}/?offset=${rows.length}` }] : [],
        items: rows.map((row: Record<string, unknown>) => ({
          data: Object.entries(row).map(([name, value]: [string, unknown]) => ({ name, value })),
          href: `https://cube/api/v1/${resourcePath}/${String(row.id)}/`,
          links: [],
        })),
      },
    },
    getItems: { value: (): unknown[] => rows.map(() => ({})) },
    totalCount: { value: totalCount ?? rows.length },
  });
  return list;
}
