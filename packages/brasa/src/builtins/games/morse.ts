/**
 * @file `morse`: text to code and back.
 *
 * `morse hello` taps it out; `morse -d .... . .-.. .-.. ---` reads it. One
 * space between letters, a slash between words, as operators write it. The
 * typed model carries the code so a surface with a speaker can sound it.
 * Declared in one record (`morseCommand`), its words taken as they come.
 *
 * @module
 */
import { text_input } from './stdin.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import type { ExpressionDeclaration } from '../../core/commandDeclaration.js';

/** The International code. */
export const MORSE: Readonly<Record<string, string>> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---',
  K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-',
  U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-', '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', '!': '-.-.--', '/': '-..-.', '(': '-.--.', ')': '-.--.-', '&': '.-...', ':': '---...',
  ';': '-.-.-.', '=': '-...-', '+': '.-.-.', '-': '-....-', '_': '..--.-', '"': '.-..-.', '$': '...-..-', '@': '.--.-.', '\'': '.----.',
};

const MORSE_BACK: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(MORSE).map(([letter, code]: [string, string]): [string, string] => [code, letter]),
);

/** Text to code: letters a space apart, words a slash apart; an unknown character is dropped. */
export function morse_encode(text: string): string {
  return text.toUpperCase().trim().split(/\s+/).map((word: string): string =>
    [...word].map((c: string): string => MORSE[c] ?? '').filter((c: string): boolean => c.length > 0).join(' '),
  ).filter((w: string): boolean => w.length > 0).join(' / ');
}

/** Code to text: a group the code does not know becomes `?`. */
export function morse_decode(code: string): string {
  return code.trim().split(/\s*\/\s*|\s{3,}/).map((word: string): string =>
    word.trim().split(/\s+/).filter((g: string): boolean => g.length > 0).map((g: string): string => MORSE_BACK[g] ?? '?').join(''),
  ).join(' ');
}

/**
 * `morse [-d] [text]`: the declaration. Its words are Morse code as often as
 * text, and code is dashes (`morse -d ... --- ...`), so it takes its words
 * as they come and reads `-d` or `--decode` at the front itself.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [morseCommand] });
 * ```
 */
export const morseCommand: ExpressionDeclaration = {
  name: 'morse',
  grammar: 'expression',
  help: {
    usage: 'morse [-d] [text]',
    summary: 'Text to Morse code and back',
    description: 'Taps text out in International Morse — one space between letters, a slash between words — or, with -d (or --decode) as the first word, reads code back into text. Morse code is dashes, so its words are taken as they come, never as options. Reads what is piped in, else the words given.',
    examples: ['morse sos', 'morse -d ... --- ...', 'fortune | morse'],
  },
  holds: [],
  handler: (args: string[]): Promise<CommandEnvelope> => builtin_morse(args),
};

/**
 * `morse` over words already split.
 *
 * @param args - The words after `morse`: `-d` or `--decode` first to read code, then the text or the code.
 * @returns The code or the text, or a refusal when there is nothing to carry.
 *
 * @example
 * ```ts
 * await builtin_morse(['-d', '...', '---', '...']); // sos
 * ```
 */
export async function builtin_morse(args: string[]): Promise<CommandEnvelope> {
  const decode: boolean = args[0] === '-d' || args[0] === '--decode';
  return morse_run(decode ? args.slice(1) : args, decode);
}

/**
 * Taps out the piped text, else the words, or reads code back.
 *
 * @param words - The words of the text or the code.
 * @param decode - Read code into text rather than text into code.
 * @returns The result, or a refusal when there is nothing to carry.
 *
 * @example
 * ```ts
 * await morse_run(['sos'], false); // ... --- ...
 * ```
 */
export async function morse_run(words: ReadonlyArray<string>, decode: boolean): Promise<CommandEnvelope> {
  const text: string | null = text_input(words);
  if (text === null) return envelope_error('', undefined, 'morse: usage: morse <text>  |  morse -d <code>\n');
  const said: string = text.replace(/\n$/, '');
  if (decode) {
    const plain: string = morse_decode(said);
    return envelope_ok(`${plain}\n`, { kind: 'games.morse', data: { text: plain, code: said.trim(), direction: 'decode' } });
  }
  const code: string = morse_encode(said);
  if (code === '') return envelope_error('', undefined, 'morse: nothing in that the code can carry\n');
  return envelope_ok(`${code}\n`, { kind: 'games.morse', data: { text: said, code, direction: 'encode' } });
}
