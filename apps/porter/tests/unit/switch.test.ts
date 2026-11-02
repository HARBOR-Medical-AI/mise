/**
 * @file The switch between a person's sessions: their ChRIS one and their
 * stratus one, started on the credentials filed under their ChRIS identity.
 * One cookie, one person: nothing lets one person reach another's.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { porterApp_build, type PorterApp } from '../../src/app.js';
import type { Berth, BootListener, BootReport, SessionHost } from '../../src/host/sessionHost.js';
import type { PorterConfig } from '../../src/config.js';
import { CredentialStore } from '../../src/creds.js';

const OWNER: string = 'rudolph@https://cube.example.org/api/v1/';
const STRATUS: string = `stratus:oci@${OWNER}`;

/** A host whose sessions are a map, recording what it was asked. */
class SwitchHost implements SessionHost {
  public up: Map<string, Berth> = new Map();
  public armed: Map<string, boolean> = new Map();
  public begun: Array<{ identity: string; configPath: string; spend: boolean; replace: boolean; door?: { cubeUrl: string; user: string } }> = [];
  async sessions_adopt(): Promise<Array<{ identity: string; berth: Berth; alive: boolean }>> { return []; }
  async find(identity: string): Promise<Berth | null> { return this.up.get(identity) ?? null; }
  async spawn(identity: string): Promise<Berth> { const berth: Berth = { identity, url: 'ws://127.0.0.1:4444', token: 'A' }; this.up.set(identity, berth); return berth; }
  spawn_begin(identity: string): void { void this.spawn(identity); }
  boot_follow(_identity: string, _listener: BootListener): { report: BootReport; release: () => void } | null { return null; }
  async evict(): Promise<boolean> { return true; }
  restart_begin(): void { /* not asked */ }
  stratus_begin(identity: string, configPath: string, spend: boolean, replace: boolean, door?: { cubeUrl: string; user: string }): void { this.begun.push({ identity, configPath, spend, replace, ...(door === undefined ? {} : { door }) }); }
  stratus_armed(identity: string): boolean | null { return this.armed.get(identity) ?? null; }
}

let host: SwitchHost;
let door: PorterApp;
let config: PorterConfig;
let stateDir: string;

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'porter-switch-'));
  config = {
    cubeUrl: 'https://cube.example.org/api/v1/', stateDir, host: '127.0.0.1', port: 0, chellEntry: '/opt/chell/dist/index.js',
    secret: 'a-secret-of-at-least-twenty-characters', secretGenerated: false, cookieHours: 24, idleHours: 24, soundsDir: null,
    tokenDays: 30, tokensFile: join(stateDir, 'tokens.json'),
  };
  host = new SwitchHost();
  host.up.set(OWNER, { identity: OWNER, url: 'ws://127.0.0.1:4444', token: 'A' });
  door = await porterApp_build({ installed: {}, config, host, mint: async () => ({ token: 'T' }) });
});

/** Logs rudolph in, as a browser, and answers the cookie. */
async function login(): Promise<string> {
  const reply = await door.app.inject({ method: 'POST', url: '/login', payload: { username: 'rudolph', password: 'p' }, headers: { accept: 'application/json' } });
  const header: unknown = reply.headers['set-cookie'];
  return (Array.isArray(header) ? String(header[0]) : String(header)).split(';')[0] ?? '';
}

/** Files rudolph's OCI key, as the host's operator would. */
function creds_file(): void {
  writeFileSync(join(stateDir, 'k.pem'), 'PRIVATE');
  writeFileSync(join(stateDir, 'oci'), `[DEFAULT]\nuser=u\nfingerprint=f\ntenancy=t\nregion=r\nkey_file=${join(stateDir, 'k.pem')}\n`);
  new CredentialStore(stateDir).oci_import(OWNER, join(stateDir, 'oci'));
}

describe('POST /switch', () => {
  it('refuses a browser with no session, and a person with no filed credentials, by name', async () => {
    expect((await door.app.inject({ method: 'POST', url: '/switch', payload: { to: 'stratus', cloud: 'oci' } })).statusCode).toBe(401);
    const cookie: string = await login();
    const refused = await door.app.inject({ method: 'POST', url: '/switch', payload: { to: 'stratus', cloud: 'oci' }, headers: { cookie } });
    expect(refused.statusCode).toBe(404);
    expect(refused.json().error).toContain('no OCI credentials are filed for rudolph');
    expect(host.begun).toEqual([]);
  });

  it('starts the person\'s stratus session read-only on their own credentials, and moves the cookie to it', async () => {
    creds_file();
    const cookie: string = await login();
    const reply = await door.app.inject({ method: 'POST', url: '/switch', payload: { to: 'stratus', cloud: 'oci' }, headers: { cookie } });
    expect(reply.json()).toMatchObject({ state: 'starting', greet: expect.stringMatching(/^\/greet\//) });
    // The door the session can be raised at: the person's CUBE and name, so a READ session asks their password once (D14).
    expect(host.begun).toEqual([{ identity: STRATUS, configPath: new CredentialStore(stateDir).ociConfig_find(OWNER), spend: false, replace: false, door: { cubeUrl: 'https://cube.example.org/api/v1/', user: 'rudolph' } }]);
    expect(String(reply.headers['set-cookie'])).toContain(reply.json().key);
  });

  it('restarts a stratus session left up on an older release, on the tier it had, instead of joining it', async () => {
    creds_file();
    const newer: PorterApp = await porterApp_build({ installed: { stratus: '0.10.1', calypso: '0.29.0' }, config, host, mint: async () => ({ token: 'T' }) });
    const reply = await newer.app.inject({ method: 'POST', url: '/login', payload: { username: 'rudolph', password: 'p' }, headers: { accept: 'application/json' } });
    const cookie: string = (String(reply.headers['set-cookie']).split(';')[0]) ?? '';
    host.up.set(STRATUS, { identity: 'u@t', url: 'ws://127.0.0.1:5555', token: 'S', versions: { stratus: '0.10.0', calypso: '0.29.0' } });
    host.armed.set(STRATUS, false);
    const switched = await newer.app.inject({ method: 'POST', url: '/switch', payload: { to: 'stratus', cloud: 'oci' }, headers: { cookie } });
    expect(switched.json()).toMatchObject({ state: 'starting' });
    expect(host.begun.at(-1)).toMatchObject({ identity: STRATUS, spend: false, replace: true, door: { user: 'rudolph' } });
    // On the release it ships, the session is joined.
    host.up.set(STRATUS, { identity: 'u@t', url: 'ws://127.0.0.1:5555', token: 'S', versions: { stratus: '0.10.1', calypso: '0.29.0' } });
    const joined = await newer.app.inject({ method: 'POST', url: '/switch', payload: { to: 'stratus', cloud: 'oci' }, headers: { cookie } });
    expect(joined.json()).toMatchObject({ state: 'attached' });
    await newer.app.close();
  });

  it('joins a session up on the tier asked, restarts one on the other, and goes back to ChRIS', async () => {
    creds_file();
    const cookie: string = await login();
    host.up.set(STRATUS, { identity: 'u@t', url: 'ws://127.0.0.1:5555', token: 'S' });
    host.armed.set(STRATUS, false);
    const joined = await door.app.inject({ method: 'POST', url: '/switch', payload: { to: 'stratus', cloud: 'oci' }, headers: { cookie } });
    expect(joined.json()).toMatchObject({ state: 'attached' });
    const armed = await door.app.inject({ method: 'POST', url: '/switch', payload: { to: 'stratus', cloud: 'oci', spend: true }, headers: { cookie } });
    expect(armed.json()).toMatchObject({ state: 'starting' });
    expect(host.begun.at(-1)).toMatchObject({ spend: true, replace: true });
    // From the stratus session's own cookie, back to the ChRIS one.
    const stratusCookie: string = (String(armed.headers['set-cookie']).split(';')[0]) ?? '';
    const back = await door.app.inject({ method: 'POST', url: '/switch', payload: { to: 'chris' }, headers: { cookie: stratusCookie } });
    expect(back.json()).toMatchObject({ state: 'attached', mount: expect.stringMatching(/^\/s\//) });
  });

  it('refuses a switch it cannot read', async () => {
    const cookie: string = await login();
    expect((await door.app.inject({ method: 'POST', url: '/switch', payload: { to: 'elsewhere' }, headers: { cookie } })).statusCode).toBe(400);
  });
});
