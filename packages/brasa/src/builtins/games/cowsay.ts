/**
 * @file `cowsay`, with the ChRIS brain for a cow.
 *
 * The classic: a speech bubble over a creature. Ours thinks rather than
 * lows — the brain is the mascot, and `fortune | cowsay` is what the shelf
 * is for. `-W N` wraps at N columns; `cowthink` is the same with a thought
 * bubble.
 *
 * @module
 */
import { text_input } from './stdin.js';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** The brain, as ASCII has long drawn it. */
export const BRAIN: ReadonlyArray<string> = [
  '        _---~~(~~-_.',
  '      _{        )   )',
  '    ,   ) -~~- ( ,-\' )_',
  '   (  `-,_..`., )-- \'_,)',
  '  ( ` _)  (  -~( -_ `,  }',
  '  (_-  _  ~_-~~~~`,  ,\' )',
  '    `~ -^(    __;-,((()))',
  '          ~~~~ {_ -_(())',
  '                 `\\  }',
  '                   { }',
];

/** Default wrap width, as cowsay's. */
export const COWSAY_WIDTH: number = 40;

/** Wraps text at a width, keeping the lines it already had. */
export function text_wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words: string[] = paragraph.split(/\s+/).filter((w: string): boolean => w.length > 0);
    if (words.length === 0) { out.push(''); continue; }
    let line: string = '';
    for (const word of words) {
      if (line.length === 0) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

/**
 * Draws the bubble: said (speech) or thought.
 *
 * @param lines - The wrapped lines.
 * @param thought - True for a thought bubble (round sides, `o` trail).
 */
export function bubble_draw(lines: string[], thought: boolean): string[] {
  const width: number = Math.max(1, ...lines.map((l: string): number => l.length));
  const pad = (l: string): string => l.padEnd(width, ' ');
  const top: string = ` ${'_'.repeat(width + 2)}`;
  const bottom: string = ` ${'-'.repeat(width + 2)}`;
  if (thought) return [top, ...lines.map((l: string): string => `( ${pad(l)} )`), bottom];
  if (lines.length === 1) return [top, `< ${pad(lines[0] as string)} >`, bottom];
  return [
    top,
    ...lines.map((l: string, i: number): string => {
      const [left, right]: [string, string] = i === 0 ? ['/', '\\'] : i === lines.length - 1 ? ['\\', '/'] : ['|', '|'];
      return `${left} ${pad(l)} ${right}`;
    }),
    bottom,
  ];
}

/**
 * The whole picture: the bubble, its trail, the brain.
 *
 * @param text - What the brain says.
 * @param thought - Thought bubble rather than speech.
 * @param width - Wrap width.
 */
export function cowsay_render(text: string, thought: boolean = false, width: number = COWSAY_WIDTH): string {
  const lines: string[] = text_wrap(text, Math.max(8, width));
  const trail: string[] = thought ? ['        o', '         o'] : ['        \\', '         \\'];
  return [...bubble_draw(lines, thought), ...trail, ...BRAIN].join('\n') + '\n';
}

/** The words a cow says: what is piped in, else these. */
const COW_TEXT = { name: 'text', kind: 'word', optional: true, repeat: true, summary: 'What to say (default: what is piped in)' } as const;

/** What a `cowsay` or `cowthink` line may hold. */
const COW_GRAMMAR = {
  operands: [COW_TEXT],
  options: {
    width: { short: 'W', summary: 'Wrap the bubble at N columns (8 or more)', value: { name: 'N', kind: 'int', min: 8 } },
  },
} as const satisfies CommandGrammar;

/**
 * `cowsay [-W N] [text]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [cowsayCommand] });
 * ```
 */
export const cowsayCommand = command_declare({
  name: 'cowsay',
  grammar: COW_GRAMMAR,
  help: {
    summary: 'The ChRIS brain says it — fortune | cowsay',
    description: 'The classic, with the ChRIS brain for a cow: a speech bubble over the mascot. Says what is piped in, else the words given; -W N wraps at N columns (40 by default).',
    examples: ['fortune | cowsay', 'cowsay hello, world', 'motd | cowsay -W 60'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof COW_GRAMMAR>): Promise<CommandEnvelope> => cow_run('cowsay', args.operands.text, false, args.options.width),
});

/**
 * `cowthink [-W N] [text]`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [cowthinkCommand] });
 * ```
 */
export const cowthinkCommand = command_declare({
  name: 'cowthink',
  grammar: COW_GRAMMAR,
  help: {
    summary: 'The ChRIS brain thinks it',
    description: 'cowsay with a thought bubble.',
    examples: ['fortune | cowthink'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof COW_GRAMMAR>): Promise<CommandEnvelope> => cow_run('cowthink', args.operands.text, true, args.options.width),
});

/**
 * Draws the brain saying or thinking the piped text, else the words.
 *
 * @param name - The command's name, for its refusal.
 * @param words - The words given.
 * @param thought - Thought bubble rather than speech.
 * @param width - The wrap width asked for, or undefined for the default.
 * @returns The picture, or a refusal when there is nothing to say.
 *
 * @example
 * ```ts
 * await cow_run('cowsay', ['moo'], false, 20);
 * ```
 */
export async function cow_run(name: string, words: ReadonlyArray<string>, thought: boolean, width: number | undefined): Promise<CommandEnvelope> {
  const text: string | null = text_input(words);
  if (text === null) return envelope_error('', undefined, `${name}: nothing to say (pipe text in, or give it: fortune | ${name})\n`);
  const said: string = text.replace(/\n$/, '');
  return envelope_ok(cowsay_render(said, thought, width ?? COWSAY_WIDTH), { kind: 'games.cowsay', data: { text: said, thought } });
}

/**
 * `cowsay` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `cowsay`.
 * @returns The picture, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_cowsay(['-W', '20', 'moo']);
 * ```
 */
export async function builtin_cowsay(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(cowsayCommand, args);
}

/**
 * `cowthink` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `cowthink`.
 * @returns The picture, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_cowthink(['hmm']);
 * ```
 */
export async function builtin_cowthink(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(cowthinkCommand, args);
}
