/**
 * @file The two small memories a route that asks CUBE keeps: how often a
 * client has asked, and what CUBE last said of one set of credentials.
 *
 * @module
 */
import { createHash } from 'node:crypto';

/** The most headers the verdict memory holds; the oldest are let go past it. */
const MEMORY_CAP: number = 1024;

/**
 * The most keys a count holds. A count never lets go of a key that still
 * counts to make room for another: past this many live keys a new one is
 * turned away until an old one has aged out, which is the count failing
 * closed. Large enough that only a flood from very many addresses or
 * names reaches it.
 */
export const COUNT_CAP: number = 16_384;

/** A per-client allowance: so many hits in a sliding span. */
export class HitLimit {
  private readonly hits: Map<string, number[]> = new Map();
  private readonly allowed: number;
  private readonly spanMs: number;
  private readonly now: () => number;
  private readonly cap: number;

  /**
   * @param allowed - The hits one client may make in the span.
   * @param spanMs - The span, in ms.
   * @param now - The clock, in ms; the system's by default.
   * @param cap - The most clients remembered at once.
   */
  constructor(allowed: number, spanMs: number, now: () => number = Date.now, cap: number = COUNT_CAP) {
    this.allowed = allowed;
    this.spanMs = spanMs;
    this.now = now;
    this.cap = cap;
  }

  /**
   * Counts a hit from a client.
   *
   * @param client - Who is asking (an address).
   * @returns Zero when the hit is allowed; otherwise the whole seconds until the client may ask again.
   */
  public hit_take(client: string): number {
    const at: number = this.now();
    const recent: number[] = (this.hits.get(client) ?? []).filter((one: number): boolean => at - one < this.spanMs);
    if (recent.length >= this.allowed) {
      this.hits.set(client, recent);
      return Math.max(1, Math.ceil(((recent[0] as number) + this.spanMs - at) / 1000));
    }
    if (!this.hits.has(client) && this.hits.size >= this.cap) {
      // Full: clients whose hits have all aged out are forgotten; one whose hits still count never is.
      let soonest: number = Infinity;
      for (const [one, times] of this.hits) {
        const newest: number = times[times.length - 1] ?? -Infinity;
        if (at - newest >= this.spanMs) this.hits.delete(one);
        else soonest = Math.min(soonest, newest + this.spanMs);
      }
      // Still full of clients that count: this one is turned away until the first of them ages out.
      if (this.hits.size >= this.cap) return Math.max(1, Math.ceil((soonest - at) / 1000));
    }
    recent.push(at);
    this.hits.set(client, recent);
    return 0;
  }
}

/** One try, held from the moment it begins: the handle its outcome is told by. */
export interface Attempt {
  /** Whose try it is. */
  readonly key: string;
  /** When it began, in ms. */
  readonly at: number;
  /** True until its outcome is told. */
  pending: boolean;
}

/**
 * A count of tries that failed, per key, in a sliding span.
 *
 * A try is taken up when it begins and is counted from then, so tries made
 * all at once cannot all get through on a count that has not caught up
 * with them; a count that is full of keys that still count takes no new
 * key until one has aged out, and lets none of them go. Its outcome is told on the try itself: failed, and it stays
 * counted for the span from when it began; forgiven (the password was
 * right, or no verdict on it was ever given), and that very try is taken
 * out, whichever others began or ended meanwhile. A try whose outcome is
 * not yet known is counted however long it has been in the air.
 */
export class AttemptLimit {
  private readonly tries: Map<string, Attempt[]> = new Map();
  private readonly allowed: number;
  private readonly spanMs: number;
  private readonly now: () => number;
  private readonly cap: number;

  /**
   * @param allowed - The failed tries one key may hold in the span.
   * @param spanMs - The span, in ms.
   * @param now - The clock, in ms; the system's by default.
   * @param cap - The most keys held at once.
   */
  constructor(allowed: number, spanMs: number, now: () => number = Date.now, cap: number = COUNT_CAP) {
    this.allowed = allowed;
    this.spanMs = spanMs;
    this.now = now;
    this.cap = cap;
  }

  /** The tries of a key that still count: in the air, or failed inside the span. Forgets the rest. */
  private counted_read(key: string): Attempt[] {
    const at: number = this.now();
    const counted: Attempt[] = (this.tries.get(key) ?? []).filter((one: Attempt): boolean => one.pending || at - one.at < this.spanMs);
    if (counted.length === 0) this.tries.delete(key);
    else this.tries.set(key, counted);
    return counted;
  }

  /**
   * How long a key must wait before it may try again.
   *
   * @param key - Who is trying (an address, a name).
   * @returns Zero when it may try now; otherwise the whole seconds to wait.
   */
  public wait_read(key: string): number {
    const counted: Attempt[] = this.counted_read(key);
    if (counted.length < this.allowed) return 0;
    // Room is made when enough of the failed ones have aged out; the ones in the air may yet be forgiven,
    // and until they are the wait is at least a second.
    const failed: number[] = counted.filter((one: Attempt): boolean => !one.pending).map((one: Attempt): number => one.at).sort((a: number, b: number): number => a - b);
    const toFree: number = counted.length - this.allowed;
    const frees: number | undefined = failed[toFree];
    return frees === undefined ? 1 : Math.max(1, Math.ceil((frees + this.spanMs - this.now()) / 1000));
  }

  /**
   * How long until there is room for a key the count does not hold.
   *
   * @param key - Who would try.
   * @returns Zero when the key is held already or there is room; otherwise the whole seconds until a held key ages out.
   */
  public room_wait(key: string): number {
    if (this.tries.has(key) || this.tries.size < this.cap) return 0;
    // Full: keys with nothing left that counts are forgotten. A failure inside its span and a try in the
    // air are never let go to make room.
    const at: number = this.now();
    let soonest: number = Infinity;
    for (const one of [...this.tries.keys()]) {
      const counted: Attempt[] = this.counted_read(one);
      for (const held of counted) if (!held.pending) soonest = Math.min(soonest, held.at + this.spanMs);
    }
    if (this.tries.size < this.cap) return 0;
    return soonest === Infinity ? 1 : Math.max(1, Math.ceil((soonest - at) / 1000));
  }

  /**
   * Takes up a try for a key, before its outcome is known.
   *
   * @param key - Who is trying.
   * @returns The try, to tell its outcome by; or null when the count is full of keys that still count and has no room for a new one.
   */
  public try_begin(key: string): Attempt | null {
    if (this.room_wait(key) > 0) return null;
    const attempt: Attempt = { key, at: this.now(), pending: true };
    const counted: Attempt[] = this.counted_read(key);
    counted.push(attempt);
    this.tries.set(key, counted);
    return attempt;
  }

  /**
   * Tells a try's outcome: it failed, and stays counted for the span.
   *
   * @param attempt - The try.
   */
  public try_fail(attempt: Attempt): void {
    attempt.pending = false;
    this.counted_read(attempt.key);
  }

  /**
   * Tells a try's outcome: it is not a failure, and is taken out. Only that try.
   *
   * @param attempt - The try.
   */
  public try_forgive(attempt: Attempt): void {
    attempt.pending = false;
    const kept: Attempt[] = (this.tries.get(attempt.key) ?? []).filter((one: Attempt): boolean => one !== attempt);
    if (kept.length === 0) this.tries.delete(attempt.key);
    else this.tries.set(attempt.key, kept);
  }
}

/**
 * A short memory of a verdict, keyed by the hash of what was presented, so
 * the credentials themselves are never held.
 */
export class VerdictCache<V> {
  private readonly kept: Map<string, { verdict: V; until: number }> = new Map();
  private readonly lifeMs: number;
  private readonly now: () => number;

  /**
   * @param lifeMs - How long a verdict is kept, in ms.
   * @param now - The clock, in ms; the system's by default.
   */
  constructor(lifeMs: number, now: () => number = Date.now) {
    this.lifeMs = lifeMs;
    this.now = now;
  }

  /**
   * The key a presented secret is kept under.
   *
   * @param secret - What the caller presented.
   * @returns Its sha256, in hex.
   */
  public static key_derive(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  /**
   * The verdict kept for a secret, while it is fresh.
   *
   * @param secret - What the caller presented.
   * @returns The verdict, or null when none is kept.
   */
  public verdict_get(secret: string): V | null {
    const key: string = VerdictCache.key_derive(secret);
    const found = this.kept.get(key);
    if (found === undefined) return null;
    if (found.until <= this.now()) {
      this.kept.delete(key);
      return null;
    }
    return found.verdict;
  }

  /**
   * Keeps a verdict for a secret.
   *
   * @param secret - What the caller presented.
   * @param verdict - What was said of it.
   */
  public verdict_keep(secret: string, verdict: V): void {
    const at: number = this.now();
    for (const [key, one] of this.kept) {
      if (one.until <= at) this.kept.delete(key);
    }
    while (this.kept.size >= MEMORY_CAP) this.kept.delete(this.kept.keys().next().value as string);
    this.kept.set(VerdictCache.key_derive(secret), { verdict, until: at + this.lifeMs });
  }
}
