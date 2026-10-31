/**
 * @file Builtin expect command: a claim the session can refuse.
 *
 * A workflow that only acts is a demonstration. `expect` is what makes one a
 * TEST: it states a claim about the session — what a path holds, and,
 * through the subjects a backend registers, how many things are gathered,
 * what a run's status is, whether a cluster verifies — and refuses, non-zero,
 * when the claim does not hold. Because it is a verb rather than a
 * harness, a workflow asserts wherever it is played: in CI, at an operator's
 * console, or in someone else's browser after they were handed the file.
 *
 * Time lives here and nowhere else. `--within` polls until the claim holds or
 * the deadline passes, which is why no other verb needs a timeout and why the
 * language has no sleep: a sleep asserts nothing and lies about how long the
 * work actually took.
 *
 * The grammar, the polling and the verdict are the core's, and so is `path`
 * (`exists`, `count`). Everything else a claim can be about belongs to a
 * backend's world, and the backend registers it (`Backend.expectSubjects`):
 * this file names no backend.
 *
 * @module
 */
import chalk from 'chalk';
import path from 'path';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { commandArgs_process, ParsedArgs, path_resolve } from '../utils.js';
import { duration_parse } from '../../lib/duration.js';

export { duration_parse };
import { vfs } from '../../lib/vfs/vfs.js';
import type { ListingItem } from '@fnndsc/menu';
import { backendInstalled_get, type ExpectAsk, type ExpectReading, type ExpectSubject } from '../../core/backend.js';
import { commandCancellation_enable, commandCancellation_signalGet } from '../../core/cancellation.js';
import type { Result } from '@fnndsc/fond';
import { exitCode_set } from '../../core/handlerRun.js';

/** The model kind under which a checked claim travels to a surface. */
export const EXPECT_MODEL_KIND: string = 'expect.result';

/** How the two sides of a claim are compared. */
const PREDICATES: ReadonlyArray<string> = [
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'notContains', 'matches',
];


/** Predicates that only mean anything about numbers. */
const NUMERIC_PREDICATES: ReadonlySet<string> = new Set(['gt', 'gte', 'lt', 'lte']);

/** How often a waiting claim asks again. */
const RECHECK_MS: number = 2000;

/** What a claim turned out to be. */
export interface ExpectVerdict {
  /** What was asked about, as the operator wrote it. */
  claim: string;
  /** Whether the claim held. */
  held: boolean;
  /** The value asked for. */
  wanted: string;
  /** The value found; absent when the subject could not be read at all. */
  got: string | null;
  /** Why the subject could not answer, when it could not. */
  refusal?: string;
  /** How long the claim was waited on. */
  waitedMs: number;
}


/**
 * Compares what was found against what was wanted.
 *
 * @param got - The value the session answered.
 * @param predicate - How to compare.
 * @param wanted - The value the claim asked for.
 * @returns Whether the claim holds, or a refusal when the comparison is not meaningful.
 */
export function claim_holds(
  got: string,
  predicate: string,
  wanted: string,
): { held: boolean } | { refusal: string } {
  if (NUMERIC_PREDICATES.has(predicate)) {
    const left: number = Number(got);
    const right: number = Number(wanted);
    if (Number.isNaN(left) || Number.isNaN(right)) {
      return { refusal: `${predicate} compares numbers, and "${Number.isNaN(left) ? got : wanted}" is not one` };
    }
    if (predicate === 'gt') return { held: left > right };
    if (predicate === 'gte') return { held: left >= right };
    if (predicate === 'lt') return { held: left < right };
    return { held: left <= right };
  }

  if (predicate === 'eq' || predicate === 'ne') {
    // A count read back as text and a count written as a number are the same
    // claim: 14 and "14" must not disagree because one came from a table.
    const numeric: boolean = got.trim() !== '' && wanted.trim() !== ''
      && !Number.isNaN(Number(got)) && !Number.isNaN(Number(wanted));
    const same: boolean = numeric ? Number(got) === Number(wanted) : got === wanted;
    return { held: predicate === 'eq' ? same : !same };
  }

  if (predicate === 'contains') return { held: got.includes(wanted) };
  if (predicate === 'notContains') return { held: !got.includes(wanted) };

  try {
    return { held: new RegExp(wanted).test(got) };
  } catch {
    return { refusal: `matches needs a regular expression, and "${wanted}" is not one` };
  }
}


/** How far beneath a named folder a claim will look for what it was asked about. */
export const DEEP_MAX: number = 4;

/**
 * Walks a folder, gathering what it holds and the folders under it.
 *
 * A plugin's output is routinely NESTED — pfdicom writes under
 * `share/incoming/<input tree>`, and a converter mirrors its input — so a
 * claim about what a run produced, made at the node's own folder, would be
 * false about a run that worked perfectly. The walk is bounded: a claim is
 * a question about a result, not a crawl of the filesystem.
 *
 * @param root - Where to start.
 * @param depth - How many levels below the root to visit.
 * @returns Every item found, with the folder each was found in.
 */
export async function folder_walkDeep(root: string, depth: number): Promise<Array<{ folder: string; item: ListingItem }>> {
  const found: Array<{ folder: string; item: ListingItem }> = [];
  const queue: Array<{ path: string; level: number }> = [{ path: root, level: 0 }];

  while (queue.length > 0) {
    const here = queue.shift() as { path: string; level: number };
    const listed: Result<ListingItem[]> = await vfs.data_get(here.path);
    if (!listed.ok) continue;
    for (const item of listed.value) {
      found.push({ folder: here.path, item });
      if (item.type === 'dir' && here.level < depth) {
        queue.push({ path: `${here.path.replace(/\/$/, '')}/${item.name}`, level: here.level + 1 });
      }
    }
  }
  return found;
}

/**
 * Turns a shell-style pattern into a matcher.
 *
 * @param pattern - A glob such as `*.nii*`.
 * @returns A regular expression anchored to the whole name.
 */
function glob_convertToRegExp(pattern: string): RegExp {
  const escaped: string = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/**
 * Answers a claim about a path: whether it is there, and what it holds.
 *
 * @param ask - The claim, as the path subject is asked it.
 * @returns What the path says.
 */
async function path_read(ask: ExpectAsk): Promise<ExpectReading> {
  const resolved: string = await path_resolve(ask.target ?? '');

  if (ask.property === 'exists') {
    const listed: Result<ListingItem[]> = await vfs.data_get(resolved);
    if (listed.ok) return { got: 'true' };
    // A file is not a listing: its parent knows it.
    const parent: Result<ListingItem[]> = await vfs.data_get(path.posix.dirname(resolved));
    if (!parent.ok) return { got: 'false' };
    const leaf: string = path.posix.basename(resolved);
    return { got: `${parent.value.some((item: ListingItem): boolean => item.name === leaf)}` };
  }

  if (ask.deep) {
    const walked: Array<{ folder: string; item: ListingItem }> = await folder_walkDeep(resolved, DEEP_MAX);
    const files: ListingItem[] = walked
      .map((entry): ListingItem => entry.item)
      .filter((item: ListingItem): boolean => item.type !== 'dir');
    if (ask.matching === undefined) return { got: `${files.length}` };
    const deepPattern: RegExp = glob_convertToRegExp(ask.matching);
    return { got: `${files.filter((item: ListingItem): boolean => deepPattern.test(item.name)).length}` };
  }
  const listed: Result<ListingItem[]> = await vfs.data_get(resolved);
  if (!listed.ok) return { got: null, refusal: `${resolved} cannot be listed` };
  if (ask.matching === undefined) return { got: `${listed.value.length}` };
  const pattern: RegExp = glob_convertToRegExp(ask.matching);
  return { got: `${listed.value.filter((item: ListingItem): boolean => pattern.test(item.name)).length}` };
}

/** The core's own subject: a path in the session's filesystem. */
const PATH_SUBJECT: ExpectSubject = { name: 'path', named: true, properties: { exists: 0, count: 0 }, read: path_read };

/** One subject as `expect` sees it: every registration of the name, merged. */
interface SubjectEntry {
  named: boolean;
  /** Each property, with the registration that answers it and the words it takes. */
  properties: Map<string, { words: number; read: (ask: ExpectAsk) => Promise<ExpectReading> }>;
}

/**
 * Every subject this session can make claims about: the core's `path`, then
 * the backend's. Two registrations of one name are one subject, each
 * answering its own properties (ChRIS adds `tags` to `path`).
 *
 * @returns The subjects, by name, in the order they were registered.
 */
export function expectSubjects_get(): Map<string, SubjectEntry> {
  const subjects: Map<string, SubjectEntry> = new Map();
  for (const subject of [PATH_SUBJECT, ...(backendInstalled_get()?.expectSubjects ?? [])]) {
    const entry: SubjectEntry = subjects.get(subject.name) ?? { named: subject.named, properties: new Map() };
    for (const [property, words] of Object.entries(subject.properties)) {
      entry.properties.set(property, { words, read: subject.read });
    }
    subjects.set(subject.name, entry);
  }
  return subjects;
}

/**
 * Sleeps between asks, unless the command is cancelled first.
 *
 * @param ms - How long to wait.
 * @param signal - The foreground command's abort signal.
 * @returns True when the sleep completed.
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
 * Renders a claim the way it was made, for the readout.
 *
 * @param parts - The claim's words.
 * @returns One line.
 */
function claim_render(parts: string[]): string {
  return parts.filter((part: string): boolean => part.length > 0).join(' ');
}

/**
 * Builtin handler for the `expect` command.
 *
 * @param args - Parsed command arguments.
 * @returns An ok envelope when the claim holds, an error envelope when it does not.
 */
export async function builtin_expect(args: string[]): Promise<CommandEnvelope> {
  // `--deep` carries no value: undeclared, the parser hands it the next
  // operand — which is the COMPARISON — and the claim loses its predicate.
  const parsed: ParsedArgs = commandArgs_process(args, { booleanLongOptions: ['deep'] });
  const operands: string[] = parsed._;
  const subject: string | undefined = operands[0];
  const subjects: Map<string, SubjectEntry> = expectSubjects_get();
  const names: string = [...subjects.keys()].join(', ');

  if (subject === undefined) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`Usage: expect <${[...subjects.keys()].join('|')}> [<target>] <property> [<predicate> <value>] [--within <duration>]`)}\n`);
  }

  // The subject is checked FIRST: read as a shape instead, an unknown
  // subject refuses by complaining about whatever word happened to land
  // where a comparison goes, which names the wrong fault.
  const entry: SubjectEntry | undefined = subjects.get(subject);
  if (entry === undefined) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`expect knows nothing about "${subject}" in this session — try ${names}.`)}\n`);
  }

  // A subject that is one thing (`gather`: there is one cohort) names nothing.
  const target: string | undefined = entry.named ? operands[1] : undefined;
  const property: string | undefined = entry.named ? operands[2] : operands[1];
  const rest: string[] = entry.named ? operands.slice(3) : operands.slice(2);
  const properties: string = [...entry.properties.keys()].join(', ');

  if (property === undefined) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`expect ${subject}: say what about it — ${properties}.`)}\n`);
  }
  const answering = entry.properties.get(property);
  if (answering === undefined) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`expect: ${subject} has no property "${property}" — try ${properties}.`)}\n`);
  }
  // A property may take words before the comparison (`tags PatientID`).
  const words: string[] = rest.splice(0, answering.words);

  // `expect path <p> exists` is the claim in full; everything else compares.
  const predicate: string = rest[0] ?? (property === 'exists' ? 'eq' : '');
  const wanted: string = rest[1] ?? (property === 'exists' ? 'true' : '');
  if (predicate === '' || !PREDICATES.includes(predicate)) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`expect: "${predicate}" is not a comparison — use ${PREDICATES.join(', ')}.`)}\n`);
  }

  let deadlineMs: number = 0;
  if (typeof parsed.within === 'string') {
    const parsedWait: number | null = duration_parse(parsed.within);
    if (parsedWait === null) {
      exitCode_set(1);
      return envelope_error('', undefined, `${chalk.red(`expect: --within takes a duration such as 30s, 20m or 2h, not "${parsed.within}".`)}\n`);
    }
    deadlineMs = parsedWait;
  }

  // The claim is printed as it was MADE, narrowing included: a ✓ reading
  // `count gt 0` for a claim that was about `*.nii*` says the wrong thing
  // held, and a battery is read by people who were not there.
  const narrowing: string = matching_get(parsed) === undefined ? '' : `--matching '${matching_get(parsed)}'`;
  const claim: string = claim_render([
    subject, target ?? '', property, ...words, narrowing,
    parsed.deep === true ? '--deep' : '', predicate, wanted,
  ]);
  const started: number = Date.now();
  if (deadlineMs > 0) commandCancellation_enable();
  const signal: AbortSignal | undefined = deadlineMs > 0 ? commandCancellation_signalGet() : undefined;

  const matching: string | undefined = matching_get(parsed);
  let reading: ExpectReading = { got: null };
  let outcome: { held: boolean } | { refusal: string } = { held: false };

  for (;;) {
    reading = await answering.read({
      ...(target !== undefined ? { target } : {}),
      property,
      words,
      ...(matching !== undefined ? { matching } : {}),
      deep: parsed.deep === true,
    });
    if (reading.got !== null) {
      outcome = claim_holds(reading.got, predicate, wanted);
      if ('refusal' in outcome) break;
      if (outcome.held) break;
    }
    const elapsed: number = Date.now() - started;
    if (elapsed >= deadlineMs) break;
    const slept: boolean = await pause_take(Math.min(RECHECK_MS, deadlineMs - elapsed), signal);
    if (!slept) break;
  }

  const waitedMs: number = Date.now() - started;
  const held: boolean = 'held' in outcome && outcome.held && reading.got !== null;
  const refusal: string | undefined = 'refusal' in outcome ? outcome.refusal : reading.refusal;
  const verdict: ExpectVerdict = {
    claim,
    held,
    wanted,
    got: reading.got,
    ...(refusal !== undefined ? { refusal } : {}),
    waitedMs,
  };
  const model = { kind: EXPECT_MODEL_KIND, data: verdict };

  if (held) {
    const took: string = deadlineMs > 0 ? chalk.gray(` (${Math.round(waitedMs / 1000)}s)`) : '';
    return envelope_ok(`${chalk.green('✓')} ${claim}${took}\n`, model);
  }

  exitCode_set(1);
  const lines: string[] = [
    chalk.red(`✗ ${claim}`),
    `    wanted  ${wanted}`,
    `    got     ${reading.got ?? '—'}`,
  ];
  if (refusal !== undefined) lines.push(`    because ${refusal}`);
  if (deadlineMs > 0) lines.push(chalk.gray(`    waited  ${Math.round(waitedMs / 1000)}s of ${Math.round(deadlineMs / 1000)}s`));
  return envelope_error('', undefined, `${lines.join('\n')}\n`, );
}

/**
 * The glob narrowing a count, when one was given.
 *
 * @param parsed - The parsed arguments.
 * @returns The pattern, or undefined.
 */
function matching_get(parsed: ParsedArgs): string | undefined {
  return typeof parsed.matching === 'string' ? parsed.matching : undefined;
}
