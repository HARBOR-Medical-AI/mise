/**
 * @file Completion of a declared command's line, read from its grammar: its
 * subcommand words, its option names, an option's value by its kind, and an
 * operand by the kind of the operand it stands in.
 *
 * The line is walked as the parser walks it, but forgivingly: what is typed
 * so far may be half a line, and nothing is refused.
 *
 * Key components:
 * - declaredWord_complete: the candidates for the word being typed.
 *
 * Typical usage:
 * ```ts
 * await declaredWord_complete(berthCommand, [], 'an'); // ['anchor']
 * await declaredWord_complete(lsCommand, [], '-'); // ['-l', '-1', …, '--sort']
 * ```
 *
 * Dependencies: the argument kinds, whose completion sources answer the values.
 *
 * @module
 */
import { argumentKind_get, candidates_filter, type ArgumentKind } from '../../core/argumentKinds.js';
import {
  declaration_isParsed,
  type AnyCommandDeclaration, type ArgumentGrammar, type CommandGrammar, type OperandGrammar, type OptionGrammar, type OptionsGrammar, type SubcommandGrammar,
} from '../../core/commandDeclaration.js';

/** A word that reads as a negative number. */
const NEGATIVE_NUMBER: RegExp = /^-\d+(?:\.\d+)?$/;

/** Where a half-typed line stands. */
interface LineReach {
  /** The subcommand typed, or null. */
  subcommand: SubcommandGrammar | null;
  /** Whether `--` has ended the options. */
  optionsEnded: boolean;
  /** The option whose value the word being typed is, or null. */
  pending: OptionGrammar | null;
  /** How many operands stand before the word being typed. */
  operands: number;
  /** The operand words before the word being typed, in order. */
  operandWords: string[];
}

/**
 * The options in reach: the subcommand's (the bare command's while none is
 * typed), then the command's.
 *
 * @param grammar - The command's grammar.
 * @param subcommand - The subcommand's, or null.
 * @returns The options.
 */
function optionsInReach_list(grammar: CommandGrammar, subcommand: SubcommandGrammar | null): OptionGrammar[] {
  const own: OptionsGrammar = subcommand === null ? (grammar.bare?.options ?? {}) : (subcommand.options ?? {});
  return [...Object.values(own), ...Object.values(grammar.options ?? {})];
}

/**
 * The option a word of short options leaves waiting for its value: one
 * that takes a value and ends the word (`-o`); none when the value is in
 * the word (`-ofile`) or no letter takes one.
 *
 * @param options - The options in reach.
 * @param word - The word, `-` and letters.
 * @returns The option waiting, or null.
 */
function shortValue_pending(options: readonly OptionGrammar[], word: string): OptionGrammar | null {
  for (let index: number = 1; index < word.length; index += 1) {
    const option: OptionGrammar | undefined = options.find((one: OptionGrammar): boolean => one.short === word[index]);
    if (option?.value !== undefined) return index === word.length - 1 && option.value.optional !== true ? option : null;
  }
  return null;
}

/**
 * Walks the words before the one being typed, as the parser would.
 *
 * @param grammar - The command's grammar.
 * @param prior - The words after the command, before the word being typed.
 * @returns Where the line stands.
 */
function lineReach_walk(grammar: CommandGrammar, prior: readonly string[]): LineReach {
  const reach: LineReach = { subcommand: null, optionsEnded: false, pending: null, operands: 0, operandWords: [] };
  for (const word of prior) {
    const options: OptionGrammar[] = optionsInReach_list(grammar, reach.subcommand);
    if (reach.pending !== null) {
      reach.pending = null;
    } else if (!reach.optionsEnded && word === '--') {
      reach.optionsEnded = true;
    } else if (!reach.optionsEnded && word.startsWith('--')) {
      const name: string = word.slice(2);
      const option: OptionGrammar | undefined = options.find((one: OptionGrammar): boolean => one.family === undefined && one.long === name)
        ?? options.find((one: OptionGrammar): boolean => one.family?.pattern.test(name) === true);
      // An optional value is in the option's own word, so the next word is not it.
      reach.pending = option?.value !== undefined && option.value.optional !== true && !word.includes('=') ? option : null;
    } else if (!reach.optionsEnded && word.startsWith('-') && word.length > 1 && !NEGATIVE_NUMBER.test(word)) {
      reach.pending = shortValue_pending(options, word);
    } else if (grammar.subcommands !== undefined && reach.subcommand === null && reach.operands === 0 && !reach.optionsEnded && Object.hasOwn(grammar.subcommands, word)) {
      reach.subcommand = grammar.subcommands[word] ?? null;
    } else {
      reach.operands += 1;
      reach.operandWords.push(word);
    }
  }
  return reach;
}

/**
 * The operands a word at a place may stand in: the one there, or, past the
 * operands before a repeated one, the repeated one and those after it.
 *
 * @param operands - The operands, in order.
 * @param place - How many operands stand before the word.
 * @returns The operands it may be.
 */
function operandsAtPlace_list(operands: readonly OperandGrammar[], place: number): OperandGrammar[] {
  let at: number = 0;
  for (const [index, operand] of operands.entries()) {
    if (operand.repeat === true) return place === at ? [operand] : [operand, ...operands.slice(index + 1)];
    if (place === at) return [operand];
    at += 1;
  }
  return [];
}

/**
 * Completes a value by its argument's kind.
 *
 * @param argument - The argument.
 * @param partial - The value typed so far.
 * @returns The candidates.
 */
async function value_complete(argument: ArgumentGrammar, partial: string): Promise<string[]> {
  const kind: ArgumentKind | null = argumentKind_get(argument.kind);
  if (kind?.words_complete === undefined) return [];
  try {
    return await kind.words_complete(partial, argument);
  } catch {
    return [];
  }
}

/**
 * The option names in reach that start with a word: `-l` and `--long`
 * alike, and the names of a family the line can take.
 *
 * @param options - The options.
 * @param word - The word typed.
 * @param operands - The operand words before it, which a family's names may depend on.
 * @returns The names.
 */
async function optionNames_complete(options: readonly OptionGrammar[], word: string, operands: readonly string[]): Promise<string[]> {
  const names: string[] = [];
  for (const option of options) {
    if (option.short !== undefined) names.push(`-${option.short}`);
  }
  for (const option of options) {
    if (option.long !== undefined && option.family === undefined) names.push(`--${option.long}`);
  }
  // A family's names are the line's to say: a pipeline's fields, once the line names it.
  for (const option of options) {
    if (option.family?.names_list === undefined) continue;
    try {
      names.push(...(await option.family.names_list(operands)).map((name: string): string => `--${name}`));
    } catch {
      // A family that cannot say its names completes none.
    }
  }
  return candidates_filter([...new Set(names)], word);
}

/**
 * The candidates for the word being typed in a declared command's line.
 *
 * @param declaration - The command.
 * @param prior - The words after the command, before the one being typed.
 * @param word - The word typed so far (quotes removed).
 * @returns The candidates, each the whole word; a folder ends in `/`.
 *
 * @example
 * ```ts
 * await declaredWord_complete(lsCommand, ['--sort'], 's'); // ['size']
 * ```
 */
export async function declaredWord_complete(declaration: AnyCommandDeclaration, prior: readonly string[], word: string): Promise<string[]> {
  if (!declaration_isParsed(declaration)) return (await declaration.complete?.(prior, word)) ?? [];
  const grammar: CommandGrammar = declaration.grammar;
  const reach: LineReach = lineReach_walk(grammar, prior);
  if (reach.pending?.value !== undefined) return value_complete(reach.pending.value, word);
  const options: OptionGrammar[] = optionsInReach_list(grammar, reach.subcommand);
  if (!reach.optionsEnded && word.startsWith('--') && word.includes('=')) {
    const name: string = word.slice(2, word.indexOf('='));
    const option: OptionGrammar | undefined = options.find((one: OptionGrammar): boolean => one.long === name);
    if (option?.value === undefined) return [];
    const head: string = word.slice(0, word.indexOf('=') + 1);
    return (await value_complete(option.value, word.slice(head.length))).map((value: string): string => `${head}${value}`);
  }
  if (!reach.optionsEnded && word.startsWith('-') && !NEGATIVE_NUMBER.test(word)) return optionNames_complete(options, word, reach.operandWords);
  const subcommands: Readonly<Record<string, SubcommandGrammar>> | undefined = grammar.subcommands;
  const operands: readonly OperandGrammar[] = reach.subcommand?.operands ?? grammar.operands ?? [];
  const candidates: string[] = [];
  if (subcommands !== undefined && reach.subcommand === null && reach.operands === 0 && !reach.optionsEnded) {
    candidates.push(...candidates_filter(Object.keys(subcommands), word));
    if ((grammar.operands ?? []).length === 0) return candidates;
  }
  for (const operand of operandsAtPlace_list(operands, reach.operands)) {
    candidates.push(...await value_complete(operand, word));
  }
  return [...new Set(candidates)];
}
