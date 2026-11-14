/**
 * @file Chimes: `timer`, `leave` and `stopwatch`.
 *
 * A chime is a word said later. The kernel keeps it on a clock and, when
 * the time comes, publishes it on the ambient channel as an envelope of
 * its own — the same road a refreshed listing takes — so every surface on
 * the session hears it: ARGUS notes it in the console and speaks it, a
 * remote chell prints it. Nothing holds the lane while it waits. A chime
 * lives as long as the process: a session's chimes end with it.
 *
 * @module
 */
import chalk from 'chalk';
import { ambient_publish } from '../../core/ambient.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** A chime waiting its turn. */
export interface Chime {
  id: number;
  /** When it sounds, epoch ms. */
  at: number;
  text: string;
  /** What set it. */
  source: 'timer' | 'leave';
}

/** The longest a chime may wait. */
export const CHIME_MAX_MS: number = 24 * 3600 * 1000;

const pending: Map<number, { chime: Chime; handle: NodeJS.Timeout }> = new Map();
let nextId: number = 1;

/** What sounding a chime does; a test hands in its own ear. */
export type ChimeSound = (chime: Chime) => void;

const chime_sound: ChimeSound = (chime: Chime): void => {
  ambient_publish({
    kind: 'envelope',
    envelope: envelope_ok(`${chalk.yellow('🔔')} ${chime.text}\n`, { kind: 'games.chime', data: { id: chime.id, text: chime.text, source: chime.source, at: new Date(chime.at).toISOString() } }),
  });
};

/**
 * Sets a chime.
 *
 * @param delayMs - How long from now.
 * @param text - What it says.
 * @param source - What set it.
 * @param sound - How it sounds (the ambient channel by default).
 * @returns The chime.
 */
export function chime_set(delayMs: number, text: string, source: Chime['source'], sound: ChimeSound = chime_sound): Chime {
  const chime: Chime = { id: nextId++, at: Date.now() + delayMs, text, source };
  const handle: NodeJS.Timeout = setTimeout((): void => {
    pending.delete(chime.id);
    sound(chime);
  }, delayMs);
  // A waiting chime must not hold the process open on its own.
  handle.unref();
  pending.set(chime.id, { chime, handle });
  return chime;
}

/** The chimes still waiting, soonest first. */
export function chimes_list(): Chime[] {
  return [...pending.values()].map((p): Chime => p.chime).sort((a: Chime, b: Chime): number => a.at - b.at);
}

/**
 * Cancels one chime, or every chime of a source, or all of them.
 *
 * @returns How many were cancelled.
 */
export function chimes_cancel(which: number | Chime['source'] | 'all'): number {
  let count: number = 0;
  for (const [id, entry] of pending) {
    if (which === 'all' || which === id || which === entry.chime.source) {
      clearTimeout(entry.handle);
      pending.delete(id);
      count++;
    }
  }
  return count;
}

/**
 * Reads a duration: `90s`, `5m`, `1h30m`, `2:30` (m:ss), `1:00:00`, or a bare number of minutes.
 *
 * @returns Milliseconds, or null when the words are not a duration.
 */
export function duration_parse(text: string): number | null {
  const t: string = text.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t) * 60_000;
  const clock: RegExpMatchArray | null = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(t);
  if (clock !== null) {
    const parts: number[] = [clock[1], clock[2], clock[3]].filter((p): p is string => p !== undefined).map(Number);
    const seconds: number = parts.length === 3 ? (parts[0] as number) * 3600 + (parts[1] as number) * 60 + (parts[2] as number) : (parts[0] as number) * 60 + (parts[1] as number);
    return seconds * 1000;
  }
  const units: RegExpMatchArray | null = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(t);
  if (units === null || units[0] === '') return null;
  const [, h, m, s] = units;
  return Math.round(((Number(h ?? 0)) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)) * 1000);
}

/** A span in words: `1h 05m`, `4m 30s`, `12s`. */
export function span_words(ms: number): string {
  const total: number = Math.max(0, Math.round(ms / 1000));
  const h: number = Math.floor(total / 3600); const m: number = Math.floor((total % 3600) / 60); const s: number = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function chimes_render(): string {
  const list: Chime[] = chimes_list();
  if (list.length === 0) return `${chalk.gray('no chimes waiting')}\n`;
  return list.map((c: Chime): string => `${String(c.id).padStart(3)}  ${c.source.padEnd(5)}  in ${span_words(c.at - Date.now()).padEnd(8)}  ${c.text}`).join('\n') + '\n';
}

/** What a `timer` line may hold: a duration and words, or `cancel`. */
const TIMER_GRAMMAR = {
  operands: [
    { name: 'duration', kind: 'word', optional: true, summary: 'How long: 90s, 5m, 1h30m, 2:30, or a bare number of minutes' },
    { name: 'words', kind: 'word', optional: true, repeat: true, summary: 'What the chime says' },
  ],
  subcommands: {
    cancel: {
      summary: 'End the waiting timers, one by id or all of them',
      operands: [{ name: 'which', kind: 'word', optional: true, summary: 'A chime id, or all (default: every timer)' }],
    },
  },
  bare: { summary: 'Set a chime after a duration, or list the chimes waiting' },
} as const satisfies CommandGrammar;

/**
 * `timer`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [timerCommand] });
 * ```
 */
export const timerCommand = command_declare({
  name: 'timer',
  grammar: TIMER_GRAMMAR,
  help: {
    summary: 'A chime after a while: timer 5m tea',
    description: "Sets a chime for later — 90s, 5m, 1h30m, 2:30, or a bare number of minutes — with the words to say when it sounds. The chime reaches every surface on the session: ARGUS notes it in the console and speaks it, a remote chell prints it. Nothing waits: the console is yours meanwhile. Bare timer lists the chimes waiting; timer cancel ends them. A chime lives as long as the session's process.",
    examples: ['timer 5m tea', 'timer 25m pomodoro over', 'timer 1:30', 'timer', 'timer cancel 2'],
  },
  handler: async (args: CommandArguments<typeof TIMER_GRAMMAR>): Promise<CommandEnvelope> =>
    args.subcommand === 'cancel' ? timerCancel_run(args.operands.which) : timer_run(args.operands.duration, args.operands.words),
});

/**
 * `timer` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `timer`.
 * @returns The chime set or listed, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_timer(['5m', 'tea']);
 * ```
 */
export async function builtin_timer(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(timerCommand, args);
}

/**
 * Ends the waiting timers.
 *
 * @param which - A chime id, `all`, or nothing for every timer.
 * @returns How many were cancelled, or a refusal for a word that is neither an id nor `all`.
 *
 * @example
 * ```ts
 * await timerCancel_run('all');
 * ```
 */
export async function timerCancel_run(which: string | undefined): Promise<CommandEnvelope> {
  const target: number | 'timer' | 'all' = which === undefined ? 'timer' : which === 'all' ? 'all' : Number(which);
  if (typeof target === 'number' && !Number.isInteger(target)) return envelope_error('', undefined, 'timer: cancel wants a chime id, or all\n');
  const n: number = chimes_cancel(target);
  return envelope_ok(`${n} chime${n === 1 ? '' : 's'} cancelled\n`, { kind: 'games.chimes', data: { cancelled: n } });
}

/**
 * Sets a timer, or lists the chimes waiting when no duration is given.
 *
 * @param duration - How long, as `duration_parse` reads it; absent to list.
 * @param words - What the chime says; empty for the default.
 * @returns The chime set or the list, or a refusal for a bad duration.
 *
 * @example
 * ```ts
 * await timer_run('5m', ['tea']);
 * ```
 */
export async function timer_run(duration: string | undefined, words: readonly string[]): Promise<CommandEnvelope> {
  if (duration === undefined) return envelope_ok(chimes_render(), { kind: 'games.chimes', data: { chimes: chimes_list() } });
  const ms: number | null = duration_parse(duration);
  if (ms === null || ms <= 0) return envelope_error('', undefined, `timer: '${duration}' is not a duration (try 90s, 5m, 1h30m, 2:30)\n`);
  if (ms > CHIME_MAX_MS) return envelope_error('', undefined, 'timer: a day is the most a timer waits\n');
  const said: string = words.join(' ') || `timer: ${span_words(ms)} is up`;
  const chime: Chime = chime_set(ms, said, 'timer');
  return envelope_ok(`timer ${chime.id} set: ${span_words(ms)} from now (${new Date(chime.at).toTimeString().slice(0, 8)}) — ${said}\n`, { kind: 'games.chimes', data: { set: chime } });
}

/** Reads `+hhmm` (from now) or `hhmm` (a clock time, today or tomorrow) as a delay. */
export function leave_delay(text: string, now: Date = new Date()): number | null {
  const m: RegExpMatchArray | null = /^(\+)?(\d{1,2}):?(\d{2})$/.exec(text.trim());
  if (m === null) return null;
  const hours: number = Number(m[2]); const minutes: number = Number(m[3]);
  if (minutes > 59 || hours > 23 && m[1] === undefined) return null;
  if (m[1] === '+') return (hours * 60 + minutes) * 60_000;
  const at: Date = new Date(now); at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime() - now.getTime();
}

/** What a `leave` line may hold: a time, or `cancel`. */
const LEAVE_GRAMMAR = {
  operands: [{ name: 'time', kind: 'word', optional: true, summary: '+hhmm from now, or hhmm as a clock time' }],
  subcommands: { cancel: { summary: 'Forget the leave' } },
  bare: { summary: 'Say when you leave, or set it to a time' },
} as const satisfies CommandGrammar;

/**
 * `leave`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [leaveCommand] });
 * ```
 */
export const leaveCommand = command_declare({
  name: 'leave',
  grammar: LEAVE_GRAMMAR,
  help: {
    summary: 'A word when it is time to go home: leave +0030',
    description: "BSD's leave: tell it when you must leave — +hhmm from now, or a clock time — and it says so five minutes before, at the time, and a minute after. Bare leave says when; leave cancel forgets it.",
    examples: ['leave +0030', 'leave 1730', 'leave', 'leave cancel'],
  },
  handler: async (args: CommandArguments<typeof LEAVE_GRAMMAR>): Promise<CommandEnvelope> =>
    args.subcommand === 'cancel' ? leaveCancel_run() : leave_run(args.operands.time),
});

/**
 * `leave` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `leave`.
 * @returns The alarm set, shown or cancelled, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_leave(['+0030']);
 * ```
 */
export async function builtin_leave(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(leaveCommand, args);
}

/**
 * Forgets the leave.
 *
 * @returns How many chimes were cancelled.
 *
 * @example
 * ```ts
 * await leaveCancel_run();
 * ```
 */
export async function leaveCancel_run(): Promise<CommandEnvelope> {
  const n: number = chimes_cancel('leave');
  return envelope_ok(`${n === 0 ? 'no leave was set' : 'leave cancelled'}\n`, { kind: 'games.chimes', data: { cancelled: n } });
}

/**
 * Says when the operator leaves, or sets it to a time.
 *
 * @param time - `+hhmm` or `hhmm`; absent to say when.
 * @returns The alarm, or a refusal for a word that is not a time.
 *
 * @example
 * ```ts
 * await leave_run('1730');
 * ```
 */
export async function leave_run(time: string | undefined): Promise<CommandEnvelope> {
  if (time === undefined) {
    const mine: Chime[] = chimes_list().filter((c: Chime): boolean => c.source === 'leave');
    if (mine.length === 0) return envelope_ok(`${chalk.gray('no leave set (leave +0030, or leave 1730)')}\n`, { kind: 'games.chimes', data: { chimes: [] } });
    const last: Chime = mine[mine.length - 1] as Chime;
    return envelope_ok(`leaving at ${new Date(last.at - 60_000).toTimeString().slice(0, 5)} — in ${span_words(last.at - 60_000 - Date.now())}\n`, { kind: 'games.chimes', data: { chimes: mine } });
  }
  const delay: number | null = leave_delay(time);
  if (delay === null) return envelope_error('', undefined, `leave: '${time}' is not a time (leave +hhmm from now, or leave hhmm)\n`);
  chimes_cancel('leave');
  const at: Date = new Date(Date.now() + delay);
  if (delay > 5 * 60_000) chime_set(delay - 5 * 60_000, 'You have to leave in 5 minutes.', 'leave');
  if (delay > 60_000) chime_set(delay - 60_000, 'Just one more minute!', 'leave');
  chime_set(delay, 'Time to leave!', 'leave');
  chime_set(delay + 60_000, "You're going to be late!", 'leave');
  return envelope_ok(`Alarm set for ${at.toTimeString().slice(0, 5)} (in ${span_words(delay)}).\n`, { kind: 'games.chimes', data: { at: at.toISOString() } });
}

/* ----------------------------------------------------------- stopwatch */

interface Stopwatch { startedAt: number | null; accumulated: number; laps: number[] }
const watch: Stopwatch = { startedAt: null, accumulated: 0, laps: [] };

/** The stopwatch's elapsed time now. */
export function stopwatch_elapsed(now: number = Date.now()): number {
  return watch.accumulated + (watch.startedAt === null ? 0 : now - watch.startedAt);
}

/** Resets the stopwatch (a test's seam, and `stopwatch reset`). */
export function stopwatch_reset(): void {
  watch.startedAt = null; watch.accumulated = 0; watch.laps = [];
}

const clock_words = (ms: number): string => {
  const total: number = Math.floor(ms / 1000);
  const h: number = Math.floor(total / 3600); const m: number = Math.floor((total % 3600) / 60); const s: number = total % 60;
  const tenths: number = Math.floor((ms % 1000) / 100);
  return `${h > 0 ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${tenths}`;
};

/** What a `stopwatch` line may hold: one of its four words, or none to show the time. */
const STOPWATCH_GRAMMAR = {
  subcommands: {
    start: { summary: 'Start the stopwatch, or resume it' },
    stop: { summary: 'Stop it, keeping the time' },
    lap: { summary: 'Mark a lap' },
    reset: { summary: 'Stop it and clear the time and the laps' },
  },
  bare: { summary: 'Show the time and the laps' },
} as const satisfies CommandGrammar;

/**
 * `stopwatch`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [stopwatchCommand] });
 * ```
 */
export const stopwatchCommand = command_declare({
  name: 'stopwatch',
  grammar: STOPWATCH_GRAMMAR,
  help: {
    summary: 'A stopwatch, with laps',
    description: 'One stopwatch per session: start, stop (and start again to resume), lap, reset. Bare stopwatch shows the time and the laps.',
    examples: ['stopwatch start', 'stopwatch lap', 'stopwatch', 'stopwatch stop'],
  },
  handler: async (args: CommandArguments<typeof STOPWATCH_GRAMMAR>): Promise<CommandEnvelope> => stopwatch_run(args.subcommand ?? 'show'),
});

/**
 * `stopwatch` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `stopwatch`.
 * @returns The stopwatch's state, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_stopwatch(['start']);
 * ```
 */
export async function builtin_stopwatch(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(stopwatchCommand, args);
}

/**
 * Does one thing to the session's stopwatch.
 *
 * @param verb - `start`, `stop`, `lap`, `reset`, or `show` for the time.
 * @returns The stopwatch's state, or a refusal for a lap while it is stopped.
 *
 * @example
 * ```ts
 * await stopwatch_run('lap');
 * ```
 */
export async function stopwatch_run(verb: 'start' | 'stop' | 'lap' | 'reset' | 'show'): Promise<CommandEnvelope> {
  const now: number = Date.now();
  const running: boolean = watch.startedAt !== null;
  if (verb === 'start') {
    if (running) return envelope_ok(`already running: ${clock_words(stopwatch_elapsed(now))}\n`, { kind: 'games.stopwatch', data: { elapsedMs: stopwatch_elapsed(now), running } });
    watch.startedAt = now;
    return envelope_ok(`stopwatch started${watch.accumulated > 0 ? ` (resuming at ${clock_words(watch.accumulated)})` : ''}\n`, { kind: 'games.stopwatch', data: { elapsedMs: watch.accumulated, running: true } });
  }
  if (verb === 'stop') {
    if (!running) return envelope_ok(`stopped at ${clock_words(watch.accumulated)}\n`, { kind: 'games.stopwatch', data: { elapsedMs: watch.accumulated, running: false } });
    watch.accumulated += now - (watch.startedAt as number);
    watch.startedAt = null;
    return envelope_ok(`stopped at ${clock_words(watch.accumulated)}\n`, { kind: 'games.stopwatch', data: { elapsedMs: watch.accumulated, running: false } });
  }
  if (verb === 'lap') {
    if (!running) return envelope_error('', undefined, 'stopwatch: not running (stopwatch start)\n');
    const elapsed: number = stopwatch_elapsed(now);
    watch.laps.push(elapsed);
    const previous: number = watch.laps.length > 1 ? (watch.laps[watch.laps.length - 2] as number) : 0;
    return envelope_ok(`lap ${watch.laps.length}: ${clock_words(elapsed - previous)}  (${clock_words(elapsed)} total)\n`, { kind: 'games.stopwatch', data: { elapsedMs: elapsed, laps: watch.laps, running } });
  }
  if (verb === 'reset') {
    stopwatch_reset();
    return envelope_ok('stopwatch reset\n', { kind: 'games.stopwatch', data: { elapsedMs: 0, running: false } });
  }
  const elapsed: number = stopwatch_elapsed(now);
  const laps: string = watch.laps.map((l: number, i: number): string => `  lap ${i + 1}  ${clock_words(l - (watch.laps[i - 1] ?? 0))}`).join('\n');
  return envelope_ok(`${clock_words(elapsed)}${running ? ' (running)' : watch.accumulated > 0 ? ' (stopped)' : ''}\n${laps ? `${laps}\n` : ''}`, { kind: 'games.stopwatch', data: { elapsedMs: elapsed, laps: watch.laps, running } });
}
