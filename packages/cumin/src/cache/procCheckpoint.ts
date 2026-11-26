/**
 * @file Persistent checkpoints for the daemon process index.
 *
 * The checkpoint is a directory of shards under an identity-keyed,
 * mode-0700 folder: `roster.json` (the feed index) and one `feed-<id>.json`
 * per feed that holds topology. A mutation to one feed rewrites one shard,
 * so a growing 80k-node feed never drags the whole index back to disk, and
 * a torn write can damage at most one feed. Every file is mode 0600 and
 * written with a same-directory atomic rename.
 *
 * Restore reads the roster and every shard, assembles one snapshot, and
 * validates it whole before replacing live cache state — a shard whose feed
 * is not in the roster is an orphan and is ignored. A legacy single-file v2
 * checkpoint is read once and migrated into shards.
 *
 * The watcher persists what changed, throttled per shard: a shard is
 * written no more than once per {@link PROC_CHECKPOINT_FLOOR_MS}, and never
 * later than that after its first pending mutation.
 *
 * Beside the index, the folder keeps where a surface last laid the space
 * out, one `layout-<name>.json` per layout: the universe is placed once per
 * identity, not once per browser, and every surface after the first draws
 * at once from the session's copy.
 *
 * @module
 */
import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import {
  procCache_get,
  status_isTerminal,
  type ProcCacheChange,
  type ProcCacheSnapshot,
  type ProcFeed,
  type ProcFeedSnapshot,
  type ProcInstance,
  type ProcFeedDataFacts,
} from './procCache';
import { identityEpoch_get } from '../connect/identityEpoch';
import { errorStack } from '../error/errorStack';

// v3: per-feed shards. v2 (one file, instances with metrics) is still read
// for migration; v1 never carried metrics and is not read.
const PROC_CHECKPOINT_SCHEMA: number = 3;
const LEGACY_CHECKPOINT_SCHEMA: number = 2;
const ROSTER_FILE: string = 'roster.json';
const SHARD_PATTERN: RegExp = /^feed-(\d+)\.json$/;

/** Minimum spacing between two writes of the same shard. */
export const PROC_CHECKPOINT_FLOOR_MS: number = 30 * 1000;

interface LegacyCheckpointFile {
  schemaVersion: number;
  identity: string;
  writtenAt: string;
  snapshot: ProcCacheSnapshot;
}

interface RosterFile {
  schemaVersion: number;
  identity: string;
  writtenAt: string;
  feeds: ProcFeed[];
  /** Feeds marked NEW since the last visit; absent in a roster written before the mark existed. */
  unseen?: number[];
}

interface ShardFile {
  schemaVersion: number;
  identity: string;
  writtenAt: string;
  feedID: number;
  loaded: boolean;
  instances: ProcInstance[];
  /** What the feed's data is; absent from a shard written before it was read, or before facts existed. */
  dataFacts?: ProcFeedDataFacts;
}

/** The formats a feed's data facts may name. */
const DATA_FORMATS: ReadonlySet<string> = new Set(['dicom', 'nifti', 'mgz', 'jpeg', 'png', 'other', 'unknown']);

/**
 * Validates a feed's data facts, read back from a shard. A shard whose facts
 * fail keeps its topology and loses only the facts: they are read again.
 *
 * @param value - Parsed facts candidate.
 * @returns True when the facts are well formed.
 */
export function dataFacts_check(value: unknown): value is ProcFeedDataFacts {
  if (!value || typeof value !== 'object') return false;
  const facts = value as Record<string, unknown>;
  const optionalText = (key: string): boolean => facts[key] === undefined || typeof facts[key] === 'string';
  return typeof facts['format'] === 'string' && DATA_FORMATS.has(facts['format'])
    && optionalText('modality') && optionalText('seriesDescription') && optionalText('reason')
    && (facts['sourceFeed'] === undefined || integer_check(facts['sourceFeed']))
    && (facts['reader'] === undefined || integer_check(facts['reader']));
}

/**
 * Outcome of attempting to restore a local process-cache checkpoint.
 *
 * @property restored - Whether validated snapshot data replaced the cache.
 * @property count - Number of restored plugin instances.
 * @property writtenAt - Checkpoint creation time when restoration succeeded.
 * @property reason - Human-readable reason when restoration was skipped.
 * @property migrated - True when a legacy single-file checkpoint was
 *   converted into shards during this restore.
 */
export interface ProcCheckpointRestoreResult {
  restored: boolean;
  count: number;
  writtenAt?: string;
  reason?: string;
  migrated?: boolean;
  /** Feeds whose shard was left out of a restore, each with why (`feed 800: instance 7209 names parent 7203, …`). */
  torn?: string[];
}

/** Returns the default directory for persistent process-cache files. */
function procCheckpointRoot_get(): string {
  const cacheHome: string = process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  return join(cacheHome, 'chell', 'proc');
}

/** Hashes an identity into a short, non-revealing directory key. */
function identityKey_get(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

/**
 * Builds the legacy (v2, single-file) checkpoint path for an identity.
 *
 * @param identity - Canonical ChRIS identity string.
 * @param root - Checkpoint directory override.
 * @returns The v2 file path, read only for migration.
 */
export function procCheckpointPath_get(identity: string, root: string = procCheckpointRoot_get()): string {
  return join(root, `proc-${identityKey_get(identity)}-v${LEGACY_CHECKPOINT_SCHEMA}.json`);
}

/**
 * Builds the identity-keyed checkpoint directory without exposing the identity.
 *
 * @param identity - Canonical ChRIS identity string.
 * @param root - Checkpoint directory override.
 * @returns The directory holding `roster.json` and the feed shards.
 */
export function procCheckpointDir_get(identity: string, root: string = procCheckpointRoot_get()): string {
  return join(root, identityKey_get(identity));
}

/** Path of one feed's shard inside a checkpoint directory. */
function shardPath_get(dir: string, feedID: number): string {
  return join(dir, `feed-${feedID}.json`);
}

/** Reports whether a value is a finite integer. */
function integer_check(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}

/** Reports whether a value is a structurally valid persisted feed. */
function procFeed_check(value: unknown): value is ProcFeed {
  if (!value || typeof value !== 'object') return false;
  const feed: Partial<ProcFeed> = value as Partial<ProcFeed>;
  return integer_check(feed.id) &&
    typeof feed.title === 'string' &&
    typeof feed.ownerUsername === 'string' &&
    typeof feed.public === 'boolean' &&
    typeof feed.creationDate === 'string' &&
    integer_check(feed.finishedJobs) &&
    integer_check(feed.erroredJobs) &&
    integer_check(feed.startedJobs) &&
    integer_check(feed.scheduledJobs) &&
    integer_check(feed.cancelledJobs) &&
    integer_check(feed.createdJobs);
}

/** Reports whether a value is a structurally valid persisted instance. */
function procInstance_check(value: unknown): value is ProcInstance {
  if (!value || typeof value !== 'object') return false;
  const instance: Partial<ProcInstance> = value as Partial<ProcInstance>;
  const parentValid: boolean = instance.parentID === null || integer_check(instance.parentID);
  const pluginTypeValid: boolean = instance.pluginType === undefined || typeof instance.pluginType === 'string';
  const statusValid: boolean = instance.status === null ||
    (typeof instance.status === 'string' && status_isTerminal(instance.status));
  const joinsValid: boolean = instance.joinParentIDs === undefined ||
    (Array.isArray(instance.joinParentIDs) && instance.joinParentIDs.every(integer_check));
  const metricsValid: boolean =
    (instance.startedAt === undefined || typeof instance.startedAt === 'string') &&
    (instance.finishedAt === undefined || typeof instance.finishedAt === 'string') &&
    (instance.outputBytes === undefined || typeof instance.outputBytes === 'number') &&
    (instance.pipelineName === undefined || instance.pipelineName === null || typeof instance.pipelineName === 'string') &&
    (instance.workflowID === undefined || instance.workflowID === null || typeof instance.workflowID === 'number');
  return metricsValid &&
    integer_check(instance.id) &&
    integer_check(instance.feedID) &&
    parentValid &&
    typeof instance.pluginName === 'string' &&
    pluginTypeValid &&
    instance.params === null &&
    statusValid &&
    joinsValid;
}

/**
 * Why one feed's shard cannot stand on its own, or null when it can: every
 * instance well formed and of this feed, ids unique, every parent and join
 * parent present in the shard, no cycle. A shard written from a walk that
 * lost a row (observed: 475 of a feed's 477 instances, two naming a parent
 * the walk never saw) fails here and costs its feed, not the checkpoint.
 *
 * @param feedID - The feed the shard claims.
 * @param instances - The shard's instances, unvalidated.
 * @returns The first fault found, in words, or null.
 */
function shardGraph_fault(feedID: number, instances: unknown[]): string | null {
  if (!instances.every(procInstance_check)) return 'an instance is malformed';
  const byID: Map<number, ProcInstance> = new Map();
  for (const instance of instances) {
    if (instance.feedID !== feedID) return `instance ${instance.id} belongs to feed ${instance.feedID}`;
    if (byID.has(instance.id)) return `instance ${instance.id} appears twice`;
    byID.set(instance.id, instance);
  }
  for (const instance of byID.values()) {
    if (instance.parentID !== null && !byID.has(instance.parentID)) {
      return `instance ${instance.id} names parent ${instance.parentID}, which the shard does not hold`;
    }
    for (const id of instance.joinParentIDs ?? []) {
      if (id === instance.id || !byID.has(id)) return `instance ${instance.id} names join parent ${id}, which the shard does not hold`;
    }
    const ancestors: Set<number> = new Set([instance.id]);
    let ancestor: ProcInstance | undefined = instance.parentID === null ? undefined : byID.get(instance.parentID);
    while (ancestor) {
      if (ancestors.has(ancestor.id)) return `instance ${instance.id} sits on a cycle`;
      ancestors.add(ancestor.id);
      ancestor = ancestor.parentID === null ? undefined : byID.get(ancestor.parentID);
    }
  }
  return null;
}

/**
 * Validates all snapshot fields and graph relationships before restoration.
 *
 * @param value - Parsed checkpoint snapshot candidate.
 * @returns True when feeds, instances, loaded markers, and parent graphs are safe.
 */
function procCacheSnapshot_check(value: unknown): value is ProcCacheSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot: Partial<ProcCacheSnapshot> = value as Partial<ProcCacheSnapshot>;
  if (!Array.isArray(snapshot.feeds) ||
      !Array.isArray(snapshot.instances) ||
      !Array.isArray(snapshot.topologyLoaded) ||
      !snapshot.feeds.every(procFeed_check) ||
      !snapshot.instances.every(procInstance_check) ||
      !snapshot.topologyLoaded.every(integer_check)) {
    return false;
  }

  const feedIDs: Set<number> = new Set(snapshot.feeds.map((feed: ProcFeed): number => feed.id));
  const instanceByID: Map<number, ProcInstance> = new Map(
    snapshot.instances.map((instance: ProcInstance): [number, ProcInstance] => [instance.id, instance]),
  );
  if (feedIDs.size !== snapshot.feeds.length ||
      instanceByID.size !== snapshot.instances.length ||
      new Set(snapshot.topologyLoaded).size !== snapshot.topologyLoaded.length ||
      snapshot.topologyLoaded.some((feedID: number): boolean => !feedIDs.has(feedID))) {
    return false;
  }

  for (const instance of snapshot.instances) {
    if (!feedIDs.has(instance.feedID)) return false;
    const parent: ProcInstance | undefined = instance.parentID === null
      ? undefined
      : instanceByID.get(instance.parentID);
    if (instance.parentID !== null && (!parent || parent.feedID !== instance.feedID)) return false;
    if (instance.joinParentIDs?.some((id: number): boolean => {
      const joinParent: ProcInstance | undefined = instanceByID.get(id);
      return !joinParent || joinParent.feedID !== instance.feedID || id === instance.id;
    })) return false;

    const ancestors: Set<number> = new Set([instance.id]);
    let ancestor: ProcInstance | undefined = parent;
    while (ancestor) {
      if (ancestors.has(ancestor.id)) return false;
      ancestors.add(ancestor.id);
      ancestor = ancestor.parentID === null ? undefined : instanceByID.get(ancestor.parentID);
    }
  }
  return true;
}

/** Shared header checks for any checkpoint file of the current schema. */
function header_check(value: unknown, identity: string): value is { identity: string; writtenAt: string } {
  if (!value || typeof value !== 'object') return false;
  const file: Partial<RosterFile> = value as Partial<RosterFile>;
  return file.schemaVersion === PROC_CHECKPOINT_SCHEMA &&
    file.identity === identity &&
    typeof file.writtenAt === 'string' &&
    !Number.isNaN(Date.parse(file.writtenAt));
}

/** Reports whether parsed JSON is a compatible roster file for an identity. */
function rosterFile_check(value: unknown, identity: string): value is RosterFile {
  return header_check(value, identity) && Array.isArray((value as Partial<RosterFile>).feeds);
}

/** Reports whether parsed JSON is a compatible shard file for an identity. */
function shardFile_check(value: unknown, identity: string): value is ShardFile {
  if (!header_check(value, identity)) return false;
  const file: Partial<ShardFile> = value as Partial<ShardFile>;
  return integer_check(file.feedID) && typeof file.loaded === 'boolean' && Array.isArray(file.instances);
}

/** Reports whether parsed JSON is a compatible legacy (v2) checkpoint for an identity. */
function legacyFile_check(value: unknown, identity: string): value is LegacyCheckpointFile {
  if (!value || typeof value !== 'object') return false;
  const file: Partial<LegacyCheckpointFile> = value as Partial<LegacyCheckpointFile>;
  return file.schemaVersion === LEGACY_CHECKPOINT_SCHEMA &&
    file.identity === identity &&
    typeof file.writtenAt === 'string' &&
    !Number.isNaN(Date.parse(file.writtenAt)) &&
    procCacheSnapshot_check(file.snapshot);
}

/** Reads and parses one JSON file; null when it does not exist. */
async function json_read(path: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Names why a shard could not be read: the system's error code (`EIO` from
 * a bad sector, `EACCES`), or `not JSON` for a file cut short by a crash.
 *
 * @param error - What reading the shard threw.
 * @returns The fault's name.
 */
function shardReadFault_name(error: unknown): string {
  if (error instanceof SyntaxError) return 'not JSON';
  const code: unknown = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.message : String(error);
}

/** Writes one mode-0600 JSON file through a same-directory atomic rename. */
async function json_write(path: string, value: unknown): Promise<void> {
  const temporaryPath: string = `${path}.${process.pid}-${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, path);
  await fs.chmod(path, 0o600);
}

/** Ensures the checkpoint directory exists, private to the user. */
async function dir_ensure(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dirname(dir), 0o700);
  await fs.chmod(dir, 0o700);
}

/**
 * Assembles the sharded checkpoint into one snapshot. Shards whose feed is
 * absent from the roster are orphans (a feed removed after its shard was
 * written) and are skipped; a shard that fails its own header check is
 * skipped too; a shard whose graph does not stand on its own (see
 * {@link shardGraph_fault}) is left out and named, and its feed stays in
 * the roster with no topology, to be walked again. A shard that cannot be
 * read or parsed is left out and named the same way. One bad file costs one
 * feed, not the checkpoint: on titan a single torn shard once refused
 * 210,010 instances and a restart booted cold, and on pangea one shard on a
 * failing disk sector (EIO) did the same to 738 good ones.
 *
 * @param dir - The checkpoint directory.
 * @param identity - Canonical ChRIS identity string.
 * @returns The assembled snapshot with its roster's write time and the
 *   torn shards' feeds, or null when there is no roster.
 */
async function shards_assemble(
  dir: string,
  identity: string,
): Promise<{ snapshot: ProcCacheSnapshot; writtenAt: string; torn: string[] } | null> {
  const roster: unknown = await json_read(join(dir, ROSTER_FILE));
  if (roster === null) return null;
  if (!rosterFile_check(roster, identity)) throw new Error('incompatible checkpoint');
  if (!roster.feeds.every(procFeed_check)) throw new Error('incompatible checkpoint');
  const feedIDs: Set<number> = new Set(roster.feeds.map((feed: ProcFeed): number => feed.id));

  const unseen: number[] = Array.isArray(roster.unseen) ? roster.unseen.filter((id: unknown): id is number => Number.isInteger(id)) : [];
  const snapshot: ProcCacheSnapshot = { feeds: roster.feeds, instances: [], topologyLoaded: [], dataFacts: {}, unseen };
  let skipped: number = 0;
  const torn: string[] = [];
  for (const name of await fs.readdir(dir)) {
    const match: RegExpMatchArray | null = SHARD_PATTERN.exec(name);
    if (!match) continue;
    const feedID: number = Number(match[1]);
    if (!feedIDs.has(feedID)) { skipped++; continue; }
    let shard: unknown;
    try {
      shard = await json_read(join(dir, name));
    } catch (error: unknown) {
      torn.push(`feed ${feedID}: unreadable (${shardReadFault_name(error)})`);
      continue;
    }
    if (!shardFile_check(shard, identity) || shard.feedID !== feedID) { skipped++; continue; }
    const fault: string | null = shardGraph_fault(feedID, shard.instances);
    if (fault !== null) { torn.push(`feed ${feedID}: ${fault}`); continue; }
    snapshot.instances.push(...shard.instances);
    if (shard.loaded) snapshot.topologyLoaded.push(feedID);
    if (shard.dataFacts !== undefined && dataFacts_check(shard.dataFacts) && snapshot.dataFacts !== undefined) snapshot.dataFacts[feedID] = shard.dataFacts;
  }
  if (skipped > 0) {
    errorStack.stack_push('warning', `proc checkpoint: ${skipped} feed shard(s) skipped (orphaned or unreadable)`);
  }
  if (torn.length > 0) {
    errorStack.stack_push('warning', `proc checkpoint: ${torn.length} feed shard(s) torn, those feeds walk again — ${torn.join('; ')}`);
  }
  return { snapshot, writtenAt: roster.writtenAt, torn };
}

/**
 * Restores a matching, fully validated checkpoint into the process cache.
 * A sharded (v3) checkpoint is preferred; failing that, a legacy single-file
 * v2 checkpoint is restored and migrated into shards.
 *
 * @param identity - Canonical ChRIS identity string.
 * @param root - Checkpoint directory override.
 * @returns Restoration outcome without throwing for absent or invalid files.
 */
export async function procCheckpoint_restore(
  identity: string,
  root: string = procCheckpointRoot_get(),
): Promise<ProcCheckpointRestoreResult> {
  const dir: string = procCheckpointDir_get(identity, root);
  try {
    const assembled: { snapshot: ProcCacheSnapshot; writtenAt: string; torn: string[] } | null = await shards_assemble(dir, identity);
    if (assembled) {
      if (!procCacheSnapshot_check(assembled.snapshot)) {
        return { restored: false, count: 0, reason: 'incompatible checkpoint' };
      }
      procCache_get().snapshot_restore(assembled.snapshot, assembled.writtenAt);
      return {
        restored: true,
        count: assembled.snapshot.instances.length,
        writtenAt: assembled.writtenAt,
        ...(assembled.torn.length > 0 ? { torn: assembled.torn } : {}),
      };
    }

    const legacy: unknown = await json_read(procCheckpointPath_get(identity, root));
    if (legacy === null) return { restored: false, count: 0, reason: 'no checkpoint' };
    if (!legacyFile_check(legacy, identity)) {
      return { restored: false, count: 0, reason: 'incompatible checkpoint' };
    }
    procCache_get().snapshot_restore(legacy.snapshot, legacy.writtenAt);
    await procCheckpoint_save(identity, root);
    return { restored: true, count: legacy.snapshot.instances.length, writtenAt: legacy.writtenAt, migrated: true };
  } catch (error: unknown) {
    return {
      restored: false,
      count: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Whether the in-memory roster is internally consistent: every feed whose
 * topology is loaded must exist in it. A cache violating that has been
 * amputated in memory (observed: a transiently-empty public-feeds walk
 * removed 641 feeds, and the watcher persisted the amputation over a good
 * checkpoint). Never durably replace good data with it.
 *
 * @returns True when the roster may be written.
 */
function roster_isConsistent(): boolean {
  const cache = procCache_get();
  const rosterIDs: Set<number> = new Set(cache.feedIDs_get());
  const orphaned: number = cache.shardedFeedIDs_get()
    .filter((id: number): boolean => cache.topologyLoaded_has(id) && !rosterIDs.has(id)).length;
  if (orphaned > 0) {
    errorStack.stack_push(
      'warning',
      `proc checkpoint skipped: ${orphaned} topology-loaded feeds missing from the roster (inconsistent snapshot)`,
    );
    return false;
  }
  return true;
}

/**
 * Atomically writes the roster shard (the feed index) for an identity.
 *
 * @param identity - Canonical ChRIS identity string.
 * @param root - Checkpoint directory override.
 * @returns Promise resolved after the file is durable in place; resolves
 *   without writing when the roster is inconsistent.
 */
export async function procCheckpointRoster_save(
  identity: string,
  root: string = procCheckpointRoot_get(),
): Promise<void> {
  if (!roster_isConsistent()) return;
  const dir: string = procCheckpointDir_get(identity, root);
  await dir_ensure(dir);
  const cache = procCache_get();
  const file: RosterFile = {
    schemaVersion: PROC_CHECKPOINT_SCHEMA,
    identity,
    writtenAt: new Date().toISOString(),
    feeds: cache.feedIDs_get().map((id: number): ProcFeed => ({ ...cache.feed_get(id)! })),
    unseen: cache.unseen_get(),
  };
  await json_write(join(dir, ROSTER_FILE), file);
  cache.checkpoint_mark(file.writtenAt);
}

/**
 * Atomically writes one feed's shard, or removes it when the feed no longer
 * holds topology (removed from the roster, or emptied).
 *
 * @param identity - Canonical ChRIS identity string.
 * @param feedID - The feed whose shard to write.
 * @param root - Checkpoint directory override.
 * @returns Promise resolved after the shard is durable in place.
 */
export async function procCheckpointFeed_save(
  identity: string,
  feedID: number,
  root: string = procCheckpointRoot_get(),
): Promise<void> {
  const dir: string = procCheckpointDir_get(identity, root);
  const cache = procCache_get();
  const snapshot: ProcFeedSnapshot = cache.feedSnapshot_create(feedID);
  const path: string = shardPath_get(dir, feedID);
  if (!cache.feed_get(feedID) || (snapshot.instances.length === 0 && !snapshot.loaded && snapshot.dataFacts === undefined)) {
    await fs.rm(path, { force: true });
    return;
  }
  await dir_ensure(dir);
  const file: ShardFile = {
    schemaVersion: PROC_CHECKPOINT_SCHEMA,
    identity,
    writtenAt: new Date().toISOString(),
    feedID,
    loaded: snapshot.loaded,
    instances: snapshot.instances,
    ...(snapshot.dataFacts === undefined ? {} : { dataFacts: snapshot.dataFacts }),
  };
  await json_write(path, file);
}

/**
 * Saves the whole process cache: the roster and every feed shard, removing
 * shards for feeds no longer in the roster.
 *
 * @param identity - Canonical ChRIS identity string.
 * @param root - Checkpoint directory override.
 * @returns Promise resolved after every file is durable in place; resolves
 *   without writing when the roster is inconsistent.
 */
export async function procCheckpoint_save(
  identity: string,
  root: string = procCheckpointRoot_get(),
): Promise<void> {
  if (!roster_isConsistent()) return;
  const dir: string = procCheckpointDir_get(identity, root);
  const cache = procCache_get();
  await procCheckpointRoster_save(identity, root);
  const wanted: Set<number> = new Set(cache.shardedFeedIDs_get());
  for (const feedID of wanted) await procCheckpointFeed_save(identity, feedID, root);
  for (const name of await fs.readdir(dir)) {
    const match: RegExpMatchArray | null = SHARD_PATTERN.exec(name);
    if (match && !wanted.has(Number(match[1]))) await fs.rm(join(dir, name), { force: true });
  }
}

/** The shard a change maps to: the roster, one feed, or everything. */
type ShardKey = 'roster' | 'all' | number;

/**
 * Starts a throttled, per-shard checkpoint writer for mutations to a
 * current cache. Each touched shard is written at least `delayMs` after
 * its first pending mutation and no more often than once per `floorMs`;
 * a burst of mutations to one feed coalesces into one write, and a quiet
 * feed's shard is never rewritten at all.
 *
 * @param identity - Canonical ChRIS identity string.
 * @param root - Checkpoint directory override.
 * @param delayMs - Debounce interval in milliseconds.
 * @param floorMs - Minimum spacing between two writes of the same shard.
 * @returns Function that stops watching and cancels pending saves.
 */
export function procCheckpoint_watch(
  identity: string,
  root: string = procCheckpointRoot_get(),
  delayMs: number = 1000,
  floorMs: number = PROC_CHECKPOINT_FLOOR_MS,
): () => void {
  const timers: Map<ShardKey, NodeJS.Timeout> = new Map();
  const lastWrite: Map<ShardKey, number> = new Map();
  // Layouts are kept beside the index this watcher keeps.
  procLayoutHome_set({ identity, root });

  // The identity this watcher writes for is the one connected when it was started. Once another has
  // connected, the tree is the other's: nothing more is written under this name.
  const began: number = identityEpoch_get();

  const shard_write = async (key: ShardKey): Promise<void> => {
    if (identityEpoch_get() !== began) return;
    if (key === 'roster') await procCheckpointRoster_save(identity, root);
    else if (key === 'all') await procCheckpoint_save(identity, root);
    else await procCheckpointFeed_save(identity, key, root);
  };

  const shard_schedule = (key: ShardKey): void => {
    if (timers.has(key) || identityEpoch_get() !== began) return;
    const earliest: number = (lastWrite.get(key) ?? 0) + floorMs;
    const wait: number = Math.max(delayMs, earliest - Date.now());
    const timer: NodeJS.Timeout = setTimeout((): void => {
      timers.delete(key);
      const now: number = Date.now();
      lastWrite.set(key, now);
      // A whole write is every shard written: each one's floor starts now,
      // or the next touch of a feed just written would write it again at once.
      if (key === 'all') {
        lastWrite.set('roster', now);
        for (const feedID of procCache_get().feedIDs_get()) lastWrite.set(feedID, now);
      }
      void shard_write(key).catch((): void => { /* next mutation retries */ });
    }, wait);
    timer.unref();
    timers.set(key, timer);
  };

  const listener_remove: () => void = procCache_get().changeListener_add((change: ProcCacheChange): void => {
    if (procCache_get().lifecycle_get().state !== 'current') return;
    if (change.scope === 'lifecycle') {
      // The cache has just become current: the sweep that built it emitted
      // its reconcile and every feed it marked BEFORE this moment, and all
      // of that was dropped above as not-yet-current. Nothing else will
      // announce the finished index — a quiet CUBE mutates nothing for
      // hours — so the roster and every shard are written whole now. A
      // session whose sweep ended at 16:47 and was killed at 18:30 had
      // fifty-six shards and no roster, and its next boot was cold.
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      shard_schedule('all');
      return;
    }
    if (change.scope === 'all') {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      shard_schedule('all');
      return;
    }
    if (timers.has('all')) return;
    shard_schedule(change.scope === 'roster' ? 'roster' : change.feedID);
  });

  return (): void => {
    listener_remove();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}

// ── Layouts ───────────────────────────────────────────────────────────────────

/** A node's place: x, y, z. */
export type ProcLayoutPosition = [number, number, number];

/**
 * Where a surface laid the space out under one layout.
 *
 * @property name - The layout (`galaxy`, `constellations`, ...).
 * @property positions - Every node's place, by the surface's node id.
 * @property writtenAt - When it was kept (ISO 8601).
 */
export interface ProcLayoutRecord {
  name: string;
  positions: Record<string, ProcLayoutPosition>;
  writtenAt: string;
}

/**
 * The longest node id a kept layout takes. A shape's hub is named by its
 * whole pipeline (`shape:r:pl-dircopy>0:pl-dyanon>...`), past 256 characters
 * for a long one — a bound that short refused a real space whole.
 */
export const PROC_LAYOUT_ID_MAX: number = 4096;
/** The most nodes a kept layout may hold: a large identity draws some 26,000. */
export const PROC_LAYOUT_NODES_MAX: number = 250_000;

/** The identity (and folder) the index is checkpointed for, once a watcher runs. */
let layoutHome: { identity: string; root: string } | null = null;
/** Layouts kept this session, by name: asked often, read from disk once. */
const layoutsHeld: Map<string, ProcLayoutRecord> = new Map();

/**
 * Whether a string names a layout: lower case, a letter first, short.
 *
 * @param name - The name.
 * @returns Whether it does.
 */
export function procLayoutName_check(name: string): boolean {
  return /^[a-z][a-z0-9-]{0,31}$/.test(name);
}

/**
 * Whether a value is a set of places: node ids to three finite numbers,
 * no more than {@link PROC_LAYOUT_NODES_MAX} of them.
 *
 * @param value - The value.
 * @returns Whether it is.
 */
export function procLayoutPositions_check(value: unknown): value is Record<string, ProcLayoutPosition> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries: Array<[string, unknown]> = Object.entries(value as Record<string, unknown>);
  if (entries.length > PROC_LAYOUT_NODES_MAX) return false;
  return entries.every(([id, at]): boolean =>
    id.length > 0 && id.length <= PROC_LAYOUT_ID_MAX && Array.isArray(at) && at.length === 3 && at.every((v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)));
}

/** The file a layout is kept in, when the index has a home. */
function layoutPath_get(name: string): string | null {
  return layoutHome === null ? null : join(procCheckpointDir_get(layoutHome.identity, layoutHome.root), `layout-${name}.json`);
}

/**
 * Where the space was last laid out under a layout: this session's copy, or
 * the checkpoint's. A file that does not hold what a layout holds is none.
 *
 * @param name - The layout.
 * @returns The record, or null when none is kept.
 */
export async function procLayout_get(name: string): Promise<ProcLayoutRecord | null> {
  if (!procLayoutName_check(name)) return null;
  const held: ProcLayoutRecord | undefined = layoutsHeld.get(name);
  if (held !== undefined) return held;
  const path: string | null = layoutPath_get(name);
  if (path === null) return null;
  let file: unknown = null;
  try {
    file = await json_read(path);
  } catch {
    return null;
  }
  if (!file || typeof file !== 'object') return null;
  const record: Partial<ProcLayoutRecord> & { schemaVersion?: unknown; identity?: unknown } = file as Partial<ProcLayoutRecord> & { schemaVersion?: unknown; identity?: unknown };
  if (record.schemaVersion !== PROC_CHECKPOINT_SCHEMA || record.identity !== layoutHome?.identity || record.name !== name
    || typeof record.writtenAt !== 'string' || !procLayoutPositions_check(record.positions)) return null;
  const kept: ProcLayoutRecord = { name, positions: record.positions, writtenAt: record.writtenAt };
  layoutsHeld.set(name, kept);
  return kept;
}

/**
 * Keeps where a surface laid the space out under a layout: for this session
 * at once, and in the checkpoint when the index has a home.
 *
 * @param name - The layout.
 * @param positions - Every node's place.
 * @returns The record kept.
 * @throws When the name or the places are not what a layout holds.
 */
export async function procLayout_set(name: string, positions: Record<string, ProcLayoutPosition>): Promise<ProcLayoutRecord> {
  if (!procLayoutName_check(name)) throw new Error(`not a layout name: ${name}`);
  if (!procLayoutPositions_check(positions)) throw new Error('not a set of places');
  const record: ProcLayoutRecord = { name, positions, writtenAt: new Date().toISOString() };
  layoutsHeld.set(name, record);
  const path: string | null = layoutPath_get(name);
  if (path !== null && layoutHome !== null) {
    await dir_ensure(dirname(path));
    await json_write(path, { schemaVersion: PROC_CHECKPOINT_SCHEMA, identity: layoutHome.identity, ...record });
  }
  return record;
}

/**
 * Forgets this session's layouts and where they are kept: a new identity, or a test.
 *
 * @param home - The identity and folder layouts are kept for, or null for none.
 */
export function procLayoutHome_set(home: { identity: string; root: string } | null): void {
  layoutHome = home;
  layoutsHeld.clear();
}
