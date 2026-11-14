/**
 * @file grep: the system's grep on text, and a grep that knows numbered
 * listings (#1100).
 *
 * Fed a numbered listing (a PACS answer, `ls`, the cohort; piped in, or the
 * held one when nothing is piped), grep keeps rows rather than lines: a row
 * that matches stays with its parents for context, a matched group (a study,
 * a patient) keeps all of its rows, and every kept row keeps the handle it
 * wore — `@SER41` stays `@SER41`. The kept rows become the held listing, so
 * `gather add @SER41` and `${listing}` read what grep left.
 *
 * It takes grep's own flags only, with grep's meanings: -i -v -w -E -F -c
 * and -e; it is declared in one record, so any other flag is refused by the
 * parser. A file named is a ChRIS path, read through the one store-path
 * resolver and filtered here, as the text filters read theirs. Plain text in
 * is the system grep where the surface can run it, its line written back
 * from the typed options; `command grep` skips this builtin altogether.
 *
 * Key components:
 * - grepCommand: the declaration.
 * - builtin_grep: the declaration run over words already split.
 * - grepMatcher_build: the test a line passes.
 * - listingRows_grep: the rows a grep keeps of a listing.
 *
 * Typical usage:
 * ```ts
 * await builtin_grep(['-i', 't1']);
 * await builtin_grep(['-c', 'todo', 'notes.txt']);
 * ```
 *
 * Dependencies: the held and piped listings, the session's filesystem (via
 * the text filters' reader), and the surface's system grep.
 *
 * @module
 */
import chalk from 'chalk';
import { envelope_ok, envelope_error, type CommandEnvelope } from '@fnndsc/menu';

import { stdin_take } from '../games/stdin.js';
import { filter_run, FILES_OPERAND, lines_join, lines_split, word_quote, type FilterSource } from './textFilters.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { listingIn_take, type ListingModel } from '../../core/listing.js';
import { answerKinds_get } from '../../core/answerKinds.js';
import { surface_get } from '../../core/surface.js';
import {
  answer_get, answerFilter_apply, answerNumbering_derive, answerOrdinals_attach, answerRow_key, answerRows_derive,
  handle_word, numberedFooter_render, type AnswerRow, type NumberedHandle,
} from '../../session/answer.js';
import { exitCode_set } from '../../core/handlerRun.js';

/**
 * What a grep line asks.
 *
 * @example
 * ```ts
 * const ask: GrepAsk = { insensitive: true, invert: false, word: false, extended: false, fixed: false, count: false, patterns: ['t1'] };
 * ```
 */
export interface GrepAsk {
  /** -i: ignore case. */
  insensitive: boolean;
  /** -v: keep what does not match. */
  invert: boolean;
  /** -w: whole words. */
  word: boolean;
  /** -E: extended regular expressions. */
  extended: boolean;
  /** -F: fixed strings. */
  fixed: boolean;
  /** -c: count only. */
  count: boolean;
  /** The patterns: any of them matches. */
  patterns: string[];
}

/** The switches of a grep line, as the line writes them back. */
const GREP_SWITCHES: ReadonlyArray<{ readonly letter: string; readonly key: 'insensitive' | 'invert' | 'word' | 'extended' | 'fixed' | 'count' }> = [
  { letter: 'i', key: 'insensitive' }, { letter: 'v', key: 'invert' }, { letter: 'w', key: 'word' },
  { letter: 'E', key: 'extended' }, { letter: 'F', key: 'fixed' }, { letter: 'c', key: 'count' },
];

/** What a `grep` line may hold. */
const GREP_GRAMMAR = {
  operands: [
    { name: 'pattern', kind: 'word', optional: true, summary: 'The pattern; with -e, the first file' },
    FILES_OPERAND,
  ],
  options: {
    insensitive: { short: 'i', long: 'ignore-case', summary: 'Ignore case' },
    invert: { short: 'v', long: 'invert-match', summary: 'Keep what does not match' },
    word: { short: 'w', long: 'word-regexp', summary: 'Whole words' },
    extended: { short: 'E', long: 'extended-regexp', summary: 'Extended regular expressions' },
    fixed: { short: 'F', long: 'fixed-strings', summary: 'Fixed strings' },
    count: { short: 'c', long: 'count', summary: 'Count only' },
    regexp: { short: 'e', long: 'regexp', repeat: true, value: { name: 'pattern', kind: 'word' }, summary: 'A pattern (repeatable: any of them matches)' },
  },
} as const satisfies CommandGrammar;

/**
 * `grep [-ivwEFc] [-e PATTERN]... [PATTERN] [FILE]...`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [grepCommand] });
 * ```
 */
export const grepCommand = command_declare({
  name: 'grep',
  grammar: GREP_GRAMMAR,
  help: {
    summary: 'Keep the lines, or the rows of a numbered listing, that match',
    description: 'Filters text, or a numbered listing keeping its handles. Fed a numbered listing (piped in, or the held one when nothing is piped), grep keeps rows: a matching row stays with the rows above it, a matched group keeps all of its rows, and every kept row keeps its handle (@SER41 stays @SER41). What it kept becomes the listing @ and ${listing} name; -c counts and changes nothing. A pattern matches a study\'s and a patient\'s own text too: grep -i t1 meant for series descriptions keeps a WHOLE study whose description says t1, and grep -i "mri brain" picking whole studies is the same rule. A file named is a ChRIS path, read here (- is the pipe); with several, each line or count is under its file\'s name. Text piped in is the system grep where the surface runs one, else filtered here with the same flags. With -e, the first word after the options is a file, not a pattern. A flag it does not take is refused; command grep runs the system grep.',
    category: 'Files',
    posix: { group: 'Files', differs: 'also filters numbered listings, keeping their handles (help grep)' },
    examples: [
      'query PatientID:1234567,Modality:MR | grep -i t1 | grep -vi gadavist',
      'grep -i -e t1 -e mprage',
      'gather list | grep -i sag | gather remove',
      'cat notes.txt | grep -c todo',
      'grep -c error a.log b.log',
    ],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof GREP_GRAMMAR>): Promise<CommandEnvelope> => grep_run(args),
});

/**
 * A grep line written back from what it asks: its switches, then its
 * patterns (each under -e when there are several, or one starts with a dash).
 *
 * @param ask - What the grep line asks.
 * @returns The line, `grep -i -v -e t1 -e t2`.
 */
function grepLine_render(ask: GrepAsk): string {
  const switches: string[] = GREP_SWITCHES.filter(({ key }): boolean => ask[key]).map(({ letter }): string => `-${letter}`);
  const lone: string | undefined = ask.patterns.length === 1 ? ask.patterns[0] : undefined;
  const patterns: string[] = lone !== undefined && !lone.startsWith('-')
    ? [word_quote(lone)]
    : ask.patterns.flatMap((pattern: string): string[] => ['-e', word_quote(pattern)]);
  return ['grep', ...switches, ...patterns].join(' ');
}

/**
 * A basic regular expression (grep's default) as a JavaScript one: in a BRE
 * `\|` `\(` `\)` `\{` `\}` `\+` `\?` are the operators and the bare
 * characters are literal.
 *
 * @param pattern - The BRE.
 * @returns The equivalent JavaScript source.
 */
function basic_convertToSource(pattern: string): string {
  let out: string = '';
  for (let at: number = 0; at < pattern.length; at++) {
    const char: string = pattern[at] ?? '';
    if (char === '\\' && at + 1 < pattern.length) {
      const next: string = pattern[at + 1] ?? '';
      out += '|(){}+?'.includes(next) ? next : `\\${next}`;
      at += 1;
    } else {
      out += '|(){}+?'.includes(char) ? `\\${char}` : char;
    }
  }
  return out;
}

/**
 * Builds the test a line (or a row's text) passes.
 *
 * @param ask - What the grep line asks.
 * @returns The test, or a refusal when a pattern does not compile.
 */
export function grepMatcher_build(ask: GrepAsk): ((text: string) => boolean) | { refused: string } {
  const sources: string[] = ask.patterns.map((pattern: string): string => {
    const source: string = ask.fixed ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : ask.extended ? pattern : basic_convertToSource(pattern);
    return ask.word ? `(?<![\\w])(?:${source})(?![\\w])` : `(?:${source})`;
  });
  try {
    const expression: RegExp = new RegExp(sources.join('|'), ask.insensitive ? 'i' : '');
    return (text: string): boolean => expression.test(text);
  } catch (error: unknown) {
    return { refused: `grep: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Which rows a grep keeps of a listing: a matching row with its parents, a
 * matched group with all its rows; under -v the matching rows (and a
 * matched group's rows) go, and a group stays while any of its rows does.
 *
 * @param rows - The listing's rows, in order.
 * @param matches - The test.
 * @param invert - grep -v.
 * @returns The kept rows, in order.
 */
export function listingRows_grep(rows: ReadonlyArray<AnswerRow>, matches: (text: string) => boolean, invert: boolean): AnswerRow[] {
  const byKey: Map<string, AnswerRow> = new Map(rows.map((row: AnswerRow): [string, AnswerRow] => [answerRow_key(row), row]));
  const ancestors = (row: AnswerRow): AnswerRow[] => {
    const chain: AnswerRow[] = [];
    let parent: AnswerRow | undefined = row.parent === undefined ? undefined : byKey.get(row.parent);
    while (parent !== undefined && !chain.includes(parent)) {
      chain.push(parent);
      parent = parent.parent === undefined ? undefined : byKey.get(parent.parent);
    }
    return chain;
  };
  const hit = (row: AnswerRow): boolean => matches(row.text ?? row.label);
  // A row is caught by its own match or a matched group above it.
  const caught = (row: AnswerRow): boolean => hit(row) || ancestors(row).some(hit);
  const hasChildren: Set<string> = new Set(rows.flatMap((row: AnswerRow): string[] => (row.parent === undefined ? [] : [row.parent])));
  const kept: Set<string> = new Set();
  if (!invert) {
    for (const row of rows) {
      if (!caught(row)) continue;
      kept.add(answerRow_key(row));
      for (const parent of ancestors(row)) kept.add(answerRow_key(parent));
    }
  } else {
    for (const row of rows) {
      if (caught(row) || hasChildren.has(answerRow_key(row))) continue;
      kept.add(answerRow_key(row));
      for (const parent of ancestors(row)) kept.add(answerRow_key(parent));
    }
    // A group with no rows of its own stays when it is not caught.
    for (const row of rows) {
      const key: string = answerRow_key(row);
      if (!caught(row) && !hasChildren.has(key) && row.parent === undefined) kept.add(key);
    }
  }
  return rows.filter((row: AnswerRow): boolean => kept.has(answerRow_key(row)));
}

/** What a listing kind is called in grep's footer. */
const LISTING_WORDS: Readonly<Record<string, string>> = { 'pacs.query': 'PACS answer', 'fs.listing': 'listing', 'gather.cohort': 'cohort' };

/** A leaf kind's plural, for the count. */
const KIND_PLURALS: Readonly<Record<string, string>> = { SER: 'series', FIL: 'files', DIR: 'folders' };

/**
 * Filters a listing and says what was kept, in the listing's own shape.
 *
 * @param listing - The listing: its kind, model, and the line that made it.
 * @param ask - What the grep line asks.
 * @param line - The grep line itself, for the footer.
 * @returns The envelope: the kept rows with their handles, and the filtered model.
 */
function listing_grep(listing: ListingModel & { source: string }, ask: GrepAsk, line: string): CommandEnvelope {
  const built = grepMatcher_build(ask);
  if (typeof built !== 'function') return envelope_error('', undefined, `${built.refused}\n`);
  const rows: AnswerRow[] = answerRows_derive(listing.kind, listing.data) ?? [];
  const numbered: NumberedHandle[] = answerNumbering_derive(listing.kind, listing.data) ?? [];
  const kept: AnswerRow[] = listingRows_grep(rows, built, ask.invert);
  const groups: Set<string> = new Set(answerKinds_get().filter((kind): boolean => kind.group === true).map((kind): string => kind.code));
  const leaves = (list: ReadonlyArray<AnswerRow>): AnswerRow[] => list.filter((row: AnswerRow): boolean => !groups.has(row.kind));
  if (ask.count) return envelope_ok(`${leaves(kept).length}\n`);

  const ordinalOf: Map<string, number> = new Map(rows.map((row: AnswerRow, at: number): [string, number] => [answerRow_key(row), numbered[at]?.ordinal ?? 0]));
  const keptKeys: Set<string> = new Set(kept.map(answerRow_key));
  const keptHandles: NumberedHandle[] = kept.map((row: AnswerRow): NumberedHandle => ({ kind: row.kind, ordinal: ordinalOf.get(answerRow_key(row)) ?? 0, address: row.address ?? row.values[0] ?? '' }));
  const width: number = Math.max(0, ...keptHandles.map((handle: NumberedHandle): number => handle_word(handle).length));
  const depthOf = (row: AnswerRow): number => {
    let depth: number = 0;
    let parent: string | undefined = row.parent;
    while (parent !== undefined && depth < 8) {
      const up: AnswerRow | undefined = rows.find((one: AnswerRow): boolean => answerRow_key(one) === parent);
      if (up === undefined) break;
      depth += 1;
      parent = up.parent;
    }
    return depth;
  };
  const lines: string[] = kept.map((row: AnswerRow, at: number): string =>
    `${'  '.repeat(depthOf(row) + 1)}${chalk.cyan(handle_word(keptHandles[at] as NumberedHandle).padEnd(width))}  ${row.text ?? row.label}`);
  const leafKinds: string[] = [...new Set(leaves(rows).map((row: AnswerRow): string => row.kind))];
  const plural: string = leafKinds.length === 1 ? KIND_PLURALS[leafKinds[0] ?? ''] ?? 'rows' : 'rows';
  const what: string = `${LISTING_WORDS[listing.kind] ?? listing.kind}${listing.source !== '' ? `: ${listing.source}` : ''}`;
  const tally: string = `${leaves(kept).length} of ${leaves(rows).length} ${plural} kept (${line}; ${what})`;
  const footer: string = numberedFooter_render(keptHandles);
  const rendered: string = `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}${chalk.gray(`  ${tally}`)}\n${footer !== '' ? `${chalk.gray(`  ${footer}`)}\n` : ''}`;
  // grep's own status: no match is exit 1, and an empty listing replaces nothing.
  if (leaves(kept).length === 0) exitCode_set(1);

  const filtered: unknown = answerFilter_apply(listing.kind, listing.data, keptKeys);
  if (filtered === null || typeof filtered !== 'object') return envelope_ok(rendered);
  // The kept rows keep the numbers they wore, wherever the listing goes next.
  answerOrdinals_attach(filtered, new Map([...keptKeys].map((key: string): [string, number] => [key, ordinalOf.get(key) ?? 0])));
  return envelope_ok(rendered, { kind: listing.kind, data: filtered });
}

/**
 * Plain grep on text: the system's, where the surface runs host programs;
 * otherwise this grep's own line filter, with the same flags.
 *
 * @param text - The text piped in.
 * @param ask - What the grep line asks.
 * @returns The envelope.
 */
async function text_grep(text: string, ask: GrepAsk): Promise<CommandEnvelope> {
  const surface = surface_get();
  if (surface.capabilities.pipeSegments) {
    const out: Buffer = await surface.pipeSegment(grepLine_render(ask), Buffer.from(text, 'utf-8'));
    return envelope_ok(out.toString('utf-8'));
  }
  const built = grepMatcher_build(ask);
  if (typeof built !== 'function') return envelope_error('', undefined, `${built.refused}\n`);
  const lines: string[] = text.replace(/\n$/, '').split('\n').filter((line: string): boolean => built(line) !== ask.invert);
  if (lines.length === 0) exitCode_set(1);
  return envelope_ok(ask.count ? `${lines.length}\n` : lines.length > 0 ? `${lines.join('\n')}\n` : '');
}

/**
 * grep over ChRIS files: this grep's own line filter, each file read through
 * the one store-path resolver. With several files each line (or count) is
 * under its file's name, as grep writes it.
 *
 * @param ask - What the grep line asks.
 * @param files - The files (`-` is the pipe).
 * @returns The envelope; exit 1 when no line was kept.
 */
async function files_grep(ask: GrepAsk, files: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const built = grepMatcher_build(ask);
  if (typeof built !== 'function') {
    exitCode_set(1);
    return envelope_error('', undefined, `${built.refused}\n`);
  }
  let selected: number = 0;
  const envelope: CommandEnvelope = await filter_run('grep', files, (sources: FilterSource[]): string => {
    const named: boolean = sources.length > 1;
    const out: string[] = [];
    for (const source of sources) {
      const name: string = source.name === '-' || source.name === null ? '(standard input)' : source.name;
      const kept: string[] = lines_split(source.text).filter((line: string): boolean => built(line) !== ask.invert);
      selected += kept.length;
      if (ask.count) out.push(named ? `${name}:${kept.length}` : String(kept.length));
      else out.push(...kept.map((line: string): string => (named ? `${name}:${line}` : line)));
    }
    return lines_join(out);
  });
  if (selected === 0) exitCode_set(1);
  return envelope;
}

/**
 * The typed grep line run: the files named, else a piped listing, else
 * piped text, else the held listing.
 *
 * @param args - The typed line.
 * @returns The envelope.
 */
async function grep_run(args: CommandArguments<typeof GREP_GRAMMAR>): Promise<CommandEnvelope> {
  const given: string[] = args.options.regexp;
  const pattern: string | undefined = args.operands.pattern;
  // With -e the patterns are said; the first word after the options is a file.
  const files: string[] = given.length > 0 && pattern !== undefined ? [pattern, ...args.operands.files] : args.operands.files;
  const ask: GrepAsk = {
    insensitive: args.options.insensitive, invert: args.options.invert, word: args.options.word,
    extended: args.options.extended, fixed: args.options.fixed, count: args.options.count,
    patterns: given.length > 0 ? given : pattern === undefined ? [] : [pattern],
  };
  if (ask.patterns.length === 0) return envelope_error('', undefined, 'grep: a pattern to keep: grep [-ivwEFc] [-e PATTERN] PATTERN\n');
  const piped: ListingModel | null = listingIn_take();
  if (files.length > 0) return files_grep(ask, files);
  const text: string | null = stdin_take();
  const line: string = grepLine_render(ask);
  if (piped !== null) return listing_grep({ ...piped, source: '' }, ask, line);
  if (text !== null) return text_grep(text, ask);
  // Nothing piped: the held listing, as an index reads it.
  const held = answer_get();
  if (held === null) return envelope_error('', undefined, 'grep: nothing to filter: pipe text or a listing in, or list something first (query, ls, gather list)\n');
  return listing_grep({ kind: held.kind, data: held.data, source: held.source }, ask, line);
}

/**
 * `grep` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `grep`.
 * @returns The envelope, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_grep(['-i', 't1']);
 * ```
 */
export async function builtin_grep(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(grepCommand, args);
}
