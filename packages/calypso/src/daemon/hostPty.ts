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
 * @module
 */
import { HOST_KILL_GRACE_MS } from './hostControl.js';
import { size_clamp, type PtyProcess, type PtySpawn } from './terminals.js';

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
  const pty: PtyProcess = spawn('/bin/sh', ['-c', command], {
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

  const done: Promise<number> = new Promise((resolve: (code: number) => void): void => {
    pty.onData((chunk: string): void => { if (!exited) options.data(chunk); });
    pty.onExit((event: { exitCode: number; signal?: number }): void => {
      exited = true;
      if (hard !== null) clearTimeout(hard);
      options.signal?.removeEventListener('abort', stop);
      if (stopped) {
        options.data(`\r\n${command}: stopped\r\n`);
        resolve(130);
        return;
      }
      resolve(event.signal !== undefined && event.signal > 0 ? 128 + event.signal : event.exitCode);
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
