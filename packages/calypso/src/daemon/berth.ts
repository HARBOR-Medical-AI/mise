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
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { CLOSING_CAUSES, type ClosingCause } from '@fnndsc/menu';
import { homedir, tmpdir } from 'os';
import { createHash } from 'node:crypto';
import { connect as net_connect, type Socket } from 'node:net';

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
  const schemeSplit: number = cubeUrl.indexOf('://');
  let normalisedUrl: string;
  if (schemeSplit === -1) {
    normalisedUrl = cubeUrl;
  } else {
    const scheme: string = cubeUrl.slice(0, schemeSplit).toLowerCase();
    const rest: string = cubeUrl.slice(schemeSplit + 3);
    // Lowercase only the authority (host[:port]); leave the path exactly as
    // written, including the trailing slash CUBE requires.
    const pathStart: number = rest.indexOf('/');
    const authority: string = pathStart === -1 ? rest : rest.slice(0, pathStart);
    const path: string = pathStart === -1 ? '' : rest.slice(pathStart);
    normalisedUrl = `${scheme}://${authority.toLowerCase()}${path}`;
  }
  return `${user}@${normalisedUrl}`;
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
  const runtimeDir: string = process.env.XDG_RUNTIME_DIR || tmpdir();
  return join(runtimeDir, BERTH_SUBDIR);
}

/**
 * Ensures the berth directory exists, owner-only (`0700`).
 */
function berthDir_ensure(): void {
  mkdirSync(berthDir_path(), { recursive: true, mode: 0o700 });
}

/**
 * The absolute path of one identity's berth file.
 *
 * @param identity - A normalised identity from {@link identity_normalise}.
 * @returns The berth file path (may not exist).
 */
export function berth_path(identity: string): string {
  return berth_pathIn(process.env.XDG_RUNTIME_DIR || tmpdir(), identity);
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
 */
export function berth_write(berth: Berth): void {
  berthDir_ensure();
  writeFileSync(berth_path(berth.identity), JSON.stringify(berth), { mode: 0o600 });
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
    typeof (parsed as Berth).token === 'string'
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
  if (!existsSync(path)) {
    return null;
  }
  try {
    const berth: Berth | null = berth_validate(JSON.parse(readFileSync(path, 'utf-8')));
    return berth && berth.identity === identity ? berth : null;
  } catch (error: unknown) {
    // A corrupt berth file reading as "no daemon" sends the user down a
    // confusing start-a-new-daemon path; name the file so it can be removed.
    const msg: string = error instanceof Error ? error.message : String(error);
    console.error(`[!] Ignoring unreadable berth file ${path}: ${msg}`);
    return null;
  }
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
    for (const located of berthDir_read(dir)) {
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
 * Reads every well-formed berth in one directory.
 *
 * @param dir - The directory.
 * @returns Its berths, each with its file.
 */
function berthDir_read(dir: string): LocatedBerth[] {
  if (!existsSync(dir)) {
    return [];
  }
  const berths: LocatedBerth[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(BERTH_FILE_PREFIX) || !name.endsWith('.json')) {
      continue;
    }
    try {
      const berth: Berth | null = berth_validate(JSON.parse(readFileSync(join(dir, name), 'utf-8')));
      if (berth) {
        berths.push({ berth, path: join(dir, name) });
      }
    } catch (error: unknown) {
      // Skipped, but named: a corrupted berth silently vanishing from the
      // --remote picker is indistinguishable from a stopped daemon.
      const msg: string = error instanceof Error ? error.message : String(error);
      console.error(`[!] Skipping unreadable berth file ${join(dir, name)}: ${msg}`);
    }
  }
  return berths;
}

/**
 * Removes an identity's berth file if present (used to reap a berth whose
 * daemon a liveness probe found dead).
 *
 * @param identity - A normalised identity from {@link identity_normalise}.
 */
export function berth_remove(identity: string): void {
  const path: string = berth_path(identity);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // Already gone: the reap is a best-effort convenience.
    }
  }
}

/**
 * Reports whether something is listening at a berth's WebSocket address, by a
 * plain TCP connect — no WebSocket handshake, so this stays within the daemon
 * package (which has no client). It is the liveness check `daemon_launch` uses
 * to refuse starting a rival for an identity that is already hosted; a surface's
 * resolver uses a stronger handshake probe for attach.
 *
 * @param url - A `ws://host:port` berth URL.
 * @param timeoutMs - How long to wait for the TCP connect (default 500 ms).
 * @returns True when the port accepts a connection.
 */
export function berthUrl_isAlive(url: string, timeoutMs: number = 500): Promise<boolean> {
  return new Promise((resolve: (alive: boolean) => void): void => {
    let host: string;
    let port: number;
    try {
      const parsed: URL = new URL(url);
      host = parsed.hostname;
      port = Number(parsed.port);
    } catch {
      resolve(false);
      return;
    }
    if (!port) {
      resolve(false);
      return;
    }
    const socket: Socket = net_connect({ host, port });
    const settle = (alive: boolean): void => {
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', (): void => settle(true));
    socket.once('timeout', (): void => settle(false));
    socket.once('error', (): void => settle(false));
  });
}

/**
 * A probe that reports whether a berth's daemon is actually reachable. The
 * surface supplies one backed by its attach client; the local resolver uses it
 * to reap dead berths on read.
 */
export type BerthLivenessProbe = (berth: Berth) => Promise<boolean>;

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
   * @returns The live berths, dead ones reaped.
   */
  list(): Promise<Berth[]>;
}

/**
 * The tier-1 resolver: reads identity-keyed berth files and, when given a
 * liveness probe, reaps any berth whose daemon has gone (passive cleanup — the
 * next read of a stale berth removes it). Without a probe it returns berths as
 * recorded, trusting the caller's own attach to surface a dead one.
 */
export class LocalBerthResolver implements BerthResolver {
  /**
   * @param liveness_probe - Optional reachability probe; when present, dead
   *   berths are reaped and never returned.
   */
  constructor(private readonly liveness_probe?: BerthLivenessProbe) {}

  /** @inheritdoc */
  public async resolve(identity: string): Promise<Berth | null> {
    const berth: Berth | null = berth_read(identity);
    if (!berth) {
      return null;
    }
    if (this.liveness_probe && !(await this.liveness_probe(berth))) {
      berth_remove(berth.identity);
      return null;
    }
    return berth;
  }

  /** @inheritdoc */
  public async list(): Promise<Berth[]> {
    return (await this.listLocated()).map((located: LocatedBerth): Berth => located.berth);
  }

  /**
   * Every live berth with the record it was read from.
   *
   * @returns The berths and their files; dead ones reaped when a probe is present.
   */
  public async listLocated(): Promise<LocatedBerth[]> {
    const berths: LocatedBerth[] = berthAllLocated_read();
    if (!this.liveness_probe) {
      return berths;
    }
    const live: LocatedBerth[] = [];
    for (const located of berths) {
      if (await this.liveness_probe(located.berth)) {
        live.push(located);
      } else {
        berth_remove(located.berth.identity);
      }
    }
    return live;
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
 */
export function closing_write(runtimeDir: string, identity: string, cause: ClosingCause): void {
  const path: string = closing_pathIn(runtimeDir, identity);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ cause, at: Date.now() })}\n`, { mode: 0o600 });
}

/** How long a left reason stays believable; an older one is a leftover. */
const CLOSING_FRESH_MS: number = 60_000;

/**
 * Takes the reason a host left for this daemon's ending, removing it.
 *
 * @param identity - The daemon's normalised identity.
 * @param runtimeDir - Its runtime directory; this process's by default.
 * @returns The cause, or null when none was left (or it is stale).
 */
export function closing_take(identity: string, runtimeDir: string = process.env.XDG_RUNTIME_DIR || tmpdir()): ClosingCause | null {
  const path: string = closing_pathIn(runtimeDir, identity);
  try {
    const left: { cause?: unknown; at?: unknown } = JSON.parse(readFileSync(path, 'utf-8')) as { cause?: unknown; at?: unknown };
    rmSync(path, { force: true });
    const fresh: boolean = typeof left.at === 'number' && Date.now() - left.at < CLOSING_FRESH_MS;
    return fresh && (CLOSING_CAUSES as readonly unknown[]).includes(left.cause) ? (left.cause as ClosingCause) : null;
  } catch {
    return null;
  }
}
