/**
 * @file Persistent checkpoint for the PACS query index.
 *
 * The index is expensive to build and cheap to keep: the back-fill walks a
 * collection whose every row drags a compressed result, so the sweep is a
 * cost worth paying once rather than at every boot. Written to disk and
 * restored at start, it comes back with its floor, and the sweep resumes
 * from there instead of starting over.
 *
 * Same shape as the listing checkpoint next door: one identity-keyed,
 * mode-0600 file under a mode-0700 folder, written by same-directory atomic
 * rename, throttled so a burst of queries coalesces into one write.
 *
 * @module
 */
import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import {
  queryIndex_get,
  type QueryIndexEntrySnapshot,
  type QueryIndexSnapshot,
  queryIndexForget_listen,
} from './queryIndex';
import { identityCache_usable, identityChange_listen, identityEpoch_get, identityName_get } from '../connect/identityEpoch';

const QUERY_INDEX_SCHEMA: number = 1;

/** Minimum spacing between two writes of the query-index checkpoint. */
export const QUERY_INDEX_CHECKPOINT_FLOOR_MS: number = 10 * 1000;

interface QueryIndexCheckpointFile {
  schemaVersion: number;
  identity: string;
  writtenAt: string;
  floor: string | null;
  entries: QueryIndexEntrySnapshot[];
}

/**
 * Outcome of attempting to restore a query-index checkpoint.
 *
 * @property restored - Whether validated entries reached the index.
 * @property count - Number of restored queries.
 * @property writtenAt - Checkpoint creation time when restoration succeeded.
 * @property reason - Human-readable reason when restoration was skipped.
 */
export interface QueryIndexRestoreResult {
  restored: boolean;
  count: number;
  writtenAt?: string;
  reason?: string;
}

/** Returns the default directory for persistent index files. */
function queryIndexRoot_get(): string {
  const cacheHome: string = process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  return join(cacheHome, 'chell', 'vfs');
}

/**
 * Builds the identity-keyed checkpoint path without exposing the identity.
 *
 * @param identity - Canonical ChRIS identity string.
 * @param root - Checkpoint directory override.
 * @returns Versioned checkpoint path.
 */
export function queryIndexCheckpointPath_get(
  identity: string,
  root: string = queryIndexRoot_get(),
): string {
  const key: string = createHash('sha256').update(identity).digest('hex').slice(0, 16);
  return join(root, `pacs-queries-${key}-v${QUERY_INDEX_SCHEMA}.json`);
}

/** Reports whether a value is a structurally valid persisted entry. */
function entry_check(value: unknown): value is QueryIndexEntrySnapshot {
  if (!value || typeof value !== 'object') return false;
  const entry: Partial<QueryIndexEntrySnapshot> = value as Partial<QueryIndexEntrySnapshot>;
  return typeof entry.key === 'string' && entry.key.length > 0 &&
    typeof entry.queryId === 'number' && Number.isFinite(entry.queryId) &&
    typeof entry.server === 'string' &&
    typeof entry.owner === 'string' &&
    typeof entry.answeredAt === 'string' && !Number.isNaN(Date.parse(entry.answeredAt)) &&
    typeof entry.hasResult === 'boolean' &&
    entry.criteria !== undefined && entry.criteria !== null && typeof entry.criteria === 'object';
}

/** Reports whether parsed JSON is a compatible checkpoint for an identity. */
function file_check(value: unknown, identity: string): value is QueryIndexCheckpointFile {
  if (!value || typeof value !== 'object') return false;
  const file: Partial<QueryIndexCheckpointFile> = value as Partial<QueryIndexCheckpointFile>;
  return file.schemaVersion === QUERY_INDEX_SCHEMA &&
    file.identity === identity &&
    typeof file.writtenAt === 'string' &&
    !Number.isNaN(Date.parse(file.writtenAt)) &&
    (file.floor === null || (typeof file.floor === 'string' && !Number.isNaN(Date.parse(file.floor)))) &&
    Array.isArray(file.entries) &&
    file.entries.every(entry_check);
}

/**
 * Restores a matching, validated checkpoint into the index.
 *
 * A rejected file is not an error worth raising: the index is advisory, so
 * an unreadable checkpoint costs a sweep and nothing else.
 *
 * @param identity - Canonical ChRIS identity string.
 * @param root - Checkpoint directory override.
 * @returns Restoration outcome without throwing for absent or invalid files.
 */
export async function queryIndexCheckpoint_restore(
  identity: string,
  root: string = queryIndexRoot_get(),
): Promise<QueryIndexRestoreResult> {
  try {
    const began: number = identityEpoch_get();
    const raw: string = await checkpoint_text(identity, root);
    // The identity changed while the checkpoint was being read: it is the one before's, and is not put into
    // the cache of whoever is connected now.
    if (began !== identityEpoch_get() || !identityCache_usable()) return { restored: false, count: 0, reason: 'the identity changed' };
    const parsed: unknown = JSON.parse(raw);
    if (!file_check(parsed, identity)) {
      return { restored: false, count: 0, reason: 'incompatible query index' };
    }
    const snapshot: QueryIndexSnapshot = { entries: parsed.entries, floor: parsed.floor };
    queryIndex_get().snapshot_restore(snapshot);
    return { restored: true, count: parsed.entries.length, writtenAt: parsed.writtenAt };
  } catch (error: unknown) {
    const code: string | undefined = (error as NodeJS.ErrnoException).code;
    return {
      restored: false,
      count: 0,
      reason: code === 'ENOENT' ? 'no query index' : (error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * Atomically saves the query index.
 *
 * @param identity - Canonical ChRIS identity string.
 * @param root - Checkpoint directory override.
 * @returns Promise resolved after the mode-0600 file is durable in place.
 */
export async function queryIndexCheckpoint_save(
  identity: string,
  root: string = queryIndexRoot_get(),
): Promise<void> {
  // Written only by the session's own identity's work: what other work sees of the index is not its to save
  // under this name. And only under the name of whoever the index in memory is: a save asked for under a
  // name that has since left (an old watcher's, a sweep begun before a switch) writes nothing.
  if (!identityCache_usable()) return;
  if (held !== null && held.identity !== identity) return;
  const whose: CheckpointHolder = held ?? { identity, root, restored: true };
  // The index as it stands now, taken before anything is waited for.
  await holder_write(whose, queryIndex_get().snapshot_create());
}

/** Whose checkpoint the index in memory is, and where its file is kept. */
interface CheckpointHolder {
  /** The identity the index is being kept for. */
  identity: string;
  /** The checkpoint directory. */
  root: string;
  /**
   * Whether the identity's checkpoint on disk has been read into the
   * index. When it has, the index is the whole of what is known, and is
   * written as it stands. When it has not (the identity connected part-way
   * through a run), the index holds only what this run learnt, and a write
   * adds it to what the file already holds.
   */
  restored: boolean;
}

/** Whose checkpoint the index in memory is: whoever is connected, once they are known by name. */
let held: CheckpointHolder | null = null;

/** Where checkpoints are kept for an identity that becomes the holder by connecting (a test names its own). */
let rootNow: string | null = null;

/** The last write begun for each file: a write waits for the one before it, so they land in the order asked. */
const writes: Map<string, Promise<void>> = new Map<string, Promise<void>>();

/** Writes of an identity's index begun when that identity left, still under way. */
const leaving: Set<Promise<void>> = new Set<Promise<void>>();

/**
 * Writes one snapshot of the index as its holder's checkpoint, after any
 * write of the same file already asked for: so what a watcher began to
 * save a moment before its identity left cannot land after, and over, what
 * was written as it left.
 *
 * @param whose - The holder.
 * @param snapshot - The index as it stood for that identity.
 * @returns When the write has landed.
 */
function holder_write(whose: CheckpointHolder, snapshot: QueryIndexSnapshot): Promise<void> {
  const path: string = queryIndexCheckpointPath_get(whose.identity, whose.root);
  const before: Promise<void> = writes.get(path) ?? Promise.resolve();
  const merged: boolean = !whose.restored;
  const written: Promise<void> = before.then((): Promise<void> => snapshot_write(whose.identity, whose.root, snapshot, merged));
  const settled: Promise<void> = written.then((): void => undefined, (): void => undefined).then((): void => {
    if (writes.get(path) === settled) writes.delete(path);
  });
  writes.set(path, settled);
  return written;
}

/**
 * Writes one snapshot of the index as an identity's checkpoint, atomically.
 *
 * @param identity - Canonical ChRIS identity string.
 * @param root - Checkpoint directory.
 * @param snapshot - The index as it stood for that identity.
 * @param merged - Whether to add the snapshot to what the file already
 *   holds (an entry in both is the snapshot's; the floor is the earlier).
 */
async function snapshot_write(identity: string, root: string, snapshot: QueryIndexSnapshot, merged: boolean): Promise<void> {
  const path: string = queryIndexCheckpointPath_get(identity, root);
  const temporaryPath: string = `${path}.${process.pid}-${randomUUID()}.tmp`;
  let entries: QueryIndexEntrySnapshot[] = snapshot.entries;
  let floor: string | null = snapshot.floor;
  if (merged) {
    const kept: QueryIndexCheckpointFile | null = await file_read(identity, root);
    if (kept !== null) {
      const noted: Set<number> = new Set<number>(snapshot.entries.map((entry: QueryIndexEntrySnapshot): number => entry.queryId));
      entries = [...kept.entries.filter((entry: QueryIndexEntrySnapshot): boolean => !noted.has(entry.queryId)), ...snapshot.entries];
      if (kept.floor !== null && (floor === null || Date.parse(kept.floor) < Date.parse(floor))) floor = kept.floor;
    }
  }
  const file: QueryIndexCheckpointFile = {
    schemaVersion: QUERY_INDEX_SCHEMA,
    identity,
    writtenAt: new Date().toISOString(),
    floor,
    entries,
  };
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.chmod(dirname(path), 0o700);
  await fs.writeFile(temporaryPath, `${JSON.stringify(file)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, path);
  await fs.chmod(path, 0o600);
}

/**
 * Reads the text of an identity's checkpoint file.
 *
 * @param identity - Canonical ChRIS identity string.
 * @param root - Checkpoint directory.
 * @returns The file's text; rejected when the file is not there or cannot be read.
 */
function checkpoint_text(identity: string, root: string): Promise<string> {
  const text: Promise<string> = fs.readFile(queryIndexCheckpointPath_get(identity, root), 'utf8');
  return text;
}

/**
 * Reads an identity's checkpoint as it is on disk.
 *
 * @param identity - Canonical ChRIS identity string.
 * @param root - Checkpoint directory.
 * @returns The file, or null when there is none or it is not one of this identity's.
 */
async function file_read(identity: string, root: string): Promise<QueryIndexCheckpointFile | null> {
  try {
    const parsed: unknown = JSON.parse(await checkpoint_text(identity, root));
    return file_check(parsed, identity) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Says that the index in memory holds the whole of an identity's
 * checkpoint: it has been restored for them. From here it is written as it
 * stands, under their name, when they leave and at the end of the run.
 * Said by the session's own current work only, and only of whoever is
 * connected: work begun before a change of identity, saying it of the one
 * who was connected then, is not heard.
 *
 * @param identity - Canonical ChRIS identity string.
 * @param root - Checkpoint directory override.
 *
 * @example
 * const restored = await queryIndexCheckpoint_restore(identity);
 * if (restored.reason !== 'the identity changed') queryIndexCheckpoint_hold(identity);
 */
export function queryIndexCheckpoint_hold(identity: string, root: string = queryIndexRoot_get()): void {
  if (!identityCache_usable()) return;
  const now: string | null = identityName_get();
  if (now !== null && now !== identity) return;
  rootNow = root;
  held = { identity, root, restored: true };
}

// At a change of identity: whoever is leaving has their index written under their own name, entries and
// floor as they stood, handed over before the index is emptied; and whoever is connected after it becomes
// the holder at once, by name. Their checkpoint on disk has not been read in, so what the index gathers
// for them from here is added to their file when it is written, and replaces nothing in it.
queryIndexForget_listen((left: QueryIndexSnapshot, now: string | null): void => {
  const whose: CheckpointHolder | null = held;
  held = now === null ? null : { identity: now, root: rootNow ?? queryIndexRoot_get(), restored: false };
  if (whose === null) return;
  // Nothing learnt and nothing restored: there is nothing of theirs to write, and no file is made for it.
  if (!whose.restored && left.entries.length === 0 && left.floor === null) return;
  const written: Promise<void> = holder_write(whose, left)
    .catch((): void => { /* the index rebuilds itself from CUBE at the next boot */ })
    .finally((): void => { leaving.delete(written); });
  leaving.add(written);
});

/**
 * Writes the index at the end of a run: what it holds now, under the name
 * of whoever it is being kept for, and waits for the checkpoint of every
 * identity that left during the run. What is written is settled before
 * anything is waited for: a change of identity while the files are being
 * written changes nothing of it.
 *
 * @param identity - The identity connected now, when the caller knows it
 *   and nobody has become the holder by connecting (a run that never
 *   changed identity and never restored). Null when nobody is connected.
 * @param root - Checkpoint directory override.
 *
 * @example
 * await queryIndexCheckpoint_finish(await sessionIdentity_name());
 */
export async function queryIndexCheckpoint_finish(identity: string | null, root: string = queryIndexRoot_get()): Promise<void> {
  // Whose the index is now: the holder, or failing one the identity named, whose file has not been read in.
  const whose: CheckpointHolder | null = held ?? (identity === null ? null : { identity, root, restored: false });
  const last: Promise<void> = whose === null || !identityCache_usable()
    ? Promise.resolve()
    : holder_write(whose, queryIndex_get().snapshot_create());
  await Promise.all([...leaving, last]);
}

/**
 * Starts a throttled checkpoint writer for index mutations: a write at
 * least `delayMs` after the first pending mutation, and no more often than
 * once per `floorMs`, the last change never dropped.
 *
 * @param identity - Canonical ChRIS identity string.
 * @param root - Checkpoint directory override.
 * @param delayMs - Debounce interval in milliseconds.
 * @param floorMs - Minimum spacing between two writes.
 * @returns Function that stops watching and cancels a pending save.
 */
export function queryIndexCheckpoint_watch(
  identity: string,
  root: string = queryIndexRoot_get(),
  delayMs: number = 2000,
  floorMs: number = QUERY_INDEX_CHECKPOINT_FLOOR_MS,
): () => void {
  // Installed only by the session's own identity's work: a warm-up that outlived a change of identity (its
  // restore came back after someone else connected) watches nothing, and writes nothing under its name.
  if (!identityCache_usable()) return (): void => undefined;
  let timer: NodeJS.Timeout | null = null;
  let lastWrite: number = 0;
  // The identity this watcher writes for is the one connected when it was started. Once another has
  // connected, what the cache holds is the other's: nothing more is written under this name.
  const began: number = identityEpoch_get();
  const listener_remove: () => void = queryIndex_get().changeListener_add((): void => {
    if (timer || identityEpoch_get() !== began) return;
    const wait: number = Math.max(delayMs, lastWrite + floorMs - Date.now());
    timer = setTimeout((): void => {
      timer = null;
      lastWrite = Date.now();
      if (identityEpoch_get() !== began) return;
      void queryIndexCheckpoint_save(identity, root).catch((): void => { /* next mutation retries */ });
    }, wait);
    timer.unref();
  });
  const watch_stop = (): void => {
    listener_remove();
    if (timer) clearTimeout(timer);
    timer = null;
    retire_remove();
  };
  // Retired at a change of identity: the cache it watched is no longer the one it writes for.
  const retire_remove: () => void = identityChange_listen(watch_stop);
  return watch_stop;
}
