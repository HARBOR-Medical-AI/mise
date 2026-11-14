/**
 * @file The text filters a pipe ends in: `wc`, `head`, `tail`, `sort`,
 * `uniq`, `cut`, run in the kernel.
 *
 * A program in a pipe runs where the surface can run one: a chell on the
 * operator's machine, or a daemon under `--host-control pipes`. A browser
 * runs none, so `find /proc/jobs | wc -l` had nowhere to go. As builtins
 * these run on every surface, and none starts a process anywhere.
 *
 * Each reads what was piped in, else the files named (`-` is the pipe), and
 * takes the POSIX flags most lines use, with their meanings. Each is declared
 * in one record, so a flag it does not take is refused by the parser before
 * it runs; `command wc` skips the builtin and runs the system program.
 *
 * Key components:
 * - wcCommand, headCommand, tailCommand, sortCommand, uniqCommand, cutCommand: the declarations.
 * - builtin_wc … builtin_cut: each declaration run over words already split.
 * - filter_run: reads the sources and answers them, for any filter (grep's files too).
 * - wc_render, head_lines, tail_lines, sort_lines, uniq_lines, cut_lines: the typed cores.
 *
 * Typical usage:
 * ```ts
 * await builtin_wc(['-l', 'notes.txt']);
 * await builtin_head(['-5']);
 * ```
 *
 * Dependencies: the session's filesystem (through the one store-path
 * resolver) and what was piped in.
 *
 * @module
 */
import chalk from 'chalk';
import { envelope_ok, envelope_error, type CommandEnvelope } from '@fnndsc/menu';
import { errno_words, type VfsOutcome } from '@fnndsc/fond';

import { stdin_take } from '../games/stdin.js';
import { vfsDispatcher_get } from '../../core/filesystem.js';
import { storePath_resolve } from '../utils.js';
import { exitCode_set } from '../../core/handlerRun.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/**
 * One text a filter reads: the pipe's, or a file's under its name.
 *
 * @example
 * ```ts
 * const source: FilterSource = { name: 'notes.txt', text: 'a\nb\n' };
 * ```
 */
export interface FilterSource {
  /** The operand as typed; null for the pipe. */
  name: string | null;
  /** What it holds. */
  text: string;
}

/** What a filter's options ask, read and checked, or why not. */
type AskRead<T> = { readonly ask: T } | { readonly refused: string };

/**
 * The file operand every filter but `uniq` takes.
 *
 * @example
 * ```ts
 * const GRAMMAR = { operands: [FILES_OPERAND] } as const satisfies CommandGrammar;
 * ```
 */
export const FILES_OPERAND = {
  name: 'files', kind: 'cfsPath', optional: true, repeat: true, glob: true,
  summary: 'ChRIS files to read, in order (a wildcard matches paths; - is the pipe); the pipe when none is named',
} as const;

/** What the posix pages say of each filter. */
const POSIX_GROUP = 'Text' as const;

/**
 * A whole number from a flag's argument, or null.
 *
 * @param word - The argument.
 * @returns The number, or null when it is not digits.
 */
function count_parse(word: string): number | null {
  return /^\d+$/.test(word) ? Number(word) : null;
}

/**
 * The lines of a text, without the last line's newline.
 *
 * @param text - The text.
 * @returns Its lines; none for the empty text.
 *
 * @example
 * ```ts
 * lines_split('a\nb\n'); // ['a', 'b']
 * ```
 */
export function lines_split(text: string): string[] {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

/**
 * Lines written back as text, each ended by a newline.
 *
 * @param lines - The lines.
 * @returns The text; empty for no lines.
 *
 * @example
 * ```ts
 * lines_join(['a', 'b']); // 'a\nb\n'
 * ```
 */
export function lines_join(lines: ReadonlyArray<string>): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/**
 * A word as a POSIX shell reads it back.
 *
 * @param word - The word.
 * @returns The word, quoted when the shell would read it otherwise.
 *
 * @example
 * ```ts
 * word_quote("it's"); // "'it'\\''s'"
 * ```
 */
export function word_quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * A filter's refusal: said on the error channel, the line's status 1.
 *
 * @param words - What was wrong.
 * @returns The envelope.
 */
function filter_refuse(words: string): CommandEnvelope {
  exitCode_set(1);
  return envelope_error('', undefined, `${words}\n`);
}

/**
 * Reads what a filter works on: the files named, in order (`-` is the
 * pipe), else what was piped in.
 *
 * @param command - The filter's name, for what it says.
 * @param operands - The file operands.
 * @returns The sources and what could not be read, or a refusal when there is nothing at all.
 */
async function sources_read(command: string, operands: ReadonlyArray<string>): Promise<{ sources: FilterSource[]; errors: string } | { refusal: string }> {
  const piped: string | null = stdin_take();
  if (operands.length === 0) {
    if (piped === null) return { refusal: `${command}: nothing to read: pipe text in, or name a file` };
    return { sources: [{ name: null, text: piped }], errors: '' };
  }
  const sources: FilterSource[] = [];
  let errors: string = '';
  for (const operand of operands) {
    if (operand === '-') { sources.push({ name: '-', text: piped ?? '' }); continue; }
    const target: string = await storePath_resolve(operand);
    const read: VfsOutcome<string> = await vfsDispatcher_get().read(target);
    if (read.ok) sources.push({ name: operand, text: read.value });
    else errors += `${command}: ${operand}: ${read.reason ?? errno_words(read.errno)}\n`;
  }
  return { sources, errors };
}

/**
 * Runs a filter: reads its sources and answers them; a file it cannot read
 * is said by name, and the others are still answered.
 *
 * @param command - The filter's name.
 * @param files - The file operands (`-` is the pipe); none for the pipe alone.
 * @param answer - Turns the sources into the filter's output.
 * @returns The envelope: the output, with what could not be read on the error channel.
 *
 * @example
 * ```ts
 * await filter_run('wc', ['notes.txt'], (sources: FilterSource[]): string => wc_render(ask, sources));
 * ```
 */
export async function filter_run(command: string, files: ReadonlyArray<string>, answer: (sources: FilterSource[]) => string): Promise<CommandEnvelope> {
  const read = await sources_read(command, files);
  if ('refusal' in read) return filter_refuse(read.refusal);
  if (read.errors !== '') exitCode_set(1);
  const out: string = read.sources.length > 0 || read.errors === '' ? answer(read.sources) : '';
  return read.errors === '' ? envelope_ok(out) : { ...envelope_ok(out), status: out === '' ? 'error' : 'ok', renderedErr: chalk.red(read.errors) };
}

/**
 * Runs a filter once its options are read: a refusal is said, else the
 * sources are answered.
 *
 * @param command - The filter's name.
 * @param read - What its options ask, or why not.
 * @param files - The file operands.
 * @param answer - Turns what it asks and the sources into its output.
 * @returns The envelope.
 */
async function askedFilter_run<T>(command: string, read: AskRead<T>, files: ReadonlyArray<string>, answer: (ask: T, sources: FilterSource[]) => string): Promise<CommandEnvelope> {
  if ('refused' in read) return filter_refuse(read.refused);
  return filter_run(command, files, (sources: FilterSource[]): string => answer(read.ask, sources));
}

/**
 * Every line of every source, in order.
 *
 * @param sources - The sources.
 * @returns Their lines.
 */
function sourceLines_list(sources: ReadonlyArray<FilterSource>): string[] {
  return sources.flatMap((s: FilterSource): string[] => lines_split(s.text));
}

// ── wc ───────────────────────────────────────────────────────────────────────

/**
 * What `wc` counts.
 *
 * @example
 * ```ts
 * const ask: WcAsk = { lines: true, words: false, bytes: false, chars: false };
 * ```
 */
export interface WcAsk {
  /** Newlines. */
  lines: boolean;
  /** Words between blanks. */
  words: boolean;
  /** Bytes. */
  bytes: boolean;
  /** Characters. */
  chars: boolean;
}

/**
 * One source's counts.
 *
 * @example
 * ```ts
 * const counts: WcCounts = wc_count('a b\n');
 * ```
 */
export interface WcCounts {
  /** Newlines. */
  lines: number;
  /** Words between blanks. */
  words: number;
  /** Bytes, in UTF-8. */
  bytes: number;
  /** Characters. */
  chars: number;
}

/** What a `wc` line may hold. */
const WC_GRAMMAR = {
  operands: [FILES_OPERAND],
  options: {
    lines: { short: 'l', long: 'lines', summary: 'Count lines' },
    words: { short: 'w', long: 'words', summary: 'Count words' },
    bytes: { short: 'c', long: 'bytes', summary: 'Count bytes' },
    chars: { short: 'm', long: 'chars', summary: 'Count characters' },
  },
} as const satisfies CommandGrammar;

/**
 * Counts a text as `wc` does: newlines, words between blanks, bytes, characters.
 *
 * @param text - The text.
 * @returns Its counts.
 *
 * @example
 * ```ts
 * wc_count('héllo\n'); // { lines: 1, words: 1, bytes: 7, chars: 6 }
 * ```
 */
export function wc_count(text: string): WcCounts {
  return {
    lines: (text.match(/\n/g) ?? []).length,
    words: text.split(/\s+/).filter((w: string): boolean => w !== '').length,
    bytes: Buffer.byteLength(text, 'utf-8'),
    chars: [...text].length,
  };
}

/**
 * `wc`'s answer: a row per source (and a total for more than one), counts in POSIX order.
 *
 * @param ask - What to count.
 * @param sources - The sources.
 * @returns The rows.
 *
 * @example
 * ```ts
 * wc_render({ lines: true, words: false, bytes: false, chars: false }, [{ name: null, text: 'a\n' }]); // '1\n'
 * ```
 */
export function wc_render(ask: WcAsk, sources: ReadonlyArray<FilterSource>): string {
  const rows: Array<{ counts: WcCounts; name: string | null }> = sources.map((s: FilterSource) => ({ counts: wc_count(s.text), name: s.name }));
  if (rows.length > 1) {
    const total: WcCounts = rows.reduce((sum: WcCounts, r) => ({
      lines: sum.lines + r.counts.lines, words: sum.words + r.counts.words, bytes: sum.bytes + r.counts.bytes, chars: sum.chars + r.counts.chars,
    }), { lines: 0, words: 0, bytes: 0, chars: 0 });
    rows.push({ counts: total, name: 'total' });
  }
  const pick = (c: WcCounts): number[] => [
    ...(ask.lines ? [c.lines] : []), ...(ask.words ? [c.words] : []), ...(ask.chars ? [c.chars] : []), ...(ask.bytes ? [c.bytes] : []),
  ];
  // One count of the pipe is the number alone, as `wc -l` prints it; more are aligned.
  const single: boolean = rows.length === 1 && rows[0]?.name === null && pick(rows[0].counts).length === 1;
  const width: number = single ? 1 : Math.max(...rows.flatMap((r) => pick(r.counts).map((n: number): number => String(n).length)));
  return lines_join(rows.map((r) => [...pick(r.counts).map((n: number): string => String(n).padStart(width)), ...(r.name === null ? [] : [r.name])].join(' ')));
}

/**
 * `wc [-lwcm] [FILE]...`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [wcCommand] });
 * ```
 */
export const wcCommand = command_declare({
  name: 'wc',
  grammar: WC_GRAMMAR,
  help: {
    summary: 'Count lines, words and bytes',
    description: 'Counts what is piped in, else each file named (- is the pipe), with a total for more than one. With no flag it counts lines, words and bytes; one count of the pipe prints the number alone. It runs in the session, on every surface; a flag it does not take is refused, and command wc runs the system wc.',
    category: 'Files',
    posix: { group: POSIX_GROUP, differs: 'as wc; a FILE is a ChRIS path' },
    examples: ['find /proc/jobs -plugin pl-dylld | wc -l', 'wc -l notes.txt', 'cat a.csv | wc'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof WC_GRAMMAR>): Promise<CommandEnvelope> => {
    const { lines, words, bytes, chars } = args.options;
    const none: boolean = !lines && !words && !bytes && !chars;
    const ask: WcAsk = none ? { lines: true, words: true, bytes: true, chars: false } : { lines, words, bytes, chars };
    return filter_run('wc', args.operands.files, (sources: FilterSource[]): string => wc_render(ask, sources));
  },
});

/**
 * `wc` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `wc`.
 * @returns The counts, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_wc(['-l', 'notes.txt']);
 * ```
 */
export async function builtin_wc(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(wcCommand, args);
}

// ── head / tail ──────────────────────────────────────────────────────────────

/**
 * How many lines `head` or `tail` keeps: the first or last N, all but the last N, or from line N on.
 *
 * @example
 * ```ts
 * const ask: EndsAsk = { count: 5, butLast: false, fromLine: false };
 * ```
 */
export interface EndsAsk {
  /** N. */
  count: number;
  /** head -n -N: all but the last N. */
  butLast: boolean;
  /** tail -n +N: from line N on. */
  fromLine: boolean;
}

/** What a `head` line may hold. */
const HEAD_GRAMMAR = {
  operands: [FILES_OPERAND],
  options: {
    lines: {
      short: 'n', long: 'lines', numeral: true, value: { name: 'count', kind: 'word' },
      summary: 'The first N lines (-N says the same); -n -N: all but the last N',
    },
  },
} as const satisfies CommandGrammar;

/** What a `tail` line may hold. */
const TAIL_GRAMMAR = {
  operands: [FILES_OPERAND],
  options: {
    lines: {
      short: 'n', long: 'lines', numeral: true, value: { name: 'count', kind: 'word' },
      summary: 'The last N lines (-N says the same); -n +N: from line N to the end',
    },
  },
} as const satisfies CommandGrammar;

/**
 * Reads `head`'s or `tail`'s count: N, and for head -N, for tail +N.
 *
 * @param command - Which of the two.
 * @param raw - The count as given, or undefined for none (ten).
 * @returns What it asks, or the refusal of a count that is not one.
 */
function endsAsk_read(command: 'head' | 'tail', raw: string | undefined): AskRead<EndsAsk> {
  if (raw === undefined) return { ask: { count: 10, butLast: false, fromLine: false } };
  const sign: string = raw.startsWith('-') || raw.startsWith('+') ? raw[0] as string : '';
  const n: number | null = count_parse(sign === '' ? raw : raw.slice(1));
  const signTaken: boolean = sign === '' || (command === 'head' && sign === '-') || (command === 'tail' && sign === '+');
  if (n === null || !signTaken) {
    return { refused: `${command}: -n takes a number${command === 'head' ? ' (-N: all but the last N)' : ' (+N: from line N)'}, not '${raw}'` };
  }
  return { ask: { count: n, butLast: command === 'head' && sign === '-', fromLine: command === 'tail' && sign === '+' } };
}

/**
 * The lines `head` keeps of a text.
 *
 * @param ask - How many.
 * @param text - The text.
 * @returns The kept lines.
 *
 * @example
 * ```ts
 * head_lines({ count: 1, butLast: false, fromLine: false }, 'a\nb\n'); // ['a']
 * ```
 */
export function head_lines(ask: EndsAsk, text: string): string[] {
  const lines: string[] = lines_split(text);
  return ask.butLast ? lines.slice(0, Math.max(0, lines.length - ask.count)) : lines.slice(0, ask.count);
}

/**
 * The lines `tail` keeps of a text.
 *
 * @param ask - How many.
 * @param text - The text.
 * @returns The kept lines.
 *
 * @example
 * ```ts
 * tail_lines({ count: 1, butLast: false, fromLine: false }, 'a\nb\n'); // ['b']
 * ```
 */
export function tail_lines(ask: EndsAsk, text: string): string[] {
  const lines: string[] = lines_split(text);
  if (ask.fromLine) return lines.slice(Math.max(0, ask.count - 1));
  return ask.count === 0 ? [] : lines.slice(-ask.count);
}

/**
 * Each source's kept lines, under `==> name <==` when there is more than one.
 *
 * @param keep - The lines one source keeps.
 * @returns The answer over the sources.
 */
function ends_render(keep: (ask: EndsAsk, text: string) => string[]): (ask: EndsAsk, sources: FilterSource[]) => string {
  return (ask: EndsAsk, sources: FilterSource[]): string => {
    if (sources.length === 1) return lines_join(keep(ask, (sources[0] as FilterSource).text));
    return sources.map((s: FilterSource): string => `==> ${s.name === '-' ? 'standard input' : s.name ?? ''} <==\n${lines_join(keep(ask, s.text))}`).join('\n');
  };
}

/**
 * `head [-n N | -N] [FILE]...`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [headCommand] });
 * ```
 */
export const headCommand = command_declare({
  name: 'head',
  grammar: HEAD_GRAMMAR,
  help: {
    summary: 'The first lines',
    description: 'Prints the first ten lines of what is piped in, else of each file named (under ==> name <== for more than one). -N is -n N; -n -N prints all but the last N. It runs in the session, on every surface; a flag it does not take is refused, and command head runs the system head.',
    category: 'Files',
    posix: { group: POSIX_GROUP, differs: 'as head; a FILE is a ChRIS path' },
    examples: ['ls -l | head -n 5', 'head -3 notes.txt'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof HEAD_GRAMMAR>): Promise<CommandEnvelope> =>
    askedFilter_run('head', endsAsk_read('head', args.options.lines), args.operands.files, ends_render(head_lines)),
});

/**
 * `tail [-n N | -N | -n +N] [FILE]...`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [tailCommand] });
 * ```
 */
export const tailCommand = command_declare({
  name: 'tail',
  grammar: TAIL_GRAMMAR,
  help: {
    summary: 'The last lines',
    description: 'Prints the last ten lines of what is piped in, else of each file named (under ==> name <== for more than one). -N is -n N; -n +N prints from line N on. It runs in the session, on every surface; a flag it does not take (-f among them) is refused, and command tail runs the system tail.',
    category: 'Files',
    posix: { group: POSIX_GROUP, differs: 'as tail, without -f; a FILE is a ChRIS path' },
    examples: ['cat /proc/jobs/feed_12/pl-dircopy_40/log | tail -n 20', 'tail -n +2 a.csv'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof TAIL_GRAMMAR>): Promise<CommandEnvelope> =>
    askedFilter_run('tail', endsAsk_read('tail', args.options.lines), args.operands.files, ends_render(tail_lines)),
});

/**
 * `head` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `head`.
 * @returns The lines, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_head(['-5', 'notes.txt']);
 * ```
 */
export async function builtin_head(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(headCommand, args);
}

/**
 * `tail` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `tail`.
 * @returns The lines, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_tail(['-n', '+2', 'a.csv']);
 * ```
 */
export async function builtin_tail(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(tailCommand, args);
}

// ── sort ─────────────────────────────────────────────────────────────────────

/**
 * How `sort` orders.
 *
 * @example
 * ```ts
 * const ask: SortAsk = { reverse: false, numeric: true, fold: false, unique: false, key: { from: 2, to: null }, separator: ',' };
 * ```
 */
export interface SortAsk {
  /** Reverse the order. */
  reverse: boolean;
  /** Compare by number. */
  numeric: boolean;
  /** Ignore case. */
  fold: boolean;
  /** One of each equal line. */
  unique: boolean;
  /** The key's fields, 1-based, inclusive; null for the whole line. */
  key: { from: number; to: number | null } | null;
  /** The field separator; null for runs of blanks. */
  separator: string | null;
}

/** What a `sort` line may hold. */
const SORT_GRAMMAR = {
  operands: [FILES_OPERAND],
  options: {
    reverse: { short: 'r', long: 'reverse', summary: 'Reverse the order' },
    numeric: { short: 'n', long: 'numeric-sort', summary: 'Compare by number' },
    fold: { short: 'f', long: 'ignore-case', summary: 'Ignore case' },
    unique: { short: 'u', long: 'unique', summary: 'One of each equal line' },
    key: { short: 'k', long: 'key', value: { name: 'N[,M]', kind: 'word' }, summary: 'Compare fields N to M (to the end without M)' },
    separator: { short: 't', long: 'field-separator', value: { name: 'C', kind: 'word' }, summary: 'Fields split at C, not at runs of blanks' },
  },
} as const satisfies CommandGrammar;

/**
 * Reads `sort`'s options: its switches, a key of whole fields, a one-character separator.
 *
 * @param options - The typed options.
 * @returns What they ask, or the refusal of a key or separator it does not take.
 */
function sortAsk_read(options: CommandArguments<typeof SORT_GRAMMAR>['options']): AskRead<SortAsk> {
  const ask: SortAsk = { reverse: options.reverse, numeric: options.numeric, fold: options.fold, unique: options.unique, key: null, separator: null };
  if (options.separator !== undefined) {
    if (options.separator.length !== 1) return { refused: `sort: -t takes one character, not '${options.separator}'` };
    ask.separator = options.separator;
  }
  if (options.key !== undefined) {
    const key: RegExpExecArray | null = /^(\d+)(?:,(\d+))?$/.exec(options.key);
    if (key === null) {
      return { refused: `sort: -k takes whole fields, N or N,M, not '${options.key}'; a key with its own options is the system sort's: command sort …` };
    }
    ask.key = { from: Number(key[1]), to: key[2] === undefined ? null : Number(key[2]) };
  }
  return { ask };
}

/**
 * The part of a line a sort compares.
 *
 * @param ask - How it orders.
 * @param line - The line.
 * @returns The key's text.
 */
function sortKey_extract(ask: SortAsk, line: string): string {
  if (ask.key === null) return line;
  const fields: string[] = ask.separator === null ? line.trim().split(/\s+/) : line.split(ask.separator);
  const to: number = ask.key.to ?? fields.length;
  return fields.slice(ask.key.from - 1, to).join(ask.separator ?? ' ');
}

/**
 * The lines in `sort`'s order: stable, by key, numeric or text, then reversed, then unique by key.
 *
 * @param ask - How it orders.
 * @param lines - The lines.
 * @returns The lines in order.
 *
 * @example
 * ```ts
 * sort_lines({ reverse: false, numeric: true, fold: false, unique: false, key: null, separator: null }, ['10', '9']); // ['9', '10']
 * ```
 */
export function sort_lines(ask: SortAsk, lines: ReadonlyArray<string>): string[] {
  const keyed: Array<{ line: string; key: string; num: number }> = lines.map((line: string) => {
    const key: string = sortKey_extract(ask, line);
    const num: number = Number(/^\s*-?\d+(?:\.\d+)?/.exec(key)?.[0] ?? 0);
    return { line, key: ask.fold ? key.toLowerCase() : key, num };
  });
  const compare = (a: { key: string; num: number }, b: { key: string; num: number }): number => {
    if (ask.numeric && a.num !== b.num) return a.num - b.num;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  };
  keyed.sort((a, b): number => (ask.reverse ? compare(b, a) : compare(a, b)));
  if (!ask.unique) return keyed.map((k): string => k.line);
  const out: string[] = [];
  let last: { key: string; num: number } | null = null;
  for (const k of keyed) {
    if (last === null || compare(last, k) !== 0) out.push(k.line);
    last = k;
  }
  return out;
}

/**
 * `sort [-rnfu] [-k N[,M]] [-t C] [FILE]...`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [sortCommand] });
 * ```
 */
export const sortCommand = command_declare({
  name: 'sort',
  grammar: SORT_GRAMMAR,
  help: {
    summary: 'Lines in order',
    description: 'Sorts the lines of what is piped in, else of the files named, stably. -k compares fields N to M (to the end without M), split at -t C or at runs of blanks. It runs in the session, on every surface; a flag it does not take, or a key with its own options (-k2n), is refused, and command sort runs the system sort.',
    category: 'Files',
    posix: { group: POSIX_GROUP, differs: 'as sort, a key by whole fields; a FILE is a ChRIS path' },
    examples: ['find /proc/jobs -status finishedWithError | sort', 'cat a.csv | sort -t , -k 2 -n'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof SORT_GRAMMAR>): Promise<CommandEnvelope> =>
    askedFilter_run('sort', sortAsk_read(args.options), args.operands.files, (ask: SortAsk, sources: FilterSource[]): string =>
      lines_join(sort_lines(ask, sourceLines_list(sources)))),
});

/**
 * `sort` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `sort`.
 * @returns The lines in order, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_sort(['-t', ',', '-k', '2', 'a.csv']);
 * ```
 */
export async function builtin_sort(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(sortCommand, args);
}

// ── uniq ─────────────────────────────────────────────────────────────────────

/**
 * What `uniq` keeps of each run of equal lines.
 *
 * @example
 * ```ts
 * const ask: UniqAsk = { count: true, repeated: false, unique: false, fold: false };
 * ```
 */
export interface UniqAsk {
  /** Prefix each with its count. */
  count: boolean;
  /** Only repeated lines. */
  repeated: boolean;
  /** Only lines never repeated. */
  unique: boolean;
  /** Ignore case. */
  fold: boolean;
}

/** What a `uniq` line may hold: one input at most; a second operand, uniq's output file, is the system uniq's. */
const UNIQ_GRAMMAR = {
  operands: [{ name: 'file', kind: 'cfsPath', optional: true, glob: true, summary: 'A ChRIS file to read (- is the pipe); the pipe when none is named' }],
  options: {
    count: { short: 'c', long: 'count', summary: 'Prefix each with its count' },
    repeated: { short: 'd', long: 'repeated', summary: 'Only repeated lines' },
    unique: { short: 'u', long: 'unique', summary: 'Only lines never repeated' },
    fold: { short: 'i', long: 'ignore-case', summary: 'Ignore case' },
  },
} as const satisfies CommandGrammar;

/**
 * Adjacent equal lines folded to one, as `uniq` does.
 *
 * @param ask - What it keeps.
 * @param lines - The lines.
 * @returns The kept lines.
 *
 * @example
 * ```ts
 * uniq_lines({ count: false, repeated: false, unique: false, fold: false }, ['a', 'a', 'b']); // ['a', 'b']
 * ```
 */
export function uniq_lines(ask: UniqAsk, lines: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  const same = (a: string, b: string): boolean => (ask.fold ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (let i: number = 0; i < lines.length;) {
    let j: number = i + 1;
    while (j < lines.length && same(lines[i] as string, lines[j] as string)) j++;
    const run: number = j - i;
    const kept: boolean = (!ask.repeated || run > 1) && (!ask.unique || run === 1);
    if (kept) out.push(ask.count ? `${String(run).padStart(7)} ${lines[i] as string}` : (lines[i] as string));
    i = j;
  }
  return out;
}

/**
 * `uniq [-cdui] [FILE]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [uniqCommand] });
 * ```
 */
export const uniqCommand = command_declare({
  name: 'uniq',
  grammar: UNIQ_GRAMMAR,
  help: {
    summary: 'Fold adjacent equal lines to one',
    description: 'Folds each run of equal adjacent lines to one, of what is piped in or of one file. Sort first to fold every equal line. It runs in the session, on every surface; a flag it does not take, or an output file, is refused, and command uniq runs the system uniq.',
    category: 'Files',
    posix: { group: POSIX_GROUP, differs: 'as uniq, without an output file; a FILE is a ChRIS path' },
    examples: ['cut -d , -f 1 a.csv | sort | uniq -c', 'ls | uniq'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof UNIQ_GRAMMAR>): Promise<CommandEnvelope> => {
    const ask: UniqAsk = { count: args.options.count, repeated: args.options.repeated, unique: args.options.unique, fold: args.options.fold };
    const files: string[] = args.operands.file === undefined ? [] : [args.operands.file];
    return filter_run('uniq', files, (sources: FilterSource[]): string => lines_join(uniq_lines(ask, sourceLines_list(sources))));
  },
});

/**
 * `uniq` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `uniq`.
 * @returns The folded lines, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_uniq(['-c']);
 * ```
 */
export async function builtin_uniq(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(uniqCommand, args);
}

// ── cut ──────────────────────────────────────────────────────────────────────

/**
 * What `cut` keeps of each line.
 *
 * @example
 * ```ts
 * const ask: CutAsk = { by: 'fields', ranges: [{ from: 1, to: 1 }], delimiter: ',', onlyDelimited: false };
 * ```
 */
export interface CutAsk {
  /** Fields or characters. */
  by: 'fields' | 'chars';
  /** The positions, 1-based: each range inclusive, an open end to the line's end. */
  ranges: Array<{ from: number; to: number | null }>;
  /** The field delimiter. */
  delimiter: string;
  /** With fields: drop a line that holds no delimiter. */
  onlyDelimited: boolean;
}

/** What a `cut` line may hold. */
const CUT_GRAMMAR = {
  operands: [FILES_OPERAND],
  options: {
    fields: { short: 'f', long: 'fields', value: { name: 'LIST', kind: 'word' }, summary: 'Keep these fields' },
    chars: { short: 'c', long: 'characters', value: { name: 'LIST', kind: 'word' }, summary: 'Keep these characters' },
    bytes: { short: 'b', long: 'bytes', value: { name: 'LIST', kind: 'word' }, summary: 'Keep these characters (as -c)' },
    delimiter: { short: 'd', long: 'delimiter', value: { name: 'C', kind: 'word' }, summary: 'The field delimiter (a tab when not said)' },
    onlyDelimited: { short: 's', long: 'only-delimited', summary: 'Only lines that hold the delimiter' },
  },
} as const satisfies CommandGrammar;

/**
 * Reads a cut LIST: `1,3`, `2-4`, `3-`, `-2`.
 *
 * @param list - The LIST.
 * @returns Its ranges, or null when it is not one.
 */
function cutList_parse(list: string): Array<{ from: number; to: number | null }> | null {
  const ranges: Array<{ from: number; to: number | null }> = [];
  for (const part of list.split(',')) {
    const range: RegExpExecArray | null = /^(\d*)(-?)(\d*)$/.exec(part);
    if (range === null || (range[1] === '' && range[3] === '')) return null;
    const from: number = range[1] === '' ? 1 : Number(range[1]);
    const to: number | null = range[2] === '' ? from : range[3] === '' ? null : Number(range[3]);
    if (from < 1 || (to !== null && to < from)) return null;
    ranges.push({ from, to });
  }
  return ranges;
}

/**
 * Reads `cut`'s options: one LIST, of fields or characters, and a one-character delimiter.
 *
 * @param options - The typed options.
 * @returns What they ask, or the refusal of a list or delimiter it does not take.
 */
function cutAsk_read(options: CommandArguments<typeof CUT_GRAMMAR>['options']): AskRead<CutAsk> {
  const ask: CutAsk = { by: 'fields', ranges: [], delimiter: '\t', onlyDelimited: options.onlyDelimited };
  if (options.delimiter !== undefined) {
    if (options.delimiter.length !== 1) return { refused: `cut: -d takes one character, not '${options.delimiter}'` };
    ask.delimiter = options.delimiter;
  }
  const lists: Array<{ by: CutAsk['by']; list: string }> = [
    ...(options.fields !== undefined ? [{ by: 'fields' as const, list: options.fields }] : []),
    ...(options.chars !== undefined ? [{ by: 'chars' as const, list: options.chars }] : []),
    ...(options.bytes !== undefined ? [{ by: 'chars' as const, list: options.bytes }] : []),
  ];
  if (lists.length > 1) return { refused: 'cut: only one of -f, -c or -b' };
  const chosen: { by: CutAsk['by']; list: string } | undefined = lists[0];
  if (chosen === undefined) return { refused: 'cut: say what to keep: -f LIST (fields) or -c LIST (characters)' };
  const ranges: Array<{ from: number; to: number | null }> | null = cutList_parse(chosen.list);
  if (ranges === null) return { refused: `cut: a list is N, N-M, N- or -M joined by commas, not '${chosen.list}'` };
  ask.by = chosen.by;
  ask.ranges = ranges;
  return { ask };
}

/**
 * The positions a cut keeps of `n`, in order, each once.
 *
 * @param ask - What it keeps.
 * @param n - How many fields or characters the line has.
 * @returns The positions, 1-based.
 */
function cutPositions_derive(ask: CutAsk, n: number): number[] {
  const kept: Set<number> = new Set();
  for (const range of ask.ranges) for (let i: number = range.from; i <= Math.min(range.to ?? n, n); i++) kept.add(i);
  return [...kept].sort((a: number, b: number): number => a - b);
}

/**
 * What `cut` keeps of each line.
 *
 * @param ask - What it keeps.
 * @param lines - The lines.
 * @returns The kept parts, a line each (a line with no delimiter dropped under -s).
 *
 * @example
 * ```ts
 * cut_lines({ by: 'fields', ranges: [{ from: 2, to: 2 }], delimiter: ',', onlyDelimited: false }, ['a,b']); // ['b']
 * ```
 */
export function cut_lines(ask: CutAsk, lines: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (ask.by === 'chars') {
      const chars: string[] = [...line];
      out.push(cutPositions_derive(ask, chars.length).map((i: number): string => chars[i - 1] as string).join(''));
      continue;
    }
    if (!line.includes(ask.delimiter)) { if (!ask.onlyDelimited) out.push(line); continue; }
    const fields: string[] = line.split(ask.delimiter);
    out.push(cutPositions_derive(ask, fields.length).map((i: number): string => fields[i - 1] as string).join(ask.delimiter));
  }
  return out;
}

/**
 * `cut -f LIST [-d C] [-s] | -c LIST [FILE]...`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [cutCommand] });
 * ```
 */
export const cutCommand = command_declare({
  name: 'cut',
  grammar: CUT_GRAMMAR,
  help: {
    summary: 'Keep fields or characters of each line',
    description: 'Keeps the fields (split at -d C, a tab when not said) or the characters LIST names, of each line piped in or of the files named. A LIST is N, N-M, N- or -M, joined by commas; -b is -c. -s drops a line with no delimiter. It runs in the session, on every surface; a flag it does not take is refused, and command cut runs the system cut.',
    category: 'Files',
    posix: { group: POSIX_GROUP, differs: 'as cut, -b as -c; a FILE is a ChRIS path' },
    examples: ['cut -d , -f 1,3 a.csv', 'ls | cut -c 1-8'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof CUT_GRAMMAR>): Promise<CommandEnvelope> =>
    askedFilter_run('cut', cutAsk_read(args.options), args.operands.files, (ask: CutAsk, sources: FilterSource[]): string =>
      lines_join(cut_lines(ask, sourceLines_list(sources)))),
});

/**
 * `cut` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `cut`.
 * @returns The kept parts, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_cut(['-d', ',', '-f', '1', 'a.csv']);
 * ```
 */
export async function builtin_cut(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(cutCommand, args);
}
