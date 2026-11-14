/**
 * @file apropos and man: find a command by a word, and read its page, in the
 * words every Unix hand already knows (builtins/helpSections.ts).
 *
 * Declared in one record each (`aproposCommand`, `manCommand`): grammar,
 * help and handler.
 *
 * Key components:
 * - aproposCommand, manCommand: the declarations.
 * - builtin_apropos, builtin_man: the declarations run over words already split.
 * - apropos_run: the typed core of both.
 *
 * Typical usage:
 * ```ts
 * await builtin_apropos(['dicom']);
 * await builtin_man(['-k', 'pull']);
 * ```
 *
 * @module
 */
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { apropos_search } from '../helpSections.js';
import { help_answer, helpLookup_make } from '../help.js';
import { exitCode_set } from '../../core/handlerRun.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';

/** What an `apropos` line may hold. */
const APROPOS_GRAMMAR = {
  operands: [
    { name: 'word', kind: 'word', repeat: true, summary: 'The word to look for; several words are one phrase' },
  ],
} as const satisfies CommandGrammar;

/** What a `man` line may hold. */
const MAN_GRAMMAR = {
  operands: [
    { name: 'topic', kind: 'word', optional: true, repeat: true, summary: 'A command, a section or a Shell topic; with -k, the word to look for' },
  ],
  options: {
    keyword: { short: 'k', summary: 'Look for the word, as apropos does' },
  },
} as const satisfies CommandGrammar;

/**
 * `apropos <word…>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [aproposCommand] });
 * ```
 */
export const aproposCommand = command_declare({
  name: 'apropos',
  grammar: APROPOS_GRAMMAR,
  help: {
    summary: 'Find commands by a word in their name, summary or description',
    description: 'Search every command, section and Shell topic for a word, in any case. Nothing found is exit 1, as apropos is. man -k <word> is the same.',
    category: 'General',
    posix: { group: 'Shell', differs: 'as apropos: searches every command\'s line and description' },
    examples: ['apropos dicom', 'apropos link', 'man -k pull'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof APROPOS_GRAMMAR>): Promise<CommandEnvelope> => apropos_run(args.operands.word),
});

/**
 * `man <topic…> | man -k <word…>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [manCommand] });
 * ```
 */
export const manCommand = command_declare({
  name: 'man',
  grammar: MAN_GRAMMAR,
  help: {
    summary: 'The page for a command, a section or a Shell topic (help, by its Unix name)',
    description: 'man <name> is help <name>; man -k <word> is apropos <word>',
    category: 'General',
    posix: { group: 'Shell', differs: 'man <name> is help <name>; man -k is apropos' },
    examples: ['man grep', 'man PACS', 'man -k dicom'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof MAN_GRAMMAR>): Promise<CommandEnvelope> => man_run(args.operands.topic, args.options.keyword),
});

/**
 * Every command, section and Shell topic whose name, summary or description
 * holds the words, as one phrase.
 *
 * @param words - The words to look for.
 * @returns The matches, or nothing appropriate (exit 1, as apropos does).
 *
 * @example
 * ```ts
 * await apropos_run(['dicom']);
 * ```
 */
export async function apropos_run(words: readonly string[]): Promise<CommandEnvelope> {
  const word: string = words.join(' ').trim();
  const hits: string[] = apropos_search(word, helpLookup_make());
  if (hits.length === 0) {
    exitCode_set(1);
    return envelope_ok(`${word}: nothing appropriate.\n`);
  }
  return envelope_ok(`${hits.join('\n')}\n`);
}

/**
 * `man <topic>` is `help` for it; `man -k <word>` is apropos.
 *
 * @param topic - The words after the options.
 * @param keyword - Whether -k asked for apropos.
 * @returns The page, the matches, or a refusal for nothing asked.
 */
async function man_run(topic: readonly string[], keyword: boolean): Promise<CommandEnvelope> {
  if (topic.length === 0) {
    return envelope_error('', undefined, keyword
      ? 'apropos: a word to look for: apropos <word>\n'
      : 'man: what manual page do you want? man <command>, man <Section>, man -k <word>\n');
  }
  return keyword ? apropos_run(topic) : help_answer(topic);
}

/**
 * `apropos` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `apropos`.
 * @returns The matches, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_apropos(['dicom']);
 * ```
 */
export async function builtin_apropos(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(aproposCommand, args);
}

/**
 * `man` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `man`.
 * @returns The page, the matches, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_man(['ls']);
 * ```
 */
export async function builtin_man(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(manCommand, args);
}
