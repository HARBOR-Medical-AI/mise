/**
 * @file What a line asks to have delivered to the machine it was typed on.
 *
 * A surface on another machine than its engine writes a file to its own
 * disk when the engine asks it to (`fileDeliver`). The request names a
 * destination, and the engine is across a wire: the surface must not take
 * the engine's word for where on its disk to write. So before a line is
 * sent, the surface reads from it, with the delivering command's own
 * declaration, the destination its operator typed. A delivery is honoured
 * only against that.
 *
 * Only a command listed here delivers. A source path, an option's value or
 * a word of some other command on the line is never a destination.
 *
 * The line is taken apart in the order the engine takes it apart
 * (`core/engine.ts`, `line_execute_run`), with the engine's own functions,
 * so the command the reader sees is the command that will run. Where the
 * reader cannot bind what would run to a place, it reports no intent, and
 * a delivery that arrives is then refused: an unfinished quote, a line
 * sent to the background, a host-shell line, a capture.
 *
 * @module
 */
import type { CommandDeclaration } from '../../core/commandDeclaration.js';
import { commandOperands_place } from '../../core/commandParse.js';
import { jobletLine_parse } from '../../core/joblets.js';
import { command_shellEscape_detect, pipeSegment_word, pipes_parse, redirect_parse, type RedirectInfo } from '../../core/preprocess.js';
import { assignment_parse } from '../../core/variables.js';
import { shellWords_tokenize, type ShellSegment, type ShellWord } from '../../lib/parser.js';
import { quoteOpen_find } from '../../lib/quoting.js';
import { commandList_parse, type ListCommand } from '../../lib/semicolonParser.js';
import { downloadCommand } from './download.js';
import { storePath_normalise, type DeliveryIntent, type SourceIntent } from './deliveryMatch.js';

export { deliveryIntent_matches, deliverySource_matches, sourceIntents_settle, storePath_normalise, type DeliveredFile, type DeliveryIntent, type SourceIntent } from './deliveryMatch.js';

/** A command that delivers, and the operand that names where. */
interface DeliveringCommand {
  /** The backend whose sessions have the command (`Backend.id`). */
  readonly backend: string;
  /** The command's declaration. */
  readonly declaration: CommandDeclaration;
  /** The name of its destination operand. */
  readonly operand: string;
  /** The name of its source operand. */
  readonly sourceOperand: string;
}

/**
 * Every command whose handler asks the surface to write a file, with the
 * backend whose sessions register it. A session of another backend has no
 * such builtin: there the same word, typed, is not the engine's command at
 * all (later in a pipeline it is the host shell's program), and asks for
 * no delivery.
 */
const DELIVERING: ReadonlyArray<DeliveringCommand> = [
  { backend: 'chris', declaration: downloadCommand, operand: 'destination', sourceOperand: 'source' },
];

/**
 * Reads what one plain command asks to have delivered: its words, as the
 * engine tokenizes them, against its declaration.
 *
 * @param command - One command, with no list, pipe or redirect left in it.
 * @param delivering_ - The delivering commands the session has.
 * @returns Its intent, or none when it is not a delivering command or its declaration refuses the line.
 */
function commandIntents_read(command: string, delivering_: ReadonlyArray<DeliveringCommand>): DeliveryIntent[] {
  const words: ShellWord[] = shellWords_tokenize(command);
  const verb: string | undefined = words[0]?.value;
  const delivering: DeliveringCommand | undefined = delivering_.find((one: DeliveringCommand): boolean => one.declaration.name === verb);
  if (verb === undefined || delivering === undefined) return [];
  const placed: Map<string, ShellWord[]> | null = commandOperands_place(delivering.declaration, words.slice(1));
  if (placed === null) return [];
  const sourceWords: ShellWord[] = placed.get(delivering.sourceOperand) ?? [];
  const referenced: ShellWord | undefined = sourceWords.find(word_isReferenced);
  if (referenced !== undefined) {
    return [{ verb, destination: null, unbound: `its source ${JSON.stringify(referenced.value)} is written with a reference, whose value is not known here: type the path itself` }];
  }
  const sources: SourceIntent[] = sourceWords.map(sourceIntent_read);
  const unresolved: SourceIntent | undefined = sources.find((one: SourceIntent): boolean => 'unresolved' in one);
  if (unresolved !== undefined && 'unresolved' in unresolved) return [{ verb, destination: null, unbound: unresolved.unresolved }];
  const word: ShellWord | undefined = placed.get(delivering.operand)?.[0];
  if (word === undefined) return [{ verb, destination: null, sources }];
  // A reference in the destination is expanded by the engine, across the
  // wire. Its spelling here is not a place, and must not become one because
  // the engine sends the same letters back. A quoted `'$x'` is plain text.
  if (word_isReferenced(word)) {
    return [{ verb, destination: null, unbound: `its destination ${JSON.stringify(word.value)} is written with a reference, whose value is not known here: type the path itself` }];
  }
  return [{ verb, destination: word.value, sources }];
}

/**
 * Whether a word holds a reference the engine resolves (a quoted `'$x'` is plain text).
 *
 * @param word - The word.
 * @returns True when it does.
 */
function word_isReferenced(word: ShellWord): boolean {
  return (word.segments ?? []).some((segment: ShellSegment): boolean => segment.ref !== null);
}

/**
 * How a delivered file is bound to one source word: by the operand as typed (quoting removed), which the root the
 * engine resolved must be; by the operand's pattern when the engine expands it. A source whose place only the
 * session knows (`.`, `..`, `~`, or a path climbing with `..`) binds nothing.
 *
 * @param word - A source word.
 * @returns The binding, or why there is none.
 */
function sourceIntent_read(word: ShellWord): SourceIntent {
  const spelled: string = word.pathnameExpansion ? word.globPattern : word.value;
  const parts: string[] = spelled.split('/');
  // `.`, `./` and `././` alike are the session folder itself: only the session knows it.
  if (storePath_normalise(spelled) === '' || parts.includes('..') || parts[0] === '~') {
    return { unresolved: `its source ${JSON.stringify(word.value)} names a place only the session knows: type the folder's path` };
  }
  return word.pathnameExpansion ? { pattern: spelled } : { operand: spelled };
}

/**
 * Whether a pipeline's later segment is one the engine would run as a
 * delivering command, by the engine's own rule.
 *
 * `pipe_execute` (`core/dispatch.ts`) decides a later segment from its raw
 * leading word, split on white space, before any quoting is read: a word
 * that names a builtin runs in the engine, anything else goes to the
 * surface's host shell. So `"download" a b` in that position is a host
 * program, not the engine's `download`, and asks for no delivery. The rule
 * is {@link pipeSegment_word}, which `pipe_execute` uses too.
 *
 * @param segment - A segment after the first.
 * @param delivering - The delivering commands the session has.
 * @returns True when its raw leading word is one of their names.
 */
function laterSegment_runsInEngine(segment: string, delivering: ReadonlyArray<DeliveringCommand>): boolean {
  const word: string = pipeSegment_word(segment);
  return delivering.some((one: DeliveringCommand): boolean => one.declaration.name === word);
}

/**
 * Reads the deliveries a line asks for, without running it.
 *
 * The order is the engine's: an unfinished quote, a background line and a
 * host-shell line are settled first (none can be bound: no intent); then a
 * list is split and each command read as a line of its own; a capture is
 * not bound; a pipeline's first segment is read as a plain command, and a
 * later one too when its raw leading word names a delivering command, which
 * is how the engine decides to run it itself; a redirect
 * is taken off and the command before it read; what is left is one plain
 * command.
 *
 * @param line - The line as typed.
 * @param backend - The backend of the session the line is sent to (`Backend.id`); a session of a backend with no delivering command, or of none named, asks for nothing.
 * @returns The intents, in order; empty when the line delivers nothing the reader can bind.
 *
 * @example
 * ```ts
 * deliveryIntents_read('cd /x; download -f a.txt "./my folder" > log', 'chris'); // [{ verb: 'download', destination: './my folder' }]
 * ```
 */
export function deliveryIntents_read(line: string, backend: string | undefined): DeliveryIntent[] {
  const delivering: ReadonlyArray<DeliveringCommand> = DELIVERING.filter((one: DeliveringCommand): boolean => one.backend === backend);
  return delivering.length === 0 ? [] : lineIntents_read(line, delivering);
}

/**
 * Reads one line's intents against the delivering commands a session has.
 *
 * @param line - The line, or one command of a list.
 * @param delivering - The delivering commands the session has.
 * @returns The intents, in order.
 */
function lineIntents_read(line: string, delivering: ReadonlyArray<DeliveringCommand>): DeliveryIntent[] {
  const trimmed: string = line.trim();
  if (trimmed === '') return [];
  if (command_shellEscape_detect(trimmed)) return [];
  if (quoteOpen_find(trimmed) !== null) return [];
  if (jobletLine_parse(trimmed) !== null) return [];
  const listed: ListCommand[] = commandList_parse(trimmed);
  // A command in a conditional arm (after `&&` or `||`) may or may not run: it is bound to nothing.
  if (listed.some((one: ListCommand): boolean => one.when !== 'always')) return [];
  if (listed.length > 1) return listed.flatMap((one: ListCommand): DeliveryIntent[] => lineIntents_read(one.command, delivering));
  if (assignment_parse(trimmed) !== null) return [];
  const segments: string[] = pipes_parse(trimmed);
  if (segments.length > 1) {
    return segments.flatMap((segment: string, at: number): DeliveryIntent[] => (at === 0 || laterSegment_runsInEngine(segment, delivering) ? commandIntents_read(segment, delivering) : []));
  }
  const redirect: RedirectInfo | null = redirect_parse(trimmed);
  return commandIntents_read(redirect !== null ? redirect.command : trimmed, delivering);
}
