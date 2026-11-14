/**
 * @file A berth's places and its state file: where anchors and outgoing work
 * live, and what has been anchored there.
 *
 * A berth container names its two places in the environment:
 * `MISE_BERTH_ANCHORS` (where each anchor is downloaded, `/anchors`) and
 * `MISE_BERTH_OUTGOING` (the person's work to return, `/outgoing`). A session
 * without them runs on a host, not in a berth. The state is one JSON file in
 * the anchors place, `.berth.json`: every anchor with its ChRIS path, its node
 * and feed (or none), the files downloaded with their sizes, when it was
 * anchored, and when the berth last closed. It is written whole, to a
 * temporary file renamed over the old one, so a reader never sees half of it.
 *
 * Key components:
 * - BerthPlaces: the anchors and outgoing folders of a berth.
 * - BerthState, BerthAnchor, AnchoredFile: the state file's shape.
 * - berthPlaces_read: the places from the environment, or null on a host.
 * - berthState_read / berthState_write: read and write the state file.
 * - berthState_update: read, change and write the state in one step.
 *
 * Typical usage:
 * ```ts
 * const places: BerthPlaces | null = berthPlaces_read();
 * if (places !== null) {
 *   const state: BerthState = berthState_read(places.anchors);
 *   berthState_update(places.anchors, (now: BerthState): BerthState => ({ ...now, lastClosedAt: new Date().toISOString() }));
 * }
 * ```
 *
 * Dependencies: Node.js built-ins only. Times are ISO 8601 strings.
 *
 * @module
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The environment variable naming a berth's anchors folder. */
export const BERTH_ANCHORS_ENV: string = 'MISE_BERTH_ANCHORS';

/** The environment variable naming a berth's outgoing folder. */
export const BERTH_OUTGOING_ENV: string = 'MISE_BERTH_OUTGOING';

/** The state file's name, inside the anchors folder. */
export const BERTH_STATE_FILE: string = '.berth.json';

/** The state file's format version. */
const BERTH_STATE_VERSION: number = 1;

/**
 * The two places of a berth.
 *
 * @example
 * ```ts
 * const places: BerthPlaces = { anchors: '/anchors', outgoing: '/outgoing' };
 * ```
 */
export interface BerthPlaces {
  /** The folder each anchor is downloaded into, one folder per anchor. */
  readonly anchors: string;
  /** The folder the person's work is returned from. */
  readonly outgoing: string;
}

/**
 * One file an anchor downloaded.
 *
 * @example
 * ```ts
 * const file: AnchoredFile = { name: 'anat/t1.nii', size: 1024 };
 * ```
 */
export interface AnchoredFile {
  /** Its name relative to the anchor's folder, with `/` between parts. */
  readonly name: string;
  /** Its size in bytes, as ChRIS gave it. */
  readonly size: number;
}

/**
 * One anchor: a ChRIS path downloaded into the berth.
 *
 * @example
 * ```ts
 * const anchor: BerthAnchor = {
 *   name: 'sub-01', path: '/home/alice/feeds/feed_5/pl-dircopy_7/data/sub-01',
 *   node: 7, feed: 5, files: [{ name: 't1.nii', size: 1024 }], anchoredAt: '2026-11-13T10:00:00.000Z',
 * };
 * ```
 */
export interface BerthAnchor {
  /** Its name: the folder under the anchors place. */
  readonly name: string;
  /** The ChRIS path it was downloaded from, absolute. */
  readonly path: string;
  /** The plugin instance the path runs through, under the person's own feeds; null anywhere else. */
  readonly node: number | null;
  /** The feed of that node; null when there is no node. */
  readonly feed: number | null;
  /** Every file downloaded, for the close's check of a changed input. */
  readonly files: readonly AnchoredFile[];
  /** When it was downloaded. */
  readonly anchoredAt: string;
}

/**
 * A berth's state, as the state file holds it.
 *
 * @example
 * ```ts
 * const state: BerthState = { version: 1, anchors: [], lastClosedAt: null };
 * ```
 */
export interface BerthState {
  /** The file's format version. */
  readonly version: number;
  /** The anchors, in the order they were made. */
  readonly anchors: readonly BerthAnchor[];
  /** When the berth last closed; null when it never has. */
  readonly lastClosedAt: string | null;
}

/** A state file that cannot be read as a berth's state. */
export class BerthStateError extends Error {
  /**
   * @param file - The state file.
   * @param why - What is wrong with it.
   */
  constructor(file: string, why: string) {
    super(`${file}: ${why}`);
    this.name = 'BerthStateError';
  }
}

/**
 * The places of the berth this session runs in.
 *
 * @param env - The environment to read; the process's by default.
 * @returns Both places, or null when either is unset (the session runs on a host).
 *
 * @example
 * ```ts
 * berthPlaces_read({ MISE_BERTH_ANCHORS: '/anchors', MISE_BERTH_OUTGOING: '/outgoing' }); // { anchors: '/anchors', outgoing: '/outgoing' }
 * berthPlaces_read({}); // null
 * ```
 */
export function berthPlaces_read(env: NodeJS.ProcessEnv = process.env): BerthPlaces | null {
  const anchors: string | undefined = env[BERTH_ANCHORS_ENV];
  const outgoing: string | undefined = env[BERTH_OUTGOING_ENV];
  if (anchors === undefined || anchors === '' || outgoing === undefined || outgoing === '') return null;
  return { anchors, outgoing };
}

/**
 * A state with nothing in it: no anchor, never closed.
 *
 * @returns The empty state.
 */
function berthState_empty(): BerthState {
  return { version: BERTH_STATE_VERSION, anchors: [], lastClosedAt: null };
}

/**
 * Reads one anchored file from the state file's JSON.
 *
 * @param raw - The parsed value.
 * @param file - The state file, for the error.
 * @returns The file.
 * @throws {BerthStateError} When it is not a file entry.
 */
function anchoredFile_parse(raw: unknown, file: string): AnchoredFile {
  const entry: Record<string, unknown> = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof entry['name'] !== 'string' || typeof entry['size'] !== 'number') throw new BerthStateError(file, 'a file entry wants a name and a size');
  return { name: entry['name'], size: entry['size'] };
}

/**
 * Reads one anchor from the state file's JSON.
 *
 * @param raw - The parsed value.
 * @param file - The state file, for the error.
 * @returns The anchor.
 * @throws {BerthStateError} When it is not an anchor entry.
 */
function berthAnchor_parse(raw: unknown, file: string): BerthAnchor {
  const entry: Record<string, unknown> = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const node: unknown = entry['node'];
  const feed: unknown = entry['feed'];
  if (typeof entry['name'] !== 'string' || typeof entry['path'] !== 'string' || typeof entry['anchoredAt'] !== 'string'
    || !(node === null || typeof node === 'number') || !(feed === null || typeof feed === 'number') || !Array.isArray(entry['files'])) {
    throw new BerthStateError(file, 'an anchor wants a name, a path, a node, a feed, files and anchoredAt');
  }
  return {
    name: entry['name'],
    path: entry['path'],
    node,
    feed,
    files: (entry['files'] as unknown[]).map((one: unknown): AnchoredFile => anchoredFile_parse(one, file)),
    anchoredAt: entry['anchoredAt'],
  };
}

/**
 * Reads a berth's state file.
 *
 * @param anchorsDir - The berth's anchors folder.
 * @returns The state; the empty state when there is no file yet.
 * @throws {BerthStateError} When the file is there but is not a berth's state.
 *
 * @example
 * ```ts
 * const state: BerthState = berthState_read('/anchors');
 * state.anchors.map((anchor: BerthAnchor): string => anchor.name); // ['sub-01']
 * ```
 */
export function berthState_read(anchorsDir: string): BerthState {
  const file: string = join(anchorsDir, BERTH_STATE_FILE);
  if (!existsSync(file)) return berthState_empty();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error: unknown) {
    throw new BerthStateError(file, error instanceof Error ? error.message : String(error));
  }
  const raw: Record<string, unknown> = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const closed: unknown = raw['lastClosedAt'];
  if (!Array.isArray(raw['anchors']) || !(closed === null || closed === undefined || typeof closed === 'string')) {
    throw new BerthStateError(file, 'not a berth state (anchors, lastClosedAt)');
  }
  return {
    version: typeof raw['version'] === 'number' ? raw['version'] : BERTH_STATE_VERSION,
    anchors: (raw['anchors'] as unknown[]).map((one: unknown): BerthAnchor => berthAnchor_parse(one, file)),
    lastClosedAt: closed ?? null,
  };
}

/**
 * Writes a berth's state file whole: to a temporary file beside it, then
 * renamed over it, so a reader sees the old state or the new and never part.
 *
 * @param anchorsDir - The berth's anchors folder.
 * @param state - The state to write.
 *
 * @example
 * ```ts
 * berthState_write('/anchors', { version: 1, anchors: [], lastClosedAt: '2026-11-13T12:00:00.000Z' });
 * ```
 */
export function berthState_write(anchorsDir: string, state: BerthState): void {
  const file: string = join(anchorsDir, BERTH_STATE_FILE);
  const temporary: string = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...state, version: BERTH_STATE_VERSION }, null, 2)}\n`, { mode: 0o644 });
  renameSync(temporary, file);
}

/**
 * Reads the state, changes it and writes it, with nothing between the read
 * and the write: the steps are synchronous, so two lines of one session that
 * change the state never lose each other's change.
 *
 * @param anchorsDir - The berth's anchors folder.
 * @param change - The change: the state as read, to the state to write.
 * @returns The state written.
 * @throws {BerthStateError} When the file there is not a berth's state.
 *
 * @example
 * ```ts
 * berthState_update('/anchors', (state: BerthState): BerthState => ({ ...state, anchors: [] }));
 * ```
 */
export function berthState_update(anchorsDir: string, change: (state: BerthState) => BerthState): BerthState {
  const next: BerthState = change(berthState_read(anchorsDir));
  berthState_write(anchorsDir, next);
  return next;
}
