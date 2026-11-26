/**
 * @file A terminal comes through the door.
 *
 * The porter — the door a browser logs in at — mounts a session at
 * `/s/<key>/` and lets a cookie name it. A terminal can come the same way:
 * it posts the operator's password to the door once, keeps the cookie the
 * door hands back, follows the session's boot rows if it has to boot, and
 * attaches to the session's wire with the cookie on the upgrade. No attach
 * token ever reaches the terminal; the door holds it, exactly as it does
 * for a browser. Same login, same session, same idle rules, from a shell.
 *
 * @module
 */
import * as readline from 'node:readline';
import { Writable } from 'node:stream';
import chalk from 'chalk';
import { doorCredential_resolve, door_carriesTokens, days_until, doorDefault_read, doorsKept_read } from './doorFile.js';

/** What the door said to a login. */
export interface DoorEntry {
  /** The session's key: its mount is `/s/<key>/`. */
  key: string;
  /** `attached` to a session already up, or `starting` one that boots now. */
  state: 'attached' | 'starting';
  /** The `Cookie` header value that names this browser's — this terminal's — session. */
  cookie: string;
}

/** The shape of `fetch` this module needs, so a test can stand one in. */
export type DoorFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The door's origin with one trailing slash, however it was typed.
 *
 * A door typed without a scheme — `localhost:4180`, `titan` — is reached
 * over plain HTTP, the way porter listens on loopback; a URL parser would
 * otherwise read `localhost:4180` as the scheme `localhost:` and the fetch
 * would die on it. A door is HTTP or HTTPS and nothing else.
 *
 * @param door - The door's URL as given: `https://titan/`, `http://titan:4180`, `localhost:4180`.
 * @returns The URL ending in `/`.
 * @throws Error naming the door when it is not an HTTP(S) address.
 */
/**
 * The origin of a door, as a browser standing at it would send: its scheme,
 * host and port, nothing after.
 *
 * @param door - The door, as typed or as normalised.
 * @returns The origin.
 * @throws {Error} When the door is no address.
 */
export function doorOrigin_derive(door: string): string {
  return new URL(door_normalise(door)).origin;
}

export function door_normalise(door: string): string {
  const typed: string = door.trim();
  const withScheme: string = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `http://${typed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`not a door address: ${door}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`not a door address: ${door} (a door is http:// or https://)`);
  }
  return parsed.pathname.endsWith('/') ? parsed.href : `${parsed.href}/`;
}

/**
 * Whether a credential still has to be asked for. An empty one has: the
 * login config hands over an empty user when none was given, and asking
 * the password of nobody reads as `Password for  at …`.
 *
 * @param value - The credential as given, if at all.
 * @returns True when it is missing or empty.
 */
export function doorCredential_missing(value: string | undefined): value is undefined {
  return value === undefined || value.trim() === '';
}

/**
 * Why a request to the door did not get an answer, in one line: the
 * network's own code (`ECONNREFUSED`, `ENOTFOUND`) when it gave one.
 *
 * @param error - What the fetch threw.
 * @returns The reason.
 */
export function doorUnreached_reason(error: unknown): string {
  const cause: unknown = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const code: unknown = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  if (typeof code === 'string') return code;
  if (cause instanceof Error && cause.message !== '') return cause.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * The session's wire, from the door and the key: the mount on the socket
 * scheme the door's scheme implies.
 *
 * @param door - The door's URL.
 * @param key - The session's key.
 * @returns `wss://host/s/<key>/`, or `ws://` for a door reached over plain HTTP.
 */
export function doorWire_build(door: string, key: string): string {
  const base: URL = new URL(`s/${key}/`, door_normalise(door));
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return base.href;
}

/**
 * Logs in at the door with a password and keeps the cookie.
 *
 * @param door - The door's URL.
 * @param username - The CUBE username.
 * @param password - The password; sent once, kept nowhere.
 * @param fetchLike - The HTTP client; the global `fetch` by default.
 * @returns The entry, or the door's refusal.
 */
export async function door_login(door: string, username: string, password: string, fetchLike: DoorFetch = fetch): Promise<DoorEntry | { refused: string }> {
  const response = await fetchLike(`${door_normalise(door)}login`, {
    method: 'POST',
    // A login by password says where it comes from, as a browser at this door would: the door takes a
    // password, and anything on its cookie, only from itself.
    headers: { 'content-type': 'application/json', accept: 'application/json', origin: doorOrigin_derive(door) },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    let reason: string = `the door answered ${response.status}`;
    try {
      const body: unknown = await response.json();
      if (typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string') reason = (body as { error: string }).error;
    } catch {
      // The status is the reason, then.
    }
    return { refused: reason };
  }
  const body = (await response.json()) as { key?: unknown; state?: unknown };
  const setCookies: string[] = response.headers.getSetCookie();
  const doorCookie: string | undefined = setCookies.map((line: string): string => line.split(';')[0] ?? '').find((pair: string): boolean => pair.startsWith('porter_session='));
  if (typeof body.key !== 'string' || (body.state !== 'attached' && body.state !== 'starting') || doorCookie === undefined) {
    return { refused: 'the door answered without a session' };
  }
  return { key: body.key, state: body.state, cookie: doorCookie };
}

/**
 * Follows a session's boot from the door, line by line, until it ends.
 *
 * @param door - The door's URL.
 * @param entry - The entry the login gave.
 * @param onLine - Told each boot line, ANSI and all.
 * @param fetchLike - The HTTP client.
 * @returns `ready`, or `failed` with the reason.
 */
export async function doorBoot_follow(
  door: string,
  entry: DoorEntry,
  onLine: (text: string) => void,
  fetchLike: DoorFetch = fetch,
): Promise<{ state: 'ready' } | { state: 'failed'; reason: string }> {
  const response = await fetchLike(`${door_normalise(door)}boot/${entry.key}`, { headers: { cookie: entry.cookie, accept: 'text/event-stream' } });
  if (!response.ok) return { state: 'failed', reason: `the door would not show the boot (${response.status})` };
  // The boot as it happens: each event is handed over as its bytes arrive.
  // Reading the body whole waited for the door to close the stream, so a
  // minute of boot rows landed in one lump after the prompt (titan, 2026-10-06).
  const body: ReadableStream<Uint8Array> | null = response.body;
  if (body === null || typeof body.getReader !== 'function') return bootEvents_read(await response.text(), onLine);
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const decoder: TextDecoder = new TextDecoder();
  let rest: string = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const fed: BootEventsFed = bootEvents_feed(rest + decoder.decode(value, { stream: true }), onLine);
    if (fed.verdict !== null) {
      void reader.cancel().catch((): void => undefined);
      return fed.verdict;
    }
    rest = fed.rest;
  }
  const last: BootEventsFed = bootEvents_feed(`${rest}${decoder.decode()}\n\n`, onLine);
  return last.verdict ?? { state: 'failed', reason: 'the boot stream ended without a verdict' };
}

/** What feeding a piece of the boot stream to the reader yielded. */
interface BootEventsFed {
  /** The verdict, once an end event was read. */
  verdict: { state: 'ready' } | { state: 'failed'; reason: string } | null;
  /** The tail not yet ending in a blank line: an event still arriving. */
  rest: string;
}

/**
 * Reads the complete events in a piece of the boot's server-sent stream,
 * handing each `line` over, and keeps the incomplete tail for the next piece.
 *
 * @param text - Bytes decoded so far, from the start of an event.
 * @param onLine - Told each `line` event's text.
 * @returns The verdict when an end event was among them, and the tail.
 */
export function bootEvents_feed(text: string, onLine: (text: string) => void): BootEventsFed {
  const cut: number = text.lastIndexOf('\n\n');
  if (cut < 0) return { verdict: null, rest: text };
  const complete: string = text.slice(0, cut);
  const rest: string = text.slice(cut + 2);
  for (const block of complete.split('\n\n')) {
    let event: string = 'message';
    let data: string = '';
    for (const row of block.split('\n')) {
      if (row.startsWith('event: ')) event = row.slice(7);
      else if (row.startsWith('data: ')) data += row.slice(6);
    }
    if (data.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (event === 'line' && typeof parsed === 'object' && parsed !== null && typeof (parsed as { text?: unknown }).text === 'string') {
      onLine((parsed as { text: string }).text);
    } else if (event === 'ready') {
      return { verdict: { state: 'ready' }, rest };
    } else if (event === 'failed') {
      const reason: unknown = typeof parsed === 'object' && parsed !== null ? (parsed as { reason?: unknown }).reason : null;
      return { verdict: { state: 'failed', reason: typeof reason === 'string' ? reason : 'the session did not start' }, rest };
    }
  }
  return { verdict: null, rest };
}

/**
 * Reads a boot's server-sent events given whole, once the stream closed.
 *
 * @param text - The whole stream.
 * @param onLine - Told each `line` event's text.
 * @returns The end the stream reached.
 */
export function bootEvents_read(text: string, onLine: (text: string) => void): { state: 'ready' } | { state: 'failed'; reason: string } {
  return bootEvents_feed(`${text}\n\n`, onLine).verdict ?? { state: 'failed', reason: 'the boot stream ended without a verdict' };
}

/** A door token as the door hands it over: what the door file keeps. */
export interface DoorTokenGrant {
  token: string;
  user: string;
  name: string;
  expires: string;
}

/** What a bearer login answers beside the entry: whose token it was. */
export interface DoorTokenEntry extends DoorEntry {
  user: string;
  tokenName: string;
  expires: string;
}

/** Reads the door's refusal out of a response, or names the status. */
async function refusal_read(response: Response): Promise<string> {
  let reason: string = `the door answered ${response.status}`;
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string') reason = (body as { error: string }).error;
  } catch {
    // The status is the reason, then.
  }
  return reason;
}

/** The session cookie out of a login's answer, or undefined. */
function cookie_read(response: Response): string | undefined {
  return response.headers.getSetCookie().map((line: string): string => line.split(';')[0] ?? '').find((pair: string): boolean => pair.startsWith('porter_session='));
}

/**
 * Logs in at the door with a door token: a script's way in. The door
 * answers with the session and whose token it was, so a pasted token can
 * be kept in a complete door file.
 *
 * @param door - The door's URL.
 * @param token - The door token.
 * @param fetchLike - The HTTP client.
 * @returns The entry with the token's user and name, or the refusal (expired and unknown tokens are refused by name).
 */
export async function door_loginByToken(door: string, token: string, fetchLike: DoorFetch = fetch): Promise<DoorTokenEntry | { refused: string }> {
  const response = await fetchLike(`${door_normalise(door)}login`, {
    method: 'POST',
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
  });
  if (!response.ok) return { refused: await refusal_read(response) };
  const body = (await response.json()) as { key?: unknown; state?: unknown; user?: unknown; tokenName?: unknown; expires?: unknown };
  const doorCookie: string | undefined = cookie_read(response);
  if (typeof body.key !== 'string' || (body.state !== 'attached' && body.state !== 'starting') || doorCookie === undefined) {
    return { refused: 'the door answered without a session' };
  }
  return {
    key: body.key,
    state: body.state,
    cookie: doorCookie,
    user: typeof body.user === 'string' ? body.user : '',
    tokenName: typeof body.tokenName === 'string' ? body.tokenName : '',
    expires: typeof body.expires === 'string' ? body.expires : '',
  };
}

/**
 * Logs in with a password and asks the door for a token beside the session.
 *
 * @param door - The door's URL.
 * @param username - The CUBE username.
 * @param password - The password; sent once, kept nowhere.
 * @param tokenName - What the token is for (`chris@titan`).
 * @param fetchLike - The HTTP client.
 * @returns The entry and the grant, or the refusal.
 */
export async function door_loginForToken(door: string, username: string, password: string, tokenName: string, fetchLike: DoorFetch = fetch): Promise<{ entry: DoorEntry; grant: DoorTokenGrant } | { refused: string }> {
  const response = await fetchLike(`${door_normalise(door)}login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', origin: doorOrigin_derive(door) },
    body: JSON.stringify({ username, password, tokenName }),
  });
  if (!response.ok) return { refused: await refusal_read(response) };
  const body = (await response.json()) as { key?: unknown; state?: unknown; token?: { token?: unknown; name?: unknown; expires?: unknown } };
  const doorCookie: string | undefined = cookie_read(response);
  if (typeof body.key !== 'string' || (body.state !== 'attached' && body.state !== 'starting') || doorCookie === undefined) {
    return { refused: 'the door answered without a session' };
  }
  const token = body.token;
  if (token === undefined || typeof token.token !== 'string' || typeof token.name !== 'string' || typeof token.expires !== 'string') {
    return { refused: 'the door let you in but gave no token: it may be an older porter (upgrade it to use chell auth)' };
  }
  return { entry: { key: body.key, state: body.state, cookie: doorCookie }, grant: { token: token.token, user: username, name: token.name, expires: token.expires } };
}

/**
 * Asks the door for a device code to show the human.
 *
 * @param door - The door's URL.
 * @param host - Where this chell runs, for the page and the token's name.
 * @param fetchLike - The HTTP client.
 * @returns The code and when it stops being accepted, or the refusal.
 */
export async function doorDevice_begin(door: string, host: string, fetchLike: DoorFetch = fetch): Promise<{ code: string; expires: string } | { refused: string }> {
  const response = await fetchLike(`${door_normalise(door)}auth/device`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ host }),
  });
  if (!response.ok) return { refused: response.status === 404 ? 'this porter has no device codes (upgrade it to use chell auth login)' : await refusal_read(response) };
  const body = (await response.json()) as { code?: unknown; expires?: unknown };
  if (typeof body.code !== 'string') return { refused: 'the door answered without a code' };
  return { code: body.code, expires: typeof body.expires === 'string' ? body.expires : '' };
}

/** One poll of a device code. */
export async function doorDevice_poll(door: string, code: string, fetchLike: DoorFetch = fetch): Promise<{ state: 'pending' } | { state: 'unknown' } | { state: 'authorised'; grant: DoorTokenGrant } | { state: 'refused'; refused: string }> {
  const response = await fetchLike(`${door_normalise(door)}auth/device/${encodeURIComponent(code)}`, { headers: { accept: 'application/json' } });
  if (response.status === 404) return { state: 'unknown' };
  if (!response.ok) return { state: 'refused', refused: await refusal_read(response) };
  const body = (await response.json()) as { state?: unknown; token?: unknown; user?: unknown; name?: unknown; expires?: unknown };
  if (body.state === 'pending') return { state: 'pending' };
  if (body.state === 'authorised' && typeof body.token === 'string' && typeof body.user === 'string' && typeof body.name === 'string' && typeof body.expires === 'string') {
    return { state: 'authorised', grant: { token: body.token, user: body.user, name: body.name, expires: body.expires } };
  }
  return { state: 'refused', refused: 'the door answered the code with something unexpected' };
}

/**
 * Waits for the human to authorise a device code, polling the door.
 *
 * @param door - The door's URL.
 * @param code - The code shown.
 * @param options - The client, how long to wait, how often to ask.
 * @returns The grant, or why there is none.
 */
export async function doorDevice_wait(
  door: string,
  code: string,
  options: { fetchLike?: DoorFetch; deadlineMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ state: 'authorised'; grant: DoorTokenGrant } | { state: 'expired' } | { state: 'refused'; refused: string }> {
  const fetchLike: DoorFetch = options.fetchLike ?? fetch;
  const deadline: number = Date.now() + (options.deadlineMs ?? 10 * 60 * 1000);
  const interval: number = options.intervalMs ?? 2000;
  const sleep = options.sleep ?? ((ms: number): Promise<void> => new Promise((resolve: () => void): void => { setTimeout(resolve, ms); }));
  for (;;) {
    const polled = await doorDevice_poll(door, code, fetchLike);
    if (polled.state === 'authorised') return polled;
    if (polled.state === 'unknown') return { state: 'expired' };
    if (polled.state === 'refused') return polled;
    if (Date.now() >= deadline) return { state: 'expired' };
    await sleep(interval);
  }
}

/** One token as the door lists it to its own identity. */
export interface DoorTokenListed {
  name: string;
  created: string;
  expires: string;
  lastUsed: string | null;
}

/**
 * This identity's tokens at the door, by the token in hand.
 *
 * @param door - The door's URL.
 * @param token - A door token of the identity.
 * @param fetchLike - The HTTP client.
 */
export async function doorTokens_list(door: string, token: string, fetchLike: DoorFetch = fetch): Promise<{ user: string; tokens: DoorTokenListed[] } | { refused: string }> {
  const response = await fetchLike(`${door_normalise(door)}auth/tokens`, { headers: { accept: 'application/json', authorization: `Bearer ${token}` } });
  if (!response.ok) return { refused: await refusal_read(response) };
  const body = (await response.json()) as { user?: unknown; tokens?: unknown };
  if (typeof body.user !== 'string' || !Array.isArray(body.tokens)) return { refused: 'the door answered without a list' };
  return { user: body.user, tokens: body.tokens as DoorTokenListed[] };
}

/**
 * Revokes the token in hand at the door: `chell auth logout`.
 *
 * @param door - The door's URL.
 * @param token - The token to end.
 * @param fetchLike - The HTTP client.
 */
export async function doorToken_revoke(door: string, token: string, fetchLike: DoorFetch = fetch): Promise<{ revoked: true } | { refused: string; gone: boolean }> {
  const response = await fetchLike(`${door_normalise(door)}auth/token`, { method: 'DELETE', headers: { accept: 'application/json', authorization: `Bearer ${token}` } });
  // 401: the door no longer knows the token — replaced by a newer login
  // under the same name, revoked, or expired. Already dead, not a failure.
  if (!response.ok) return { refused: await refusal_read(response), gone: response.status === 401 };
  return { revoked: true };
}

/** A writable that can be told to swallow what it is given: the password. */
type MutableWritable = Writable & { muted: boolean };

/**
 * Asks for a line on the terminal, hidden when it is a password.
 *
 * @param label - What is asked for.
 * @param hidden - Whether to echo nothing.
 * @returns The line typed.
 */
export function terminalLine_ask(label: string, hidden: boolean): Promise<string> {
  return new Promise((resolve: (line: string) => void): void => {
    const output: MutableWritable = Object.assign(new Writable({
      write(chunk: Buffer | string, encoding: BufferEncoding, callback: () => void): void {
        if (!(this as MutableWritable).muted) process.stdout.write(chunk, encoding);
        callback();
      },
    }), { muted: false });
    const rl: readline.Interface = readline.createInterface({ input: process.stdin, output, terminal: true });
    // The label is readline's own prompt: written beside it, readline's
    // repaint of an empty prompt (column one, clear to the end) erased it,
    // and the username question showed as a blank line. A hidden answer
    // writes the label first and then mutes what follows.
    if (hidden) {
      process.stdout.write(label);
      output.muted = true;
    }
    rl.question(hidden ? '' : label, (line: string): void => {
      rl.close();
      if (hidden) console.log('');
      resolve(line.trim());
    });
  });
}

/** Where a terminal ends up after the door: a wire and what to send with it. */
export interface DoorReach {
  identity: string;
  url: string;
  headers: Record<string, string>;
}

/**
 * Why a plain-http door's token is not sent, and what would send it: which
 * door this is (the default, when it is), and a door the user is already
 * logged into with --insecure-door, when there is one, so the way out is a
 * flag rather than another login.
 *
 * @param doorUrl - The door tried.
 * @param env - The environment.
 * @returns The words.
 */
export function doorRefusal_words(doorUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const isDefault: boolean = doorDefault_read(env) === doorUrl;
  const head: string = `${doorUrl}${isDefault ? ' (your default door)' : ''} is plain http to another host: the door token is not sent there.`;
  const usable: { door: string } | undefined = doorsKept_read(env).find((kept): boolean => kept.insecure && kept.door !== doorUrl);
  if (usable !== undefined) {
    return `${head} You are logged in at ${usable.door} with --insecure-door: use it with chell --remote --door ${usable.door} -c '…', or make it the default with chell auth login --door ${usable.door} --insecure-door --default.`;
  }
  return `${head} Use the https door, or chell auth login --door ${doorUrl} --insecure-door${isDefault ? '' : ' --default'} knowingly.`;
}

/**
 * Takes a terminal through the door: asks what it must, logs in, follows
 * the boot if there is one, and hands back the session's wire.
 *
 * @param door - The door's URL.
 * @param username - The CUBE username, or undefined to ask.
 * @param password - The password, or undefined to ask.
 * @param fetchLike - The HTTP client.
 * @returns The reach, or null when the door refused (already said why).
 */
export async function door_enter(door: string, username: string | undefined, password: string | undefined, fetchLike: DoorFetch = fetch, env: NodeJS.ProcessEnv = process.env): Promise<DoorReach | null> {
  let doorUrl: string;
  try {
    doorUrl = door_normalise(door);
  } catch (error: unknown) {
    console.error(chalk.red(`[!] ${error instanceof Error ? error.message : String(error)}`));
    return null;
  }
  // A token first, when no password was given: the environment, then the
  // door file (`chell auth login`). A refused token is said and is the end;
  // a script is never left at a prompt it cannot answer.
  if (doorCredential_missing(password)) {
    const credential = doorCredential_resolve(doorUrl, env);
    if ('refused' in credential) {
      console.error(chalk.red(`[!] ${credential.refused}`));
      return null;
    }
    if (credential.kind === 'token') {
      if (!door_carriesTokens(doorUrl)) {
        if (credential.insecure !== true) {
          console.error(chalk.red(`[!] ${doorRefusal_words(doorUrl, env)}`));
          return null;
        }
        // Said at login, kept with the door, and said again on each use.
        console.error(chalk.yellow(`[!] ${doorUrl} is plain http: the token goes readable on the wire (--insecure-door, chosen at login).`));
      }
      return doorByToken_enter(doorUrl, credential.token, credential.name, credential.expires, fetchLike);
    }
  }
  // Off a terminal there is nobody to ask: say so in one line.
  if ((doorCredential_missing(username) || doorCredential_missing(password)) && process.stdin.isTTY !== true) {
    console.error(chalk.red(`[!] No credential for ${doorUrl} and no terminal to ask on: run chell auth login once, or set CHELL_DOOR_TOKEN.`));
    return null;
  }
  const user: string = doorCredential_missing(username) ? await terminalLine_ask(`Username at ${doorUrl}: `, false) : username;
  // An empty answer is refused here, by name: the door would only refuse it
  // after a password asked for nobody.
  if (doorCredential_missing(user)) {
    console.error(chalk.red('[!] A username is required to come through the door (give -u <user>, or answer the question).'));
    return null;
  }
  const secret: string = doorCredential_missing(password) ? await terminalLine_ask(`Password for ${user} at ${doorUrl}: `, true) : password;
  // A door that cannot be reached — porter down, a wrong port, a name that
  // does not resolve — is one line naming the door, never a stack trace.
  const unreached = (error: unknown): null => {
    console.error(chalk.red(`[!] The door at ${doorUrl} could not be reached: ${doorUnreached_reason(error)}`));
    return null;
  };
  let entered: DoorEntry | { refused: string };
  try {
    entered = await door_login(doorUrl, user, secret, fetchLike);
  } catch (error: unknown) {
    return unreached(error);
  }
  if ('refused' in entered) {
    console.error(chalk.red(`[!] The door refused: ${entered.refused}`));
    return null;
  }
  if (entered.state === 'starting') {
    // The boot is progress, not the answer: stderr, so `chell -c` stdout is
    // the command's output alone even when a session had to be started.
    console.error(chalk.gray(`[+] Starting your session at ${doorUrl} — the boot as it happens:`));
    let ended: { state: 'ready' } | { state: 'failed'; reason: string };
    try {
      ended = await doorBoot_follow(doorUrl, entered, (text: string): void => { console.error(text); }, fetchLike);
    } catch (error: unknown) {
      return unreached(error);
    }
    if (ended.state === 'failed') {
      console.error(chalk.red(`[!] The session did not start: ${ended.reason}`));
      return null;
    }
  }
  return {
    identity: `${user} through the door at ${doorUrl}`,
    url: doorWire_build(doorUrl, entered.key),
    // The wire is opened on the door's cookie, and so says it is opened from the door.
    headers: { cookie: entered.cookie, origin: doorOrigin_derive(doorUrl) },
  };
}

/**
 * Takes a terminal through the door on a door token, following the boot
 * when there is one. The token's remaining life is said from seven days
 * out, so a script's owner hears before it stops.
 */
async function doorByToken_enter(doorUrl: string, token: string, name: string | null, expires: string | null, fetchLike: DoorFetch): Promise<DoorReach | null> {
  if (expires !== null) {
    const left: number = days_until(expires);
    if (left >= 0 && left < 7) console.error(chalk.yellow(`[!] the door token${name === null ? '' : ` "${name}"`} expires in ${left} day${left === 1 ? '' : 's'}; run chell auth login`));
  }
  let entered: DoorTokenEntry | { refused: string };
  try {
    entered = await door_loginByToken(doorUrl, token, fetchLike);
  } catch (error: unknown) {
    console.error(chalk.red(`[!] The door at ${doorUrl} could not be reached: ${doorUnreached_reason(error)}`));
    return null;
  }
  if ('refused' in entered) {
    console.error(chalk.red(`[!] The door refused the token: ${entered.refused}`));
    return null;
  }
  if (entered.state === 'starting') {
    // The boot is progress, not the answer: stderr, so `chell -c` stdout is
    // the command's output alone even when a session had to be started.
    console.error(chalk.gray(`[+] Starting your session at ${doorUrl} — the boot as it happens:`));
    let ended: { state: 'ready' } | { state: 'failed'; reason: string };
    try {
      ended = await doorBoot_follow(doorUrl, entered, (text: string): void => { console.error(text); }, fetchLike);
    } catch (error: unknown) {
      console.error(chalk.red(`[!] The door at ${doorUrl} could not be reached: ${doorUnreached_reason(error)}`));
      return null;
    }
    if (ended.state === 'failed') {
      console.error(chalk.red(`[!] The session did not start: ${ended.reason}`));
      return null;
    }
  }
  return {
    identity: `${entered.user || 'you'} through the door at ${doorUrl}`,
    url: doorWire_build(doorUrl, entered.key),
    // The wire is opened on the door's cookie, and so says it is opened from the door.
    headers: { cookie: entered.cookie, origin: doorOrigin_derive(doorUrl) },
  };
}
