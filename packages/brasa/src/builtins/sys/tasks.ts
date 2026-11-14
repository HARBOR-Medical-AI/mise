/**
 * @file `kill` and `wait`: the shell's job verbs over the runner's jobs
 * (core/runner.ts).
 *
 * A job is named as it is mounted, `/proc/<source>/<id>`, or as
 * `<source>/<id>`, or by its id alone when one source has it. `kill` asks a
 * job to stop and is silent when it does, as kill(1) is; the job ends when
 * its current operation does, and a second `kill` says so rather than
 * forcing it, because a cloud job cut short can leave its state locked.
 * `wait` follows a job's log until it ends, and its status is the job's:
 * Ctrl-C stops following, never the job. Declared in one record each
 * (`killCommand`, `waitCommand`); neither takes an option, so `kill -9` is
 * refused before it runs.
 *
 * @module
 */
import { envelope_error, envelope_ok, taskState_isOver, type CommandEnvelope } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { runner_get, type JobRecord, type JobRunner, type JobStopResult } from '../../core/runner.js';
import { commandCancellation_enable, commandCancellation_signalGet } from '../../core/cancellation.js';
import { sink_dataLine } from '../../core/sink.js';
import { JOBLETS_SOURCE_ID, jobletWord_parse } from '../../core/joblets.js';

/** A job a word names. */
interface JobName {
  source: string;
  id: string;
}

/**
 * The job a word names.
 *
 * @param runner - The session's runner.
 * @param word - `/proc/<source>/<id>`, `<source>/<id>`, `<id>`, or a joblet's `%N`.
 * @returns The job, or a reason it names none.
 */
export function jobName_resolve(runner: JobRunner, word: string): JobName | { error: string } {
  // `%3` (and `%%`) name a joblet, as a shell names its jobs.
  if (word.startsWith('%')) {
    const number: number | null = jobletWord_parse(word);
    return number === null ? { error: 'no such joblet' } : { source: JOBLETS_SOURCE_ID, id: String(number) };
  }
  const parts: string[] = word.replace(/^\/proc\//, '').split('/').filter(Boolean);
  if (parts.length === 2) return { source: parts[0] as string, id: parts[1] as string };
  if (parts.length !== 1) return { error: 'no such task' };
  const matches: JobRecord[] = runner.jobs_list().filter((record: JobRecord): boolean => record.id === parts[0]);
  if (matches.length === 0) return { error: 'no such task' };
  if (matches.length > 1) return { error: `ambiguous: ${matches.map((record: JobRecord): string => `/proc/${record.source}/${record.id}`).sort().join(', ')}` };
  return { source: (matches[0] as JobRecord).source, id: (matches[0] as JobRecord).id };
}

/** What `kill` says for each outcome but a quiet success. */
const STOP_WORDS: Record<Exclude<JobStopResult, 'stopping'>, (record: JobRecord | undefined) => string> = {
  'already-stopping': (): string => 'already asked to stop; it ends when its current operation does',
  'not-running': (record: JobRecord | undefined): string => `not running (${record?.state ?? 'ended'})`,
  unknown: (): string => 'no such task',
};

/** What a `kill` line may hold. */
const KILL_GRAMMAR = {
  operands: [
    { name: 'task', kind: 'word', repeat: true, summary: 'Each task: /proc/<source>/<id>, <source>/<id>, %N, or its name' },
  ],
} as const satisfies CommandGrammar;

/** What a `wait` line may hold. */
const WAIT_GRAMMAR = {
  operands: [
    { name: 'task', kind: 'word', optional: true, repeat: true, summary: 'Each task, as kill names it; bare, every running task' },
  ],
} as const satisfies CommandGrammar;

/**
 * `kill <task>…`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [killCommand] });
 * ```
 */
export const killCommand = command_declare({
  name: 'kill',
  grammar: KILL_GRAMMAR,
  help: {
    summary: 'Ask a running task to stop',
    description: 'Asks each task to stop: /proc/<source>/<id>, <source>/<id>, a joblet\'s %N, or its name alone when one source has it. Quiet when it is asked, as kill is. The task ends when its current operation does: a cloud job cut short can leave its state locked, so a task is never forced, there is no -9, and a second kill says so instead.',
    category: 'General',
    posix: { group: 'System', differs: 'stops a session task (/proc/<source>/<id>), never a process; asks, never forces' },
    examples: ['kill /proc/steps/trial-build', 'kill trial-build', 'kill %1'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof KILL_GRAMMAR>): Promise<CommandEnvelope> => kill_run(args.operands.task),
});

/**
 * `wait [<task>…]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [waitCommand] });
 * ```
 */
export const waitCommand = command_declare({
  name: 'wait',
  grammar: WAIT_GRAMMAR,
  help: {
    summary: 'Follow a task until it ends',
    description: 'Follows each task\'s log until it ends, then says how it ended; bare, every running task. The status is the tasks\': 0 when all ended done. Ctrl-C stops following and leaves the task running; wait again picks it up.',
    category: 'General',
    posix: { group: 'System', differs: 'waits on session tasks, following each one\'s log' },
    examples: ['wait trial-build', 'wait %1', 'wait'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof WAIT_GRAMMAR>): Promise<CommandEnvelope> => wait_run(args.operands.task),
});

/**
 * `kill` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `kill`.
 * @returns Quiet on success, a line per job that could not be asked, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_kill(['%1']);
 * ```
 */
export async function builtin_kill(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(killCommand, args);
}

/**
 * `wait` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `wait`.
 * @returns Failed when a job did not end done or following was stopped, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_wait(['trial-build']);
 * ```
 */
export async function builtin_wait(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(waitCommand, args);
}

/**
 * Asks each job to stop.
 *
 * @param args - The tasks, as words name them.
 * @returns The envelope: quiet on success, a line per job that could not be asked.
 *
 * @example
 * ```ts
 * await kill_run(['/proc/steps/trial-build']);
 * ```
 */
export async function kill_run(args: readonly string[]): Promise<CommandEnvelope> {
  const runner: JobRunner | null = runner_get();
  if (runner === null) return envelope_error('', undefined, 'kill: this session runs no tasks\n');
  const complaints: string[] = [];
  const stopped: string[] = [];
  for (const word of args) {
    const name: JobName | { error: string } = jobName_resolve(runner, word);
    if ('error' in name) { complaints.push(`kill: ${word}: ${name.error}`); continue; }
    const result: JobStopResult = runner.job_stop(name.source, name.id);
    if (result === 'stopping') { stopped.push(`/proc/${name.source}/${name.id}`); continue; }
    complaints.push(`kill: ${word}: ${STOP_WORDS[result](runner.job_get(name.source, name.id))}`);
  }
  const data: Record<string, unknown> = { stopping: stopped };
  if (complaints.length > 0) return envelope_error('', undefined, `${complaints.join('\n')}\n`);
  return envelope_ok('', { kind: 'tasks.kill', data });
}

/**
 * Follows each job's log until it ends; bare, every running job.
 *
 * @param args - The tasks, as words name them; none for every running one.
 * @returns The envelope: failed when a job did not end done, or following was stopped.
 *
 * @example
 * ```ts
 * await wait_run([]);
 * ```
 */
export async function wait_run(args: readonly string[]): Promise<CommandEnvelope> {
  const runner: JobRunner | null = runner_get();
  if (runner === null) return args.length === 0 ? envelope_ok('') : envelope_error('', undefined, 'wait: this session runs no tasks\n');
  const names: Array<JobName | { error: string; word: string }> = args.length === 0
    ? runner.jobs_list().filter((record: JobRecord): boolean => !taskState_isOver(record.state)).map((record: JobRecord): JobName => ({ source: record.source, id: record.id }))
    : args.map((word: string): JobName | { error: string; word: string } => {
      const name: JobName | { error: string } = jobName_resolve(runner, word);
      return 'error' in name ? { ...name, word } : name;
    });
  commandCancellation_enable();
  const signal: AbortSignal | undefined = commandCancellation_signalGet();
  const complaints: string[] = [];
  const ended: JobRecord[] = [];
  for (const name of names) {
    if ('error' in name) { complaints.push(`wait: ${name.word}: ${name.error}`); continue; }
    if (signal?.aborted === true) break;
    const record: JobRecord | undefined = await runner.job_followAside(name.source, name.id, (line: string): void => sink_dataLine(line), signal);
    if (record === undefined) { complaints.push(`wait: ${name.id}: no such task`); continue; }
    if (!taskState_isOver(record.state)) { complaints.push(`wait: stopped following; /proc/${record.source}/${record.id} goes on`); break; }
    ended.push(record);
    if (record.state !== 'done') complaints.push(`wait: /proc/${record.source}/${record.id}: ${record.state}${record.outcome !== undefined ? ` (${record.outcome})` : ''}`);
  }
  const data: Record<string, unknown> = { ended };
  if (complaints.length > 0) return envelope_error('', undefined, `${complaints.join('\n')}\n`);
  return envelope_ok('', { kind: 'tasks.wait', data });
}
