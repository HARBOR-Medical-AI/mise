/**
 * @file Delegation to the chili command layer.
 *
 * Unknown commands and the pacs passthroughs hand off to chili. This lives in
 * its own leaf module so both the dispatcher and any builtins can call it
 * without importing each other — dispatch imports the builtins, so routing the
 * delegation through dispatch would close a cycle.
 *
 * @module
 */

import chalk from 'chalk';
import { run_capture, commandNames_get } from '@fnndsc/chili/run.js';
import { type CommandEnvelope, envelope_ok, envelope_error } from '@fnndsc/menu';
import { exitCode_set } from '../core/handlerRun.js';
import { hostDisk_refusal, hostProcess_refusal } from '../core/hostGate.js';

/** chili's top-level command names, resolved once and memoized (see {@link chiliCommand_exists}). */
let chiliCommandNames: Set<string> | null = null;

/**
 * Whether chili has a top-level command by this name. Used to decide whether an
 * unknown chell command is worth delegating: a name chili does not know (a typo,
 * a shell program like `fortune`) is reported as not-found rather than paying the
 * cost of a chili run that can only fail. The command set is resolved once — a
 * cheap, network-free registration pass — and cached.
 *
 * @param command - The command name to test.
 * @returns True if chili exposes a top-level command with this name.
 */
export async function chiliCommand_exists(command: string): Promise<boolean> {
  if (!chiliCommandNames) {
    chiliCommandNames = await commandNames_get();
  }
  return chiliCommandNames.has(command);
}

/**
 * The notice shown when an unknown chell command is handed off to chili.
 *
 * @param command - The command being delegated.
 * @returns The formatted notice line.
 */
export function chiliDelegationNotice_build(command: string): string {
  return `${chalk.yellow(`Unknown chell command '${command}' -- delegating to chili`)}\n`;
}

/** A line's arguments, told apart by role: which are options (and their values) and which are operands. */
export interface ArgvRoles {
  /** The options given, by the name they were spelt with (`--save`, `-f`), each with its value when it takes one. */
  readonly options: ReadonlyMap<string, string | true>;
  /** The operands, in order: subcommands and positional words, including any after `--`. */
  readonly operands: ReadonlyArray<string>;
}

/**
 * Tells a line's arguments apart by role, as Commander reads them.
 *
 * `--` ends the options: every word after it is an operand, a
 * dash-prefixed one included. `--name=value` carries its value; a valued
 * `--name` or `-n` takes the next word, so that word is never an operand;
 * single-dash letters cluster (`-ab`), and a valued letter takes the rest
 * of its cluster or the next word. An option not named as valued is a flag.
 *
 * @param args - The arguments.
 * @param valued - The options that take a value: long names with their dashes, and single letters.
 * @returns The options and the operands.
 *
 * @example
 * ```ts
 * argvRoles_read(['scan', '--filter', 'download', '--tree'], ['--filter']); // operands: ['scan'], options: --filter=download, --tree
 * ```
 */
export function argvRoles_read(args: ReadonlyArray<string>, valued: ReadonlyArray<string>): ArgvRoles {
  const options: Map<string, string | true> = new Map<string, string | true>();
  const operands: string[] = [];
  for (let at: number = 0; at < args.length; at++) {
    const arg: string = args[at] as string;
    if (arg === '--') {
      operands.push(...args.slice(at + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const equals: number = arg.indexOf('=');
      const name: string = equals === -1 ? arg : arg.slice(0, equals);
      if (equals !== -1) options.set(name, arg.slice(equals + 1));
      else if (valued.includes(name)) { options.set(name, args[at + 1] ?? ''); at++; }
      else options.set(name, true);
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let letterAt: number = 1; letterAt < arg.length; letterAt++) {
        const letter: string = arg[letterAt] as string;
        if (!valued.includes(letter)) { options.set(`-${letter}`, true); continue; }
        const rest: string = arg.slice(letterAt + 1);
        if (rest !== '') options.set(`-${letter}`, rest);
        else { options.set(`-${letter}`, args[at + 1] ?? ''); at++; }
        break;
      }
      continue;
    }
    operands.push(arg);
  }
  return { options, operands };
}

/** One subcommand of a chili word, and whether a line of it reads or writes a file on the host. */
export interface HostSubcommand {
  /** `always`: its purpose is a host file. `never`: it touches none. Otherwise the options (as spelt, every spelling listed) that make it touch one. */
  readonly touches: 'always' | 'never' | ReadonlyArray<string>;
  /** Its options that take a value, long names and single letters, so a value is not taken for an operand. */
  readonly valued?: ReadonlyArray<string>;
  /** Whether an operand of it, given after the subcommand, makes it touch the host (a manual topic that climbs out of the manual). */
  readonly operand_touches?: (operand: string) => boolean;
  /** The options (every spelling) that also start a program on the host (a renderer, a browser): they need the process grant as well as the disk's. */
  readonly spawns?: ReadonlyArray<string>;
}

/**
 * chili's words that can read or write the disk of the machine they run
 * on, by subcommand.
 *
 * chili was written as a program at its operator's own terminal, where
 * that disk is the operator's. Run in-process by an engine that somebody
 * attends from elsewhere, the same words reach the engine's host. Every
 * subcommand each word registers is named here and classified; one that is
 * not named is refused, so a subcommand chili gains is refused until it is
 * classified. `scripts/chiliHostWords.mjs` holds this table to what the
 * built chili actually registers, and `chiliDelegate.test.ts` to chili's
 * sources.
 */
export const CHILI_HOST_WORDS: Readonly<Record<string, Readonly<Record<string, HostSubcommand>>>> = {
  path: {
    upload: { touches: 'always' },
    download: { touches: 'always' },
    // A plain scan lists CUBE. It maps onto the host with --hostpath, and writes the host with --mermaid (a page) and --save.
    // --mermaid renders with `npx mmdc` and opens the page: programs on the host as well; --save alone writes a file.
    scan: { touches: ['--hostpath', '--mermaid', '--save'], valued: ['--hostpath', '--filter', '--endsWith', '--save'], spawns: ['--mermaid'] },
    help: { touches: 'never' },
  },
  chefs: {
    upload: { touches: 'always' },
    ls: { touches: 'never' }, cp: { touches: 'never' }, mv: { touches: 'never' }, cat: { touches: 'never' }, mkdir: { touches: 'never' },
    touch: { touches: 'never' }, cd: { touches: 'never' }, pwd: { touches: 'never' }, rm: { touches: 'never' }, help: { touches: 'never' },
  },
  man: {
    // The topic is joined to chili's own manual folder: one that holds a separator or `..` names a file elsewhere. --browser opens a browser on the host.
    doc: { touches: ['--browser', '-b'], spawns: ['--browser', '-b'], valued: ['--style', '--width'], operand_touches: (topic: string): boolean => /[\\/]/.test(topic) || topic.includes('..') },
    topics: { touches: 'never' },
    help: { touches: 'never' },
  },
};

/** Options of `inode <path> file create` that take a value; `--from-file`/`-f` names a file on the host. */
const INODE_CREATE_VALUED: ReadonlyArray<string> = ['--content', 'c', '--from-file', 'f', '--path', 'p', '--name', 'n'];

/**
 * chili's own options, which Commander reads wherever they stand on the
 * line, before or after the command word: `-c, --config <path>` takes a
 * value, so the word after it is never the command or a subcommand.
 */
const PROGRAM_VALUED: ReadonlyArray<string> = ['--config', 'c'];

/**
 * The arguments chili acts on, after its own first step.
 *
 * Before any parsing, chili takes the first argument that holds an `=` and
 * does not begin with a dash to be a context (`user@url?folder=…`) and
 * removes it (`run.ts`, `context_parse`). What is left is what Commander
 * reads, so it is what is classified here: `path a=b upload /etc` is an
 * upload.
 *
 * @param argv - The word and its arguments, as handed to chili.
 * @returns The arguments with that one removed, when there is one.
 */
export function chiliArgv_effective(argv: ReadonlyArray<string>): string[] {
  const at: number = argv.findIndex((arg: string): boolean => arg.includes('=') && !arg.startsWith('-'));
  return at === -1 ? [...argv] : [...argv.slice(0, at), ...argv.slice(at + 1)];
}

/** What a chili line is, read as chili reads it: its top-level word, its subcommand, and its roles. */
export interface ChiliLine {
  /** The top-level word chili will run; undefined when the line names none. */
  readonly word: string | undefined;
  /** Its subcommand; undefined when none is named. */
  readonly sub: string | undefined;
  /** The whole line's options and operands, read with every option of the word and subcommand that takes a value. */
  readonly roles: ArgvRoles;
}

/**
 * Reads a chili line as chili will: its context removed, its program
 * options set aside with their values, the first operand its top-level
 * word and the second that word's subcommand.
 *
 * @param command - The word the line was handed over under.
 * @param args - Its arguments.
 * @returns The line as read.
 */
export function chiliLine_read(command: string, args: ReadonlyArray<string>): ChiliLine {
  const effective: string[] = chiliArgv_effective([command, ...args]);
  const first: ArgvRoles = argvRoles_read(effective, PROGRAM_VALUED);
  const word: string | undefined = first.operands[0];
  const sub: string | undefined = first.operands[1];
  const known: HostSubcommand | undefined = word !== undefined && sub !== undefined ? CHILI_HOST_WORDS[word]?.[sub] : undefined;
  const valued: ReadonlyArray<string> = [...PROGRAM_VALUED, ...(known?.valued ?? []), ...(word === 'inode' ? INODE_CREATE_VALUED : [])];
  return { word, sub, roles: argvRoles_read(effective, valued) };
}

/**
 * Why a chili line may not run here, when it would touch the host's disk
 * and that disk is nobody's.
 *
 * The line is read as chili reads it (`chiliLine_read`), by role: an
 * option's value is never mistaken for a subcommand, so `chefs ls upload`
 * lists a path called upload and `path scan --filter download` is a plain
 * scan; `path -c upload scan` is a scan too, `upload` being the value of
 * chili's own `--config`. A word asked only for its help touches nothing.
 * A subcommand the table does not name is refused.
 *
 * @param command - chili's top-level word, as the line was handed over.
 * @param args - Its arguments.
 * @returns The refusal, or null when the line touches no host file or the disk is the operator's.
 *
 * @example
 * ```ts
 * chiliHostWord_refusal('path', ['upload', '/etc']); // "path upload: the session's host disk is nobody's; …" under a daemon without the files tier
 * ```
 */
export function chiliHostWord_refusal(command: string, args: ReadonlyArray<string>): string | null {
  const line: ChiliLine = chiliLine_read(command, args);
  if (line.word === undefined) return null;
  if (line.word === 'inode') {
    // `inode <path> file create [name] --from-file <local>`: the one place chili registers `create`.
    const [, , kind, verb] = line.roles.operands;
    const creates: boolean = kind === 'file' && verb === 'create' && (line.roles.options.has('--from-file') || line.roles.options.has('-f'));
    return creates ? hostDisk_refusal('inode file create --from-file') : null;
  }
  const word: Readonly<Record<string, HostSubcommand>> | undefined = CHILI_HOST_WORDS[line.word];
  if (word === undefined) return null;
  const what: string = line.sub === undefined ? line.word : `${line.word} ${line.sub}`;
  // Asked only for the word's own help, with no subcommand: Commander prints it and runs nothing.
  if (line.sub === undefined && (line.roles.options.has('--help') || line.roles.options.has('-h'))) return null;
  const sub: HostSubcommand | undefined = line.sub === undefined ? undefined : word[line.sub];
  if (sub === undefined || sub.touches === 'always') return hostDisk_refusal(what);
  const given: string | undefined = sub.touches === 'never' ? undefined : sub.touches.find((option: string): boolean => line.roles.options.has(option));
  if (given !== undefined) {
    const spawned: string | undefined = sub.spawns?.find((option: string): boolean => line.roles.options.has(option));
    return hostDisk_refusal(`${what} ${given}`) ?? (spawned === undefined ? null : hostProcess_refusal(`${what} ${spawned}`));
  }
  if (sub.operand_touches !== undefined && line.roles.operands.slice(2).some(sub.operand_touches)) return hostDisk_refusal(what);
  return null;
}

/**
 * Runs a chili command in-process and returns its output as an envelope.
 *
 * chili shares this process's cumin connection and context, so there is no node
 * subprocess to spawn and no per-command startup cost. Its output is captured
 * through chili's own output seam ({@link run_capture}) rather than a console
 * monkeypatch, so the rendered text and error stream travel in the envelope.
 *
 * @param command - The command to run (e.g., "pacsservers").
 * @param args - The arguments to pass to the command.
 * @returns An envelope carrying chili's captured output.
 */
export async function chiliCommand_run(command: string, args: string[]): Promise<CommandEnvelope> {
  const refused: string | null = chiliHostWord_refusal(command, args);
  if (refused !== null) {
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(refused)}\n`);
  }
  try {
    const { out, err } = await run_capture([command, ...args]);
    const envelope: CommandEnvelope = envelope_ok(out);
    if (err.length > 0) {
      envelope.renderedErr = err;
    }
    return envelope;
  } catch (e: unknown) {
    const message: string = e instanceof Error ? e.message : String(e);
    exitCode_set(1);
    return envelope_error('', undefined, `${chalk.red(`chili command '${command}' failed: ${message}`)}\n`);
  }
}
