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
import { chmodSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, utimesSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore, LAST_USED_SAMPLE_MS, tokenRecord_read, token_hash, type StoreHooks } from '../../src/tokens.js';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'porter-versions-'));
  path = join(dir, 'tokens.json');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** A writer over the store. */
async function writer(hooks: StoreHooks = {}, now: () => Date = (): Date => new Date()): Promise<TokenStore> {
  const store: TokenStore = new TokenStore(path, 30, now, hooks);
  await store.load();
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
  it('a change published, then built on by another writer, returns its own result and makes nothing more', async () => {
    const b: TokenStore = await writer();
    const victim = await b.mint('kim@c/', 'kim', 'laptop');
    await b.mint('ann@c/', 'ann', 'cron');
    let afterA: number = 0;
    const a: TokenStore = await writer({ publish_after: async (): Promise<void> => { afterA = versions().length; await b.mint('zed@c/', 'zed', 'other'); } });
    expect(await a.revoke('kim', 'laptop')).toBe(1);
    // A made one version; B built on it; A made nothing after.
    expect(versions().length).toBe(afterA + 1);
    expect(await b.check(victim.token)).toEqual({ ok: false, why: 'unknown' });
    expect((await b.list()).map((t) => t.user).sort()).toEqual(['ann', 'zed']);
  });

  it('a writer that read long ago, while eight and more versions were published and emptied, loses its slot and makes its change once on the current store', async () => {
    const other: TokenStore = await writer();
    await other.mint('seed@c/', 'seed', 'x');
    let fired: boolean = false;
    const slow: TokenStore = await writer({ read_after: async (): Promise<void> => {
      if (fired) return;
      fired = true;
      for (let i = 0; i < 12; i++) await other.mint(`u${String(i)}@c/`, `u${String(i)}`, 'n');
    } });
    const made = await slow.mint('slow@c/', 'slow', 'late');
    const final = await other.list();
    expect(final.filter((t) => t.user === 'slow')).toHaveLength(1);
    expect(final.filter((t) => t.user.startsWith('u'))).toHaveLength(12);
    expect((await other.check(made.token)).ok).toBe(true);
    // Old versions were emptied, never removed: every name below stays taken.
    const numbers: number[] = versions();
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_v, i) => i + 1));
    expect(statSync(versionFile(1)).size).toBe(0);
  });

  it('a revocation racing a token login: the token stays revoked, and the login is refused', async () => {
    const door0: TokenStore = await writer();
    const held = await door0.mint('kim@c/', 'kim', 'laptop');
    const cli: TokenStore = await writer();
    let raced: boolean = false;
    const door: TokenStore = await writer({ read_after: async (): Promise<void> => {
      if (raced) return;
      raced = true;
      expect((await cli.revoke_presented(held.token))?.name).toBe('laptop');
    } });
    expect(await door.login_authorize(held.token, AT)).toEqual({ ok: false, why: 'unknown' });
    expect(await cli.check(held.token)).toEqual({ ok: false, why: 'unknown' });
  });

  it('every change reported as made is in the final store, under writers interleaved at both points', async () => {
    const made: string[] = [];
    const base: TokenStore = await writer();
    let depth: number = 0;
    const meddler: StoreHooks = {
      read_after: async (): Promise<void> => { if (depth++ < 3) made.push((await base.mint(`r${String(depth)}@c/`, `r${String(depth)}`, 'n')).record.user); },
      publish_after: async (): Promise<void> => { if (depth++ < 6) made.push((await base.mint(`p${String(depth)}@c/`, `p${String(depth)}`, 'n')).record.user); },
    };
    const busy: TokenStore = await writer(meddler);
    for (let i = 0; i < 4; i++) made.push((await busy.mint(`b${String(i)}@c/`, `b${String(i)}`, 'n')).record.user);
    expect((await base.list()).map((t) => t.user).sort()).toEqual([...made].sort());
  });

  it('a publication that fails for a reason other than a taken name fails the change, and makes nothing', async () => {
    const before: TokenStore = await writer();
    await before.mint('seed@c/', 'seed', 'x');
    // Between the read and the publication, the folder of versions is put aside and a file stands at its name.
    const folder: string = join(`${path}.d`, 's0');
    const a: TokenStore = await writer({ read_after: async (): Promise<void> => { renameSync(folder, `${folder}.aside`); writeFileSync(folder, 'x'); } });
    try {
      await expect(a.mint('kim@c/', 'kim', 'laptop')).rejects.toThrow('not a folder of its own');
    } finally {
      rmSync(folder, { force: true });
      renameSync(`${folder}.aside`, folder);
    }
    expect((await before.list()).map((t) => t.user)).toEqual(['seed']);
  });

  it('a token login within the hour of its last notes nothing new', async () => {
    let now: number = Date.parse('2026-11-27T10:00:00Z');
    const store: TokenStore = await writer({}, (): Date => new Date(now));
    const held = await store.mint('kim@c/', 'kim', 'laptop');
    expect((await store.login_authorize(held.token, AT)).ok).toBe(true);
    const after: number = versions().length;
    now += LAST_USED_SAMPLE_MS - 1;
    expect((await store.login_authorize(held.token, AT)).ok).toBe(true);
    expect(versions().length).toBe(after);
    now += 2;
    expect((await store.login_authorize(held.token, AT)).ok).toBe(true);
    expect(versions().length).toBe(after + 1);
  });

  it('refuses a token minted for another CUBE\'s identity of the same username', async () => {
    const store: TokenStore = await writer();
    const elsewhere = await store.mint('kim@other/', 'kim', 'laptop');
    const here = await store.mint('kim@c/', 'kim', 'laptop');
    expect(await store.login_authorize(elsewhere.token, AT)).toMatchObject({ ok: false, why: 'foreign' });
    expect((await store.login_authorize(here.token, AT)).ok).toBe(true);
    // Logging out with one leaves the other.
    expect((await store.revoke_presented(elsewhere.token))?.identity).toBe('kim@other/');
    expect((await store.check(here.token)).ok).toBe(true);
  });

  it('a logout with a token that was replaced under the same name leaves the replacement valid', async () => {
    const store: TokenStore = await writer();
    const old = await store.mint('kim@c/', 'kim', 'laptop');
    const replacement = await store.mint('kim@c/', 'kim', 'laptop');
    expect(await store.revoke_presented(old.token)).toBeNull();
    expect((await store.check(replacement.token)).ok).toBe(true);
    expect((await store.revoke_presented(replacement.token))?.name).toBe('laptop');
    expect(await store.check(replacement.token)).toEqual({ ok: false, why: 'unknown' });
  });
});

describe('migration from the one-file store', () => {
  const legacy = (tokens: unknown[]): void => { writeFileSync(path, JSON.stringify({ schemaVersion: 1, tokens }), { mode: 0o600 }); };
  const RECORD = { name: 'laptop', identity: 'kim@c/', user: 'kim', hash: 'a'.repeat(64), created: '2026-11-01T00:00:00.000Z', expires: '2099-01-01T00:00:00.000Z', lastUsed: null };

  it('reads the legacy file while no version holds its records, then publishes it, and leaves the file as it is', async () => {
    legacy([RECORD]);
    const before: string = readFileSync(path, 'utf8');
    const store: TokenStore = await writer();
    expect((await store.list()).map((t) => t.name)).toEqual(['laptop']);
    expect(versions()).toEqual([1]);
    // Never moved or changed: a copy from before, which the versions now stand for.
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(store.legacyNote).toBeNull();
  });


  it('an empty versions folder beside a valid legacy file: the legacy file is the truth, and the next open migrates', async () => {
    legacy([RECORD]);
    // Folder made, nothing published: as a crash right after its mkdir.
    mkdirSync(`${path}.d/tmp`, { recursive: true, mode: 0o700 });
    const store: TokenStore = await writer();
    expect((await store.list()).map((t) => t.name)).toEqual(['laptop']);
    expect(versions()).toEqual([1]);
  });

  it('once a version holds it, the versions are the store, whatever the file from before still says', async () => {
    legacy([RECORD]);
    const first: TokenStore = await writer();
    await first.revoke('kim');
    const again: TokenStore = await writer();
    expect(await again.list()).toEqual([]);
    expect(again.legacyNote).toBeNull();
  });


  it('two first opens at once: one publishes, the other reads the current version', async () => {
    legacy([RECORD]);
    let second: TokenStore | null = null;
    const first: TokenStore = new TokenStore(path, 30, (): Date => new Date(), { read_after: async (): Promise<void> => {
      if (second === null) { second = new TokenStore(path, 30); await second.load(); }
    } });
    await first.load();
    expect(versions()).toEqual([1]);
    expect((await first.list()).map((t) => t.name)).toEqual(['laptop']);
    expect((await (second as TokenStore | null)?.list()).map((t) => t.name)).toEqual(['laptop']);
  });

  it('two stores with different names in one folder stay apart', async () => {
    const a: TokenStore = new TokenStore(join(dir, 'a.json'), 30);
    const b: TokenStore = new TokenStore(join(dir, 'b.json'), 30);
    await a.load();
    await b.load();
    await a.mint('kim@c/', 'kim', 'laptop');
    expect(await b.list()).toEqual([]);
    expect(await a.list()).toHaveLength(1);
  });

  it('leaves out, and counts, a record of the wrong shape; the rest load', async () => {
    legacy([RECORD, { ...RECORD, hash: 'not-hex' }, { name: 'x' }]);
    const store: TokenStore = await writer();
    expect((await store.list()).map((t) => t.name)).toEqual(['laptop']);
    expect(store.skipped).toEqual(['#2 ("laptop")', '#3 ("x")']);
    expect(readFileSync(versionFile(1), 'utf8')).not.toContain('not-hex');
  });
});

describe('what Codex found in the first form (seq 398)', () => {
  const RECORD = { name: 'laptop', identity: 'kim@c/', user: 'kim', hash: 'a'.repeat(64), created: '2026-11-01T00:00:00.000Z', expires: '2099-01-01T00:00:00.000Z', lastUsed: null };

  it('a change committed is answered as made, though the upkeep after it fails', async () => {
    const other: TokenStore = await writer();
    const a: TokenStore = await writer({ publish_after: async (): Promise<void> => { chmodSync(join(`${path}.d`, 'tmp'), 0o500); } });
    let made: ReturnType<TokenStore['mint']> | undefined;
    try {
      made = await a.mint('kim@c/', 'kim', 'laptop');
    } finally {
      chmodSync(join(`${path}.d`, 'tmp'), 0o700);
    }
    expect(made?.record.name).toBe('laptop');
    expect((await other.check(made?.token ?? '')).ok).toBe(true);
    expect(await other.list()).toHaveLength(1);
  });

  it('refuses a change whose version would be larger than a reader accepts, counted in UTF-8 bytes, and publishes nothing', async () => {
    // A store of records with four-byte names, just under the bound in bytes, though well under it in characters.
    const name: string = '\u{1F600}'.repeat(200);
    const record = (i: number): unknown => ({ ...RECORD, name, user: `u${String(i).padStart(6, '0')}`, hash: i.toString(16).padStart(64, '0') });
    const size = (records: unknown[]): number => Buffer.byteLength(`${JSON.stringify({ schemaVersion: 1, tokens: records }, null, 2)}\n`, 'utf8');
    // Every record serialises to the same size, so the count that lands just under the bound is computed, not searched for.
    const each: number = size([record(0), record(1)]) - size([record(0)]);
    const count: number = Math.floor((4 * 1024 * 1024 - size([])) / each);
    const records: Array<Record<string, unknown>> = Array.from({ length: count }, (_v: unknown, i: number) => record(i) as Record<string, unknown>);
    // Topped up with longer usernames until it stands within 400 bytes of the bound.
    for (let i = 0; i < records.length && 4 * 1024 * 1024 - size(records) > 400; i++) {
      const room: number = Math.min(180, 4 * 1024 * 1024 - size(records) - 300);
      records[i] = { ...records[i], user: `${String(records[i]?.['user'])}${'x'.repeat(room)}` };
    }
    expect(size(records)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(4 * 1024 * 1024 - size(records)).toBeLessThan(400);
    expect(JSON.stringify(records).length).toBeLessThan(4 * 1024 * 1024);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, tokens: records }));
    const store: TokenStore = await writer();
    const before: number[] = versions();
    await expect(store.mint('zed@c/', 'zed', name)).rejects.toThrow('would grow past');
    expect(versions()).toEqual(before);
  });


  it('leaves a legacy store too large to migrate where it is, refused loudly', async () => {
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, tokens: [RECORD], pad: 'x'.repeat(4 * 1024 * 1024) }));
    await expect(new TokenStore(path, 30).load()).rejects.toThrow('larger than a token store');
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.migrated`)).toBe(false);
  });

  it('an opener that finds no version, while another opener migrates before it reads, reads the one version', async () => {
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, tokens: [RECORD] }));
    let raced: boolean = false;
    // This opener finds no version; before it reads the legacy file, the other opener migrates.
    const late: TokenStore = new TokenStore(path, 30, (): Date => new Date(), { legacy_before: async (): Promise<void> => {
      if (raced) return;
      raced = true;
      await writer();
    } });
    await late.load();
    expect(raced).toBe(true);
    expect(versions()).toEqual([1]);
    expect((await late.list()).map((t) => t.name)).toEqual(['laptop']);
  });


  it('reads only times in the store\'s own form', async () => {
    expect(tokenRecord_read(RECORD)).not.toBeNull();
    for (const created of ['2026-11-01', 'Nov 1 2026', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00.000+01:00', '1']) {
      expect(tokenRecord_read({ ...RECORD, created })).toBeNull();
    }
  });

  it('lets nobody in on a token two records claim, and a logout by it removes every copy', async () => {
    const store: TokenStore = await writer();
    const held = await store.mint('kim@c/', 'kim', 'laptop');
    // A tampered store: the same token's record twice, under two names.
    const current: string = versionFile(versions().at(-1) ?? 0);
    const body = JSON.parse(readFileSync(current, 'utf8')) as { tokens: Array<Record<string, unknown>> };
    writeFileSync(versionFile((versions().at(-1) ?? 0) + 1), JSON.stringify({ schemaVersion: 1, tokens: [...body.tokens, { ...body.tokens[0], name: 'copy' }] }));
    expect(await store.check(held.token)).toEqual({ ok: false, why: 'unknown' });
    expect(await store.login_authorize(held.token, AT)).toEqual({ ok: false, why: 'unknown' });
    expect((await store.revoke_presented(held.token))?.name).toBe('laptop');
    expect(await store.list()).toEqual([]);
  });

  it('finds the current version by listing at most one folder of versions, and empties one slot per publication', async () => {
    const store: TokenStore = await writer();
    for (let i = 0; i < 20; i++) await store.mint(`u${String(i)}@c/`, `u${String(i)}`, 'n');
    expect(await store.list()).toHaveLength(20);
    const sizes: number[] = versions().map((n: number): number => statSync(versionFile(n)).size);
    expect(sizes.slice(0, -8).every((size: number): boolean => size === 0)).toBe(true);
    expect(sizes.slice(-8).every((size: number): boolean => size > 0)).toBe(true);
  });

});

describe('what agy broke in the first form (attack B1a)', () => {
  const RECORD = { name: 'laptop', identity: 'kim@c/', user: 'kim', hash: 'a'.repeat(64), created: '2026-11-01T00:00:00.000Z', expires: '2099-01-01T00:00:00.000Z', lastUsed: null };

  it('a planted version number past the last, or filed in the wrong folder, is not a version', async () => {
    const store: TokenStore = await writer();
    await store.mint('kim@c/', 'kim', 'laptop');
    mkdirSync(join(`${path}.d`, 's9007199254740'), { recursive: true });
    writeFileSync(join(`${path}.d`, 's9007199254740', '9007199254740992.json'), JSON.stringify({ schemaVersion: 1, tokens: [] }));
    mkdirSync(join(`${path}.d`, 's1'), { recursive: true });
    writeFileSync(join(`${path}.d`, 's1', '5.json'), JSON.stringify({ schemaVersion: 1, tokens: [] }));
    writeFileSync(join(`${path}.d`, 's0', '999999999999999999999.json'), '{}');
    expect((await store.list()).map((t) => t.name)).toEqual(['laptop']);
    await store.mint('ann@c/', 'ann', 'cron');
    expect((await store.list()).map((t) => t.name).sort()).toEqual(['cron', 'laptop']);
  });

  it('a pipe at the current version or at the legacy file is refused, not waited on', async () => {
    const store: TokenStore = await writer();
    await store.mint('kim@c/', 'kim', 'laptop');
    const next: string = versionFile((versions().at(-1) ?? 0) + 1);
    execFileSync('mkfifo', [next]);
    await expect(store.list()).rejects.toThrow('not a file of its own');
    rmSync(next);
    const other: string = join(dir, 'piped.json');
    execFileSync('mkfifo', [other]);
    await expect(new TokenStore(other, 30).load()).rejects.toThrow('not a file of its own');
  });

  it('a link at the current version or at the legacy file is refused, not followed', async () => {
    const outside: string = join(dir, 'outside.json');
    writeFileSync(outside, JSON.stringify({ schemaVersion: 1, tokens: [RECORD] }));
    const store: TokenStore = await writer();
    await store.mint('ann@c/', 'ann', 'cron');
    symlinkSync(outside, versionFile((versions().at(-1) ?? 0) + 1));
    await expect(store.list()).rejects.toThrow('not a file of its own');
    const linked: string = join(dir, 'linked.json');
    symlinkSync(outside, linked);
    await expect(new TokenStore(linked, 30).load()).rejects.toThrow('not a file of its own');
    expect(existsSync(`${linked}.migrated`)).toBe(false);
  });

  it('a legacy file changed after it was migrated is left as it is, and said', async () => {
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, tokens: [RECORD] }));
    let changed: boolean = false;
    const opener: TokenStore = new TokenStore(path, 30, (): Date => new Date(), { read_after: async (): Promise<void> => {
      if (changed) return;
      changed = true;
      // An older porter writes the one-file store between this opener's read and its publication.
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, tokens: [RECORD, { ...RECORD, name: 'newer', hash: 'b'.repeat(64) }] }));
    } });
    await opener.load();
    expect(existsSync(path)).toBe(true);
    expect(opener.legacyNote).toContain('changed after it was migrated');
    // A later open says it again, and still reads the versions.
    const later: TokenStore = await writer();
    expect(later.legacyNote).toContain('changed after it was migrated');
    expect((await later.list()).map((t) => t.name)).toEqual(['laptop']);
    // A one-file store that cannot be read, once migrated, is said and does not stop the store opening.
    rmSync(path);
    symlinkSync(join(dir, 'nowhere'), path);
    const linked: TokenStore = await writer();
    expect(linked.legacyNote).toContain('could not be compared');
    expect((await linked.list()).map((t) => t.name)).toEqual(['laptop']);
  });

});

describe('what Codex and agy found in the second form (seq 400, attack B1a-2)', () => {
  const RECORD = { name: 'laptop', identity: 'kim@c/', user: 'kim', hash: 'a'.repeat(64), created: '2026-11-01T00:00:00.000Z', expires: '2099-01-01T00:00:00.000Z', lastUsed: null };

  it('sweeps only the names it gives its temporary files: another old file in its folder survives', async () => {
    const store: TokenStore = await writer();
    await store.mint('kim@c/', 'kim', 'laptop');
    const tmp: string = join(`${path}.d`, 'tmp');
    const theirs: string = join(tmp, 'notes.txt');
    const ours: string = join(tmp, `3.${String(process.pid)}.abcdef012345`);
    writeFileSync(theirs, 'kept');
    writeFileSync(ours, 'left by a writer that died');
    const old: Date = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(theirs, old, old);
    utimesSync(ours, old, old);
    await (await writer()).list();
    expect(existsSync(theirs)).toBe(true);
    expect(existsSync(ours)).toBe(false);
  });

  it('refuses a store whose folder is a link, and touches nothing behind it', async () => {
    const outside: string = mkdtempSync(join(tmpdir(), 'porter-outside-'));
    try {
      chmodSync(outside, 0o755);
      symlinkSync(outside, `${path}.d`);
      await expect(new TokenStore(path, 30).load()).rejects.toThrow('not a folder of its own');
      expect(readdirSync(outside)).toEqual([]);
      expect(statSync(outside).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a folder of versions that is a link, or a file, holds no versions; writes go on', async () => {
    const store: TokenStore = await writer();
    await store.mint('kim@c/', 'kim', 'laptop');
    const outside: string = mkdtempSync(join(tmpdir(), 'porter-outside-'));
    try {
      const forged = { ...RECORD, name: 'forged', hash: token_hash('pdt_forged-forged-forged-forged-forged') };
      writeFileSync(join(outside, '1000.json'), JSON.stringify({ schemaVersion: 1, tokens: [forged] }));
      symlinkSync(outside, join(`${path}.d`, 's1'));
      writeFileSync(join(`${path}.d`, 's2'), 'not a folder');
      expect((await store.check('pdt_forged-forged-forged-forged-forged')).ok).toBe(false);
      await store.mint('ann@c/', 'ann', 'cron');
      expect((await store.list()).map((t) => t.name).sort()).toEqual(['cron', 'laptop']);
      expect(readdirSync(outside)).toEqual(['1000.json']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses before publishing a mint whose record would not read back', async () => {
    const store: TokenStore = await writer();
    for (const name of ['', 'a\nb', 'x'.repeat(201)]) await expect(store.mint('kim@c/', 'kim', name)).rejects.toThrow('one short line');
    expect(versions()).toEqual([]);
  });

  it('reads a time only as toISOString writes it: no February 30th, and the extended years it writes', () => {
    expect(tokenRecord_read({ ...RECORD, created: '2026-02-30T00:00:00.000Z' })).toBeNull();
    expect(tokenRecord_read({ ...RECORD, expires: new Date(Date.UTC(12345, 0, 1)).toISOString() })).not.toBeNull();
  });
});

describe('what Codex and agy found in the third form (seq 402, attack B1a-3)', () => {
  it('a revocation published, then the newest folder unreadable: the reader fails, never falls back to the token\'s older life', async () => {
    const store: TokenStore = await writer();
    const held = await store.mint('kim@c/', 'kim', 'laptop');
    expect(await store.revoke_presented(held.token)).not.toBeNull();
    const folder: string = join(`${path}.d`, 's0');
    chmodSync(folder, 0o000);
    try {
      await expect(store.check(held.token)).rejects.toThrow();
      await expect(store.login_authorize(held.token, AT)).rejects.toThrow();
      await expect(store.list()).rejects.toThrow();
    } finally {
      chmodSync(folder, 0o700);
    }
    expect(await store.check(held.token)).toEqual({ ok: false, why: 'unknown' });
  });

  it('a versioned store whose versions vanish refuses, and never starts again from the file from before', async () => {
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, tokens: [{ name: 'laptop', identity: 'kim@c/', user: 'kim', hash: 'a'.repeat(64), created: '2026-11-01T00:00:00.000Z', expires: '2099-01-01T00:00:00.000Z', lastUsed: null }] }));
    const store: TokenStore = await writer();
    await store.revoke('kim');
    expect(existsSync(`${path}.marks`)).toBe(true);
    rmSync(`${path}.d`, { recursive: true, force: true });
    await expect(new TokenStore(path, 30).load()).rejects.toThrow('lost versions');
  });

  it('closes every folder it opened when a publication is refused part way', async () => {
    // A store at version 999, the last of its folder: the next is filed in s1, and a file stands where s1 would be.
    mkdirSync(join(`${path}.d`, 's0'), { recursive: true, mode: 0o700 });
    writeFileSync(versionFile(999), JSON.stringify({ schemaVersion: 1, tokens: [] }), { mode: 0o600 });
    const store: TokenStore = await writer();
    writeFileSync(join(`${path}.d`, 's1'), 'x');
    const open = (): number => readdirSync('/proc/self/fd').length;
    const before: number = open();
    for (let i = 0; i < 10; i++) await expect(store.mint(`u${String(i)}@c/`, `u${String(i)}`, 'n')).rejects.toThrow('not a folder of its own');
    expect(open()).toBe(before);
    rmSync(join(`${path}.d`, 's1'));
    await store.mint('kim@c/', 'kim', 'laptop');
    expect(versions().at(-1)).toBe(1000);
  });


  it('keeps an identity as long as a CUBE url gets, from a one-file store and from a mint', async () => {
    const identity: string = `kim@https://${'h'.repeat(900)}.example.org/api/v1/`;
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, tokens: [{ name: 'laptop', identity, user: 'kim', hash: 'a'.repeat(64), created: '2026-11-01T00:00:00.000Z', expires: '2099-01-01T00:00:00.000Z', lastUsed: null }] }));
    const store: TokenStore = await writer();
    expect(store.skipped).toEqual([]);
    expect((await store.list()).map((t) => t.identity)).toEqual([identity]);
    const made = await store.mint(identity, 'kim', 'cron');
    expect((await store.check(made.token)).ok).toBe(true);
  });
});

describe('what Codex found in the fourth form (seq 404)', () => {
  it('a revocation in the newest folder of versions, then that folder lost: the reader refuses, never answers from the folder before', async () => {
    mkdirSync(join(`${path}.d`, 's0'), { recursive: true, mode: 0o700 });
    const store0: TokenStore = await writer();
    const held = await store0.mint('kim@c/', 'kim', 'laptop');
    // Bring the store to the last version of s0, then revoke into s1.
    const top: number = versions().at(-1) ?? 0;
    const body: string = readFileSync(versionFile(top), 'utf8');
    writeFileSync(versionFile(999), body, { mode: 0o600 });
    const store: TokenStore = await writer();
    expect(await store.revoke_presented(held.token)).not.toBeNull();
    expect(versions().at(-1)).toBe(1000);
    rmSync(join(`${path}.d`, 's1'), { recursive: true, force: true });
    await expect(store.check(held.token)).rejects.toThrow('lost versions');
  });

  it('a first open that finds no version while another opener migrates and marks reads the version, not "lost"', async () => {
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, tokens: [{ name: 'laptop', identity: 'kim@c/', user: 'kim', hash: 'a'.repeat(64), created: '2026-11-01T00:00:00.000Z', expires: '2099-01-01T00:00:00.000Z', lastUsed: null }] }));
    let raced: boolean = false;
    const late: TokenStore = new TokenStore(path, 30, (): Date => new Date(), { listed_after: async (): Promise<void> => {
      if (raced) return;
      raced = true;
      await writer();
    } });
    await late.load();
    expect(raced).toBe(true);
    expect((await late.list()).map((t) => t.name)).toEqual(['laptop']);
  });

  it('no writer lowers the marks, however late; a folder of marks that is not the store\'s refuses', async () => {
    const store: TokenStore = await writer();
    await store.mint('kim@c/', 'kim', 'laptop');
    await store.mint('ann@c/', 'ann', 'cron');
    // A writer that published version 1 long ago marks it now: the highest mark is still the current version.
    writeFileSync(join(`${path}.marks`, '1'), '');
    expect(readdirSync(`${path}.marks`).map(Number).sort((a, b) => a - b).at(-1)).toBe(versions().at(-1));
    expect((await store.list()).map((t) => t.name).sort()).toEqual(['cron', 'laptop']);
    rmSync(`${path}.marks`, { recursive: true });
    writeFileSync(`${path}.marks`, 'x');
    await expect(new TokenStore(path, 30).load()).rejects.toThrow('not a folder of its own');
  });

  it('keeps a one-file store identity longer than any fixed cap, within the store bound', async () => {
    const identity: string = `kim@https://${'h'.repeat(6000)}.example.org/api/v1/`;
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, tokens: [{ name: 'laptop', identity, user: 'kim', hash: 'a'.repeat(64), created: '2026-11-01T00:00:00.000Z', expires: '2099-01-01T00:00:00.000Z', lastUsed: null }] }));
    const store: TokenStore = await writer();
    expect(store.skipped).toEqual([]);
    expect((await store.list())[0]?.identity).toBe(identity);
  });

  it('a renewal leaves the standing token until it is handed over; handed over and current, the older go; not, it goes alone', async () => {
    const store: TokenStore = await writer();
    const standing = await store.mint('kim@c/', 'kim', 'kim@titan');
    // Two renewals by two codes at once; neither handed over, in either order: the standing token still lets in.
    for (const order of [[0, 1], [1, 0]]) {
      const renewals = [await store.mint('kim@c/', 'kim', 'kim@titan', true), await store.mint('kim@c/', 'kim', 'kim@titan', true)];
      for (const i of order) expect((await store.renewal_settle(renewals[i] as never, false)).state).toBe('dropped');
      expect((await store.list()).map((t) => t.hash)).toEqual([standing.record.hash]);
    }
    // A renewal interrupted (minted, never settled: the door stopped): the standing token still lets in.
    const interrupted = await store.mint('kim@c/', 'kim', 'kim@titan', true);
    expect((await store.check(standing.token)).ok).toBe(true);
    const handed = await store.mint('kim@c/', 'kim', 'kim@titan', true);
    expect(await store.renewal_settle(handed, true)).toEqual({ state: 'current', retired: 2 });
    expect((await store.list()).map((t) => t.hash)).toEqual([handed.record.hash]);
    expect(await store.check(interrupted.token)).toEqual({ ok: false, why: 'unknown' });
    // A revocation during a renewal stands.
    const another = await store.mint('kim@c/', 'kim', 'kim@titan', true);
    await store.revoke_presented(handed.token);
    await store.renewal_settle(another, false);
    expect(await store.list()).toEqual([]);
  });

  it('two renewals both handed over, settled in either order, leave the newer standing; a newer operator mint wins over a renewal', async () => {
    for (const order of [[0, 1], [1, 0]]) {
      const store: TokenStore = await writer();
      const standing = await store.mint('kim@c/', 'kim', 'kim@titan');
      const renewals = [await store.mint('kim@c/', 'kim', 'kim@titan', true), await store.mint('kim@c/', 'kim', 'kim@titan', true)];
      const outcomes = [];
      for (const i of order) outcomes[i] = await store.renewal_settle(renewals[i] as never, true);
      expect((await store.list()).map((t) => t.hash)).toEqual([renewals[1]?.record.hash]);
      expect(await store.check(standing.token)).toEqual({ ok: false, why: 'unknown' });
      // The older renewal is superseded when it settles after the newer; current when before it (and then the newer retires it).
      expect(outcomes[0]?.state).toBe(order[0] === 0 ? 'current' : 'superseded');
      expect(outcomes[1]?.state).toBe('current');
      rmSync(`${path}.d`, { recursive: true, force: true });
      rmSync(`${path}.marks`, { recursive: true, force: true });
    }
    const store: TokenStore = await writer();
    const renewal = await store.mint('kim@c/', 'kim', 'kim@titan', true);
    const operator = await store.mint('kim@c/', 'kim', 'kim@titan');
    expect((await store.renewal_settle(renewal, true)).state).toBe('superseded');
    expect((await store.list()).map((t) => t.hash)).toEqual([operator.record.hash]);
  });

  it('a folder planted among the marks does not stop a healthy store opening (agy, attack B1a-6)', async () => {
    const store: TokenStore = await writer();
    for (let i = 0; i < 10; i++) await store.mint(`u${String(i)}@c/`, `u${String(i)}`, 'n');
    mkdirSync(join(`${path}.marks`, '1'), { recursive: true });
    const again: TokenStore = await writer();
    await again.mint('kim@c/', 'kim', 'laptop');
    expect((await again.list())).toHaveLength(11);
  });


  it('a mark not made after a publication is said, and made at the next open', async () => {
    const said: string[] = [];
    // Right after the publication, a file stands where the folder of marks should be.
    const store: TokenStore = new TokenStore(path, 30, (): Date => new Date(), {
      publish_after: async (): Promise<void> => { renameSync(`${path}.marks`, `${path}.marks.aside`); writeFileSync(`${path}.marks`, 'x'); },
      upkeep_failed: (what: string): void => { said.push(what); },
    });
    await store.load();
    await (await writer()).mint('seed@c/', 'seed', 'x');
    let made: boolean = false;
    try {
      await store.mint('kim@c/', 'kim', 'laptop');
      made = true;
    } finally {
      rmSync(`${path}.marks`, { force: true });
      renameSync(`${path}.marks.aside`, `${path}.marks`);
    }
    // The mint stands, and the failure was said.
    expect(made).toBe(true);
    expect(said.some((line) => line.startsWith('the mark for version'))).toBe(true);
    await writer();
    expect(readdirSync(`${path}.marks`).map(Number).sort((a, b) => a - b).at(-1)).toBe(versions().at(-1));
  });

});

describe('what Codex found in the seventh form (seq 410)', () => {
  it('counts as a mark only an empty file of the store\'s own; prunes only marks, and leaves anything else', async () => {
    const store: TokenStore = await writer();
    for (let i = 0; i < 12; i++) await store.mint(`u${String(i)}@c/`, `u${String(i)}`, 'n');
    const top: number = versions().at(-1) ?? 0;
    // A higher-numbered folder, and a higher-numbered file with something in it: neither is a mark.
    mkdirSync(join(`${path}.marks`, String(top + 50)));
    writeFileSync(join(`${path}.marks`, String(top + 60)), 'not empty');
    // An old name holding something: not a mark, so never pruned.
    writeFileSync(join(`${path}.marks`, '2'), 'kept');
    expect(await store.list()).toHaveLength(12);
    await store.mint('kim@c/', 'kim', 'laptop');
    expect(readFileSync(join(`${path}.marks`, '2'), 'utf8')).toBe('kept');
    expect(existsSync(join(`${path}.marks`, String(top + 50)))).toBe(true);
    expect(existsSync(join(`${path}.marks`, String(top + 60)))).toBe(true);
  });
});

