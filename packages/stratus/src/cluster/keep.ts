/**
 * @file What the tenancy keeps of a cluster beyond its stacks: its lock
 * (PROTECT), with when it was set, as one secret in the tenancy's vault,
 * `mise-cluster-<name>` (AEGIS's a-change-is-a-loop, clause 1; the operator,
 * 2026-11-05). A lock set on one host holds on every host; of two the newer
 * is the lock (`kept/lock.ts`). Written when a MANAGE session sets the lock,
 * read on each status and before a teardown acts.
 *
 * @module
 */
import type { BuildCall, CloudBuilder } from '../cloud/builder.js';
import { lock_adopt, lock_newer, lock_read, type KeptLock } from '../kept/lock.js';
import type { ClusterRecord, ClusterStore } from './state.js';

/** What one cluster's secret holds. */
export interface ClusterKept {
  readonly cluster: string;
  readonly lock?: KeptLock;
}

/**
 * The secret's name in the tenancy's vault.
 *
 * @param name - The cluster.
 * @returns `mise-cluster-<name>`.
 */
export function clusterKeepName_derive(name: string): string {
  return `mise-cluster-${name}`;
}

/**
 * The vault's keep of a cluster, read and checked.
 *
 * @param builder - The cloud.
 * @param name - The cluster.
 * @param region - Its region.
 * @returns The keep, or null when the vault keeps nothing of it (or this cloud keeps nothing).
 * @throws Error - When the secret is not a cluster's keep.
 */
export async function clusterKept_read(builder: CloudBuilder, name: string, region: string): Promise<ClusterKept | null> {
  if (builder.keep_read === undefined) return null;
  const content: string | null = await builder.keep_read({ region, name: clusterKeepName_derive(name) });
  if (content === null) return null;
  const kept: ClusterKept = JSON.parse(content) as ClusterKept;
  if (kept.cluster !== name) throw new Error(`${clusterKeepName_derive(name)}: the tenancy's secret is not a cluster's keep`);
  return kept;
}

/**
 * Takes the vault's lock into the record when newer, and keeps its time as the tenancy's.
 *
 * @param store - The clusters.
 * @param name - The cluster; its record must exist.
 * @param kept - The vault's keep.
 */
export function clusterLock_adopt(store: ClusterStore, name: string, kept: ClusterKept | null): void {
  if (store.record_read(name) === null) return;
  store.record_update(name, (current: ClusterRecord): void => { lock_adopt(current, kept?.lock, true); });
}

/**
 * Writes the cluster's lock to the tenancy, the newer of this host's and the
 * vault's, and takes that one back into the record.
 *
 * @param builder - The cloud.
 * @param store - The clusters.
 * @param name - The cluster; its record must exist.
 * @param call - The step's log and stop.
 * @throws Error - When the cloud keeps nothing.
 */
export async function clusterLock_write(builder: CloudBuilder, store: ClusterStore, name: string, call: BuildCall): Promise<void> {
  if (builder.keep_write === undefined) throw new Error('this cloud keeps nothing in the tenancy');
  const record: ClusterRecord = store.record_read(name) as ClusterRecord;
  const vault: ClusterKept | null = await clusterKept_read(builder, name, record.region);
  const lock: KeptLock = lock_newer(lock_read(record, true), vault?.lock) as KeptLock;
  const kept: ClusterKept = { cluster: name, lock };
  await builder.keep_write({ region: record.region, name: clusterKeepName_derive(name), content: JSON.stringify(kept) }, call);
  clusterLock_adopt(store, name, kept);
}

/**
 * The lock as the tenancy keeps it now, taken into the record; this host's as
 * it was when the vault does not answer or this cloud keeps nothing.
 *
 * @param builder - The cloud, or null.
 * @param store - The clusters.
 * @param name - The cluster; its record must exist.
 * @returns The record after the read.
 */
export async function clusterLock_refresh(builder: CloudBuilder | null, store: ClusterStore, name: string): Promise<ClusterRecord> {
  const record: ClusterRecord = store.record_read(name) as ClusterRecord;
  if (builder?.keep_read === undefined) return record;
  try {
    clusterLock_adopt(store, name, await clusterKept_read(builder, name, record.region));
  } catch {
    // The vault did not answer: the lock stays as last read.
  }
  return store.record_read(name) as ClusterRecord;
}
