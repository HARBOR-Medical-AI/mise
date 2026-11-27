/**
 * @jest-environment jsdom
 */
/**
 * @file The page's start: one attach at a time, a second attempt after a
 * failure from a clean page, and an attach that settles when its socket
 * closes before it is answered.
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import { attachStart_make, retryToken_keep, retryToken_take, type AttachStartPorts } from '../../src/app/attachStart.js';
import { ArgusClient } from '../../src/calypso/client.js';

/** A surface whose attach the test settles, and which counts how often it was wired. */
function bench_make(): { start: (token: string) => void; wired: string[]; shown: string[]; hidden: number[]; restarted: string[]; settle: (ok: boolean, why?: string) => Promise<void> } {
  const wired: string[] = [];
  const shown: string[] = [];
  const hidden: number[] = [];
  const restarted: string[] = [];
  let resolve: () => void = (): void => undefined;
  let reject: (error: Error) => void = (): void => undefined;
  const ports: AttachStartPorts = {
    surface_start: (token: string): Promise<void> => {
      // What the surface does before it attaches: every listener and timer of the page.
      wired.push(token);
      return new Promise<void>((yes: () => void, no: (error: Error) => void): void => { resolve = yes; reject = no; });
    },
    form_hide: (): void => { hidden.push(1); },
    form_show: (reason: string): void => { shown.push(reason); },
    page_restart: (token: string): void => { restarted.push(token); },
  };
  const settle = async (ok: boolean, why: string = 'the token was refused'): Promise<void> => {
    if (ok) resolve(); else reject(new Error(why));
    await Promise.resolve();
    await Promise.resolve();
  };
  return { start: attachStart_make(ports), wired, shown, hidden, restarted, settle };
}

describe('the page\'s start', () => {
  it('begins one attach: Enter twice, or the button and Enter, while it is in flight wires the surface once', async () => {
    const bench = bench_make();
    bench.start('good');
    bench.start('good');
    bench.start('good');
    expect(bench.wired).toEqual(['good']);
    await bench.settle(true);
    expect(bench.hidden).toHaveLength(1);
    expect(bench.shown).toEqual([]);
  });

  it('after an attach that failed, wires nothing again: the form says why, and the next attempt restarts the page with its token', async () => {
    const bench = bench_make();
    bench.start('wrong');
    await bench.settle(false);
    expect(bench.shown).toEqual(['the token was refused']);
    expect(bench.hidden).toEqual([]);
    // The second attempt, with a good token: the page that was wired is not wired again.
    bench.start('good');
    expect(bench.wired).toEqual(['wrong']);
    expect(bench.restarted).toEqual(['good']);
  });

  it('carries the token over the reload in the tab\'s own storage, for one load only', () => {
    expect(retryToken_take(window.sessionStorage)).toBeNull();
    expect(retryToken_keep(window.sessionStorage, 'good')).toBe(true);
    expect(retryToken_take(window.sessionStorage)).toBe('good');
    expect(retryToken_take(window.sessionStorage)).toBeNull();
    // A tab whose storage cannot be used keeps nothing, and says so: the fresh page shows the form.
    const refusing = { setItem: (): void => { throw new Error('denied'); }, getItem: (): string | null => { throw new Error('denied'); }, removeItem: (): void => undefined } as unknown as Storage;
    expect(retryToken_keep(refusing, 'good')).toBe(false);
    expect(retryToken_take(refusing)).toBeNull();
  });

  it('a fresh page that was handed a token attaches once with it, as the first attempt of that page', async () => {
    // The whole of it: a failed attach, a second attempt, the reload, and the page that follows.
    const first = bench_make();
    first.start('wrong');
    await first.settle(false);
    first.restarted.length = 0;
    retryToken_keep(window.sessionStorage, 'good');
    const second = bench_make();
    const kept: string | null = retryToken_take(window.sessionStorage);
    expect(kept).toBe('good');
    second.start(kept as string);
    await second.settle(true);
    expect(second.wired).toEqual(['good']);
    expect(second.hidden).toHaveLength(1);
  });
});

/** A socket the test drives. */
class FakeSocket {
  public static made: FakeSocket[] = [];
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: string }) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onclose: (() => void) | null = null;
  public sent: string[] = [];
  constructor(public readonly url: string) { FakeSocket.made.push(this); }
  public send(text: string): void { this.sent.push(text); }
  public close(): void { this.onclose?.(); }
}

describe('an attach', () => {
  const RealSocket = globalThis.WebSocket;
  afterEach((): void => { globalThis.WebSocket = RealSocket; FakeSocket.made.length = 0; });

  it('is rejected when its socket closes before the daemon answers it, and does not wait for ever', async () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    const attaching = ArgusClient.session_attach('ws://127.0.0.1:9000', 'T', {} as never);
    const socket: FakeSocket = FakeSocket.made[0] as FakeSocket;
    socket.onopen?.();
    expect(socket.sent).toHaveLength(1);
    // The daemon goes away with the attach unanswered.
    socket.onclose?.();
    await expect(attaching).rejects.toThrow('closed the connection before it answered the attach');
  });

  it('once answered, a close is the client\'s to hear, not a rejection of the attach', async () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    let closed: number = 0;
    const attaching = ArgusClient.session_attach('ws://127.0.0.1:9000', 'T', { close_handle: (): void => { closed += 1; } } as never);
    const socket: FakeSocket = FakeSocket.made[0] as FakeSocket;
    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({ type: 'attached', session: 's', protocolVersion: 1 }) });
    const { client } = await attaching;
    expect(client).toBeDefined();
    socket.onclose?.();
    expect(closed).toBe(1);
  });
});
