/**
 * @file Persistent checkpoint for the directory-listing cache.
 *
 * The listing cache is a set of per-path snapshots with a TTL each. Written
 * to disk, restored at boot with their original timestamps, they come back
 * exactly as stale as they are: the first visit to a restored path renders
 * at once and revalidates behind itself, instead of starting cold. One
 * identity-keyed, mode-0600 file under a mode-0700 folder, written by
 * same-directory atomic rename, throttled so a burst of listings coalesces
 * into one write.
 *
 * @module
 */
import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { listCache_get, type ListCacheEntrySnapshot, type ListCacheSnapshot } from './listCache';
import { identityEpoch_get } from '../connect/identityEpoch';

const LIST_CHECKPOINT_SCHEMA: number = 1;

/** Minimum spacing between two writes of the listing checkpoint. */
export const LIST_CHECKPOINT_FLOOR_MS: number = 10 * 1000;

interface ListCheckpointFile {
  schemaVersion: number;
  identity: string;
  writtenAt: string;
  entries: ListCacheEntrySnapshot[];
}

/**
 * Outcome of attempting to restore a listing checkpoint.
 *
 * @property restored - Whether validated entries replaced the cache.
 * @property count - Number of restored listings.
 * @property writtenAt - Checkpoint creation time when restoration succeeded.
 * @property reason - Human-readable reason when restoration was skipped.
 */
export interface ListCheckpointRestoreResult {
  restored: boolean;
  count: number;
  writtenAt?: string;
  reason?: string;
}

/** Returns the default directory for persistent listing files. */
function listCheckpointRoot_get(): string {
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
export function listCheckpointPath_get(identity: string, root: string = listCheckpointRoot_get()): string {
  const key: string = createHash('sha256').update(identity).digest('hex').slice(0, 16);
  return join(root, `listings-${key}-v${LIST_CHECKPOINT_SCHEMA}.json`);
}

/** Reports whether a value is a structurally valid persisted entry. */
function entry_check(value: unknown): value is ListCacheEntrySnapshot {
  if (!value || typeof value !== 'object') return false;
  const entry: Partial<ListCacheEntrySnapshot> = value as Partial<ListCacheEntrySnapshot>;
  return typeof entry.path === 'string' && entry.path.startsWith('/') &&
    entry.data !== undefined && entry.data !== null &&
    typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp) &&
    typeof entry.dirty === 'boolean' &&
    typeof entry.ttl === 'number' && Number.isFinite(entry.ttl) && entry.ttl > 0;
}

/** Reports whether parsed JSON is a compatible checkpoint for an identity. */
function file_check(value: unknown, identity: string): value is ListCheckpointFile {
  if (!value || typeof value !== 'object') return false;
  const file: Partial<ListCheckpointFile> = value as Partial<ListCheckpointFile>;
  return file.schemaVersion === LIST_CHECKPOINT_SCHEMA &&
    file.identity === identity &&
    typeof file.writtenAt === 'string' &&
    !Number.isNaN(Date.parse(file.writtenAt)) &&
    Array.isArray(file.entries) &&
    file.entries.every(entry_check) &&
    new Set(file.entries.map((entry: ListCacheEntrySnapshot): string => entry.path)).size === file.entries.length;
}

/**
 * Restores a matching, validated listing checkpoint into the cache.
 *
 * @param identity - Canonical ChRIS identity string.
 * @param root - Checkpoint directory override.
 * @returns Restoration outcome without throwing for absent or invalid files.
 */
export async function listCheckpoint_restore(
  identity: string,
  root: string = listCheckpointRoot_get(),
): Promise<ListCheckpointRestoreResult> {
  try {
    const raw: string = await fs.readFile(listCheckpointPath_get(identity, root), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!file_check(parsed, identity)) {
      return { restored: false, count: 0, reason: 'incompatible listing checkpoint' };
    }
    const snapshot: ListCacheSnapshot = { entries: parsed.entries };
    listCache_get().snapshot_restore(snapshot);
    return { restored: true, count: parsed.entries.length, writtenAt: parsed.writtenAt };
  } catch (error: unknown) {
    const code: string | undefined = (error as NodeJS.ErrnoException).code;
    return {
      restored: false,
      count: 0,
      reason: code === 'ENOENT' ? 'no listing checkpoint' : (error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * Atomically saves the listing cache.
 *
 * @param identity - Canonical ChRIS identity string.
 * @param root - Checkpoint directory override.
 * @returns Promise resolved after the mode-0600 file is durable in place.
 */
export async function listCheckpoint_save(
  identity: string,
  root: string = listCheckpointRoot_get(),
): Promise<void> {
  const path: string = listCheckpointPath_get(identity, root);
  const temporaryPath: string = `${path}.${process.pid}-${randomUUID()}.tmp`;
  const file: ListCheckpointFile = {
    schemaVersion: LIST_CHECKPOINT_SCHEMA,
    identity,
    writtenAt: new Date().toISOString(),
    entries: listCache_get().snapshot_create().entries,
  };
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.chmod(dirname(path), 0o700);
  await fs.writeFile(temporaryPath, `${JSON.stringify(file)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, path);
  await fs.chmod(path, 0o600);
}

/**
 * Starts a throttled checkpoint writer for listing-cache mutations: a write
 * at least `delayMs` after the first pending mutation, and no more often
 * than once per `floorMs`, the last change never dropped.
 *
 * @param identity - Canonical ChRIS identity string.
 * @param root - Checkpoint directory override.
 * @param delayMs - Debounce interval in milliseconds.
 * @param floorMs - Minimum spacing between two writes.
 * @returns Function that stops watching and cancels a pending save.
 */
export function listCheckpoint_watch(
  identity: string,
  root: string = listCheckpointRoot_get(),
  delayMs: number = 2000,
  floorMs: number = LIST_CHECKPOINT_FLOOR_MS,
): () => void {
  let timer: NodeJS.Timeout | null = null;
  let lastWrite: number = 0;
  // The identity this watcher writes for is the one connected when it was started. Once another has
  // connected, what the cache holds is the other's: nothing more is written under this name.
  const began: number = identityEpoch_get();
  const listener_remove: () => void = listCache_get().changeListener_add((): void => {
    if (timer || identityEpoch_get() !== began) return;
    const wait: number = Math.max(delayMs, lastWrite + floorMs - Date.now());
    timer = setTimeout((): void => {
      timer = null;
      lastWrite = Date.now();
      if (identityEpoch_get() !== began) return;
      void listCheckpoint_save(identity, root).catch((): void => { /* next mutation retries */ });
    }, wait);
    timer.unref();
  });
  return (): void => {
    listener_remove();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
