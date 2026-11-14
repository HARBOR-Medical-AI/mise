/**
 * @file Builtin date.
 *
 * Prints the current date and time, in the spirit of the UNIX `date` command:
 * the default human format, `-u` for UTC, and `+FORMAT` strftime-style format
 * strings. Pure computation — no host `date` binary, no subprocess — so it
 * behaves the same in a local shell, over a CALYPSO daemon, and in the
 * standalone binary. It reports the time only; it never sets the clock.
 * Declared in one record (`dateCommand`).
 *
 * @module
 */
import { CommandEnvelope, envelope_error, envelope_ok } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

const DAYS_LONG: readonly string[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_SHORT: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_LONG: readonly string[] = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT: readonly string[] = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The default output format, matching UNIX `date`: `Sun Jul 13 20:30:00 EDT 2026`. */
const DEFAULT_FORMAT: string = '%a %b %e %H:%M:%S %Z %Y';

/** Composite specifiers, expanded to their component format before the simple pass. */
const COMPOSITE: Record<string, string> = {
  D: '%m/%d/%y',
  F: '%Y-%m-%d',
  T: '%H:%M:%S',
  R: '%H:%M',
  c: '%a %b %e %H:%M:%S %Y',
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** The short timezone name (e.g. `EDT`), or `UTC` in UTC mode. */
function timezone_abbrev(date: Date, utc: boolean): string {
  if (utc) return 'UTC';
  try {
    const parts: Intl.DateTimeFormatPart[] = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(date);
    return parts.find((p: Intl.DateTimeFormatPart) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/** The numeric UTC offset as `+hhmm` / `-hhmm` (`+0000` in UTC mode). */
function timezone_offset(date: Date, utc: boolean): string {
  const minutes: number = utc ? 0 : -date.getTimezoneOffset();
  const sign: string = minutes < 0 ? '-' : '+';
  const abs: number = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`;
}

/** The 1-based day of the year. */
function dayOfYear_compute(year: number, month: number, day: number): number {
  const start: number = Date.UTC(year, 0, 1);
  const current: number = Date.UTC(year, month, day);
  return Math.floor((current - start) / 86_400_000) + 1;
}

/**
 * Formats a date with a strftime-style format string.
 *
 * @param date - The instant to format.
 * @param format - A strftime-style format string (e.g. `%Y-%m-%d`).
 * @param utc - Whether to render in UTC rather than local time.
 * @returns The formatted string.
 */
export function date_format(date: Date, format: string, utc: boolean): string {
  const year: number = utc ? date.getUTCFullYear() : date.getFullYear();
  const month: number = utc ? date.getUTCMonth() : date.getMonth();
  const day: number = utc ? date.getUTCDate() : date.getDate();
  const dow: number = utc ? date.getUTCDay() : date.getDay();
  const hours: number = utc ? date.getUTCHours() : date.getHours();
  const minutes: number = utc ? date.getUTCMinutes() : date.getMinutes();
  const seconds: number = utc ? date.getUTCSeconds() : date.getSeconds();
  const hour12: number = hours % 12 === 0 ? 12 : hours % 12;

  const simple: Record<string, string> = {
    Y: String(year),
    y: pad2(year % 100),
    m: pad2(month + 1),
    d: pad2(day),
    e: String(day).padStart(2, ' '),
    H: pad2(hours),
    I: pad2(hour12),
    M: pad2(minutes),
    S: pad2(seconds),
    p: hours < 12 ? 'AM' : 'PM',
    P: hours < 12 ? 'am' : 'pm',
    A: DAYS_LONG[dow],
    a: DAYS_SHORT[dow],
    B: MONTHS_LONG[month],
    b: MONTHS_SHORT[month],
    h: MONTHS_SHORT[month],
    j: String(dayOfYear_compute(year, month, day)).padStart(3, '0'),
    u: String(dow === 0 ? 7 : dow),
    w: String(dow),
    Z: timezone_abbrev(date, utc),
    z: timezone_offset(date, utc),
    s: String(Math.floor(date.getTime() / 1000)),
    n: '\n',
    t: '\t',
    '%': '%',
  };

  const expanded: string = format.replace(/%[DFTRc]/g, (m: string): string => COMPOSITE[m[1]]);
  return expanded.replace(/%([A-Za-z%])/g, (m: string, code: string): string => (code in simple ? simple[code] : m));
}

/** What a `date` line may hold. */
const DATE_GRAMMAR = {
  operands: [
    { name: 'format', kind: 'word', optional: true, summary: '+ and a strftime-style format (e.g. +%Y-%m-%d, +%H:%M:%S)' },
  ],
  options: {
    utc: { short: 'u', long: 'utc', summary: 'Print (or interpret) time in UTC' },
  },
} as const satisfies CommandGrammar;

/**
 * `date [-u] [+format]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [dateCommand] });
 * ```
 */
export const dateCommand = command_declare({
  name: 'date',
  grammar: DATE_GRAMMAR,
  help: {
    summary: 'Print the current date and time',
    description: 'Prints the current date and time, in the spirit of UNIX date. Use -u for UTC and +FORMAT for a strftime-style format string. Reports the time only; it never sets the clock.',
    category: 'General',
    posix: { group: 'System', differs: 'as date, with its + formats' },
    examples: ['date', 'date -u', 'date +%Y-%m-%d', 'date "+%A, %B %e %Y"'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof DATE_GRAMMAR>): Promise<CommandEnvelope> => date_run(args.operands.format, args.options.utc),
});

/**
 * `date` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `date`.
 * @returns The date, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_date(['-u', '+%Y']);
 * ```
 */
export async function builtin_date(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(dateCommand, args);
}

/**
 * Reports the current date/time as a command envelope: under a `+FORMAT`
 * strftime-style format when one is given, otherwise the default `date` format.
 *
 * @param format - The format, its `+` included, or undefined for the default.
 * @param utc - Whether to report the time in UTC.
 * @returns An envelope carrying the formatted date and an ISO/unix model, or a refusal for a format without its `+`.
 *
 * @example
 * ```ts
 * await date_run('+%Y-%m-%d', true);
 * ```
 */
export async function date_run(format: string | undefined, utc: boolean): Promise<CommandEnvelope> {
  if (format !== undefined && !format.startsWith('+')) {
    exitCode_set(1);
    return envelope_error('', undefined, `date: '${format}': a format starts with +, as +%Y-%m-%d; date never sets the clock\n`);
  }
  const now: Date = new Date();
  const rendered: string = date_format(now, format !== undefined ? format.slice(1) : DEFAULT_FORMAT, utc);
  return envelope_ok(`${rendered}\n`, {
    kind: 'sys.date',
    data: { iso: now.toISOString(), unix: Math.floor(now.getTime() / 1000) },
  });
}
