/**
 * @file The daemon console: the terminal a daemon booted in becomes its
 * first surface.
 *
 * A Linux boot ends at a login. A daemon boot ended at a resting face — a
 * brain animation and a status line, with the boot log a keypress away —
 * that was a screensaver where a session belonged. The identity is already
 * resolved by the time the engine is ready, so the login is the attach: an
 * ordinary `chell --remote` surface is put on the daemon's own terminal.
 *
 * It is a child process on the wire, not an in-process shortcut. The daemon
 * process holds one output sink and one interaction surface for every
 * attached session; a REPL started inside it would take those over and
 * every other surface would go quiet. A child pays one loopback hop, which
 * is what every surface pays, and shares nothing else.
 *
 * `exit` in the console detaches; the daemon stays up, its terminal idle.
 * Enter attaches again. Ctrl-C at that idle terminal stops the daemon, as
 * it always did. While the console holds the terminal, whatever the daemon
 * itself writes — a roster row, a late warm-up settling — is held and
 * handed back on detach, so it lands after the surface's last line and
 * never across its prompt.
 *
 * The console lives here, in the daemon's own package, because both the
 * chell `--daemon` host and the standalone `calypso` binary end their boot
 * this way. What differs between them is only how the surface is launched —
 * chell spawns itself, the calypso binary spawns `chell` from the path — so
 * that is the one injected part.
 *
 * @module
 */
import { spawn as childSpawn, type ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import chalk from 'chalk';
import { consoleCage_start, consoleCage_stop } from './console.js';
import { ATTACH_TOKEN_ENV } from './token.js';

/** What the console needs to know about the daemon it attaches to. */
export interface DaemonConsoleTarget {
  identity: string;
  url: string;
  token: string;
}

/** How to launch the surface: the executable and the args before `--remote`. */
export interface SurfaceLaunch {
  /** The program to run — `chell` on the path, or a node with an entry. */
  exec: string;
  /** Args that precede the surface flags (a script entry, or nothing). */
  prefixArgs: string[];
}

/** The default: the `chell` a user would run, found on the path. */
export const CHELL_ON_PATH: SurfaceLaunch = { exec: 'chell', prefixArgs: [] };

/**
 * The chell installed beside this calypso, as a launch: the same install's
 * entry under this very node, so a daemon that passes no launch of its own
 * (stratus, the calypso binary) spawns a console of its own build rather
 * than whichever `chell` the path finds first.
 *
 * @param from - Where to resolve from; this module by default.
 * @returns The launch, or null when no chell is installed beside this calypso.
 */
export function chellLaunch_find(from: string = import.meta.url): SurfaceLaunch | null {
  try {
    const manifest: string = createRequire(from).resolve('@fnndsc/chell/package.json');
    const entry: string = join(dirname(manifest), 'dist', 'index.js');
    return existsSync(entry) ? { exec: process.execPath, prefixArgs: [entry] } : null;
  } catch {
    return null;
  }
}

/** The running attached surface: settles with its exit code. */
export interface ConsoleChild {
  exited: Promise<number>;
}

/** The seams the console loop runs on, replaceable under test. */
export interface DaemonConsoleDeps {
  /** Starts a `chell --remote` surface on this terminal. */
  attach: (target: DaemonConsoleTarget) => ConsoleChild;
  /** Holds the daemon's own console writes. */
  cage_start: () => void;
  /** Hands back what was held. */
  cage_stop: () => string[];
  /** Resolves true on Enter, false when the terminal's input ends. */
  enter_wait: () => Promise<boolean>;
  /** The terminal's own line writer. */
  log: (line: string) => void;
}

/** What the spawner needs of a child: its exit and error events. */
export type SpawnedChild = Pick<ChildProcess, 'once'>;

/** A process spawner with the shape of `child_process.spawn`. */
export type Spawn = (
  command: string,
  args: string[],
  options: { stdio: 'inherit'; env: NodeJS.ProcessEnv },
) => SpawnedChild;

/** What the Enter wait needs of the terminal's input. */
export type ConsoleInput = Pick<EventEmitter, 'on' | 'once' | 'off'> & { resume(): unknown; pause(): unknown };

/**
 * Starts a remote surface on this terminal, attached by address.
 *
 * @param target - The daemon's wire address and token.
 * @param launch - How to launch the surface; `chell` on the path by default.
 * @param spawn - The process spawner; `child_process.spawn` by default.
 * @returns The child, settling with its exit code when the operator detaches.
 */
export function surface_spawn(
  target: DaemonConsoleTarget,
  launch: SurfaceLaunch = CHELL_ON_PATH,
  spawn: Spawn = childSpawn,
): ConsoleChild {
  // The identity rides along so the surface greets with it, not with the
  // address twice; the environment mark tells it whose terminal it is on,
  // so it skips the greeting the daemon's banner already gave.
  // The token goes to the surface in its environment, never on its command line: an argument list is shown
  // to every user of this host by `ps`, an environment only to the process's own user.
  const child: SpawnedChild = spawn(
    launch.exec,
    [...launch.prefixArgs, '--remote', target.identity, '--attach', target.url],
    { stdio: 'inherit', env: { ...process.env, CHELL_CONSOLE: '1', [ATTACH_TOKEN_ENV]: target.token } },
  );
  const exited: Promise<number> = new Promise<number>((resolve: (code: number) => void): void => {
    child.once('exit', (code: number | null): void => { resolve(code ?? 0); });
    child.once('error', (error: Error): void => {
      // A surface that cannot start at all (no `chell` on the path) must say
      // so, or the loop would offer to attach again with nothing to show for
      // it. Named so the operator knows what to install.
      process.stderr.write(chalk.red(`[!] Could not start the console surface (${launch.exec}): ${error.message}\n`));
      resolve(1);
    });
  });
  return { exited };
}

/**
 * Waits for the operator to press Enter at the idle daemon terminal.
 *
 * @param input - The terminal's input; `process.stdin` by default.
 * @returns True on a line of input; false when the input ends.
 */
export function enter_await(input: ConsoleInput = process.stdin): Promise<boolean> {
  return new Promise<boolean>((resolve: (again: boolean) => void): void => {
    const cleanup = (): void => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.pause();
    };
    const onData = (): void => { cleanup(); resolve(true); };
    const onEnd = (): void => { cleanup(); resolve(false); };
    input.on('data', onData);
    input.once('end', onEnd);
    input.resume();
  });
}

/**
 * The live seams for a given surface launch: a real child on the wire, the
 * real cage, the real terminal.
 *
 * @param launch - How to launch the surface.
 * @returns The deps `daemonConsole_run` uses in production.
 */
export function consoleDeps_live(launch: SurfaceLaunch = CHELL_ON_PATH): DaemonConsoleDeps {
  return {
    attach: (target: DaemonConsoleTarget): ConsoleChild => surface_spawn(target, launch),
    cage_start: consoleCage_start,
    cage_stop: consoleCage_stop,
    enter_wait: (): Promise<boolean> => enter_await(),
    log: (line: string): void => { console.log(line); },
  };
}

/**
 * Holds the terminal's interrupt while a surface has it.
 *
 * The surface's readline owns Ctrl-C while attached (it clears the typed
 * line, as chell always has); the daemon's own stop-on-interrupt is put
 * back once the surface detaches, so Ctrl-C at the idle terminal stops
 * the daemon as before.
 *
 * @returns A restore function.
 */
function interrupt_hold(): () => void {
  const held: NodeJS.SignalsListener[] = process.listeners('SIGINT');
  process.removeAllListeners('SIGINT');
  const ignore = (): void => { /* the attached surface owns Ctrl-C */ };
  process.on('SIGINT', ignore);
  return (): void => {
    process.off('SIGINT', ignore);
    for (const listener of held) process.on('SIGINT', listener);
  };
}

/**
 * Runs the daemon console until the operator leaves the terminal idle for
 * good: attach, detach on `exit`, attach again on Enter, until stdin ends.
 *
 * @param target - The daemon to attach to.
 * @param deps - The seams; the live ones (chell on the path) by default.
 * @returns Resolves when the operator will not attach again.
 */
export async function daemonConsole_run(
  target: DaemonConsoleTarget,
  deps: DaemonConsoleDeps = consoleDeps_live(),
): Promise<void> {
  for (;;) {
    deps.log(chalk.green(`[+] Console attached to ${target.identity} — 'exit' detaches, Enter attaches again, Ctrl-C then stops the daemon`));
    deps.cage_start();
    const restore: () => void = interrupt_hold();
    let held: string[];
    try {
      await deps.attach(target).exited;
    } finally {
      restore();
      held = deps.cage_stop();
    }
    if (held.length > 0) {
      deps.log(chalk.gray('[+] While the console was attached:'));
      for (const line of held) deps.log(line);
    }
    deps.log(chalk.green('[+] Console detached; the daemon is still running. Enter attaches again, Ctrl-C stops the daemon.'));
    if (!(await deps.enter_wait())) return;
  }
}
