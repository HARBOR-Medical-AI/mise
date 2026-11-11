/**
 * @file Command list parser
 *
 * Parses a line's list of commands, joined by `;`, `&&` and `||`, while respecting quotes.
 *
 * @module
 */
import { backslash_escapesNext } from './quoting.js';

/** When a command of a list runs: always (`;`), after a success (`&&`), after a failure (`||`). */
export type ListCondition = 'always' | 'success' | 'failure';

/** One command of a list, and the condition its joiner puts on it. */
export interface ListCommand {
  /** The command, trimmed. */
  command: string;
  /** `always` for the first command and after `;`; `success` after `&&`; `failure` after `||`. */
  when: ListCondition;
}

/**
 * Parses a command line into its list: commands joined by `;`, `&&` and
 * `||`, as POSIX `sh` reads them. A joiner inside quotes is text. A single
 * `|` is a pipe and a single `&` a background mark; neither splits here.
 *
 * @param line - The full command line.
 * @returns The commands in order, each with the condition it runs under.
 *
 * @example
 * ```typescript
 * commandList_parse("cd ~/uploads && pwd")  // [{ command: 'cd ~/uploads', when: 'always' }, { command: 'pwd', when: 'success' }]
 * commandList_parse("ls x || echo none; pwd")  // ls x: always; echo none: failure; pwd: always
 * commandList_parse("echo 'a && b'")  // one command
 * ```
 */
export function commandList_parse(line: string): ListCommand[] {
  const commands: ListCommand[] = [];
  let currentCommand: string = '';
  let when: ListCondition = 'always';
  let inSingleQuote: boolean = false;
  let inDoubleQuote: boolean = false;
  let escapeNext: boolean = false;
  const command_close = (next: ListCondition): void => {
    const trimmed: string = currentCommand.trim();
    if (trimmed) commands.push({ command: trimmed, when });
    currentCommand = '';
    when = next;
  };

  for (let i: number = 0; i < line.length; i++) {
    const char: string = line[i];
    const quoted: boolean = inSingleQuote || inDoubleQuote;

    // A backslash escapes as POSIX quoting says (lib/quoting.ts), the rule
    // the word tokenizer and the pipe and redirect parsers read: an escaped
    // quote neither opens nor closes a quote, so `"it\"s; x"` is one command,
    // and in single quotes a backslash is a character, so `'a\'; b` is two.
    if (escapeNext) {
      currentCommand += char;
      escapeNext = false;
    } else if (char === '\\' && backslash_escapesNext(inSingleQuote, inDoubleQuote, line[i + 1])) {
      currentCommand += char;
      escapeNext = true;
    } else if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      currentCommand += char;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      currentCommand += char;
    } else if (char === ';' && !quoted) {
      command_close('always');
    } else if ((char === '&' || char === '|') && line[i + 1] === char && !quoted) {
      command_close(char === '&' ? 'success' : 'failure');
      i++;
    } else {
      currentCommand += char;
    }
  }
  command_close('always');
  return commands;
}

/**
 * Parses a command line into the commands of its list, without their
 * conditions: for a caller that looks at every command a line holds.
 * Respects quoted strings: a joiner inside quotes is not a separator.
 *
 * @param line - The full command line.
 * @returns An array of individual commands.
 *
 * @example
 * ```typescript
 * semicolons_parse("ls; pwd")                    // Returns: ["ls", "pwd"]
 * semicolons_parse("echo 'a;b'; pwd")            // Returns: ["echo 'a;b'", "pwd"]
 * semicolons_parse("cd /tmp && ls; cat file.txt")  // Returns: ["cd /tmp", "ls", "cat file.txt"]
 * ```
 */
export function semicolons_parse(line: string): string[] {
  return commandList_parse(line).map((item: ListCommand): string => item.command);
}
