/**
 * @jest-environment jsdom
 */
/**
 * @file The page's start: one attach at a time, a second attempt after a
 * failure from a clean page, and an attach that settles when its socket
 * closes before it is answered.
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import { addressManual_derive, attachStart_make, bootChoice_derive, retryPlace_name, retryToken_keep, retryToken_take, type AttachStartPorts } from '../../src/app/attachStart.js';
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

  it('of two attempts made together after a failure, the first is the one: one restart, with its token', async () => {
    const bench = bench_make();
    bench.start('wrong');
    await bench.settle(false);
    // Enter and the button, before the reload has taken the page away.
    bench.start('good');
    bench.start('other');
    bench.start('good');
    expect(bench.restarted).toEqual(['good']);
    expect(bench.wired).toEqual(['wrong']);
  });

  const tab = (): Storage => window.sessionStorage;

  it('carries the token over the reload in the tab\'s own storage, for one load only and for its own page only', () => {
    expect(retryToken_take(tab, '/s/abc/')).toBeNull();
    expect(retryToken_keep(tab, 'good', '/s/abc/')).toBe(true);
    expect(retryToken_take(tab, '/s/abc/')).toBe('good');
    expect(retryToken_take(tab, '/s/abc/')).toBeNull();
    // Another mount on the same origin in this tab does not take it, and it does not wait for a later load.
    expect(retryToken_keep(tab, 'good', '/s/abc/')).toBe(true);
    expect(retryToken_take(tab, '/s/other/')).toBeNull();
    expect(retryToken_take(tab, '/s/abc/')).toBeNull();
    // Something else under that name is not a handoff.
    window.sessionStorage.setItem('argus.attach.retry', 'not json');
    expect(retryToken_take(tab, '/s/abc/')).toBeNull();
    expect(window.sessionStorage.getItem('argus.attach.retry')).toBeNull();
  });

  it('a tab whose storage is refused keeps nothing and takes nothing, and says so: reaching it, reading it or writing it', () => {
    // Reaching the storage is itself refused (a browser set to block site data throws from the getter).
    const unreachable = (): Storage => { throw new Error('The operation is insecure.'); };
    expect(retryToken_take(unreachable, '/s/abc/')).toBeNull();
    expect(retryToken_keep(unreachable, 'good', '/s/abc/')).toBe(false);
    // It can be reached and read, and a write is refused.
    const readOnly = (): Storage => ({ setItem: (): void => { throw new Error('QuotaExceededError'); }, getItem: (): string | null => null, removeItem: (): void => undefined }) as unknown as Storage;
    expect(retryToken_take(readOnly, '/s/abc/')).toBeNull();
    expect(retryToken_keep(readOnly, 'good', '/s/abc/')).toBe(false);
  });

  it('a handoff is for one page and one daemon: the same page pointed at another socket does not take it, and it is gone', () => {
    const here: string = retryPlace_name('/s/abc/', 'ws://127.0.0.1:9000');
    const elsewhere: string = retryPlace_name('/s/abc/', 'ws://127.0.0.1:9001');
    expect(here).not.toBe(elsewhere);
    expect(retryToken_keep(tab, 'good', here)).toBe(true);
    expect(retryToken_take(tab, elsewhere)).toBeNull();
    expect(retryToken_take(tab, here)).toBeNull();
    expect(retryToken_keep(tab, 'good', here)).toBe(true);
    expect(retryToken_take(tab, here)).toBe('good');
  });

  it('where the token cannot be kept, the fresh page goes to its form: no token in the address, the rest of it and its fragment kept', () => {
    expect(addressManual_derive('/s/abc/', '?token=REFUSED', '')).toBe('/s/abc/?attach=manual');
    expect(addressManual_derive('/s/abc/', '?token=REFUSED&door=1&theme=lcars', '#view=dag&feed=7')).toBe('/s/abc/?door=1&theme=lcars&attach=manual#view=dag&feed=7');
    expect(addressManual_derive('/', '', '')).toBe('/?attach=manual');
    // Asked twice, it is marked once.
    expect(addressManual_derive('/s/abc/', '?attach=manual&door=1', '')).toBe('/s/abc/?attach=manual&door=1');
  });

  it('a page chooses once what it does on loading: the handed-over token, its form when marked for it, the address\'s token, the door, or its form', () => {
    expect(bootChoice_derive('handed', '?token=other&door=1', true)).toEqual({ kind: 'attach', token: 'handed' });
    expect(bootChoice_derive(null, '?token=T', false)).toEqual({ kind: 'attach', token: 'T' });
    expect(bootChoice_derive(null, '?door=1', true)).toEqual({ kind: 'attach', token: '' });
    expect(bootChoice_derive(null, '', false)).toEqual({ kind: 'form' });
    expect(bootChoice_derive(null, '?token=', false)).toEqual({ kind: 'form' });
    // Marked for its form: neither a token in the address nor a door is tried.
    expect(bootChoice_derive(null, '?door=1&attach=manual', true)).toEqual({ kind: 'form' });
    expect(bootChoice_derive(null, '?token=REFUSED&attach=manual', false)).toEqual({ kind: 'form' });
  });

  it('a refused door, a tab with no storage, and a token typed by hand: the door is not tried again, and the typed token attaches', async () => {
    const unreachable = (): Storage => { throw new Error('The operation is insecure.'); };
    const place: string = retryPlace_name('/s/abc/', 'ws://127.0.0.1:9000');
    // The first page: behind a door, which the daemon refuses.
    const first = bench_make();
    const firstChoice = bootChoice_derive(retryToken_take(unreachable, place), '?door=1', true);
    expect(firstChoice).toEqual({ kind: 'attach', token: '' });
    first.start('');
    await first.settle(false, 'the door\'s token was refused');
    expect(first.shown).toEqual(['the door\'s token was refused']);
    // A token is typed. It cannot be kept, so the page is sent to its form at an address that says so.
    let went: string | null = null;
    const kept: boolean = retryToken_keep(unreachable, 'typed', place);
    expect(kept).toBe(false);
    went = addressManual_derive('/s/abc/', '?door=1', '#view=dag');
    expect(went).toBe('/s/abc/?door=1&attach=manual#view=dag');
    // The fresh page: it shows its form and does not try the door again.
    const second = bench_make();
    const search: string = went.slice(went.indexOf('?'), went.indexOf('#'));
    expect(bootChoice_derive(retryToken_take(unreachable, place), search, true)).toEqual({ kind: 'form' });
    expect(second.wired).toEqual([]);
    // The token typed there is that page's first attempt, and attaches.
    second.start('typed');
    await second.settle(true);
    expect(second.wired).toEqual(['typed']);
    expect(second.hidden).toHaveLength(1);
    expect(second.restarted).toEqual([]);
  });

  it('a fresh page that was handed a token attaches once with it, as the first attempt of that page', async () => {
    // The whole of it: a failed attach, a second attempt, the reload, and the page that follows.
    const first = bench_make();
    first.start('wrong');
    await first.settle(false);
    retryToken_keep(tab, 'good', '/s/abc/');
    const second = bench_make();
    const kept: string | null = retryToken_take(tab, '/s/abc/');
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
  public onclose: ((event: { reason: string; code: number }) => void) | null = null;
  public sent: string[] = [];
  constructor(public readonly url: string) { FakeSocket.made.push(this); }
  public send(text: string): void { this.sent.push(text); }
  public close(): void { this.onclose?.({ reason: '', code: 1005 }); }
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
    // The daemon goes away with the attach unanswered, and says why.
    socket.onclose?.({ reason: 'the session is restarting', code: 1012 });
    await expect(attaching).rejects.toThrow('the daemon at ws://127.0.0.1:9000 closed the connection before it answered the attach (the session is restarting)');
  });

  it('says the close\'s code where it gave no reason, and that it gave none where it gave neither', async () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    const coded = ArgusClient.session_attach('ws://127.0.0.1:9000', 'T', {} as never);
    FakeSocket.made[0]?.onclose?.({ reason: '', code: 1006 });
    await expect(coded).rejects.toThrow('before it answered the attach (code 1006)');
    const silent = ArgusClient.session_attach('ws://127.0.0.1:9000', 'T', {} as never);
    FakeSocket.made[1]?.onclose?.({ reason: '', code: 1005 });
    await expect(silent).rejects.toThrow('before it answered the attach and gave no reason');
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
    socket.onclose?.({ reason: '', code: 1000 });
    expect(closed).toBe(1);
  });
});
