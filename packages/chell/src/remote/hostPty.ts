/**
 * @file The remote side of a host pty: this terminal handed to a program the
 * daemon runs on a pseudo-terminal of its own.
 *
 * Under host control a remote chell's `!cmd` runs on the daemon host. When
 * this chell's input and output are both a terminal it says so on attach
 * (`tty`: its type and size), and the daemon runs the command on a pty and
 * relays its bytes here. For as long as the program runs, the terminal is
 * the program's: whoever read keys here (readline, the interrupt watcher) is
 * set aside (and whoever redraws on a window size), the terminal goes raw, every key goes to the daemon as typed
 * (Ctrl-C included, which the program hears as its own), every window size
 * follows it, and the program's bytes are written as they come. When it
 * ends, the terminal is put back as it was.
 *
 * - `hostPtyTerminal_describe`: what this chell declares on attach, or nothing.
 * - `HostPtyRelay`: the hand-over: `start`, `data`, `exit`.
 *
 * @module
 */
import { StringDecoder } from 'node:string_decoder';

/** The terminal a surface declares on attach: type and size, in cells. */
export interface HostPtyDeclared {
  term: string;
  cols: number;
  rows: number;
}

/** The keyboard side of a terminal, as much of `process.stdin` as the relay uses. */
export interface HostPtyInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  listeners(event: string): unknown[];
  removeAllListeners(event: string): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  resume(): unknown;
}

/** The screen side of a terminal, as much of `process.stdout` as the relay uses. */
export interface HostPtyOutput {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(chunk: string): boolean;
  listeners(event: 'resize'): unknown[];
  removeAllListeners(event: 'resize'): unknown;
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
}

/** This chell's terminal: keys, screen, and the type `TERM` names. */
export interface HostPtyTerminal {
  input: HostPtyInput;
  output: HostPtyOutput;
  term: string;
}

/** A message the relay sends the daemon. */
export type HostPtyOutgoing =
  | { type: 'hostPtyInput'; ptyId: string; data: string }
  | { type: 'hostPtyResize'; ptyId: string; cols: number; rows: number };

/**
 * What this chell declares on attach: its terminal's type and size, when its
 * input and output are both a terminal, else nothing (the daemon then runs
 * `!` on pipes).
 *
 * @param terminal - The terminal, or undefined when there is none.
 * @returns The declaration, or undefined.
 * @example
 * hostPtyTerminal_describe({ input: process.stdin, output: process.stdout, term: 'xterm-256color' });
 * // { term: 'xterm-256color', cols: 120, rows: 40 } in a terminal; undefined on pipes
 */
export function hostPtyTerminal_describe(terminal: HostPtyTerminal | undefined): HostPtyDeclared | undefined {
  if (terminal === undefined || terminal.input.isTTY !== true || terminal.output.isTTY !== true) return undefined;
  return { term: terminal.term.length > 0 ? terminal.term : 'xterm-256color', cols: terminal.output.columns ?? 80, rows: terminal.output.rows ?? 24 };
}

/** What the terminal was before a program took it, so it is put back as it was. */
interface HostPtyHeld {
  ptyId: string;
  wasRaw: boolean;
  fed: unknown[];
  keyed: unknown[];
  /** Who redraws on a window size (readline's prompt): set aside, or it draws over the program. */
  sized: unknown[];
  onKeys: (chunk: unknown) => void;
  onResize: () => void;
}

/** Hands this terminal to a program on the daemon's pty, and takes it back. */
export class HostPtyRelay {
  private held: HostPtyHeld | null = null;

  /**
   * @param terminal - This chell's terminal.
   * @param send - Sends a message to the daemon.
   */
  constructor(private readonly terminal: HostPtyTerminal, private readonly send: (message: HostPtyOutgoing) => void) {}

  /**
   * A program has started on the daemon's pty for this surface: the
   * terminal goes raw and its keys and sizes go to the daemon.
   *
   * @param ptyId - The program's id.
   * @example
   * relay.start('a1b2');
   */
  public start(ptyId: string): void {
    if (this.held !== null) this.exit(this.held.ptyId);
    const { input, output } = this.terminal;
    const decoder: StringDecoder = new StringDecoder('utf8');
    const onKeys = (chunk: unknown): void => {
      const data: string = typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer);
      if (data.length > 0) this.send({ type: 'hostPtyInput', ptyId, data });
    };
    const onResize = (): void => {
      this.send({ type: 'hostPtyResize', ptyId, cols: output.columns ?? 80, rows: output.rows ?? 24 });
    };
    const held: HostPtyHeld = {
      ptyId,
      wasRaw: input.isRaw === true,
      fed: [...input.listeners('data')],
      keyed: [...input.listeners('keypress')],
      sized: [...output.listeners('resize')],
      onKeys,
      onResize,
    };
    input.removeAllListeners('keypress');
    input.removeAllListeners('data');
    input.setRawMode?.(true);
    input.on('data', onKeys);
    input.resume();
    output.removeAllListeners('resize');
    output.on('resize', onResize);
    this.held = held;
    // The size now, which may have moved since attach.
    onResize();
  }

  /**
   * Output the program wrote, written to this terminal as it came.
   *
   * @param ptyId - The program's id.
   * @param data - The bytes.
   * @example
   * relay.data('a1b2', '\u001b[?1049h');
   */
  public data(ptyId: string, data: string): void {
    if (this.held?.ptyId !== ptyId) return;
    this.terminal.output.write(data);
  }

  /**
   * The program has ended: the terminal is put back as it was.
   *
   * @param ptyId - The program's id.
   * @example
   * relay.exit('a1b2');
   */
  public exit(ptyId: string): void {
    const held: HostPtyHeld | null = this.held;
    if (held === null || held.ptyId !== ptyId) return;
    this.held = null;
    const { input, output } = this.terminal;
    input.off('data', held.onKeys);
    output.off('resize', held.onResize);
    input.setRawMode?.(held.wasRaw);
    for (const listener of held.fed) input.on('data', listener as (...args: unknown[]) => void);
    for (const listener of held.keyed) input.on('keypress', listener as (...args: unknown[]) => void);
    for (const listener of held.sized) output.on('resize', listener as () => void);
    input.resume();
  }

  /**
   * Whether a program holds this terminal now.
   *
   * @returns True between `start` and `exit`.
   */
  public get active(): boolean {
    return this.held !== null;
  }
}
