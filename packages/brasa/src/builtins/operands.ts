/**
 * @file The input operand of a `/bin` run: the POSIX form `pl-x <path>`.
 *
 * A plugin or pipeline run from `/bin` used to take its input from the
 * working directory only. Now the line may name it (#1303):
 *
 * ```
 * pl-freesurfer-v1.0.4 ~/uploads/subjects        # a directory: that tree is the input
 * pl-freesurfer-v1.0.4 ~/uploads/t1.nii          # a file: one subject, that file
 * pl-freesurfer t1.nii as sub-01                 # the subject named
 * pl-freesurfer t1.nii t2.nii as sub-01          # one subject holding both
 * pl-freesurfer-v1.0.4                           # nothing: cwd, as before
 * ```
 *
 * The grammar: operands come first, the plugin's own flags after; a flag
 * before an operand is written with `=`. `as <name>` names the file
 * operands since the previous `as` (or the start) as one subject. A path is
 * read as given, a directory when a directory stands there, a file
 * otherwise; nothing is guessed from its spelling.
 *
 * A directory operand replaces cwd and nothing else changes. File operands
 * are shaped before the run, since the plugin keeps its one rule (a tree,
 * one directory per subject): each subject becomes a folder under a stage
 * (`~/.mise/stage/<id>/<subject>/`) holding its files, and the stage is
 * what pl-dircopy roots the feed with. The stage stays after the run, as
 * the record of the shaping. CUBE keeps each copied argument's full storage
 * path in the root node's output with `/` as `_`, so the data then lives at
 * `data/<stage trace>/<subject>/<file>`; the run prints that path.
 *
 * @module
 */
import path from 'path';
import type { VFSDispatcher, VfsOutcome } from '@fnndsc/fond';
import { vfsDispatcher_get } from '../core/filesystem.js';
import { path_resolve } from '../core/paths.js';
import { entry_isFolder, pathEntry_find } from './fs/entries.js';

/** A subject shaped from file operands: its name and the files, resolved. */
export interface OperandSubject {
  name: string;
  /** Whether `as` named it; false when the name is the file's stem. */
  named: boolean;
  /** The files as typed, for the record. */
  typed: string[];
  /** The files resolved to CFS paths. */
  files: string[];
}

/** The operands of a line, split from the plugin's own words. */
export interface BinOperands {
  /** The first directory operand, resolved, or null. */
  directory: string | null;
  /** Every directory operand, resolved, in order: several are several runs, one each. */
  directories: string[];
  /** The subjects the file operands make, in order; empty with a directory or nothing. */
  subjects: OperandSubject[];
  /** Every operand path as typed, in order. */
  typed: string[];
  /** The rest of the line: the plugin's own words. */
  rest: string[];
}

/** Why a line's operands are refused: the message, as the prompt should read it. */
export class OperandRefusal extends Error {}

/** The operand tokens of a line, before any path is looked at. */
export interface OperandTokens {
  /** `path` tokens and `as <name>` clauses, in order. */
  clauses: Array<{ kind: 'path'; value: string } | { kind: 'as'; name: string }>;
  rest: string[];
}

/** Whether a token is a flag written with `=`, which may stand before an operand. */
function token_isAssignedFlag(token: string): boolean {
  const equals: number = token.indexOf('=');
  if (equals <= 0) return false;
  const name: string = token.slice(0, equals);
  return name.startsWith('-') || !name.includes('/');
}

/**
 * Splits a line's words into its operand clauses and the plugin's rest.
 *
 * Operands are the leading words that are not flags; the first bare flag
 * (`-x`, `--x`, or `--`) ends them, and everything from there is the
 * plugin's. A flag written with `=` before an operand is kept for the
 * plugin and the scan goes on. `as` is a keyword only directly after a
 * path operand and only when a name follows: a lone `as`, or `as` first,
 * is a path as given.
 *
 * @param args - The words after the executable's name.
 * @returns The clauses and the rest.
 * @throws OperandRefusal when `as` has no usable name.
 */
export function operandTokens_split(args: readonly string[]): OperandTokens {
  const clauses: OperandTokens['clauses'] = [];
  const rest: string[] = [];
  let index: number = 0;
  while (index < args.length) {
    const token: string = args[index] as string;
    if (token.startsWith('-') && token !== '-') {
      if (token_isAssignedFlag(token)) { rest.push(token); index++; continue; }
      break;
    }
    if (token_isAssignedFlag(token)) { rest.push(token); index++; continue; }
    const previous = clauses[clauses.length - 1];
    if (token === 'as' && previous !== undefined && previous.kind === 'path') {
      const name: string | undefined = args[index + 1];
      if (name === undefined || name.startsWith('-')) throw new OperandRefusal(`as needs a name after ${previous.value}`);
      if (name.includes('/') || name === '.' || name === '..') throw new OperandRefusal(`as ${name}: a subject's name is one word with no /, since it becomes a folder`);
      clauses.push({ kind: 'as', name });
      index += 2;
      continue;
    }
    clauses.push({ kind: 'path', value: token });
    index++;
  }
  rest.push(...args.slice(index));
  return { clauses, rest };
}

/**
 * The subject a file is named after when no `as` names it: the file's stem,
 * a compound extension stripped as a whole (`t1.nii.gz` → `t1`, `a.tar.gz`
 * → `a`), else the last extension.
 *
 * @param file - A file path.
 * @returns The stem.
 */
export function subjectStem_derive(file: string): string {
  const base: string = path.posix.basename(file);
  const compound: RegExpMatchArray | null = base.match(/^(.+)\.[A-Za-z0-9]+\.(gz|bz2|xz|zst|zip)$/i);
  if (compound !== null) return compound[1] as string;
  const simple: RegExpMatchArray | null = base.match(/^(.+)\.[A-Za-z0-9]+$/);
  return simple !== null ? (simple[1] as string) : base;
}

/** What a path is on CFS: a directory, a file, or nothing. */
export type PathKind = 'directory' | 'file' | 'missing';

/** Reads what stands at a CFS path. */
export type PathKind_read = (resolved: string) => Promise<PathKind>;

/** The default reader: the VFS dispatcher's listing of the parent. */
export async function pathKind_read(resolved: string): Promise<PathKind> {
  const dispatcher: VFSDispatcher = vfsDispatcher_get();
  const entry = await pathEntry_find(dispatcher, resolved);
  if (entry === null) return 'missing';
  return entry_isFolder(entry) ? 'directory' : 'file';
}

/**
 * Reads a line's operands against CFS: which are directories, which files,
 * and the subjects the files make.
 *
 * @param args - The words after the executable's name.
 * @param kind_read - How a path is looked at (the dispatcher, or a test's).
 * @returns The operands and the plugin's rest.
 * @throws OperandRefusal for a missing path, a pattern matching nothing, a
 *   directory with `as`, a directory beside files, or two subjects of one name.
 */
export async function operands_read(args: readonly string[], kind_read: PathKind_read = pathKind_read): Promise<BinOperands> {
  const { clauses, rest } = operandTokens_split(args);
  const subjects: OperandSubject[] = [];
  let pending: Array<{ typed: string; resolved: string }> = [];
  const directories: string[] = [];
  const typed: string[] = [];
  const subject_add = (name: string, named: boolean, files: Array<{ typed: string; resolved: string }>): void => {
    const taken: OperandSubject | undefined = subjects.find((one: OperandSubject): boolean => one.name === name);
    if (taken !== undefined) throw new OperandRefusal(`two subjects would be called ${name}: ${taken.typed.join(' ')} and ${files.map((one): string => one.typed).join(' ')}; name one with as`);
    subjects.push({ name, named, typed: files.map((one): string => one.typed), files: files.map((one): string => one.resolved) });
  };
  // `as` makes one subject of the files since the last `as`; without it,
  // each file is its own subject, named by its stem.
  const subject_close = (name: string | null): void => {
    if (name !== null) subject_add(name, true, pending);
    else for (const file of pending) subject_add(subjectStem_derive(file.resolved), false, [file]);
    pending = [];
  };
  for (const clause of clauses) {
    if (clause.kind === 'as') {
      if (directories.length > 0 && pending.length === 0) throw new OperandRefusal(`${typed[typed.length - 1]} is a directory, and a tree is already named: as names a file's subject`);
      subject_close(clause.name);
      continue;
    }
    const resolved: string = await path_resolve(clause.value);
    const kind: PathKind = await kind_read(resolved);
    // A pattern the shell could not expand arrives as typed: it matched nothing.
    if (kind === 'missing') throw new OperandRefusal(`${clause.value}: ${/[*?[\]]/.test(clause.value) ? 'no match' : 'no such file or directory'}`);
    typed.push(clause.value);
    if (kind === 'directory') {
      if (subjects.length > 0 || pending.length > 0) throw new OperandRefusal(`${clause.value}: a directory and files do not mix; a directory is the whole input`);
      directories.push(resolved);
      continue;
    }
    if (directories.length > 0) throw new OperandRefusal(`${clause.value}: a directory and files do not mix; ${typed[0]} is the whole input`);
    pending.push({ typed: clause.value, resolved });
  }
  subject_close(null);
  return { directory: directories[0] ?? null, directories, subjects, typed, rest };
}

/** A stage made for file operands: where it is and what it holds. */
export interface Stage {
  /** The stage folder, a CFS path. */
  path: string;
  /** Its trace name in a root node's output, `/` as `_`, as CUBE writes it. */
  trace: string;
  subjects: OperandSubject[];
}

/** How a stage is written: folders made and files copied on CFS. */
export interface StageWriter {
  folder_make: (folder: string) => Promise<VfsOutcome>;
  file_copy: (source: string, destination: string) => Promise<VfsOutcome>;
}

/** The default writer: the VFS dispatcher. */
export function stageWriter_default(): StageWriter {
  const dispatcher: VFSDispatcher = vfsDispatcher_get();
  return {
    folder_make: (folder: string): Promise<VfsOutcome> => dispatcher.mkdir(folder),
    file_copy: (source: string, destination: string): Promise<VfsOutcome> => dispatcher.cp(source, destination, { recursive: false }),
  };
}

/** A fresh stage id: the moment, and four hex digits against two in one second. */
export function stageId_make(now: Date = new Date()): string {
  const stamp: string = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const salt: string = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${stamp}-${salt}`;
}

/**
 * Shapes file operands into a stage: `<stage>/<subject>/<file>` for each
 * file of each subject, the stage under the session's home.
 *
 * @param subjects - The subjects the operands made.
 * @param home - The session's home on CFS.
 * @param writer - How folders are made and files copied.
 * @param id - The stage id; fresh unless a test fixes it.
 * @returns The stage.
 * @throws OperandRefusal when a subject's folder already stands (never merged) or a copy fails.
 */
export async function stage_make(subjects: OperandSubject[], home: string, writer: StageWriter = stageWriter_default(), id: string = stageId_make()): Promise<Stage> {
  const stage: string = path.posix.join(home, '.mise', 'stage', id);
  const made: VfsOutcome = await writer.folder_make(stage);
  if (!made.ok) throw new OperandRefusal(`could not make the stage ${stage}`);
  for (const subject of subjects) {
    const folder: string = path.posix.join(stage, subject.name);
    const folderMade: VfsOutcome = await writer.folder_make(folder);
    if (!folderMade.ok) throw new OperandRefusal(`could not make ${folder}`);
    for (const file of subject.files) {
      const destination: string = path.posix.join(folder, path.posix.basename(file));
      const copied: VfsOutcome = await writer.file_copy(file, destination);
      if (!copied.ok) throw new OperandRefusal(`could not copy ${file} to ${destination}`);
    }
  }
  return { path: stage, trace: stage.replace(/^\//, '').replace(/\//g, '_'), subjects };
}

/**
 * The lines a stage is announced with: each subject and where it came from.
 *
 * @param stage - The stage.
 * @returns One line per subject.
 */
export function stage_lines(stage: Stage): string[] {
  return stage.subjects.map((subject: OperandSubject): string => `subject ${subject.name} from ${subject.typed.join(' ')}`);
}

/**
 * The paths CUBE made for a stage's files under a root node's output.
 *
 * @param stage - The stage.
 * @param rootOutput - The root node's output folder (`…/pl-dircopy_N/data`).
 * @returns One line per file, `made <path>`.
 */
export function stageMade_lines(stage: Stage, rootOutput: string): string[] {
  const lines: string[] = [];
  for (const subject of stage.subjects) {
    for (const file of subject.files) {
      lines.push(`made ${path.posix.join(rootOutput, stage.trace, subject.name, path.posix.basename(file))}`);
    }
  }
  return lines;
}
