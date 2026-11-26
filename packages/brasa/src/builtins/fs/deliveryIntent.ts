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
import { command_shellEscape_detect, pipes_parse, redirect_parse, type RedirectInfo } from '../../core/preprocess.js';
import { assignment_parse } from '../../core/variables.js';
import { shellWords_tokenize, type ShellSegment, type ShellWord } from '../../lib/parser.js';
import { quoteOpen_find } from '../../lib/quoting.js';
import { commandList_parse, type ListCommand } from '../../lib/semicolonParser.js';
import { downloadCommand } from './download.js';
import type { DeliveryIntent } from './deliveryMatch.js';

export { deliveryIntent_matches, type DeliveryIntent } from './deliveryMatch.js';

/** A command that delivers, and the operand that names where. */
interface DeliveringCommand {
  /** The command's declaration. */
  readonly declaration: CommandDeclaration;
  /** The name of its destination operand. */
  readonly operand: string;
}

/** Every command whose handler asks the surface to write a file. */
const DELIVERING: ReadonlyArray<DeliveringCommand> = [
  { declaration: downloadCommand, operand: 'destination' },
];

/**
 * Reads what one plain command asks to have delivered: its words, as the
 * engine tokenizes them, against its declaration.
 *
 * @param command - One command, with no list, pipe or redirect left in it.
 * @returns Its intent, or none when it is not a delivering command or its declaration refuses the line.
 */
function commandIntents_read(command: string): DeliveryIntent[] {
  const words: ShellWord[] = shellWords_tokenize(command);
  const verb: string | undefined = words[0]?.value;
  const delivering: DeliveringCommand | undefined = DELIVERING.find((one: DeliveringCommand): boolean => one.declaration.name === verb);
  if (verb === undefined || delivering === undefined) return [];
  const placed: Map<string, ShellWord[]> | null = commandOperands_place(delivering.declaration, words.slice(1));
  if (placed === null) return [];
  const word: ShellWord | undefined = placed.get(delivering.operand)?.[0];
  if (word === undefined) return [{ verb, destination: null }];
  // A reference in the destination is expanded by the engine, across the
  // wire. Its spelling here is not a place, and must not become one because
  // the engine sends the same letters back. A quoted `'$x'` is plain text.
  if ((word.segments ?? []).some((segment: ShellSegment): boolean => segment.ref !== null)) {
    return [{ verb, destination: null, unbound: `its destination ${JSON.stringify(word.value)} is written with a reference, whose value is not known here: type the path itself` }];
  }
  return [{ verb, destination: word.value }];
}

/**
 * Reads the deliveries a line asks for, without running it.
 *
 * The order is the engine's: an unfinished quote, a background line and a
 * host-shell line are settled first (none can be bound: no intent); then a
 * list is split and each command read as a line of its own; a capture is
 * not bound; a pipeline's every segment is read as a plain command, since
 * a later segment that names a builtin runs in the engine too; a redirect
 * is taken off and the command before it read; what is left is one plain
 * command.
 *
 * @param line - The line as typed.
 * @returns The intents, in order; empty when the line delivers nothing the reader can bind.
 *
 * @example
 * ```ts
 * deliveryIntents_read('cd /x; download -f a.txt "./my folder" > log'); // [{ verb: 'download', destination: './my folder' }]
 * ```
 */
export function deliveryIntents_read(line: string): DeliveryIntent[] {
  const trimmed: string = line.trim();
  if (trimmed === '') return [];
  if (command_shellEscape_detect(trimmed)) return [];
  if (quoteOpen_find(trimmed) !== null) return [];
  if (jobletLine_parse(trimmed) !== null) return [];
  const listed: ListCommand[] = commandList_parse(trimmed);
  if (listed.length > 1) return listed.flatMap((one: ListCommand): DeliveryIntent[] => deliveryIntents_read(one.command));
  if (assignment_parse(trimmed) !== null) return [];
  const segments: string[] = pipes_parse(trimmed);
  if (segments.length > 1) return segments.flatMap((segment: string): DeliveryIntent[] => commandIntents_read(segment));
  const redirect: RedirectInfo | null = redirect_parse(trimmed);
  return commandIntents_read(redirect !== null ? redirect.command : trimmed);
}
