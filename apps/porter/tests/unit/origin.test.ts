/**
 * @file Where a request on the door's cookie came from, and how often a
 * password may be tried: the door's two answers to a browser being steered
 * and to a guesser.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { porterApp_build, cookie_carried, DEVICE_CODES_PER_MINUTE, LOGIN_FAILURES_PER_ADDRESS, LOGIN_FAILURES_PER_NAME, type PorterApp } from '../../src/app.js';
import { porterConfig_resolve, type PorterConfig } from '../../src/config.js';
import { AttemptLimit } from '../../src/limit.js';
import { doorOrigins_resolve, method_isSafe, origin_isDoors, origin_normalise, originRefusal_say } from '../../src/origin.js';
import type { Berth, SessionHost } from '../../src/host.js';

const config: PorterConfig = {
  cubeUrl: 'https://cube.example.org/api/v1/',
  stateDir: '/tmp/porter-test',
  host: '127.0.0.1',
  port: 4180,
  chellEntry: '/opt/chell/dist/index.js',
  secret: 'a-secret-of-at-least-twenty-characters',
  secretGenerated: false,
  cookieHours: 24,
  idleHours: 24, soundsDir: null,
  tokenDays: 30,
  tokensFile: '/tmp/porter-test-tokens-unused.json',
  berths: { mode: 'local' },
};

const OWN: string = 'http://127.0.0.1:4180';

/** A host with one session already up for whoever logs in. */
const host = {
  sessions_adopt: async (): Promise<never[]> => [],
  find: async (identity: string): Promise<Berth> => ({ identity, url: 'ws://127.0.0.1:4444', token: 'ATTACH' }),
  spawn: async (identity: string): Promise<Berth> => ({ identity, url: 'ws://127.0.0.1:4444', token: 'ATTACH' }),
  spawn_begin: (): void => undefined,
  boot_follow: (): null => null,
  evict: async (): Promise<boolean> => true,
  restart_begin: (): void => undefined,
} as unknown as SessionHost;

/** The door's cookie as a browser would send it back. */
function cookie_of(response: { headers: Record<string, unknown> }): string {
  const header: unknown = response.headers['set-cookie'];
  return (Array.isArray(header) ? String(header[0]) : String(header)).split(';')[0] ?? '';
}

interface Stand { door: PorterApp; minted: string[]; said: string[]; clock: { at: number } }

/** A door, the passwords CUBE was asked about, what it logged, and its clock. */
async function door_stand(extra: Partial<PorterConfig> = {}, mintMs: number = 0): Promise<Stand> {
  const minted: string[] = [];
  const said: string[] = [];
  const clock = { at: 1_000_000 };
  const dir: string = await mkdtemp(join(tmpdir(), 'porter-origin-'));
  const door: PorterApp = await porterApp_build({
    installed: {},
    config: { ...config, tokensFile: join(dir, 'tokens.json'), ...extra },
    host,
    now: (): number => clock.at,
    log: (line: string): void => { said.push(line); },
    mint: async (_cube: string, username: string, password: string) => {
      minted.push(username);
      if (mintMs > 0) await new Promise((resolve) => setTimeout(resolve, mintMs));
      return password === 'right' ? { token: `TOKEN-${username}` } : { token: null, reason: 'CUBE refused the login' };
    },
  });
  return { door, minted, said, clock };
}

const login = (door: PorterApp, username: string, password: string, headers: Record<string, string> = { origin: OWN }) =>
  door.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json', ...headers }, payload: { username, password } });

describe('an origin, as written and as the door\'s', () => {
  it('reads an origin as scheme, host and port, and nothing else as one', () => {
    expect(origin_normalise('https://Porter.Example.org/')).toBe('https://porter.example.org');
    expect(origin_normalise(' http://127.0.0.1:4180/login?x ')).toBe('http://127.0.0.1:4180');
    expect(origin_normalise('https://porter.example.org:443')).toBe('https://porter.example.org');
    for (const not of ['null', '', 'porter.example.org', 'file:///etc/passwd', 'javascript:alert(1)']) expect(origin_normalise(not)).toBeNull();
  });

  it('answers as this machine\'s own names at the port until the operator says otherwise', () => {
    expect(doorOrigins_resolve(undefined, 4180)).toEqual({ origins: ['http://127.0.0.1:4180', 'http://localhost:4180', 'http://[::1]:4180'], named: false });
    expect(doorOrigins_resolve('  ', 4180).named).toBe(false);
    expect(doorOrigins_resolve('https://porter.example.org/, https://alt.example.org:8443 ,https://porter.example.org', 4180)).toEqual({ origins: ['https://porter.example.org', 'https://alt.example.org:8443'], named: true });
    expect(() => doorOrigins_resolve('porter.example.org', 4180)).toThrow('PORTER_PUBLIC_ORIGIN is not an origin: porter.example.org');
  });

  it('is read from the environment, and a named origin replaces the machine\'s own', () => {
    const env = { PORTER_CUBE_URL: 'https://cube.example.org/api/v1/', PORTER_CHELL: '/x' };
    expect(porterConfig_resolve(env).origins).toEqual(doorOrigins_resolve(undefined, 4180));
    expect(porterConfig_resolve({ ...env, PORTER_PORT: '9000', PORTER_PUBLIC_ORIGIN: 'https://porter.example.org' }).origins).toEqual({ origins: ['https://porter.example.org'], named: true });
    expect(() => porterConfig_resolve({ ...env, PORTER_PUBLIC_ORIGIN: 'nonsense' })).toThrow('PORTER_PUBLIC_ORIGIN is not an origin');
  });

  it('takes only an origin that was sent and is one of its own', () => {
    const own: string[] = ['https://porter.example.org'];
    expect(origin_isDoors('https://porter.example.org', own)).toBe(true);
    expect(origin_isDoors(['https://porter.example.org'], own)).toBe(true);
    for (const other of [undefined, 'null', 'http://porter.example.org', 'https://porter.example.org.elsewhere.example', 'https://porter.example.org:8443', 'https://elsewhere.example']) {
      expect(origin_isDoors(other, own)).toBe(false);
    }
    expect(method_isSafe('get')).toBe(true);
    expect(method_isSafe('HEAD')).toBe(true);
    expect(method_isSafe('POST')).toBe(false);
    expect(method_isSafe('DELETE')).toBe(false);
  });

  it('says what it answers as, and how to name it when it was not named', () => {
    expect(originRefusal_say('https://elsewhere.example', doorOrigins_resolve(undefined, 4180))).toBe('the door does not take a request from https://elsewhere.example: it answers as http://127.0.0.1:4180, http://localhost:4180, http://[::1]:4180; if this door is reached by another name, set PORTER_PUBLIC_ORIGIN to it');
    expect(originRefusal_say(undefined, doorOrigins_resolve('https://porter.example.org', 4180))).toBe('the door does not take a request that does not say where it came from: it answers as https://porter.example.org');
  });

  it('knows a request that carries the door\'s cookie, valid or not', () => {
    expect(cookie_carried(undefined)).toBe(false);
    expect(cookie_carried('other=1; theme=dark')).toBe(false);
    expect(cookie_carried('other=1; porter_session=anything')).toBe(true);
    expect(cookie_carried('xporter_session=1')).toBe(false);
  });
});

describe('a request to the door, by where it came from', () => {
  it('takes a password only from its own page, and CUBE is not asked about one from elsewhere', async () => {
    const { door, minted, said } = await door_stand();
    for (const headers of [{}, { origin: 'https://elsewhere.example' }, { origin: 'null' }, { origin: 'http://127.0.0.1:4181' }]) {
      const refused = await login(door, 'chris', 'right', headers as Record<string, string>);
      expect(refused.statusCode).toBe(403);
      expect((refused.json() as { error: string }).error).toContain('the door does not take a request');
      expect(refused.headers['set-cookie']).toBeUndefined();
    }
    expect(minted).toEqual([]);
    expect(said.filter((line: string): boolean => line.startsWith('refused POST /login: the door does not take'))).toHaveLength(4);
    for (const own of [OWN, 'http://localhost:4180']) expect((await login(door, 'chris', 'right', { origin: own })).statusCode).toBe(200);
    await door.app.close();
  });

  it('takes nothing on its cookie from elsewhere, asks nothing of a read, and nothing of a program with no cookie', async () => {
    const { door } = await door_stand();
    const cookie: string = cookie_of(await login(door, 'chris', 'right'));
    expect(cookie).toContain('porter_session=');
    for (const url of ['/logout', '/restart', '/switch']) {
      for (const headers of [{ cookie }, { cookie, origin: 'https://elsewhere.example' }]) {
        expect([url, (await door.app.inject({ method: 'POST', url, headers, payload: {} })).statusCode]).toEqual([url, 403]);
      }
    }
    // The session's own routes, relayed: a write on the cookie from elsewhere never reaches the session.
    const key: string = ((await login(door, 'chris', 'right')).json() as { key: string }).key;
    expect((await door.app.inject({ method: 'POST', url: `/s/${key}/vfs?path=/x`, headers: { cookie, origin: 'https://elsewhere.example' }, payload: 'x' })).statusCode).toBe(403);
    expect((await door.app.inject({ method: 'DELETE', url: `/s/${key}/anything`, headers: { cookie } })).statusCode).toBe(403);
    // A cookie that is not even a valid one still marks a browser's request.
    expect((await door.app.inject({ method: 'POST', url: '/logout', headers: { cookie: 'porter_session=forged' }, payload: {} })).statusCode).toBe(403);
    // A read changes nothing and is not asked.
    expect((await door.app.inject({ method: 'GET', url: '/', headers: { cookie } })).statusCode).not.toBe(403);
    expect((await door.app.inject({ method: 'GET', url: '/healthz', headers: { cookie, origin: 'https://elsewhere.example' } })).statusCode).toBe(200);
    // A program: no cookie, so no browser was steered. It is answered on its own terms.
    expect((await door.app.inject({ method: 'POST', url: '/auth/device', payload: { host: 'pangea' } })).statusCode).toBe(200);
    expect((await door.app.inject({ method: 'DELETE', url: '/auth/token', headers: { authorization: 'Bearer pdt_nobody' } })).statusCode).toBe(401);
    expect((await door.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json', authorization: 'Bearer pdt_nobody' } })).statusCode).toBe(401);
    expect((await door.app.inject({ method: 'POST', url: '/logout', headers: { cookie, origin: OWN }, payload: {} })).statusCode).not.toBe(403);
    await door.app.close();
  });

  it('answers as the name its operator gave it, and then not as the machine\'s own', async () => {
    const { door } = await door_stand({ origins: doorOrigins_resolve('https://porter.example.org', 4180) });
    expect((await login(door, 'chris', 'right', { origin: 'https://porter.example.org' })).statusCode).toBe(200);
    const refused = await login(door, 'chris', 'right', { origin: OWN });
    expect(refused.statusCode).toBe(403);
    expect((refused.json() as { error: string }).error).toBe(`the door does not take a request from ${OWN}: it answers as https://porter.example.org`);
    // What a proxy says of itself does not decide it.
    expect((await login(door, 'chris', 'right', { origin: 'https://elsewhere.example', host: 'elsewhere.example', 'x-forwarded-host': 'elsewhere.example', 'x-forwarded-proto': 'https' })).statusCode).toBe(403);
    await door.app.close();
  });
});

describe('how often a password may be tried', () => {
  it('counts failed tries, not good ones, per key and inside its span', () => {
    let at = 0;
    const limit = new AttemptLimit(2, 60_000, (): number => at);
    expect(limit.wait_read('a')).toBe(0);
    limit.try_begin('a'); limit.try_forgive('a');
    limit.try_begin('a'); limit.try_begin('a');
    expect(limit.wait_read('a')).toBe(60);
    expect(limit.wait_read('b')).toBe(0);
    at = 59_500;
    expect(limit.wait_read('a')).toBe(1);
    at = 60_000;
    expect(limit.wait_read('a')).toBe(0);
  });

  it('holds a name after its failures from anywhere, says how long, and lets a right password in once the span has passed', async () => {
    const { door, minted, said, clock } = await door_stand();
    for (let n = 0; n < LOGIN_FAILURES_PER_NAME; n++) expect((await login(door, 'Chris', 'wrong')).statusCode).toBe(401);
    // The right password too is held: the count is of the name, however it is cased, and CUBE is not asked.
    const held = await door.app.inject({ method: 'POST', url: '/login', remoteAddress: '10.0.0.9', headers: { accept: 'application/json', origin: OWN }, payload: { username: 'chris', password: 'right' } });
    expect(held.statusCode).toBe(429);
    expect(held.headers['retry-after']).toBe('60');
    expect((held.json() as { error: string }).error).toBe('too many failed logins; try again in 60 s');
    expect(minted).toHaveLength(LOGIN_FAILURES_PER_NAME);
    expect(said).toContain('refused a login as chris: too many failed tries (60 s to wait)');
    // Another name from the same address is still heard.
    expect((await login(door, 'anna', 'right')).statusCode).toBe(200);
    clock.at += 60_000;
    expect((await login(door, 'chris', 'right')).statusCode).toBe(200);
    await door.app.close();
  });

  it('holds an address after its failures across names, and does not count the logins that were right', async () => {
    const { door, minted } = await door_stand();
    for (let n = 0; n < 30; n++) expect((await login(door, `good${n}`, 'right')).statusCode).toBe(200);
    for (let n = 0; n < LOGIN_FAILURES_PER_ADDRESS; n++) expect((await login(door, `name${n}`, 'wrong')).statusCode).toBe(401);
    expect((await login(door, 'another', 'right')).statusCode).toBe(429);
    expect(minted).toHaveLength(30 + LOGIN_FAILURES_PER_ADDRESS);
    // From another address the door is open.
    expect((await door.app.inject({ method: 'POST', url: '/login', remoteAddress: '10.0.0.9', headers: { accept: 'application/json', origin: OWN }, payload: { username: 'another', password: 'right' } })).statusCode).toBe(200);
    await door.app.close();
  });

  it('lets no more of a burst reach CUBE than the bound, though none has been answered yet', async () => {
    const { door, minted } = await door_stand({}, 40);
    const burst = await Promise.all(Array.from({ length: 20 }, () => login(door, 'chris', 'wrong')));
    expect(minted).toHaveLength(LOGIN_FAILURES_PER_NAME);
    expect(burst.filter((one): boolean => one.statusCode === 401)).toHaveLength(LOGIN_FAILURES_PER_NAME);
    expect(burst.filter((one): boolean => one.statusCode === 429)).toHaveLength(20 - LOGIN_FAILURES_PER_NAME);
    await door.app.close();
  });

  it('sends a held form back to its page with the reason, and holds device codes per address', async () => {
    const { door } = await door_stand();
    for (let n = 0; n < LOGIN_FAILURES_PER_NAME; n++) await login(door, 'chris', 'wrong');
    const form = await door.app.inject({ method: 'POST', url: '/login', headers: { origin: OWN, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'username=chris&password=right' });
    expect(form.statusCode).toBe(303);
    expect(form.headers.location).toBe(`/login?reason=${encodeURIComponent('too many failed logins; try again in 60 s')}`);
    for (let n = 0; n < DEVICE_CODES_PER_MINUTE; n++) expect((await door.app.inject({ method: 'POST', url: '/auth/device', payload: { host: 'pangea' } })).statusCode).toBe(200);
    const held = await door.app.inject({ method: 'POST', url: '/auth/device', payload: { host: 'pangea' } });
    expect(held.statusCode).toBe(429);
    expect(held.headers['retry-after']).toBe('60');
    await door.app.close();
  });
});
