/**
 * @file The porter's routes over a fake host: a session asked for, its boot
 * followed, its mount addressed. The proxy itself needs a daemon and is
 * proved live.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { AddressInfo } from 'node:net';
import { createServer, get as httpGet, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { SessionRegistry } from '../../src/registry.js';
import { porterApp_build, upstreamPath_build, mountUrl_split, berthHttp_derive, type PorterApp } from '../../src/app.js';
import type { Berth, BerthAccess, BootListener, BootReport, SessionHost } from '../../src/host/sessionHost.js';
import type { PorterConfig } from '../../src/config.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { TokenStore } from '../../src/tokens.js';
import { cubeAdmin_check, type AdminAnswer, type AdminVerdict } from '../../src/cube/auth.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config: PorterConfig = {
  cubeUrl: 'https://cube.example.org/api/v1/',
  stateDir: '/tmp/porter-test',
  host: '127.0.0.1',
  port: 0,
  chellEntry: '/opt/chell/dist/index.js',
  secret: 'a-secret-of-at-least-twenty-characters',
  secretGenerated: false,
  cookieHours: 24,
  idleHours: 24, soundsDir: null,
  tokenDays: 30,
  tokensFile: '/tmp/porter-test-tokens-unused.json',
  berths: { mode: 'local' },
};

/** The door's cookie as a browser would send it back, from a login reply. */
function cookie_of(response: { headers: Record<string, unknown> }): string {
  const header: unknown = response.headers['set-cookie'];
  const first: string = Array.isArray(header) ? String(header[0]) : String(header);
  return first.split(';')[0] ?? '';
}

/** A host that remembers what it was asked and answers from a script. */
class FakeHost implements SessionHost {
  public found: Berth | null = null;
  public sightings: Array<{ identity: string; berth: Berth; alive: boolean }> = [];
  async sessions_adopt(): Promise<Array<{ identity: string; berth: Berth; alive: boolean }>> { return this.sightings; }
  public spawned: Array<{ identity: string; user: string; token: string }> = [];
  public spawnError: string | null = null;
  public report: BootReport | null = null;
  public listener: BootListener | null = null;
  async find(): Promise<Berth | null> { return this.found; }
  async spawn(identity: string, user: string, _cubeUrl: string, token: string): Promise<Berth> {
    this.spawned.push({ identity, user, token });
    if (this.spawnError !== null) throw new Error(this.spawnError);
    return { identity, url: 'ws://127.0.0.1:4444', token: 'ATTACH' };
  }
  spawn_begin(identity: string, user: string, cubeUrl: string, token: string): void {
    void this.spawn(identity, user, cubeUrl, token).catch((): void => undefined);
  }
  boot_follow(_identity: string, listener: BootListener): { report: BootReport; release: () => void } | null {
    if (this.report === null) return null;
    this.listener = listener;
    return { report: this.report, release: (): void => { this.listener = null; } };
  }
  public evicted: string[] = [];
  async evict(identity: string): Promise<boolean> { this.evicted.push(identity); return true; }
  public restarted: Array<{ identity: string; user: string }> = [];
  restart_begin(identity: string, user: string): void { this.restarted.push({ identity, user }); }
}

/** A host that keeps tokens outside its sessions, as the berth launcher does. */
class FakeBerthHost extends FakeHost {
  public renewed: Array<{ identity: string; token: string }> = [];
  async token_renew(identity: string, _user: string, _cubeUrl: string, token: string): Promise<void> { this.renewed.push({ identity, token }); }
}

let host: FakeHost;
let built: PorterApp;
let tokensDir: string;
let said: string[];

beforeEach(async () => {
  host = new FakeHost();
  tokensDir = await mkdtemp(join(tmpdir(), 'porter-routes-tokens-'));
  said = [];
  built = await porterApp_build({
    // A fake berth names no versions; the shared door ships none to compare, so a login mounts as before.
    installed: {},
    config: { ...config, tokensFile: join(tokensDir, 'tokens.json') },
    host,
    log: (line: string): void => { said.push(line); },
    mint: async (_cube: string, username: string, password: string) =>
      password === 'right' ? { token: `TOKEN-${username}` } : { token: null, reason: 'CUBE refused the login' },
  });
});

describe('the deployment\'s own sounds', () => {
  it('answers a sound under the session from the sounds folder, and proxies what it does not have', async () => {
    const dir: string = await mkdtemp(join(tmpdir(), 'porter-sounds-'));
    await writeFile(join(dir, 'press.mp3'), Buffer.from('beep1'));
    const soundHost = new FakeHost();
    // A session already up: the login attaches to it and the key has an entry at once.
    soundHost.found = { identity: 'chris@https://cube.example.org/api/v1/', url: 'ws://127.0.0.1:4444', token: 'ATTACH' };
    const withSounds = await porterApp_build({ installed: {}, config: { ...config, soundsDir: dir }, host: soundHost, mint: async () => ({ token: 'T' }) });
    const login = await withSounds.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'x' } });
    const { key } = login.json() as { key: string };
    const sound = await withSounds.app.inject({ method: 'GET', url: `/s/${key}/sounds/press.mp3`, headers: { cookie: cookie_of(login) } });
    expect(sound.statusCode).toBe(200);
    expect(sound.headers['content-type']).toBe('audio/mpeg');
    expect(sound.body).toBe('beep1');
    await withSounds.app.close();
  });
});

describe('POST /login', () => {
  it('trades the password for a token, starts the session with it, and answers at once', async () => {
    const response = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'right' } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { key: string; mount: string; state: string };
    expect(body.state).toBe('starting');
    expect(body.mount).toBe(`/s/${body.key}/`);
    expect(body.key).toMatch(/^[0-9a-f]{16}$/);
    expect(host.spawned).toEqual([{ identity: 'chris@https://cube.example.org/api/v1/', user: 'chris', token: 'TOKEN-chris' }]);
    const cookie: string = cookie_of(response);
    expect(cookie.startsWith('porter_session=')).toBe(true);
    const raw: string = String(Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'][0] : response.headers['set-cookie']);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
    expect(raw).toContain('Max-Age=86400');
    expect(raw).not.toContain('Secure');
  });

  it('marks the cookie Secure when a front says the page came over TLS', async () => {
    const response = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json', 'x-forwarded-proto': 'https' }, payload: { username: 'chris', password: 'right' } });
    const raw: string = String(Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'][0] : response.headers['set-cookie']);
    expect(raw).toContain('Secure');
  });

  it('takes a form from the door and sends the browser to the greet while the session boots', async () => {
    const response = await built.app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' }, payload: 'username=chris&password=right' });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toMatch(/^\/greet\/[0-9a-f]{16}$/);
    expect(cookie_of(response).startsWith('porter_session=')).toBe(true);
  });

  it('sends a form straight to a session already up', async () => {
    host.found = { identity: 'chris@https://cube.example.org/api/v1/', url: 'ws://127.0.0.1:4444', token: 'ATTACH' };
    const response = await built.app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' }, payload: 'username=chris&password=right' });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toMatch(/^\/s\/[0-9a-f]{16}\/\?door$/);
  });

  it('sends a refused form back to the door with the reason', async () => {
    const response = await built.app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' }, payload: 'username=chris&password=wrong' });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/login?reason=CUBE%20refused%20the%20login');
  });

  it('attaches to a session already up, after checking the password all the same', async () => {
    host.found = { identity: 'chris@https://cube.example.org/api/v1/', url: 'ws://127.0.0.1:4444', token: 'ATTACH' };
    const ok = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'right' } });
    expect((ok.json() as { state: string }).state).toBe('attached');
    expect(host.spawned).toEqual([]);
    const refused = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'wrong' } });
    expect(refused.statusCode).toBe(401);
  });

  it('refuses a bad password with CUBE\'s word, and a bad body by name', async () => {
    const refused = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'wrong' } });
    expect(refused.statusCode).toBe(401);
    expect((refused.json() as { error: string }).error).toBe('CUBE refused the login');
    const bad = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris' } });
    expect(bad.statusCode).toBe(400);
  });

  it('surfaces a boot that failed through the boot stream, not the login', async () => {
    host.spawnError = 'the session exited during boot (code 1)';
    host.report = { lines: [], state: 'failed', reason: 'the session exited during boot (code 1)' };
    const response = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'right' } });
    expect(response.statusCode).toBe(200);
    const key: string = (response.json() as { key: string }).key;
    const boot = await built.app.inject({ method: 'GET', url: `/boot/${key}`, headers: { cookie: cookie_of(response) } });
    expect(boot.body).toContain('event: failed\ndata: {"reason":"the session exited during boot (code 1)"}');
    // No berth ever answered, so the mount still refuses.
    expect((await built.app.inject({ method: 'GET', url: `/s/${key}/`, headers: { cookie: cookie_of(response) } })).statusCode).toBe(404);
  });
});

describe('GET /boot/:key', () => {
  it('replays the boot so far, closes on a settled state, and admits the session to its mount', async () => {
    host.report = { lines: [{ channel: 'out', text: '[ OK ] Connect' }], state: 'ready' };
    const session = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'right' } });
    const key: string = (session.json() as { key: string }).key;
    // Booting: the mount refuses until the berth answers.
    expect((await built.app.inject({ method: 'GET', url: `/s/${key}/`, headers: { cookie: cookie_of(session) } })).statusCode).toBe(404);
    host.found = { identity: 'chris@https://cube.example.org/api/v1/', url: 'ws://127.0.0.1:4444', token: 'ATTACH' };
    const boot = await built.app.inject({ method: 'GET', url: `/boot/${key}`, headers: { cookie: cookie_of(session) } });
    expect(boot.statusCode).toBe(200);
    expect(boot.headers['content-type']).toBe('text/event-stream');
    expect(boot.body).toContain('event: line\ndata: {"channel":"out","text":"[ OK ] Connect"}');
    expect(boot.body).toContain('event: ready');
    expect(built.registry.get(key)?.berth.token).toBe('ATTACH');
  });

  it('follows a boot still under way: lines as they come, then the end', async () => {
    host.report = { lines: [{ channel: 'out', text: 'first' }], state: 'booting' };
    const session = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'right' } });
    const key: string = (session.json() as { key: string }).key;
    const boot: Promise<{ body: string }> = built.app.inject({ method: 'GET', url: `/boot/${key}`, headers: { cookie: cookie_of(session) } });
    await new Promise((r) => setTimeout(r, 50));
    expect(host.listener).not.toBeNull();
    host.listener?.line({ channel: 'err', text: 'second' });
    host.listener?.done('failed', 'it died');
    const body: string = (await boot).body;
    expect(body).toContain('data: {"channel":"out","text":"first"}');
    expect(body).toContain('data: {"channel":"err","text":"second"}');
    expect(body).toContain('event: failed\ndata: {"reason":"it died"}');
  });

  it('answers ready at once for a session it found rather than started', async () => {
    host.found = { identity: 'chris@https://cube.example.org/api/v1/', url: 'ws://127.0.0.1:4444', token: 'ATTACH' };
    const session = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'right' } });
    const key: string = (session.json() as { key: string }).key;
    const boot = await built.app.inject({ method: 'GET', url: `/boot/${key}`, headers: { cookie: cookie_of(session) } });
    expect(boot.body).toContain('event: ready');
  });

  it('401s a browser whose cookie names another session, or none', async () => {
    const session = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'right' } });
    const key: string = (session.json() as { key: string }).key;
    expect((await built.app.inject({ method: 'GET', url: `/boot/${key}` })).statusCode).toBe(401);
    expect((await built.app.inject({ method: 'GET', url: '/boot/0123456789abcdef', headers: { cookie: cookie_of(session) } })).statusCode).toBe(401);
    expect((await built.app.inject({ method: 'GET', url: `/boot/${key}`, headers: { cookie: 'porter_session=forged.signature' } })).statusCode).toBe(401);
  });
});

describe('the door', () => {
  it('shows the login page with the brain at rest, and the reason when there is one', async () => {
    const page = await built.app.inject({ method: 'GET', url: '/login' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('name="password"');
    expect(page.body).toContain('https://cube.example.org/api/v1/');
    expect(page.body).toContain("./greeter/brain.js");
    expect(page.body).toContain('brain_draw(0, true)');
    const refused = await built.app.inject({ method: 'GET', url: '/login?reason=CUBE%20refused%20the%20login' });
    expect(refused.body).toContain('CUBE refused the login');
  });

  it('serves the greeter\'s two modules from the wire package, and nothing else', async () => {
    const brain = await built.app.inject({ method: 'GET', url: '/greeter/brain.js' });
    expect(brain.statusCode).toBe(200);
    expect(brain.headers['content-type']).toContain('text/javascript');
    expect(brain.body).toContain('export function logo_frameRender');
    const icon = await built.app.inject({ method: 'GET', url: '/greeter/favicon.svg' });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['content-type']).toBe('image/svg+xml');
    expect(icon.body).toMatch(/^<svg /);
    const door = await built.app.inject({ method: 'GET', url: '/login' });
    expect(door.body).toContain('./greeter/favicon.svg');
    const ansi = await built.app.inject({ method: 'GET', url: '/greeter/ansi.js' });
    expect(ansi.body).toContain('export function ansi_renderHtml');
    expect((await built.app.inject({ method: 'GET', url: '/greeter/other.js' })).statusCode).toBe(404);
  });

  it('shows the greet to the browser whose cookie names the key, and the door to any other', async () => {
    const session = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'right' } });
    const key: string = (session.json() as { key: string }).key;
    const greet = await built.app.inject({ method: 'GET', url: `/greet/${key}`, headers: { cookie: cookie_of(session) } });
    expect(greet.statusCode).toBe(200);
    expect(greet.body).toContain(`new EventSource("../boot/${key}")`);
    expect(greet.body).toContain(`"../s/${key}/?door"`);
    expect(greet.body).toContain("from '../greeter/brain.js'");
    expect((await built.app.inject({ method: 'GET', url: `/greet/${key}` })).statusCode).toBe(302);
  });

  it('sends the root to the session when let in, else to the login', async () => {
    expect((await built.app.inject({ method: 'GET', url: '/' })).headers.location).toBe('/login');
    host.found = { identity: 'chris@https://cube.example.org/api/v1/', url: 'ws://127.0.0.1:4444', token: 'ATTACH' };
    const session = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'right' } });
    const key: string = (session.json() as { key: string }).key;
    expect((await built.app.inject({ method: 'GET', url: '/', headers: { cookie: cookie_of(session) } })).headers.location).toBe(`/s/${key}/?door`);
  });

  it('restarts only the cookie\'s own session, sends the browser to the greeter, and refuses one with no session', async () => {
    const refused = await built.app.inject({ method: 'POST', url: '/restart', headers: { accept: 'application/json' } });
    expect(refused.statusCode).toBe(401);
    expect(host.restarted).toEqual([]);
    host.found = { identity: 'chris@https://cube.example.org/api/v1/', url: 'ws://127.0.0.1:4444', token: 'ATTACH' };
    const session = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'right' } });
    const key: string = (session.json() as { key: string }).key;
    const restart = await built.app.inject({ method: 'POST', url: '/restart', headers: { accept: 'application/json', cookie: cookie_of(session) } });
    expect(restart.json()).toEqual({ key, greet: `/greet/${key}`, state: 'restarting' });
    expect(host.restarted).toEqual([{ identity: 'chris@https://cube.example.org/api/v1/', user: 'chris' }]);
    // Until the fresh berth answers, the mount refuses rather than proxy to a daemon on its way out.
    const mount = await built.app.inject({ method: 'GET', url: `/s/${key}/`, headers: { cookie: cookie_of(session) } });
    expect(mount.statusCode).toBe(404);
    // A second press while it boots joins that boot rather than starting another.
    const again = await built.app.inject({ method: 'POST', url: '/restart', headers: { accept: 'text/html', cookie: cookie_of(session) } });
    expect(again.statusCode).toBe(303);
    expect(again.headers.location).toBe(`/greet/${key}`);
    expect(host.restarted).toHaveLength(1);
  });

  it('on a door that starts berths, a logout stops the person\'s berth and a new login\'s token reaches the one running', async () => {
    const berths = new FakeBerthHost();
    const door: PorterApp = await porterApp_build({ installed: {}, logoutEnds: true, config: { ...config, tokensFile: join(tokensDir, 'tokens.json') }, host: berths, log: (line: string): void => { said.push(line); }, mint: async (_cube: string, username: string) => ({ token: `TOKEN-${username}` }) });
    const login = await door.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'right' } });
    expect(login.statusCode).toBe(200);
    berths.found = { identity: 'chris@https://cube.example.org/api/v1/', url: 'ws://10.213.77.2:4444', token: 'ATTACH' };
    const again = await door.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'right' } });
    expect(again.json()).toMatchObject({ state: 'attached' });
    expect(berths.renewed).toEqual([{ identity: 'chris@https://cube.example.org/api/v1/', token: 'TOKEN-chris' }]);
    const out = await door.app.inject({ method: 'POST', url: '/logout', headers: { accept: 'application/json', cookie: cookie_of(again) } });
    expect(out.json()).toEqual({ ok: true });
    expect(berths.evicted).toEqual(['chris@https://cube.example.org/api/v1/']);
    expect(said).toContain('chris logged out; their berth stopped, its volumes kept');
    await door.app.close();
  });

  it('logs a browser out by clearing its cookie, and leaves the session alone', async () => {
    const out = await built.app.inject({ method: 'POST', url: '/logout', headers: { accept: 'application/json' } });
    expect(out.json()).toEqual({ ok: true });
    expect(String(out.headers['set-cookie'])).toContain('porter_session=;');
    const form = await built.app.inject({ method: 'POST', url: '/logout', headers: { accept: 'text/html' } });
    expect(form.statusCode).toBe(303);
    expect(form.headers.location).toBe('/login');
  });
});

describe('the mount', () => {
  it('sends a browser without the right cookie to the login', async () => {
    expect((await built.app.inject({ method: 'GET', url: '/s/0123456789abcdef/' })).statusCode).toBe(302);
    expect((await built.app.inject({ method: 'GET', url: '/s/0123456789abcdef/' })).headers.location).toBe('/login');
  });

  it('404s a key the cookie names but the registry has forgotten', async () => {
    const session = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'right' } });
    const key: string = (session.json() as { key: string }).key;
    built.registry.forget(key);
    expect((await built.app.inject({ method: 'GET', url: `/s/${key}/`, headers: { cookie: cookie_of(session) } })).statusCode).toBe(404);
  });

  it('sends the mount without its slash to the directory', async () => {
    const response = await built.app.inject({ method: 'GET', url: '/s/0123456789abcdef' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/s/0123456789abcdef/');
  });
});

describe('a login never lands on a kernel older than the door\'s', () => {
  it('ends a session whose daemon runs older code and boots it afresh on the way in', async () => {
    const older: FakeHost = new FakeHost();
    older.found = { identity: 'chris@https://cube.example.org/api/v1/', url: 'ws://127.0.0.1:4444', token: 'ATTACH', versions: { brasa: '0.31.5', calypso: '0.19.2', chell: '5.10.1' } };
    const said: string[] = [];
    const door: PorterApp = await porterApp_build({ config, host: older, mint: async () => ({ token: 'x' }), installed: { brasa: '0.33.0', calypso: '0.19.5', chell: '5.10.4' }, log: (line: string): void => { said.push(line); } });
    const reply = await door.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'right' } });
    expect(reply.json()).toMatchObject({ state: 'starting' });
    expect(older.restarted).toEqual([{ identity: 'chris@https://cube.example.org/api/v1/', user: 'chris' }]);
    expect(older.spawned.length).toBe(0);
    expect(said.some((line: string): boolean => /restarting chris's session for the new release \(brasa 0.31.5 → 0.33.0/.test(line))).toBe(true);
    await door.app.close();
  });

  it('mounts a session whose daemon is current', async () => {
    const current: FakeHost = new FakeHost();
    current.found = { identity: 'chris@https://cube.example.org/api/v1/', url: 'ws://127.0.0.1:4444', token: 'ATTACH', versions: { brasa: '0.33.0', calypso: '0.19.5', chell: '5.10.4' } };
    const door: PorterApp = await porterApp_build({ config, host: current, mint: async () => ({ token: 'x' }), installed: { brasa: '0.33.0', calypso: '0.19.5', chell: '5.10.4' } });
    const reply = await door.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'right' } });
    expect(reply.json()).toMatchObject({ state: 'attached' });
    expect(current.restarted).toEqual([]);
    await door.app.close();
  });
});

describe('a porter restarted', () => {
  it('adopts the sessions its state directory holds that still answer', async () => {
    const adopting: FakeHost = new FakeHost();
    adopting.sightings = [
      { identity: 'chris@https://cube.example.org/api/v1/', berth: { identity: 'chris@https://cube.example.org/api/v1/', url: 'ws://127.0.0.1:4444', token: 'A' }, alive: true },
      { identity: 'jane@https://cube.example.org/api/v1/', berth: { identity: 'jane@https://cube.example.org/api/v1/', url: 'ws://127.0.0.1:4445', token: 'B' }, alive: false },
    ];
    const said: string[] = [];
    const restarted: PorterApp = await porterApp_build({ config, host: adopting, mint: async () => ({ token: 'x' }), log: (line: string): void => { said.push(line); } });
    // Nothing is claimed at build: the entry adopts once the door is bound.
    expect(restarted.registry.all()).toEqual([]);
    await restarted.adopt();
    expect(restarted.registry.all().map((e) => e.user)).toEqual(['chris']);
    expect(said).toEqual(["adopted chris's session at ws://127.0.0.1:4444"]);
    await restarted.app.close();
  });
});

describe('the registry', () => {
  it('lists what the door let through, and forgets on request', async () => {
    host.found = { identity: 'chris@https://cube.example.org/api/v1/', url: 'ws://127.0.0.1:4444', token: 'ATTACH' };
    await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'right' } });
    const all = built.registry.all();
    expect(all.length).toBe(1);
    expect(all[0]?.user).toBe('chris');
    built.registry.forget(all[0]?.key ?? '');
    expect(built.registry.all()).toEqual([]);
    expect((await built.app.inject({ method: 'GET', url: '/healthz' })).json()).toMatchObject({ ok: true, sessions: 0, version: expect.stringMatching(/^\d+\.\d+\.\d+/) });
  });
});

describe('address helpers', () => {
  it('splits a mount URL into key and rest', () => {
    expect(mountUrl_split('/s/0123456789abcdef/')).toEqual({ key: '0123456789abcdef', rest: '/' });
    expect(mountUrl_split('/s/0123456789abcdef/assets/x.js?v=1')).toEqual({ key: '0123456789abcdef', rest: '/assets/x.js?v=1' });
    expect(mountUrl_split('/s/short/')).toBeNull();
    expect(mountUrl_split('/elsewhere')).toBeNull();
  });

  it('puts the token on the byte route and the wire, and nowhere else', () => {
    expect(upstreamPath_build('/vfs?path=%2Fa', 'T')).toBe('/vfs?path=%2Fa&token=T');
    expect(upstreamPath_build('/backend', 'T')).toBe('/backend?token=T');
    expect(upstreamPath_build('/?door', 'T')).toBe('/?door=&token=T');
    expect(upstreamPath_build('/assets/x.js', 'T')).toBe('/assets/x.js');
    expect(upstreamPath_build('sounds/press.mp3', 'T')).toBe('/sounds/press.mp3');
  });

  it('names a berth\'s HTTP origin', () => {
    expect(berthHttp_derive({ identity: 'i', url: 'ws://127.0.0.1:4444', token: 't' })).toBe('http://127.0.0.1:4444');
  });
});

describe('the wire through the mount', () => {
  let daemon: WebSocketServer;
  let seenUrl: string | null = null;

  beforeEach(async () => {
    seenUrl = null;
    daemon = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    daemon.on('connection', (socket: WebSocket, request: { url?: string }): void => {
      seenUrl = request.url ?? null;
      socket.on('message', (data: RawData): void => { socket.send(`echo:${data.toString()}`); });
    });
    await new Promise<void>((resolve) => daemon.once('listening', () => resolve()));
  });
  afterEach(async () => {
    daemon.close();
    await built.app.close();
  });

  it('relays the upgrade to the daemon with the token on its URL, and the frames both ways', async () => {
    const port: number = (daemon.address() as AddressInfo).port;
    host.found = { identity: 'chris@https://cube.example.org/api/v1/', url: `ws://127.0.0.1:${port}`, token: 'ATTACH' };
    const session = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'right' } });
    const key: string = (session.json() as { key: string }).key;
    await built.app.listen({ host: '127.0.0.1', port: 0 });
    const porterPort: number = (built.app.server.address() as AddressInfo).port;
    const client: WebSocket = new WebSocket(`ws://127.0.0.1:${porterPort}/s/${key}/?door`, { headers: { cookie: cookie_of(session) } });
    await new Promise<void>((resolve, reject) => { client.once('open', () => resolve()); client.once('error', reject); });
    const echoed: Promise<string> = new Promise((resolve) => client.once('message', (data: RawData) => resolve(data.toString())));
    client.send('hello');
    expect(await echoed).toBe('echo:hello');
    expect(seenUrl).toBe('/?door=&token=ATTACH');
    // A wire open counts as a surface on the session; closed, it does not.
    expect(built.registry.get(key)?.wires).toBe(1);
    client.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(built.registry.get(key)?.wires).toBe(0);
  });

  it('drops an upgrade without the cookie, even for a known key', async () => {
    const port: number = (daemon.address() as AddressInfo).port;
    host.found = { identity: 'chris@https://cube.example.org/api/v1/', url: `ws://127.0.0.1:${port}`, token: 'ATTACH' };
    const session = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'right' } });
    const key: string = (session.json() as { key: string }).key;
    await built.app.listen({ host: '127.0.0.1', port: 0 });
    const porterPort: number = (built.app.server.address() as AddressInfo).port;
    const client: WebSocket = new WebSocket(`ws://127.0.0.1:${porterPort}/s/${key}/`);
    const outcome: string = await new Promise((resolve) => {
      client.once('open', () => resolve('open'));
      client.once('error', () => resolve('refused'));
    });
    expect(outcome).toBe('refused');
    expect(seenUrl).toBeNull();
  });

  it('drops an upgrade for an unknown key', async () => {
    await built.app.listen({ host: '127.0.0.1', port: 0 });
    const porterPort: number = (built.app.server.address() as AddressInfo).port;
    const client: WebSocket = new WebSocket(`ws://127.0.0.1:${porterPort}/s/0123456789abcdef/`);
    const outcome: string = await new Promise((resolve) => {
      client.once('open', () => resolve('open'));
      client.once('error', () => resolve('refused'));
    });
    expect(outcome).toBe('refused');
  });
});

describe('a session whose daemon is gone', () => {
  const identity: string = 'chris@https://cube.example.org/api/v1/';
  /** A port nothing listens on: bound, noted, closed. */
  const deadPort_find = async (): Promise<number> => {
    const probe: Server = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port: number = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  };
  /** Logs in while the host reports a berth at `url`, and returns the cookie and key. */
  const attach = async (url: string): Promise<{ cookie: string; key: string }> => {
    host.found = { identity, url, token: 'ATTACH' };
    const response = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'right' } });
    return { cookie: cookie_of(response), key: (response.json() as { key: string }).key };
  };

  it('a new boot drops the entry that named the dead daemon', async () => {
    const registry: SessionRegistry = new SessionRegistry();
    const key: string = registry.note(identity, 'chris', { identity, url: 'ws://127.0.0.1:1111', token: 'OLD' }).key;
    registry.pending_note(identity, 'chris');
    expect(registry.get(key)).toBeNull();
    const settled = await registry.settle(identity, { find: async () => ({ identity, url: 'ws://127.0.0.1:2222', token: 'NEW' }) });
    expect(settled?.berth.url).toBe('ws://127.0.0.1:2222');
    expect(registry.get(key)?.berth.url).toBe('ws://127.0.0.1:2222');
  });

  it('the mount moves to where the session answers now, instead of a 500 for the dead port', async () => {
    const live: Server = createServer((_request, response) => { response.end('from the live daemon'); });
    await new Promise<void>((resolve) => live.listen(0, '127.0.0.1', resolve));
    try {
      const { cookie, key } = await attach(`ws://127.0.0.1:${await deadPort_find()}`);
      host.found = { identity, url: `ws://127.0.0.1:${(live.address() as AddressInfo).port}`, token: 'NEW' };
      const first = await built.app.inject({ method: 'GET', url: `/s/${key}/index.html`, headers: { cookie } });
      expect(first.statusCode).toBe(307);
      expect(first.headers.location).toBe(`/s/${key}/index.html`);
      const again = await built.app.inject({ method: 'GET', url: `/s/${key}/index.html`, headers: { cookie } });
      expect(again.statusCode).toBe(200);
      expect(again.body).toBe('from the live daemon');
    } finally {
      await new Promise<void>((resolve) => live.close(() => resolve()));
    }
  });

  it('with no session up, the mount sends the browser to the door and forgets the key', async () => {
    const { cookie, key } = await attach(`ws://127.0.0.1:${await deadPort_find()}`);
    host.found = null;
    const response = await built.app.inject({ method: 'GET', url: `/s/${key}/`, headers: { cookie } });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toMatch(/^\/login\?reason=your%20session%20ended/);
    expect((await built.app.inject({ method: 'GET', url: `/s/${key}/`, headers: { cookie } })).statusCode).toBe(404);
  });
});

describe('the relay to the session', () => {
  const identity: string = 'chris@https://cube.example.org/api/v1/';
  let upstream: Server;
  let upstreamPort: number;
  /** What the fake daemon does with each request. */
  let handle: (request: IncomingMessage, response: ServerResponse) => void;

  beforeEach(async () => {
    handle = (_request, response) => { response.end('ok'); };
    upstream = createServer((request, response) => handle(request, response));
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;
  });
  afterEach(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await built.app.close();
  });

  /** Logs in while the host reports the fake daemon (or `url`), and returns the cookie and key. */
  const attach = async (url: string = `ws://127.0.0.1:${upstreamPort}`): Promise<{ cookie: string; key: string }> => {
    host.found = { identity, url, token: 'ATTACH' };
    const response = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'right' } });
    return { cookie: cookie_of(response), key: (response.json() as { key: string }).key };
  };

  it('forwards a posted body larger than 1 MiB whole, whatever its type, and never answers 413', async () => {
    const seen: Array<{ url: string; bytes: number; type: string }> = [];
    handle = (request, response) => {
      let bytes: number = 0;
      request.on('data', (chunk: Buffer) => { bytes += chunk.length; });
      request.on('end', () => {
        seen.push({ url: request.url ?? '', bytes, type: String(request.headers['content-type'] ?? '') });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ bytes }));
      });
    };
    const { cookie, key } = await attach();
    const body: Buffer = Buffer.alloc(3 * 1024 * 1024, 7);
    for (const type of ['application/octet-stream', 'application/x-www-form-urlencoded', 'application/json', undefined]) {
      const headers: Record<string, string> = { cookie, ...(type === undefined ? {} : { 'content-type': type }) };
      const answer = await built.app.inject({ method: 'POST', url: `/s/${key}/vfs?path=%2Fhome%2Fchris%2Fbig.bin`, headers, payload: body });
      expect(answer.statusCode).toBe(200);
      expect(answer.json()).toEqual({ bytes: body.length });
    }
    expect(seen.map((one) => one.bytes)).toEqual([body.length, body.length, body.length, body.length]);
    expect(seen[0]?.url).toBe('/vfs?path=%2Fhome%2Fchris%2Fbig.bin&token=ATTACH');
    expect(seen[0]?.type).toBe('application/octet-stream');
  });

  it('passes the daemon\'s own refusal of a body on as it is', async () => {
    handle = (_request, response) => {
      response.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('file too large: this route takes at most 268435456 bytes');
    };
    const { cookie, key } = await attach();
    const answer = await built.app.inject({ method: 'POST', url: `/s/${key}/vfs?path=%2Fx`, headers: { cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(16) });
    expect(answer.statusCode).toBe(413);
    expect(answer.body).toBe('file too large: this route takes at most 268435456 bytes');
  });

  it('a file that stops part way after its 200: the browser\'s body is cut, and the porter says how far it got', async () => {
    handle = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/dicom', 'content-length': 11 });
      response.write('part1-');
      setTimeout(() => { response.socket?.destroy(); }, 30);
    };
    const { cookie, key } = await attach();
    await built.app.listen({ host: '127.0.0.1', port: 0 });
    const porterPort: number = (built.app.server.address() as AddressInfo).port;
    const outcome = await new Promise<{ status: number; received: number; broke: boolean }>((resolve) => {
      httpGet({ host: '127.0.0.1', port: porterPort, path: `/s/${key}/vfs?path=%2Fhome%2Fchris%2Fscan.dcm`, headers: { cookie } }, (response: IncomingMessage) => {
        let received: number = 0;
        response.on('data', (chunk: Buffer) => { received += chunk.length; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, received, broke: false }));
        response.on('error', () => resolve({ status: response.statusCode ?? 0, received, broke: true }));
        response.on('aborted', () => resolve({ status: response.statusCode ?? 0, received, broke: true }));
      });
    });
    expect(outcome).toEqual({ status: 200, received: 6, broke: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const line: string | undefined = said.find((one: string) => one.includes('stopped arriving'));
    expect(line).toMatch(/^chris's session: the file stopped arriving part way: \/vfs \/home\/chris\/scan\.dcm after 6 bytes of 11 \(.+\)$/);
    expect(said.some((one: string) => one.includes('did not answer'))).toBe(false);
  });

  it('a browser that leaves part way is not a break', async () => {
    handle = (_request, response) => {
      response.writeHead(200, { 'content-length': 1_000_000 });
      response.write(Buffer.alloc(1000));
    };
    const { cookie, key } = await attach();
    await built.app.listen({ host: '127.0.0.1', port: 0 });
    const porterPort: number = (built.app.server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => {
      const asked = httpGet({ host: '127.0.0.1', port: porterPort, path: `/s/${key}/vfs?path=%2Fa`, headers: { cookie } }, (response: IncomingMessage) => {
        response.once('data', () => { asked.destroy(); resolve(); });
      });
      asked.on('error', () => undefined);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(said.some((one: string) => one.includes('stopped arriving'))).toBe(false);
  });

  it('a socket closed before any answer is said so, not called a session that did not answer', async () => {
    handle = (request) => { request.socket.destroy(); };
    const { cookie, key } = await attach();
    const answer = await built.app.inject({ method: 'GET', url: `/s/${key}/vfs?path=%2Fhome%2Fchris%2Fscan.dcm`, headers: { cookie } });
    expect(answer.statusCode).toBe(502);
    const error: string = (answer.json() as { error: string }).error;
    expect(error).toMatch(/^the session closed the connection before it answered \(.+\)$/);
    expect(said).toContain(`chris's session: ${error}: GET /vfs /home/chris/scan.dcm`);
  });

  it('a refused connection, the session still on record there, is a session that did not answer', async () => {
    const probe: Server = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const deadPort: number = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const { cookie, key } = await attach(`ws://127.0.0.1:${deadPort}`);
    const answer = await built.app.inject({ method: 'GET', url: `/s/${key}/vfs?path=%2Fa`, headers: { cookie } });
    expect(answer.statusCode).toBe(502);
    expect((answer.json() as { error: string }).error).toMatch(/^the session did not answer: .*ECONNREFUSED/);
  });
});

describe('door tokens (chell auth)', () => {
  const up: Berth = { identity: 'chris@https://cube.example.org/api/v1/', url: 'ws://127.0.0.1:4444', token: 'ATTACH' };

  it('a JSON password login asking for a token is given one beside its session, and the token lets a script in later', async () => {
    host.found = up;
    const login = await built.app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/json' }, payload: { username: 'chris', password: 'right', tokenName: 'cron@titan' } });
    expect(login.statusCode).toBe(200);
    const body = login.json() as { state: string; token?: { token: string; name: string; expires: string } };
    expect(body.state).toBe('attached');
    expect(body.token?.name).toBe('cron@titan');
    expect(body.token?.token.startsWith('pdt_')).toBe(true);
    expect(said.some((line) => line.includes('minted a door token "cron@titan" for chris'))).toBe(true);
    // The store on disk holds the hash, never the plaintext.
    const kept: string = await (await import('node:fs/promises')).readFile(join(tokensDir, 'tokens.json'), 'utf8');
    expect(kept).not.toContain(body.token?.token as string);

    const byToken = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json', authorization: `Bearer ${body.token?.token}` } });
    expect(byToken.statusCode).toBe(200);
    expect(byToken.json()).toMatchObject({ state: 'attached' });
    expect(cookie_of(byToken)).toMatch(/^porter_session=/);
    expect(said.some((line) => line.includes('chris came through by door token "cron@titan"'))).toBe(true);
    expect(built.tokens.list()[0]?.lastUsed).not.toBeNull();
  });

  it('a token login with no session up boots one on the saved login (no CUBE token travels), and a password is never asked', async () => {
    const minted = built.tokens.mint('chris@https://cube.example.org/api/v1/', 'chris', 'laptop');
    host.found = null;
    const byToken = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json', authorization: `Bearer ${minted.token}` } });
    expect(byToken.statusCode).toBe(200);
    expect(byToken.json()).toMatchObject({ state: 'starting' });
    expect(host.restarted).toEqual([{ identity: 'chris@https://cube.example.org/api/v1/', user: 'chris' }]);
    expect(host.spawned).toEqual([]);
  });

  it('authorising a device code with no session up starts the session on that login\'s CUBE token, so a later token has a saved login to boot on', async () => {
    host.found = null;
    const asked = await built.app.inject({ method: 'POST', url: '/auth/device', headers: { 'content-type': 'application/json' }, payload: { host: 'titan' } });
    const { code } = asked.json() as { code: string };
    const authorised = await built.app.inject({ method: 'POST', url: '/login', payload: `username=chris&password=right&code=${encodeURIComponent(code)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(authorised.body).toContain('is authorised');
    expect(host.spawned).toEqual([{ identity: 'chris@https://cube.example.org/api/v1/', user: 'chris', token: 'TOKEN-chris' }]);
    expect(said.some((line) => line.includes('starting a session for chris beside the device login'))).toBe(true);
  });

  it('a token login answers whose token it was, lists the identity\'s tokens by one of them, and the token in hand can end itself', async () => {
    host.found = up;
    const mine = built.tokens.mint('chris@https://cube.example.org/api/v1/', 'chris', 'laptop');
    built.tokens.mint('chris@https://cube.example.org/api/v1/', 'chris', 'cron@titan');
    built.tokens.mint('kim@https://cube.example.org/api/v1/', 'kim', 'laptop');
    const byToken = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json', authorization: `Bearer ${mine.token}` } });
    expect(byToken.json()).toMatchObject({ state: 'attached', user: 'chris', tokenName: 'laptop' });
    const listed = await built.app.inject({ method: 'GET', url: '/auth/tokens', headers: { authorization: `Bearer ${mine.token}` } });
    const list = listed.json() as { user: string; tokens: Array<{ name: string }> };
    expect(list.user).toBe('chris');
    expect(list.tokens.map((t) => t.name).sort()).toEqual(['cron@titan', 'laptop']);
    const bare = await built.app.inject({ method: 'GET', url: '/auth/tokens' });
    expect(bare.statusCode).toBe(401);
    const revoked = await built.app.inject({ method: 'DELETE', url: '/auth/token', headers: { authorization: `Bearer ${mine.token}` } });
    expect(revoked.json()).toEqual({ revoked: true, name: 'laptop' });
    expect(built.tokens.list().map((t) => `${t.user}/${t.name}`).sort()).toEqual(['chris/cron@titan', 'kim/laptop']);
    const again = await built.app.inject({ method: 'DELETE', url: '/auth/token', headers: { authorization: `Bearer ${mine.token}` } });
    expect(again.statusCode).toBe(401);
    expect(said.some((line) => line.includes('chris revoked their door token "laptop"'))).toBe(true);
  });

  it('a login during a boot joins it rather than starting another: scripts arriving together never kill each other\'s boot', async () => {
    host.found = null;
    host.report = { state: 'booting', lines: [] };
    const first = await built.app.inject({ method: 'POST', url: '/login', headers: { 'content-type': 'application/json' }, payload: { username: 'chris', password: 'right' } });
    expect(first.json()).toMatchObject({ state: 'starting' });
    const minted = built.tokens.mint('chris@https://cube.example.org/api/v1/', 'chris', 'laptop');
    const second = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json', authorization: `Bearer ${minted.token}` } });
    expect(second.json()).toMatchObject({ state: 'starting' });
    expect(host.spawned).toEqual([]);
    expect(host.restarted).toEqual([]);
    expect(said.filter((line) => line.includes('joins the boot already under way'))).toHaveLength(2);
  });

  it('refuses an unknown, a malformed and an expired token by name, and says so in the journal', async () => {
    const unknown = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json', authorization: `Bearer pdt_${'q'.repeat(43)}` } });
    expect(unknown.statusCode).toBe(401);
    expect((unknown.json() as { error: string }).error).toContain('does not know that token');
    const malformed = await built.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json', authorization: 'Bearer TOKEN-chris' } });
    expect(malformed.statusCode).toBe(401);
    expect((malformed.json() as { error: string }).error).toBe('that is not a door token');

    let now: number = Date.parse('2026-10-06T00:00:00Z');
    const store = new TokenStore(join(tokensDir, 'aged.json'), 1, (): Date => new Date(now));
    store.load();
    const aged = store.mint('chris@https://cube.example.org/api/v1/', 'chris', 'old');
    now = Date.parse('2026-10-08T00:00:00Z');
    const lines: string[] = [];
    const door: PorterApp = await porterApp_build({ installed: {}, config, host, mint: async () => ({ token: 'x' }), tokens: store, log: (line: string): void => { lines.push(line); } });
    const expired = await door.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json', authorization: `Bearer ${aged.token}` } });
    expect(expired.statusCode).toBe(401);
    expect((expired.json() as { error: string }).error).toBe('the door token "old" expired on 2026-10-07; run chell auth login');
    expect(lines.some((line) => line.includes('refused chris\'s door token "old"'))).toBe(true);
    await door.app.close();
  });

  it('the device code: chell asks, the human authorises on the login page, chell polls the token once', async () => {
    const asked = await built.app.inject({ method: 'POST', url: '/auth/device', headers: { 'content-type': 'application/json' }, payload: { host: 'titan' } });
    expect(asked.statusCode).toBe(200);
    const { code, url } = asked.json() as { code: string; url: string };
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(url).toBe('/device');

    const pending = await built.app.inject({ method: 'GET', url: `/auth/device/${code}` });
    expect(pending.json()).toEqual({ state: 'pending' });

    const typed = await built.app.inject({ method: 'GET', url: '/device' });
    expect(typed.body).toContain('enter the code it showed you');
    expect(typed.body).toContain('name="code"');
    const page = await built.app.inject({ method: 'GET', url: `/login?code=${encodeURIComponent(code)}` });
    expect(page.body).toContain('Authorise <b>chell</b> on <b>titan</b>');
    expect(page.body).toContain(`name="code" value="${code}"`);
    expect(page.body).toContain('AUTHORISE');

    host.found = up;
    const authorised = await built.app.inject({ method: 'POST', url: '/login', payload: `username=chris&password=right&code=${encodeURIComponent(code)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(authorised.statusCode).toBe(200);
    expect(authorised.body).toContain('is authorised');
    expect(authorised.body).toContain('chris@titan');
    expect(said.some((line) => line.includes('minted a door token "chris@titan" for chris by device code'))).toBe(true);

    const granted = await built.app.inject({ method: 'GET', url: `/auth/device/${code}` });
    const grant = granted.json() as { state: string; token: string; user: string; name: string; expires: string };
    expect(grant.state).toBe('authorised');
    expect(grant.user).toBe('chris');
    expect(grant.name).toBe('chris@titan');
    expect(grant.token.startsWith('pdt_')).toBe(true);
    expect(built.tokens.check(grant.token).ok).toBe(true);

    const spent = await built.app.inject({ method: 'GET', url: `/auth/device/${code}` });
    expect(spent.statusCode).toBe(404);
    const dead = await built.app.inject({ method: 'GET', url: `/login?code=${encodeURIComponent(code)}` });
    expect(dead.body).toContain('is not waiting');
    const wrongPassword = await built.app.inject({ method: 'POST', url: '/login', payload: `username=chris&password=wrong&code=${encodeURIComponent(code)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(wrongPassword.statusCode).toBe(303); // back to the page with the code field
    expect(String(wrongPassword.headers.location)).toMatch(/^\/device\?reason=/);
  });
});

describe('GET /berths', () => {
  const ROWS: BerthAccess[] = [
    { user: 'ana', state: 'running', cohort: '42', cpuPercent: 3, memoryBytes: 210 * 1024 ** 2, memoryLimitBytes: 2 * 1024 ** 3 },
    { user: 'benito', state: 'stopped', cohort: null, cpuPercent: null, memoryBytes: null, memoryLimitBytes: null },
  ];
  /** A host that starts berths and reports these rows. */
  class AccessHost extends FakeHost {
    public fails: boolean = false;
    public readCube: string | null = null;
    async access_read(cubeUrl: string): Promise<BerthAccess[]> {
      this.readCube = cubeUrl;
      if (this.fails) throw new Error('connect ENOENT /run/launcher.sock');
      return ROWS;
    }
  }
  /** CUBE as the check sees it: it asks with the header it was handed, and says who administers. */
  const verdicts = (asked: string[]) => async (_cube: string, authorization: string): Promise<AdminVerdict> => {
    asked.push(authorization);
    return authorization === 'Token ADMIN' ? 'admin' : authorization === 'Token USER' ? 'not-admin' : authorization === 'Token DOWN' ? 'unreachable' : 'refused';
  };
  const app_make = async (over: SessionHost, asked: string[], now?: () => number): Promise<PorterApp> =>
    porterApp_build({ installed: {}, config: { ...config, tokensFile: join(tokensDir, 'tokens-berths.json') }, host: over, adminCheck: verdicts(asked), log: (line: string): void => { said.push(line); }, ...(now !== undefined ? { now } : {}) });

  it('refuses a caller with no credentials, or ones CUBE does not accept, before it asks the launcher', async () => {
    const asked: string[] = [];
    const made = await app_make(new AccessHost(), asked);
    expect((await made.app.inject({ method: 'GET', url: '/berths' })).statusCode).toBe(401);
    expect((await made.app.inject({ method: 'GET', url: '/berths', headers: { authorization: 'Bearer ADMIN' } })).statusCode).toBe(401);
    expect(asked).toEqual([]);
    const refused = await made.app.inject({ method: 'GET', url: '/berths', headers: { authorization: 'Token WRONG' } });
    expect(refused.statusCode).toBe(401);
    expect(refused.body).not.toContain('WRONG');
    await made.app.close();
  });

  it('refuses a CUBE user who is not an administrator, and says so when CUBE does not answer', async () => {
    const made = await app_make(new AccessHost(), []);
    expect((await made.app.inject({ method: 'GET', url: '/berths', headers: { authorization: 'Token USER' } })).statusCode).toBe(403);
    expect((await made.app.inject({ method: 'GET', url: '/berths', headers: { authorization: 'Token DOWN' } })).statusCode).toBe(502);
    await made.app.close();
  });

  it('answers an administrator, by token or by Basic credentials, with each person\'s berth or kept home, and logs no credential', async () => {
    const asked: string[] = [];
    const made = await app_make(new AccessHost(), asked);
    const basic: string = `Basic ${Buffer.from('chris:secret-password').toString('base64')}`;
    const answer = await made.app.inject({ method: 'GET', url: '/berths', headers: { authorization: 'Token ADMIN' } });
    expect(answer.statusCode).toBe(200);
    const body = answer.json() as { at: string; berths: BerthAccess[] };
    expect(Number.isNaN(Date.parse(body.at))).toBe(false);
    expect(body.berths).toEqual(ROWS);
    // Basic credentials reach CUBE as they came; CUBE here refuses them, and the refusal is a 401.
    expect((await made.app.inject({ method: 'GET', url: '/berths', headers: { authorization: basic } })).statusCode).toBe(401);
    expect(asked).toEqual(['Token ADMIN', basic]);
    expect(said.join('\n')).not.toContain('secret-password');
    expect(said.join('\n')).not.toContain('ADMIN');
    await made.app.close();
  });

  it('asks the launcher about this door\'s CUBE', async () => {
    const host = new AccessHost();
    const made = await app_make(host, []);
    await made.app.inject({ method: 'GET', url: '/berths', headers: { authorization: 'Token ADMIN' } });
    expect(host.readCube).toBe(config.cubeUrl);
    await made.app.close();
  });

  it('allows a client ten asks a minute, then answers 429 with Retry-After and does not ask CUBE; the minute passing lets it ask again', async () => {
    const asked: string[] = [];
    let at: number = 1_000_000;
    const made = await app_make(new AccessHost(), asked, () => at);
    const ask = (token: string) => made.app.inject({ method: 'GET', url: '/berths', headers: { authorization: `Token ${token}` } });
    for (let one = 0; one < 10; one += 1) expect((await ask(`WRONG${one}`)).statusCode).toBe(401);
    expect(asked).toHaveLength(10);
    at += 20_000;
    const over = await ask('WRONG10');
    expect(over.statusCode).toBe(429);
    expect(Number(over.headers['retry-after'])).toBe(40);
    expect((await made.app.inject({ method: 'GET', url: '/berths' })).statusCode).toBe(429);
    expect(asked).toHaveLength(10);
    at += 41_000;
    expect((await ask('ADMIN')).statusCode).toBe(200);
    await made.app.close();
  });

  it('counts each client address on its own', async () => {
    const made = await app_make(new AccessHost(), []);
    const ask = (address: string) => made.app.inject({ method: 'GET', url: '/berths', remoteAddress: address, headers: { authorization: 'Token ADMIN' } });
    for (let one = 0; one < 10; one += 1) await ask('10.0.0.1');
    expect((await ask('10.0.0.1')).statusCode).toBe(429);
    expect((await ask('10.0.0.2')).statusCode).toBe(200);
    await made.app.close();
  });

  it('keeps CUBE\'s verdict on one header for 30 s, under a hash, and asks again after; a silent CUBE is not remembered', async () => {
    const asked: string[] = [];
    let at: number = 5_000_000;
    const made = await app_make(new AccessHost(), asked, () => at);
    const ask = (token: string) => made.app.inject({ method: 'GET', url: '/berths', headers: { authorization: `Token ${token}` } });
    expect((await ask('ADMIN')).statusCode).toBe(200);
    expect((await ask('ADMIN')).statusCode).toBe(200);
    expect((await ask('USER')).statusCode).toBe(403);
    expect((await ask('USER')).statusCode).toBe(403);
    expect((await ask('WRONG')).statusCode).toBe(401);
    expect((await ask('WRONG')).statusCode).toBe(401);
    expect(asked).toEqual(['Token ADMIN', 'Token USER', 'Token WRONG']);
    at += 31_000;
    expect((await ask('ADMIN')).statusCode).toBe(200);
    expect(asked).toHaveLength(4);
    at += 1_000;
    expect((await ask('DOWN')).statusCode).toBe(502);
    expect((await ask('DOWN')).statusCode).toBe(502);
    expect(asked.filter((one) => one === 'Token DOWN')).toHaveLength(2);
    await made.app.close();
  });

  it('says a porter that starts no berths starts none', async () => {
    const made = await app_make(new FakeHost(), []);
    const answer = await made.app.inject({ method: 'GET', url: '/berths', headers: { authorization: 'Token ADMIN' } });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ berths: null, why: 'this porter starts no berths' });
    await made.app.close();
  });

  it('says a launcher that does not answer, with a 502', async () => {
    const down = new AccessHost();
    down.fails = true;
    const made = await app_make(down, []);
    const answer = await made.app.inject({ method: 'GET', url: '/berths', headers: { authorization: 'Token ADMIN' } });
    expect(answer.statusCode).toBe(502);
    expect((answer.json() as { error: string }).error).toContain('the berth launcher did not answer');
    await made.app.close();
  });
});

describe('the admin check against CUBE', () => {
  const root = (links: unknown, status: number = 200) => async (): Promise<AdminAnswer> => ({ status, json: async (): Promise<unknown> => ({ collection_links: links }) });
  it('takes the admin link on CUBE\'s root as an administrator, and its absence as a user who is not one', async () => {
    expect(await cubeAdmin_check('https://cube.example.org/api/v1/', 'Token T', root({ admin: 'https://cube.example.org/chris-admin/api/v1/', user: 'x' }))).toBe('admin');
    expect(await cubeAdmin_check('https://cube.example.org/api/v1/', 'Token T', root({ user: 'x' }))).toBe('not-admin');
    expect(await cubeAdmin_check('https://cube.example.org/api/v1/', 'Token T', root({ admin: null }))).toBe('not-admin');
  });

  it('hands CUBE the header as it came, asks for one item of the root, and tells a refusal from silence', async () => {
    let seen: Record<string, string> = {};
    let url: string = '';
    await cubeAdmin_check('https://cube.example.org/api/v1/', 'Basic abc', async (asked, init) => { url = asked; seen = init.headers; return { status: 200, json: async () => ({}) }; });
    expect(seen['Authorization']).toBe('Basic abc');
    expect(url).toBe('https://cube.example.org/api/v1/?limit=1');
    expect(await cubeAdmin_check('https://cube.example.org/api/v1/', 'Token T', root({}, 401))).toBe('refused');
    expect(await cubeAdmin_check('https://cube.example.org/api/v1/', 'Token T', root({}, 403))).toBe('refused');
    expect(await cubeAdmin_check('https://cube.example.org/api/v1/', 'Token T', root({}, 500))).toBe('unreachable');
    expect(await cubeAdmin_check('https://cube.example.org/api/v1/', 'Token T', async () => { throw new Error('down'); })).toBe('unreachable');
  });

  it('does not follow a redirect, takes it as CUBE not answering, and lets go of the body of every answer it does not read', async () => {
    let redirect: string = '';
    let cancelled: number = 0;
    const body = { cancel: async (): Promise<void> => { cancelled += 1; } };
    const answer = (status: number) => async (_url: string, init: { redirect: 'manual' }): Promise<AdminAnswer> => { redirect = init.redirect; return { status, body, json: async () => ({}) }; };
    expect(await cubeAdmin_check('https://cube.example.org/api/v1/', 'Token T', answer(302))).toBe('unreachable');
    expect(redirect).toBe('manual');
    expect(await cubeAdmin_check('https://cube.example.org/api/v1/', 'Token T', answer(401))).toBe('refused');
    expect(await cubeAdmin_check('https://cube.example.org/api/v1/', 'Token T', answer(503))).toBe('unreachable');
    expect(cancelled).toBe(3);
  });
});
