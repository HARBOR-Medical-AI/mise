/**
 * @file Terminals: a surface's console as a real terminal, a `chell --remote`
 * the daemon runs under a pseudo-terminal and whose bytes it relays.
 *
 * A browser cannot hold a terminal, so the daemon holds one for it. Each
 * terminal is the same chell a shell would run, attached back to this daemon
 * over the loopback wire like any other surface; the browser draws its bytes
 * (xterm.js) and sends back keystrokes and its size. One shell
 * implementation serves the terminal and the browser alike.
 *
 * A terminal outlives the socket that opened it. The page keeps the
 * terminal's id; a reload or a dropped connection opens it again by that id,
 * receives what was printed meanwhile (a bounded buffer of the most recent
 * output) and carries on, mid-command or mid-question. A terminal nobody is
 * attached to closes after an idle timeout; its chell exiting closes it at
 * once.
 *
 * The pseudo-terminal comes from `node-pty`, an optional dependency compiled
 * at install. A daemon on a machine where it could not be built offers no
 * terminals, and says so on attach; its surfaces keep their transcript
 * console.
 *
 * @module
 */
import { randomBytes } from 'node:crypto';
import type { DaemonConsoleTarget, SurfaceLaunch } from './consoleSession.js';

/** A running pseudo-terminal, as much of node-pty's IPty as is used. */
export interface PtyProcess {
  /** Calls back with each chunk the program writes. */
  onData: (listener: (data: string) => void) => unknown;
  /** Calls back once when the program exits: its status, and the signal that ended it (0 for none). */
  onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => unknown;
  /** Types into the program. */
  write: (data: string) => void;
  /** Tells the program its new size. */
  resize: (cols: number, rows: number) => void;
  /** Ends the program: SIGHUP, or the signal named. */
  kill: (signal?: string) => void;
  /** The program's process id, which leads its own session and process group. */
  pid?: number;
}

/** Starts a program under a pseudo-terminal: node-pty's `spawn`. */
export type PtySpawn = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
) => PtyProcess;

/** Where a terminal's output goes while a surface is attached to it. */
export interface TerminalViewer {
  /** Receives output. */
  data: (terminalId: string, data: string) => void;
  /** Hears that the terminal has ended. */
  exit: (terminalId: string, code: number) => void;
  /** The surface watching, as its host knows it (who a terminal's chell belongs to). */
  owner?: () => unknown;
}

/** How terminals are kept. */
export interface TerminalsOptions {
  /** Starts a pty. */
  spawn: PtySpawn;
  /** How to run chell. */
  launch: SurfaceLaunch;
  /** The daemon a terminal's chell attaches to (the loopback address). */
  target: DaemonConsoleTarget;
  /** The recent output kept for a reattach, in characters. */
  bufferLimit?: number;
  /** How long a terminal nobody is attached to lives, in milliseconds. */
  idleMs?: number;
}

/** The recent output a terminal keeps for a reattach: about a megabyte. */
export const TERMINAL_BUFFER_LIMIT: number = 1024 * 1024;

/** How long a terminal nobody is attached to lives: fifteen minutes. */
export const TERMINAL_IDLE_MS: number = 15 * 60 * 1000;

/** The smallest and largest size a terminal takes. */
const SIZE_MIN: number = 2;
const SIZE_MAX: number = 1000;

/** One terminal. */
interface Terminal {
  id: string;
  pty: PtyProcess;
  /** Recent output, oldest first. */
  buffer: string[];
  bufferSize: number;
  viewer: TerminalViewer | null;
  idle: NodeJS.Timeout | null;
  exited: boolean;
}

/** What opening a terminal answers. */
export interface TerminalOpened {
  terminalId: string;
  /** The recent output to draw first: empty for a new terminal. */
  replay: string;
}

/**
 * A size kept in bounds and whole.
 *
 * @param n - The size asked for.
 * @returns The size used.
 * @example
 * size_clamp(5000); // 1000
 */
export function size_clamp(n: number): number {
  if (!Number.isFinite(n)) return 80;
  return Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(n)));
}

/** The daemon's terminals. */
export class Terminals {
  private readonly terminals: Map<string, Terminal> = new Map();
  private readonly bufferLimit: number;
  private readonly idleMs: number;

  /** @param options - How terminals are started and kept. */
  constructor(private readonly options: TerminalsOptions) {
    this.bufferLimit = options.bufferLimit ?? TERMINAL_BUFFER_LIMIT;
    this.idleMs = options.idleMs ?? TERMINAL_IDLE_MS;
  }

  /**
   * Opens a terminal for a viewer: the one named, when it is still running,
   * else a new one. A viewer already on the named terminal is replaced.
   *
   * @param viewer - Where its output goes.
   * @param cols - The viewer's width.
   * @param rows - The viewer's height.
   * @param terminalId - The terminal to open again, when the viewer had one.
   * @returns Its id and the output to draw first.
   */
  public open(viewer: TerminalViewer, cols: number, rows: number, terminalId?: string): TerminalOpened {
    const known: Terminal | undefined = terminalId === undefined ? undefined : this.terminals.get(terminalId);
    if (known !== undefined && !known.exited) {
      this.idle_stop(known);
      known.viewer = viewer;
      known.pty.resize(size_clamp(cols), size_clamp(rows));
      return { terminalId: known.id, replay: known.buffer.join('') };
    }
    const terminal: Terminal = this.terminal_start(size_clamp(cols), size_clamp(rows));
    terminal.viewer = viewer;
    return { terminalId: terminal.id, replay: '' };
  }

  /**
   * Types into a terminal.
   *
   * @param viewer - Who types; only the terminal's own viewer may.
   * @param terminalId - The terminal.
   * @param data - The keystrokes.
   * @returns False when the viewer does not hold that terminal.
   */
  public input(viewer: TerminalViewer, terminalId: string, data: string): boolean {
    const terminal: Terminal | undefined = this.held(viewer, terminalId);
    if (terminal === undefined) return false;
    terminal.pty.write(data);
    return true;
  }

  /**
   * Resizes a terminal.
   *
   * @param viewer - Who resizes; only the terminal's own viewer may.
   * @param terminalId - The terminal.
   * @param cols - The new width.
   * @param rows - The new height.
   * @returns False when the viewer does not hold that terminal.
   */
  public resize(viewer: TerminalViewer, terminalId: string, cols: number, rows: number): boolean {
    const terminal: Terminal | undefined = this.held(viewer, terminalId);
    if (terminal === undefined) return false;
    terminal.pty.resize(size_clamp(cols), size_clamp(rows));
    return true;
  }

  /**
   * Closes a terminal its viewer is done with.
   *
   * @param viewer - Who closes; only the terminal's own viewer may.
   * @param terminalId - The terminal.
   * @returns False when the viewer does not hold that terminal.
   */
  public close(viewer: TerminalViewer, terminalId: string): boolean {
    const terminal: Terminal | undefined = this.held(viewer, terminalId);
    if (terminal === undefined) return false;
    terminal.viewer = null;
    this.terminal_end(terminal);
    return true;
  }

  /**
   * A viewer has gone (its socket closed): its terminals keep running,
   * unwatched, until the idle timeout or a reattach.
   *
   * @param viewer - The viewer that went.
   */
  public detach(viewer: TerminalViewer): void {
    for (const terminal of this.terminals.values()) {
      if (terminal.viewer !== viewer) continue;
      terminal.viewer = null;
      this.idle_start(terminal);
    }
  }

  /** Ends every terminal (the daemon is stopping). */
  public stop(): void {
    for (const terminal of [...this.terminals.values()]) this.terminal_end(terminal);
  }

  /**
   * The viewer of a terminal, when it is running.
   *
   * @param terminalId - The terminal.
   * @returns Its viewer, or null when nobody watches it or it is gone.
   */
  public viewer_get(terminalId: string): TerminalViewer | null {
    return this.terminals.get(terminalId)?.viewer ?? null;
  }

  /**
   * The terminals a viewer holds.
   *
   * @param viewer - The viewer.
   * @returns Their ids.
   */
  public ids_list(viewer: TerminalViewer): string[] {
    return [...this.terminals.values()].filter((terminal: Terminal): boolean => terminal.viewer === viewer).map((terminal: Terminal): string => terminal.id);
  }

  /** How many terminals are running. */
  public get count(): number {
    return this.terminals.size;
  }

  /**
   * The terminal a viewer holds, by id.
   *
   * @param viewer - The viewer.
   * @param terminalId - The id.
   * @returns The terminal, or undefined when it is not that viewer's.
   */
  private held(viewer: TerminalViewer, terminalId: string): Terminal | undefined {
    const terminal: Terminal | undefined = this.terminals.get(terminalId);
    return terminal !== undefined && terminal.viewer === viewer && !terminal.exited ? terminal : undefined;
  }

  /**
   * Starts a terminal: chell attached to this daemon, under a pty.
   *
   * @param cols - Its width.
   * @param rows - Its height.
   * @returns The terminal.
   */
  private terminal_start(cols: number, rows: number): Terminal {
    const { launch, target } = this.options;
    const id: string = randomBytes(12).toString('hex');
    const pty: PtyProcess = this.options.spawn(
      launch.exec,
      [...launch.prefixArgs, '--remote', target.identity, '--attach', target.url, '--token', target.token],
      {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: process.env['HOME'] ?? process.cwd(),
        // A terminal draws colour, whatever the daemon's own environment said;
        // CHELL_TERMINAL names the terminal, so the chell can say on attach
        // whose console it is.
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '3', CHELL_TERMINAL: id },
      },
    );
    const terminal: Terminal = { id, pty, buffer: [], bufferSize: 0, viewer: null, idle: null, exited: false };
    pty.onData((data: string): void => {
      this.buffer_add(terminal, data);
      terminal.viewer?.data(id, data);
    });
    pty.onExit((event: { exitCode: number }): void => {
      terminal.exited = true;
      this.idle_stop(terminal);
      this.terminals.delete(id);
      terminal.viewer?.exit(id, event.exitCode);
      terminal.viewer = null;
    });
    this.terminals.set(id, terminal);
    return terminal;
  }

  /**
   * Keeps output for a reattach, dropping the oldest past the limit.
   *
   * @param terminal - The terminal.
   * @param data - What it printed.
   */
  private buffer_add(terminal: Terminal, data: string): void {
    terminal.buffer.push(data);
    terminal.bufferSize += data.length;
    while (terminal.bufferSize > this.bufferLimit && terminal.buffer.length > 1) {
      terminal.bufferSize -= (terminal.buffer.shift() as string).length;
    }
    if (terminal.bufferSize > this.bufferLimit) {
      const only: string = terminal.buffer[0] as string;
      terminal.buffer[0] = only.slice(only.length - this.bufferLimit);
      terminal.bufferSize = (terminal.buffer[0] as string).length;
    }
  }

  /**
   * Ends a terminal: its program is killed and it is forgotten.
   *
   * @param terminal - The terminal.
   */
  private terminal_end(terminal: Terminal): void {
    this.idle_stop(terminal);
    this.terminals.delete(terminal.id);
    if (!terminal.exited) {
      terminal.exited = true;
      try {
        terminal.pty.kill();
      } catch {
        // Already gone.
      }
    }
  }

  /**
   * Starts the clock on an unwatched terminal.
   *
   * @param terminal - The terminal.
   */
  private idle_start(terminal: Terminal): void {
    this.idle_stop(terminal);
    terminal.idle = setTimeout((): void => this.terminal_end(terminal), this.idleMs);
    terminal.idle.unref();
  }

  /**
   * Stops the clock on a terminal that is watched again.
   *
   * @param terminal - The terminal.
   */
  private idle_stop(terminal: Terminal): void {
    if (terminal.idle !== null) clearTimeout(terminal.idle);
    terminal.idle = null;
  }
}

/**
 * Loads node-pty's spawn, when node-pty was built on this machine.
 *
 * @returns The spawn, or null when node-pty is absent or will not load.
 */
export async function ptySpawn_load(): Promise<PtySpawn | null> {
  try {
    const name: string = 'node-pty';
    const module: { spawn?: PtySpawn; default?: { spawn?: PtySpawn } } = (await import(name)) as { spawn?: PtySpawn; default?: { spawn?: PtySpawn } };
    return module.spawn ?? module.default?.spawn ?? null;
  } catch {
    return null;
  }
}
