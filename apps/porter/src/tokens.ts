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
 * never in it. Its I/O is asynchronous, off the door's event loop. A
 * token's last use is sampled at most once an hour.
 *
 * @module
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, rm, stat, writeFile, type FileHandle, type FileReadResult } from 'node:fs/promises';
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

/**
 * A token just minted: its plaintext, shown once, and the record kept.
 *
 * @example
 * ```ts
 * const { token, record }: MintedToken = await store.mint(identity, user, 'laptop');
 * ```
 */
export interface MintedToken {
  /** The plaintext, shown once and never kept. */
  token: string;
  /** The record the store keeps. */
  record: DoorToken;
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

/** How long a temporary file a writer left behind is kept before it is swept, in ms. */
const TEMP_LIFE_MS: number = 3_600_000;

/** The names the store gives its temporary files, and the only names its sweep removes. */
const TEMP_NAME: RegExp = /^(?:[1-9][0-9]{0,11}|empty)\.[0-9]{1,10}\.[0-9a-f]{12}$/;

/** How seldom a token's last use is written down: at most once an hour. */
export const LAST_USED_SAMPLE_MS: number = 3_600_000;

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

/** Records as read, with those of the wrong shape left out. */
interface RecordsRead {
  /** The records kept. */
  tokens: DoorToken[];
  /** Those left out: their positions and, where safe, their names. */
  skipped: string[];
  /** What the text said it was migrated from. */
  migratedFrom?: string;
}

/**
 * A folder the store will not use because it is shown not to be one of
 * its own (a link, a file, another account's): proof that what is at that
 * name holds none of the store. Any other failure to open a folder is not
 * this, and is never read as "no versions here".
 *
 * @example
 * ```ts
 * try { await folder_hold(path); } catch (error) { if (error instanceof FolderIneligible) skip(); else throw error; }
 * ```
 */
export class FolderIneligible extends Error {}

/** A folder of the store, held open: reached through its handle, whatever stands at its name since. */
interface HeldFolder {
  /** The open folder. */
  handle: FileHandle;
  /** The path that leads to the open folder itself (`/proc/self/fd/<fd>`). */
  at: string;
}

/**
 * Where in a transaction a test may step in, to stand for another writer.
 *
 * @example
 * ```ts
 * new TokenStore(path, 30, undefined, { read_after: async () => { await other.mint(identity, user, 'n'); } });
 * ```
 */
export interface StoreHooks {
  /** After the current version is read, before the next is published. */
  read_after?: () => void | Promise<void>;
  /** After the next version is published. */
  publish_after?: () => void | Promise<void>;
  /** After a reader found no version, before it reads the legacy file. */
  legacy_before?: () => void | Promise<void>;
  /** While a read holds the store, for a test that holds it there. */
  read_during?: () => void | Promise<void>;
}

/**
 * Whether a field is a time as the store writes it: exactly what
 * `toISOString()` makes of the time it names (so no February 30th, and the
 * extended years it writes are read back).
 *
 * @param value - The field.
 * @returns True for such a time.
 *
 * @example
 * ```ts
 * time_isIso('2026-11-27T00:00:00.000Z'); // true
 * ```
 */
function time_isIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const at: number = Date.parse(value);
  return !Number.isNaN(at) && new Date(at).toISOString() === value;
}

/** What a token's name may be: a short line with no control characters. */
const TOKEN_TEXT: RegExp = /^[^\u0000-\u001f\u007f]{1,200}$/u;

/** What an identity (`user@<CUBE url>`) and a username may be: one line with no control characters, as long as a URL gets. */
const IDENTITY_TEXT: RegExp = /^[^\u0000-\u001f\u007f]{1,4096}$/u;

/**
 * Reads one record of the store as a token, or says it is not one. The one
 * rule for both sides: a record is published only if it reads back.
 *
 * @param value - The record as parsed, or as about to be published.
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
  if (typeof name !== 'string' || !TOKEN_TEXT.test(name) || typeof identity !== 'string' || !IDENTITY_TEXT.test(identity)) return null;
  if (typeof user !== 'string' || !IDENTITY_TEXT.test(user) || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null;
  if (!time_isIso(created) || !time_isIso(expires) || (lastUsed !== null && !time_isIso(lastUsed))) return null;
  return { name, identity, user, hash, created, expires, lastUsed };
}

/**
 * The door's token store: minted, checked, revoked, listed, persisted.
 *
 * The store is a folder of versions beside the file it is named by
 * (`<file>.d/`, versions filed in folders of a thousand): each change
 * writes the next version whole and publishes it with an exclusive link,
 * so a version exists whole or not at all, and two writers (the door and
 * the operator's CLI) can never both publish the same version. The link is
 * the commit: a writer that loses (the name is taken) reads the newer
 * version and applies its change again. A version's name is never freed:
 * old versions are emptied, not removed. Every folder is opened without
 * following a link and shown to be this account's own before anything in
 * it is read or made, and is reached through that open handle afterwards.
 * Every question reads the current version afresh, asynchronously, off the
 * door's event loop.
 *
 * @example
 * ```ts
 * const store = new TokenStore('/var/lib/porter/tokens.json', 30);
 * await store.load();
 * const { token } = await store.mint('me@https://cube/api/v1/', 'me', 'laptop');
 * ```
 */
export class TokenStore {
  /** The records the store held of the wrong shape when it was opened, left out: by position and, where safe, by name. */
  public skipped: string[] = [];
  /** Said once at start about the one-file store from before, when there is something to say. */
  public legacyNote: string | null = null;
  private readonly versions: string;

  /**
   * @param path - The store's file: the versions live in `<path>.d/` (0700); a one-file store at the path is migrated, and left as it is.
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
  }

  /**
   * Opens the store: migrates a one-file store into the first version when
   * there is none, and reads the current one, so a store that does not
   * parse is refused loudly at start. Safe to repeat, and safe at once from
   * two processes. The one-file store is never moved or changed: once a
   * version holds it, it is only a copy from before.
   *
   * @throws {Error} When the current version, or a one-file store still to be migrated, cannot be read or is not a token file.
   */
  public async load(): Promise<void> {
    await this.held_run(async (root: HeldFolder): Promise<void> => {
      await this.temps_sweep(root);
      const current: StoreVersion = await this.current_read(root);
      // A store that has versions is marked so beside its file: should its versions ever vanish, it refuses rather than start again from the copy from before.
      if (current.n > 0) await this.versioned_mark();
      // What was left out of the store as found, said once at start: a migrated version holds only what was kept.
      this.skipped = current.skipped;
      if (current.legacy) {
        // The one-file store is the truth until a whole version holds its records; another opener may publish it first.
        await this.hooks.read_after?.();
        const temp: string | false = await this.version_publish(root, 1, current.tokens, current.migratedFrom);
        if (temp !== false) await this.maintenance_run(root, 1, temp);
        await this.versioned_mark();
      }
      const now: StoreVersion = current.legacy ? await this.current_read(root) : current;
      if (now.n > 0) await this.legacy_compare(now.migratedFrom);
    });
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
   * @throws {Error} When the record would not read back (an empty name, a control character), before anything is published.
   */
  public async mint(identity: string, user: string, name: string): Promise<MintedToken> {
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
    // The rule a reader holds a record to, held before it is published: a mint never succeeds for a token the next read drops.
    if (tokenRecord_read(record) === null) throw new Error(`a door token needs a name of one short line, and a user and an identity of one line each; "${name.slice(0, 40)}" is not one`);
    await this.change_apply((tokens: DoorToken[]) => ({
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
  public async check(plain: string): Promise<TokenCheck> {
    return token_find((await this.current_get()).tokens, plain, this.now());
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
   * await store.login_authorize(bearer, (user) => identity_normalise(user, cubeUrl));
   * ```
   */
  public async login_authorize(plain: string, identityAt: (user: string) => string): Promise<TokenCheck> {
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
  public async revoke(user: string, name?: string): Promise<number> {
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
   * (await store.revoke_presented(bearer))?.name; // 'laptop'
   * ```
   */
  public async revoke_presented(plain: string): Promise<DoorToken | null> {
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
   * (await store.list()).map((token) => token.name);
   * ```
   */
  public async list(): Promise<DoorToken[]> {
    return (await this.current_get()).tokens;
  }

  /**
   * The current version, read under the store's root held open.
   *
   * @returns The current version.
   */
  private async current_get(): Promise<StoreVersion> {
    return this.held_run(async (root: HeldFolder): Promise<StoreVersion> => {
      const current: StoreVersion = await this.current_read(root);
      await this.hooks.read_during?.();
      return current;
    });
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
  private async change_apply<T>(change: StoreChange<T>): Promise<T> {
    return this.held_run(async (root: HeldFolder): Promise<T> => {
      for (let attempt: number = 0; attempt < PUBLISH_TRIES; attempt++) {
        const current: StoreVersion = await this.current_read(root);
        const out: ChangeOutcome<T> = change(current.tokens.map((held: DoorToken): DoorToken => ({ ...held })));
        if (out.next === undefined) return out.result;
        await this.hooks.read_after?.();
        const temp: string | false = await this.version_publish(root, current.n + 1, out.next, current.migratedFrom);
        if (temp !== false) {
          // Committed: whatever the upkeep after it does, the caller is given what the change did.
          await this.hooks.publish_after?.();
          await this.maintenance_run(root, current.n + 1, temp);
          await this.versioned_mark().catch((): void => undefined);
          return out.result;
        }
      }
      throw new Error(`the door's token store at ${this.path} kept changing under this change; try again`);
    });
  }

  /**
   * Marks the store as versioned, beside its file: made once, never removed.
   *
   * @throws {Error} When the mark cannot be made, other than by its being there already.
   */
  private async versioned_mark(): Promise<void> {
    try {
      await writeFile(`${this.path}.versioned`, `${this.versions}\n`, { mode: 0o600, flag: 'wx' });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  /**
   * Runs a step with the store's root folder held open and shown to be this
   * account's own, made first when there is none.
   *
   * @param step - What to do in it.
   * @returns What the step answers.
   * @throws {Error} When the root is not this account's own folder, or the host gives no path to an open folder.
   */
  private async held_run<T>(step: (root: HeldFolder) => Promise<T>): Promise<T> {
    await mkdir(this.versions, { recursive: true, mode: 0o700 });
    const root: HeldFolder = await folder_hold(this.versions);
    try {
      return await step(root);
    } finally {
      await handle_close(root.handle);
    }
  }

  /**
   * Publishes a version: written whole to a fresh file in the store's own
   * temporary folder, then linked to its name in its folder of versions,
   * which fails if the name is taken. Both folders are reached through
   * their open handles.
   *
   * @param root - The store's root, held.
   * @param n - The version's number.
   * @param tokens - Its records.
   * @param migratedFrom - The one-file store the store was migrated from, carried on.
   * @returns The temporary file it was published from, for the upkeep to remove; false when another writer holds that version.
   * @throws {Error} When the version would be larger than a store, a record would not read back, or it cannot be written or linked other than by a taken name.
   */
  private async version_publish(root: HeldFolder, n: number, tokens: DoorToken[], migratedFrom: string | undefined): Promise<string | false> {
    if (n > VERSION_LAST) throw new Error(`the door's token store at ${this.path} has run out of version numbers`);
    if (tokens.some((record: DoorToken): boolean => tokenRecord_read(record) === null)) throw new Error(`the door's token store at ${this.path} would hold a record no reader accepts; the change is refused`);
    const body: TokenFile = { schemaVersion: 1, tokens, ...(migratedFrom === undefined ? {} : { migratedFrom }) };
    const text: string = `${JSON.stringify(body, null, 2)}\n`;
    // The rule the reader holds a version to, held before it is published: nothing is published that would be refused.
    if (Buffer.byteLength(text, 'utf8') > VERSION_MAX_BYTES) throw new Error(`the door's token store at ${this.path} would grow past ${String(VERSION_MAX_BYTES)} bytes; the change is refused`);
    const temps: HeldFolder = await folder_hold(join(root.at, 'tmp'), true);
    let folder: HeldFolder;
    try {
      folder = await folder_hold(join(root.at, folder_name(n)), true);
    } catch (error: unknown) {
      await handle_close(temps.handle);
      throw error;
    }
    try {
      const name: string = `${String(n)}.${String(process.pid)}.${randomBytes(6).toString('hex')}`;
      const temp: string = join(temps.at, name);
      const file: FileHandle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(text, 'utf8');
      } finally {
        await file.close();
      }
      try {
        await link(temp, join(folder.at, `${String(n)}.json`));
        return name;
      } catch (error: unknown) {
        await rm(temp, { force: true });
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
    } finally {
      // A close that fails after the link has published leaves the publication as it is.
      await handle_close(temps.handle);
      await handle_close(folder.handle);
    }
  }

  /**
   * The upkeep after a publication: its temporary file removed, and the
   * version that just fell out of the kept window emptied. Each step is its
   * own: a failure is no failure of the change already committed, and
   * leaves only something to do again.
   *
   * @param root - The store's root, held.
   * @param published - The version just published.
   * @param temp - Its temporary file's name.
   */
  private async maintenance_run(root: HeldFolder, published: number, temp: string): Promise<void> {
    const steps: Array<() => Promise<void>> = [
      async (): Promise<void> => {
        const temps: HeldFolder = await folder_hold(join(root.at, 'tmp'));
        try {
          await rm(join(temps.at, temp), { force: true });
        } finally {
          await handle_close(temps.handle);
        }
      },
      async (): Promise<void> => { await this.version_empty(root, published - VERSIONS_KEPT); },
    ];
    for (const step_run of steps) {
      try {
        await step_run();
      } catch {
        // Upkeep only: the version is published whatever this step did.
      }
    }
  }

  /**
   * The highest version's number, emptied or not, by listing the folders
   * of versions and the highest of them that is a folder of this account's
   * own: at most a thousand names, however long the store has lived. Only
   * names a writer makes count: a number past the last, one filed in the
   * wrong folder, a folder that is a link or a file, is no version.
   *
   * @param root - The store's root, held.
   * @returns The number, and its folder's handle-reached path; 0 when there is none.
   * @throws {Error} When a folder cannot be read.
   */
  private async highest_find(root: HeldFolder): Promise<number> {
    const folders: number[] = (await readdir(root.at))
      .map((name: string): number => (/^s(0|[1-9][0-9]{0,8})$/.test(name) ? Number(name.slice(1)) : -1))
      .filter((k: number): boolean => k >= 0 && k * VERSIONS_PER_FOLDER <= VERSION_LAST)
      .sort((a: number, b: number): number => b - a);
    for (const k of folders) {
      let folder: HeldFolder;
      try {
        folder = await folder_hold(join(root.at, `s${String(k)}`));
      } catch (error: unknown) {
        // Shown not to be a folder of the store's own (a link, a file, another's): no versions are in it.
        // Any other failure is uncertainty about the newest versions, and a reader never falls back to older ones on it.
        if (error instanceof FolderIneligible) continue;
        throw error;
      }
      try {
        const found: number[] = (await readdir(folder.at))
          .map((name: string): number => (/^[1-9][0-9]{0,11}\.json$/.test(name) ? Number(name.slice(0, -5)) : 0))
          .filter((n: number): boolean => n > 0 && n <= VERSION_LAST && Math.floor(n / VERSIONS_PER_FOLDER) === k);
        if (found.length > 0) return Math.max(...found);
      } finally {
        await handle_close(folder.handle);
      }
    }
    return 0;
  }

  /**
   * The current version: the highest that holds records. One emptied
   * between the listing and the read sends the reader back to the listing.
   * With no version yet, the legacy file, or nothing.
   *
   * @param root - The store's root, held.
   * @returns The current version.
   * @throws {Error} When it is not a token file, or no version holds records.
   */
  private async current_read(root: HeldFolder): Promise<StoreVersion> {
    for (let attempt: number = 0; attempt < PUBLISH_TRIES; attempt++) {
      const highest: number = await this.highest_find(root);
      if (highest === 0) {
        const unversioned: StoreVersion | null = await this.unversioned_read(root);
        // The legacy file migrated by another opener between the look and the read: its version now holds the truth.
        if (unversioned === null) continue;
        return unversioned;
      }
      const text: string | null = await this.versionText_read(root, highest);
      if (text !== null) return { n: highest, ...this.tokens_parse(text, `version ${String(highest)}`), legacy: false };
    }
    throw new Error(`the door's token store at ${this.path} has no version that holds its records`);
  }

  /**
   * The store while it has no version: the legacy file, or nothing.
   *
   * @param root - The store's root, held.
   * @returns The legacy file's records, an empty store, or null when a version has appeared meanwhile (another opener migrated).
   * @throws {Error} When the legacy file cannot be read, is larger than a store, or is not a token file.
   */
  private async unversioned_read(root: HeldFolder): Promise<StoreVersion | null> {
    // A store marked as versioned that finds no version lost them: the copy from before is never the truth again.
    if ((await lstat(`${this.path}.versioned`).catch((): null => null)) !== null) {
      throw new Error(`the door's token store at ${this.path} has lost its versions (${this.versions}); it refuses rather than go back to the file from before`);
    }
    await this.hooks.legacy_before?.();
    const bytes: Buffer | null = await ownFile_read(this.path, VERSION_MAX_BYTES);
    if (bytes !== null) return { n: 0, ...this.tokens_parse(bytes.toString('utf8'), 'the file'), migratedFrom: bytes_hash(bytes), legacy: true };
    return (await this.highest_find(root)) > 0 ? null : { n: 0, tokens: [], skipped: [], legacy: false };
  }

  /**
   * Compares the one-file store from before with the one the store was
   * migrated from, and says once at start if it has changed since (an
   * older porter wrote it): it is left as it is either way, and the
   * versions are the store. A one-file store that cannot be read is said,
   * never a reason the versioned store does not open.
   *
   * @param from - The SHA-256 the store was migrated from.
   */
  private async legacy_compare(from: string | undefined): Promise<void> {
    let bytes: Buffer | null;
    try {
      bytes = await ownFile_read(this.path, VERSION_MAX_BYTES);
    } catch (error: unknown) {
      this.legacyNote = `the one-file token store at ${this.path} could not be compared (${error instanceof Error ? error.message : String(error)}); the versions in ${this.versions} are the store`;
      return;
    }
    if (bytes !== null && from !== undefined && bytes_hash(bytes) !== from) {
      this.legacyNote = `the one-file token store at ${this.path} changed after it was migrated (an older porter wrote it); it is left as it is, and the versions in ${this.versions} are the store`;
    }
  }

  /**
   * A version's text, read through its folder held open.
   *
   * @param root - The store's root, held.
   * @param n - The version.
   * @returns Its text, or null when it was emptied.
   * @throws {Error} When it cannot be read, is gone, or is larger than a store.
   */
  private async versionText_read(root: HeldFolder, n: number): Promise<string | null> {
    const folder: HeldFolder = await folder_hold(join(root.at, folder_name(n)));
    try {
      const bytes: Buffer | null = await ownFile_read(join(folder.at, `${String(n)}.json`), VERSION_MAX_BYTES);
      if (bytes === null) throw new Error(`the door's token store at ${this.path} lost version ${String(n)}`);
      return bytes.length === 0 ? null : bytes.toString('utf8');
    } finally {
      await handle_close(folder.handle);
    }
  }

  /**
   * Parses a store's text: a file that is not a token file is refused
   * loudly, since silently starting empty would let every script's key
   * stop working with no word why; a record of the wrong shape is left out,
   * and counted.
   *
   * @param text - The store's text.
   * @param which - Which file it is, for the words.
   * @returns The records kept, and those left out.
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
   * @param root - The store's root, held.
   * @param n - The version to empty.
   * @throws {Error} When it cannot be emptied.
   */
  private async version_empty(root: HeldFolder, n: number): Promise<void> {
    if (n < 1) return;
    const folder: HeldFolder = await folder_hold(join(root.at, folder_name(n)));
    let temps: HeldFolder;
    try {
      temps = await folder_hold(join(root.at, 'tmp'), true);
    } catch (error: unknown) {
      await handle_close(folder.handle);
      throw error;
    }
    try {
      const path: string = join(folder.at, `${String(n)}.json`);
      const found: Stats | null = await lstat(path).catch((): null => null);
      if (found === null || !found.isFile() || found.size === 0) return;
      const empty: string = join(temps.at, `empty.${String(process.pid)}.${randomBytes(6).toString('hex')}`);
      await writeFile(empty, '', { mode: 0o600, flag: 'wx' });
      await rename(empty, path);
    } finally {
      await handle_close(folder.handle);
      await handle_close(temps.handle);
    }
  }

  /**
   * Sweeps temporary files a writer that died left behind: only names the
   * store gives them, older than an hour, in the store's own folder.
   *
   * @param root - The store's root, held.
   */
  private async temps_sweep(root: HeldFolder): Promise<void> {
    const temps: HeldFolder = await folder_hold(join(root.at, 'tmp'), true);
    try {
      const cutoff: number = Date.now() - TEMP_LIFE_MS;
      for (const name of await readdir(temps.at)) {
        if (!TEMP_NAME.test(name)) continue;
        const path: string = join(temps.at, name);
        const found: Stats | null = await lstat(path).catch((): null => null);
        if (found !== null && found.isFile() && found.mtimeMs < cutoff) await rm(path, { force: true });
      }
    } finally {
      await handle_close(temps.handle);
    }
  }
}

/**
 * Closes a handle; a close that fails is not a failure of what was done through it.
 *
 * @param handle - The handle.
 *
 * @example
 * ```ts
 * await handle_close(folder.handle);
 * ```
 */
async function handle_close(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Closed already, or the descriptor went with an error: nothing done through it is undone.
  }
}

/**
 * The folder of versions a version is filed in.
 *
 * @param n - The version's number.
 * @returns The folder's name.
 *
 * @example
 * ```ts
 * folder_name(1234); // 's1'
 * ```
 */
function folder_name(n: number): string {
  return `s${String(Math.floor(n / VERSIONS_PER_FOLDER))}`;
}

/**
 * Opens a folder of the store without following a link at its name, shows
 * through the handle that it is a folder of this account's, left 0700, and
 * gives the path that leads to the open folder itself.
 *
 * @param path - The folder.
 * @param made - Whether to make it first when it is not there.
 * @returns The folder, held.
 * @throws {FolderIneligible} When it is a link, not a folder, or another account's.
 * @throws {Error} When it cannot be opened for another reason, or the host gives no path to an open folder.
 *
 * @example
 * ```ts
 * const root = await folder_hold('/var/lib/porter/tokens.json.d');
 * ```
 */
export async function folder_hold(path: string, made: boolean = false): Promise<HeldFolder> {
  if (made) await mkdir(path, { mode: 0o700 }).catch((error: unknown): void => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    const code: string | undefined = (error as NodeJS.ErrnoException).code;
    // A link at the name, or a file: shown to be no folder of the store's. Anything else (no access, an I/O error, no descriptors) is a failure, said as one.
    if (code === 'ELOOP' || code === 'ENOTDIR') throw new FolderIneligible(`the door's token store folder ${path} is not a folder of its own (${code})`);
    throw error;
  }
  try {
    const found: Stats = await handle.stat();
    if (!found.isDirectory() || (typeof process.getuid === 'function' && found.uid !== process.getuid())) throw new FolderIneligible(`the door's token store folder ${path} is not a folder of its own`);
    if ((found.mode & 0o7777) !== 0o700) await handle.chmod(0o700);
    const at: string = `/proc/self/fd/${String(handle.fd)}`;
    const seen: Stats = await stat(at);
    if (seen.dev !== found.dev || seen.ino !== found.ino) throw new Error('this host gives no path to an open folder (/proc/self/fd); the door\'s token store needs one');
    return { handle, at };
  } catch (error: unknown) {
    await handle.close();
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
 * await ownFile_read('/var/lib/porter/tokens.json', 4 * 1024 * 1024);
 * ```
 */
export async function ownFile_read(path: string, most: number): Promise<Buffer | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`the door's token store at ${path} is not a file of its own`);
  }
  try {
    const found: Stats = await handle.stat();
    if (!found.isFile() || (typeof process.getuid === 'function' && found.uid !== process.getuid())) throw new Error(`the door's token store at ${path} is not a file of its own`);
    if (found.size > most) throw new Error(`the door's token store at ${path} is larger than a token store; it is left as it is`);
    const bytes: Buffer = Buffer.alloc(found.size);
    let read: number = 0;
    while (read < found.size) {
      const got: FileReadResult<Buffer> = await handle.read(bytes, read, found.size - read, read);
      if (got.bytesRead === 0) break;
      read += got.bytesRead;
    }
    return bytes.subarray(0, read);
  } finally {
    await handle.close();
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

/** One code waiting, being authorised, authorised, or spent. */
interface DeviceCode {
  /** The host chell runs on, for the page ("authorise chell on titan") and the token's name. */
  host: string;
  /** When it was issued, ms. */
  issued: number;
  /** What chell gets, once a human authorised it. */
  grant: DeviceGrant | null;
  /** Whether a login holds it while it mints a token for it: no second login may take it meanwhile. */
  claimed: boolean;
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
    this.codes.set(code, { host, issued, grant: null, claimed: false });
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
    return held === undefined || held.grant !== null || held.claimed ? null : held.host;
  }

  /**
   * Claims a waiting code for one login, before it mints: a second login
   * with the same code is refused while this one holds it.
   *
   * @param code - As typed.
   * @returns The host chell runs on, or null when the code is not waiting, or is already claimed.
   *
   * @example
   * ```ts
   * const host = codes.code_claim('K7PD-3MXQ'); // 'titan'
   * ```
   */
  public code_claim(code: string): string | null {
    this.sweep();
    const held: DeviceCode | undefined = this.codes.get(deviceCode_normalise(code));
    if (held === undefined || held.grant !== null || held.claimed) return null;
    held.claimed = true;
    return held.host;
  }

  /**
   * Lets go of a claim whose mint failed, so the code can be tried again.
   *
   * @param code - As typed.
   *
   * @example
   * ```ts
   * codes.claim_release('K7PD-3MXQ');
   * ```
   */
  public claim_release(code: string): void {
    const held: DeviceCode | undefined = this.codes.get(deviceCode_normalise(code));
    if (held !== undefined && held.grant === null) held.claimed = false;
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
    // Only the login that claimed it, and only while it is still alive.
    if (held === undefined || held.grant !== null || !held.claimed) return false;
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
