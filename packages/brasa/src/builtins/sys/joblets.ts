/**
 * @file `joblets` and `fg`: the shell's verbs over lines run in the
 * background (core/joblets.ts).
 *
 * `joblets` lists them, as a shell's `jobs` does (the word `jobs` is the
 * ChRIS backend's, for plugin instances). `fg %1` brings one to the front:
 * it asks the question the joblet waits on, here, then follows its log
 * until it ends. Ctrl-C stops following, never the joblet; `kill %1` stops
 * it. Declared in one record each (`jobletsCommand`, `fgCommand`): `fg`'s
 * operand is a `job`, which completes from the joblets running.
 *
 * @module
 */
import { envelope_error, envelope_ok, taskState_isOver, type CommandEnvelope } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { runner_get, type JobRecord, type JobRunner } from '../../core/runner.js';
import { commandCancellation_enable, commandCancellation_signalGet } from '../../core/cancellation.js';
import { sink_dataLine } from '../../core/sink.js';
import { surface_get } from '../../core/surface.js';
import { JOBLETS_SOURCE_ID, joblet_isWaiting, jobletQuestion_await, jobletWord_parse, type JobletQuestion } from '../../core/joblets.js';

/**
 * A joblet's state, as `joblets` prints it.
 *
 * @param record - Its record.
 * @returns The word.
 */
function jobletState_word(record: JobRecord): string {
  if (!taskState_isOver(record.state)) return joblet_isWaiting(Number(record.id)) ? 'Waiting for an answer' : 'Running';
  if (record.state === 'done') return 'Done';
  if (record.state === 'cancelled') return 'Stopped';
  const exit: unknown = record.data.exit;
  return record.outcome === 'ended by restart' ? 'Ended by restart' : `Failed (exit ${typeof exit === 'number' ? exit : 1})`;
}

/** What a `joblets` line may hold: nothing. */
const JOBLETS_GRAMMAR = {} as const satisfies CommandGrammar;

/** What an `fg` line may hold. */
const FG_GRAMMAR = {
  operands: [
    { name: 'job', kind: 'job', optional: true, summary: 'The joblet: %N; bare, the most recent' },
  ],
} as const satisfies CommandGrammar;

/**
 * `joblets`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [jobletsCommand] });
 * ```
 */
export const jobletsCommand = command_declare({
  name: 'joblets',
  grammar: JOBLETS_GRAMMAR,
  help: {
    summary: 'List the lines run in the background',
    description: 'Lists every joblet the session keeps, by number: a line ended with & runs as one, at /proc/joblets/<N>, its output in /proc/joblets/<N>/log. Each reads Running, Waiting for an answer, Done, Failed (with its exit status), Stopped, or Ended by restart. A joblet stands where its line was typed and starts with its variables; its own cd and assignments stay inside it. fg %N follows one, kill %N stops one.',
    category: 'General',
    posix: { group: 'Shell', differs: 'is jobs: the word jobs lists CUBE plugin instances' },
    examples: ['pull pacs PatientID:1234 &', 'joblets', 'fg %1', 'kill %1', 'cat /proc/joblets/1/log'],
  },
  holds: [],
  handler: async (): Promise<CommandEnvelope> => joblets_run(),
});

/**
 * `fg [%N]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [fgCommand] });
 * ```
 */
export const fgCommand = command_declare({
  name: 'fg',
  grammar: FG_GRAMMAR,
  help: {
    summary: 'Bring a joblet to the front',
    description: 'Asks the question the joblet waits on here, then follows its log until it ends; bare, the most recent joblet. Any surface of the session may bring any joblet forward. The status is the joblet\'s: 0 when it ended done. Ctrl-C stops following and leaves it running; kill %N stops it.',
    category: 'General',
    posix: { group: 'Shell', differs: 'follows a joblet\'s log; Ctrl-C stops following, not the joblet' },
    examples: ['fg', 'fg %2'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof FG_GRAMMAR>): Promise<CommandEnvelope> => fg_run(args.operands.job),
});

/**
 * `joblets` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `joblets` (none).
 * @returns The listing, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_joblets([]);
 * ```
 */
export async function builtin_joblets(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(jobletsCommand, args);
}

/**
 * `fg` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `fg`.
 * @returns The joblet's status, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_fg(['%1']);
 * ```
 */
export async function builtin_fg(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(fgCommand, args);
}

/**
 * Every joblet the session has kept, by number.
 *
 * @returns The listing.
 *
 * @example
 * ```ts
 * (await joblets_run()).model?.kind; // 'joblets.list'
 * ```
 */
export async function joblets_run(): Promise<CommandEnvelope> {
  const runner: JobRunner | null = runner_get();
  const records: JobRecord[] = (runner?.jobs_list(JOBLETS_SOURCE_ID) ?? [])
    .sort((a: JobRecord, b: JobRecord): number => Number(a.id) - Number(b.id));
  const lines: string[] = records.map((record: JobRecord): string => `[${record.id}]  ${jobletState_word(record).padEnd(22)}  ${record.label}${taskState_isOver(record.state) ? '' : ' &'}`);
  return envelope_ok(lines.length === 0 ? '' : `${lines.join('\n')}\n`, {
    kind: 'joblets.list',
    data: records.map((record: JobRecord) => ({ number: Number(record.id), line: record.label, state: jobletState_word(record), path: `/proc/${JOBLETS_SOURCE_ID}/${record.id}` })),
  });
}

/**
 * Brings a joblet to the front: answers what it waits on here, and follows
 * its log until it ends.
 *
 * @param job - The joblet as a word names it (`%1`), or undefined for the most recent.
 * @returns The joblet's status: 0 when it ended done.
 *
 * @example
 * ```ts
 * await fg_run('%1');
 * ```
 */
export async function fg_run(job: string | undefined): Promise<CommandEnvelope> {
  const word: string = job ?? '%%';
  const runner: JobRunner | null = runner_get();
  const number: number | null = jobletWord_parse(word);
  const record: JobRecord | undefined = number === null || runner === null ? undefined : runner.job_get(JOBLETS_SOURCE_ID, String(number));
  if (runner === null || number === null || record === undefined) return envelope_error('', undefined, `fg: ${word}: no such joblet\n`);
  commandCancellation_enable();
  const signal: AbortSignal | undefined = commandCancellation_signalGet();
  sink_dataLine(record.label);
  const followed: Promise<JobRecord | undefined> = runner.job_followAside(JOBLETS_SOURCE_ID, String(number), (line: string): void => sink_dataLine(line), signal);
  // Its questions are asked here, as they come, until it ends.
  const answering: Promise<void> = (async (): Promise<void> => {
    for (;;) {
      const question: JobletQuestion | null = await jobletQuestion_await(number, followed);
      if (question === null) return;
      try {
        question.answer(await surface_get().prompt(question.request));
      } catch (error: unknown) {
        question.refuse(error instanceof Error ? error : new Error(String(error)));
      }
    }
  })();
  const ended: JobRecord | undefined = await followed;
  await answering;
  if (ended === undefined || !taskState_isOver(ended.state)) {
    return envelope_error('', undefined, `fg: stopped following; %${number} goes on (kill %${number} stops it)\n`);
  }
  if (ended.state === 'done') return envelope_ok('', { kind: 'joblet.ended', data: { ...ended } });
  return envelope_error('', undefined, `fg: %${number}: ${jobletState_word(ended)}${ended.outcome !== undefined && ended.outcome !== 'stopped when asked' ? `: ${ended.outcome}` : ''}\n`);
}
