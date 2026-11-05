/**
 * @file A lock (PROTECT) as the tenancy keeps it (AEGIS's a-change-is-a-loop,
 * clause 1; the operator, 2026-11-05): whether a VM or a cluster may be torn
 * down is the tenancy's, not one host's, so a lock set on one host holds on
 * every host. A lock travels with its time: of two, the newer is the lock.
 *
 * A host's record keeps the lock it acts on (`protected`), when it was set
 * (`protectedAt`) and the time of the lock the vault last held
 * (`lockKept`): the two times equal say the vault holds this host's lock.
 *
 * @module
 */

/** A lock, with when it was set. */
export interface KeptLock {
  readonly protected: boolean;
  readonly at: string;
}

/** What a record keeps of its lock. */
export interface LockedRecord {
  created: string;
  protected?: boolean;
  /** When the lock was last set; a record born before locks were timed reads its birth. */
  protectedAt?: string;
  /** The time of the lock the tenancy last held, as last read. */
  lockKept?: string;
}

/**
 * A record's own lock, with when it was set.
 *
 * @param record - The record.
 * @param bornProtected - What an absent `protected` reads as (a cluster: protected; a VM: as recorded).
 * @returns Its lock.
 */
export function lock_read(record: LockedRecord, bornProtected: boolean): KeptLock {
  return { protected: record.protected ?? bornProtected, at: record.protectedAt ?? record.created };
}

/**
 * The newer of two locks.
 *
 * @param first - One, or undefined.
 * @param second - The other, or undefined.
 * @returns The newer (the first on a tie), or undefined when neither is.
 */
export function lock_newer(first: KeptLock | undefined, second: KeptLock | undefined): KeptLock | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return second.at > first.at ? second : first;
}

/**
 * Takes the tenancy's lock into a record when it is newer than the record's,
 * and keeps its time as the tenancy's. Mutates the record (inside a store's
 * update).
 *
 * @param record - The record, being updated.
 * @param kept - The tenancy's lock, or undefined when it keeps none.
 * @param bornProtected - What an absent `protected` reads as.
 */
export function lock_adopt(record: LockedRecord, kept: KeptLock | undefined, bornProtected: boolean): void {
  if (kept === undefined) { delete record.lockKept; return; }
  const own: KeptLock = lock_read(record, bornProtected);
  if (kept.at > own.at) { record.protected = kept.protected; record.protectedAt = kept.at; }
  record.lockKept = kept.at;
}

/**
 * Whether the tenancy holds the lock this record acts on.
 *
 * @param record - The record.
 * @param bornProtected - What an absent `protected` reads as.
 * @returns True when the vault's lock is this one.
 */
export function lockKept_is(record: LockedRecord, bornProtected: boolean): boolean {
  return record.lockKept !== undefined && record.lockKept === lock_read(record, bornProtected).at;
}

/**
 * Where a lock is kept, in words, for a status line.
 *
 * @param record - The record.
 * @param bornProtected - What an absent `protected` reads as.
 * @returns `(kept in the tenancy, set <time> UTC)` or `(this host only, set <time> UTC)`.
 */
export function lock_where(record: LockedRecord, bornProtected: boolean): string {
  const at: string = lock_read(record, bornProtected).at.slice(0, 16).replace('T', ' ');
  return lockKept_is(record, bornProtected) ? `(kept in the tenancy, set ${at} UTC)` : `(this host only, set ${at} UTC)`;
}
