/**
 * @file The two small memories a route that asks CUBE keeps: how often a
 * client has asked, and what CUBE last said of one set of credentials.
 *
 * @module
 */
import { createHash } from 'node:crypto';

/** The most clients or headers either memory holds; the oldest are let go past it. */
const MEMORY_CAP: number = 1024;

/** A per-client allowance: so many hits in a sliding span. */
export class HitLimit {
  private readonly hits: Map<string, number[]> = new Map();
  private readonly allowed: number;
  private readonly spanMs: number;
  private readonly now: () => number;

  /**
   * @param allowed - The hits one client may make in the span.
   * @param spanMs - The span, in ms.
   * @param now - The clock, in ms; the system's by default.
   */
  constructor(allowed: number, spanMs: number, now: () => number = Date.now) {
    this.allowed = allowed;
    this.spanMs = spanMs;
    this.now = now;
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
    recent.push(at);
    this.hits.delete(client);
    this.hits.set(client, recent);
    if (this.hits.size > MEMORY_CAP) {
      for (const [one, times] of this.hits) {
        if (times.every((time: number): boolean => at - time >= this.spanMs)) this.hits.delete(one);
      }
      while (this.hits.size > MEMORY_CAP) this.hits.delete(this.hits.keys().next().value as string);
    }
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
 * with them. Its outcome is told on the try itself: failed, and it stays
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

  /**
   * @param allowed - The failed tries one key may hold in the span.
   * @param spanMs - The span, in ms.
   * @param now - The clock, in ms; the system's by default.
   */
  constructor(allowed: number, spanMs: number, now: () => number = Date.now) {
    this.allowed = allowed;
    this.spanMs = spanMs;
    this.now = now;
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
   * Takes up a try for a key, before its outcome is known.
   *
   * @param key - Who is trying.
   * @returns The try, to tell its outcome by.
   */
  public try_begin(key: string): Attempt {
    const attempt: Attempt = { key, at: this.now(), pending: true };
    const counted: Attempt[] = this.counted_read(key);
    counted.push(attempt);
    this.tries.delete(key);
    this.tries.set(key, counted);
    this.room_make();
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

  /**
   * Keeps the memory inside its cap: keys with nothing left that counts go
   * first, then the keys longest untouched whose tries have all been told.
   * A key with a try in the air is never let go, since its outcome is
   * still to be told on it.
   */
  private room_make(): void {
    if (this.tries.size <= MEMORY_CAP) return;
    for (const key of [...this.tries.keys()]) this.counted_read(key);
    for (const [key, held] of this.tries) {
      if (this.tries.size <= MEMORY_CAP) return;
      if (held.every((one: Attempt): boolean => !one.pending)) this.tries.delete(key);
    }
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
