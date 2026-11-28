/**
 * @file The token store as versions: the door and the operator's CLI are
 * two writers of one store, and no change either reports as made is ever
 * lost, none is made twice, and none reported as failed is made. Each
 * writer here is its own `TokenStore` over the same folder, sharing
 * nothing but the files; a hook runs another writer's whole change
 * between this one's read and its publication, or just after it.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore, LAST_USED_SAMPLE_MS, tokenRecord_read, type StoreHooks } from '../../src/tokens.js';

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
  return readdirSync(`${path}.d`).filter((folder: string): boolean => /^s[0-9]+$/.test(folder))
    .flatMap((folder: string): string[] => readdirSync(join(`${path}.d`, folder)))
    .filter((name: string): boolean => /^[0-9]+\.json$/.test(name)).map((name: string): number => Number(name.slice(0, -5))).sort((a, b) => a - b);
}

/** A version's file. */
function versionFile(n: number): string {
  return join(`${path}.d`, `s${String(Math.floor(n / 1000))}`, `${String(n)}.json`);
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
    expect(statSync(versionFile(1)).size).toBe(0);
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
    expect(door.login_authorize(held.token, AT)).toEqual({ ok: false, why: 'unknown' });
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
    const a: TokenStore = writer({ read_after: (): void => { chmodSync(join(`${path}.d`, 's0'), 0o500); } });
    try {
      expect(() => a.mint('kim@c/', 'kim', 'laptop')).toThrow();
    } finally {
      chmodSync(join(`${path}.d`, 's0'), 0o700);
    }
    expect(before.list().map((t) => t.user)).toEqual(['seed']);
  });

  it('a token login within the hour of its last notes nothing new', () => {
    let now: number = Date.parse('2026-11-27T10:00:00Z');
    const store: TokenStore = writer({}, (): Date => new Date(now));
    const held = store.mint('kim@c/', 'kim', 'laptop');
    expect(store.login_authorize(held.token, AT).ok).toBe(true);
    const after: number = versions().length;
    now += LAST_USED_SAMPLE_MS - 1;
    expect(store.login_authorize(held.token, AT).ok).toBe(true);
    expect(versions().length).toBe(after);
    now += 2;
    expect(store.login_authorize(held.token, AT).ok).toBe(true);
    expect(versions().length).toBe(after + 1);
  });

  it('refuses a token minted for another CUBE\'s identity of the same username', () => {
    const store: TokenStore = writer();
    const elsewhere = store.mint('kim@other/', 'kim', 'laptop');
    const here = store.mint('kim@c/', 'kim', 'laptop');
    expect(store.login_authorize(elsewhere.token, AT)).toMatchObject({ ok: false, why: 'foreign' });
    expect(store.login_authorize(here.token, AT).ok).toBe(true);
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
    // The crash came between the publication and the archive: the same file still stands at its name.
    renameSync(`${path}.migrated`, path);
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
    expect(store.skipped).toEqual(['#2 ("laptop")', '#3 ("x")']);
    expect(readFileSync(versionFile(1), 'utf8')).not.toContain('not-hex');
  });
});

describe('what Codex found in the first form (seq 398)', () => {
  const RECORD = { name: 'laptop', identity: 'kim@c/', user: 'kim', hash: 'a'.repeat(64), created: '2026-11-01T00:00:00.000Z', expires: '2099-01-01T00:00:00.000Z', lastUsed: null };

  it('a change committed is answered as made, though the upkeep after it fails', () => {
    const other: TokenStore = writer();
    const a: TokenStore = writer({ publish_after: (): void => { chmodSync(join(`${path}.d`, 'tmp'), 0o500); } });
    let made: ReturnType<TokenStore['mint']> | undefined;
    try {
      made = a.mint('kim@c/', 'kim', 'laptop');
    } finally {
      chmodSync(join(`${path}.d`, 'tmp'), 0o700);
    }
    expect(made?.record.name).toBe('laptop');
    expect(other.check(made?.token ?? '').ok).toBe(true);
    expect(other.list()).toHaveLength(1);
  });

  it('refuses a change whose version would be larger than a reader accepts, counted in UTF-8 bytes, and publishes nothing', () => {
    const store: TokenStore = writer();
    const before: number[] = versions();
    // Four-byte characters: a name the reader's byte rule refuses well before its character count would.
    const wide: string = '\u{1F600}'.repeat(1_100_000);
    expect(() => store.mint('kim@c/', 'kim', wide)).toThrow('would grow past');
    expect(versions()).toEqual(before);
    expect(store.list()).toEqual([]);
  });

  it('leaves a legacy store too large to migrate where it is, refused loudly', () => {
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, tokens: [RECORD], pad: 'x'.repeat(4 * 1024 * 1024) }));
    expect(() => new TokenStore(path, 30).load()).toThrow('larger than a token store');
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.migrated`)).toBe(false);
  });

  it('an opener whose legacy file another opener archived between its look and its read reads the version instead', () => {
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, tokens: [RECORD] }));
    let raced: boolean = false;
    // This opener finds no version; before it reads the legacy file, the other opener migrates and archives it.
    const late: TokenStore = new TokenStore(path, 30, (): Date => new Date(), { legacy_before: (): void => {
      if (raced) return;
      raced = true;
      writer();
    } });
    late.load();
    expect(raced).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(late.list().map((t) => t.name)).toEqual(['laptop']);
  });

  it('reads only times in the store\'s own form', () => {
    expect(tokenRecord_read(RECORD)).not.toBeNull();
    for (const created of ['2026-11-01', 'Nov 1 2026', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00.000+01:00', '1']) {
      expect(tokenRecord_read({ ...RECORD, created })).toBeNull();
    }
  });

  it('lets nobody in on a token two records claim, and a logout by it removes every copy', () => {
    const store: TokenStore = writer();
    const held = store.mint('kim@c/', 'kim', 'laptop');
    // A tampered store: the same token's record twice, under two names.
    const current: string = versionFile(versions().at(-1) ?? 0);
    const body = JSON.parse(readFileSync(current, 'utf8')) as { tokens: Array<Record<string, unknown>> };
    writeFileSync(versionFile((versions().at(-1) ?? 0) + 1), JSON.stringify({ schemaVersion: 1, tokens: [...body.tokens, { ...body.tokens[0], name: 'copy' }] }));
    expect(store.check(held.token)).toEqual({ ok: false, why: 'unknown' });
    expect(store.login_authorize(held.token, AT)).toEqual({ ok: false, why: 'unknown' });
    expect(store.revoke_presented(held.token)?.name).toBe('laptop');
    expect(store.list()).toEqual([]);
  });

  it('finds the current version by listing at most one folder of versions, and empties one slot per publication', () => {
    const store: TokenStore = writer();
    for (let i = 0; i < 20; i++) store.mint(`u${String(i)}@c/`, `u${String(i)}`, 'n');
    expect(store.list()).toHaveLength(20);
    const sizes: number[] = versions().map((n: number): number => statSync(versionFile(n)).size);
    expect(sizes.slice(0, -8).every((size: number): boolean => size === 0)).toBe(true);
    expect(sizes.slice(-8).every((size: number): boolean => size > 0)).toBe(true);
  });

});

describe('what agy broke in the first form (attack B1a)', () => {
  const RECORD = { name: 'laptop', identity: 'kim@c/', user: 'kim', hash: 'a'.repeat(64), created: '2026-11-01T00:00:00.000Z', expires: '2099-01-01T00:00:00.000Z', lastUsed: null };

  it('a planted version number past the last, or filed in the wrong folder, is not a version', () => {
    const store: TokenStore = writer();
    store.mint('kim@c/', 'kim', 'laptop');
    mkdirSync(join(`${path}.d`, 's9007199254740'), { recursive: true });
    writeFileSync(join(`${path}.d`, 's9007199254740', '9007199254740992.json'), JSON.stringify({ schemaVersion: 1, tokens: [] }));
    mkdirSync(join(`${path}.d`, 's1'), { recursive: true });
    writeFileSync(join(`${path}.d`, 's1', '5.json'), JSON.stringify({ schemaVersion: 1, tokens: [] }));
    writeFileSync(join(`${path}.d`, 's0', '999999999999999999999.json'), '{}');
    expect(store.list().map((t) => t.name)).toEqual(['laptop']);
    store.mint('ann@c/', 'ann', 'cron');
    expect(store.list().map((t) => t.name).sort()).toEqual(['cron', 'laptop']);
  });

  it('a pipe at the current version or at the legacy file is refused, not waited on', () => {
    const store: TokenStore = writer();
    store.mint('kim@c/', 'kim', 'laptop');
    const next: string = versionFile((versions().at(-1) ?? 0) + 1);
    execFileSync('mkfifo', [next]);
    expect(() => store.list()).toThrow('not a file of its own');
    rmSync(next);
    const other: string = join(dir, 'piped.json');
    execFileSync('mkfifo', [other]);
    expect(() => new TokenStore(other, 30).load()).toThrow('not a file of its own');
  });

  it('a link at the current version or at the legacy file is refused, not followed', () => {
    const outside: string = join(dir, 'outside.json');
    writeFileSync(outside, JSON.stringify({ schemaVersion: 1, tokens: [RECORD] }));
    const store: TokenStore = writer();
    store.mint('ann@c/', 'ann', 'cron');
    symlinkSync(outside, versionFile((versions().at(-1) ?? 0) + 1));
    expect(() => store.list()).toThrow('not a file of its own');
    const linked: string = join(dir, 'linked.json');
    symlinkSync(outside, linked);
    expect(() => new TokenStore(linked, 30).load()).toThrow('not a file of its own');
    expect(existsSync(`${linked}.migrated`)).toBe(false);
  });

  it('a legacy file changed after it was migrated is left as it is, and said', () => {
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, tokens: [RECORD] }));
    let changed: boolean = false;
    const opener: TokenStore = new TokenStore(path, 30, (): Date => new Date(), { read_after: (): void => {
      if (changed) return;
      changed = true;
      // An older porter writes the one-file store between this opener's read and its publication.
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, tokens: [RECORD, { ...RECORD, name: 'newer', hash: 'b'.repeat(64) }] }));
    } });
    opener.load();
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.migrated`)).toBe(false);
    expect(opener.legacyNote).toContain('changed after it was migrated');
    // The same file reopened unchanged since its migration is archived.
    rmSync(`${path}.d`, { recursive: true, force: true });
    const fresh: TokenStore = writer();
    expect(fresh.legacyNote).toBeNull();
    expect(existsSync(`${path}.migrated`)).toBe(true);
  });
});

