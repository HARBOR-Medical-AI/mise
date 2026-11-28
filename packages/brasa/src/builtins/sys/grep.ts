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
 * It takes grep's flags with grep's meanings: -i -v -w -E -F -c -e, and for
 * text and files -n -l -o -h -r -A -B -C, which a listing (whole rows) has no
 * use for and refuses by name. It is declared in one record, so any other
 * flag is refused by the parser. A file named is a ChRIS path, read through
 * the one store-path resolver (a folder walked under -r) and filtered here,
 * named as typed. Plain text in is the system grep where the surface can run
 * it, its line written back from the typed options, and filtered here where
 * it cannot; `command grep` skips this builtin altogether.
 *
 * Key components:
 * - grepCommand: the declaration.
 * - builtin_grep: the declaration run over words already split.
 * - grepExpression_build, grepMatcher_build: the expression, and the test a line passes.
 * - textSources_grep: the lines a grep over text writes, as GNU grep writes them.
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
import { errorStack, errno_words, type Result, type VFSItem, type VfsOutcome } from '@fnndsc/fond';
import {
  filterFile_read, filterRead_answer, filterSources_read, FILES_OPERAND, lines_join, lines_split, word_quote,
  type FilterRead, type FilterSource,
} from './textFilters.js';
import { storePath_resolve } from '../utils.js';
import { vfsDispatcher_get } from '../../core/filesystem.js';
import { itemType_isContainer } from '../../core/itemKinds.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { commandLine_parse, declaredCommand_run, type LineParse } from '../../core/commandParse.js';
import { listingIn_take, type ListingModel } from '../../core/listing.js';
import { answerKinds_get } from '../../core/answerKinds.js';
import { surface_get } from '../../core/surface.js';
import {
  answer_get, answerFilter_apply, answerNumbering_derive, answerOrdinals_attach, answerRow_key, answerRows_derive,
  handle_word, numberedFooter_render, type AnswerRow, type NumberedHandle,
} from '../../session/answer.js';
import { exitCode_set } from '../../core/handlerRun.js';
import type { ShellWord } from '../../lib/parser.js';

/**
 * What a grep line asks of a match: the flags that decide which lines (or
 * rows) are kept, and the patterns.
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

/**
 * How a grep line over text writes what it kept: the flags that mean
 * something for lines and files, and nothing for a numbered listing.
 *
 * @example
 * ```ts
 * const layout: GrepLayout = { ...GREP_LAYOUT_PLAIN, lineNumber: true, after: 2 };
 * ```
 */
export interface GrepLayout {
  /** -n: each line's number. */
  lineNumber: boolean;
  /** -l: only the names of files with a match. */
  filesWithMatches: boolean;
  /** -o: only the matching parts, one per line. */
  onlyMatching: boolean;
  /** -h: no file-name prefix. */
  noFilename: boolean;
  /** -H: the file-name prefix even for one file. */
  withFilename: boolean;
  /** --color[=WHEN], as given: the kernel writes no colour; the system grep is told. */
  color: string | undefined;
  /** -r: each folder operand walked for files. */
  recursive: boolean;
  /** -A N, as given. */
  after: number | undefined;
  /** -B N, as given. */
  before: number | undefined;
  /** -C N, as given. */
  context: number | undefined;
}

/**
 * The layout of a grep line that asks none: lines as they are.
 *
 * @example
 * ```ts
 * const layout: GrepLayout = { ...GREP_LAYOUT_PLAIN, onlyMatching: true };
 * ```
 */
export const GREP_LAYOUT_PLAIN: GrepLayout = {
  lineNumber: false, filesWithMatches: false, onlyMatching: false, noFilename: false, withFilename: false, recursive: false,
  after: undefined, before: undefined, context: undefined, color: undefined,
};

/** The switches of a grep line, as the line writes them back. */
const GREP_SWITCHES: ReadonlyArray<{ readonly letter: string; readonly on: (ask: GrepAsk, layout: GrepLayout) => boolean }> = [
  { letter: 'i', on: (ask: GrepAsk): boolean => ask.insensitive },
  { letter: 'v', on: (ask: GrepAsk): boolean => ask.invert },
  { letter: 'w', on: (ask: GrepAsk): boolean => ask.word },
  { letter: 'E', on: (ask: GrepAsk): boolean => ask.extended },
  { letter: 'F', on: (ask: GrepAsk): boolean => ask.fixed },
  { letter: 'c', on: (ask: GrepAsk): boolean => ask.count },
  { letter: 'n', on: (_ask: GrepAsk, layout: GrepLayout): boolean => layout.lineNumber },
  { letter: 'l', on: (_ask: GrepAsk, layout: GrepLayout): boolean => layout.filesWithMatches },
  { letter: 'o', on: (_ask: GrepAsk, layout: GrepLayout): boolean => layout.onlyMatching },
  { letter: 'h', on: (_ask: GrepAsk, layout: GrepLayout): boolean => layout.noFilename },
  { letter: 'H', on: (_ask: GrepAsk, layout: GrepLayout): boolean => layout.withFilename },
  { letter: 'r', on: (_ask: GrepAsk, layout: GrepLayout): boolean => layout.recursive },
];

/** The layout flags a numbered listing has no use for, each with why, as grep says it. */
const LISTING_REFUSALS: ReadonlyArray<{ readonly flag: string; readonly given: (layout: GrepLayout) => boolean; readonly why: string }> = [
  { flag: '-n', given: (layout: GrepLayout): boolean => layout.lineNumber, why: 'a listing\'s rows wear their handles, not line numbers' },
  { flag: '-l', given: (layout: GrepLayout): boolean => layout.filesWithMatches, why: 'a listing is not files to name' },
  { flag: '-o', given: (layout: GrepLayout): boolean => layout.onlyMatching, why: 'a listing keeps whole rows' },
  { flag: '-h', given: (layout: GrepLayout): boolean => layout.noFilename, why: 'a listing has no file names to drop' },
  { flag: '-H', given: (layout: GrepLayout): boolean => layout.withFilename, why: 'a listing has no file names to show' },
  { flag: '-r', given: (layout: GrepLayout): boolean => layout.recursive, why: 'a listing is not a folder to walk' },
  { flag: '-A', given: (layout: GrepLayout): boolean => layout.after !== undefined, why: 'a listing keeps a row with its group, not lines after it' },
  { flag: '-B', given: (layout: GrepLayout): boolean => layout.before !== undefined, why: 'a listing keeps a row with its group, not lines before it' },
  { flag: '-C', given: (layout: GrepLayout): boolean => layout.context !== undefined, why: 'a listing keeps a row with its group, not lines around it' },
];

/** What a `grep` line may hold. */
const GREP_GRAMMAR = {
  operands: [
    { name: 'pattern', kind: 'word', optional: true, unless: 'regexp', summary: 'The pattern, unless -e gives it' },
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
    lineNumber: { short: 'n', long: 'line-number', summary: 'Each line\'s number (text and files)' },
    filesWithMatches: { short: 'l', long: 'files-with-matches', summary: 'Only the names of files with a match' },
    onlyMatching: { short: 'o', long: 'only-matching', summary: 'Only the matching parts, one per line' },
    noFilename: { short: 'h', long: 'no-filename', summary: 'No file-name prefix' },
    withFilename: { short: 'H', long: 'with-filename', summary: 'The file-name prefix, even for one file' },
    color: { long: 'color', value: { name: 'when', kind: 'word', optional: true }, summary: 'Colour the matches (always, never, auto): the system grep colours; the session\'s own grep writes plain text' },
    recursive: { short: 'r', long: 'recursive', summary: 'Walk each folder for files (. when none is named)' },
    after: { short: 'A', long: 'after-context', value: { name: 'N', kind: 'int', min: 0 }, summary: 'N lines after each match' },
    before: { short: 'B', long: 'before-context', value: { name: 'N', kind: 'int', min: 0 }, summary: 'N lines before each match' },
    context: { short: 'C', long: 'context', value: { name: 'N', kind: 'int', min: 0 }, summary: 'N lines around each match' },
  },
} as const satisfies CommandGrammar;

/**
 * `grep [-ivwEFcnlohr] [-A N] [-B N] [-C N] [-e PATTERN]... [PATTERN] [FILE]...`: the declaration.
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
    description: 'Filters text, or a numbered listing keeping its handles. Fed a numbered listing (piped in, or the held one when nothing is piped), grep keeps rows: a matching row stays with the rows above it, a matched group keeps all of its rows, and every kept row keeps its handle (@SER41 stays @SER41). What it kept becomes the listing @ and ${listing} name; -c counts and changes nothing. A pattern matches a study\'s and a patient\'s own text too: grep -i t1 meant for series descriptions keeps a WHOLE study whose description says t1, and grep -i "mri brain" picking whole studies is the same rule. A file named is a ChRIS path, read here (- is the pipe; a wildcard matches paths); with several, each line or count is under its file\'s name as typed. -r walks each folder named (. when none is) for its files; links met on the way are not followed. -n numbers lines, -l names the files with a match, -o keeps only the matching parts, -h drops the names and -H keeps them for one file, --color colours the matches of the system grep (this one writes plain text), and -A, -B and -C show lines after, before and around each match, groups apart by --; a listing keeps whole rows, so these are refused for one. Text piped in is the system grep where the surface runs one, else filtered here with the same flags. With -e every word after the options is a file. A flag it does not take is refused; command grep runs the system grep.',
    category: 'Files',
    posix: { group: 'Files', differs: 'also filters numbered listings, keeping their handles (help grep)' },
    examples: [
      'query PatientID:1234567,Modality:MR | grep -i t1 | grep -vi gadavist',
      'grep -i -e t1 -e mprage',
      'gather list | grep -i sag | gather remove',
      'cat notes.txt | grep -c todo',
      'grep -c error a.log b.log',
      'grep -rn TODO notes',
      'grep -C 2 error run.log',
    ],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof GREP_GRAMMAR>): Promise<CommandEnvelope> => grep_run(args),
});

/**
 * A grep line written back from what it asks: its switches, its context
 * counts, then its patterns (each under -e when there are several, or one
 * starts with a dash).
 *
 * @param ask - What the grep line asks of a match.
 * @param layout - How it writes what it kept.
 * @returns The line, `grep -i -v -n -A 2 -e t1 -e t2`.
 */
function grepLine_render(ask: GrepAsk, layout: GrepLayout): string {
  const switches: string[] = GREP_SWITCHES.filter(({ on }): boolean => on(ask, layout)).map(({ letter }): string => `-${letter}`);
  const counts: string[] = [
    ...(layout.after !== undefined ? ['-A', String(layout.after)] : []),
    ...(layout.before !== undefined ? ['-B', String(layout.before)] : []),
    ...(layout.context !== undefined ? ['-C', String(layout.context)] : []),
    ...(layout.color === undefined ? [] : [layout.color === '' ? '--color' : `--color=${word_quote(layout.color)}`]),
  ];
  const lone: string | undefined = ask.patterns.length === 1 ? ask.patterns[0] : undefined;
  const patterns: string[] = lone !== undefined && !lone.startsWith('-')
    ? [word_quote(lone)]
    : ask.patterns.flatMap((pattern: string): string[] => ['-e', word_quote(pattern)]);
  return ['grep', ...switches, ...counts, ...patterns].join(' ');
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
 * Builds the expression a line (or a row's text) is matched by: any of the
 * patterns, read as grep reads them under -F, -E or neither, -w and -i.
 *
 * @param ask - What the grep line asks of a match.
 * @returns The expression (not global), or a refusal when a pattern does not compile.
 *
 * @example
 * ```ts
 * grepExpression_build({ ...ask, patterns: ['t1\\|t2'] }); // /(?:t1|t2)/
 * ```
 */
export function grepExpression_build(ask: GrepAsk): RegExp | { refused: string } {
  const sources: string[] = ask.patterns.map((pattern: string): string => {
    const source: string = ask.fixed ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : ask.extended ? pattern : basic_convertToSource(pattern);
    return ask.word ? `(?<![\\w])(?:${source})(?![\\w])` : `(?:${source})`;
  });
  try {
    return new RegExp(sources.join('|'), ask.insensitive ? 'i' : '');
  } catch (error: unknown) {
    return { refused: `grep: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Builds the test a line (or a row's text) passes.
 *
 * @param ask - What the grep line asks of a match.
 * @returns The test, or a refusal when a pattern does not compile.
 *
 * @example
 * ```ts
 * const matches = grepMatcher_build({ ...ask, patterns: ['T1'], word: true });
 * ```
 */
export function grepMatcher_build(ask: GrepAsk): ((text: string) => boolean) | { refused: string } {
  const built: RegExp | { refused: string } = grepExpression_build(ask);
  if (!(built instanceof RegExp)) return built;
  return (text: string): boolean => built.test(text);
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

/** What a grep over text read: its sources, what could not be read, and whether a folder was walked. */
interface GrepRead extends FilterRead {
  /** A folder was walked (-r), so each line is under its file's name. */
  walked: boolean;
}

/** What a grep over text wrote, and how many lines it kept. */
interface GrepAnswer {
  /** The output. */
  readonly text: string;
  /** Lines selected over every source, for the exit status. */
  readonly selected: number;
}

/**
 * The lines a grep over text writes for its sources, as GNU grep writes
 * them: `name:` before each line when named, `N:` under -n (`-` for a
 * context line), `--` between groups apart under -A, -B or -C; -l the
 * names with a match, -c a count each, -o the matching parts.
 *
 * @param expression - The match, compiled.
 * @param ask - What the line asks of a match.
 * @param layout - How it writes what it kept.
 * @param sources - The texts, under the names shown.
 * @param named - Whether each line is under its file's name.
 * @returns The output and how many lines were kept.
 *
 * @example
 * ```ts
 * textSources_grep(/b/, ask, GREP_LAYOUT_PLAIN, [{ name: null, text: 'a\nb\n' }], false).text; // 'b\n'
 * ```
 */
export function textSources_grep(
  expression: RegExp, ask: GrepAsk, layout: GrepLayout, sources: ReadonlyArray<FilterSource>, named: boolean,
): GrepAnswer {
  const after: number = layout.after ?? layout.context ?? 0;
  const before: number = layout.before ?? layout.context ?? 0;
  const grouped: boolean = (after > 0 || before > 0) && !layout.onlyMatching;
  const every: RegExp = new RegExp(expression.source, `${expression.flags.replace('g', '')}g`);
  const out: string[] = [];
  let selected: number = 0;
  let printedAny: boolean = false;
  for (const source of sources) {
    const name: string = source.name === '-' || source.name === null ? '(standard input)' : source.name;
    const lines: string[] = lines_split(source.text);
    const hits: boolean[] = lines.map((line: string): boolean => expression.test(line) !== ask.invert);
    const kept: number = hits.filter((hit: boolean): boolean => hit).length;
    selected += kept;
    if (layout.filesWithMatches) { if (kept > 0) out.push(name); continue; }
    if (ask.count) { out.push(named ? `${name}:${kept}` : String(kept)); continue; }
    const prefix = (at: number, mark: string): string => `${named ? `${name}${mark}` : ''}${layout.lineNumber ? `${at + 1}${mark}` : ''}`;
    if (layout.onlyMatching) {
      // Under -v the kept lines are those with no match: no part to show.
      if (ask.invert) continue;
      lines.forEach((line: string, at: number): void => {
        for (const match of line.matchAll(every)) if (match[0] !== '') out.push(`${prefix(at, ':')}${match[0]}`);
      });
      continue;
    }
    const shown: boolean[] = lines.map((): boolean => false);
    hits.forEach((hit: boolean, at: number): void => {
      if (!hit) return;
      for (let near: number = Math.max(0, at - before); near <= Math.min(lines.length - 1, at + after); near++) shown[near] = true;
    });
    let last: number = -2;
    lines.forEach((line: string, at: number): void => {
      if (!shown[at]) return;
      if (grouped && printedAny && at !== last + 1) out.push('--');
      out.push(`${prefix(at, hits[at] === true ? ':' : '-')}${line}`);
      printedAny = true;
      last = at;
    });
  }
  return { text: lines_join(out), selected };
}

/**
 * Walks a folder for its files, depth first: each file read under its name
 * as shown (the folder as typed, then the names below it). A link met on the
 * way is not followed, as grep -r does not.
 *
 * @param store - The folder's store path.
 * @param shown - The folder as the output names it; empty for the working directory unnamed.
 * @param read - Where the files and the errors go.
 */
async function folder_walk(store: string, shown: string, read: FilterRead): Promise<void> {
  const mark: number = errorStack.checkpoint_mark();
  const listed: Result<VFSItem[]> = await vfsDispatcher_get().list(store);
  errorStack.checkpoint_drain(mark);
  if (!listed.ok) {
    read.errors += `grep: ${shown || '.'}: cannot list the folder\n`;
    return;
  }
  for (const item of listed.value) {
    const childStore: string = store === '/' ? `/${item.name}` : `${store}/${item.name}`;
    const childShown: string = shown === '' ? item.name : `${shown}/${item.name}`;
    if (itemType_isContainer(item.type)) { await folder_walk(childStore, childShown, read); continue; }
    if (item.type === 'link') continue;
    const file: VfsOutcome<string> = await vfsDispatcher_get().read(childStore);
    if (file.ok) read.sources.push({ name: childShown, text: file.value });
    else read.errors += `grep: ${childShown}: ${file.reason ?? errno_words(file.errno)}\n`;
  }
}

/**
 * Reads what grep -r works on: each operand a file, or a folder walked for
 * its files (`-` is the pipe); no operand walks the working directory, its
 * files named below it.
 *
 * @param operands - The operands, as typed.
 * @returns The files read, under the names shown, and whether a folder was walked.
 */
async function recursiveSources_read(operands: ReadonlyArray<string>): Promise<GrepRead> {
  const piped: string | null = stdin_take();
  const read: GrepRead = { sources: [], errors: '', walked: false };
  if (operands.length === 0) {
    read.walked = true;
    await folder_walk(await storePath_resolve('.'), '', read);
    return read;
  }
  for (const operand of operands) {
    if (operand === '-') { read.sources.push({ name: '-', text: piped ?? '' }); continue; }
    const file: FilterSource | { error: string } = await filterFile_read('grep', operand);
    if (!('error' in file)) { read.sources.push(file); continue; }
    const store: string = await storePath_resolve(operand);
    const mark: number = errorStack.checkpoint_mark();
    const listed: Result<VFSItem[]> = await vfsDispatcher_get().list(store);
    errorStack.checkpoint_drain(mark);
    if (!listed.ok) { read.errors += file.error; continue; }
    read.walked = true;
    await folder_walk(store, operand.length > 1 ? operand.replace(/\/+$/, '') : operand, read);
  }
  return read;
}

/**
 * grep over text it filters itself: ChRIS files (each read through the one
 * store-path resolver, a folder walked under -r) or the piped text, named
 * as typed.
 *
 * @param ask - What the grep line asks of a match.
 * @param layout - How it writes what it kept.
 * @param files - The file operands (`-` is the pipe); none, with text piped, for the pipe alone.
 * @returns The envelope; exit 1 when no line was kept.
 */
async function sources_grep(ask: GrepAsk, layout: GrepLayout, files: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const built: RegExp | { refused: string } = grepExpression_build(ask);
  if (!(built instanceof RegExp)) {
    exitCode_set(1);
    return envelope_error('', undefined, `${built.refused}\n`);
  }
  let read: GrepRead;
  if (layout.recursive) {
    read = await recursiveSources_read(files);
  } else {
    const plain: FilterRead | { refusal: string } = await filterSources_read('grep', files);
    if ('refusal' in plain) return envelope_error('', undefined, `${plain.refusal}\n`);
    read = { ...plain, walked: false };
  }
  let selected: number = 0;
  const envelope: CommandEnvelope = filterRead_answer(read, (sources: FilterSource[]): string => {
    const named: boolean = layout.withFilename || (!layout.noFilename && (sources.length > 1 || read.walked));
    const answer: GrepAnswer = textSources_grep(built, ask, layout, sources, named);
    selected = answer.selected;
    return answer.text;
  });
  if (selected === 0) exitCode_set(1);
  return envelope;
}

/**
 * Plain grep on piped text: the system's, its line written back from the
 * typed options, where the surface runs host programs; otherwise this
 * grep's own filter, with the same flags.
 *
 * @param text - The text piped in.
 * @param ask - What the grep line asks of a match.
 * @param layout - How it writes what it kept.
 * @returns The envelope.
 */
async function text_grep(text: string, ask: GrepAsk, layout: GrepLayout): Promise<CommandEnvelope> {
  const surface = surface_get();
  if (surface.capabilities.pipeSegments) {
    const out: Buffer = await surface.pipeSegment(grepLine_render(ask, layout), Buffer.from(text, 'utf-8'));
    return envelope_ok(out.toString('utf-8'));
  }
  const built: RegExp | { refused: string } = grepExpression_build(ask);
  if (!(built instanceof RegExp)) return envelope_error('', undefined, `${built.refused}\n`);
  const answer: GrepAnswer = textSources_grep(built, ask, layout, [{ name: null, text }], false);
  if (answer.selected === 0) exitCode_set(1);
  return envelope_ok(answer.text);
}

/**
 * The refusal of a layout flag a numbered listing has no use for, or null.
 *
 * @param layout - How the line asks to write what it kept.
 * @returns The envelope that says so, or null when the line asks none.
 */
function listingLayout_refuse(layout: GrepLayout): CommandEnvelope | null {
  const refused: { flag: string; why: string } | undefined = LISTING_REFUSALS.find(({ given }): boolean => given(layout));
  if (refused === undefined) return null;
  exitCode_set(1);
  return envelope_error('', undefined, `grep ${refused.flag}: ${refused.why}\n`);
}

/** What a grep line asks of a match, and how it writes what it kept. */
interface GrepLine {
  /** What it asks of a match. */
  ask: GrepAsk;
  /** How it writes what it kept. */
  layout: GrepLayout;
}

/**
 * What a typed grep line asks and how it writes: one reading, for the run and for a reader that must know what the
 * run would hand to the host's grep.
 *
 * @param args - The parsed line.
 * @returns Its ask and layout.
 */
function grepLine_read(args: CommandArguments<typeof GREP_GRAMMAR>): GrepLine {
  const given: string[] = args.options.regexp;
  const pattern: string | undefined = args.operands.pattern;
  return {
    ask: {
      insensitive: args.options.insensitive, invert: args.options.invert, word: args.options.word,
      extended: args.options.extended, fixed: args.options.fixed, count: args.options.count,
      patterns: given.length > 0 ? given : pattern === undefined ? [] : [pattern],
    },
    layout: {
      lineNumber: args.options.lineNumber, filesWithMatches: args.options.filesWithMatches, onlyMatching: args.options.onlyMatching,
      noFilename: args.options.noFilename, withFilename: args.options.withFilename, recursive: args.options.recursive,
      after: args.options.after, before: args.options.before, context: args.options.context, color: args.options.color,
    },
  };
}

/**
 * The line a grep segment would hand to the host's grep, when it filters piped text there (`text_grep`): rendered
 * from the segment's own words by the run's own reading and rendering, so it is exactly what the engine would
 * send. Null when the segment would not (files named, recursive, no pattern) or the line does not parse.
 *
 * @param words - The words after `grep`, as the engine tokenizes them.
 * @returns The host line, or null.
 *
 * @example
 * ```ts
 * await grepHostLine_read(shellWords_tokenize('-i t1')); // 'grep -i t1'
 * ```
 */
export async function grepHostLine_read(words: readonly ShellWord[]): Promise<string | null> {
  const parsed: LineParse = await commandLine_parse(grepCommand, words);
  if (!parsed.ok) return null;
  const args: CommandArguments<typeof GREP_GRAMMAR> = parsed.args as unknown as CommandArguments<typeof GREP_GRAMMAR>;
  const { ask, layout } = grepLine_read(args);
  if (ask.patterns.length === 0 || args.operands.files.length > 0 || layout.recursive) return null;
  return grepLine_render(ask, layout);
}

/**
 * The typed grep line run: the files named (or walked under -r), else a
 * piped listing, else piped text, else the held listing.
 *
 * @param args - The typed line.
 * @returns The envelope.
 */
async function grep_run(args: CommandArguments<typeof GREP_GRAMMAR>): Promise<CommandEnvelope> {
  const files: string[] = args.operands.files;
  const { ask, layout } = grepLine_read(args);
  if (ask.patterns.length === 0) return envelope_error('', undefined, 'grep: a pattern to keep: grep [-ivwEFc] [-e PATTERN] PATTERN\n');
  const piped: ListingModel | null = listingIn_take();
  if (piped !== null && files.length === 0) {
    stdin_take();
    return listingLayout_refuse(layout) ?? listing_grep({ ...piped, source: '' }, ask, grepLine_render(ask, layout));
  }
  if (files.length > 0 || layout.recursive) return sources_grep(ask, layout, files);
  const text: string | null = stdin_take();
  if (text !== null) return text_grep(text, ask, layout);
  // Nothing piped: the held listing, as an index reads it.
  const held = answer_get();
  if (held === null) return envelope_error('', undefined, 'grep: nothing to filter: pipe text or a listing in, or list something first (query, ls, gather list)\n');
  return listingLayout_refuse(layout) ?? listing_grep({ kind: held.kind, data: held.data, source: held.source }, ask, grepLine_render(ask, layout));
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
