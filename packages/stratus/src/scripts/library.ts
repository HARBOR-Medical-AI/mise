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
 * @param network - Whether git is kept off this host's own transports (`file`, `ext`), within what the operator's own policy allows.
 * @returns Whether it succeeded, and its last line.
 */
export function git_run(args: ReadonlyArray<string>, cwd?: string, network: boolean = false): GitAnswer {
  // With `network`, git itself is held off this host's own transports, whatever a clone's configured upstream
  // or a redirect says: by two keys on its command line where the operator's policy is git's configuration,
  // and by a shortened list where the operator's policy is a list in the environment (which git lets replace
  // its configuration). No part of the operator's policy is widened either way.
  const inherited: string | undefined = process.env['GIT_ALLOW_PROTOCOL'];
  const held: ReadonlyArray<string> = network ? [...LOCAL_TRANSPORTS_OFF, ...args] : args;
  const ran: SpawnSyncReturns<string> = spawnSync('git', [...held], {
    encoding: 'utf-8',
    ...(cwd !== undefined ? { cwd } : {}),
    env: { ...process.env, ...(network && inherited !== undefined ? { GIT_ALLOW_PROTOCOL: networkProtocols_allow(inherited) } : {}), GIT_TERMINAL_PROMPT: '0' },
  });
  const text: string = ((ran.status === 0 ? ran.stdout : ran.stderr) || ran.error?.message || '').trim().split('\n').at(-1) ?? '';
  return { ok: ran.status === 0, text };
}

/**
 * The transports of git's own that leave this host. `file`, and every
 * helper that is a program on this host (`ext`), are not among them.
 */
export const NETWORK_PROTOCOLS: ReadonlyArray<string> = ['https', 'ssh', 'git', 'http', 'ftp', 'ftps'];

/**
 * git's own configuration, given on its command line, that turns the
 * transports of this host off and says nothing of any other.
 *
 * A key given with `-c` overrides that one key and no more. So every
 * other part of the operator's policy stands exactly as git reads it: a
 * transport set to `never` stays never, one set to `user` stays subject to
 * `GIT_PROTOCOL_FROM_USER`, and the defaults stay the defaults. Nothing is
 * read out of the configuration and re-stated, so nothing can be re-stated
 * wrongly.
 */
export const LOCAL_TRANSPORTS_OFF: ReadonlyArray<string> = ['-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never'];

/**
 * The `GIT_ALLOW_PROTOCOL` to give git when the process was started under
 * one: what that policy and the network transports have in common, which
 * may be nothing. A list in the environment replaces git's configuration
 * wholesale, the `-c` keys above included, so here the list itself is
 * what must lose the local transports; it is only ever made shorter.
 *
 * @param inherited - The `GIT_ALLOW_PROTOCOL` the process was started with.
 * @returns The value to give git.
 */
export function networkProtocols_allow(inherited: string): string {
  const own: string[] = inherited.split(':').map((one: string): string => one.trim()).filter((one: string): boolean => one !== '');
  return NETWORK_PROTOCOLS.filter((protocol: string): boolean => own.includes(protocol)).join(':');
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
