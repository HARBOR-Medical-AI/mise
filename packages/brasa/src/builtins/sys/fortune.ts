/**
 * @file Builtin fortune.
 *
 * Prints a random fortune cookie — the classic `fortune` command, reimagined as
 * a self-contained builtin. Its content is bundled (see {@link FORTUNES}), so it
 * needs no host `fortune` binary and no datfiles on disk, and behaves the same
 * in a local shell, over a CALYPSO daemon, and in the standalone binary.
 *
 * @module
 */
import { FORTUNES } from './fortunes.data.js';
import { CommandEnvelope, envelope_ok } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/**
 * Picks a random fortune from the bundled collection.
 *
 * @param maxLines - Optional upper bound on the fortune's line count, so a
 *   boot banner can favour short cookies. When the bound filters everything
 *   out, the full collection is used rather than returning nothing.
 * @returns The chosen fortune text (no trailing newline).
 */
export function fortune_random(maxLines?: number): string {
  const bounded: readonly string[] =
    maxLines !== undefined
      ? FORTUNES.filter((f: string): boolean => f.split('\n').length <= maxLines)
      : FORTUNES;
  const pool: readonly string[] = bounded.length > 0 ? bounded : FORTUNES;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** What a `fortune` line may hold: nothing. */
const FORTUNE_GRAMMAR = {} as const satisfies CommandGrammar;

/**
 * `fortune`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [fortuneCommand] });
 * ```
 */
export const fortuneCommand = command_declare({
  name: 'fortune',
  grammar: FORTUNE_GRAMMAR,
  help: {
    summary: 'Print a random fortune cookie',
    description: 'Prints a random fortune — the classic UNIX fortune cookie, bundled and self-contained.',
    examples: ['fortune'],
    category: 'Games',
  },
  holds: [],
  handler: async (_args: CommandArguments<typeof FORTUNE_GRAMMAR>): Promise<CommandEnvelope> => fortune_run(),
});

/**
 * `fortune` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `fortune`.
 * @returns A fortune, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_fortune([]);
 * ```
 */
export async function builtin_fortune(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(fortuneCommand, args);
}

/**
 * Reports a random fortune as a command envelope.
 *
 * @returns An envelope carrying the chosen fortune and a typed model of it.
 *
 * @example
 * ```ts
 * await fortune_run();
 * ```
 */
export async function fortune_run(): Promise<CommandEnvelope> {
  const fortune: string = fortune_random();
  return envelope_ok(`${fortune}\n`, {
    kind: 'sys.fortune',
    data: { fortune },
  });
}
