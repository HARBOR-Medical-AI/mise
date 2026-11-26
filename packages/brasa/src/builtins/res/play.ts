/**
 * @file Builtin play command: running a manifest.
 *
 * A manifest is a text file of the lines an operator could have typed. It is
 * not a second language and it has no runtime of its own: `play` reads the
 * file and feeds its lines to the session one at a time, through the same
 * path a typed line takes. That is the whole trick — because every verb
 * lowers to a line and every line's answer is a typed model the surface
 * renders, a manifest played at a surface PLAYS: the PACS pane fills, the
 * cohort's face counts up, a viewer opens. Played headlessly, the same file
 * prints the same envelopes and exits 0 or non-zero. Neither run knows which
 * it is.
 *
 * The file may say what it needs (`@param`), what it is (`@name`) and what it
 * answers (`@answers`), and names what its own lines made (`A=$(…)`).
 * It may not say where anything goes: placement is the surface's judgment,
 * and a manifest that named panes would fork into a browser version and a
 * headless one.
 *
 * Declared in one record (`playCommand`).
 *
 * Key components:
 * - playCommand: the declaration.
 * - builtin_play: the declaration run over words already split.
 * - playArgs_parse: a line's words to the request it makes.
 * - manifest_parse, line_expand: a manifest's text and its lines.
 *
 * Typical usage:
 * ```ts
 * await builtin_play(['~/flows/battery.mise', '--param', 'MRN=1234567']);
 * ```
 *
 * Dependencies: the engine's line path (`line_execute`), the session's
 * variables and filesystem, and the backend's line-status providers.
 *
 * @module
 */
import chalk from 'chalk';
import { duration_parse } from '../../lib/duration.js';
import { recorderMuted_run } from '../../session/recorder.js';
import { session } from '../../session/index.js';
import { sink_dataLine, sink_errLine } from '../../core/sink.js';
import { commandCancellation_enable, commandCancellation_signalGet } from '../../core/cancellation.js';
import { backendInstalled_get, type LineState, type LineStatusProvider } from '../../core/backend.js';
import { exitCode_read, exitCode_set } from '../../core/handlerRun.js';
import { reference_changedBy, reference_isReserved, reference_resolve, unresolvedStands_run, type LinesPassed } from '../../core/expansion.js';
import { pipes_parse } from '../../core/preprocess.js';
import { commandList_parse, semicolons_parse, type ListCommand } from '../../lib/semicolonParser.js';
import { VARIABLE_NAME, assignment_parse, variable_get, variableScope_run, type Assignment, type Variable } from '../../core/variables.js';
import { shellWord_literal, shellWords_referencesExpand, shellWords_tokenize, type ReferenceExpansion, type ReferenceValue, type ShellWord } from '../../lib/parser.js';
import { manifestText_read, type ManifestRead } from './manifestRead.js';
import { CommandEnvelope, envelope_ok, envelope_error, LINE_DECLINED_MODEL_KIND, MANIFEST_STATUS_MODEL_KIND } from '@fnndsc/menu';
import { AsyncLocalStorage } from 'node:async_hooks';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { commandLine_parse, declaredCommand_run, type LineParse } from '../../core/commandParse.js';

/** The model kind under which a played manifest's outcome travels. */
export const PLAY_MODEL_KIND: string = 'manifest.played';

/** The model `play --status` answers with: one row per line. */
export const PLAY_STATUS_KIND: string = MANIFEST_STATUS_MODEL_KIND;

/** One line's standing, as `play --status` reads it. */
export interface LineStanding {
  readonly number: number;
  /** The line as it would run, its references filled. */
  readonly text: string;
  /** Not yet, ready, done or changed; null when no verb reads it. */
  readonly state: LineState | null;
  readonly detail: string;
  /** The task running this line now (`/proc/steps/<id>`); absent when none does. */
  readonly running?: string;
}

/** A manifest may play a manifest; a manifest may not play itself forever. */
const NESTING_MAX: number = 2;

/** How deep the running play is: a line outside any play stands at the top. */
const depthScope: AsyncLocalStorage<number> = new AsyncLocalStorage<number>();

/** The running line's play depth. */
function depth_get(): number {
  return depthScope.getStore() ?? 0;
}

/** One parameter a manifest declares. */
export interface ManifestParam {
  name: string;
  fallback?: string;
}

/** One line of a manifest, with where it came from. */
export interface ManifestLine {
  /** 1-based line number in the file, so a refusal can point at it. */
  number: number;
  text: string;
}

/** A manifest, read. */
export interface Manifest {
  name: string | null;
  description: string | null;
  params: ManifestParam[];
  /** The variable whose model the play answers with (`@answers`), when the manifest names one. */
  answers: string | null;
  lines: ManifestLine[];
}

/** What a play did. */
export interface PlayOutcome {
  manifest: string;
  /** Lines that ran, in order. */
  ran: number;
  /** Lines the file holds. */
  total: number;
  /** The line a refusal stopped on, when one did. */
  stoppedAt: number | null;
  /** How long the play took. */
  elapsedMs: number;
}

/**
 * Reads a manifest.
 *
 * Header directives are collected wherever they appear and take effect
 * before the first line runs, so a file cannot half-declare itself.
 *
 * @param text - The file's content.
 * @returns What the file says, and the lines to run.
 */
export function manifest_parse(text: string): Manifest {
  const params: ManifestParam[] = [];
  const lines: ManifestLine[] = [];
  let name: string | null = null;
  let description: string | null = null;
  let answers: string | null = null;

  const raw: string[] = text.split('\n');
  for (let index = 0; index < raw.length; index++) {
    const line: string = raw[index];
    const trimmed: string = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('@')) {
      const space: number = trimmed.search(/\s/);
      const directive: string = space === -1 ? trimmed : trimmed.slice(0, space);
      const value: string = space === -1 ? '' : trimmed.slice(space + 1).trim();
      if (directive === '@name') name = value;
      else if (directive === '@description') description = value;
      else if (directive === '@answers') answers = value;
      else if (directive === '@param') {
        const equals: number = value.indexOf('=');
        if (equals === -1) params.push({ name: value.trim() });
        else params.push({ name: value.slice(0, equals).trim(), fallback: value.slice(equals + 1).trim() });
      }
      continue;
    }

    lines.push({ number: index + 1, text: trimmed });
  }

  return { name, description, params, answers, lines };
}




/**
 * Sleeps between lines, unless the play is cancelled.
 *
 * @param ms - How long to wait.
 * @param signal - The foreground command's abort signal.
 * @returns True when the pause completed.
 */
async function pause_take(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted === true) return false;
  return await new Promise<boolean>((resolve): void => {
    const onAbort = (): void => { clearTimeout(timer); resolve(false); };
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}


/**
 * Renders one command's words as the kernel would expand them.
 *
 * It expands through the SAME resolver the dispatcher uses, so a dry run
 * cannot disagree with a play; it simply stops before acting. A reference
 * an earlier line may have changed stands as written: the session could
 * answer it, but from the state before the play, which the manifest has
 * since changed.
 *
 * @param text - The command as the manifest holds it.
 * @param passed - What the lines before it could have changed.
 * @returns The command with its references filled in.
 */
async function words_preview(text: string, passed: LinesPassed): Promise<string> {
  const words: ShellWord[] = shellWords_tokenize(text);
  const resolve = async (name: string): Promise<ReferenceValue> => (reference_changedBy(name, passed) ? null : await reference_resolve(name));
  const expanded: ReferenceExpansion = await unresolvedStands_run(
    async (): Promise<ReferenceExpansion> => await shellWords_referencesExpand(words, resolve, true),
  );
  if (!expanded.ok) return text;
  return expanded.words
    .map((word: ShellWord): string => (/\s/.test(word.value) ? `'${word.value}'` : word.value))
    .join(' ');
}

/**
 * Renders a line as the kernel would expand it, without running it.
 *
 * The line is taken apart as the session takes it: a batch at its `;`, and
 * a capture `NAME=$(…)` around the command it holds, which plain words
 * would split through, closing parenthesis and all.
 *
 * @param text - The line as the manifest holds it.
 * @param passed - What the lines before it could have changed.
 * @returns The line with its references filled in.
 */
async function line_preview(text: string, passed: LinesPassed): Promise<string> {
  const JOINERS: Record<ListCommand['when'], string> = { always: '; ', success: ' && ', failure: ' || ' };
  let preview: string = '';
  for (const { command, when } of commandList_parse(text.trim())) {
    const assignment: Assignment | null = assignment_parse(command.trim());
    const part: string = assignment !== null && 'capture' in assignment
      ? `${assignment.name}=$(${await words_preview(assignment.capture, passed)})`
      : await words_preview(command, passed);
    preview += preview === '' ? part : `${JOINERS[when]}${part}`;
  }
  return preview;
}

/**
 * Notes what a line could change, for the lines a dry run previews after
 * it: the verb of every command it holds (each side of a pipe, each part of
 * a batch, the command a capture runs) and the variable it assigns.
 *
 * @param text - The line as the manifest holds it.
 * @param verbs - The verbs seen so far, added to.
 * @param assigned - The variables assigned so far, added to.
 */
function linePassed_note(text: string, verbs: Set<string>, assigned: Set<string>): void {
  for (const command of semicolons_parse(text.trim())) {
    const assignment: Assignment | null = assignment_parse(command.trim());
    if (assignment !== null) assigned.add(assignment.name);
    if (assignment !== null && !('capture' in assignment)) continue;
    const body: string = assignment !== null && 'capture' in assignment ? assignment.capture : command;
    for (const piece of pipes_parse(body)) {
      const words: string[] = shellWords_tokenize(piece).map((word: ShellWord): string => word.value);
      const verb: string | undefined = words[0] === 'sudo' ? words[1] : words[0];
      if (verb !== undefined) verbs.add(verb);
    }
  }
}

/** How a play was asked for. */
interface PlayArgs {
  manifest: string | null;
  params: Map<string, string>;
  paceMs: number;
  dryRun: boolean;
  /** Read each line against what is kept, running none. */
  status: boolean;
  /** The script's text, given in place of the file's (with `--status` only): a surface reads the standing of lines it has not written yet. */
  text: string | null;
  parseError: string | null;
}

/**
 * What a `play` line may hold. `--param` repeats and keeps every value, so
 * no parameter is dropped for the one given after it.
 */
const PLAY_GRAMMAR = {
  operands: [
    { name: 'manifest', kind: 'cfsPath', glob: true, summary: "The manifest: read from the session's filesystem first, the engine's disk second" },
  ],
  options: {
    param: { long: 'param', repeat: true, summary: 'Supply a parameter the manifest declares (repeatable)', value: { name: 'NAME=value', kind: 'word' } },
    pace: { long: 'pace', summary: 'Wait between lines, for watching a play at a surface', value: { name: 'duration', kind: 'word' } },
    dryRun: { long: 'dry-run', summary: 'Expand the lines and show them without running any' },
    status: { long: 'status', summary: 'Run nothing: say where each line stands, from what the backend keeps' },
    text: { long: 'text', summary: "With --status: the script's text, read in place of the file's", value: { name: 'script', kind: 'word' } },
    step: { long: 'step', summary: 'Refused: a keypress needs a terminal; at a surface, play with --pace' },
  },
} as const satisfies CommandGrammar;

/** The typed `play` line. */
type PlayArguments = CommandArguments<typeof PLAY_GRAMMAR>;

/**
 * `play <manifest> [--param NAME=value]… [--pace <duration>] [--dry-run] [--status [--text <script>]]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [playCommand] });
 * ```
 */
export const playCommand = command_declare({
  name: 'play',
  grammar: PLAY_GRAMMAR,
  help: {
    summary: 'Run a manifest: the lines an operator could have typed',
    description: 'Plays a manifest (a script is one): its lines run in order in a scope of their own, each shown as it runs, and the first refused line stops it, non-zero. When it ends, however it ends, the session is back in the directory the play began in, so a manifest that cds into a feed does not leave every surface there. The manifest is read from the session\'s filesystem first and from the engine\'s disk second. --status runs nothing: each line is expanded as a dry run expands it and its verb says, from what the backend keeps and never from the cloud, where it stands (not yet, with what is missing; ready; done; changed, with what changed), one row per line and a count at the end; a verb that keeps nothing reads as a dash. A manifest holds a comment (# …), @name (what this workflow is), @description (one line about it), @param NAME (a parameter it needs) or @param LABEL = draft (one with a default), @answers C (the variable X=$(play f) holds), and any kernel line, C=$(…) naming what a line made. The variables a line may use (${C.field}, ${cwd} …) are in help variables. See docs/manifest.adoc.',
    category: 'Workflows',
    examples: [
      'play ~/flows/battery.mise',
      'play ~/flows/battery.mise --dry-run',
      'play ~/flows/battery.mise --pace 2s',
      'play ~/flows/battery.mise --param MRN=1234567 --param LABEL=draft',
    ],
  },
  handler: async (args: PlayArguments): Promise<CommandEnvelope> => play_run(playRequest_check(args)),
});

/**
 * Checks what the parse cannot: each `--param` is NAME=value, `--pace` is a
 * duration, `--text` comes with `--status`, and `--step` is refused by name.
 *
 * @param args - The typed `play` line.
 * @returns What was asked for, `parseError` set when it cannot be played.
 */
function playRequest_check(args: PlayArguments): PlayArgs {
  const request: PlayArgs = {
    manifest: args.operands.manifest, params: new Map(), paceMs: 0, dryRun: args.options.dryRun,
    status: args.options.status, text: args.options.text ?? null, parseError: null,
  };
  // A keypress needs a terminal, and the daemon has none. Refusing by
  // name beats pausing forever on a surface that cannot answer.
  if (args.options.step) return { ...request, parseError: '--step needs a terminal; at a surface, play with --pace' };
  for (const pair of args.options.param) {
    const equals: number = pair.indexOf('=');
    if (equals <= 0) return { ...request, parseError: '--param takes NAME=value' };
    request.params.set(pair.slice(0, equals), pair.slice(equals + 1));
  }
  if (args.options.pace !== undefined) {
    // One duration reader for the language: `expect --within` and
    // `play --pace` are the same notion of time, and a second parser
    // beside it is a second set of durations that mean something else.
    const ms: number | null = duration_parse(args.options.pace);
    if (ms === null || ms < 0) return { ...request, parseError: '--pace takes a duration such as 2s' };
    request.paceMs = ms;
  }
  // A text given in place of the file is read, never played: what runs is always a file someone can read after.
  if (request.text !== null && !request.status) return { ...request, parseError: '--text reads a script\'s standing only: with --status' };
  return request;
}

/**
 * Reads `play`'s own words as its declaration parses them, with the checks
 * the parse cannot make: the request a line makes, or why it makes none.
 *
 * @param args - The words after `play`, as literals.
 * @returns What was asked for; `parseError` holds a refusal, the parser's or a check's.
 *
 * @example
 * ```ts
 * (await playArgs_parse(['f.mise', '--param', 'MRN=1'])).params.get('MRN'); // '1'
 * ```
 */
export async function playArgs_parse(args: string[]): Promise<PlayArgs> {
  const parsed: LineParse = await commandLine_parse(playCommand, args.map(shellWord_literal));
  if (!parsed.ok) return { manifest: null, params: new Map(), paceMs: 0, dryRun: false, status: false, text: null, parseError: parsed.refusal };
  return playRequest_check(parsed.args as PlayArguments);
}

/** The word a state is shown as, and its colour. */
function state_show(state: LineState | null): string {
  switch (state) {
    case 'done': return chalk.green('done');
    case 'ready': return chalk.cyan('ready');
    case 'changed': return chalk.yellow('changed');
    case 'not yet': return chalk.gray('not yet');
    default: return chalk.gray('—');
  }
}

/**
 * Reads where every line of a manifest stands, running none: each line is
 * expanded as a dry run expands it, then its verb's provider on the backend
 * says not yet, ready, done or changed from what it keeps. A verb without a
 * provider has no state to read.
 *
 * @param manifest - The manifest, read.
 * @param name - What it was asked as, for the summary.
 * @param values - Its parameters.
 * @returns The envelope: one row per line, and the model for a surface.
 */
async function manifestStatus_read(manifest: Manifest, name: string, values: Map<string, string>): Promise<CommandEnvelope> {
  const providers: Map<string, LineStatusProvider> = new Map((backendInstalled_get()?.lineStatuses ?? []).map((provider: LineStatusProvider): [string, LineStatusProvider] => [provider.verb, provider]));
  const standings: LineStanding[] = [];
  const verbs: Set<string> = new Set();
  const assigned: Set<string> = new Set();
  let count: number = 0;
  await variableScope_run(values, async (): Promise<void> => {
    for (const line of manifest.lines) {
      const text: string = await line_preview(line.text, { count, verbs, assigned });
      linePassed_note(line.text, verbs, assigned);
      count += 1;
      const words: string[] = shellWords_tokenize(text).map((word: ShellWord): string => word.value);
      const provider: LineStatusProvider | undefined = words[0] === undefined ? undefined : providers.get(words[0]);
      let standing: LineStanding = { number: line.number, text, state: null, detail: '' };
      if (provider !== undefined) {
        try {
          const read = await provider.read(words);
          if (read !== null) standing = { ...standing, state: read.state, detail: read.detail, ...(read.running === undefined ? {} : { running: read.running }) };
        } catch (error: unknown) {
          standing = { ...standing, detail: error instanceof Error ? error.message : String(error) };
        }
      }
      standings.push(standing);
      const pad: string = ' '.repeat(Math.max(1, 8 - (standing.state ?? '—').length));
      // A line whose task runs now says so after its state: the state is what the records hold, the run is what is happening to them.
      const running: string = standing.running === undefined ? '' : chalk.yellow(`  ▶ running: ${standing.running} (wait ${standing.running} follows it)`);
      sink_dataLine(`${state_show(standing.state)}${pad}${chalk.cyan(`▸ ${text}`)}${standing.detail !== '' ? chalk.gray(`  ${standing.detail}`) : ''}${running}`);
    }
  });
  const counted = (state: LineState): number => standings.filter((standing: LineStanding): boolean => standing.state === state).length;
  const summary: string = `play: ${name}: ${counted('done')} done, ${counted('ready')} ready, ${counted('changed')} changed, ${counted('not yet')} not yet, of ${manifest.lines.length} lines`;
  return envelope_ok(`${summary}\n`, { kind: PLAY_STATUS_KIND, data: { manifest: name, lines: standings } });
}

/**
 * `play` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `play`.
 * @returns An envelope carrying what the play did, or the refusal that stopped it.
 *
 * @example
 * ```ts
 * await builtin_play(['~/flows/battery.mise', '--dry-run']);
 * ```
 */
export async function builtin_play(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(playCommand, args);
}

/**
 * Plays a manifest as asked: reads it, settles its parameters before any
 * line runs, then runs (or, with `--status`, reads) its lines in order.
 *
 * @param parsed - What was asked for.
 * @returns An envelope carrying what the play did, or the refusal that stopped it.
 */
async function play_run(parsed: PlayArgs): Promise<CommandEnvelope> {
  if (parsed.parseError !== null) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`play: ${parsed.parseError}`)}\n`);
  }
  if (parsed.manifest === null) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red('Usage: play <manifest> [--param NAME=value]... [--pace <duration>] [--dry-run] [--status [--text <script>]]')}\n`);
  }
  if (depth_get() >= NESTING_MAX) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`play: ${parsed.manifest} is nested too deep — a manifest may play a manifest, not a chain of them.`)}\n`);
  }

  const source: ManifestRead = parsed.text !== null ? { ok: true, value: { text: parsed.text, from: parsed.manifest } } : await manifestText_read(parsed.manifest);
  if (!source.ok) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`play: ${source.reason}`)}\n`);
  }

  const manifest: Manifest = manifest_parse(source.value.text);

  // A manifest may not take a name the session answers for: shadowing a
  // built-in would make ${gather} mean two things in one language, and a
  // reader of a shared file could not tell which one they were looking at.
  const shadowed: ManifestParam[] = manifest.params.filter(
    (param: ManifestParam): boolean => reference_isReserved(param.name),
  );
  if (shadowed.length > 0) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(
      `play: ${parsed.manifest} declares ${shadowed.map((param: ManifestParam): string => `@param ${param.name}`).join(', ')}, which the session already answers for.`,
    )}\n`);
  }

  // Everything the file needs is settled BEFORE the first line runs: a
  // manifest that gets half way and then asks has already changed the
  // session, and the operator cannot un-ask it.
  const values: Map<string, string> = new Map();
  const missing: string[] = [];
  for (const param of manifest.params) {
    const given: string | undefined = parsed.params.get(param.name);
    if (given !== undefined) values.set(param.name, given);
    else if (param.fallback !== undefined) values.set(param.name, param.fallback);
    else missing.push(param.name);
  }
  for (const [key, value] of parsed.params) values.set(key, value);

  if (manifest.answers !== null && !VARIABLE_NAME.test(manifest.answers)) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`play: ${parsed.manifest} answers '${manifest.answers}', which is not a variable's name.`)}\n`);
  }

  if (missing.length > 0) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(
      `play: ${manifest.name ?? parsed.manifest} needs ${missing.map((name: string): string => `--param ${name}=…`).join(' ')}`,
    )}\n`);
  }

  if (manifest.name !== null) sink_dataLine(chalk.bold(manifest.name));
  if (manifest.description !== null) sink_dataLine(chalk.gray(manifest.description));

  // A status reads every line against what is kept and runs none: the
  // script screen colours its rail from this, and chell reads it as text.
  if (parsed.status) return await manifestStatus_read(manifest, parsed.manifest, values);

  const started: number = Date.now();
  if (parsed.paceMs > 0) commandCancellation_enable();
  const signal: AbortSignal | undefined = parsed.paceMs > 0 ? commandCancellation_signalGet() : undefined;

  const { line_execute } = await import('../../core/engine.js');
  let ran: number = 0;
  let stoppedAt: number | null = null;
  /** Whether the play stopped at the operator's no to a line's question: a choice, answered ok, never an error. */
  let declinedAt: number | null = null;
  // What the manifest answers with, read before its scope ends with it.
  let answered: Variable | undefined;
  // What the lines a dry run passed over could have changed.
  const passedVerbs: Set<string> = new Set();
  const passedAssigned: Set<string> = new Set();

  const exitBeforePlay: number = exitCode_read();
  // Where the play began. A manifest that `cd`s into a feed must not leave a
  // shared session there: every surface on it stands where the play put
  // it. The place is given back however the play ends (#1264).
  const cwdBefore: string = await session.getCWD();
  // What a play runs is already written down in the file it is playing: a
  // recording that captured it too would hold every line twice.
  // The depth and the mute are this play's and its lines': a line another
  // surface runs meanwhile is neither nested nor muted.
  try {
    await depthScope.run(depth_get() + 1, (): Promise<void> => recorderMuted_run((): Promise<void> => variableScope_run(values, async (): Promise<void> => {
    for (const line of manifest.lines) {
      // A dry run shows what WOULD run, expanded by the kernel's own
      // expander rather than a second one living here: a reference nothing
      // can answer yet stands as written, since nothing has run to give it
      // a value, and so does one an earlier line may have changed (#1241).
      if (parsed.dryRun) {
        sink_dataLine(chalk.cyan(`▸ ${await line_preview(line.text, { count: ran, verbs: passedVerbs, assigned: passedAssigned })}`));
        linePassed_note(line.text, passedVerbs, passedAssigned);
        ran += 1;
        continue;
      }

      // The line is SHOWN as written, then handed to the session, which
      // resolves its references the way it resolves every other line's.
      sink_dataLine(chalk.cyan(`▸ ${line.text}`));

      // A line failed when it refused or set the exit status. The status is
      // cleared before each line, so one an earlier command left set (before
      // the play, or by a line that passed) is never this line's.
      exitCode_set(0);
      const envelopes: CommandEnvelope[] = await line_execute(line.text);
      ran += 1;
      // The operator answered no to the line's question: the play stops there, as their choice, never as a refusal.
      if (envelopes.some((envelope: CommandEnvelope): boolean => envelope.model?.kind === LINE_DECLINED_MODEL_KIND)) {
        sink_dataLine(chalk.gray(`play: stopped at your answer to ${parsed.manifest}:${line.number}; the lines after it did not run`));
        declinedAt = line.number;
        break;
      }
      const refused: boolean = envelopes.some((envelope: CommandEnvelope): boolean => envelope.status === 'error')
        || exitCode_read() !== 0;
      if (refused) {
        // A workflow whose first half failed has a second half that is
        // noise: the play stops where the trouble is.
        sink_errLine(chalk.red(`✗ ${parsed.manifest}:${line.number} refused — stopping.`));
        stoppedAt = line.number;
        break;
      }

      if (parsed.paceMs > 0 && !await pause_take(parsed.paceMs, signal)) {
        sink_dataLine(chalk.yellow(`play: stopped at ${parsed.manifest}:${line.number}`));
        stoppedAt = line.number;
        break;
      }
    }
    if (manifest.answers !== null) answered = variable_get(manifest.answers);
    })));
  } finally {
    // A place that cannot be given back (removed during the play) is said,
    // never thrown: the play's own result is what the operator asked for.
    if (!parsed.dryRun && await session.getCWD() !== cwdBefore) {
      try {
        await session.setCWD(cwdBefore);
      } catch (error: unknown) {
        sink_errLine(chalk.yellow(`play: could not go back to ${cwdBefore} (${error instanceof Error ? error.message : String(error)}); the session stays in ${await session.getCWD()}`));
      }
    }
  }

  // A play that ran through leaves the session's status as it found it.
  if (stoppedAt === null) exitCode_set(exitBeforePlay);

  const outcome: PlayOutcome = {
    manifest: parsed.manifest,
    ran,
    total: manifest.lines.length,
    stoppedAt,
    elapsedMs: Date.now() - started,
  };
  const model = { kind: PLAY_MODEL_KIND, data: outcome };
  const took: string = `${Math.round(outcome.elapsedMs / 1000)}s`;

  if (declinedAt !== null) {
    exitCode_set(exitBeforePlay);
    return envelope_ok(`${chalk.gray(`play: ${parsed.manifest} stopped at your answer to line ${declinedAt}, after ${ran} of ${manifest.lines.length} lines (${took})`)}\n`, { kind: LINE_DECLINED_MODEL_KIND, data: { manifest: parsed.manifest, line: declinedAt } });
  }
  if (stoppedAt !== null) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`play: ${parsed.manifest} stopped at line ${stoppedAt} after ${ran} of ${manifest.lines.length} lines (${took})`)}\n`);
  }

  const what: string = parsed.dryRun ? 'would play' : 'played';
  if (parsed.dryRun && manifest.answers !== null) sink_dataLine(chalk.cyan(`▸ @answers ${manifest.answers}`));
  // A manifest that declares its answer hands back that variable's model,
  // so `X=$(play f)` holds what the flow made, as a verb's capture would.
  if (!parsed.dryRun && manifest.answers !== null) {
    if (answered === undefined) {
      exitCode_set(1);
      return envelope_error('', undefined, `${chalk.red(`play: ${parsed.manifest} answers ${manifest.answers}, and ${manifest.answers} was never set`)}\n`);
    }
    return envelope_ok(
      `${chalk.green(`play: ${what} ${ran} line${ran === 1 ? '' : 's'} of ${parsed.manifest} (${took}), answering ${manifest.answers}`)}\n`,
      { kind: answered.answer.kind, data: answered.answer.data },
    );
  }
  return envelope_ok(`${chalk.green(`play: ${what} ${ran} line${ran === 1 ? '' : 's'} of ${parsed.manifest} (${took})`)}\n`, model);
}
