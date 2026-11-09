/**
 * @file The seam between the door and wherever sessions run.
 *
 * On one host a session is a child process in four directories of its own;
 * on a cluster it is a pod with a volume. The porter never knows which: it
 * asks the host to find an identity's session, to start one with a token,
 * and to end one, and it gets back a berth — an address and an attach
 * token — either way. This is the `BerthResolver` seam of tier 1 walked
 * through: the surface's attach path did not change for identity-keyed
 * daemons, and the door's does not change for pods.
 *
 * @module
 */
import type { Berth } from '@fnndsc/calypso/berth';

export type { Berth };

/**
 * One person's berth as the operator reads it: whether it is up and what it
 * uses, or that it is stopped and their home is kept. A person with neither
 * a berth nor a home is absent.
 */
export interface BerthAccess {
  readonly user: string;
  readonly state: 'running' | 'stopped';
  /** The cohort a running berth holds (`none` for no cohort); null when stopped. */
  readonly cohort: string | null;
  /** CPU use, as a percent of one CPU, from one engine sample; null when stopped. */
  readonly cpuPercent: number | null;
  /** Memory in use, less the page cache; null when stopped. */
  readonly memoryBytes: number | null;
  /** The memory the berth may use; null when stopped. */
  readonly memoryLimitBytes: number | null;
}

/** How a person's stratus session is named, beside their ChRIS one. */
const STRATUS_PREFIX: string = 'stratus:oci@';

/**
 * The identity of a person's stratus session: theirs, marked for the cloud.
 * Its directories and its key follow from it as any session's do.
 *
 * @param owner - The person's ChRIS identity (`<user>@<cube url>`).
 * @returns `stratus:oci@<user>@<cube url>`.
 */
export function stratusIdentity_derive(owner: string): string {
  return `${STRATUS_PREFIX}${owner}`;
}

/**
 * The ChRIS identity a session belongs to: itself for a ChRIS session, its
 * owner's for a stratus one.
 *
 * @param identity - A session's identity.
 * @returns The person's ChRIS identity.
 */
export function owner_extract(identity: string): string {
  return identity.startsWith(STRATUS_PREFIX) ? identity.slice(STRATUS_PREFIX.length) : identity;
}

/**
 * Whether a session is a stratus one.
 *
 * @param identity - A session's identity.
 * @returns True for `stratus:oci@…`.
 */
export function identity_isStratus(identity: string): boolean {
  return identity.startsWith(STRATUS_PREFIX);
}

/**
 * The CUBE username a session belongs to.
 *
 * @param identity - A session's identity.
 * @returns The user.
 */
export function user_extract(identity: string): string {
  const owner: string = owner_extract(identity);
  return owner.slice(0, owner.indexOf('@'));
}

/** One line of a session's boot, as the host saw it. */
export interface BootLine {
  /** Which stream it came off. */
  channel: 'out' | 'err';
  /** The line, ANSI and all: the greeter renders it as the terminal would. */
  text: string;
  /** The row's number in this boot, so a later line can settle it in place. */
  id?: number;
  /**
   * The row this line settles: a `[PENDING]` or `[RETRY]` row of the same
   * label, printed earlier. On a terminal the boot logger rewrites that row
   * where it stands; off one (as under porter) it can only append, so the
   * host matches the label and the greeter does the rewriting.
   */
  replaces?: number;
}

/** A boot in progress, or finished, as a host reports it. */
export interface BootReport {
  /** Every line so far, in order. */
  lines: BootLine[];
  /** Whether the session is up (berth answering), still booting, or gone. */
  state: 'booting' | 'ready' | 'failed';
  /** What went wrong, when the state is `failed`. */
  reason?: string;
}

/** Who to tell as a boot proceeds. */
export interface BootListener {
  line(line: BootLine): void;
  done(state: 'ready' | 'failed', reason?: string): void;
}

/** One session a host knows of, for a listing. */
export interface SessionSighting {
  identity: string;
  berth: Berth;
  alive: boolean;
}

/** Where sessions run. */
export interface SessionHost {
  /**
   * Finds every session this host holds a berth for, alive or not, and
   * takes the live ones under its wing — a porter restarted adopts the
   * fleet its predecessor started rather than starting rivals.
   *
   * @returns Every berth found, with whether its daemon answers.
   */
  sessions_adopt(): Promise<SessionSighting[]>;

  /**
   * Finds an identity's live session.
   *
   * @param identity - The normalised `<user>@<url>`.
   * @returns Its berth, or null when no session of theirs answers.
   */
  find(identity: string): Promise<Berth | null>;

  /**
   * Starts an identity's session with a CUBE token, or joins one already
   * starting; resolves once its berth answers.
   *
   * @param identity - The normalised `<user>@<url>`.
   * @param user - The CUBE username.
   * @param cubeUrl - The CUBE API base.
   * @param token - The CUBE token the door minted; the session's only credential.
   * @returns The berth.
   * @throws {Error} When the session does not come up.
   */
  spawn(identity: string, user: string, cubeUrl: string, token: string): Promise<Berth>;

  /**
   * Starts an identity's session and returns at once: the boot is followed
   * through {@link boot_follow}, and its end — ready, or failed with a
   * reason — is recorded there rather than thrown to anyone.
   *
   * @param identity - The normalised `<user>@<url>`.
   * @param user - The CUBE username.
   * @param cubeUrl - The CUBE API base.
   * @param token - The CUBE token the door minted.
   */
  spawn_begin(identity: string, user: string, cubeUrl: string, token: string): void;

  /**
   * Reads what a session's boot has said so far, and follows it.
   *
   * @param identity - The normalised `<user>@<url>`.
   * @param listener - Told each line from now on, and the end.
   * @returns The lines so far and the state now, or null when the host has
   *   no boot on record for this identity. The listener is released when
   *   the boot ends or when the returned function is called.
   */
  boot_follow(identity: string, listener: BootListener): { report: BootReport; release: () => void } | null;
  /**
   * Starts a stratus session for a person, or joins one starting; on the
   * other tier than the one running, ends it and starts it again. Returns
   * at once: the boot is followed through {@link boot_follow}.
   *
   * @param identity - The session's own identity (`stratus:oci@<chris identity>`).
   * @param configPath - The person's stored OCI config, on this host.
   * @param spend - Whether it may change the cloud and bill (the tasks tier).
   * @param replace - Whether a daemon up for it is ended first (to change its tier).
   */
  stratus_begin(identity: string, configPath: string, spend: boolean, replace: boolean, door?: { cubeUrl: string; user: string }): void;
  /**
   * Whether a stratus session this porter started has the tasks tier.
   *
   * @param identity - The session's identity.
   * @returns True or false, or null when this porter did not start it.
   */
  stratus_armed(identity: string): boolean | null;

  /**
   * Ends an identity's session, leaving the daemon the reason so it can tell
   * its surfaces before it goes.
   *
   * @param identity - The normalised `<user>@<url>`.
   * @param cause - Why: an administrator's end by default.
   * @returns Whether there was one to end.
   */
  evict(identity: string, cause?: 'restart' | 'end'): Promise<boolean>;

  /**
   * Restarts an identity's session and returns at once: the old daemon is
   * left the cause and ended, and a fresh one boots on the token the session saved
   * — the operator's password is not asked again. The whole of it is one
   * boot, followed through {@link boot_follow} from the first word, so a
   * greeter never sees a gap; a saved token the server refuses ends the boot
   * failed, with the reason.
   *
   * @param identity - The normalised `<user>@<url>`.
   * @param user - The CUBE username.
   * @param cubeUrl - The CUBE API base.
   * @param why - Why, for the boot's first line; the operator's RESTART by default.
   */
  restart_begin(identity: string, user: string, cubeUrl: string, why?: RestartWhy): void;
  /**
   * A new login's token for a session already up, where the host keeps the
   * token outside the session (a berth's token file); a host that hands the
   * token only at start has none.
   *
   * @param identity - The normalised `<user>@<url>`.
   * @param user - The CUBE username.
   * @param cubeUrl - The CUBE API base.
   * @param token - The new token.
   */
  token_renew?(identity: string, user: string, cubeUrl: string, token: string): Promise<void>;
  /**
   * Every person's berth and what it uses, for the operator; a host that
   * starts no berths has none to read.
   *
   * @param cubeUrl - This door's CUBE: only the berths and homes of its people are read, not leftovers of an earlier CUBE.
   * @returns One row a person who has a berth up or a home kept.
   * @throws {Error} When the berth launcher does not answer.
   */
  access_read?(cubeUrl: string): Promise<BerthAccess[]>;
}

/**
 * Why a session restarts, for the first line its boot reads: a daemon
 * running older code than the door ships (and which packages), the
 * operator's own RESTART, or a session with no daemon booting on its saved
 * login.
 */
export type RestartWhy =
  | { kind: 'stale'; behind: ReadonlyArray<string> }
  | { kind: 'asked' }
  | { kind: 'saved-login' };

/**
 * The first line a restart's boot reads, in plain words.
 *
 * @param why - Why the session restarts.
 * @returns The line.
 */
export function restartLine_render(why: RestartWhy): string {
  switch (why.kind) {
    case 'stale': return why.behind.length > 0 ? `Restarting a stale calypso daemon (${why.behind.join(', ')})` : 'Restarting a stale calypso daemon';
    case 'asked': return 'Restarting the calypso daemon, as asked';
    case 'saved-login': return 'Starting a calypso daemon on the saved login';
  }
}
