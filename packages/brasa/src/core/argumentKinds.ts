/**
 * @file Argument kinds: what an operand or an option's value is. A kind
 * checks a word and turns it into a value, says what that value is as a
 * schema, completes a word typed so far, and, for a path, expands a wildcard.
 *
 * The core's kinds mean the same in every session: `word`, `enum`, `int`,
 * `number`, `cfsPath`, `hostPath`, `variable` and `job`. A backend registers
 * its own through the backend seam (`Backend.argumentKinds`); a kind is found
 * among the core's first, then the installed backend's. A core command uses
 * only core kinds, which a test holds.
 *
 * Key components:
 * - ArgumentKind: one kind.
 * - CORE_KIND_NAMES: the core's kind names.
 * - argumentKind_get: finds a kind by name.
 * - argumentWord_check: checks one word against its argument's kind.
 *
 * Typical usage:
 * ```ts
 * const checked: ArgumentCheck = argumentWord_check({ kind: 'int', min: 1 }, '3');
 * if (checked.ok) checked.value; // 3
 * ```
 *
 * Dependencies: zod for the value schemas. Completion and expansion load
 * what they read (the session's paths, variables, joblets) when asked, so
 * the parse path loads none of it.
 *
 * @module
 */
import type { Dirent } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { z } from 'zod';

import type { ShellWord } from '../lib/parser.js';
import type { ArgumentGrammar } from './commandDeclaration.js';
import { backendInstalled_get } from './backend.js';

/** What checking a word came to: its value, or why it is not one, in a few words (`valid: a, b`). */
export type ArgumentCheck =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

/** What expanding a word came to: its words, or why it could not be expanded. */
export type ArgumentExpansion =
  | { readonly ok: true; readonly words: ShellWord[] }
  | { readonly ok: false; readonly reason: string };

/**
 * One kind of argument.
 *
 * @example
 * ```ts
 * const colour: ArgumentKind = {
 *   name: 'colour',
 *   summary: 'A colour name',
 *   word_read: (word: string): ArgumentCheck => ({ ok: true, value: word }),
 *   schema_make: (): z.ZodType => z.string(),
 * };
 * ```
 */
export interface ArgumentKind {
  /** The name an argument gives as its `kind`. */
  readonly name: string;
  /** What it is, in a few words, for help and the schema. */
  readonly summary: string;
  /** A word that looks like a negative number is this kind's operand, not an option. */
  readonly numeric?: boolean;
  /** It is a path, so an argument of it may declare `glob`. */
  readonly path?: boolean;
  /**
   * Turns a word into its value, or says why it is not one.
   *
   * @param word - The word as the line gave it.
   * @param argument - The argument's grammar (an enum's values, a number's bounds).
   * @returns The value, or the reason.
   */
  word_read(word: string, argument: ArgumentGrammar): ArgumentCheck;
  /**
   * The schema of the value, for a tool's input.
   *
   * @param argument - The argument's grammar.
   * @returns The zod schema.
   */
  schema_make(argument: ArgumentGrammar): z.ZodType;
  /**
   * Completes a word typed so far.
   *
   * @param partial - The word so far.
   * @param argument - The argument's grammar.
   * @returns The candidates that start with it.
   */
  words_complete?(partial: string, argument: ArgumentGrammar): Promise<string[]>;
  /**
   * Pathname expansion: the words a wildcard matches.
   *
   * @param words - The words, quoting kept.
   * @returns The expanded words, a word matching nothing left as written.
   */
  words_expand?(words: readonly ShellWord[]): Promise<ArgumentExpansion>;
}

/** The core's kind names, which a core command may use and no other. */
export const CORE_KIND_NAMES: ReadonlyArray<string> = ['word', 'enum', 'int', 'number', 'cfsPath', 'hostPath', 'variable', 'job'];

/** A variable's name, as `set` and `${name}` spell it. */
const VARIABLE_NAME: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A joblet as a word names it: `%3`, `3`, `%%`, `%+`, `%`. */
const JOB_WORD: RegExp = /^(?:%?\d+|%%|%\+|%)$/;

/** A whole number as a word writes it. */
const INT_WORD: RegExp = /^[+-]?\d+$/;

/**
 * Checks a number against an argument's bounds.
 *
 * @param value - The number.
 * @param argument - The argument, with its bounds.
 * @returns The value, or why it is out of bounds.
 */
function bounds_check(value: number, argument: ArgumentGrammar): ArgumentCheck {
  if (argument.min !== undefined && value < argument.min) return { ok: false, reason: `at least ${argument.min}` };
  if (argument.max !== undefined && value > argument.max) return { ok: false, reason: `at most ${argument.max}` };
  return { ok: true, value };
}

/**
 * A number schema with an argument's bounds.
 *
 * @param base - The number schema.
 * @param argument - The argument, with its bounds.
 * @returns The schema, bounded.
 */
function numberSchema_bound(base: z.ZodNumber, argument: ArgumentGrammar): z.ZodNumber {
  let schema: z.ZodNumber = base;
  if (argument.min !== undefined) schema = schema.min(argument.min);
  if (argument.max !== undefined) schema = schema.max(argument.max);
  return schema;
}

/**
 * Reads a word as text that is not empty.
 *
 * @param word - The word.
 * @param what - What it should be, for the reason.
 * @returns The word, or why it is not one.
 */
function text_read(word: string, what: string): ArgumentCheck {
  return word === '' ? { ok: false, reason: `an empty word is not ${what}` } : { ok: true, value: word };
}

/**
 * The candidates among some words that start with what was typed.
 *
 * @param words - The words.
 * @param partial - What was typed.
 * @returns Those that start with it.
 */
export function candidates_filter(words: ReadonlyArray<string>, partial: string): string[] {
  return words.filter((word: string): boolean => word.startsWith(partial));
}

/** Any word at all. */
const WORD_KIND: ArgumentKind = {
  name: 'word',
  summary: 'a word',
  word_read: (word: string): ArgumentCheck => ({ ok: true, value: word }),
  schema_make: (): z.ZodType => z.string(),
};

/** One of the words an argument lists. */
const ENUM_KIND: ArgumentKind = {
  name: 'enum',
  summary: 'one of the listed words',
  word_read: (word: string, argument: ArgumentGrammar): ArgumentCheck => {
    const values: readonly string[] = argument.values ?? [];
    return values.includes(word) ? { ok: true, value: word } : { ok: false, reason: `valid: ${values.join(', ')}` };
  },
  schema_make: (argument: ArgumentGrammar): z.ZodType => z.enum([...(argument.values ?? [])] as [string, ...string[]]),
  words_complete: async (partial: string, argument: ArgumentGrammar): Promise<string[]> => candidates_filter(argument.values ?? [], partial),
};

/** A whole number. */
const INT_KIND: ArgumentKind = {
  name: 'int',
  summary: 'a whole number',
  numeric: true,
  word_read: (word: string, argument: ArgumentGrammar): ArgumentCheck =>
    INT_WORD.test(word) ? bounds_check(Number(word), argument) : { ok: false, reason: 'not a whole number' },
  schema_make: (argument: ArgumentGrammar): z.ZodType => numberSchema_bound(z.number().int(), argument),
};

/** A number, whole or not. */
const NUMBER_KIND: ArgumentKind = {
  name: 'number',
  summary: 'a number',
  numeric: true,
  word_read: (word: string, argument: ArgumentGrammar): ArgumentCheck => {
    const value: number = word.trim() === '' ? Number.NaN : Number(word);
    return Number.isFinite(value) ? bounds_check(value, argument) : { ok: false, reason: 'not a number' };
  },
  schema_make: (argument: ArgumentGrammar): z.ZodType => numberSchema_bound(z.number(), argument),
};

/** A path in ChRIS's filesystem (CFS), as the session resolves it. */
const CFS_PATH_KIND: ArgumentKind = {
  name: 'cfsPath',
  summary: "a path in ChRIS's filesystem",
  path: true,
  word_read: (word: string): ArgumentCheck => text_read(word, 'a path'),
  schema_make: (): z.ZodType => z.string().min(1),
  words_complete: async (partial: string): Promise<string[]> => {
    const { cfsPaths_complete } = await import('../lib/completer/cfsPaths.js');
    return cfsPaths_complete(partial);
  },
  words_expand: async (words: readonly ShellWord[]): Promise<ArgumentExpansion> => {
    const { shellWords_expand } = await import('../lib/wildcard.js');
    const { errorStack } = await import('@fnndsc/fond');
    const expanded = await shellWords_expand(words, (): boolean => true);
    if (expanded.ok) return { ok: true, words: expanded.value };
    const reason: string | undefined = errorStack.stack_pop()?.message;
    return { ok: false, reason: reason ?? 'a wildcard could not be expanded' };
  },
};

/**
 * The folders and files under a host folder that start with a name, for
 * completion of a host path.
 *
 * The disk is loaded when asked, so parsing a line loads no filesystem.
 *
 * @param partial - The path typed so far.
 * @returns The candidates, a folder ending in `/`; none when the folder cannot be read.
 */
async function hostPaths_list(partial: string): Promise<string[]> {
  const { readdirSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const expanded: string = partial.startsWith('~/') ? join(homedir(), partial.slice(2)) : partial;
  const folder: string = expanded.endsWith('/') ? expanded : dirname(expanded);
  const typedFolder: string = partial.endsWith('/') ? partial : partial.slice(0, partial.lastIndexOf('/') + 1);
  const prefix: string = expanded.endsWith('/') ? '' : expanded.slice(expanded.lastIndexOf('/') + 1);
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(resolve(folder === '' ? '.' : folder), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry: Dirent): boolean => entry.name.startsWith(prefix))
    .map((entry: Dirent): string => `${typedFolder}${entry.name}${entry.isDirectory() ? '/' : ''}`)
    .sort();
}

/**
 * A path on the host the operator's surface sits on. It completes from the
 * engine's own disk only when that disk is the surface's: under a daemon the
 * engine's disk is a machine nobody at the surface sits at.
 */
const HOST_PATH_KIND: ArgumentKind = {
  name: 'hostPath',
  summary: "a path on this machine's filesystem",
  path: true,
  word_read: (word: string): ArgumentCheck => text_read(word, 'a path'),
  schema_make: (): z.ZodType => z.string().min(1),
  words_complete: async (partial: string): Promise<string[]> => {
    const { surface_get } = await import('./surface.js');
    return surface_get().capabilities.engineFilesystem ? hostPaths_list(partial) : [];
  },
};

/** A session variable's name. */
const VARIABLE_KIND: ArgumentKind = {
  name: 'variable',
  summary: 'a variable name',
  word_read: (word: string): ArgumentCheck =>
    VARIABLE_NAME.test(word) ? { ok: true, value: word } : { ok: false, reason: 'not a variable name' },
  schema_make: (): z.ZodType => z.string().regex(VARIABLE_NAME),
  words_complete: async (partial: string): Promise<string[]> => {
    const { variables_list } = await import('./variables.js');
    return candidates_filter(variables_list().map((variable: { name: string }): string => variable.name), partial);
  },
};

/** A joblet: `%3`, `3`, or the most recent, `%%`. */
const JOB_KIND: ArgumentKind = {
  name: 'job',
  summary: 'a job: %N, or %% for the most recent',
  word_read: (word: string): ArgumentCheck =>
    JOB_WORD.test(word) ? { ok: true, value: word } : { ok: false, reason: 'a job is %N, or %% for the most recent' },
  schema_make: (): z.ZodType => z.string().regex(JOB_WORD),
  words_complete: async (partial: string): Promise<string[]> => {
    const { joblets_running } = await import('./joblets.js');
    return candidates_filter(joblets_running().map((joblet: { number: number }): string => `%${joblet.number}`), partial);
  },
};

/** The core's kinds, by name. */
const CORE_KINDS: ReadonlyMap<string, ArgumentKind> = new Map(
  [WORD_KIND, ENUM_KIND, INT_KIND, NUMBER_KIND, CFS_PATH_KIND, HOST_PATH_KIND, VARIABLE_KIND, JOB_KIND]
    .map((kind: ArgumentKind): [string, ArgumentKind] => [kind.name, kind]),
);

/**
 * Finds a kind: the core's, then the installed backend's.
 *
 * @param name - The kind's name.
 * @returns The kind, or null when neither has it.
 *
 * @example
 * ```ts
 * argumentKind_get('cfsPath')?.path; // true
 * ```
 */
export function argumentKind_get(name: string): ArgumentKind | null {
  const core: ArgumentKind | undefined = CORE_KINDS.get(name);
  if (core !== undefined) return core;
  return backendInstalled_get()?.argumentKinds?.find((kind: ArgumentKind): boolean => kind.name === name) ?? null;
}

/**
 * Checks one word against its argument's kind.
 *
 * @param argument - The argument's grammar.
 * @param word - The word.
 * @returns The value, or why the word is not one (an unregistered kind says so).
 *
 * @example
 * ```ts
 * argumentWord_check({ kind: 'enum', values: ['a', 'b'] }, 'c'); // { ok: false, reason: 'valid: a, b' }
 * ```
 */
export function argumentWord_check(argument: ArgumentGrammar, word: string): ArgumentCheck {
  const kind: ArgumentKind | null = argumentKind_get(argument.kind);
  if (kind === null) return { ok: false, reason: `this session has no argument kind ${argument.kind}` };
  return kind.word_read(word, argument);
}
