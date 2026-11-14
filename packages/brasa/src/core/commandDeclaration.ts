/**
 * @file A command's declaration: its name, the grammar its line is parsed
 * against, the kind of every argument, its help prose, what it holds of the
 * session, and its handler, in one record.
 *
 * The grammar is the shell's own: subcommands; operands in order, each
 * optional or repeated; options with a short name, a long name, or both, and
 * a value or none. Every argument names a kind (`argumentKinds.ts`), which
 * checks its value and completes it. The handler receives a typed object the
 * compiler infers from the grammar, written `as const`: its operands, its
 * options and, for a subcommand, which one. Reading an undeclared option is a
 * build error, and the handler never sees the words.
 *
 * A command whose arguments form an expression language (`find`) declares
 * `grammar: 'expression'` instead, keeps its own parser and completion, and
 * receives its words after references expand.
 *
 * Key components:
 * - CommandGrammar: subcommands, operands and options, as a value.
 * - CommandDeclaration: the whole record for a parsed command.
 * - ExpressionDeclaration: the record for an expression-grammar command.
 * - CommandArguments: the typed object a handler receives.
 * - SubcommandArguments: one subcommand's share of it.
 * - command_declare: declares a command, inferring its handler's argument.
 *
 * Typical usage:
 * ```ts
 * const HELLO_GRAMMAR = {
 *   operands: [{ name: 'who', kind: 'word', optional: true, summary: 'Whom to greet' }],
 *   options: { loud: { short: 'l', long: 'loud', summary: 'Shout' } },
 * } as const satisfies CommandGrammar;
 * export const helloCommand = command_declare({
 *   name: 'hello',
 *   grammar: HELLO_GRAMMAR,
 *   help: { summary: 'Say hello', description: 'Greets someone.' },
 *   handler: async (args) => envelope_ok(`hello ${args.operands.who ?? 'world'}${args.options.loud ? '!' : ''}\n`),
 * });
 * ```
 *
 * Dependencies: types only (`@fnndsc/menu` for the envelope, the registry for
 * session pieces).
 *
 * @module
 */
import type { CommandEnvelope } from '@fnndsc/menu';

import type { SessionPiece } from './commandRegistry.js';

/**
 * What an argument is: the kind that checks and completes it, and that
 * kind's parameters.
 *
 * @example
 * ```ts
 * const sortField: ArgumentGrammar = { kind: 'enum', values: ['name', 'size'] };
 * ```
 */
export interface ArgumentGrammar {
  /** The kind's name: a core kind (`word`, `enum`, `int`, `number`, `cfsPath`, `hostPath`, `variable`, `job`) or one a backend registers. */
  readonly kind: string;
  /** The words an `enum` takes. */
  readonly values?: readonly string[];
  /** Pathname expansion for a `cfsPath` or `hostPath` operand: a wildcard in it matches paths. */
  readonly glob?: boolean;
  /** The least an `int` or `number` takes. */
  readonly min?: number;
  /** The most an `int` or `number` takes. */
  readonly max?: number;
}

/**
 * One operand: a word that is not an option, in its place on the line.
 *
 * @example
 * ```ts
 * const paths: OperandGrammar = { name: 'paths', kind: 'cfsPath', optional: true, repeat: true, glob: true, summary: 'What to list' };
 * ```
 */
export interface OperandGrammar extends ArgumentGrammar {
  /** Its name: the property the handler reads, and the word usage shows (`<path>`). */
  readonly name: string;
  /** One line for help and the schema. */
  readonly summary: string;
  /** It may be left out. */
  readonly optional?: boolean;
  /** It takes every word left over: at most one operand of a grammar repeats. */
  readonly repeat?: boolean;
}

/** An option's value: an argument with the word usage shows for it (`<field>`). */
export interface OptionValueGrammar extends ArgumentGrammar {
  /** The word usage shows: `--sort <field>`. */
  readonly name: string;
}

/**
 * One option: `-l`, `--long`, or both; a switch, or one that takes a value.
 *
 * @example
 * ```ts
 * const sort: OptionGrammar = { long: 'sort', summary: 'Sort by', value: { name: 'field', kind: 'enum', values: ['name', 'size'] } };
 * ```
 */
export interface OptionGrammar {
  /** Its one-character name, without the dash. */
  readonly short?: string;
  /** Its long name, without the dashes. */
  readonly long?: string;
  /** One line for help and the schema. */
  readonly summary: string;
  /** What it takes; absent, it is a switch. */
  readonly value?: OptionValueGrammar;
  /** A value option given more than once keeps every value; otherwise the last one counts. */
  readonly repeat?: boolean;
}

/** A grammar's options, by the property the handler reads them as. */
export type OptionsGrammar = { readonly [key: string]: OptionGrammar };

/**
 * A subcommand: the word after the command, with operands and options of its
 * own. The command's own options hold after it too.
 *
 * @example
 * ```ts
 * const drop: SubcommandGrammar = { summary: 'Remove one anchor', operands: [{ name: 'name', kind: 'word', summary: 'The anchor' }] };
 * ```
 */
export interface SubcommandGrammar {
  /** One line for help and the schema. */
  readonly summary: string;
  /** Its operands, in order. */
  readonly operands?: readonly OperandGrammar[];
  /** Its options. */
  readonly options?: OptionsGrammar;
}

/**
 * A command's grammar: what its line may hold, as a value. Written `as const`,
 * so the handler's argument is inferred from it.
 *
 * @example
 * ```ts
 * const grammar = { operands: [{ name: 'path', kind: 'cfsPath', summary: 'Where' }] } as const satisfies CommandGrammar;
 * ```
 */
export interface CommandGrammar {
  /** Its operands, in order; with subcommands, the words of the bare command. */
  readonly operands?: readonly OperandGrammar[];
  /** Its options, which hold after any subcommand too. */
  readonly options?: OptionsGrammar;
  /** Its subcommands, by the word that names each. */
  readonly subcommands?: { readonly [word: string]: SubcommandGrammar };
  /** What the command does with no subcommand; absent, a command with subcommands needs one. */
  readonly bare?: { readonly summary: string };
}

/**
 * A command's help prose: what `help` shows beside the usage the grammar
 * generates.
 *
 * @example
 * ```ts
 * const prose: CommandProse = { summary: 'List directory contents', description: 'Lists…', category: 'Navigation' };
 * ```
 */
export interface CommandProse {
  /** One line for listings. */
  readonly summary: string;
  /** What the command does, as one paragraph. */
  readonly description: string;
  /** Lines `help` shows under EXAMPLES; a `#` starts a comment. */
  readonly examples?: readonly string[];
  /** Where `help` lists it: one of the help sections. */
  readonly category?: string;
  /** It mirrors a Unix utility: the group `help POSIX` lists it under, and how it differs, in a line. */
  readonly posix?: { readonly group: 'Files' | 'Text' | 'System' | 'Shell'; readonly differs: string };
}

/** A kind's value type: a number for `int` and `number`, the declared words for `enum`, else text. */
type KindValue<A> = A extends { readonly kind: 'int' | 'number' }
  ? number
  : A extends { readonly kind: 'enum'; readonly values: readonly (infer V extends string)[] }
    ? V
    : string;

/** An operand's value: a list when it repeats, possibly absent when optional. */
type OperandValue<O> = O extends { readonly repeat: true }
  ? KindValue<O>[]
  : O extends { readonly optional: true }
    ? KindValue<O> | undefined
    : KindValue<O>;

/** The operands a grammar declares, by name. */
type OperandsOf<G> = G extends { readonly operands: readonly (infer O)[] }
  ? { readonly [P in O as P extends { readonly name: infer N extends string } ? N : never]: OperandValue<P> }
  : Record<never, never>;

/** The names of a grammar's operands that expand pathnames. */
type GlobNamesOf<G> = G extends { readonly operands: readonly (infer O)[] }
  ? O extends { readonly glob: true; readonly name: infer N extends string } ? N : never
  : never;

/** Whether each globbing operand's words came from pathname expansion. */
type ExpandedOf<G> = { readonly [N in GlobNamesOf<G>]: boolean };

/** An option's value: a switch is a boolean; a value option its value, or every value when it repeats. */
type OptionValue<O> = O extends { readonly value: infer V }
  ? O extends { readonly repeat: true } ? KindValue<V>[] : KindValue<V> | undefined
  : boolean;

/** The options a grammar declares, by property. */
type OptionsOf<G> = G extends { readonly options: infer M }
  ? { readonly [K in keyof M]: OptionValue<M[K]> }
  : Record<never, never>;

/** One parsed line: what a handler reads, for a grammar and the command's own options. */
interface ParsedLine<S, G> {
  /** The operands, by name. */
  readonly operands: OperandsOf<S>;
  /** The options, by property: the subcommand's and the command's. */
  readonly options: OptionsOf<S> & OptionsOf<G>;
  /** For each operand that globs, whether its words came from pathname expansion. */
  readonly expanded: ExpandedOf<S>;
}

/** The bare command's line, when the grammar allows one. */
type BareLine<G> = G extends { readonly subcommands: object }
  ? G extends { readonly bare: object } ? { readonly subcommand: null } & ParsedLine<G, G> : never
  : { readonly subcommand: null } & ParsedLine<G, G>;

/** Each subcommand's line. */
type SubcommandLine<G> = G extends { readonly subcommands: infer S }
  ? { [K in keyof S & string]: { readonly subcommand: K } & ParsedLine<S[K], G> }[keyof S & string]
  : never;

/**
 * The typed object a handler receives: which subcommand (null for none), its
 * operands, its options, and which operands came from pathname expansion.
 *
 * @example
 * ```ts
 * type LsArguments = CommandArguments<typeof LS_GRAMMAR>;
 * const paths: string[] = (args as LsArguments).operands.paths;
 * ```
 */
export type CommandArguments<G extends CommandGrammar> = BareLine<G> | SubcommandLine<G>;

/**
 * One subcommand's share of a handler's argument, for a function that runs it.
 *
 * @example
 * ```ts
 * function drop_run(args: SubcommandArguments<typeof BERTH_GRAMMAR, 'drop'>): CommandEnvelope { … }
 * ```
 */
export type SubcommandArguments<G extends CommandGrammar, K extends string> = Extract<CommandArguments<G>, { readonly subcommand: K }>;

/**
 * A command parsed against its grammar: the one record that is its help,
 * its completion, its schema and its dispatch.
 *
 * @example
 * ```ts
 * const declaration: CommandDeclaration<typeof HELLO_GRAMMAR> = helloCommand;
 * ```
 */
export interface CommandDeclaration<G extends CommandGrammar = CommandGrammar> {
  /** The word that runs it. */
  readonly name: string;
  /** What its line may hold. */
  readonly grammar: G;
  /** What `help` says of it. */
  readonly help: CommandProse;
  /** The pieces of the session it changes while it runs; absent, it holds the whole session. */
  readonly holds?: readonly SessionPiece[];
  /**
   * Runs it, given the line parsed and checked. A method, so a record of one
   * grammar stands where any declaration is read.
   *
   * @param args - The typed line.
   * @returns Its outcome.
   */
  handler(args: CommandArguments<G>): Promise<CommandEnvelope>;
}

/**
 * A command whose arguments are an expression language of its own (`find`):
 * it parses and completes them itself, under a ratchet.
 *
 * @example
 * ```ts
 * const findCommand: ExpressionDeclaration = { name: 'find', grammar: 'expression', help, handler: builtin_find };
 * ```
 */
export interface ExpressionDeclaration {
  /** The word that runs it. */
  readonly name: string;
  /** Says it parses its own words. */
  readonly grammar: 'expression';
  /** What `help` says of it; its usage is its own. */
  readonly help: CommandProse & { readonly usage: string };
  /** The pieces of the session it changes while it runs. */
  readonly holds?: readonly SessionPiece[];
  /**
   * Runs it over its words, references expanded and nothing globbed.
   *
   * @param args - The words after the command.
   * @returns Its outcome.
   */
  handler(args: string[]): Promise<CommandEnvelope>;
  /**
   * Completes one word of its line.
   *
   * @param words - The words before the one completed.
   * @param word - The word typed so far.
   * @returns The candidates.
   */
  complete?(words: readonly string[], word: string): Promise<string[]>;
}

/** Any declaration the registry holds. */
export type AnyCommandDeclaration = CommandDeclaration | ExpressionDeclaration;

/**
 * Declares a command. Returns its argument unchanged; what it adds is the
 * inference: the handler's argument is typed from the grammar beside it.
 *
 * @param declaration - The record.
 * @returns The same record.
 *
 * @example
 * ```ts
 * export const helloCommand = command_declare({ name: 'hello', grammar: HELLO_GRAMMAR, help, handler: async (args) => … });
 * ```
 */
export function command_declare<const G extends CommandGrammar>(declaration: CommandDeclaration<G>): CommandDeclaration<G> {
  return declaration;
}

/**
 * Whether a declaration parses its line against a grammar (rather than an
 * expression language of its own).
 *
 * @param declaration - The record.
 * @returns True for a grammar.
 *
 * @example
 * ```ts
 * if (declaration_isParsed(declaration)) declaration.grammar.operands;
 * ```
 */
export function declaration_isParsed(declaration: AnyCommandDeclaration): declaration is CommandDeclaration {
  return declaration.grammar !== 'expression';
}
