/**
 * @file Builtin cal.
 *
 * Prints a month or year calendar, in the spirit of the UNIX `cal` command,
 * with today highlighted: `cal` (current month), `cal <year>` (whole year), and
 * `cal <month> <year>`. Pure computation — no host `cal` binary, no subprocess —
 * so it behaves the same in a local shell, over a CALYPSO daemon, and in the
 * standalone binary.
 *
 * @module
 */
import chalk from 'chalk';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

const MONTHS_LONG: readonly string[] = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAY_HEADER: string = 'Su Mo Tu We Th Fr Sa';
/** Visible width of one month block (the weekday header width). */
const BLOCK_WIDTH: number = WEEKDAY_HEADER.length;

/** Today, for highlighting, or null when the rendered month is not the current one. */
interface Today {
  year: number;
  month: number;
  day: number;
}

function center(text: string, width: number): string {
  if (text.length >= width) return text;
  const left: number = Math.floor((width - text.length) / 2);
  return ' '.repeat(left) + text + ' '.repeat(width - text.length - left);
}

/**
 * Renders one month as a list of fixed-width lines: a centered title, the
 * weekday header, and the week rows. Optionally padded to `weekRows` rows so
 * month blocks align in a year grid.
 *
 * @param year - The year.
 * @param month - The 0-based month.
 * @param today - Today's date for highlighting, or null.
 * @param weekRows - Minimum week rows to emit (blank-padded); 0 for no padding.
 * @param titleWithYear - Whether the title includes the year.
 * @returns The month's lines, each {@link BLOCK_WIDTH} visible columns wide.
 */
function month_render(year: number, month: number, today: Today | null, weekRows: number, titleWithYear: boolean): string[] {
  const title: string = titleWithYear ? `${MONTHS_LONG[month]} ${year}` : MONTHS_LONG[month];
  const firstDow: number = new Date(year, month, 1).getDay();
  const daysInMonth: number = new Date(year, month + 1, 0).getDate();

  const cells: string[] = [];
  for (let i = 0; i < firstDow; i++) cells.push('  ');
  for (let d = 1; d <= daysInMonth; d++) {
    const label: string = String(d).padStart(2, ' ');
    const isToday: boolean = today !== null && today.year === year && today.month === month && today.day === d;
    cells.push(isToday ? chalk.inverse(label) : label);
  }
  while (cells.length % 7 !== 0) cells.push('  ');

  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 7) {
    rows.push(cells.slice(i, i + 7).join(' '));
  }
  while (rows.length < weekRows) rows.push(' '.repeat(BLOCK_WIDTH));

  return [center(title, BLOCK_WIDTH), WEEKDAY_HEADER, ...rows];
}

/** Renders a single month with today highlighted where applicable. */
function calendar_month(year: number, month: number, today: Today): string {
  const active: Today | null = today.year === year && today.month === month ? today : null;
  return `${month_render(year, month, active, 0, true).join('\n')}\n`;
}

/** Renders a full year as a 3-across grid of month blocks. */
function calendar_year(year: number, today: Today): string {
  const gap: string = '   ';
  const blocks: string[][] = [];
  for (let m = 0; m < 12; m++) {
    const active: Today | null = today.year === year && today.month === m ? today : null;
    blocks.push(month_render(year, m, active, 6, false));
  }

  const lines: string[] = [center(String(year), BLOCK_WIDTH * 3 + gap.length * 2), ''];
  for (let row = 0; row < 4; row++) {
    const trio: string[][] = [blocks[row * 3], blocks[row * 3 + 1], blocks[row * 3 + 2]];
    const height: number = Math.max(...trio.map((b: string[]) => b.length));
    for (let i = 0; i < height; i++) {
      lines.push(trio.map((b: string[]) => b[i] ?? ' '.repeat(BLOCK_WIDTH)).join(gap).replace(/\s+$/, ''));
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}


/** What a `cal` line may hold. */
const CAL_GRAMMAR = {
  operands: [
    { name: 'month', kind: 'int', optional: true, summary: 'The month, 1 to 12; with no year after it, the year' },
    { name: 'year', kind: 'int', optional: true, summary: 'The year, 1 to 9999' },
  ],
} as const satisfies CommandGrammar;

/**
 * `cal [[month] year]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [calCommand] });
 * ```
 */
export const calCommand = command_declare({
  name: 'cal',
  grammar: CAL_GRAMMAR,
  help: {
    summary: 'Print a calendar',
    description: 'Prints a month or year calendar with today highlighted, in the spirit of UNIX cal.',
    examples: ['cal', 'cal 2026', 'cal 7 2026'],
    category: 'Games',
    posix: { group: 'System', differs: 'as cal' },
  },
  holds: [],
  handler: async (args: CommandArguments<typeof CAL_GRAMMAR>): Promise<CommandEnvelope> =>
    args.operands.year === undefined ? cal_run(undefined, args.operands.month) : cal_run(args.operands.month, args.operands.year),
});

/**
 * `cal` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `cal`.
 * @returns The calendar, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_cal(['7', '2026']);
 * ```
 */
export async function builtin_cal(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(calCommand, args);
}

/**
 * Reports a calendar as a command envelope.
 *
 * With neither, the current month; with a year alone, the whole year; with
 * both, that month.
 *
 * @param month - The month, 1 to 12, or undefined for none.
 * @param year - The year, 1 to 9999, or undefined for none.
 * @returns An envelope carrying the calendar, or an error envelope on a month or year out of range.
 *
 * @example
 * ```ts
 * await cal_run(7, 2026);
 * ```
 */
export async function cal_run(month: number | undefined, year: number | undefined): Promise<CommandEnvelope> {
  const now: Date = new Date();
  const today: Today = { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };

  if (year === undefined) {
    return envelope_ok(calendar_month(today.year, today.month, today), { kind: 'sys.cal', data: { year: today.year, month: today.month + 1 } });
  }
  if (month === undefined) {
    if (year < 1 || year > 9999) return envelope_error(`${chalk.red(`cal: year ${year} out of range (1..9999)`)}\n`);
    return envelope_ok(calendar_year(year, today), { kind: 'sys.cal', data: { year } });
  }
  if (month < 1 || month > 12) return envelope_error(`${chalk.red(`cal: ${month} is not a month number (1..12)`)}\n`);
  if (year < 1 || year > 9999) return envelope_error(`${chalk.red(`cal: year ${year} out of range (1..9999)`)}\n`);
  return envelope_ok(calendar_month(year, month - 1, today), { kind: 'sys.cal', data: { year, month } });
}
