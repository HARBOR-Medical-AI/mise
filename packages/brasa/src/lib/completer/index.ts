/**
 * @file REPL Autocompletion.
 *
 * Provides tab-completion logic for the REPL: command words, then a
 * declared command's line from its declaration (subcommands, options, and
 * values by kind, `declared.ts`). A word the backend answers (a `/bin`
 * plugin or pipeline) completes from the declaration the backend makes of
 * it; any other word completes nothing.
 *
 * @module
 */
import { backendInstalled_get } from '../../core/backend.js';
import { builtinCommands_list } from '../../builtins/help.js';
import { commandDeclaration_get } from '../../core/commandRegistry.js';
import type { AnyCommandDeclaration, CommandDeclaration } from '../../core/commandDeclaration.js';
import { declaredWord_complete } from './declared.js';
import { args_tokenize } from '../parser.js';
import { backslash_escapesNext } from '../quoting.js';

/**
 * Callback function type for autocomplete results.
 * @param err - Error if completion failed, null otherwise.
 * @param result - Tuple of [matches array, original input string].
 */
type CompleterCallback = (err: Error | null, result: [string[], string]) => void;

interface CompletionWord {
  raw: string;
  value: string;
  quote: "'" | '"' | null;
}

function completionWord_get(line: string): CompletionWord {
  let start: number = 0;
  let quote: "'" | '"' | null = null;
  let escapeNext: boolean = false;

  for (let index: number = 0; index < line.length; index++) {
    const char: string = line[index];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\' && backslash_escapesNext(quote === "'", quote === '"', line[index + 1])) {
      escapeNext = true;
      continue;
    }
    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      start = index + 1;
    }
  }

  const raw: string = line.substring(start);
  const tokens: string[] = args_tokenize(raw);
  const value: string = tokens.length > 0 ? tokens[0] : '';
  const openingQuote: "'" | '"' | null =
    raw.startsWith("'") ? "'" : raw.startsWith('"') ? '"' : null;
  return { raw, value, quote: openingQuote };
}

function completion_format(completion: string, word: CompletionWord): string {
  if (word.quote === "'") {
    return `'${completion.replace(/'/g, `'\\''`)}`;
  }
  if (word.quote === '"') {
    return `"${completion.replace(/(["\\])/g, '\\$1')}`;
  }
  return completion.replace(/([\\\s'"`])/g, '\\$1');
}


/**
 * Computes autocomplete suggestions for a given input line.
 * Uses the callback style to support asynchronous operations (fetching files).
 *
 * @param line - The current input line.
 * @param callback - The callback function to return results.
 */
export function input_complete(line: string, callback: CompleterCallback): void {
  const trimmed: string = line.trimStart();
  const args: string[] = args_tokenize(trimmed);

  // Case 1: Command Completion (First word)
  // If we have only one token and the line doesn't end with space, we are typing the command
  // Or if line is empty
  const isCommandCompletion: boolean = args.length === 0 || (args.length === 1 && !line.endsWith(' '));

  if (isCommandCompletion) {
    // Check builtins first (instant, no async)
    const builtinHits: string[] = builtinCommands_list().filter((c: string) => c.startsWith(trimmed));

    // Always check plugins and combine results
    commandWords_get().then((pluginNames) => {
      const pluginHits: string[] = pluginNames.filter((c) => c.startsWith(trimmed));
      
      // Combine both builtins and plugins
      const allHits: string[] = [...builtinHits, ...pluginHits];
      callback(null, [allHits, trimmed]);
    }).catch(() => {
      // On error, return only builtin matches
      callback(null, [builtinHits, trimmed]);
    });
    return;
  }

  const declaration: AnyCommandDeclaration | undefined = commandDeclaration_get(args[0] ?? '');
  if (declaration !== undefined) {
    declaredLine_complete(line, args, declaration, callback);
    return;
  }

  // A word the backend answers (a /bin plugin or pipeline) completes from the
  // declaration it makes of it, as a builtin's line completes from its own.
  const backendDeclaration: ((command: string) => Promise<CommandDeclaration | null>) | undefined = backendInstalled_get()?.fallback?.declaration;
  if (backendDeclaration === undefined) {
    callback(null, [[], line]);
    return;
  }
  backendDeclaration(args[0] ?? '').then((found: CommandDeclaration | null): void => {
    if (found === null) {
      callback(null, [[], line]);
      return;
    }
    declaredLine_complete(line, args, found, callback);
  }).catch((): void => callback(null, [[], line]));
}

/**
 * Completes the word being typed in a declared command's line, from its
 * declaration.
 *
 * @param line - The input line.
 * @param args - Its words.
 * @param declaration - The command's declaration.
 * @param callback - Where the completions go.
 */
function declaredLine_complete(line: string, args: string[], declaration: AnyCommandDeclaration, callback: CompleterCallback): void {
  const word: CompletionWord = completionWord_get(line);
  const typing: boolean = !/\s$/.test(line);
  const prior: string[] = args.slice(1, typing ? -1 : undefined);
  declaredWord_complete(declaration, prior, word.value).then((found: string[]): void => {
    callback(null, [found.map((candidate: string): string => completion_format(candidate, word)), word.raw]);
  }).catch((): void => callback(null, [[], word.raw]));
}

/**
 * Command words beyond the registry's, from the backend (ChRIS: its plugins).
 *
 * @returns The words, or none.
 */
async function commandWords_get(): Promise<string[]> {
  const words: (() => Promise<string[]>) | undefined = backendInstalled_get()?.completion?.commandWords;
  return words === undefined ? [] : await words();
}
