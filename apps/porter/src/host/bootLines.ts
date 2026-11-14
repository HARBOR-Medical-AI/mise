/**
 * @file A session's boot lines as porter's login page shows them: a daemon's
 * own boot rows (chell's boot logger, `[ OK ] …`), whether read off a child's
 * stdout beside porter or relayed from a berth's log by the launcher, each
 * with its attach token taken out, an open row settled in place by its
 * outcome.
 *
 * @module
 */
import type { BootLine, BootListener } from './sessionHost.js';

/** How many lines a boot keeps for a late follower: a daemon writes for as long as it lives. */
export const BOOT_LINES_KEPT: number = 2_000;

/** A boot row as chell prints it: a status tag, then the step's label. */
export interface BootRow {
  /** The step the row is about (`Feeds`, `Queries`, …). */
  label: string;
  /** Whether the row is still open — `[PENDING]` or `[RETRY]` — or settled. */
  open: boolean;
}

/** The tags chell's boot logger prints (bootsequence.ts), colour stripped. */
const BOOT_ROW: RegExp = /^\[\s*(OK|RETRY|SKIP|FAIL|PENDING)\s*\]\s+(\S+)/;

/**
 * Reads a boot line as a status row, or not one.
 *
 * @param text - The line, ANSI and all.
 * @returns The row's label and whether it is still open, or null for a line
 *   that is not a status row (the brain, a box rule, a plain note).
 *
 * @example
 * bootRow_parse('[PENDING] Public  Warming /PUBLIC behind the prompt'); // { label: 'Public', open: true }
 */
export function bootRow_parse(text: string): BootRow | null {
  // eslint-disable-next-line no-control-regex
  const plain: string = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const match: RegExpExecArray | null = BOOT_ROW.exec(plain);
  if (match === null) return null;
  const tag: string = match[1] as string;
  return { label: match[2] as string, open: tag === 'PENDING' || tag === 'RETRY' };
}

/**
 * A boot line with the attach token taken out. A daemon prints its token
 * (`token:`, an ARGUS `?token=` address, an attach line's `--token`) for a
 * terminal; under porter the lines go to a browser's greeter, and the
 * browser never holds the token: the porter does, and adds it on the way
 * to the daemon.
 *
 * @param text - The line, ANSI and all.
 * @returns The line without the token.
 *
 * @example
 * bootLine_redact('    token:     0123456789abcdef0123'); // '    token:     (held by the porter)'
 */
export function bootLine_redact(text: string): string {
  return text
    .replace(/(token:\s+)[0-9a-f]{16,}/g, '$1(held by the porter)')
    .replace(/([?&]token=)[0-9a-f]{16,}/g, '$1…')
    .replace(/(--token\s+)[0-9a-f]{16,}/g, '$1…');
}

/** A boot's lines as a host keeps them, and who follows them. */
export interface BootBook {
  lines: BootLine[];
  /** The next row number. */
  serial: number;
  /** Rows still open (`[PENDING]`, `[RETRY]`), by label, to the row they hold. */
  open: Map<string, number>;
  listeners: Set<BootListener>;
}

/**
 * Notes one line of a daemon's boot: its token taken out, and when it is the
 * outcome of a row printed open, the row settled where it stands, as the
 * boot logger would on a terminal. The kept line takes the new text under
 * the old number, so a late follower sees the settled row once, in its place.
 *
 * @param book - The boot's lines.
 * @param channel - Which stream the line came off.
 * @param raw - The line as the daemon wrote it.
 *
 * @example
 * bootLine_note(book, 'out', '[ OK ]    Public  Cached 9 items from /PUBLIC');
 */
export function bootLine_note(book: BootBook, channel: 'out' | 'err', raw: string): void {
  const text: string = bootLine_redact(raw);
  const row: BootRow | null = bootRow_parse(text);
  const held: number | undefined = row === null ? undefined : book.open.get(row.label);
  if (row !== null && held !== undefined) {
    const kept: BootLine | undefined = book.lines.find((line: BootLine): boolean => line.id === held);
    if (kept !== undefined) { kept.channel = channel; kept.text = text; }
    if (!row.open) book.open.delete(row.label);
    const line: BootLine = { channel, text, id: held, replaces: held };
    for (const listener of book.listeners) listener.line(line);
    return;
  }
  const line: BootLine = { channel, text, id: book.serial++ };
  if (row !== null && row.open) book.open.set(row.label, line.id as number);
  book.lines.push(line);
  // A follower wants the boot, not the year. The earliest lines go first.
  if (book.lines.length > BOOT_LINES_KEPT) book.lines.splice(0, book.lines.length - BOOT_LINES_KEPT);
  for (const listener of book.listeners) listener.line(line);
}
