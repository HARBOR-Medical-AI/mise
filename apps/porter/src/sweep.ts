/**
 * @file The idle sweep: sessions nobody is on, ended after a day.
 *
 * A session with no wire open and nothing through the door for the idle
 * span is ended — the process, never the identity's state directory, so
 * the next login boots warm. The registry forgets it; a cookie that still
 * names it sends its browser back through the door, where the password is
 * checked again and the session started again.
 *
 * @module
 */
import type { SessionHost } from './host/sessionHost.js';
import type { EvictionClaim, SessionRegistry, SessionEntry } from './registry.js';

/**
 * Ends every idle session once.
 *
 * @param registry - Who is on what, and since when.
 * @param host - Where sessions run.
 * @param idleMs - The span after which a session with nobody on it is ended.
 * @param log - Told each session ended.
 * @returns The keys ended; none when a sweep of this registry is already running.
 */
export async function idleSweep_run(
  registry: SessionRegistry,
  host: Pick<SessionHost, 'evict'>,
  idleMs: number,
  log: (line: string) => void = (): void => undefined,
): Promise<string[]> {
  // One sweep at a time: a sweep still waiting on a slow stop is not joined by the next tick's.
  if (sweeping.has(registry)) return [];
  sweeping.add(registry);
  const ended: string[] = [];
  try {
    for (const entry of registry.idle_list(idleMs)) {
      // Claimed on what is true now: a session that gained a wire, or was noted afresh, since the listing is
      // left alone.
      const claim: EvictionClaim | null = registry.eviction_begin(entry, idleMs);
      if (claim === null) continue;
      const idleFor: number = Math.round((Date.now() - entry.activeAt) / 60_000);
      try {
        // False from the host means nothing was running: the session is ended either way.
        await host.evict(entry.identity);
        registry.eviction_end(claim, true);
        ended.push(entry.key);
        log(`ended ${entry.user}'s session after ${String(idleFor)} min idle; the state directory stays`);
      } catch (error: unknown) {
        // The stop failed: the session may still be running, so it is still remembered, and the next
        // sweep tries again. The other idle sessions are still swept.
        registry.eviction_end(claim, false);
        log(`could not end ${entry.user}'s idle session: ${error instanceof Error ? error.message : String(error)}; it is still remembered`);
      }
    }
  } finally {
    sweeping.delete(registry);
  }
  return ended;
}

/** The registries a sweep is running over now. */
const sweeping: WeakSet<SessionRegistry> = new WeakSet<SessionRegistry>();

/**
 * The idle entries, for a listing or a test, without ending anything.
 *
 * @param registry - Who is on what.
 * @param idleMs - The span.
 * @returns The entries idle longer than the span.
 */
export function idle_list(registry: SessionRegistry, idleMs: number): SessionEntry[] {
  return registry.idle_list(idleMs);
}
