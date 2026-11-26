/**
 * @file Where a request on the door's cookie came from, and how often a
 * password may be tried: the door's two answers to a browser being steered
 * and to a guesser.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { porterApp_build, cookie_carried, DEVICE_CODES_PER_MINUTE, LOGIN_FAILURES_PER_ADDRESS, LOGIN_FAILURES_PER_NAME, type PorterApp } from '../../src/app.js';
import { porterConfig_resolve, trustedProxies_read, type PorterConfig } from '../../src/config.js';
import { AttemptLimit, HitLimit, type Attempt } from '../../src/limit.js';
import { cubeToken_mint, type FetchLike } from '../../src/cube/auth.js';
import { doorOrigins_resolve, method_isSafe, origin_isDoors, origin_normalise, originHeader_read, originRefusal_say } from '../../src/origin.js';
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

/** Begins a try that the count has room for. */
function taken(limit: AttemptLimit, key: string): Attempt {
  const asked = limit.try_begin(key);
  if (!asked.ok) throw new Error(`no room for ${key}`);
  return asked.attempt;
}

/** The door's cookie as a browser would send it back. */
function cookie_of(response: { headers: Record<string, unknown> }): string {
  const header: unknown = response.headers['set-cookie'];
  return (Array.isArray(header) ? String(header[0]) : String(header)).split(';')[0] ?? '';
}

interface Stand { door: PorterApp; minted: string[]; said: string[]; clock: { at: number } }

/** A door, the passwords CUBE was asked about, what it logged, and its clock. */
async function door_stand(extra: Partial<PorterConfig> = {}, mintMs: number = 0, countCap?: number): Promise<Stand> {
  const minted: string[] = [];
  const said: string[] = [];
  const clock = { at: 1_000_000 };
  const dir: string = await mkdtemp(join(tmpdir(), 'porter-origin-'));
  const door: PorterApp = await porterApp_build({
    installed: {},
    config: { ...config, tokensFile: join(dir, 'tokens.json'), ...extra },
    host,
    now: (): number => clock.at,
    ...(countCap === undefined ? {} : { countCap }),
    log: (line: string): void => { said.push(line); },
    mint: async (_cube: string, username: string, password: string) => {
      minted.push(username);
      if (mintMs > 0) await new Promise((resolve) => setTimeout(resolve, mintMs));
      if (password === 'right') return { token: `TOKEN-${username}` };
      // A password that names CUBE's trouble stands for CUBE down, unreachable, or answering without a token.
      return password === 'cube-down' ? { token: null, why: 'unavailable' as const, reason: 'CUBE answered 503' } : { token: null, why: 'rejected' as const, reason: 'CUBE refused the login' };
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

  it('takes an Origin header only as a browser serializes one: one origin, nothing forgiven', () => {
    expect(originHeader_read('http://127.0.0.1:4180')).toBe('http://127.0.0.1:4180');
    expect(originHeader_read(['https://porter.example.org'])).toBe('https://porter.example.org');
    for (const hand of [undefined, 'HTTP://127.0.0.1:4180', 'http://127.0.0.1:4180/', ' http://127.0.0.1:4180', 'http://127.0.0.1:4180 ', 'https://Porter.example.org', 'https://porter.example.org:443', 'http://127.0.0.1:4180, http://127.0.0.1:4180', 'http://user@127.0.0.1:4180', 'http://127.0.0.1:4180/login', ['http://127.0.0.1:4180', 'http://127.0.0.1:4180'], []]) {
      expect([hand, originHeader_read(hand as string | string[] | undefined)]).toEqual([hand, null]);
    }
    expect(origin_isDoors('http://127.0.0.1:4180/', ['http://127.0.0.1:4180'])).toBe(false);
    // What an operator types is forgiven its spelling, though not a name and password in it.
    expect(origin_normalise('https://user:pw@porter.example.org')).toBeNull();
  });

  it('writes its own names as a browser does when its port is the scheme\'s own', () => {
    expect(doorOrigins_resolve(undefined, 80).origins).toEqual(['http://127.0.0.1', 'http://localhost', 'http://[::1]']);
    expect(origin_isDoors('http://127.0.0.1', doorOrigins_resolve(undefined, 80).origins)).toBe(true);
    expect(origin_isDoors('http://127.0.0.1:80', doorOrigins_resolve(undefined, 80).origins)).toBe(false);
  });

  it('reads the proxies it is to believe, and refuses what is not an address or a range', () => {
    expect(trustedProxies_read(undefined)).toEqual([]);
    expect(trustedProxies_read(' 10.0.0.1, 172.16.0.0/12 ,loopback,uniquelocal, ::1, fd00::/8')).toEqual(['10.0.0.1', '172.16.0.0/12', 'loopback', 'uniquelocal', '::1', 'fd00::/8']);
    for (const not of ['true', 'caddy', '10.0.0.1/33', '10.0.0.1/8/8', '*']) expect(() => trustedProxies_read(not)).toThrow(`not ${not}`);
    const env = { PORTER_CUBE_URL: 'https://cube.example.org/api/v1/', PORTER_CHELL: '/x' };
    expect(porterConfig_resolve(env).trustedProxies).toEqual([]);
    expect(porterConfig_resolve({ ...env, PORTER_TRUSTED_PROXIES: 'loopback' }).trustedProxies).toEqual(['loopback']);
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

  it('asks it of the password branch of the login route itself, however the address is spelled', async () => {
    const { door, minted } = await door_stand();
    const statuses: Array<[string, number]> = [];
    for (const url of ['/login', '/login?next=/', '/login?', '/login/', '//login', '/LOGIN', '/login%2F', '/./login', '/x/../login', '/login#x']) {
      const answer = await door.app.inject({ method: 'POST', url, headers: { accept: 'application/json' }, payload: { username: 'chris', password: 'right' } });
      statuses.push([url, answer.statusCode]);
      expect(answer.headers['set-cookie']).toBeUndefined();
    }
    // Whatever the router made of each spelling, none of them got a password as far as CUBE.
    expect(minted).toEqual([]);
    expect(statuses.filter(([, status]: [string, number]): boolean => status === 200)).toEqual([]);
    expect(statuses.find(([url]: [string, number]): boolean => url === '/login?next=/')?.[1]).toBe(403);
    // Two Origin lines are no origin.
    expect((await door.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json', origin: `${OWN}, ${OWN}` }, payload: { username: 'chris', password: 'right' } })).statusCode).toBe(403);
    expect((await door.app.inject({ method: 'POST', url: '/login', headers: { accept: 'application/json', origin: `${OWN}/` }, payload: { username: 'chris', password: 'right' } })).statusCode).toBe(403);
    expect(minted).toEqual([]);
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
    limit.try_forgive(taken(limit, 'a'));
    limit.try_fail(taken(limit, 'a'));
    limit.try_fail(taken(limit, 'a'));
    expect(limit.wait_read('a')).toBe(60);
    expect(limit.wait_read('b')).toBe(0);
    at = 59_500;
    expect(limit.wait_read('a')).toBe(1);
    at = 60_000;
    expect(limit.wait_read('a')).toBe(0);
  });

  it('takes out the very try that is forgiven, whichever began or ended meanwhile', () => {
    let at = 0;
    const limit = new AttemptLimit(2, 60_000, (): number => at);
    // An old try that will turn out right, then a newer one that fails: forgiving the old one must not
    // take the newer failure's place in the count.
    const slowRight: Attempt = taken(limit, 'a');
    at = 30_000;
    const quickWrong: Attempt = taken(limit, 'a');
    limit.try_fail(quickWrong);
    limit.try_forgive(slowRight);
    at = 60_000;
    // The failure of 30 s still stands; had the newest been popped, the old stamp would have aged out by now.
    limit.try_fail(taken(limit, 'a'));
    expect(limit.wait_read('a')).toBe(30);
    // Forgiving twice, or a try already aged out, takes nothing else with it.
    limit.try_forgive(slowRight);
    expect(limit.wait_read('a')).toBe(30);
    at = 90_000;
    expect(limit.wait_read('a')).toBe(0);
  });

  it('counts a try for as long as it is in the air, past the span, and a failure from when it began', () => {
    let at = 0;
    const limit = new AttemptLimit(1, 60_000, (): number => at);
    const slow: Attempt = taken(limit, 'a');
    at = 120_000;
    // Still unanswered after two spans: it is still a try, and the key is held for it.
    expect(limit.wait_read('a')).toBe(1);
    limit.try_fail(slow);
    // Told at last, it is a failure of two minutes ago, and has aged out.
    expect(limit.wait_read('a')).toBe(0);
    const again: Attempt = taken(limit, 'a');
    at = 200_000;
    limit.try_forgive(again);
    expect(limit.wait_read('a')).toBe(0);
  });

  it('at capacity lets go of nothing that still counts, turns a new key away, and has room again when one ages out', () => {
    let at = 0;
    const limit = new AttemptLimit(1, 60_000, (): number => at, 3);
    const inTheAir: Attempt = taken(limit, 'in-the-air');
    at = 10_000;
    limit.try_fail(taken(limit, 'failed-at-10'));
    at = 20_000;
    limit.try_fail(taken(limit, 'failed-at-20'));
    // Full of keys that count: a fourth is not admitted, and is told how long until the first failure ages out.
    expect(limit.try_begin('new').ok).toBe(false);
    expect(limit.room_wait('new')).toBe(50);
    // Nothing was let go for it: every held key is still held, and a held key may still be asked about.
    expect(limit.wait_read('in-the-air')).toBe(1);
    expect(limit.wait_read('failed-at-10')).toBe(50);
    expect(limit.wait_read('failed-at-20')).toBe(60);
    expect(limit.room_wait('failed-at-20')).toBe(0);
    // A forgiven try frees its key at once.
    limit.try_forgive(inTheAir);
    expect(limit.room_wait('new')).toBe(0);
    limit.try_fail(taken(limit, 'new'));
    expect(limit.try_begin('another').ok).toBe(false);
    // And an aged-out failure frees its key in time.
    at = 70_000;
    expect(limit.try_begin('another').ok).toBe(true);
    expect(limit.wait_read('failed-at-20')).toBe(10);
    // Every key in the air: none is let go, the new key waits, and the count never grows past its cap.
    const full = new AttemptLimit(1, 60_000, (): number => at, 2);
    full.try_begin('a'); full.try_begin('b');
    at = 500_000;
    // Nobody can date the end of a try in the air: the wait is the short fixed one, to ask again.
    expect(full.try_begin('c')).toEqual({ ok: false, wait: 5 });
    expect(full.room_wait('c')).toBe(5);
    expect(full.wait_read('a')).toBe(1);
    expect(full.wait_read('b')).toBe(1);
  });

  it('advertises the wait until a whole key is gone, not until its first failure ages out, and admits at that moment', () => {
    let at = 0;
    const limit = new AttemptLimit(5, 60_000, (): number => at, 1);
    // One key holds the only place, with failures staggered at 0 s and 30 s.
    limit.try_fail(taken(limit, 'held'));
    at = 30_000;
    limit.try_fail(taken(limit, 'held'));
    at = 40_000;
    // The first failure ages out at 60 s, but the key stays until the second does, at 90 s: that is the wait.
    expect(limit.try_begin('new')).toEqual({ ok: false, wait: 50 });
    // Refused again and again, the count is as it was: the same answer counted down, the held key untouched.
    const before: string = JSON.stringify([...(limit as unknown as { tries: Map<string, Attempt[]> }).tries]);
    at = 45_000;
    for (let n = 0; n < 50; n++) expect(limit.try_begin(`other${n}`)).toEqual({ ok: false, wait: 45 });
    expect(JSON.stringify([...(limit as unknown as { tries: Map<string, Attempt[]> }).tries])).toBe(before);
    // Past the first failure's age-out there is still no place, as advertised.
    at = 60_000;
    expect(limit.try_begin('new')).toEqual({ ok: false, wait: 30 });
    at = 89_999;
    expect(limit.try_begin('new')).toEqual({ ok: false, wait: 1 });
    // At the advertised moment there is.
    at = 90_000;
    expect(limit.try_begin('new').ok).toBe(true);
    // A key with a try in the air beside an old failure is not dated by the failure.
    at = 0;
    const mixed = new AttemptLimit(5, 60_000, (): number => at, 2);
    mixed.try_fail(taken(mixed, 'a'));
    const air: Attempt = taken(mixed, 'a');
    mixed.try_fail(taken(mixed, 'b'));
    at = 10_000;
    mixed.try_fail(taken(mixed, 'b'));
    // a cannot be dated (a try in the air); b is wholly gone at 70 s.
    expect(mixed.try_begin('c')).toEqual({ ok: false, wait: 60 });
    // The try in the air ends as a failure of 0 s: a is gone at 60 s, sooner than was said, and the count
    // works that out afresh once a key is let go, never later than it said.
    mixed.try_fail(air);
    at = 60_000;
    expect(mixed.try_begin('c')).toEqual({ ok: false, wait: 10 });
    at = 70_000;
    expect(mixed.try_begin('c').ok).toBe(true);
  });

  it('holds device-code counts the same way: a full count forgets only what has aged out', () => {
    let at = 0;
    const hits = new HitLimit(2, 60_000, (): number => at, 2);
    expect(hits.hit_take('a')).toBe(0);
    at = 10_000;
    expect(hits.hit_take('b')).toBe(0);
    // Full of clients whose hits count: a third is turned away until the first is wholly aged out, and
    // neither is forgotten. b's one hit ages out at 70 s; a's at 60 s, until a asks again below.
    expect(hits.hit_take('c')).toBe(50);
    for (let n = 0; n < 20; n++) expect(hits.hit_take(`other${n}`)).toBe(50);
    expect(hits.hit_take('a')).toBe(0);
    expect(hits.hit_take('a')).toBe(50);
    at = 60_000;
    // a's first hit has aged out but its second counts: still held. b's has not aged out either.
    expect(hits.hit_take('c')).toBe(10);
    at = 70_000;
    expect(hits.hit_take('c')).toBe(0);
    expect(hits.hit_take('a')).toBe(0);
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

  it('takes a login into both counts or neither: a count with no room turns it away and the other gives it back', async () => {
    const { door, minted, said } = await door_stand({}, 0, 2);
    // Two names fail from this address: the name count is full (two keys), the address count holds one key.
    expect((await login(door, 'a', 'wrong')).statusCode).toBe(401);
    expect((await login(door, 'b', 'wrong')).statusCode).toBe(401);
    // Twenty logins under new names: the name count has no room, so each is turned away before CUBE is
    // asked, with the wait until a held name ages out.
    for (let n = 0; n < 20; n++) {
      const away = await login(door, `new${n}`, 'right');
      expect(away.statusCode).toBe(429);
      expect(away.headers['retry-after']).toBe('60');
      expect((away.json() as { error: string }).error).toBe('the door is under too many failed logins to take another; try again in 60 s');
    }
    expect(minted).toEqual(['a', 'b']);
    expect(said.filter((line: string): boolean => line.includes('counting as many failed logins as it can hold'))).toHaveLength(20);
    // None of the twenty was left in the address count: had they been, this address (two failures, bound of
    // ten) would be held now. A held name with room in both counts is still heard, and is right.
    expect((await login(door, 'a', 'right')).statusCode).toBe(200);
    // And the names that were held are still held as they were: one failure each, four more allowed.
    for (let n = 0; n < LOGIN_FAILURES_PER_NAME - 1; n++) expect((await login(door, 'b', 'wrong')).statusCode).toBe(401);
    expect((await login(door, 'b', 'right')).statusCode).toBe(429);
    await door.app.close();
  });

  it('holds nobody for CUBE\'s own trouble: only a password CUBE refused is a failure', async () => {
    const { door, minted } = await door_stand();
    for (let n = 0; n < 25; n++) {
      const down = await login(door, 'chris', 'cube-down');
      expect(down.statusCode).toBe(401);
      expect((down.json() as { error: string }).error).toBe('CUBE answered 503');
    }
    expect(minted).toHaveLength(25);
    // CUBE back: the same name, from the same address, is let in at once.
    expect((await login(door, 'chris', 'right')).statusCode).toBe(200);
    await door.app.close();
  });

  it('tells a refusal of the credentials from every other no CUBE can give', async () => {
    const answer = (status: number, body: unknown = {}): FetchLike => (async () => ({ ok: status >= 200 && status < 300, status, json: async (): Promise<unknown> => body })) as unknown as FetchLike;
    const cube: string = 'https://cube.example.org/api/v1/';
    for (const status of [400, 401, 403]) expect(await cubeToken_mint(cube, 'u', 'p', answer(status))).toMatchObject({ token: null, why: 'rejected' });
    for (const status of [404, 429, 500, 502, 503]) expect(await cubeToken_mint(cube, 'u', 'p', answer(status))).toMatchObject({ token: null, why: 'unavailable', reason: `CUBE answered ${status}` });
    expect(await cubeToken_mint(cube, 'u', 'p', answer(200, {}))).toEqual({ token: null, why: 'unavailable', reason: 'CUBE answered without a token' });
    expect(await cubeToken_mint(cube, 'u', 'p', (async () => { throw new Error('getaddrinfo ENOTFOUND cube.example.org'); }) as unknown as FetchLike)).toMatchObject({ token: null, why: 'unavailable' });
    expect(await cubeToken_mint(cube, 'u', 'p', answer(200, { token: 'T' }))).toEqual({ token: 'T' });
  });

  it('counts a peer nobody named by its own address, whatever it says it forwards for', async () => {
    const { door, minted } = await door_stand();
    for (let n = 0; n < LOGIN_FAILURES_PER_ADDRESS; n++) {
      expect((await login(door, `name${n}`, 'wrong', { origin: OWN, 'x-forwarded-for': `203.0.113.${n}` })).statusCode).toBe(401);
    }
    expect((await login(door, 'another', 'right', { origin: OWN, 'x-forwarded-for': '203.0.113.200' })).statusCode).toBe(429);
    expect(minted).toHaveLength(LOGIN_FAILURES_PER_ADDRESS);
    // Its forwarded scheme is not believed either: the cookie is not marked Secure on its say-so.
    const fresh = await door_stand();
    const plain = await login(fresh.door, 'chris', 'right', { origin: OWN, 'x-forwarded-proto': 'https' });
    expect(String(plain.headers['set-cookie'])).not.toContain('Secure');
    await fresh.door.app.close();
    await door.app.close();
  });

  it('believes a proxy its operator named: each visitor is counted by the address the proxy gives', async () => {
    const { door } = await door_stand({ trustedProxies: ['127.0.0.1'], origins: doorOrigins_resolve('https://porter.example.org', 4180) });
    const via = (visitor: string): Record<string, string> => ({ origin: 'https://porter.example.org', 'x-forwarded-for': visitor, 'x-forwarded-proto': 'https' });
    for (let n = 0; n < LOGIN_FAILURES_PER_ADDRESS; n++) expect((await login(door, `name${n}`, 'wrong', via('203.0.113.7'))).statusCode).toBe(401);
    expect((await login(door, 'another', 'right', via('203.0.113.7'))).statusCode).toBe(429);
    const other = await login(door, 'another', 'right', via('203.0.113.8'));
    expect(other.statusCode).toBe(200);
    expect(String(other.headers['set-cookie'])).toContain('Secure');
    // The generated deployment names Caddy's one address on its link with porter. A sibling container on
    // another private address is not Caddy: what it forwards is not believed, for logins or for device codes.
    const deployed = await door_stand({ trustedProxies: ['10.213.76.2'], origins: doorOrigins_resolve('https://porter.example.org', 4180) });
    const code = (peer: string, visitor: string) => deployed.door.app.inject({ method: 'POST', url: '/auth/device', remoteAddress: peer, headers: { 'x-forwarded-for': visitor }, payload: { host: 'pangea' } });
    for (let n = 0; n < DEVICE_CODES_PER_MINUTE; n++) expect((await code('172.18.0.9', `203.0.113.${n}`)).statusCode).toBe(200);
    expect((await code('172.18.0.9', '203.0.113.250')).statusCode).toBe(429);
    // Through Caddy each visitor has a count of their own.
    for (let n = 0; n < DEVICE_CODES_PER_MINUTE + 5; n++) expect((await code('10.213.76.2', `203.0.113.${n}`)).statusCode).toBe(200);
    await deployed.door.app.close();
    // A peer that is not the named proxy is counted by its own address, and may say what it likes.
    for (let n = 0; n < LOGIN_FAILURES_PER_ADDRESS; n++) await door.app.inject({ method: 'POST', url: '/login', remoteAddress: '198.51.100.9', headers: { accept: 'application/json', origin: 'https://porter.example.org', 'x-forwarded-for': `203.0.113.${50 + n}` }, payload: { username: `n${n}`, password: 'wrong' } });
    expect((await door.app.inject({ method: 'POST', url: '/login', remoteAddress: '198.51.100.9', headers: { accept: 'application/json', origin: 'https://porter.example.org', 'x-forwarded-for': '203.0.113.99' }, payload: { username: 'fresh', password: 'right' } })).statusCode).toBe(429);
    await door.app.close();
  });

  it('marks the cookie Secure when every name the door answers as is https, though the socket is plain', async () => {
    const { door } = await door_stand({ origins: doorOrigins_resolve('https://porter.example.org', 4180) });
    expect(String((await login(door, 'chris', 'right', { origin: 'https://porter.example.org' })).headers['set-cookie'])).toContain('Secure');
    await door.app.close();
  });

  it('answers a held form with its own page, 429 and the wait, and holds device codes per address', async () => {
    const { door } = await door_stand();
    for (let n = 0; n < LOGIN_FAILURES_PER_NAME; n++) await login(door, 'chris', 'wrong');
    const form = await door.app.inject({ method: 'POST', url: '/login', headers: { origin: OWN, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'username=chris&password=right' });
    expect(form.statusCode).toBe(429);
    expect(form.headers['retry-after']).toBe('60');
    expect(form.headers.location).toBeUndefined();
    expect(String(form.headers['content-type'])).toContain('text/html');
    expect(form.body).toContain('too many failed logins; try again in 60 s');
    expect(form.body).toContain('name="password"');
    // A form that carried a device code gets the page with the code field back.
    const device = await door.app.inject({ method: 'POST', url: '/login', headers: { origin: OWN, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'username=chris&password=right&code=ABCD-EFGH' });
    expect(device.statusCode).toBe(429);
    expect(device.body).toContain('name="code"');
    for (let n = 0; n < DEVICE_CODES_PER_MINUTE; n++) expect((await door.app.inject({ method: 'POST', url: '/auth/device', payload: { host: 'pangea' } })).statusCode).toBe(200);
    const held = await door.app.inject({ method: 'POST', url: '/auth/device', payload: { host: 'pangea' } });
    expect(held.statusCode).toBe(429);
    expect(held.headers['retry-after']).toBe('60');
    await door.app.close();
  });
});
