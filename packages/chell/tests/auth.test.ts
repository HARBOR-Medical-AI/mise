/**
 * @file `chell auth`: the verbs against a scripted door and a scripted terminal.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auth_run, authArgs_parse, authWorld_real, type AuthWorld } from '../src/remote/auth.js';
import { doorFile_read, doorFile_write, doorFile_path, doorDefault_read, doorDefault_write } from '../src/remote/doorFile.js';
import type { DoorFetch } from '../src/remote/door.js';

let home: string;
let said: string[];
let warned: string[];
let asked: string[];

/** One scripted answer per request, in order; the door's URL and method are kept for the test to read. */
function door_script(answers: Array<{ status: number; body: unknown; cookie?: string }>): DoorFetch & { calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchLike = (async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const next = answers.shift();
    if (next === undefined) throw new Error(`the door was asked more than scripted: ${url}`);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (next.cookie !== undefined) headers['set-cookie'] = next.cookie;
    return new Response(JSON.stringify(next.body), { status: next.status, headers });
  }) as DoorFetch & { calls: Array<{ url: string; init: RequestInit | undefined }> };
  fetchLike.calls = calls;
  return fetchLike;
}

function world_make(fetchLike: DoorFetch, options: { isTTY?: boolean; answers?: string[]; stdin?: string; now?: number } = {}): AuthWorld {
  const answers: string[] = [...(options.answers ?? [])];
  return {
    fetchLike,
    env: { XDG_CONFIG_HOME: home },
    isTTY: options.isTTY ?? false,
    ask: async (label: string): Promise<string> => { asked.push(label); return answers.shift() ?? ''; },
    stdinLine: async (): Promise<string> => options.stdin ?? '',
    say: (line: string): void => { said.push(line); },
    warn: (line: string): void => { warned.push(line); },
    hostname: (): string => 'pangea',
    now: (): number => options.now ?? Date.parse('2026-10-06T12:00:00Z'),
    deviceWaitMs: 50,
  };
}

const DOOR: string = 'https://titan.tch.harvard.edu/';
const ENTRY = { key: '0123456789abcdef', mount: '/s/0123456789abcdef/', state: 'attached' };
const COOKIE: string = 'porter_session=c.s; Path=/; HttpOnly';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'chell-auth-'));
  said = []; warned = []; asked = [];
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('authArgs_parse', () => {
  it('reads each verb and its words, and refuses by name', () => {
    expect(authArgs_parse(['login'])).toEqual({ verb: 'login' });
    expect(authArgs_parse(['login', '--door', 'https://t/', '--with-token', '--default', '--insecure-door'])).toEqual({ verb: 'login', door: 'https://t/', withToken: true, makeDefault: true, insecureDoor: true });
    expect(authArgs_parse(['logout', '--door'])).toMatchObject({ refusal: expect.stringContaining('--door wants a value') });
    expect(authArgs_parse(['tokens', '--bogus'])).toMatchObject({ refusal: expect.stringContaining("unknown word '--bogus'") });
    expect(authArgs_parse([])).toMatchObject({ refusal: expect.stringContaining('chell auth login') });
  });
});

describe('chell auth login', () => {
  it('with --insecure-door to a plain http host: the choice is kept with the door, and only then', async () => {
    const PLAIN: string = 'http://pangea:4180/';
    const answered = { status: 200, body: { ...ENTRY, user: 'chris', tokenName: 'pangea', expires: '2026-11-05T00:00:00.000Z' }, cookie: COOKIE };
    expect(await auth_run({ verb: 'login', door: PLAIN, withToken: true, insecureDoor: true }, world_make(door_script([answered]), { stdin: 'pdt_plain' }))).toBe(0);
    expect(doorFile_read(PLAIN, { XDG_CONFIG_HOME: home })).toMatchObject({ door: PLAIN, insecure: true });
    // A door that carries tokens never records the choice, even when it was said.
    expect(await auth_run({ verb: 'login', door: DOOR, withToken: true, insecureDoor: true }, world_make(door_script([answered]), { stdin: 'pdt_tls' }))).toBe(0);
    expect((doorFile_read(DOOR, { XDG_CONFIG_HOME: home }) as { insecure?: boolean }).insecure).toBeUndefined();
    // The second login left the first door the default, and says so.
    expect(said.join('\n')).toContain(`your default door stays ${PLAIN}: chell and chell -c still go there. Add --default to this login to switch`);
  });

  it('with a pasted token off a TTY: the door says whose it is, the file is written 0600, the door becomes the default', async () => {
    const door = door_script([{ status: 200, body: { ...ENTRY, user: 'chris', tokenName: 'laptop', expires: '2026-11-05T00:00:00.000Z' }, cookie: COOKIE }]);
    const code: number = await auth_run({ verb: 'login', door: DOOR, withToken: true }, world_make(door, { stdin: 'pdt_pasted' }));
    expect(code).toBe(0);
    expect((door.calls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer pdt_pasted');
    expect(doorFile_read(DOOR, { XDG_CONFIG_HOME: home })).toMatchObject({ door: DOOR, user: 'chris', name: 'laptop', token: 'pdt_pasted' });
    expect(doorDefault_read({ XDG_CONFIG_HOME: home })).toBe(DOOR);
    expect(said.join('\n')).toContain('Logged in at https://titan.tch.harvard.edu/ as chris; token "laptop" dies 2026-11-05 (29 days)');
    expect(said.join('\n')).toContain('this door is now the default');
  });

  it('with a password on a TTY: asks the user and the password, names the token after this host, keeps a default already set', async () => {
    doorDefault_write('https://other/', { XDG_CONFIG_HOME: home });
    const door = door_script([{ status: 200, body: { ...ENTRY, state: 'starting', token: { token: 'pdt_minted', name: 'chris@pangea', expires: '2026-11-05T00:00:00.000Z' } }, cookie: COOKIE }]);
    const code: number = await auth_run({ verb: 'login', door: DOOR, withPassword: true }, world_make(door, { isTTY: true, answers: ['chris', 'pw'] }));
    expect(code).toBe(0);
    expect(asked).toEqual([`Username at ${DOOR}: `, `Password for chris at ${DOOR}: `]);
    expect(JSON.parse(String(door.calls[0]?.init?.body))).toEqual({ username: 'chris', password: 'pw', tokenName: 'chris@pangea' });
    // A password says where it comes from, as a browser at this door would.
    expect((door.calls[0]?.init?.headers as Record<string, string>).origin).toBe(new URL(DOOR).origin);
    expect(doorFile_read(DOOR, { XDG_CONFIG_HOME: home })).toMatchObject({ user: 'chris', name: 'chris@pangea', token: 'pdt_minted' });
    expect(doorDefault_read({ XDG_CONFIG_HOME: home })).toBe('https://other/');
  });

  it('with a browser on a TTY (the default pick): shows the code and the page, polls until authorised', async () => {
    const door = door_script([
      { status: 200, body: { code: 'K7PD-3MXQ', expires: 'soon', url: '/login?code=K7PD-3MXQ' } },
      { status: 200, body: { state: 'pending' } },
      { status: 200, body: { state: 'authorised', token: 'pdt_browser', user: 'chris', name: 'chris@pangea', expires: '2026-11-05T00:00:00.000Z' } },
    ]);
    const code: number = await auth_run({ verb: 'login', door: DOOR }, world_make(door, { isTTY: true, answers: [''] }));
    expect(code).toBe(0);
    expect(said.join('\n')).toContain('How would you like to log in?');
    expect(said.join('\n')).toContain('First copy your one-time code: K7PD-3MXQ');
    expect(said.join('\n')).toContain(`${DOOR}device`);
    expect(JSON.parse(String(door.calls[0]?.init?.body))).toEqual({ host: 'pangea' });
    expect(doorFile_read(DOOR, { XDG_CONFIG_HOME: home })).toMatchObject({ token: 'pdt_browser', name: 'chris@pangea' });
  });

  it('refuses plainly off a TTY with nothing to go on, over plain http to another host, and when the door refuses the token', async () => {
    expect(await auth_run({ verb: 'login', door: DOOR }, world_make(door_script([])))).toBe(1);
    expect(warned.join('\n')).toContain('No terminal to ask on');
    warned = [];
    expect(await auth_run({ verb: 'login', door: 'http://pangea.tch.harvard.edu:4180/', withToken: true }, world_make(door_script([]), { stdin: 'pdt_x' }))).toBe(1);
    expect(warned.join('\n')).toContain('plain http to another host');
    warned = [];
    expect(await auth_run({ verb: 'login', door: 'http://127.0.0.1:4190/', withToken: true }, world_make(door_script([{ status: 401, body: { error: 'the door does not know that token' } }]), { stdin: 'pdt_x' }))).toBe(1);
    expect(warned.join('\n')).toContain('The door refused the token: the door does not know that token');
    warned = [];
    expect(await auth_run({ verb: 'login' }, world_make(door_script([])))).toBe(1);
    expect(warned.join('\n')).toContain('No door');
  });

  it('asks for the door on a TTY when none is known, and refuses one that is not a door', async () => {
    const door = door_script([{ status: 200, body: { ...ENTRY, user: 'chris', tokenName: 'laptop', expires: '2026-11-05T00:00:00.000Z' }, cookie: COOKIE }]);
    expect(await auth_run({ verb: 'login', withToken: true }, world_make(door, { isTTY: true, answers: ['titan.tch.harvard.edu', 'pdt_typed'] }))).toBe(1);
    // typed without a scheme: plain http to another host, refused by the transport rule
    expect(warned.join('\n')).toContain('plain http');
    warned = [];
    expect(await auth_run({ verb: 'status' }, world_make(door_script([]), { isTTY: true, answers: ['ftp://nope'] }))).toBe(1);
    expect(warned.join('\n')).toContain('not a door address');
  });
});

describe('chell auth status, logout, token, tokens', () => {
  const file = { door: DOOR, user: 'chris', name: 'chris@pangea', token: 'pdt_x', minted: '2026-10-06T00:00:00.000Z', expires: '2026-11-05T00:00:00.000Z' };

  it('status says who, where, and how long; names a dead token; reads the environment; refuses a loose file', async () => {
    expect(await auth_run({ verb: 'status', door: DOOR }, world_make(door_script([])))).toBe(1);
    expect(said.join('\n')).toContain('Not logged in');
    said = [];
    doorFile_write(file, { XDG_CONFIG_HOME: home });
    doorDefault_write(DOOR, { XDG_CONFIG_HOME: home });
    expect(await auth_run({ verb: 'status' }, world_make(door_script([])))).toBe(0);
    expect(said.join('\n')).toContain('Logged in at https://titan.tch.harvard.edu/ as chris (the default door); token "chris@pangea" dies 2026-11-05 (29 days)');
    said = [];
    expect(await auth_run({ verb: 'status' }, world_make(door_script([]), { now: Date.parse('2026-12-01T00:00:00Z') }))).toBe(1);
    expect(said.join('\n')).toContain('died 2026-11-05');
    said = [];
    const world = world_make(door_script([]));
    world.env = { XDG_CONFIG_HOME: home, CHELL_DOOR_TOKEN: 'pdt_env', CHELL_DOOR_USER: 'kim' };
    expect(await auth_run({ verb: 'status' }, world)).toBe(0);
    expect(said.join('\n')).toContain('by CHELL_DOOR_TOKEN as kim');
    await chmod(doorFile_path(DOOR, { XDG_CONFIG_HOME: home }), 0o644);
    expect(await auth_run({ verb: 'status' }, world_make(door_script([])))).toBe(1);
    expect(warned.join('\n')).toContain('readable by others');
  });

  it('logout revokes at the door and removes the file and the default; a loose file goes without asking the door', async () => {
    doorFile_write(file, { XDG_CONFIG_HOME: home });
    doorDefault_write(DOOR, { XDG_CONFIG_HOME: home });
    const door = door_script([{ status: 200, body: { revoked: true, name: 'chris@pangea' } }]);
    expect(await auth_run({ verb: 'logout' }, world_make(door))).toBe(0);
    expect(door.calls[0]?.init?.method).toBe('DELETE');
    expect(doorFile_read(DOOR, { XDG_CONFIG_HOME: home })).toBeNull();
    expect(doorDefault_read({ XDG_CONFIG_HOME: home })).toBeNull();
    expect(said.join('\n')).toContain('Revoked token "chris@pangea"');
    said = [];
    expect(await auth_run({ verb: 'logout', door: DOOR }, world_make(door_script([])))).toBe(0);
    expect(said.join('\n')).toContain('nothing to do');
    doorFile_write(file, { XDG_CONFIG_HOME: home });
    await chmod(doorFile_path(DOOR, { XDG_CONFIG_HOME: home }), 0o644);
    expect(await auth_run({ verb: 'logout', door: DOOR }, world_make(door_script([])))).toBe(0);
    expect(doorFile_read(DOOR, { XDG_CONFIG_HOME: home })).toBeNull();
  });

  it('logout still removes the file when the door cannot revoke, and says the token dies on its own', async () => {
    doorFile_write(file, { XDG_CONFIG_HOME: home });
    expect(await auth_run({ verb: 'logout', door: DOOR }, world_make(door_script([{ status: 404, body: { error: 'no such route' } }])))).toBe(0);
    expect(warned.join('\n')).toContain('dies 2026-11-05 on its own');
    expect(warned.join('\n')).not.toContain('porter --revoke chris');
    expect(doorFile_read(DOOR, { XDG_CONFIG_HOME: home })).toBeNull();
  });

  it('logout of a token the door no longer knows says it is already gone, quietly, and offers no revoke by name', async () => {
    doorFile_write(file, { XDG_CONFIG_HOME: home });
    expect(await auth_run({ verb: 'logout', door: DOOR }, world_make(door_script([{ status: 401, body: { error: 'the door does not know that token' } }])))).toBe(0);
    expect(warned).toEqual([]);
    expect(said.join('\n')).toContain('the door no longer knows this token');
    expect(said.join('\n')).toContain('nothing to revoke');
    expect(doorFile_read(DOOR, { XDG_CONFIG_HOME: home })).toBeNull();
  });

  it('token mints one to carry, shown once, named as asked', async () => {
    const door = door_script([{ status: 200, body: { ...ENTRY, token: { token: 'pdt_carry', name: 'cron on titan', expires: '2026-11-05T00:00:00.000Z' } }, cookie: COOKIE }]);
    expect(await auth_run({ verb: 'token', door: DOOR, name: 'cron on titan', user: 'chris', password: 'pw' }, world_make(door))).toBe(0);
    expect(said).toContain('pdt_carry');
    expect(said.join('\n')).toContain('Minted token "cron on titan" for chris');
    expect(doorFile_read(DOOR, { XDG_CONFIG_HOME: home })).toBeNull(); // carried, not kept here
  });

  it('tokens lists this identity\'s by the token in hand, marking this machine\'s', async () => {
    doorFile_write(file, { XDG_CONFIG_HOME: home });
    const door = door_script([{ status: 200, body: { user: 'chris', tokens: [{ name: 'chris@pangea', created: '2026-10-06T00:00:00Z', expires: '2026-11-05T00:00:00Z', lastUsed: null }, { name: 'cron on titan', created: '2026-10-01T00:00:00Z', expires: '2026-10-31T00:00:00Z', lastUsed: '2026-10-05T03:15:00Z' }] } }]);
    expect(await auth_run({ verb: 'tokens', door: DOOR }, world_make(door))).toBe(0);
    const out: string = said.join('\n');
    expect(out).toContain('Door tokens for chris at https://titan.tch.harvard.edu/');
    expect(out).toContain('chris@pangea');
    expect(out).toContain('← this machine');
    expect(out).toContain('last used 2026-10-05');
    said = [];
    expect(await auth_run({ verb: 'tokens', door: 'https://nowhere/' }, world_make(door_script([])))).toBe(1);
    expect(warned.join('\n')).toContain('Not logged in');
  });
});

describe('chell auth edges', () => {
  it('off a TTY a password login needs -u and -p; a browser login that the door refuses or lets expire is said; an odd pick is refused', async () => {
    expect(await auth_run({ verb: 'login', door: DOOR, withPassword: true, user: 'chris' }, world_make(door_script([])))).toBe(1);
    expect(warned.join('\n')).toContain('A password is required');
    warned = [];
    expect(await auth_run({ verb: 'login', door: DOOR, withPassword: true }, world_make(door_script([])))).toBe(1);
    expect(warned.join('\n')).toContain('A username is required');
    warned = [];
    expect(await auth_run({ verb: 'login', door: DOOR }, world_make(door_script([{ status: 404, body: {} }]), { isTTY: true, answers: ['1'] }))).toBe(1);
    expect(warned.join('\n')).toContain('would not give a code');
    warned = [];
    expect(await auth_run({ verb: 'login', door: DOOR }, world_make(door_script([{ status: 200, body: { code: 'AAAA-BBBB', expires: 'x' } }, { status: 404, body: { state: 'unknown' } }]), { isTTY: true, answers: ['1'] }))).toBe(1);
    expect(warned.join('\n')).toContain('not entered in time');
    warned = [];
    expect(await auth_run({ verb: 'login', door: DOOR }, world_make(door_script([]), { isTTY: true, answers: ['9'] }))).toBe(1);
    expect(warned.join('\n')).toContain("'9' is not a choice");
    warned = [];
    expect(await auth_run({ verb: 'login', door: DOOR, withPassword: true, user: 'chris', password: 'wrong' }, world_make(door_script([{ status: 401, body: { error: 'CUBE refused the login' } }])))).toBe(1);
    expect(warned.join('\n')).toContain('The door refused: CUBE refused the login');
    warned = [];
    const unreachable: DoorFetch = async (): Promise<Response> => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
    expect(await auth_run({ verb: 'login', door: DOOR, withToken: true }, world_make(unreachable, { stdin: 'pdt_x' }))).toBe(1);
    expect(warned.join('\n')).toContain('could not be reached: ECONNREFUSED');
    warned = [];
    expect(await auth_run({ verb: 'login', door: DOOR, withToken: true }, world_make(door_script([]), { stdin: '' }))).toBe(1);
    expect(warned.join('\n')).toContain('No token given');
  });

  it('a password typed on a TTY for the token verb, with the browser as the TTY default; the pick of 2 and 3 on login', async () => {
    const door = door_script([{ status: 200, body: { ...ENTRY, token: { token: 'pdt_t', name: 'for x', expires: '2026-11-05T00:00:00.000Z' } }, cookie: COOKIE }]);
    expect(await auth_run({ verb: 'token', door: DOOR, name: 'for x', withPassword: true }, world_make(door, { isTTY: true, answers: ['chris', 'pw'] }))).toBe(0);
    expect(said).toContain('pdt_t');
    said = [];
    const byPick = door_script([{ status: 200, body: { ...ENTRY, token: { token: 'pdt_2', name: 'chris@pangea', expires: '2026-11-05T00:00:00.000Z' } }, cookie: COOKIE }]);
    expect(await auth_run({ verb: 'login', door: DOOR }, world_make(byPick, { isTTY: true, answers: ['2', 'chris', 'pw'] }))).toBe(0);
    const byPaste = door_script([{ status: 200, body: { ...ENTRY, user: 'chris', tokenName: 'laptop', expires: '2026-11-05T00:00:00.000Z' }, cookie: COOKIE }]);
    expect(await auth_run({ verb: 'login', door: DOOR, makeDefault: true }, world_make(byPaste, { isTTY: true, answers: ['3', 'pdt_pasted'] }))).toBe(0);
    expect(asked.some((label) => label === 'Token: ')).toBe(true);
    const browserToken = door_script([
      { status: 200, body: { code: 'K7PD-3MXQ', expires: 'soon' } },
      { status: 200, body: { state: 'authorised', token: 'pdt_b', user: 'chris', name: 'chris@pangea', expires: '2026-11-05T00:00:00.000Z' } },
    ]);
    said = [];
    expect(await auth_run({ verb: 'token', door: DOOR, name: 'carry' }, world_make(browserToken, { isTTY: true }))).toBe(0);
    expect(said).toContain('pdt_b');
  });

  it('tokens by the environment token, and the door unreachable or refusing', async () => {
    const world = world_make(door_script([{ status: 200, body: { user: 'kim', tokens: [] } }]));
    world.env = { XDG_CONFIG_HOME: home, CHELL_DOOR_TOKEN: 'pdt_env' };
    expect(await auth_run({ verb: 'tokens', door: DOOR }, world)).toBe(0);
    expect(said.join('\n')).toContain('No door tokens for kim');
    const refusing = world_make(door_script([{ status: 401, body: { error: 'the door does not know that token' } }]));
    refusing.env = { XDG_CONFIG_HOME: home, CHELL_DOOR_TOKEN: 'pdt_env' };
    expect(await auth_run({ verb: 'tokens', door: DOOR }, refusing)).toBe(1);
    const down = world_make(async (): Promise<Response> => { throw new Error('fetch failed'); });
    down.env = { XDG_CONFIG_HOME: home, CHELL_DOOR_TOKEN: 'pdt_env' };
    expect(await auth_run({ verb: 'tokens', door: DOOR }, down)).toBe(1);
    expect(warned.join('\n')).toContain('could not be reached');
    doorFile_write({ door: DOOR, user: 'chris', name: 'n', token: 'pdt_x', minted: 'a', expires: '2026-11-05T00:00:00.000Z' }, { XDG_CONFIG_HOME: home });
    await chmod(doorFile_path(DOOR, { XDG_CONFIG_HOME: home }), 0o644);
    warned = [];
    expect(await auth_run({ verb: 'tokens', door: DOOR }, world_make(door_script([])))).toBe(1);
    expect(warned.join('\n')).toContain('readable by others');
  });
});

describe('the real world', () => {
  it('is built from the process: a TTY flag, this host\'s short name, ten minutes for a browser code', () => {
    const world: AuthWorld = authWorld_real();
    expect(typeof world.isTTY).toBe('boolean');
    expect(world.hostname()).not.toContain('.');
    expect(world.hostname().length).toBeGreaterThan(0);
    expect(world.deviceWaitMs).toBe(10 * 60 * 1000);
    expect(world.now()).toBeGreaterThan(Date.parse('2026-01-01T00:00:00Z'));
    const said: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((line?: unknown): void => { said.push(String(line)); });
    const err = jest.spyOn(console, 'error').mockImplementation((line?: unknown): void => { said.push(String(line)); });
    world.say('a'); world.warn('b');
    expect(said).toEqual(['a', 'b']);
    log.mockRestore(); err.mockRestore();
  });
});

describe('the host\'s door', () => {
  it('chell auth login with no --door goes to the host\'s CHELL_DOOR, and makes it the user\'s own default', async () => {
    const door = door_script([{ status: 200, body: { ...ENTRY, user: 'chris', tokenName: 'laptop', expires: '2026-11-05T00:00:00.000Z' }, cookie: COOKIE }]);
    const world = world_make(door, { stdin: 'pdt_pasted' });
    world.env = { XDG_CONFIG_HOME: home, CHELL_DOOR: DOOR };
    expect(await auth_run({ verb: 'login', withToken: true }, world)).toBe(0);
    expect(door.calls[0]?.url).toBe(`${DOOR}login`);
    expect(doorDefault_read({ XDG_CONFIG_HOME: home })).toBe(DOOR);
  });
});
