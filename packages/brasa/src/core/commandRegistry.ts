/**
 * @file The command registry: every name the engine answers in-process, and the
 * handler that answers it.
 *
 * A command registers its declaration (`commandDeclaration.ts`): one record
 * holding its grammar, kinds, handler, holds and help prose. The registry
 * answers its name, and each alias, with a handler that parses the line
 * against the grammar first, in two forms: an envelope handler (it returns
 * its outcome as an envelope) and a plain one (it delivers that envelope).
 * Its help is generated from the same record, so help and behaviour cannot
 * drift apart. Dispatch, the capture path and the pipe's "is this a builtin"
 * test read the registry, never a table of their own; so do `help`, the
 * `/bin` builtin list and command completion, and completion and the tool
 * schema read the declaration itself (`commandDeclaration_get`).
 *
 * The words the shell or its surface answers before the registry (`sudo`,
 * `exit`, `!`, `clear`, `prompt`) have no handler here, only the page their
 * declaration in `shellWords.ts` gives.
 *
 * Handlers are kept in plain records and looked up by index: a name is a
 * builtin when it is `in` a record. A record inherits from
 * `Object.prototype`, so a name such as `toString` counts as a builtin too;
 * that is how the tables behaved, and changing it is a decision of its own.
 *
 * Listing order is kept explicitly (`commandOrder_set`), apart from which
 * group registered a name, so the core's and a backend's commands registering
 * separately do not reorder what the shell offers; an unlisted name lists
 * after, in registration order. A later registration of a name replaces the
 * earlier.
 *
 * @module
 */
import type { CommandEnvelope } from '@fnndsc/menu';

import { commandAliases_list, declaration_isParsed, type AnyCommandDeclaration } from './commandDeclaration.js';
import { declaredHandler_make } from './commandParse.js';
import { declarationHelp_derive } from './commandUsage.js';
import type { ShellWordDeclaration } from './shellWords.js';

/** A builtin that returns its outcome as an envelope. */
export type EnvelopeHandler = (args: string[]) => Promise<CommandEnvelope>;

/** A builtin that may print, and returns an envelope or nothing. */
export type CommandHandler = (args: string[]) => Promise<void | CommandEnvelope>;

/** A command's help: what `help <name>` shows, and what the listings summarise. */
export interface CommandHelp {
  usage: string;
  /** One line for listings; the description stands in when there is none. */
  summary?: string;
  /**
   * Where the command stands in `help`'s list (one of HELP_CATEGORIES). Every
   * runnable command declares one, or is on the games shelf; a test holds it,
   * so a new command cannot be missing from help.
   */
  category?: string;
  /**
   * The command mirrors a Unix utility: the group `help POSIX` lists it
   * under, and how chell's differs, in a line.
   */
  posix?: { group: 'Files' | 'Text' | 'System' | 'Shell'; differs: string };
  description: string;
  subcommands?: string[];
  options?: string[];
  examples?: string[];
}

/** A group of commands registered together. */
export interface CommandGroup {
  /** The words the shell answers before the registry: their pages, which `help` shows and `/bin` lists. */
  shellWords?: ReadonlyArray<ShellWordDeclaration>;
  /** Commands declared in one record each: handler, help and holds come from the declaration. */
  declarations?: ReadonlyArray<AnyCommandDeclaration>;
}

/**
 * A piece of session state a line may change: the working directory, or
 * the cohort. Variables are not a piece: a store is one step nothing can
 * come between, so assigning one holds nothing.
 */
export type SessionPiece = 'cwd' | 'cohort';

/** Who registers a group: the core, or the session's backend. */
export type CommandOwner = 'core' | 'backend';

/** The names the core registered, which no backend may take. */
const coreNames: Set<string> = new Set<string>();

const envelopeHandlers: Record<string, EnvelopeHandler> = {};
const plainHandlers: Record<string, CommandHandler> = {};
const helpEntries: Record<string, CommandHelp> = {};
const holdsEntries: Map<string, readonly SessionPiece[]> = new Map();
const declarationEntries: Map<string, AnyCommandDeclaration> = new Map();
/** Each alias of a declared command, to its declaration. */
const aliasEntries: Map<string, AnyCommandDeclaration> = new Map();

/** The listing order, by kind; empty until set. */
const listingOrder: { envelope: string[]; plain: string[]; help: string[] } = { envelope: [], plain: [], help: [] };

/**
 * Every envelope handler registered, by name: the record the engine's
 * `ENVELOPE_HANDLERS` export names. Read through {@link envelopeHandler_get}.
 */
export const ENVELOPE_HANDLERS: Readonly<Record<string, EnvelopeHandler>> = envelopeHandlers;

/**
 * Every plain handler registered, by name: the record the engine's
 * `COMMAND_HANDLERS` export names. Read through {@link plainHandler_get}.
 */
export const COMMAND_HANDLERS: Readonly<Record<string, CommandHandler>> = plainHandlers;

/**
 * Sets the order names list in, by kind, apart from which group registered
 * them: a registered name in the order lists there, and any other after,
 * in registration order.
 *
 * @param order - The names, by kind, in listing order.
 */
export function commandOrder_set(order: { envelope?: string[]; plain?: string[]; help?: string[] }): void {
  if (order.envelope !== undefined) listingOrder.envelope = [...order.envelope];
  if (order.plain !== undefined) listingOrder.plain = [...order.plain];
  if (order.help !== undefined) listingOrder.help = [...order.help];
}

/**
 * A record's names in listing order: those the order names, in its order,
 * then the rest in registration order.
 *
 * @param record - The record.
 * @param order - The listing order.
 * @returns The names.
 */
function names_ordered(record: Record<string, unknown>, order: string[]): string[] {
  const registered: string[] = Object.keys(record);
  const present: Set<string> = new Set(registered);
  const listed: string[] = order.filter((name: string): boolean => present.has(name));
  const listedSet: Set<string> = new Set(listed);
  return [...listed, ...registered.filter((name: string): boolean => !listedSet.has(name))];
}

/**
 * Registers a group of commands. The core's come first; a backend's are
 * added beside them and may not replace one (a backend never overrides a
 * core command).
 *
 * @param group - The commands, by name, in the order they list.
 * @param owner - Whose commands they are: the core's, or a backend's.
 * @throws {Error} When a backend's group names a core command.
 */
export function commands_register(group: CommandGroup, owner: CommandOwner = 'core'): void {
  const declared: string[] = (group.declarations ?? []).flatMap((declaration: AnyCommandDeclaration): string[] => [declaration.name, ...declarationAliases_list(declaration).map((alias: AnyCommandDeclaration): string => alias.name)]);
  const names: string[] = [...(group.shellWords ?? []).map((word: ShellWordDeclaration): string => word.name), ...declared];
  if (owner === 'backend') {
    const taken: string[] = names.filter((name: string): boolean => coreNames.has(name));
    if (taken.length > 0) throw new Error(`a backend cannot replace the core's commands: ${[...new Set(taken)].join(', ')}`);
  } else {
    for (const name of names) coreNames.add(name);
  }
  for (const word of group.shellWords ?? []) helpEntries[word.name] = shellWordHelp_derive(word);
  for (const declaration of group.declarations ?? []) declaration_register(declaration);
}

/**
 * A shell word's help record, from its declaration.
 *
 * @param word - The shell word.
 * @returns The record `help` renders.
 */
function shellWordHelp_derive(word: ShellWordDeclaration): CommandHelp {
  return {
    usage: word.usage,
    summary: word.help.summary,
    description: word.help.description,
    ...(word.help.category !== undefined ? { category: word.help.category } : {}),
    ...(word.help.examples !== undefined ? { examples: [...word.help.examples] } : {}),
  };
}

/**
 * The command under each of its other words, as the registry answers them.
 *
 * @param declaration - The command's declaration.
 * @returns One record per alias; none for a command without any.
 */
function declarationAliases_list(declaration: AnyCommandDeclaration): AnyCommandDeclaration[] {
  return commandAliases_list(declaration);
}

/**
 * Registers one declared command: its name answered by a handler that parses
 * the line against the grammar (an expression grammar's handler takes the
 * words), its help generated from the record, and what it holds. Each alias
 * is registered the same way under its own word, so its usage and refusals
 * say the word typed; the command alone is listed among the declarations,
 * which the schema reads.
 *
 * @param declaration - The command's declaration.
 */
function declaration_register(declaration: AnyCommandDeclaration): void {
  declarationEntries.set(declaration.name, declaration);
  declaredName_register(declaration);
  for (const alias of declarationAliases_list(declaration)) {
    aliasEntries.set(alias.name, alias);
    declaredName_register(alias);
  }
}

/**
 * Answers one word of a declared command: its handlers, its help entry and
 * what it holds.
 *
 * @param declaration - The command, named as the word.
 */
function declaredName_register(declaration: AnyCommandDeclaration): void {
  const handler: EnvelopeHandler = declaration_isParsed(declaration)
    ? declaredHandler_make(declaration)
    : (args: string[]): Promise<CommandEnvelope> => declaration.handler(args);
  envelopeHandlers[declaration.name] = handler;
  // The plain form delivers what the handler answers, as envelopeHandler_wrap
  // does; the sink is loaded when it runs, so the registry loads no output path.
  plainHandlers[declaration.name] = async (args: string[]): Promise<void> => {
    const envelope: CommandEnvelope | undefined = await handler(args);
    if (envelope === undefined) return;
    const { envelope_deliver } = await import('./sink.js');
    envelope_deliver(envelope);
  };
  helpEntries[declaration.name] = declaration_isParsed(declaration)
    ? declarationHelp_derive(declaration)
    : {
      usage: declaration.help.usage,
      summary: declaration.help.summary,
      description: declaration.help.description,
      ...(declaration.help.category !== undefined ? { category: declaration.help.category } : {}),
      ...(declaration.help.posix !== undefined ? { posix: { ...declaration.help.posix } } : {}),
      ...(declaration.help.examples !== undefined ? { examples: [...declaration.help.examples] } : {}),
    };
  if (declaration.holds !== undefined) holdsEntries.set(declaration.name, declaration.holds);
}

/**
 * A command's declaration, when it has one, by its name or an alias.
 *
 * @param name - The command name, or an alias of it (`feeds`).
 * @returns The declaration (an alias's named as the alias), or undefined for a word the registry does not answer (a shell word, or a `/bin` entry, whose declaration the backend makes).
 *
 * @example
 * ```ts
 * commandDeclaration_get('ls')?.grammar;
 * commandDeclaration_get('feeds')?.name; // 'feeds', the feed command under that word
 * ```
 */
export function commandDeclaration_get(name: string): AnyCommandDeclaration | undefined {
  return declarationEntries.get(name) ?? aliasEntries.get(name);
}

/**
 * Every declared command, in registration order.
 *
 * @returns The declarations.
 *
 * @example
 * ```ts
 * commandDeclarations_list().map((declaration) => declaration.name);
 * ```
 */
export function commandDeclarations_list(): AnyCommandDeclaration[] {
  return [...declarationEntries.values()];
}

/**
 * What a command holds of the session while it runs.
 * @param name - The command name.
 * @returns The pieces it changes (none for a read), or null when it has
 *   not said, and so holds the whole session.
 */
export function commandHolds_get(name: string): readonly SessionPiece[] | null {
  return holdsEntries.get(name) ?? null;
}

/**
 * The envelope handler a name reaches, by index (as the tables were read).
 *
 * @param name - The command name.
 * @returns The handler, or undefined.
 */
export function envelopeHandler_get(name: string): EnvelopeHandler | undefined {
  return envelopeHandlers[name];
}

/**
 * The plain handler a name reaches, by index (as the tables were read).
 *
 * @param name - The command name.
 * @returns The handler, or undefined.
 */
export function plainHandler_get(name: string): CommandHandler | undefined {
  return plainHandlers[name];
}

/**
 * Whether a name is answered in-process, by either kind of handler: the pipe's
 * test for running a segment in the engine rather than on the host.
 *
 * @param name - The command name.
 * @returns True when the name is `in` either record.
 */
export function builtinCommand_has(name: string): boolean {
  return name in envelopeHandlers || name in plainHandlers;
}

/**
 * Every word the engine runs itself (`builtinCommand_has` is true for each): what a session tells a surface on
 * another machine at attach, so the surface routes a pipeline as this engine will.
 *
 * @returns The names.
 *
 * @example
 * ```ts
 * builtinCommand_names().includes('wc'); // true
 * ```
 */
export function builtinCommand_names(): string[] {
  return [...new Set([...Object.keys(envelopeHandlers), ...Object.keys(plainHandlers)])].sort();
}

/** @returns The names answered by an envelope handler, in listing order. */
export function envelopeCommand_names(): string[] {
  return names_ordered(envelopeHandlers, listingOrder.envelope);
}

/** @returns The names answered by a plain handler, in listing order. */
export function plainCommand_names(): string[] {
  return names_ordered(plainHandlers, listingOrder.plain);
}

/**
 * A name's help, by index (as the help record was read).
 *
 * @param name - The command or topic name.
 * @returns The help, or undefined.
 */
export function commandHelpEntry_get(name: string): CommandHelp | undefined {
  return helpEntries[name];
}

/** @returns The names that have help, in listing order: `/bin`'s builtins and the shell's completions. */
export function helpTopic_names(): string[] {
  return names_ordered(helpEntries, listingOrder.help);
}
