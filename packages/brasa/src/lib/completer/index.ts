/**
 * @file REPL Autocompletion.
 *
 * Provides tab-completion logic for the REPL: command words, then a
 * declared command's line from its declaration (subcommands, options, and
 * values by kind, `declared.ts`), and for a command not yet declared the
 * older rules: a backend's option hook, a CFS path for the commands that
 * take one, and a backend's `/bin` entries.
 *
 * @module
 */
import { backendInstalled_get } from '../../core/backend.js';
import { builtinCommands_list } from '../../builtins/help.js';
import { commandDeclaration_get } from '../../core/commandRegistry.js';
import type { AnyCommandDeclaration } from '../../core/commandDeclaration.js';
import { cfsPaths_complete } from './cfsPaths.js';
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

  const compoundWord: CompletionWord = completionWord_get(line);
  const options: ((args: string[], word: string) => Promise<string[] | null>) | undefined = backendInstalled_get()?.completion?.options;
  if (compoundWord.value.startsWith('--') && options !== undefined) {
    options(args, compoundWord.value).then((found: string[] | null): void => {
      if (found === null) {
        argumentCompletion_run(line, args, callback);
        return;
      }
      callback(null, [found, compoundWord.raw]);
    }).catch(() => callback(null, [[], compoundWord.raw]));
    return;
  }

  argumentCompletion_run(line, args, callback);
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
 * Completes an argument of a command not declared: a path, for a /bin
 * entry that takes one (a declared command's kinds complete its words).
 *
 * @param line - The input line.
 * @param args - Its words.
 * @param callback - Where the completions go.
 */
function argumentCompletion_run(line: string, args: string[], callback: CompleterCallback): void {
  // Case 2: Path Completion (Argument to specific commands)
  const cmd: string = args[0];
  const pathWord_complete = (): void => {
    const word: CompletionWord = completionWord_get(line);

    cfsPaths_complete(word.value).then((matches) => {
        callback(null, [matches.map((match: string) => completion_format(match, word)), word.raw]);
    }).catch((err) => {
        // On error, return no matches, don't crash REPL
        callback(null, [[], word.raw]);
    });
  };
  // A /bin entry's operand is a path (#1303, #1305): a directory or files,
  // first on the line. An option word is not one, and the word after `as`
  // is a subject's name, so neither completes.
  const pathArguments: ((command: string) => Promise<boolean>) | undefined = backendInstalled_get()?.completion?.pathArguments;
  if (pathArguments !== undefined) {
    const word: CompletionWord = completionWord_get(line);
    const previous: string | undefined = line.endsWith(' ') ? args[args.length - 1] : args[args.length - 2];
    const operandPosition: boolean = !word.value.startsWith('-') && previous !== 'as';
    pathArguments(cmd).then((takesPaths: boolean): void => {
      if (takesPaths && operandPosition) pathWord_complete();
      else callback(null, [[], operandPosition ? line : word.raw]);
    }).catch(() => callback(null, [[], line]));
    return;
  }
  callback(null, [[], line]);
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
