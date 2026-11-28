/**
 * @file The door's grants: a cookie is worth only the grant the door keeps
 * for it. Made at a login that succeeds, moved at a switch, ended at logout
 * or at its hour, and every connection opened under it closed then.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { FrameCloser, GRANT_CLOSE_CODE, GRANT_STEP_MS, GrantStore, grantCookie_read, grantCookie_value, frameHeader_read, closeReason_bytes, CLOSE_REASON_MAX_BYTES } from '../../src/grants.js';

const KEY: string = '0123456789abcdef';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'porter-grants-')); });
afterEach(() => { jest.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

describe('the cookie', () => {
  it('names a key and a grant, and nothing of another form', () => {
    const id: string = 'a'.repeat(64);
    expect(grantCookie_read(grantCookie_value(KEY, id))).toEqual({ key: KEY, id });
    // A bare key, from before grants, is no longer a cookie the door reads.
    expect(grantCookie_read(KEY)).toBeNull();
    expect(grantCookie_read(`${KEY}.short`)).toBeNull();
    expect(grantCookie_read(`not-a-key.${id}`)).toBeNull();
  });
});

describe('GrantStore', () => {
  it('admits a grant for its key until it is ended, and a restarted door honours the grants it kept and no other', async () => {
    const path: string = join(dir, 'door-grants.json');
    const grants: GrantStore = new GrantStore(path, 8);
    await grants.grants_load();
    const a = await grants.grant_make(KEY);
    const b = await grants.grant_make(KEY);
    expect(grants.grant_admits(a.id, KEY)).toBe(true);
    expect(grants.grant_admits(a.id, 'fedcba9876543210')).toBe(false);
    expect(await grants.grant_end(a.id)).toBe('ended');
    expect(grants.grant_admits(a.id, KEY)).toBe(false);
    // Two browsers of one person hold independent grants: one's logout leaves the other's.
    expect(grants.grant_admits(b.id, KEY)).toBe(true);
    const again: GrantStore = new GrantStore(path, 8);
    expect(await again.grants_load()).toBe(1);
    expect(again.grant_admits(b.id, KEY)).toBe(true);
    expect(again.grant_admits(a.id, KEY)).toBe(false);
  });

  it('stops admitting a grant at its hour, and a restarted door drops one past it', async () => {
    let now: number = Date.parse('2026-11-27T00:00:00Z');
    const path: string = join(dir, 'door-grants.json');
    const grants: GrantStore = new GrantStore(path, 1, (): number => now);
    const made = await grants.grant_make(KEY);
    now += 3_600_000 + 1;
    expect(grants.grant_admits(made.id, KEY)).toBe(false);
    expect(await new GrantStore(path, 1, (): number => now).grants_load()).toBe(0);
  });

  it('grants nothing when it cannot keep the grant', async () => {
    writeFileSync(join(dir, 'file'), 'x');
    const grants: GrantStore = new GrantStore(join(dir, 'file', 'door-grants.json'), 8);
    await expect(grants.grant_make(KEY)).rejects.toThrow();
  });

  it('reads its file only as a file of its own: a link at its name is refused', async () => {
    writeFileSync(join(dir, 'elsewhere.json'), JSON.stringify({ schemaVersion: 1, grants: [{ id: 'b'.repeat(64), key: KEY, expires: '2099-01-01T00:00:00.000Z' }] }));
    symlinkSync(join(dir, 'elsewhere.json'), join(dir, 'door-grants.json'));
    await expect(new GrantStore(join(dir, 'door-grants.json'), 8).grants_load()).rejects.toThrow('not a file of its own');
  });

  it('moves a grant only while it stands: a logout first wins, and a move first leaves the logout nothing to end', async () => {
    const grants: GrantStore = new GrantStore(join(dir, 'door-grants.json'), 8);
    const first = await grants.grant_make(KEY);
    const [ended, moved] = await Promise.all([grants.grant_end(first.id), grants.grant_move(first.id, 'fedcba9876543210')]);
    expect(ended).toBe('ended');
    expect(moved).toBeNull();
    // A logout refuses its grant the moment it is asked: a switch still waiting its turn then finds nothing to move.
    const racing = await grants.grant_make(KEY);
    const [movedLate, endedEarly] = await Promise.all([grants.grant_move(racing.id, 'fedcba9876543210'), grants.grant_end(racing.id)]);
    expect(movedLate).toBeNull();
    expect(endedEarly).toBe('ended');
    // A switch that has moved the grant before the logout is asked: the logout learns it lost, and the switch's grant stands.
    const second = await grants.grant_make(KEY);
    const movedFirst = await grants.grant_move(second.id, 'fedcba9876543210');
    const endedAfter = await grants.grant_end(second.id);
    expect(movedFirst).not.toBeNull();
    expect(endedAfter).toBe('moved');
    expect(grants.grant_admits(second.id, KEY)).toBe(false);
    expect(grants.grant_admits(movedFirst?.id ?? '', 'fedcba9876543210')).toBe(true);
  });

  it('closes what a grant holds when it ends, at its hour with no traffic, and keeps another grant\'s open', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-11-27T00:00:00Z') });
    const grants: GrantStore = new GrantStore(join(dir, 'door-grants.json'), 1);
    const a = await grants.grant_make(KEY);
    const b = await grants.grant_make(KEY);
    const closed: string[] = [];
    grants.connection_hold(a.id, { connection_close: (): void => { closed.push('a-ws'); } });
    grants.connection_hold(a.id, { connection_close: (): void => { closed.push('a-boot'); } });
    grants.connection_hold(b.id, { connection_close: (): void => { closed.push('b-ws'); } });
    await grants.grant_end(a.id);
    expect(closed.sort()).toEqual(['a-boot', 'a-ws']);
    jest.advanceTimersByTime(3_600_000 + 5);
    expect(closed).toContain('b-ws');
    grants.timers_stop();
  });

  it('keeps a thirty-day grant\'s connection on day twenty-five and closes it on day thirty, a day at a time', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-11-01T00:00:00Z') });
    const grants: GrantStore = new GrantStore(join(dir, 'door-grants.json'), 30 * 24);
    const made = await grants.grant_make(KEY);
    let closed: boolean = false;
    grants.connection_hold(made.id, { connection_close: (): void => { closed = true; } });
    jest.advanceTimersByTime(25 * GRANT_STEP_MS);
    expect(closed).toBe(false);
    jest.advanceTimersByTime(5 * GRANT_STEP_MS + 5);
    expect(closed).toBe(true);
    grants.timers_stop();
  });
});

describe('FrameCloser', () => {
  /** A server frame: unmasked, final, text. */
  const frame = (payload: string): Buffer => Buffer.concat([Buffer.from([0x81, payload.length]), Buffer.from(payload)]);

  it('passes the upgrade answer and the frames, then closes at a frame boundary with the grant code', async () => {
    const closer: FrameCloser = new FrameCloser();
    const out: Buffer[] = [];
    closer.on('data', (chunk: Buffer): void => { out.push(chunk); });
    const ended: Promise<void> = new Promise((resolve) => { closer.on('end', () => resolve()); });
    const answer: Buffer = Buffer.from('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\n\r\n');
    const one: Buffer = frame('hello');
    // The handshake and half a frame arrive; the close is asked for mid-frame; the frame's rest arrives with another after it.
    closer.write(Buffer.concat([answer, one.subarray(0, 4)]));
    closer.close_request('signed out');
    closer.write(Buffer.concat([one.subarray(4), frame('after')]));
    await ended;
    const all: Buffer = Buffer.concat(out);
    expect(all.subarray(0, answer.length).equals(answer)).toBe(true);
    expect(all.subarray(answer.length, answer.length + one.length).equals(one)).toBe(true);
    const close: Buffer = all.subarray(answer.length + one.length);
    expect(close[0]).toBe(0x88);
    expect(close.readUInt16BE(2)).toBe(GRANT_CLOSE_CODE);
    expect(close.subarray(4).toString()).toBe('signed out');
    expect(all.includes(Buffer.from('after'))).toBe(false);
  });

  it('reads frame headers of every length form', () => {
    expect(frameHeader_read(Buffer.from([0x81]))).toBeNull();
    expect(frameHeader_read(Buffer.from([0x81, 5]))).toEqual({ headerLength: 2, payloadLength: 5 });
    expect(frameHeader_read(Buffer.from([0x82, 126, 0x01, 0x00]))).toEqual({ headerLength: 4, payloadLength: 256 });
    const long: Buffer = Buffer.alloc(10);
    long[0] = 0x82; long[1] = 127; long.writeBigUInt64BE(70000n, 2);
    expect(frameHeader_read(long)).toEqual({ headerLength: 10, payloadLength: 70000 });
  });

  it('closes at once between frames, through a stream to a browser', async () => {
    const closer: FrameCloser = new FrameCloser();
    const browser: PassThrough = new PassThrough();
    closer.pipe(browser);
    closer.write(Buffer.from('HTTP/1.1 101 x\r\n\r\n'));
    closer.write(frame('one'));
    const got: Buffer[] = [];
    browser.on('data', (chunk: Buffer): void => { got.push(chunk); });
    const done: Promise<void> = new Promise((resolve) => { browser.on('end', () => resolve()); });
    closer.close_request('signed out');
    await done;
    expect(Buffer.concat(got).includes(Buffer.from([0x88]))).toBe(true);
  });
});

describe('what Codex found in the first form (seq 419)', () => {
  /** A writer that writes as the door does, and fails the writes a test names. */
  const writing = (fail: Set<number>) => {
    let count: number = 0;
    return async (path: string, body: string): Promise<void> => {
      count += 1;
      if (fail.has(count)) throw new Error('the disk is full');
      writeFileSync(path, body, { mode: 0o600 });
    };
  };

  it('a logout whose write fails refuses the cookie at once, and the same logout asked again writes it; a restart honours only the other browser', async () => {
    const path: string = join(dir, 'door-grants.json');
    const fail: Set<number> = new Set();
    const grants: GrantStore = new GrantStore(path, 8, undefined, writing(fail));
    const a = await grants.grant_make(KEY);
    const b = await grants.grant_make(KEY);
    fail.add(3);
    await expect(grants.grant_end(a.id)).rejects.toThrow('the disk is full');
    expect(grants.grant_admits(a.id, KEY)).toBe(false);
    // The file still holds it: a restart now would let it in, so the logout is asked again.
    expect(readFileSync(path, 'utf8')).toContain(a.id);
    expect(await grants.grant_end(a.id)).toBe('ended');
    const again: GrantStore = new GrantStore(path, 8);
    await again.grants_load();
    expect(again.grant_admits(a.id, KEY)).toBe(false);
    expect(again.grant_admits(b.id, KEY)).toBe(true);
  });

  it('a change whose write fails is carried by no later write, whatever order they overlap in', async () => {
    const path: string = join(dir, 'door-grants.json');
    const fail: Set<number> = new Set([2]);
    const grants: GrantStore = new GrantStore(path, 8, undefined, writing(fail));
    const standing = await grants.grant_make(KEY);
    // A switch whose write fails, and a login whose write succeeds after it.
    const [moved, made] = await Promise.allSettled([grants.grant_move(standing.id, 'fedcba9876543210'), grants.grant_make(KEY)]);
    expect(moved.status).toBe('rejected');
    expect(made.status).toBe('fulfilled');
    const reopened: GrantStore = new GrantStore(path, 8);
    expect(await reopened.grants_load()).toBe(2);
    expect(reopened.grant_admits(standing.id, KEY)).toBe(true);
    expect(grants.grant_admits(standing.id, KEY)).toBe(true);
  });

  it('refuses a grant that would grow the file past what the door reads back, and a full store still reopens and revokes', async () => {
    const path: string = join(dir, 'door-grants.json');
    // A store at its bound: grants written straight to the file.
    const one = { id: 'c'.repeat(64), key: KEY, expires: '2099-01-01T00:00:00.000Z' };
    const each: number = Buffer.byteLength(JSON.stringify(one)) + 1;
    const count: number = Math.floor((4 * 1024 * 1024 - 64) / each);
    const records = Array.from({ length: count }, (_v: unknown, i: number) => ({ ...one, id: i.toString(16).padStart(64, '0') }));
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, grants: records }), { mode: 0o600 });
    const grants: GrantStore = new GrantStore(path, 8);
    expect(await grants.grants_load()).toBe(count);
    await expect(grants.grant_make(KEY)).rejects.toThrow('would grow past');
    expect(await grants.grant_end(records[0]?.id ?? '')).toBe('ended');
    expect(grants.grant_admits(records[0]?.id ?? '', KEY)).toBe(false);
  });

  it('writes away grants past their hour, so the file holds only those that stand', async () => {
    let now: number = Date.parse('2026-11-27T00:00:00Z');
    const path: string = join(dir, 'door-grants.json');
    const grants: GrantStore = new GrantStore(path, 1, (): number => now);
    const old = await grants.grant_make(KEY);
    now += 3_600_000 + 1;
    const fresh = await grants.grant_make(KEY);
    const kept: string = readFileSync(path, 'utf8');
    expect(kept).not.toContain(old.id);
    expect(kept).toContain(fresh.id);
  });
});

describe('closeReason_bytes', () => {
  it('fits a close frame by UTF-8 bytes and never cuts a character in half', () => {
    expect(closeReason_bytes('signed out').toString('utf8')).toBe('signed out');
    const euros: Buffer = closeReason_bytes('€'.repeat(50));
    expect(euros.length).toBe(123);
    expect(euros.toString('utf8')).toBe('€'.repeat(41));
    const mixed: Buffer = closeReason_bytes(`${'a'.repeat(122)}€`);
    expect(mixed.length).toBe(122);
    expect(closeReason_bytes('😀'.repeat(40)).length).toBeLessThanOrEqual(CLOSE_REASON_MAX_BYTES);
    // The frame's length byte stays a length: no mask bit.
    expect(2 + closeReason_bytes('€'.repeat(50)).length).toBeLessThan(126);
  });
});
