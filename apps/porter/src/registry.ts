/**
 * @file Who is behind which door.
 *
 * A browser names its session by a short key in the path — `/s/<key>/` —
 * never by the identity, which carries a URL with slashes in it and is the
 * operator's business, not the URL bar's. The key is the berth key calypso
 * already computes for the identity, so a porter restarted finds the same
 * key for the same operator. The registry maps key to identity and to the
 * berth the door last saw.
 *
 * @module
 */
import { berthKey_compute } from '@fnndsc/calypso/berth';
import type { Berth, SessionHost } from './host/sessionHost.js';

/** One identity the door has let through. */
export interface SessionEntry {
  key: string;
  identity: string;
  user: string;
  berth: Berth;
  /** When something last reached the session through the door, epoch ms. */
  activeAt: number;
  /** How many wires — relayed WebSockets — stand open on it right now. */
  wires: number;
  /** Which life of the session this is: one boot, from its start to the berth it answers at. */
  life: number;
}

/** A session the door has admitted but whose berth has not answered yet. */
interface PendingEntry {
  key: string;
  identity: string;
  user: string;
  /** The life this boot begins. */
  life: number;
}

/**
 * A session the sweep has claimed in order to end it: the entry it found
 * idle, held so that nothing else takes the session for live while it is
 * being stopped.
 *
 * @example
 * const claim: EvictionClaim | null = registry.eviction_begin(entry, idleMs);
 * if (claim !== null) registry.eviction_end(claim, await host.evict(entry.identity));
 */
export interface EvictionClaim {
  /** The entry that was found idle, and is being ended. */
  readonly entry: SessionEntry;
  /** Settles when the claim is ended: what a login for the key waits on. */
  readonly done: Promise<void>;
}

/** The sessions the door knows, by key. */
export class SessionRegistry {
  private readonly byKey: Map<string, SessionEntry> = new Map();
  private readonly pending: Map<string, PendingEntry> = new Map();
  /** The last life handed out; every boot, and every berth found that is not the one on record, is a new one. */
  private lifeLast: number = 0;
  /**
   * How many times each key's session has been ended, or begun to be. It is
   * raised when an ending begins and never lowered, so an ending that has
   * come and gone is as visible as one under way: whoever read the number
   * before a wait and finds it moved after knows that what they learnt of
   * the session's berth before the wait is of a berth since stopped.
   */
  private readonly generations: Map<string, number> = new Map();
  /** The endings under way, by key: each resolves when its session has stopped, or could not be. */
  private readonly evictions: Map<string, Promise<void>> = new Map();
  /** How many ends of each key's session have been asked for and are not over. */
  private readonly ends: Map<string, number> = new Map<string, number>();
  /** What settles each ending under way, by its promise. */
  private readonly settlers: WeakMap<Promise<void>, () => void> = new WeakMap<Promise<void>, () => void>();
  private readonly clock: () => number;

  constructor(clock: () => number = (): number => Date.now()) {
    this.clock = clock;
  }

  /**
   * The key an identity is addressed by.
   *
   * @param identity - The normalised identity.
   * @returns Sixteen hex characters, stable for the identity.
   */
  public key_derive(identity: string): string {
    return berthKey_compute(identity);
  }

  /**
   * Records an identity and the berth it answers at; a known one keeps its wires. The berth on record again (the
   * same address and attach token) keeps its life; a boot that settles gives its berth the boot's; any other
   * berth is a life of its own.
   *
   * @param identity - The identity.
   * @param user - The person.
   * @param berth - The berth it answers at.
   * @param life - The life of the boot that made the berth, when a boot settles.
   * @returns The entry.
   */
  public note(identity: string, user: string, berth: Berth, life?: number): SessionEntry {
    const key: string = this.key_derive(identity);
    const known: SessionEntry | undefined = this.byKey.get(key);
    const same: boolean = known !== undefined && known.berth.url === berth.url && known.berth.token === berth.token;
    const entry: SessionEntry = { key, identity, user, berth, activeAt: this.clock(), wires: known?.wires ?? 0, life: life ?? (same && known !== undefined ? known.life : ++this.lifeLast) };
    this.byKey.set(key, entry);
    return entry;
  }

  /** Something reached the session through the door just now. */
  public activity_note(key: string): void {
    const entry: SessionEntry | undefined = this.byKey.get(key);
    if (entry !== undefined) entry.activeAt = this.clock();
  }

  /** A wire opened on the session, or closed. */
  public wire_count(key: string, delta: 1 | -1): void {
    const entry: SessionEntry | undefined = this.byKey.get(key);
    if (entry === undefined) return;
    entry.wires = Math.max(0, entry.wires + delta);
    entry.activeAt = this.clock();
  }

  /**
   * The sessions nobody has touched for longer than the span: no wire open,
   * nothing through the door since.
   *
   * @param idleMs - The span.
   * @returns The idle entries.
   */
  public idle_list(idleMs: number): SessionEntry[] {
    const now: number = this.clock();
    return [...this.byKey.values()].filter((entry: SessionEntry): boolean => entry.wires === 0 && now - entry.activeAt > idleMs);
  }

  /**
   * Records an identity whose session is booting; the berth comes later.
   * A boot starts only when no live session answers, so an entry still
   * held for the identity names a daemon that is gone — it is dropped, or
   * the mount would keep sending the new session's traffic to the dead
   * one's port.
   *
   * @param identity - The identity.
   * @param user - The person.
   * @param joins - The login joins the boot already under way, rather than beginning one.
   */
  public pending_note(identity: string, user: string, joins: boolean = false): void {
    const key: string = this.key_derive(identity);
    this.byKey.delete(key);
    // A login that joins a boot under way keeps that boot's life; any other note begins a boot, and a life.
    const joined: PendingEntry | undefined = joins ? this.pending.get(key) : undefined;
    this.pending.set(key, { key, identity, user, life: joined?.life ?? ++this.lifeLast });
  }

  /**
   * Which life of a key's session stands now, booting or answering.
   *
   * @param key - The session key.
   * @returns The life, or null when no session is recorded under the key.
   *
   * @example
   * const life: number | null = registry.life_get(key);
   */
  public life_get(key: string): number | null {
    return this.byKey.get(key)?.life ?? this.pending.get(key)?.life ?? null;
  }

  /** The identity behind a key, admitted or still booting. */
  public identity_find(key: string): string | null {
    return this.byKey.get(key)?.identity ?? this.pending.get(key)?.identity ?? null;
  }

  /**
   * Moves a booting identity into the registry once its berth answers.
   *
   * @param identity - The identity whose boot ended.
   * @param host - Where to read the berth from.
   * @returns The entry, or null when the boot ended without a berth.
   */
  public async settle(identity: string, host: Pick<SessionHost, 'find'>): Promise<SessionEntry | null> {
    const key: string = this.key_derive(identity);
    const waiting: PendingEntry | undefined = this.pending.get(key);
    if (waiting === undefined) return this.byKey.get(key) ?? null;
    const berth: Berth | null = await host.find(identity);
    if (berth === null) return null;
    this.pending.delete(key);
    return this.note(identity, waiting.user, berth, waiting.life);
  }

  /** Looks a key up. */
  public get(key: string): SessionEntry | null {
    return this.byKey.get(key) ?? null;
  }

  /** Forgets a key. */
  public forget(key: string): void {
    this.byKey.delete(key);
    this.pending.delete(key);
  }

  /**
   * How many times a key's session has been ended, or begun to be.
   *
   * @param key - The session key.
   * @returns The count; it only rises.
   *
   * @example
   * const began: number = registry.generation_get(key);
   */
  public generation_get(key: string): number {
    return this.generations.get(key) ?? 0;
  }

  /**
   * Says that a key's session is being ended (a restart, a logout, the
   * sweep): what anyone learnt of its berth before now is of a berth about
   * to stop.
   *
   * @param key - The session key.
   *
   * @example
   * registry.generation_raise(key);
   */
  public generation_raise(key: string): void {
    this.generations.set(key, this.generation_get(key) + 1);
  }

  /**
   * Claims an idle session in order to end it. The claim is made on what is
   * true at this moment, not on what was true when the idle sessions were
   * listed: the key must still hold that very entry, with no wire open on
   * it, nothing through the door for the idle span, nothing waiting to boot
   * under it, and no ending of it already under way. From the claim until
   * its end, a login for the key waits ({@link eviction_wait}).
   *
   * @param entry - The entry found idle.
   * @param idleMs - The idle span.
   * @returns The claim, or null when the session is no longer idle, or no longer that one.
   *
   * @example
   * const claim: EvictionClaim | null = registry.eviction_begin(entry, idleMs);
   */
  public eviction_begin(entry: SessionEntry, idleMs: number): EvictionClaim | null {
    const key: string = entry.key;
    if (this.byKey.get(key) !== entry || this.pending.has(key) || this.evictions.has(key)) return null;
    if (entry.wires !== 0 || this.clock() - entry.activeAt <= idleMs) return null;
    this.generation_raise(key);
    let wait_settle: () => void = (): void => undefined;
    const done: Promise<void> = new Promise((resolve: () => void): void => { wait_settle = resolve; });
    this.evictions.set(key, done);
    this.settlers.set(done, wait_settle);
    return { entry, done };
  }

  /**
   * Ends a claim.
   *
   * @param claim - The claim.
   * @param ended - Whether the session was ended. When it was, the entry is
   *   forgotten, if the key still holds that very entry and nothing is
   *   waiting to boot under it; when it was not, nothing is forgotten.
   *
   * @example
   * registry.eviction_end(claim, true);
   */
  public eviction_end(claim: EvictionClaim, ended: boolean): void {
    const key: string = claim.entry.key;
    // Only that generation is forgotten: a session noted under the key since is another, and stays.
    if (ended && this.byKey.get(key) === claim.entry && !this.pending.has(key)) this.byKey.delete(key);
    if (this.evictions.get(key) === claim.done) this.evictions.delete(key);
    this.settlers.get(claim.done)?.();
  }

  /**
   * Runs an ending of a key's session that is not the sweep's (a logout,
   * an administrator's end) as the one ending under way for the key: it
   * waits for any that is, raises the generation, and until it is over a
   * login for the key waits and the sweep claims nothing under the key.
   *
   * @param key - The session key.
   * @param work - The stop.
   * @param kind - An end of the session (the default), or the stop that begins a restart of it.
   * @returns What the stop returns.
   *
   * @example
   * const ended: boolean = await registry.ending_run(key, (): Promise<boolean> => host.evict(identity));
   */
  public async ending_run<T>(key: string, work: () => Promise<T>, kind: 'end' | 'restart' = 'end'): Promise<T> {
    // An end asked for (a logout, an administrator's end) is counted from the moment it is asked until it
    // is over, the time it waits behind a restart included: a login meanwhile does not join that restart.
    if (kind === 'end') this.ends.set(key, (this.ends.get(key) ?? 0) + 1);
    // One at a time for a key: each waits for the one before, in the order asked.
    const before: Promise<void> | undefined = this.evictions.get(key);
    let wait_settle: () => void = (): void => undefined;
    const done: Promise<void> = new Promise((resolve: () => void): void => { wait_settle = resolve; });
    this.evictions.set(key, done);
    this.generation_raise(key);
    try {
      if (before !== undefined) await before;
      return await work();
    } finally {
      if (kind === 'end') {
        const left: number = (this.ends.get(key) ?? 1) - 1;
        if (left > 0) this.ends.set(key, left);
        else this.ends.delete(key);
      }
      if (this.evictions.get(key) === done) this.evictions.delete(key);
      wait_settle();
    }
  }

  /**
   * Says whether an end of a key's session has been asked for and is not
   * over: under way, or waiting its turn behind a restart.
   *
   * @param key - The session key.
   * @returns True while one is.
   *
   * @example
   * if (!registry.end_pending(key)) joinTheBoot();
   */
  public end_pending(key: string): boolean {
    return (this.ends.get(key) ?? 0) > 0;
  }

  /**
   * Waits for an ending of a key's session that is under way.
   *
   * @param key - The session key.
   *
   * @example
   * await registry.eviction_wait(key);
   */
  public async eviction_wait(key: string): Promise<void> {
    // Until none is: another may have been asked for while the one before was awaited.
    for (let under: Promise<void> | undefined = this.evictions.get(key); under !== undefined; under = this.evictions.get(key)) await under;
  }

  /** Every entry, for a status listing. */
  public all(): SessionEntry[] {
    return [...this.byKey.values()];
  }
}
