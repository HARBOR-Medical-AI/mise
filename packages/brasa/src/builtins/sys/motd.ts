/**
 * @file Builtin motd.
 *
 * The message of the day: the greeting a session gives the operator who
 * has just arrived. A kernel command, so a TTY and a browser say the same
 * thing — who you are, how many feeds you hold, how many jobs have run
 * and how many of them failed, what is running now — from the session's
 * own index, which costs no call. While the index is still warming the
 * greeting says what it holds so far and says so, rather than keeping the
 * operator waiting for a number.
 *
 * A surface may say where the operator has arrived (`motd ARGUS`); the
 * kernel does not know its surfaces by name and should not.
 *
 * @module
 */
import { procCache_get, type ProcFeed, type ProcWarmupProgress, type SingleContext } from '@fnndsc/cumin';
import { context_getSingle } from '@fnndsc/salsa';
import { SESSION_MOTD_MODEL_KIND, type SessionMotd, type MotdIndex, CommandEnvelope, envelope_ok } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { jobsState_derive, type JobsState } from '../../chris/jobsState.js';
import { fortune_random } from './fortune.js';

/** The most lines a greeting's fortune may run to. */
const FORTUNE_LINES_MAX: number = 4;

/**
 * Says a count the way a person reads one.
 *
 * @param n - The count.
 * @returns The count with thousands separated.
 */
function count_say(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Says a failure rate as a percentage with one decimal, or as a whole
 * number when it is one.
 *
 * @param rate - 0..1.
 * @returns The percentage, e.g. `1.3 %`.
 */
function rate_say(rate: number): string {
  const percent: number = rate * 100;
  const text: string = Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
  return `${text} %`;
}

/**
 * Gathers the greeting's facts from the session's own index.
 *
 * @param user - Who arrived.
 * @param surface - Where, as the surface said it; empty for none.
 * @returns The facts.
 */
export function motd_gather(user: string, surface: string): SessionMotd {
  const cache = procCache_get();
  const feeds: ProcFeed[] = cache.feeds_find('');
  const scope = cache.feedScopeCounts_get(user);
  const state: JobsState = jobsState_derive(feeds);
  let finished: number = 0;
  let errored: number = 0;
  let cancelled: number = 0;
  let total: number = 0;
  for (const feed of feeds) {
    finished += feed.finishedJobs;
    errored += feed.erroredJobs;
    cancelled += feed.cancelledJobs;
    total += feed.finishedJobs + feed.erroredJobs + feed.cancelledJobs + feed.startedJobs + feed.scheduledJobs + feed.createdJobs;
  }
  const settled: number = finished + errored;
  const warmup: ProcWarmupProgress = cache.warmupProgress_get();
  const lifecycle: string = cache.lifecycle_get().state;
  const index: MotdIndex = {
    state: lifecycle === 'current' ? 'current' : warmup.active || warmup.loaded > 0 ? 'warming' : 'cold',
    loaded: warmup.loaded,
    total: warmup.total,
  };
  return {
    user,
    surface,
    feeds: { total: scope.total, own: scope.user, shared: scope.shared, public: scope.public },
    jobs: { total, finished, errored, cancelled, running: state.running, scheduled: state.scheduled },
    failureRate: settled > 0 ? errored / settled : null,
    index,
    fortune: fortune_random(FORTUNE_LINES_MAX),
  };
}

/**
 * Renders the greeting.
 *
 * @param motd - The facts.
 * @returns The text, with a trailing newline.
 */
export function motd_render(motd: SessionMotd): string {
  const where: string = motd.surface.length > 0 ? ` to ${motd.surface}` : '';
  const lines: string[] = [`Welcome${where}, ${motd.user}.`];
  const facts: string[] = [];
  if (motd.index.state === 'cold' && motd.feeds.total === 0) {
    facts.push('your index is still cold: the feeds and jobs arrive as it warms');
  } else {
    facts.push(`${count_say(motd.feeds.total)} feed${motd.feeds.total === 1 ? '' : 's'}`);
    const jobsWord: string = motd.index.state === 'current'
      ? `${count_say(motd.jobs.total)} jobs run`
      : motd.index.total > 0
        ? `${count_say(motd.index.loaded)} of ${count_say(motd.index.total)} jobs indexed so far`
        : `${count_say(motd.jobs.total)} jobs indexed so far`;
    facts.push(jobsWord);
    if (motd.failureRate !== null) facts.push(`${rate_say(motd.failureRate)} failed`);
    if (motd.jobs.running > 0 || motd.jobs.scheduled > 0) {
      facts.push(`${count_say(motd.jobs.running)} running, ${count_say(motd.jobs.scheduled)} scheduled`);
    }
  }
  lines.push(facts.join(' · '));
  if (motd.fortune.length > 0) {
    lines.push('');
    lines.push(motd.fortune);
  }
  return `${lines.join('\n')}\n`;
}

/** What a `motd` line may hold: where the operator arrived. */
const MOTD_GRAMMAR = {
  operands: [{ name: 'surface', kind: 'word', optional: true, repeat: true, summary: 'Where you arrived (e.g. ARGUS, chell)' }],
} as const satisfies CommandGrammar;

/**
 * `motd [surface]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [motdCommand] });
 * ```
 */
export const motdCommand = command_declare({
  name: 'motd',
  grammar: MOTD_GRAMMAR,
  help: {
    summary: 'The greeting a session gives on arrival',
    description: "Says who you are, how many feeds you hold, how many jobs have run and what share of them failed, and what is running now — from the session's own index, at no cost. While the index is still warming it says what it holds so far. A surface may name itself (motd ARGUS) and the greeting says where you arrived. Ends with a short fortune.",
    category: 'Games',
    examples: ['motd', 'motd ARGUS'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof MOTD_GRAMMAR>): Promise<CommandEnvelope> => motd_run(args.operands.surface),
});

/**
 * `motd` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `motd`.
 * @returns The greeting, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_motd(['ARGUS']);
 * ```
 */
export async function builtin_motd(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(motdCommand, args);
}

/**
 * Greets the operator.
 *
 * @param surface - The words naming where the operator arrived, e.g. `ARGUS`
 *   or `chell`; they go into the greeting as given.
 * @returns An envelope carrying the greeting and the `session.motd` model.
 *
 * @example
 * ```ts
 * await motd_run(['ARGUS']);
 * ```
 */
export async function motd_run(surface: readonly string[]): Promise<CommandEnvelope> {
  const context: SingleContext = await context_getSingle();
  const user: string = context.user ?? '';
  if (user.length === 0) {
    return envelope_ok('Welcome. You are not connected: connect --user <user> --password <pwd> <url>\n');
  }
  const motd: SessionMotd = motd_gather(user, surface.join(' '));
  return envelope_ok(motd_render(motd), { kind: SESSION_MOTD_MODEL_KIND, data: motd });
}
