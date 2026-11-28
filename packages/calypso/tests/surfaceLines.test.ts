/**
 * @file Lines in a surface's own language: a browser declares the subjects it
 * claims; a chell's line in one is run by that browser, never by the engine,
 * and its answer printed by the chell. A terminal's own browser answers first;
 * with none attached, a claimed subject is refused by name. A browser's note
 * reaches only its own consoles; completion offers the claimed words.
 *
 * @module
 */
import { WebSocket } from 'ws';
import { CalypsoDaemon } from '../src/daemon/server';
import type { HostedEngine } from '../src/daemon/engine';
import { Terminals, type PtyProcess, type PtySpawn } from '../src/daemon/terminals';
import { CONTRACT_VERSION } from '@fnndsc/menu';
import type { CommandEnvelope } from '@fnndsc/cumin';

const TOKEN = 'test-attach-token';

/** A connected client: its socket, what it received, and a wait for one message. */
interface Client {
  ws: WebSocket;
  got: Record<string, unknown>[];
  next: (test: (m: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>;
}

/** Attaches a client with the given capabilities. */
async function client_attach(port: number, capabilities: Record<string, unknown>): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const got: Record<string, unknown>[] = [];
  const waits: Array<{ test: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }> = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as Record<string, unknown>;
    got.push(m);
    for (const w of [...waits]) if (w.test(m)) { waits.splice(waits.indexOf(w), 1); w.resolve(m); }
  });
  const next = (test: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
    const seen = got.find(test);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve) => waits.push({ test, resolve }));
  };
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN, capabilities: { shellCommands: false, hiddenInput: true, ...capabilities } }));
  await next((m) => m.type === 'attached');
  return { ws, got, next };
}

/** A browser that answers its own lines with a fixed reply naming itself. */
function browser_answer(client: Client, name: string): void {
  client.ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as Record<string, unknown>;
    if (m.type === 'surfaceLine') client.ws.send(JSON.stringify({ type: 'surfaceLineResult', lineId: m.lineId, rendered: `${name} ran: ${m.line as string}`, status: 'ok' }));
  });
}

/** A spawn of ptys that do nothing. */
const spawn: PtySpawn = (): PtyProcess => ({ onData: () => undefined, onExit: () => undefined, write: () => undefined, resize: () => undefined, kill: () => undefined });

describe('lines in a surface\'s own language', () => {
  let daemon: CalypsoDaemon;
  let ran: string[];
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    ran = [];
    const engine: HostedEngine = {
      line_execute: async (line: string): Promise<CommandEnvelope[]> => { ran.push(line); return [{ status: 'ok', rendered: `engine: ${line}` }]; },
      line_complete: async (prefix: string) => ({ candidates: prefix.startsWith('d') ? ['date', 'du'] : [], prefix }),
    };
    daemon = new CalypsoDaemon({ engine, token: TOKEN });
    await daemon.start();
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await daemon.stop().catch((): void => undefined);
  });

  const port = (): number => (daemon as unknown as { httpServer: { address: () => { port: number } } }).httpServer.address().port;

  it('a chell\'s line in a claimed subject is run by the browser and printed by the chell; the engine never sees it', async () => {
    const browser = await client_attach(port(), { claims: [{ subject: 'dag' }, { subject: 'file', verbs: ['open'] }] });
    browser_answer(browser, 'argus');
    const chell = await client_attach(port(), { shellCommands: true });
    sockets.push(browser.ws, chell.ws);
    chell.ws.send(JSON.stringify({ type: 'execute', id: '1', line: 'dag %1 census on' }));
    const result = await chell.next((m) => m.type === 'result' && m.id === '1');
    expect(result.envelopes).toEqual([{ status: 'ok', rendered: 'argus ran: dag %1 census on\n' }]);
    // A shared subject's other verbs stay the session's.
    chell.ws.send(JSON.stringify({ type: 'execute', id: '2', line: 'file input.txt' }));
    await chell.next((m) => m.type === 'result' && m.id === '2');
    expect(ran).toEqual(['file input.txt']);
  });

  it('a terminal\'s own browser answers before the one most recently active', async () => {
    const owner = await client_attach(port(), { claims: [{ subject: 'dag' }] });
    const other = await client_attach(port(), { claims: [{ subject: 'dag' }] });
    browser_answer(owner, 'owner');
    browser_answer(other, 'other');
    sockets.push(owner.ws, other.ws);
    daemon.terminals_set(new Terminals({ spawn, launch: { exec: 'chell', prefixArgs: [] }, target: { identity: 'i', url: 'ws://x', token: 't' } }));
    owner.ws.send(JSON.stringify({ type: 'terminalOpen', cols: 80, rows: 24 }));
    const terminalId = (await owner.next((m) => m.type === 'terminalOpened')).terminalId as string;
    // The other browser was the last to do something.
    other.ws.send(JSON.stringify({ type: 'execute', id: 'x', line: 'pwd' }));
    await other.next((m) => m.type === 'result' && m.id === 'x');
    const chell = await client_attach(port(), { shellCommands: true, terminal: terminalId });
    sockets.push(chell.ws);
    chell.ws.send(JSON.stringify({ type: 'execute', id: '1', line: 'dag census on' }));
    expect(((await chell.next((m) => m.type === 'result' && m.id === '1')).envelopes as Array<{ rendered: string }>)[0]?.rendered).toBe('owner ran: dag census on\n');
    // A plain shell's line goes to the browser most recently active.
    const shell = await client_attach(port(), { shellCommands: true });
    sockets.push(shell.ws);
    shell.ws.send(JSON.stringify({ type: 'execute', id: '2', line: 'dag census off' }));
    expect(((await shell.next((m) => m.type === 'result' && m.id === '2')).envelopes as Array<{ rendered: string }>)[0]?.rendered).toBe('other ran: dag census off\n');
  });

  it('a browser\'s own line never opens on another browser: what it did not claim, the session runs', async () => {
    const mine = await client_attach(port(), { claims: [{ subject: 'domain', verbs: ['harbor'] }] });
    const other = await client_attach(port(), { claims: [{ subject: 'domain', verbs: ['harbor', 'quay'] }] });
    browser_answer(other, 'other');
    sockets.push(mine.ws, other.ws);
    // The other browser was the last to do something, and claims `domain quay`; this one does not yet.
    other.ws.send(JSON.stringify({ type: 'execute', id: 'x', line: 'pwd' }));
    await other.next((m) => m.type === 'result' && m.id === 'x');
    mine.ws.send(JSON.stringify({ type: 'execute', id: '1', line: 'domain quay' }));
    expect(((await mine.next((m) => m.type === 'result' && m.id === '1')).envelopes as Array<{ rendered: string }>)[0]?.rendered).toBe('engine: domain quay');
    expect(ran).toEqual(['pwd', 'domain quay']);
  });

  it('with no browser attached, a subject claimed whole is refused by name, and a shared one is the session\'s', async () => {
    const browser = await client_attach(port(), { claims: [{ subject: 'dag' }, { subject: 'file', verbs: ['open'] }] });
    browser.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    const chell = await client_attach(port(), { shellCommands: true });
    sockets.push(chell.ws);
    chell.ws.send(JSON.stringify({ type: 'execute', id: '1', line: 'dag census on' }));
    const refused = await chell.next((m) => m.type === 'result' && m.id === '1');
    expect(refused.envelopes).toEqual([{ status: 'error', rendered: '', renderedErr: 'dag: an ARGUS word; no ARGUS is attached to this session\n' }]);
    chell.ws.send(JSON.stringify({ type: 'execute', id: '2', line: 'file open x' }));
    await chell.next((m) => m.type === 'result' && m.id === '2');
    expect(ran).toEqual(['file open x']);
  });

  it('a browser that cannot run the line says why, and claims can change after attach', async () => {
    const browser = await client_attach(port(), {});
    browser.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as Record<string, unknown>;
      if (m.type === 'surfaceLine') browser.ws.send(JSON.stringify({ type: 'surfaceLineError', lineId: m.lineId, reason: 'not a line of this surface' }));
    });
    browser.ws.send(JSON.stringify({ type: 'surfaceClaims', claims: [{ subject: 'universe' }] }));
    const chell = await client_attach(port(), { shellCommands: true });
    sockets.push(browser.ws, chell.ws);
    await new Promise((r) => setTimeout(r, 50));
    chell.ws.send(JSON.stringify({ type: 'execute', id: '1', line: 'universe spokes' }));
    const failed = await chell.next((m) => m.type === 'result' && m.id === '1');
    expect(failed.envelopes).toEqual([{ status: 'error', rendered: '', renderedErr: 'universe: not a line of this surface\n' }]);
  });

  it('a browser\'s note reaches the chell of its own terminal only, and completion offers the claimed words', async () => {
    const browser = await client_attach(port(), { claims: [{ subject: 'desktop' }] });
    sockets.push(browser.ws);
    daemon.terminals_set(new Terminals({ spawn, launch: { exec: 'chell', prefixArgs: [] }, target: { identity: 'i', url: 'ws://x', token: 't' } }));
    browser.ws.send(JSON.stringify({ type: 'terminalOpen', cols: 80, rows: 24 }));
    const terminalId = (await browser.next((m) => m.type === 'terminalOpened')).terminalId as string;
    const mine = await client_attach(port(), { shellCommands: true, terminal: terminalId });
    const stranger = await client_attach(port(), { shellCommands: true });
    sockets.push(mine.ws, stranger.ws);
    browser.ws.send(JSON.stringify({ type: 'note', text: 'view link: ran 4 lines' }));
    expect(await mine.next((m) => m.type === 'consoleNote')).toEqual({ type: 'consoleNote', text: 'view link: ran 4 lines' });
    await new Promise((r) => setTimeout(r, 50));
    expect(stranger.got.some((m) => m.type === 'consoleNote')).toBe(false);
    mine.ws.send(JSON.stringify({ type: 'complete', id: 'c', prefix: 'd' }));
    const completed = await mine.next((m) => m.type === 'complete' && m.id === 'c');
    expect(completed.candidates).toEqual(['date', 'du', 'desktop']);
  });

  it('a command the browser mirrors into its own console skips that console\'s echo, and reaches every other surface', async () => {
    const browser = await client_attach(port(), { claims: [] });
    sockets.push(browser.ws);
    daemon.terminals_set(new Terminals({ spawn, launch: { exec: 'chell', prefixArgs: [] }, target: { identity: 'i', url: 'ws://x', token: 't' } }));
    browser.ws.send(JSON.stringify({ type: 'terminalOpen', cols: 80, rows: 24 }));
    const terminalId = (await browser.next((m) => m.type === 'terminalOpened')).terminalId as string;
    const mine = await client_attach(port(), { shellCommands: true, terminal: terminalId });
    const other = await client_attach(port(), { shellCommands: true });
    sockets.push(mine.ws, other.ws);
    browser.ws.send(JSON.stringify({ type: 'execute', id: 'm1', line: 'ls', mirrored: true }));
    await browser.next((m) => m.type === 'result' && m.id === 'm1');
    await other.next((m) => m.type === 'session');
    await new Promise((r) => setTimeout(r, 50));
    expect(mine.got.some((m) => m.type === 'session')).toBe(false);
    // Unmirrored, it reaches the console's chell as any session echo does.
    browser.ws.send(JSON.stringify({ type: 'execute', id: 'm2', line: 'pwd' }));
    await mine.next((m) => m.type === 'session');
  });

  it('a host command or pipeline segment for a terminal\'s line is refused at the daemon, though its browser could run one: nothing is sent to either', async () => {
    const asked: string[] = [];
    const hosted = new CalypsoDaemon({
      engine: {
        line_execute: async (line: string): Promise<CommandEnvelope[]> => {
          if (line === 'shellme') await hosted.shell_current('ls').catch((e: Error) => asked.push(`shell: ${e.message}`));
          if (line === 'pipeme') await hosted.pipe_current('tr a b', Buffer.from('x')).catch((e: Error) => asked.push(`pipe: ${e.message}`));
          return [{ status: 'ok', rendered: '' }];
        },
        line_complete: async (prefix: string) => ({ candidates: [], prefix }),
      },
      token: TOKEN,
    });
    const hostedPort = await hosted.start();
    try {
      // A browser that says it can run programs: still not the surface that sent the terminal's line.
      const browser = await client_attach(hostedPort, { claims: [], shellCommands: true, pipeSegments: true });
      hosted.terminals_set(new Terminals({ spawn, launch: { exec: 'chell', prefixArgs: [] }, target: { identity: 'i', url: 'ws://x', token: 't' } }));
      browser.ws.send(JSON.stringify({ type: 'terminalOpen', cols: 80, rows: 24 }));
      const terminalId = (await browser.next((m) => m.type === 'terminalOpened')).terminalId as string;
      const chell = await client_attach(hostedPort, { shellCommands: true, pipeSegments: true, terminal: terminalId });
      sockets.push(browser.ws, chell.ws);
      chell.ws.send(JSON.stringify({ type: 'execute', id: '1', line: 'shellme' }));
      await chell.next((m) => m.type === 'result' && m.id === '1');
      chell.ws.send(JSON.stringify({ type: 'execute', id: '2', line: 'pipeme' }));
      await chell.next((m) => m.type === 'result' && m.id === '2');
      expect(asked).toEqual([
        'shell: a host command for this line would run on another surface than the one that sent it; nothing ran',
        'pipe: a pipeline segment for this line would run on another surface than the one that sent it; nothing ran',
      ]);
      for (const surface of [browser, chell]) expect(surface.got.some((m) => m.type === 'shell' || m.type === 'pipe')).toBe(false);
    } finally {
      await hosted.stop();
    }
  });

  it('a terminal\'s chell never runs a shell, an editor or a download on the daemon host: its browser does, or refuses', async () => {
    const asked: string[] = [];
    const hosted = new CalypsoDaemon({
      engine: {
        line_execute: async (line: string): Promise<CommandEnvelope[]> => {
          if (line === 'shellme') await hosted.shell_current('ls').catch((e: Error) => asked.push(`shell refused: ${e.message}`));
          if (line === 'editme') await hosted.edit_current('text', '.txt').catch((e: Error) => asked.push(`edit failed: ${e.message}`));
          if (line === 'askme') asked.push(`answer: ${await hosted.prompt_current({ message: 'q? ', hidden: false })}`);
          return [{ status: 'ok', rendered: '' }];
        },
        line_complete: async (prefix: string) => ({ candidates: [], prefix }),
      },
      token: TOKEN,
    });
    const hostedPort = await hosted.start();
    try {
      const browser = await client_attach(hostedPort, { claims: [] });
      hosted.terminals_set(new Terminals({ spawn, launch: { exec: 'chell', prefixArgs: [] }, target: { identity: 'i', url: 'ws://x', token: 't' } }));
      browser.ws.send(JSON.stringify({ type: 'terminalOpen', cols: 80, rows: 24 }));
      const terminalId = (await browser.next((m) => m.type === 'terminalOpened')).terminalId as string;
      const chell = await client_attach(hostedPort, { shellCommands: true, fileDelivery: true, terminal: terminalId });
      sockets.push(browser.ws, chell.ws);
      // The browser runs no shells: refused by name, never sent to the chell.
      chell.ws.send(JSON.stringify({ type: 'execute', id: '1', line: 'shellme' }));
      await chell.next((m) => m.type === 'result' && m.id === '1');
      expect(asked[0]).toMatch(/shell refused/);
      expect(chell.got.some((m) => m.type === 'shell')).toBe(false);
      // The editor is the browser's.
      browser.ws.on('message', (d) => {
        const m = JSON.parse(d.toString()) as Record<string, unknown>;
        if (m.type === 'edit') browser.ws.send(JSON.stringify({ type: 'editResult', editId: m.editId, content: 'text', changed: false, opened: true }));
      });
      chell.ws.send(JSON.stringify({ type: 'execute', id: '2', line: 'editme' }));
      await chell.next((m) => m.type === 'result' && m.id === '2');
      expect(browser.got.some((m) => m.type === 'edit')).toBe(true);
      expect(chell.got.some((m) => m.type === 'edit')).toBe(false);
      // The browser did not send the line: its edit carries no line of the chell's.
      expect(browser.got.find((m) => m.type === 'edit')?.lineId).toBeUndefined();
      // Its questions stay with the chell, typed in the terminal.
      chell.ws.on('message', (d) => {
        const m = JSON.parse(d.toString()) as Record<string, unknown>;
        if (m.type === 'prompt') chell.ws.send(JSON.stringify({ type: 'promptAnswer', promptId: m.promptId, answer: 'typed' }));
      });
      chell.ws.send(JSON.stringify({ type: 'execute', id: '3', line: 'askme' }));
      await chell.next((m) => m.type === 'result' && m.id === '3');
      expect(asked).toContain('answer: typed');
    } finally {
      await hosted.stop();
    }
  });
});

