/**
 * @file The argument kinds a ChRIS session adds to the core's, registered
 * through the backend seam (`Backend.argumentKinds`): what its commands'
 * arguments are beyond words, numbers and paths.
 *
 * Key components:
 * - ANCHOR_KIND: an anchor of this session's berth, by name.
 * - chrisArgumentKinds: every kind the ChRIS backend registers.
 *
 * Typical usage:
 * ```ts
 * const backend: Backend = { …, argumentKinds: chrisArgumentKinds };
 * ```
 *
 * Dependencies: zod for the value schemas; the berth's state for an
 * anchor's completion.
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

/** Every argument kind the ChRIS backend registers. */
export const chrisArgumentKinds: ReadonlyArray<ArgumentKind> = [ANCHOR_KIND];
