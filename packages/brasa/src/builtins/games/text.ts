/**
 * @file Text toys from the shelf: `rev`, `tac`, `yes`, `seq`, `shuf`, `rot13`.
 *
 * Each reads what was piped in, else its arguments, and answers in kind:
 * `fortune | rev`, `rot13 hello`, `seq 1 2 9`. `yes` is bounded — a shell
 * that never ends is not a toy — and says how many it printed. Each is
 * declared in one record (`revCommand`, `tacCommand`, `yesCommand`,
 * `seqCommand`, `shufCommand`, `rot13Command`).
 *
 * @module
 */
import chalk from 'chalk';
import { text_input } from './stdin.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** Lines `yes` prints when not told how many. */
export const YES_DEFAULT: number = 10;
/** The most lines `yes` prints however it is asked. */
export const YES_MAX: number = 10_000;
/** The most numbers `seq` prints. */
export const SEQ_MAX: number = 100_000;

/** Reverses each line's characters, keeping the lines. */
export function text_rev(text: string): string {
  return text.split('\n').map((line: string): string => [...line].reverse().join('')).join('\n');
}

/** Reverses the order of the lines. */
export function text_tac(text: string): string {
  const trailing: boolean = text.endsWith('\n');
  const lines: string[] = (trailing ? text.slice(0, -1) : text).split('\n');
  return lines.reverse().join('\n') + (trailing ? '\n' : '');
}

/** The ROT13 of a text; letters only, case kept. */
export function text_rot13(text: string): string {
  return text.replace(/[a-zA-Z]/g, (c: string): string => {
    const base: number = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

/**
 * The numbers `seq` prints: `seq LAST`, `seq FIRST LAST`, `seq FIRST STEP LAST`.
 *
 * @param nums - One to three numbers, as the line gave them.
 * @returns The numbers, or a refusal.
 *
 * @example
 * ```ts
 * seq_numbers([2, 5]); // { numbers: [2, 3, 4, 5] }
 * ```
 */
export function seq_numbers(nums: ReadonlyArray<number>): { numbers: number[] } | { refusal: string } {
  if (nums.length === 0 || nums.length > 3) {
    return { refusal: 'seq: usage: seq [FIRST [STEP]] LAST' };
  }
  const [first, step, last]: [number, number, number] = nums.length === 1 ? [1, 1, nums[0] as number]
    : nums.length === 2 ? [nums[0] as number, 1, nums[1] as number]
    : [nums[0] as number, nums[1] as number, nums[2] as number];
  if (step === 0) return { refusal: 'seq: STEP must not be zero' };
  const numbers: number[] = [];
  for (let n: number = first; step > 0 ? n <= last : n >= last; n += step) {
    numbers.push(Number(n.toFixed(10)));
    if (numbers.length >= SEQ_MAX) break;
  }
  return { numbers };
}

/** Shuffles lines (Fisher–Yates), with an optional source of chance for tests. */
export function lines_shuffle(lines: string[], random: () => number = Math.random): string[] {
  const out: string[] = [...lines];
  for (let i: number = out.length - 1; i > 0; i--) {
    const j: number = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as string, out[i] as string];
  }
  return out;
}

/** The words of a toy that works on text: what is piped in, else these. */
const TEXT_OPERAND = { name: 'text', kind: 'word', optional: true, repeat: true, summary: 'The text to work on (default: what is piped in)' } as const;

/** What a `rev` line may hold. */
const REV_GRAMMAR = { operands: [TEXT_OPERAND] } as const satisfies CommandGrammar;

/**
 * `rev [text]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [revCommand] });
 * ```
 */
export const revCommand = command_declare({
  name: 'rev',
  grammar: REV_GRAMMAR,
  help: {
    summary: 'Reverse each line',
    description: 'Reverses the characters of each line, keeping the lines in order. Reads what is piped in, else the words given.',
    examples: ['rev stressed', 'fortune | rev'],
    posix: { group: 'Text', differs: 'reads a pipe or its words' },
  },
  holds: [],
  handler: async (args: CommandArguments<typeof REV_GRAMMAR>): Promise<CommandEnvelope> => rev_run(args.operands.text),
});

/**
 * `rev` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `rev`.
 * @returns The reversed text, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_rev(['stressed']);
 * ```
 */
export async function builtin_rev(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(revCommand, args);
}

/**
 * Reverses each line of the piped text, else of the words.
 *
 * @param words - The words given.
 * @returns The reversed text, or a refusal when there is none.
 *
 * @example
 * ```ts
 * await rev_run(['stressed']); // desserts
 * ```
 */
export async function rev_run(words: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const text: string | null = text_input(words);
  if (text === null) return envelope_error('', undefined, 'rev: nothing to reverse (pipe text in, or give it)\n');
  const out: string = text_rev(text.replace(/\n$/, ''));
  return envelope_ok(`${out}\n`, { kind: 'games.rev', data: { text: out } });
}

/** What a `tac` line may hold. */
const TAC_GRAMMAR = { operands: [TEXT_OPERAND] } as const satisfies CommandGrammar;

/**
 * `tac [text]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [tacCommand] });
 * ```
 */
export const tacCommand = command_declare({
  name: 'tac',
  grammar: TAC_GRAMMAR,
  help: {
    summary: 'Lines last to first',
    description: 'cat backwards: prints the lines in reverse order. Reads what is piped in.',
    examples: ['help games | tac', 'seq 5 | tac'],
    posix: { group: 'Text', differs: 'reads a pipe or its words' },
  },
  holds: [],
  handler: async (args: CommandArguments<typeof TAC_GRAMMAR>): Promise<CommandEnvelope> => tac_run(args.operands.text),
});

/**
 * `tac` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `tac`.
 * @returns The lines last to first, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_tac(['a']);
 * ```
 */
export async function builtin_tac(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(tacCommand, args);
}

/**
 * Turns the lines of the piped text, else of the words, last to first.
 *
 * @param words - The words given.
 * @returns The turned lines, or a refusal when there are none.
 *
 * @example
 * ```ts
 * await tac_run(['a', 'b']);
 * ```
 */
export async function tac_run(words: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const text: string | null = text_input(words);
  if (text === null) return envelope_error('', undefined, 'tac: nothing to turn over (pipe lines in)\n');
  const out: string = text_tac(text.endsWith('\n') ? text : `${text}\n`);
  return envelope_ok(out, { kind: 'games.tac', data: { text: out } });
}

/** What a `yes` line may hold. */
const YES_GRAMMAR = {
  operands: [{ name: 'words', kind: 'word', optional: true, repeat: true, summary: 'The word to repeat (default y)' }],
  options: {
    count: { short: 'n', summary: 'Lines to print (default 10, at most 10000)', value: { name: 'N', kind: 'int', min: 1 } },
  },
} as const satisfies CommandGrammar;

/**
 * `yes [word] [-n N]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [yesCommand] });
 * ```
 */
export const yesCommand = command_declare({
  name: 'yes',
  grammar: YES_GRAMMAR,
  help: {
    summary: 'Repeat a word (ten times, not forever)',
    description: 'Prints a word on its own line, over and over — but bounded: ten times unless -n N asks for more (up to 10000), and it says how many it printed. The real yes runs until killed; a session is not the place.',
    examples: ['yes', 'yes no -n 3', 'yes | head -n 2'],
    posix: { group: 'Text', differs: 'bounded: ten lines unless told how many, never forever' },
  },
  handler: async (args: CommandArguments<typeof YES_GRAMMAR>): Promise<CommandEnvelope> => yes_run(args.operands.words, args.options.count),
});

/**
 * `yes` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `yes`.
 * @returns The repeated lines, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_yes(['no', '-n', '3']);
 * ```
 */
export async function builtin_yes(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(yesCommand, args);
}

/**
 * Prints a word a bounded number of times.
 *
 * @param words - The words to repeat, joined by a space; none means `y`.
 * @param requested - How many lines were asked for, or undefined for the default.
 * @returns The lines and a note saying how many.
 *
 * @example
 * ```ts
 * await yes_run(['no'], 3);
 * ```
 */
export async function yes_run(words: ReadonlyArray<string>, requested: number | undefined): Promise<CommandEnvelope> {
  const count: number = Math.min(requested ?? YES_DEFAULT, YES_MAX);
  const word: string = words.length > 0 ? words.join(' ') : 'y';
  const lines: string = `${word}\n`.repeat(count);
  // Bounded on purpose, and it says so: the real yes runs until killed.
  const note: string = chalk.gray(`yes: ${count} of forever (-n N for more, up to ${YES_MAX})\n`);
  return envelope_ok(lines + note, { kind: 'games.yes', data: { word, count } });
}

/** What a `seq` line may hold. */
const SEQ_GRAMMAR = {
  operands: [{ name: 'numbers', kind: 'number', repeat: true, summary: '[FIRST [STEP]] LAST' }],
} as const satisfies CommandGrammar;

/**
 * `seq [FIRST [STEP]] LAST`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [seqCommand] });
 * ```
 */
export const seqCommand = command_declare({
  name: 'seq',
  grammar: SEQ_GRAMMAR,
  help: {
    summary: 'Count from one number to another',
    description: 'Prints the numbers from FIRST to LAST by STEP, one per line, as seq does: seq 5 is 1 to 5, seq 2 10 is 2 to 10, seq 10 -2 0 counts down. At most 100000 numbers.',
    examples: ['seq 5', 'seq 0 5 30', 'seq 10 -1 1 | tac'],
    posix: { group: 'Text', differs: 'as seq' },
  },
  holds: [],
  handler: async (args: CommandArguments<typeof SEQ_GRAMMAR>): Promise<CommandEnvelope> => seq_run(args.operands.numbers),
});

/**
 * `seq` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `seq`.
 * @returns The numbers, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_seq(['3']);
 * ```
 */
export async function builtin_seq(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(seqCommand, args);
}

/**
 * Prints a sequence of numbers.
 *
 * @param nums - FIRST, STEP and LAST as the line gave them (one to three).
 * @returns The numbers one per line, or a refusal.
 *
 * @example
 * ```ts
 * await seq_run([1, 2, 9]);
 * ```
 */
export async function seq_run(nums: ReadonlyArray<number>): Promise<CommandEnvelope> {
  const answer: { numbers: number[] } | { refusal: string } = seq_numbers(nums);
  if ('refusal' in answer) return envelope_error('', undefined, `${answer.refusal}\n`);
  const note: string = answer.numbers.length >= SEQ_MAX ? chalk.gray(`seq: stopped at ${SEQ_MAX} numbers\n`) : '';
  return envelope_ok(`${answer.numbers.join('\n')}\n${note}`, { kind: 'games.seq', data: { numbers: answer.numbers } });
}

/** What a `shuf` line may hold. */
const SHUF_GRAMMAR = {
  operands: [{ name: 'words', kind: 'word', optional: true, repeat: true, summary: 'The words to shuffle (default: the lines piped in)' }],
} as const satisfies CommandGrammar;

/**
 * `shuf [words...]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [shufCommand] });
 * ```
 */
export const shufCommand = command_declare({
  name: 'shuf',
  grammar: SHUF_GRAMMAR,
  help: {
    summary: 'Shuffle lines',
    description: 'Prints the lines piped in, or the words given, in a random order.',
    examples: ['shuf a b c d', 'ls | shuf', 'seq 10 | shuf'],
    posix: { group: 'Text', differs: 'reads a pipe or its words' },
  },
  handler: async (args: CommandArguments<typeof SHUF_GRAMMAR>): Promise<CommandEnvelope> => shuf_run(args.operands.words),
});

/**
 * `shuf` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `shuf`.
 * @returns The shuffled lines, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_shuf(['a', 'b']);
 * ```
 */
export async function builtin_shuf(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(shufCommand, args);
}

/**
 * Shuffles the lines piped in, else the words given.
 *
 * @param words - The words given.
 * @returns The lines in a random order, or a refusal when there are none.
 *
 * @example
 * ```ts
 * await shuf_run(['a', 'b', 'c']);
 * ```
 */
export async function shuf_run(words: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const piped: string | null = text_input([]);
  const lines: string[] = piped !== null
    ? piped.replace(/\n$/, '').split('\n')
    : [...words];
  if (lines.length === 0) return envelope_error('', undefined, 'shuf: nothing to shuffle (pipe lines in, or give words)\n');
  const out: string[] = lines_shuffle(lines);
  return envelope_ok(`${out.join('\n')}\n`, { kind: 'games.shuf', data: { lines: out } });
}

/** What a `rot13` line may hold. */
const ROT13_GRAMMAR = { operands: [TEXT_OPERAND] } as const satisfies CommandGrammar;

/**
 * `rot13 [text]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [rot13Command] });
 * ```
 */
export const rot13Command = command_declare({
  name: 'rot13',
  grammar: ROT13_GRAMMAR,
  help: {
    summary: 'Turn letters half the alphabet round',
    description: 'ROT13: each letter moved thirteen places, so applying it twice gives the text back. Reads what is piped in, else the words given.',
    examples: ['rot13 hello', 'fortune | rot13 | rot13'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof ROT13_GRAMMAR>): Promise<CommandEnvelope> => rot13_run(args.operands.text),
});

/**
 * `rot13` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `rot13`.
 * @returns The turned text, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_rot13(['hello']);
 * ```
 */
export async function builtin_rot13(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(rot13Command, args);
}

/**
 * Turns the piped text, else the words, thirteen places round the alphabet.
 *
 * @param words - The words given.
 * @returns The turned text, or a refusal when there is none.
 *
 * @example
 * ```ts
 * await rot13_run(['hello']); // uryyb
 * ```
 */
export async function rot13_run(words: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const text: string | null = text_input(words);
  if (text === null) return envelope_error('', undefined, 'rot13: nothing to turn (pipe text in, or give it)\n');
  const out: string = text_rot13(text.replace(/\n$/, ''));
  return envelope_ok(`${out}\n`, { kind: 'games.rot13', data: { text: out } });
}
