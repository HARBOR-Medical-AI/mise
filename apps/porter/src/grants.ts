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
 * Dependencies: node:crypto, node:fs, node:stream.
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
}

/**
 * A connection opened under a grant, closed when the grant ends.
 *
 * @example
 * ```ts
 * grants.connection_hold(grantId, { close: () => stream.end() });
 * ```
 */
export interface GrantConnection {
  /** Closes it: a WebSocket with GRANT_CLOSE_CODE, an event stream by ending it. */
  close: () => void;
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
export function grantCookie_read(value: string): { key: string; id: string } | null {
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
 * grants.load();
 * ```
 */
export class GrantStore {
  private grants: Map<string, DoorGrant> = new Map();
  /** Grants ended by a logout or a switch, so a failed move does not bring one back. */
  private readonly ended: Set<string> = new Set();
  /** The write under way, so writes are made one after another. */
  private saving: Promise<void> = Promise.resolve();
  private readonly connections: Map<string, Set<GrantConnection>> = new Map();
  private readonly timers: Map<string, NodeJS.Timeout> = new Map();

  /**
   * @param path - The grants file.
   * @param hours - How long a grant lives.
   * @param now - The clock.
   */
  public constructor(
    private readonly path: string,
    private readonly hours: number,
    private readonly now: () => number = (): number => Date.now(),
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
   */
  public async load(): Promise<number> {
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
   */
  public async grant_make(key: string): Promise<DoorGrant> {
    const grant: DoorGrant = { id: randomBytes(32).toString('hex'), key, expires: new Date(this.now() + this.hours * 3600 * 1000).toISOString() };
    this.grants.set(grant.id, grant);
    try {
      await this.save();
    } catch (error: unknown) {
      this.grants.delete(grant.id);
      throw error;
    }
    return grant;
  }

  /**
   * Whether a grant lets a key in now.
   *
   * @param id - The grant's id.
   * @param key - The key the cookie names.
   * @returns True while the grant stands for that key.
   */
  public grant_admits(id: string, key: string): boolean {
    const grant: DoorGrant | undefined = this.grants.get(id);
    return grant !== undefined && grant.key === key && Date.parse(grant.expires) > this.now();
  }

  /**
   * Ends a grant: forgotten on disk, and every connection it holds closed.
   *
   * @param id - The grant's id.
   * @returns True when the grant stood.
   */
  public async grant_end(id: string): Promise<boolean> {
    // Gone from memory first, and its connections closed: the door stands by it no more from this moment.
    const stood: boolean = this.grants.delete(id);
    this.ended.add(id);
    this.connections_close(id);
    if (stood) {
      try {
        await this.save();
      } catch {
        // The file catches up at the next write; a grant it still holds is one the door no longer stands by after a restart only until then.
      }
    }
    return stood;
  }

  /**
   * Replaces one grant with a new one for another key, in one step: the old
   * one must still stand, or nothing is made.
   *
   * @param id - The grant being moved away from.
   * @param key - The key the new grant lets in.
   * @returns The new grant, or null when the old one no longer stands.
   * @throws {Error} When the grants file cannot be written; the old grant stands and nothing is made.
   */
  public async grant_move(id: string, key: string): Promise<DoorGrant | null> {
    // Checked and changed in one step, before anything is awaited: a logout that comes first wins, and one after finds the new grant.
    const old: DoorGrant | undefined = this.grants.get(id);
    if (old === undefined || Date.parse(old.expires) <= this.now()) return null;
    const grant: DoorGrant = { id: randomBytes(32).toString('hex'), key, expires: new Date(this.now() + this.hours * 3600 * 1000).toISOString() };
    this.grants.delete(id);
    this.grants.set(grant.id, grant);
    try {
      await this.save();
    } catch (error: unknown) {
      this.grants.delete(grant.id);
      if (!this.ended.has(id)) this.grants.set(id, old);
      throw error;
    }
    this.connections_close(id);
    return grant;
  }

  /**
   * Holds a connection under a grant, to be closed when the grant ends or
   * reaches its hour, traffic or none.
   *
   * @param id - The grant's id.
   * @param connection - How to close it.
   * @returns How to let it go when it closes on its own.
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

  /** Forgets grants past their hour, closing what they held; for the minute sweep. */
  public async sweep(): Promise<void> {
    let changed: boolean = false;
    for (const grant of [...this.grants.values()]) {
      if (Date.parse(grant.expires) > this.now()) continue;
      this.grants.delete(grant.id);
      this.connections_close(grant.id);
      changed = true;
    }
    if (changed) {
      try {
        await this.save();
      } catch {
        // Gone from memory already; the file catches up at the next write.
      }
    }
  }

  /** Stops every timer: the door is closing. */
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
      this.grant_end(id);
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
        connection.close();
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
   * Writes every grant, whole, through a fresh file renamed in the same
   * folder; writes are made one after another, each holding every grant
   * as it then stands.
   *
   * @throws {Error} When it cannot be written.
   */
  private async save(): Promise<void> {
    const write = async (): Promise<void> => {
      const body: string = `${JSON.stringify({ schemaVersion: 1, grants: [...this.grants.values()] } satisfies GrantFile)}\n`;
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
    };
    const next: Promise<void> = this.saving.then(write, write);
    this.saving = next.catch((): void => undefined);
    return next;
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
export function frameHeader_read(header: Buffer): { headerLength: number; payloadLength: number } | null {
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
      const read: { headerLength: number; payloadLength: number } | null = frameHeader_read(this.cursor.header);
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
    const words: Buffer = Buffer.from((this.closing ?? '').slice(0, 100), 'utf8');
    const frame: Buffer = Buffer.alloc(4 + words.length);
    frame[0] = 0x88;
    frame[1] = 2 + words.length;
    frame.writeUInt16BE(GRANT_CLOSE_CODE, 2);
    words.copy(frame, 4);
    this.push(frame);
    this.push(null);
  }
}
