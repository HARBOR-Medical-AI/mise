/**
 * @file The text filters a pipe ends in: `wc`, `head`, `tail`, `sort`,
 * `uniq`, `cut`, run in the kernel.
 *
 * A program in a pipe runs where the surface can run one: a chell on the
 * operator's machine, or a daemon under `--host-control pipes`. A browser
 * runs none, so `find /proc/jobs | wc -l` had nowhere to go. As builtins
 * these run on every surface, and none starts a process anywhere.
 *
 * Each reads what was piped in, else the files named (`-` is the
 * pipe), and takes the POSIX flags most lines use, with their meanings. A
 * flag it does not take is the system program's: the line goes there with
 * the piped text when the surface can run one, and is refused by name when
 * it cannot. `command wc` skips the builtin altogether.
 *
 * @module
 */
import chalk from 'chalk';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { errno_words, type VfsOutcome } from '@fnndsc/fond';
import { stdin_take } from '../games/stdin.js';
import { surface_get } from '../../core/surface.js';
import { vfsDispatcher_get } from '../../core/filesystem.js';
import { storePath_resolve } from '../utils.js';
import { exitCode_set } from '../../core/handlerRun.js';

/** One text a filter reads: the pipe's, or a file's under its name. */
export interface FilterSource {
  /** The operand as typed; null for the pipe. */
  name: string | null;
  text: string;
}

/** A line's words read by one filter: what it asks, its operands, or what it does not take. */
interface FilterParse<T> {
  ask: T;
  operands: string[];
  /** A flag this builtin does not take: the line is the system program's. */
  foreign: string | null;
  /** A flag taken but given wrong: said by name. */
  refused: string | null;
}

/** A whole number from a flag's argument, or null. */
function count_parse(word: string | undefined): number | null {
  if (word === undefined || !/^\d+$/.test(word)) return null;
  return Number(word);
}

/** The lines of a text, without the last line's newline. */
function lines_split(text: string): string[] {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

/** Lines written back as text, each ended by a newline. */
function lines_join(lines: ReadonlyArray<string>): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** A word as a POSIX shell reads it back. */
function word_quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
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
 * Runs a filter: a line it does not take goes to the system program, else
 * the sources are read and answered.
 *
 * @param command - The filter's name.
 * @param args - The words after it.
 * @param parsed - What they ask.
 * @param answer - Turns the sources into the filter's output.
 * @returns The envelope.
 */
async function filter_run<T>(
  command: string,
  args: ReadonlyArray<string>,
  parsed: FilterParse<T>,
  answer: (ask: T, sources: FilterSource[]) => string,
): Promise<CommandEnvelope> {
  if (parsed.refused !== null) {
    exitCode_set(1);
    return envelope_error('', undefined, `${parsed.refused}\n`);
  }
  if (parsed.foreign !== null) return foreign_run(command, args, parsed.foreign, parsed.operands);
  const read = await sources_read(command, parsed.operands);
  if ('refusal' in read) {
    exitCode_set(1);
    return envelope_error('', undefined, `${read.refusal}\n`);
  }
  if (read.errors !== '') exitCode_set(1);
  const out: string = read.sources.length > 0 || read.errors === '' ? answer(parsed.ask, read.sources) : '';
  return read.errors === '' ? envelope_ok(out) : { ...envelope_ok(out), status: out === '' ? 'error' : 'ok', renderedErr: chalk.red(read.errors) };
}

/**
 * A line with a flag the builtin does not take: the system program's, fed
 * the piped text, where the surface runs one; refused by name where not.
 *
 * @param command - The filter's name.
 * @param args - The words after it.
 * @param flag - The flag not taken.
 * @param operands - The file operands (session paths, which a system program cannot read).
 * @returns The envelope.
 */
async function foreign_run(command: string, args: ReadonlyArray<string>, flag: string, operands: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const surface = surface_get();
  const text: string | null = stdin_take();
  if (!surface.capabilities.pipeSegments || operands.length > 0 || text === null) {
    exitCode_set(1);
    const why: string = operands.length > 0 || text === null
      ? `the builtin does not take it, and a system ${command} cannot read the session's files`
      : `the builtin does not take it, and this surface runs no system ${command} (command ${command} asks for one)`;
    return envelope_error('', undefined, `${command}: ${flag}: ${why}\n`);
  }
  const out: Buffer = await surface.pipeSegment(`${command} ${args.map(word_quote).join(' ')}`.trim(), Buffer.from(text, 'utf-8'));
  return envelope_ok(out.toString('utf-8'));
}

/**
 * Reads short flags (`-lw`), each taking an argument attached or next
 * (`-n5`, `-n 5`), and operands; `--` ends the flags.
 *
 * @param args - The words.
 * @param takes - The flags without an argument.
 * @param withArg - The flags that take one.
 * @param long - Long flags to their short letter.
 * @returns The flags met (in order, with any argument), the operands, and a flag not taken.
 */
function flags_read(
  args: ReadonlyArray<string>,
  takes: string,
  withArg: string,
  long: Readonly<Record<string, string>> = {},
): { flags: Array<[string, string | undefined]>; operands: string[]; foreign: string | null; missing: string | null } {
  const flags: Array<[string, string | undefined]> = [];
  const operands: string[] = [];
  let ended: boolean = false;
  for (let i: number = 0; i < args.length; i++) {
    const word: string = args[i] as string;
    if (ended || word === '-' || !word.startsWith('-')) { operands.push(word); continue; }
    if (word === '--') { ended = true; continue; }
    if (word.startsWith('--')) {
      const [name, value]: [string, string | undefined] = (word.includes('=') ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, undefined]);
      const letter: string | undefined = long[name];
      if (letter === undefined) return { flags, operands, foreign: word, missing: null };
      if (withArg.includes(letter)) {
        const arg: string | undefined = value ?? args[++i];
        if (arg === undefined) return { flags, operands, foreign: null, missing: name };
        flags.push([letter, arg]);
      } else {
        flags.push([letter, undefined]);
      }
      continue;
    }
    for (let j: number = 1; j < word.length; j++) {
      const letter: string = word[j] as string;
      if (withArg.includes(letter)) {
        const rest: string = word.slice(j + 1);
        const arg: string | undefined = rest !== '' ? rest : args[++i];
        if (arg === undefined) return { flags, operands, foreign: null, missing: `-${letter}` };
        flags.push([letter, arg]);
        break;
      }
      if (!takes.includes(letter)) return { flags, operands, foreign: `-${letter}`, missing: null };
      flags.push([letter, undefined]);
    }
  }
  return { flags, operands, foreign: null, missing: null };
}

// ── wc ───────────────────────────────────────────────────────────────────────

/** What `wc` counts. */
export interface WcAsk { lines: boolean; words: boolean; bytes: boolean; chars: boolean }

/** One source's counts. */
export interface WcCounts { lines: number; words: number; bytes: number; chars: number }

/** Counts a text as `wc` does: newlines, words between blanks, bytes, characters. */
export function wc_count(text: string): WcCounts {
  return {
    lines: (text.match(/\n/g) ?? []).length,
    words: text.split(/\s+/).filter((w: string): boolean => w !== '').length,
    bytes: Buffer.byteLength(text, 'utf-8'),
    chars: [...text].length,
  };
}

/** Reads `wc`'s words. */
export function wcArgs_parse(args: ReadonlyArray<string>): FilterParse<WcAsk> {
  const read = flags_read(args, 'lwcm', '', { '--lines': 'l', '--words': 'w', '--bytes': 'c', '--chars': 'm' });
  const ask: WcAsk = { lines: false, words: false, bytes: false, chars: false };
  for (const [flag] of read.flags) {
    if (flag === 'l') ask.lines = true;
    if (flag === 'w') ask.words = true;
    if (flag === 'c') ask.bytes = true;
    if (flag === 'm') ask.chars = true;
  }
  if (!ask.lines && !ask.words && !ask.bytes && !ask.chars) { ask.lines = true; ask.words = true; ask.bytes = true; }
  return { ask, operands: read.operands, foreign: read.foreign, refused: null };
}

/** `wc`'s answer: a row per source (and a total for more than one), counts in POSIX order. */
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

/** `wc [-lwcm] [FILE]...` */
export async function builtin_wc(args: string[]): Promise<CommandEnvelope> {
  return filter_run('wc', args, wcArgs_parse(args), wc_render);
}

// ── head / tail ──────────────────────────────────────────────────────────────

/** How many lines `head` or `tail` keeps: the first or last N, all but the last N, or from line N on. */
export interface EndsAsk { count: number; butLast: boolean; fromLine: boolean }

/** Reads `head`'s or `tail`'s words: `-n N`, `-N`, and for head `-n -N`, for tail `-n +N`. */
export function endsArgs_parse(command: 'head' | 'tail', args: ReadonlyArray<string>): FilterParse<EndsAsk> {
  const ask: EndsAsk = { count: 10, butLast: false, fromLine: false };
  // `-5` is `-n 5`, as both have always taken it.
  const words: string[] = args.map((w: string, i: number): string =>
    (/^-\d+$/.test(w) && args[i - 1] !== '-n' && args[i - 1] !== '--lines' ? `-n${w.slice(1)}` : w));
  const read = flags_read(words, '', 'n', { '--lines': 'n' });
  if (read.missing !== null) return { ask, operands: read.operands, foreign: null, refused: `${command}: ${read.missing} needs a number` };
  for (const [, value] of read.flags) {
    const raw: string = value ?? '';
    const sign: string = raw.startsWith('-') || raw.startsWith('+') ? raw[0] as string : '';
    const n: number | null = count_parse(sign === '' ? raw : raw.slice(1));
    const signTaken: boolean = sign === '' || (command === 'head' && sign === '-') || (command === 'tail' && sign === '+');
    if (n === null || !signTaken) return { ask, operands: read.operands, foreign: null, refused: `${command}: -n takes a number${command === 'head' ? ' (-N: all but the last N)' : ' (+N: from line N)'}, not '${raw}'` };
    ask.count = n;
    ask.butLast = command === 'head' && sign === '-';
    ask.fromLine = command === 'tail' && sign === '+';
  }
  return { ask, operands: read.operands, foreign: read.foreign, refused: null };
}

/** The lines `head` keeps of a text. */
export function head_lines(ask: EndsAsk, text: string): string[] {
  const lines: string[] = lines_split(text);
  return ask.butLast ? lines.slice(0, Math.max(0, lines.length - ask.count)) : lines.slice(0, ask.count);
}

/** The lines `tail` keeps of a text. */
export function tail_lines(ask: EndsAsk, text: string): string[] {
  const lines: string[] = lines_split(text);
  if (ask.fromLine) return lines.slice(Math.max(0, ask.count - 1));
  return ask.count === 0 ? [] : lines.slice(-ask.count);
}

/** Each source's kept lines, under `==> name <==` when there is more than one. */
function ends_render(keep: (ask: EndsAsk, text: string) => string[]): (ask: EndsAsk, sources: FilterSource[]) => string {
  return (ask: EndsAsk, sources: FilterSource[]): string => {
    if (sources.length === 1) return lines_join(keep(ask, (sources[0] as FilterSource).text));
    return sources.map((s: FilterSource): string => `==> ${s.name === '-' ? 'standard input' : s.name} <==\n${lines_join(keep(ask, s.text))}`).join('\n');
  };
}

/** `head [-n N | -N] [FILE]...` */
export async function builtin_head(args: string[]): Promise<CommandEnvelope> {
  return filter_run('head', args, endsArgs_parse('head', args), ends_render(head_lines));
}

/** `tail [-n N | -N | -n +N] [FILE]...` */
export async function builtin_tail(args: string[]): Promise<CommandEnvelope> {
  return filter_run('tail', args, endsArgs_parse('tail', args), ends_render(tail_lines));
}

// ── sort ─────────────────────────────────────────────────────────────────────

/** How `sort` orders. */
export interface SortAsk {
  reverse: boolean;
  numeric: boolean;
  fold: boolean;
  unique: boolean;
  /** The key's fields, 1-based, inclusive; null for the whole line. */
  key: { from: number; to: number | null } | null;
  /** The field separator; null for runs of blanks. */
  separator: string | null;
}

/** Reads `sort`'s words. */
export function sortArgs_parse(args: ReadonlyArray<string>): FilterParse<SortAsk> {
  const ask: SortAsk = { reverse: false, numeric: false, fold: false, unique: false, key: null, separator: null };
  const read = flags_read(args, 'rnfu', 'kt', {
    '--reverse': 'r', '--numeric-sort': 'n', '--ignore-case': 'f', '--unique': 'u', '--key': 'k', '--field-separator': 't',
  });
  if (read.missing !== null) return { ask, operands: read.operands, foreign: null, refused: `sort: ${read.missing} needs an argument` };
  for (const [flag, value] of read.flags) {
    if (flag === 'r') ask.reverse = true;
    if (flag === 'n') ask.numeric = true;
    if (flag === 'f') ask.fold = true;
    if (flag === 'u') ask.unique = true;
    if (flag === 't') {
      if ((value ?? '').length !== 1) return { ask, operands: read.operands, foreign: null, refused: `sort: -t takes one character, not '${value ?? ''}'` };
      ask.separator = value as string;
    }
    if (flag === 'k') {
      // A key's own options (-k2n, -k1.3) are the system sort's.
      const key: RegExpExecArray | null = /^(\d+)(?:,(\d+))?$/.exec(value ?? '');
      if (key === null) return { ask, operands: read.operands, foreign: `-k ${value ?? ''}`, refused: null };
      ask.key = { from: Number(key[1]), to: key[2] === undefined ? null : Number(key[2]) };
    }
  }
  return { ask, operands: read.operands, foreign: read.foreign, refused: null };
}

/** The part of a line a sort compares. */
function sortKey_extract(ask: SortAsk, line: string): string {
  if (ask.key === null) return line;
  const fields: string[] = ask.separator === null ? line.trim().split(/\s+/) : line.split(ask.separator);
  const to: number = ask.key.to ?? fields.length;
  return fields.slice(ask.key.from - 1, to).join(ask.separator ?? ' ');
}

/** The lines in `sort`'s order: stable, by key, numeric or text, then reversed, then unique by key. */
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

/** `sort [-rnfu] [-k N[,M]] [-t C] [FILE]...` */
export async function builtin_sort(args: string[]): Promise<CommandEnvelope> {
  return filter_run('sort', args, sortArgs_parse(args), (ask: SortAsk, sources: FilterSource[]): string =>
    lines_join(sort_lines(ask, sources.flatMap((s: FilterSource): string[] => lines_split(s.text)))));
}

// ── uniq ─────────────────────────────────────────────────────────────────────

/** What `uniq` keeps of each run of equal lines. */
export interface UniqAsk { count: boolean; repeated: boolean; unique: boolean; fold: boolean }

/** Reads `uniq`'s words; one input at most, as uniq takes. */
export function uniqArgs_parse(args: ReadonlyArray<string>): FilterParse<UniqAsk> {
  const ask: UniqAsk = { count: false, repeated: false, unique: false, fold: false };
  const read = flags_read(args, 'cdui', '', { '--count': 'c', '--repeated': 'd', '--unique': 'u', '--ignore-case': 'i' });
  for (const [flag] of read.flags) {
    if (flag === 'c') ask.count = true;
    if (flag === 'd') ask.repeated = true;
    if (flag === 'u') ask.unique = true;
    if (flag === 'i') ask.fold = true;
  }
  // A second operand is uniq's output file, written on the host: the system uniq's.
  const foreign: string | null = read.foreign ?? (read.operands.length > 1 ? (read.operands[1] as string) : null);
  return { ask, operands: read.operands, foreign, refused: null };
}

/** Adjacent equal lines folded to one, as `uniq` does. */
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

/** `uniq [-cdui] [FILE]` */
export async function builtin_uniq(args: string[]): Promise<CommandEnvelope> {
  return filter_run('uniq', args, uniqArgs_parse(args), (ask: UniqAsk, sources: FilterSource[]): string =>
    lines_join(uniq_lines(ask, sources.flatMap((s: FilterSource): string[] => lines_split(s.text)))));
}

// ── cut ──────────────────────────────────────────────────────────────────────

/** What `cut` keeps of each line. */
export interface CutAsk {
  /** Fields or characters. */
  by: 'fields' | 'chars';
  /** The positions, 1-based: each range inclusive, an open end to the line's end. */
  ranges: Array<{ from: number; to: number | null }>;
  delimiter: string;
  /** With fields: drop a line that holds no delimiter. */
  onlyDelimited: boolean;
}

/** Reads a cut LIST: `1,3`, `2-4`, `3-`, `-2`. */
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

/** Reads `cut`'s words. */
export function cutArgs_parse(args: ReadonlyArray<string>): FilterParse<CutAsk> {
  const ask: CutAsk = { by: 'fields', ranges: [], delimiter: '\t', onlyDelimited: false };
  const read = flags_read(args, 's', 'fcbd', { '--fields': 'f', '--characters': 'c', '--bytes': 'b', '--delimiter': 'd', '--only-delimited': 's' });
  if (read.missing !== null) return { ask, operands: read.operands, foreign: null, refused: `cut: ${read.missing} needs an argument` };
  let listed: boolean = false;
  for (const [flag, value] of read.flags) {
    if (flag === 's') ask.onlyDelimited = true;
    if (flag === 'd') {
      if ((value ?? '').length !== 1) return { ask, operands: read.operands, foreign: null, refused: `cut: -d takes one character, not '${value ?? ''}'` };
      ask.delimiter = value as string;
    }
    if (flag === 'f' || flag === 'c' || flag === 'b') {
      if (listed) return { ask, operands: read.operands, foreign: null, refused: 'cut: only one of -f, -c or -b' };
      const ranges = cutList_parse(value ?? '');
      if (ranges === null) return { ask, operands: read.operands, foreign: null, refused: `cut: a list is N, N-M, N- or -M joined by commas, not '${value ?? ''}'` };
      ask.by = flag === 'f' ? 'fields' : 'chars';
      ask.ranges = ranges;
      listed = true;
    }
  }
  if (!listed && read.foreign === null) return { ask, operands: read.operands, foreign: null, refused: 'cut: say what to keep: -f LIST (fields) or -c LIST (characters)' };
  return { ask, operands: read.operands, foreign: read.foreign, refused: null };
}

/** The positions a cut keeps of `n`, in order, each once. */
function cutPositions_derive(ask: CutAsk, n: number): number[] {
  const kept: Set<number> = new Set();
  for (const range of ask.ranges) for (let i: number = range.from; i <= Math.min(range.to ?? n, n); i++) kept.add(i);
  return [...kept].sort((a: number, b: number): number => a - b);
}

/** What `cut` keeps of each line. */
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

/** `cut -f LIST [-d C] [-s] | -c LIST [FILE]...` */
export async function builtin_cut(args: string[]): Promise<CommandEnvelope> {
  return filter_run('cut', args, cutArgs_parse(args), (ask: CutAsk, sources: FilterSource[]): string =>
    lines_join(cut_lines(ask, sources.flatMap((s: FilterSource): string[] => lines_split(s.text)))));
}
