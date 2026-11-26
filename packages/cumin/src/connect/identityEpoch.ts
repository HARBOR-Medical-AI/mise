/**
 * @file Which identity a piece of work was begun under, and whether it is
 * still the one connected.
 *
 * A session has one identity at a time: a user on a CUBE. The caches that
 * hold what that identity sees (listings, folder records, the proc tree,
 * tags, PACS facts, the query index) are emptied when it changes. Emptying
 * is not enough by itself: a lookup begun as the first identity may finish
 * after the second has connected, and would put the first's answer into the
 * second's cache. So the identity is numbered (an epoch, raised at each
 * change), work is begun in a scope that remembers the epoch it began
 * under, and a cache takes a fill only from a scope whose epoch is the
 * current one.
 *
 * A `sudo` scope is not a change of identity: it is one piece of work done
 * with another user's client while the session's identity stands. What it
 * reads is neither taken from the session's caches nor put into them.
 *
 * Key components:
 * - {@link identityEpoch_get}, {@link identityEpoch_raise}: the number, and
 *   the one way it moves.
 * - {@link identityScope_run}: begins work under the current epoch.
 * - {@link identityElevated_run}: runs work as another user, with their client.
 * - {@link identityCache_usable}: what a cache asks before a read or a fill.
 * - {@link identityChange_listen}: what a cache does when the identity changes.
 *
 * Typical usage:
 * ```typescript
 * identityChange_listen((): void => { cache.clear(); });
 * await identityScope_run(async (): Promise<void> => {
 *   const rows = await fetch_rows();
 *   if (identityCache_usable()) cache.set(key, rows);
 * });
 * ```
 *
 * Dependencies: `node:async_hooks` only. It imports nothing of cumin, so
 * every cache and the connection can import it. It keeps one store, which
 * the connection's `sudo` scope uses too.
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** What a scope of work remembers. */
interface IdentityScope {
  /** The epoch the work began under, or the one it raised to itself. */
  epoch: number;
  /** The client of another user the work is being done with (a `sudo`), or null for the session's own. */
  elevatedWith: object | null;
}

/** The current epoch. */
let current: number = 0;

/** What is called at each change. */
const listeners: Set<() => void> = new Set<() => void>();

/** The scope a piece of work runs in: the one store this module keeps. */
const scopes: AsyncLocalStorage<IdentityScope> = new AsyncLocalStorage<IdentityScope>();

/**
 * The scope the work now running is in.
 *
 * @returns The scope, or undefined for work begun in none.
 */
function scope_get(): IdentityScope | undefined {
  return scopes.getStore();
}

/**
 * Runs work in a scope.
 *
 * @param scope - The scope.
 * @param work - The work.
 * @returns What the work returns.
 */
function scope_run<T>(scope: IdentityScope, work: () => T): T {
  const returned: T = scopes.run(scope, work);
  return returned;
}

/**
 * The current epoch.
 *
 * @returns The number of changes of identity so far.
 *
 * @example
 * const began: number = identityEpoch_get();
 */
export function identityEpoch_get(): number {
  return current;
}

/**
 * The epoch the work now running was begun under.
 *
 * @returns Its scope's epoch; the current one for work begun in no scope.
 *
 * @example
 * const entry = { epoch: identityScopeEpoch_get(), value };
 */
export function identityScopeEpoch_get(): number {
  return scope_get()?.epoch ?? current;
}

/**
 * Says that the identity has changed: someone connected, the context was
 * moved to another user or CUBE, or the session logged out. Every listener
 * is called, at once and in turn. The work that made the change (the
 * `connect` itself) carries on under the new epoch: what it fills next is
 * the new identity's.
 *
 * @example
 * this.authToken = token;
 * identityEpoch_raise();
 */
export function identityEpoch_raise(): void {
  current += 1;
  const scope: IdentityScope | undefined = scope_get();
  if (scope !== undefined) scope.epoch = current;
  for (const change_tell of [...listeners]) change_tell();
}

/**
 * Registers what to do when the identity changes (a cache empties itself).
 *
 * @param listener - Called at each change, after the epoch has moved.
 * @returns A function that removes the listener.
 *
 * @example
 * const stop = identityChange_listen((): void => { cache.clear(); });
 */
export function identityChange_listen(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => { listeners.delete(listener); };
}

/**
 * Runs a piece of work in a scope, begun under the current epoch.
 * Everything it awaits, and every timer it starts, is in that scope. A
 * command, a request to the daemon, a warm-up and a watcher are each begun
 * this way. Work already in a scope stays in it (a command run by a
 * command is part of the same work): so work begun under an identity since
 * replaced cannot make itself current by starting something.
 *
 * @param work - The work.
 * @returns What the work returns.
 *
 * @example
 * await identityScope_run((): Promise<void> => command_run(line));
 */
export function identityScope_run<T>(work: () => T): T {
  if (scope_get() !== undefined) return work();
  return scope_run({ epoch: current, elevatedWith: null }, work);
}

/**
 * Runs a piece of work as another user (a `sudo`): with their client, for
 * the length of that work and for nothing else. The epoch it runs under is
 * the one it was begun under.
 *
 * @param client - The other user's client.
 * @param work - The work.
 * @returns What the work returns.
 *
 * @example
 * return identityElevated_run(elevatedClient, operation);
 */
export function identityElevated_run<T>(client: object, work: () => T): T {
  return scope_run({ epoch: identityScopeEpoch_get(), elevatedWith: client }, work);
}

/**
 * The client of the other user the work now running is being done as.
 *
 * @returns Their client, or null when the work is the session's own.
 *
 * @example
 * const elevated: object | null = identityElevatedClient_get();
 */
export function identityElevatedClient_get(): object | null {
  return scope_get()?.elevatedWith ?? null;
}

/**
 * Whether the work now running is done under another user's client.
 *
 * @returns True inside a `sudo` scope.
 *
 * @example
 * if (identityElevated_is()) return null;
 */
export function identityElevated_is(): boolean {
  return identityElevatedClient_get() !== null;
}

/**
 * Whether the work now running may read from, and fill, the caches of the
 * session's identity: it was begun under the identity that is connected
 * now, and it is not being done as another user.
 *
 * @returns False for work begun before the last change of identity, and
 *   for work in a `sudo` scope.
 *
 * @example
 * if (identityCache_usable()) cache.set(key, rows);
 */
export function identityCache_usable(): boolean {
  return !identityElevated_is() && identityScopeEpoch_get() === current;
}

/**
 * Whether the work now running was begun under an identity that is no
 * longer the one connected. A watcher or a loop asks this, and stops.
 *
 * @returns True once the identity has changed since the work began.
 *
 * @example
 * if (identityScope_passed()) return;
 */
export function identityScope_passed(): boolean {
  return identityScopeEpoch_get() !== current;
}
