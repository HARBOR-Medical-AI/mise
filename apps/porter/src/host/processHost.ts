/**
 * @file Sessions as child processes on this host, one per identity, each in
 * four directories of its own.
 *
 * A session is `chell --daemon <user>@<url> --auth-token-stdin`: the token
 * on stdin, one line, never argv; the config, runtime, cache and tmp
 * directories under the porter's state, keyed by the identity's berth key,
 * because a daemon that shares any of them with another identity's has cost
 * real sessions their working directory. The child's berth lands in its own
 * runtime directory, and that is where the host reads it back.
 *
 * The boot's stdout and stderr are kept, line by line, for as long as the
 * child lives: a greeter that attaches late replays them, one that is there
 * follows them, and the terminal boot and the browser boot are the same
 * text.
 *
 * @module
 */
import { spawn as childSpawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { berthKey_compute, berth_pathIn, berthUrl_isAlive, closing_write } from '@fnndsc/calypso/berth';
import { restartLine_render, type Berth, type BootLine, type BootListener, type BootReport, type RestartWhy, type SessionHost, type SessionSighting } from './sessionHost.js';

/** How many boot lines a session keeps for late followers. */
export const BOOT_LINES_KEPT: number = 2_000;

/** How long a restart waits for the old daemon to go before it gives up. */
export const STOP_WAIT_MS: number = 15_000;

/** The four directories a session owns. */
export interface SessionDirs {
  config: string;
  runtime: string;
  cache: string;
  tmp: string;
}

/** What the host needs of a child it started. */
export interface SpawnedSession {
  pid: number | undefined;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  exitCode: number | null;
  /** The signal that ended it, when one did (`exitCode` stays null then). */
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
}

/** A process spawner with the shape of `child_process.spawn`. */
export type SessionSpawn = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] }) => SpawnedSession;

/** Whether a berth's daemon answers on the wire. */
export type LivenessProbe = (url: string) => Promise<boolean>;

/** What the process host is built from. */
export interface ProcessHostOptions {
  /** Where each identity's subtree goes. */
  stateDir: string;
  /** The chell entry to run. */
  chellEntry: string;
  /** The stratus entry, when this porter can start a stratus session (`:stratus oci`). */
  stratusEntry?: string | null;
  /** The spawner; `child_process.spawn` by default. */
  spawn?: SessionSpawn;
  /** The liveness probe; a TCP connect to the berth by default. */
  alive?: LivenessProbe;
  /** How long a boot may take before it is called failed, in ms. */
  bootTimeoutMs?: number;
  /** How often to look for the berth while booting, in ms. */
  pollMs?: number;
  /** How to signal a process this host did not start; `process.kill` by default. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

/** One session this host knows about. */
/**
 * What a session is started as: a chell daemon for a ChRIS login, or a
 * stratus daemon for the same person's cloud.
 */
export type SessionLaunch =
  | { kind: 'chris'; user: string; cubeUrl: string; token: string | null }
  | { kind: 'stratus'; configPath: string; spend: boolean };

interface SessionRecord {
  identity: string;
  child: SpawnedSession | null;
  /** The daemon's pid when adopted from its berth rather than started here. */
  adoptedPid: number | null;
  lines: BootLine[];
  /** The next row number. */
  serial: number;
  /** Rows still open (`[PENDING]`, `[RETRY]`), by label, to the row they hold. */
  open: Map<string, number>;
  state: 'booting' | 'ready' | 'failed';
  reason?: string;
  listeners: Set<BootListener>;
  starting: Promise<Berth> | null;
}

/** A boot row as chell prints it: a status tag, then the step's label. */
export interface BootRow {
  /** The step the row is about (`Feeds`, `Queries`, …). */
  label: string;
  /** Whether the row is still open — `[PENDING]` or `[RETRY]` — or settled. */
  open: boolean;
}

/** The tags chell's boot logger prints (bootsequence.ts), colour stripped. */
const BOOT_ROW: RegExp = /^\[\s*(OK|RETRY|SKIP|FAIL|PENDING)\s*\]\s+(\S+)/;

/**
 * Reads a boot line as a status row, or not one.
 *
 * @param text - The line, ANSI and all.
 * @returns The row's label and whether it is still open, or null for a line
 *   that is not a status row (the brain, a box rule, a plain note).
 */
export function bootRow_parse(text: string): BootRow | null {
  const plain: string = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const match: RegExpExecArray | null = BOOT_ROW.exec(plain);
  if (match === null) return null;
  const tag: string = match[1] as string;
  return { label: match[2] as string, open: tag === 'PENDING' || tag === 'RETRY' };
}

/**
 * A boot line with the attach token taken out. A daemon prints its token
 * (`token:`, an ARGUS `?token=` address, an attach line's `--token`) for a
 * terminal; under porter the lines go to a browser's greeter, and the
 * browser never holds the token: the porter does, and adds it on the way
 * to the daemon.
 *
 * @param text - The line, ANSI and all.
 * @returns The line without the token.
 */
export function bootLine_redact(text: string): string {
  return text
    .replace(/(token:\s+)[0-9a-f]{16,}/g, '$1(held by the porter)')
    .replace(/([?&]token=)[0-9a-f]{16,}/g, '$1…')
    .replace(/(--token\s+)[0-9a-f]{16,}/g, '$1…');
}

/** Default spawner: a real child with piped streams. */
const spawn_real: SessionSpawn = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] }): SpawnedSession => {
  const child: ChildProcess = childSpawn(command, args, { env: options.env, stdio: options.stdio });
  return child as unknown as SpawnedSession;
};

/**
 * Splits a stream's chunks into lines, handing over each complete one.
 *
 * @param stream - The stream to read.
 * @param onLine - Told each line without its ending.
 */
function stream_lines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (stream === null) return;
  let buffered: string = '';
  stream.on('data', (chunk: Buffer | string): void => {
    buffered += chunk.toString();
    let cut: number = buffered.indexOf('\n');
    while (cut !== -1) {
      onLine(buffered.slice(0, cut).replace(/\r$/, ''));
      buffered = buffered.slice(cut + 1);
      cut = buffered.indexOf('\n');
    }
  });
  stream.on('end', (): void => {
    if (buffered.length > 0) onLine(buffered);
    buffered = '';
  });
}

/** Sessions as child processes on this host. */
export class ProcessHost implements SessionHost {
  private readonly stateDir: string;
  private readonly chellEntry: string;
  private readonly stratusEntry: string | null;
  private readonly spawner: SessionSpawn;
  /** Whether each stratus session was started with the tasks tier. */
  private readonly armed: Map<string, boolean> = new Map();
  private readonly alive: LivenessProbe;
  private readonly bootTimeoutMs: number;
  private readonly pollMs: number;
  private readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  private readonly sessions: Map<string, SessionRecord> = new Map();

  constructor(options: ProcessHostOptions) {
    this.stateDir = options.stateDir;
    this.chellEntry = options.chellEntry;
    this.stratusEntry = options.stratusEntry ?? null;
    this.spawner = options.spawn ?? spawn_real;
    this.alive = options.alive ?? ((url: string): Promise<boolean> => berthUrl_isAlive(url));
    this.bootTimeoutMs = options.bootTimeoutMs ?? 120_000;
    this.pollMs = options.pollMs ?? 250;
    this.kill = options.kill ?? ((pid: number, signal: NodeJS.Signals): void => { process.kill(pid, signal); });
  }

  /**
   * The four directories an identity's session owns, under the state dir.
   *
   * @param identity - The normalised identity.
   * @returns The directories; not necessarily existing yet.
   */
  public dirs_build(identity: string): SessionDirs {
    const root: string = join(this.stateDir, berthKey_compute(identity));
    return {
      config: join(root, 'config'),
      runtime: join(root, 'run'),
      cache: join(root, 'cache'),
      tmp: join(root, 'tmp'),
    };
  }

  /** Reads a berth file, if well formed. */
  private berthFile_read(path: string): Berth | null {
    if (!existsSync(path)) return null;
    try {
      const parsed: Partial<Berth> = JSON.parse(readFileSync(path, 'utf-8')) as Partial<Berth>;
      if (typeof parsed.url === 'string' && typeof parsed.token === 'string' && typeof parsed.identity === 'string') {
        return {
          identity: parsed.identity,
          url: parsed.url,
          token: parsed.token,
          ...(typeof parsed.pid === 'number' ? { pid: parsed.pid } : {}),
          // What the daemon runs and when it booted: the door compares these with its own tree.
          ...(typeof parsed.versions === 'object' && parsed.versions !== null ? { versions: parsed.versions } : {}),
          ...(typeof parsed.booted === 'string' ? { booted: parsed.booted } : {}),
        };
      }
    } catch {
      // A half-written berth reads as none; the next poll reads it whole.
    }
    return null;
  }

  /**
   * Reads an identity's berth from its own runtime directory, if written. A
   * chell daemon writes it under the identity porter knows it by; a stratus
   * daemon names itself by its cloud identity (`<user>@<tenancy>`), which
   * porter learns only from the key, so the one berth in a session's own
   * runtime directory is that session's.
   */
  private berth_read(identity: string): Berth | null {
    const runtime: string = this.dirs_build(identity).runtime;
    const exact: Berth | null = this.berthFile_read(berth_pathIn(runtime, identity));
    if (exact !== null) return exact;
    const calypso: string = join(runtime, 'calypso');
    if (!existsSync(calypso)) return null;
    const berths: string[] = readdirSync(calypso).filter((name: string): boolean => name.startsWith('berth-') && name.endsWith('.json'));
    return berths.length === 1 ? this.berthFile_read(join(calypso, berths[0] as string)) : null;
  }

  /** @inheritdoc */
  public async sessions_adopt(): Promise<SessionSighting[]> {
    const sightings: SessionSighting[] = [];
    if (!existsSync(this.stateDir)) return sightings;
    for (const entry of readdirSync(this.stateDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const berthDir: string = join(this.stateDir, entry.name, 'run', 'calypso');
      if (!existsSync(berthDir)) continue;
      for (const name of readdirSync(berthDir)) {
        if (!name.startsWith('berth-') || !name.endsWith('.json')) continue;
        const berth: Berth | null = this.berthFile_read(join(berthDir, name));
        if (berth === null) continue;
        const alive: boolean = await this.alive(berth.url);
        // A stratus session's own identity is kept beside its berth.
        const marker: string = join(this.stateDir, entry.name, 'identity');
        const identity: string = existsSync(marker) ? readFileSync(marker, 'utf-8').trim() : berth.identity;
        sightings.push({ identity, berth, alive });
        if (alive && !this.sessions.has(identity)) {
          this.sessions.set(identity, {
            identity,
            child: null,
            adoptedPid: berth.pid ?? null,
            lines: [],
            serial: 0,
            open: new Map(),
            state: 'ready',
            listeners: new Set(),
            starting: null,
          });
        }
      }
    }
    return sightings;
  }

  /** @inheritdoc */
  public async find(identity: string): Promise<Berth | null> {
    const berth: Berth | null = this.berth_read(identity);
    if (berth === null) return null;
    return (await this.alive(berth.url)) ? berth : null;
  }

  /** @inheritdoc */
  public async spawn(identity: string, user: string, cubeUrl: string, token: string): Promise<Berth> {
    const existing: SessionRecord | undefined = this.sessions.get(identity);
    if (existing?.starting) return existing.starting;
    const record: SessionRecord = {
      identity,
      child: null,
      adoptedPid: null,
      lines: [],
      serial: 0,
      open: new Map(),
      state: 'booting',
      listeners: new Set(),
      starting: null,
    };
    this.sessions.set(identity, record);
    record.starting = this.boot_run(record, { kind: 'chris', user, cubeUrl, token }).finally((): void => { record.starting = null; });
    return record.starting;
  }

  /** @inheritdoc */
  public stratus_armed(identity: string): boolean | null {
    return this.armed.get(identity) ?? null;
  }

  /** @inheritdoc */
  public stratus_begin(identity: string, configPath: string, spend: boolean, replace: boolean): void {
    const existing: SessionRecord | undefined = this.sessions.get(identity);
    if (existing?.starting) return;
    const launch: SessionLaunch = { kind: 'stratus', configPath, spend };
    // A session already up is ended first: the tier is chosen when a daemon
    // starts, never changed under it.
    if (replace) {
      this.relaunch_begin(identity, launch, spend ? 'Restarting with the tasks tier: this session may change the cloud and bill' : 'Restarting read-only: this session changes nothing in the cloud');
      return;
    }
    const record: SessionRecord = this.record_new(identity);
    this.sessions.set(identity, record);
    record.starting = this.boot_run(record, launch).finally((): void => { record.starting = null; });
    void record.starting.catch((): void => undefined);
  }

  /** A fresh boot record. */
  private record_new(identity: string): SessionRecord {
    return { identity, child: null, adoptedPid: null, lines: [], serial: 0, open: new Map(), state: 'booting', listeners: new Set(), starting: null };
  }

  /** @inheritdoc */
  public spawn_begin(identity: string, user: string, cubeUrl: string, token: string): void {
    // The failure is already on the boot record for whoever follows it; the
    // promise's own rejection has nobody left to reach.
    void this.spawn(identity, user, cubeUrl, token).catch((): void => undefined);
  }

  /**
   * Starts the child and waits for its berth to answer.
   *
   * @param token - The CUBE token the door minted, handed on stdin; null
   *   boots on the token the session saved (`--saved-token`), which refuses
   *   rather than come up offline.
   */
  private async boot_run(record: SessionRecord, launch: SessionLaunch): Promise<Berth> {
    const dirs: SessionDirs = this.dirs_build(record.identity);
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A stratus session keeps its clusters and its home beside its other
    // directories: never porter's own, which every session it starts shares.
    const own: Record<string, string> = {};
    if (launch.kind === 'stratus') {
      const root: string = join(this.stateDir, berthKey_compute(record.identity));
      own['XDG_STATE_HOME'] = join(root, 'state');
      own['HOME'] = join(root, 'home');
      for (const dir of Object.values(own)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      // The daemon's berth names its cloud identity; this names the session's,
      // so a porter restarted adopts it under the key its cookie holds.
      writeFileSync(join(root, 'identity'), `${record.identity}\n`, { encoding: 'utf-8', mode: 0o600 });
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_CONFIG_HOME: dirs.config,
      XDG_RUNTIME_DIR: dirs.runtime,
      XDG_CACHE_HOME: dirs.cache,
      TMPDIR: dirs.tmp,
      // The boot rows are for a greeter that renders them as a terminal
      // would; chalk sees no TTY here and would strip the colour.
      FORCE_COLOR: '3',
      // Last, so the session's own HOME and state win over porter's.
      ...own,
    };
    // The greeter draws the brain itself, from the same frames; the boot's
    // own copy on stdout would stand a second, still brain under the rows.
    let argv: string[];
    let stdin: string = '';
    if (launch.kind === 'chris') {
      const login: string = launch.token !== null ? '--auth-token-stdin' : '--saved-token';
      argv = [this.chellEntry, `${launch.user}@${launch.cubeUrl}`, '--daemon', login, '--no-logo'];
      stdin = launch.token !== null ? `${launch.token}\n` : '';
    } else {
      if (this.stratusEntry === null) return this.boot_end(record, 'failed', 'this porter has no stratus to start');
      argv = [this.stratusEntry, '--config', launch.configPath, ...(launch.spend ? ['--host-control=tasks'] : [])];
      this.armed.set(record.identity, launch.spend);
    }
    const child: SpawnedSession = this.spawner(process.execPath, argv, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    record.child = child;
    const line_note = (channel: 'out' | 'err', raw: string): void => {
      const text: string = bootLine_redact(raw);
      const row: BootRow | null = bootRow_parse(text);
      const held: number | undefined = row === null ? undefined : record.open.get(row.label);
      if (row !== null && held !== undefined) {
        // The outcome of a row printed open: settle it where it stands, as
        // the boot logger would on a terminal. The kept line takes the new
        // text under the old number, so a late follower sees the settled
        // row once, in its place.
        const kept: BootLine | undefined = record.lines.find((line: BootLine): boolean => line.id === held);
        if (kept !== undefined) { kept.channel = channel; kept.text = text; }
        if (!row.open) record.open.delete(row.label);
        const line: BootLine = { channel, text, id: held, replaces: held };
        for (const listener of record.listeners) listener.line(line);
        return;
      }
      const line: BootLine = { channel, text, id: record.serial++ };
      if (row !== null && row.open) record.open.set(row.label, line.id as number);
      record.lines.push(line);
      // A daemon writes for as long as it lives; a follower wants the boot,
      // not the year. The earliest lines go first.
      if (record.lines.length > BOOT_LINES_KEPT) record.lines.splice(0, record.lines.length - BOOT_LINES_KEPT);
      for (const listener of record.listeners) listener.line(line);
    };
    stream_lines(child.stdout, (text: string): void => line_note('out', text));
    stream_lines(child.stderr, (text: string): void => line_note('err', text));
    child.stdin?.end(stdin);
    let exited: number | null = null;
    child.once('exit', (code: number | null): void => { exited = code ?? 0; });

    const deadline: number = Date.now() + this.bootTimeoutMs;
    while (Date.now() < deadline) {
      if (exited !== null) {
        return this.boot_end(record, 'failed', `the session exited during boot (code ${exited})`);
      }
      const berth: Berth | null = this.berth_read(record.identity);
      if (berth !== null && (await this.alive(berth.url))) {
        this.boot_end(record, 'ready');
        return berth;
      }
      await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, this.pollMs); });
    }
    child.kill('SIGTERM');
    return this.boot_end(record, 'failed', `the session did not answer within ${Math.round(this.bootTimeoutMs / 1000)} s`);
  }

  /** Settles a boot and tells everyone following it. */
  private boot_end(record: SessionRecord, state: 'ready', reason?: undefined): void;
  private boot_end(record: SessionRecord, state: 'failed', reason: string): never;
  private boot_end(record: SessionRecord, state: 'ready' | 'failed', reason?: string): void {
    record.state = state;
    record.reason = reason;
    for (const listener of record.listeners) listener.done(state, reason);
    record.listeners.clear();
    if (state === 'failed') throw new Error(reason);
  }

  /** @inheritdoc */
  public boot_follow(identity: string, listener: BootListener): { report: BootReport; release: () => void } | null {
    const record: SessionRecord | undefined = this.sessions.get(identity);
    if (record === undefined) return null;
    const report: BootReport = { lines: [...record.lines], state: record.state, ...(record.reason !== undefined ? { reason: record.reason } : {}) };
    if (record.state === 'booting') record.listeners.add(listener);
    return { report, release: (): void => { record.listeners.delete(listener); } };
  }

  /** @inheritdoc */
  public async evict(identity: string, cause: 'restart' | 'end' = 'end'): Promise<boolean> {
    const record: SessionRecord | undefined = this.sessions.get(identity);
    this.sessions.delete(identity);
    return (await this.process_signal(identity, record, cause)) !== null;
  }

  /** @inheritdoc */
  public restart_begin(identity: string, user: string, cubeUrl: string, why: RestartWhy = { kind: 'asked' }): void {
    const old: SessionRecord | undefined = this.sessions.get(identity);
    const record: SessionRecord = {
      identity,
      child: null,
      adoptedPid: null,
      lines: [],
      serial: 0,
      open: new Map(),
      state: 'booting',
      listeners: new Set(),
      starting: null,
    };
    // The new record stands before the old daemon is touched: a greeter that
    // asks for the boot from here on follows this one, never a gap that
    // reads as "up" while nothing is.
    this.sessions.set(identity, record);
    const say = (text: string): void => {
      const line: BootLine = { channel: 'out', text, id: record.serial++ };
      record.lines.push(line);
      for (const listener of record.listeners) listener.line(line);
    };
    record.starting = (async (): Promise<Berth> => {
      say(restartLine_render(why));
      const ended: SpawnedSession | number | null = await this.process_signal(identity, old, 'restart');
      if (ended !== null && !(await this.gone_wait(identity, ended))) {
        return this.boot_end(record, 'failed', 'the old calypso daemon did not stop');
      }
      if (why.kind !== 'saved-login') say('Starting a fresh calypso daemon on the saved login');
      return this.boot_run(record, { kind: 'chris', user, cubeUrl, token: null });
    })().finally((): void => { record.starting = null; });
    // The failure is already on the boot record for whoever follows it.
    void record.starting.catch((): void => undefined);
  }

  /**
   * Ends a session's daemon and boots it again on another launch, as one
   * boot a greeter follows from the first word.
   *
   * @param identity - The session.
   * @param launch - What to start in its place.
   * @param first - The first line the greeter shows.
   */
  private relaunch_begin(identity: string, launch: SessionLaunch, first: string): void {
    const old: SessionRecord | undefined = this.sessions.get(identity);
    const record: SessionRecord = this.record_new(identity);
    this.sessions.set(identity, record);
    const line: BootLine = { channel: 'out', text: first, id: record.serial++ };
    record.lines.push(line);
    record.starting = (async (): Promise<Berth> => {
      const ended: SpawnedSession | number | null = await this.process_signal(identity, old, 'restart');
      if (ended !== null && !(await this.gone_wait(identity, ended))) return this.boot_end(record, 'failed', 'the old calypso daemon did not stop');
      return this.boot_run(record, launch);
    })().finally((): void => { record.starting = null; });
    void record.starting.catch((): void => undefined);
  }

  /**
   * Leaves a daemon the reason it is ending, then signals it: the child this
   * porter started, or the pid an earlier porter's berth names — the latter
   * only while the berth answers, since a pid whose daemon is gone may be
   * somebody else's by now.
   *
   * @returns The child or pid signalled, or null when there was none.
   */
  private async process_signal(identity: string, record: SessionRecord | undefined, cause: 'restart' | 'end'): Promise<SpawnedSession | number | null> {
    if (record?.child && record.child.exitCode === null) {
      this.closing_leave(identity, cause);
      record.child.kill('SIGTERM');
      return record.child;
    }
    const berth: Berth | null = this.berth_read(identity);
    const pid: number | null = record?.adoptedPid ?? berth?.pid ?? null;
    if (berth !== null && pid !== null && (await this.alive(berth.url))) {
      this.closing_leave(identity, cause);
      this.kill(pid, 'SIGTERM');
      return pid;
    }
    return null;
  }

  /** Leaves the reason beside the berth; a daemon that finds none says it was stopped. */
  private closing_leave(identity: string, cause: 'restart' | 'end'): void {
    try {
      closing_write(this.dirs_build(identity).runtime, identity, cause);
    } catch {
      // Unwritable: the daemon still goes, and says only that it stopped.
    }
  }

  /**
   * Waits until a signalled daemon is gone: its child has exited, or its
   * berth no longer answers.
   *
   * @returns True once it is gone; false when it outlived the wait.
   */
  private async gone_wait(identity: string, ended: SpawnedSession | number): Promise<boolean> {
    const deadline: number = Date.now() + STOP_WAIT_MS;
    while (Date.now() < deadline) {
      if (typeof ended !== 'number') {
        if (ended.exitCode !== null || (ended.signalCode ?? null) !== null) return true;
      } else {
        const berth: Berth | null = this.berth_read(identity);
        if (berth === null || !(await this.alive(berth.url))) return true;
      }
      await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, this.pollMs); });
    }
    return false;
  }
}
