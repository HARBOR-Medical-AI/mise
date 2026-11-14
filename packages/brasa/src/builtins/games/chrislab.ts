/**
 * @file The ChRIS lab's toys: `ping`, the round trip to CUBE, and
 * `chrisfetch`, the brain beside the session's facts.
 *
 * @module
 */
import chalk from 'chalk';
import { chrisContext, requestLedger_snapshot, type LedgerSnapshot } from '@fnndsc/cumin';
import { motd_gather } from '../sys/motd.js';
import { surface_get, type SurfacePeer } from '../../core/surface.js';
import { uptime_words } from './lab.js';
import { BRAIN } from './cowsay.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandDeclaration, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** Round trips `ping` makes when not told. */
export const PING_COUNT: number = 3;
/** The most round trips `ping` makes however asked. */
export const PING_MAX: number = 20;
/** How long one round trip may take before it is called lost. */
const PING_TIMEOUT_MS: number = 8_000;

/** One round trip's outcome. */
export interface PingSample { seq: number; ms: number | null; status: number | null }

/** What `ping` uses to reach CUBE; a test hands in its own. */
export type PingFetch = (url: string, init: { method: string; signal: AbortSignal }) => Promise<{ status: number }>;

/**
 * Round-trips to a URL `count` times.
 *
 * @param url - Where.
 * @param count - How many.
 * @param fetchFn - The fetch to use.
 * @param onSample - Told each sample as it lands, for a surface that streams.
 */
export async function ping_run(url: string, count: number, fetchFn: PingFetch, onSample?: (s: PingSample) => void): Promise<PingSample[]> {
  const samples: PingSample[] = [];
  for (let seq: number = 1; seq <= count; seq++) {
    const started: number = performance.now();
    const controller: AbortController = new AbortController();
    const timer: NodeJS.Timeout = setTimeout((): void => controller.abort(), PING_TIMEOUT_MS);
    let sample: PingSample;
    try {
      const response: { status: number } = await fetchFn(url, { method: 'GET', signal: controller.signal });
      sample = { seq, ms: Math.round((performance.now() - started) * 10) / 10, status: response.status };
    } catch {
      sample = { seq, ms: null, status: null };
    } finally {
      clearTimeout(timer);
    }
    samples.push(sample);
    onSample?.(sample);
  }
  return samples;
}

/** The summary line, as ping prints it. */
export function ping_summary(samples: PingSample[]): string {
  const got: number[] = samples.map((s: PingSample): number | null => s.ms).filter((ms: number | null): ms is number => ms !== null);
  const lost: number = samples.length - got.length;
  const loss: string = samples.length === 0 ? '0' : String(Math.round((lost / samples.length) * 100));
  let out: string = `${samples.length} sent, ${got.length} answered, ${loss}% lost`;
  if (got.length > 0) {
    const min: number = Math.min(...got); const max: number = Math.max(...got);
    const avg: number = got.reduce((a: number, b: number): number => a + b, 0) / got.length;
    out += `\nround-trip min/avg/max = ${min}/${avg.toFixed(1)}/${max} ms`;
  }
  return out;
}

/** What a `ping` line may hold: how many round trips, and the one place it pings. */
const PING_GRAMMAR = {
  operands: [{ name: 'target', kind: 'enum', values: ['cube'], optional: true, summary: 'What to ping: only cube' }],
  options: {
    count: { short: 'c', summary: `Round trips to make (default ${PING_COUNT}, at most ${PING_MAX})`, value: { name: 'N', kind: 'int', min: 1 } },
  },
} as const satisfies CommandGrammar;

/** The fetch `ping` uses unless handed another. */
const defaultFetch: PingFetch = (url: string, init: { method: string; signal: AbortSignal }): Promise<{ status: number }> => fetch(url, init);

/**
 * Declares `ping` over a fetch (a test hands in its own).
 *
 * @param fetchFn - The fetch the command round-trips with.
 * @returns The declaration.
 *
 * @example
 * ```ts
 * const command = pingCommand_make(fakeFetch);
 * ```
 */
export function pingCommand_make(fetchFn: PingFetch): CommandDeclaration<typeof PING_GRAMMAR> {
  return command_declare({
    name: 'ping',
    grammar: PING_GRAMMAR,
    help: {
      summary: 'Round trips to CUBE, timed',
      description: "Makes N (3) HTTP round trips to the CUBE this session talks to and times each, then sums up as ping does — and adds the average of this session's own calls to CUBE so far. Only CUBE is pinged from here: a hosted session is not a probe for the network it sits on.",
      examples: ['ping', 'ping -c 10'],
    },
    handler: async (args: CommandArguments<typeof PING_GRAMMAR>): Promise<CommandEnvelope> => ping_command(args.options.count, fetchFn),
  });
}

/**
 * `ping [-c N] [cube]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [pingCommand] });
 * ```
 */
export const pingCommand: CommandDeclaration<typeof PING_GRAMMAR> = pingCommand_make(defaultFetch);

/**
 * `ping` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `ping`.
 * @param fetchFn - The fetch to use.
 * @returns The round trips, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_ping(['-c', '2']);
 * ```
 */
export async function builtin_ping(args: string[], fetchFn: PingFetch = defaultFetch): Promise<CommandEnvelope> {
  return declaredCommand_run(fetchFn === defaultFetch ? pingCommand : pingCommand_make(fetchFn), args);
}

/**
 * Round-trips to the session's CUBE and sums up.
 *
 * @param asked - How many round trips were asked for; absent for the default.
 * @param fetchFn - The fetch to use.
 * @returns The samples and their summary, or a refusal when not connected.
 *
 * @example
 * ```ts
 * await ping_command(3, fetch);
 * ```
 */
export async function ping_command(asked: number | undefined, fetchFn: PingFetch): Promise<CommandEnvelope> {
  const count: number = Math.min(asked ?? PING_COUNT, PING_MAX);
  const url: string | null = await chrisContext.ChRISURL_get();
  if (url === null) return envelope_error('', undefined, 'ping: not connected to a CUBE\n');
  const lines: string[] = [`PING cube (${url})`];
  const samples: PingSample[] = await ping_run(url, count, fetchFn, (s: PingSample): void => {
    lines.push(s.ms === null ? `seq=${s.seq} lost (no answer in ${PING_TIMEOUT_MS / 1000}s)` : `seq=${s.seq} http=${s.status} time=${s.ms} ms`);
  });
  const ledger: LedgerSnapshot = requestLedger_snapshot({ last: 0 });
  const recent: string = ledger.total > 0 ? `\nthis session's own calls: ${ledger.total} to CUBE, ${(ledger.ms / ledger.total).toFixed(0)} ms each on average` : '';
  return envelope_ok(`${lines.join('\n')}\n--- cube ping statistics ---\n${ping_summary(samples)}${recent}\n`, { kind: 'games.ping', data: { url, samples } });
}

/** `chrisfetch` takes nothing. */
const CHRISFETCH_GRAMMAR = {} as const satisfies CommandGrammar;

/**
 * `chrisfetch`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [chrisfetchCommand] });
 * ```
 */
export const chrisfetchCommand = command_declare({
  name: 'chrisfetch',
  grammar: CHRISFETCH_GRAMMAR,
  help: {
    summary: "The brain beside the session's facts, neofetch style",
    description: "Who you are and where, feeds by scope, jobs run and the failure rate, the index's state, the surfaces attached, the uptime — beside the ChRIS brain. All from what the session already holds: no extra calls.",
    examples: ['chrisfetch', 'chrisfetch | lolcat'],
  },
  handler: async (): Promise<CommandEnvelope> => chrisfetch_run(),
});

/**
 * `chrisfetch` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `chrisfetch`: none.
 * @returns The brain beside the facts, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_chrisfetch([]);
 * ```
 */
export async function builtin_chrisfetch(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(chrisfetchCommand, args);
}

/**
 * The brain beside the session's facts, neofetch style.
 *
 * @returns The brain and the facts.
 *
 * @example
 * ```ts
 * await chrisfetch_run();
 * ```
 */
export async function chrisfetch_run(): Promise<CommandEnvelope> {
  const user: string = (await chrisContext.ChRISuser_get()) ?? '?';
  const url: string | null = await chrisContext.ChRISURL_get();
  const host: string = url === null ? '(not connected)' : url.replace(/^https?:\/\//, '').replace(/\/api\/v1\/?$/, '');
  const motd = motd_gather(user, 'chrisfetch');
  const peers: SurfacePeer[] | null = surface_get().peers?.() ?? null;
  const facts: Array<[string, string]> = [
    ['CUBE', host],
    ['Feeds', `${motd.feeds.total} (${motd.feeds.own} own, ${motd.feeds.shared} shared, ${motd.feeds.public} public)`],
    ['Jobs', `${motd.jobs.total.toLocaleString('en-US')} run · ${motd.jobs.running} running · ${motd.jobs.scheduled} scheduled`],
    ['Failed', motd.failureRate === null ? 'none settled yet' : `${(motd.failureRate * 100).toFixed(1)} %`],
    ['Index', motd.index.state === 'current' ? 'whole' : `${motd.index.state} (${motd.index.loaded}/${motd.index.total})`],
    ['Surfaces', peers === null ? 'this terminal' : `${peers.length} attached (${peers.filter((p: SurfacePeer): boolean => p.kind === 'browser').length} browser, ${peers.filter((p: SurfacePeer): boolean => p.kind === 'chell').length} chell)`],
    ['Uptime', uptime_words(process.uptime())],
    ['Node', process.version],
  ];
  const title: string = `${chalk.bold.cyan(user)}@${chalk.bold.cyan(host.split(':')[0] ?? host)}`;
  const right: string[] = [title, chalk.gray('─'.repeat(Math.min(40, user.length + host.length + 1))), ...facts.map(([k, v]: [string, string]): string => `${chalk.cyan(k.padEnd(9))}${v}`)];
  const rows: number = Math.max(BRAIN.length, right.length);
  const lines: string[] = [];
  for (let i: number = 0; i < rows; i++) {
    const left: string = (BRAIN[i] ?? '').padEnd(27);
    lines.push(`${chalk.cyan(left)}  ${right[i] ?? ''}`.trimEnd());
  }
  return envelope_ok(`${lines.join('\n')}\n`, { kind: 'games.chrisfetch', data: { user, cube: url, feeds: motd.feeds, jobs: motd.jobs, failureRate: motd.failureRate, index: motd.index, surfaces: peers, uptimeSeconds: process.uptime() } });
}

