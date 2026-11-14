/**
 * @file Bytes of a CFS file: `file`, `xxd`, `strings`, `sha256sum`, `md5sum`.
 *
 * The way people learn what a file is: by its magic, in hex, by the words
 * in it, by its digest. Each reads the file the way `cat` does, through
 * the session's filesystem, so a path is a CFS path. `xxd` and `strings`
 * are bounded and say what they showed.
 *
 * Each is declared in one record (`fileCommand`, `xxdCommand`, …); `file`
 * reads where the store keeps a path (`storePath_resolve`), through any link.
 *
 * @module
 */
import { createHash } from 'node:crypto';
import { files_cat, files_catBinary } from '@fnndsc/chili/commands/fs/cat.js';
import chalk from 'chalk';
import { path_resolve, storePath_resolve, error_stripDebugPrefix } from '../utils.js';
import { command_declare, type CommandArguments, type CommandGrammar } from '../../core/commandDeclaration.js';
import { declaredCommand_run } from '../../core/commandParse.js';
import { errorStack, type Result, type StackMessage } from '@fnndsc/fond';
import { CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';

/** Bytes `xxd` shows when not told. */
export const XXD_DEFAULT: number = 256;
/** Strings `strings` shows when not told. */
export const STRINGS_DEFAULT: number = 200;

/** What a file is, by its first bytes. */
export function magic_derive(bytes: Buffer, name: string = ''): string {
  const at = (i: number): number => bytes[i] ?? -1;
  const ascii = (from: number, to: number): string => bytes.subarray(from, to).toString('latin1');
  if (bytes.length === 0) return 'empty';
  if (bytes.length > 132 && ascii(128, 132) === 'DICM') return 'DICOM medical image (part 10, with preamble)';
  if (at(0) === 0x1f && at(1) === 0x8b) return /\.nii\.gz$/i.test(name) ? 'gzip compressed data, a NIfTI volume by its name' : 'gzip compressed data';
  if (bytes.length >= 348 && (ascii(344, 348) === 'n+1\0' || ascii(344, 348) === 'ni1\0')) return 'NIfTI-1 neuroimaging volume';
  if (bytes.length >= 8 && ascii(4, 8) === 'n+2\0') return 'NIfTI-2 neuroimaging volume';
  if (ascii(0, 4) === '\x89PNG') return 'PNG image';
  if (at(0) === 0xff && at(1) === 0xd8) return 'JPEG image';
  if (ascii(0, 4) === 'GIF8') return 'GIF image';
  if (ascii(0, 4) === '%PDF') return 'PDF document';
  if (ascii(0, 2) === 'PK') return 'ZIP archive';
  if (ascii(0, 4) === 'MThd') return 'MIDI';
  if (ascii(0, 4) === 'RIFF') return 'RIFF (WAV or AVI)';
  if (ascii(0, 2) === 'BM') return 'BMP image';
  if (ascii(0, 7) === '!<arch>') return 'ar archive';
  if (ascii(0, 4) === '\x7fELF') return 'ELF executable';
  if (ascii(0, 5) === 'ustar' || ascii(257, 262) === 'ustar') return 'tar archive';
  if (at(0) === 0x42 && at(1) === 0x5a && at(2) === 0x68) return 'bzip2 compressed data';
  if (ascii(0, 6) === '\xfd7zXZ\0') return 'xz compressed data';
  const head: Buffer = bytes.subarray(0, 4096);
  let printable: number = 0;
  for (const b of head) if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128) printable++;
  if (printable / head.length > 0.95) {
    const text: string = head.toString('utf-8');
    if (/^\s*[{[]/.test(text)) return 'JSON text';
    if (/^#!/.test(text)) return `script text (${text.split('\n')[0]?.slice(2).trim() ?? ''})`;
    if (/^\s*<\?xml/i.test(text)) return 'XML text';
    if (/^\s*<(!doctype html|html)/i.test(text)) return 'HTML text';
    const lines: string[] = text.split('\n').slice(0, 5);
    if (lines.length > 1 && lines.every((l: string): boolean => l.split(',').length > 1)) return 'CSV text';
    return head.some((b: number): boolean => b >= 128) ? 'UTF-8 text' : 'ASCII text';
  }
  return 'data';
}

/** The canonical hex dump of some bytes, offsets from `base`. */
export function hexdump_render(bytes: Buffer, base: number = 0): string {
  const lines: string[] = [];
  for (let off: number = 0; off < bytes.length; off += 16) {
    const chunk: Buffer = bytes.subarray(off, off + 16);
    const hex: string[] = [];
    for (let i: number = 0; i < 16; i += 2) {
      const a: number | undefined = chunk[i]; const b: number | undefined = chunk[i + 1];
      hex.push(a === undefined ? '    ' : b === undefined ? `${a.toString(16).padStart(2, '0')}  ` : `${a.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`);
    }
    const text: string = [...chunk].map((b: number): string => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${(base + off).toString(16).padStart(8, '0')}: ${hex.join(' ')}  ${text}`);
  }
  return lines.join('\n');
}

/** The printable runs of at least `min` characters in some bytes. */
export function strings_find(bytes: Buffer, min: number = 4): string[] {
  const out: string[] = [];
  let run: string = '';
  for (const b of bytes) {
    if (b >= 32 && b < 127) { run += String.fromCharCode(b); continue; }
    if (run.length >= min) out.push(run);
    run = '';
  }
  if (run.length >= min) out.push(run);
  return out;
}

/**
 * Reads a CFS file's bytes, or answers why not.
 *
 * @param pathArg - The path as typed.
 * @param name - The command, for the refusal.
 * @param resolve - Where the path is read: the session's path by default;
 *   `file` reads where the store keeps it, through any link.
 * @returns The path read and its bytes, or the refusal.
 */
async function bytes_read(
  pathArg: string,
  name: string,
  resolve: (path: string) => Promise<string> = path_resolve,
): Promise<{ path: string; bytes: Buffer } | { error: CommandEnvelope }> {
  const target: string = await resolve(pathArg);
  const result: Result<Buffer> = await files_catBinary(target);
  if (result.ok) return { path: target, bytes: result.value };
  // A projected file (/etc/cube, a /proc log) has words but no bytes of its
  // own: its text is read instead, and the refusal of the first read is
  // dropped — it was a question, not a failure.
  const first: StackMessage | undefined = errorStack.stack_pop();
  const text: Result<string> = await files_cat(target);
  if (text.ok) return { path: target, bytes: Buffer.from(text.value, 'utf-8') };
  const last: StackMessage | undefined = errorStack.stack_pop() ?? first;
  const why: string = last === undefined ? 'cannot read' : error_stripDebugPrefix(last.message);
  return { error: envelope_error('', undefined, `${name}: ${pathArg}: ${why}\n`) };
}

/** What a `file` line may hold: ChRIS paths, a wildcard matching them. */
const FILE_GRAMMAR = {
  operands: [
    { name: 'path', kind: 'cfsPath', repeat: true, glob: true, summary: 'The ChRIS files to name; a wildcard matches paths' },
  ],
} as const satisfies CommandGrammar;

/**
 * `file <path…>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [fileCommand] }, 'backend');
 * ```
 */
export const fileCommand = command_declare({
  name: 'file',
  grammar: FILE_GRAMMAR,
  help: {
    summary: 'What a file is, by its first bytes',
    description: 'Reads a CFS file\'s head and names it by its magic: DICOM, NIfTI, gzip, PNG, JPEG, PDF, ZIP, JSON, text and more, with its size.',
    category: 'Files',
    posix: { group: 'Files', differs: 'names a CFS file by its first bytes (DICOM, NIfTI, …)' },
    examples: ['file 0001.dcm', 'file ~/data/*'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof FILE_GRAMMAR>): Promise<CommandEnvelope> => file_run(args.operands.path),
});

/**
 * `file` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `file`.
 * @returns What each file is, or the refusal of a bad line.
 */
export async function builtin_file(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(fileCommand, args);
}

/**
 * Names each file by its first bytes, reading it where the store keeps it.
 *
 * @param paths - The paths, as typed or matched.
 * @returns A line per file, and the model; the first unreadable one's refusal.
 */
async function file_run(paths: readonly string[]): Promise<CommandEnvelope> {
  const lines: string[] = [];
  const data: Array<{ path: string; kind: string; bytes: number }> = [];
  for (const arg of paths) {
    const read = await bytes_read(arg, 'file', storePath_resolve);
    if ('error' in read) return read.error;
    const kind: string = magic_derive(read.bytes, read.path);
    lines.push(`${arg}: ${kind}${read.bytes.length > 0 ? chalk.gray(`  (${read.bytes.length.toLocaleString('en-US')} bytes)`) : ''}`);
    data.push({ path: read.path, kind, bytes: read.bytes.length });
  }
  return envelope_ok(`${lines.join('\n')}\n`, { kind: 'games.file', data: { files: data } });
}

/** What an `xxd` line may hold: a file, where to start, how much to show. */
const XXD_GRAMMAR = {
  operands: [{ name: 'path', kind: 'cfsPath', glob: true, summary: 'The file' }],
  options: {
    offset: { short: 's', summary: 'Start at this byte (default 0)', value: { name: 'OFFSET', kind: 'int', min: 0 } },
    length: { short: 'l', summary: `Show this many bytes (default ${XXD_DEFAULT})`, value: { name: 'LENGTH', kind: 'int', min: 0 } },
  },
} as const satisfies CommandGrammar;

/**
 * `xxd [-s OFFSET] [-l LENGTH] <path>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [xxdCommand] });
 * ```
 */
export const xxdCommand = command_declare({
  name: 'xxd',
  grammar: XXD_GRAMMAR,
  help: {
    summary: 'A hex dump of a file',
    description: 'The canonical hex dump — offset, sixteen bytes in pairs, the text beside — of a CFS file. 256 bytes unless -l asks for more; -s starts further in. Says how much of the file it showed.',
    posix: { group: 'Text', differs: 'reads a CFS file' },
    examples: ['xxd 0001.dcm', 'xxd -s 128 -l 16 0001.dcm', 'xxd -l 4096 image.nii'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof XXD_GRAMMAR>): Promise<CommandEnvelope> => xxd_run(args.operands.path, args.options.offset, args.options.length),
});

/**
 * `xxd` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `xxd`.
 * @returns The dump, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_xxd(['-l', '16', 'a.txt']);
 * ```
 */
export async function builtin_xxd(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(xxdCommand, args);
}

/**
 * Dumps a file's bytes in hex.
 *
 * @param path - The CFS path.
 * @param start - Where to start; absent for the beginning.
 * @param span - How many bytes to show; absent for the default.
 * @returns The dump and how much it showed, or why the file cannot be read.
 *
 * @example
 * ```ts
 * await xxd_run('a.txt', 0, 16);
 * ```
 */
export async function xxd_run(path: string, start: number | undefined, span: number | undefined): Promise<CommandEnvelope> {
  const read = await bytes_read(path, 'xxd');
  if ('error' in read) return read.error;
  const offset: number = start ?? 0;
  const length: number = span ?? XXD_DEFAULT;
  const shown: Buffer = read.bytes.subarray(offset, offset + length);
  const more: number = read.bytes.length - offset - shown.length;
  const note: string = more > 0 ? chalk.gray(`\nxxd: ${shown.length} of ${read.bytes.length.toLocaleString('en-US')} bytes shown (-l ${length}; -s to start elsewhere)`) : '';
  return envelope_ok(`${hexdump_render(shown, offset)}${note}\n`, { kind: 'games.xxd', data: { path: read.path, offset, shown: shown.length, total: read.bytes.length } });
}

/** What a `strings` line may hold: a file, the shortest run, how many to show. */
const STRINGS_GRAMMAR = {
  operands: [{ name: 'path', kind: 'cfsPath', glob: true, summary: 'The file' }],
  options: {
    min: { short: 'n', summary: 'Shortest run to show (default 4)', value: { name: 'MIN', kind: 'int', min: 0 } },
    limit: { short: 'l', summary: `Most runs to show (default ${STRINGS_DEFAULT})`, value: { name: 'LIMIT', kind: 'int', min: 0 } },
  },
} as const satisfies CommandGrammar;

/**
 * `strings [-n MIN] [-l LIMIT] <path>`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [stringsCommand] });
 * ```
 */
export const stringsCommand = command_declare({
  name: 'strings',
  grammar: STRINGS_GRAMMAR,
  help: {
    summary: 'The readable runs in a file',
    description: 'Prints the runs of printable characters, MIN (4) or longer, in a CFS file — the way to see what a binary carries. 200 lines unless -l asks for more; says how many there were.',
    posix: { group: 'Text', differs: 'reads a CFS file' },
    examples: ['strings 0001.dcm', 'strings -n 8 report.pdf'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof STRINGS_GRAMMAR>): Promise<CommandEnvelope> => strings_run(args.operands.path, args.options.min, args.options.limit),
});

/**
 * `strings` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `strings`.
 * @returns The runs, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_strings(['-n', '8', 'a.bin']);
 * ```
 */
export async function builtin_strings(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(stringsCommand, args);
}

/**
 * Lists the printable runs in a file.
 *
 * @param path - The CFS path.
 * @param shortest - The shortest run to show; absent for 4.
 * @param most - The most runs to show; absent for the default.
 * @returns The runs and how many there were, or why the file cannot be read.
 *
 * @example
 * ```ts
 * await strings_run('a.bin', 8, 50);
 * ```
 */
export async function strings_run(path: string, shortest: number | undefined, most: number | undefined): Promise<CommandEnvelope> {
  const read = await bytes_read(path, 'strings');
  if ('error' in read) return read.error;
  const min: number = Math.max(1, shortest ?? 4);
  const limit: number = most ?? STRINGS_DEFAULT;
  const found: string[] = strings_find(read.bytes, min);
  const shown: string[] = found.slice(0, limit);
  const note: string = found.length > shown.length ? chalk.gray(`\nstrings: ${shown.length} of ${found.length} shown (-l for more)`) : '';
  return envelope_ok(`${shown.join('\n')}${note}\n`, { kind: 'games.strings', data: { path: read.path, shown: shown.length, total: found.length } });
}

/**
 * Digests each file with an algorithm, as the coreutils tools print.
 *
 * @param paths - The CFS paths.
 * @param algorithm - The digest.
 * @param name - The command's name, for refusals and the model kind.
 * @returns A line per file, or why one cannot be read.
 */
async function digest_run(paths: readonly string[], algorithm: 'sha256' | 'md5', name: string): Promise<CommandEnvelope> {
  const lines: string[] = [];
  const data: Array<{ path: string; digest: string }> = [];
  for (const arg of paths) {
    const read = await bytes_read(arg, name);
    if ('error' in read) return read.error;
    const digest: string = createHash(algorithm).update(read.bytes).digest('hex');
    lines.push(`${digest}  ${arg}`);
    data.push({ path: read.path, digest });
  }
  return envelope_ok(`${lines.join('\n')}\n`, { kind: `games.${name}`, data: { algorithm, files: data } });
}

/** What a digest line may hold: the files. */
const DIGEST_GRAMMAR = {
  operands: [{ name: 'paths', kind: 'cfsPath', glob: true, repeat: true, summary: 'The files' }],
} as const satisfies CommandGrammar;

/**
 * `sha256sum <path>...`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [sha256sumCommand] });
 * ```
 */
export const sha256sumCommand = command_declare({
  name: 'sha256sum',
  grammar: DIGEST_GRAMMAR,
  help: {
    summary: 'The SHA-256 digest of a file',
    description: "Prints each CFS file's SHA-256 as hex, then its name, in the format the coreutils tool uses.",
    posix: { group: 'Text', differs: 'hashes a CFS file' },
    examples: ['sha256sum image.nii.gz', 'sha256sum ~/uploads/*'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof DIGEST_GRAMMAR>): Promise<CommandEnvelope> => digest_run(args.operands.paths, 'sha256', 'sha256sum'),
});

/**
 * `md5sum <path>...`: the declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [md5sumCommand] });
 * ```
 */
export const md5sumCommand = command_declare({
  name: 'md5sum',
  grammar: DIGEST_GRAMMAR,
  help: {
    summary: 'The MD5 digest of a file',
    description: "Prints each CFS file's MD5 as hex, then its name.",
    posix: { group: 'Text', differs: 'hashes a CFS file' },
    examples: ['md5sum image.nii.gz'],
  },
  holds: [],
  handler: async (args: CommandArguments<typeof DIGEST_GRAMMAR>): Promise<CommandEnvelope> => digest_run(args.operands.paths, 'md5', 'md5sum'),
});

/**
 * `sha256sum` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `sha256sum`.
 * @returns The digests, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_sha256sum(['a.txt']);
 * ```
 */
export async function builtin_sha256sum(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(sha256sumCommand, args);
}

/**
 * `md5sum` over words already split: the declaration's parse and handler.
 *
 * @param args - The words after `md5sum`.
 * @returns The digests, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await builtin_md5sum(['a.txt']);
 * ```
 */
export async function builtin_md5sum(args: string[]): Promise<CommandEnvelope> {
  return declaredCommand_run(md5sumCommand, args);
}
