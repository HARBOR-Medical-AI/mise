/**
 * @file The remote side of a host pty: this terminal handed to a program on
 * the daemon's pty and taken back. While it runs the terminal is raw, keys
 * and sizes go to the daemon, and the program's bytes are written as they
 * come; when it ends, the terminal is as it was.
 *
 * @module
 */
import { EventEmitter } from 'events';
import { describe, it, expect } from '@jest/globals';
import { HostPtyRelay, hostPtyTerminal_describe, type HostPtyOutgoing, type HostPtyTerminal } from '../src/remote/hostPty.js';

/** A terminal that records what is done to it. */
interface FakeTerminal extends HostPtyTerminal {
  input: EventEmitter & { isTTY: boolean; isRaw: boolean; setRawMode: (mode: boolean) => void; resume: () => void; resumed: number };
  output: EventEmitter & { isTTY: boolean; columns: number; rows: number; write: (chunk: string) => boolean; written: string[] };
}

/** A terminal of the size given, raw or cooked as the prompt left it. */
function terminal_create(cols: number = 80, rows: number = 24, raw: boolean = true): FakeTerminal {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: raw,
    resumed: 0,
    setRawMode(mode: boolean): void { input.isRaw = mode; },
    resume(): void { input.resumed += 1; },
  });
  const output = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: cols,
    rows,
    written: [] as string[],
    write(chunk: string): boolean { output.written.push(chunk); return true; },
  });
  return { input, output, term: 'xterm-kitty' } as FakeTerminal;
}

describe('hostPtyTerminal_describe', () => {
  it('declares a terminal\'s type and size, and nothing for pipes or no terminal', () => {
    const terminal = terminal_create(132, 43);
    expect(hostPtyTerminal_describe(terminal)).toEqual({ term: 'xterm-kitty', cols: 132, rows: 43 });
    expect(hostPtyTerminal_describe({ ...terminal, term: '' })).toEqual({ term: 'xterm-256color', cols: 132, rows: 43 });
    terminal.output.isTTY = false;
    expect(hostPtyTerminal_describe(terminal)).toBeUndefined();
    terminal.output.isTTY = true;
    terminal.input.isTTY = false;
    expect(hostPtyTerminal_describe(terminal)).toBeUndefined();
    expect(hostPtyTerminal_describe(undefined)).toBeUndefined();
  });
});

describe('HostPtyRelay', () => {
  it('hands the terminal over raw, keys and sizes to the daemon, bytes to the screen, and takes it back', () => {
    const terminal = terminal_create(100, 30, false);
    const sent: HostPtyOutgoing[] = [];
    const readline: string[] = [];
    const prompt = (chunk: Buffer): void => { readline.push(chunk.toString()); };
    const keyed = (): void => undefined;
    let redrawn: number = 0;
    const redraw = (): void => { redrawn += 1; };
    terminal.input.on('data', prompt);
    terminal.input.on('keypress', keyed);
    terminal.output.on('resize', redraw);
    const relay = new HostPtyRelay(terminal, (message) => sent.push(message));

    relay.start('p1');
    expect(relay.active).toBe(true);
    expect(terminal.input.isRaw).toBe(true);
    // The size now goes first: it may have moved since attach.
    expect(sent).toEqual([{ type: 'hostPtyResize', ptyId: 'p1', cols: 100, rows: 30 }]);
    // The prompt's readers are set aside: what is typed is the program's.
    terminal.input.emit('data', Buffer.from(':q'));
    terminal.input.emit('data', Buffer.from([0xc3]));
    terminal.input.emit('data', Buffer.from([0xa9]));
    terminal.input.emit('data', '\r');
    expect(readline).toEqual([]);
    terminal.output.columns = 90;
    terminal.output.emit('resize');
    relay.data('p1', '\u001b[?1049h');
    relay.data('other', 'not mine');
    expect(terminal.output.written).toEqual(['\u001b[?1049h']);
    // The prompt does not redraw over the program on a window size.
    expect(redrawn).toBe(0);
    expect(sent.slice(1)).toEqual([
      { type: 'hostPtyInput', ptyId: 'p1', data: ':q' },
      { type: 'hostPtyInput', ptyId: 'p1', data: 'é' },
      { type: 'hostPtyInput', ptyId: 'p1', data: '\r' },
      { type: 'hostPtyResize', ptyId: 'p1', cols: 90, rows: 30 },
    ]);

    relay.exit('other');
    expect(relay.active).toBe(true);
    relay.exit('p1');
    expect(relay.active).toBe(false);
    // Cooked again, as the prompt left it, its readers back, and nothing more goes up.
    expect(terminal.input.isRaw).toBe(false);
    expect(terminal.input.listeners('data')).toEqual([prompt]);
    expect(terminal.input.listeners('keypress')).toEqual([keyed]);
    expect(terminal.output.listeners('resize')).toEqual([redraw]);
    terminal.input.emit('data', Buffer.from('pwd\r'));
    terminal.output.emit('resize');
    expect(readline).toEqual(['pwd\r']);
    expect(redrawn).toBe(1);
    expect(sent).toHaveLength(5);
    relay.data('p1', 'late');
    expect(terminal.output.written).toEqual(['\u001b[?1049h']);
  });

  it('a second start ends the first hand-over before it takes the terminal again', () => {
    const terminal = terminal_create();
    const sent: HostPtyOutgoing[] = [];
    const relay = new HostPtyRelay(terminal, (message) => sent.push(message));
    relay.start('p1');
    relay.start('p2');
    expect(terminal.input.listeners('data')).toHaveLength(1);
    terminal.input.emit('data', 'x');
    expect(sent.at(-1)).toEqual({ type: 'hostPtyInput', ptyId: 'p2', data: 'x' });
    relay.exit('p2');
    expect(terminal.input.isRaw).toBe(true);
    expect(terminal.input.listeners('data')).toHaveLength(0);
  });
});
