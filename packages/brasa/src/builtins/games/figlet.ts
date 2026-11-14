/**
 * @file `figlet` and `banner`: big letters.
 *
 * One bundled face, five rows tall, drawn in `#` the way `banner` always
 * was; `figlet` fills with `█` for a solid look. Letters, digits and the
 * punctuation a title needs. A glyph is five strings of equal width; the
 * row of a word is its glyphs' rows side by side with one column between.
 *
 * @module
 */
import { text_input } from './stdin.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** The face: each glyph five rows, `#` for ink. */
const FACE: Readonly<Record<string, ReadonlyArray<string>>> = {
  A: [' ### ', '#   #', '#####', '#   #', '#   #'],
  B: ['#### ', '#   #', '#### ', '#   #', '#### '],
  C: [' ####', '#    ', '#    ', '#    ', ' ####'],
  D: ['#### ', '#   #', '#   #', '#   #', '#### '],
  E: ['#####', '#    ', '#### ', '#    ', '#####'],
  F: ['#####', '#    ', '#### ', '#    ', '#    '],
  G: [' ####', '#    ', '#  ##', '#   #', ' ####'],
  H: ['#   #', '#   #', '#####', '#   #', '#   #'],
  I: ['#####', '  #  ', '  #  ', '  #  ', '#####'],
  J: ['    #', '    #', '    #', '#   #', ' ### '],
  K: ['#   #', '#  # ', '###  ', '#  # ', '#   #'],
  L: ['#    ', '#    ', '#    ', '#    ', '#####'],
  M: ['#   #', '## ##', '# # #', '#   #', '#   #'],
  N: ['#   #', '##  #', '# # #', '#  ##', '#   #'],
  O: [' ### ', '#   #', '#   #', '#   #', ' ### '],
  P: ['#### ', '#   #', '#### ', '#    ', '#    '],
  Q: [' ### ', '#   #', '# # #', '#  # ', ' ## #'],
  R: ['#### ', '#   #', '#### ', '#  # ', '#   #'],
  S: [' ####', '#    ', ' ### ', '    #', '#### '],
  T: ['#####', '  #  ', '  #  ', '  #  ', '  #  '],
  U: ['#   #', '#   #', '#   #', '#   #', ' ### '],
  V: ['#   #', '#   #', '#   #', ' # # ', '  #  '],
  W: ['#   #', '#   #', '# # #', '## ##', '#   #'],
  X: ['#   #', ' # # ', '  #  ', ' # # ', '#   #'],
  Y: ['#   #', ' # # ', '  #  ', '  #  ', '  #  '],
  Z: ['#####', '   # ', '  #  ', ' #   ', '#####'],
  '0': [' ### ', '#  ##', '# # #', '##  #', ' ### '],
  '1': ['  #  ', ' ##  ', '  #  ', '  #  ', '#####'],
  '2': [' ### ', '#   #', '  ## ', ' #   ', '#####'],
  '3': ['#### ', '    #', ' ### ', '    #', '#### '],
  '4': ['#  # ', '#  # ', '#####', '   # ', '   # '],
  '5': ['#####', '#    ', '#### ', '    #', '#### '],
  '6': [' ### ', '#    ', '#### ', '#   #', ' ### '],
  '7': ['#####', '    #', '   # ', '  #  ', '  #  '],
  '8': [' ### ', '#   #', ' ### ', '#   #', ' ### '],
  '9': [' ### ', '#   #', ' ####', '    #', ' ### '],
  ' ': ['   ', '   ', '   ', '   ', '   '],
  '.': [' ', ' ', ' ', ' ', '#'],
  ',': [' ', ' ', ' ', '#', '#'],
  '!': ['#', '#', '#', ' ', '#'],
  '?': [' ### ', '#   #', '   # ', '     ', '  #  '],
  '-': ['     ', '     ', '#####', '     ', '     '],
  '_': ['     ', '     ', '     ', '     ', '#####'],
  ':': [' ', '#', ' ', '#', ' '],
  '/': ['    #', '   # ', '  #  ', ' #   ', '#    '],
  '+': ['     ', '  #  ', '#####', '  #  ', '     '],
  '=': ['     ', '#####', '     ', '#####', '     '],
  '*': ['     ', '# # #', ' ### ', '# # #', '     '],
  '#': [' # # ', '#####', ' # # ', '#####', ' # # '],
  '(': [' #', '# ', '# ', '# ', ' #'],
  ')': ['# ', ' #', ' #', ' #', '# '],
  '\'': ['#', '#', ' ', ' ', ' '],
  '"': ['# #', '# #', '   ', '   ', '   '],
  '&': [' ## ', '#  #', ' ## ', '# # ', ' # #'],
  '@': [' ### ', '#  ##', '# # #', '#  # ', ' ### '],
  '%': ['#   #', '   # ', '  #  ', ' #   ', '#   #'],
};

/** The rows of the face, five. */
export const FACE_ROWS: number = 5;

/**
 * Sets a text in the face.
 *
 * @param text - The words; lowercase is set as capitals, an unknown character as `?`.
 * @param ink - The character to draw with.
 * @returns The five rows (more for several lines).
 */
export function figlet_render(text: string, ink: string = '#'): string[] {
  const rows: string[] = [];
  for (const line of text.split('\n')) {
    const glyphs: ReadonlyArray<string>[] = [...line.toUpperCase()].map((c: string): ReadonlyArray<string> => FACE[c] ?? FACE['?'] as ReadonlyArray<string>);
    for (let r: number = 0; r < FACE_ROWS; r++) {
      const row: string = glyphs.map((g: ReadonlyArray<string>): string => g[r] ?? '').join(' ').replace(/#/g, ink).trimEnd();
      rows.push(row);
    }
    rows.push('');
  }
  rows.pop();
  return rows;
}

/** The words to set in big letters: what is piped in, else these. */
const BIG_TEXT = { name: 'text', kind: 'word', optional: true, repeat: true, summary: 'The words to set (default: what is piped in)' } as const;

/** What a `figlet` or `banner` line may hold. */
const BIG_GRAMMAR = { operands: [BIG_TEXT] } as const satisfies CommandGrammar;

/**
 * `figlet [text]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [figletCommand] });
 * ```
 */
export const figletCommand = command_declare({
  name: 'figlet',
  grammar: BIG_GRAMMAR,
  help: {
    summary: 'Big letters, solid',
    description: 'Sets words in a five-row face of solid blocks. Letters, digits and the punctuation a title needs; lowercase is set as capitals. Reads what is piped in, else the words given.',
    examples: ['figlet LCARS', 'date +%H:%M | figlet'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof BIG_GRAMMAR>): Promise<CommandEnvelope> => big_run('figlet', args.operands.text, '█'),
});

/**
 * `banner [text]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [bannerCommand] });
 * ```
 */
export const bannerCommand = command_declare({
  name: 'banner',
  grammar: BIG_GRAMMAR,
  help: {
    summary: 'Big letters in #, as banner drew them',
    description: 'figlet in the face banner used: # for ink.',
    examples: ['banner ChRIS'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof BIG_GRAMMAR>): Promise<CommandEnvelope> => big_run('banner', args.operands.text, '#'),
});

/**
 * Sets the piped text, else the words, in big letters.
 *
 * @param name - The command's name, for its refusal.
 * @param words - The words given.
 * @param ink - The character to draw with.
 * @returns The big letters, or a refusal when there is nothing to set.
 *
 * @example
 * ```ts
 * await big_run('banner', ['hi'], '#');
 * ```
 */
export async function big_run(name: string, words: ReadonlyArray<string>, ink: string): Promise<CommandEnvelope> {
  const text: string | null = text_input(words);
  if (text === null) return envelope_error('', undefined, `${name}: nothing to set (give words, or pipe them in)\n`);
  const said: string = text.replace(/\n$/, '');
  return envelope_ok(`${figlet_render(said, ink).join('\n')}\n`, { kind: 'games.figlet', data: { text: said, ink } });
}

/**
 * `figlet` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `figlet`.
 * @returns The big letters, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_figlet(['LCARS']);
 * ```
 */
export async function builtin_figlet(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(figletCommand, args);
}

/**
 * `banner` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `banner`.
 * @returns The big letters, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_banner(['ChRIS']);
 * ```
 */
export async function builtin_banner(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(bannerCommand, args);
}
