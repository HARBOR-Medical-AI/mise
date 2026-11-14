/**
 * @file What of `cat`'s line other modules read without loading cat.
 *
 * Defines the typed options the core reads, the usage text, and the option
 * predicate redirect filename inference uses. The line itself is parsed
 * against `catCommand`'s grammar (`cat.ts`). This module is intentionally
 * dependency-free so preprocessing can consume it without loading the file
 * reader or syntax highlighter.
 *
 * @module
 */

/** Whether syntax highlighting follows TTY detection, is forced, or is disabled. */
export type CatHighlightMode = 'auto' | 'always' | 'never';

/** The typed core's options: which files, and how they are presented. */
export interface CatArguments {
  binaryMode: boolean;
  highlightMode: CatHighlightMode;
  highlightLanguage?: string;
  filePaths: string[];
}

/** Canonical usage shared by the typed core's refusal and interactive help. */
export const CAT_USAGE: string =
  'cat [--binary] [--highlight[=language] | --no-highlight] <file> [file...]';

const BINARY_OPTION: string = '--binary';
const HIGHLIGHT_OPTION: string = '--highlight';
const HIGHLIGHT_LANGUAGE_PREFIX: string = '--highlight=';
const NO_HIGHLIGHT_OPTION: string = '--no-highlight';

/**
 * Returns whether an argument belongs to the `cat` option grammar.
 *
 * @param argument - One token from the command line.
 * @returns True for a recognized binary or highlight option.
 *
 * @example
 * ```ts
 * catArgument_isOption('--highlight=python'); // true
 * catArgument_isOption('notes.txt');          // false
 * ```
 */
export function catArgument_isOption(argument: string): boolean {
  return argument === BINARY_OPTION
    || argument === HIGHLIGHT_OPTION
    || argument === NO_HIGHLIGHT_OPTION
    || argument.startsWith(HIGHLIGHT_LANGUAGE_PREFIX);
}
