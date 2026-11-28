/**
 * @file The door's token store and device codes.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore, DeviceCodes, token_looksLike, deviceCode_make, deviceCode_normalise, DEVICE_CODE_LIFE_MS, DOOR_TOKEN_PREFIX } from '../../src/tokens.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'porter-tokens-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('TokenStore', () => {
  it('mints a prefixed plaintext, keeps only its hash at mode 0600, and lets the plaintext back in', async () => {
    const store = new TokenStore(join(dir, 'state', 'tokens.json'), 30);
    await store.load();
    const { token, record } = await store.mint('chris@https://cube/api/v1/', 'chris', 'cron@titan');
    expect(token_looksLike(token)).toBe(true);
    expect(token.startsWith(DOOR_TOKEN_PREFIX)).toBe(true);
    expect(record.hash).not.toContain(token.slice(DOOR_TOKEN_PREFIX.length, DOOR_TOKEN_PREFIX.length + 8));
    const kept: string = await readFile(join(dir, 'state', 'tokens.json.d', 's0', '1.json'), 'utf8');
    expect(kept).not.toContain(token);
    expect(kept).toContain('cron@titan');
    expect((await stat(join(dir, 'state', 'tokens.json.d', 's0', '1.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'state', 'tokens.json.d'))).mode & 0o777).toBe(0o700);
    expect(await store.check(token)).toMatchObject({ ok: true, record: { user: 'chris', name: 'cron@titan' } });
    expect(await store.check(`${DOOR_TOKEN_PREFIX}not-the-one-${'x'.repeat(30)}`)).toEqual({ ok: false, why: 'unknown' });
  });

  it('comes back from disk, says when a token died, and revokes by name or all', async () => {
    let now: number = Date.parse('2026-10-06T00:00:00Z');
    const clock = (): Date => new Date(now);
    const path: string = join(dir, 'tokens.json');
    const store = new TokenStore(path, 30, clock);
    await store.load();
    const a = await store.mint('chris@c/', 'chris', 'cron@titan');
    const b = await store.mint('chris@c/', 'chris', 'laptop');
    const c = await store.mint('kim@c/', 'kim', 'cron@titan');
    expect(a.record.expires).toBe('2026-11-05T00:00:00.000Z');

    const again = new TokenStore(path, 30, clock);
    await again.load();
    expect((await again.list()).map((t) => `${t.user}/${t.name}`).sort()).toEqual(['chris/cron@titan', 'chris/laptop', 'kim/cron@titan']);
    expect((await again.check(b.token)).ok).toBe(true);

    now = Date.parse('2026-11-05T00:00:01Z');
    expect(await again.check(a.token)).toMatchObject({ ok: false, why: 'expired', record: { name: 'cron@titan' } });
    expect(await again.revoke('chris', 'laptop')).toBe(1);
    expect(await again.check(b.token)).toEqual({ ok: false, why: 'unknown' });
    expect(await again.revoke('chris')).toBe(1);
    expect((await again.list()).map((t) => t.user)).toEqual(['kim']);
    expect((await again.check(c.token)).ok).toBe(false); // kim's also died on the day
  });

  it('minting the same name for the same identity replaces the old token, and a token login records the use', async () => {
    const store = new TokenStore(join(dir, 'tokens.json'), 30);
    await store.load();
    const first = await store.mint('chris@c/', 'chris', 'cron@titan');
    const second = await store.mint('chris@c/', 'chris', 'cron@titan');
    expect(await store.list()).toHaveLength(1);
    expect(await store.check(first.token)).toEqual({ ok: false, why: 'unknown' });
    const checked = await store.check(second.token);
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.record.lastUsed).toBeNull();
      expect((await store.login_authorize(second.token, (user: string): string => `${user}@c/`)).ok).toBe(true);
      expect((await store.list())[0]?.lastUsed).not.toBeNull();
    }
  });

  it('notices a change another process made to the file: a revocation from the CLI is seen by the running door', async () => {
    const path: string = join(dir, 'tokens.json');
    const door = new TokenStore(path, 30);
    await door.load();
    const minted = await door.mint('chris@c/', 'chris', 'cron@titan');
    expect((await door.check(minted.token)).ok).toBe(true);
    // The CLI, in another process: its own store over the same file.
    const cli = new TokenStore(path, 30);
    await cli.load();
    expect(await cli.revoke('chris', 'cron@titan')).toBe(1);
    expect(await door.check(minted.token)).toEqual({ ok: false, why: 'unknown' });
    const byCli = await cli.mint('kim@c/', 'kim', 'laptop');
    expect((await door.check(byCli.token)).ok).toBe(true);
    expect((await door.list()).map((t) => t.user)).toEqual(['kim']);
  });

  it('refuses a file that is not a token store rather than starting empty', async () => {
    const path: string = join(dir, 'tokens.json');
    await (await import('node:fs/promises')).writeFile(path, '{"nope":true}');
    const store = new TokenStore(path, 30);
    await expect(store.load()).rejects.toThrow('is not a token file');
  });
});

describe('DeviceCodes', () => {
  it('issues a readable code, is pending until authorised, hands the grant once, then forgets it', async () => {
    let now: number = 1_000_000;
    const codes = new DeviceCodes((): number => now);
    const issued = codes.issue('titan');
    expect(issued.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(codes.host_find(issued.code)).toBe('titan');
    expect(codes.host_find(issued.code.toLowerCase().replace('-', ''))).toBe('titan');
    expect(codes.take(issued.code)).toEqual({ state: 'pending' });
    // Only a login that claimed the code may authorise it; a second claim is refused while the first holds it.
    expect(codes.authorise(issued.code, 'no-claim', { token: 'pdt_z', user: 'chris', name: 'chris@titan', expires: 'later' })).toBe(false);
    const claimed = codes.code_claim(issued.code);
    expect(claimed?.host).toBe('titan');
    expect(codes.code_claim(issued.code)).toBeNull();
    expect(codes.host_find(issued.code)).toBeNull();
    // Another login's claim neither completes nor lets go of this one.
    codes.claim_release(issued.code, 'another');
    expect(codes.code_claim(issued.code)).toBeNull();
    expect(codes.authorise(issued.code, 'another', { token: 'pdt_w', user: 'kim', name: 'kim@titan', expires: 'later' })).toBe(false);
    expect(codes.authorise(issued.code, claimed?.claim ?? '', { token: 'pdt_x', user: 'chris', name: 'chris@titan', expires: 'later' })).toBe(true);
    expect(codes.host_find(issued.code)).toBeNull(); // a code authorised is no longer waiting on the page
    expect(codes.authorise(issued.code, claimed?.claim ?? '', { token: 'pdt_y', user: 'kim', name: 'kim@titan', expires: 'later' })).toBe(false);
    expect(codes.take(issued.code)).toEqual({ state: 'authorised', grant: { token: 'pdt_x', user: 'chris', name: 'chris@titan', expires: 'later' } });
    expect(codes.take(issued.code)).toEqual({ state: 'unknown' });

    const late = codes.issue('pangea');
    now += DEVICE_CODE_LIFE_MS + 1;
    expect(codes.take(late.code)).toEqual({ state: 'unknown' });
    expect(codes.host_find(late.code)).toBeNull();
  });

  it('makes codes without the letters that read as digits, and normalises what a human types', async () => {
    for (let i = 0; i < 50; i++) expect(deviceCode_make()).not.toMatch(/[01OIL]/);
    expect(deviceCode_normalise('k7pd 3mxq')).toBe('K7PD-3MXQ');
    expect(deviceCode_normalise('K7PD-3MXQ')).toBe('K7PD-3MXQ');
    expect(deviceCode_normalise('short')).toBe('SHORT');
  });
});
