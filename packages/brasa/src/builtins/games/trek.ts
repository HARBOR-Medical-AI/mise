/**
 * @file `trek`: the 1976 Berkeley space war game (BSD trek(6)), played by
 * question in the console or a terminal.
 *
 * The game is the `bsd-trek` package; this module wires it to the session:
 * lines to the data channel, each pending partial line as the question asked,
 * sleeps as real pauses, the game's state as a typed event (`games.trek.state`)
 * at every Command: prompt for a surface that draws a bridge, and one
 * saved-game slot that lasts as long as the session. Scans wear glyphs and colours unless `--classic` asks for the
 * original look or the output has no colour.
 *
 * @module
 */
import chalk from 'chalk';
import { CommandEnvelope, envelope_error, envelope_ok } from '@fnndsc/menu';
import { TREK_CREDITS, trek_play, type TrekDump, type TrekState, type TrekTerminal } from 'bsd-trek';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { repl_question } from '../../core/question.js';
import { sink_get } from '../../core/sink.js';

/** The session's saved game: `dump` writes it, a `restart` length reads it back. */
const TREK_DUMP: TrekDump = { saved: null };

/** The session's terminal: the data channel, the question, a real pause. */
const SESSION_TERMINAL: TrekTerminal = {
  text_write: (text: string): void => sink_get().data_write(text),
  question_ask: async (prompt: string): Promise<string | null> => {
    // What is printed before the last newline is output; the rest is the question.
    const cut: number = prompt.lastIndexOf('\n');
    if (cut >= 0) sink_get().data_write(prompt.slice(0, cut + 1));
    try {
      return await repl_question(prompt.slice(cut + 1));
    } catch (error: unknown) {
      // A question the operator abandoned (Esc, LEAVE BRIDGE) is end of input, as Ctrl-D is: the game ends as the C does.
      if (error instanceof Error && /abandoned/.test(error.message)) return null;
      throw error;
    }
  },
  seconds_sleep: (seconds: number): Promise<void> => new Promise((resolve: () => void): void => { setTimeout(resolve, seconds * 1000); }),
  state_show: (state: TrekState): void => { sink_get().event_write?.('games.trek.state', state); },
};

/** What a `trek` line may hold: the look, the pace, the galaxy's seed, the credits. */
const TREK_GRAMMAR = {
  options: {
    classic: { long: 'classic', summary: 'Show the scans as printed in 1976, without glyphs or colour' },
    fast: { short: 'f', summary: 'The original fast mode' },
    slow: { short: 's', summary: 'The original slow mode' },
    seed: { long: 'seed', summary: 'Replay the galaxy of this seed', value: { name: 'N', kind: 'int' } },
    credits: { long: 'credits', summary: 'Name who made the game, instead of playing it' },
  },
} as const satisfies CommandGrammar;

/**
 * `trek [--classic] [-f | -s] [--seed N] [--credits]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [trekCommand] });
 * ```
 */
export const trekCommand = command_declare({
  name: 'trek',
  grammar: TREK_GRAMMAR,
  help: {
    summary: 'The 1976 Berkeley space war game (BSD trek)',
    description: 'Command a starship against an invading fleet across an 8×8 galaxy of quadrants, by question: srscan, lrscan, move, phasers, torpedo, shield, dock, computer and the rest (? at any prompt lists the answers it takes). Answers can be typed ahead on one line, as in the original. The scans wear glyphs and colours; --classic shows them as printed in 1976. -f and -s are the original fast and slow modes; --seed N replays a galaxy; --credits (or credits in the game) names who made it. terminate ends a game; answer no to Another game to leave.',
    examples: ['trek', 'trek --classic', 'trek --seed 42', 'trek --credits'],
  },
  handler: async (args: CommandArguments<typeof TREK_GRAMMAR>): Promise<CommandEnvelope> => trek_run(args.options),
});

/**
 * `trek` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `trek`.
 * @returns The game's end, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_trek(['--seed', '42']);
 * ```
 */
export async function builtin_trek(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(trekCommand, args);
}

/**
 * Plays `trek`, or names who made it.
 *
 * @param options - The line's options.
 * @param options.classic - The original look.
 * @param options.fast - The original fast mode.
 * @param options.slow - The original slow mode (it wins over fast).
 * @param options.seed - The galaxy's seed; absent, the clock's.
 * @param options.credits - Name the makers instead of playing.
 * @returns The game's end.
 *
 * @example
 * ```ts
 * await trek_run({ classic: true, fast: false, slow: false, seed: 42, credits: false });
 * ```
 */
export async function trek_run(options: { readonly classic: boolean; readonly fast: boolean; readonly slow: boolean; readonly seed: number | undefined; readonly credits: boolean }): Promise<CommandEnvelope> {
  if (options.credits) return envelope_ok(TREK_CREDITS, { kind: 'games.trek.credits', data: {} });
  const seed: number = options.seed ?? Math.floor(Date.now() / 1000);
  const fast: number = options.slow ? 0 : options.fast ? 2 : 1;
  try {
    const code: number = await trek_play(SESSION_TERMINAL, { seed, fast, trace: 0, styled: !options.classic && chalk.level > 0 }, TREK_DUMP);
    return envelope_ok('', { kind: 'games.trek', data: { seed, exit: code } });
  } catch (error: unknown) {
    return envelope_error('', undefined, `trek: cannot ask here (${error instanceof Error ? error.message : String(error)})\n`);
  }
}
