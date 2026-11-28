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
import { FrameCloser, GRANT_CLOSE_CODE, GRANT_STEP_MS, GrantStore, grantCookie_read, grantCookie_value, frameHeader_read } from '../../src/grants.js';

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
    await grants.load();
    const a = await grants.grant_make(KEY);
    const b = await grants.grant_make(KEY);
    expect(grants.grant_admits(a.id, KEY)).toBe(true);
    expect(grants.grant_admits(a.id, 'fedcba9876543210')).toBe(false);
    expect(await grants.grant_end(a.id)).toBe(true);
    expect(grants.grant_admits(a.id, KEY)).toBe(false);
    // Two browsers of one person hold independent grants: one's logout leaves the other's.
    expect(grants.grant_admits(b.id, KEY)).toBe(true);
    const again: GrantStore = new GrantStore(path, 8);
    expect(await again.load()).toBe(1);
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
    expect(await new GrantStore(path, 1, (): number => now).load()).toBe(0);
  });

  it('grants nothing when it cannot keep the grant', async () => {
    writeFileSync(join(dir, 'file'), 'x');
    const grants: GrantStore = new GrantStore(join(dir, 'file', 'door-grants.json'), 8);
    await expect(grants.grant_make(KEY)).rejects.toThrow();
  });

  it('reads its file only as a file of its own: a link at its name is refused', async () => {
    writeFileSync(join(dir, 'elsewhere.json'), JSON.stringify({ schemaVersion: 1, grants: [{ id: 'b'.repeat(64), key: KEY, expires: '2099-01-01T00:00:00.000Z' }] }));
    symlinkSync(join(dir, 'elsewhere.json'), join(dir, 'door-grants.json'));
    await expect(new GrantStore(join(dir, 'door-grants.json'), 8).load()).rejects.toThrow('not a file of its own');
  });

  it('moves a grant only while it stands: a logout first wins, and a move first leaves the logout nothing to end', async () => {
    const grants: GrantStore = new GrantStore(join(dir, 'door-grants.json'), 8);
    const first = await grants.grant_make(KEY);
    const [ended, moved] = await Promise.all([grants.grant_end(first.id), grants.grant_move(first.id, 'fedcba9876543210')]);
    expect(ended).toBe(true);
    expect(moved).toBeNull();
    const second = await grants.grant_make(KEY);
    const [movedFirst, endedAfter] = await Promise.all([grants.grant_move(second.id, 'fedcba9876543210'), grants.grant_end(second.id)]);
    expect(movedFirst).not.toBeNull();
    expect(endedAfter).toBe(false);
    expect(grants.grant_admits(second.id, KEY)).toBe(false);
    expect(grants.grant_admits(movedFirst?.id ?? '', 'fedcba9876543210')).toBe(true);
  });

  it('closes what a grant holds when it ends, at its hour with no traffic, and keeps another grant\'s open', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-11-27T00:00:00Z') });
    const grants: GrantStore = new GrantStore(join(dir, 'door-grants.json'), 1);
    const a = await grants.grant_make(KEY);
    const b = await grants.grant_make(KEY);
    const closed: string[] = [];
    grants.connection_hold(a.id, { close: (): void => { closed.push('a-ws'); } });
    grants.connection_hold(a.id, { close: (): void => { closed.push('a-boot'); } });
    grants.connection_hold(b.id, { close: (): void => { closed.push('b-ws'); } });
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
    grants.connection_hold(made.id, { close: (): void => { closed = true; } });
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
