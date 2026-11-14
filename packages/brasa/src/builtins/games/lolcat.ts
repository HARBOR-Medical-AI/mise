/**
 * @file `lolcat`: text in a rainbow.
 *
 * Each character takes the next hue along a sine rainbow, the hue drifting
 * down the lines, as the original does. The colour is 24-bit ANSI, which
 * every surface here renders; `-p N` sets the spread (characters per cycle),
 * `-S N` the starting phase.
 *
 * @module
 */
import chalk from 'chalk';
import { text_input } from './stdin.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** 24-bit colour whatever the host thinks of its terminal: every surface here renders it. */
const paint: chalk.Chalk = new chalk.Instance({ level: 3 });

/** Characters per rainbow cycle when none is asked. */
export const LOLCAT_SPREAD: number = 24;

/** The colour at a point along the rainbow. */
export function rainbow_rgb(position: number, spread: number): [number, number, number] {
  const t: number = (position / spread) * 2 * Math.PI;
  const channel = (phase: number): number => Math.round(Math.sin(t + phase) * 100 + 155);
  return [channel(0), channel(2 * Math.PI / 3), channel(4 * Math.PI / 3)];
}

/**
 * Paints a text.
 *
 * @param text - The lines.
 * @param spread - Characters per cycle.
 * @param phase - Where the first character starts.
 * @returns The text with a colour per character; plain spaces stay plain.
 */
export function lolcat_paint(text: string, spread: number = LOLCAT_SPREAD, phase: number = 0): string {
  const clean: string = text.replace(/\x1b\[[0-9;]*m/g, '');
  return clean.split('\n').map((line: string, row: number): string =>
    [...line].map((c: string, col: number): string => {
      if (c === ' ') return c;
      const [r, g, b]: [number, number, number] = rainbow_rgb(phase + col + row * 3, spread);
      return paint.rgb(r, g, b)(c);
    }).join(''),
  ).join('\n');
}

/** What a `lolcat` line may hold. */
const LOLCAT_GRAMMAR = {
  operands: [{ name: 'text', kind: 'word', optional: true, repeat: true, summary: 'The text to paint (default: what is piped in)' }],
  options: {
    spread: { short: 'p', summary: 'Characters per rainbow cycle (1 or more)', value: { name: 'SPREAD', kind: 'number', min: 1 } },
    phase: { short: 'S', summary: 'Where the rainbow starts', value: { name: 'PHASE', kind: 'number' } },
  },
} as const satisfies CommandGrammar;

/**
 * `lolcat [-p SPREAD] [-S PHASE] [text]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [lolcatCommand] });
 * ```
 */
export const lolcatCommand = command_declare({
  name: 'lolcat',
  grammar: LOLCAT_GRAMMAR,
  help: {
    summary: 'Text in a rainbow',
    description: 'Paints each character the next hue along a rainbow, drifting down the lines. -p sets how many characters one cycle spans (24), -S where it starts (random). Reads what is piped in, else the words given.',
    examples: ['fortune | lolcat', 'figlet ARGUS | lolcat', 'motd | lolcat -p 12'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof LOLCAT_GRAMMAR>): Promise<CommandEnvelope> => lolcat_run(args.operands.text, args.options.spread, args.options.phase),
});

/**
 * `lolcat` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `lolcat`.
 * @returns The painted text, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_lolcat(['-p', '12', 'hello']);
 * ```
 */
export async function builtin_lolcat(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(lolcatCommand, args);
}

/**
 * Paints the piped text, else the words, in a rainbow.
 *
 * @param words - The words given.
 * @param spread - Characters per cycle, or undefined for the default.
 * @param phase - Where the rainbow starts, or undefined for a random start.
 * @returns The painted text, or a refusal when there is nothing to paint.
 *
 * @example
 * ```ts
 * await lolcat_run(['hello'], 12, 0);
 * ```
 */
export async function lolcat_run(words: ReadonlyArray<string>, spread: number | undefined, phase: number | undefined): Promise<CommandEnvelope> {
  const cycle: number = spread ?? LOLCAT_SPREAD;
  const start: number = phase ?? Math.floor(Math.random() * 256);
  const text: string | null = text_input(words);
  if (text === null) return envelope_error('', undefined, 'lolcat: nothing to paint (pipe text in: fortune | lolcat)\n');
  const said: string = text.replace(/\n$/, '');
  return envelope_ok(`${lolcat_paint(said, cycle, start)}\n`, { kind: 'games.lolcat', data: { text: said, spread: cycle, phase: start } });
}
