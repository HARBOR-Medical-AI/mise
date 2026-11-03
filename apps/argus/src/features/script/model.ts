/**
 * @file The script screen's model (docs/stratus.adoc, D17): a `.mise` script's
 * lines as the rail's steps, each wearing the state `play --status` read for
 * it, and the lines a step's form fills and sends. Pure of the DOM and the
 * wire, so a step's grouping, a line's options and the words a control sends
 * are tested as functions.
 *
 * A step is a line. The rail shows one seat per line (NET NEW, NET BUILD, VM
 * NEW, VM BUILD, CHRIS DEPLOY), except that every `chris user add` line is
 * gathered under one seat, USERS, since a ChRIS's accounts are many lines of
 * one kind.
 *
 * @module
 */
import type { LineStandingModel, LineState, VmCostRate, VmLimitsModel, VmSpecModel } from '@fnndsc/menu';

/** A line of the script, with what `play --status` said of it. */
export interface ScriptLine {
  /** Its place among the script's lines, from one. */
  readonly number: number;
  /** The line as it stands: the file's text, or the form's edit of it. */
  text: string;
  /** Its state, or null when no verb reads it (`echo`). */
  readonly state: LineState | null;
  readonly detail: string;
  /** The task running this line now (`/proc/steps/<id>`), or null: the state is what the records hold, the run is what is happening to them. */
  readonly running: string | null;
}

/** The kinds of step the screen draws a body for. */
export type StepKind = 'net new' | 'net build' | 'vm new' | 'vm build' | 'chris deploy' | 'users' | 'other';

/** One seat on the rail: a line, or the USERS gathering. */
export interface ScriptStep {
  /** The seat's key: `line-3`, or `users`. */
  readonly key: string;
  /** The seat's label: the line's verb and sub-verb (`VM BUILD`), or USERS. */
  readonly label: string;
  readonly kind: StepKind;
  /** The lines under the seat: one, or every user line. */
  readonly lines: ScriptLine[];
  /** The state the seat wears: the lines' together. */
  readonly state: LineState | null;
  /** The task running one of its lines now, or null. */
  readonly running: string | null;
  /** A seat over a line the script does not hold yet (the VM controller's CHRIS before a deploy): RUN appends the line first. */
  readonly template?: boolean;
}

/** A line taken apart: its verb words, its subject and its options. */
export interface LineParts {
  /** The verb and its sub-verbs (`chris user add`). */
  readonly verb: string[];
  /** The first word after the verb that is not an option, or null. */
  readonly subject: string | null;
  /** The options in order, each `--word` with its value (`''` for a bare flag). */
  readonly options: Array<[string, string]>;
}

/** The verbs each step kind begins with, longest first so `chris user add` wins over `chris`. */
const STEP_VERBS: ReadonlyArray<[string, StepKind]> = [
  ['chris user add', 'users'],
  ['chris deploy', 'chris deploy'],
  ['net new', 'net new'],
  ['net build', 'net build'],
  ['vm new', 'vm new'],
  ['vm build', 'vm build'],
];

/** The options a line's words begin with. */
const OPTION_WORD: RegExp = /^--[a-z][a-z0-9-]*$/;

/** The precedence a gathered seat's state takes: what needs the operator first. */
const STATE_RANK: ReadonlyArray<LineState> = ['changed', 'not yet', 'ready', 'done'];

/**
 * Splits a line into words, as a shell would: quotes keep spaces.
 *
 * @param text - The line.
 * @returns Its words, quotes removed.
 */
export function words_split(text: string): string[] {
  const words: string[] = [];
  let word: string = '';
  let quote: string | null = null;
  let open: boolean = false;
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null; else word += char;
      continue;
    }
    if (char === '\'' || char === '"') { quote = char; open = true; continue; }
    if (/\s/.test(char)) {
      if (word !== '' || open) words.push(word);
      word = '';
      open = false;
      continue;
    }
    word += char;
  }
  if (word !== '' || open) words.push(word);
  return words;
}

/**
 * Quotes a word for a line when it needs it.
 *
 * @param word - The word.
 * @returns It, quoted when it holds a space or a quote.
 */
export function word_quote(word: string): string {
  if (word === '') return '\'\'';
  if (!/[\s'"]/.test(word)) return word;
  return `'${word.replace(/'/g, '\'\\\'\'')}'`;
}

/**
 * The kind of step a line is.
 *
 * @param text - The line.
 * @returns Its kind; `other` for a verb the screen has no body for.
 */
export function stepKind_derive(text: string): StepKind {
  const words: string[] = words_split(text);
  for (const [verb, kind] of STEP_VERBS) {
    const parts: string[] = verb.split(' ');
    if (parts.every((part: string, index: number): boolean => words[index] === part)) return kind;
  }
  return 'other';
}

/**
 * Takes a line apart.
 *
 * @param text - The line.
 * @returns Its verb words, subject and options.
 */
export function line_parse(text: string): LineParts {
  const words: string[] = words_split(text);
  const kind: StepKind = stepKind_derive(text);
  const verbLength: number = kind === 'other' ? Math.min(1, words.length) : (STEP_VERBS.find(([, each]): boolean => each === kind)?.[0].split(' ').length ?? 1);
  const verb: string[] = words.slice(0, verbLength);
  let subject: string | null = null;
  const options: Array<[string, string]> = [];
  for (let index: number = verbLength; index < words.length; index++) {
    const word: string = words[index] as string;
    if (OPTION_WORD.test(word)) {
      const next: string | undefined = words[index + 1];
      if (next !== undefined && !OPTION_WORD.test(next)) { options.push([word, next]); index++; } else options.push([word, '']);
    } else if (subject === null) {
      subject = word;
    }
  }
  return { verb, subject, options };
}

/**
 * Puts a line together: the verb, the subject, the options in their order.
 *
 * @param parts - The parts.
 * @returns The line.
 */
export function line_render(parts: LineParts): string {
  const words: string[] = [...parts.verb];
  if (parts.subject !== null) words.push(word_quote(parts.subject));
  for (const [word, value] of parts.options) {
    words.push(word);
    if (value !== '') words.push(word_quote(value));
  }
  return words.join(' ');
}

/**
 * A line with one option set, kept in place when it stands, appended when it
 * does not, and taken away when the value is empty.
 *
 * @param text - The line.
 * @param word - The option (`--memory`).
 * @param value - Its value; `''` removes the option.
 * @returns The line.
 */
export function lineOption_set(text: string, word: string, value: string): string {
  const parts: LineParts = line_parse(text);
  const options: Array<[string, string]> = parts.options.filter(([each]): boolean => each !== word);
  if (value !== '') {
    const at: number = parts.options.findIndex(([each]): boolean => each === word);
    if (at === -1) options.push([word, value]); else options.splice(at, 0, [word, value]);
  }
  return line_render({ ...parts, options });
}

/**
 * One option's value on a line.
 *
 * @param text - The line.
 * @param word - The option.
 * @returns Its value, or null when the line has it not.
 */
export function lineOption_get(text: string, word: string): string | null {
  return line_parse(text).options.find(([each]): boolean => each === word)?.[1] ?? null;
}

/**
 * The state a gathered seat wears: the lines' together, what needs the operator first.
 *
 * @param lines - The lines.
 * @returns Changed over not yet over ready over done; null when none reads.
 */
export function stepState_derive(lines: ReadonlyArray<ScriptLine>): LineState | null {
  for (const state of STATE_RANK) if (lines.some((line: ScriptLine): boolean => line.state === state)) return state;
  return null;
}

/**
 * The seat's label for a line: its verb words, in capitals (`VM BUILD`).
 *
 * @param text - The line.
 * @returns The label.
 */
export function stepLabel_derive(text: string): string {
  const kind: StepKind = stepKind_derive(text);
  if (kind === 'users') return 'USERS';
  if (kind !== 'other') return kind.toUpperCase();
  const words: string[] = words_split(text);
  return words.slice(0, 2).join(' ').toUpperCase() || '—';
}

/**
 * The rail's steps from the script's lines: one per line, the user lines
 * gathered under USERS at the first one's place.
 *
 * @param lines - The lines, in the script's order.
 * @returns The steps, in order.
 */
export function steps_build(lines: ReadonlyArray<ScriptLine>): ScriptStep[] {
  const steps: ScriptStep[] = [];
  let users: ScriptLine[] | null = null;
  for (const line of lines) {
    const kind: StepKind = stepKind_derive(line.text);
    if (kind === 'users') {
      if (users === null) {
        users = [line];
        steps.push({ key: 'users', label: 'USERS', kind, lines: users, state: null, running: null });
      } else {
        users.push(line);
      }
      continue;
    }
    steps.push({ key: `line-${line.number}`, label: stepLabel_derive(line.text), kind, lines: [line], state: line.state, running: line.running });
  }
  return steps.map((step: ScriptStep): ScriptStep => ({ ...step, state: stepState_derive(step.lines), running: step.lines.find((line: ScriptLine): boolean => line.running !== null)?.running ?? null }));
}

/**
 * The step whose line runs now, when one does.
 *
 * @param steps - The steps.
 * @returns The first step with a running task, or undefined.
 */
export function runningStep_find(steps: ReadonlyArray<ScriptStep>): ScriptStep | undefined {
  return steps.find((step: ScriptStep): boolean => step.running !== null);
}

/**
 * Whether a step's line runs as a task (a build, a deploy, a user add): its
 * run outlives the screen, so the screen follows it instead of holding it.
 *
 * @param kind - The step's kind.
 * @returns True for the kinds that start a task.
 */
export function stepKind_isTask(kind: StepKind): boolean {
  return kind === 'net build' || kind === 'vm build' || kind === 'chris deploy' || kind === 'users';
}

/**
 * The script's lines from its text and what `play --status` said: the file's
 * lines that play (not blank, not a comment) matched in order to the
 * standings, so a working copy keeps the file's own words where the status
 * filled references.
 *
 * @param text - The file's text.
 * @param standings - The standings, in the script's order; empty when the status did not answer.
 * @returns The lines.
 */
export function lines_build(text: string, standings: ReadonlyArray<LineStandingModel>): ScriptLine[] {
  const played: string[] = text.split('\n').map((line: string): string => line.trim()).filter((line: string): boolean => line !== '' && !line.startsWith('#'));
  return played.map((line: string, index: number): ScriptLine => {
    const standing: LineStandingModel | undefined = standings[index];
    return { number: index + 1, text: line, state: standing?.state ?? null, detail: standing?.detail ?? '', running: standing?.running ?? null };
  });
}

/** How many lines stand in each state. */
export interface StateCounts {
  readonly done: number;
  readonly ready: number;
  readonly changed: number;
  readonly notYet: number;
  readonly total: number;
}

/**
 * Counts the lines by state.
 *
 * @param lines - The lines.
 * @returns The counts.
 */
export function states_count(lines: ReadonlyArray<ScriptLine>): StateCounts {
  const count = (state: LineState): number => lines.filter((line: ScriptLine): boolean => line.state === state).length;
  return { done: count('done'), ready: count('ready'), changed: count('changed'), notYet: count('not yet'), total: lines.length };
}

/**
 * The counts in a phrase, as `play --status` says them.
 *
 * @param counts - The counts.
 * @returns `5 DONE · 1 READY`, the zero states left out; `NOTHING READ` for none.
 */
export function counts_words(counts: StateCounts): string {
  const parts: string[] = [];
  if (counts.done > 0) parts.push(`${counts.done} DONE`);
  if (counts.ready > 0) parts.push(`${counts.ready} READY`);
  if (counts.changed > 0) parts.push(`${counts.changed} CHANGED`);
  if (counts.notYet > 0) parts.push(`${counts.notYet} NOT YET`);
  return parts.length === 0 ? (counts.total === 0 ? 'NOTHING READ' : `${counts.total} LINES`) : parts.join(' · ');
}

/**
 * A script's name from its path: `store` from `/scripts/chrisproject/store.mise`.
 *
 * @param path - The path.
 * @returns The name.
 */
export function scriptName_derive(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.mise$/, '');
}

/**
 * A script's source from its path: `chrisproject` from `/scripts/chrisproject/store.mise`; `mine` for a working copy.
 *
 * @param path - The path.
 * @returns The source, or `''` for a path outside the library.
 */
export function scriptSource_derive(path: string): string {
  const match: RegExpMatchArray | null = path.match(/^\/scripts\/([^/]+)\//);
  return match?.[1] ?? '';
}

/**
 * Where a script's working copy goes: under `/scripts/mine/`, the one folder written to.
 *
 * @param path - The script.
 * @returns `/scripts/mine/<name>.mise`; the path itself when already there.
 */
export function workingCopy_derive(path: string): string {
  return scriptSource_derive(path) === 'mine' ? path : `/scripts/mine/${scriptName_derive(path)}.mise`;
}

/**
 * The script's text from its lines, one a line, for the working copy.
 *
 * @param lines - The lines.
 * @returns The text, ending in a newline.
 */
export function script_render(lines: ReadonlyArray<ScriptLine>): string {
  return `${lines.map((line: ScriptLine): string => line.text).join('\n')}\n`;
}

/** What a `vm new` line declares, read for the sliders; null where the line says nothing. */
export interface VmNewLevers {
  readonly net: string | null;
  readonly open: string | null;
  readonly vcpu: number | null;
  readonly memory: number | null;
  readonly disk: number | null;
  readonly data: number | null;
  readonly dataBackup: 'daily' | 'none' | null;
  readonly os: string | null;
}

/**
 * Reads a `vm new` line's levers.
 *
 * @param text - The line.
 * @returns Its options as numbers and words.
 */
export function vmLevers_read(text: string): VmNewLevers {
  const number = (word: string): number | null => {
    const value: string | null = lineOption_get(text, word);
    return value === null || value === '' || Number.isNaN(Number(value)) ? null : Number(value);
  };
  const backup: string | null = lineOption_get(text, '--data-backup');
  return {
    net: lineOption_get(text, '--net'), open: lineOption_get(text, '--open'),
    vcpu: number('--vcpu'), memory: number('--memory'), disk: number('--disk'), data: number('--data'),
    dataBackup: backup === 'daily' || backup === 'none' ? backup : null, os: lineOption_get(text, '--os'),
  };
}

/** One slider's ends and step, from `vm limits`. */
export interface SliderSpec {
  readonly word: string;
  readonly label: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/**
 * The sliders VM NEW draws, scaled to what the shape sells; a page draws no
 * end of its own.
 *
 * @param limits - What `vm limits` said.
 * @param ceiling - The most a slider shows (the shape's top is in the thousands; the ends stay the cloud's in the line).
 * @returns The four sliders.
 */
export function vmSliders_build(limits: VmLimitsModel, ceiling: { vcpu: number; memory: number; gb: number } = { vcpu: 64, memory: 512, gb: 2048 }): SliderSpec[] {
  return [
    { word: '--vcpu', label: 'vCPU', unit: '', min: limits.vcpu.min, max: Math.min(limits.vcpu.max, ceiling.vcpu), step: limits.vcpu.step },
    { word: '--memory', label: 'MEMORY', unit: 'GiB', min: limits.memory.min, max: Math.min(limits.memory.max, ceiling.memory), step: 1 },
    { word: '--disk', label: 'DISK', unit: 'GB', min: limits.disk.min, max: Math.min(limits.disk.max, ceiling.gb), step: 10 },
    { word: '--data', label: 'DATA', unit: 'GB', min: limits.data.min, max: Math.min(limits.data.max, ceiling.gb), step: 10 },
  ];
}

/**
 * The memory a vCPU count allows, from the shape's per-vCPU bounds.
 *
 * @param limits - What `vm limits` said.
 * @param vcpu - The vCPUs chosen.
 * @returns The memory's ends for that count.
 */
export function memoryRange_derive(limits: VmLimitsModel, vcpu: number): { min: number; max: number } {
  if (limits.memory.perVcpu === null) return { min: limits.memory.min, max: limits.memory.max };
  return { min: Math.max(limits.memory.min, Math.ceil(vcpu * limits.memory.perVcpu.min)), max: Math.min(limits.memory.max, Math.floor(vcpu * limits.memory.perVcpu.max)) };
}

/**
 * The `vm cost` line that prices a `vm new` line as it stands: the same
 * words, `cost` for `new`.
 *
 * @param text - The `vm new` line.
 * @returns The `vm cost` line.
 */
export function costLine_derive(text: string): string {
  const parts: LineParts = line_parse(text);
  return line_render({ ...parts, verb: ['vm', 'cost'] });
}

/**
 * A cost an hour and a month, in words.
 *
 * @param rate - The rate, or null when not priced.
 * @param hoursPerMonth - The month's hours.
 * @returns `$0.052/H · $37.83 A MONTH`, or NOT PRICED.
 */
export function rate_words(rate: VmCostRate | null, hoursPerMonth: number): string {
  if (rate === null) return 'NOT PRICED';
  const hour: number = rate.machineHour + rate.dataHour;
  return `${money_format(hour, rate.currency, 3)}/H · ${money_format(hour * hoursPerMonth, rate.currency, 2)} A MONTH`;
}

/**
 * Money in the screen's words.
 *
 * @param amount - The amount.
 * @param currency - Its currency.
 * @param digits - Decimal places.
 * @returns `$0.052`, or `EUR 0.052`.
 */
export function money_format(amount: number, currency: string, digits: number): string {
  return `${currency === 'USD' ? '$' : `${currency} `}${amount.toFixed(digits)}`;
}

/**
 * What the declared VMs bill together, from `vm cost` bare.
 *
 * @param rates - Each VM's rate, null where not priced.
 * @returns The sum, or null when none is priced.
 */
export function rates_sum(rates: ReadonlyArray<VmCostRate | null>): VmCostRate | null {
  const priced: VmCostRate[] = rates.filter((rate): rate is VmCostRate => rate !== null);
  if (priced.length === 0) return null;
  return priced.reduce((sum: VmCostRate, rate: VmCostRate): VmCostRate => ({ machineHour: sum.machineHour + rate.machineHour, dataHour: sum.dataHour + rate.dataHour, currency: rate.currency }), { machineHour: 0, dataHour: 0, currency: priced[0]?.currency ?? 'USD' });
}

/**
 * The words a spec is drawn in.
 *
 * @param spec - The spec.
 * @returns `2 vCPU · 8 GiB · disk 50 GB · data 50 GB · daily backups`.
 */
export function spec_words(spec: VmSpecModel): string {
  return `${spec.vcpu} vCPU · ${spec.memory} GiB · disk ${spec.disk} GB · data ${spec.data} GB${spec.dataBackup === 'daily' ? ' · daily backups' : ''}`;
}

/**
 * The `chris user add` line a USERS form fills: the password is asked hidden
 * when the line runs unless a file is named.
 *
 * @param name - The account.
 * @param email - Its address.
 * @param passwordFile - The file holding its password, or `''` to be asked.
 * @param on - The VM, when more than one ChRIS stands; `''` for the only one.
 * @returns The line.
 */
export function userLine_build(name: string, email: string, passwordFile: string, on: string): string {
  const options: Array<[string, string]> = [['--email', email]];
  if (passwordFile !== '') options.push(['--password-file', passwordFile]);
  if (on !== '') options.push(['--on', on]);
  return line_render({ verb: ['chris', 'user', 'add'], subject: name, options });
}

/**
 * The form an engine's question takes, from its words.
 *
 * @param message - The question.
 * @returns Yes or no, a name typed back, a hidden word, or text.
 */
export function askForm_derive(message: string): 'yes-no' | 'name' | 'text' {
  if (/\[y\/N\]|\[Y\/n\]|\(y\/n\)|continue\?/i.test(message)) return 'yes-no';
  if (/type (the|its) name|name typed back|type .* to go on/i.test(message)) return 'name';
  return 'text';
}

/**
 * A duration in the header's words.
 *
 * @param ms - Milliseconds.
 * @returns `4 s`, `3 m 20 s`, `1 h 02 m`.
 */
export function duration_words(ms: number): string {
  const seconds: number = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes: number = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ${String(seconds % 60).padStart(2, '0')} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} m`;
}
