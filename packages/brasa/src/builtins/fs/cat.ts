/**
 * @file `cat`: prints files of ChRIS's filesystem (CFS), text or binary.
 *
 * Declared in one record (`catCommand`): one or more files, each a path
 * that may be a wildcard, read where the store keeps it
 * (`storePath_resolve`: a path through a link reads what it points at).
 * Binary bytes stream through the active output sink; text returns in the
 * envelope. Text highlighting uses cli-highlight with a forced-color theme
 * only after option/TTY policy has allowed ANSI; ordinary pipe and redirect
 * sinks strip ANSI downstream.
 *
 * Key components:
 * - catCommand: the declaration.
 * - builtin_cat: the declaration run over words already split.
 * - cat_run: the typed core behind both, and the typed API.
 *
 * Typical usage:
 * ```ts
 * await builtin_cat(['--highlight=python', 'source']);
 * await cat_run({ filePaths: ['notes.txt'], binaryMode: false, highlightMode: 'never' });
 * ```
 *
 * Dependencies: the session's filesystem and output sink, and cli-highlight.
 *
 * @module
 */
import * as path from 'path';
import chalk from 'chalk';
import { highlight, supportsLanguage, type Theme } from 'cli-highlight';
import { vfsDispatcher_get } from '../../core/filesystem.js';
import { path_resolve, storePath_resolve, error_stripDebugPrefix } from '../utils.js';
import { sink_get } from '../../core/sink.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import {
  CAT_USAGE,
  type CatArguments,
  type CatHighlightMode,
} from './cat.args.js';
import { errorStack, Result, Ok, Err, StackMessage, errno_words, vfsRefusal_text, type VfsOutcome } from '@fnndsc/fond';

/**
 * A read's answer as a Result, a refusal said on the error stack in the
 * words cat puts after its operand: the mount's own reason, else the
 * errno's words (`Is a directory`), the path being said once, by cat.
 *
 * @param outcome - The read's answer.
 * @param operation - Which read, for the words of an unoffered one.
 * @param target - The absolute path.
 * @returns The value, or Err with the reason stacked.
 */
function read_said<T>(outcome: VfsOutcome<T>, operation: 'read' | 'readBinary', target: string): Result<T> {
  if (outcome.ok) return Ok(outcome.value);
  const words: string = outcome.reason
    ?? (outcome.errno === 'EROFS' ? vfsRefusal_text(operation, outcome, target) : errno_words(outcome.errno));
  errorStack.stack_push('error', words);
  return Err();
}

/**
 * Reads a file whole, as text, through the session's filesystem; a refusal
 * is said on the error stack, in the words the mount gave.
 *
 * @param target - The absolute path.
 * @returns The text, or Err with the reason stacked.
 */
async function text_read(target: string): Promise<Result<string>> {
  return read_said(await vfsDispatcher_get().read(await storePath_resolve(target)), 'read', target);
}

/**
 * Reads a file whole, as bytes, through the session's filesystem.
 *
 * @param target - The absolute path.
 * @returns The bytes, or Err with the reason stacked.
 */
async function bytes_read(target: string): Promise<Result<Buffer>> {
  return read_said(await vfsDispatcher_get().readBinary(await storePath_resolve(target)), 'readBinary', target);
}
import { envelope_ok, envelope_error, type CommandEnvelope } from '@fnndsc/menu';
import { exitCode_set } from '../../core/handlerRun.js';

/** Delay before a slow group projection becomes visible as progress. */
const GROUP_PROGRESS_DELAY_MS: number = 300;

/** User-facing status shown while CUBE group memberships are hydrated. */
const GROUP_PROGRESS_LABEL: string = 'Resolving /etc/group memberships…';

/** cli-highlight language names inferred for commonly viewed text formats. */
const SOURCE_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.bash': 'bash',
  '.c': 'c',
  '.cc': 'cpp',
  '.cfg': 'ini',
  '.cjs': 'javascript',
  '.conf': 'ini',
  '.cpp': 'cpp',
  '.css': 'css',
  '.cts': 'typescript',
  '.cxx': 'cpp',
  '.diff': 'diff',
  '.dockerfile': 'dockerfile',
  '.go': 'go',
  '.h': 'c',
  '.hh': 'cpp',
  '.hpp': 'cpp',
  '.htm': 'xml',
  '.html': 'xml',
  '.hxx': 'cpp',
  '.ini': 'ini',
  '.java': 'java',
  '.js': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.jsx': 'jsx',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.less': 'less',
  '.lua': 'lua',
  '.markdown': 'markdown',
  '.md': 'markdown',
  '.mjs': 'javascript',
  '.mts': 'typescript',
  '.patch': 'diff',
  '.php': 'php',
  '.pl': 'perl',
  '.pm': 'perl',
  '.proto': 'protobuf',
  '.py': 'python',
  '.pyw': 'python',
  '.r': 'r',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.sass': 'scss',
  '.scss': 'scss',
  '.sh': 'bash',
  '.sql': 'sql',
  '.svg': 'xml',
  '.swift': 'swift',
  '.toml': 'toml',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.zsh': 'bash',
};

/** cli-highlight language names inferred from conventional extensionless files. */
const SOURCE_LANGUAGE_BY_BASENAME: Readonly<Record<string, string>> = {
  '.env': 'ini',
  'dockerfile': 'dockerfile',
  'gnumakefile': 'makefile',
  'makefile': 'makefile',
};

/** Forced-color palette used only after terminal/highlight policy allows ANSI. */
const HIGHLIGHT_COLOR = new chalk.Instance({ level: 3 });

/** High-contrast token palette shared by every highlighted language. */
const HIGHLIGHT_THEME: Theme = {
  addition: HIGHLIGHT_COLOR.green,
  attr: HIGHLIGHT_COLOR.yellow,
  attribute: HIGHLIGHT_COLOR.cyan,
  built_in: HIGHLIGHT_COLOR.cyanBright,
  bullet: HIGHLIGHT_COLOR.yellow,
  class: HIGHLIGHT_COLOR.blueBright,
  code: HIGHLIGHT_COLOR.green,
  comment: HIGHLIGHT_COLOR.gray,
  deletion: HIGHLIGHT_COLOR.redBright,
  doctag: HIGHLIGHT_COLOR.gray,
  emphasis: HIGHLIGHT_COLOR.italic,
  function: HIGHLIGHT_COLOR.yellowBright,
  keyword: HIGHLIGHT_COLOR.blueBright,
  link: HIGHLIGHT_COLOR.blueBright.underline,
  literal: HIGHLIGHT_COLOR.yellowBright,
  meta: HIGHLIGHT_COLOR.magenta,
  'meta-keyword': HIGHLIGHT_COLOR.magentaBright,
  'meta-string': HIGHLIGHT_COLOR.green,
  name: HIGHLIGHT_COLOR.cyanBright,
  number: HIGHLIGHT_COLOR.magentaBright,
  params: HIGHLIGHT_COLOR.white,
  quote: HIGHLIGHT_COLOR.gray,
  regexp: HIGHLIGHT_COLOR.redBright,
  section: HIGHLIGHT_COLOR.magentaBright.bold,
  'selector-attr': HIGHLIGHT_COLOR.green,
  'selector-class': HIGHLIGHT_COLOR.yellow,
  'selector-id': HIGHLIGHT_COLOR.magentaBright,
  'selector-pseudo': HIGHLIGHT_COLOR.blueBright,
  'selector-tag': HIGHLIGHT_COLOR.cyan,
  string: HIGHLIGHT_COLOR.green,
  strong: HIGHLIGHT_COLOR.bold,
  subst: HIGHLIGHT_COLOR.cyan,
  symbol: HIGHLIGHT_COLOR.magentaBright,
  tag: HIGHLIGHT_COLOR.blueBright,
  'template-tag': HIGHLIGHT_COLOR.magenta,
  'template-variable': HIGHLIGHT_COLOR.cyan,
  title: HIGHLIGHT_COLOR.cyanBright,
  type: HIGHLIGHT_COLOR.cyan,
  variable: HIGHLIGHT_COLOR.cyanBright,
};

/**
 * Infers a syntax grammar from a file extension or conventional basename.
 *
 * @param filePath - Resolved source path.
 * @returns cli-highlight language name, or undefined for an unknown format.
 */
function sourceLanguage_get(filePath: string): string | undefined {
  const basename: string = path.basename(filePath).toLowerCase();
  return SOURCE_LANGUAGE_BY_BASENAME[basename]
    ?? SOURCE_LANGUAGE_BY_EXTENSION[path.extname(basename).toLowerCase()];
}

/**
 * Applies syntax highlighting according to explicit flags, filename inference,
 * and terminal detection.
 *
 * @param content - File content string.
 * @param filePath - Full path used to determine the file type.
 * @param mode - Automatic terminal policy, forced highlighting, or disabled highlighting.
 * @param language - Explicit language that forces highlighting when provided.
 * @returns Highlighted or original content.
 */
function content_highlight(
  content: string,
  filePath: string,
  mode: CatHighlightMode,
  language?: string,
): string {
  if (mode === 'never') return content;
  if (language) {
    return highlight(content, { language, ignoreIllegals: true, theme: HIGHLIGHT_THEME });
  }
  if (mode === 'auto' && !process.stdout.isTTY) return content;
  const sourceLanguage: string | undefined = sourceLanguage_get(filePath);
  if (sourceLanguage) {
    return highlight(content, {
      language: sourceLanguage,
      ignoreIllegals: true,
      theme: HIGHLIGHT_THEME,
    });
  }
  if (mode === 'always') {
    return highlight(content, { ignoreIllegals: true, theme: HIGHLIGHT_THEME });
  }
  return content;
}

/**
 * List of file extensions that are considered binary.
 */
const BINARY_EXTENSIONS: Set<string> = new Set([
  '.dcm',   // DICOM medical images
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',  // Images
  '.pdf',   // Documents
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',  // Archives
  '.exe', '.dll', '.so', '.dylib', '.bin',  // Executables/Libraries
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',  // Media
]);

/**
 * Checks if a file path has a binary extension.
 *
 * @param filePath - The file path to check.
 * @returns True if the file has a binary extension.
 */
function extension_isBinary(filePath: string): boolean {
  const ext: string = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/** Outcome of one cat target, for the envelope model. */
export interface CatOutcome {
  path: string;
  ok: boolean;
  binary: boolean;
  bytes?: number;
}

/** Resolved input and its extension-based binary classification. */
interface CatTarget {
  pathArg: string;
  target: string;
  isBinaryFile: boolean;
}

/**
 * Reads one text target, adding delayed semantic progress for `/etc/group`.
 *
 * Fast cache hits complete before the delay. Inspection progress is ephemeral,
 * so pipe and redirect sinks drop it while interactive surfaces show a spinner.
 *
 * @param target - Resolved VFS path.
 * @returns Text content or the original read failure.
 */
async function textFile_read(target: string): Promise<Result<string>> {
  if (target !== '/etc/group') return text_read(target);

  let progressStarted: boolean = false;
  let progressFailed: boolean = false;
  const progressTimer: NodeJS.Timeout = setTimeout((): void => {
    progressStarted = true;
    sink_get().progress_write({
      operation: 'group',
      kind: 'inspection',
      phase: 'reading',
      label: GROUP_PROGRESS_LABEL,
      status: 'running',
    });
  }, GROUP_PROGRESS_DELAY_MS);
  try {
    const result: Result<string> = await text_read(target);
    progressFailed = !result.ok;
    return result;
  } catch (error: unknown) {
    progressFailed = true;
    throw error;
  } finally {
    clearTimeout(progressTimer);
    if (progressStarted) {
      sink_get().progress_write({
        operation: 'group',
        kind: 'inspection',
        phase: progressFailed ? 'failed' : 'complete',
        label: GROUP_PROGRESS_LABEL,
        status: progressFailed ? 'error' : 'done',
      });
    }
  }
}

/** What a `cat` line may hold. */
const CAT_GRAMMAR = {
  operands: [
    { name: 'files', kind: 'cfsPath', repeat: true, glob: true, summary: 'The files to print, in order' },
  ],
  options: {
    binary: { long: 'binary', summary: 'Force byte-for-byte binary output' },
    highlight: {
      long: 'highlight',
      summary: 'Force highlighting: in a cli-highlight language such as python, typescript, or sql; given none, inferred from the filename or content',
      value: { name: 'language', kind: 'word', optional: true },
    },
    noHighlight: { long: 'no-highlight', summary: 'Disable automatic syntax highlighting (wins over --highlight)' },
  },
} as const satisfies CommandGrammar;

/**
 * Runs a parsed `cat` line: its options as the typed core's presentation.
 * `--no-highlight` wins over `--highlight`; a bare `--highlight` (the
 * empty value) infers the language.
 *
 * @param args - The typed line.
 * @returns The files' envelope.
 */
async function cat_handle(args: CommandArguments<typeof CAT_GRAMMAR>): Promise<CommandEnvelope> {
  const language: string | undefined = args.options.highlight;
  const highlightMode: CatHighlightMode = args.options.noHighlight ? 'never' : language !== undefined ? 'always' : 'auto';
  return cat_run({
    filePaths: args.operands.files,
    binaryMode: args.options.binary,
    highlightMode,
    ...(highlightMode === 'always' && language !== '' ? { highlightLanguage: language } : {}),
  });
}

/**
 * `cat [--binary] [--highlight[=<language>]] [--no-highlight] <files…>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [catCommand] });
 * ```
 */
export const catCommand = command_declare({
  name: 'cat',
  grammar: CAT_GRAMMAR,
  help: {
    summary: 'Display file contents',
    description: 'Display file contents, with terminal syntax highlighting for recognized text formats. Several files print in order, one after another. A file with a binary extension (.dcm, .png, .zip, ...) is written byte for byte; a path through a link reads what it points at.',
    category: 'Files',
    posix: { group: 'Files', differs: 'reads CFS files' },
    examples: [
      'cat file.txt                    # Display single file',
      'cat analysis.py                 # Auto-highlight Python in a terminal',
      'cat source --highlight=python   # Force Python highlighting without filename inference',
      'cat config.json --no-highlight  # Display raw text',
      'cat file1 file2                 # Display multiple files',
    ],
  },
  holds: [],
  handler: cat_handle,
});

/**
 * Displays the content of one or more files: the declaration's parse and
 * handler over words already split.
 *
 * Supports multiple files and concatenates their output. Binary mode is applied
 * per recognized file, or consistently to all files when `--binary` is specified.
 * Text content and errors are buffered into the envelope; binary content streams
 * to the terminal directly with backpressure (raw bytes are not envelope text),
 * and the binary auto-detection notice is emitted live on the err channel so it
 * precedes the bytes it describes.
 *
 * @param args - The words after `cat`.
 * @returns An envelope whose rendered text carries the (highlighted) file
 *   contents and whose model lists per-file outcomes, or the refusal of a bad line.
 */
export async function builtin_cat(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(catCommand, args);
}

/**
 * Prints files: the shared typed core behind the parsed builtin and the
 * typed API.
 *
 * @param parsed - File paths and presentation options.
 * @returns An envelope whose rendered text carries the (highlighted) file
 *   contents and whose model lists per-file outcomes.
 */
export async function cat_run(parsed: CatArguments): Promise<CommandEnvelope> {
  if (parsed.filePaths.length === 0) {
    return envelope_error('', undefined, `${chalk.red(`Usage: ${CAT_USAGE}`)}\n`);
  }

  // Resolving a path can fail — a listing the server refuses, a provider
  // that throws — and a throw here used to leave the session: an unhandled
  // rejection that dumped an axios request object, auth header and all
  // (#465). A path that cannot be resolved is reported like any other
  // unreadable file, and the rest of the line still runs.
  const targets: CatTarget[] = [];
  let renderedErr: string = '';
  const outcomes: CatOutcome[] = [];
  let anyFailed: boolean = false;
  for (const pathArg of parsed.filePaths) {
    try {
      const target: string = await path_resolve(pathArg);
      targets.push({ pathArg, target, isBinaryFile: extension_isBinary(target) });
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      renderedErr += `${chalk.red(`cat: ${pathArg}: ${error_stripDebugPrefix(message)}`)}\n`;
      outcomes.push({ path: pathArg, ok: false, binary: false });
      anyFailed = true;
      exitCode_set(1);
    }
  }
  const hasTextTarget: boolean = !parsed.binaryMode
    && targets.some((target: CatTarget): boolean => !target.isBinaryFile);

  if (
    hasTextTarget
    && parsed.highlightLanguage !== undefined
    && !supportsLanguage(parsed.highlightLanguage)
  ) {
    return envelope_error(
      '',
      undefined,
      `${chalk.red(`cat: unknown highlight language '${parsed.highlightLanguage}'`)}\n`,
    );
  }

  let rendered: string = '';

  for (let i: number = 0; i < targets.length; i++) {
    const { pathArg, target, isBinaryFile }: CatTarget = targets[i];

    // Inform user about auto-detection only if in interactive mode (stdout is TTY).
    // Emitted live (not buffered) so the notice precedes the raw bytes it announces.
    // Only show on first file to avoid spam.
    if (i === 0 && isBinaryFile && !parsed.binaryMode && process.stdout.isTTY) {
      sink_get().err_write(`${chalk.cyan(`Info: ${pathArg} detected as binary file (${path.extname(target)}), using binary mode.`)}\n`);
      sink_get().err_write(`${chalk.cyan('Tip: Use "cat --binary <file>" to explicitly request binary mode.')}\n`);
      sink_get().err_write('\n');
    }

    // Use binary mode if requested OR if file is detected as binary
    if (parsed.binaryMode || isBinaryFile) {
      let result: Result<Buffer>;
      try {
        result = await bytes_read(target);
      } catch (error: unknown) {
        const message: string = error instanceof Error ? error.message : String(error);
        renderedErr += `${chalk.red(`cat: ${pathArg}: ${error_stripDebugPrefix(message)}`)}\n`;
        outcomes.push({ path: pathArg, ok: false, binary: true });
        anyFailed = true;
        exitCode_set(1);
        continue;
      }

      if (!result.ok) {
        const error: StackMessage | undefined = errorStack.stack_pop();
        renderedErr += `${chalk.red(`cat: ${pathArg}: ${error ? error_stripDebugPrefix(error.message) : 'Unknown error'}`)}\n`;
        outcomes.push({ path: pathArg, ok: false, binary: true });
        anyFailed = true;
        exitCode_set(1);
        continue;
      }

      // Raw bytes go to the active sink: the terminal for a direct cat, or the
      // pipe/redirect capture buffer (kept byte-for-byte) when piped.
      sink_get().data_write(result.value);
      outcomes.push({ path: pathArg, ok: true, binary: true, bytes: result.value.length });
    } else {
      let result: Result<string>;
      try {
        result = await textFile_read(target);
      } catch (error: unknown) {
        const message: string = error instanceof Error ? error.message : String(error);
        renderedErr += `${chalk.red(`cat: ${pathArg}: ${error_stripDebugPrefix(message)}`)}\n`;
        outcomes.push({ path: pathArg, ok: false, binary: false });
        anyFailed = true;
        exitCode_set(1);
        continue;
      }

      if (!result.ok) {
        const error: StackMessage | undefined = errorStack.stack_pop();
        renderedErr += `${chalk.red(`cat: ${pathArg}: ${error ? error_stripDebugPrefix(error.message) : 'Unknown error'}`)}\n`;
        outcomes.push({ path: pathArg, ok: false, binary: false });
        anyFailed = true;
        exitCode_set(1);
        continue;
      }

      const highlighted: string = content_highlight(
        result.value,
        target,
        parsed.highlightMode,
        parsed.highlightLanguage,
      );
      // The file's own last newline ends it; one is added only to a file
      // without (so the next output starts on a line of its own), never a
      // second: `cat f > out` reproduces a file that ends as files do.
      rendered += highlighted.endsWith('\n') ? highlighted : `${highlighted}\n`;
      outcomes.push({ path: pathArg, ok: true, binary: false });
    }
  }

  const model: { kind: string; data: CatOutcome[] } = { kind: 'fs.cat', data: outcomes };
  if (anyFailed) {
    const envelope: CommandEnvelope = envelope_error(rendered, undefined, renderedErr || undefined);
    envelope.model = model;
    return envelope;
  }
  const envelope: CommandEnvelope = envelope_ok(rendered, model);
  return envelope;
}
