/**
 * @file Command-line preprocessing: pure parsing of pipes, redirects and
 * wildcard/shell-escape detection.
 *
 * @module
 */
import * as path from 'path';
import { statSync } from 'fs';
import { catArgument_isOption } from '../builtins/fs/cat.args.js';
import { args_tokenize } from '../lib/parser.js';
import { Result, Ok, Err, errorStack } from '@fnndsc/fond';
import { backslash_escapesNext } from '../lib/quoting.js';

/**
 * Determines whether an argument of a command not yet declared belongs to the
 * CFS/VFS shell namespace. A declared command never asks: its grammar says
 * which operands glob (core/commandParse.ts), and each command leaves this
 * table as it is declared.
 *
 * Ordinary ChELL words expand before dispatch. `upload` marks its host-local
 * operands as a different realm and owns host-source expansion.
 *
 * @param command - Command word being executed.
 * @param _index - Zero-based argument position before expansion.
 * @param _argumentCount - Number of arguments before expansion.
 * @param _args - Argument values before expansion.
 * @returns True if the word is eligible for CFS/VFS pathname expansion.
 */
export function pathnameExpansion_isEligible(
  command: string,
  _index: number,
  _argumentCount: number,
  _args: readonly string[] = [],
): boolean {
  return command !== 'upload';
}

/**
 * Returns true if the input line is a shell escape (starts with `!`).
 *
 * @param line - Trimmed input line.
 */
export function command_shellEscape_detect(line: string): boolean {
  return line.startsWith('!');
}

/**
 * Parses a command line for pipe operators and returns segments.
 * Respects single and double quotes.
 *
 * @param line - The full command line.
 * @returns An array of command segments.
 */
export function pipes_parse(line: string): string[] {
  const segments: string[] = [];
  let currentSegment: string = '';
  let inSingleQuote: boolean = false;
  let inDoubleQuote: boolean = false;
  let escapeNext: boolean = false;

  for (let i = 0; i < line.length; i++) {
    const char: string = line[i];

    if (escapeNext) {
      currentSegment += char;
      escapeNext = false;
    } else if (char === '\\' && backslash_escapesNext(inSingleQuote, inDoubleQuote, line[i + 1])) {
      currentSegment += char;
      escapeNext = true;
    } else if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      currentSegment += char;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      currentSegment += char;
    } else if (char === '|' && !inSingleQuote && !inDoubleQuote) {
      segments.push(currentSegment.trim());
      currentSegment = '';
    } else {
      currentSegment += char;
    }
  }

  if (currentSegment.trim()) {
    segments.push(currentSegment.trim());
  }

  return segments;
}

/** Parsed output-redirection: command plus target file and append/overwrite. */
export interface RedirectInfo {
  command: string;
  operator: '>' | '>>';
  filePath: string;
}

/**
 * Parses a command line for output redirection operators (> or >>).
 * Respects single and double quotes.
 *
 * @param line - The full command line.
 * @returns An object with the command and redirect info, or null if no redirection.
 */
export function redirect_parse(line: string): RedirectInfo | null {
  let inSingleQuote: boolean = false;
  let inDoubleQuote: boolean = false;
  let escapeNext: boolean = false;

  for (let i = 0; i < line.length; i++) {
    const char: string = line[i];

    if (escapeNext) {
      escapeNext = false;
    } else if (char === '\\' && backslash_escapesNext(inSingleQuote, inDoubleQuote, line[i + 1])) {
      escapeNext = true;
    } else if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if (!inSingleQuote && !inDoubleQuote) {
      // Check for >>
      if (i < line.length - 1 && line[i] === '>' && line[i + 1] === '>') {
        const command: string = line.substring(0, i).trim();
        const filePath: string = line.substring(i + 2).trim();
        return { command, operator: '>>', filePath };
      }
      // Check for >
      else if (line[i] === '>') {
        const command: string = line.substring(0, i).trim();
        const filePath: string = line.substring(i + 1).trim();
        return { command, operator: '>', filePath };
      }
    }
  }

  return null;
}

/**
 * Resolves the final redirect target path. If the target is an existing directory
 * and the source command is `cat <file>`, resolves to `<dir>/<basename>`.
 * Returns Err (with message on errorStack) when the filename cannot be determined.
 *
 * @param filePath - The redirect target path as written by the user.
 * @param commandLine - The command whose output is being redirected.
 * @returns Ok(resolved path) or Err on failure.
 */
export function redirectTarget_resolve(filePath: string, commandLine: string): Result<string> {
  try {
    const stats = statSync(filePath);
    if (!stats.isDirectory()) {
      return Ok(filePath);
    }
  } catch (err: unknown) {
    const nodeErr: NodeJS.ErrnoException = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      return Ok(filePath);
    }
    errorStack.stack_push('error', `Redirect: filesystem error for '${filePath}': ${String(err)}`);
    return Err();
  }

  const tokens: string[] = args_tokenize(commandLine);
  if (tokens.length === 0) {
    errorStack.stack_push('error', `Redirect target '${filePath}' is a directory and no source command was provided.`);
    return Err();
  }

  const [command, ...args] = tokens;
  if (command !== 'cat') {
    errorStack.stack_push('error', `Redirect target '${filePath}' is a directory; cannot infer filename for command '${command}'.`);
    return Err();
  }

  const sourceArgs: string[] = args.filter((arg: string): boolean => !catArgument_isOption(arg));
  if (sourceArgs.length === 0) {
    errorStack.stack_push('error', `Redirect target '${filePath}' is a directory; no source file provided to 'cat'.`);
    return Err();
  }

  if (sourceArgs.length > 1) {
    errorStack.stack_push('error', `Redirect target '${filePath}' is a directory; 'cat' with multiple files cannot choose a single output name.`);
    return Err();
  }

  const sourceName: string = path.basename(sourceArgs[0]);
  return Ok(path.join(filePath, sourceName));
}
