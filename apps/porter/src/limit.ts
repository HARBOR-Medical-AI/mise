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

/**
 * A count of tries that failed, per key, in a sliding span.
 *
 * A try is taken up when it begins and given back when it turns out well,
 * so only failures stay counted; and because it is taken up before its
 * outcome is known, tries made all at once are counted while they are
 * still in the air, and cannot all get through on a count that has not
 * caught up with them.
 */
export class AttemptLimit {
  private readonly tries: Map<string, number[]> = new Map();
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

  /** The tries of a key still inside the span. */
  private recent_read(key: string): number[] {
    const at: number = this.now();
    return (this.tries.get(key) ?? []).filter((one: number): boolean => at - one < this.spanMs);
  }

  /**
   * How long a key must wait before it may try again.
   *
   * @param key - Who is trying (an address, a name).
   * @returns Zero when it may try now; otherwise the whole seconds to wait.
   */
  public wait_read(key: string): number {
    const recent: number[] = this.recent_read(key);
    if (recent.length < this.allowed) return 0;
    return Math.max(1, Math.ceil(((recent[0] as number) + this.spanMs - this.now()) / 1000));
  }

  /**
   * Takes up a try for a key, before its outcome is known.
   *
   * @param key - Who is trying.
   */
  public try_begin(key: string): void {
    const recent: number[] = this.recent_read(key);
    recent.push(this.now());
    this.tries.delete(key);
    this.tries.set(key, recent);
    while (this.tries.size > MEMORY_CAP) this.tries.delete(this.tries.keys().next().value as string);
  }

  /**
   * Gives a try back: it did not fail.
   *
   * @param key - Who tried.
   */
  public try_forgive(key: string): void {
    const recent: number[] = this.recent_read(key);
    recent.pop();
    if (recent.length === 0) this.tries.delete(key);
    else this.tries.set(key, recent);
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
