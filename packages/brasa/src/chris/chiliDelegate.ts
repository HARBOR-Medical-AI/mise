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
import { hostDisk_refusal } from '../core/surface.js';

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

/** One of chili's top-level words, and when a line of it touches the host's disk. */
interface HostWordRule {
  /** The words the rule is for. */
  readonly words: ReadonlyArray<string>;
  /** Whether these arguments make the word read or write a file on the engine's host. */
  readonly touches: (args: ReadonlyArray<string>) => boolean;
}

/**
 * The arguments that are not options: subcommands and operands, wherever
 * options stand among them.
 *
 * @param args - The arguments after the word.
 * @returns Those that do not begin with a dash.
 */
function bareWords_list(args: ReadonlyArray<string>): string[] {
  return args.filter((arg: string): boolean => !arg.startsWith('-'));
}

/**
 * Whether an option is among the arguments, however it is written: its long
 * name alone or with `=value`, or its letter alone or in a cluster of
 * single-dash letters (`-nf x`).
 *
 * @param args - The arguments after the word.
 * @param long - The long names, with their dashes.
 * @param letters - The single letters, without a dash.
 * @returns True when any is given.
 */
function option_given(args: ReadonlyArray<string>, long: ReadonlyArray<string>, letters: string = ''): boolean {
  return args.some((arg: string): boolean => {
    if (arg.startsWith('--')) return long.some((name: string): boolean => arg === name || arg.startsWith(`${name}=`));
    if (!arg.startsWith('-') || arg.length < 2) return false;
    return [...letters].some((letter: string): boolean => arg.slice(1).includes(letter));
  });
}

/**
 * chili's words that read or write the disk of the machine they run on.
 *
 * chili was written as a program at its operator's own terminal, where
 * that disk is the operator's. Run in-process by an engine that somebody
 * attends from elsewhere, the same words reach the engine's host. Each rule
 * says when; a line that matches is refused where the disk is nobody's
 * (`hostDisk_refusal`). A rule errs toward refusing: `path` is let through
 * only as a plain `scan`.
 *
 * A test (`chiliDelegate.test.ts`) holds this table to chili's sources:
 * every file there that opens the host's disk is either one of these
 * words' or is listed as reading only chili's own packaged files.
 */
const HOST_WORD_RULES: ReadonlyArray<HostWordRule> = [
  {
    // `path upload <hostpath>`, `path download [hostpath]`, and `path scan` when it maps to, or saves onto, the host.
    words: ['path'],
    touches: (args: ReadonlyArray<string>): boolean => {
      const bare: string[] = bareWords_list(args);
      return !bare.includes('scan') || bare.includes('upload') || bare.includes('download') || option_given(args, ['--hostpath', '--mermaid', '--save']);
    },
  },
  {
    // `chefs upload <local> <remote>`.
    words: ['chefs'],
    touches: (args: ReadonlyArray<string>): boolean => bareWords_list(args).includes('upload'),
  },
  {
    // `files create --from-file <localPath>` (and `links`, `dirs`, which share the handler); `-f` is `--force` on their other subcommands.
    words: ['files', 'links', 'dirs'],
    touches: (args: ReadonlyArray<string>): boolean => bareWords_list(args).includes('create') && option_given(args, ['--from-file'], 'f'),
  },
  {
    // `man doc <topic>` reads `<topic>.adoc` beside chili's own pages, and `--browser` opens a browser on the host.
    words: ['man'],
    touches: (args: ReadonlyArray<string>): boolean => option_given(args, ['--browser'], 'b') || bareWords_list(args).some((word: string): boolean => /[\\/]|\.\./.test(word)),
  },
];

/**
 * Why a chili line may not run here, when it would touch the host's disk
 * and that disk is nobody's.
 *
 * @param command - chili's top-level word.
 * @param args - Its arguments.
 * @returns The refusal, or null when the line touches no host file or the disk is the operator's.
 *
 * @example
 * ```ts
 * chiliHostWord_refusal('path', ['upload', '/etc']); // "path upload: the session's host disk is nobody's; …" under a daemon without the files tier
 * ```
 */
export function chiliHostWord_refusal(command: string, args: ReadonlyArray<string>): string | null {
  const rule: HostWordRule | undefined = HOST_WORD_RULES.find((one: HostWordRule): boolean => one.words.includes(command));
  if (rule === undefined || !rule.touches(args)) return null;
  const sub: string | undefined = bareWords_list(args)[0];
  return hostDisk_refusal(sub !== undefined ? `${command} ${sub}` : command);
}

/** chili's top-level words that have a host-disk rule, for the test that holds the table to chili's sources. */
export const CHILI_HOST_WORDS: ReadonlyArray<string> = HOST_WORD_RULES.flatMap((rule: HostWordRule): string[] => [...rule.words]);

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
