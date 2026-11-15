/**
 * @file The argument kinds a ChRIS session adds to the core's, registered
 * through the backend seam (`Backend.argumentKinds`): what its commands'
 * arguments are beyond words, numbers and paths.
 *
 * Key components:
 * - ANCHOR_KIND: an anchor of this session's berth, by name.
 * - FEED_KIND: a feed, by id, feed_N or title.
 * - COMPUTE_KIND: a compute resource, by name.
 * - CPU_KIND / MEMORY_KIND: a run's CPU and memory limits, as CUBE writes them.
 * - PACS_QUERY_KIND: a PACS query, by id, by path, or as a question.
 * - PLUGIN_KIND: a plugin, as `/bin` names a version of it.
 * - PIPELINE_KIND: a pipeline, by its name, id or `/bin` name.
 * - chrisArgumentKinds: every kind the ChRIS backend registers.
 *
 * Typical usage:
 * ```ts
 * const backend: Backend = { …, argumentKinds: chrisArgumentKinds };
 * ```
 *
 * Dependencies: zod for the value schemas; the berth's state for an
 * anchor's completion; the session's feed index and CUBE (loaded when a
 * word is completed) for a feed's and a compute resource's; the session's
 * PACS query index for a query's, loaded when asked.
 *
 * @module
 */
import { z } from 'zod';
import type { QueryIndexEntry } from '@fnndsc/cumin';
import type { Result } from '@fnndsc/fond';

import type { ShellWord } from '../lib/parser.js';
import { candidates_filter, type ArgumentCheck, type ArgumentExpansion, type ArgumentKind } from '../core/argumentKinds.js';
import { berthPlaces_read, berthState_read, type BerthAnchor, type BerthPlaces } from '../builtins/berth/berthState.js';

/**
 * An anchor of this session's berth, by its name: `berth drop <name>`,
 * `berth close --infeed <anchor>`. It completes from the berth's state; on a
 * host, with no berth, it completes nothing.
 */
export const ANCHOR_KIND: ArgumentKind = {
  name: 'anchor',
  summary: "the name of an anchor in this session's berth",
  word_read: (word: string): ArgumentCheck => (word === '' ? { ok: false, reason: 'an empty word names no anchor' } : { ok: true, value: word }),
  schema_make: (): z.ZodType => z.string().min(1),
  words_complete: async (partial: string): Promise<string[]> => {
    const places: BerthPlaces | null = berthPlaces_read();
    if (places === null) return [];
    return candidates_filter(berthState_read(places.anchors).anchors.map((anchor: BerthAnchor): string => anchor.name), partial);
  },
};

/**
 * A feed, as a line names it: its id, its `feed_N`, or a word of its title
 * (`feed tree Brain Run` names the feed titled so). It completes the
 * `feed_N` of every feed the session's index holds, or the ids when a digit
 * is typed; an index still warming completes what it holds so far.
 */
export const FEED_KIND: ArgumentKind = {
  name: 'feed',
  summary: 'a feed: its id, feed_N, or its title',
  word_read: (word: string): ArgumentCheck => (word === '' ? { ok: false, reason: 'an empty word names no feed' } : { ok: true, value: word }),
  schema_make: (): z.ZodType => z.string().min(1),
  words_complete: async (partial: string): Promise<string[]> => {
    const { procCache_get } = await import('@fnndsc/cumin');
    const ids: number[] = procCache_get().feedIDs_get().sort((a: number, b: number): number => b - a);
    const words: string[] = /^\d/.test(partial) ? ids.map((id: number): string => String(id)) : ids.map((id: number): string => `feed_${id}`);
    return candidates_filter(words, partial);
  },
};

/**
 * A compute resource registered with CUBE, by name, or several comma-separated
 * (`--compute host,moc`). It completes the names CUBE lists, after the last
 * comma typed.
 */
export const COMPUTE_KIND: ArgumentKind = {
  name: 'compute',
  summary: 'a compute resource registered with CUBE, or several comma-separated',
  word_read: (word: string): ArgumentCheck => (word === '' ? { ok: false, reason: 'an empty word names no compute resource' } : { ok: true, value: word }),
  schema_make: (): z.ZodType => z.string().min(1),
  words_complete: async (partial: string): Promise<string[]> => {
    const { computeResources_getAll } = await import('@fnndsc/cumin');
    const { errorStack } = await import('@fnndsc/fond');
    const checkpoint: number = errorStack.checkpoint_mark();
    const listed = await computeResources_getAll();
    // A completion that cannot read CUBE completes nothing, and says nothing.
    errorStack.checkpoint_drain(checkpoint);
    if (!listed.ok) return [];
    const head: string = partial.slice(0, partial.lastIndexOf(',') + 1);
    const names: string[] = listed.value.map((resource: { name: string }): string => `${head}${resource.name}`);
    return candidates_filter(names, partial);
  },
};

/**
 * A limit as CUBE writes it: a whole number above nought, bare or with one
 * of its units. Bare, it is a number (CUBE counts it in the field's own
 * unit); with a unit, the word as typed, which CUBE converts.
 *
 * @param word - The word.
 * @param units - The units CUBE takes after the number.
 * @param reason - What the word should be, for the refusal.
 * @returns The value, or why it is not one.
 */
function limit_read(word: string, units: readonly string[], reason: string): ArgumentCheck {
  const found: RegExpMatchArray | null = word.match(/^(\d+)([A-Za-z]*)$/);
  if (found === null || Number(found[1]) <= 0) return { ok: false, reason };
  if (found[2] === '') return { ok: true, value: Number(found[1]) };
  return units.includes(found[2] ?? '') ? { ok: true, value: word } : { ok: false, reason };
}

/**
 * A run's CPU limit, as CUBE's plugin instance takes it: millicores, `2000m`
 * or a bare `2000`.
 */
export const CPU_KIND: ArgumentKind = {
  name: 'cpu',
  summary: 'a CPU limit in millicores: 2000m, or 2000',
  word_read: (word: string): ArgumentCheck => limit_read(word, ['m'], 'millicores: 2000m, or 2000'),
  schema_make: (): z.ZodType => z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*m$/)]),
};

/**
 * A run's memory limit, as CUBE's plugin instance takes it: `512Mi`, `8Gi`,
 * or a bare number of MiB.
 */
export const MEMORY_KIND: ArgumentKind = {
  name: 'memory',
  summary: 'a memory limit: 512Mi, 8Gi, or a number of MiB',
  word_read: (word: string): ArgumentCheck => limit_read(word, ['Mi', 'Gi'], 'a memory size: 512Mi, 8Gi, or a number of MiB'),
  schema_make: (): z.ZodType => z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*(?:Mi|Gi)$/)]),
};

/** Where the PACS provider keeps its queries. */
const PACS_QUERIES_ROOT: string = '/net/pacs/queries/';

/** A query asked as a question, `Key:Value[,…]` or JSON, rather than named. */
const QUESTION_WORD: RegExp = /^(?:[A-Za-z][A-Za-z0-9]*:|\{)/;

/**
 * The queries the session's index holds, as the paths and ids that name
 * them. The index is the session's own record of what was asked; reading it
 * asks CUBE nothing.
 *
 * @returns The query folders under /net/pacs/queries, and the ids, each in the index's order.
 */
async function indexedQueries_list(): Promise<{ paths: string[]; ids: string[] }> {
  const { queryIndex_get } = await import('@fnndsc/cumin');
  const { queryFolderName_build } = await import('@fnndsc/salsa');
  const entries: QueryIndexEntry[] = queryIndex_get().entries_all();
  return {
    paths: entries.map((entry: QueryIndexEntry): string => `${PACS_QUERIES_ROOT}${queryFolderName_build({ queryId: entry.queryId, queryObj: entry.criteria, username: entry.owner || undefined, hasResult: entry.hasResult })}/`),
    ids: entries.map((entry: QueryIndexEntry): string => String(entry.queryId)),
  };
}

/**
 * Completes a PACS query: its id from the index while digits are typed; its
 * folder under /net/pacs/queries from the index; a study or series inside
 * one as CFS lists it; nothing for a question being typed.
 *
 * @param partial - The word typed so far.
 * @returns The candidates.
 */
async function pacsQuery_complete(partial: string): Promise<string[]> {
  if (QUESTION_WORD.test(partial)) return [];
  if (/^\d+$/.test(partial)) return candidates_filter([...new Set((await indexedQueries_list()).ids)], partial);
  const inFolder: boolean = partial.startsWith(PACS_QUERIES_ROOT) && partial.indexOf('/', PACS_QUERIES_ROOT.length) !== -1;
  if (partial === '' || (partial.startsWith('/') && !inFolder)) {
    if (!PACS_QUERIES_ROOT.startsWith(partial) && !partial.startsWith(PACS_QUERIES_ROOT)) return [];
    return candidates_filter([...new Set((await indexedQueries_list()).paths)], partial);
  }
  const { cfsPaths_complete } = await import('../lib/completer/cfsPaths.js');
  return cfsPaths_complete(partial);
}

/**
 * A PACS query, as `pull`, `pacs pull` and `pacs status` take one: its id,
 * its path under /net/pacs/queries (or a study or series inside it), or a
 * question (`AccessionNumber:12345678`) that is asked first. It completes
 * from the session's query index; a path's wildcard is matched, a
 * question's is the PACS's to read.
 */
export const PACS_QUERY_KIND: ArgumentKind = {
  name: 'pacsQuery',
  summary: 'a PACS query: its id, its path under /net/pacs/queries, or a Key:Value question',
  path: true,
  word_read: (word: string): ArgumentCheck => (word === '' ? { ok: false, reason: 'an empty word names no query' } : { ok: true, value: word }),
  schema_make: (): z.ZodType => z.string().min(1),
  words_complete: pacsQuery_complete,
  words_expand: async (words: readonly ShellWord[]): Promise<ArgumentExpansion> => {
    const { shellWords_expand } = await import('../lib/wildcard.js');
    const { errorStack } = await import('@fnndsc/fond');
    const expanded: Result<ShellWord[]> = await shellWords_expand(words, (word: ShellWord): boolean => !QUESTION_WORD.test(word.value));
    if (expanded.ok) return { ok: true, words: expanded.value };
    return { ok: false, reason: errorStack.stack_pop()?.message ?? 'a wildcard could not be expanded' };
  },
};

/**
 * A plugin registered with CUBE, as `/bin` names a version of it
 * (`pl-dircopy-v2.1.1`), or by its name. It completes the versions `/bin`
 * lists.
 */
export const PLUGIN_KIND: ArgumentKind = {
  name: 'plugin',
  summary: 'a plugin: a version as /bin names it, <name>-v<version>, or its name',
  word_read: (word: string): ArgumentCheck => (word === '' ? { ok: false, reason: 'an empty word names no plugin' } : { ok: true, value: word }),
  schema_make: (): z.ZodType => z.string().min(1),
  words_complete: async (partial: string): Promise<string[]> => {
    const { binEntries_list } = await import('./completion.js');
    return candidates_filter(await binEntries_list('plugin'), partial);
  },
};

/**
 * A pipeline registered with CUBE: its name, its id, or its `/bin` name
 * (`PHI_detection_id12`). It completes the `/bin` names.
 */
export const PIPELINE_KIND: ArgumentKind = {
  name: 'pipeline',
  summary: 'a pipeline: its name, its id, or its /bin name',
  word_read: (word: string): ArgumentCheck => (word === '' ? { ok: false, reason: 'an empty word names no pipeline' } : { ok: true, value: word }),
  schema_make: (): z.ZodType => z.string().min(1),
  words_complete: async (partial: string): Promise<string[]> => {
    const { binEntries_list } = await import('./completion.js');
    return candidates_filter(await binEntries_list('pipeline'), partial);
  },
};

/** Every argument kind the ChRIS backend registers. */
export const chrisArgumentKinds: ReadonlyArray<ArgumentKind> = [ANCHOR_KIND, FEED_KIND, COMPUTE_KIND, CPU_KIND, MEMORY_KIND, PACS_QUERY_KIND, PLUGIN_KIND, PIPELINE_KIND];
