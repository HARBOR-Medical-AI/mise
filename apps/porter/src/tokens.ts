/**
 * @file Door tokens: how a script comes through the door without a password.
 *
 * A token is minted once by a human login (a browser code or a password)
 * and carried by scripts afterwards as `Authorization: Bearer …`. The door
 * keeps only its hash, with the identity it is for, a name the operator
 * can read (`cron@titan`), when it was minted and when it dies. A token
 * dies on its day: no sliding refresh, so a leaked key in steady use still
 * ends, and every script is re-blessed by a human on the horizon the
 * operator set (`PORTER_TOKEN_DAYS`). Revocation is by name.
 *
 * Device codes are the browser half of `chell auth login`: chell asks for
 * a short one-time code, the human opens the door's login page on any
 * device, logs in with the code, and the door hands chell the token it
 * minted. A code lives ten minutes and is taken once.
 *
 * The store is a folder of versions in the porter's own state, each a JSON
 * file at mode 0600 published whole by an exclusive link, so the door and
 * the operator's CLI never lose each other's changes; the plaintext is
 * never in it. A token's last use is sampled at most once an hour.
 *
 * @module
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What the plaintext starts with, so a token is recognisable in a log or a leak. */
export const DOOR_TOKEN_PREFIX: string = 'pdt_';

/** How long a device code waits to be authorised, in ms. */
export const DEVICE_CODE_LIFE_MS: number = 10 * 60 * 1000;

/** One token the door knows: everything but the plaintext. */
export interface DoorToken {
  /** The operator-readable name, unique per identity (`cron@titan`). */
  name: string;
  /** The canonical identity (`user@cubeUrl`) the token logs in as. */
  identity: string;
  /** The CUBE username, for lists and the journal. */
  user: string;
  /** SHA-256 of the plaintext, hex. */
  hash: string;
  /** ISO time it was minted. */
  created: string;
  /** ISO time it dies. */
  expires: string;
  /** ISO time it last let someone in, or null when never. */
  lastUsed: string | null;
}

/**
 * A token let in.
 *
 * @example
 * ```ts
 * const admitted: TokenAdmitted = { ok: true, record };
 * ```
 */
export interface TokenAdmitted {
  /** It lets someone in. */
  ok: true;
  /** Its record. */
  record: DoorToken;
}

/**
 * A token the store holds that is refused: past its day, or minted for another CUBE's identity.
 *
 * @example
 * ```ts
 * const refused: TokenRefused = { ok: false, why: 'foreign', record };
 * ```
 */
export interface TokenRefused {
  /** It does not let anyone in. */
  ok: false;
  /** Why: it died, or it is another door's. */
  why: 'expired' | 'foreign';
  /** Its record. */
  record: DoorToken;
}

/**
 * A token the store does not hold.
 *
 * @example
 * ```ts
 * const unknown: TokenUnknown = { ok: false, why: 'unknown' };
 * ```
 */
export interface TokenUnknown {
  /** It does not let anyone in. */
  ok: false;
  /** Why: revoked, or never minted here. */
  why: 'unknown';
}

/** What the store answers for a presented token. */
export type TokenCheck = TokenAdmitted | TokenRefused | TokenUnknown;

/** The file's shape on disk. */
interface TokenFile {
  schemaVersion: 1;
  tokens: DoorToken[];
}

/** Makes a fresh plaintext token: 32 random bytes, base64url, prefixed. */
export function token_make(): string {
  return `${DOOR_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** Hashes a plaintext token the way the store keeps it. */
export function token_hash(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

/** Whether a string looks like a door token, before any lookup. */
export function token_looksLike(value: string): boolean {
  return value.startsWith(DOOR_TOKEN_PREFIX) && value.length > DOOR_TOKEN_PREFIX.length + 20;
}

/** The most a version of the store holds: well beyond any door's tokens. */
const VERSION_MAX_BYTES: number = 4 * 1024 * 1024;

/** How many versions below the current one keep their records; older ones are emptied, never removed. */
const VERSIONS_KEPT: number = 8;

/** How often a change that lost its race is tried again on the newer store before it refuses. */
const PUBLISH_TRIES: number = 64;

/** How long a temporary version a writer left behind is kept before it is swept, in ms. */
const TEMP_LIFE_MS: number = 3_600_000;

/** How seldom a token's last use is written down: at most once an hour. */
export const LAST_USED_SAMPLE_MS: number = 3_600_000;

/** One version of the store as read: its number and its records. */
interface StoreVersion {
  /** The version's number; 0 for a store that has none yet (the legacy file, or nothing). */
  n: number;
  /** Its records. */
  tokens: DoorToken[];
  /** How many records it held of the wrong shape, left out. */
  skipped: number;
}

/** What a change made of the records it read: its answer, and the records to publish, if any. */
interface ChangeOutcome<T> {
  /** What the change answers its caller. */
  result: T;
  /** The next version's records; absent when the change changes nothing. */
  next?: DoorToken[];
}

/** What a change to the store does with what it read. */
type StoreChange<T> = (tokens: DoorToken[]) => ChangeOutcome<T>;

/** Records as read, with how many of the wrong shape were left out. */
interface RecordsRead {
  /** The records kept. */
  tokens: DoorToken[];
  /** How many were left out. */
  skipped: number;
}

/**
 * Where in a transaction a test may step in, to stand for another writer.
 *
 * @example
 * ```ts
 * new TokenStore(path, 30, undefined, { read_after: () => { other.mint(identity, user, 'n'); } });
 * ```
 */
export interface StoreHooks {
  /** After the current version is read, before the next is published. */
  read_after?: () => void;
  /** After the next version is published. */
  publish_after?: () => void;
}

/**
 * Whether a field is an ISO time.
 *
 * @param value - The field.
 * @returns True for a string that parses as a time.
 *
 * @example
 * ```ts
 * time_isIso('2026-11-27T00:00:00.000Z'); // true
 * ```
 */
function time_isIso(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * Reads one record of the store as a token, or says it is not one.
 *
 * @param value - The record as parsed.
 * @returns The token, or null for a record of the wrong shape.
 *
 * @example
 * ```ts
 * tokenRecord_read({ name: 'laptop', identity: 'me@c/', user: 'me', hash: 'ab…', created, expires, lastUsed: null });
 * ```
 */
export function tokenRecord_read(value: unknown): DoorToken | null {
  if (value === null || typeof value !== 'object') return null;
  const held: Record<string, unknown> = value as Record<string, unknown>;
  const { name, identity, user, hash, created, expires, lastUsed } = held;
  if (typeof name !== 'string' || name.length === 0 || typeof identity !== 'string' || identity.length === 0) return null;
  if (typeof user !== 'string' || user.length === 0 || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null;
  if (!time_isIso(created) || !time_isIso(expires) || (lastUsed !== null && !time_isIso(lastUsed))) return null;
  return { name, identity, user, hash, created, expires, lastUsed };
}

/**
 * The door's token store: minted, checked, revoked, listed, persisted.
 *
 * The store is a folder of versions beside the file it is named by
 * (`<file>.d/`): each change writes the next version whole and publishes
 * it with an exclusive link, so a version exists whole or not at all, and
 * two writers (the door and the operator's CLI) can never both publish
 * the same version. The link is the commit: a writer that loses (the name
 * is taken) reads the newer version and applies its change again. A
 * version's name is never freed: old versions are emptied, not removed, so
 * a writer that read long ago can only lose. Every question reads the
 * current version afresh; nothing is answered from a copy in memory.
 *
 * @example
 * ```ts
 * const store = new TokenStore('/var/lib/porter/tokens.json', 30);
 * store.load();
 * const { token } = store.mint('me@https://cube/api/v1/', 'me', 'laptop');
 * ```
 */
export class TokenStore {
  /** How many records the store held of the wrong shape when it was opened, left out. */
  public skipped: number = 0;
  private readonly versions: string;
  private readonly temps: string;

  /**
   * @param path - The store's file: the versions live in `<path>.d/` (0700), and a legacy file at the path is migrated.
   * @param days - How long a minted token lives.
   * @param now - The clock, replaceable in tests.
   * @param hooks - Where a test stands in for another writer.
   */
  public constructor(
    private readonly path: string,
    private readonly days: number,
    private readonly now: () => Date = (): Date => new Date(),
    private readonly hooks: StoreHooks = {},
  ) {
    this.versions = `${path}.d`;
    this.temps = join(this.versions, 'tmp');
  }

  /**
   * Opens the store: migrates a legacy file into the first version when
   * there is none, and reads the current one, so a store that does not
   * parse is refused loudly at start. Safe to repeat, and safe at once from
   * two processes.
   *
   * @throws {Error} When the current version, or the legacy file, is not a token file.
   */
  public load(): void {
    mkdirSync(this.temps, { recursive: true, mode: 0o700 });
    this.temps_sweep();
    const current: StoreVersion = this.current_read();
    // What was left out of the store as found, said once at start: a migrated version holds only what was kept.
    this.skipped = current.skipped;
    if (current.n === 0 && existsSync(this.path)) {
      // The legacy file is the truth until a whole version holds its records; another opener may publish it first.
      this.hooks.read_after?.();
      this.version_publish(1, current.tokens);
    }
    if (this.highest_find() > 0) {
      try {
        renameSync(this.path, `${this.path}.migrated`);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    this.current_read();
  }

  /**
   * Mints a token for an identity. A token of the same name for the same
   * identity is replaced, so `login` again on the same host never leaves
   * a forgotten key behind.
   *
   * @param identity - The canonical identity.
   * @param user - The CUBE username.
   * @param name - The operator-readable name.
   * @returns The plaintext, shown once, and the record kept.
   */
  public mint(identity: string, user: string, name: string): { token: string; record: DoorToken } {
    const token: string = token_make();
    const created: Date = this.now();
    const record: DoorToken = {
      name,
      identity,
      user,
      hash: token_hash(token),
      created: created.toISOString(),
      expires: new Date(created.getTime() + this.days * 24 * 3600 * 1000).toISOString(),
      lastUsed: null,
    };
    this.transact((tokens: DoorToken[]) => ({
      result: undefined,
      next: [...tokens.filter((held: DoorToken): boolean => !(held.identity === identity && held.name === name)), record],
    }));
    return { token, record };
  }

  /**
   * Checks a presented plaintext against the current store, in constant
   * time per record, and says why when it fails. Read afresh every time.
   *
   * @param plain - The token as presented.
   * @returns The record when it lets someone in.
   */
  public check(plain: string): TokenCheck {
    return token_find(this.current_read().tokens, plain, this.now());
  }

  /**
   * Lets a token in, as one change of the store: read afresh, the record
   * found by the presented hash, its expiry and its identity checked
   * against the door's, and its use written down (at most once an hour).
   * A token revoked meanwhile is refused, never touched back to life.
   *
   * @param plain - The token as presented.
   * @param identityAt - The identity the door serves for a username.
   * @returns The record when it lets someone in, or why not.
   *
   * @example
   * ```ts
   * store.authorize(bearer, (user) => identity_normalise(user, cubeUrl));
   * ```
   */
  public authorize(plain: string, identityAt: (user: string) => string): TokenCheck {
    return this.transact<TokenCheck>((tokens: DoorToken[]) => {
      const found: TokenCheck = token_find(tokens, plain, this.now());
      if (!found.ok) return { result: found };
      if (identityAt(found.record.user) !== found.record.identity) return { result: { ok: false, why: 'foreign', record: found.record } };
      const last: number = found.record.lastUsed === null ? 0 : Date.parse(found.record.lastUsed);
      if (this.now().getTime() - last < LAST_USED_SAMPLE_MS) return { result: found };
      const used: DoorToken = { ...found.record, lastUsed: this.now().toISOString() };
      return { result: { ok: true, record: used }, next: tokens.map((held: DoorToken): DoorToken => (held.hash === used.hash ? used : held)) };
    });
  }

  /**
   * Revokes a user's tokens at every CUBE: one by name, or all of them.
   * The operator's command (`porter --revoke`).
   *
   * @param user - The CUBE username.
   * @param name - The token's name, or undefined for every one of the user's.
   * @returns How many went.
   */
  public revoke(user: string, name?: string): number {
    return this.transact((tokens: DoorToken[]) => {
      const next: DoorToken[] = tokens.filter((held: DoorToken): boolean => !(held.user === user && (name === undefined || held.name === name)));
      return next.length === tokens.length ? { result: 0 } : { result: tokens.length - next.length, next };
    });
  }

  /**
   * Revokes the one token presented, by its hash: a logout by a token in
   * hand ends that token and no other, a replacement of the same name
   * included.
   *
   * @param plain - The token as presented.
   * @returns The record that went, or null when the store holds no such token.
   *
   * @example
   * ```ts
   * store.revoke_presented(bearer)?.name; // 'laptop'
   * ```
   */
  public revoke_presented(plain: string): DoorToken | null {
    const hash: string = token_hash(plain);
    return this.transact<DoorToken | null>((tokens: DoorToken[]) => {
      const gone: DoorToken | undefined = tokens.find((held: DoorToken): boolean => held.hash === hash);
      return gone === undefined ? { result: null } : { result: gone, next: tokens.filter((held: DoorToken): boolean => held !== gone) };
    });
  }

  /**
   * Every token the door knows, as kept (no plaintext exists to show), read afresh.
   *
   * @returns The records.
   *
   * @example
   * ```ts
   * store.list().map((token) => token.name);
   * ```
   */
  public list(): DoorToken[] {
    return this.current_read().tokens;
  }

  /**
   * One change: the current version read, the change applied, the next
   * version published. Losing the race (the next version's name taken) is
   * the only reason to try again, on the newer store; any other failure
   * fails the change.
   *
   * @param change - What the change does with the records it reads.
   * @returns The change's answer, once its version is published (or when it changes nothing).
   * @throws {Error} When publishing fails other than by a lost race, or the store keeps changing past the bound.
   */
  private transact<T>(change: StoreChange<T>): T {
    for (let attempt: number = 0; attempt < PUBLISH_TRIES; attempt++) {
      const current: StoreVersion = this.current_read();
      const out: ChangeOutcome<T> = change(current.tokens.map((held: DoorToken): DoorToken => ({ ...held })));
      if (out.next === undefined) return out.result;
      this.hooks.read_after?.();
      if (this.version_publish(current.n + 1, out.next)) {
        this.hooks.publish_after?.();
        this.versions_prune(current.n + 1);
        return out.result;
      }
    }
    throw new Error(`the door's token store at ${this.path} kept changing under this change; try again`);
  }

  /**
   * Publishes a version: written whole to a fresh file, then linked to its
   * name, which fails if the name is taken.
   *
   * @param n - The version's number.
   * @param tokens - Its records.
   * @returns True when published; false when another writer holds that version.
   * @throws {Error} When the version cannot be written or linked other than by a taken name.
   */
  private version_publish(n: number, tokens: DoorToken[]): boolean {
    const temp: string = join(this.temps, `${String(n)}.${String(process.pid)}.${randomBytes(6).toString('hex')}`);
    const body: TokenFile = { schemaVersion: 1, tokens };
    writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      linkSync(temp, join(this.versions, `${String(n)}.json`));
      return true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    } finally {
      rmSync(temp, { force: true });
    }
  }

  /**
   * The highest version's number, emptied or not.
   *
   * @returns The number; 0 when there is none.
   * @throws {Error} When the versions folder cannot be read.
   */
  private highest_find(): number {
    return this.versionNumbers_list()[0] ?? 0;
  }

  /**
   * Every version's number, highest first.
   *
   * @returns The numbers; none when there is no versions folder.
   * @throws {Error} When the versions folder cannot be read.
   */
  private versionNumbers_list(): number[] {
    let names: string[];
    try {
      names = readdirSync(this.versions);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return names
      .map((name: string): number => (/^[1-9][0-9]*\.json$/.test(name) ? Number(name.slice(0, -5)) : 0))
      .filter((n: number): boolean => n > 0)
      .sort((a: number, b: number): number => b - a);
  }

  /**
   * The current version: the highest that holds records. One emptied
   * between the listing and the read sends the reader back to the listing.
   * With no version yet, the legacy file, or nothing.
   *
   * @returns The current version.
   * @throws {Error} When it is not a token file, or no version holds records.
   */
  private current_read(): StoreVersion {
    for (let attempt: number = 0; attempt < PUBLISH_TRIES; attempt++) {
      const numbers: number[] = this.versionNumbers_list();
      const highest: number | undefined = numbers[0];
      if (highest === undefined) return { n: 0, ...this.legacy_read() };
      const text: string | null = this.versionText_read(join(this.versions, `${String(highest)}.json`));
      if (text !== null) return { n: highest, ...this.tokens_parse(text, `version ${String(highest)}`) };
    }
    throw new Error(`the door's token store at ${this.path} has no version that holds its records`);
  }

  /**
   * A version's text.
   *
   * @param path - The version's file.
   * @returns Its text, or null when it was emptied.
   * @throws {Error} When it cannot be read, or is larger than a store.
   */
  private versionText_read(path: string): string | null {
    const text: string = readFileSync(path, 'utf8');
    if (text.length > VERSION_MAX_BYTES) throw new Error(`the door's token store at ${path} is larger than a token store`);
    return text.length === 0 ? null : text;
  }

  /**
   * The legacy file's records.
   *
   * @returns Its records, or none when there is no file.
   * @throws {Error} When it is not a token file.
   */
  private legacy_read(): RecordsRead {
    if (!existsSync(this.path)) return { tokens: [], skipped: 0 };
    return this.tokens_parse(readFileSync(this.path, 'utf8'), 'the file');
  }

  /**
   * Parses a store's text: a file that is not a token file is refused
   * loudly, since silently starting empty would let every script's key
   * stop working with no word why; a record of the wrong shape is left out,
   * and counted.
   *
   * @param text - The store's text.
   * @param which - Which file it is, for the words.
   * @returns The records kept, and how many were left out.
   * @throws {Error} When it is not a token file.
   */
  private tokens_parse(text: string, which: string): RecordsRead {
    const parsed: unknown = JSON.parse(text);
    const records: unknown = parsed !== null && typeof parsed === 'object' ? (parsed as { tokens?: unknown }).tokens : undefined;
    if (!Array.isArray(records)) throw new Error(`the door's token store at ${this.path} (${which}) is not a token file`);
    const tokens: DoorToken[] = [];
    let skipped: number = 0;
    for (const record of records) {
      const read: DoorToken | null = tokenRecord_read(record);
      if (read === null) skipped++;
      else tokens.push(read);
    }
    return { tokens, skipped };
  }

  /**
   * Empties versions well below the one just published; their names stay taken.
   *
   * @param published - The version just published.
   */
  private versions_prune(published: number): void {
    for (const n of this.versionNumbers_list()) {
      if (n > published - VERSIONS_KEPT) continue;
      const path: string = join(this.versions, `${String(n)}.json`);
      if (statSync(path).size === 0) continue;
      const empty: string = join(this.temps, `empty.${String(process.pid)}.${randomBytes(6).toString('hex')}`);
      writeFileSync(empty, '', { mode: 0o600, flag: 'wx' });
      renameSync(empty, path);
    }
  }

  /** Sweeps temporary files a writer that died left behind. */
  private temps_sweep(): void {
    const cutoff: number = Date.now() - TEMP_LIFE_MS;
    for (const name of readdirSync(this.temps)) {
      const path: string = join(this.temps, name);
      try {
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
      } catch {
        // Swept meanwhile by another writer.
      }
    }
  }
}

/**
 * Finds a presented token among records, in constant time per record.
 *
 * @param tokens - The records.
 * @param plain - The token as presented.
 * @param now - The time it is.
 * @returns The record, or why not.
 */
function token_find(tokens: DoorToken[], plain: string, now: Date): TokenCheck {
  const presented: Buffer = Buffer.from(token_hash(plain), 'hex');
  for (const record of tokens) {
    const kept: Buffer = Buffer.from(record.hash, 'hex');
    if (kept.length !== presented.length || !timingSafeEqual(kept, presented)) continue;
    if (Date.parse(record.expires) <= now.getTime()) return { ok: false, why: 'expired', record };
    return { ok: true, record };
  }
  return { ok: false, why: 'unknown' };
}

/** What a device code hands chell once a human authorised it. */
export interface DeviceGrant {
  token: string;
  user: string;
  name: string;
  expires: string;
}

/** One code waiting, authorised, or spent. */
interface DeviceCode {
  /** The host chell runs on, for the page ("authorise chell on titan") and the token's name. */
  host: string;
  issued: number;
  grant: DeviceGrant | null;
}

/** The letters a code is made of: no 0/O, 1/I/L, so it survives being read aloud. */
const CODE_ALPHABET: string = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Makes a code like `K7PD-3MXQ`. */
export function deviceCode_make(): string {
  const bytes: Buffer = randomBytes(8);
  let code: string = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += CODE_ALPHABET[(bytes[i] as number) % CODE_ALPHABET.length];
  }
  return code;
}

/** Normalises a code as a human might type it: upper case, the dash optional. */
export function deviceCode_normalise(typed: string): string {
  const letters: string = typed.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : typed.trim().toUpperCase();
}

/**
 * The device codes the door has out: issued by chell, authorised by a human
 * on the login page, taken once by chell's poll.
 */
export class DeviceCodes {
  private readonly codes: Map<string, DeviceCode> = new Map();

  public constructor(private readonly now: () => number = (): number => Date.now()) {}

  /**
   * Issues a code for a chell on a host.
   *
   * @param host - Where chell runs.
   * @returns The code and when it stops being accepted.
   */
  public issue(host: string): { code: string; expires: string } {
    this.sweep();
    let code: string = deviceCode_make();
    while (this.codes.has(code)) code = deviceCode_make();
    const issued: number = this.now();
    this.codes.set(code, { host, issued, grant: null });
    return { code, expires: new Date(issued + DEVICE_CODE_LIFE_MS).toISOString() };
  }

  /**
   * Looks a code up for the login page.
   *
   * @param code - As typed.
   * @returns The host chell runs on, or null when the code is not out.
   */
  public host_find(code: string): string | null {
    this.sweep();
    const held: DeviceCode | undefined = this.codes.get(deviceCode_normalise(code));
    return held === undefined || held.grant !== null ? null : held.host;
  }

  /**
   * Authorises a code: a human logged in with it.
   *
   * @param code - As typed.
   * @param grant - What chell gets.
   * @returns Whether the code was waiting.
   */
  public authorise(code: string, grant: DeviceGrant): boolean {
    this.sweep();
    const held: DeviceCode | undefined = this.codes.get(deviceCode_normalise(code));
    if (held === undefined || held.grant !== null) return false;
    held.grant = grant;
    return true;
  }

  /**
   * Chell's poll: the grant once, pending while the human has not yet
   * logged in, unknown after the code died or was taken.
   *
   * @param code - As chell was given it.
   */
  public take(code: string): { state: 'pending' } | { state: 'unknown' } | { state: 'authorised'; grant: DeviceGrant } {
    this.sweep();
    const held: DeviceCode | undefined = this.codes.get(code);
    if (held === undefined) return { state: 'unknown' };
    if (held.grant === null) return { state: 'pending' };
    this.codes.delete(code);
    return { state: 'authorised', grant: held.grant };
  }

  /** Forgets codes past their life. */
  private sweep(): void {
    const cutoff: number = this.now() - DEVICE_CODE_LIFE_MS;
    for (const [code, held] of this.codes) {
      if (held.issued < cutoff) this.codes.delete(code);
    }
  }
}
