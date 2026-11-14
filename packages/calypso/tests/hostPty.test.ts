/**
 * @file Host ptys: a terminal surface's `!` run on a pseudo-terminal of the
 * daemon's own. The command runs under `sh -c` on a pty sized and typed as
 * the surface's terminal, its bytes go to that surface alone, its keys and
 * sizes come back, and the line ends with its status. A surface with no
 * terminal is not offered one.
 *
 * @module
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import { WebSocket } from 'ws';
import { CalypsoDaemon } from '../src/daemon/server';
import type { HostedEngine } from '../src/daemon/engine';
import { hostPty_start, hostPtyTerm_resolve } from '../src/daemon/hostPty';
import { ptySpawn_load, type PtyProcess, type PtySpawn } from '../src/daemon/terminals';
import { CONTRACT_VERSION } from '@fnndsc/menu';
import type { CommandEnvelope } from '@fnndsc/cumin';

const TOKEN = 'test-attach-token';

/** A pty that records what it is told and ends when the test says so. */
interface FakePty extends PtyProcess {
  file: string;
  args: string[];
  options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv };
  written: string[];
  sizes: Array<[number, number]>;
  signals: string[];
  say: (data: string) => void;
  end: (code: number, signal?: number) => void;
}

/** A spawn that hands out fake ptys and remembers them. */
function fakeSpawn_create(): { spawn: PtySpawn; ptys: FakePty[] } {
  const ptys: FakePty[] = [];
  const spawn: PtySpawn = (file, args, options): PtyProcess => {
    let onData: (data: string) => void = (): void => undefined;
    let onExit: (event: { exitCode: number; signal?: number }) => void = (): void => undefined;
    const pty: FakePty = {
      file,
      args,
      options,
      written: [],
      sizes: [],
      signals: [],
      onData: (listener): void => { onData = listener; },
      onExit: (listener): void => { onExit = listener; },
      write: (data: string): void => { pty.written.push(data); },
      resize: (cols: number, rows: number): void => { pty.sizes.push([cols, rows]); },
      kill: (signal?: string): void => { pty.signals.push(signal ?? 'SIGHUP'); },
      say: (data: string): void => onData(data),
      end: (code: number, signal?: number): void => onExit({ exitCode: code, ...(signal !== undefined ? { signal } : {}) }),
    };
    ptys.push(pty);
    return pty;
  };
  return { spawn, ptys };
}

describe('hostPty_start', () => {
  it('runs the command under sh on a pty of the terminal\'s type and size, in the cwd given', async () => {
    const { spawn, ptys } = fakeSpawn_create();
    const out: string[] = [];
    const run = hostPty_start(spawn, 'nvim notes.txt', { terminal: { term: 'screen-256color', cols: 5000, rows: 30 }, cwd: '/work', env: { HOME: '/home/me', TERM: 'dumb' }, data: (chunk) => out.push(chunk) });
    const pty = ptys[0] as FakePty;
    expect(pty.file).toBe('/bin/sh');
    expect(pty.args).toEqual(['-c', 'nvim notes.txt']);
    expect([pty.options.name, pty.options.cols, pty.options.rows, pty.options.cwd]).toEqual(['screen-256color', 1000, 30, '/work']);
    expect(pty.options.env).toEqual({ HOME: '/home/me', TERM: 'screen-256color' });
    run.write(':q\r');
    run.resize(100, 1);
    pty.say('\u001b[?1049h');
    pty.end(3);
    expect(await run.done).toBe(3);
    expect(pty.written).toEqual([':q\r']);
    expect(pty.sizes).toEqual([[100, 2]]);
    expect(out).toEqual(['\u001b[?1049h']);
    // Once ended, nothing more reaches it or comes from it.
    run.write('late');
    pty.say('late');
    expect(pty.written).toEqual([':q\r']);
    expect(out).toEqual(['\u001b[?1049h']);
  });

  it('the program\'s last output, read off the pty after its exit, still reaches the surface before the line ends', async () => {
    const { spawn, ptys } = fakeSpawn_create();
    let out: string = '';
    const run = hostPty_start(spawn, 'echo got hello', { terminal: { term: 'xterm', cols: 80, rows: 24 }, cwd: '/', env: {}, data: (chunk: string): void => { out += chunk; } });
    const pty: FakePty = ptys[0] as FakePty;
    pty.say('hello\r\n');
    pty.end(4);
    pty.say('got hello\r\n');
    expect(await run.done).toBe(4);
    expect(out).toBe('hello\r\ngot hello\r\n');
  });

  it('a program ended by a signal ends with 128 and the signal', async () => {
    const { spawn, ptys } = fakeSpawn_create();
    const run = hostPty_start(spawn, 'sleep 9', { terminal: { term: 'xterm', cols: 80, rows: 24 }, cwd: '/', env: {}, data: () => undefined });
    (ptys[0] as FakePty).end(0, 9);
    expect(await run.done).toBe(137);
  });

  it('a cancelled line hangs it up, says it stopped, and ends with 130', async () => {
    const { spawn, ptys } = fakeSpawn_create();
    const controller = new AbortController();
    const out: string[] = [];
    const run = hostPty_start(spawn, 'nvim', { terminal: { term: 'xterm', cols: 80, rows: 24 }, cwd: '/', env: {}, data: (chunk) => out.push(chunk), signal: controller.signal });
    controller.abort();
    const pty = ptys[0] as FakePty;
    // No pid to signal as a group: the pty itself hears it.
    expect(pty.signals).toEqual(['SIGHUP']);
    run.stop();
    expect(pty.signals).toEqual(['SIGHUP']);
    pty.end(0, 1);
    expect(await run.done).toBe(130);
    expect(out.join('')).toContain('nvim: stopped');
  });

  it('a line already cancelled stops it at once', async () => {
    const { spawn, ptys } = fakeSpawn_create();
    const controller = new AbortController();
    controller.abort();
    const run = hostPty_start(spawn, 'nvim', { terminal: { term: 'xterm', cols: 80, rows: 24 }, cwd: '/', env: {}, data: () => undefined, signal: controller.signal });
    expect((ptys[0] as FakePty).signals).toEqual(['SIGHUP']);
    (ptys[0] as FakePty).end(0, 1);
    expect(await run.done).toBe(130);
  });

  it('keeps a plain terminal type and replaces anything else', () => {
    expect(hostPtyTerm_resolve('xterm-256color')).toBe('xterm-256color');
    expect(hostPtyTerm_resolve('')).toBe('xterm-256color');
    expect(hostPtyTerm_resolve('x; rm -rf /')).toBe('xterm-256color');
  });

  it('on a real pty the program has a terminal, reads what is typed and ends with its status', async () => {
    const spawn: PtySpawn | null = await ptySpawn_load();
    if (spawn === null) return;
    let out: string = '';
    let typed: boolean = false;
    const run = hostPty_start(spawn, 'tty; echo "TERM=$TERM"; stty size; read x; echo "got $x"; exit 4', {
      terminal: { term: 'xterm-256color', cols: 91, rows: 27 },
      cwd: process.cwd(),
      env: process.env,
      data: (chunk: string): void => {
        out += chunk;
        if (!typed && out.includes('27 91')) { typed = true; run.write('hello\r'); }
      },
    });
    expect(await run.done).toBe(4);
    expect(out).toMatch(/\/dev\/pts\/\d+/);
    expect(out).toContain('TERM=xterm-256color');
    expect(out).toContain('got hello');
  }, 15000);

  it('on a real pty Ctrl-Z and a program suspending itself stop nothing: the line goes on', async () => {
    // The pty's process group has no parent in its session, so POSIX has
    // job-control stops do nothing there. A stopped program would hold the
    // session with nothing to resume it; this holds that it cannot happen.
    const spawn: PtySpawn | null = await ptySpawn_load();
    if (spawn === null) return;
    let out: string = '';
    let step: number = 0;
    const run = hostPty_start(spawn, 'echo ready; read x; kill -TSTP $$; echo "got $x"; read y; echo "then $y"', {
      terminal: { term: 'xterm', cols: 80, rows: 24 },
      cwd: process.cwd(),
      env: process.env,
      data: (chunk: string): void => {
        out += chunk;
        if (step === 0 && out.includes('ready')) { step = 1; run.write('\x1a'); setTimeout((): void => run.write('one\r'), 300); }
        if (step === 1 && out.includes('got one')) { step = 2; run.write('two\r'); }
      },
    });
    const ended: number | string = await Promise.race([run.done, new Promise<string>((resolve) => setTimeout(() => resolve('held'), 8000))]);
    if (ended === 'held') run.stop();
    expect(ended).toBe(0);
    expect(out).toContain('got one');
    expect(out).toContain('then two');
  }, 15000);

  it('on a real pty a cancel ends the program and everything it started', async () => {
    const spawn: PtySpawn | null = await ptySpawn_load();
    if (spawn === null) return;
    const controller = new AbortController();
    const started: number = Date.now();
    const run = hostPty_start(spawn, 'sleep 30 & sleep 30; wait', { terminal: { term: 'xterm', cols: 80, rows: 24 }, cwd: process.cwd(), env: process.env, data: () => undefined, signal: controller.signal });
    setTimeout((): void => controller.abort(), 150);
    expect(await run.done).toBe(130);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10000);
});

/** Opens and attaches a client; resolves with it and a reader of its inbox by type. */
async function client_attach(port: number, capabilities: Record<string, unknown>): Promise<{ ws: WebSocket; next: (type: string) => Promise<Record<string, unknown>>; seen: Record<string, unknown>[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: Record<string, unknown>[] = [];
  const seen: Record<string, unknown>[] = [];
  const waiting: Array<{ type: string; resolve: (m: Record<string, unknown>) => void }> = [];
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    seen.push(message);
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
  ws.send(JSON.stringify({ type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN, capabilities }));
  await next('attached');
  return { ws, next, seen };
}

describe('the daemon runs a terminal surface\'s ! on a pty of its own', () => {
  let daemon: CalypsoDaemon;
  const sockets: WebSocket[] = [];

  /** An engine whose every line is a `!` the host runs on a pty, else says it would not. */
  const engine: HostedEngine = {
    line_execute: async (line: string): Promise<CommandEnvelope[]> => {
      const onPty: Promise<number> | null = daemon.hostPty_current(line);
      if (onPty === null) return [{ status: 'ok', rendered: 'pipes' }];
      return [{ status: 'ok', rendered: `exit ${await onPty}` }];
    },
    line_complete: async (prefix: string) => ({ candidates: [], prefix }),
  };

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await daemon.stop().catch((): void => undefined);
  });

  it('relays the program to that surface alone, with its keys and sizes, and the line ends with its status', async () => {
    const { spawn, ptys } = fakeSpawn_create();
    daemon = new CalypsoDaemon({ engine, token: TOKEN });
    daemon.ptySpawn_set(spawn);
    const port = await daemon.start();
    const shell = await client_attach(port, { shellCommands: true, tty: { term: 'xterm-kitty', cols: 120, rows: 40 } });
    const other = await client_attach(port, { shellCommands: true, tty: { term: 'xterm', cols: 80, rows: 24 } });
    sockets.push(shell.ws, other.ws);

    // A size change before the line: the program starts at it.
    shell.ws.send(JSON.stringify({ type: 'hostPtyResize', cols: 132, rows: 43 }));
    await new Promise((r) => setTimeout(r, 30));
    shell.ws.send(JSON.stringify({ type: 'execute', id: '1', line: 'nvim notes.txt' }));
    const started = await shell.next('hostPtyStart');
    const ptyId = started['ptyId'] as string;
    const pty = ptys[0] as FakePty;
    expect([pty.options.name, pty.options.cols, pty.options.rows]).toEqual(['xterm-kitty', 132, 43]);

    const data = shell.next('hostPtyData');
    pty.say('\u001b[?1049hhello');
    expect(await data).toEqual({ type: 'hostPtyData', ptyId, data: '\u001b[?1049hhello' });

    shell.ws.send(JSON.stringify({ type: 'hostPtyInput', ptyId, data: ':q\r' }));
    shell.ws.send(JSON.stringify({ type: 'hostPtyResize', ptyId, cols: 100, rows: 30 }));
    // Another surface cannot type into it or resize it.
    other.ws.send(JSON.stringify({ type: 'hostPtyInput', ptyId, data: 'rm -rf ~\r' }));
    other.ws.send(JSON.stringify({ type: 'hostPtyResize', ptyId, cols: 10, rows: 10 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(pty.written).toEqual([':q\r']);
    expect(pty.sizes).toEqual([[100, 30]]);

    pty.end(0);
    expect(await shell.next('hostPtyExit')).toEqual({ type: 'hostPtyExit', ptyId, code: 0 });
    const result = await shell.next('result');
    expect((result['envelopes'] as CommandEnvelope[])[0]?.rendered).toBe('exit 0');
    expect(other.seen.some((m) => String(m['type']).startsWith('hostPty'))).toBe(false);
  });

  it('a surface with no terminal, or a daemon with no ptys, gets pipes', async () => {
    daemon = new CalypsoDaemon({ engine, token: TOKEN });
    daemon.ptySpawn_set(fakeSpawn_create().spawn);
    const port = await daemon.start();
    const piped = await client_attach(port, { shellCommands: true });
    sockets.push(piped.ws);
    piped.ws.send(JSON.stringify({ type: 'execute', id: '1', line: 'nvim' }));
    expect(((await piped.next('result'))['envelopes'] as CommandEnvelope[])[0]?.rendered).toBe('pipes');
    // A size from a surface that declared no terminal changes nothing.
    piped.ws.send(JSON.stringify({ type: 'hostPtyResize', cols: 10, rows: 10 }));

    daemon.ptySpawn_set(null);
    const terminal = await client_attach(port, { shellCommands: true, tty: { term: 'xterm', cols: 80, rows: 24 } });
    sockets.push(terminal.ws);
    terminal.ws.send(JSON.stringify({ type: 'execute', id: '2', line: 'nvim' }));
    expect(((await terminal.next('result'))['envelopes'] as CommandEnvelope[])[0]?.rendered).toBe('pipes');
  });

  it('a surface that goes away hangs up on its program, and the daemon stopping ends any', async () => {
    const { spawn, ptys } = fakeSpawn_create();
    daemon = new CalypsoDaemon({ engine, token: TOKEN });
    daemon.ptySpawn_set(spawn);
    const port = await daemon.start();
    const shell = await client_attach(port, { shellCommands: true, tty: { term: 'xterm', cols: 80, rows: 24 } });
    sockets.push(shell.ws);
    shell.ws.send(JSON.stringify({ type: 'execute', id: '1', line: 'nvim' }));
    await shell.next('hostPtyStart');
    shell.ws.close();
    await new Promise((r) => setTimeout(r, 80));
    expect((ptys[0] as FakePty).signals[0]).toBe('SIGHUP');
    (ptys[0] as FakePty).end(0, 1);

    const again = await client_attach(port, { shellCommands: true, tty: { term: 'xterm', cols: 80, rows: 24 } });
    sockets.push(again.ws);
    again.ws.send(JSON.stringify({ type: 'execute', id: '2', line: 'nvim' }));
    await again.next('hostPtyStart');
    await daemon.stop();
    expect((ptys[1] as FakePty).signals[0]).toBe('SIGHUP');
  });

  it('a pty that will not start ends the program on the surface and fails the line', async () => {
    daemon = new CalypsoDaemon({ engine, token: TOKEN });
    daemon.ptySpawn_set((): PtyProcess => { throw new Error('posix_spawnp failed'); });
    const port = await daemon.start();
    const shell = await client_attach(port, { shellCommands: true, tty: { term: 'xterm', cols: 80, rows: 24 } });
    sockets.push(shell.ws);
    shell.ws.send(JSON.stringify({ type: 'execute', id: '1', line: 'nvim' }));
    const started = await shell.next('hostPtyStart');
    expect(await shell.next('hostPtyExit')).toEqual({ type: 'hostPtyExit', ptyId: started['ptyId'], code: 1 });
    // The line fails with the reason, however the daemon answers a line that threw.
    await new Promise((r) => setTimeout(r, 100));
    expect(JSON.stringify(shell.seen.filter((m) => m['type'] === 'result' || m['type'] === 'error'))).toContain('posix_spawnp failed');
  });
});
