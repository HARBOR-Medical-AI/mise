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
import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, existsSync, realpathSync, writeSync, type Stats } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { berthKey_compute, berth_pathIn, berthUrl_isAlive, closing_write } from '@fnndsc/calypso/berth';
import { sessionEnv_build } from './sessionEnv.js';
import { restartLine_render, type Berth, type BootLine, type BootListener, type BootReport, type RestartWhy, type SessionHost, type SessionSighting } from './sessionHost.js';
import { bootLine_note } from './bootLines.js';

// The boot lines' parse, the token taken out, and how many are kept are shared with the launcher's host.
export { BOOT_LINES_KEPT, bootLine_redact, bootRow_parse, type BootRow } from './bootLines.js';


/** How long a restart waits for the old daemon to go before it gives up. */
export const STOP_WAIT_MS: number = 15_000;

/** How long a daemon that outlived that wait is given to go once it has been killed. */
export const KILL_WAIT_MS: number = 5_000;

/** A process this host did not start, signalled by pid. */
interface SignalledPid {
  /** The pid. */
  pid: number;
  /** When that process started, as the host's kernel says it, or null where it cannot be told. */
  started: string | null;
}

/**
 * Reads when a process started, from `/proc`: with the pid, it says which
 * process this is, since a pid is given to another once its process is gone.
 *
 * @param pid - The pid.
 * @returns The start time as the kernel keeps it (clock ticks since boot); null when there is no such process; undefined when it cannot be told (no `/proc`, or its entry cannot be read).
 */
function processStart_read(pid: number): string | null | undefined {
  try {
    const stat: string = readFileSync(`/proc/${String(pid)}/stat`, 'utf-8');
    // The command's name is in brackets and may hold spaces: the fields are counted after it.
    const fields: string[] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19];
  } catch (error: unknown) {
    const missing: boolean = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
    // Not there, on a host that has a `/proc`: no such process. Anything else is not knowing.
    return missing && existsSync('/proc/self/stat') ? null : undefined;
  }
}

/** Said when a daemon stops answering and its exit cannot be proved. */
const STOP_SILENT: string = 'the calypso daemon no longer answers, but its exit could not be confirmed (its process cannot be read from /proc)';

/** What is known of a signalled daemon: gone, still there, or silent with its exit not provable. */
type StopState = 'gone' | 'there' | 'silent';

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
  /** How long a daemon asked to stop is waited for before it is killed, in ms. */
  stopWaitMs?: number;
  /** The filesystem calls that settle a session's folders (a test's double; node's own otherwise). */
  settleFs?: SettleFs;
  /** How long a killed daemon is waited for before the stop is called failed, in ms. */
  killWaitMs?: number;
  /** When a process started (which process a pid is); `/proc` by default. Null: there is no such process. Undefined: it cannot be told. */
  processStart_read?: (pid: number) => string | null | undefined;
}

/** One session this host knows about. */
/**
 * What a session is started as: a chell daemon for a ChRIS login, or a
 * stratus daemon for the same person's cloud.
 */
export type SessionLaunch =
  | { kind: 'chris'; user: string; cubeUrl: string; token: string | null }
  | { kind: 'stratus'; configPath: string; spend: boolean; door?: ElevationDoorInfo };

/** The door a stratus session can be raised at: the person's CUBE, where their password is checked (D14). */
export interface ElevationDoorInfo {
  cubeUrl: string;
  user: string;
}

interface SessionRecord {
  identity: string;
  child: SpawnedSession | null;
  /** The daemon's pid when adopted from its berth rather than started here. */
  adoptedPid: number | null;
  /** When the adopted process started, as read at adoption and never since: a start is the proof the pid is held to; null (no such process then) and undefined (it could not be read) are no proof, and nothing read later takes their place. */
  adoptedStart?: string | null | undefined;
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

/** A session's folders, settled: its directories, its root, and its own names for home, state and data. */
interface SettledFolders {
  /** The four directories porter names for it. */
  dirs: SessionDirs;
  /** The folder all of them are in. */
  root: string;
  /** HOME, XDG_STATE_HOME and XDG_DATA_HOME, the session's own. */
  own: Record<string, string>;
}

/** How a session's folder is made. */
interface FolderMaking {
  /** Its parents too. */
  recursive: true;
  /** The mode it is made with. */
  mode: number;
}

/**
 * The filesystem calls settling a folder makes: node's own, or a double that
 * shows which object each one reached.
 *
 * @example
 * ```ts
 * const recorded: SettleFs = { ...nodeCalls, open_chmod: (fd, mode) => { changed.push(fd); fchmodSync(fd, mode); } };
 * sessionDir_settle(dir, root, recorded);
 * ```
 */
export interface SettleFs {
  /** Makes the folder. */
  dir_make: (path: string, options: FolderMaking) => unknown;
  /** Opens it. */
  dir_open: (path: string, flags: number) => number;
  /** Reads what is open. */
  open_stat: (fd: number) => Stats;
  /** Changes what is open. */
  open_chmod: (fd: number, mode: number) => void;
  /** Reads what a name names, without following it. */
  name_stat: (path: string) => Stats;
  /** Where a name leads. */
  path_real: (path: string) => string;
  /** Closes what was opened. */
  open_close: (fd: number) => void;
}

/** Node's own filesystem calls. */
const SETTLE_FS: SettleFs = {
  dir_make: (path: string, options: FolderMaking): unknown => mkdirSync(path, options),
  dir_open: (path: string, flags: number): number => openSync(path, flags),
  open_stat: (fd: number): Stats => fstatSync(fd),
  open_chmod: (fd: number, mode: number): void => { fchmodSync(fd, mode); },
  name_stat: (path: string): Stats => lstatSync(path),
  path_real: (path: string): string => realpathSync(path),
  open_close: (fd: number): void => { closeSync(fd); },
};

/**
 * Writes the file naming a session's identity, never through a link or
 * something other than a file standing at its name: opened without
 * following one, as a regular file of this account's, 0600.
 *
 * @param path - The file.
 * @param identity - The identity it names.
 * @throws {Error} When something other than this account's own file stands at the name.
 *
 * @example
 * ```ts
 * identityFile_write('/var/lib/porter/ab12/identity', 'stratus:oci@me@https://cube.example.org/api/v1/');
 * ```
 */
export function identityFile_write(path: string, identity: string): void {
  let handle: number;
  try {
    handle = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  } catch {
    throw new Error(`the session's identity file ${path} is not a file of its own`);
  }
  try {
    const found: Stats = fstatSync(handle);
    if (!found.isFile() || (typeof process.getuid === 'function' && found.uid !== process.getuid())) {
      throw new Error(`the session's identity file ${path} is not a file of its own`);
    }
    fchmodSync(handle, 0o600);
    ftruncateSync(handle, 0);
    writeSync(handle, `${identity}\n`, 0, 'utf-8');
  } finally {
    closeSync(handle);
  }
}

/**
 * Makes a session's folder, or settles one already there: it must be a real
 * folder (not a link), this account's, inside `within`, and it is left 0700
 * whatever mode it had. The folder is opened as a directory without
 * following a link at its own name, and looked at, and tightened, through
 * that open handle: what is checked is what is changed. Its name must still
 * name that same folder afterwards, or the start is refused.
 *
 * @param dir - The folder.
 * @param within - The folder it must lie inside.
 * @param fs - The filesystem calls, node's own unless a test gives a double.
 * @throws {Error} When the path is a link, not a folder, another account's, outside `within`, or no longer the folder checked.
 *
 * @example
 * ```ts
 * sessionDir_settle('/var/lib/porter/ab12/home', '/var/lib/porter/ab12');
 * ```
 */
export function sessionDir_settle(dir: string, within: string, fs: SettleFs = SETTLE_FS): void {
  // Asked of the names first, so nothing is made outside `within` by a path that leaves it.
  if (!resolve(dir).startsWith(`${resolve(within)}${sep}`)) throw new Error(`the session folder ${dir} lies outside ${within}`);
  fs.dir_make(dir, { recursive: true, mode: 0o700 });
  let handle: number;
  try {
    handle = fs.dir_open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    throw new Error(`the session folder ${dir} is not a folder of its own`);
  }
  try {
    let found: Stats = fs.open_stat(handle);
    if (!found.isDirectory()) throw new Error(`the session folder ${dir} is not a folder of its own`);
    if (typeof process.getuid === 'function' && found.uid !== process.getuid()) throw new Error(`the session folder ${dir} belongs to another account`);
    if (!fs.path_real(dir).startsWith(`${fs.path_real(within)}${sep}`)) throw new Error(`the session folder ${dir} lies outside ${within}`);
    // Every mode bit, setgid and sticky among them: the folder is its owner's, and nothing else.
    if ((found.mode & 0o7777) !== 0o700) {
      fs.open_chmod(handle, 0o700);
      found = fs.open_stat(handle);
    }
    if ((found.mode & 0o7777) !== 0o700) throw new Error(`the session folder ${dir} could not be made private`);
    const named: Stats = fs.name_stat(dir);
    if (named.isSymbolicLink() || named.dev !== found.dev || named.ino !== found.ino) throw new Error(`the session folder ${dir} changed while it was checked`);
  } finally {
    fs.open_close(handle);
  }
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
  private readonly stopWaitMs: number;
  private readonly settleFs: SettleFs | undefined;
  private readonly killWaitMs: number;
  private readonly startReader: (pid: number) => string | null | undefined;
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
    this.stopWaitMs = options.stopWaitMs ?? STOP_WAIT_MS;
    this.settleFs = options.settleFs;
    this.killWaitMs = options.killWaitMs ?? KILL_WAIT_MS;
    this.startReader = options.processStart_read ?? processStart_read;
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
            adoptedStart: berth.pid !== undefined ? this.startReader(berth.pid) : undefined,
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
  public stratus_refusal(): string | null {
    return this.stratusEntry === null ? 'this porter has no stratus to start' : null;
  }

  /** @inheritdoc */
  public stratus_armed(identity: string): boolean | null {
    return this.armed.get(identity) ?? null;
  }

  /** @inheritdoc */
  public stratus_begin(identity: string, configPath: string, spend: boolean, replace: boolean, door?: ElevationDoorInfo): void {
    const existing: SessionRecord | undefined = this.sessions.get(identity);
    if (existing?.starting) return;
    const launch: SessionLaunch = { kind: 'stratus', configPath, spend, ...(door === undefined ? {} : { door }) };
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
   * The folders a session is given, each its own: made 0700, or, found
   * already there, a real folder of this account's inside porter's state
   * and left 0700. Every session keeps its home, state and data (a stratus
   * session's clusters, chell's history) beside its other directories, never
   * porter's own, which every session it starts would share.
   *
   * @param identity - The session's identity.
   * @returns The folders, and the session's own names for them.
   * @throws {Error} When a folder is a link, not a folder, another account's, or outside porter's state.
   */
  private folders_settle(identity: string): SettledFolders {
    const dirs: SessionDirs = this.dirs_build(identity);
    const root: string = join(this.stateDir, berthKey_compute(identity));
    const own: Record<string, string> = { HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'state'), XDG_DATA_HOME: join(root, 'data') };
    sessionDir_settle(root, this.stateDir, this.settleFs);
    const folders: string[] = [dirs.config, dirs.runtime, dirs.cache, dirs.tmp, join(root, 'home'), join(root, 'state'), join(root, 'data')];
    for (const dir of folders) sessionDir_settle(dir, root, this.settleFs);
    return { dirs, root, own };
  }

  /**
   * Starts the child and waits for its berth to answer.
   *
   * @param token - The CUBE token the door minted, handed on stdin; null
   *   boots on the token the session saved (`--saved-token`), which refuses
   *   rather than come up offline.
   */
  private async boot_run(record: SessionRecord, launch: SessionLaunch): Promise<Berth> {
    let settled: SettledFolders;
    try {
      settled = this.folders_settle(record.identity);
    } catch (error: unknown) {
      return this.boot_end(record, 'failed', error instanceof Error ? error.message : String(error));
    }
    const { dirs, root, own } = settled;
    if (launch.kind === 'stratus') {
      // The daemon's berth names its cloud identity; this names the session's,
      // so a porter restarted adopts it under the key its cookie holds.
      identityFile_write(join(root, 'identity'), record.identity);
      // The door the session can be raised at: a READ session asks the person's password once and is MANAGE after (D14).
      if (launch.door !== undefined) {
        own['CALYPSO_ELEVATION_URL'] = launch.door.cubeUrl;
        own['CALYPSO_ELEVATION_USER'] = launch.door.user;
      }
    }
    // Never porter's own environment: it holds the key that signs every door cookie (sessionEnv.ts).
    const env: NodeJS.ProcessEnv = sessionEnv_build(process.env, {
      XDG_CONFIG_HOME: dirs.config,
      XDG_RUNTIME_DIR: dirs.runtime,
      XDG_CACHE_HOME: dirs.cache,
      TMPDIR: dirs.tmp,
      // The boot rows are for a greeter that renders them as a terminal
      // would; chalk sees no TTY here and would strip the colour.
      FORCE_COLOR: '3',
      // Last, so the session's own HOME and state win over porter's.
      ...own,
    });
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
    const line_note = (channel: 'out' | 'err', raw: string): void => { bootLine_note(record, channel, raw); };
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
    // The answer waits for the daemon to be gone, and a daemon that will not go is an error, not "ended".
    // The session is forgotten only once it is: a stop that failed keeps what is known of the daemon (its
    // child, or the pid adopted and when that process started), so the next try is held to the same proof.
    const stopped: boolean = await this.daemon_stop(identity, record, cause);
    if (this.sessions.get(identity) === record) this.sessions.delete(identity);
    return stopped;
  }

  /** @inheritdoc */
  public restart_begin(identity: string, user: string, cubeUrl: string, why: RestartWhy = { kind: 'asked' }): Promise<void> {
    const old: SessionRecord | undefined = this.sessions.get(identity);
    let stop_settle: () => void = (): void => undefined;
    const stopped: Promise<void> = new Promise<void>((resolve: () => void): void => { stop_settle = resolve; });
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
      try {
        await this.daemon_stop(identity, old, 'restart');
      } catch (error: unknown) {
        ProcessHost.evidence_keep(record, old);
        return this.boot_end(record, 'failed', error instanceof Error ? error.message : String(error));
      } finally {
        stop_settle();
      }
      if (why.kind !== 'saved-login') say('Starting a fresh calypso daemon on the saved login');
      return this.boot_run(record, { kind: 'chris', user, cubeUrl, token: null });
    })().finally((): void => { record.starting = null; });
    // The failure is already on the boot record for whoever follows it.
    void record.starting.catch((): void => undefined);
    return stopped;
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
      try {
        await this.daemon_stop(identity, old, 'restart');
      } catch (error: unknown) {
        ProcessHost.evidence_keep(record, old);
        return this.boot_end(record, 'failed', error instanceof Error ? error.message : String(error));
      }
      return this.boot_run(record, launch);
    })().finally((): void => { record.starting = null; });
    void record.starting.catch((): void => undefined);
  }

  /**
   * Keeps, on the record of a restart whose stop failed, what was known of
   * the daemon that would not stop: the next try is held to the same proof.
   *
   * @param record - The failed restart's record, which now stands for the session.
   * @param old - What the host knew of the daemon before the restart.
   */
  private static evidence_keep(record: SessionRecord, old: SessionRecord | undefined): void {
    if (old === undefined) return;
    record.child = old.child;
    record.adoptedPid = old.adoptedPid;
    record.adoptedStart = old.adoptedStart;
  }

  /**
   * Stops a session's daemon and waits until it is gone: asked first
   * (`SIGTERM`), and killed if it outlives the wait. A pid this host did not
   * start is killed only when it is proved to be the process that was asked.
   *
   * @param identity - The session.
   * @param record - What the host knew of it, when it knew anything.
   * @param cause - Why it ends, left for the daemon to say.
   * @returns Whether there was a daemon to stop.
   * @throws {Error} When the daemon is still there after being killed, could not be proved to be the one to kill, or went silent with its exit not provable.
   */
  private async daemon_stop(identity: string, record: SessionRecord | undefined, cause: 'restart' | 'end'): Promise<boolean> {
    const ended: SpawnedSession | SignalledPid | null = await this.process_signal(identity, record, cause);
    if (ended === null) return false;
    const asked: StopState = await this.gone_wait(identity, ended, this.stopWaitMs);
    if (asked === 'gone') return true;
    if (asked === 'silent') throw new Error(STOP_SILENT);
    if ('pid' in ended && 'started' in ended) {
      // Proved again before the harder signal: the process asked to stop may have gone at the last moment
      // and its pid been given to another. Where it cannot be proved, it is not killed.
      const now: 'same' | 'gone' | 'unknown' = this.pid_state(ended);
      if (now === 'gone') return true;
      if (now === 'unknown') throw new Error(`pid ${String(ended.pid)} could not be proved to be the session's calypso daemon (its process cannot be read from /proc); it was asked to stop and did not, and was not killed`);
      this.kill(ended.pid, 'SIGKILL');
    } else {
      ended.kill('SIGKILL');
    }
    const killed: StopState = await this.gone_wait(identity, ended, this.killWaitMs);
    if (killed === 'gone') return true;
    if (killed === 'silent') throw new Error(STOP_SILENT);
    throw new Error('the old calypso daemon did not stop, even when killed');
  }

  /**
   * Says what is known of what was signalled.
   *
   * @param identity - The session.
   * @param ended - The child or pid signalled.
   * @returns Gone, still there, or silent: no longer answering, with nothing to prove its exit by.
   */
  private async gone_check(identity: string, ended: SpawnedSession | SignalledPid): Promise<StopState> {
    if (!('pid' in ended && 'started' in ended)) return ended.exitCode !== null || (ended.signalCode ?? null) !== null ? 'gone' : 'there';
    const now: 'same' | 'gone' | 'unknown' = this.pid_state(ended);
    if (now !== 'unknown') return now === 'gone' ? 'gone' : 'there';
    // Nothing says whether the process is there. Its berth still answering says it is; its berth silent
    // says only that: a process can stop answering and live on.
    const berth: Berth | null = this.berth_read(identity);
    return berth !== null && (await this.alive(berth.url)) ? 'there' : 'silent';
  }

  /**
   * Says whether a pid is still the process that was signalled.
   *
   * @param signalled - The pid and when its process started.
   * @returns Same; gone (no such process, or another started since); or unknown, where it cannot be told.
   */
  private pid_state(signalled: SignalledPid): 'same' | 'gone' | 'unknown' {
    if (signalled.started === null) return 'unknown';
    const now: string | null | undefined = this.startReader(signalled.pid);
    if (now === undefined) return 'unknown';
    return now === signalled.started ? 'same' : 'gone';
  }

  /**
   * Leaves a daemon the reason it is ending, then asks it to stop: the child
   * this porter started, or the pid an earlier porter's berth names. The
   * latter only while the berth answers and the pid is still the process it
   * was when adopted, since a pid whose daemon is gone may be somebody
   * else's by now.
   *
   * @returns The child or pid signalled, or null when there was none.
   * @throws {Error} When the adopted pid has become another process.
   */
  private async process_signal(identity: string, record: SessionRecord | undefined, cause: 'restart' | 'end'): Promise<SpawnedSession | SignalledPid | null> {
    if (record?.child && record.child.exitCode === null) {
      this.closing_leave(identity, cause);
      record.child.kill('SIGTERM');
      return record.child;
    }
    const berth: Berth | null = this.berth_read(identity);
    return this.pid_signal(identity, record, berth, berth !== null && (await this.alive(berth.url)), cause);
  }

  /**
   * Asks the daemon a berth or an adoption names by pid to stop, where it
   * may be asked at all.
   *
   * @param identity - The session.
   * @param record - What the host knew of the session.
   * @param berth - The session's berth file as it reads now, or null.
   * @param answers - Whether that berth answers now.
   * @param cause - Why it ends, left for the daemon to say.
   * @returns The pid signalled, or null when nothing says a daemon is there.
   * @throws {Error} When a daemon may be there and nothing may be signalled.
   */
  private pid_signal(identity: string, record: SessionRecord | undefined, berth: Berth | null, answers: boolean, cause: 'restart' | 'end'): SignalledPid | null {
    const pid: number | null = record?.adoptedPid ?? berth?.pid ?? null;
    // No pid, or one that names no single process (0 and negatives signal groups; 1 is the host's own):
    // there is nothing that may be signalled. A berth that answers all the same is a daemon not stopped.
    if (pid === null || !Number.isInteger(pid) || pid <= 1) {
      if (answers) throw new Error('the session\'s berth answers but names no process that can be stopped; nothing was signalled');
      return null;
    }
    const proof: string | null | undefined = record?.adoptedPid === pid ? record.adoptedStart : undefined;
    if (typeof proof === 'string') return this.proved_signal(identity, pid, proof, answers, cause);
    return this.unproved_signal(identity, pid, record, berth?.pid ?? null, answers, cause);
  }

  /**
   * Asks a pid that was never proved to stop, where that may be done at
   * all. Its berth's answer is the only proof there is, and it holds only
   * while the berth still names that pid; such a pid is never killed.
   *
   * @param identity - The session.
   * @param pid - The pid.
   * @param record - What the host knew of the session.
   * @param named - The pid the berth names now, or null.
   * @param answers - Whether the berth answers now.
   * @param cause - Why it ends, left for the daemon to say.
   * @returns The pid signalled, or null when nothing says a daemon is there.
   * @throws {Error} When a daemon may be there and nothing may be signalled: the stop is not confirmed.
   */
  private unproved_signal(identity: string, pid: number, record: SessionRecord | undefined, named: number | null, answers: boolean, cause: 'restart' | 'end'): SignalledPid | null {
    const adopted: boolean = record?.adoptedPid === pid;
    // Known not to be a process when the session was adopted: whatever holds that number now is another.
    if (adopted && record?.adoptedStart === null) {
      if (answers) throw new Error(`pid ${String(pid)} was not a process when the session was adopted, so what holds that number now is not its calypso daemon; nothing was signalled, and the berth still answers`);
      return null;
    }
    if (!answers) {
      // A pid this porter adopted, now silent, with nothing to say whether its process lives.
      if (adopted) throw new Error(STOP_SILENT);
      return null;
    }
    if (named !== pid) throw new Error(`the session's berth no longer names pid ${String(pid)}; nothing was signalled, and the berth still answers`);
    this.closing_leave(identity, cause);
    this.kill(pid, 'SIGTERM');
    return { pid, started: null };
  }

  /**
   * Asks a pid that was proved at adoption to stop, on that proof and not
   * on whether its berth still answers: a daemon whose berth has gone
   * silent, or whose berth file is gone, may still be running.
   *
   * @param identity - The session.
   * @param pid - The pid.
   * @param proof - When its process started, as read at adoption.
   * @param answers - Whether its berth answers now.
   * @param cause - Why it ends, left for the daemon to say.
   * @returns The pid signalled, or null when its process is known to be gone.
   * @throws {Error} When the process cannot be read any more, or the pid is another process while the berth still answers.
   */
  private proved_signal(identity: string, pid: number, proof: string, answers: boolean, cause: 'restart' | 'end'): SignalledPid | null {
    const now: string | null | undefined = this.startReader(pid);
    if (now === undefined) {
      throw new Error(`pid ${String(pid)} could not be proved to be the session's calypso daemon (its process can no longer be read from /proc); it was not signalled`);
    }
    if (now !== proof) {
      // That process is gone. If something still answers at the berth it is not what was adopted.
      if (answers) throw new Error(`pid ${String(pid)} is no longer the session's calypso daemon; it was not signalled`);
      return null;
    }
    this.closing_leave(identity, cause);
    this.kill(pid, 'SIGTERM');
    return { pid, started: proof };
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
   * Waits until a signalled daemon is gone, or can no longer be told about.
   *
   * @param identity - The session.
   * @param ended - The child or pid signalled.
   * @param waitMs - How long to wait.
   * @returns Gone; silent (see {@link gone_check}); or still there when the wait ran out.
   */
  private async gone_wait(identity: string, ended: SpawnedSession | SignalledPid, waitMs: number): Promise<StopState> {
    const deadline: number = Date.now() + waitMs;
    for (;;) {
      const state: StopState = await this.gone_check(identity, ended);
      if (state !== 'there' || Date.now() >= deadline) return state;
      await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, this.pollMs); });
    }
  }
}
