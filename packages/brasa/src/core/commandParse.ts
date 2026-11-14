/**
 * @file Parses a declared command's line against its grammar, and runs it.
 *
 * The words reach here with references already expanded. Then, in order:
 * 1. The line's shape is parsed, GNU `getopt_long` for every command: `-f`,
 *    bundled short switches (`-rf`), `--force`; `--name x` and `--name=x`;
 *    `--` ends the options; options may stand anywhere among the operands;
 *    a word like `-3` is an operand when an operand of the line is numeric,
 *    or the value of the option that says `numeral` (`head -3`); a value
 *    that may be left out (`--highlight[=lang]`) is only in its own word;
 *    a value option that `asks`, given no value, is a question (null).
 *    Subcommand words and option names are literal and never globbed.
 * 2. Operands expand by kind: only a path operand that declares `glob` has
 *    its wildcards matched.
 * 3. Values are checked by kind.
 * A line that fails a step is refused in plain words, with the usage, before
 * the handler runs.
 *
 * Key components:
 * - commandLine_parse: a line's words to the typed object a handler reads.
 * - declaredCommand_run: parses and runs, refusing a bad line.
 * - declaredHandler_make: the registry's handler for a declared command.
 *
 * Typical usage:
 * ```ts
 * const parsed: LineParse = await commandLine_parse(lsCommand, shellWords_tokenize('-l docs'));
 * const envelope: CommandEnvelope = await declaredCommand_run(lsCommand, ['-l', 'docs']);
 * ```
 *
 * Dependencies: the argument kinds (each a value check and a pathname
 * expansion), the usage renderer, and the shell words' quoting.
 *
 * @module
 */
import chalk from 'chalk';
import { envelope_error, type CommandEnvelope } from '@fnndsc/menu';

import type { ShellArguments, ShellWord } from '../lib/parser.js';
import { argumentKind_get, argumentWord_check, type ArgumentCheck, type ArgumentExpansion, type ArgumentKind } from './argumentKinds.js';
import type {
  ArgumentGrammar, CommandArguments, CommandDeclaration, CommandGrammar, FamilyValue, OperandGrammar, OptionGrammar, OptionsGrammar, SubcommandGrammar,
} from './commandDeclaration.js';
import { commandUsage_render } from './commandUsage.js';
import { exitCode_set } from './handlerRun.js';

/** A word that reads as a negative number. */
const NEGATIVE_NUMBER: RegExp = /^-\d+(?:\.\d+)?$/;

/** A dash and digits: an option that says `numeral` with that value (`head -5`). */
const DASH_DIGITS: RegExp = /^-\d+$/;

/** What parsing a line came to: the handler's argument, or the refusal. */
export type LineParse =
  | { readonly ok: true; readonly args: ParsedArguments }
  | { readonly ok: false; readonly refusal: string };

/** The handler's argument, before the grammar's types are put on it. */
export interface ParsedArguments {
  /** The subcommand, or null for none. */
  readonly subcommand: string | null;
  /** The operands, by name. */
  readonly operands: Record<string, unknown>;
  /** The options, by property. */
  readonly options: Record<string, unknown>;
  /** For each operand that globs, whether its words came from pathname expansion. */
  readonly expanded: Record<string, boolean>;
}

/** An option in reach on a line: its property and its grammar. */
interface OptionEntry {
  /** The property the handler reads. */
  readonly key: string;
  /** Its grammar. */
  readonly option: OptionGrammar;
}

/** Every option of a family a line gave, in order. */
interface FamilyHeld {
  /** The names and values given. */
  readonly given: FamilyValue[];
}

/** What a line gave an option: a switch's `true`, a value option's words, null when one that asks was given none, or a family's options. */
type OptionHeld = true | string[] | null | FamilyHeld;

/** The line's shape: the subcommand, the options' words, and the operands' words. */
interface LineShape {
  /** The subcommand, or null. */
  readonly subcommand: string | null;
  /** Each option given: a switch's `true`, a value option's words in order, or null for one that asks. */
  readonly options: Map<string, OptionHeld>;
  /** The words that are operands, in order. */
  readonly operands: ShellWord[];
}

/** A refusal raised while a line is parsed: its words, after `<command>: `. */
class LineRefusal extends Error {
  /** The subcommand the line chose by then, for the usage that follows. */
  public readonly subcommand: string | null;

  /**
   * @param message - What was wrong.
   * @param subcommand - The subcommand chosen, if one was.
   */
  constructor(message: string, subcommand: string | null) {
    super(message);
    this.subcommand = subcommand;
  }
}

/**
 * The options in reach once a subcommand is chosen, or none is: its own (the
 * bare command's for none), then the command's.
 *
 * @param grammar - The command's grammar.
 * @param subcommand - The subcommand's grammar, or null for the bare command.
 * @returns The options.
 */
function optionEntries_list(grammar: CommandGrammar, subcommand: SubcommandGrammar | null): OptionEntry[] {
  const own: OptionsGrammar = subcommand === null ? (grammar.bare?.options ?? {}) : (subcommand.options ?? {});
  const command: OptionsGrammar = grammar.options ?? {};
  return [...Object.entries(own), ...Object.entries(command)]
    .map(([key, option]: [string, OptionGrammar]): OptionEntry => ({ key, option }));
}

/**
 * Whether any operand in reach is numeric, so a negative number is one.
 *
 * @param operands - The operands.
 * @returns True when one is.
 */
function operands_takeNumbers(operands: readonly OperandGrammar[]): boolean {
  return operands.some((operand: OperandGrammar): boolean => argumentKind_get(operand.kind)?.numeric === true);
}

/**
 * Records one option's value: a switch is set; a value is kept with any before it.
 *
 * @param options - The options so far.
 * @param entry - The option.
 * @param value - Its value, or null for a switch.
 */
function option_record(options: Map<string, OptionHeld>, entry: OptionEntry, value: string | null): void {
  if (value === null) {
    options.set(entry.key, true);
    return;
  }
  const held: OptionHeld | undefined = options.get(entry.key);
  options.set(entry.key, [...(Array.isArray(held) ? held : []), value]);
}

/**
 * Whether a value option stands with no value: nothing follows it, or, for
 * one that asks, another option does.
 *
 * @param option - The option.
 * @param next - The word after it, if any.
 * @returns True when it has no value.
 */
function value_isAbsent(option: OptionGrammar, next: ShellWord | undefined): boolean {
  if (next === undefined) return true;
  return option.asks === true && next.value.startsWith('-') && next.value.length > 1;
}

/** Where a parse stands as it walks the words. */
interface ShapeWalk {
  /** The subcommand chosen, or null. */
  subcommand: string | null;
  /** Its grammar, or null. */
  scope: SubcommandGrammar | null;
  /** The options in reach. */
  entries: OptionEntry[];
  /** Whether `--` has ended the options. */
  optionsEnded: boolean;
}

/**
 * Reads one long option word, `--name` or `--name=value`, taking its value
 * from the next word when it wants one.
 *
 * @param words - The line's words.
 * @param at - Where the option stands.
 * @param walk - Where the parse stands.
 * @param options - The options so far.
 * @returns Where the next word stands.
 * @throws {LineRefusal} For an unknown option, a missing value, or a value given to a switch.
 */
function longOption_read(words: readonly ShellWord[], at: number, walk: ShapeWalk, options: Map<string, OptionHeld>): number {
  const text: string = (words[at] as ShellWord).value.slice(2);
  const equals: number = text.indexOf('=');
  const name: string = equals === -1 ? text : text.slice(0, equals);
  const inline: string | null = equals === -1 ? null : text.slice(equals + 1);
  const entry: OptionEntry | undefined = walk.entries.find((one: OptionEntry): boolean => one.option.family === undefined && one.option.long === name);
  if (entry === undefined) {
    const family: OptionEntry | undefined = walk.entries.find((one: OptionEntry): boolean => one.option.family?.pattern.test(name) === true);
    if (family === undefined) throw new LineRefusal(`unrecognized option '--${name}'`, walk.subcommand);
    return familyOption_read(words, at, family, name, inline, options);
  }
  if (entry.option.value === undefined) {
    if (inline !== null) throw new LineRefusal(`option '--${name}' takes no value`, walk.subcommand);
    option_record(options, entry, null);
    return at + 1;
  }
  if (inline !== null || entry.option.value.optional === true) {
    // An optional value is only ever in the option's own word.
    option_record(options, entry, inline ?? '');
    return at + 1;
  }
  const next: ShellWord | undefined = words[at + 1];
  if (value_isAbsent(entry.option, next)) {
    if (entry.option.asks !== true) throw new LineRefusal(`option '--${name}' wants a value (<${entry.option.value.name}>)`, walk.subcommand);
    options.set(entry.key, null);
    return at + 1;
  }
  option_record(options, entry, (next as ShellWord).value);
  return at + 2;
}

/**
 * Reads one option of a family: its value in the same word after `=`, else
 * the next word unless that is a long option, else `true` (a switch, as
 * CUBE writes one).
 *
 * @param words - The line's words.
 * @param at - Where the option stands.
 * @param entry - The family.
 * @param name - The name typed, without the dashes.
 * @param inline - The value after `=`, or null.
 * @param options - The options so far.
 * @returns Where the next word stands.
 */
function familyOption_read(words: readonly ShellWord[], at: number, entry: OptionEntry, name: string, inline: string | null, options: Map<string, OptionHeld>): number {
  const held: OptionHeld | undefined = options.get(entry.key);
  const given: FamilyValue[] = held !== undefined && held !== null && held !== true && !Array.isArray(held) ? held.given : [];
  const next: ShellWord | undefined = words[at + 1];
  const takesNext: boolean = inline === null && next !== undefined && (!next.value.startsWith('--') || NEGATIVE_NUMBER.test(next.value));
  options.set(entry.key, { given: [...given, { name, value: inline ?? (takesNext ? (next as ShellWord).value : true) }] });
  return takesNext ? at + 2 : at + 1;
}

/**
 * Reads one word of short options, `-l` or bundled `-rf`; an option that
 * takes a value takes the rest of the word, or the next word.
 *
 * @param words - The line's words.
 * @param at - Where the word stands.
 * @param walk - Where the parse stands.
 * @param options - The options so far.
 * @returns Where the next word stands.
 * @throws {LineRefusal} For an unknown option or a missing value.
 */
function shortOptions_read(words: readonly ShellWord[], at: number, walk: ShapeWalk, options: Map<string, OptionHeld>): number {
  const text: string = (words[at] as ShellWord).value;
  for (let index: number = 1; index < text.length; index += 1) {
    const letter: string = text[index] as string;
    const entry: OptionEntry | undefined = walk.entries.find((one: OptionEntry): boolean => one.option.short === letter);
    if (entry === undefined) throw new LineRefusal(`invalid option -- '${letter}'`, walk.subcommand);
    if (entry.option.value === undefined) {
      option_record(options, entry, null);
      continue;
    }
    const rest: string = text.slice(index + 1);
    if (rest !== '' || entry.option.value.optional === true) {
      option_record(options, entry, rest);
      return at + 1;
    }
    const next: ShellWord | undefined = words[at + 1];
    if (value_isAbsent(entry.option, next)) {
      if (entry.option.asks !== true) throw new LineRefusal(`option '-${letter}' wants a value (<${entry.option.value.name}>)`, walk.subcommand);
      options.set(entry.key, null);
      return at + 1;
    }
    option_record(options, entry, (next as ShellWord).value);
    return at + 2;
  }
  return at + 1;
}

/**
 * Takes a word that is not an option: the subcommand, when the line has
 * none yet and the grammar has them; otherwise an operand.
 *
 * @param grammar - The command's grammar.
 * @param word - The word.
 * @param walk - Where the parse stands.
 * @param operands - The operands so far.
 * @param options - The options so far, which a chosen subcommand must take.
 * @throws {LineRefusal} For a word that names no subcommand of a command that takes no bare operand, or a subcommand that does not take an option given before it.
 */
function plainWord_take(grammar: CommandGrammar, word: ShellWord, walk: ShapeWalk, operands: ShellWord[], options: Map<string, OptionHeld>): void {
  const subcommands: Readonly<Record<string, SubcommandGrammar>> | undefined = grammar.subcommands;
  if (subcommands !== undefined && walk.subcommand === null && operands.length === 0 && !walk.optionsEnded) {
    const chosen: SubcommandGrammar | undefined = Object.hasOwn(subcommands, word.value) ? subcommands[word.value] : undefined;
    if (chosen !== undefined) {
      const entries: OptionEntry[] = optionEntries_list(grammar, chosen);
      // An option the bare command takes, given before a subcommand that does not take it, is refused, not dropped.
      for (const key of options.keys()) {
        if (entries.some((entry: OptionEntry): boolean => entry.key === key)) continue;
        const given: OptionGrammar | undefined = walk.entries.find((entry: OptionEntry): boolean => entry.key === key)?.option;
        const name: string = given?.long !== undefined ? `--${given.long}` : `-${given?.short ?? key}`;
        throw new LineRefusal(`option '${name}' is not one ${word.value} takes`, word.value);
      }
      walk.subcommand = word.value;
      walk.scope = chosen;
      walk.entries = entries;
      return;
    }
    if ((grammar.operands ?? []).length === 0) {
      throw new LineRefusal(`unknown subcommand '${word.value}' (${Object.keys(subcommands).join(', ')})`, null);
    }
  }
  operands.push(word);
}

/**
 * Parses a line's shape: which subcommand, which options with which values,
 * and which words are operands.
 *
 * @param grammar - The command's grammar.
 * @param words - The words after the command.
 * @returns The shape.
 * @throws {LineRefusal} For an unknown option, a missing value, or an unknown subcommand.
 */
function lineShape_parse(grammar: CommandGrammar, words: readonly ShellWord[]): LineShape {
  const walk: ShapeWalk = { subcommand: null, scope: null, entries: optionEntries_list(grammar, null), optionsEnded: false };
  const options: Map<string, OptionHeld> = new Map();
  const operands: ShellWord[] = [];
  let at: number = 0;
  while (at < words.length) {
    const word: ShellWord = words[at] as ShellWord;
    const text: string = word.value;
    const reach: readonly OperandGrammar[] = walk.scope?.operands ?? grammar.operands ?? [];
    if (walk.optionsEnded) {
      plainWord_take(grammar, word, walk, operands, options);
      at += 1;
    } else if (text === '--') {
      walk.optionsEnded = true;
      at += 1;
    } else if (text.startsWith('--')) {
      at = longOption_read(words, at, walk, options);
    } else if (DASH_DIGITS.test(text) && walk.entries.some((entry: OptionEntry): boolean => entry.option.numeral === true)) {
      option_record(options, walk.entries.find((entry: OptionEntry): boolean => entry.option.numeral === true) as OptionEntry, text.slice(1));
      at += 1;
    } else if (text.startsWith('-') && text.length > 1 && !(NEGATIVE_NUMBER.test(text) && operands_takeNumbers(reach))) {
      at = shortOptions_read(words, at, walk, options);
    } else {
      plainWord_take(grammar, word, walk, operands, options);
      at += 1;
    }
  }
  if (grammar.subcommands !== undefined && walk.subcommand === null && grammar.bare === undefined && (grammar.operands ?? []).length === 0) {
    throw new LineRefusal(`missing subcommand (${Object.keys(grammar.subcommands).join(', ')})`, null);
  }
  return { subcommand: walk.subcommand, options, operands };
}

/**
 * Hands the operand words to the operands, in order: each required operand
 * one word, each optional one a word while words are left over, and the one
 * that repeats every word left after that.
 *
 * @param operands - The operands, in order.
 * @param words - The operand words.
 * @param subcommand - The subcommand, for a refusal.
 * @returns Each operand's words, by name.
 * @throws {LineRefusal} For too few words, or too many.
 */
function operandWords_assign(operands: readonly OperandGrammar[], words: readonly ShellWord[], subcommand: string | null): Map<string, ShellWord[]> {
  const required: number = operands.filter((operand: OperandGrammar): boolean => operand.optional !== true).length;
  if (words.length < required) {
    const missing: OperandGrammar | undefined = operands.filter((operand: OperandGrammar): boolean => operand.optional !== true)[words.length];
    throw new LineRefusal(`missing operand <${missing?.name ?? 'operand'}>`, subcommand);
  }
  let spare: number = words.length - required;
  let at: number = 0;
  const assigned: Map<string, ShellWord[]> = new Map();
  for (const operand of operands) {
    let take: number = operand.optional === true ? 0 : 1;
    if (operand.repeat === true) {
      take += spare;
      spare = 0;
    } else if (operand.optional === true && spare > 0) {
      take = 1;
      spare -= 1;
    }
    assigned.set(operand.name, words.slice(at, at + take));
    at += take;
  }
  const extra: ShellWord | undefined = words[at];
  if (extra !== undefined) throw new LineRefusal(`unexpected operand '${extra.value}'`, subcommand);
  return assigned;
}

/**
 * Expands one operand's words by its kind: a path operand that declares
 * `glob` has its wildcards matched; every other word stands as written.
 *
 * @param operand - The operand.
 * @param words - Its words.
 * @param subcommand - The subcommand, for a refusal.
 * @returns Its words after expansion, and whether any came from it.
 * @throws {LineRefusal} When the expansion fails, or gives one-word operand several words.
 */
async function operandWords_expand(operand: OperandGrammar, words: ShellWord[], subcommand: string | null): Promise<{ words: ShellWord[]; expanded: boolean }> {
  const kind: ArgumentKind | null = argumentKind_get(operand.kind);
  if (operand.glob !== true || kind?.words_expand === undefined || !words.some((word: ShellWord): boolean => word.pathnameExpansion)) {
    return { words, expanded: false };
  }
  const result: ArgumentExpansion = await kind.words_expand(words);
  if (!result.ok) throw new LineRefusal(result.reason, subcommand);
  if (operand.repeat !== true && result.words.length > 1) {
    throw new LineRefusal(`<${operand.name}> takes one path; '${words[0]?.value ?? ''}' matches ${result.words.length}`, subcommand);
  }
  return { words: result.words, expanded: result.words.some((word: ShellWord): boolean => word.pathnameExpanded) };
}

/**
 * Checks one word against its argument, refusing it in the line's words.
 *
 * @param argument - The argument.
 * @param word - The word.
 * @param where - The argument as the refusal names it (`<path>`, `'--sort'`).
 * @param subcommand - The subcommand, for a refusal.
 * @returns The value.
 * @throws {LineRefusal} When the word is not one of the kind.
 */
function word_check(argument: ArgumentGrammar, word: string, where: string, subcommand: string | null): unknown {
  const checked: ArgumentCheck = argumentWord_check(argument, word);
  if (!checked.ok) throw new LineRefusal(`invalid argument '${word}' for ${where} (${checked.reason})`, subcommand);
  return checked.value;
}

/**
 * The options' values, checked: a switch true or false, a value option its
 * last value (or every value when it repeats), absent as undefined (or none).
 *
 * @param entries - The options in reach.
 * @param given - What the line gave.
 * @param subcommand - The subcommand, for a refusal.
 * @returns The values, by property.
 * @throws {LineRefusal} For a value not of its kind.
 */
function optionValues_check(entries: readonly OptionEntry[], given: Map<string, OptionHeld>, subcommand: string | null): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const { key, option } of entries) {
    const held: OptionHeld | undefined = given.get(key);
    if (option.family !== undefined) {
      values[key] = held !== undefined && held !== null && held !== true && !Array.isArray(held) ? held.given : [];
      continue;
    }
    if (option.value === undefined) {
      values[key] = held === true;
      continue;
    }
    if (held === null) {
      values[key] = option.repeat === true ? [] : null;
      continue;
    }
    const where: string = option.long !== undefined ? `'--${option.long}'` : `'-${option.short ?? ''}'`;
    const checked: unknown[] = (Array.isArray(held) ? held : []).map((word: string): unknown => word_check(option.value as ArgumentGrammar, word, where, subcommand));
    values[key] = option.repeat === true ? checked : checked.at(-1);
  }
  return values;
}

/**
 * Parses a declared command's line into the object its handler reads.
 *
 * @param declaration - The command.
 * @param words - The words after the command, references expanded, quoting kept.
 * @returns The handler's argument, or the refusal (`ls: unrecognized option '--x'; usage: …`).
 *
 * @example
 * ```ts
 * const parsed: LineParse = await commandLine_parse(lsCommand, [shellWord_literal('-l')]);
 * if (parsed.ok) parsed.args.options['long']; // true
 * ```
 */
export async function commandLine_parse(declaration: CommandDeclaration, words: readonly ShellWord[]): Promise<LineParse> {
  const grammar: CommandGrammar = declaration.grammar;
  try {
    const shape: LineShape = lineShape_parse(grammar, words);
    const scope: SubcommandGrammar | null = shape.subcommand === null ? null : (grammar.subcommands?.[shape.subcommand] ?? null);
    // An operand that stands only without an option is gone when the option is given.
    const operandGrammars: readonly OperandGrammar[] = (scope !== null ? (scope.operands ?? []) : (grammar.operands ?? []))
      .filter((operand: OperandGrammar): boolean => operand.unless === undefined || !shape.options.has(operand.unless));
    const assigned: Map<string, ShellWord[]> = operandWords_assign(operandGrammars, shape.operands, shape.subcommand);
    const operands: Record<string, unknown> = {};
    const expanded: Record<string, boolean> = {};
    for (const operand of operandGrammars) {
      const own: { words: ShellWord[]; expanded: boolean } = await operandWords_expand(operand, assigned.get(operand.name) ?? [], shape.subcommand);
      if (operand.glob === true) expanded[operand.name] = own.expanded;
      const values: unknown[] = own.words.map((word: ShellWord): unknown => word_check(operand, word.value, `<${operand.name}>`, shape.subcommand));
      operands[operand.name] = operand.repeat === true ? values : values[0];
    }
    const options: Record<string, unknown> = optionValues_check(optionEntries_list(grammar, scope), shape.options, shape.subcommand);
    return { ok: true, args: { subcommand: shape.subcommand, operands, options, expanded } };
  } catch (error: unknown) {
    if (!(error instanceof LineRefusal)) throw error;
    const where: string = error.subcommand === null ? declaration.name : `${declaration.name}: ${error.subcommand}`;
    return { ok: false, refusal: `${where}: ${error.message}; usage: ${commandUsage_render(declaration, error.subcommand)}` };
  }
}

/**
 * Words as a line hands them on: the shell words the line carried, quoting
 * kept, when they came with it; otherwise each string as a literal word,
 * which globs nothing (a caller that split its own words expands nothing).
 *
 * @param args - The arguments.
 * @returns The words.
 *
 * @example
 * ```ts
 * const words: ShellWord[] = lineWords_read(args); // a line's own words, or literals
 * ```
 */
export function lineWords_read(args: readonly string[]): ShellWord[] {
  const carried: readonly ShellWord[] | undefined = (args as ShellArguments).words;
  if (carried !== undefined && carried.length === args.length) return [...carried];
  return args.map((value: string): ShellWord => ({ value, globPattern: value.replace(/[\\*?[\]]/g, '\\$&'), pathnameExpansion: false, pathnameExpanded: false }));
}

/**
 * Parses a line against its declaration and runs the handler on it; a bad
 * line is refused on the error channel, the handler never called.
 *
 * @param declaration - The command.
 * @param args - The words after the command.
 * @returns The handler's envelope, or the refusal's.
 *
 * @example
 * ```ts
 * await declaredCommand_run(lsCommand, ['--nosuch']); // renderedErr: "ls: unrecognized option '--nosuch'; usage: …"
 * ```
 */
export async function declaredCommand_run(declaration: CommandDeclaration, args: readonly string[]): Promise<CommandEnvelope> {
  const parsed: LineParse = await commandLine_parse(declaration, lineWords_read(args));
  if (!parsed.ok) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(parsed.refusal)}\n`);
  }
  // The grammar's types are put on the object here, the one place the
  // parse meets them: the parse built it from that same grammar.
  return declaration.handler(parsed.args as CommandArguments<CommandGrammar>);
}

/**
 * The registry's handler for a declared command: the words a line hands
 * on, parsed against the declaration.
 *
 * @param declaration - The command.
 * @returns The handler.
 *
 * @example
 * ```ts
 * const handler = declaredHandler_make(lsCommand);
 * await handler(['-l']);
 * ```
 */
export function declaredHandler_make(declaration: CommandDeclaration): (args: string[]) => Promise<CommandEnvelope> {
  return (args: string[]): Promise<CommandEnvelope> => declaredCommand_run(declaration, args);
}
