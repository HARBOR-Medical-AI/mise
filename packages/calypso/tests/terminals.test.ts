/**
 * @file Terminals: a surface's console as a chell under a pty. They start
 * chell attached back to the daemon, relay bytes both ways, keep recent
 * output for a reattach, outlive the socket until an idle timeout, and are
 * held by one viewer at a time. The daemon offers them on attach and routes
 * the four terminal messages; a daemon without a pty refuses by saying why.
 *
 * @module
 */
import { jest } from '@jest/globals';
import { WebSocket } from 'ws';
import { CalypsoDaemon } from '../src/daemon/server';
import type { HostedEngine } from '../src/daemon/engine';
import { Terminals, ptySpawn_load, type PtyProcess, type PtySpawn, type TerminalViewer } from '../src/daemon/terminals';
import { CONTRACT_VERSION } from '@fnndsc/menu';
import type { CommandEnvelope } from '@fnndsc/cumin';

const TOKEN = 'test-attach-token';

/** A pty that records what it is told and speaks when the test says so. */
interface FakePty extends PtyProcess {
  file: string;
  args: string[];
  options: { cols: number; rows: number; env: NodeJS.ProcessEnv };
  written: string[];
  sizes: Array<[number, number]>;
  killed: boolean;
  say: (data: string) => void;
  end: (code: number) => void;
}

/** A spawn that hands out fake ptys and remembers them. */
function fakeSpawn_create(): { spawn: PtySpawn; ptys: FakePty[] } {
  const ptys: FakePty[] = [];
  const spawn: PtySpawn = (file, args, options): PtyProcess => {
    let onData: (data: string) => void = (): void => undefined;
    let onExit: (event: { exitCode: number }) => void = (): void => undefined;
    const pty: FakePty = {
      file,
      args,
      options,
      written: [],
      sizes: [],
      killed: false,
      onData: (listener): void => { onData = listener; },
      onExit: (listener): void => { onExit = listener; },
      write: (data: string): void => { pty.written.push(data); },
      resize: (cols: number, rows: number): void => { pty.sizes.push([cols, rows]); },
      kill: (): void => { pty.killed = true; },
      say: (data: string): void => onData(data),
      end: (code: number): void => onExit({ exitCode: code }),
    };
    ptys.push(pty);
    return pty;
  };
  return { spawn, ptys };
}

/** A viewer that keeps what it is sent. */
function viewer_create(): TerminalViewer & { got: string[]; exits: number[] } {
  const got: string[] = [];
  const exits: number[] = [];
  return { got, exits, data: (_id: string, data: string): void => { got.push(data); }, exit: (_id: string, code: number): void => { exits.push(code); } };
}

const LAUNCH = { exec: '/usr/bin/node', prefixArgs: ['/opt/chell/index.js'] };
const TARGET = { identity: 'rudolph@cube', url: 'ws://127.0.0.1:4242', token: 'tok' };

describe('Terminals', () => {
  it('starts chell attached back to the daemon, in a colour terminal of the viewer size', () => {
    const { spawn, ptys } = fakeSpawn_create();
    const terminals = new Terminals({ spawn, launch: LAUNCH, target: TARGET });
    const opened = terminals.open(viewer_create(), 120, 40);
    expect(opened.replay).toBe('');
    expect(opened.terminalId).toMatch(/^[0-9a-f]{24}$/);
    const pty = ptys[0] as FakePty;
    expect(pty.file).toBe('/usr/bin/node');
    // The token is in the terminal's environment and nowhere in its arguments, which every user of the host can list.
    expect(pty.args).toEqual(['/opt/chell/index.js', '--remote', 'rudolph@cube', '--attach', 'ws://127.0.0.1:4242']);
    expect(pty.options.env['CHELL_ATTACH_TOKEN']).toBe('tok');
    expect([pty.options.cols, pty.options.rows]).toEqual([120, 40]);
    expect(pty.options.env['TERM']).toBe('xterm-256color');
    expect(pty.options.env['CHELL_TERMINAL']).toBe(opened.terminalId);
    expect(terminals.count).toBe(1);
  });

  it('relays output to its viewer and keystrokes and sizes to the program, clamped', () => {
    const { spawn, ptys } = fakeSpawn_create();
    const terminals = new Terminals({ spawn, launch: LAUNCH, target: TARGET });
    const viewer = viewer_create();
    const { terminalId } = terminals.open(viewer, 0, 5000);
    const pty = ptys[0] as FakePty;
    expect([pty.options.cols, pty.options.rows]).toEqual([2, 1000]);
    pty.say('\u001b[32mhello\u001b[0m\r\n');
    expect(viewer.got).toEqual(['\u001b[32mhello\u001b[0m\r\n']);
    expect(terminals.input(viewer, terminalId, 'ls\r')).toBe(true);
    expect(terminals.resize(viewer, terminalId, 90.4, Number.NaN)).toBe(true);
    expect(pty.written).toEqual(['ls\r']);
    expect(pty.sizes).toEqual([[90, 80]]);
  });

  it('is held by one viewer: another cannot type into it, resize or close it', () => {
    const { spawn, ptys } = fakeSpawn_create();
    const terminals = new Terminals({ spawn, launch: LAUNCH, target: TARGET });
    const owner = viewer_create();
    const stranger = viewer_create();
    const { terminalId } = terminals.open(owner, 80, 24);
    expect(terminals.input(stranger, terminalId, 'rm -r ~\r')).toBe(false);
    expect(terminals.resize(stranger, terminalId, 10, 10)).toBe(false);
    expect(terminals.close(stranger, terminalId)).toBe(false);
    expect(terminals.input(owner, 'nosuch', 'x')).toBe(false);
    expect((ptys[0] as FakePty).written).toEqual([]);
  });

  it('outlives its viewer, and a reattach by id replays the recent output and carries on', () => {
    const { spawn, ptys } = fakeSpawn_create();
    const terminals = new Terminals({ spawn, launch: LAUNCH, target: TARGET });
    const first = viewer_create();
    const { terminalId } = terminals.open(first, 80, 24);
    const pty = ptys[0] as FakePty;
    pty.say('one ');
    terminals.detach(first);
    pty.say('two ');
    expect(first.got).toEqual(['one ']);
    const second = viewer_create();
    const again = terminals.open(second, 100, 30, terminalId);
    expect(again).toEqual({ terminalId, replay: 'one two ' });
    expect(pty.sizes).toEqual([[100, 30]]);
    expect(ptys).toHaveLength(1);
    pty.say('three');
    expect(second.got).toEqual(['three']);
    expect(terminals.input(first, terminalId, 'x')).toBe(false);
  });

  it('keeps only the most recent output, up to its limit', () => {
    const { spawn, ptys } = fakeSpawn_create();
    const terminals = new Terminals({ spawn, launch: LAUNCH, target: TARGET, bufferLimit: 10 });
    const viewer = viewer_create();
    const { terminalId } = terminals.open(viewer, 80, 24);
    const pty = ptys[0] as FakePty;
    pty.say('abcdef');
    pty.say('ghijkl');
    expect(terminals.open(viewer, 80, 24, terminalId).replay).toBe('ghijkl');
    pty.say('0123456789XYZ');
    expect(terminals.open(viewer, 80, 24, terminalId).replay).toBe('3456789XYZ');
  });

  it('closes an unwatched terminal after the idle timeout', () => {
    jest.useFakeTimers();
    try {
      const { spawn, ptys } = fakeSpawn_create();
      const terminals = new Terminals({ spawn, launch: LAUNCH, target: TARGET, idleMs: 1000 });
      const viewer = viewer_create();
      const { terminalId } = terminals.open(viewer, 80, 24);
      terminals.detach(viewer);
      jest.advanceTimersByTime(999);
      expect(terminals.count).toBe(1);
      jest.advanceTimersByTime(1);
      expect(terminals.count).toBe(0);
      expect((ptys[0] as FakePty).killed).toBe(true);
      // Gone: the same id opens a new terminal.
      const again = terminals.open(viewer, 80, 24, terminalId);
      expect(again.terminalId).not.toBe(terminalId);
      expect(ptys).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a reattach stops the idle clock', () => {
    jest.useFakeTimers();
    try {
      const { spawn } = fakeSpawn_create();
      const terminals = new Terminals({ spawn, launch: LAUNCH, target: TARGET, idleMs: 1000 });
      const viewer = viewer_create();
      const { terminalId } = terminals.open(viewer, 80, 24);
      terminals.detach(viewer);
      jest.advanceTimersByTime(500);
      terminals.open(viewer, 80, 24, terminalId);
      jest.advanceTimersByTime(5000);
      expect(terminals.count).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('ends with its program: the viewer hears the exit and the terminal is gone', () => {
    const { spawn, ptys } = fakeSpawn_create();
    const terminals = new Terminals({ spawn, launch: LAUNCH, target: TARGET });
    const viewer = viewer_create();
    const { terminalId } = terminals.open(viewer, 80, 24);
    (ptys[0] as FakePty).end(0);
    expect(viewer.exits).toEqual([0]);
    expect(terminals.count).toBe(0);
    expect(terminals.input(viewer, terminalId, 'x')).toBe(false);
  });

  it('close and stop kill the program', () => {
    const { spawn, ptys } = fakeSpawn_create();
    const terminals = new Terminals({ spawn, launch: LAUNCH, target: TARGET });
    const viewer = viewer_create();
    const a = terminals.open(viewer, 80, 24);
    terminals.open(viewer_create(), 80, 24);
    expect(terminals.close(viewer, a.terminalId)).toBe(true);
    expect((ptys[0] as FakePty).killed).toBe(true);
    (ptys[1] as FakePty).kill = (): void => { throw new Error('already gone'); };
    terminals.stop();
    expect(terminals.count).toBe(0);
  });

  it('node-pty loads where it was built', async () => {
    const spawn: PtySpawn | null = await ptySpawn_load();
    expect(spawn === null || typeof spawn === 'function').toBe(true);
  });
});

/** A stub engine: terminals need none of it. */
const engine: HostedEngine = {
  line_execute: async (line: string): Promise<CommandEnvelope[]> => [{ status: 'ok', rendered: line }],
  line_complete: async (prefix: string) => ({ candidates: [], prefix }),
};

/** Opens and attaches a client; resolves with it and its attach ack. */
async function client_attach(port: number): Promise<{ ws: WebSocket; attached: Record<string, unknown>; next: (type: string) => Promise<Record<string, unknown>> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: Record<string, unknown>[] = [];
  const waiting: Array<{ type: string; resolve: (m: Record<string, unknown>) => void }> = [];
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    const at = waiting.findIndex((w) => w.type === message['type']);
    if (at >= 0) waiting.splice(at, 1)[0]?.resolve(message);
    else inbox.push(message);
  });
  const next = (type: string): Promise<Record<string, unknown>> => {
    const at = inbox.findIndex((m) => m['type'] === type);
    if (at >= 0) return Promise.resolve(inbox.splice(at, 1)[0] as Record<string, unknown>);
    return new Promise((resolve) => waiting.push({ type, resolve }));
  };
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN, capabilities: { hiddenInput: true, shellCommands: false } }));
  const attached = await next('attached');
  return { ws, attached, next };
}

describe('the daemon offers terminals', () => {
  let daemon: CalypsoDaemon;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await daemon.stop().catch((): void => undefined);
  });

  it('says on attach whether it offers them, and refuses by saying why when it does not', async () => {
    daemon = new CalypsoDaemon({ engine, token: TOKEN });
    const port = await daemon.start();
    const { ws, attached, next } = await client_attach(port);
    sockets.push(ws);
    expect(attached['terminals']).toBe(false);
    ws.send(JSON.stringify({ type: 'terminalOpen', cols: 80, rows: 24 }));
    const refused = await next('terminalOpened');
    expect(refused['refused']).toMatch(/offers no terminals/);
  });

  it('opens one, relays both ways, and a new socket reattaches by id with the replay', async () => {
    const { spawn, ptys } = fakeSpawn_create();
    daemon = new CalypsoDaemon({ engine, token: TOKEN });
    const port = await daemon.start();
    daemon.terminals_set(new Terminals({ spawn, launch: LAUNCH, target: TARGET }));

    const one = await client_attach(port);
    sockets.push(one.ws);
    expect(one.attached['terminals']).toBe(true);
    one.ws.send(JSON.stringify({ type: 'terminalOpen', cols: 100, rows: 30 }));
    const opened = await one.next('terminalOpened');
    const terminalId = opened['terminalId'] as string;
    expect(opened['replay']).toBe('');
    const pty = ptys[0] as FakePty;
    expect([pty.options.cols, pty.options.rows]).toEqual([100, 30]);

    const data = one.next('terminalData');
    pty.say('prompt> ');
    expect(await data).toEqual({ type: 'terminalData', terminalId, data: 'prompt> ' });
    one.ws.send(JSON.stringify({ type: 'terminalInput', terminalId, data: 'pwd\r' }));
    one.ws.send(JSON.stringify({ type: 'terminalResize', terminalId, cols: 90, rows: 20 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(pty.written).toEqual(['pwd\r']);
    expect(pty.sizes).toEqual([[90, 20]]);

    one.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    pty.say('/home/rudolph\r\n');

    const two = await client_attach(port);
    sockets.push(two.ws);
    two.ws.send(JSON.stringify({ type: 'terminalOpen', terminalId, cols: 90, rows: 20 }));
    const again = await two.next('terminalOpened');
    expect(again).toEqual({ type: 'terminalOpened', terminalId, replay: 'prompt> /home/rudolph\r\n' });

    const exit = two.next('terminalExit');
    pty.end(0);
    expect(await exit).toEqual({ type: 'terminalExit', terminalId, code: 0 });
  });

  it('a terminal is closed by its viewer, and goes with the daemon', async () => {
    const { spawn, ptys } = fakeSpawn_create();
    daemon = new CalypsoDaemon({ engine, token: TOKEN });
    const port = await daemon.start();
    daemon.terminals_set(new Terminals({ spawn, launch: LAUNCH, target: TARGET }));
    const one = await client_attach(port);
    sockets.push(one.ws);
    one.ws.send(JSON.stringify({ type: 'terminalOpen', cols: 80, rows: 24 }));
    const a = (await one.next('terminalOpened'))['terminalId'] as string;
    one.ws.send(JSON.stringify({ type: 'terminalOpen', cols: 80, rows: 24 }));
    await one.next('terminalOpened');
    one.ws.send(JSON.stringify({ type: 'terminalClose', terminalId: a }));
    await new Promise((r) => setTimeout(r, 50));
    expect((ptys[0] as FakePty).killed).toBe(true);
    expect((ptys[1] as FakePty).killed).toBe(false);
    await daemon.stop();
    expect((ptys[1] as FakePty).killed).toBe(true);
  });
});
