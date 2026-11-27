/**
 * @file A terminal comes through the door: the login, the boot stream, the
 * wire, and the cookie that names the session.
 *
 * @module
 */
import { jest, describe, it, expect } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doorFile_write, doorDefault_write } from '../src/remote/doorFile.js';
import { door_normalise, doorOrigin_derive, doorWire_build, door_login, doorBoot_follow, bootEvents_read, door_enter, doorCredential_missing, doorUnreached_reason, door_loginByToken, door_loginForToken, doorDevice_begin, doorDevice_wait, doorTokens_list, doorToken_revoke, doorRefusal_words, type DoorFetch } from '../src/remote/door.js';

/** A door that answers every request the same way, and remembers what it was asked. */
function answer(status: number, body: unknown, setCookie?: string, text?: string): DoorFetch & { calls: Array<[string, RequestInit | undefined]> } {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const fetchLike = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push([url, init]);
    const headers: Record<string, string> = setCookie !== undefined ? { 'set-cookie': setCookie } : {};
    return new Response(text ?? JSON.stringify(body), { status, headers });
  };
  return Object.assign(fetchLike, { calls });
}

describe('door_normalise and doorWire_build', () => {
  it('ends the door in a slash and mounts the wire on the socket scheme', () => {
    expect(door_normalise('https://titan.tch.harvard.edu')).toBe('https://titan.tch.harvard.edu/');
    expect(door_normalise('http://127.0.0.1:4180/')).toBe('http://127.0.0.1:4180/');
    expect(doorWire_build('https://titan.tch.harvard.edu', '0123456789abcdef')).toBe('wss://titan.tch.harvard.edu/s/0123456789abcdef/');
    expect(doorWire_build('http://127.0.0.1:4180/', '0123456789abcdef')).toBe('ws://127.0.0.1:4180/s/0123456789abcdef/');
  });
});

describe('a door typed by hand', () => {
  it('reaches a door typed without a scheme over plain HTTP', () => {
    expect(door_normalise('localhost:4180')).toBe('http://localhost:4180/');
    expect(door_normalise('titan')).toBe('http://titan/');
    expect(door_normalise(' 127.0.0.1:4180 ')).toBe('http://127.0.0.1:4180/');
    expect(doorWire_build('localhost:4180', '0123456789abcdef')).toBe('ws://localhost:4180/s/0123456789abcdef/');
  });

  it('refuses a door that is not HTTP(S), by name', () => {
    expect(() => door_normalise('ftp://titan')).toThrow('not a door address: ftp://titan');
  });

  it('asks for an empty credential as for a missing one', () => {
    expect(doorCredential_missing(undefined)).toBe(true);
    expect(doorCredential_missing('')).toBe(true);
    expect(doorCredential_missing('  ')).toBe(true);
    expect(doorCredential_missing('chris')).toBe(false);
  });

  it('names why a door was not reached by the network\'s own code', () => {
    const refused: Error = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4180'), { code: 'ECONNREFUSED' }) });
    expect(doorUnreached_reason(refused)).toBe('ECONNREFUSED');
    expect(doorUnreached_reason(Object.assign(new TypeError('fetch failed'), { cause: new Error('unknown scheme') }))).toBe('unknown scheme');
    expect(doorUnreached_reason(new Error('boom'))).toBe('boom');
  });
});

describe('the origin a door is spoken to as', () => {
  it('is the door\'s scheme, host and port, however the door was typed', () => {
    expect(doorOrigin_derive('https://titan/')).toBe('https://titan');
    expect(doorOrigin_derive('titan:4180')).toBe('http://titan:4180');
    expect(doorOrigin_derive('https://porter.example.org:443/some/path/')).toBe('https://porter.example.org');
  });
});

describe('door_login', () => {
  it('posts the password once and keeps the cookie', async () => {
    const fetchLike = answer(200, { key: '0123456789abcdef', mount: '/s/0123456789abcdef/', state: 'starting' }, 'porter_session=abc.sig; Path=/; HttpOnly');
    const entered = await door_login('http://127.0.0.1:4180', 'chris', 'pw', fetchLike);
    expect(entered).toEqual({ key: '0123456789abcdef', state: 'starting', cookie: 'porter_session=abc.sig' });
    const [url, init] = fetchLike.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4180/login');
    expect(JSON.parse(String(init.body))).toEqual({ username: 'chris', password: 'pw' });
    expect((init.headers as Record<string, string>).accept).toBe('application/json');
    // A password says where it comes from, as a browser at this door would.
    expect((init.headers as Record<string, string>).origin).toBe('http://127.0.0.1:4180');
  });

  it('carries the door\'s refusal', async () => {
    expect(await door_login('http://d/', 'chris', 'wrong', answer(401, { error: 'CUBE refused the login' }))).toEqual({ refused: 'CUBE refused the login' });
    expect(await door_login('http://d/', 'chris', 'pw', answer(200, { key: 'x' }))).toEqual({ refused: 'the door answered without a session' });
  });
});

describe('bootEvents_read', () => {
  it('hands over each line and stops at the verdict', () => {
    const seen: string[] = [];
    const stream: string = 'event: line\ndata: {"channel":"out","text":"[ OK ] Connect"}\n\nevent: line\ndata: {"channel":"err","text":"warm"}\n\nevent: ready\ndata: {"reason":null}\n\n';
    expect(bootEvents_read(stream, (t: string): void => { seen.push(t); })).toEqual({ state: 'ready' });
    expect(seen).toEqual(['[ OK ] Connect', 'warm']);
    expect(bootEvents_read('event: failed\ndata: {"reason":"it died"}\n\n', (): void => undefined)).toEqual({ state: 'failed', reason: 'it died' });
    expect(bootEvents_read('', (): void => undefined).state).toBe('failed');
  });

  it('hands each line over as its bytes arrive, before the door closes the stream', async () => {
    // Two chunks: the first carries one whole line and half of the next; the
    // door closes the stream only after the test has seen the first line.
    const seen: string[] = [];
    let release: () => void = (): void => undefined;
    const firstSeen: Promise<void> = new Promise((resolve: () => void): void => { release = resolve; });
    const encoder: TextEncoder = new TextEncoder();
    const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
      async start(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
        controller.enqueue(encoder.encode('event: line\ndata: {"channel":"out","text":"[ OK ] Connect"}\n\nevent: line\ndata: {"chan'));
        await firstSeen;
        controller.enqueue(encoder.encode('nel":"out","text":"[ OK ] Jobs"}\n\nevent: ready\ndata: {}\n\n'));
        controller.close();
      },
    });
    const fetchLike: DoorFetch = async (): Promise<Response> => new Response(body, { status: 200 });
    const ended = await doorBoot_follow('http://d/', { key: '0123456789abcdef', state: 'starting', cookie: 'c' }, (t: string): void => { seen.push(t); if (seen.length === 1) release(); }, fetchLike);
    expect(ended).toEqual({ state: 'ready' });
    expect(seen).toEqual(['[ OK ] Connect', '[ OK ] Jobs']);
  });

  it('reads a boot answered without a streaming body the old way, whole', async () => {
    const fetchLike: DoorFetch = async (): Promise<Response> => new Response(null, { status: 200 });
    const ended = await doorBoot_follow('http://d/', { key: '0123456789abcdef', state: 'starting', cookie: 'c' }, (): void => undefined, fetchLike);
    expect(ended).toEqual({ state: 'failed', reason: 'the boot stream ended without a verdict' });
  });

  it('follows the boot with the cookie on the request', async () => {
    const fetchLike = answer(200, null, undefined, 'event: ready\ndata: {}\n\n');
    const ended = await doorBoot_follow('http://d/', { key: '0123456789abcdef', state: 'starting', cookie: 'porter_session=c' }, (): void => undefined, fetchLike);
    expect(ended).toEqual({ state: 'ready' });
    const [url, init] = fetchLike.calls[0] as [string, RequestInit];
    expect(url).toBe('http://d/boot/0123456789abcdef');
    expect((init.headers as Record<string, string>).cookie).toBe('porter_session=c');
  });
});

describe('door_enter', () => {
  it('attaches at once to a session already up, with the cookie as the credential', async () => {
    const fetchLike = answer(200, { key: '0123456789abcdef', mount: '/s/0123456789abcdef/', state: 'attached' }, 'porter_session=c.s; Path=/');
    const reach = await door_enter('https://titan/', 'chris', 'pw', fetchLike);
    expect(reach).toEqual({ identity: 'chris through the door at https://titan/', url: 'wss://titan/s/0123456789abcdef/', headers: { cookie: 'porter_session=c.s', origin: 'https://titan' } });
  });

  it('says in one line when the door cannot be reached, never a stack trace', async () => {
    const said: string[] = [];
    const errSpy = jest.spyOn(console, 'error').mockImplementation((line: string): void => { said.push(String(line)); });
    const down: DoorFetch = async (): Promise<Response> => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    };
    expect(await door_enter('localhost:4180', 'chris', 'pw', down)).toBeNull();
    expect(said[0]).toContain('The door at http://localhost:4180/ could not be reached: ECONNREFUSED');
    errSpy.mockRestore();
  });

  it('refuses a door that is not an HTTP(S) address before asking anything', async () => {
    const said: string[] = [];
    const errSpy = jest.spyOn(console, 'error').mockImplementation((line: string): void => { said.push(String(line)); });
    expect(await door_enter('ftp://titan', undefined, undefined, answer(200, {}))).toBeNull();
    expect(said[0]).toContain('not a door address: ftp://titan');
    errSpy.mockRestore();
  });

  it('says why when the door refuses', async () => {
    const said: string[] = [];
    const errSpy = jest.spyOn(console, 'error').mockImplementation((line: string): void => { said.push(String(line)); });
    expect(await door_enter('https://titan/', 'chris', 'wrong', answer(401, { error: 'CUBE refused the login' }))).toBeNull();
    expect(said[0]).toContain('CUBE refused the login');
    errSpy.mockRestore();
  });
});

describe('door tokens (chell auth)', () => {
  it('logs in by token and learns whose token it was', async () => {
    const fetchLike = answer(200, { key: '0123456789abcdef', mount: '/s/0123456789abcdef/', state: 'attached', user: 'chris', tokenName: 'laptop', expires: '2026-11-05T00:00:00.000Z' }, 'porter_session=c.s; Path=/');
    const entered = await door_loginByToken('https://titan/', 'pdt_abc', fetchLike);
    expect(entered).toMatchObject({ key: '0123456789abcdef', state: 'attached', cookie: 'porter_session=c.s', user: 'chris', tokenName: 'laptop' });
    const [, init] = fetchLike.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer pdt_abc');
    expect(init.body).toBeUndefined();
    expect(await door_loginByToken('https://titan/', 'pdt_old', answer(401, { error: 'the door token "old" expired on 2026-10-07; run chell auth login' }))).toEqual({ refused: 'the door token "old" expired on 2026-10-07; run chell auth login' });
  });

  it('a password login asking for a token hands the grant back, and says when an older porter gives none', async () => {
    const fetchLike = answer(200, { key: '0123456789abcdef', mount: '/s/0123456789abcdef/', state: 'starting', token: { token: 'pdt_new', name: 'chris@pangea', expires: '2026-11-05T00:00:00.000Z' } }, 'porter_session=c.s; Path=/');
    const minted = await door_loginForToken('https://titan/', 'chris', 'pw', 'chris@pangea', fetchLike);
    expect(minted).toEqual({ entry: { key: '0123456789abcdef', state: 'starting', cookie: 'porter_session=c.s' }, grant: { token: 'pdt_new', user: 'chris', name: 'chris@pangea', expires: '2026-11-05T00:00:00.000Z' } });
    const [, init] = fetchLike.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ username: 'chris', password: 'pw', tokenName: 'chris@pangea' });
    const older = await door_loginForToken('https://titan/', 'chris', 'pw', 'x', answer(200, { key: '0123456789abcdef', mount: '/s/0123456789abcdef/', state: 'attached' }, 'porter_session=c.s; Path=/'));
    expect(older).toMatchObject({ refused: expect.stringContaining('older porter') });
  });

  it('the device code: asks with the host, polls until authorised, and gives up when the code is gone', async () => {
    const begun = await doorDevice_begin('https://titan/', 'pangea', answer(200, { code: 'K7PD-3MXQ', expires: 'soon', url: '/login?code=K7PD-3MXQ' }));
    expect(begun).toEqual({ code: 'K7PD-3MXQ', expires: 'soon' });
    expect(await doorDevice_begin('https://titan/', 'pangea', answer(404, {}))).toMatchObject({ refused: expect.stringContaining('upgrade') });

    const answers: Array<[number, unknown]> = [[200, { state: 'pending' }], [200, { state: 'pending' }], [200, { state: 'authorised', token: 'pdt_x', user: 'chris', name: 'chris@pangea', expires: 'later' }]];
    let polls: number = 0;
    const polling: DoorFetch = async (): Promise<Response> => { const [status, body] = answers[polls++] as [number, unknown]; return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); };
    const waited = await doorDevice_wait('https://titan/', 'K7PD-3MXQ', { fetchLike: polling, intervalMs: 1, sleep: async (): Promise<void> => undefined });
    expect(waited).toEqual({ state: 'authorised', grant: { token: 'pdt_x', user: 'chris', name: 'chris@pangea', expires: 'later' } });
    expect(polls).toBe(3);
    expect(await doorDevice_wait('https://titan/', 'GONE-GONE', { fetchLike: answer(404, { state: 'unknown' }), intervalMs: 1, sleep: async (): Promise<void> => undefined })).toEqual({ state: 'expired' });
  });

  it('lists and revokes by the token in hand', async () => {
    const listed = await doorTokens_list('https://titan/', 'pdt_x', answer(200, { user: 'chris', tokens: [{ name: 'laptop', created: 'a', expires: 'b', lastUsed: null }] }));
    expect(listed).toEqual({ user: 'chris', tokens: [{ name: 'laptop', created: 'a', expires: 'b', lastUsed: null }] });
    const revoking = answer(200, { revoked: true, name: 'laptop' });
    expect(await doorToken_revoke('https://titan/', 'pdt_x', revoking)).toEqual({ revoked: true });
    const [url, init] = revoking.calls[0] as [string, RequestInit];
    expect(url).toBe('https://titan/auth/token');
    expect(init.method).toBe('DELETE');
  });
});

describe('door_enter with a door token', () => {
  it('goes in on CHELL_DOOR_TOKEN without asking, warns of a token near its death, and refuses plain http to another host', async () => {
    const errors: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((line?: unknown): void => { errors.push(String(line)); });
    const fetchLike = answer(200, { key: '0123456789abcdef', mount: '/s/0123456789abcdef/', state: 'attached', user: 'chris', tokenName: 'laptop', expires: '2026-11-05T00:00:00.000Z' }, 'porter_session=c.s; Path=/');
    const reach = await door_enter('https://titan/', undefined, undefined, fetchLike, { CHELL_DOOR_TOKEN: 'pdt_env', XDG_CONFIG_HOME: '/nonexistent-doors' });
    expect(reach).toEqual({ identity: 'chris through the door at https://titan/', url: 'wss://titan/s/0123456789abcdef/', headers: { cookie: 'porter_session=c.s', origin: 'https://titan' } });
    const [, init] = fetchLike.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer pdt_env');

    const refused = await door_enter('http://pangea.tch.harvard.edu:4180/', undefined, undefined, answer(200, {}), { CHELL_DOOR_TOKEN: 'pdt_env', XDG_CONFIG_HOME: '/nonexistent-doors' });
    expect(refused).toBeNull();
    expect(errors.join('\n')).toContain('plain http to another host');

    const dead = await door_enter('https://titan/', undefined, undefined, answer(401, { error: 'the door token "laptop" expired on 2026-10-07; run chell auth login' }), { CHELL_DOOR_TOKEN: 'pdt_env', XDG_CONFIG_HOME: '/nonexistent-doors' });
    expect(dead).toBeNull();
    expect(errors.join('\n')).toContain('The door refused the token: the door token "laptop" expired');
    spy.mockRestore();
  });

  it('a door kept with --insecure-door takes its token over plain http, warning each time; one without is refused', async () => {
    const errors: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((line?: unknown): void => { errors.push(String(line)); });
    const home: string = await mkdtemp(join(tmpdir(), 'chell-door-'));
    const env = { XDG_CONFIG_HOME: home };
    const PLAIN: string = 'http://pangea:4180/';
    doorFile_write({ door: PLAIN, user: 'chris', name: 'pangea', token: 'pdt_kept', minted: '2026-10-15T00:00:00.000Z', expires: '2099-01-01T00:00:00.000Z', insecure: true }, env);
    const fetchLike = answer(200, { key: '0123456789abcdef', mount: '/s/0123456789abcdef/', state: 'attached', user: 'chris', tokenName: 'pangea', expires: '2099-01-01T00:00:00.000Z' }, 'porter_session=c.s; Path=/');
    const reach = await door_enter(PLAIN, undefined, undefined, fetchLike, env);
    expect(reach).toMatchObject({ identity: 'chris through the door at http://pangea:4180/' });
    expect(errors.join('\n')).toContain('the token goes readable on the wire (--insecure-door, chosen at login)');
    doorFile_write({ door: PLAIN, user: 'chris', name: 'pangea', token: 'pdt_kept', minted: '2026-10-15T00:00:00.000Z', expires: '2099-01-01T00:00:00.000Z' }, env);
    expect(await door_enter(PLAIN, undefined, undefined, answer(200, {}), env)).toBeNull();
    expect(errors.join('\n')).toContain('--insecure-door --default knowingly');
    await rm(home, { recursive: true, force: true });
    spy.mockRestore();
  });

  it('the refusal names the default door and points at a door already logged into with --insecure-door', async () => {
    const home: string = await mkdtemp(join(tmpdir(), 'chell-door-'));
    const env = { XDG_CONFIG_HOME: home };
    const OLD: string = 'http://pangea:4180/';
    const NEW: string = 'http://pangea.tch.harvard.edu:4180/';
    doorFile_write({ door: OLD, user: 'chris', name: 'old', token: 'pdt_old', minted: 'a', expires: '2099-01-01T00:00:00.000Z' }, env);
    doorFile_write({ door: NEW, user: 'chris', name: 'new', token: 'pdt_new', minted: 'a', expires: '2099-01-01T00:00:00.000Z', insecure: true }, env);
    doorDefault_write(OLD, env);
    expect(doorRefusal_words(OLD, env)).toBe(`${OLD} (your default door) is plain http to another host: the door token is not sent there. You are logged in at ${NEW} with --insecure-door: use it with chell --remote --door ${NEW} -c '…', or make it the default with chell auth login --door ${NEW} --insecure-door --default.`);
    await rm(home, { recursive: true, force: true });
  });

  it('a password on the command line beats the token, as before', async () => {
    const fetchLike = answer(200, { key: '0123456789abcdef', mount: '/s/0123456789abcdef/', state: 'attached' }, 'porter_session=c.s; Path=/');
    const reach = await door_enter('https://titan/', 'chris', 'pw', fetchLike, { CHELL_DOOR_TOKEN: 'pdt_env' });
    expect(reach).toMatchObject({ identity: 'chris through the door at https://titan/' });
    const [, init] = fetchLike.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ username: 'chris', password: 'pw' });
  });
});

describe('door token edges', () => {
  it('refuses answers without a session, a list, or a verdict, and names the door\'s own refusals', async () => {
    expect(await door_loginByToken('https://titan/', 'pdt_x', answer(200, { key: 'k', state: 'attached' }))).toEqual({ refused: 'the door answered without a session' });
    expect(await door_loginForToken('https://titan/', 'chris', 'pw', 'n', answer(401, { error: 'CUBE refused the login' }))).toEqual({ refused: 'CUBE refused the login' });
    expect(await door_loginForToken('https://titan/', 'chris', 'pw', 'n', answer(200, { key: 'k' }))).toEqual({ refused: 'the door answered without a session' });
    expect(await doorDevice_begin('https://titan/', 'h', answer(500, { error: 'boom' }))).toEqual({ refused: 'boom' });
    expect(await doorDevice_begin('https://titan/', 'h', answer(200, { nope: true }))).toEqual({ refused: 'the door answered without a code' });
    expect(await doorDevice_wait('https://titan/', 'C', { fetchLike: answer(500, { error: 'down' }), intervalMs: 1, sleep: async (): Promise<void> => undefined })).toEqual({ state: 'refused', refused: 'down' });
    expect(await doorDevice_wait('https://titan/', 'C', { fetchLike: answer(200, { state: 'odd' }), intervalMs: 1, sleep: async (): Promise<void> => undefined })).toMatchObject({ state: 'refused' });
    expect(await doorDevice_wait('https://titan/', 'C', { fetchLike: answer(200, { state: 'pending' }), deadlineMs: 0, intervalMs: 1, sleep: async (): Promise<void> => undefined })).toEqual({ state: 'expired' });
    expect(await doorTokens_list('https://titan/', 'pdt_x', answer(401, { error: 'the door does not know that token' }))).toEqual({ refused: 'the door does not know that token' });
    expect(await doorTokens_list('https://titan/', 'pdt_x', answer(200, { user: 'chris' }))).toEqual({ refused: 'the door answered without a list' });
    expect(await doorToken_revoke('https://titan/', 'pdt_x', answer(401, { error: 'gone' }))).toEqual({ refused: 'gone', gone: true });
    expect(await doorToken_revoke('https://titan/', 'pdt_x', answer(503, 'nope'))).toEqual({ refused: 'the door answered 503', gone: false });
  });

  it('on a token, a session that boots is followed to ready, and a boot that fails is said', async () => {
    const outs: string[] = [];
    const quiet = jest.spyOn(console, 'log').mockImplementation((line?: unknown): void => { outs.push(String(line)); });
    const errors: string[] = [];
    const errs = jest.spyOn(console, 'error').mockImplementation((line?: unknown): void => { errors.push(String(line)); });
    const starting = { key: '0123456789abcdef', mount: '/s/0123456789abcdef/', state: 'starting', user: 'chris', tokenName: 'laptop', expires: '2026-11-05T00:00:00.000Z' };
    const okBoot: DoorFetch = async (url: string): Promise<Response> => url.endsWith('/login')
      ? new Response(JSON.stringify(starting), { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'porter_session=c.s; Path=/' } })
      : new Response('event: line\ndata: {"text":"[ OK ] Engine"}\n\nevent: ready\ndata: {}\n\n', { status: 200 });
    expect(await door_enter('https://titan/', undefined, undefined, okBoot, { CHELL_DOOR_TOKEN: 'pdt_env', XDG_CONFIG_HOME: '/nonexistent-doors' })).toMatchObject({ url: 'wss://titan/s/0123456789abcdef/' });
    // The boot is progress, never the answer: nothing of it on stdout, so a
    // script reading `chell -c` output gets the command's alone.
    expect(outs).toEqual([]);
    expect(errors.join('\n')).toContain('Starting your session at https://titan/');
    expect(errors.join('\n')).toContain('[ OK ] Engine');
    const badBoot: DoorFetch = async (url: string): Promise<Response> => url.endsWith('/login')
      ? new Response(JSON.stringify(starting), { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'porter_session=c.s; Path=/' } })
      : new Response('event: failed\ndata: {"reason":"no saved login"}\n\n', { status: 200 });
    expect(await door_enter('https://titan/', undefined, undefined, badBoot, { CHELL_DOOR_TOKEN: 'pdt_env', XDG_CONFIG_HOME: '/nonexistent-doors' })).toBeNull();
    expect(errors.join('\n')).toContain('The session did not start: no saved login');
    const unreachable: DoorFetch = async (): Promise<Response> => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
    expect(await door_enter('https://titan/', undefined, undefined, unreachable, { CHELL_DOOR_TOKEN: 'pdt_env', XDG_CONFIG_HOME: '/nonexistent-doors' })).toBeNull();
    expect(errors.join('\n')).toContain('ECONNREFUSED');
    quiet.mockRestore(); errs.mockRestore();
  });

  it('a loose door file is a refusal, not a prompt', async () => {
    const { mkdtemp, writeFile, mkdir, chmod, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home: string = await mkdtemp(join(tmpdir(), 'chell-door-enter-'));
    await mkdir(join(home, 'chell', 'doors'), { recursive: true });
    await writeFile(join(home, 'chell', 'doors', 'titan.json'), JSON.stringify({ door: 'https://titan/', user: 'chris', name: 'n', token: 'pdt_x', minted: 'a', expires: 'b' }));
    await chmod(join(home, 'chell', 'doors', 'titan.json'), 0o644);
    const errors: string[] = [];
    const errs = jest.spyOn(console, 'error').mockImplementation((line?: unknown): void => { errors.push(String(line)); });
    expect(await door_enter('https://titan/', undefined, undefined, answer(200, {}), { XDG_CONFIG_HOME: home })).toBeNull();
    expect(errors.join('\n')).toContain('readable by others');
    errs.mockRestore();
    await rm(home, { recursive: true, force: true });
  });
});
