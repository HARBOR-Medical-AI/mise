/**
 * @file Sessions as berths (docs/dev-bastion.adoc, stand-in): porter asks
 * the berth launcher for a user's berth instead of starting a calypso
 * beside itself, and shows the berth's calypso through the same door. The
 * launcher alone holds the container engine; porter holds a secret it
 * carries and the user's CUBE token, which it hands over once per login.
 *
 * Behind a switch (`PORTER_BERTHS=launcher`): a porter without it starts
 * sessions as it always has.
 *
 * @module
 */
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { identity_normalise, type Berth } from '@fnndsc/calypso/berth';
import { restartLine_render, type BerthAccess, type BootLine, type BootListener, type BootReport, type RestartWhy, type SessionHost, type SessionSighting } from './sessionHost.js';

/** A berth as the launcher answers it. */
interface LauncherBerth {
  identity: string;
  user: string;
  state: 'running' | 'stopped';
  url: string | null;
  token: string | null;
}

/** How porter reaches the launcher: its socket or loopback address, and the secret every call carries. */
export interface LauncherReach {
  /** A unix socket path, or `127.0.0.1:<port>`. */
  readonly listen: string;
  readonly secret: string;
}

/** How a CUBE user's id is read with their token; a test gives its own. */
export type CubeUserRead = (cubeUrl: string, token: string) => Promise<number>;

/**
 * The CUBE id of the token's user: the `user` link of the API's root names it (`…/users/<id>/`).
 *
 * @param cubeUrl - The CUBE API base.
 * @param token - The user's token.
 * @returns The id.
 * @throws {Error} When CUBE does not say.
 */
export const cubeUserId_read: CubeUserRead = async (cubeUrl: string, token: string): Promise<number> => {
  const answer: Response = await fetch(cubeUrl, { headers: { Authorization: `Token ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!answer.ok) throw new Error(`CUBE answered ${answer.status} for the user's own record`);
  const body: unknown = await answer.json();
  const link: unknown = typeof body === 'object' && body !== null ? (body as { collection_links?: { user?: unknown } }).collection_links?.user : undefined;
  const id: RegExpExecArray | null = typeof link === 'string' ? /\/users\/(\d+)\/?$/.exec(link) : null;
  if (id === null) throw new Error('CUBE did not say who the token is');
  return Number(id[1]);
};

/**
 * Splits a session identity into its user and CUBE.
 *
 * @param identity - `<user>@<cube url>`.
 * @returns The two, or null when it is not one.
 */
export function identity_split(identity: string): { user: string; cubeUrl: string } | null {
  const at: number = identity.search(/@https?:\/\//);
  return at <= 0 ? null : { user: identity.slice(0, at), cubeUrl: identity.slice(at + 1) };
}

/**
 * One call to the launcher.
 *
 * @param reach - Where it is and the secret.
 * @param method - The HTTP method.
 * @param path - The path and query.
 * @param body - The JSON body, when there is one.
 * @returns The status and the parsed body.
 */
export function launcher_call(reach: LauncherReach, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve: (answer: { status: number; body: Record<string, unknown> }) => void, reject: (error: Error) => void): void => {
    const payload: string | null = body === undefined ? null : JSON.stringify(body);
    const hostPort: RegExpExecArray | null = /^(127\.0\.0\.1|localhost|::1):(\d+)$/.exec(reach.listen);
    const headers: Record<string, string | number> = { Authorization: `Bearer ${reach.secret}`, ...(payload !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) };
    const req: ClientRequest = httpRequest({
      ...(hostPort !== null ? { host: hostPort[1], port: Number(hostPort[2]) } : { socketPath: reach.listen }),
      method, path, headers,
    }, (res: IncomingMessage): void => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer): void => { chunks.push(chunk); });
      res.on('end', (): void => {
        let parsed: unknown = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { parsed = {}; }
        resolve({ status: res.statusCode ?? 0, body: typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {} });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** A boot as this host keeps it: its lines, its state, who follows. */
interface BootRecord {
  lines: BootLine[];
  state: 'booting' | 'ready' | 'failed';
  reason?: string;
  listeners: Set<BootListener>;
}

/** Sessions as berths the launcher starts. */
export class LauncherHost implements SessionHost {
  private readonly reach: LauncherReach;
  private readonly userId_read: CubeUserRead;
  private readonly boots: Map<string, BootRecord> = new Map();

  /**
   * @param reach - Where the launcher is, and the secret.
   * @param userId_read - How a token's CUBE id is read.
   */
  constructor(reach: LauncherReach, userId_read: CubeUserRead = cubeUserId_read) {
    // A unix socket's path is at most 107 bytes; a longer one fails at the first call, far from its cause.
    if (!/^(127\.0\.0\.1|localhost|::1):\d+$/.test(reach.listen) && Buffer.byteLength(reach.listen) > 100) throw new Error(`${reach.listen}: a socket path longer than 100 bytes; give the launcher a shorter one`);
    this.reach = reach;
    this.userId_read = userId_read;
  }

  /**
   * A launcher berth as porter's.
   *
   * @param berth - The launcher's answer.
   * @returns The berth, or null when it is not running.
   */
  private static berth_take(berth: LauncherBerth): Berth | null {
    return berth.state === 'running' && berth.url !== null && berth.token !== null ? { identity: berth.identity, url: berth.url, token: berth.token } : null;
  }

  /** @inheritdoc */
  public async sessions_adopt(): Promise<SessionSighting[]> {
    const answer = await launcher_call(this.reach, 'GET', '/berths/status');
    const berths: LauncherBerth[] = Array.isArray(answer.body['berths']) ? answer.body['berths'] as LauncherBerth[] : [];
    return berths.flatMap((one: LauncherBerth): SessionSighting[] => {
      const berth: Berth | null = LauncherHost.berth_take(one);
      return berth === null ? [] : [{ identity: one.identity, berth, alive: true }];
    });
  }

  /** @inheritdoc */
  public async access_read(): Promise<BerthAccess[]> {
    const answer = await launcher_call(this.reach, 'GET', '/berths/access');
    if (answer.status !== 200) throw new Error(typeof answer.body['error'] === 'string' ? answer.body['error'] : `the launcher answered ${answer.status}`);
    return Array.isArray(answer.body['berths']) ? answer.body['berths'] as BerthAccess[] : [];
  }

  /** @inheritdoc */
  public async find(identity: string): Promise<Berth | null> {
    const who = identity_split(identity);
    if (who === null) return null;
    const answer = await launcher_call(this.reach, 'GET', `/berths/status?user=${encodeURIComponent(who.user)}&cubeUrl=${encodeURIComponent(who.cubeUrl)}`);
    const berths: LauncherBerth[] = Array.isArray(answer.body['berths']) ? answer.body['berths'] as LauncherBerth[] : [];
    const own: LauncherBerth | undefined = berths.find((one: LauncherBerth): boolean => one.identity === identity);
    return own === undefined ? null : LauncherHost.berth_take(own);
  }

  /** @inheritdoc */
  public async spawn(identity: string, user: string, cubeUrl: string, token: string): Promise<Berth> {
    return this.boot_run(identity, user, cubeUrl, token, null);
  }

  /** @inheritdoc */
  public spawn_begin(identity: string, user: string, cubeUrl: string, token: string): void {
    void this.boot_run(identity, user, cubeUrl, token, null).catch((): void => undefined);
  }

  /**
   * A new login's token for a berth already running: the launcher rewrites
   * its token file, and the session reads it at its next start.
   *
   * @param identity - The identity.
   * @param user - The CUBE user.
   * @param cubeUrl - The CUBE.
   * @param token - The new token.
   */
  public async token_renew(identity: string, user: string, cubeUrl: string, token: string): Promise<void> {
    const uid: number = await this.userId_read(cubeUrl, token);
    await launcher_call(this.reach, 'POST', '/berths/start', { user, uid, gid: uid, cubeUrl, token });
  }

  /** @inheritdoc */
  public boot_follow(identity: string, listener: BootListener): { report: BootReport; release: () => void } | null {
    const record: BootRecord | undefined = this.boots.get(identity);
    if (record === undefined) return null;
    const report: BootReport = { lines: [...record.lines], state: record.state, ...(record.reason !== undefined ? { reason: record.reason } : {}) };
    if (record.state === 'booting') record.listeners.add(listener);
    return { report, release: (): void => { record.listeners.delete(listener); } };
  }

  /** @inheritdoc */
  public stratus_begin(identity: string): void {
    const record: BootRecord = this.record_open(identity);
    this.boot_end(record, 'failed', 'a stratus session is not offered on a door that starts berths');
  }

  /** @inheritdoc */
  public stratus_armed(): boolean | null {
    return null;
  }

  /** @inheritdoc */
  public async evict(identity: string): Promise<boolean> {
    const who = identity_split(identity);
    if (who === null) return false;
    const answer = await launcher_call(this.reach, 'POST', '/berths/stop', { user: who.user, cubeUrl: who.cubeUrl });
    return answer.body['stopped'] === true;
  }

  /** @inheritdoc */
  public restart_begin(identity: string, user: string, cubeUrl: string, why: RestartWhy = { kind: 'asked' }): void {
    void (async (): Promise<void> => {
      if (why.kind !== 'saved-login') await this.evict(identity).catch((): boolean => false);
      await this.boot_run(identity, user, cubeUrl, null, restartLine_render(why));
    })().catch((): void => undefined);
  }

  /**
   * A boot: the user's CUBE id read with their token, the launcher asked, each step a line.
   *
   * @param identity - The identity.
   * @param user - The CUBE user.
   * @param cubeUrl - The CUBE.
   * @param token - The token, or null for the one the launcher holds.
   * @param first - A first line, for a restart.
   * @returns The berth.
   */
  private async boot_run(identity: string, user: string, cubeUrl: string, token: string | null, first: string | null): Promise<Berth> {
    const record: BootRecord = this.record_open(identity);
    if (first !== null) this.line_add(record, first);
    try {
      if (identity !== identity_normalise(user, cubeUrl)) throw new Error('the identity is not the user\'s at this CUBE');
      let uid: number | null = null;
      if (token !== null) {
        uid = await this.userId_read(cubeUrl, token);
        this.line_add(record, `[ OK ]    Identity     ${user} is CUBE user ${uid}`);
      }
      this.line_add(record, `[PENDING] Berth        starting ${user}'s berth`);
      // No cohort yet: the picker at the door is a later stage; the berth starts with an empty pair.
      const answer = await launcher_call(this.reach, 'POST', '/berths/start', { user, uid: uid ?? 0, gid: uid ?? 0, cubeUrl, token, cohort: null });
      if (answer.status !== 200) throw new Error(typeof answer.body['error'] === 'string' ? answer.body['error'] : `the launcher answered ${answer.status}`);
      const berth: Berth | null = LauncherHost.berth_take(answer.body as unknown as LauncherBerth);
      if (berth === null) throw new Error('the launcher started no berth');
      this.line_add(record, `[ OK ]    Berth        ${user}'s berth answers`);
      this.boot_end(record, 'ready');
      return berth;
    } catch (error: unknown) {
      const reason: string = error instanceof Error ? error.message : String(error);
      this.line_add(record, `[FAIL]    Berth        ${reason}`);
      this.boot_end(record, 'failed', reason);
      throw error;
    }
  }

  /**
   * A fresh boot record for an identity.
   *
   * @param identity - The identity.
   * @returns The record.
   */
  private record_open(identity: string): BootRecord {
    const listeners: Set<BootListener> = this.boots.get(identity)?.listeners ?? new Set();
    const record: BootRecord = { lines: [], state: 'booting', listeners };
    this.boots.set(identity, record);
    return record;
  }

  /**
   * A line of a boot, told to its followers.
   *
   * @param record - The boot.
   * @param text - The line.
   */
  private line_add(record: BootRecord, text: string): void {
    const line: BootLine = { channel: 'out', text, id: record.lines.length };
    record.lines.push(line);
    for (const listener of record.listeners) listener.line(line);
  }

  /**
   * A boot's end, told to its followers.
   *
   * @param record - The boot.
   * @param state - How it ended.
   * @param reason - Why, when it failed.
   */
  private boot_end(record: BootRecord, state: 'ready' | 'failed', reason?: string): void {
    record.state = state;
    if (reason !== undefined) record.reason = reason;
    for (const listener of record.listeners) listener.done(state, reason);
    record.listeners.clear();
  }
}
