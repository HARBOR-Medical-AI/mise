/**
 * @file A declared command's usage line and help page, generated from its
 * grammar: the usage `help` shows and every refusal ends with, and the help
 * record `help`, `/bin` and the listings read.
 *
 * Key components:
 * - commandUsage_render: the usage line of a command or one of its subcommands.
 * - declarationHelp_derive: the help record of a declared command.
 *
 * Typical usage:
 * ```ts
 * commandUsage_render(lsCommand); // 'ls [-l1hrdfaA] [--sort <field>] [path…]'
 * const help: CommandHelp = declarationHelp_derive(berthCommand);
 * ```
 *
 * Dependencies: the declaration types and the registry's help record.
 *
 * @module
 */
import type { CommandHelp } from './commandRegistry.js';
import type {
  CommandDeclaration, CommandGrammar, OperandGrammar, OptionGrammar, OptionsGrammar, SubcommandGrammar,
} from './commandDeclaration.js';

/** The gap between a help line's left column and its summary. */
const COLUMN_GAP: number = 2;

/** What one stretch of a line holds: some operands and some options. */
interface LineGrammar {
  /** Its operands, in order. */
  readonly operands?: readonly OperandGrammar[];
  /** Its options. */
  readonly options?: OptionsGrammar;
}

/**
 * One operand as usage writes it: `<path>`, `[name]`, `<source>…`, `[path…]`.
 *
 * @param operand - The operand.
 * @returns Its word.
 */
function operand_usage(operand: OperandGrammar): string {
  const word: string = `${operand.name}${operand.repeat === true ? '…' : ''}`;
  return operand.optional === true ? `[${word}]` : `<${word}>`;
}

/**
 * One option's name as help writes it: `-l, --long`, `-l`, `--sort <field>`.
 *
 * @param option - The option.
 * @returns Its names, with its value's word.
 */
function optionNames_render(option: OptionGrammar): string {
  const names: string[] = [];
  if (option.short !== undefined) names.push(`-${option.short}`);
  if (option.long !== undefined) names.push(`--${option.long}`);
  const value: string = option.value === undefined ? '' : option.asks === true ? ` [<${option.value.name}>]` : ` <${option.value.name}>`;
  return `${names.join(', ')}${value}`;
}

/**
 * The options and operands of one stretch of a line, as usage writes them:
 * the one-letter switches bundled, the long-only switches, the options that
 * take a value, then the operands.
 *
 * @param line - The stretch's grammar.
 * @returns Its words, joined by spaces; empty when it takes nothing.
 */
function lineTail_render(line: LineGrammar): string {
  const options: OptionGrammar[] = Object.values(line.options ?? {});
  const shortSwitches: string = options
    .filter((option: OptionGrammar): boolean => option.value === undefined && option.short !== undefined)
    .map((option: OptionGrammar): string => option.short as string)
    .join('');
  const parts: string[] = [];
  if (shortSwitches !== '') parts.push(`[-${shortSwitches}]`);
  for (const option of options) {
    if (option.value === undefined && option.short === undefined && option.long !== undefined) parts.push(`[--${option.long}]`);
  }
  for (const option of options) {
    if (option.value === undefined) continue;
    const name: string = option.long !== undefined ? `--${option.long}` : `-${option.short ?? ''}`;
    parts.push(option.asks === true ? `[${name} [<${option.value.name}>]]` : `[${name} <${option.value.name}>]`);
  }
  for (const operand of line.operands ?? []) parts.push(operand_usage(operand));
  return parts.join(' ');
}

/**
 * Joins a head and a tail with a space, or gives the head alone.
 *
 * @param head - The words before.
 * @param tail - The words after, perhaps none.
 * @returns The line.
 */
function words_join(head: string, tail: string): string {
  return tail === '' ? head : `${head} ${tail}`;
}

/**
 * A command's usage line, or one subcommand's.
 *
 * @param declaration - The command.
 * @param subcommand - The subcommand, or none for the whole command.
 * @returns The line, starting with the command's name.
 *
 * @example
 * ```ts
 * commandUsage_render(berthCommand, 'drop'); // 'berth drop <name>'
 * ```
 */
export function commandUsage_render(declaration: CommandDeclaration, subcommand: string | null = null): string {
  const grammar: CommandGrammar = declaration.grammar;
  const subcommands: Readonly<Record<string, SubcommandGrammar>> | undefined = grammar.subcommands;
  if (subcommand !== null && subcommands !== undefined) {
    const chosen: SubcommandGrammar | undefined = subcommands[subcommand];
    if (chosen !== undefined) return words_join(`${declaration.name} ${subcommand}`, lineTail_render(chosen));
  }
  const own: string = lineTail_render({ ...(grammar.options !== undefined ? { options: grammar.options } : {}), ...(subcommands === undefined && grammar.operands !== undefined ? { operands: grammar.operands } : {}) });
  if (subcommands === undefined) return words_join(declaration.name, own);
  // The bare command's own options are its line, the first choice.
  const bareTail: string = grammar.bare?.options !== undefined ? lineTail_render({ options: grammar.bare.options }) : '';
  const choices: string = [
    ...(bareTail !== '' ? [bareTail] : []),
    ...Object.entries(subcommands).map(([word, sub]: [string, SubcommandGrammar]): string => words_join(word, lineTail_render(sub))),
  ].join(' | ');
  const bracketed: string = grammar.bare !== undefined ? `[${choices}]` : `<${choices}>`;
  return words_join(words_join(declaration.name, own), bracketed);
}

/**
 * Lines of a help column: each left part padded to the widest, then its summary.
 *
 * @param rows - Left part and summary, by row.
 * @param indent - The spaces before each row.
 * @returns The lines.
 */
function columns_render(rows: ReadonlyArray<readonly [string, string]>, indent: string): string[] {
  const width: number = Math.max(0, ...rows.map(([left]: readonly [string, string]): number => left.length));
  return rows.map(([left, summary]: readonly [string, string]): string => `${indent}${left.padEnd(width + COLUMN_GAP)}${summary}`);
}

/**
 * One option's help row: its names and its summary, an enum's words after.
 *
 * @param option - The option.
 * @returns The row.
 */
function optionRow_make(option: OptionGrammar): readonly [string, string] {
  const values: readonly string[] | undefined = option.value?.kind === 'enum' ? option.value.values : undefined;
  return [optionNames_render(option), values === undefined ? option.summary : `${option.summary} (${values.join(', ')})`];
}

/**
 * The help lines of a stretch's operands and options.
 *
 * @param line - The stretch's grammar.
 * @param indent - The spaces before each row.
 * @returns The lines.
 */
function lineRows_render(line: LineGrammar, indent: string): string[] {
  const rows: Array<readonly [string, string]> = [
    ...(line.operands ?? []).map((operand: OperandGrammar): readonly [string, string] => [operand_usage(operand), operand.summary]),
    ...Object.values(line.options ?? {}).map(optionRow_make),
  ];
  return rows.length === 0 ? [] : columns_render(rows, indent);
}

/**
 * The SUBCOMMANDS lines: the bare command's, then each subcommand's with its
 * operands and options beneath it.
 *
 * @param grammar - The command's grammar.
 * @returns The lines; none for a command without subcommands.
 */
function subcommandLines_render(grammar: CommandGrammar): string[] {
  const subcommands: Readonly<Record<string, SubcommandGrammar>> | undefined = grammar.subcommands;
  if (subcommands === undefined) return [];
  const heads: Array<readonly [string, string]> = [
    ...(grammar.bare !== undefined ? [['(none)', grammar.bare.summary] as const] : []),
    ...Object.entries(subcommands).map(([word, sub]: [string, SubcommandGrammar]): readonly [string, string] => [word, sub.summary]),
  ];
  const headLines: string[] = columns_render(heads, '');
  const lines: string[] = [];
  let at: number = 0;
  if (grammar.bare !== undefined) {
    lines.push(headLines[at++] as string);
    lines.push(...lineRows_render({ ...(grammar.bare.options !== undefined ? { options: grammar.bare.options } : {}) }, '  '));
  }
  for (const sub of Object.values(subcommands)) {
    lines.push(headLines[at++] as string);
    lines.push(...lineRows_render(sub, '  '));
  }
  return lines;
}

/**
 * The help record of a declared command: the usage its grammar generates,
 * its subcommands, operands and options with their summaries, and its prose.
 *
 * @param declaration - The command.
 * @returns The record `help` renders and the listings read.
 *
 * @example
 * ```ts
 * declarationHelp_derive(lsCommand).usage; // 'ls [-l1hrdfaA] [--sort <field>] [path…]'
 * ```
 */
export function declarationHelp_derive(declaration: CommandDeclaration): CommandHelp {
  const grammar: CommandGrammar = declaration.grammar;
  const subcommands: string[] = subcommandLines_render(grammar);
  const own: LineGrammar = {
    ...(grammar.subcommands === undefined && grammar.operands !== undefined ? { operands: grammar.operands } : {}),
    ...(grammar.options !== undefined ? { options: grammar.options } : {}),
  };
  // The subcommands lead the OPTIONS block under a heading of their own,
  // since that block keeps each line's indent and the subcommands' options
  // sit beneath them.
  const ownRows: string[] = lineRows_render(own, '');
  const options: string[] = subcommands.length === 0
    ? ownRows
    : ['SUBCOMMANDS:', ...subcommands.map((line: string): string => `  ${line}`), ...(ownRows.length > 0 ? ['', ...ownRows] : [])];
  return {
    usage: commandUsage_render(declaration),
    summary: declaration.help.summary,
    description: declaration.help.description,
    ...(declaration.help.category !== undefined ? { category: declaration.help.category } : {}),
    ...(declaration.help.posix !== undefined ? { posix: { ...declaration.help.posix } } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(declaration.help.examples !== undefined ? { examples: [...declaration.help.examples] } : {}),
  };
}

/**
 * The help record of one subcommand of a declared command (`help pacs
 * query`): its usage, its summary, and its operands and options with the
 * command's own beside them; the command's examples that run it.
 *
 * @param declaration - The command.
 * @param subcommand - The subcommand's word.
 * @returns The record, or undefined when the command has no such subcommand.
 *
 * @example
 * ```ts
 * subcommandHelp_derive(berthCommand, 'drop')?.usage; // 'berth drop <name>'
 * ```
 */
export function subcommandHelp_derive(declaration: CommandDeclaration, subcommand: string): CommandHelp | undefined {
  const subcommands: Readonly<Record<string, SubcommandGrammar>> | undefined = declaration.grammar.subcommands;
  if (subcommands === undefined || !Object.hasOwn(subcommands, subcommand)) return undefined;
  const chosen: SubcommandGrammar = subcommands[subcommand] as SubcommandGrammar;
  const options: string[] = lineRows_render({
    ...(chosen.operands !== undefined ? { operands: chosen.operands } : {}),
    options: { ...(chosen.options ?? {}), ...(declaration.grammar.options ?? {}) },
  }, '');
  const lead: string = `${declaration.name} ${subcommand}`;
  const examples: string[] = (declaration.help.examples ?? []).filter((line: string): boolean => line === lead || line.startsWith(`${lead} `));
  return {
    usage: commandUsage_render(declaration, subcommand),
    summary: chosen.summary,
    description: chosen.summary,
    ...(options.length > 0 ? { options } : {}),
    ...(examples.length > 0 ? { examples } : {}),
  };
}
