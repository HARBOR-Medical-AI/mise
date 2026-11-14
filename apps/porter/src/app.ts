/**
 * @file The porter's routes: the door, the boot, and the session behind it.
 *
 * - `GET /login` — the door: a username and a password, nothing else.
 * - `POST /login` — the password goes to CUBE once and comes back a token;
 *   the token starts (or joins) that identity's session; the browser is
 *   given a signed cookie naming the session. A session already up is
 *   entered at once; one that has to boot is watched from the greet, which
 *   the door answers with immediately — a browser is never held for a
 *   boot. A JSON caller gets the mount and the state (`attached` or
 *   `starting`) instead of a redirect. Every login checks the password
 *   even when the session is up: a berth proves the daemon, not the human.
 * - `GET /greet/<key>` — the greeter: the brain awake and the boot rows
 *   arriving, until `ready` hands the browser to the session.
 * - `GET /greeter/brain.js`, `/greeter/ansi.js` — the wire package's own
 *   modules, served from where they are installed, so the greeter draws
 *   the brain and the rows from the same source the console does.
 * - `POST /restart` — the cookie's own session restarts: the old daemon is
 *   left the cause and ended, a fresh one boots on the login it saved, and the
 *   browser follows the boot on the greeter (no password asked again).
 * - `POST /logout` — the cookie is cleared; the session lives on.
 * - Door tokens (`chell auth`): `POST /login` also takes `Authorization:
 *   Bearer <token>`, a token the door minted for a human login earlier,
 *   and lets its identity in the same way (a session not up boots on the
 *   login it saved); a JSON password login carrying `tokenName` is given
 *   a fresh token in its answer; a form login carrying a device `code`
 *   authorises the chell that asked for it.
 * - `POST /auth/device` — chell asks for a one-time code to show its
 *   human; `GET /login?code=…` is the login page saying what it is for;
 *   `GET /auth/device/<code>` is chell's poll: pending, then the token
 *   once, then unknown. `GET /auth/tokens` lists the identity's tokens
 *   by one of them; `DELETE /auth/token` revokes the token in hand.
 * - `GET /boot/<key>` — the session's boot as it happens, server-sent, one
 *   event per line the daemon wrote, ending with `ready` or `failed`.
 * - `GET /berths` — for the operator: every person's berth (running, with
 *   what it uses) or kept home (stopped), read through the berth launcher.
 *   Asked with `Authorization: Token <CUBE token>` or Basic credentials, which
 *   porter hands to CUBE to verify; only an administrator is answered (401
 *   with no credentials or ones CUBE refuses, 403 for a CUBE user who is not
 *   an administrator). A client may ask ten times a minute (429 with
 *   `Retry-After` past that, and CUBE is not asked); CUBE's verdict on one
 *   set of credentials is kept for 30 s, under a hash of the header. A porter
 *   that starts no berths says so.
 * - `/s/<key>/…` — the session itself: the argus page and its assets, the
 *   `/vfs` byte route, and the WebSocket wire, proxied to the daemon on
 *   loopback. The attach token is put on the proxied `/vfs` query and the
 *   proxied upgrade URL by the porter; the browser never holds it. A body
 *   goes on as it arrives, never parsed, held or refused by size (the
 *   daemon's own limit on `POST /vfs` is the only one), and an answer that
 *   stops part way is a line in the porter's log (relay.ts).
 *
 * The cookie gates everything under `/s/` and `/boot/`: a browser reaches
 * only the session its cookie names, and a request with none is sent to the
 * door. TLS is somebody else's — a caddy, an ingress — and `trustProxy`
 * lets the porter learn from them that the page came over it.
 *
 * @module
 */
import { berth_behind, berthJoblets_read, installed_read, porterVersion_read, type BerthJoblet } from './versions.js';
import { FAVICON_SVG } from './favicon.js';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie, { unsign as cookie_unsign } from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import replyFrom from '@fastify/reply-from';
import { z } from 'zod';
import { connect as net_connect, type Socket } from 'node:net';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Duplex, Readable } from 'node:stream';
import { identity_normalise } from '@fnndsc/calypso/berth';
import type { PorterConfig } from './config.js';
import { identity_isStratus, owner_extract, stratusIdentity_derive, user_extract, type SessionHost, type Berth, type BootLine } from './host/sessionHost.js';
import { CredentialStore } from './creds.js';
import { SessionRegistry, type SessionEntry } from './registry.js';
import { cubeAdmin_check, cubeToken_mint, type AdminVerdict, type TokenMint } from './cube/auth.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DOOR_COOKIE, doorCookie_options } from './door.js';
import { loginPage_render, greetPage_render, authorisedPage_render } from './greeter.js';
import { DeviceCodes, TokenStore, token_looksLike, type DeviceGrant, type DoorToken, type TokenCheck } from './tokens.js';
import { idleSweep_run } from './sweep.js';
import { HitLimit, VerdictCache } from './limit.js';
import { answer_watch, bodyStream_pass, relayBreak_format, relayFailure_describe, relayTarget_name, relayTimeout_derive } from './relay.js';

/** What the routes are built over. */
export interface PorterAppOptions {
  /** What this porter ships (brasa, calypso, chell versions); a test names its own. */
  installed?: Record<string, string>;
  config: PorterConfig;
  host: SessionHost;
  /** How a password becomes a token; CUBE's `auth-token/` by default. */
  mint?: (cubeUrl: string, username: string, password: string) => Promise<TokenMint>;
  /** Fastify's logger switch. */
  logger?: boolean;
  /** One line per thing the door does, for the porter's own terminal. */
  log?: (line: string) => void;
  /** How often the idle sweep runs, in ms; a minute by default. */
  sweepMs?: number;
  /** The door's token store; built from the config's file when not given (a test gives its own). */
  tokens?: TokenStore;
  /** The device codes out; fresh when not given. */
  codes?: DeviceCodes;
  /** How the credentials of a `GET /berths` are checked against CUBE; CUBE's API root by default. */
  adminCheck?: (cubeUrl: string, authorization: string) => Promise<AdminVerdict>;
  /** The clock, in ms, for the `/berths` rate limit and verdict cache; the system's by default (a test steps its own). */
  now?: () => number;
  /** Whether a logout ends the person's session (a berth stops; its volumes stay); otherwise it lives on. */
  logoutEnds?: boolean;
}

/** A porter application: the Fastify instance and the registry behind it. */
export interface PorterApp {
  app: FastifyInstance;
  registry: SessionRegistry;
  /** The door's token store, for the porter's own CLI (`--tokens`, `--revoke`, `--mint`). */
  tokens: TokenStore;
  /** Adopts the sessions the state directory holds that still answer; called once the door is bound. */
  adopt: () => Promise<void>;
}

/** How many times a client may ask `/berths` in a minute. */
const BERTHS_PER_MINUTE: number = 10;
/** How long CUBE's verdict on one set of credentials is kept, in ms. */
const BERTHS_VERDICT_MS: number = 30_000;

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  /** A JSON caller asking for a door token with this name, beside its session. */
  tokenName: z.string().min(1).max(80).optional(),
  /** A device code the login authorises, carried by the page variant. */
  code: z.string().min(1).max(20).optional(),
});

const deviceSchema = z.object({
  /** Where the chell asking for the code runs, for the page and the token's name. */
  host: z.string().min(1).max(120),
});

/** The token a request presents as a bearer, or null. */
export function bearer_extract(request: FastifyRequest): string | null {
  const header: string = String(request.headers.authorization ?? '');
  const match: RegExpMatchArray | null = /^Bearer\s+(\S+)$/i.exec(header);
  return match === null ? null : (match[1] as string);
}

/**
 * The upstream base for a berth: its `ws://host:port` as `http://`.
 *
 * @param berth - The berth.
 * @returns The daemon's HTTP origin.
 */
export function berthHttp_derive(berth: Berth): string {
  return berth.url.replace(/^ws/, 'http');
}

/**
 * The path to hand the daemon for a request under a session's mount, the
 * token added where the daemon wants it.
 *
 * @param rest - The path after `/s/<key>/`, query included.
 * @param token - The session's attach token.
 * @returns The upstream path, always beginning with `/`.
 */
export function upstreamPath_build(rest: string, token: string): string {
  const path: string = rest.startsWith('/') ? rest : `/${rest}`;
  const cut: number = path.indexOf('?');
  const pathname: string = cut === -1 ? path : path.slice(0, cut);
  const query: URLSearchParams = new URLSearchParams(cut === -1 ? '' : path.slice(cut + 1));
  if (pathname === '/vfs' || pathname === '/backend' || pathname === '/') {
    // The byte route and the backend's name are token-gated; the wire's upgrade lands on `/`.
    query.set('token', token);
  }
  const text: string = query.toString();
  return text.length > 0 ? `${pathname}?${text}` : pathname;
}

/** The sound types the page asks for, and what each is served as. */
const SOUND_TYPES: Readonly<Record<string, string>> = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg' };

/**
 * The deployment's own copy of a sound the page asks for, when it has one:
 * `sounds/<name>.<mp3|wav|ogg>` under the session, read from the sounds
 * folder. A name is taken as a bare file name only, so no path climbs out.
 * `sounds/index.json` names the files the folder has, so the page knows
 * which of its sounds the deployment keeps and synthesizes the rest.
 *
 * @param soundsDir - The deployment's sounds folder, or null for none.
 * @param rest - The path after `/s/<key>/`, query included.
 * @returns The bytes and their type, or null when the page's own is served.
 */
export async function soundOverride_read(soundsDir: string | null, rest: string): Promise<{ bytes: Buffer; type: string } | null> {
  if (soundsDir === null) return null;
  // The rest as the mount splits it begins with a slash (`/sounds/press.mp3`).
  const path: string = (rest.split('?')[0] ?? '').replace(/^\/+/, '');
  // The page asks which sounds the deployment keeps: it plays those recordings and synthesizes the rest itself.
  if (path === 'sounds/index.json') {
    try {
      const names: string[] = (await readdir(soundsDir)).filter((name: string): boolean => /^[A-Za-z0-9_-]+\.(mp3|wav|ogg)$/.test(name)).sort();
      return { bytes: Buffer.from(`${JSON.stringify({ files: names })}\n`), type: 'application/json; charset=utf-8' };
    } catch {
      return null;
    }
  }
  const match: RegExpMatchArray | null = path.match(/^sounds\/([A-Za-z0-9_-]+)\.(mp3|wav|ogg)$/);
  if (match === null) return null;
  const name: string = `${match[1]}.${match[2]}`;
  if (basename(name) !== name) return null;
  try {
    return { bytes: await readFile(join(soundsDir, name)), type: SOUND_TYPES[match[2] as string] as string };
  } catch {
    // Not in the folder: the page's own sound is served.
    return null;
  }
}

/**
 * Splits a request URL under `/s/` into its key and the rest.
 *
 * @param url - The request URL, query included.
 * @returns The key and the rest (beginning with `/`), or null when the URL
 *   is not under `/s/<key>/`.
 */
export function mountUrl_split(url: string): { key: string; rest: string } | null {
  const match: RegExpMatchArray | null = /^\/s\/([0-9a-f]{16})(\/.*)?$/.exec(url) as RegExpMatchArray | null;
  if (match === null) return null;
  return { key: match[1] ?? '', rest: match[2] ?? '/' };
}

/**
 * The session key a cookie header names, once its signature is checked.
 *
 * @param cookieHeader - The raw `Cookie` header, or undefined.
 * @param secret - The door's signing secret.
 * @returns The key, or null when there is no cookie or its signature fails.
 */
export function cookieKey_read(cookieHeader: string | undefined, secret: string): string | null {
  if (cookieHeader === undefined) return null;
  // The one cookie wanted, out of a header that may carry any number: the
  // plugin parses only for a request it decorated, and an upgrade has none.
  let raw: string | undefined;
  for (const part of cookieHeader.split(';')) {
    const cut: number = part.indexOf('=');
    if (cut === -1) continue;
    if (part.slice(0, cut).trim() !== DOOR_COOKIE) continue;
    try {
      raw = decodeURIComponent(part.slice(cut + 1).trim());
    } catch {
      return null;
    }
    break;
  }
  if (raw === undefined) return null;
  const checked = cookie_unsign(raw, secret);
  return checked.valid && checked.value !== null && /^[0-9a-f]{16}$/.test(checked.value) ? checked.value : null;
}

/** Whether a request would rather be answered in JSON than sent somewhere. */
function request_wantsJson(request: FastifyRequest): boolean {
  const contentType: string = String(request.headers['content-type'] ?? '');
  const accept: string = String(request.headers.accept ?? '');
  return contentType.includes('application/json') || (accept.includes('application/json') && !accept.includes('text/html'));
}

/** What the door says when a session's daemon is gone. */
const SESSION_ENDED: string = 'your session ended; log in to start it again';

/**
 * Builds the porter's routes over a host and a config.
 *
 * @param options - The config, the session host, and the seams a test replaces.
 * @returns The application, not yet listening.
 */
export async function porterApp_build(options: PorterAppOptions): Promise<PorterApp> {
  const { config, host } = options;
  const installed: Record<string, string> = options.installed ?? installed_read();
  const mint = options.mint ?? cubeToken_mint;
  // /berths asks CUBE, and a Basic header makes CUBE hash a password each time: a client is allowed a few asks a minute, and a verdict (never the credentials) is kept for a short while.
  const berthsHits: HitLimit = new HitLimit(BERTHS_PER_MINUTE, 60_000, options.now);
  const berthsVerdicts: VerdictCache<AdminVerdict> = new VerdictCache<AdminVerdict>(BERTHS_VERDICT_MS, options.now);
  const adminCheck = options.adminCheck ?? ((cubeUrl: string, authorization: string): Promise<AdminVerdict> => cubeAdmin_check(cubeUrl, authorization));
  const registry: SessionRegistry = new SessionRegistry();
  const creds: CredentialStore = new CredentialStore(config.stateDir);
  const tokens: TokenStore = options.tokens ?? new TokenStore(config.tokensFile, config.tokenDays);
  tokens.load();
  const codes: DeviceCodes = options.codes ?? new DeviceCodes();
  const app: FastifyInstance = Fastify({ logger: options.logger ?? false, trustProxy: true });

  // A porter restarted adopts the sessions its predecessor started: their
  // berths are in the state directory, and a cookie that names one still
  // opens it, because the key is the identity's and not this process's.
  // Not at build: the entry adopts after the door is bound, so a second
  // porter that cannot hold the port claims nothing.
  const adopt = async (): Promise<void> => {
    for (const sighting of await host.sessions_adopt()) {
      if (!sighting.alive) continue;
      const user: string = user_extract(sighting.identity);
      registry.note(sighting.identity, user, sighting.berth);
      options.log?.(`adopted ${user}'s session at ${sighting.berth.url}`);
    }
  };
  await app.register(fastifyCookie, { secret: config.secret });
  await app.register(fastifyFormbody);
  await app.register(replyFrom);

  /**
   * Finds where an entry's session answers now, after its berth failed to.
   * A daemon started again since the entry was written (a login that
   * booted a new one, an operator who killed the old one) answers at a new
   * port: the entry moves there. None answering: the entry is forgotten,
   * so the next visit goes to the door rather than to a dead port.
   *
   * @param entry - The entry whose berth refused.
   * @returns `moved` when the session answers at a new berth, `same` when
   *   the berth on record still answers (the failure was something else),
   *   `gone` when no session is up.
   */
  const entry_recover = async (entry: SessionEntry): Promise<'moved' | 'same' | 'gone'> => {
    const found: Berth | null = await host.find(entry.identity);
    if (found === null) {
      registry.forget(entry.key);
      options.log?.(`${entry.user}'s session at ${entry.berth.url} is gone; forgot it`);
      return 'gone';
    }
    if (found.url === entry.berth.url) return 'same';
    options.log?.(`${entry.user}'s session moved from ${entry.berth.url} to ${found.url}`);
    registry.note(entry.identity, entry.user, found);
    return 'moved';
  };

  /** The key the request's cookie names, or null. */
  const requestKey_read = (request: FastifyRequest): string | null => cookieKey_read(request.headers.cookie, config.secret);

  // Its own version beside its sessions: a deploy that would replace porter says which version it replaces and what it ends.
  const version: string = porterVersion_read();
  app.get('/healthz', async (): Promise<{ ok: true; cube: string; sessions: number; version: string }> => ({ ok: true, cube: config.cubeUrl, sessions: registry.all().length, version }));

  // The operator's read of every berth. CUBE verifies the caller and says whether they administer it; the launcher, the only holder of the engine, reads the berths.
  app.get('/berths', async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const wait: number = berthsHits.hit_take(request.ip);
    if (wait > 0) return reply.code(429).header('Retry-After', String(wait)).send({ error: `too many asks for /berths; try again in ${wait} s` });
    const authorization: string = String(request.headers.authorization ?? '');
    if (!/^(Token|Basic)\s+\S+$/i.test(authorization)) return reply.code(401).send({ error: 'send a CUBE token (Authorization: Token <token>) or the admin\'s Basic credentials' });
    let verdict: AdminVerdict | null = berthsVerdicts.verdict_get(authorization);
    if (verdict === null) {
      verdict = await adminCheck(config.cubeUrl, authorization);
      if (verdict !== 'unreachable') berthsVerdicts.verdict_keep(authorization, verdict);
    }
    if (verdict === 'refused') return reply.code(401).send({ error: 'CUBE does not accept those credentials' });
    if (verdict === 'unreachable') return reply.code(502).send({ error: 'CUBE did not answer' });
    if (verdict === 'not-admin') return reply.code(403).send({ error: 'berths are read by a CUBE administrator' });
    if (host.access_read === undefined) return { berths: null, why: 'this porter starts no berths' };
    try {
      return { at: new Date().toISOString(), berths: await host.access_read(config.cubeUrl) };
    } catch (error: unknown) {
      return reply.code(502).send({ error: `the berth launcher did not answer: ${error instanceof Error ? error.message : String(error)}` });
    }
  });

  app.get('/', async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const key: string | null = requestKey_read(request);
    const entry: SessionEntry | null = key === null ? null : registry.get(key);
    await reply.redirect(entry === null ? '/login' : `/s/${entry.key}/?door`, 302);
  });

  app.get('/login', async (request: FastifyRequest, reply: FastifyReply): Promise<string> => {
    const query = request.query as { reason?: unknown; code?: unknown };
    const reason: string | null = typeof query.reason === 'string' && query.reason.length > 0 ? query.reason : null;
    void reply.type('text/html; charset=utf-8');
    if (typeof query.code === 'string' && query.code.length > 0) {
      // The device-code variant: the same door, saying which chell it is for.
      const host: string | null = codes.host_find(query.code);
      if (host === null) return loginPage_render(config.cubeUrl, `the code ${query.code} is not waiting (ten minutes, once); run chell auth login again`);
      return loginPage_render(config.cubeUrl, reason, { code: query.code, host });
    }
    return loginPage_render(config.cubeUrl, reason);
  });

  // Where a human types the code chell showed: the login page with a code field.
  app.get('/device', async (request: FastifyRequest, reply: FastifyReply): Promise<string> => {
    const reason: unknown = (request.query as { reason?: unknown }).reason;
    void reply.type('text/html; charset=utf-8');
    return loginPage_render(config.cubeUrl, typeof reason === 'string' && reason.length > 0 ? reason : null, 'ask');
  });

  app.post('/auth/device', async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const parsed = deviceSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'the host chell runs on is required' });
    const issued: { code: string; expires: string } = codes.issue(parsed.data.host);
    return { code: issued.code, expires: issued.expires, url: '/device' };
  });

  /** The token a self-service route is called with, checked; or the refusal sent. */
  const bearer_check = async (request: FastifyRequest, reply: FastifyReply): Promise<DoorToken | null> => {
    const bearer: string | null = bearer_extract(request);
    if (bearer === null || !token_looksLike(bearer)) {
      await reply.code(401).send({ error: 'a door token is required (Authorization: Bearer …)' });
      return null;
    }
    const checked: TokenCheck = tokens.check(bearer);
    if (!checked.ok) {
      await reply.code(401).send({ error: checked.why === 'expired' ? `the door token "${checked.record.name}" expired on ${checked.record.expires.slice(0, 10)}` : 'the door does not know that token' });
      return null;
    }
    return checked.record;
  };

  // This identity's tokens, by a token of its own: `chell auth tokens`.
  app.get('/auth/tokens', async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const holder: DoorToken | null = await bearer_check(request, reply);
    if (holder === null) return reply;
    return {
      user: holder.user,
      tokens: tokens.list().filter((token: DoorToken): boolean => token.identity === holder.identity).map((token: DoorToken) => ({ name: token.name, created: token.created, expires: token.expires, lastUsed: token.lastUsed })),
    };
  });

  // The token in hand ends itself: `chell auth logout`.
  app.delete('/auth/token', async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const holder: DoorToken | null = await bearer_check(request, reply);
    if (holder === null) return reply;
    tokens.revoke(holder.user, holder.name);
    options.log?.(`${holder.user} revoked their door token "${holder.name}"`);
    return { revoked: true, name: holder.name };
  });

  app.get('/auth/device/:code', async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const code: string = (request.params as { code: string }).code;
    const taken = codes.take(code);
    if (taken.state === 'unknown') return reply.code(404).send({ state: 'unknown' });
    if (taken.state === 'pending') return { state: 'pending' };
    return { state: 'authorised', ...taken.grant };
  });

  app.post('/login', async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const wantsJson: boolean = request_wantsJson(request);
    // A form that carried a device code goes back to the page with the code
    // field, so a mistyped password or code is tried again where it was typed.
    const fromDevice: boolean = typeof (request.body as { code?: unknown } | undefined)?.code === 'string';
    const refuse = async (status: number, reason: string): Promise<unknown> =>
      wantsJson ? reply.code(status).send({ error: reason }) : reply.redirect(`/${fromDevice ? 'device' : 'login'}?reason=${encodeURIComponent(reason)}`, 303);
    // A script's way in: a door token minted for a human login earlier.
    // Checked before any body, so a token never travels beside a password.
    const bearer: string | null = bearer_extract(request);
    let username: string;
    let cubeToken: string | null;
    let byToken: DoorToken | null = null;
    let wanted: { tokenName?: string; code?: string } = {};
    if (bearer !== null) {
      if (!token_looksLike(bearer)) return refuse(401, 'that is not a door token');
      const checked: TokenCheck = tokens.check(bearer);
      if (!checked.ok) {
        if (checked.why === 'expired') {
          options.log?.(`refused ${checked.record.user}'s door token "${checked.record.name}": it expired on ${checked.record.expires.slice(0, 10)}`);
          return refuse(401, `the door token "${checked.record.name}" expired on ${checked.record.expires.slice(0, 10)}; run chell auth login`);
        }
        options.log?.('refused a door token nobody holds (revoked, or never minted here)');
        return refuse(401, 'the door does not know that token (revoked, or minted elsewhere); run chell auth login');
      }
      byToken = checked.record;
      tokens.touch(byToken);
      username = byToken.user;
      cubeToken = null;
    } else {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        return refuse(400, 'a username and a password are required');
      }
      username = parsed.data.username;
      wanted = { ...(parsed.data.tokenName === undefined ? {} : { tokenName: parsed.data.tokenName }), ...(parsed.data.code === undefined ? {} : { code: parsed.data.code }) };
      const minted: TokenMint = await mint(config.cubeUrl, username, parsed.data.password);
      if (minted.token === null) {
        return refuse(401, minted.reason ?? 'refused');
      }
      cubeToken = minted.token;
    }
    const identity: string = identity_normalise(username, config.cubeUrl);
    // A device code: the human came to authorise a chell, not to open a
    // session here. The token is minted, handed to the waiting poll, and
    // the browser is told it can go.
    if (wanted.code !== undefined) {
      const forHost: string | null = codes.host_find(wanted.code);
      if (forHost === null) return refuse(410, `the code ${wanted.code} is not waiting (ten minutes, once); run chell auth login again`);
      const name: string = `${username}@${forHost}`;
      const made: { token: string; record: DoorToken } = tokens.mint(identity, username, name);
      const grant: DeviceGrant = { token: made.token, user: username, name, expires: made.record.expires };
      codes.authorise(wanted.code, grant);
      options.log?.(`minted a door token "${name}" for ${username} by device code (dies ${made.record.expires.slice(0, 10)})`);
      // A token boots a session on the login the session saved. A human who
      // never came through before has none, so this login, which holds a
      // fresh CUBE token, starts the session now; chell's first call then
      // finds it up or booting (found live: a first-ever device login left
      // `chell -c` failing with "no token is saved for this identity").
      if (cubeToken !== null && (await host.find(identity)) === null) {
        const booting = host.boot_follow(identity, { line: (): void => undefined, done: (): void => undefined });
        booting?.release();
        if (booting === null || booting.report.state !== 'booting') {
          registry.pending_note(identity, username);
          host.spawn_begin(identity, username, config.cubeUrl, cubeToken);
          options.log?.(`starting a session for ${username} beside the device login`);
        }
      }
      if (wantsJson) return { authorised: true, name, expires: made.record.expires };
      void reply.type('text/html; charset=utf-8');
      return authorisedPage_render(config.cubeUrl, forHost, name, made.record.expires);
    }
    // A password login asking for a token beside its session.
    let granted: { token: string; name: string; expires: string } | null = null;
    if (wanted.tokenName !== undefined) {
      const made: { token: string; record: DoorToken } = tokens.mint(identity, username, wanted.tokenName);
      granted = { token: made.token, name: wanted.tokenName, expires: made.record.expires };
      options.log?.(`minted a door token "${wanted.tokenName}" for ${username} (dies ${made.record.expires.slice(0, 10)})`);
    }
    // The answer carries the grant a password login asked for, or, on a
    // token login, whose token it was: a pasted token becomes a whole door file.
    const answer = (body: { key: string; mount: string; state: 'attached' | 'starting' }): unknown => {
      if (granted !== null) return { ...body, token: granted };
      if (byToken !== null) return { ...body, user: byToken.user, tokenName: byToken.name, expires: byToken.expires };
      return body;
    };
    const found: Berth | null = await host.find(identity);
    const key: string = registry.key_derive(identity);
    void reply.setCookie(DOOR_COOKIE, key, doorCookie_options(config.cookieHours, request.protocol === 'https'));
    if (byToken !== null) options.log?.(`${username} came through by door token "${byToken.name}"`);
    // A boot already under way is joined, never restarted: two scripts
    // arriving together, or a browser and a script, would otherwise take
    // turns killing each other's boot and nobody would ever get in.
    if (found === null) {
      const booting = host.boot_follow(identity, { line: (): void => undefined, done: (): void => undefined });
      if (booting !== null) {
        booting.release();
        if (booting.report.state === 'booting') {
          registry.pending_note(identity, username);
          options.log?.(`${username} joins the boot already under way`);
          return wantsJson ? answer({ key, mount: `/s/${key}/`, state: 'starting' }) : reply.redirect(`/greet/${key}`, 303);
        }
      }
    }
    // A login never lands on a kernel older than the door's: a session whose
    // daemon runs code this porter no longer ships is ended here and boots
    // afresh on the way in, its saved state kept.
    if (found !== null) {
      const behind: string[] = berth_behind(found, installed);
      // A restart ends the session's joblets: one that runs them is kept on
      // its older code, and the RESTART pill, which lists them, asks (#1273).
      const joblets: BerthJoblet[] = behind.length > 0 ? await berthJoblets_read(found) : [];
      if (joblets.length > 0) {
        options.log?.(`kept ${username}'s session on its older release (${behind.join(', ')}): ${joblets.length} joblet${joblets.length === 1 ? '' : 's'} running`);
      } else if (behind.length > 0) {
        // The restart the RESTART pill takes: the old daemon is left the
        // cause and waited out before the new one boots, so the mount never reaches a
        // port that is about to close.
        options.log?.(`restarting ${username}'s session for the new release (${behind.join(', ')})`);
        registry.pending_note(identity, username);
        host.restart_begin(identity, username, config.cubeUrl, { kind: 'stale', behind });
        return wantsJson ? answer({ key, mount: `/s/${key}/`, state: 'starting' }) : reply.redirect(`/greet/${key}`, 303);
      }
    }
    // A new login's token reaches a berth already up: the launcher rewrites its token file.
    if (found !== null && cubeToken !== null && host.token_renew !== undefined) {
      await host.token_renew(identity, username, config.cubeUrl, cubeToken).catch((error: unknown): void => { options.log?.(`${username}'s new token did not reach the berth: ${error instanceof Error ? error.message : String(error)}`); });
    }
    if (found !== null) {
      registry.note(identity, username, found);
      options.log?.(`attached ${username} to the session up at ${found.url}`);
      return wantsJson ? answer({ key, mount: `/s/${key}/`, state: 'attached' }) : reply.redirect(`/s/${key}/?door`, 303);
    }
    // The boot is watched, not waited for: the door answers now, and the
    // greet follows the rows until the berth answers. The berth reaches the
    // registry when the boot ends, so the mount refuses until then.
    registry.pending_note(identity, username);
    if (cubeToken === null) {
      // A door token carries no CUBE token: the session boots on the login
      // it saved when a human last came through, as a restart does; a
      // session that never saved one refuses, and says so on the boot.
      host.restart_begin(identity, username, config.cubeUrl, { kind: 'saved-login' });
      options.log?.(`starting a session for ${username} on its saved login`);
    } else {
      host.spawn_begin(identity, username, config.cubeUrl, cubeToken);
      options.log?.(`starting a session for ${username}`);
    }
    return wantsJson ? answer({ key, mount: `/s/${key}/`, state: 'starting' }) : reply.redirect(`/greet/${key}`, 303);
  });

  app.get('/greet/:key', async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const key: string = (request.params as { key: string }).key;
    if (requestKey_read(request) !== key) {
      return reply.redirect('/login', 302);
    }
    void reply.type('text/html; charset=utf-8');
    return greetPage_render(config.cubeUrl, key);
  });

  // The greeter's two modules: the wire package's own, from where they are
  // installed. Read once; a porter does not restart for a menu upgrade.
  const greeterModules: Record<string, { type: string; source: string }> = {
    'brain.js': { type: 'text/javascript; charset=utf-8', source: readFileSync(fileURLToPath(import.meta.resolve('@fnndsc/menu/logo')), 'utf-8') },
    'ansi.js': { type: 'text/javascript; charset=utf-8', source: readFileSync(fileURLToPath(import.meta.resolve('@fnndsc/menu/ansi')), 'utf-8') },
    // The door wears the surface's own mark on its tab.
    'favicon.svg': { type: 'image/svg+xml', source: FAVICON_SVG },
  };
  app.get('/greeter/:name', async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const name: string = (request.params as { name: string }).name;
    const served: { type: string; source: string } | undefined = greeterModules[name];
    if (served === undefined) {
      return reply.code(404).send({ error: 'no such greeter module' });
    }
    void reply.type(served.type);
    return served.source;
  });

  // A session restarted by its own operator: the old daemon is left the
  // cause and ended, a fresh one boots on the login it saved, and the browser follows
  // the boot on the greeter and comes back in. The cookie names the session
  // and the only session it can name is its own.
  app.post('/restart', async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const wantsJson: boolean = request_wantsJson(request);
    const key: string | null = requestKey_read(request);
    const entry: SessionEntry | null = key !== null ? registry.get(key) : null;
    if (key !== null && entry === null && registry.identity_find(key) !== null) {
      // Already restarting (or booting): a second press joins that boot.
      return wantsJson ? { key, greet: `/greet/${key}`, state: 'restarting' } : reply.redirect(`/greet/${key}`, 303);
    }
    if (key === null || entry === null) {
      return wantsJson ? reply.code(401).send({ error: 'this browser holds no session to restart' }) : reply.redirect('/login', 303);
    }
    // Pending from here: the mount refuses until the fresh berth answers,
    // rather than proxying to a daemon on its way out.
    registry.pending_note(entry.identity, entry.user);
    if (identity_isStratus(entry.identity)) {
      // A stratus session restarts on its owner's credentials, on the tier it had, with the same door to be raised at
      // (a restart without the door left the session READ with no way up: TEAR DOWN · REFUSED, 2026-11-03).
      const configPath: string | null = creds.ociConfig_find(owner_extract(entry.identity));
      if (configPath === null) return wantsJson ? reply.code(404).send({ error: 'no OCI credentials are filed for this session any more' }) : reply.redirect('/login', 303);
      host.stratus_begin(entry.identity, configPath, host.stratus_armed(entry.identity) === true, true, { cubeUrl: config.cubeUrl, user: entry.user });
      options.log?.(`restarting ${entry.user}'s stratus session, asked from their browser`);
      return wantsJson ? { key, greet: `/greet/${key}`, state: 'restarting' } : reply.redirect(`/greet/${key}`, 303);
    }
    host.restart_begin(entry.identity, entry.user, config.cubeUrl, { kind: 'asked' });
    options.log?.(`restarting ${entry.user}'s session, asked from their browser`);
    return wantsJson ? { key, greet: `/greet/${key}`, state: 'restarting' } : reply.redirect(`/greet/${key}`, 303);
  });

  // The switch between a person's sessions: their ChRIS one, which the
  // login made, and their stratus one, started on the credentials filed
  // under their ChRIS identity (docs/stratus.adoc, D14). One cookie, one
  // person: the cookie moves to the session switched to, and nothing here
  // lets one person reach another's.
  const switchSchema = z.object({ to: z.enum(['stratus', 'chris']), cloud: z.literal('oci').optional(), spend: z.boolean().optional() });
  app.post('/switch', async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const key: string | null = requestKey_read(request);
    const identity: string | null = key !== null ? registry.identity_find(key) : null;
    if (key === null || identity === null) return reply.code(401).send({ error: 'this browser holds no session: log in first' });
    const parsed = switchSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'switch wants {to: "stratus" | "chris", cloud?: "oci", spend?: boolean}' });
    const owner: string = owner_extract(identity);
    const user: string = user_extract(identity);
    const cookie = (to: string): void => { void reply.setCookie(DOOR_COOKIE, to, doorCookie_options(config.cookieHours, request.protocol === 'https')); };
    if (parsed.data.to === 'chris') {
      const found: Berth | null = await host.find(owner);
      if (found === null) return reply.code(409).send({ error: `${user}'s ChRIS session is not running: log in again` });
      const back: string = registry.key_derive(owner);
      registry.note(owner, user, found);
      cookie(back);
      return { key: back, mount: `/s/${back}/`, state: 'attached' };
    }
    const configPath: string | null = creds.ociConfig_find(owner);
    if (configPath === null) {
      return reply.code(404).send({ error: `no OCI credentials are filed for ${user} on this host. The host's operator files an existing key with porter --creds ${user} --oci <config>; connecting a new key from here is not built yet` });
    }
    const session: string = stratusIdentity_derive(owner);
    const to: string = registry.key_derive(session);
    const spend: boolean = parsed.data.spend === true;
    const found: Berth | null = await host.find(session);
    const armed: boolean | null = host.stratus_armed(session);
    cookie(to);
    // A session up on the tier asked for is joined; one asked to change tier
    // is ended and started again. One whose tier this porter never knew (it
    // was adopted) is joined read-only and restarted only when spending is asked.
    if (found !== null && (armed === spend || (armed === null && !spend))) {
      // As at the door: a switch never lands on a kernel older than this porter ships. A stratus
      // daemon left up across a release is ended and started again on the tier it had; its jobs
      // go on (the runner resumes them) and its state is kept.
      const behind: string[] = berth_behind(found, installed);
      if (behind.length > 0) {
        options.log?.(`restarting ${user}'s stratus session for the new release (${behind.join(', ')})`);
        registry.pending_note(session, user);
        host.stratus_begin(session, configPath, armed ?? spend, true, { cubeUrl: config.cubeUrl, user });
        return { key: to, mount: `/s/${to}/`, greet: `/greet/${to}`, state: 'starting' };
      }
      registry.note(session, user, found);
      return { key: to, mount: `/s/${to}/`, state: 'attached' };
    }
    registry.pending_note(session, user);
    host.stratus_begin(session, configPath, spend, found !== null, { cubeUrl: config.cubeUrl, user });
    options.log?.(`starting ${user}'s stratus session${spend ? ' with the tasks tier' : ', read-only'}`);
    return { key: to, mount: `/s/${to}/`, greet: `/greet/${to}`, state: 'starting' };
  });

  app.post('/logout', async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    // On a door that starts berths a logout stops the person's berth; its volumes, and so their home, stay.
    const leaving: string | null = options.logoutEnds === true ? requestKey_read(request) : null;
    const identity: string | null = leaving === null ? null : registry.identity_find(leaving);
    if (identity !== null) {
      const ended: boolean = await host.evict(identity, 'end').catch((): boolean => false);
      options.log?.(`${user_extract(identity)} logged out${ended ? '; their berth stopped, its volumes kept' : ''}`);
    }
    void reply.clearCookie(DOOR_COOKIE, { path: '/' });
    return request_wantsJson(request) ? { ok: true } : reply.redirect('/login', 303);
  });

  app.get('/boot/:key', async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const key: string = (request.params as { key: string }).key;
    if (requestKey_read(request) !== key) {
      await reply.code(401).send({ error: 'this browser was not let in to that session' });
      return;
    }
    const identity: string | null = registry.identity_find(key);
    if (identity === null) {
      await reply.code(404).send({ error: 'no session behind that key' });
      return;
    }
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const event_send = (name: string, data: unknown): void => {
      reply.raw.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const followed = host.boot_follow(identity, {
      line: (line: BootLine): void => event_send('line', line),
      done: (state: 'ready' | 'failed', reason?: string): void => {
        void registry.settle(identity, host).then((): void => {
          event_send(state, { reason: reason ?? null });
          reply.raw.end();
        });
      },
    });
    if (followed === null) {
      // A session this porter found rather than started has no boot to
      // show: it is up, which is the only thing a greeter needs to hear.
      event_send('ready', { reason: null });
      reply.raw.end();
      return;
    }
    for (const line of followed.report.lines) event_send('line', line);
    if (followed.report.state !== 'booting') {
      await registry.settle(identity, host);
      event_send(followed.report.state, { reason: followed.report.reason ?? null });
      reply.raw.end();
      return;
    }
    request.raw.once('close', (): void => followed.release());
  });

  // The session itself, over HTTP: the page, its assets, and /vfs. Its own
  // scope, whose bodies go on as streams (relay.ts): a file posted to /vfs
  // is never parsed, held or refused by size here.
  await app.register(async (scope: FastifyInstance): Promise<void> => {
    bodyStream_pass(scope);
    scope.all('/s/:key/*', async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      const split = mountUrl_split(request.url);
      if (split === null || requestKey_read(request) !== split.key) {
        return reply.redirect('/login', 302);
      }
      const entry: SessionEntry | null = registry.get(split.key);
      if (entry === null) {
        return reply.code(404).send({ error: 'no session behind that key' });
      }
      registry.activity_note(entry.key);
      // The deployment's own beeps, when it keeps them, in place of the page's.
      const sound = await soundOverride_read(config.soundsDir, split.rest);
      if (sound !== null) return reply.type(sound.type).header('cache-control', 'private, max-age=3600').send(sound.bytes);
      const target: string = relayTarget_name(split.rest);
      const timeout: number | undefined = relayTimeout_derive(request.method);
      return reply.from(upstreamPath_build(split.rest, entry.berth.token), {
        getUpstream: (): string => berthHttp_derive(entry.berth),
        ...(timeout === undefined ? {} : { timeout }),
        // The status is sent once the answer begins; a stop after that can
        // only be counted and said here, in the porter's own log.
        onResponse: (_request: unknown, _reply: unknown, res: { stream: Readable }): void => {
          const stated: number = Number(reply.getHeader('content-length'));
          void reply.send(answer_watch(res.stream, (sentBytes: number, cause: string): void => {
            options.log?.(`${entry.user}'s session: ${relayBreak_format({ target, sentBytes, statedBytes: Number.isFinite(stated) ? stated : undefined, cause })}`);
          }));
        },
        // The daemon behind the entry did not answer: ask the host who is up
        // now instead of handing the browser a bare 500 for a dead port.
        onError: (_failed: unknown, error: { error: Error }): void => {
          void entry_recover(entry).then((outcome: 'moved' | 'same' | 'gone'): void => {
            if (outcome === 'moved') {
              void reply.redirect(request.url, 307);
            } else if (outcome === 'gone') {
              void reply.redirect(`/login?reason=${encodeURIComponent(SESSION_ENDED)}`, 303);
            } else {
              const said: string = relayFailure_describe(error.error);
              options.log?.(`${entry.user}'s session: ${said}: ${request.method} ${target}`);
              void reply.code(502).send({ error: said });
            }
          });
        },
      });
    });
  });
  app.all('/s/:key', async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // The mount without its slash: the page's relative addresses need the
    // directory, so send the browser to it.
    const key: string = (request.params as { key: string }).key;
    await reply.redirect(`/s/${key}/`, 302);
  });

  // The session's wire: the upgrade is relayed byte for byte to the daemon,
  // with the token on the upgrade URL, which the daemon reads.
  app.addHook('onReady', async (): Promise<void> => {
    app.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
      const split = mountUrl_split(request.url ?? '/');
      const entry: SessionEntry | null = split === null ? null : registry.get(split.key);
      if (split === null || entry === null || cookieKey_read(request.headers.cookie, config.secret) !== split.key) {
        socket.destroy();
        return;
      }
      const target: URL = new URL(entry.berth.url);
      // A wire open is a surface on the session; the idle sweep never ends
      // a session with one, however quiet it is.
      registry.wire_count(entry.key, 1);
      let counted: boolean = true;
      const wire_release = (): void => {
        if (!counted) return;
        counted = false;
        registry.wire_count(entry.key, -1);
      };
      socket.once('close', wire_release);
      const upstream: Socket = net_connect(Number(target.port), target.hostname, (): void => {
        const path: string = upstreamPath_build(split.rest, entry.berth.token);
        const lines: string[] = [`${request.method ?? 'GET'} ${path} HTTP/1.1`];
        for (const [name, value] of Object.entries(request.headers)) {
          lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value ?? ''}`);
        }
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head.length > 0) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on('error', (): void => {
        socket.destroy();
        // The surface reconnects on its own; let it find the live berth.
        void entry_recover(entry);
      });
      upstream.once('close', (): void => { wire_release(); socket.destroy(); });
      socket.on('error', (): void => { upstream.destroy(); });
    });

    // The idle sweep, once a minute for as long as the porter listens.
    const idleMs: number = config.idleHours * 3_600_000;
    const sweep: NodeJS.Timeout = setInterval((): void => {
      void idleSweep_run(registry, host, idleMs, options.log ?? ((): void => undefined));
    }, options.sweepMs ?? 60_000);
    sweep.unref();
    app.addHook('onClose', async (): Promise<void> => { clearInterval(sweep); });
  });

  return { app, registry, adopt, tokens };
}
