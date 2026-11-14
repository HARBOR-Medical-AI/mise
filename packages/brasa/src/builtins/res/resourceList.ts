/**
 * @file What the resource commands share: the options of a CUBE listing
 * (`tags list --all --sort name`), the option bag chili's listings read, and
 * a second name for a command (`tags` beside `tag`).
 *
 * A resource command lists a CUBE collection page by page (`list`), filters
 * it (`search <field:value>`, which is `list --search`), and names its fields
 * (`inspect`): the Resource Contract (packages/chell/CONTEXT.md). Its
 * declaration spreads these options into its grammar, so every listing reads
 * them alike and refuses the same unknown option.
 *
 * Key components:
 * - RESOURCE_LIST_OPTIONS_GRAMMAR: the listing options, as grammar.
 * - ResourceListOptions: what a handler reads of them.
 * - resourceListBag_build: those options as the bag chili's listings read.
 *
 * Typical usage:
 * ```ts
 * const TAG_GRAMMAR = { options: { ...RESOURCE_LIST_OPTIONS_GRAMMAR }, … } as const satisfies CommandGrammar;
 * await tags_fetchList(resourceListBag_build(args.options));
 * ```
 *
 * Dependencies: types only.
 *
 * @module
 */
import type { CLIoptions } from '@fnndsc/chili/utils/cli.js';

import type { OptionsGrammar } from '../../core/commandDeclaration.js';

/** The options every resource listing reads: paging, columns, the filter, the order, and the shape. */
export const RESOURCE_LIST_OPTIONS_GRAMMAR = {
  all: { long: 'all', summary: 'Fetch every page' },
  limit: { long: 'limit', summary: 'Page size (default 20)', value: { name: 'n', kind: 'int', min: 1 } },
  offset: { long: 'offset', summary: 'Start this many rows in', value: { name: 'n', kind: 'int', min: 0 } },
  page: { long: 'page', summary: 'Page size, when --limit is not given', value: { name: 'n', kind: 'int', min: 1 } },
  fields: { long: 'fields', summary: 'The columns to show, comma-separated (inspect names them)', value: { name: 'field,…', kind: 'word' } },
  search: { long: 'search', summary: 'Filter by field:value, comma-separated (inspect names the fields)', value: { name: 'field:value', kind: 'word' } },
  sort: { long: 'sort', summary: 'Sort by a field', value: { name: 'field', kind: 'word' } },
  reverse: { long: 'reverse', summary: 'Reverse the sort' },
  table: { long: 'table', summary: 'Tabular output' },
  csv: { long: 'csv', summary: 'CSV output' },
} as const satisfies OptionsGrammar;

/** What a handler reads of the listing options. */
export interface ResourceListOptions {
  /** Fetch every page. */
  readonly all: boolean;
  /** Page size. */
  readonly limit: number | undefined;
  /** Rows skipped first. */
  readonly offset: number | undefined;
  /** Page size when no limit is given. */
  readonly page: number | undefined;
  /** The columns, comma-separated. */
  readonly fields: string | undefined;
  /** The filter, `field:value[,field:value]`. */
  readonly search: string | undefined;
  /** The field sorted by. */
  readonly sort: string | undefined;
  /** Reverse the sort. */
  readonly reverse: boolean;
  /** Tabular output. */
  readonly table: boolean;
  /** CSV output. */
  readonly csv: boolean;
}

/**
 * The listing options as the bag chili's listings read: only what the line
 * gave, a number as the word it was typed as. A search term, when given,
 * stands for `--search`, as `search <term>` is `list --search <term>`.
 *
 * @param options - The listing options read from the line.
 * @param search - The search term of `search <term>`, which replaces any `--search`.
 * @param extra - Further options the one listing reads (`feeds list --user`).
 * @returns The bag.
 *
 * @example
 * ```ts
 * resourceListBag_build({ ...noOptions, limit: 5, all: true }); // { limit: '5', all: true }
 * ```
 */
export function resourceListBag_build(options: ResourceListOptions, search?: string, extra: CLIoptions = {}): CLIoptions {
  const bag: CLIoptions = { ...extra };
  const switches: ReadonlyArray<'all' | 'reverse' | 'table' | 'csv'> = ['all', 'reverse', 'table', 'csv'];
  for (const name of switches) {
    if (options[name]) bag[name] = true;
  }
  const numbers: ReadonlyArray<'limit' | 'offset' | 'page'> = ['limit', 'offset', 'page'];
  for (const name of numbers) {
    const value: number | undefined = options[name];
    if (value !== undefined) bag[name] = String(value);
  }
  if (options.fields !== undefined) bag.fields = options.fields;
  if (options.sort !== undefined) bag.sort = options.sort;
  const filter: string | undefined = search ?? options.search;
  if (filter !== undefined) bag.search = filter;
  return bag;
}
