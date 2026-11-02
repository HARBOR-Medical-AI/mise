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
 * @module
 */
import chalk from 'chalk';
import { path_resolve } from '../utils.js';
import { duration_parse } from '../../lib/duration.js';
import { recorderMuted_run } from '../../session/recorder.js';
import { session } from '../../session/index.js';
import { sink_dataLine, sink_errLine } from '../../core/sink.js';
import { commandCancellation_enable, commandCancellation_signalGet } from '../../core/cancellation.js';
import { backendInstalled_get, type LineState, type LineStatusProvider } from '../../core/backend.js';
import { exitCode_read, exitCode_set } from '../../core/handlerRun.js';
import { reference_changedBy, reference_isReserved, reference_resolve, unresolvedStands_run, type LinesPassed } from '../../core/expansion.js';
import { pipes_parse } from '../../core/preprocess.js';
import { semicolons_parse } from '../../lib/semicolonParser.js';
import { VARIABLE_NAME, assignment_parse, variable_get, variableScope_run, type Assignment, type Variable } from '../../core/variables.js';
import { shellWords_referencesExpand, shellWords_tokenize, type ReferenceExpansion, type ReferenceValue, type ShellWord } from '../../lib/parser.js';
import { errorStack, type Result } from '@fnndsc/fond';
import { CommandEnvelope, envelope_ok, envelope_error, MANIFEST_STATUS_MODEL_KIND } from '@fnndsc/menu';
import { AsyncLocalStorage } from 'node:async_hooks';

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
 * Reads a manifest, from the backend's filesystem (ChRIS: CFS) or from the
 * engine's own disk.
 *
 * A manifest is a ChRIS file: that is what makes one shareable, and sharing
 * it is `setfacl`, like any other file. But a repository's battery lives
 * beside the code that it tests, and uploading itself before it can run
 * would be a ritual, not a requirement — so a path that names no CFS file
 * is looked for on the host the ENGINE runs on. In a daemon that is the
 * daemon's disk, never the surface's, which is why CFS is asked first.
 *
 * @param target - The manifest, as the operator wrote it.
 * @returns The text and where it came from, or a refusal when neither has it.
 */
async function manifestText_read(target: string): Promise<Result<{ text: string; from: string }>> {
  const resolved: string = await path_resolve(target);
  // Asking CFS is how we find out whether the manifest lives there. The
  // miss is an ANSWER, not a fault: left on the stack it made a play that
  // ran a host-side battery perfectly exit non-zero.
  // The backend's files are asked first (ChRIS: CFS); a backend with no
  // files of its own (stratus) has only the engine's disk.
  const files = backendInstalled_get()?.files;
  if (files !== undefined) {
    const mark: number = errorStack.checkpoint_mark();
    try {
      const bytes: Buffer = await files.read(resolved);
      return { ok: true, value: { text: bytes.toString('utf8'), from: resolved } };
    } catch {
      errorStack.checkpoint_drain(mark);
    }
  }

  try {
    const { readFile } = await import('node:fs/promises');
    const text: string = await readFile(target, 'utf8');
    return { ok: true, value: { text, from: target } };
  } catch {
    return { ok: false };
  }
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
  const parts: string[] = [];
  for (const command of semicolons_parse(text.trim())) {
    const assignment: Assignment | null = assignment_parse(command.trim());
    parts.push(assignment !== null && 'capture' in assignment
      ? `${assignment.name}=$(${await words_preview(assignment.capture, passed)})`
      : await words_preview(command, passed));
  }
  return parts.join('; ');
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
  parseError: string | null;
}

/**
 * Parses `play`'s own arguments.
 *
 * Hand-parsed because `--param` repeats, and a generic parser keeps only the
 * last of a repeated option — which would silently drop every parameter but
 * one and play the manifest with the wrong values.
 *
 * @param args - The tokens after `play`.
 * @returns What was asked for.
 */
export function playArgs_parse(args: string[]): PlayArgs {
  const params: Map<string, string> = new Map();
  let manifest: string | null = null;
  let paceMs: number = 0;
  let dryRun: boolean = false;
  let status: boolean = false;
  let parseError: string | null = null;

  for (let index = 0; index < args.length; index++) {
    const token: string = args[index];
    if (token === '--param') {
      const pair: string | undefined = args[index + 1];
      const equals: number = pair === undefined ? -1 : pair.indexOf('=');
      if (pair === undefined || equals <= 0) {
        parseError = '--param takes NAME=value';
        break;
      }
      params.set(pair.slice(0, equals), pair.slice(equals + 1));
      index++;
    } else if (token === '--pace') {
      // One duration reader for the language: `expect --within` and
      // `play --pace` are the same notion of time, and a second parser
      // beside it is a second set of durations that mean something else.
      const value: string | undefined = args[index + 1];
      const ms: number | null = value === undefined ? null : duration_parse(value);
      if (ms === null || ms < 0) {
        parseError = '--pace takes a duration such as 2s';
        break;
      }
      paceMs = ms;
      index++;
    } else if (token === '--dry-run') {
      dryRun = true;
    } else if (token === '--status') {
      status = true;
    } else if (token === '--step') {
      // A keypress needs a terminal, and the daemon has none. Refusing by
      // name beats pausing forever on a surface that cannot answer.
      parseError = '--step needs a terminal; at a surface, play with --pace';
      break;
    } else if (token.startsWith('--')) {
      parseError = `unknown option ${token}`;
      break;
    } else if (manifest === null) {
      manifest = token;
    } else {
      parseError = `unexpected argument ${token}`;
      break;
    }
  }

  return { manifest, params, paceMs, dryRun, status, parseError };
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
 * Builtin handler for the `play` command.
 *
 * @param args - Parsed command arguments.
 * @returns An envelope carrying what the play did, or the refusal that stopped it.
 */
export async function builtin_play(args: string[]): Promise<CommandEnvelope> {
  const parsed: PlayArgs = playArgs_parse(args);
  if (parsed.parseError !== null) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`play: ${parsed.parseError}`)}\n`);
  }
  if (parsed.manifest === null) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red('Usage: play <manifest> [--param NAME=value]... [--pace <duration>] [--dry-run] [--status]')}\n`);
  }
  if (depth_get() >= NESTING_MAX) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`play: ${parsed.manifest} is nested too deep — a manifest may play a manifest, not a chain of them.`)}\n`);
  }

  const source: Result<{ text: string; from: string }> = await manifestText_read(parsed.manifest);
  if (!source.ok) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`play: cannot read ${parsed.manifest} — no such manifest in the session's filesystem, and none beside the engine.`)}\n`);
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
