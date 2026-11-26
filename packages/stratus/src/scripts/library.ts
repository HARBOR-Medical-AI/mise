/**
 * @file The library of scripts (docs/stratus.adoc, D17): its sources are git
 * repositories named in stratus's configuration, each kept as a clone under
 * stratus's state and pulled when asked, so `play` and the script screen
 * read one path, `/scripts/<source>/…`. `/scripts/mine/` is a folder of this
 * host's own, where a step's edits land as working copies; the way back into
 * a repository is git, outside the session.
 *
 * @module
 */
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { wireName_place, type HostPlace } from '@fnndsc/fond';

/** One source: a repository, and the folder in it the library shows (its root when absent). */
export interface ScriptSource {
  readonly name: string;
  readonly repo: string;
  readonly folder?: string;
}

/** The folder of this host's own scripts. */
export const MINE: string = 'mine';

/** A source's name: a folder's, lower-case letters, digits and hyphens. */
export const SOURCE_NAME: RegExp = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Where the library's clones live.
 *
 * @param env - The environment.
 * @returns `$XDG_STATE_HOME/stratus/scripts`, or under `~/.local/state`.
 */
export function scriptsRoot_derive(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env['XDG_STATE_HOME'] || path.join(os.homedir(), '.local', 'state'), 'stratus', 'scripts');
}

/** What a pull or clone answered. */
export interface GitAnswer {
  readonly ok: boolean;
  readonly text: string;
}

/**
 * Runs git, as stratus runs ssh-keygen: on this host, the answer kept.
 *
 * @param args - git's arguments.
 * @param cwd - Where.
 * @param network - Whether git is held to the transports that leave this host, within what the operator's own policy allows; every transport of this host (`file`, `ext`, any installed remote helper) is then refused by git itself.
 * @returns Whether it succeeded, and its last line.
 */
export function git_run(args: ReadonlyArray<string>, cwd?: string, network: boolean = false): GitAnswer {
  // With `network`, git itself is held to the transports that leave this host, whatever a clone's configured
  // upstream or a redirect says: by keys on its command line where the operator's policy is git's
  // configuration, and by a shortened list where the operator's policy is a list in the environment (which
  // git lets replace its configuration). No part of the operator's policy is widened either way.
  const inherited: string | undefined = process.env['GIT_ALLOW_PROTOCOL'];
  let held: ReadonlyArray<string> = args;
  if (network && inherited === undefined) {
    const keys: ReadonlyArray<string> | { readonly refused: string } = networkOnly_keys(
      (key: string): string | null | ConfigUnread => gitConfig_read(key, cwd),
      (): ReadonlyArray<string> | ConfigUnread => gitProtocols_configured(cwd),
    );
    // A policy that could not be read is not guessed at: git is not run.
    if (!Array.isArray(keys)) return { ok: false, text: (keys as { readonly refused: string }).refused };
    held = [...keys, ...args];
  }
  const ran: SpawnSyncReturns<string> = spawnSync('git', [...held], {
    encoding: 'utf-8',
    ...(cwd !== undefined ? { cwd } : {}),
    env: { ...process.env, ...(network && inherited !== undefined ? { GIT_ALLOW_PROTOCOL: networkProtocols_allow(inherited) } : {}), GIT_TERMINAL_PROMPT: '0' },
  });
  const text: string = ((ran.status === 0 ? ran.stdout : ran.stderr) || ran.error?.message || '').trim().split('\n').at(-1) ?? '';
  return { ok: ran.status === 0, text };
}

/**
 * The transports of git's own that leave this host, each with the policy
 * git gives it when nothing is configured (`git help config`,
 * `protocol.allow`): the four it knows as safe are `always`, any other is
 * `user`. `file`, `ext` and every other remote helper, each of which is a
 * program on this host, are not among them.
 */
export const NETWORK_PROTOCOLS: Readonly<Record<string, 'always' | 'user'>> = { https: 'always', ssh: 'always', git: 'always', http: 'always', ftp: 'user', ftps: 'user' };

/** A configuration key that could not be read: neither set nor shown to be unset. */
export interface ConfigUnread {
  /** Why. */
  readonly unread: string;
}

/**
 * Reads one key of git's configuration as git would where it is about to
 * run, telling a key that is not set from a read that failed.
 *
 * @param key - The key.
 * @param cwd - Where git will run, so a repository's own configuration counts.
 * @returns The value; null when the key is not set (git's exit status 1); or that it could not be read.
 */
export function gitConfig_read(key: string, cwd?: string): string | null | ConfigUnread {
  const ran: SpawnSyncReturns<string> = spawnSync('git', ['config', '--get', key], { encoding: 'utf-8', env: { ...process.env }, ...(cwd !== undefined && fs.existsSync(cwd) ? { cwd } : {}) });
  if (ran.status === 0) return ran.stdout.trim();
  if (ran.status === 1) return null;
  return { unread: `${key}: ${(ran.stderr || ran.error?.message || `git config ended with ${String(ran.status)}`).trim().split('\n').at(-1) ?? ''}` };
}

/**
 * Every transport git's configuration gives a policy of its own, by name:
 * each `protocol.<name>.allow` key, wherever it is set (the system's, the
 * user's, the repository's where git is about to run).
 *
 * @param cwd - Where git will run, so a repository's own configuration counts.
 * @returns The names; none when no such key is set; or that the configuration could not be read.
 */
export function gitProtocols_configured(cwd?: string): ReadonlyArray<string> | ConfigUnread {
  const ran: SpawnSyncReturns<string> = spawnSync('git', ['config', '--name-only', '--get-regexp', '^protocol\\..+\\.allow$'], { encoding: 'utf-8', env: { ...process.env }, ...(cwd !== undefined && fs.existsSync(cwd) ? { cwd } : {}) });
  if (ran.status === 1) return [];
  if (ran.status !== 0) return { unread: `protocol.*.allow: ${(ran.stderr || ran.error?.message || `git config ended with ${String(ran.status)}`).trim().split('\n').at(-1) ?? ''}` };
  const names: string[] = ran.stdout.split('\n').map((key: string): string => key.trim()).filter((key: string): boolean => key !== '')
    .map((key: string): string => key.slice('protocol.'.length, key.length - '.allow'.length).toLowerCase());
  return [...new Set(names)];
}

/**
 * git's own configuration, for its command line, that leaves it only the
 * transports that leave this host and keeps the operator's policy for
 * each of those as it is.
 *
 * `protocol.allow=never` makes `never` the policy of every transport that
 * has no key of its own: `file`, `ext`, and any remote helper installed on
 * this host, by whatever name. A transport that does have a key of its own
 * is decided by that key, which a default cannot reach; so `file` and
 * `ext`, and every other transport the configuration names that is not a
 * network one, is given `never` by name as well, whatever it was set to.
 * That default would also take over from
 * git's built-in policy for the network transports, so each of those is
 * given a key of its own, unless the operator already gave it one: the
 * value the operator set as their general policy (`protocol.allow`) where
 * they set one, and otherwise the policy git has built in. A value of
 * `user` is passed on as `user`, so it stays subject to
 * `GIT_PROTOCOL_FROM_USER`; a transport the operator set to `never` has
 * its own key and is not touched.
 *
 * @param read - How a configuration key is read.
 * @param configured - The transports the configuration gives a key of their own.
 * @returns The `-c` arguments, or a refusal when the operator's policy could not be read or is no policy git knows.
 */
export function networkOnly_keys(
  read: (key: string) => string | null | ConfigUnread,
  configured: () => ReadonlyArray<string> | ConfigUnread = (): ReadonlyArray<string> => [],
): ReadonlyArray<string> | { readonly refused: string } {
  const refuse = (why: string): { readonly refused: string } => ({ refused: `git's transport policy could not be read (${why}); nothing was fetched` });
  const general: string | null | ConfigUnread = read('protocol.allow');
  if (general !== null && typeof general !== 'string') return refuse(general.unread);
  if (general !== null && !POLICIES.includes(general)) return refuse(`protocol.allow is ${JSON.stringify(general)}`);
  const named: ReadonlyArray<string> | ConfigUnread = configured();
  if (!Array.isArray(named)) return refuse((named as ConfigUnread).unread);
  const keys: string[] = ['-c', 'protocol.allow=never'];
  // This host's transports by name: the two git ships, and any the configuration names that is not a network one.
  // A name is used only when it is one a key can be made of; a configuration that names anything else is not read as a policy.
  const local: string[] = ['file', 'ext', ...(named as ReadonlyArray<string>).filter((name: string): boolean => !(name in NETWORK_PROTOCOLS))];
  for (const name of [...new Set(local)]) {
    if (!/^[a-z0-9][a-z0-9+.-]*$/.test(name)) return refuse(`a transport is configured under a name that is not one: ${JSON.stringify(name)}`);
    keys.push('-c', `protocol.${name}.allow=never`);
  }
  for (const [protocol, builtIn] of Object.entries(NETWORK_PROTOCOLS)) {
    const own: string | null | ConfigUnread = read(`protocol.${protocol}.allow`);
    if (own !== null && typeof own !== 'string') return refuse(own.unread);
    if (own !== null && !POLICIES.includes(own)) return refuse(`protocol.${protocol}.allow is ${JSON.stringify(own)}`);
    // The operator's own key for this transport stands as it is; only where there is none is one given.
    if (own === null) keys.push('-c', `protocol.${protocol}.allow=${general ?? builtIn}`);
  }
  return keys;
}

/** The policies git knows for a transport. */
const POLICIES: ReadonlyArray<string> = ['always', 'never', 'user'];

/**
 * The `GIT_ALLOW_PROTOCOL` to give git when the process was started under
 * one: what that policy and the network transports have in common, which
 * may be nothing. A list in the environment replaces git's configuration
 * wholesale, any `-c` key included, so here the list itself is what must
 * lose every transport of this host; it is only ever made shorter.
 *
 * @param inherited - The `GIT_ALLOW_PROTOCOL` the process was started with.
 * @returns The value to give git.
 */
export function networkProtocols_allow(inherited: string): string {
  const own: string[] = inherited.split(':').map((one: string): string => one.trim()).filter((one: string): boolean => one !== '');
  return Object.keys(NETWORK_PROTOCOLS).filter((protocol: string): boolean => own.includes(protocol)).join(':');
}

/** The library: its sources, as configured and as cloned. */
export class ScriptLibrary {
  /** The configuration file naming the sources. */
  readonly sourcesFile: string;
  /** Where the clones are. */
  readonly root: string;
  private readonly git: typeof git_run;

  constructor(configDir: string, root: string = scriptsRoot_derive(), git: typeof git_run = git_run) {
    this.sourcesFile = path.join(configDir, 'scripts.json');
    this.root = root;
    this.git = git;
  }

  /** The sources named in the configuration, in order. */
  sources_list(): ScriptSource[] {
    if (!fs.existsSync(this.sourcesFile)) return [];
    const read: unknown = JSON.parse(fs.readFileSync(this.sourcesFile, 'utf-8'));
    const sources: unknown = (read as { sources?: unknown }).sources;
    // A source is its name, and its clone is a folder of that name under the library's root. A name kept in
    // the file that is not one (it climbs, it is absolute, it is `mine`) names no source: it is not listed,
    // pulled or removed, so no path is ever made from it.
    return Array.isArray(sources) ? (sources as ScriptSource[]).filter((source: ScriptSource): boolean => ScriptLibrary.name_isSource(source?.name)) : [];
  }

  /**
   * Whether a word is a source's name: lower-case letters, digits and
   * hyphens, starting with a letter, and not this host's own folder.
   *
   * @param name - The word.
   * @returns True when a clone may be named for it.
   */
  static name_isSource(name: unknown): name is string {
    return typeof name === 'string' && SOURCE_NAME.test(name) && name !== MINE;
  }

  /** One source by name, or null. */
  source_read(name: string): ScriptSource | null {
    return this.sources_list().find((source: ScriptSource): boolean => source.name === name) ?? null;
  }

  private sources_write(sources: ReadonlyArray<ScriptSource>): void {
    fs.mkdirSync(path.dirname(this.sourcesFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.sourcesFile, `${JSON.stringify({ sources }, null, 2)}\n`, { mode: 0o600 });
  }

  /** Where a source's clone would be, by its name alone. */
  clone_derive(name: string): string {
    return path.join(this.root, name);
  }

  /**
   * A source's clone, held inside the library's root.
   *
   * The clone is a folder of the source's name under the root. If what
   * stands at that name is a link that leads out of the root, the folder
   * is not the library's: nothing is read from it, and git is not run in
   * it. Asked before the mount reads a clone and before git touches one, a
   * clone that already stood there included.
   *
   * @param name - The source's name.
   * @returns The clone's place, or why it has none inside the library.
   */
  clone_place(name: string): HostPlace {
    if (!ScriptLibrary.name_isSource(name)) return { ok: false, reason: `${JSON.stringify(name)} is not a source's name` };
    return wireName_place(this.root, name);
  }

  /**
   * The folder a source shows: its clone, or the folder in it.
   *
   * The folder comes from a configuration file and from what an operator
   * typed. It is a name inside the clone or it is nothing: one that is
   * absolute, climbs with `..`, or passes through a link that leads out of
   * the clone has no place there (`wireName_place`). The answer carries
   * why, so a folder that could not be looked at is told from one that is
   * not there.
   *
   * @param source - The source.
   * @returns The folder's place, or why it has none inside the library.
   */
  shown_place(source: ScriptSource): HostPlace {
    const clone: HostPlace = this.clone_place(source.name);
    if (!clone.ok || source.folder === undefined || source.folder === '') return clone;
    return wireName_place(clone.place, source.folder);
  }

  /** The folder of this host's own scripts, made on first ask. */
  mine_derive(): string {
    const folder: string = path.join(this.root, MINE);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    return folder;
  }

  /**
   * This host's own folder, held inside the library's root like any clone:
   * a link standing at its name that leads out of the root is not it.
   *
   * @returns The folder's place, or why it has none inside the library.
   */
  mine_place(): HostPlace {
    try {
      this.mine_derive();
    } catch (error: unknown) {
      // A folder that could not be made is not a folder that is absent: the file system's own reason is
      // kept, so nothing downstream takes "not there" for proof. Only a name already taken by something
      // that is no folder goes on to the placing, which says what it is.
      const code: string = (error as NodeJS.ErrnoException).code ?? 'EIO';
      if (code !== 'EEXIST') return { ok: false, reason: `${MINE} could not be made in the library (${code})`, unseen: code };
    }
    return wireName_place(this.root, MINE);
  }

  /**
   * Whether a repository is on this host's own disk, not somewhere git
   * reaches over a network: a path (`/srv/repo`, `./repo`, `~/repo`), a
   * `file:` address, or a bare word with no host in it. `https://…`,
   * `ssh://…`, `git://…` and `git@host:owner/repo` are not.
   *
   * Cloning or pulling such a repository reads the host's disk at a place
   * the operator chose, which is what the files tier of host control is for.
   *
   * @param repo - The repository as written.
   * @returns True when it names a place on this host.
   */
  static repo_isLocal(repo: string): boolean {
    if (/^file:/i.test(repo)) return true;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(repo)) return false;
    if (/^[/.~]/.test(repo)) return true;
    // scp-like: user@host:path, or host:path with no slash before the colon.
    return !/^[^/]+:/.test(repo);
  }

  /** Whether a source is cloned. */
  cloned(name: string): boolean {
    const clone: HostPlace = this.clone_place(name);
    return clone.ok && fs.existsSync(path.join(clone.place, '.git'));
  }

  /**
   * Adds a source and clones it.
   *
   * @param source - The source.
   * @param network - Whether git is held to transports that leave this host.
   * @returns What git said, or why not.
   */
  source_add(source: ScriptSource, network: boolean = false): GitAnswer {
    if (!SOURCE_NAME.test(source.name)) return { ok: false, text: `${source.name}: a source's name is lower-case letters, digits and hyphens, starting with a letter, at most 32` };
    if (source.name === MINE) return { ok: false, text: `${MINE} is this host's own folder, not a source` };
    if (this.source_read(source.name) !== null) return { ok: false, text: `${source.name}: already a source (scripts remove ${source.name} first)` };
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    // First of all: whatever already stands at the clone's name is the library's own folder, or nothing under
    // it is looked at and git is not run there.
    const placed: HostPlace = this.clone_place(source.name);
    if (!placed.ok) return { ok: false, text: `${source.name}: its clone would not be inside the library: ${placed.reason}` };
    const clone: string = placed.place;
    // Then, before anything is cloned: a folder that is no name inside a repository is refused as written,
    // read against the clone's checked place.
    if (source.folder !== undefined && source.folder !== '') {
      const named: HostPlace = wireName_place(clone, source.folder);
      if (!named.ok) return { ok: false, text: `--folder ${source.folder}: a folder inside the repository, and ${named.reason}` };
    }
    // A clone that stood here before this add is not this add's to remove when the add fails.
    const fresh: boolean = !this.cloned(source.name);
    if (fresh) {
      const cloned: GitAnswer = this.git(['clone', '--quiet', source.repo, clone], undefined, network);
      if (!cloned.ok) return { ok: false, text: `git clone ${source.repo}: ${cloned.text}` };
    }
    if (source.folder !== undefined && source.folder !== '') {
      // Again now that the clone is there: the folder may be, or pass through, a link the repository carries.
      const shown: HostPlace = this.shown_place(source);
      if (!shown.ok || !fs.existsSync(shown.place)) {
        if (fresh) fs.rmSync(clone, { recursive: true, force: true });
        return { ok: false, text: !shown.ok ? `--folder ${source.folder}: it leads out of the repository's clone (${shown.reason})` : `${source.repo} has no folder ${source.folder}` };
      }
    }
    this.sources_write([...this.sources_list(), source]);
    return { ok: true, text: `${source.name}: ${source.repo}${source.folder !== undefined && source.folder !== '' ? ` (${source.folder})` : ''} cloned to ${clone}` };
  }

  /**
   * Forgets a source and removes its clone.
   *
   * @param name - The source.
   * @returns What was done, or why not.
   */
  source_remove(name: string): GitAnswer {
    if (this.source_read(name) === null) return { ok: false, text: `${name}: not a source` };
    this.sources_write(this.sources_list().filter((source: ScriptSource): boolean => source.name !== name));
    // Only a clone that is the library's own folder is removed; what a link at its name points at is not.
    const clone: HostPlace = this.clone_place(name);
    if (!clone.ok) return { ok: true, text: `${name}: forgotten; what stands at its clone's name is not inside the library and was left (${clone.reason})` };
    fs.rmSync(clone.place, { recursive: true, force: true });
    return { ok: true, text: `${name}: forgotten; its clone removed` };
  }

  /**
   * Pulls a source's clone, fast-forward only; clones it when the clone is gone.
   *
   * @param name - The source.
   * @param network - Whether git is held to transports that leave this host.
   * @returns What git said.
   */
  source_pull(name: string, network: boolean = false): GitAnswer {
    const source: ScriptSource | null = this.source_read(name);
    if (source === null) return { ok: false, text: `${name}: not a source` };
    const clone: HostPlace = this.clone_place(name);
    if (!clone.ok) return { ok: false, text: `${name}: its clone is not inside the library: ${clone.reason}` };
    if (!this.cloned(name)) {
      const cloned: GitAnswer = this.git(['clone', '--quiet', source.repo, clone.place], undefined, network);
      return cloned.ok ? { ok: true, text: `${name}: cloned again` } : { ok: false, text: `git clone ${source.repo}: ${cloned.text}` };
    }
    // A pull goes where the clone's own configuration says, which need not be what the library's file says:
    // git itself is told which transports it may use.
    const pulled: GitAnswer = this.git(['pull', '--quiet', '--ff-only'], clone.place, network);
    if (!pulled.ok) return { ok: false, text: `${name}: git pull: ${pulled.text}` };
    const head: GitAnswer = this.git(['log', '-1', '--format=%h %cs %s'], clone.place);
    return { ok: true, text: `${name}: at ${head.text}` };
  }

  /** A source's head, in a line, or why it has none. */
  head_read(name: string): string {
    const clone: HostPlace = this.clone_place(name);
    if (!clone.ok || !this.cloned(name)) return 'not cloned (scripts pull)';
    const head: GitAnswer = this.git(['log', '-1', '--format=%h %cs %s'], clone.place);
    return head.ok ? head.text : head.text;
  }
}
