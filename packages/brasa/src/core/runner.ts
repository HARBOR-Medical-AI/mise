/**
 * @file The runner: a backend's long jobs, started, kept and stopped by the
 * core (docs/stratus.adoc, D10).
 *
 * A job is an async function the backend hands in, given a context to
 * report progress, write its log, keep what it must remember, and hear a
 * stop. The runner keeps each job's record and whole log under the
 * session's state folder, so a job outlives the command that started it and
 * every surface; a job whose work runs elsewhere (a cloud's own job, an
 * installer's poll) is picked up again after a restart through its source's
 * `resume`. Each source is a task source, so `/proc/<source>` and the tiles
 * show its jobs as they show any task.
 *
 * Starting a job needs the `tasks` tier: the surface the engine runs under
 * says whether its operator granted it, and the runner refuses without it,
 * so no backend starts a job past that door. Stopping is gentle: `kill`
 * aborts the job's signal and the job ends when its current operation does;
 * it is never forced.
 *
 * @module
 */
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { envelope_ok, taskState_isOver, type Task, type TaskProgress, type TaskState } from '@fnndsc/menu';
import { ambient_publish } from './ambient.js';
import { aside_await, surface_get } from './surface.js';
import type { TaskSource } from './backend.js';

/** The model a job's end travels as, on the ambient channel. */
export const JOB_MODEL_KIND: string = 'tasks.job';

/** How many of a job's last log lines its task carries as `logTail`. */
export const JOB_LOG_TAIL_LINES: number = 20;

/**
 * What the runner keeps of one job, on disk and in memory.
 *
 * @property id - Its name in its source, a path segment.
 * @property source - The source's id: the job is `/proc/<source>/<id>`.
 * @property label - What an operator reads it as.
 * @property state - Where it stands.
 * @property progress - How far it has come, when it says.
 * @property started - When it started, ISO 8601.
 * @property ended - When it ended, ISO 8601.
 * @property data - What the job asked to remember (a cloud job's id), read back by `resume`.
 * @property outcome - Its last word: why it failed, or how it ended.
 */
export interface JobRecord {
  id: string;
  source: string;
  label: string;
  state: TaskState;
  progress?: TaskProgress;
  started: string;
  ended?: string;
  data: Record<string, unknown>;
  outcome?: string;
}

/** What a running job is handed. */
export interface JobContext {
  /** Aborted when an operator asks the job to stop; the job ends when its current operation does. */
  readonly signal: AbortSignal;
  /** What the job remembered so far (all of it again, after a restart). */
  readonly data: Readonly<Record<string, unknown>>;
  /** Says how far it has come. */
  progress_set(progress: TaskProgress): void;
  /** Writes one line to its log. */
  log_write(line: string): void;
  /** Remembers one value across a restart. */
  data_set(key: string, value: unknown): void;
}

/** A job's work: resolves when done, throws when failed; resolving after its signal aborted is a cancel. */
export type JobRun = (context: JobContext) => Promise<void>;

/**
 * One kind of job a backend runs (stratus: a cluster's build steps).
 *
 * @property id - Its name, and its folder: `/proc/<id>`.
 * @property label - What an operator reads it as.
 * @property resume - Picks a job that was running when the session ended up
 *   again, from its record: the work to go on with, or null when it cannot
 *   go on (it is then marked failed, saying so).
 * @property ungated - Starting one needs no tier: its work is the session's
 *   own lines, which the operator may run anyway (a joblet).
 * @property interrupted - What a job that cannot go on after a restart says.
 * @property notice - The line every surface (or the job's own, `data.origin`)
 *   hears when a job ends; the job's path and state when absent.
 */
export interface JobSource {
  readonly id: string;
  readonly label: string;
  readonly resume?: (record: JobRecord) => JobRun | null;
  readonly ungated?: boolean;
  readonly interrupted?: string;
  readonly notice?: (record: JobRecord) => string;
}

/** Why a job did not start. */
export class JobRefusal extends Error {
  /**
   * @param message - The refusal, as the operator reads it.
   */
  constructor(message: string) {
    super(message);
    this.name = 'JobRefusal';
  }
}

/** What `kill` did. */
export type JobStopResult = 'stopping' | 'already-stopping' | 'not-running' | 'unknown';

/** One job in memory: its record, its log tail, and its stop. */
interface JobEntry {
  record: JobRecord;
  tail: string[];
  controller?: AbortController;
  done?: Promise<JobRecord>;
}

/**
 * The folder the runner keeps a backend's jobs in:
 * `$XDG_STATE_HOME/<backend>/jobs` (`~/.local/state` when unset).
 *
 * @param backendId - The backend's id.
 * @param env - The environment.
 * @returns The folder.
 */
export function jobsRoot_derive(backendId: string, env: NodeJS.ProcessEnv = process.env): string {
  const state: string = env['XDG_STATE_HOME'] || path.join(os.homedir(), '.local', 'state');
  return path.join(state, backendId, 'jobs');
}

/**
 * Writes a file whole or not at all.
 *
 * @param file - Where.
 * @param text - What.
 */
function file_writeAtomic(file: string, text: string): void {
  const temporary: string = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** The runner: every job source of one session. */
export class JobRunner {
  private readonly entries: Map<string, JobEntry> = new Map();
  private readonly events: EventEmitter = new EventEmitter();

  /**
   * @param root - The folder its records and logs live in.
   * @param sources - The backend's job sources.
   * @param allowed - Whether starting a job is allowed now (the `tasks` tier).
   */
  constructor(
    private readonly root: string,
    private readonly sources: ReadonlyArray<JobSource>,
    private readonly allowed: () => boolean = (): boolean => surface_get().capabilities.tasks === true,
  ) {
    this.events.setMaxListeners(0);
    for (const source of sources) this.records_load(source.id);
  }

  /**
   * A job source by id.
   *
   * @param id - Its id.
   * @returns It, or undefined.
   */
  private source_find(id: string): JobSource | undefined {
    return this.sources.find((candidate: JobSource): boolean => candidate.id === id);
  }

  /**
   * A job's key in the map.
   *
   * @param source - Its source's id.
   * @param id - Its id.
   * @returns The key.
   */
  private key_format(source: string, id: string): string {
    return `${source}/${id}`;
  }

  /**
   * A source's folder, made when missing.
   *
   * @param source - Its id.
   * @returns The folder.
   */
  private folder_make(source: string): string {
    const folder: string = path.join(this.root, source);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    return folder;
  }

  /**
   * Reads a source's records back from disk.
   *
   * @param source - Its id.
   */
  private records_load(source: string): void {
    const folder: string = path.join(this.root, source);
    if (!fs.existsSync(folder)) return;
    for (const name of fs.readdirSync(folder).filter((file: string): boolean => file.endsWith('.json'))) {
      try {
        const record: JobRecord = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf-8')) as JobRecord;
        const tail: string[] = this.logLines_read(source, record.id).slice(-JOB_LOG_TAIL_LINES);
        this.entries.set(this.key_format(source, record.id), { record, tail });
      } catch {
        // A torn record is no job; the next start of that id replaces it.
      }
    }
  }

  /**
   * A job's log, as lines.
   *
   * @param source - Its source.
   * @param id - Its id.
   * @returns The lines (none when it has no log).
   */
  private logLines_read(source: string, id: string): string[] {
    const file: string = path.join(this.root, source, `${id}.log`);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf-8').split('\n').filter((line: string): boolean => line !== '');
  }

  /**
   * Saves a job's record.
   *
   * @param entry - The job.
   */
  private record_save(entry: JobEntry): void {
    file_writeAtomic(path.join(this.folder_make(entry.record.source), `${entry.record.id}.json`), `${JSON.stringify(entry.record, null, 2)}\n`);
  }

  /**
   * Adds a line to a job's log, on disk and in its tail, and tells anyone following.
   *
   * @param entry - The job.
   * @param line - The line.
   */
  private log_append(entry: JobEntry, line: string): void {
    const stamped: string = `${new Date().toISOString().slice(11, 19)} ${line}`;
    fs.appendFileSync(path.join(this.folder_make(entry.record.source), `${entry.record.id}.log`), `${stamped}\n`, { mode: 0o600 });
    entry.tail.push(stamped);
    if (entry.tail.length > JOB_LOG_TAIL_LINES) entry.tail.shift();
    this.events.emit(`log:${this.key_format(entry.record.source, entry.record.id)}`, stamped);
  }

  /**
   * Runs a job's work to its end and records how it ended.
   *
   * @param entry - The job.
   * @param run - Its work.
   * @returns Its record at the end.
   */
  private async work_run(entry: JobEntry, run: JobRun): Promise<JobRecord> {
    const controller: AbortController = new AbortController();
    entry.controller = controller;
    const context: JobContext = {
      signal: controller.signal,
      data: entry.record.data,
      progress_set: (progress: TaskProgress): void => { entry.record.progress = progress; this.record_save(entry); },
      log_write: (line: string): void => { this.log_append(entry, line); },
      data_set: (key: string, value: unknown): void => { entry.record.data[key] = value; this.record_save(entry); },
    };
    try {
      await run(context);
      entry.record.state = controller.signal.aborted ? 'cancelled' : 'done';
      entry.record.outcome = controller.signal.aborted ? 'stopped when asked' : 'done';
    } catch (error: unknown) {
      entry.record.state = controller.signal.aborted ? 'cancelled' : 'failed';
      entry.record.outcome = error instanceof Error ? error.message : String(error);
      this.log_append(entry, `${entry.record.state}: ${entry.record.outcome}`);
    }
    entry.record.ended = new Date().toISOString();
    delete entry.controller;
    this.record_save(entry);
    this.events.emit(`end:${this.key_format(entry.record.source, entry.record.id)}`, entry.record);
    // Every surface hears a job end, as it hears a chime: a line and its
    // model. A job that names the surface it was started on tells it alone.
    const source: JobSource | undefined = this.source_find(entry.record.source);
    const notice: string = source?.notice?.(entry.record)
      ?? `/proc/${entry.record.source}/${entry.record.id}: ${entry.record.state}${entry.record.state === 'done' ? '' : ` (${entry.record.outcome ?? ''})`}`;
    const origin: unknown = entry.record.data.origin;
    ambient_publish({
      kind: 'envelope',
      envelope: envelope_ok(`${notice}\n`, { kind: JOB_MODEL_KIND, data: { ...entry.record } }),
      ...(typeof origin === 'string' ? { origin } : {}),
    });
    return entry.record;
  }

  /**
   * Starts a job.
   *
   * @param source - Its source's id.
   * @param id - Its id (a path segment); a job of that id that has ended is replaced.
   * @param label - What an operator reads it as.
   * @param run - Its work.
   * @param data - What it starts out remembering.
   * @returns Its record as it starts; `finished` resolves with its record at the end.
   * @throws JobRefusal - Without the `tasks` tier, for an unknown source, or while that id still runs.
   */
  job_start(source: string, id: string, label: string, run: JobRun, data: Record<string, unknown> = {}): { record: JobRecord; finished: Promise<JobRecord> } {
    const kind: JobSource | undefined = this.source_find(source);
    if (kind === undefined) throw new JobRefusal(`${id}: no task source ${source}`);
    if (kind.ungated !== true && !this.allowed()) throw new JobRefusal(`${id}: Operation not permitted: starting a task needs the tasks tier (calypso --host-control tasks)`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new JobRefusal(`${id}: a task's name is letters, digits, '.', '_' and '-'`);
    const existing: JobEntry | undefined = this.entries.get(this.key_format(source, id));
    if (existing !== undefined && !taskState_isOver(existing.record.state)) throw new JobRefusal(`${id}: already running (/proc/${source}/${id})`);
    const folder: string = this.folder_make(source);
    fs.rmSync(path.join(folder, `${id}.log`), { force: true });
    const entry: JobEntry = { record: { id, source, label, state: 'running', started: new Date().toISOString(), data: { ...data } }, tail: [] };
    this.entries.set(this.key_format(source, id), entry);
    this.record_save(entry);
    entry.done = this.work_run(entry, run);
    return { record: { ...entry.record }, finished: entry.done };
  }

  /**
   * Picks up the jobs that were running when the session last ended: each
   * source's `resume` gives the work to go on with, or the job is marked
   * failed, saying why. Run once, after the surface is installed.
   *
   * @returns How many went on.
   */
  jobs_resume(): number {
    let resumed: number = 0;
    for (const entry of this.entries.values()) {
      if (taskState_isOver(entry.record.state) || entry.controller !== undefined) continue;
      const source: JobSource | undefined = this.sources.find((candidate: JobSource): boolean => candidate.id === entry.record.source);
      const run: JobRun | null = source?.resume?.(entry.record) ?? null;
      if (run === null || (source?.ungated !== true && !this.allowed())) {
        entry.record.state = 'failed';
        entry.record.ended = new Date().toISOString();
        entry.record.outcome = run === null
          ? source?.interrupted ?? 'interrupted: the session ended while it ran, and it cannot be picked up again'
          : 'interrupted: the session restarted without the tasks tier';
        this.log_append(entry, `failed: ${entry.record.outcome}`);
        this.record_save(entry);
        continue;
      }
      this.log_append(entry, 'picked up again after a restart');
      entry.done = this.work_run(entry, run);
      resumed++;
    }
    return resumed;
  }

  /**
   * Asks a running job to stop.
   *
   * @param source - Its source.
   * @param id - Its id.
   * @returns What happened.
   */
  job_stop(source: string, id: string): JobStopResult {
    const entry: JobEntry | undefined = this.entries.get(this.key_format(source, id));
    if (entry === undefined) return 'unknown';
    if (entry.controller === undefined) return 'not-running';
    if (entry.controller.signal.aborted) return 'already-stopping';
    this.log_append(entry, 'asked to stop; it ends when its current operation does');
    entry.controller.abort();
    return 'stopping';
  }

  /**
   * One job's record.
   *
   * @param source - Its source.
   * @param id - Its id.
   * @returns A copy, or undefined.
   */
  job_get(source: string, id: string): JobRecord | undefined {
    const entry: JobEntry | undefined = this.entries.get(this.key_format(source, id));
    return entry === undefined ? undefined : { ...entry.record, data: { ...entry.record.data } };
  }

  /**
   * Every job, or one source's.
   *
   * @param source - A source's id; absent, all.
   * @returns Copies of their records, newest first.
   */
  jobs_list(source?: string): JobRecord[] {
    return [...this.entries.values()]
      .filter((entry: JobEntry): boolean => source === undefined || entry.record.source === source)
      .map((entry: JobEntry): JobRecord => ({ ...entry.record, data: { ...entry.record.data } }))
      .sort((a: JobRecord, b: JobRecord): number => b.started.localeCompare(a.started));
  }

  /**
   * Follows a job, as `tail -f` does: its last lines kept in memory first,
   * then each new one, then its end.
   *
   * @param source - Its source.
   * @param id - Its id.
   * @param onLine - Hears each new line.
   * @param signal - Stops following (the job goes on).
   * @returns Its record at the end, or at the moment following stopped.
   */
  job_follow(source: string, id: string, onLine: (line: string) => void, signal?: AbortSignal): Promise<JobRecord | undefined> {
    const key: string = this.key_format(source, id);
    const entry: JobEntry | undefined = this.entries.get(key);
    if (entry === undefined) return Promise.resolve(undefined);
    for (const line of entry.tail) onLine(line);
    if (taskState_isOver(entry.record.state)) return Promise.resolve({ ...entry.record });
    return new Promise((resolve: (record: JobRecord) => void): void => {
      const line_hear = (line: string): void => onLine(line);
      const finish = (): void => {
        this.events.off(`log:${key}`, line_hear);
        this.events.off(`end:${key}`, finish);
        signal?.removeEventListener('abort', finish);
        resolve({ ...entry.record });
      };
      this.events.on(`log:${key}`, line_hear);
      this.events.on(`end:${key}`, finish);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  /**
   * Follows a job as {@link job_follow} does, but out of the session's turn
   * between its lines: a follow is waiting, not working, so other lines run
   * while the job is quiet (a pane's reads among them). Each line heard is
   * given to `onLine` once the follower has its turn again.
   *
   * @param source - Its source.
   * @param id - Its id.
   * @param onLine - Hears each line, in the follower's turn.
   * @param signal - Stops following (the job goes on).
   * @returns Its record at the end, or at the moment following stopped.
   */
  async job_followAside(source: string, id: string, onLine: (line: string) => void, signal?: AbortSignal): Promise<JobRecord | undefined> {
    const heard: string[] = [];
    let wake: (() => void) | null = null;
    const nudge = (): void => { const woken: (() => void) | null = wake; wake = null; woken?.(); };
    let over: boolean = false;
    let ended: JobRecord | undefined;
    void this.job_follow(source, id, (line: string): void => { heard.push(line); nudge(); }, signal).then((record: JobRecord | undefined): void => {
      ended = record;
      over = true;
      nudge();
    });
    for (;;) {
      while (heard.length > 0) onLine(heard.shift() as string);
      if (over) return ended;
      await aside_await(new Promise<void>((resolve: () => void): void => {
        wake = resolve;
        if (heard.length > 0 || over) nudge();
      }));
    }
  }

  /**
   * A job's log, whole.
   *
   * @param source - Its source.
   * @param id - Its id.
   * @returns The log, or null when there is none.
   */
  log_read(source: string, id: string): string | null {
    const lines: string[] = this.logLines_read(source, id);
    return lines.length === 0 && !this.entries.has(this.key_format(source, id)) ? null : lines.map((line: string): string => `${line}\n`).join('');
  }

  /**
   * The job sources as task sources, for `/proc` and the tiles.
   *
   * @returns One task source per job source.
   */
  taskSources_get(): TaskSource[] {
    return this.sources.map((source: JobSource): TaskSource => ({
      id: source.id,
      label: source.label,
      list: async (): Promise<Task[]> => this.jobs_list(source.id).map((record: JobRecord): Task => this.task_build(record)),
      log: async (id: string): Promise<string | null> => this.log_read(source.id, id),
    }));
  }

  /**
   * A job as a task.
   *
   * @param record - Its record.
   * @returns The task.
   */
  private task_build(record: JobRecord): Task {
    const entry: JobEntry | undefined = this.entries.get(this.key_format(record.source, record.id));
    return {
      id: record.id,
      label: record.label,
      state: record.state,
      ...(record.progress !== undefined ? { progress: record.progress } : {}),
      started: record.started,
      ...(record.ended !== undefined ? { ended: record.ended } : {}),
      ...(entry !== undefined && entry.tail.length > 0 ? { logTail: entry.tail.map((line: string): string => `${line}\n`).join('') } : {}),
    };
  }
}

let installed: JobRunner | null = null;

/**
 * Installs the session's runner.
 *
 * @param runner - The runner, or null to remove it.
 */
export function runner_install(runner: JobRunner | null): void {
  installed = runner;
}

/**
 * The session's runner.
 *
 * @returns It, or null when the backend runs no jobs.
 */
export function runner_get(): JobRunner | null {
  return installed;
}
