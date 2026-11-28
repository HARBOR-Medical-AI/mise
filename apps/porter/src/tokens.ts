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
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from 'node:fs';
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
  /** The shape's version. */
  schemaVersion: 1;
  /** The records. */
  tokens: DoorToken[];
  /** The SHA-256 of the one-file store this store was migrated from, carried by every version after. */
  migratedFrom?: string;
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

/** How many versions a folder of versions holds: the highest is found by listing at most one folder. */
const VERSIONS_PER_FOLDER: number = 1000;

/** The highest version number the store names: beyond it a name is not a version (a planted one, say). */
const VERSION_LAST: number = 999_999_999_999;

/** How many versions below the current one keep their records; older ones are emptied, never removed. */
const VERSIONS_KEPT: number = 8;

/** How often a change that lost its race is tried again on the newer store before it refuses. */
const PUBLISH_TRIES: number = 64;

/** How long a temporary version a writer left behind is kept before it is swept, in ms. */
const TEMP_LIFE_MS: number = 3_600_000;

/** How seldom a token's last use is written down: at most once an hour. */
export const LAST_USED_SAMPLE_MS: number = 3_600_000;

/** A time as the store writes it: `toISOString()`'s form, and no other. */
const ISO_TIME: RegExp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** One version of the store as read: its number and its records. */
interface StoreVersion {
  /** The version's number; 0 for a store that has none yet (the legacy file, or nothing). */
  n: number;
  /** Its records. */
  tokens: DoorToken[];
  /** The records it held of the wrong shape, left out: their positions and, where safe, their names. */
  skipped: string[];
  /** Whether it is the legacy one-file store, not a version. */
  legacy: boolean;
  /** The one-file store it was migrated from (its SHA-256), or, for the legacy store itself, its own. */
  migratedFrom?: string;
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
  /** Those left out: their positions and, where safe, their names. */
  skipped: string[];
  /** What the text said it was migrated from. */
  migratedFrom?: string;
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
  /** After a reader found no version, before it reads the legacy file. */
  legacy_before?: () => void;
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
  return typeof value === 'string' && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value));
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
  /** The records the store held of the wrong shape when it was opened, left out: by position and, where safe, by name. */
  public skipped: string[] = [];
  /** Said once at start when the one-file store changed after it was migrated: it is left as it is, not archived. */
  public legacyNote: string | null = null;
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
    if (current.legacy) {
      // The legacy file is the truth until a whole version holds its records; another opener may publish it first.
      this.hooks.read_after?.();
      const temp: string | false = this.version_publish(1, current.tokens, current.migratedFrom);
      if (temp !== false) this.maintenance_run(1, temp);
    }
    this.legacy_archive();
  }

  /**
   * Archives the one-file store once a version holds it: only if it is
   * still the file the store was migrated from. One changed since (an older
   * porter wrote it) is left as it is, and said.
   *
   * @throws {Error} When the file cannot be read or renamed for another reason than its being gone.
   */
  private legacy_archive(): void {
    if (this.highest_find() === 0) return;
    const bytes: Buffer | null = ownFile_read(this.path, VERSION_MAX_BYTES);
    if (bytes === null) return;
    const from: string | undefined = this.current_read().migratedFrom;
    if (from !== bytes_hash(bytes)) {
      this.legacyNote = `the one-file token store at ${this.path} changed after it was migrated (an older porter wrote it); it is left as it is, and the versions in ${this.versions} are the store`;
      return;
    }
    try {
      renameSync(this.path, `${this.path}.migrated`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
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
    this.change_apply((tokens: DoorToken[]) => ({
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
   * store.login_authorize(bearer, (user) => identity_normalise(user, cubeUrl));
   * ```
   */
  public login_authorize(plain: string, identityAt: (user: string) => string): TokenCheck {
    return this.change_apply<TokenCheck>((tokens: DoorToken[]) => {
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
    return this.change_apply((tokens: DoorToken[]) => {
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
    return this.change_apply<DoorToken | null>((tokens: DoorToken[]) => {
      // Every record of that token goes, a copy left by a tampered store included.
      const gone: DoorToken | undefined = tokens.find((held: DoorToken): boolean => held.hash === hash);
      return gone === undefined ? { result: null } : { result: gone, next: tokens.filter((held: DoorToken): boolean => held.hash !== hash) };
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
   * @returns The change's answer, once its version is published (or when it changes nothing); upkeep after the publication never turns it into a failure.
   * @throws {Error} When publishing fails other than by a lost race, or the store keeps changing past the bound.
   */
  private change_apply<T>(change: StoreChange<T>): T {
    for (let attempt: number = 0; attempt < PUBLISH_TRIES; attempt++) {
      const current: StoreVersion = this.current_read();
      const out: ChangeOutcome<T> = change(current.tokens.map((held: DoorToken): DoorToken => ({ ...held })));
      if (out.next === undefined) return out.result;
      this.hooks.read_after?.();
      const temp: string | false = this.version_publish(current.n + 1, out.next, current.migratedFrom);
      if (temp !== false) {
        // Committed: whatever the upkeep after it does, the caller is given what the change did.
        this.hooks.publish_after?.();
        this.maintenance_run(current.n + 1, temp);
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
   * @param migratedFrom - The one-file store the store was migrated from, carried on.
   * @returns The temporary file it was published from, for the upkeep to remove; false when another writer holds that version.
   * @throws {Error} When the version would be larger than a store, or cannot be written or linked other than by a taken name.
   */
  private version_publish(n: number, tokens: DoorToken[], migratedFrom: string | undefined): string | false {
    if (n > VERSION_LAST) throw new Error(`the door's token store at ${this.path} has run out of version numbers`);
    const body: TokenFile = { schemaVersion: 1, tokens, ...(migratedFrom === undefined ? {} : { migratedFrom }) };
    const text: string = `${JSON.stringify(body, null, 2)}\n`;
    // The rule the reader holds a version to, held before it is published: nothing is published that would be refused.
    if (Buffer.byteLength(text, 'utf8') > VERSION_MAX_BYTES) throw new Error(`the door's token store at ${this.path} would grow past ${String(VERSION_MAX_BYTES)} bytes; the change is refused`);
    const temp: string = join(this.temps, `${String(n)}.${String(process.pid)}.${randomBytes(6).toString('hex')}`);
    writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      mkdirSync(this.folder_path(n), { recursive: true, mode: 0o700 });
      linkSync(temp, this.version_path(n));
      return temp;
    } catch (error: unknown) {
      rmSync(temp, { force: true });
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  /**
   * The upkeep after a publication: its temporary file removed, and the
   * version that just fell out of the kept window emptied. Each step is its own: a failure is no failure
   * of the change already committed, and leaves only something to do again.
   *
   * @param published - The version just published.
   * @param temp - Its temporary file.
   */
  private maintenance_run(published: number, temp: string): void {
    const steps: Array<() => void> = [
      (): void => { rmSync(temp, { force: true }); },
      (): void => { this.version_empty(published - VERSIONS_KEPT); },
    ];
    for (const step_run of steps) {
      try {
        step_run();
      } catch {
        // Upkeep only: the version is published whatever this step did.
      }
    }
  }

  /**
   * The highest version's number, emptied or not, by listing the folders of
   * versions and the highest of them: at most a thousand names, however
   * long the store has lived. Only names a writer makes count: a number
   * past the last, or one filed in the wrong folder, is not a version.
   *
   * @returns The number; 0 when there is none.
   * @throws {Error} When a folder cannot be read.
   */
  private highest_find(): number {
    const folders: number[] = names_list(this.versions)
      .map((name: string): number => (/^s(0|[1-9][0-9]{0,9})$/.test(name) ? Number(name.slice(1)) : -1))
      .filter((k: number): boolean => k >= 0 && k * VERSIONS_PER_FOLDER <= VERSION_LAST)
      .sort((a: number, b: number): number => b - a);
    for (const k of folders) {
      const found: number[] = names_list(join(this.versions, `s${String(k)}`))
        .map((name: string): number => (/^[1-9][0-9]{0,11}\.json$/.test(name) ? Number(name.slice(0, -5)) : 0))
        .filter((n: number): boolean => n > 0 && n <= VERSION_LAST && Math.floor(n / VERSIONS_PER_FOLDER) === k);
      if (found.length > 0) return Math.max(...found);
    }
    return 0;
  }

  /**
   * The folder a version is filed in.
   *
   * @param n - The version's number.
   * @returns Its folder.
   */
  private folder_path(n: number): string {
    return join(this.versions, `s${String(Math.floor(n / VERSIONS_PER_FOLDER))}`);
  }

  /**
   * A version's file.
   *
   * @param n - The version's number.
   * @returns Its file.
   */
  private version_path(n: number): string {
    return join(this.folder_path(n), `${String(n)}.json`);
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
      const highest: number = this.highest_find();
      if (highest === 0) {
        const unversioned: StoreVersion | null = this.unversioned_read();
        // The legacy file archived by another opener between the look and the read: its version now holds the truth.
        if (unversioned === null) continue;
        return unversioned;
      }
      const text: string | null = this.versionText_read(this.version_path(highest));
      if (text !== null) return { n: highest, ...this.tokens_parse(text, `version ${String(highest)}`), legacy: false };
    }
    throw new Error(`the door's token store at ${this.path} has no version that holds its records`);
  }

  /**
   * The store while it has no version: the legacy file, or nothing.
   *
   * @returns The legacy file's records, an empty store, or null when a version has appeared meanwhile (another opener migrated).
   * @throws {Error} When the legacy file cannot be read, is larger than a store, or is not a token file.
   */
  private unversioned_read(): StoreVersion | null {
    this.hooks.legacy_before?.();
    const legacy: RecordsRead | null = this.legacy_read();
    if (legacy !== null) return { n: 0, ...legacy, legacy: true };
    return this.highest_find() > 0 ? null : { n: 0, tokens: [], skipped: [], legacy: false };
  }

  /**
   * A version's text.
   *
   * @param path - The version's file.
   * @returns Its text, or null when it was emptied.
   * @throws {Error} When it cannot be read, or is larger than a store.
   */
  private versionText_read(path: string): string | null {
    const bytes: Buffer | null = ownFile_read(path, VERSION_MAX_BYTES);
    if (bytes === null) throw new Error(`the door's token store at ${path} is gone`);
    return bytes.length === 0 ? null : bytes.toString('utf8');
  }

  /**
   * The legacy file's records, read directly (no look first that another opener could outrun).
   *
   * @returns Its records, or null when there is no file.
   * @throws {Error} When it cannot be read, is larger than a store, or is not a token file.
   */
  private legacy_read(): RecordsRead | null {
    // Held to the rule a version is held to, so it is never migrated into one the reader would refuse; refused, it stays as it is.
    const bytes: Buffer | null = ownFile_read(this.path, VERSION_MAX_BYTES);
    if (bytes === null) return null;
    return { ...this.tokens_parse(bytes.toString('utf8'), 'the file'), migratedFrom: bytes_hash(bytes) };
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
    const records: unknown = parsed !== null && typeof parsed === 'object' ? (parsed as Partial<Record<'tokens', unknown>>).tokens : undefined;
    if (!Array.isArray(records)) throw new Error(`the door's token store at ${this.path} (${which}) is not a token file`);
    const from: unknown = (parsed as Partial<Record<'migratedFrom', unknown>>).migratedFrom;
    const tokens: DoorToken[] = [];
    const skipped: string[] = [];
    records.forEach((record: unknown, position: number): void => {
      const read: DoorToken | null = tokenRecord_read(record);
      if (read !== null) {
        tokens.push(read);
        return;
      }
      // Its position, and its name when that is a short plain word: never anything else of it.
      const name: unknown = record !== null && typeof record === 'object' ? (record as Partial<Record<'name', unknown>>).name : undefined;
      skipped.push(typeof name === 'string' && /^[\w@.:-]{1,80}$/.test(name) ? `#${String(position + 1)} ("${name}")` : `#${String(position + 1)}`);
    });
    return { tokens, skipped, ...(typeof from === 'string' && /^[0-9a-f]{64}$/.test(from) ? { migratedFrom: from } : {}) };
  }

  /**
   * Empties one version, the one that fell out of the kept window when a
   * later one was published: one slot per publication, so the upkeep stays
   * the same size however long the store has lived. Its name stays taken.
   *
   * @param n - The version to empty.
   * @throws {Error} When it cannot be emptied.
   */
  private version_empty(n: number): void {
    if (n < 1) return;
    const path: string = this.version_path(n);
    if (!existsSync(path) || lstatSync(path).size === 0) return;
    const empty: string = join(this.temps, `empty.${String(process.pid)}.${randomBytes(6).toString('hex')}`);
    writeFileSync(empty, '', { mode: 0o600, flag: 'wx' });
    renameSync(empty, path);
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
 * The names in a folder.
 *
 * @param folder - The folder.
 * @returns Its names; none when there is no folder.
 * @throws {Error} When it cannot be read for another reason.
 */
function names_list(folder: string): string[] {
  try {
    return readdirSync(folder);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Reads a file of the store: opened without following a link and without
 * waiting (a pipe put in its place is found to be no file, not waited on),
 * and read only when it is a regular file of this account's no larger than
 * the store allows.
 *
 * @param path - The file.
 * @param most - The most bytes it may hold.
 * @returns Its bytes, or null when there is no file.
 * @throws {Error} When something other than this account's own file of at most that size stands at the name.
 *
 * @example
 * ```ts
 * ownFile_read('/var/lib/porter/tokens.json', 4 * 1024 * 1024);
 * ```
 */
export function ownFile_read(path: string, most: number): Buffer | null {
  let handle: number;
  try {
    handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`the door's token store at ${path} is not a file of its own`);
  }
  try {
    const found: Stats = fstatSync(handle);
    if (!found.isFile() || (typeof process.getuid === 'function' && found.uid !== process.getuid())) throw new Error(`the door's token store at ${path} is not a file of its own`);
    if (found.size > most) throw new Error(`the door's token store at ${path} is larger than a token store; it is left as it is`);
    const bytes: Buffer = Buffer.alloc(found.size);
    let read: number = 0;
    while (read < found.size) {
      const got: number = readSync(handle, bytes, read, found.size - read, read);
      if (got === 0) break;
      read += got;
    }
    return bytes.subarray(0, read);
  } finally {
    closeSync(handle);
  }
}

/**
 * The SHA-256 of some bytes, hex.
 *
 * @param bytes - The bytes.
 * @returns The hash.
 *
 * @example
 * ```ts
 * bytes_hash(Buffer.from('x'));
 * ```
 */
function bytes_hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
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
  const found: DoorToken[] = tokens.filter((record: DoorToken): boolean => {
    const kept: Buffer = Buffer.from(record.hash, 'hex');
    return kept.length === presented.length && timingSafeEqual(kept, presented);
  });
  // Two records for one token cannot both be it: an ambiguous token lets nobody in.
  const record: DoorToken | undefined = found.length === 1 ? found[0] : undefined;
  if (record === undefined) return { ok: false, why: 'unknown' };
  if (Date.parse(record.expires) <= now.getTime()) return { ok: false, why: 'expired', record };
  return { ok: true, record };
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
