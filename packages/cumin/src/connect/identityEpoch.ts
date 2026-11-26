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
 * - {@link identityPartition_make}: a cache that other work sees a spare of.
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
  /** The epoch the work began under. It never changes. */
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
 * is called, at once and in turn. Every piece of work already begun,
 * the one that made the change included, stays under the epoch it began
 * under: a scope is never moved to a later epoch, since work it started
 * before the change shares it. What the new identity fills, it fills from
 * work begun after the change (the next line, the warm-up that follows a
 * login).
 *
 * @example
 * this.authToken = token;
 * identityEpoch_raise();
 */
export function identityEpoch_raise(): void {
  current += 1;
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
 * A cache as each piece of work is to see it: the session's own, for work
 * begun under the identity now connected and done as that identity; and
 * for any other work (begun before the identity changed, or done as
 * another user under `sudo`) a spare of its own, empty at first and thrown
 * away with the work. So such work can go on building and reading what it
 * needs (a `sudo ls /proc` builds a tree and lists it) without seeing a
 * thing the session's identity was shown, and without leaving a thing
 * behind for it. Which of the two is used is decided at each call, from
 * the work that makes the call: a reference taken before a change of
 * identity does not go on reaching the session's own after it.
 *
 * @param own - The session's cache.
 * @param spareMake - Makes an empty one for a piece of other work.
 * @returns The cache to hand out: it looks like `own`, and is.
 *
 * @example
 * const shared: ProcCache = identityPartition_make(new ProcCache(), (): ProcCache => new ProcCache());
 */
export function identityPartition_make<T extends object>(own: T, spareMake: () => T): T {
  const spares: WeakMap<object, T> = new WeakMap<object, T>();
  const recipient_get = (): T => {
    const scope: IdentityScope | undefined = scope_get();
    if (scope === undefined || identityCache_usable()) return own;
    let spare: T | undefined = spares.get(scope);
    if (spare === undefined) {
      spare = spareMake();
      spares.set(scope, spare);
    }
    return spare;
  };
  return new Proxy(own, {
    // (The trap's name is the language's, written as a key so that it is not read as one of this code's.)
    ['get']: (...trap: [T, string | symbol, unknown]): unknown => {
      const property: string | symbol = trap[1];
      const recipient: T = recipient_get();
      const member: unknown = Reflect.get(recipient, property, recipient);
      if (typeof member !== 'function') return member;
      // A function put on the cache itself (a stand-in a test put in a method's place) is handed out as it is.
      if (Object.prototype.hasOwnProperty.call(recipient, property)) return member;
      // Decided again when it is called: a method taken now and called after a change is the caller's then.
      return (...given: unknown[]): unknown => {
        const called: T = recipient_get();
        // The member as it was when taken, unless the call is another piece of work's: then that one's.
        const method: unknown = called === recipient ? member : Reflect.get(called, property, called);
        return (method as (...args: unknown[]) => unknown).apply(called, given);
      };
    },
  });
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
