/**
 * @file Joblets: lines run in the background, `line &` (#1273).
 *
 * A long line (a PACS pull, a feed's creation, a teardown) need not hold the
 * console it was typed in. Ended with `&`, it runs as a joblet: the runner
 * keeps it as `/proc/joblets/<N>`, its output goes to its log rather than to
 * a console someone is typing in, and its surface hears one line when it
 * starts (`[1] pull … &`) and one when it ends (`[1]+ Done  pull …`).
 *
 * A joblet is a subshell, as POSIX's is: it stands where its line was typed
 * and starts with that line's variables, and its own `cd`s and assignments
 * stay inside it. What lives in CUBE (a feed, the cohort) is shared, and a
 * joblet holds what its line changes while it works, as a foreground line
 * does, so it waits for, and is waited for by, the lines it conflicts with.
 *
 * A joblet that needs an answer pauses and says so (`[1]+ Waiting for an
 * answer: … · fg %1 to answer`), as a POSIX background job that reads the
 * terminal is stopped: a question asked out of the blue in a console would
 * be answered by accident. `fg %1`, from any surface, asks it there. A verb
 * that can decide without the answer reads that it runs in a joblet
 * (`./jobletScope.js`) and does not ask: a pull on a silent PACS waits its
 * long window and ends, where in front it would ask whether to keep waiting.
 *
 * Joblets belong to the session: they outlive the surface that started them,
 * and a daemon restart ends them, their logs kept ("ended by restart").
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { envelope_error, envelope_ok, taskState_isOver, type CommandEnvelope } from '@fnndsc/menu';
import type { OutputSink } from '@fnndsc/menu/surface';
import type { ProgressEvent, TaskProgress } from '@fnndsc/menu';
import { ambient_publish } from './ambient.js';
import { commandCancellation_abort } from './cancellation.js';
import { lineHolds_get } from './holds.js';
import { jobletScope_run } from './jobletScope.js';
import { lineOrigin_get } from './lineOrigin.js';
import { JobRefusal, runner_get, type JobContext, type JobRecord, type JobRunner, type JobSource } from './runner.js';
import { ansi_strip, sinkScope_run } from './sink.js';
import { surfaceInstalled_get, surfaceScope_run, type PromptRequest, type Surface } from './surface.js';
import { variableScope_fork } from './variables.js';
import { quoteOpen_find } from '../lib/quoting.js';
import { cwdScope_run } from '../session/cwdScope.js';
import { session } from '../session/index.js';

/** The runner source joblets are kept in: `/proc/joblets/<N>`. */
export const JOBLETS_SOURCE_ID: string = 'joblets';

/**
 * Runs work outside every line's scope, as the kernel stood when it loaded:
 * a joblet is its own line, not part of the one that started it.
 */
const rootContext_run: <R>(fn: () => R) => R = AsyncLocalStorage.snapshot();

/** A question a joblet waits on, until someone `fg`s it. */
export interface JobletQuestion {
  request: PromptRequest;
  answer(text: string): void;
  refuse(reason: Error): void;
}

/** A joblet while it runs. */
interface Joblet {
  number: number;
  line: string;
  origin: string;
  question: JobletQuestion | null;
}

const running: Map<number, Joblet> = new Map();
const asking: EventEmitter = new EventEmitter();
asking.setMaxListeners(0);

/**
 * The line a joblet ends with, as its surface and `joblets` print it.
 *
 * @param record - The joblet's record.
 * @returns The notice.
 */
function jobletNotice_render(record: JobRecord): string {
  if (record.state === 'done') return `[${record.id}]+ Done  ${record.label}`;
  if (record.state === 'cancelled') return `[${record.id}]+ Stopped  ${record.label}`;
  const exit: unknown = record.data.exit;
  return `[${record.id}]+ Failed (exit ${typeof exit === 'number' ? exit : 1}): ${record.outcome ?? record.label}`;
}

/** The joblets' source, which the core gives every session's runner. */
export const jobletsSource: JobSource = {
  id: JOBLETS_SOURCE_ID,
  label: 'joblets',
  // A joblet runs the session's own lines, which need no tier in front.
  ungated: true,
  interrupted: 'ended by restart',
  notice: jobletNotice_render,
};

/**
 * The line a `&` sends to the background, when the line ends with one.
 *
 * @param line - The line as typed.
 * @returns The line without its `&`, or null when it is not one (`&&`,
 *   `\&`, a `&` inside quotes, a bare `&`).
 */
export function jobletLine_parse(line: string): string | null {
  const trimmed: string = line.trimEnd();
  if (!trimmed.endsWith('&') || trimmed.endsWith('&&')) return null;
  const body: string = trimmed.slice(0, -1);
  if (body.endsWith('\\') || quoteOpen_find(body) !== null) return null;
  const command: string = body.trim();
  return command === '' ? null : command;
}

/**
 * Publishes a line to the surface a joblet came from.
 *
 * @param origin - The surface.
 * @param text - The line.
 */
function notice_publish(origin: string, text: string, model?: { kind: string; data: unknown }): void {
  ambient_publish({ kind: 'envelope', envelope: envelope_ok(`${text}\n`, model), origin });
}

/** A sink that writes a joblet's output to its log, a line at a time. */
class JobletLogSink implements OutputSink {
  private pending: string = '';

  /**
   * @param write - Writes one line to the log.
   * @param progress - Says how far the joblet has come, on its task.
   * @param relay - Hands a progress event to the joblet's surface.
   */
  constructor(
    private readonly write: (line: string) => void,
    private readonly progress: (progress: TaskProgress) => void,
    private readonly relay: (event: ProgressEvent) => void,
  ) {}

  /** @inheritdoc */
  public data_write(chunk: string | Buffer): void {
    this.text_take(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
  }

  /** @inheritdoc */
  public err_write(chunk: string | Buffer): void {
    this.text_take(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
  }

  /** @inheritdoc */
  public status_write(_text: string): void {
    // A status line is for whoever watches now; a log keeps what happened.
  }

  /** @inheritdoc */
  public progress_write(event: ProgressEvent): void {
    // The surface it came from follows it as it would a line in front.
    this.relay(event);
    // A count goes on the joblet's task, where a tile or a watch reads it.
    if (event.current === undefined) return;
    this.progress({ current: event.current, total: event.total ?? null, ...(event.unit !== undefined ? { unit: event.unit } : {}) });
  }

  /** @inheritdoc */
  public event_write(_kind: string, _data: unknown): void {
    // An event is live by contract.
  }

  /** Writes what is left of a line without its newline. */
  public flush(): void {
    if (this.pending !== '') this.write(this.pending);
    this.pending = '';
  }

  /**
   * Splits text into the log's lines, keeping a part-line for the next chunk.
   *
   * @param text - The text.
   */
  private text_take(text: string): void {
    const lines: string[] = ansi_strip(this.pending + text).split('\n');
    this.pending = lines.pop() ?? '';
    for (const line of lines) this.write(line);
  }
}

/**
 * The number a new joblet takes: one past the highest still running, as a
 * shell numbers its jobs.
 *
 * @param runner - The session's runner.
 * @returns The number.
 */
function jobletNumber_next(runner: JobRunner): number {
  const numbers: number[] = runner.jobs_list(JOBLETS_SOURCE_ID)
    .filter((record: JobRecord): boolean => !taskState_isOver(record.state))
    .map((record: JobRecord): number => Number(record.id))
    .filter((number: number): boolean => Number.isInteger(number));
  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
}

/**
 * Starts a line as a joblet.
 *
 * @param line - The line, without its `&`.
 * @returns The start notice, `[1] line &`, or why it could not start.
 */
export async function joblet_start(line: string): Promise<CommandEnvelope> {
  const runner: JobRunner | null = runner_get();
  if (runner === null) return envelope_error('', undefined, `${line}: this session runs no joblets\n`);
  const number: number = jobletNumber_next(runner);
  const joblet: Joblet = { number, line, origin: lineOrigin_get(), question: null };
  // Where the line was typed: the joblet stands there whatever moves later.
  const cwd: string = await session.getCWD();
  try {
    const started = runner.job_start(JOBLETS_SOURCE_ID, String(number), line, (context: JobContext): Promise<void> => {
      running.set(number, joblet);
      return rootContext_run((): Promise<void> => joblet_run(joblet, context, cwd))
        .finally((): void => { running.delete(number); });
    }, { origin: joblet.origin });
    void started.finished;
  } catch (error: unknown) {
    if (error instanceof JobRefusal) return envelope_error('', undefined, `${error.message}\n`);
    throw error;
  }
  return envelope_ok(`[${number}] ${line} &\n`, { kind: 'joblet.started', data: { number, line, path: `/proc/${JOBLETS_SOURCE_ID}/${number}` } });
}

/**
 * A joblet's work: its line, run as a line of its own, writing to its log.
 *
 * @param joblet - The joblet.
 * @param context - What the runner hands it.
 * @param cwd - Where it stands.
 */
async function joblet_run(joblet: Joblet, context: JobContext, cwd: string): Promise<void> {
  const { line_execute } = await import('./engine.js');
  const host: Surface = surfaceInstalled_get();
  let release: (() => void) | null = null;
  const hold_take = async (): Promise<void> => {
    release = host.hold !== undefined ? await host.hold(lineHolds_get(joblet.line)) : null;
  };
  const hold_give = (): void => {
    const giving: (() => void) | null = release;
    release = null;
    giving?.();
  };
  const key: string = `joblet-${joblet.number}`;
  context.signal.addEventListener('abort', (): void => {
    commandCancellation_abort(key);
    joblet.question?.refuse(new Error('the joblet was stopped'));
  }, { once: true });
  const standIn: Surface = jobletSurface_make(joblet, context, hold_take, hold_give);
  const sink: JobletLogSink = new JobletLogSink(
    (text: string): void => context.log_write(text),
    (progress: TaskProgress): void => context.progress_set(progress),
    (event: ProgressEvent): void => ambient_publish({ kind: 'progress', origin: joblet.origin, id: key, progress: event }),
  );
  let exit: number = 0;
  await hold_take();
  let envelopes: CommandEnvelope[];
  try {
    envelopes = await jobletScope_run(joblet.number, (): Promise<CommandEnvelope[]> => sinkScope_run(sink, (): Promise<CommandEnvelope[]> => surfaceScope_run(standIn, (): Promise<CommandEnvelope[]> =>
      variableScope_fork((): Promise<CommandEnvelope[]> => cwdScope_run((): Promise<CommandEnvelope[]> =>
        line_execute(joblet.line, { origin: `joblet:${joblet.number}`, id: key, ended: (code: number): void => { exit = code; } }), cwd)))));
  } finally {
    hold_give();
  }
  // What the line answered with goes to the log after what it printed, and
  // a model it answered with (a cohort its pull brought home) to its surface,
  // whose views take it as they would from a line in front.
  for (const envelope of envelopes) {
    if (envelope.model !== undefined) ambient_publish({ kind: 'envelope', envelope: { status: envelope.status, rendered: '', model: envelope.model }, origin: joblet.origin });
    if (envelope.rendered !== '') sink.data_write(envelope.rendered.endsWith('\n') ? envelope.rendered : `${envelope.rendered}\n`);
    if (envelope.renderedErr) sink.err_write(envelope.renderedErr.endsWith('\n') ? envelope.renderedErr : `${envelope.renderedErr}\n`);
  }
  sink.flush();
  const failed: boolean = exit !== 0 || envelopes.some((envelope: CommandEnvelope): boolean => envelope.status === 'error');
  if (!failed) return;
  context.data_set('exit', exit === 0 ? 1 : exit);
  const lastErr: string = envelopes.map((envelope: CommandEnvelope): string => ansi_strip(envelope.renderedErr ?? '')).join('').trim().split('\n').pop() ?? '';
  throw new Error(lastErr !== '' ? lastErr : `exit ${exit === 0 ? 1 : exit}`);
}

/**
 * The surface a joblet runs under: the host's, except that a question
 * pauses the joblet until someone `fg`s it, giving up what it holds while
 * it waits.
 *
 * @param joblet - The joblet.
 * @param context - Its runner context.
 * @param hold_take - Takes its hold again.
 * @param hold_give - Gives its hold up.
 * @returns The stand-in.
 */
function jobletSurface_make(joblet: Joblet, context: JobContext, hold_take: () => Promise<void>, hold_give: () => void): Surface {
  const question_pause = async (request: PromptRequest): Promise<string> => {
    if (context.signal.aborted) throw new Error('the joblet was stopped');
    hold_give();
    notice_publish(joblet.origin, `[${joblet.number}]+ Waiting for an answer: ${request.message.trim()} · fg %${joblet.number} to answer`,
      { kind: 'joblet.waiting', data: { number: joblet.number, line: joblet.line, question: request.message } });
    context.log_write(`waiting for an answer: ${request.message.trim()}`);
    try {
      return await new Promise<string>((resolve: (text: string) => void, reject: (reason: Error) => void): void => {
        joblet.question = {
          request,
          answer: (text: string): void => { joblet.question = null; resolve(text); },
          refuse: (reason: Error): void => { joblet.question = null; reject(reason); },
        };
        asking.emit(`asked:${joblet.number}`);
      });
    } finally {
      await hold_take();
    }
  };
  return new Proxy(surfaceInstalled_get(), {
    get: (_target: Surface, property: string | symbol): unknown => {
      if (property === 'prompt') return question_pause;
      const host: Surface = surfaceInstalled_get();
      const value: unknown = Reflect.get(host, property);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(host) : value;
    },
  });
}

/**
 * The question a joblet waits on now, if any.
 *
 * @param number - The joblet.
 * @returns Its question, or null.
 */
export function jobletQuestion_get(number: number): JobletQuestion | null {
  return running.get(number)?.question ?? null;
}

/**
 * Waits until a joblet asks a question, or the wait is called off.
 *
 * @param number - The joblet.
 * @param until - Calls the wait off when it settles.
 * @returns The question, or null when called off first.
 */
export async function jobletQuestion_await(number: number, until: Promise<unknown>): Promise<JobletQuestion | null> {
  const now: JobletQuestion | null = jobletQuestion_get(number);
  if (now !== null) return now;
  let heard: (() => void) | null = null;
  const asked: Promise<'asked'> = new Promise<'asked'>((resolve: (value: 'asked') => void): void => {
    heard = (): void => resolve('asked');
    asking.once(`asked:${number}`, heard);
  });
  const outcome: 'asked' | 'off' = await Promise.race([asked, until.then((): 'off' => 'off', (): 'off' => 'off')]);
  if (heard !== null) asking.off(`asked:${number}`, heard);
  return outcome === 'asked' ? jobletQuestion_get(number) : null;
}

/** A joblet still running, as a restart's warning counts it. */
export interface JobletRunning {
  number: number;
  line: string;
  waiting: boolean;
}

/**
 * The joblets running now: what a restart would end.
 *
 * @returns Them, by number.
 */
export function joblets_running(): JobletRunning[] {
  return [...running.values()]
    .sort((a: Joblet, b: Joblet): number => a.number - b.number)
    .map((joblet: Joblet): JobletRunning => ({ number: joblet.number, line: joblet.line, waiting: joblet.question !== null }));
}

/**
 * Whether a joblet waits on an answer.
 *
 * @param number - The joblet.
 * @returns True while it waits.
 */
export function joblet_isWaiting(number: number): boolean {
  return jobletQuestion_get(number) !== null;
}

/**
 * The joblet a word names: `%3`, `%%`/`%+` (the most recent), or `3`.
 *
 * @param word - The word.
 * @returns The joblet's number, or null when the word names none.
 */
export function jobletWord_parse(word: string): number | null {
  const runner: JobRunner | null = runner_get();
  if (word === '%%' || word === '%+' || word === '%') {
    const numbers: number[] = (runner?.jobs_list(JOBLETS_SOURCE_ID) ?? []).map((record: JobRecord): number => Number(record.id)).filter(Number.isInteger);
    const live: number[] = numbers.filter((number: number): boolean => running.has(number));
    const pool: number[] = live.length > 0 ? live : numbers;
    return pool.length === 0 ? null : Math.max(...pool);
  }
  const match: RegExpMatchArray | null = word.match(/^%?(\d+)$/);
  return match === null ? null : Number(match[1]);
}
