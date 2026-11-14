/**
 * @file The person's processes still running in a berth, read from `/proc`,
 * with the files each holds open under a folder.
 *
 * Inside a berth every process is the person's, so the processes that
 * matter to a close are all of them but the session's own: this process,
 * its parents up to PID 1, the terminals it runs for the console (a child
 * whose environment carries `CHELL_TERMINAL` or `CHELL_CONSOLE`, as calypso
 * starts them), and a shell such a terminal starts directly (`!`). Whatever
 * runs under that shell is the person's work and is listed. A process of
 * another user, or with no command line (a kernel thread, a zombie), is not
 * listed.
 *
 * Key components:
 * - BerthProcess: one process, its command and its open files under the folder.
 * - processesOwn_list: the person's processes, the session's own left out.
 *
 * Typical usage:
 * ```ts
 * const running: BerthProcess[] = processesOwn_list('/outgoing');
 * ```
 *
 * Dependencies: Node.js built-ins only; a Linux `/proc` (a berth's). Where
 * `/proc` is not there, no process is listed.
 *
 * @module
 */
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The environment marks of a console terminal calypso starts. */
const TERMINAL_MARKS: readonly string[] = ['CHELL_TERMINAL=', 'CHELL_CONSOLE='];

/** The commands that are a shell a console terminal opens. */
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'fish', 'ksh', 'tcsh', 'csh']);

/**
 * One of the person's processes.
 *
 * @example
 * ```ts
 * const running: BerthProcess = { pid: 412, command: 'python train.py', open: ['/outgoing/model.pt'] };
 * ```
 */
export interface BerthProcess {
  /** Its process id. */
  readonly pid: number;
  /** Its command line, the words joined by spaces. */
  readonly command: string;
  /** The files it holds open under the folder asked about, by path. */
  readonly open: readonly string[];
}

/** What `/proc` says of one process. */
interface ProcEntry {
  /** Its id. */
  readonly pid: number;
  /** Its parent's id; 0 for PID 1. */
  readonly ppid: number;
  /** Its command name (`comm`). */
  readonly name: string;
  /** Its command line's words. */
  readonly argv: readonly string[];
  /** Whether its environment carries a console terminal's mark. */
  readonly terminal: boolean;
}

/**
 * Reads a file of `/proc`, or nothing when the process is gone or the file cannot be read.
 *
 * @param path - The file.
 * @returns Its text, or null.
 */
function procFile_read(path: string): string | null {
  try {
    return readFileSync(path, 'latin1');
  } catch {
    return null;
  }
}

/**
 * Reads one process from `/proc/<pid>`.
 *
 * @param procRoot - The `/proc` folder.
 * @param pid - The process.
 * @returns The entry, or null when it is gone or unreadable.
 */
function procEntry_read(procRoot: string, pid: number): ProcEntry | null {
  const stat: string | null = procFile_read(join(procRoot, String(pid), 'stat'));
  if (stat === null) return null;
  // `comm` sits in parentheses and may hold spaces and parentheses itself:
  // the fields after it start after the last `)`.
  const open: number = stat.indexOf('(');
  const close: number = stat.lastIndexOf(')');
  if (open === -1 || close < open) return null;
  const fields: string[] = stat.slice(close + 2).split(' ');
  const ppid: number = Number(fields[1]);
  const cmdline: string = procFile_read(join(procRoot, String(pid), 'cmdline')) ?? '';
  const environ: string = procFile_read(join(procRoot, String(pid), 'environ')) ?? '';
  return {
    pid,
    ppid: Number.isFinite(ppid) ? ppid : 0,
    name: stat.slice(open + 1, close),
    argv: cmdline.split('\0').filter((word: string): boolean => word !== ''),
    terminal: environ.split('\0').some((pair: string): boolean => TERMINAL_MARKS.some((mark: string): boolean => pair.startsWith(mark))),
  };
}

/**
 * Every process of one user in `/proc`.
 *
 * @param procRoot - The `/proc` folder.
 * @param uid - The user's id.
 * @returns The processes, by pid.
 */
function procEntries_read(procRoot: string, uid: number): Map<number, ProcEntry> {
  const entries: Map<number, ProcEntry> = new Map();
  if (!existsSync(procRoot)) return entries;
  for (const name of readdirSync(procRoot)) {
    if (!/^\d+$/.test(name)) continue;
    const owner: number | undefined = statSync(join(procRoot, name), { throwIfNoEntry: false })?.uid;
    if (owner !== uid) continue;
    const entry: ProcEntry | null = procEntry_read(procRoot, Number(name));
    if (entry !== null) entries.set(entry.pid, entry);
  }
  return entries;
}

/**
 * The session's own processes: this one, its parents up to PID 1, the
 * console terminals it runs, and the shells those terminals start.
 *
 * @param entries - The user's processes.
 * @param procRoot - The `/proc` folder, for parents of another user.
 * @param self - This process's id.
 * @returns Their ids.
 */
function sessionPids_find(entries: ReadonlyMap<number, ProcEntry>, procRoot: string, self: number): Set<number> {
  const session: Set<number> = new Set([self]);
  let parent: number = entries.get(self)?.ppid ?? procEntry_read(procRoot, self)?.ppid ?? 0;
  while (parent > 0 && !session.has(parent)) {
    session.add(parent);
    parent = entries.get(parent)?.ppid ?? procEntry_read(procRoot, parent)?.ppid ?? 0;
  }
  const terminals: number[] = [...entries.values()]
    .filter((entry: ProcEntry): boolean => entry.ppid === self && entry.terminal)
    .map((entry: ProcEntry): number => entry.pid);
  for (const terminal of terminals) session.add(terminal);
  for (const entry of entries.values()) {
    if (terminals.includes(entry.ppid) && SHELLS.has(entry.name)) session.add(entry.pid);
  }
  return session;
}

/**
 * The files a process holds open under a folder.
 *
 * @param procRoot - The `/proc` folder.
 * @param pid - The process.
 * @param folder - The folder, absolute.
 * @returns Their paths, sorted; none when its descriptors cannot be read.
 */
function openFiles_list(procRoot: string, pid: number, folder: string): string[] {
  const fdDir: string = join(procRoot, String(pid), 'fd');
  const prefix: string = folder.endsWith('/') ? folder : `${folder}/`;
  let descriptors: string[];
  try {
    descriptors = readdirSync(fdDir);
  } catch {
    return [];
  }
  const open: Set<string> = new Set();
  for (const descriptor of descriptors) {
    try {
      const target: string = readlinkSync(join(fdDir, descriptor));
      if (target.startsWith(prefix)) open.add(target.replace(/ \(deleted\)$/, ''));
    } catch {
      // A descriptor closed between the listing and the read holds nothing.
    }
  }
  return [...open].sort();
}

/**
 * The person's processes still running in the berth, the session's own left
 * out, each with the files it holds open under a folder.
 *
 * @param folder - The folder whose open files are said (the outgoing place).
 * @param procRoot - The `/proc` folder; the system's by default.
 * @param self - This process's id; the running process by default.
 * @param uid - The person's user id; this process's by default.
 * @returns The processes, by pid; empty when `/proc` is not there.
 *
 * @example
 * ```ts
 * processesOwn_list('/outgoing'); // [{ pid: 412, command: 'python train.py', open: ['/outgoing/model.pt'] }]
 * ```
 */
export function processesOwn_list(
  folder: string,
  procRoot: string = '/proc',
  self: number = process.pid,
  uid: number = process.getuid?.() ?? 0,
): BerthProcess[] {
  const entries: Map<number, ProcEntry> = procEntries_read(procRoot, uid);
  const session: Set<number> = sessionPids_find(entries, procRoot, self);
  return [...entries.values()]
    .filter((entry: ProcEntry): boolean => !session.has(entry.pid) && entry.argv.length > 0)
    .sort((a: ProcEntry, b: ProcEntry): number => a.pid - b.pid)
    .map((entry: ProcEntry): BerthProcess => ({ pid: entry.pid, command: entry.argv.join(' '), open: openFiles_list(procRoot, entry.pid, folder) }));
}
