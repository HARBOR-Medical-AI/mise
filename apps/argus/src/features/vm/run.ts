/**
 * @file A machine's build, as one run the VM controller draws: its steps in
 * the order `vm build` takes them, each waiting, under way or done, read from
 * what the line prints, and its outcome once the line ends. `vm build` plans
 * its data, then its machine (two tasks it follows), asks with the cost,
 * applies what changed, and grows a filesystem a bigger disk left ungrown;
 * the screen says where in that it is, so a run never looks idle.
 *
 * Key components:
 * - BuildRun: one build in flight or just ended.
 * - buildRun_start: a run, at the line sent.
 * - buildRun_take: a printed line moves the run.
 * - buildRun_ask, buildRun_answer: the question, and its answer.
 * - buildRun_end: the line's end, its outcome.
 *
 * Typical usage:
 * ```ts
 * let run: BuildRun = buildRun_start('store', 'disk 100 → 150 GB', Date.now());
 * run = buildRun_take(run, 'following /proc/steps/vm-store-plan-data; Ctrl-C …');
 * ```
 *
 * Dependencies: none; the task names are `vm build`'s (/proc/steps/vm-<name>-plan-data, …).
 *
 * @module
 */

/** A step of a build, in the order `vm build` takes them. */
export type BuildPhaseKey = 'plan-data' | 'plan-machine' | 'ask' | 'apply-data' | 'apply-machine' | 'grow';

/** Where one step stands. */
export type BuildPhaseState = 'waiting' | 'going' | 'done' | 'skipped';

/** The steps a build is drawn as, with the words each is drawn with. */
export const BUILD_PHASES: ReadonlyArray<{ readonly key: BuildPhaseKey; readonly label: string }> = [
  { key: 'plan-data', label: 'PLAN DATA' },
  { key: 'plan-machine', label: 'PLAN MACHINE' },
  { key: 'ask', label: 'ASKS' },
  { key: 'apply-data', label: 'APPLY DATA' },
  { key: 'apply-machine', label: 'APPLY MACHINE' },
  { key: 'grow', label: 'GROW' },
];

/** How a run ended. */
export interface BuildOutcome {
  /** done: the change stands; declined: a NO, nothing changed; failed: the session refused or the cloud failed. */
  readonly tone: 'done' | 'declined' | 'failed';
  /** What is said, large. */
  readonly words: string;
  /** When it ended, ISO. */
  readonly at: string;
}

/**
 * One build, in flight or just ended.
 *
 * @example
 * ```ts
 * const run: BuildRun = buildRun_start('store', 'disk 100 → 150 GB', Date.now());
 * ```
 */
export interface BuildRun {
  /** The machine. */
  readonly vm: string;
  /** What the build changes, as offered when BUILD was pressed (`disk 100 → 150 GB`). */
  readonly change: string;
  /** When BUILD was pressed, in ms since the epoch. */
  readonly since: number;
  /** Each step's state. */
  readonly phases: Readonly<Record<BuildPhaseKey, BuildPhaseState>>;
  /** The last line the run printed that says something (a plan's counts, a step's end). */
  readonly said: string;
  /** Set once the line ends. */
  readonly outcome: BuildOutcome | null;
}

/**
 * A run, at the line sent: every step waiting.
 *
 * @param vm - The machine.
 * @param change - What the build changes, in words.
 * @param since - When BUILD was pressed.
 * @returns The run.
 * @example
 * ```ts
 * buildRun_start('store', 'disk 100 → 150 GB', 0).phases['plan-data']; // 'waiting'
 * ```
 */
export function buildRun_start(vm: string, change: string, since: number): BuildRun {
  return { vm, change, since, phases: { 'plan-data': 'waiting', 'plan-machine': 'waiting', ask: 'waiting', 'apply-data': 'waiting', 'apply-machine': 'waiting', grow: 'waiting' }, said: '', outcome: null };
}

/**
 * The step a task is, from its path under /proc/steps.
 *
 * @param vm - The machine.
 * @param line - A printed line.
 * @returns The step a line names (`following /proc/steps/vm-store-plan-data`), or null.
 */
function phase_named(vm: string, line: string): BuildPhaseKey | null {
  const escaped: string = vm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found: RegExpMatchArray | null = line.match(new RegExp(`/proc/steps/vm-${escaped}-(plan-data|plan-machine|apply-data|apply-machine|grow)\\b`));
  return found === null ? null : (found[1] as BuildPhaseKey);
}

/**
 * Moves a step to going; every step before it that went is done, one never
 * started is skipped (a build with nothing to apply to its data skips it).
 *
 * @param run - The run.
 * @param key - The step now under way.
 * @returns The run moved on.
 */
function phase_go(run: BuildRun, key: BuildPhaseKey): BuildRun {
  const at: number = BUILD_PHASES.findIndex((phase): boolean => phase.key === key);
  const phases: Record<BuildPhaseKey, BuildPhaseState> = { ...run.phases };
  BUILD_PHASES.forEach((phase, index: number): void => {
    if (index < at) phases[phase.key] = phases[phase.key] === 'waiting' ? 'skipped' : 'done';
  });
  phases[key] = 'going';
  return { ...run, phases };
}

/**
 * A printed line moves the run: a task followed is its step under way, a
 * plan's counts are what is said.
 *
 * @param run - The run.
 * @param line - The line, as printed (ANSI already stripped).
 * @returns The run moved on, or the same run.
 * @example
 * ```ts
 * buildRun_take(buildRun_start('store', '', 0), 'following /proc/steps/vm-store-plan-machine; …').phases['plan-data']; // 'skipped'
 * ```
 */
export function buildRun_take(run: BuildRun, line: string): BuildRun {
  if (run.outcome !== null) return run;
  const key: BuildPhaseKey | null = phase_named(run.vm, line);
  if (key !== null) return phase_go(run, key);
  const counts: RegExpMatchArray | null = line.match(/\b(data|machine) plan: (.+)$/);
  if (counts !== null) return { ...run, said: `${counts[1]} plan: ${counts[2]}` };
  return run;
}

/**
 * The build's question stands: planning is over.
 *
 * @param run - The run.
 * @returns The run, asking.
 */
export function buildRun_ask(run: BuildRun): BuildRun {
  return run.outcome !== null ? run : phase_go(run, 'ask');
}

/**
 * The question answered.
 *
 * @param run - The run.
 * @param yes - Whether the answer goes on.
 * @returns The run, its question done.
 */
export function buildRun_answer(run: BuildRun, yes: boolean): BuildRun {
  if (run.outcome !== null || run.phases.ask !== 'going') return run;
  return { ...run, phases: { ...run.phases, ask: yes ? 'done' : 'skipped' } };
}

/**
 * The line ended: every step under way is done, and the outcome said.
 *
 * @param run - The run.
 * @param ended - How the line ended: done, declined (a NO) or failed, with why when it failed.
 * @param at - When, ISO.
 * @returns The run, ended.
 * @example
 * ```ts
 * buildRun_end(buildRun_start('store', 'disk 100 → 150 GB', 0), { tone: 'declined', why: '' }, '2026-11-06T21:50:00Z').outcome?.words; // 'STOPPED BEFORE THE APPLY · NOTHING CHANGED'
 * ```
 */
export function buildRun_end(run: BuildRun, ended: { tone: BuildOutcome['tone']; why: string }, at: string): BuildRun {
  const phases: Record<BuildPhaseKey, BuildPhaseState> = { ...run.phases };
  for (const phase of BUILD_PHASES) if (phases[phase.key] === 'going') phases[phase.key] = ended.tone === 'done' ? 'done' : 'skipped';
  const words: string = ended.tone === 'done' ? (run.change === '' ? 'BUILT' : `BUILT · ${run.change.toUpperCase()}`)
    : ended.tone === 'declined' ? 'STOPPED BEFORE THE APPLY · NOTHING CHANGED'
      : `FAILED${ended.why === '' ? '' : ` · ${ended.why}`}`;
  return { ...run, phases, outcome: { tone: ended.tone, words, at } };
}
