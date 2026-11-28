/**
 * @file What a line asks to run on the machine it was typed on.
 *
 * A surface on another machine than its engine runs a host command, a pipeline segment or an editor when the
 * engine asks it to (`shellCommand`, `pipeSegment`, `localEdit`). The engine is across a wire: the surface must not
 * take its word for what to run. So before a line is sent, the surface reads from it what the engine will ask, by
 * the engine's own routing, and runs a request only against that (each grant once).
 *
 * The line is taken apart in the order the engine takes it apart (`core/engine.ts`, `line_execute_run`), with the
 * engine's own functions. Where the reader cannot establish what would be asked from the line alone, it grants
 * nothing, and a request that arrives is refused: an unfinished quote, a line sent to the background, a list (`;`,
 * `&&`, `||`), an assignment or capture, a redirect, a word holding a reference or a pattern the engine expands.
 *
 * Key components:
 * - LineHostOperations: the host commands, pipeline segments and edits a line may ask for.
 * - lineHostOperations_read: reads them from a line.
 *
 * Typical usage:
 * ```ts
 * const granted: LineHostOperations = await lineHostOperations_read('cat x | tr a b');
 * // { shells: [], pipes: [' tr a b'], edits: [] }
 * ```
 *
 * Dependencies: the engine's line parsers (preprocess, joblets, variables, semicolonParser, quoting, parser), the
 * command registry (which words are builtins), grep's and command's own renderings of what they hand the host.
 *
 * @module
 */

import { grepHostLine_read } from './grep.js';
import { word_quote } from './textFilters.js';
import { builtinCommand_has } from '../../core/commandRegistry.js';
import { jobletLine_parse } from '../../core/joblets.js';
import { command_shellEscape_detect, pipeSegment_word, pipes_parse, redirect_parse } from '../../core/preprocess.js';
import { assignment_parse } from '../../core/variables.js';
import { shellWords_tokenize, type ShellWord } from '../../lib/parser.js';
import { quoteOpen_find } from '../../lib/quoting.js';
import { commandList_parse } from '../../lib/semicolonParser.js';

/**
 * What one line may ask the machine it was typed on to run, each once, in the order the engine asks.
 *
 * @example
 * ```ts
 * const granted: LineHostOperations = { shells: ['ls -la'], pipes: [], edits: [] };
 * ```
 */
export interface LineHostOperations {
  /** Host commands (`!cmd`): exactly the command after the `!`. */
  readonly shells: readonly string[];
  /** Pipeline segments and delegated host lines, each exactly as the engine hands it over, in order. */
  readonly pipes: readonly string[];
  /** Files an `edit` line opens, by base name. */
  readonly edits: readonly string[];
}

/** A line that asks for nothing. */
const NOTHING: LineHostOperations = { shells: [], pipes: [], edits: [] };

/**
 * Whether a word is exactly what was typed: no reference the engine resolves, no pattern it expands.
 *
 * @param word - The word.
 * @returns True when the engine hands it on as typed.
 */
function word_isLiteral(word: ShellWord): boolean {
  return word.segments === undefined && !word.pathnameExpansion;
}

/**
 * The host line a builtin segment would delegate, when it is one that does (`grep` over piped text, `command`)
 * and its words are literal; null otherwise.
 *
 * @param segment - One segment, its leading word a builtin.
 * @returns The line it hands the host, or null.
 */
async function delegation_read(segment: string): Promise<string | null> {
  const words: ShellWord[] = shellWords_tokenize(segment);
  if (words.length === 0 || !words.every(word_isLiteral)) return null;
  const verb: string = words[0].value;
  const rest: ShellWord[] = words.slice(1);
  if (verb === 'grep') return grepHostLine_read(rest);
  if (verb === 'command' && rest.length > 0) return `command ${rest.map((word: ShellWord): string => word_quote(word.value)).join(' ')}`;
  return null;
}

/**
 * The file an `edit` line opens, by base name, when the line is exactly `edit <one literal operand>`.
 *
 * @param line - A plain line.
 * @returns The base name, or null.
 */
function editOperand_read(line: string): string | null {
  const words: ShellWord[] = shellWords_tokenize(line);
  if (words.length !== 2 || words[0].value !== 'edit') return null;
  const operand: ShellWord = words[1];
  if (!word_isLiteral(operand) || operand.value.startsWith('-')) return null;
  // Its base name, as posix basename gives it (trailing slashes dropped).
  const name: string = operand.value.replace(/\/+$/, '').split('/').pop() ?? '';
  return name === '' || name === '.' || name === '..' ? null : name;
}

/**
 * What a line may ask the machine it was typed on to run: a `!` line its one host command; a pipeline each later
 * segment that is not a builtin (exactly its text), and each builtin segment's delegated host line (`grep` over
 * piped text, `command`); a single `command` line its delegated line; an `edit <file>` line one edit of that file.
 * Anything the reader cannot establish from the line alone grants nothing.
 *
 * @param line - The line as it will be sent.
 * @returns What it may ask for.
 *
 * @example
 * ```ts
 * await lineHostOperations_read('!ls -la'); // { shells: ['ls -la'], pipes: [], edits: [] }
 * await lineHostOperations_read('cat x | wc -l'); // nothing: wc is a builtin
 * ```
 */
export async function lineHostOperations_read(line: string): Promise<LineHostOperations> {
  const trimmed: string = line.trim();
  if (trimmed.length === 0 || jobletLine_parse(trimmed) !== null) return NOTHING;
  if (command_shellEscape_detect(trimmed)) {
    const command: string = trimmed.substring(1).trim();
    return command.length > 0 ? { ...NOTHING, shells: [command] } : NOTHING;
  }
  if (quoteOpen_find(trimmed) !== null || commandList_parse(trimmed).length > 1 || assignment_parse(trimmed) !== null) return NOTHING;
  const segments: string[] = pipes_parse(trimmed);
  if (segments.length <= 1) {
    if (redirect_parse(trimmed) !== null) return NOTHING;
    const edit: string | null = editOperand_read(trimmed);
    if (edit !== null) return { ...NOTHING, edits: [edit] };
    const delegated: string | null = pipeSegment_word(trimmed) === 'command' ? await delegation_read(trimmed) : null;
    return delegated !== null ? { ...NOTHING, pipes: [delegated] } : NOTHING;
  }
  return { ...NOTHING, pipes: await pipeline_read(segments) };
}

/**
 * The host lines a pipeline asks for, in order: the head's delegation when it is `command`, then each later
 * segment's text when it is not a builtin, or its delegation when it is one that delegates.
 *
 * @param segments - The pipeline's segments, as the engine splits them.
 * @returns The host lines.
 */
async function pipeline_read(segments: readonly string[]): Promise<string[]> {
  const pipes: string[] = [];
  for (let at = 0; at < segments.length; at++) {
    const segment: string = segments[at] ?? '';
    const word: string = pipeSegment_word(segment);
    if (at > 0 && !(word !== '' && builtinCommand_has(word))) {
      pipes.push(segment);
      continue;
    }
    const delegated: string | null = await delegation_read(segment);
    if (delegated !== null) pipes.push(delegated);
  }
  return pipes;
}
