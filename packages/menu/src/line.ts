/**
 * @file A line for the mise shell, built from data.
 *
 * A surface that builds a line from a value it was given (a path, a name, a
 * description) writes the value through `arg_quote`: the shell then reads it
 * as one word, exactly as it is, whatever it holds. Inside single quotes the
 * shell takes every character literally (`$`, `"`, `;`, `|`, `>`, `*`, a
 * leading `@`, a newline), which double quotes do not: `$NAME` still expands
 * inside those.
 *
 * What a line means as grammar is not quoted, and is written as grammar on
 * purpose: `feed_12`, `%3`, `@SER2`, a trailing `&`, and the home (`~/`),
 * for which `home_path` writes the tilde outside the quotes.
 *
 * This is the mise shell's grammar only. A line for a POSIX `sh`, or an
 * OpenSSH option, is a different grammar and is quoted by its own function,
 * where it is built.
 *
 * Key components:
 * - arg_quote, path_quote: a value, or a path, always quoted.
 * - word_write, path_write, home_path: the same for a line an operator reads, bare when plain.
 * - line_split, script_lines: such a line, and a script of them, read back.
 *
 * Typical usage:
 * ```ts
 * terminal.line_run(`cd ${path_quote(folder)}`);
 * ```
 *
 * Dependencies: none.
 *
 * @module
 */

/**
 * Quotes a value as one word of a mise-shell line: single quotes keep every
 * character. A single quote cannot stand inside them, so it closes the
 * quote, stands escaped, and opens it again: `it's` is written `'it'\''s'`.
 *
 * @param value - Any text.
 * @returns The value, as one word of a line.
 *
 * @example
 * ```typescript
 * `rm ${arg_quote('/home/u/a "b" $c')}`; // rm '/home/u/a "b" $c'
 * ```
 */
export function arg_quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** A value that reads as itself with no quotes: one plain word that is not grammar anywhere in a line. */
const PLAIN_WORD: RegExp = /^[A-Za-z0-9_./:=,+][A-Za-z0-9_./:=,+@%-]*$/;

/**
 * Writes a value as one word of a line an operator will read: bare when it
 * is one plain word (letters, digits and `_ . / : = , + @ % -`, not
 * beginning with `@`, `%` or `-`), quoted by `arg_quote` otherwise. The
 * shell reads it as the same one word either way.
 *
 * @param value - Any text.
 * @returns The value, as one word of a line.
 *
 * @example
 * ```typescript
 * word_write('ada@example.org'); // ada@example.org
 * word_write('two words');       // 'two words'
 * ```
 */
export function word_write(value: string): string {
  return PLAIN_WORD.test(value) ? value : arg_quote(value);
}

/**
 * Quotes a path as one word of a mise-shell line, as the path it is. The
 * shell reads a leading `~/` as the home whether or not it was quoted, so a
 * path that literally begins with a tilde is written from where one stands
 * (`./~/x`), which names the same place and is never the home.
 *
 * @param path - The path, absolute or relative.
 * @returns The path, as one word of a line.
 *
 * @example
 * ```typescript
 * `cat ${path_quote('~/notes')}`; // cat './~/notes'  (a folder named "~")
 * ```
 */
export function path_quote(path: string): string {
  return arg_quote(path.startsWith('~') ? `./${path}` : path);
}

/**
 * Writes a path as one word of a line an operator will read: bare when it
 * is one plain word, quoted by `path_quote` otherwise.
 *
 * @param path - The path, absolute or relative.
 * @returns The path, as one word of a line.
 *
 * @example
 * ```typescript
 * path_write('/scripts/vm/store.mise'); // /scripts/vm/store.mise
 * path_write('/home/u/my notes');       // '/home/u/my notes'
 * ```
 */
export function path_write(path: string): string {
  return PLAIN_WORD.test(path) ? path : path_quote(path);
}

/**
 * Writes a path under the session's home: the tilde outside the quotes,
 * where the shell reads it as the home, and the rest as `word_write`
 * writes it (bare when plain, quoted otherwise).
 *
 * @param rest - The path under the home, without a leading slash; empty for the home itself.
 * @returns The word.
 *
 * @example
 * ```typescript
 * `ls ${home_path('gather/my set.json')}`; // ls ~/'gather/my set.json'
 * `ls ${home_path('gather/a.json')}`;      // ls ~/gather/a.json
 * ```
 */
export function home_path(rest: string): string {
  return rest === '' ? '~' : `~/${word_write(rest)}`;
}

/** One word of a line: quoted runs, escaped characters and plain characters, with no bare whitespace between. */
const WORD: RegExp = /(?:'[^']*'|"(?:[^"\\]|\\[\s\S])*"|\\[\s\S]|\\$|[^\s'"\\])+/g;

/** A word's pieces, in order: a single-quoted run, a double-quoted run, an escaped character, plain text. */
const PIECE: RegExp = /'([^']*)'|"((?:[^"\\]|\\[\s\S])*)"|\\([\s\S])|(\\$|[^'"\\]+)/g;

/**
 * Reads a word back as the value it carries: its quotes removed, and its
 * escapes resolved as each kind of quote resolves them.
 *
 * @param word - One word, as it stands in the line.
 * @returns The value.
 */
function word_unquote(word: string): string {
  return word.replace(PIECE, (_piece: string, single?: string, double?: string, escaped?: string, plain?: string): string => {
    if (double !== undefined) return double.replace(/\\(["\\])/g, '$1');
    return single ?? escaped ?? plain ?? '';
  });
}

/**
 * Splits a line into its words as `arg_quote` wrote them: whitespace
 * separates words outside quotes; single quotes keep every character;
 * double quotes keep every character but a backslash before `"` or `\`;
 * a backslash outside quotes keeps the character after it. Nothing is
 * expanded: this is for a surface's own verbs, which have no variables.
 *
 * @param line - The line.
 * @returns Its words, quotes removed; null when a quote is left open.
 *
 * @example
 * ```typescript
 * line_split("file %2 open '/home/u/my folder'"); // ['file', '%2', 'open', '/home/u/my folder']
 * ```
 */
export function line_split(line: string): string[] | null {
  const tokens: string[] = line.match(WORD) ?? [];
  // What is left once the words and the space between them are taken away is a quote that never closed.
  if (line.replace(WORD, '').trim() !== '') return null;
  return tokens.map(word_unquote);
}

/**
 * Splits a script into its lines, as `arg_quote` wrote them: a newline ends
 * a line only outside quotes, so a quoted value that holds a newline stays
 * in its line.
 *
 * @param script - The script's text.
 * @returns Its lines, as written (quotes kept, nothing trimmed).
 *
 * @example
 * ```typescript
 * script_lines("a 'one\ntwo'\nb"); // ["a 'one\ntwo'", 'b']
 * ```
 */
export function script_lines(script: string): string[] {
  const lines: string[] = [];
  let line: string = '';
  let quote: '\'' | '"' | null = null;
  for (let at = 0; at < script.length; at++) {
    const char: string = script.charAt(at);
    if (quote === null && char === '\n') {
      lines.push(line);
      line = '';
      continue;
    }
    line += char;
    if (quote === '\'') {
      if (char === '\'') quote = null;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '\\' && at + 1 < script.length) line += script.charAt(++at);
    } else if (char === '\'' || char === '"') {
      quote = char;
    } else if (char === '\\' && at + 1 < script.length) {
      line += script.charAt(++at);
    }
  }
  lines.push(line);
  return lines;
}
