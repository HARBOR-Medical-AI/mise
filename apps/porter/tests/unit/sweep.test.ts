/**
 * @file The idle sweep and the registry's notion of idle: no wire open,
 * nothing through the door for the span.
 */
import { describe, it, expect } from '@jest/globals';
import { SessionRegistry } from '../../src/registry.js';
import { idleSweep_run } from '../../src/sweep.js';

const HOUR: number = 3_600_000;
const berth = { identity: 'chris@https://cube/api/v1/', url: 'ws://127.0.0.1:4444', token: 'T' };

function clock_make(start: number): { now: () => number; advance: (ms: number) => void } {
  let at: number = start;
  return { now: (): number => at, advance: (ms: number): void => { at += ms; } };
}

describe('idle', () => {
  it('is a day with no wire and nothing through the door', async () => {
    const clock = clock_make(1_000_000);
    const registry: SessionRegistry = new SessionRegistry(clock.now);
    const entry = registry.note(berth.identity, 'chris', berth);
    expect(registry.idle_list(24 * HOUR)).toEqual([]);
    clock.advance(25 * HOUR);
    expect(registry.idle_list(24 * HOUR).map((e) => e.key)).toEqual([entry.key]);
  });

  it('is never a session with a wire open, however quiet', () => {
    const clock = clock_make(1_000_000);
    const registry: SessionRegistry = new SessionRegistry(clock.now);
    const entry = registry.note(berth.identity, 'chris', berth);
    registry.wire_count(entry.key, 1);
    clock.advance(48 * HOUR);
    expect(registry.idle_list(24 * HOUR)).toEqual([]);
    registry.wire_count(entry.key, -1);
    expect(registry.idle_list(24 * HOUR)).toEqual([]);
    clock.advance(25 * HOUR);
    expect(registry.idle_list(24 * HOUR).length).toBe(1);
  });

  it('starts the clock again at every request through the door', () => {
    const clock = clock_make(1_000_000);
    const registry: SessionRegistry = new SessionRegistry(clock.now);
    const entry = registry.note(berth.identity, 'chris', berth);
    clock.advance(20 * HOUR);
    registry.activity_note(entry.key);
    clock.advance(20 * HOUR);
    expect(registry.idle_list(24 * HOUR)).toEqual([]);
  });

  it('keeps a session\'s wires when its berth is noted again', () => {
    const registry: SessionRegistry = new SessionRegistry();
    const entry = registry.note(berth.identity, 'chris', berth);
    registry.wire_count(entry.key, 1);
    registry.note(berth.identity, 'chris', { ...berth, token: 'T2' });
    expect(registry.get(entry.key)?.wires).toBe(1);
    expect(registry.get(entry.key)?.berth.token).toBe('T2');
  });
});

describe('idleSweep_run', () => {
  it('ends the idle sessions, forgets them, and says so', async () => {
    const clock = clock_make(1_000_000);
    const registry: SessionRegistry = new SessionRegistry(clock.now);
    const idle = registry.note(berth.identity, 'chris', berth);
    const busy = registry.note('jane@https://cube/api/v1/', 'jane', { ...berth, identity: 'jane@https://cube/api/v1/' });
    registry.wire_count(busy.key, 1);
    clock.advance(25 * HOUR);
    const evicted: string[] = [];
    const said: string[] = [];
    const ended: string[] = await idleSweep_run(registry, { evict: async (identity: string): Promise<boolean> => { evicted.push(identity); return true; } }, 24 * HOUR, (line: string): void => { said.push(line); });
    expect(ended).toEqual([idle.key]);
    expect(evicted).toEqual([berth.identity]);
    expect(registry.get(idle.key)).toBeNull();
    expect(registry.get(busy.key)).not.toBeNull();
    expect(said[0]).toContain("ended chris's session");
    expect(said[0]).toContain('the state directory stays');
  });

  /** A promise and the hand that settles it. */
  function gate_make(): { wait: Promise<void>; open: () => void; fail: (reason: Error) => void } {
    let open: () => void = (): void => undefined;
    let fail: (reason: Error) => void = (): void => undefined;
    const wait: Promise<void> = new Promise((resolve: () => void, reject: (reason: Error) => void): void => { open = resolve; fail = reject; });
    return { wait, open, fail };
  }
  const jane = { identity: 'jane@https://cube/api/v1/', url: 'ws://127.0.0.1:5555', token: 'J' };

  it('forgets only the session it found idle: one noted under the same key while the stop was awaited stays', async () => {
    const clock = clock_make(1_000_000);
    const registry: SessionRegistry = new SessionRegistry(clock.now);
    const idle = registry.note(berth.identity, 'chris', berth);
    clock.advance(25 * HOUR);
    const stopping = gate_make();
    const sweep: Promise<string[]> = idleSweep_run(registry, { evict: async (): Promise<boolean> => { await stopping.wait; return true; } }, 24 * HOUR);
    await Promise.resolve();
    // A new session of the same person is noted while the old one is still being stopped.
    const fresh = registry.note(berth.identity, 'chris', { ...berth, url: 'ws://127.0.0.1:6666' });
    stopping.open();
    await sweep;
    expect(registry.get(idle.key)).toBe(fresh);
    expect(registry.get(idle.key)?.berth.url).toBe('ws://127.0.0.1:6666');
  });

  it('forgets nothing that is waiting to boot under the key', async () => {
    const clock = clock_make(1_000_000);
    const registry: SessionRegistry = new SessionRegistry(clock.now);
    const idle = registry.note(berth.identity, 'chris', berth);
    clock.advance(25 * HOUR);
    const stopping = gate_make();
    const sweep: Promise<string[]> = idleSweep_run(registry, { evict: async (): Promise<boolean> => { await stopping.wait; return true; } }, 24 * HOUR);
    await Promise.resolve();
    registry.pending_note(berth.identity, 'chris');
    stopping.open();
    await sweep;
    // The boot that is on its way still settles into a session.
    expect(registry.identity_find(idle.key)).toBe(berth.identity);
    expect(await registry.settle(berth.identity, { find: async () => ({ ...berth, url: 'ws://127.0.0.1:7777' }) })).not.toBeNull();
  });

  it('claims on what is true at that moment: a session that gained a wire, or was used, since the listing is left alone', async () => {
    const clock = clock_make(1_000_000);
    const registry: SessionRegistry = new SessionRegistry(clock.now);
    const first = registry.note(berth.identity, 'chris', berth);
    const second = registry.note(jane.identity, 'jane', jane);
    clock.advance(25 * HOUR);
    const evicted: string[] = [];
    // While the first is being stopped, someone opens a wire on the second.
    await idleSweep_run(registry, { evict: async (identity: string): Promise<boolean> => { evicted.push(identity); registry.wire_count(second.key, 1); return true; } }, 24 * HOUR);
    expect(evicted).toEqual([berth.identity]);
    expect(registry.get(first.key)).toBeNull();
    expect(registry.get(second.key)).not.toBeNull();
    // And a claim is refused outright for an entry that is no longer the key's, or no longer idle.
    const stale = registry.note(berth.identity, 'chris', berth);
    registry.note(berth.identity, 'chris', berth);
    clock.advance(25 * HOUR);
    expect(registry.eviction_begin(stale, 24 * HOUR)).toBeNull();
    registry.activity_note(second.key);
    registry.wire_count(second.key, -1);
    expect(registry.eviction_begin(registry.get(second.key)!, 24 * HOUR)).toBeNull();
  });

  it('a stop that fails forgets nothing, is said, and does not keep the other idle sessions from being ended', async () => {
    const clock = clock_make(1_000_000);
    const registry: SessionRegistry = new SessionRegistry(clock.now);
    const first = registry.note(berth.identity, 'chris', berth);
    const second = registry.note(jane.identity, 'jane', jane);
    clock.advance(25 * HOUR);
    const said: string[] = [];
    const ended: string[] = await idleSweep_run(registry, {
      evict: async (identity: string): Promise<boolean> => { if (identity === berth.identity) throw new Error('the launcher answered 500'); return true; },
    }, 24 * HOUR, (line: string): void => { said.push(line); });
    expect(ended).toEqual([second.key]);
    expect(registry.get(first.key)).not.toBeNull();
    expect(registry.get(second.key)).toBeNull();
    expect(said.join('\n')).toContain("could not end chris's idle session: the launcher answered 500; it is still remembered");
    // The next sweep tries it again.
    const again: string[] = await idleSweep_run(registry, { evict: async (): Promise<boolean> => true }, 24 * HOUR);
    expect(again).toEqual([first.key]);
  });

  it('runs one at a time: a tick that comes while a sweep is waiting on a stop ends nothing a second time', async () => {
    const clock = clock_make(1_000_000);
    const registry: SessionRegistry = new SessionRegistry(clock.now);
    registry.note(berth.identity, 'chris', berth);
    clock.advance(25 * HOUR);
    const stopping = gate_make();
    let evictions: number = 0;
    const host = { evict: async (): Promise<boolean> => { evictions += 1; await stopping.wait; return true; } };
    const first: Promise<string[]> = idleSweep_run(registry, host, 24 * HOUR);
    await Promise.resolve();
    expect(await idleSweep_run(registry, host, 24 * HOUR)).toEqual([]);
    stopping.open();
    expect((await first).length).toBe(1);
    expect(evictions).toBe(1);
  });

  it('raises the key\'s generation when a stop begins and leaves it raised after: a login that read it before knows', async () => {
    const clock = clock_make(1_000_000);
    const registry: SessionRegistry = new SessionRegistry(clock.now);
    const idle = registry.note(berth.identity, 'chris', berth);
    const before: number = registry.generation_get(idle.key);
    clock.advance(25 * HOUR);
    const stopping = gate_make();
    const sweep: Promise<string[]> = idleSweep_run(registry, { evict: async (): Promise<boolean> => { await stopping.wait; return true; } }, 24 * HOUR);
    await Promise.resolve();
    expect(registry.generation_get(idle.key)).toBe(before + 1);
    // A login that arrives now waits for the stop to end.
    let waited: boolean = false;
    const waiting: Promise<void> = registry.eviction_wait(idle.key).then((): void => { waited = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(waited).toBe(false);
    stopping.open();
    await sweep;
    await waiting;
    expect(waited).toBe(true);
    expect(registry.generation_get(idle.key)).toBe(before + 1);
  });
});
