/**
 * @file The door's grants: what a door cookie is worth, kept by the door.
 *
 * A door cookie names a session key and a grant, signed. The signature says
 * the door made it; the grant says the door still stands by it. A grant is
 * made when a login or a switch succeeds, lives the door's cookie hours,
 * and ends at logout, at a switch away from it, or at its hour: after that
 * the cookie lets nobody in, however well it is signed, and every
 * connection opened under it is closed at that moment. Grants are kept in
 * the porter's state (`door-grants.json`, 0600, written whole through a
 * rename), so a porter restarted honours the grants it made and no other.
 *
 * Key components:
 * - GrantStore: grants made, checked, ended, and the connections they hold.
 * - grantCookie_value, grantCookie_read: the cookie's signed value, both ways.
 * - FrameCloser: closes a relayed WebSocket at a frame boundary, with a close code.
 *
 * Typical usage:
 * ```ts
 * const made = grants.grant_make(key);
 * reply.setCookie(DOOR_COOKIE, grantCookie_value(key, made.id), options);
 * ```
 *
 * Dependencies: node:crypto, node:fs, node:stream, the token store's safe read.
 *
 * @module
 */

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';

import { ownFile_read } from './tokens.js';

/** The WebSocket close code a connection is closed with when its grant ends. */
export const GRANT_CLOSE_CODE: number = 4401;

/** The longest one timer is set for; a longer wait is taken in steps (setTimeout holds at most about 24.8 days). */
export const GRANT_STEP_MS: number = 24 * 3600 * 1000;

/**
 * One grant the door stands by.
 *
 * @example
 * ```ts
 * const grant: DoorGrant = { id: 'ab…', key: '0123456789abcdef', expires: '2026-12-01T00:00:00.000Z' };
 * ```
 */
export interface DoorGrant {
  /** 32 random bytes, hex: the part of the cookie only the door can stand by. */
  id: string;
  /** The session key the grant lets in. */
  key: string;
  /** ISO time it ends. */
  expires: string;
  /** The grant a switch moved from, kept in memory only: a logout racing the switch learns it lost. */
  movedFrom?: string;
}

/**
 * A connection opened under a grant, closed when the grant ends.
 *
 * @example
 * ```ts
 * grants.connection_hold(grantId, { connection_close: () => stream.end() });
 * ```
 */
export interface GrantConnection {
  /** Closes it: a WebSocket with GRANT_CLOSE_CODE, an event stream by ending it. */
  connection_close: () => void;
}

/** The file's shape on disk. */
interface GrantFile {
  /** The shape's version. */
  schemaVersion: 1;
  /** Every grant the door stands by. */
  grants: DoorGrant[];
}

/** What a grant's id looks like. */
const GRANT_ID: RegExp = /^[0-9a-f]{64}$/;

/** The most the grants file holds: far beyond any door's browsers. */
const GRANTS_MAX_BYTES: number = 4 * 1024 * 1024;

/** What a session key looks like. */
const SESSION_KEY: RegExp = /^[0-9a-f]{16}$/;

/**
 * A key and the grant a cookie names for it.
 *
 * @example
 * ```ts
 * const named: GrantNamed = { key: '0123456789abcdef', id: 'ab…' };
 * ```
 */
export interface GrantNamed {
  /** The session key. */
  key: string;
  /** The grant's id. */
  id: string;
}

/**
 * The cookie's value before it is signed: the key and the grant.
 *
 * @param key - The session key.
 * @param id - The grant's id.
 * @returns The value.
 *
 * @example
 * ```ts
 * grantCookie_value('0123456789abcdef', 'ab…'); // '0123456789abcdef.ab…'
 * ```
 */
export function grantCookie_value(key: string, id: string): string {
  return `${key}.${id}`;
}

/**
 * Reads a cookie's signed-over value as a key and a grant.
 *
 * @param value - The value the signature covered.
 * @returns The key and the grant's id, or null for a value of another form (a bare key from before grants among them).
 *
 * @example
 * ```ts
 * grantCookie_read('0123456789abcdef.ab…'); // { key: '0123456789abcdef', id: 'ab…' }
 * ```
 */
export function grantCookie_read(value: string): GrantNamed | null {
  const cut: number = value.indexOf('.');
  if (cut === -1) return null;
  const key: string = value.slice(0, cut);
  const id: string = value.slice(cut + 1);
  return SESSION_KEY.test(key) && GRANT_ID.test(id) ? { key, id } : null;
}

/**
 * Reads one record of the grants file, or says it is not one.
 *
 * @param value - The record as parsed.
 * @returns The grant, or null.
 *
 * @example
 * ```ts
 * grantRecord_read({ id, key, expires }); // a DoorGrant
 * ```
 */
function grantRecord_read(value: unknown): DoorGrant | null {
  if (value === null || typeof value !== 'object') return null;
  const { id, key, expires } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !GRANT_ID.test(id) || typeof key !== 'string' || !SESSION_KEY.test(key)) return null;
  if (typeof expires !== 'string' || Number.isNaN(Date.parse(expires))) return null;
  return { id, key, expires };
}

/**
 * The door's grants and the connections each one holds. The door is the
 * only writer of the file.
 *
 * @example
 * ```ts
 * const grants = new GrantStore(join(stateDir, 'door-grants.json'), 8);
 * await grants.grants_load();
 * ```
 */
export class GrantStore {
  private grants: Map<string, DoorGrant> = new Map();
  /** Grants a logout or an hour ended that the file may still hold: let in by none, until the file says so too. */
  private readonly denied: Set<string> = new Set();
  /** The change under way: changes are made one after another, each on the grants as the last left them. */
  private changing: Promise<unknown> = Promise.resolve();
  private readonly connections: Map<string, Set<GrantConnection>> = new Map();
  private readonly timers: Map<string, NodeJS.Timeout> = new Map();

  /**
   * @param path - The grants file.
   * @param hours - How long a grant lives.
   * @param now - The clock.
   * @param writer - How the file is written: a test's double makes one write fail; the door's own otherwise.
   */
  public constructor(
    private readonly path: string,
    private readonly hours: number,
    private readonly now: () => number = (): number => Date.now(),
    private readonly writer: ((path: string, body: string) => Promise<void>) | null = null,
  ) {}

  /**
   * Reads the grants the door made before it was restarted; those past
   * their hour are dropped. The file is read without following a link, as
   * a regular file of this account's. A file that does not parse starts
   * the door with none: every browser signs in again, which is the safe way
   * to be wrong.
   *
   * @returns How many grants were read.
   * @throws {Error} When something other than this account's own file stands at the name.
   *
   * @example
   * ```ts
   * const kept: number = await grants.grants_load();
   * ```
   */
  public async grants_load(): Promise<number> {
    this.grants = new Map();
    const bytes: Buffer | null = await ownFile_read(this.path, GRANTS_MAX_BYTES);
    if (bytes === null) return 0;
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      return 0;
    }
    const records: unknown = parsed !== null && typeof parsed === 'object' ? (parsed as Partial<Record<'grants', unknown>>).grants : undefined;
    if (!Array.isArray(records)) return 0;
    for (const record of records) {
      const grant: DoorGrant | null = grantRecord_read(record);
      if (grant !== null && Date.parse(grant.expires) > this.now()) this.grants.set(grant.id, grant);
    }
    return this.grants.size;
  }

  /**
   * Makes a grant for a session key and keeps it on disk before it is
   * handed out: a grant the file does not hold is never set as a cookie.
   *
   * @param key - The session key.
   * @returns The grant.
   * @throws {Error} When the grants file cannot be written; nothing is granted.
   *
   * @example
   * ```ts
   * const made: DoorGrant = await grants.grant_make(key);
   * ```
   */
  public async grant_make(key: string): Promise<DoorGrant> {
    const grant: DoorGrant = this.grant_new(key);
    return this.change_apply((next: Map<string, DoorGrant>): DoorGrant => {
      next.set(grant.id, grant);
      return grant;
    });
  }

  /**
   * Whether a grant lets a key in now.
   *
   * @param id - The grant's id.
   * @param key - The key the cookie names.
   * @returns True while the grant stands for that key.
   *
   * @example
   * ```ts
   * grants.grant_admits(named.id, named.key);
   * ```
   */
  public grant_admits(id: string, key: string): boolean {
    const grant: DoorGrant | undefined = this.grants.get(id);
    return grant !== undefined && !this.denied.has(id) && grant.key === key && Date.parse(grant.expires) > this.now();
  }

  /**
   * Ends a grant. At once, before anything is written, it lets nobody in and
   * every connection it holds is closed; then the file is written without
   * it. A write that fails leaves it refused here and says so, so the same
   * signed cookie can ask again; until a write succeeds a restarted door
   * would read it from the file.
   *
   * @param id - The grant's id.
   * @returns `ended` when it stood, `moved` when a switch had already moved it to another grant, `gone` when the door held no such grant.
   * @throws {Error} When the file cannot be written without it.
   *
   * @example
   * ```ts
   * await grants.grant_end(held.id);
   * ```
   */
  public async grant_end(id: string): Promise<'ended' | 'moved' | 'gone'> {
    const known: boolean = this.grants.has(id);
    if (known) this.denied.add(id);
    this.connections_close(id);
    return this.change_apply((next: Map<string, DoorGrant>): 'ended' | 'moved' | 'gone' => {
      if (next.delete(id)) return 'ended';
      if ([...next.values()].some((grant: DoorGrant): boolean => grant.movedFrom === id)) return 'moved';
      // Refused at this logout's asking, and written away by a change that came between: this logout ended it.
      return known ? 'ended' : 'gone';
    });
  }

  /**
   * Replaces one grant with a new one for another key, in one change: the
   * old one must still stand when the change's turn comes (a logout that
   * began first wins), or nothing is made.
   *
   * @param id - The grant being moved away from.
   * @param key - The key the new grant lets in.
   * @returns The new grant, or null when the old one no longer stands.
   * @throws {Error} When the grants file cannot be written; the old grant stands and nothing is made.
   *
   * @example
   * ```ts
   * const moved: DoorGrant | null = await grants.grant_move(held.id, stratusKey);
   * ```
   */
  public async grant_move(id: string, key: string): Promise<DoorGrant | null> {
    const moved: DoorGrant | null = await this.change_apply((next: Map<string, DoorGrant>): DoorGrant | null => {
      const old: DoorGrant | undefined = next.get(id);
      if (old === undefined || this.denied.has(id) || Date.parse(old.expires) <= this.now()) return null;
      const grant: DoorGrant = { ...this.grant_new(key), movedFrom: id };
      next.delete(id);
      next.set(grant.id, grant);
      return grant;
    });
    if (moved !== null) this.connections_close(id);
    return moved;
  }

  /**
   * Holds a connection under a grant, to be closed when the grant ends or
   * reaches its hour, traffic or none.
   *
   * @param id - The grant's id.
   * @param connection - How to close it.
   * @returns How to let it go when it closes on its own.
   *
   * @example
   * ```ts
   * const letGo = grants.connection_hold(held.id, { connection_close: () => socket.end() });
   * ```
   */
  public connection_hold(id: string, connection: GrantConnection): () => void {
    let held: Set<GrantConnection> | undefined = this.connections.get(id);
    if (held === undefined) {
      held = new Set();
      this.connections.set(id, held);
    }
    held.add(connection);
    this.deadline_arm(id);
    return (): void => {
      const now: Set<GrantConnection> | undefined = this.connections.get(id);
      now?.delete(connection);
      if (now !== undefined && now.size === 0) this.connections_forget(id);
    };
  }

  /**
   * Forgets grants past their hour, closing what they held; for the minute sweep.
   *
   * @example
   * ```ts
   * await grants.grants_sweep();
   * ```
   */
  public async grants_sweep(): Promise<void> {
    for (const grant of [...this.grants.values()]) {
      if (Date.parse(grant.expires) <= this.now()) this.connections_close(grant.id);
    }
    // Writing drops every grant past its hour; a write that fails is the next sweep's to do again.
    await this.change_apply((): void => undefined).catch((): void => undefined);
  }

  /**
   * Stops every timer: the door is closing.
   *
   * @example
   * ```ts
   * grants.timers_stop();
   * ```
   */
  public timers_stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * Arms the closing of a grant's connections at its hour, in steps of at
   * most a day, each step reading the hour again.
   *
   * @param id - The grant's id.
   */
  private deadline_arm(id: string): void {
    if (this.timers.has(id)) return;
    const grant: DoorGrant | undefined = this.grants.get(id);
    if (grant === undefined) {
      this.connections_close(id);
      return;
    }
    const left: number = Date.parse(grant.expires) - this.now();
    if (left <= 0) {
      // Past its hour it lets nobody in already; its connections close now, and the sweep forgets it.
      this.connections_close(id);
      return;
    }
    const timer: NodeJS.Timeout = setTimeout((): void => {
      this.timers.delete(id);
      this.deadline_arm(id);
    }, Math.min(left, GRANT_STEP_MS));
    timer.unref();
    this.timers.set(id, timer);
  }

  /**
   * Closes every connection a grant holds, and forgets them.
   *
   * @param id - The grant's id.
   */
  private connections_close(id: string): void {
    const held: Set<GrantConnection> | undefined = this.connections.get(id);
    this.connections_forget(id);
    for (const connection of held ?? []) {
      try {
        connection.connection_close();
      } catch {
        // A connection already gone has nothing to close.
      }
    }
  }

  /**
   * Forgets a grant's connections and its timer.
   *
   * @param id - The grant's id.
   */
  private connections_forget(id: string): void {
    this.connections.delete(id);
    const timer: NodeJS.Timeout | undefined = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
  }

  /**
   * A new grant for a key, its hour from now.
   *
   * @param key - The key.
   * @returns The grant, not yet kept.
   */
  private grant_new(key: string): DoorGrant {
    return { id: randomBytes(32).toString('hex'), key, expires: new Date(this.now() + this.hours * 3600 * 1000).toISOString() };
  }

  /**
   * One change of the grants, in its turn: made on a copy of the grants
   * as the last change left them (those past their hour dropped), written
   * whole, and only then the grants the door goes by. A change whose write
   * fails changes nothing, and no later write carries it. Denials the
   * written file no longer needs are let go.
   *
   * @param change - What the change does with the copy; its answer is the change's.
   * @returns The change's answer, once written.
   * @throws {Error} When the file cannot be written, or would be larger than the door reads back.
   */
  private change_apply<T>(change: (next: Map<string, DoorGrant>) => T): Promise<T> {
    const turn_run = async (): Promise<T> => {
      const next: Map<string, DoorGrant> = new Map([...this.grants].filter(([, grant]: [string, DoorGrant]): boolean => Date.parse(grant.expires) > this.now()));
      const answer: T = change(next);
      // Whatever the change, a grant refused here is not written as standing.
      for (const id of this.denied) next.delete(id);
      await this.file_write(next);
      this.grants = next;
      for (const id of [...this.denied]) if (!next.has(id)) this.denied.delete(id);
      return answer;
    };
    const run: Promise<T> = this.changing.then(turn_run, turn_run);
    this.changing = run.catch((): void => undefined);
    return run;
  }

  /**
   * Writes the grants, whole, through a fresh file renamed in the same
   * folder, held to the bound the door reads back.
   *
   * @param grants - The grants to write.
   * @throws {Error} When it cannot be written, or would be larger than the door reads back.
   */
  private async file_write(grants: Map<string, DoorGrant>): Promise<void> {
    const body: string = `${JSON.stringify({ schemaVersion: 1, grants: [...grants.values()].map(({ id, key, expires }: DoorGrant) => ({ id, key, expires })) } satisfies GrantFile)}\n`;
    if (Buffer.byteLength(body, 'utf8') > GRANTS_MAX_BYTES) throw new Error(`the door's grants would grow past ${String(GRANTS_MAX_BYTES)} bytes; the change is refused`);
    if (this.writer !== null) {
      await this.writer(this.path, body);
      return;
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp: string = join(dirname(this.path), `.door-grants.${String(process.pid)}.${randomBytes(6).toString('hex')}`);
    const file: FileHandle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(body, 'utf8');
    } finally {
      await file.close().catch((): void => undefined);
    }
    try {
      await rename(temp, this.path);
    } catch (error: unknown) {
      await rm(temp, { force: true });
      throw error;
    }
  }


}

/**
 * Where a server-to-browser WebSocket stream stands: how much of the frame
 * under way is still to come.
 */
interface FrameCursor {
  /** Header bytes gathered for the frame not yet begun. */
  header: Buffer;
  /** Payload bytes of the current frame still to pass. */
  remaining: number;
}

/**
 * A frame's size, as its header says it.
 *
 * @example
 * ```ts
 * const size: FrameSize | null = frameHeader_read(header);
 * ```
 */
export interface FrameSize {
  /** The header's own length, in bytes. */
  headerLength: number;
  /** The payload's length, in bytes. */
  payloadLength: number;
}

/**
 * The length of a frame header, once enough of it has arrived to say.
 *
 * @param header - The header bytes so far.
 * @returns The header's length and the payload's, or null while it cannot be told.
 *
 * @example
 * ```ts
 * frameHeader_read(Buffer.from([0x81, 0x05])); // { headerLength: 2, payloadLength: 5 }
 * ```
 */
export function frameHeader_read(header: Buffer): FrameSize | null {
  if (header.length < 2) return null;
  const second: number = header[1] ?? 0;
  const masked: boolean = (second & 0x80) !== 0;
  const short: number = second & 0x7f;
  const lengthBytes: number = short === 126 ? 2 : short === 127 ? 8 : 0;
  const headerLength: number = 2 + lengthBytes + (masked ? 4 : 0);
  if (header.length < 2 + lengthBytes) return null;
  let payloadLength: number = short;
  if (short === 126) payloadLength = header.readUInt16BE(2);
  if (short === 127) payloadLength = Number(header.readBigUInt64BE(2));
  return { headerLength, payloadLength };
}

/** The most a close frame's reason may hold, in UTF-8 bytes: a control frame carries 125, two of them the code. */
export const CLOSE_REASON_MAX_BYTES: number = 123;

/**
 * A close frame's reason as UTF-8, cut at a character's edge to fit the frame.
 *
 * @param text - The reason.
 * @returns Its bytes, at most CLOSE_REASON_MAX_BYTES, never half a character.
 *
 * @example
 * ```ts
 * closeReason_bytes('signed out').length; // 10
 * ```
 */
export function closeReason_bytes(text: string): Buffer {
  const kept: Buffer[] = [];
  let size: number = 0;
  for (const character of text) {
    const bytes: Buffer = Buffer.from(character, 'utf8');
    if (size + bytes.length > CLOSE_REASON_MAX_BYTES) break;
    kept.push(bytes);
    size += bytes.length;
  }
  return Buffer.concat(kept, size);
}

/**
 * Closes a relayed WebSocket at a frame boundary: the daemon's frames pass
 * through it to the browser, and when the connection's grant ends, the
 * frame under way is let finish, nothing after it passes, and a close frame
 * with GRANT_CLOSE_CODE is written in its place.
 *
 * @example
 * ```ts
 * const closer = new FrameCloser();
 * upstream.pipe(closer).pipe(browser);
 * closer.close_request('signed out');
 * ```
 */
export class FrameCloser extends Transform {
  private readonly cursor: FrameCursor = { header: Buffer.alloc(0), remaining: 0 };
  private closing: string | null = null;
  private frameClosed: boolean = false;
  /** The daemon's answer to the upgrade, until its blank line: passed as it is, before any frame. */
  private handshake: Buffer | null = Buffer.alloc(0);

  /**
   * Asks for the close: at once when between frames, else when the frame under way ends.
   *
   * @param reason - The words the close frame carries.
   *
   * @example
   * ```ts
   * closer.close_request('signed out');
   * ```
   */
  public close_request(reason: string): void {
    if (this.frameClosed) return;
    this.closing = reason;
    if (this.handshake === null && this.cursor.remaining === 0 && this.cursor.header.length === 0) this.close_write();
  }

  /**
   * Passes the daemon's bytes up to the frame boundary a close waits for.
   *
   * @param chunk - The bytes.
   * @param _encoding - Unused.
   * @param done - Called when the chunk is handled.
   */
  public override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    let at: number = 0;
    if (this.handshake !== null) {
      const seen: Buffer = Buffer.concat([this.handshake, chunk]);
      const end: number = seen.indexOf('\r\n\r\n');
      if (end === -1) {
        this.handshake = seen;
        this.push(chunk);
        done();
        return;
      }
      const through: number = end + 4 - this.handshake.length;
      this.push(chunk.subarray(0, through));
      this.handshake = null;
      at = through;
    }
    while (at < chunk.length && !this.frameClosed) {
      if (this.cursor.remaining > 0) {
        const take: number = Math.min(this.cursor.remaining, chunk.length - at);
        this.push(chunk.subarray(at, at + take));
        this.cursor.remaining -= take;
        at += take;
        continue;
      }
      if (this.closing !== null && this.cursor.header.length === 0) {
        this.close_write();
        break;
      }
      this.cursor.header = Buffer.concat([this.cursor.header, chunk.subarray(at, at + 1)]);
      at += 1;
      const read: FrameSize | null = frameHeader_read(this.cursor.header);
      if (read !== null && this.cursor.header.length === read.headerLength) {
        this.push(this.cursor.header);
        this.cursor.header = Buffer.alloc(0);
        this.cursor.remaining = read.payloadLength;
      }
    }
    if (!this.frameClosed && this.closing !== null && this.cursor.remaining === 0 && this.cursor.header.length === 0) this.close_write();
    done();
  }

  /** Writes the close frame and ends the stream to the browser; before the handshake ends there is no frame to write, only the end. */
  private close_write(): void {
    if (this.frameClosed) return;
    this.frameClosed = true;
    if (this.handshake !== null) {
      this.push(null);
      return;
    }
    const words: Buffer = closeReason_bytes(this.closing ?? '');
    const frame: Buffer = Buffer.alloc(4 + words.length);
    frame[0] = 0x88;
    frame[1] = 2 + words.length;
    frame.writeUInt16BE(GRANT_CLOSE_CODE, 2);
    words.copy(frame, 4);
    this.push(frame);
    this.push(null);
  }
}
