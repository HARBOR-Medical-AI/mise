/**
 * @file Builtin record command: writing a session down as a manifest.
 *
 * Subcommands: start, stop, status. Declared in one record (`recordCommand`).
 *
 * Every verb lowers to a line the operator could have typed, so a session's
 * line history is very nearly a manifest already — a press on a surface and
 * a line at a console arrive at the same place, and the recorder sits there.
 * That is why this costs almost nothing: the lowering was already the law.
 *
 * Key components:
 * - recordCommand: the declaration.
 * - builtin_record: the declaration run over words already split.
 * - identifiers_offer, manifest_render: a recording to a shareable manifest.
 *
 * Typical usage:
 * ```ts
 * await builtin_record(['start', '~/flows/sag.mise']);
 * await builtin_record(['stop']);
 * ```
 *
 * Dependencies: the session's recorder; chili's touch and mkdir to write the file.
 *
 * @module
 */
import chalk from 'chalk';
import { files_touch as chefs_touch_cmd } from '@fnndsc/chili/commands/fs/touch.js';
import { files_mkdir as chefs_mkdir_cmd } from '@fnndsc/chili/commands/fs/mkdir.js';
import path from 'path';
import { path_resolve, storePath_resolve } from '../utils.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import {
  RecorderState,
  recorder_start,
  recorder_state,
  recorder_stop,
} from '../../session/recorder.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';

/** The model kind under which a finished recording travels. */
export const RECORD_MODEL_KIND: string = 'manifest.recorded';

/** What a recording turned into. */
export interface RecordedManifest {
  /** Where it was written. */
  path: string;
  /** How many lines it holds. */
  lines: number;
  /** The parameters it was given, and the literal each replaced. */
  params: Array<{ name: string; was: string }>;
  /** How long the recording ran. */
  elapsedMs: number;
}

/**
 * Literals worth offering as parameters.
 *
 * A recording is personal until its identifiers come out of it: the MRN and
 * the accession are exactly what the next person has to change, and they are
 * the two a PACS line wears on its face. Nothing else is guessed at — a
 * parameter the author did not want is worse than one they have to add.
 */
const IDENTIFIER_PATTERNS: ReadonlyArray<{ criterion: string; param: string }> = [
  { criterion: 'PatientID', param: 'MRN' },
  { criterion: 'AccessionNumber', param: 'ACC' },
  { criterion: 'PatientName', param: 'PATIENT' },
];

/**
 * Offers parameters for the identifiers a recording carries.
 *
 * @param lines - The captured lines.
 * @returns The lines with identifiers replaced, and what was replaced.
 */
export function identifiers_offer(
  lines: string[],
): { lines: string[]; params: Array<{ name: string; was: string }> } {
  const params: Array<{ name: string; was: string }> = [];
  const taken: Map<string, string> = new Map();

  const rewritten: string[] = lines.map((line: string): string => {
    let text: string = line;
    for (const { criterion, param } of IDENTIFIER_PATTERNS) {
      // The value stops at an underscore or a slash: a query's projection
      // folder is `PatientID:1279049_qid:3125_owner`, and a value that ran on
      // to the end of the word would parameterize the query id too, so the
      // same MRN in a path and in a query would read as two patients.
      const pattern: RegExp = new RegExp(`${criterion}:([^\\s'"/_]+)`, 'g');
      text = text.replace(pattern, (match: string, value: string): string => {
        const held: string | undefined = taken.get(match);
        if (held !== undefined) return `${criterion}:\${${held}}`;
        // A second distinct value for the same criterion gets its own name,
        // or a workflow over two patients would collapse into one.
        const name: string = taken.size === 0 || ![...taken.values()].includes(param)
          ? param
          : `${param}_${taken.size + 1}`;
        taken.set(match, name);
        params.push({ name, was: value });
        return `${criterion}:\${${name}}`;
      });
    }
    return text;
  });

  return { lines: rewritten, params };
}

/**
 * Renders the manifest a recording became.
 *
 * @param name - What to call it.
 * @param lines - The captured lines, already parameterized.
 * @param params - The parameters offered.
 * @returns The file's text.
 */
export function manifest_render(
  name: string,
  lines: string[],
  params: Array<{ name: string; was: string }>,
): string {
  const header: string[] = [
    `@name         ${name}`,
    `@description  Recorded from a session on ${new Date().toISOString().slice(0, 10)}.`,
  ];
  for (const param of params) header.push(`@param        ${param.name} = ${param.was}`);
  return `${[...header, '', ...lines].join('\n')}\n`;
}

/** What a `record` line may hold. */
const RECORD_GRAMMAR = {
  bare: { summary: 'Whether anything is recording, and how much (as status)' },
  subcommands: {
    start: {
      summary: 'Begin capturing the lines this session runs',
      operands: [{ name: 'manifest', kind: 'cfsPath', summary: 'The manifest to write when the recording stops' }],
    },
    stop: { summary: 'Write the manifest and say what it holds' },
    status: { summary: 'Whether anything is recording, and how much' },
  },
} as const satisfies CommandGrammar;

/**
 * `record [start <manifest> | stop | status]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [recordCommand] }, 'backend');
 * ```
 */
export const recordCommand = command_declare({
  name: 'record',
  grammar: RECORD_GRAMMAR,
  help: {
    summary: 'Write what this session does down as a manifest',
    description: 'Write what this session does down as a manifest. A recording captures typed lines and the lines a surface mints from a press alike. It never invents expectations: adding `expect` lines is the author\'s act, and the one that turns a recording into a test. Identifiers a PACS line wears on its face (PatientID, AccessionNumber, PatientName) are offered as parameters, so the file is shareable rather than personal.',
    category: 'Workflows',
    examples: [
      'record start ~/flows/sag-cohort.mise',
      '# … do the work, by hand or by pressing …',
      'record stop',
      'play ~/flows/sag-cohort.mise --param MRN=1234567',
    ],
  },
  handler: async (args: CommandArguments<typeof RECORD_GRAMMAR>): Promise<CommandEnvelope> => {
    if (args.subcommand === 'start') return recording_start(args.operands.manifest);
    if (args.subcommand === 'stop') return recording_stop();
    return recording_status();
  },
});

/**
 * `record` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `record`.
 * @returns An envelope reporting what the recorder is doing, or what it wrote; or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_record(['status']);
 * ```
 */
export async function builtin_record(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(recordCommand, args);
}

/**
 * Starts recording to a manifest, unless a recording is already under way.
 *
 * @param target - Where the manifest goes, as typed.
 * @returns An envelope saying where the recording goes, or why it did not start.
 */
async function recording_start(target: string): Promise<CommandEnvelope> {
  const state: RecorderState = recorder_state();
  if (state.target !== null) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`record: already recording to ${state.target} — stop it first.`)}\n`);
  }
  const resolved: string = await path_resolve(target);
  recorder_start(resolved);
  return envelope_ok(`${chalk.green(`record: recording to ${resolved}. Do the work; \`record stop\` writes it.`)}\n`);
}

/**
 * Stops the recording and writes what it captured as a manifest.
 *
 * @returns An envelope saying what was written, with the recorded model; or why nothing was.
 */
async function recording_stop(): Promise<CommandEnvelope> {
  const held = recorder_stop();
  if (held === null) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red('record: nothing is recording.')}\n`);
  }
  if (held.lines.length === 0) {
    return envelope_ok(`${chalk.yellow(`record: nothing to write — the session ran no lines while recording.`)}\n`);
  }

  const { lines, params } = identifiers_offer(held.lines);
  const name: string = path.posix.basename(held.target).replace(/\.[^.]+$/, '');
  // Written where the store keeps it; said as it was named.
  const stored: string = await storePath_resolve(held.target);
  await chefs_mkdir_cmd(path.posix.dirname(stored));
  const written: boolean = await chefs_touch_cmd(stored, {
    withContents: manifest_render(name, lines, params),
  });
  if (!written) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`record: could not write ${held.target}.`)}\n`);
  }

  const recorded: RecordedManifest = {
    path: held.target,
    lines: lines.length,
    params,
    elapsedMs: held.elapsedMs,
  };
  const offered: string = params.length === 0
    ? ''
    : `${chalk.gray(`  offered ${params.length} param${params.length === 1 ? '' : 's'}: `)}${
      params.map((param): string => `${param.was} → \${${param.name}}`).join(', ')}\n`;
  return envelope_ok(
    `${chalk.green(`record: wrote ${held.target} · ${lines.length} line${lines.length === 1 ? '' : 's'}`)}\n${offered}`,
    { kind: RECORD_MODEL_KIND, data: recorded },
  );
}

/**
 * Says whether anything is recording, and how much.
 *
 * @returns An envelope with the recorder's state.
 */
function recording_status(): Promise<CommandEnvelope> {
  const state: RecorderState = recorder_state();
  if (state.target === null) return Promise.resolve(envelope_ok(`${chalk.gray('Nothing is recording.')}\n`));
  return Promise.resolve(envelope_ok(
    `${chalk.green(`Recording to ${state.target}`)} ${chalk.gray(`· ${state.lines} line${state.lines === 1 ? '' : 's'} · ${Math.round(state.elapsedMs / 1000)}s`)}\n`,
  ));
}
