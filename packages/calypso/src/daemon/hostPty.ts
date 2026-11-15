/**
 * @file Host pseudo-terminals: a `!` command run on the daemon host, under
 * host control, on a pseudo-terminal of its own, for a surface that is
 * itself a terminal.
 *
 * A remote chell in a real terminal declares `tty` on attach (its terminal
 * type and size). Its `!nvim` then runs here on a pty sized to that
 * terminal, with `TERM` from it and the daemon's working directory; the
 * daemon relays the program's output to that surface alone, the surface
 * sends back its keys and window sizes, and the line ends with the
 * program's exit status. A surface with no terminal gets pipes
 * (`hostShell_run`).
 *
 * - `hostPty_start`: starts one command on a pty and hands back its handle.
 * - `HostPtyRun`: the handle: keys in, size, stop, and the exit status.
 *
 * The pty comes from node-pty, through the same `PtySpawn` the daemon's
 * terminals use (terminals.ts).
 *
 * The program leads a session of its own whose parent, the daemon, is
 * outside it, so its process group is orphaned: POSIX has job-control stops
 * (Ctrl-Z, nvim's `:suspend`, `kill -TSTP`) do nothing there. A program
 * cannot stop and hold the session with nothing to resume it.
 *
 * @module
 */
import { HOST_KILL_GRACE_MS } from './hostControl.js';
import { size_clamp, type PtyProcess, type PtySpawn } from './terminals.js';

/** How long a pty stays quiet after its program exits before the line ends, in ms. */
const HOST_PTY_DRAIN_QUIET_MS: number = 150;

/** The longest a line waits for a program's last output after it exits, in ms. */
const HOST_PTY_DRAIN_CEILING_MS: number = 2000;

/** The terminal a surface declared: its type and size in cells. */
export interface HostPtyTerminal {
  term: string;
  cols: number;
  rows: number;
}

/** A command running on a host pty. */
export interface HostPtyRun {
  /** Types into the program (the surface's raw keys). */
  write: (data: string) => void;
  /** Tells the program its terminal's new size. */
  resize: (cols: number, rows: number) => void;
  /** Ends the program and everything it started: SIGHUP, SIGKILL after a grace. */
  stop: () => void;
  /** The exit status: the program's, 128 + the signal that ended it, 130 when stopped. */
  done: Promise<number>;
}

/** What a host pty is started with. */
export interface HostPtyOptions {
  /** The surface's terminal. */
  terminal: HostPtyTerminal;
  /** Where the command runs. */
  cwd: string;
  /** The environment it gets, before `TERM` is set from the terminal. */
  env: NodeJS.ProcessEnv;
  /** Receives the program's output, raw. */
  data: (chunk: string) => void;
  /** Stops the program when it aborts (the line is cancelled). */
  signal?: AbortSignal;
}

/**
 * A terminal type that is safe to hand to a program's environment: a plain
 * name, else `xterm-256color`.
 *
 * @param term - The type the surface declared.
 * @returns The type used.
 * @example
 * hostPtyTerm_resolve('screen-256color'); // 'screen-256color'
 * hostPtyTerm_resolve(''); // 'xterm-256color'
 */
export function hostPtyTerm_resolve(term: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(term) ? term : 'xterm-256color';
}

/** How long the shell holds the pty open after the command ends, in seconds, so its last output is read. */
const HOST_PTY_LINGER_S: string = '0.2';

/**
 * The line the pty's shell runs: the command in a subshell, then a short
 * linger before the shell exits with the command's status. node-pty can close
 * the pty as the shell exits, before the last bytes the program wrote are read
 * off it; the program's output is all written once its subshell ends, and the
 * linger lets it be read before the pty goes. An `exit` in the command ends
 * only its subshell, so the status still comes through.
 *
 * @param command - The command without its leading `!`.
 * @returns The line for `sh -c`.
 * @example
 * hostPtyLine_wrap('nvim notes.txt'); // '( nvim notes.txt\n); s=$?; sleep 0.2; exit $s'
 */
export function hostPtyLine_wrap(command: string): string {
  return `( ${command}\n); s=$?; sleep ${HOST_PTY_LINGER_S}; exit $s`;
}

/**
 * Starts a shell command on a pseudo-terminal of its own: `sh -c`, sized to
 * the surface's terminal, `TERM` from it.
 *
 * @param spawn - node-pty's spawn.
 * @param command - The command without its leading `!`.
 * @param options - The terminal, the working directory, the environment and the output.
 * @returns The running command's handle.
 * @example
 * const run = hostPty_start(spawn, 'nvim notes.txt', { terminal: { term: 'xterm', cols: 80, rows: 24 }, cwd: '/home/me', env: process.env, data: (chunk) => send(chunk) });
 * run.write(':q\r');
 * const code: number = await run.done;
 */
export function hostPty_start(spawn: PtySpawn, command: string, options: HostPtyOptions): HostPtyRun {
  const term: string = hostPtyTerm_resolve(options.terminal.term);
  const pty: PtyProcess = spawn('/bin/sh', ['-c', hostPtyLine_wrap(command)], {
    name: term,
    cols: size_clamp(options.terminal.cols),
    rows: size_clamp(options.terminal.rows),
    cwd: options.cwd,
    env: { ...options.env, TERM: term },
  });
  let exited: boolean = false;
  let stopped: boolean = false;
  let hard: ReturnType<typeof setTimeout> | null = null;

  const group_signal = (name: NodeJS.Signals): void => {
    // The program leads its own session (node-pty starts it so): the whole
    // group hears the signal, so a pipeline or a child it started goes too.
    try {
      if (pty.pid === undefined) throw new Error('no pid');
      process.kill(-pty.pid, name);
    } catch {
      try { pty.kill(name); } catch { /* already gone */ }
    }
  };
  const stop = (): void => {
    if (exited || stopped) return;
    stopped = true;
    group_signal('SIGHUP');
    hard = setTimeout((): void => { if (!exited) group_signal('SIGKILL'); }, HOST_KILL_GRACE_MS);
    hard.unref?.();
  };

  // The pty can report the exit before the program's last bytes have been
  // read off it: output keeps flowing until the line ends, and the line ends
  // once the pty has been quiet for a moment after the exit (or a ceiling
  // passes), so a program's final line is never dropped.
  let ended: boolean = false;
  let lastData: number = Date.now();
  const done: Promise<number> = new Promise((resolve: (code: number) => void): void => {
    pty.onData((chunk: string): void => {
      if (ended) return;
      lastData = Date.now();
      options.data(chunk);
    });
    pty.onExit((event: { exitCode: number; signal?: number }): void => {
      exited = true;
      if (hard !== null) clearTimeout(hard);
      options.signal?.removeEventListener('abort', stop);
      const code: number = stopped ? 130 : event.signal !== undefined && event.signal > 0 ? 128 + event.signal : event.exitCode;
      const exitedAt: number = Date.now();
      const drain = (): void => {
        const now: number = Date.now();
        if (now - lastData < HOST_PTY_DRAIN_QUIET_MS && now - exitedAt < HOST_PTY_DRAIN_CEILING_MS) {
          setTimeout(drain, HOST_PTY_DRAIN_QUIET_MS).unref?.();
          return;
        }
        ended = true;
        if (stopped) options.data(`\r\n${command}: stopped\r\n`);
        resolve(code);
      };
      setTimeout(drain, HOST_PTY_DRAIN_QUIET_MS).unref?.();
    });
  });
  if (options.signal?.aborted === true) stop();
  else options.signal?.addEventListener('abort', stop, { once: true });

  return {
    write: (data: string): void => { if (!exited) pty.write(data); },
    resize: (cols: number, rows: number): void => { if (!exited) pty.resize(size_clamp(cols), size_clamp(rows)); },
    stop,
    done,
  };
}
