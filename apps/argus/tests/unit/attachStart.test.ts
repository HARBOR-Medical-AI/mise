/**
 * @jest-environment jsdom
 */
/**
 * @file The page's start: one attach at a time, a second attempt after a
 * failure from a clean page, and an attach that settles when its socket
 * closes before it is answered.
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import { addressManual_derive, addressSame_check, AttachWiredError, attachStart_make, attachSubmit_allowed, failReason_keep, failReason_take, surfaceStart_run, bootChoice_derive, retryPlace_name, retryToken_keep, retryToken_take, type AttachStartPorts } from '../../src/app/attachStart.js';
import { ArgusClient, type AttachedSession } from '../../src/calypso/client.js';
import type { SurfaceWired } from '../../src/app/attachStart.js';

/** A surface whose attach the test settles, and which counts how often it was wired. */
function bench_make(): { start: (token: string) => void; wired: string[]; shown: string[]; hidden: number[]; cleaned: string[]; settle: (ok: boolean, why?: string, wired?: boolean) => Promise<void> } {
  const wired: string[] = [];
  const shown: string[] = [];
  const hidden: number[] = [];
  const cleaned: string[] = [];
  let resolve: () => void = (): void => undefined;
  let reject: (error: Error) => void = (): void => undefined;
  // How the next failure fails: refused before anything was wired, or after the wiring had begun.
  const ports: AttachStartPorts = {
    surface_start: (token: string): Promise<void> => {
      // What the surface does before it attaches: every listener and timer of the page.
      wired.push(token);
      return new Promise<void>((yes: () => void, no: (error: Error) => void): void => { resolve = yes; reject = no; });
    },
    form_hide: (): void => { hidden.push(1); },
    form_show: (reason: string): void => { shown.push(reason); },
    page_clean: (reason: string): void => { cleaned.push(reason); },
  };
  const settle = async (ok: boolean, why: string = 'the token was refused', wired: boolean = false): Promise<void> => {
    if (ok) resolve(); else reject(wired ? new AttachWiredError(new Error(why)) : new Error(why));
    await Promise.resolve();
    await Promise.resolve();
  };
  return { start: attachStart_make(ports), wired, shown, hidden, cleaned, settle };
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

  it('after an attach that was refused, the next attempt is made in place: nothing was wired, and no page is restarted', async () => {
    const bench = bench_make();
    bench.start('wrong');
    await bench.settle(false);
    expect(bench.shown).toEqual(['the token was refused']);
    expect(bench.hidden).toEqual([]);
    // The second attempt, with a good token: started here, on this page.
    bench.start('good');
    expect(bench.wired).toEqual(['wrong', 'good']);
    expect(bench.cleaned).toEqual([]);
    await bench.settle(true);
    expect(bench.hidden).toHaveLength(1);
    // And while it is in flight, a second press begins nothing.
  });

  it('after a start that failed once wiring had begun, the page is left at once for a clean one with the reason: the form is not shown here', async () => {
    const bench = bench_make();
    bench.start('good');
    await bench.settle(false, 'the daemon closed the connection before the surface was ready', true);
    expect(bench.cleaned).toEqual(['the daemon closed the connection before the surface was ready']);
    expect(bench.shown).toEqual([]);
    // Nothing starts on the page that is being left: presses before it goes are nothing.
    bench.start('good');
    bench.start('other');
    expect(bench.wired).toEqual(['good']);
    expect(bench.cleaned).toHaveLength(1);
  });

  it('the reason goes with the move, for that one load and that page only', () => {
    const tab = (): Storage => window.sessionStorage;
    window.sessionStorage.clear();
    expect(failReason_keep(tab, 'wiring threw', '/s/abc/')).toBe(true);
    expect(failReason_take(tab, '/s/other/')).toBeNull();
    expect(failReason_keep(tab, 'wiring threw', '/s/abc/')).toBe(true);
    expect(failReason_take(tab, '/s/abc/')).toBe('wiring threw');
    expect(failReason_take(tab, '/s/abc/')).toBeNull();
    const refused = (): Storage => { throw new Error('The operation is insecure.'); };
    expect(failReason_keep(refused, 'x', '/s/abc/')).toBe(false);
    expect(failReason_take(refused, '/s/abc/')).toBeNull();
  });

  it('of two attempts made together after a refusal, the first is the one: one attach in flight', async () => {
    const bench = bench_make();
    bench.start('wrong');
    await bench.settle(false);
    bench.start('good');
    bench.start('other');
    expect(bench.wired).toEqual(['wrong', 'good']);
    expect(bench.cleaned).toEqual([]);
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
    expect(second.cleaned).toEqual([]);
  });

  it('a second refusal on the form\'s own page reloads it: going to the address it is already at would load nothing new', async () => {
    // The page is already the fallback's: behind a door, marked for its form, with a link's fragment.
    const path: string = '/s/abc/';
    const search: string = '?door=1&attach=manual';
    const hash: string = '#view=dag';
    const unreachable = (): Storage => { throw new Error('The operation is insecure.'); };
    const bench = bench_make();
    expect(bootChoice_derive(null, search, true)).toEqual({ kind: 'form' });
    // A token typed by hand is refused.
    bench.start('wrong');
    await bench.settle(false);
    // Another is typed. It cannot be kept, and the address the fallback would go to is the page's own.
    expect(retryToken_keep(unreachable, 'good', retryPlace_name(path, 'ws://127.0.0.1:9000'))).toBe(false);
    const address: string = addressManual_derive(path, search, hash);
    expect(address).toBe('/s/abc/?door=1&attach=manual#view=dag');
    expect(addressSame_check(address, path, search)).toBe(true);
    // So the page is reloaded, and the document that follows is a new one: it shows its form and takes input.
    const next = bench_make();
    expect(bootChoice_derive(retryToken_take(unreachable, retryPlace_name(path, 'ws://127.0.0.1:9000')), search, true)).toEqual({ kind: 'form' });
    next.start('good');
    await next.settle(true);
    expect(next.wired).toEqual(['good']);
    // An address that differs in its query is another document, and is gone to.
    expect(addressSame_check('/s/abc/?door=1&attach=manual#x', path, '?door=1')).toBe(false);
    expect(addressSame_check('/s/other/?door=1&attach=manual', path, search)).toBe(false);
    expect(addressSame_check('/s/abc/', path, '')).toBe(true);
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

describe('a held attach', () => {
  const RealSocket = globalThis.WebSocket;
  afterEach((): void => { globalThis.WebSocket = RealSocket; FakeSocket.made.length = 0; });

  /** Attaches held over a fake socket; gives back the client and the socket. */
  async function held_make(): Promise<{ client: ArgusClient; socket: FakeSocket }> {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    const attaching = ArgusClient.session_attachHeld('ws://127.0.0.1:9000', 'T');
    const socket: FakeSocket = FakeSocket.made[0] as FakeSocket;
    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({ type: 'attached', session: 's', protocolVersion: 1 }) });
    const { client } = await attaching;
    return { client, socket };
  }
  const output = (chunk: string): { data: string } => ({ data: JSON.stringify({ type: 'output', id: 'x', channel: 'data', chunk }) });

  it('holds what the session says until the handlers are installed, and then hands it over, in order, once', async () => {
    const { client, socket } = await held_make();
    socket.onmessage?.(output('one'));
    socket.onmessage?.(output('two'));
    const got: string[] = [];
    client.handlers_install({ output_receive: (_channel: string, chunk: string): void => { got.push(chunk); } } as never);
    // Installed, still held: the page finishes setting up before anything reaches a handler.
    expect(got).toEqual([]);
    socket.onmessage?.(output('three'));
    expect(got).toEqual([]);
    client.held_release();
    expect(got).toEqual(['one', 'two', 'three']);
    socket.onmessage?.(output('four'));
    expect(got).toEqual(['one', 'two', 'three', 'four']);
    // Released again: nothing is handed over twice.
    client.held_release();
    expect(got).toEqual(['one', 'two', 'three', 'four']);
  });

  it('a close while held is the attach gone: installing throws, nothing it held is delivered, and the close is no handler\'s', async () => {
    const { client, socket } = await held_make();
    socket.onmessage?.(output('stale'));
    socket.onclose?.({ reason: '', code: 1006 });
    const got: string[] = [];
    let closed: number = 0;
    expect(() => { client.handlers_install({ output_receive: (_c: string, chunk: string): void => { got.push(chunk); }, close_handle: (): void => { closed += 1; } } as never); }).toThrow('the daemon closed the connection before the surface was ready');
    expect(() => { client.held_release(); }).toThrow('the daemon closed the connection before the surface was ready');
    await expect(client.held_closed()).rejects.toThrow('before the surface was ready');
    expect(got).toEqual([]);
    expect(closed).toBe(0);
  });

  it('abandoned, its socket is closed and nothing it held or receives after reaches anyone', async () => {
    const { client, socket } = await held_make();
    let closedSockets: number = 0;
    const close = socket.close.bind(socket);
    socket.close = (): void => { closedSockets += 1; close(); };
    socket.onmessage?.(output('held'));
    client.held_abandon();
    expect(closedSockets).toBe(1);
    socket.onmessage?.(output('late'));
    const got: string[] = [];
    expect(() => { client.handlers_install({ output_receive: (_c: string, chunk: string): void => { got.push(chunk); } } as never); }).toThrow();
    expect(got).toEqual([]);
  });

  it('abandoned after its handlers were installed and released, its handlers are taken away and its socket closed', async () => {
    const { client, socket } = await held_make();
    const got: string[] = [];
    let closed: number = 0;
    client.handlers_install({ output_receive: (_c: string, chunk: string): void => { got.push(chunk); }, close_handle: (): void => { closed += 1; } } as never);
    client.held_release();
    socket.onmessage?.(output('live'));
    expect(got).toEqual(['live']);
    client.held_abandon();
    // The socket was closed, and no handler heard it, or anything after.
    expect(socket.onmessage).toBeNull();
    expect(closed).toBe(0);
    expect(got).toEqual(['live']);
  });

  it('a held attach that is refused, or never answered, rejects as an attach does: nothing to install', async () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    const refused = ArgusClient.session_attachHeld('ws://127.0.0.1:9000', 'WRONG');
    const socket: FakeSocket = FakeSocket.made[0] as FakeSocket;
    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({ type: 'error', reason: 'the token was refused' }) });
    await expect(refused).rejects.toThrow('the token was refused');
  });
});

describe('the start, in order', () => {
  const RealSocket = globalThis.WebSocket;
  afterEach((): void => { globalThis.WebSocket = RealSocket; FakeSocket.made.length = 0; });

  /** Attaches held over a fake socket the test drives: the ack is given when `ack` is called. */
  function attach_controlled(stale: boolean): { attach_held: (token: string) => Promise<AttachedSession>; socket: () => FakeSocket; ack: () => void } {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    return {
      attach_held: (token: string): Promise<AttachedSession> => ArgusClient.session_attachHeld('ws://127.0.0.1:9000', token),
      socket: (): FakeSocket => FakeSocket.made[FakeSocket.made.length - 1] as FakeSocket,
      ack: (): void => {
        const socket = FakeSocket.made[FakeSocket.made.length - 1] as FakeSocket;
        socket.onopen?.();
        socket.onmessage?.({ data: JSON.stringify({ type: 'attached', session: 's', protocolVersion: 1, stale }) });
      },
    };
  }

  it('a word of the session held behind its attach wins over the attach\'s own: the facts are applied first, the held word after, then READY', async () => {
    const control = attach_controlled(true);
    const said: string[] = [];
    let stale: boolean | null = null;
    const running = surfaceStart_run('T', {
      attach_held: control.attach_held,
      backend_ask: async (): Promise<string> => {
        // The session spoke after its ack, while the page was still learning its backend.
        control.socket().onmessage?.({ data: JSON.stringify({ type: 'stale', stale: false }) });
        await Promise.resolve();
        return 'chris';
      },
      surface_wire: (_token: string, held: AttachedSession): SurfaceWired => {
        held.client.handlers_install({ stale_receive: (now: boolean): void => { stale = now; said.push(`stale ${String(now)}`); } } as never);
        // The attach's facts, applied by the wiring.
        stale = held.attach.stale === true;
        said.push(`attach says stale ${String(stale)}`);
        return { ready_show: (): void => { said.push('READY'); } };
      },
    });
    control.ack();
    await running;
    expect(said).toEqual(['attach says stale true', 'stale false', 'READY']);
    expect(stale).toBe(false);
  });

  it('a close while the backend is being asked settles the start at once; the answer that comes after wires nothing and says no READY', async () => {
    const control = attach_controlled(false);
    const said: string[] = [];
    let answer: (backend: string) => void = (): void => undefined;
    const running = surfaceStart_run('T', {
      attach_held: control.attach_held,
      backend_ask: (): Promise<string> => new Promise<string>((resolve: (backend: string) => void): void => { answer = resolve; }),
      surface_wire: (_token: string, held: AttachedSession): SurfaceWired => {
        // The first of the wiring's effects: none may happen after the close.
        said.push('wired');
        held.client.handlers_install({ output_receive: (_c: string, chunk: string): void => { said.push(chunk); } } as never);
        return { ready_show: (): void => { said.push('READY'); } };
      },
    });
    control.ack();
    await Promise.resolve();
    control.socket().onmessage?.({ data: JSON.stringify({ type: 'output', id: 'x', channel: 'data', chunk: 'from the first socket' }) });
    control.socket().onclose?.({ reason: '', code: 1006 });
    await expect(running).rejects.toBeInstanceOf(AttachWiredError);
    // The backend answers late.
    answer('chris');
    await Promise.resolve();
    await Promise.resolve();
    expect(said).toEqual([]);
    expect(control.socket().onmessage).toBeNull();
  });

  it('a handler that throws during the hand-over, after the handlers were installed: no READY, the client is let go, and the start fails as wired', async () => {
    const control = attach_controlled(false);
    const said: string[] = [];
    let closed: number = 0;
    const running = surfaceStart_run('T', {
      attach_held: control.attach_held,
      backend_ask: async (): Promise<string> => 'chris',
      surface_wire: (_token: string, held: AttachedSession): SurfaceWired => {
        held.client.handlers_install({ output_receive: (): void => { throw new Error('a handler broke'); }, close_handle: (): void => { closed += 1; } } as never);
        control.socket().onmessage?.({ data: JSON.stringify({ type: 'output', id: 'x', channel: 'data', chunk: 'boom' }) });
        return { ready_show: (): void => { said.push('READY'); } };
      },
    });
    control.ack();
    await expect(running).rejects.toThrow('a handler broke');
    expect(said).toEqual([]);
    expect(control.socket().onmessage).toBeNull();
    expect(closed).toBe(0);
  });

  it('a refused attach wires nothing; the good attempt that follows says READY once, and its handlers hear each frame once', async () => {
    const control = attach_controlled(false);
    let wired: number = 0;
    const said: string[] = [];
    const ports = {
      attach_held: control.attach_held,
      backend_ask: async (): Promise<string> => 'chris',
      surface_wire: (_token: string, held: AttachedSession): SurfaceWired => {
        wired += 1;
        held.client.handlers_install({ output_receive: (_c: string, chunk: string): void => { said.push(chunk); } } as never);
        return { ready_show: (): void => { said.push('READY'); } };
      },
    };
    const refused = surfaceStart_run('WRONG', ports);
    control.socket().onopen?.();
    control.socket().onmessage?.({ data: JSON.stringify({ type: 'error', reason: 'the token was refused' }) });
    await expect(refused).rejects.toThrow('the token was refused');
    await expect(refused).rejects.not.toBeInstanceOf(AttachWiredError);
    expect(wired).toBe(0);
    const good = surfaceStart_run('GOOD', ports);
    control.ack();
    await good;
    control.socket().onmessage?.({ data: JSON.stringify({ type: 'output', id: 'x', channel: 'data', chunk: 'press' }) });
    expect(wired).toBe(1);
    expect(said).toEqual(['READY', 'press']);
  });
});

describe('behind a door', () => {
  const RealSocket = globalThis.WebSocket;
  afterEach((): void => { globalThis.WebSocket = RealSocket; FakeSocket.made.length = 0; });

  it('an empty form may be submitted (the door holds the token); elsewhere a token must be given', () => {
    expect(attachSubmit_allowed('', true)).toBe(true);
    expect(attachSubmit_allowed('', false)).toBe(false);
    expect(attachSubmit_allowed('T', false)).toBe(true);
  });

  it('a door attach that fails after its ack goes to a clean form; a deliberate empty retry there attaches through the door and says READY once', async () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    const said: string[] = [];
    const cleaned: string[] = [];
    const tokens: string[] = [];
    const surface_start = (token: string): Promise<void> => surfaceStart_run(token, {
      attach_held: (asked: string): Promise<AttachedSession> => { tokens.push(asked); return ArgusClient.session_attachHeld('ws://127.0.0.1:9000', asked); },
      backend_ask: async (): Promise<string> => 'chris',
      surface_wire: (_token: string, held: AttachedSession): SurfaceWired => {
        held.client.handlers_install({} as never);
        return { ready_show: (): void => { said.push('READY'); } };
      },
    });
    const socket = (): FakeSocket => FakeSocket.made[FakeSocket.made.length - 1] as FakeSocket;
    const ack = (): void => { socket().onopen?.(); socket().onmessage?.({ data: JSON.stringify({ type: 'attached', session: 's', protocolVersion: 1 }) }); };
    // The first page: through the door, with no token of its own. Its socket closes after the ack, before the
    // page is ready (the backend not yet known).
    const first = attachStart_make({ surface_start, form_hide: (): void => undefined, form_show: (): void => undefined, page_clean: (reason: string): void => { cleaned.push(reason); } });
    first('');
    await Promise.resolve();
    socket().onopen?.();
    socket().onmessage?.({ data: JSON.stringify({ type: 'attached', session: 's', protocolVersion: 1 }) });
    socket().onclose?.({ reason: '', code: 1006 });
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(cleaned).toEqual(['the daemon closed the connection before the surface was ready']);
    expect(said).toEqual([]);
    // The clean page, behind the same door: its form, and the operator presses it with nothing typed.
    expect(attachSubmit_allowed('', true)).toBe(true);
    let hidden: number = 0;
    const second = attachStart_make({ surface_start, form_hide: (): void => { hidden += 1; }, form_show: (): void => undefined, page_clean: (reason: string): void => { cleaned.push(reason); } });
    second('');
    await Promise.resolve();
    ack();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(tokens).toEqual(['', '']);
    expect(said).toEqual(['READY']);
    expect(hidden).toBe(1);
  });
});
