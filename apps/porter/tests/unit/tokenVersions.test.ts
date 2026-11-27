/**
 * @file The token store as versions: the door and the operator's CLI are
 * two writers of one store, and no change either reports as made is ever
 * lost, none is made twice, and none reported as failed is made. Each
 * writer here is its own `TokenStore` over the same folder, sharing
 * nothing but the files; a hook runs another writer's whole change
 * between this one's read and its publication, or just after it.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore, LAST_USED_SAMPLE_MS, type StoreHooks } from '../../src/tokens.js';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'porter-versions-'));
  path = join(dir, 'tokens.json');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** A writer over the store. */
function writer(hooks: StoreHooks = {}, now: () => Date = (): Date => new Date()): TokenStore {
  const store: TokenStore = new TokenStore(path, 30, now, hooks);
  store.load();
  return store;
}

/** The versions published, by number. */
function versions(): number[] {
  return readdirSync(`${path}.d`).filter((name: string): boolean => /^[0-9]+\.json$/.test(name)).map((name: string): number => Number(name.slice(0, -5))).sort((a, b) => a - b);
}

/** The door's identity for a username. */
const AT = (user: string): string => `${user}@c/`;

describe('the exclusive link is the commit', () => {
  it('a change published, then built on by another writer, returns its own result and makes nothing more', () => {
    const b: TokenStore = writer();
    const victim = b.mint('kim@c/', 'kim', 'laptop');
    b.mint('ann@c/', 'ann', 'cron');
    let afterA: number = 0;
    const a: TokenStore = writer({ publish_after: (): void => { afterA = versions().length; b.mint('zed@c/', 'zed', 'other'); } });
    expect(a.revoke('kim', 'laptop')).toBe(1);
    // A made one version; B built on it; A made nothing after.
    expect(versions().length).toBe(afterA + 1);
    expect(b.check(victim.token)).toEqual({ ok: false, why: 'unknown' });
    expect(b.list().map((t) => t.user).sort()).toEqual(['ann', 'zed']);
  });

  it('a writer that read long ago, while eight and more versions were published and emptied, loses its slot and makes its change once on the current store', () => {
    const other: TokenStore = writer();
    other.mint('seed@c/', 'seed', 'x');
    let fired: boolean = false;
    const slow: TokenStore = writer({ read_after: (): void => {
      if (fired) return;
      fired = true;
      for (let i = 0; i < 12; i++) other.mint(`u${String(i)}@c/`, `u${String(i)}`, 'n');
    } });
    const made = slow.mint('slow@c/', 'slow', 'late');
    const final = other.list();
    expect(final.filter((t) => t.user === 'slow')).toHaveLength(1);
    expect(final.filter((t) => t.user.startsWith('u'))).toHaveLength(12);
    expect(other.check(made.token).ok).toBe(true);
    // Old versions were emptied, never removed: every name below stays taken.
    const numbers: number[] = versions();
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_v, i) => i + 1));
    expect(statSync(join(`${path}.d`, '1.json')).size).toBe(0);
  });

  it('a revocation racing a token login: the token stays revoked, and the login is refused', () => {
    const door0: TokenStore = writer();
    const held = door0.mint('kim@c/', 'kim', 'laptop');
    const cli: TokenStore = writer();
    let raced: boolean = false;
    const door: TokenStore = writer({ read_after: (): void => {
      if (raced) return;
      raced = true;
      expect(cli.revoke_presented(held.token)?.name).toBe('laptop');
    } });
    expect(door.authorize(held.token, AT)).toEqual({ ok: false, why: 'unknown' });
    expect(cli.check(held.token)).toEqual({ ok: false, why: 'unknown' });
  });

  it('every change reported as made is in the final store, under writers interleaved at both points', () => {
    const made: string[] = [];
    const base: TokenStore = writer();
    let depth: number = 0;
    const meddler: StoreHooks = {
      read_after: (): void => { if (depth++ < 3) made.push(base.mint(`r${String(depth)}@c/`, `r${String(depth)}`, 'n').record.user); },
      publish_after: (): void => { if (depth++ < 6) made.push(base.mint(`p${String(depth)}@c/`, `p${String(depth)}`, 'n').record.user); },
    };
    const busy: TokenStore = writer(meddler);
    for (let i = 0; i < 4; i++) made.push(busy.mint(`b${String(i)}@c/`, `b${String(i)}`, 'n').record.user);
    expect(base.list().map((t) => t.user).sort()).toEqual([...made].sort());
  });

  it('a publication that fails for a reason other than a taken name fails the change, and makes nothing', () => {
    const before: TokenStore = writer();
    before.mint('seed@c/', 'seed', 'x');
    const a: TokenStore = writer({ read_after: (): void => { chmodSync(`${path}.d`, 0o500); } });
    try {
      expect(() => a.mint('kim@c/', 'kim', 'laptop')).toThrow();
    } finally {
      chmodSync(`${path}.d`, 0o700);
    }
    expect(before.list().map((t) => t.user)).toEqual(['seed']);
  });

  it('a token login within the hour of its last notes nothing new', () => {
    let now: number = Date.parse('2026-11-27T10:00:00Z');
    const store: TokenStore = writer({}, (): Date => new Date(now));
    const held = store.mint('kim@c/', 'kim', 'laptop');
    expect(store.authorize(held.token, AT).ok).toBe(true);
    const after: number = versions().length;
    now += LAST_USED_SAMPLE_MS - 1;
    expect(store.authorize(held.token, AT).ok).toBe(true);
    expect(versions().length).toBe(after);
    now += 2;
    expect(store.authorize(held.token, AT).ok).toBe(true);
    expect(versions().length).toBe(after + 1);
  });

  it('refuses a token minted for another CUBE\'s identity of the same username', () => {
    const store: TokenStore = writer();
    const elsewhere = store.mint('kim@other/', 'kim', 'laptop');
    const here = store.mint('kim@c/', 'kim', 'laptop');
    expect(store.authorize(elsewhere.token, AT)).toMatchObject({ ok: false, why: 'foreign' });
    expect(store.authorize(here.token, AT).ok).toBe(true);
    // Logging out with one leaves the other.
    expect(store.revoke_presented(elsewhere.token)?.identity).toBe('kim@other/');
    expect(store.check(here.token).ok).toBe(true);
  });

  it('a logout with a token that was replaced under the same name leaves the replacement valid', () => {
    const store: TokenStore = writer();
    const old = store.mint('kim@c/', 'kim', 'laptop');
    const replacement = store.mint('kim@c/', 'kim', 'laptop');
    expect(store.revoke_presented(old.token)).toBeNull();
    expect(store.check(replacement.token).ok).toBe(true);
    expect(store.revoke_presented(replacement.token)?.name).toBe('laptop');
    expect(store.check(replacement.token)).toEqual({ ok: false, why: 'unknown' });
  });
});

describe('migration from the one-file store', () => {
  const legacy = (tokens: unknown[]): void => { writeFileSync(path, JSON.stringify({ schemaVersion: 1, tokens }), { mode: 0o600 }); };
  const RECORD = { name: 'laptop', identity: 'kim@c/', user: 'kim', hash: 'a'.repeat(64), created: '2026-11-01T00:00:00.000Z', expires: '2099-01-01T00:00:00.000Z', lastUsed: null };

  it('reads the legacy file while no version holds its records, then publishes it and archives the file', () => {
    legacy([RECORD]);
    const store: TokenStore = writer();
    expect(store.list().map((t) => t.name)).toEqual(['laptop']);
    expect(versions()).toEqual([1]);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.migrated`)).toBe(true);
  });

  it('an empty versions folder beside a valid legacy file: the legacy file is the truth, and the next open migrates', () => {
    legacy([RECORD]);
    // Folder made, nothing published: as a crash right after its mkdir.
    mkdirSync(`${path}.d/tmp`, { recursive: true, mode: 0o700 });
    const store: TokenStore = writer();
    expect(store.list().map((t) => t.name)).toEqual(['laptop']);
    expect(versions()).toEqual([1]);
  });

  it('a crash after publishing and before archiving: the version is the truth, and the next open archives', () => {
    legacy([RECORD]);
    writer();
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, tokens: [] }));
    const store: TokenStore = writer();
    expect(store.list().map((t) => t.name)).toEqual(['laptop']);
    expect(existsSync(path)).toBe(false);
  });

  it('two first opens at once: one publishes, the other reads the current version', () => {
    legacy([RECORD]);
    let second: TokenStore | null = null;
    const first: TokenStore = new TokenStore(path, 30, (): Date => new Date(), { read_after: (): void => {
      if (second === null) { second = new TokenStore(path, 30); second.load(); }
    } });
    first.load();
    expect(versions()).toEqual([1]);
    expect(first.list().map((t) => t.name)).toEqual(['laptop']);
    expect((second as TokenStore | null)?.list().map((t) => t.name)).toEqual(['laptop']);
  });

  it('two stores with different names in one folder stay apart', () => {
    const a: TokenStore = new TokenStore(join(dir, 'a.json'), 30);
    const b: TokenStore = new TokenStore(join(dir, 'b.json'), 30);
    a.load();
    b.load();
    a.mint('kim@c/', 'kim', 'laptop');
    expect(b.list()).toEqual([]);
    expect(a.list()).toHaveLength(1);
  });

  it('leaves out, and counts, a record of the wrong shape; the rest load', () => {
    legacy([RECORD, { ...RECORD, hash: 'not-hex' }, { name: 'x' }]);
    const store: TokenStore = writer();
    expect(store.list().map((t) => t.name)).toEqual(['laptop']);
    expect(store.skipped).toBe(2);
    expect(readFileSync(join(`${path}.d`, '1.json'), 'utf8')).not.toContain('not-hex');
  });
});
