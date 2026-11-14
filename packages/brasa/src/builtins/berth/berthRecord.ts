/**
 * @file `berth.json`, the record a close writes into the outgoing folder and
 * returns with the work: who, every anchor with its ChRIS path, node, feed,
 * what was downloaded and what changed since, the berth session, the source
 * commit, the image, the time, and where the node goes.
 *
 * The record travels in the data, so a copy or a download of the node keeps
 * it. It is written before the upload with the placement the close decided,
 * and written again in the berth once the node is made, with the node's
 * feed and id.
 *
 * Key components:
 * - BERTH_RECORD_FILE: the record's name, `berth.json`.
 * - BerthRecord, RecordAnchor, AnchorChanges, BerthPlacement, BerthAttachment, BerthSource: its shape.
 * - anchorChanges_compare: what differs between the files anchored and the files ChRIS holds at the close.
 * - anchorChanges_any: whether anything differs.
 * - berthSource_read: the git commit of a folder, when it is in a repository.
 * - berthRecord_write: writes the record into a folder.
 *
 * Typical usage:
 * ```ts
 * const changes: AnchorChanges = anchorChanges_compare(anchor.files, atClose);
 * berthRecord_write('/outgoing', record);
 * ```
 *
 * Dependencies: Node.js built-ins; `git` on the path for the source commit
 * (none when it is absent). Times are ISO 8601 strings, sizes bytes.
 *
 * @module
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AnchoredFile, BerthAnchor } from './berthState.js';

/** The record's name, in the outgoing folder. */
export const BERTH_RECORD_FILE: string = 'berth.json';

/** The record's format version. */
const BERTH_RECORD_VERSION: number = 1;

/** How long `git` may take to say the commit, in milliseconds. */
const GIT_TIMEOUT_MS: number = 5_000;

/**
 * A file whose size differs from the size anchored.
 *
 * @example
 * ```ts
 * const resized: ResizedFile = { name: 'model.pt', anchored: 5, atClose: 6 };
 * ```
 */
export interface ResizedFile {
  /** Its name relative to the anchor. */
  readonly name: string;
  /** Its size when anchored, in bytes. */
  readonly anchored: number;
  /** Its size in ChRIS at the close, in bytes. */
  readonly atClose: number;
}

/**
 * What differs between an anchor's files and what ChRIS holds at the close.
 *
 * @example
 * ```ts
 * const changes: AnchorChanges = { added: ['extra.pt'], removed: [], resized: [], unreadable: null };
 * ```
 */
export interface AnchorChanges {
  /** Files ChRIS holds that were not anchored. */
  readonly added: readonly string[];
  /** Files anchored that ChRIS does not hold at the close. */
  readonly removed: readonly string[];
  /** Files whose size differs. */
  readonly resized: readonly ResizedFile[];
  /** Why ChRIS could not be read for the comparison; null when it was read. */
  readonly unreadable: string | null;
}

/**
 * One anchor as the record holds it: the anchor, and what changed since.
 *
 * @example
 * ```ts
 * const anchor: RecordAnchor = { name: 'weights', path: '/home/alice/uploads/weights', node: null, feed: null, files: [], anchoredAt: '…', changes: null };
 * ```
 */
export interface RecordAnchor extends BerthAnchor {
  /** What differs in ChRIS since the anchor; null for an anchor under a node, which does not change. */
  readonly changes: AnchorChanges | null;
}

/**
 * Where the work's node goes.
 *
 * @example
 * ```ts
 * const child: BerthPlacement = { kind: 'child', by: 'anchors', parent: 41, parentName: 'pl-fshack_41', feed: 5, anchor: null };
 * const fresh: BerthPlacement = { kind: 'newFeed', by: '--newfeed', name: 'berth work', inputs: ['/home/alice/uploads/weights'] };
 * ```
 */
export type BerthPlacement = PlacementChild | PlacementNewFeed;

/** What decided a placement: the anchors themselves, or the flag given. */
export type PlacementCause = 'anchors' | '--infeed' | '--newfeed';

/** The work as a child of a node of the person's feeds. */
export interface PlacementChild {
  /** A child of a node. */
  readonly kind: 'child';
  /** What decided it. */
  readonly by: PlacementCause;
  /** The parent plugin instance. */
  readonly parent: number;
  /** The parent's folder name, `pl-fshack_41`. */
  readonly parentName: string;
  /** The parent's feed. */
  readonly feed: number | null;
  /** The anchor `--infeed` named; null when the anchors decided. */
  readonly anchor: string | null;
}

/** The work in a new feed. */
export interface PlacementNewFeed {
  /** A new feed. */
  readonly kind: 'newFeed';
  /** What decided it. */
  readonly by: PlacementCause;
  /** The feed's name. */
  readonly name: string;
  /** The ChRIS paths its `pl-dircopy` root copies; empty when the root is the work itself. */
  readonly inputs: readonly string[];
}

/**
 * The node made, once the close attached the work.
 *
 * @example
 * ```ts
 * const attached: BerthAttachment = { feed: 12, node: 58, plugin: 'pl-dsdircopy', root: 57 };
 * ```
 */
export interface BerthAttachment {
  /** The feed the node is in; null when CUBE did not say. */
  readonly feed: number | null;
  /** The work's plugin instance. */
  readonly node: number;
  /** Its plugin. */
  readonly plugin: string;
  /** The new feed's root, when the close made one under the work; else null. */
  readonly root: number | null;
}

/**
 * The source the work was made from: the git repository holding the folder the session runs in.
 *
 * @example
 * ```ts
 * const source: BerthSource = { repository: '/home/alice/src/seg', commit: '3f2a…', dirty: false };
 * ```
 */
export interface BerthSource {
  /** The repository's top folder. */
  readonly repository: string;
  /** The commit checked out. */
  readonly commit: string;
  /** Whether the working tree differs from the commit. */
  readonly dirty: boolean;
}

/**
 * `berth.json`.
 *
 * @example
 * ```ts
 * const record: BerthRecord = {
 *   version: 1, who: 'alice', session: 'berth-alice', image: null, source: null, closedAt: '2026-11-14T10:00:00.000Z',
 *   title: 'berth work', anchors: [], outgoing: '/outgoing', folder: '/home/alice/berth/0b6c…',
 *   placement: { kind: 'newFeed', by: 'anchors', name: 'berth work', inputs: [] }, attached: null,
 * };
 * ```
 */
export interface BerthRecord {
  /** The record's format version. */
  readonly version: number;
  /** The person, by CUBE user name. */
  readonly who: string;
  /** The berth session: the berth's host name. */
  readonly session: string;
  /** The berth's image, as the berth names it; null when it does not. */
  readonly image: string | null;
  /** The source commit; null when the session's folder is in no git repository. */
  readonly source: BerthSource | null;
  /** When the close ran. */
  readonly closedAt: string;
  /** The work node's title. */
  readonly title: string;
  /** Every anchor, with what changed since. */
  readonly anchors: readonly RecordAnchor[];
  /** The outgoing folder returned. */
  readonly outgoing: string;
  /** The person's CUBE files folder it was uploaded to. */
  readonly folder: string;
  /** Where the node goes. */
  readonly placement: BerthPlacement;
  /** The node made; null until the close attached it. */
  readonly attached: BerthAttachment | null;
}

/**
 * What differs between the files anchored and the files ChRIS holds at the close, by name and size.
 *
 * @param anchored - The files the anchor downloaded.
 * @param atClose - The files ChRIS holds at the anchor's path at the close.
 * @returns The files added, removed and resized, each sorted by name.
 *
 * @example
 * ```ts
 * anchorChanges_compare([{ name: 'a', size: 1 }, { name: 'b', size: 2 }], [{ name: 'b', size: 3 }, { name: 'c', size: 1 }]);
 * // { added: ['c'], removed: ['a'], resized: [{ name: 'b', anchored: 2, atClose: 3 }], unreadable: null }
 * ```
 */
export function anchorChanges_compare(anchored: readonly AnchoredFile[], atClose: readonly AnchoredFile[]): AnchorChanges {
  const before: Map<string, number> = new Map(anchored.map((file: AnchoredFile): [string, number] => [file.name, file.size]));
  const after: Map<string, number> = new Map(atClose.map((file: AnchoredFile): [string, number] => [file.name, file.size]));
  const byName = (a: string, b: string): number => a.localeCompare(b);
  const added: string[] = [...after.keys()].filter((name: string): boolean => !before.has(name)).sort(byName);
  const removed: string[] = [...before.keys()].filter((name: string): boolean => !after.has(name)).sort(byName);
  const resized: ResizedFile[] = [...before.entries()]
    .filter(([name, size]: [string, number]): boolean => after.has(name) && after.get(name) !== size)
    .map(([name, size]: [string, number]): ResizedFile => ({ name, anchored: size, atClose: after.get(name) ?? 0 }))
    .sort((a: ResizedFile, b: ResizedFile): number => byName(a.name, b.name));
  return { added, removed, resized, unreadable: null };
}

/**
 * Whether a comparison found anything different, or could not be made.
 *
 * @param changes - The comparison.
 * @returns True when a file was added, removed or resized, or ChRIS could not be read.
 *
 * @example
 * ```ts
 * anchorChanges_any({ added: [], removed: [], resized: [], unreadable: null }); // false
 * ```
 */
export function anchorChanges_any(changes: AnchorChanges): boolean {
  return changes.added.length + changes.removed.length + changes.resized.length > 0 || changes.unreadable !== null;
}

/**
 * Runs `git` in a folder.
 *
 * @param folder - The folder.
 * @param args - The words after `git`.
 * @returns What it printed, trimmed; null when it failed or is not there.
 */
function git_ask(folder: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS }).trim();
  } catch {
    return null;
  }
}

/**
 * The git commit a folder is at, when it is in a repository.
 *
 * @param folder - The folder the session runs in.
 * @returns The repository, its commit and whether its tree differs; null outside a repository, or one with no commit.
 *
 * @example
 * ```ts
 * berthSource_read('/home/alice/src/seg'); // { repository: '/home/alice/src/seg', commit: '3f2a…', dirty: false }
 * ```
 */
export function berthSource_read(folder: string): BerthSource | null {
  const repository: string | null = git_ask(folder, ['rev-parse', '--show-toplevel']);
  const commit: string | null = git_ask(folder, ['rev-parse', 'HEAD']);
  if (repository === null || commit === null || commit === '') return null;
  const status: string | null = git_ask(folder, ['status', '--porcelain']);
  return { repository, commit, dirty: status !== null && status !== '' };
}

/**
 * Writes the record into a folder as `berth.json`.
 *
 * @param folder - The outgoing folder.
 * @param record - The record.
 * @returns The file written.
 *
 * @example
 * ```ts
 * berthRecord_write('/outgoing', record); // '/outgoing/berth.json'
 * ```
 */
export function berthRecord_write(folder: string, record: BerthRecord): string {
  const file: string = join(folder, BERTH_RECORD_FILE);
  writeFileSync(file, `${JSON.stringify({ ...record, version: BERTH_RECORD_VERSION }, null, 2)}\n`, { mode: 0o644 });
  return file;
}
