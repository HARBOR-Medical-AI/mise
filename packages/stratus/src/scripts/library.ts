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
 * @returns Whether it succeeded, and its last line.
 */
export function git_run(args: ReadonlyArray<string>, cwd?: string): GitAnswer {
  const ran: SpawnSyncReturns<string> = spawnSync('git', [...args], { encoding: 'utf-8', ...(cwd !== undefined ? { cwd } : {}), env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const text: string = ((ran.status === 0 ? ran.stdout : ran.stderr) || ran.error?.message || '').trim().split('\n').at(-1) ?? '';
  return { ok: ran.status === 0, text };
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
    return Array.isArray(sources) ? (sources as ScriptSource[]) : [];
  }

  /** One source by name, or null. */
  source_read(name: string): ScriptSource | null {
    return this.sources_list().find((source: ScriptSource): boolean => source.name === name) ?? null;
  }

  private sources_write(sources: ReadonlyArray<ScriptSource>): void {
    fs.mkdirSync(path.dirname(this.sourcesFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.sourcesFile, `${JSON.stringify({ sources }, null, 2)}\n`, { mode: 0o600 });
  }

  /** Where a source's clone is. */
  clone_derive(name: string): string {
    return path.join(this.root, name);
  }

  /** The folder a source shows: its clone, or the folder in it. */
  shown_derive(source: ScriptSource): string {
    const clone: string = this.clone_derive(source.name);
    return source.folder === undefined || source.folder === '' ? clone : path.join(clone, source.folder);
  }

  /** The folder of this host's own scripts, made on first ask. */
  mine_derive(): string {
    const folder: string = path.join(this.root, MINE);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    return folder;
  }

  /** Whether a source is cloned. */
  cloned(name: string): boolean {
    return fs.existsSync(path.join(this.clone_derive(name), '.git'));
  }

  /**
   * Adds a source and clones it.
   *
   * @param source - The source.
   * @returns What git said, or why not.
   */
  source_add(source: ScriptSource): GitAnswer {
    if (!SOURCE_NAME.test(source.name)) return { ok: false, text: `${source.name}: a source's name is lower-case letters, digits and hyphens, starting with a letter, at most 32` };
    if (source.name === MINE) return { ok: false, text: `${MINE} is this host's own folder, not a source` };
    if (this.source_read(source.name) !== null) return { ok: false, text: `${source.name}: already a source (scripts remove ${source.name} first)` };
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const clone: string = this.clone_derive(source.name);
    if (!this.cloned(source.name)) {
      const cloned: GitAnswer = this.git(['clone', '--quiet', source.repo, clone]);
      if (!cloned.ok) return { ok: false, text: `git clone ${source.repo}: ${cloned.text}` };
    }
    if (source.folder !== undefined && source.folder !== '' && !fs.existsSync(path.join(clone, source.folder))) {
      fs.rmSync(clone, { recursive: true, force: true });
      return { ok: false, text: `${source.repo} has no folder ${source.folder}` };
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
    fs.rmSync(this.clone_derive(name), { recursive: true, force: true });
    return { ok: true, text: `${name}: forgotten; its clone removed` };
  }

  /**
   * Pulls a source's clone, fast-forward only; clones it when the clone is gone.
   *
   * @param name - The source.
   * @returns What git said.
   */
  source_pull(name: string): GitAnswer {
    const source: ScriptSource | null = this.source_read(name);
    if (source === null) return { ok: false, text: `${name}: not a source` };
    if (!this.cloned(name)) {
      const cloned: GitAnswer = this.git(['clone', '--quiet', source.repo, this.clone_derive(name)]);
      return cloned.ok ? { ok: true, text: `${name}: cloned again` } : { ok: false, text: `git clone ${source.repo}: ${cloned.text}` };
    }
    const pulled: GitAnswer = this.git(['pull', '--quiet', '--ff-only'], this.clone_derive(name));
    if (!pulled.ok) return { ok: false, text: `${name}: git pull: ${pulled.text}` };
    const head: GitAnswer = this.git(['log', '-1', '--format=%h %cs %s'], this.clone_derive(name));
    return { ok: true, text: `${name}: at ${head.text}` };
  }

  /** A source's head, in a line, or why it has none. */
  head_read(name: string): string {
    if (!this.cloned(name)) return 'not cloned (scripts pull)';
    const head: GitAnswer = this.git(['log', '-1', '--format=%h %cs %s'], this.clone_derive(name));
    return head.ok ? head.text : head.text;
  }
}
