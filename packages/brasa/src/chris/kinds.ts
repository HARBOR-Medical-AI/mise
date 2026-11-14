/**
 * @file The argument kinds a ChRIS session adds to the core's, registered
 * through the backend seam (`Backend.argumentKinds`): what its commands'
 * arguments are beyond words, numbers and paths.
 *
 * Key components:
 * - ANCHOR_KIND: an anchor of this session's berth, by name.
 * - FEED_KIND: a feed, by id, feed_N or title.
 * - COMPUTE_KIND: a compute resource, by name.
 * - chrisArgumentKinds: every kind the ChRIS backend registers.
 *
 * Typical usage:
 * ```ts
 * const backend: Backend = { …, argumentKinds: chrisArgumentKinds };
 * ```
 *
 * Dependencies: zod for the value schemas; the berth's state for an
 * anchor's completion; the session's feed index and CUBE (loaded when a
 * word is completed) for a feed's and a compute resource's.
 *
 * @module
 */
import { z } from 'zod';

import { candidates_filter, type ArgumentCheck, type ArgumentKind } from '../core/argumentKinds.js';
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

/** Every argument kind the ChRIS backend registers. */
export const chrisArgumentKinds: ReadonlyArray<ArgumentKind> = [ANCHOR_KIND, FEED_KIND, COMPUTE_KIND];
