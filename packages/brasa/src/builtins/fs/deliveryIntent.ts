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
 * @module
 */
import type { CommandDeclaration } from '../../core/commandDeclaration.js';
import { commandOperands_place } from '../../core/commandParse.js';
import { pipes_parse } from '../../core/preprocess.js';
import { shellWords_tokenize, type ShellWord } from '../../lib/parser.js';
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
 * Reads the deliveries a line asks for, without running it.
 *
 * The line is split as the engine splits it (`;`, `&&`, `||`, then the
 * head of a pipeline) and each command that delivers is parsed with its
 * own declaration. Nothing is expanded: a destination written as a
 * variable is read as the variable's spelling, which is not what an engine
 * will send back, so such a delivery finds no matching intent.
 *
 * @param line - The line as typed.
 * @returns The intents, in order; empty when the line delivers nothing.
 *
 * @example
 * ```ts
 * deliveryIntents_read('cd /x; download -f a.txt "./my folder"'); // [{ verb: 'download', destination: './my folder' }]
 * ```
 */
export function deliveryIntents_read(line: string): DeliveryIntent[] {
  const intents: DeliveryIntent[] = [];
  for (const listed of commandList_parse(line) as ListCommand[]) {
    const head: string | undefined = pipes_parse(listed.command)[0];
    if (head === undefined) continue;
    const words: ShellWord[] = shellWords_tokenize(head);
    const verb: string | undefined = words[0]?.value;
    const delivering: DeliveringCommand | undefined = DELIVERING.find((one: DeliveringCommand): boolean => one.declaration.name === verb);
    if (verb === undefined || delivering === undefined) continue;
    const placed: Map<string, ShellWord[]> | null = commandOperands_place(delivering.declaration, words.slice(1));
    if (placed === null) continue;
    intents.push({ verb, destination: placed.get(delivering.operand)?.[0]?.value ?? null });
  }
  return intents;
}
