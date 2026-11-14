/**
 * @file Command line argument tokenizer.
 *
 * Splits a command line into words while respecting single/double quotes and
 * backslash escapes. Quotes are stripped from rendered values, but their
 * pathname-expansion meaning is retained.
 */
import { backslash_escapesNext } from './quoting.js';

/**
 * One piece of a word: literal text, or a reference the line asked for.
 *
 * The tokenizer records references rather than resolving them, because
 * resolving is asynchronous (a pronoun asks the session) and tokenizing is
 * not. What it must record is the QUOTING, since that is known only here:
 * inside single quotes a `$` is text, inside double quotes a reference is
 * one operand however many values it carries, and bare it may become
 * several — the shell's rule, which the stack claims to wear.
 */
export interface ShellSegment {
  /** Literal text, when this piece is text. */
  text: string;
  /** The reference's name, when this piece is one. */
  ref: string | null;
  /** Whether the reference stood inside double quotes. */
  quoted: boolean;
}

/** A rendered shell word and the glob pattern it may contribute. */
export interface ShellWord {
  value: string;
  globPattern: string;
  pathnameExpansion: boolean;
  pathnameExpanded: boolean;
  /** The word's pieces, when it holds a reference; absent when it is plain text. */
  segments?: ShellSegment[];
}

/** String arguments with per-operand pathname-expansion provenance. */
export type ShellArguments = string[] & {
  pathnameExpanded?: readonly boolean[];
  pathnameExpansion?: readonly boolean[];
  /**
   * The words themselves, quoting kept, for a declared command: its operands
   * expand by kind after the line is parsed, so its words reach it unglobbed.
   */
  words?: readonly ShellWord[];
};

/**
 * What a reference looks like: `${name}` or a bare `$NAME`.
 *
 * A braced name may carry dots, which is how a variable names a field
 * of what it refers to (`${gather.series.folderPath}`); a bare one may not, so
 * `$HOME.txt` keeps its extension.
 */
const REFERENCE_PATTERN: RegExp = /^\$(?:\{([A-Za-z_][A-Za-z0-9_.]*)\}|([A-Za-z_][A-Za-z0-9_]*))/;

/**
 * What an index looks like: `@SER3`, `@STD001`, `@FIL2,3,7`, `@DIR2-4`.
 *
 * A row of the session's last answer, named by the handle the listing shows
 * beside it — the KIND it counts, then its place in that kind's sequence.
 * The sigil keeps it unambiguous: a directory called `SER3` is a path, and
 * `@SER3` never is.
 */
const INDEX_PATTERN: RegExp = /^@([A-Z]{3}\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)/;

/** Escapes wildcard metacharacters for literal minimatch use. */
function globLiteral_escape(value: string): string {
  return value.replace(/[\\*?\[\]]/g, '\\$&');
}

/**
 * Creates a shell word from a literal value.
 *
 * @param value - Rendered word value.
 * @returns A word that cannot trigger pathname expansion.
 */
export function shellWord_literal(value: string): ShellWord {
  return {
    value,
    globPattern: globLiteral_escape(value),
    pathnameExpansion: false,
    pathnameExpanded: false,
  };
}

/**
 * Creates an unquoted shell word from a compatibility string value.
 *
 * @param value - Rendered word value.
 * @returns A word whose wildcard syntax is eligible for pathname expansion.
 */
export function shellWord_unquoted(value: string): ShellWord {
  return {
    value,
    globPattern: value,
    pathnameExpansion: /[*?[\]]/.test(value),
    pathnameExpanded: false,
  };
}

/**
 * Converts shell words to compatibility string arguments.
 *
 * @param words - Parsed or expanded shell words.
 * @returns String arguments annotated with expansion provenance.
 */
export function shellWords_values(words: readonly ShellWord[]): ShellArguments {
  const values: ShellArguments = words.map((word: ShellWord): string => word.value) as ShellArguments;
  Object.defineProperty(values, 'pathnameExpanded', {
    value: words.map((word: ShellWord): boolean => word.pathnameExpanded),
    enumerable: false,
  });
  Object.defineProperty(values, 'pathnameExpansion', {
    value: words.map((word: ShellWord): boolean => word.pathnameExpansion),
    enumerable: false,
  });
  Object.defineProperty(values, 'words', { value: [...words], enumerable: false });
  return values;
}

/**
 * Checks whether one compatibility argument was produced by pathname expansion.
 *
 * @param args - String arguments created by {@link shellWords_values}.
 * @param index - Argument position to inspect.
 * @returns True when the argument was produced by pathname expansion.
 */
export function shellArguments_pathnameExpanded(args: readonly string[], index: number): boolean {
  const expanded: readonly boolean[] | undefined = (args as ShellArguments).pathnameExpanded;
  return expanded?.[index] === true;
}

/**
 * Applies environment substitution without discarding shell-word provenance.
 *
 * @param args - Compatibility arguments with pathname metadata.
 * @param expand - Per-token environment substitution function.
 * @returns Substituted arguments retaining the original pathname metadata.
 */
export function shellArguments_envRefsExpand(
  args: readonly string[],
  expand: (value: string) => string,
): ShellArguments {
  const values: ShellArguments = args.map(expand) as ShellArguments;
  const source: ShellArguments = args as ShellArguments;
  Object.defineProperty(values, 'pathnameExpanded', {
    value: source.pathnameExpanded,
    enumerable: false,
  });
  Object.defineProperty(values, 'pathnameExpansion', {
    value: source.pathnameExpansion,
    enumerable: false,
  });
  return values;
}

/**
 * Slices compatibility arguments while rebasing pathname metadata.
 *
 * @param args - Compatibility arguments with pathname metadata.
 * @param start - Inclusive offset of the first returned argument.
 * @returns The sliced arguments with matching provenance entries.
 */
export function shellArguments_slice(args: readonly string[], start: number): ShellArguments {
  const source: ShellArguments = args as ShellArguments;
  const values: ShellArguments = args.slice(start) as ShellArguments;
  Object.defineProperty(values, 'pathnameExpanded', {
    value: source.pathnameExpanded?.slice(start),
    enumerable: false,
  });
  Object.defineProperty(values, 'pathnameExpansion', {
    value: source.pathnameExpansion?.slice(start),
    enumerable: false,
  });
  Object.defineProperty(values, 'words', { value: source.words?.slice(start), enumerable: false });
  return values;
}

/**
 * Tokenizes a line while preserving quote and escape provenance for globbing.
 *
 * @param line - Raw command line input.
 * @returns Parsed shell words with rendered and glob-pattern representations.
 */
export function shellWords_tokenize(line: string): ShellWord[] {
  const tokens: ShellWord[] = [];
  let currentValue: string = '';
  let currentPattern: string = '';
  let pathnameExpansion: boolean = false;
  let wordStarted: boolean = false;
  let inSingle: boolean = false;
  let inDouble: boolean = false;
  let escapeNext: boolean = false;

  let segments: ShellSegment[] = [];
  let pendingText: string = '';

  const text_flush = (): void => {
    if (pendingText.length === 0) return;
    segments.push({ text: pendingText, ref: null, quoted: false });
    pendingText = '';
  };
  const character_append = (char: string, literal: boolean): void => {
    currentValue += char;
    currentPattern += literal ? globLiteral_escape(char) : char;
    pathnameExpansion ||= !literal && /[*?[\]]/.test(char);
    pendingText += char;
    wordStarted = true;
  };
  const reference_append = (name: string, raw: string, quoted: boolean): void => {
    text_flush();
    segments.push({ text: '', ref: name, quoted });
    // The value keeps the reference as written: every reader that does not
    // resolve references (completion, help, the tests) sees the line as the
    // operator typed it.
    currentValue += raw;
    currentPattern += globLiteral_escape(raw);
    wordStarted = true;
  };
  const word_pushCurrent = (): void => {
    if (!wordStarted) return;
    text_flush();
    const held: ShellSegment[] = segments;
    tokens.push({
      value: currentValue,
      globPattern: currentPattern,
      pathnameExpansion,
      pathnameExpanded: false,
      ...(held.some((segment: ShellSegment): boolean => segment.ref !== null) ? { segments: held } : {}),
    });
    currentValue = '';
    currentPattern = '';
    pathnameExpansion = false;
    wordStarted = false;
    segments = [];
    pendingText = '';
  };

  for (let i = 0; i < line.length; i++) {
    const char: string = line[i];

    if (escapeNext) {
      character_append(char, true);
      escapeNext = false;
      continue;
    }

    // POSIX quoting (lib/quoting.ts): in single quotes a backslash is a
    // character; in double quotes it escapes only $ ` " \ and newline.
    if (char === '\\' && backslash_escapesNext(inSingle, inDouble, line[i + 1])) {
      escapeNext = true;
      wordStarted = true;
      continue;
    }

    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      wordStarted = true;
      continue;
    }

    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      wordStarted = true;
      continue;
    }

    if (!inSingle && !inDouble && /\s/.test(char)) {
      word_pushCurrent();
      continue;
    }

    // An index into the session's last answer, unless it stands in quotes.
    // Only at the START of a word: `user@host` is not an index, and neither
    // is an email address in a tag value.
    if (char === '@' && !inSingle && !inDouble && !wordStarted) {
      const rest: string = line.slice(i);
      const match: RegExpMatchArray | null = rest.match(INDEX_PATTERN);
      if (match !== null) {
        reference_append(`@${match[1]}`, match[0], false);
        i += match[0].length - 1;
        continue;
      }
    }

    // A reference, unless it stands in single quotes, where a `$` is text —
    // which is what makes a quoted DICOM value or a literal price safe.
    if (char === '$' && !inSingle) {
      const rest: string = line.slice(i);
      const match: RegExpMatchArray | null = rest.match(REFERENCE_PATTERN);
      if (match !== null) {
        reference_append(match[1] ?? match[2], match[0], inDouble);
        i += match[0].length - 1;
        continue;
      }
    }

    character_append(char, inSingle || inDouble);
  }

  word_pushCurrent();
  return tokens;
}

/**
 * Tokenizes a command line preserving quoted segments with spaces.
 *
 * @param line - Raw command line input.
 * @returns Array of tokens with quotes removed.
 */
export function args_tokenize(line: string): string[] {
  return shellWords_tokenize(line).map((word: ShellWord): string => word.value);
}

/** What a reference turned out to be. */
export type ReferenceValue = { values: string[] } | null;

/** Answers what a reference refers to, or null when nothing does. */
export type ReferenceResolver = (name: string) => Promise<ReferenceValue>;

/** How reference expansion went. */
export type ReferenceExpansion =
  | { ok: true; words: ShellWord[] }
  | { ok: false; missing: string };

/**
 * Resolves the references in a line's words, respecting how they were quoted.
 *
 * The shell's rule, kept: a bare reference carrying several values becomes
 * several operands, a double-quoted one stays a single operand however many
 * values it holds, and a single-quoted `$` never got here at all. An
 * expanded value never globs afterwards — a filename with a bracket in it is
 * a filename, not a pattern.
 *
 * @param words - The tokenized words.
 * @param resolve - Answers what a reference refers to.
 * @param unresolvedStands - Leave an unanswerable reference as written
 *   instead of refusing: what a dry run does, having run nothing.
 * @returns The expanded words, or the reference nothing could answer.
 */
export async function shellWords_referencesExpand(
  words: readonly ShellWord[],
  resolve: ReferenceResolver,
  unresolvedStands: boolean = false,
): Promise<ReferenceExpansion> {
  const expanded: ShellWord[] = [];

  for (const word of words) {
    const segments: ShellSegment[] | undefined = word.segments;
    if (segments === undefined) {
      expanded.push(word);
      continue;
    }

    // A word that is nothing but one bare reference is the list case: it may
    // leave as several operands. Anything else joins into one word.
    const lone: boolean = segments.length === 1 && segments[0].ref !== null && !segments[0].quoted;
    let rendered: string = '';
    let split: string[] | null = null;

    for (const segment of segments) {
      if (segment.ref === null) { rendered += segment.text; continue; }
      const held: ReferenceValue = await resolve(segment.ref);
      if (held === null) {
        if (!unresolvedStands) return { ok: false, missing: segment.ref };
        // As written: an index is its own sigil, a name its `${…}`.
        rendered += segment.ref.startsWith('@') ? segment.ref : `\${${segment.ref}}`;
        continue;
      }
      if (lone && held.values.length !== 1) { split = held.values; continue; }
      rendered += held.values.join(' ');
    }

    if (split !== null) {
      for (const value of split) expanded.push(shellWord_literal(value));
      continue;
    }
    expanded.push(shellWord_literal(rendered));
  }

  return { ok: true, words: expanded };
}
