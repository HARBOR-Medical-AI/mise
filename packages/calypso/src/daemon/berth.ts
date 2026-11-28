/**
 * @file Identity-keyed daemon berths.
 *
 * A *berth* is the advertised location of one running CALYPSO daemon, keyed by
 * the CUBE identity it hosts. It supersedes the single per-OS-user discovery
 * file: several daemons — one per `<user>@<url>` identity — can now advertise on
 * one machine, each in its own file, and a surface resolves the one it wants by
 * identity.
 *
 * The berth records the daemon's WebSocket address and attach token. Files live
 * in the user's runtime directory (`$XDG_RUNTIME_DIR`, else the system temp dir)
 * under an owned `calypso/` subdirectory, `0700` on the directory and `0600` on
 * each file — the same same-user perimeter the single-file discovery used, now
 * multiplied by identity. See docs/session-supervisor.adoc for the design.
 *
 * All berth lookup goes through the {@link BerthResolver} seam so a future
 * network `PorterBerthResolver` can replace the local one without any surface
 * change. Liveness (is the daemon still there?) is supplied to the local
 * resolver as an injected probe, keeping this server-side package free of a
 * WebSocket client: the surface injects a probe backed by its own attach client.
 *
 * @module
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { get as httpGet, type ClientRequest, type IncomingMessage } from 'node:http';
import { get as httpsGet } from 'node:https';
import { connect as net_connect, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { identityName_spell } from '@fnndsc/cumin/identity-epoch';
import { ownFile_read, ownFile_take, ownFile_write, ownFolder_settle, type OwnFolder, type OwnHeld, type OwnRead, type OwnRefusal } from '@fnndsc/fond';
import { CLOSING_CAUSES, type ClosingCause } from '@fnndsc/menu';

// A host that keeps berth folders under a root of its own asks this before it starts (porter's state root).
export { pathTrust_refusal } from '@fnndsc/fond';

/** The prefix of every berth filename, so a directory scan finds only berths. */
const BERTH_FILE_PREFIX: string = 'berth-';
/** The owned subdirectory berths live under, inside the runtime directory. */
const BERTH_SUBDIR: string = 'calypso';

/**
 * The advertised location of one running daemon, keyed by CUBE identity.
 *
 * @property identity - The normalised `<user>@<url>` this daemon hosts; stored
 *   so a resolve can verify an exact match rather than trust the filename hash
 *   alone.
 * @property url - The daemon's WebSocket address (e.g. `ws://127.0.0.1:54321`).
 * @property token - The attach token gating the daemon's handshake.
 * @property pid - The daemon's process id, so a host that did not start it
 *   — a porter restarted under a fleet it adopted — can still end it.
 *   Absent from berths written before it was recorded.
 */
export interface Berth {
  identity: string;
  url: string;
  token: string;
  pid?: number;
  /** The package versions this daemon runs (brasa, calypso, chell, …), so a door can tell an older session from its own code. */
  versions?: Record<string, string>;
  /** When the daemon booted, ISO. */
  booted?: string;
  /** This launch's key for proving which instance answers (`berthInstance_probe`); absent in an earlier release's record. */
  probeKey?: string;
}

/**
 * Normalises a `<user>@<url>` identity lexically — no DNS, no network.
 *
 * The URL scheme and host are lowercased; the trailing slash CUBE requires is
 * preserved; the port and the user's case are kept exactly. Host aliases (a
 * short hostname versus its FQDN) are deliberately *not* merged: that is DNS
 * resolution, not string rewriting, and a key that depends on DNS breaks under
 * load balancers and split-horizon resolution. The rule is "same string, same
 * daemon" — operators adopt one canonical URL per CUBE by convention.
 *
 * @param user - The CUBE username, used with exact case.
 * @param cubeUrl - The CUBE API URL as the user typed it (scheme included).
 * @returns The normalised identity string used as the berth key input.
 */
export function identity_normalise(user: string, cubeUrl: string): string {
  return identityName_spell(user, cubeUrl);
}

/** The reserved identity for a daemon started with no restored CUBE session. */
export const DISCONNECTED_IDENTITY: string = 'disconnected@no-cube';

/**
 * Derives the berth identity for a session, falling back to the reserved
 * disconnected identity when there is no restored user/URL. Both the daemon
 * (writing its berth) and a surface (guarding against a duplicate, or attaching)
 * key on this so they always agree.
 *
 * @param user - The connected CUBE username, or null/undefined when disconnected.
 * @param cubeUrl - The connected CUBE URL, or null/undefined when disconnected.
 * @returns The normalised identity, or {@link DISCONNECTED_IDENTITY}.
 */
export function identity_deriveForSession(user: string | null | undefined, cubeUrl: string | null | undefined): string {
  return user && cubeUrl ? identity_normalise(user, cubeUrl) : DISCONNECTED_IDENTITY;
}

/**
 * Computes the short, filesystem-safe key for a normalised identity.
 *
 * @param identity - A normalised identity from {@link identity_normalise}.
 * @returns The first 16 hex characters of the identity's SHA-256 digest.
 */
export function berthKey_compute(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

/**
 * The directory berths live in: `$XDG_RUNTIME_DIR/calypso` when the runtime
 * directory is set (Linux, per-user `0700`, cleared on logout), else the system
 * temp directory (macOS `TMPDIR` is already per-user-private; Linux `/tmp`).
 *
 * @returns The absolute berth directory path (not guaranteed to exist yet).
 */
export function berthDir_path(): string {
  const runtimeDir: string | undefined = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir) return join(runtimeDir, BERTH_SUBDIR);
  // No runtime directory: a folder of this account's own name under the shared temporary folder, so no other
  // account can hold the name for everyone (held to this account by ownFolder_settle before use).
  return join(tmpdir(), `${BERTH_SUBDIR}-${String(process.getuid?.() ?? 'user')}`);
}

/** The most a berth record may hold. */
const BERTH_MAX_BYTES: number = 64 * 1024;

/** The paths already said to be refused, so each is said once per process. */
const refusalsSaid: Set<string> = new Set();

/**
 * Says, once, why a berth folder or record was refused: its path and what was wrong, never what it holds.
 *
 * @param refused - The refusal.
 */
function refusal_say(refused: OwnRefusal): void {
  if (refusalsSaid.has(refused.reason)) return;
  refusalsSaid.add(refused.reason);
  console.error(`[!] berth record refused: ${refused.reason}`);
}

/**
 * The absolute path of one identity's berth file.
 *
 * @param identity - A normalised identity from {@link identity_normalise}.
 * @returns The berth file path (may not exist).
 */
export function berth_path(identity: string): string {
  return join(berthDir_path(), `${BERTH_FILE_PREFIX}${berthKey_compute(identity)}.json`);
}

/**
 * The path of one identity's berth file under a given runtime directory.
 *
 * A host that keeps several daemons, each in a runtime directory of its
 * own — the porter, one directory per identity — reads their berths from
 * where it put them rather than from its own environment.
 *
 * @param runtimeDir - The runtime directory the daemon was started with.
 * @param identity - A normalised identity from {@link identity_normalise}.
 * @returns The berth file path (may not exist).
 */
export function berth_pathIn(runtimeDir: string, identity: string): string {
  return join(runtimeDir, BERTH_SUBDIR, `${BERTH_FILE_PREFIX}${berthKey_compute(identity)}.json`);
}

/**
 * Writes a berth to its identity-keyed file, readable only by the current user.
 *
 * @param berth - The berth to advertise; its `identity` must be normalised.
 * @throws {Error} When the berth folder is not this account's own, or a record that is not stands at the name.
 */
export function berth_write(berth: Berth): void {
  const held: OwnFolder | OwnRefusal = ownFolder_settle(berthDir_path(), true);
  if (!held.ok) throw new Error(`the berth folder is not this account's own: ${held.reason}`);
  // In the folder as held (its resolved path), by rename over the name: a valid standing record is replaced whole,
  // anything else at the name refused untouched.
  const written: OwnHeld | OwnRefusal = ownFile_write(held.path, basename(berth_path(berth.identity)), JSON.stringify(berth));
  if (!written.ok) throw new Error(`the berth record could not be written: ${written.reason}`);
}

/**
 * Whether a record that carries a probe key carries all an instance proof is made over: a key of 32 hex bytes, a
 * pid and a boot time. An earlier release's record carries no key and is whole as it is.
 *
 * @param berth - The record.
 * @returns True when whole.
 */
function keyedFacts_areWhole(berth: Berth): boolean {
  if (berth.probeKey === undefined) return true;
  return typeof berth.probeKey === 'string' && HEX_32.test(berth.probeKey) && Number.isSafeInteger(berth.pid) && typeof berth.booted === 'string';
}

/**
 * Validates that an unknown parsed value is a well-formed {@link Berth}.
 *
 * @param parsed - The value read from a berth file.
 * @returns The value as a Berth, or null when it is malformed.
 */
function berth_validate(parsed: unknown): Berth | null {
  if (
    typeof parsed === 'object' && parsed !== null &&
    typeof (parsed as Berth).identity === 'string' &&
    typeof (parsed as Berth).url === 'string' &&
    typeof (parsed as Berth).token === 'string' &&
    berthUrl_target((parsed as Berth).url) !== null &&
    keyedFacts_areWhole(parsed as Berth)
  ) {
    return parsed as Berth;
  }
  return null;
}

/**
 * Reads one identity's berth from disk, verifying the stored identity matches
 * exactly (so a hash collision can never mis-route).
 *
 * @param identity - A normalised identity from {@link identity_normalise}.
 * @returns The berth, or null when none is advertised or it is malformed.
 */
export function berth_read(identity: string): Berth | null {
  // This runtime's own berth first; then a porter's session for the same
  // identity, which keeps its berth under the porter's state (a session a
  // browser login started is attached to as any other).
  for (const path of berthPaths_list(identity)) {
    const berth: Berth | null = berthFile_read(path, identity);
    if (berth !== null) return berth;
  }
  return null;
}

/**
 * Reads this runtime's own berth for an identity, never a porter's: what a
 * daemon starting here checks so as not to host a rival to one of its own.
 * A porter's session is its own runtime, and starting beside it is allowed.
 *
 * @param identity - A normalised identity.
 * @returns The berth, or null.
 */
export function berthOwn_read(identity: string): Berth | null {
  return berthFile_read(berth_path(identity), identity);
}

/**
 * The state directories a porter on this machine keeps its sessions under,
 * in the order looked: the porter's own setting, the user's state directory
 * (a porter run as this user), the system one (a porter run as a service).
 *
 * @returns The candidate roots.
 */
export function porterStateRoots_get(): string[] {
  const roots: string[] = [];
  if (process.env.PORTER_STATE_DIR) roots.push(process.env.PORTER_STATE_DIR);
  roots.push(join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'porter'));
  roots.push('/var/lib/porter/sessions');
  return [...new Set(roots)];
}

/**
 * Where an identity's berth may be: this runtime's directory, then each
 * porter root's session runtime (`<root>/<key>/run`, porter's own layout).
 *
 * @param identity - A normalised identity.
 * @returns The candidate paths.
 */
export function berthPaths_list(identity: string): string[] {
  return [
    berth_path(identity),
    ...porterStateRoots_get().map((root: string): string => berth_pathIn(join(root, berthKey_compute(identity), 'run'), identity)),
  ];
}

/**
 * Reads one berth file, when it exists and names the identity.
 *
 * @param path - The file.
 * @param identity - The identity it must name.
 * @returns The berth, or null.
 */
function berthFile_read(path: string, identity: string): Berth | null {
  const berth: Berth | null = berthRecord_read(path);
  return berth !== null && berth.identity === identity ? berth : null;
}

/**
 * Reads a berth record held to this account: its folder through a trusted path, owner-only, never made by a
 * reader; the record a regular 0600 file of this account's, bounded. A missing folder or record is no berth; one
 * refused is said once (its path and why) and is no berth either.
 *
 * @param path - The record.
 * @returns The berth, or null.
 *
 * @example
 * ```ts
 * const berth: Berth | null = berthRecord_read(berth_path(identity));
 * ```
 */
export function berthRecord_read(path: string): Berth | null {
  const folder: OwnFolder | OwnRefusal = ownFolder_settle(dirname(path), false);
  if (!folder.ok) {
    if (folder.missing !== true) refusal_say(folder);
    return null;
  }
  return berthRecordIn_read(folder.path, basename(path));
}

/**
 * Reads one berth record in a folder already held (`ownFolder_settle`), by the held folder's resolved path.
 *
 * @param folder - The held folder's `path`.
 * @param name - The record's name.
 * @returns The berth, or null (a refusal other than absence said once).
 */
function berthRecordIn_read(folder: string, name: string): Berth | null {
  const path: string = join(folder, name);
  const read: OwnRead = ownFile_read(path, BERTH_MAX_BYTES);
  if (!read.ok) {
    if (read.missing !== true) refusal_say(read);
    return null;
  }
  let berth: Berth | null;
  try {
    berth = berth_validate(JSON.parse(read.text));
  } catch {
    berth = null;
  }
  if (berth === null) refusal_say({ ok: false, reason: `${path}: not a berth record` });
  return berth;
}

/**
 * Reads every advertised berth in the berth directory.
 *
 * @returns All well-formed berths; an empty array when the directory is absent
 *   or holds none.
 */
export function berthAll_read(): Berth[] {
  return berthAllLocated_read().map((located: LocatedBerth): Berth => located.berth);
}

/** A berth and the file it was read from. */
export interface LocatedBerth {
  /** The berth. */
  readonly berth: Berth;
  /** The record that holds it: this runtime's, or a porter session's. */
  readonly path: string;
}

/**
 * Reads every advertised berth with the file each was read from.
 *
 * A berth is found in this runtime's directory or in a porter session's,
 * so the file is not something an identity alone gives back: a listing
 * that must name where a berth's token is kept names this path.
 *
 * @returns All well-formed berths, one per identity, each with its record's path.
 */
export function berthAllLocated_read(): LocatedBerth[] {
  const found: LocatedBerth[] = [];
  // This runtime's berths, then each porter session's, one per identity.
  for (const dir of [berthDir_path(), ...porterSessionDirs_get()]) {
    for (const located of berthFolder_read(dir)) {
      if (!found.some((one: LocatedBerth): boolean => one.berth.identity === located.berth.identity)) found.push(located);
    }
  }
  return found;
}

/**
 * The berth directories of every porter session this user can read.
 *
 * @returns The directories.
 */
function porterSessionDirs_get(): string[] {
  const dirs: string[] = [];
  for (const root of porterStateRoots_get()) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(join(root, entry.name, 'run', BERTH_SUBDIR));
      }
    } catch {
      // No porter here, or not one this user may read.
    }
  }
  return dirs;
}

/**
 * Reads every well-formed berth in one folder, held to this account first (`ownFolder_settle`); a refused
 * folder, a folder that cannot be listed, and a refused record are each said once and passed over.
 *
 * @param dir - The folder.
 * @returns Its berths, each with its file (by the folder's resolved path).
 *
 * @example
 * ```ts
 * const found: LocatedBerth[] = berthFolder_read(join(runtime, 'calypso'));
 * ```
 */
export function berthFolder_read(dir: string): LocatedBerth[] {
  const folder: OwnFolder | OwnRefusal = ownFolder_settle(dir, false);
  if (!folder.ok) {
    if (folder.missing !== true) refusal_say(folder);
    return [];
  }
  const berths: LocatedBerth[] = [];
  let names: string[];
  try {
    names = readdirSync(folder.path);
  } catch (error: unknown) {
    refusal_say({ ok: false, reason: `${folder.path}: could not be listed (${error instanceof Error ? error.message : String(error)})` });
    return [];
  }
  for (const name of names) {
    if (!name.startsWith(BERTH_FILE_PREFIX) || !name.endsWith('.json')) continue;
    // Skipped, but said (once): a refused or unreadable record vanishing silently is indistinguishable from a stopped daemon.
    const berth: Berth | null = berthRecordIn_read(folder.path, name);
    if (berth !== null) berths.push({ berth, path: join(folder.path, name) });
  }
  return berths;
}

/**
 * What a probe learnt of a berth's daemon.
 *
 * @example
 * ```ts
 * const liveness: BerthLiveness = await berthInstance_probe(berth);
 * ```
 */
export type BerthLiveness =
  /** The recorded instance answered with its proof. */
  | 'live'
  /** Nothing of it is there: a refused connection, or (for a keyed record) an answer that is not its proof. */
  | 'dead'
  /** A record of an earlier release, with no key to prove by, whose address did not refuse: it may be running. */
  | 'unverified';

/** What the instance proof covers, and its version. */
const INSTANCE_PROOF_LABEL: string = 'calypso-instance-v1';

/** A probe's nonce, and a launch's probe key: 32 bytes, lowercase hex. */
const HEX_32: RegExp = /^[0-9a-f]{64}$/;

/** How long a probe waits for an answer. */
const PROBE_TIMEOUT_MS: number = 1500;

/**
 * A fresh key for this launch's instance proof.
 *
 * @returns 32 random bytes, lowercase hex.
 *
 * @example
 * ```ts
 * const berth: Berth = { ...facts, probeKey: probeKey_generate() };
 * ```
 */
export function probeKey_generate(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Whether a string is a probe nonce: exactly 64 lowercase hex characters, so nothing else enters the proof.
 *
 * @param nonce - What was asked with.
 * @returns True when it is one.
 *
 * @example
 * ```ts
 * if (!nonce_isValid(asked)) respond(400);
 * ```
 */
export function nonce_isValid(nonce: unknown): nonce is string {
  return typeof nonce === 'string' && HEX_32.test(nonce);
}

/**
 * The facts of one running daemon a proof is made over.
 *
 * @example
 * ```ts
 * const facts: InstanceFacts = { probeKey, identity, pid: process.pid, booted };
 * ```
 */
export interface InstanceFacts {
  /** The launch's probe key, hex. */
  probeKey: string;
  /** The identity it serves. */
  identity: string;
  /** Its process id. */
  pid: number;
  /** When it booted, ISO. */
  booted: string;
}

/**
 * The proof that a daemon is the instance a record names: HMAC-SHA256 under the launch's probe key over the label,
 * the nonce, the identity, the pid and the boot time, one per line. Neither the key nor the token travels.
 *
 * @param facts - The instance's facts.
 * @param nonce - The probe's nonce.
 * @returns The proof, hex.
 *
 * @example
 * ```ts
 * const proof: string = instanceProof_compute(facts, nonce);
 * ```
 */
export function instanceProof_compute(facts: InstanceFacts, nonce: string): string {
  return createHmac('sha256', Buffer.from(facts.probeKey, 'hex'))
    .update(`${INSTANCE_PROOF_LABEL}\n${nonce}\n${facts.identity}\n${String(facts.pid)}\n${facts.booted}`)
    .digest('hex');
}

/**
 * A record's instance facts, when it holds a key to prove by.
 *
 * @param berth - The record.
 * @returns Its facts, or null for an earlier release's record.
 */
function instanceFacts_read(berth: Berth): InstanceFacts | null {
  if (berth.probeKey === undefined || berth.pid === undefined || berth.booted === undefined) return null;
  return { probeKey: berth.probeKey, identity: berth.identity, pid: berth.pid, booted: berth.booted };
}

/**
 * A berth address: what a connection is made to, and the origin a probe is asked at.
 *
 * @example
 * ```ts
 * const target: BerthTarget | null = berthUrl_target(berth.url);
 * ```
 */
export interface BerthTarget {
  /** The host as `net.connect` takes it (an IPv6 address without brackets). */
  host: string;
  /** The port, a scheme's default filled in. */
  port: number;
  /** `ws:` or `wss:`. */
  secure: boolean;
  /** The `http(s)://host[:port]` origin the instance route is asked at; nothing else of the URL goes. */
  origin: string;
}

/** How a plain connection to an address went. */
export type ConnectOutcome = 'accepted' | 'refused' | 'inconclusive';

/**
 * A berth URL's address: a `ws:` or `wss:` URL with a host and no credentials, its scheme's default port filled
 * in. Anything else names no daemon a berth could record.
 *
 * @param url - The URL.
 * @returns The address, or null.
 *
 * @example
 * ```ts
 * berthUrl_target('ws://[::1]:4000'); // { host: '::1', port: 4000, secure: false, origin: 'http://[::1]:4000' }
 * ```
 */
export function berthUrl_target(url: string): BerthTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
  if (parsed.username !== '' || parsed.password !== '' || parsed.hostname === '') return null;
  const secure: boolean = parsed.protocol === 'wss:';
  const port: number = parsed.port === '' ? (secure ? 443 : 80) : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const bracketed: boolean = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']');
  const host: string = bracketed ? parsed.hostname.slice(1, -1) : parsed.hostname;
  return { host, port, secure, origin: `${secure ? 'https' : 'http'}://${parsed.host}` };
}

/**
 * Connects to a berth's address and says how it went, no handshake, within one deadline. Only a refusal means
 * nothing is there; a timeout, a name that does not resolve, an address that names no daemon, or any other failure
 * is inconclusive.
 *
 * @param url - A `ws://host:port` berth URL.
 * @param timeoutMs - The deadline for the whole attempt.
 * @returns How it went.
 *
 * @example
 * ```ts
 * if ((await berthUrl_connect(berth.url)) === 'refused') startHere();
 * ```
 */
export function berthUrl_connect(url: string, timeoutMs: number = 500): Promise<ConnectOutcome> {
  return new Promise((resolve: (outcome: ConnectOutcome) => void): void => {
    const target: BerthTarget | null = berthUrl_target(url);
    if (target === null) {
      resolve('inconclusive');
      return;
    }
    const socket: Socket = net_connect({ host: target.host, port: target.port });
    const deadline: NodeJS.Timeout = setTimeout((): void => { outcome_settle('inconclusive'); }, timeoutMs);
    /**
     * Settles once: the deadline cleared, the socket closed.
     *
     * @param outcome - How it went.
     */
    function outcome_settle(outcome: ConnectOutcome): void {
      clearTimeout(deadline);
      socket.destroy();
      resolve(outcome);
    }
    socket.once('connect', (): void => { outcome_settle('accepted'); });
    socket.once('error', (error: NodeJS.ErrnoException): void => { outcome_settle(error.code === 'ECONNREFUSED' ? 'refused' : 'inconclusive'); });
  });
}

/** An instance request answered: its HTTP status and body. */
interface InstanceReply {
  /** The status. */
  status: number;
  /** The body, at most `INSTANCE_BODY_MAX` bytes. */
  body: string;
}

/** An instance request that got no answer: how the connection failed. */
interface InstanceSilence {
  /** How it failed. */
  failed: ConnectOutcome;
}

/** An instance answer's body, as sent: its proof is checked before it is believed. */
interface InstanceProofBody {
  /** The proof, if any. */
  proof?: unknown;
}

/** What one instance request gave. */
type InstanceAnswer = InstanceReply | InstanceSilence;

/** The most an instance answer may hold; a proof answer is under 100 bytes. */
const INSTANCE_BODY_MAX: number = 1024;

/**
 * Asks an address for its instance proof: `GET <origin>/instance?nonce=<nonce>`, built from the address's origin
 * and the nonce alone, with no pooled socket, within one deadline for the whole exchange, the body bounded (more
 * is no answer).
 *
 * @param target - The address.
 * @param nonce - The nonce.
 * @returns The answer, or how the connection failed.
 */
function instance_ask(target: BerthTarget, nonce: string): Promise<InstanceAnswer> {
  return new Promise((resolve: (answer: InstanceAnswer) => void): void => {
    const request_get: typeof httpGet = target.secure ? httpsGet : httpGet;
    let request: ClientRequest | null = null;
    const deadline: NodeJS.Timeout = setTimeout((): void => { answer_settle({ failed: 'inconclusive' }); }, PROBE_TIMEOUT_MS);
    /**
     * Settles once: the deadline cleared, the request ended.
     *
     * @param answer - What was had.
     */
    function answer_settle(answer: InstanceAnswer): void {
      clearTimeout(deadline);
      request?.destroy();
      resolve(answer);
    }
    request = request_get(`${target.origin}/instance?nonce=${nonce}`, { agent: false }, (response: IncomingMessage): void => {
      const chunks: Buffer[] = [];
      let size: number = 0;
      response.on('data', (chunk: Buffer): void => {
        size += chunk.length;
        if (size > INSTANCE_BODY_MAX) {
          answer_settle({ failed: 'inconclusive' });
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', (): void => {
        if (size > INSTANCE_BODY_MAX) return;
        answer_settle({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
      // Cut short: no answer. A settled promise ignores this after an end.
      response.on('close', (): void => { answer_settle({ failed: 'inconclusive' }); });
    });
    request.on('error', (error: NodeJS.ErrnoException): void => { answer_settle({ failed: error.code === 'ECONNREFUSED' ? 'refused' : 'inconclusive' }); });
  });
}

/**
 * Whether a berth's recorded daemon is running. A keyed record is live only when its address answers a fresh nonce
 * with the proof the record's key gives for that instance (identity, pid, boot time); anything else is dead. An
 * earlier release's record has no key: a refused connection means it is gone, anything else leaves it unverified
 * (never grounds to start beside it or adopt it).
 *
 * @param berth - The record.
 * @returns What was learnt.
 *
 * @example
 * ```ts
 * if ((await berthInstance_probe(berth)) === 'live') attach(berth);
 * ```
 */
export async function berthInstance_probe(berth: Berth): Promise<BerthLiveness> {
  const facts: InstanceFacts | null = instanceFacts_read(berth);
  if (facts === null) return (await berthUrl_connect(berth.url)) === 'refused' ? 'dead' : 'unverified';
  const target: BerthTarget | null = berthUrl_target(berth.url);
  if (target === null) return 'dead';
  const nonce: string = randomBytes(32).toString('hex');
  const answer: InstanceAnswer = await instance_ask(target, nonce);
  if ('failed' in answer || answer.status !== 200) return 'dead';
  let proof: unknown;
  try {
    proof = (JSON.parse(answer.body) as InstanceProofBody).proof;
  } catch {
    return 'dead';
  }
  if (typeof proof !== 'string' || !HEX_32.test(proof)) return 'dead';
  return timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(instanceProof_compute(facts, nonce), 'hex')) ? 'live' : 'dead';
}

/**
 * A probe that says whether a berth's daemon is running. The local resolver uses one to pass over a record whose
 * daemon has gone; a test supplies a double.
 */
export type BerthLivenessProbe = (berth: Berth) => Promise<BerthLiveness>;

/**
 * A berth, the record it was read from, and what a probe learnt of it.
 *
 * @example
 * ```ts
 * for (const { berth, liveness } of await resolver.probed_list()) say(berth.identity, liveness);
 * ```
 */
export interface ProbedBerth extends LocatedBerth {
  /** What the probe learnt. */
  readonly liveness: BerthLiveness;
}

/**
 * The berth lookup seam. Tier 1 ships {@link LocalBerthResolver} over the local
 * files; a future tier-2 `PorterBerthResolver` will implement the same contract
 * over the network. Every surface depends only on this interface.
 */
export interface BerthResolver {
  /**
   * Resolves one identity to a live berth.
   *
   * @param identity - A normalised identity from {@link identity_normalise}.
   * @returns The live berth, or null when none is advertised or it is dead.
   */
  resolve(identity: string): Promise<Berth | null>;
  /**
   * Lists every live berth (for a bare `--remote` with several daemons).
   *
   * @returns The live berths.
   */
  list(): Promise<Berth[]>;
}

/**
 * The tier-1 resolver: reads identity-keyed berth records and, given a probe, walks every record of an identity in
 * order (this runtime's, then each porter session's), probing each before one is chosen, so a dead record never
 * hides a live one behind it. Nothing is removed: a dead record is passed over and the next daemon of its identity
 * replaces it. Without a probe it returns records as written, trusting the caller's own attach to find a dead one.
 */
export class LocalBerthResolver implements BerthResolver {
  /**
   * @param liveness_probe - Optional probe; when present, only live berths are returned.
   */
  constructor(private readonly liveness_probe?: BerthLivenessProbe) {}

  /** @inheritdoc */
  public async resolve(identity: string): Promise<Berth | null> {
    for (const path of berthPaths_list(identity)) {
      const berth: Berth | null = berthFile_read(path, identity);
      if (berth === null) continue;
      if (!this.liveness_probe || (await this.liveness_probe(berth)) === 'live') return berth;
    }
    return null;
  }

  /** @inheritdoc */
  public async list(): Promise<Berth[]> {
    return (await this.listLocated()).map((located: LocatedBerth): Berth => located.berth);
  }

  /**
   * Every live berth with the record it was read from, one per identity.
   *
   * @returns The berths and their files.
   */
  public async listLocated(): Promise<LocatedBerth[]> {
    return (await this.probed_list())
      .filter((one: ProbedBerth): boolean => one.liveness === 'live')
      .map((one: ProbedBerth): LocatedBerth => ({ berth: one.berth, path: one.path }));
  }

  /**
   * Every record with what a probe learnt of it, one per identity: the first live record of each identity, else
   * its first unverified one (an earlier release's daemon that may still run), else none. Without a probe, the
   * first record of each identity, as written, counted live.
   *
   * @returns The probed berths.
   *
   * @example
   * ```ts
   * const rows: ProbedBerth[] = await new LocalBerthResolver(berthInstance_probe).probed_list();
   * ```
   */
  public async probed_list(): Promise<ProbedBerth[]> {
    const chosen: Map<string, ProbedBerth> = new Map();
    for (const dir of [berthDir_path(), ...porterSessionDirs_get()]) {
      for (const located of berthFolder_read(dir)) {
        const held: ProbedBerth | undefined = chosen.get(located.berth.identity);
        if (held?.liveness === 'live') continue;
        const liveness: BerthLiveness = this.liveness_probe ? await this.liveness_probe(located.berth) : 'live';
        if (liveness === 'dead' || (held !== undefined && liveness !== 'live')) continue;
        chosen.set(located.berth.identity, { ...located, liveness });
      }
    }
    return [...chosen.values()];
  }
}

/** The file beside a berth that says why its daemon is being ended. */
const CLOSING_FILE_PREFIX: string = 'closing-';

/**
 * Where a host leaves the reason it is ending an identity's daemon: beside
 * the berth, in the same runtime directory.
 *
 * @param runtimeDir - The runtime directory the daemon writes its berth in.
 * @param identity - The normalised identity.
 * @returns The path.
 */
export function closing_pathIn(runtimeDir: string, identity: string): string {
  return join(runtimeDir, BERTH_SUBDIR, `${CLOSING_FILE_PREFIX}${berthKey_compute(identity)}.json`);
}

/**
 * Leaves the reason an identity's daemon is about to be ended, for the
 * daemon to read when the signal arrives and tell its surfaces.
 *
 * @param runtimeDir - The daemon's runtime directory.
 * @param identity - The normalised identity.
 * @param cause - Why: `restart` or `end`.
 * @throws {Error} When the folder is not this account's own, or a note that is not stands at the name.
 */
export function closing_write(runtimeDir: string, identity: string, cause: ClosingCause): void {
  const path: string = closing_pathIn(runtimeDir, identity);
  const held: OwnFolder | OwnRefusal = ownFolder_settle(dirname(path), true);
  if (!held.ok) throw new Error(`the berth folder is not this account's own: ${held.reason}`);
  const written: OwnHeld | OwnRefusal = ownFile_write(held.path, basename(path), `${JSON.stringify({ cause, at: Date.now() })}\n`);
  if (!written.ok) throw new Error(`the closing note could not be written: ${written.reason}`);
}

/** How long a left reason stays believable; an older one is a leftover. */
const CLOSING_FRESH_MS: number = 60_000;

/**
 * Takes the reason a host left for this daemon's ending: renamed aside and read once, never put back.
 *
 * @param identity - The daemon's normalised identity.
 * @param runtimeDir - Its runtime directory; by default this process's berth folder's.
 * @returns The cause, or null when none was left (or it is stale, or refused).
 */
export function closing_take(identity: string, runtimeDir?: string): ClosingCause | null {
  const path: string = runtimeDir !== undefined ? closing_pathIn(runtimeDir, identity) : join(berthDir_path(), basename(closing_pathIn('', identity)));
  const held: OwnFolder | OwnRefusal = ownFolder_settle(dirname(path), false);
  if (!held.ok) return null;
  const taken: OwnRead = ownFile_take(held.path, basename(path), 4096);
  if (!taken.ok) return null;
  try {
    const left: { cause?: unknown; at?: unknown } = JSON.parse(taken.text) as { cause?: unknown; at?: unknown };
    const fresh: boolean = typeof left.at === 'number' && Date.now() - left.at < CLOSING_FRESH_MS;
    return fresh && (CLOSING_CAUSES as readonly unknown[]).includes(left.cause) ? (left.cause as ClosingCause) : null;
  } catch {
    return null;
  }
}
