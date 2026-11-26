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
} from './queryIndex';
import { identityEpoch_get } from '../connect/identityEpoch';

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
    const raw: string = await fs.readFile(queryIndexCheckpointPath_get(identity, root), 'utf8');
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
  const path: string = queryIndexCheckpointPath_get(identity, root);
  const temporaryPath: string = `${path}.${process.pid}-${randomUUID()}.tmp`;
  const snapshot: QueryIndexSnapshot = queryIndex_get().snapshot_create();
  const file: QueryIndexCheckpointFile = {
    schemaVersion: QUERY_INDEX_SCHEMA,
    identity,
    writtenAt: new Date().toISOString(),
    floor: snapshot.floor,
    entries: snapshot.entries,
  };
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.chmod(dirname(path), 0o700);
  await fs.writeFile(temporaryPath, `${JSON.stringify(file)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, path);
  await fs.chmod(path, 0o600);
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
  return (): void => {
    listener_remove();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
