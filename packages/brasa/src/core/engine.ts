/**
 * @file The chell engine facade: line execution and completion behind one
 * hostable interface.
 *
 * The engine is the seam between the shell's deterministic core (dispatch,
 * session, VFS) and whatever hosts it. The CLI REPL is one host; a session
 * daemon serving remote surfaces is the next. A host creates the engine,
 * installs an output sink, and drives it one line at a time:
 *
 * ```
 * const engine: BrasaEngine = await engine_create();
 * const envelopes: CommandEnvelope[] = await engine.line_execute('ls; pwd');
 * ```
 *
 * `line_execute` owns line-level orchestration — shell escape, semicolon
 * batching, redirects, pipes — and yields exactly one envelope per executed
 * command. Output is delivered through the active sink as each command
 * completes, so a terminal host sees output live; the returned envelopes are
 * the records an envelope-aware host (daemon, test) consumes.
 *
 * Single-command execution and the command table live in `./dispatch.js`;
 * this module deliberately keeps its cumin imports type-only.
 *
 * @see docs/calypso.adoc for the governing design.
 * @module
 */
import { FileReadRefusal } from './fileRefusal.js';
export { FileReadRefusal } from './fileRefusal.js';
import chalk from 'chalk';
import type { Regard, WatchState, AmbientEvent, CommandEnvelope } from '@fnndsc/menu';
import { taskWatch_set, taskWatch_release } from './taskWatch.js';
import { ambient_listen } from './ambient.js';
import { session } from '../session/index.js';
import { cwdScope_run } from '../session/cwdScope.js';
import { commandList_parse, type ListCommand } from '../lib/semicolonParser.js';
import {
  pipes_parse,
  redirect_parse,
  command_shellEscape_detect,
  type RedirectInfo,
} from './preprocess.js';
import {
  command_executeToEnvelope,
  command_timingMaybePrint,
  redirect_execute,
  pipe_execute,
} from './dispatch.js';
import { capability_require, surface_get, surface_set, type Surface } from './surface.js';
import { commandCancellation_abort, commandCancellation_stopped, commandCancellation_active, commandCancellation_enable, commandCancellation_request, commandCancellation_run, commandCancellation_signalGet } from './cancellation.js';
import { errorStack } from '@fnndsc/fond';
import { recorder_note } from '../session/recorder.js';
import { assignment_parse, type Assignment } from './variables.js';
import { assignment_execute } from './assignment.js';
import { answerAdapters_register } from '../session/answerAdapters.js';
import { answerOrigin_forget } from '../session/answer.js';
import { lineOrigin_run } from './lineOrigin.js';
import { lineHolds_get, type LineHolds } from './holds.js';
import { joblet_start, jobletLine_parse, joblets_running, jobletsSource, type JobletRunning } from './joblets.js';
import { sink_get, sink_set, type OutputSink } from './sink.js';
import { backend_install, backendInstalled_get, type Backend, type FileByteStream, type TaskSource } from './backend.js';
import { JobRunner, jobsRoot_derive, runner_get, runner_install, type JobSource } from './runner.js';
import { vfsDispatcher_get } from './filesystem.js';
import { itemType_isContainer } from './itemKinds.js';
import type { VFSDispatcher } from '@fnndsc/fond';
import { quoteOpen_find, type OpenQuote } from '../lib/quoting.js';
import { exitCode_set, exitScope_run } from './handlerRun.js';

/**
 * Result of a completion request: the candidates and the prefix they
 * complete, matching what a readline completer consumes.
 *
 * @property candidates - The matching completion candidates.
 * @property prefix - The input prefix the candidates complete.
 */
export interface CompletionResult {
  candidates: string[];
  prefix: string;
}

/** How a host hands the kernel a line. */
export interface LineOptions {
  /** The surface the line came from: what it lists is that surface's answer. */
  origin?: string;
  /** The host's name for the line, which its STOP and Ctrl-C name. */
  id?: string;
  /** Hears the line's exit status when it ends. */
  ended?: (code: number) => void;
}

/**
 * The hostable shell engine.
 *
 * One engine serves one session: it executes command lines against the
 * shared session state and answers completion requests. Hosts own the
 * output destination (via the sink) and the input source (a readline loop,
 * a socket); the engine owns everything between.
 */
export interface BrasaEngine {
  /**
   * Executes one input line and returns one envelope per executed command.
   *
   * @param line - The raw input line (may contain `;`, `|`, `>`, `!`).
   * @returns The envelopes of the executed commands, in execution order.
   */
  line_execute(line: string, options?: LineOptions): Promise<CommandEnvelope[]>;

  /**
   * Requests cancellation of a running command when it supports it (Ctrl-C).
   *
   * @param id - The line, as its host named it; the most recent when omitted.
   * @returns True when the command accepted the request.
   */
  line_cancel?(id?: string): boolean;
  /** Aborts a running command, cancellable or not; the host abandons one that does not end. */
  line_abort?(id?: string): boolean;
  /** Whether the command the caller runs inside was stopped (its output and questions are no one's). */
  command_stopped?(): boolean;

  /**
   * What a line holds of the session while it runs, for a host that runs
   * lines side by side: the pieces its commands change, none for a read,
   * or 'all' when the line cannot say.
   *
   * @param line - The line.
   * @returns Its pieces, or 'all'.
   */
  line_holds?(line: string): LineHolds;

  /**
   * The joblets running now, for a host that warns before a restart ends them.
   *
   * @returns Them, by number.
   */
  joblets_running?(): JobletRunning[];

  /**
   * Computes completion candidates for a partial input line.
   *
   * @param linePrefix - The input line up to the cursor.
   * @returns The matching candidates and the prefix they complete.
   */
  line_complete(linePrefix: string): Promise<CompletionResult>;

  /**
   * Reads one ChRIS file's raw bytes, resolved against the session's
   * working directory. The seam a hosting daemon uses to serve file
   * content to surfaces that render it natively (an image in a browser
   * panel) rather than through a terminal stream.
   *
   * @param filePath - The file's path (absolute or cwd-relative).
   * @returns The file's bytes.
   */
  file_read?(filePath: string): Promise<Buffer>;

  /**
   * Opens one file's bytes as a stream, resolved as {@link Engine.file_read}
   * resolves. A hosting daemon serves a download through it, so a large
   * file reaches the surface as it arrives and is never held whole.
   *
   * @param filePath - The file's path (absolute, cwd-relative, or projected).
   * @returns The stream and its size when known.
   */
  file_stream?(filePath: string): Promise<FileByteStream>;

  /**
   * Writes bytes to one ChRIS path, resolved against the session's working
   * directory. The twin of {@link Engine.file_read}: a surface that cannot
   * reach the machine's disk (a browser) hands its bytes to the daemon,
   * which puts them in the store through the kernel like any other write.
   *
   * @param filePath - The destination path (absolute or cwd-relative).
   * @param bytes - The content to write.
   */
  file_write?(filePath: string, bytes: Buffer): Promise<void>;

  /**
   * Notes a regard write from a surface: the addressable thing the operator
   * most recently indicated. The engine retains it as session truth (last
   * write wins) so engine-side consumers can answer "what is the operator
   * regarding" without any surface geometry crossing the seam.
   *
   * @param regard - The indicated address with its provenance.
   */
  regard_note?(regard: Regard): void;

  /**
   * Returns the session's retained regard, or null before the first
   * indication.
   *
   * @returns The retained regard, or null.
   */
  regard_get?(): Regard | null;

  /**
   * Opens or closes a liveness watch on a subject for one owner (a surface
   * id, or the operator at a console). While any owner watches a subject,
   * the engine samples it and publishes refreshed models as ambient events.
   *
   * @param subject - The subject address (`/proc/jobs/feed_N`).
   * @param owner - Who holds the watch.
   * @param on - True to watch, false to release.
   * @returns The subject's watch state, or null when the subject is not watchable.
   */
  watch_set?(subject: string, owner: string, on: boolean): WatchState | null;

  /**
   * Releases every watch one owner holds (a surface detached).
   *
   * @param owner - The owner whose watches end.
   */
  watch_release?(owner: string): void;

  /**
   * Forgets what a surface left behind (its last answer), when it has gone.
   *
   * @param origin - The surface's origin.
   */
  origin_forget?(origin: string): void;

  /**
   * Subscribes to events the engine originates on its own: a sampler's
   * refreshed model, a watch changing state.
   *
   * @param listener - Receives each ambient event.
   * @returns Function that unsubscribes.
   */
  ambient_listen?(listener: (event: AmbientEvent) => void): () => void;

  /**
   * Installs where the engine's output goes from now on: a daemon's sink
   * relays it to every attached surface, a terminal's writes it to stdout.
   *
   * @param sink - The sink.
   */
  sink_install(sink: OutputSink): void;

  /**
   * Installs who the engine asks for what only a surface can give: a hidden
   * prompt, a local editor, a host shell, a delivered file.
   *
   * @param surface - The surface.
   */
  surface_install(surface: Surface): void;

  /**
   * Picks up the backend's jobs that were running when the session last
   * ended (core/runner.ts). A host calls it once, after installing its surface,
   * which says whether the `tasks` tier is granted.
   *
   * @returns How many went on.
   */
  jobs_resume?(): number;
}

/**
 * Whether a batch (semicolon list, script) should abort on the first error.
 * Read by the batch loop; set by the boot layer for `-e` / script modes.
 */
let stopOnError: boolean = false;

/**
 * Sets the shared stop-on-error flag. Exposed so the boot layer (which owns
 * the `-e` flag and script execution) can drive the flag that the batch
 * loop reads.
 *
 * @param value - `true` to abort a batch on the first error.
 */
export function stopOnError_set(value: boolean): void {
  stopOnError = value;
}

/**
 * Executes a shell-escaped line (`!command`) on the host system.
 *
 * @param trimmedLine - The trimmed input line including the leading `!`.
 * @param startTime - Timing reference from `performance.now()`.
 * @param timingEnabled - Whether to print elapsed time after execution.
 * @returns One envelope carrying the host command's outcome, or none for a
 *   bare `!`.
 */
async function shellEscape_execute(
  trimmedLine: string,
  startTime: number,
  timingEnabled: boolean,
): Promise<CommandEnvelope[]> {
  const shellCommand: string = trimmedLine.substring(1).trim();
  if (!shellCommand) return [];
  try {
    capability_require('shellCommands', 'this surface cannot run shell commands');
    // A host command is cancellable: Ctrl-C (or the console's STOP) kills
    // the process it started rather than leave it holding the session.
    commandCancellation_enable();
    const exitCode: number = await surface_get().shellCommand(shellCommand, commandCancellation_signalGet());
    command_timingMaybePrint(startTime, timingEnabled);
    return [{ status: exitCode === 0 ? 'ok' : 'error', rendered: '' }];
  } catch (error: unknown) {
    const message: string = error instanceof Error ? error.message : String(error);
    return [{ status: 'error', rendered: '', renderedErr: `${chalk.red(`Shell command failed: ${message}`)}\n` }];
  }
}

/**
 * Executes a command list, one segment at a time, collecting each
 * segment's envelopes. A segment after `&&` runs only when the one run
 * before it succeeded, after `||` only when it failed; a segment that is
 * skipped leaves that outcome as it was, as POSIX `sh` does.
 *
 * A segment that throws yields an error envelope; the batch continues unless
 * stop-on-error is set, in which case the envelopes collected so far are
 * returned immediately (and no total time is printed, matching the shell's
 * historical behavior).
 *
 * @param commands - The list's segments in execution order, each with its condition.
 * @param startTime - Timing reference from `performance.now()`.
 * @param timingEnabled - Whether to print the batch's total elapsed time.
 * @returns The envelopes of all executed segments, in execution order.
 */
async function batch_execute(
  commands: ListCommand[],
  startTime: number,
  timingEnabled: boolean,
): Promise<CommandEnvelope[]> {
  const envelopes: CommandEnvelope[] = [];
  let succeeded: boolean = true;
  for (const { command, when } of commands) {
    if ((when === 'success' && !succeeded) || (when === 'failure' && succeeded)) continue;
    try {
      const ran: CommandEnvelope[] = await line_execute(command);
      succeeded = !ran.some((envelope: CommandEnvelope): boolean => envelope.status === 'error');
      envelopes.push(...ran);
    } catch (error: unknown) {
      const msg: string = error instanceof Error ? error.message : String(error);
      sink_get().err_write(`${chalk.red(`Command error: ${msg}`)}\n`);
      envelopes.push({ status: 'error', rendered: '' });
      succeeded = false;
      if (stopOnError) {
        return envelopes;
      }
    }
  }
  if (timingEnabled) {
    const elapsed: number = performance.now() - startTime;
    sink_get().data_write(`${chalk.gray(`[Total: ${elapsed.toFixed(2)}ms]`)}\n`);
  }
  return envelopes;
}

/**
 * Executes one input line and returns one envelope per executed command.
 *
 * Line-level constructs are recognized in the shell's historical order:
 * shell escape first (the whole line goes to the host shell), then
 * semicolon batching (each segment recurses through this function), then
 * pipes, then standalone output redirection, then plain dispatch. A redirect
 * in the final pipe segment therefore runs on the originating surface along
 * with that segment. Output reaches the
 * active sink as each command completes.
 *
 * @param line - The raw input line.
 * @param options - The surface the line came from, when a host names it.
 * @returns The envelopes of the executed commands, in execution order.
 */
export async function line_execute(line: string, options: LineOptions = {}): Promise<CommandEnvelope[]> {
  // A host that names the line's surface scopes it there: what it lists is
  // that surface's answer (#1273).
  if (options.origin !== undefined) {
    const origin: string = options.origin;
    const { origin: _origin, ...rest } = options;
    return await lineOrigin_run(origin, (): Promise<CommandEnvelope[]> => line_execute(line, rest));
  }
  // A line inside a command (a manifest's) shares that command's scope.
  if (commandCancellation_active()) return await line_execute_run(line);
  // A top-level line keeps its own error stack: another command running
  // while this one waits on a question cannot pop its messages, nor have
  // its own drained by this one.
  // ...and its own exit status, so a line running beside it (a read, a
  // background job) never marks it failed, nor it them (#1273).
  return await commandCancellation_run(
    (): Promise<CommandEnvelope[]> => exitScope_run((): Promise<CommandEnvelope[]> =>
      errorStack.scope_run((): Promise<CommandEnvelope[]> => cwdScope_run((): Promise<CommandEnvelope[]> => line_execute_run(line))), options.ended),
    options.id,
  );
}

/**
 * Executes one line inside its already-established cancellation scope.
 *
 * @param line - The raw input line.
 * @param captured - Whether the line is a capture's command, already noted with its assignment.
 * @returns The envelopes of the executed commands, in execution order.
 */
async function line_execute_run(line: string, captured: boolean = false): Promise<CommandEnvelope[]> {
  const trimmedLine: string = line.trim();
  if (!trimmedLine) return [];

  // A quote that never closes is a line the operator has not finished, not
  // one to run as if it closed at the end: refused by name before any of it
  // runs or is recorded, as POSIX refuses it (#1260). A `!` line is the host
  // shell's to read.
  const open: OpenQuote | null = command_shellEscape_detect(trimmedLine) ? null : quoteOpen_find(trimmedLine);
  if (open !== null) {
    sink_get().err_write(`${chalk.red(`chell: the ${open.quote} at column ${open.column} never closes; nothing of the line ran`)}\n`);
    exitCode_set(2);
    return [{ status: 'error', rendered: '' }];
  }

  // A press on a surface and a line at a console arrive here alike, which is
  // what makes recording a session cost nothing: the lowering is the law. A
  // capture's command is part of its assignment's line, already noted.
  if (!captured) recorder_note(trimmedLine);

  // Start timing if enabled
  const timingEnabled: boolean = session.timingEnabled_get();
  const startTime: number = timingEnabled ? performance.now() : 0;

  // `line &` runs the line as a joblet: its surface has its prompt back at once.
  const background: string | null = captured ? null : jobletLine_parse(trimmedLine);
  if (background !== null) {
    const started: CommandEnvelope = await joblet_start(background);
    if (started.status === 'error') exitCode_set(1);
    return [started];
  }

  if (command_shellEscape_detect(trimmedLine)) {
    return shellEscape_execute(trimmedLine, startTime, timingEnabled);
  }

  const batch: ListCommand[] = commandList_parse(trimmedLine);
  if (batch.length > 1) {
    return batch_execute(batch, startTime, timingEnabled);
  }

  // `NAME=$(command)` or `NAME=word`: before pipes, since a capture's
  // command may be a pipe of its own.
  const assignment: Assignment | null = assignment_parse(trimmedLine);
  if (assignment !== null) {
    return await assignment_execute(assignment, trimmedLine, (capture: string): Promise<CommandEnvelope[]> => line_execute_run(capture, true));
  }

  const pipeSegments: string[] = pipes_parse(trimmedLine);
  if (pipeSegments.length > 1) {
    try {
      const envelope: CommandEnvelope = await pipe_execute(pipeSegments);
      command_timingMaybePrint(startTime, timingEnabled);
      return [envelope];
    } catch (error: unknown) {
      const msg: string = error instanceof Error ? error.message : String(error);
      sink_get().err_write(`${chalk.red(`Pipe error: ${msg}`)}\n`);
      return [{ status: 'error', rendered: '' }];
    }
  }

  const redirectInfo: RedirectInfo | null = redirect_parse(trimmedLine);
  if (redirectInfo) {
    const envelope: CommandEnvelope = await redirect_execute(redirectInfo);
    if (envelope.status === 'ok') {
      command_timingMaybePrint(startTime, timingEnabled);
    }
    return [envelope];
  }

  const envelope: CommandEnvelope | null = await command_executeToEnvelope(trimmedLine, startTime, timingEnabled);
  return envelope ? [envelope] : [];
}

/**
 * Requests cancellation of a running command (Ctrl-C).
 *
 * @param id - The line, as its host named it; the most recent when omitted.
 * @returns True when the command can honor the request.
 */
export function line_cancel(id?: string): boolean {
  return commandCancellation_request(id);
}

/**
 * Aborts a running command, cancellable or not (the operator's STOP).
 *
 * @param id - The line, as its host named it; the most recent when omitted.
 * @returns True when such a command was running.
 */
export function line_abort(id?: string): boolean {
  return commandCancellation_abort(id);
}

/**
 * Computes completion candidates for a partial input line.
 *
 * Promise-shaped facade over the callback-style completer, for hosts that
 * answer completion requests asynchronously (a remote surface's tab press).
 * Completion failures resolve to no candidates; they never reject, matching
 * the completer's own never-crash contract.
 *
 * @param linePrefix - The input line up to the cursor.
 * @returns The matching candidates and the prefix they complete.
 */
export async function line_complete(linePrefix: string): Promise<CompletionResult> {
  const { input_complete } = await import('../lib/completer/index.js');
  return new Promise((resolve: (result: CompletionResult) => void) => {
    input_complete(linePrefix, (err: Error | null, result: [string[], string]) => {
      if (err || !result) {
        resolve({ candidates: [], prefix: linePrefix });
        return;
      }
      resolve({ candidates: result[0], prefix: result[1] });
    });
  });
}

/**
 * Handles a command entered by the user.
 *
 * Compatibility shape over {@link line_execute} for callers that do not
 * consume envelopes.
 *
 * @param line - The input line.
 * @returns A Promise that resolves once the command has been processed.
 */
export async function command_handle(line: string): Promise<void> {
  await line_execute(line);
}

/**
 * Adds the core's own mounts (`/usr` and beneath it) to the session's
 * filesystem, after the backend's.
 */
async function vfsProviders_register(): Promise<void> {
  const { StaticVfsProvider } = await import('../lib/vfs/providers/static.js');
  const vfsDispatcher: VFSDispatcher = vfsDispatcher_get();
  vfsDispatcher.provider_register(new StaticVfsProvider('/usr'));
  vfsDispatcher.provider_register(new StaticVfsProvider('/usr/bin'));
  vfsDispatcher.provider_register(new StaticVfsProvider('/usr/games'));
  vfsDispatcher.provider_register(new StaticVfsProvider('/usr/share'));
  vfsDispatcher.provider_register(new StaticVfsProvider('/usr/share/doc'));
  // A backend's task sources that bring no mount of their own are the core's to show, the runner's among them.
  const { TaskSourceVfsProvider } = await import('./tasks.js');
  for (const source of taskSources_all()) {
    if (source.mounted !== true) vfsDispatcher.provider_register(new TaskSourceVfsProvider(source));
  }
}

/**
 * Every task source of the session: the backend's own, and its jobs as the runner keeps them.
 *
 * @returns The sources.
 */
function taskSources_all(): TaskSource[] {
  return [...(backendInstalled_get()?.tasks ?? []), ...(runner_get()?.taskSources_get() ?? [])];
}

/**
 * Creates the engine: initializes session state, registers the VFS
 * providers, and returns the facade a host drives.
 *
 * Establishing a CUBE connection is deliberately not the engine's concern —
 * connection setup involves host-owned interaction (credential prompting,
 * boot reporting) and the engine executes correctly both offline and
 * connected.
 *
 * @param backend - The backend the session runs over; omitted, the one
 *   already installed (the package entry installs ChRIS).
 * @returns The engine facade.
 */
export async function engine_create(backend?: Backend): Promise<BrasaEngine> {
  if (backend !== undefined) backend_install(backend);
  // What each listing's rows are, so `@3` can name one.
  answerAdapters_register();
  // Every session runs joblets (`line &`); a backend adds its own jobs.
  const jobs: ReadonlyArray<JobSource> = [...(backendInstalled_get()?.jobs ?? []), jobletsSource];
  runner_install(new JobRunner(jobsRoot_derive(backendInstalled_get()?.id ?? 'session'), jobs));
  await session.init();
  await vfsProviders_register();
  // A backend's containers are folders to every tool, the dispatcher's read included.
  vfsDispatcher_get().containerTest_register(itemType_isContainer);
  return {
    line_execute,
    line_cancel,
    line_abort,
    command_stopped: commandCancellation_stopped,
    line_holds: lineHolds_get,
    joblets_running,
    line_complete,
    file_read,
    file_stream,
    file_write,
    regard_note: (regard: Regard): void => session.regard_set(regard),
    regard_get: (): Regard | null => session.regard_get(),
    origin_forget: (origin: string): void => answerOrigin_forget(origin),
    // The backend answers for its own subjects (ChRIS: feeds); a task it
    // leaves to the core is watched by the core.
    watch_set: (subject: string, owner: string, on: boolean): WatchState | null =>
      backendInstalled_get()?.watch?.set(subject, owner, on)
        ?? taskWatch_set(subject, owner, on, taskSources_all()),
    watch_release: (owner: string): void => {
      backendInstalled_get()?.watch?.release(owner);
      taskWatch_release(owner);
    },
    ambient_listen,
    sink_install: (sink: OutputSink): void => { sink_set(sink); },
    surface_install: (surface: Surface): void => { surface_set(surface); },
    jobs_resume: (): number => runner_get()?.jobs_resume() ?? 0,
  };
}

/**
 * Writes bytes to one file at a path the session resolves: how a surface
 * with no reach into a filesystem (a browser) delivers a file. The backend
 * does the writing.
 *
 * @param filePath - The destination path (absolute or cwd-relative).
 * @param bytes - The content to write.
 * @throws {Error} When the backend refused the write, or has no files.
 */
export async function file_write(filePath: string, bytes: Buffer): Promise<void> {
  const files: Backend['files'] = backendInstalled_get()?.files;
  if (files === undefined) throw new Error(`cannot write ${filePath}: this session has no files`);
  await files.write(filePath, bytes);
}

/**
 * Reads one file's raw bytes at a path the session resolves, for a surface
 * that renders it natively. The backend does the reading.
 *
 * @param filePath - The file's path (absolute, cwd-relative, or projected).
 * @returns The file's bytes.
 * @throws {Error} When the path does not resolve to a readable file.
 */
export async function file_read(filePath: string): Promise<Buffer> {
  const files: Backend['files'] = backendInstalled_get()?.files;
  if (files === undefined) throw new FileReadRefusal(filePath, 404, 'this session has no files');
  return await files.read(filePath);
}

/**
 * Opens one file's bytes as a stream through the installed backend; a
 * backend that streams nothing is served its whole read, as a stream.
 *
 * @param filePath - The file's path (absolute, cwd-relative, or projected).
 * @returns The stream and its size when known.
 * @throws {FileReadRefusal} When the path does not resolve to a readable file.
 */
export async function file_stream(filePath: string): Promise<FileByteStream> {
  const files: Backend['files'] = backendInstalled_get()?.files;
  if (files === undefined) throw new FileReadRefusal(filePath, 404, 'this session has no files');
  if (files.stream !== undefined) return await files.stream(filePath);
  const bytes: Buffer = await files.read(filePath);
  const { Readable } = await import('node:stream');
  return { stream: Readable.from(bytes), size: bytes.length };
}
