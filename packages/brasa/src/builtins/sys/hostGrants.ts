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
import { args_checkHasHelpFlag } from '../help.js';

/**
 * One pipeline line a line may ask for: its text exactly, and whether the engine always asks for it when the line
 * runs that far (a segment that leaves the engine) or only may (a builtin's delegation, which depends on its input).
 *
 * @example
 * ```ts
 * const grant: PipeGrant = { command: 'tr a b', required: true };
 * ```
 */
export interface PipeGrant {
  /** The line exactly as the engine hands it over. */
  readonly command: string;
  /** True when the engine asks for it whenever the line gets this far; false when it may not. */
  readonly required: boolean;
}

/**
 * Which words run in the engine of the session a line is sent to (its builtins), as that session says; null when
 * it has not said, and then no pipeline routing can be established.
 */
export type EngineRuns = ((word: string) => boolean) | null;

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
  readonly pipes: readonly PipeGrant[];
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
 * and its words are literal, and it would not stop at its help (`--help`, `-h`); null otherwise.
 *
 * @param segment - One segment, its leading word a builtin.
 * @returns The line it hands the host, or null.
 */
async function delegation_read(segment: string): Promise<string | null> {
  const words: ShellWord[] = shellWords_tokenize(segment);
  if (words.length === 0 || !words.every(word_isLiteral)) return null;
  const verb: string = words[0].value;
  const rest: ShellWord[] = words.slice(1);
  if (args_checkHasHelpFlag(rest.map((word: ShellWord): string => word.value), verb)) return null;
  if (verb === 'grep') return grepHostLine_read(rest);
  if (verb === 'command' && rest.length > 0) return `command ${rest.map((word: ShellWord): string => word_quote(word.value)).join(' ')}`;
  return null;
}

/**
 * The file an `edit` line opens, as typed (quoting removed), when the line is exactly `edit <one literal operand>`.
 *
 * @param line - A plain line.
 * @returns The operand, or null.
 */
function editOperand_read(line: string): string | null {
  const words: ShellWord[] = shellWords_tokenize(line);
  if (words.length !== 2 || words[0].value !== 'edit') return null;
  const operand: ShellWord = words[1];
  if (!word_isLiteral(operand) || operand.value.startsWith('-') || operand.value.length === 0) return null;
  return operand.value;
}

/**
 * What a line may ask the machine it was typed on to run: a `!` line its one host command; a pipeline each later
 * segment the session's engine does not run (exactly its text, required) and each builtin's delegated host line
 * (`grep` over piped text, `command`; optional); a single `command` line its delegated line; an `edit <file>` line
 * one edit of that file. Anything the reader cannot establish from the line and the session's own word list grants
 * nothing: a line sent elsewhere, a list, a capture, a redirect, a segment holding a reference, an empty segment.
 *
 * @param line - The line as it will be sent.
 * @param engineRuns - Which words the session's engine runs itself, as it said at attach; null when it did not say.
 * @returns What it may ask for.
 *
 * @example
 * ```ts
 * await lineHostOperations_read('!ls -la'); // { shells: ['ls -la'], pipes: [], edits: [] }
 * await lineHostOperations_read('cat x | wc -l'); // nothing: wc is a builtin
 * ```
 */
export async function lineHostOperations_read(line: string, engineRuns: EngineRuns = builtinCommand_has): Promise<LineHostOperations> {
  const trimmed: string = line.trim();
  if (trimmed.length === 0 || jobletLine_parse(trimmed) !== null) return NOTHING;
  if (command_shellEscape_detect(trimmed)) {
    const command: string = trimmed.substring(1).trim();
    return command.length > 0 ? { ...NOTHING, shells: [command] } : NOTHING;
  }
  if (quoteOpen_find(trimmed) !== null || commandList_parse(trimmed).length > 1 || assignment_parse(trimmed) !== null) return NOTHING;
  const segments: string[] = pipes_parse(trimmed);
  if (segments.length <= 1) return plainLine_read(trimmed);
  if (engineRuns === null) return NOTHING;
  const pipes: PipeGrant[] | null = await pipeline_read(segments, engineRuns);
  return pipes === null ? NOTHING : { ...NOTHING, pipes };
}

/**
 * What a plain line (one command, no pipe) may ask for: nothing for a redirect, one edit for `edit <file>`, its
 * delegated line for `command …`.
 *
 * @param line - The trimmed line.
 * @returns What it may ask for.
 */
async function plainLine_read(line: string): Promise<LineHostOperations> {
  if (redirect_parse(line) !== null) return NOTHING;
  const edit: string | null = editOperand_read(line);
  if (edit !== null) return { ...NOTHING, edits: [edit] };
  const delegated: string | null = pipeSegment_word(line) === 'command' ? await delegation_read(line) : null;
  return delegated !== null ? { ...NOTHING, pipes: [{ command: delegated, required: false }] } : NOTHING;
}

/**
 * The host lines a pipeline asks for, in order: the head's delegation when it is `command` (its input is the
 * line's), then each later segment's text when the session's engine does not run it (required), or its delegation
 * when it is a builtin that delegates (optional). Null when a segment's routing cannot be established: an empty
 * segment, or one leaving the engine that holds a reference (its words would not be what was typed).
 *
 * @param segments - The pipeline's segments, as the engine splits them.
 * @param engineRuns - Which words the session's engine runs itself.
 * @returns The host lines, or null.
 */
async function pipeline_read(segments: readonly string[], engineRuns: (word: string) => boolean): Promise<PipeGrant[] | null> {
  const pipes: PipeGrant[] = [];
  for (let at = 0; at < segments.length; at++) {
    const segment: string = segments[at] ?? '';
    const word: string = pipeSegment_word(segment);
    if (word === '') return null;
    if (at > 0 && !engineRuns(word)) {
      if (!shellWords_tokenize(segment).every((one: ShellWord): boolean => one.segments === undefined)) return null;
      pipes.push({ command: segment, required: true });
      continue;
    }
    // The head's input is the line's own: only `command` hands it to the host there.
    if (at === 0 && word !== 'command') continue;
    const delegated: string | null = await delegation_read(segment);
    if (delegated !== null) pipes.push({ command: delegated, required: false });
  }
  return pipes;
}
