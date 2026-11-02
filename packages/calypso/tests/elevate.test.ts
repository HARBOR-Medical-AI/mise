/**
 * @file Raising a session to MANAGE with the person's password (D14): the
 * daemon checks it at the door it was given and grants the `tasks` tier to
 * that surface alone; a wrong password is refused by name; a daemon with no
 * door says so; the grant reaches a terminal's lines through its owner.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { WebSocket } from 'ws';
import { CalypsoDaemon } from '../src/daemon/server';
import type { HostedEngine } from '../src/daemon/engine';
import { CONTRACT_VERSION } from '@fnndsc/menu';
import type { CommandEnvelope } from '@fnndsc/cumin';
import { cubePassword_check, elevation_read } from '../src/daemon/elevation';

const TOKEN = 'test-attach-token';

interface Client {
  ws: WebSocket;
  next: (test: (m: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>;
}

async function client_attach(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const got: Record<string, unknown>[] = [];
  const waits: Array<{ test: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }> = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as Record<string, unknown>;
    got.push(m);
    for (const w of [...waits]) if (w.test(m)) { waits.splice(waits.indexOf(w), 1); w.resolve(m); }
  });
  const next = (test: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
    const seen = got.find(test);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve) => waits.push({ test, resolve }));
  };
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN, capabilities: { shellCommands: false, hiddenInput: true } }));
  await next((m) => m.type === 'attached');
  return { ws, next };
}

describe('raising a session with the person\'s password', () => {
  let daemon: CalypsoDaemon;
  let seenTasks: boolean[];
  const sockets: WebSocket[] = [];
  const port = (): number => (daemon as unknown as { httpServer: { address: () => { port: number } } }).httpServer.address().port;

  const daemon_make = async (door: boolean): Promise<void> => {
    seenTasks = [];
    const engine: HostedEngine = {
      // Each line records whether the acting surface holds the tasks tier now.
      line_execute: async (): Promise<CommandEnvelope[]> => { seenTasks.push(daemon.capabilities_current()?.tasks ?? false); return [{ status: 'ok', rendered: 'ran' }]; },
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    daemon = new CalypsoDaemon({ engine, token: TOKEN, ...(door ? { elevation: { user: 'rudolph', verify: async (password: string): Promise<boolean> => password === 'right' } } : {}) });
    await daemon.start();
  };

  beforeEach(() => undefined);
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await daemon.stop().catch((): void => undefined);
  });

  it('says it offers a door on attach, refuses a wrong password by name, grants the right one to that surface alone', async () => {
    await daemon_make(true);
    const a = await client_attach(port()); sockets.push(a.ws);
    const b = await client_attach(port()); sockets.push(b.ws);
    const attached = await a.next((m) => m.type === 'attached');
    expect(attached.elevation).toBe(true);
    a.ws.send(JSON.stringify({ type: 'execute', id: '1', line: 'vm build x' }));
    await a.next((m) => m.type === 'result' && m.id === '1');
    expect(seenTasks).toEqual([false]);
    a.ws.send(JSON.stringify({ type: 'elevate', password: 'wrong' }));
    const refused = await a.next((m) => m.type === 'elevated');
    expect(refused).toMatchObject({ granted: false, reason: "not rudolph's password; nothing changed" });
    a.ws.send(JSON.stringify({ type: 'elevate', password: 'right' }));
    const granted = await a.next((m) => m.type === 'elevated' && m.granted === true);
    expect(granted).toEqual({ type: 'elevated', granted: true });
    a.ws.send(JSON.stringify({ type: 'execute', id: '2', line: 'vm build x' }));
    await a.next((m) => m.type === 'result' && m.id === '2');
    // The other surface is still READ.
    b.ws.send(JSON.stringify({ type: 'execute', id: '3', line: 'vm build x' }));
    await b.next((m) => m.type === 'result' && m.id === '3');
    expect(seenTasks).toEqual([false, true, false]);
  }, 10000);

  it('a daemon started without a door cannot be raised, and says so', async () => {
    await daemon_make(false);
    const a = await client_attach(port()); sockets.push(a.ws);
    expect((await a.next((m) => m.type === 'attached')).elevation).toBe(false);
    a.ws.send(JSON.stringify({ type: 'elevate', password: 'right' }));
    const refused = await a.next((m) => m.type === 'elevated');
    expect(refused).toMatchObject({ granted: false });
    expect(String(refused.reason)).toContain('started without a door to ask');
  }, 10000);

  it('reads the door from the environment and checks a password at the CUBE', async () => {
    expect(elevation_read({})).toBeNull();
    const calls: Array<{ url: string; body: string }> = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response(JSON.stringify({ token: 'x' }), { status: String(init?.body).includes('"right"') ? 200 : 400 });
    }) as typeof fetch;
    const door = elevation_read({ CALYPSO_ELEVATION_URL: 'https://cube.example.org/api/v1/', CALYPSO_ELEVATION_USER: 'rudolph' }, fetcher);
    expect(door?.user).toBe('rudolph');
    expect(await door?.verify('right')).toBe(true);
    expect(await door?.verify('wrong')).toBe(false);
    expect(calls[0]).toEqual({ url: 'https://cube.example.org/api/v1/auth-token/', body: JSON.stringify({ username: 'rudolph', password: 'right' }) });
    expect(await cubePassword_check('https://cube.example.org/api/v1', 'rudolph', 'right', fetcher)).toBe(true);
    expect(calls[2]?.url).toBe('https://cube.example.org/api/v1/auth-token/');
    // A door that cannot be reached refuses rather than throws.
    expect(await cubePassword_check('https://cube.example.org/api/v1/', 'rudolph', 'right', (async (): Promise<Response> => { throw new Error('down'); }) as typeof fetch)).toBe(false);
  });
});
