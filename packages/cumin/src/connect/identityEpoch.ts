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
 * - {@link identityOwned_make}: the same, for bookkeeping that is not a cache.
 * - {@link identityScope_fork}: begins work that goes on beside its beginner.
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
  /** The identity epoch the work was begun under. */
  readonly epoch: number;
  /** The client of another user the work is done as, or null. */
  readonly elevatedWith: object | null;
  /** The work that began this one in turn, or null for work that stands alone. */
  readonly parent: IdentityScope | null;
  /** What caches made for other work are filed under: shared by work begun in turn under one identity. */
  readonly key: object;
  /** The epoch a change of identity made inside this work raised to, or null: what its next step is begun under. */
  handed: number | null;
}

/** The current epoch. */
let current: number = 0;

/** What is called at each change, with the name of who is connected after it, or null when nobody is. */
const listeners: Set<(now: string | null) => void> = new Set<(now: string | null) => void>();

/** The name of who is connected now (`user@url`), or null. */
let named: string | null = null;

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
 * is called, at once and in turn, with the name of who is connected now.
 * Every piece of work already begun, the one that made the change
 * included, stays under the epoch it began under: a scope is never moved
 * to a later epoch, since work it started before the change shares it.
 * The work that made the change, and whatever began it in turn, are told
 * the new epoch, and the next step each begins (see
 * {@link identityScope_turn}) is the new identity's.
 *
 * @param now - The name of who is connected after the change (`user@url`), or null when nobody is.
 *
 * @example
 * this.authToken = token;
 * identityEpoch_raise('chris@https://cube/api/v1/');
 */
export function identityEpoch_raise(now: string | null = null): void {
  current += 1;
  named = now;
  for (let scope: IdentityScope | null = scope_get() ?? null; scope !== null; scope = scope.parent) scope.handed = current;
  for (const change_tell of [...listeners]) change_tell(now);
}

/**
 * Spells an identity's name the one way it is spelt everywhere: the
 * user exactly as given, the address with its scheme and host in lower
 * case and its path as written. The daemon's berth, the checkpoints and
 * the change of identity all use this spelling, so one user at one CUBE
 * is one name however the address was typed.
 *
 * @param user - The CUBE user name.
 * @param cubeUrl - The CUBE address.
 * @returns `user@address`.
 *
 * @example
 * identityName_spell('chris', 'HTTPS://Cube.Example/api/v1/'); // 'chris@https://cube.example/api/v1/'
 */
export function identityName_spell(user: string, cubeUrl: string): string {
  const schemeSplit: number = cubeUrl.indexOf('://');
  if (schemeSplit === -1) return `${user}@${cubeUrl}`;
  const rest: string = cubeUrl.slice(schemeSplit + 3);
  const pathStart: number = rest.indexOf('/');
  const authority: string = pathStart === -1 ? rest : rest.slice(0, pathStart);
  const path: string = pathStart === -1 ? '' : rest.slice(pathStart);
  return `${user}@${cubeUrl.slice(0, schemeSplit).toLowerCase()}://${authority.toLowerCase()}${path}`;
}

/**
 * The name of who is connected now.
 *
 * @returns `user@url`, or null when nobody is connected (or nobody has said).
 *
 * @example
 * const identity: string | null = identityName_get();
 */
export function identityName_get(): string | null {
  return named;
}

/**
 * Registers what to do when the identity changes (a cache empties itself).
 *
 * @param listener - Called at each change, after the epoch has moved, with the name of who is connected now.
 * @returns A function that removes the listener.
 *
 * @example
 * const stop = identityChange_listen((): void => { cache.clear(); });
 */
export function identityChange_listen(listener: (now: string | null) => void): () => void {
  listeners.add(listener);
  return (): void => { listeners.delete(listener); };
}

/**
 * Runs a piece of work in a scope, begun under the current epoch.
 * Everything it awaits, and every timer it starts, is in that scope. A
 * command, a request to the daemon, a warm-up and a watcher are each begun
 * this way.
 *
 * Work already in a scope stays in it (a command run by a command is part
 * of the same work): so work begun under an identity since replaced cannot
 * make itself current by starting something. Steps that go in turn are
 * begun with {@link identityScope_turn}.
 *
 * @param work - The work.
 * @returns What the work returns.
 *
 * @example
 * await identityScope_run((): Promise<void> => command_run(line));
 */
export function identityScope_run<T>(work: () => T): T {
  const scope: IdentityScope | undefined = scope_get();
  if (scope === undefined) return scope_run({ epoch: current, elevatedWith: null, parent: null, key: {}, handed: null }, work);
  return work();
}

/**
 * Runs the next step of work that goes in turn: a command of a line, a
 * line of a script.
 *
 * A step is begun as its beginner was, unless a step before it changed
 * who is connected: then it is begun under the identity that step
 * connected, so `connect other; ls` lists as the other. Only a step begun
 * here is handed on to. What a step started and left running, and anything
 * that merely calls {@link identityScope_run} later, stays what it was
 * begun as; and a change made by unrelated work (another line, another
 * surface) is handed to nobody here.
 *
 * @param work - The step.
 * @returns Whatever the step returns.
 *
 * @example
 * await identityScope_turn((): Promise<void> => command_run('connect other'));
 * await identityScope_turn((): Promise<void> => command_run('ls'));
 */
export function identityScope_turn<T>(work: () => T): T {
  const scope: IdentityScope | undefined = scope_get();
  if (scope === undefined) return scope_run({ epoch: current, elevatedWith: null, parent: null, key: {}, handed: null }, work);
  const epoch: number = scope.handed ?? scope.epoch;
  return scope_run({ epoch, elevatedWith: scope.elevatedWith, parent: scope, key: epoch === scope.epoch ? scope.key : {}, handed: null }, work);
}

/**
 * Takes hold of a place for work that goes on beside its beginner and
 * comes back to itself later: a watch and its timers.
 *
 * The place is begun under the identity current to the caller, as
 * {@link identityScope_fork} begins one, and never as another user: what
 * outlives a `sudo` is not the other user's. Every piece of work run
 * through what is returned runs in that same place, whoever's work calls
 * it.
 *
 * @returns A runner: it runs the work it is given in the held place.
 *
 * @example
 * const within = identityScope_hold();
 * setTimeout((): void => { within((): void => { tick(); }); }, 1000);
 */
export function identityScope_hold(): <T>(work: () => T) => T {
  const held: IdentityScope = { epoch: scope_get()?.epoch ?? current, elevatedWith: null, parent: null, key: {}, handed: null };
  return <T>(work: () => T): T => scope_run(held, work);
}

/**
 * Runs a piece of work that goes on by itself beside the work that began
 * it (a job left in the background, a watch, a timer's tick): in a scope
 * of its own, under the epoch its beginner is under. It is stale when its
 * beginner is, and it is never handed on to a later identity: if the line
 * that began it goes on to connect as someone else, this is still the
 * first identity's work.
 *
 * @param work - The work.
 * @returns What the work returns.
 *
 * @example
 * void identityScope_fork((): Promise<void> => watch_tick(feedID));
 */
export function identityScope_fork<T>(work: () => T): T {
  const scope: IdentityScope | undefined = scope_get();
  return scope_run({ epoch: scope?.epoch ?? current, elevatedWith: scope?.elevatedWith ?? null, parent: null, key: {}, handed: null }, work);
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
  return scope_run({ epoch: identityScopeEpoch_get(), elevatedWith: client, parent: scope_get() ?? null, key: {}, handed: null }, work);
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
    let spare: T | undefined = spares.get(scope.key);
    if (spare === undefined) {
      spare = spareMake();
      spares.set(scope.key, spare);
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
 * State that belongs to one identity, as each piece of work is to see it:
 * a plain object of bookkeeping (what has been visited, what is in flight)
 * that the session's own current work shares, that is made anew at each
 * change of identity, and of which any other work (begun before the
 * change, or done as another user) has a copy of its own. The same rule as
 * {@link identityPartition_make}, for state that is not a cache.
 *
 * @param make - Makes the state, empty.
 * @returns A function that answers the state for the work that calls it.
 *
 * @example
 * const visits_get = identityOwned_make((): Visits => ({ byFeed: new Map(), inflight: new Map() }));
 * visits_get().byFeed.set(feedID, visit);
 */
export function identityOwned_make<T extends object>(make: () => T): () => T {
  let own: T = make();
  let ownEpoch: number = current;
  const spares: WeakMap<object, T> = new WeakMap<object, T>();
  return (): T => {
    const scope: IdentityScope | undefined = scope_get();
    if (scope === undefined || identityCache_usable()) {
      // Made anew for each identity, the first time that identity's work asks.
      if (ownEpoch !== current) {
        own = make();
        ownEpoch = current;
      }
      return own;
    }
    let spare: T | undefined = spares.get(scope.key);
    if (spare === undefined) {
      spare = make();
      spares.set(scope.key, spare);
    }
    return spare;
  };
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
