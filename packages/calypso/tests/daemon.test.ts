import { WebSocket } from 'ws';
import { CalypsoDaemon, lineExit_derive } from '../src/daemon/server';
import type { HostedEngine } from '../src/daemon/engine';
import { CONTRACT_VERSION } from '@fnndsc/menu';
import type { CommandEnvelope } from '@fnndsc/cumin';

const TOKEN = 'test-attach-token';

/** A stub engine that records lines and throws on the sentinel `__throw__`. */
function stubEngine_create(): HostedEngine & { executed: string[] } {
  const executed: string[] = [];
  return {
    executed,
    line_execute: async (line: string): Promise<CommandEnvelope[]> => {
      executed.push(line);
      if (line === '__throw__') throw new Error('engine exploded');
      return [{ status: 'ok', rendered: `ran: ${line}` }];
    },
    line_complete: async (prefix: string) => ({ candidates: ['ls', 'logout'], prefix }),
  };
}

/** Buffers messages so awaiting the Nth cannot race the socket. */
function messages_collect(ws: WebSocket, n: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const out: Record<string, unknown>[] = [];
    ws.on('message', (data) => {
      out.push(JSON.parse(data.toString()));
      if (out.length === n) resolve(out);
    });
  });
}

/** Opens a client to the daemon and resolves once connected. */
function client_open(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Resolves with the next parsed message from a socket. */
function message_next(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

/** Sends a JSON message. */
function send(ws: WebSocket, message: unknown): void {
  ws.send(JSON.stringify(message));
}

/** Attaches with the valid token and awaits the ack. */
async function client_attach(
  port: number,
  shellCommands: boolean = false,
  extra: Record<string, boolean> = {},
): Promise<WebSocket> {
  const ws = await client_open(port);
  const acked = message_next(ws);
  send(ws, {
    type: 'attach',
    protocolVersion: CONTRACT_VERSION,
    token: TOKEN,
    capabilities: { hiddenInput: true, shellCommands, ...extra },
  });
  await acked;
  return ws;
}

describe('CalypsoDaemon', () => {
  let daemon: CalypsoDaemon;
  let engine: HostedEngine & { executed: string[] };
  let port: number;
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    engine = stubEngine_create();
    daemon = new CalypsoDaemon({ engine, token: TOKEN });
    port = await daemon.start();
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.terminate();
    await daemon.stop();
  });

  it('binds the loopback interface only', () => {
    // The daemon is constructed with the default host; a client on localhost
    // connects, which is exercised throughout. Here we just assert a port was
    // assigned.
    expect(port).toBeGreaterThan(0);
  });

  it('acknowledges an attach with the correct token', async () => {
    const ws = await client_open(port);
    clients.push(ws);
    const acked = message_next(ws);
    send(ws, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN });
    const msg = await acked;
    expect(msg.type).toBe('attached');
    // A daemon without host control declares none — a surface's lamp reads
    // the ack, never infers.
    expect(msg.hostControl).toEqual([]);
    expect(msg.protocolVersion).toBe(CONTRACT_VERSION);
    expect(typeof msg.session).toBe('string');
  });

  it('names the session\'s backend in the ack when told it, and nothing when not', async () => {
    const plain = await client_open(port);
    clients.push(plain);
    const first = message_next(plain);
    send(plain, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN });
    expect((await first).backend).toBeUndefined();
    await daemon.stop();
    daemon = new CalypsoDaemon({ engine, token: TOKEN, backend: 'null' });
    port = await daemon.start();
    const ws = await client_open(port);
    clients.push(ws);
    const acked = message_next(ws);
    send(ws, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN });
    expect((await acked).backend).toBe('null');
  });

  it('says in the ack whether its own code moved, checks again on each attach, and pushes the flip', async () => {
    await daemon.stop();
    let checks: number = 0;
    daemon = new CalypsoDaemon({ engine, token: TOKEN, codeCheck: (): void => { checks++; } });
    port = await daemon.start();
    const ws = await client_open(port);
    clients.push(ws);
    const acked = message_next(ws);
    send(ws, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN });
    const msg = await acked;
    expect(msg.stale).toBe(false);
    expect(checks).toBe(1);
    const pushed = message_next(ws);
    daemon.stale_set(true);
    expect(await pushed).toEqual({ type: 'stale', stale: true });
    // Only a flip is told: the same answer again sends nothing.
    daemon.stale_set(true);
    const late = await client_attach(port);
    clients.push(late);
    expect(checks).toBe(2);
  });

  it('tells every surface why it is going before it goes', async () => {
    const a = await client_attach(port);
    const b = await client_attach(port);
    clients.push(a, b);
    const toA = message_next(a);
    const toB = message_next(b);
    await daemon.closing_announce('restart');
    expect(await toA).toEqual({ type: 'closing', cause: 'restart' });
    expect(await toB).toEqual({ type: 'closing', cause: 'restart' });
  });

  it('takes the attach token from the upgrade URL when the attach carries none', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`);
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    clients.push(ws);
    const acked = message_next(ws);
    send(ws, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: '', capabilities: { shellCommands: false, hiddenInput: false, localEdit: false, pipeSegments: false } });
    const msg = await acked;
    expect(msg.type).toBe('attached');
  });

  it('refuses an empty attach token when the URL carries a wrong one', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=wrong`);
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    clients.push(ws);
    const errored = message_next(ws);
    send(ws, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: '', capabilities: { shellCommands: false, hiddenInput: false, localEdit: false, pipeSegments: false } });
    const msg = await errored;
    expect(msg.type).toBe('error');
    expect(msg.reason).toBe('invalid token');
  });

  it('refuses an attach with a wrong token and closes', async () => {
    const ws = await client_open(port);
    clients.push(ws);
    const errored = message_next(ws);
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    send(ws, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: 'wrong' });
    const msg = await errored;
    expect(msg.type).toBe('error');
    expect(msg.reason).toBe('invalid token');
    await closed;
  });

  it('refuses an attach on an incompatible contract version', async () => {
    const ws = await client_open(port);
    clients.push(ws);
    const errored = message_next(ws);
    send(ws, { type: 'attach', protocolVersion: CONTRACT_VERSION + 1, token: TOKEN });
    const msg = await errored;
    expect(msg.type).toBe('error');
    expect(String(msg.reason)).toContain('incompatible contract version');
  });

  it('requires attach before any command', async () => {
    const ws = await client_open(port);
    clients.push(ws);
    const errored = message_next(ws);
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    send(ws, { type: 'execute', id: '1', line: 'ls' });
    const msg = await errored;
    expect(msg.type).toBe('error');
    await closed;
    expect(engine.executed).toEqual([]);
  });

  it('broadcasts a telemetry heartbeat to attached surfaces', async () => {
    await daemon.stop();
    daemon = new CalypsoDaemon({
      engine,
      token: TOKEN,
      telemetryProvider: (): { jobs: number; feeds: number } => ({ jobs: 7, feeds: 3 }),
    });
    port = await daemon.start();
    const ws = await client_attach(port);
    clients.push(ws);

    const beat = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no heartbeat within 3s')), 3000);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg['type'] === 'telemetry') {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
    expect(beat['index']).toEqual({ jobs: 7, feeds: 3 });
  });

  it('the heartbeat carries the lane: the line holding it, since when, and how many wait', async () => {
    await daemon.stop();
    let release: () => void = (): void => undefined;
    const slowEngine = stubEngine_create();
    const executed: string[] = [];
    slowEngine.line_execute = async (line: string): Promise<CommandEnvelope[]> => {
      executed.push(line);
      if (line === '__slow__') await new Promise<void>((resolve) => { release = resolve; });
      return [{ status: 'ok', rendered: `ran: ${line}` }];
    };
    daemon = new CalypsoDaemon({
      engine: slowEngine,
      token: TOKEN,
      telemetryProvider: (): { jobs: number; feeds: number; cube?: { msPerPage: number; samples: number } } => ({ jobs: 7, feeds: 3, cube: { msPerPage: 2800, samples: 5 } }),
    });
    port = await daemon.start();
    const ws = await client_attach(port);
    clients.push(ws);
    const beats: Array<Record<string, unknown>> = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg['type'] === 'telemetry') beats.push(msg);
    });
    send(ws, { type: 'execute', id: 'a', line: '__slow__' });
    send(ws, { type: 'execute', id: 'b', line: 'ls' });
    send(ws, { type: 'execute', id: 'c', line: 'pwd' });
    const held = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no heartbeat with a held lane within 4s')), 4000);
      const poll = setInterval(() => {
        const beat = beats.find((b) => (b['lane'] as { running: unknown } | undefined)?.running !== null && (b['lane'] as { running: unknown } | undefined)?.running !== undefined);
        if (beat) { clearTimeout(timer); clearInterval(poll); resolve(beat); }
      }, 20);
    });
    const lane = held['lane'] as { running: { line: string; sinceMs: number; surface: string }; waiting: number };
    expect(lane.running.line).toBe('__slow__');
    expect(lane.running.sinceMs).toBeGreaterThanOrEqual(0);
    expect(lane.waiting).toBe(2);
    expect(held['cube']).toEqual({ msPerPage: 2800, samples: 5 });
    release();
    const idle = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no idle heartbeat within 4s')), 4000);
      const poll = setInterval(() => {
        const after = beats.slice().reverse().find((b) => (b['lane'] as { running: unknown; waiting: number } | undefined)?.running === null && (b['lane'] as { waiting: number }).waiting === 0);
        if (after) { clearTimeout(timer); clearInterval(poll); resolve(after); }
      }, 20);
    });
    expect((idle['lane'] as { waiting: number }).waiting).toBe(0);
    expect(executed).toEqual(['__slow__', 'ls', 'pwd']);
  });

  it('executes a line and returns its result envelopes', async () => {
    const ws = await client_attach(port);
    clients.push(ws);
    const replied = message_next(ws);
    send(ws, { type: 'execute', id: '42', line: 'pwd' });
    const msg = await replied;
    expect(msg.type).toBe('result');
    expect(msg.id).toBe('42');
    expect(msg.envelopes).toEqual([{ status: 'ok', rendered: 'ran: pwd' }]);
    expect(engine.executed).toEqual(['pwd']);
  });

  it('sends the line\'s exit status with its result, though every envelope was ok', async () => {
    const statusEngine: HostedEngine = {
      line_execute: async (line: string, options?: { ended?: (code: number) => void }): Promise<CommandEnvelope[]> => {
        // As `berth close` that closed nothing: an ok answer, status 1.
        options?.ended?.(line === 'berth close' ? 1 : 0);
        return [{ status: 'ok', rendered: line === 'berth close' ? 'berth: close: nothing closed\n' : '' }];
      },
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    await daemon.stop();
    daemon = new CalypsoDaemon({ engine: statusEngine, token: TOKEN });
    port = await daemon.start();
    const ws = await client_attach(port);
    clients.push(ws);
    let replied = message_next(ws);
    send(ws, { type: 'execute', id: 'x1', line: 'berth close' });
    expect(await replied).toEqual(expect.objectContaining({ type: 'result', id: 'x1', exitCode: 1 }));
    replied = message_next(ws);
    send(ws, { type: 'execute', id: 'x2', line: 'pwd' });
    expect(await replied).toEqual(expect.objectContaining({ type: 'result', id: 'x2', exitCode: 0 }));
  });

  it('derives a line\'s exit status from what it set, what it answered, and whether it threw', () => {
    expect(lineExit_derive([{ status: 'ok', rendered: '' }], undefined, 1)).toBe(1);
    expect(lineExit_derive([{ status: 'error', rendered: '' }], undefined, 2)).toBe(2);
    expect(lineExit_derive([{ status: 'error', rendered: '' }], undefined, 0)).toBe(1);
    expect(lineExit_derive([{ status: 'error', rendered: '' }], undefined, undefined)).toBe(1);
    expect(lineExit_derive(undefined, 'the engine threw', undefined)).toBe(1);
    expect(lineExit_derive([{ status: 'ok', rendered: '' }], undefined, undefined)).toBe(0);
    expect(lineExit_derive([], undefined, 0)).toBe(0);
  });

  it('forwards progress from the running command to the origin surface', async () => {
    let daemonRef: CalypsoDaemon | undefined;
    const progressEngine: HostedEngine = {
      line_execute: async (): Promise<CommandEnvelope[]> => {
        (daemonRef as CalypsoDaemon).progress_current({
          operation: 'upload',
          kind: 'transfer',
          phase: 'transferring',
          current: 1,
          total: 2,
          unit: 'files',
          status: 'running',
        });
        return [{ status: 'ok', rendered: 'done' }];
      },
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    await daemon.stop();
    daemon = new CalypsoDaemon({ engine: progressEngine, token: TOKEN });
    daemonRef = daemon;
    port = await daemon.start();

    const ws = await client_attach(port);
    clients.push(ws);
    const messages = messages_collect(ws, 2);
    send(ws, { type: 'execute', id: 'p1', line: 'upload x y' });
    const [progress, result] = await messages;
    expect(progress).toEqual(expect.objectContaining({
      type: 'progress',
      id: 'p1',
      operation: 'upload',
      phase: 'transferring',
      current: 1,
      total: 2,
      unit: 'files',
      status: 'running',
    }));
    expect(result).toEqual(expect.objectContaining({ type: 'result', id: 'p1' }));
  });


  it('forwards a typed event from the running command to the origin surface', async () => {
    let daemonRef: CalypsoDaemon | undefined;
    const eventEngine: HostedEngine = {
      line_execute: async (): Promise<CommandEnvelope[]> => {
        (daemonRef as CalypsoDaemon).event_current('games.trek.state', { Ship: { energy: 2350 } });
        return [{ status: 'ok', rendered: 'done' }];
      },
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    await daemon.stop();
    daemon = new CalypsoDaemon({ engine: eventEngine, token: TOKEN });
    daemonRef = daemon;
    port = await daemon.start();

    const ws = await client_attach(port);
    clients.push(ws);
    const messages = messages_collect(ws, 2);
    send(ws, { type: 'execute', id: 'e1', line: 'trek' });
    const [event, result] = await messages;
    expect(event).toEqual({ type: 'event', id: 'e1', kind: 'games.trek.state', data: { Ship: { energy: 2350 } } });
    expect(result.type).toBe('result');
  });

  it('forwards live output from the running command only to the origin surface', async () => {
    let daemonRef: CalypsoDaemon | undefined;
    const outputEngine: HostedEngine = {
      line_execute: async (): Promise<CommandEnvelope[]> => {
        (daemonRef as CalypsoDaemon).output_current('data', 'live stdout\n');
        (daemonRef as CalypsoDaemon).output_current('err', 'live stderr\n');
        return [{ status: 'ok', rendered: 'final' }];
      },
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    await daemon.stop();
    daemon = new CalypsoDaemon({ engine: outputEngine, token: TOKEN });
    daemonRef = daemon;
    port = await daemon.start();

    const origin = await client_attach(port);
    const sibling = await client_attach(port);
    clients.push(origin, sibling);
    const originMessages = messages_collect(origin, 3);
    const siblingMessages = messages_collect(sibling, 1);
    send(origin, { type: 'execute', id: 'o1', line: 'live' });

    const [stdout, stderr, result] = await originMessages;
    expect(stdout).toEqual({ type: 'output', id: 'o1', channel: 'data', chunk: 'live stdout\n' });
    expect(stderr).toEqual({ type: 'output', id: 'o1', channel: 'err', chunk: 'live stderr\n' });
    expect(result).toEqual(expect.objectContaining({ type: 'result', id: 'o1' }));

    const [siblingMessage] = await siblingMessages;
    expect(siblingMessage).toEqual(expect.objectContaining({ type: 'session' }));
  });

  it('answers a completion request', async () => {
    const ws = await client_attach(port);
    clients.push(ws);
    const replied = message_next(ws);
    send(ws, { type: 'complete', id: '7', prefix: 'l' });
    const msg = await replied;
    expect(msg.type).toBe('complete');
    expect(msg.id).toBe('7');
    expect(msg.prefix).toBe('l');
    expect(msg.candidates).toEqual(['ls', 'logout']);
  });

  it('serializes execution in submission order', async () => {
    const ws = await client_attach(port);
    clients.push(ws);
    const bothReplied = messages_collect(ws, 2);
    send(ws, { type: 'execute', id: 'a', line: 'first' });
    send(ws, { type: 'execute', id: 'b', line: 'second' });
    const replies = await bothReplied;
    expect(replies.map((r) => r.id)).toEqual(['a', 'b']);
    expect(engine.executed).toEqual(['first', 'second']);
  });

  it('relays cancellation only from the surface running the foreground command', async () => {
    let release: (() => void) | undefined;
    engine.line_execute = async (line: string): Promise<CommandEnvelope[]> => {
      engine.executed.push(line);
      await new Promise<void>((resolve: () => void): void => { release = resolve; });
      return [{ status: 'error', rendered: '', renderedErr: 'du: cancelled\n' }];
    };
    let cancellations: number = 0;
    const cancel = (): boolean => {
      cancellations += 1;
      release?.();
      return true;
    };
    engine.line_cancel = cancel;

    const origin = await client_attach(port);
    const sibling = await client_attach(port);
    clients.push(origin, sibling);
    send(origin, { type: 'execute', id: 'scan-1', line: 'du test-upload' });
    await until(() => engine.executed.length === 1);

    const siblingError = message_next(sibling);
    send(sibling, { type: 'cancel', id: 'scan-1' });
    expect((await siblingError).reason).toContain('no matching foreground command');
    expect(cancellations).toBe(0);

    const result = message_next(origin);
    send(origin, { type: 'cancel', id: 'scan-1' });
    await until(() => cancellations === 1);
    expect((await result).type).toBe('result');
  });

  it('returns an error when the engine throws during execute', async () => {
    const ws = await client_attach(port);
    clients.push(ws);
    const replied = message_next(ws);
    send(ws, { type: 'execute', id: '9', line: '__throw__' });
    const msg = await replied;
    expect(msg.type).toBe('error');
    expect(msg.id).toBe('9');
    expect(String(msg.reason)).toContain('engine exploded');
  });

  it('rejects a structurally invalid message after attach', async () => {
    const ws = await client_attach(port);
    clients.push(ws);
    const errored = message_next(ws);
    send(ws, { type: 'execute', id: '1' });
    const msg = await errored;
    expect(msg.type).toBe('error');
    expect(String(msg.reason)).toContain('line');
  });

  it('rejects a malformed message with an error', async () => {
    const ws = await client_attach(port);
    clients.push(ws);
    const errored = message_next(ws);
    ws.send('{ not json');
    const msg = await errored;
    expect(msg.type).toBe('error');
    expect(String(msg.reason)).toContain('malformed JSON');
  });

  it('broadcasts a command to sibling surfaces but not the originator', async () => {
    const a = await client_attach(port);
    const b = await client_attach(port);
    clients.push(a, b);
    const aReply = message_next(a);
    const bEvent = message_next(b);
    send(a, { type: 'execute', id: '1', line: 'ls' });
    const [aMsg, bMsg] = await Promise.all([aReply, bEvent]);
    // The originator gets the correlated result; the sibling gets a session event.
    expect(aMsg.type).toBe('result');
    expect(bMsg.type).toBe('session');
    expect(bMsg.envelope).toEqual({ status: 'ok', rendered: 'ran: ls' });
    expect(typeof bMsg.surface).toBe('string');
  });

  it('lists the attached surfaces by kind, marking the one asking (the kernel\'s peers seam, for who)', async () => {
    const shell = await client_attach(port, true);
    const browser = await client_attach(port, false);
    clients.push(shell, browser);
    const listed = daemon.surfaces_list();
    expect(listed.map((each) => each.kind)).toEqual(['chell', 'browser']);
    // Nobody is running a command, so nobody is "you".
    expect(listed.every((each) => each.you === false)).toBe(true);
    expect(new Set(listed.map((each) => each.id)).size).toBe(2);
  });

  it('replays scrollback to a newly attached surface', async () => {
    const a = await client_attach(port);
    clients.push(a);
    const aReply = message_next(a);
    send(a, { type: 'execute', id: '1', line: 'pwd' });
    await aReply;

    const b = await client_open(port);
    clients.push(b);
    const collected = messages_collect(b, 2); // attached ack, then the replay
    send(b, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN });
    const [attached, replayed] = await collected;
    expect(attached.type).toBe('attached');
    expect(replayed.type).toBe('session');
    expect(replayed.envelope).toEqual({ status: 'ok', rendered: 'ran: pwd' });
  });

  it('drops a surface from the bus when it closes', async () => {
    const a = await client_attach(port);
    const b = await client_attach(port);
    clients.push(b);
    const closed = new Promise<void>((resolve) => a.once('close', () => resolve()));
    a.terminate();
    await closed;
    const bReply = message_next(b);
    send(b, { type: 'execute', id: '1', line: 'ls' });
    expect((await bReply).type).toBe('result');
  });
});

/** Polls until a predicate holds, or throws after ~2s. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
}

describe('CalypsoDaemon prompt line push', () => {
  it('pushes the refreshed prompt before completing a state-changing command', async () => {
    let cwd = '~';
    const engine: HostedEngine = {
      line_execute: async (line: string): Promise<CommandEnvelope[]> => {
        if (line === 'cd /bin') cwd = '/bin';
        return [{ status: 'ok', rendered: '' }];
      },
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    const promptContext = () => ({
      user: 'chris', uri: 'http://cube/', cwd, pacsserver: null,
      physicalMode: false, lastExitCode: 0, lastCommandDurationMs: 0,
    });
    const daemon = new CalypsoDaemon({ engine, token: TOKEN, promptProvider: promptContext });
    const port = await daemon.start();
    try {
      const ws = await client_open(port);
      const got: Record<string, unknown>[] = [];
      ws.on('message', (d) => got.push(JSON.parse(d.toString())));

      send(ws, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN });
      await until(() => got.length >= 2);
      expect(got[0].type).toBe('attached');
      expect(got[1]).toEqual({ type: 'promptline', context: promptContext() });

      send(ws, { type: 'execute', id: '1', line: 'cd /bin' });
      await until(() => got.length >= 4);
      expect(got[2]).toEqual({ type: 'promptline', context: promptContext() });
      expect(got[3].type).toBe('result');
      ws.terminate();
    } finally {
      await daemon.stop();
    }
  });

  it('pushes the promptline from the heartbeat while warm-up counts climb', async () => {
    // No command runs during warm-up, so the only path that can refresh an
    // idle surface's prompt is the telemetry heartbeat noticing movement.
    let jobs = 0;
    const engine = stubEngine_create();
    const promptContext = () => ({
      user: 'chris', uri: 'http://cube/', cwd: '~', pacsserver: null,
      physicalMode: false, lastExitCode: 0, lastCommandDurationMs: 0,
      procWarmup: { loaded: jobs, total: 100, state: 'cached' as const },
    });
    const daemon = new CalypsoDaemon({
      engine,
      token: TOKEN,
      promptProvider: promptContext,
      telemetryProvider: (): { jobs: number; feeds: number } => ({ jobs: ++jobs, feeds: 0 }),
    });
    const port = await daemon.start();
    try {
      const ws = await client_open(port);
      const prompts: Record<string, unknown>[] = [];
      ws.on('message', (d) => {
        const msg = JSON.parse(d.toString()) as Record<string, unknown>;
        if (msg['type'] === 'promptline') prompts.push(msg);
      });
      send(ws, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN });
      // One push rides the attach; at least one more must ride a heartbeat.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no heartbeat prompt push within 3s')), 3000);
        const poll = setInterval(() => {
          if (prompts.length >= 2) {
            clearTimeout(timer);
            clearInterval(poll);
            resolve();
          }
        }, 20);
      });
      const last = prompts[prompts.length - 1] as { context: { procWarmup?: { loaded: number } } };
      expect(last.context.procWarmup?.loaded).toBeGreaterThan(0);
      ws.terminate();
    } finally {
      await daemon.stop();
    }
  });

  it('pushes the promptline from the heartbeat while a command is executing, though the counts stand still', async () => {
    // A feed's topology walk reports its progress into the prompt context
    // page by page, but adds its instances to the index only once the walk
    // is done — so the counts do not move, and the command's own push comes
    // only at its end. The heartbeat carries the walk while it runs.
    let release: () => void = (): void => {};
    const held: Promise<void> = new Promise<void>((resolve) => { release = resolve; });
    let walking: boolean = false;
    const engine = stubEngine_create();
    engine.line_execute = async (): Promise<CommandEnvelope[]> => {
      walking = true;
      await held;
      walking = false;
      return [];
    };
    let page: number = 0;
    const promptContext = () => ({
      user: 'chris', uri: 'http://cube/', cwd: '~', pacsserver: null,
      physicalMode: false, lastExitCode: 0, lastCommandDurationMs: 0,
      ...(walking
        ? { procWarmup: { loaded: 0, total: 0, state: 'cached' as const, sweeping: false, feed: { id: 834, loaded: ++page * 100, total: 1323 } } }
        : {}),
    });
    const daemon = new CalypsoDaemon({
      engine,
      token: TOKEN,
      promptProvider: promptContext,
      // The counts never move: nothing but the running command can justify a push.
      telemetryProvider: (): { jobs: number; feeds: number } => ({ jobs: 7, feeds: 3 }),
    });
    const port = await daemon.start();
    try {
      const ws = await client_open(port);
      const prompts: Array<{ context: { procWarmup?: { feed?: { id: number; loaded: number } } } }> = [];
      let beats: number = 0;
      ws.on('message', (d) => {
        const msg = JSON.parse(d.toString()) as Record<string, unknown>;
        if (msg['type'] === 'promptline') prompts.push(msg as unknown as { context: { procWarmup?: { feed?: { id: number; loaded: number } } } });
        if (msg['type'] === 'telemetry') beats += 1;
      });
      send(ws, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN });
      // The attach pushes once, and the first heartbeat pushes once more (it
      // has no previous counts to compare). Let both pass, so any push from
      // here on is the heartbeat acting on a running command alone.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no quiet heartbeat within 4s')), 4000);
        const poll = setInterval(() => { if (beats >= 2) { clearTimeout(timer); clearInterval(poll); resolve(); } }, 20);
      });
      const before: number = prompts.length;
      send(ws, { type: 'execute', id: '834', line: 'proc refresh 834' });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no heartbeat prompt push while the command ran')), 4000);
        const poll = setInterval(() => { if (prompts.length > before) { clearTimeout(timer); clearInterval(poll); resolve(); } }, 20);
      });
      const carried = prompts[prompts.length - 1];
      expect(carried.context.procWarmup?.feed?.id).toBe(834);
      expect(carried.context.procWarmup?.feed?.loaded).toBeGreaterThan(0);
      release();
      ws.terminate();
    } finally {
      release();
      await daemon.stop();
    }
  });

  it('does not push a prompt when no provider is configured', async () => {
    const engine = stubEngine_create();
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    const port = await daemon.start();
    try {
      const ws = await client_open(port);
      const got: Record<string, unknown>[] = [];
      ws.on('message', (d) => got.push(JSON.parse(d.toString())));
      send(ws, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN });
      await until(() => got.length >= 1);
      // Give any stray push a chance to arrive, then assert none did.
      await new Promise((r) => setTimeout(r, 50));
      expect(got.every((m) => m.type !== 'promptline')).toBe(true);
      ws.terminate();
    } finally {
      await daemon.stop();
    }
  });
});

describe('CalypsoDaemon prompt over the wire', () => {
  it('routes a prompt raised during a command to the executing surface', async () => {
    let daemonRef: CalypsoDaemon | undefined;
    const engine: HostedEngine = {
      line_execute: async (line: string): Promise<CommandEnvelope[]> => {
        if (line === '__prompt__') {
          const answer: string = await (daemonRef as CalypsoDaemon)
            .prompt_current({ message: 'Password:', hidden: true });
          return [{ status: 'ok', rendered: `got: ${answer}` }];
        }
        return [{ status: 'ok', rendered: `ran: ${line}` }];
      },
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    daemonRef = daemon;
    const port = await daemon.start();
    try {
      const ws = await client_attach(port);
      const prompted = message_next(ws);
      send(ws, { type: 'execute', id: '1', line: '__prompt__' });
      const prompt = await prompted;
      expect(prompt.type).toBe('prompt');
      expect(prompt.message).toBe('Password:');
      expect(prompt.hidden).toBe(true);

      const replied = message_next(ws);
      send(ws, { type: 'promptAnswer', promptId: prompt.promptId as string, answer: 'secret' });
      const result = await replied;
      expect(result.type).toBe('result');
      expect((result.envelopes as { rendered: string }[])[0].rendered).toBe('got: secret');
      ws.terminate();
    } finally {
      await daemon.stop();
    }
  });

  it('rejects prompt_current when no command is executing', async () => {
    const engine: HostedEngine = {
      line_execute: async () => [],
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    await daemon.start();
    try {
      await expect(daemon.prompt_current({ message: 'x', hidden: false })).rejects.toThrow('no active command');
    } finally {
      await daemon.stop();
    }
  });
});

describe('CalypsoDaemon pipe segments over the wire', () => {
  it('routes a pipe segment to the executing surface and returns its output', async () => {
    let daemonRef: CalypsoDaemon | undefined;
    const engine: HostedEngine = {
      line_execute: async (line: string): Promise<CommandEnvelope[]> => {
        if (line === '__pipe__') {
          const out: Buffer = await (daemonRef as CalypsoDaemon).pipe_current('grep foo', Buffer.from('input'));
          return [{ status: 'ok', rendered: `piped: ${out.toString('utf-8')}` }];
        }
        return [{ status: 'ok', rendered: `ran: ${line}` }];
      },
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    daemonRef = daemon;
    const port = await daemon.start();
    try {
      const ws = await client_attach(port);
      const asked = message_next(ws);
      send(ws, { type: 'execute', id: '1', line: '__pipe__' });
      const pipe = await asked;
      expect(pipe.type).toBe('pipe');
      expect(pipe.command).toBe('grep foo');
      expect(Buffer.from(pipe.input as string, 'base64').toString('utf-8')).toBe('input');

      const replied = message_next(ws);
      send(ws, { type: 'pipeResult', pipeId: pipe.pipeId as string, output: Buffer.from('OUTPUT').toString('base64') });
      const result = await replied;
      expect(result.type).toBe('result');
      expect((result.envelopes as { rendered: string }[])[0].rendered).toBe('piped: OUTPUT');
      ws.terminate();
    } finally {
      await daemon.stop();
    }
  });

  it('returns a surface pipe failure to the executing engine', async () => {
    let daemonRef: CalypsoDaemon | undefined;
    const engine: HostedEngine = {
      line_execute: async (): Promise<CommandEnvelope[]> => {
        try {
          await (daemonRef as CalypsoDaemon).pipe_current('signalflow', Buffer.from('pipeline: test'));
          return [{ status: 'ok', rendered: '' }];
        } catch (error: unknown) {
          const message: string = error instanceof Error ? error.message : String(error);
          return [{ status: 'error', rendered: message }];
        }
      },
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    daemonRef = daemon;
    const port: number = await daemon.start();
    try {
      const ws: WebSocket = await client_attach(port);
      const asked: Promise<Record<string, unknown>> = message_next(ws);
      send(ws, { type: 'execute', id: '1', line: '__pipe_error__' });
      const pipe: Record<string, unknown> = await asked;

      const replied: Promise<Record<string, unknown>> = message_next(ws);
      send(ws, { type: 'pipeError', pipeId: pipe.pipeId as string, reason: "Command 'signalflow' exited with code 1" });
      const result: Record<string, unknown> = await replied;

      expect(result.type).toBe('result');
      expect((result.envelopes as CommandEnvelope[])[0]).toEqual({
        status: 'error',
        rendered: "Command 'signalflow' exited with code 1",
      });
      ws.terminate();
    } finally {
      await daemon.stop();
    }
  });
});

describe('CalypsoDaemon shell commands over the wire', () => {
  it('routes a shell command to the executing surface and returns its exit code', async () => {
    let daemonRef: CalypsoDaemon | undefined;
    const engine: HostedEngine = {
      line_execute: async (): Promise<CommandEnvelope[]> => {
        const exitCode: number = await (daemonRef as CalypsoDaemon).shell_current('pwd');
        return [{ status: exitCode === 0 ? 'ok' : 'error', rendered: '' }];
      },
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    daemonRef = daemon;
    const port: number = await daemon.start();
    try {
      const ws: WebSocket = await client_attach(port, true);
      const asked: Promise<Record<string, unknown>> = message_next(ws);
      send(ws, { type: 'execute', id: '1', line: '!pwd' });
      const shell: Record<string, unknown> = await asked;
      expect(shell).toEqual(expect.objectContaining({ type: 'shell', command: 'pwd' }));

      const replied: Promise<Record<string, unknown>> = message_next(ws);
      send(ws, { type: 'shellResult', shellId: shell.shellId as string, exitCode: 0 });
      const result: Record<string, unknown> = await replied;
      expect(result).toEqual(expect.objectContaining({
        type: 'result',
        envelopes: [{ status: 'ok', rendered: '' }],
      }));
      ws.terminate();
    } finally {
      await daemon.stop();
    }
  });

  it('rejects shell execution when the originating surface lacks the capability', async () => {
    let daemonRef: CalypsoDaemon | undefined;
    const engine: HostedEngine = {
      line_execute: async (): Promise<CommandEnvelope[]> => {
        try {
          await (daemonRef as CalypsoDaemon).shell_current('pwd');
          return [{ status: 'ok', rendered: '' }];
        } catch (error: unknown) {
          return [{
            status: 'error',
            rendered: '',
            renderedErr: error instanceof Error ? error.message : String(error),
          }];
        }
      },
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    daemonRef = daemon;
    const port: number = await daemon.start();
    try {
      const ws: WebSocket = await client_attach(port);
      const replied: Promise<Record<string, unknown>> = message_next(ws);
      send(ws, { type: 'execute', id: '1', line: '!pwd' });
      const result: Record<string, unknown> = await replied;
      expect(result).toEqual(expect.objectContaining({
        type: 'result',
        envelopes: [expect.objectContaining({
          status: 'error',
          renderedErr: expect.stringContaining("--host-control"),
        })],
      }));
      ws.terminate();
    } finally {
      await daemon.stop();
    }
  });

  it('ignores a shell result forged by a sibling surface', async () => {
    let daemonRef: CalypsoDaemon | undefined;
    const engine: HostedEngine = {
      line_execute: async (): Promise<CommandEnvelope[]> => {
        const exitCode: number = await (daemonRef as CalypsoDaemon).shell_current('pwd');
        return [{ status: exitCode === 0 ? 'ok' : 'error', rendered: '' }];
      },
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    daemonRef = daemon;
    const port: number = await daemon.start();
    try {
      const origin: WebSocket = await client_attach(port, true);
      const sibling: WebSocket = await client_attach(port, true);
      const asked: Promise<Record<string, unknown>> = message_next(origin);
      send(origin, { type: 'execute', id: '1', line: '!pwd' });
      const shell: Record<string, unknown> = await asked;
      send(sibling, { type: 'shellResult', shellId: shell.shellId as string, exitCode: 9 });

      const replied: Promise<Record<string, unknown>> = message_next(origin);
      send(origin, { type: 'shellResult', shellId: shell.shellId as string, exitCode: 0 });
      const result: Record<string, unknown> = await replied;
      expect(result).toEqual(expect.objectContaining({
        type: 'result',
        envelopes: [{ status: 'ok', rendered: '' }],
      }));
      origin.terminate();
      sibling.terminate();
    } finally {
      await daemon.stop();
    }
  });
});

describe('CalypsoDaemon local edit over the wire', () => {
  it('routes an edit to the executing surface and returns the edited content', async () => {
    let daemonRef: CalypsoDaemon | undefined;
    const engine: HostedEngine = {
      line_execute: async (line: string): Promise<CommandEnvelope[]> => {
        if (line === '__edit__') {
          const edit = await (daemonRef as CalypsoDaemon).edit_current('before', '.txt');
          return [{ status: 'ok', rendered: `edited(${edit.changed}): ${edit.content}` }];
        }
        return [{ status: 'ok', rendered: `ran: ${line}` }];
      },
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    daemonRef = daemon;
    const port = await daemon.start();
    try {
      const ws = await client_attach(port);
      const asked = message_next(ws);
      send(ws, { type: 'execute', id: '1', line: '__edit__' });
      const edit = await asked;
      expect(edit.type).toBe('edit');
      expect(edit.content).toBe('before');
      expect(edit.extension).toBe('.txt');

      const replied = message_next(ws);
      send(ws, { type: 'editResult', editId: edit.editId as string, content: 'after', changed: true });
      const result = await replied;
      expect(result.type).toBe('result');
      expect((result.envelopes as { rendered: string }[])[0].rendered).toBe('edited(true): after');
      ws.terminate();
    } finally {
      await daemon.stop();
    }
  });
});

describe('CalypsoDaemon edit into a pane that stays open', () => {
  it('names the file to the surface and carries back that the surface opened it', async () => {
    let daemonRef: CalypsoDaemon | undefined;
    const engine: HostedEngine = {
      line_execute: async (line: string): Promise<CommandEnvelope[]> => {
        const edit = await (daemonRef as CalypsoDaemon).edit_current('the note', '.txt', '/proc/jobs/feed_12/note');
        return [{ status: 'ok', rendered: `opened=${String(edit.opened)} changed=${String(edit.changed)} ${line}` }];
      },
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    daemonRef = daemon;
    const port = await daemon.start();
    try {
      const ws = await client_attach(port);
      const asked = message_next(ws);
      send(ws, { type: 'execute', id: '1', line: 'x' });
      const edit = await asked;
      expect(edit.type).toBe('edit');
      expect(edit.path).toBe('/proc/jobs/feed_12/note');

      const replied = message_next(ws);
      send(ws, { type: 'editResult', editId: edit.editId as string, content: 'the note', changed: false, opened: true });
      const result = await replied;
      expect((result.envelopes as { rendered: string }[])[0].rendered).toBe('opened=true changed=false x');
      ws.terminate();
    } finally {
      await daemon.stop();
    }
  });
});

describe('CalypsoDaemon file delivery over the wire', () => {
  it('routes a delivery to the executing surface and reports where it landed', async () => {
    let daemonRef: CalypsoDaemon | undefined;
    const engine: HostedEngine = {
      line_execute: async (line: string): Promise<CommandEnvelope[]> => {
        if (line === '__deliver__') {
          const delivered = await (daemonRef as CalypsoDaemon).deliver_current({
            path: '/home/me/scan.dcm', filename: 'scan.dcm', destination: '/tmp', size: 2048,
          });
          return [{ status: 'ok', rendered: `${delivered.bytes} bytes to ${delivered.location}` }];
        }
        return [{ status: 'ok', rendered: `ran: ${line}` }];
      },
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    daemonRef = daemon;
    const port = await daemon.start();
    try {
      const ws = await client_attach(port, false, { fileDelivery: true });
      const asked = message_next(ws);
      send(ws, { type: 'execute', id: '1', line: '__deliver__' });
      const deliver = await asked;
      // Only the request crosses; the surface fetches the bytes itself.
      expect(deliver.type).toBe('deliver');
      expect(deliver.path).toBe('/home/me/scan.dcm');
      expect(deliver.filename).toBe('scan.dcm');
      expect(deliver.destination).toBe('/tmp');
      expect(deliver.size).toBe(2048);
      expect(deliver).not.toHaveProperty('bytes');

      const replied = message_next(ws);
      send(ws, {
        type: 'deliverResult',
        deliverId: deliver.deliverId as string,
        location: '/tmp/scan.dcm',
        bytes: 2048,
      });
      const result = await replied;
      expect((result.envelopes as { rendered: string }[])[0].rendered).toBe('2048 bytes to /tmp/scan.dcm');
      ws.terminate();
    } finally {
      await daemon.stop();
    }
  });

  it('fails the command when the surface cannot deliver', async () => {
    let daemonRef: CalypsoDaemon | undefined;
    const engine: HostedEngine = {
      line_execute: async (line: string): Promise<CommandEnvelope[]> => {
        if (line === '__deliver__') {
          try {
            await (daemonRef as CalypsoDaemon).deliver_current({ path: '/x', filename: 'x' });
          } catch (error: unknown) {
            return [{ status: 'error', rendered: '', renderedErr: String((error as Error).message) }];
          }
        }
        return [{ status: 'ok', rendered: '' }];
      },
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    daemonRef = daemon;
    const port = await daemon.start();
    try {
      const ws = await client_attach(port, false, { fileDelivery: true });
      const asked = message_next(ws);
      send(ws, { type: 'execute', id: '1', line: '__deliver__' });
      const deliver = await asked;
      const replied = message_next(ws);
      send(ws, { type: 'deliverError', deliverId: deliver.deliverId as string, reason: 'no disk here' });
      const result = await replied;
      expect((result.envelopes as { renderedErr: string }[])[0].renderedErr).toContain('no disk here');
      ws.terminate();
    } finally {
      await daemon.stop();
    }
  });
});

describe('CalypsoDaemon scrollback bound', () => {
  it('retains only the most recent envelopes up to the size', async () => {
    const engine = stubEngine_create();
    const daemon = new CalypsoDaemon({ engine, token: TOKEN, scrollbackSize: 2 });
    const port = await daemon.start();
    try {
      const a = await client_attach(port);
      for (const line of ['one', 'two', 'three']) {
        const replied = message_next(a);
        send(a, { type: 'execute', id: line, line });
        await replied;
      }
      const c = await client_open(port);
      const collected = messages_collect(c, 3); // attached + 2 replayed
      send(c, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN });
      const messages = await collected;
      a.terminate();
      c.terminate();
      expect(messages[0].type).toBe('attached');
      const rendered = messages.slice(1).map((m) => (m.envelope as { rendered: string }).rendered);
      expect(rendered).toEqual(['ran: two', 'ran: three']);
    } finally {
      await daemon.stop();
    }
  });

  it('a watch is owned by its surface: opened on the wire, answered with its state, released on detach', async () => {
    const engine = stubEngine_create();
    const calls: { subject: string; owner: string; on: boolean }[] = [];
    const released: string[] = [];
    (engine as { watch_set?: (subject: string, owner: string, on: boolean) => string | null }).watch_set =
      (subject, owner, on): string | null => { calls.push({ subject, owner, on }); return subject.includes('feed_') ? 'live' : null; };
    (engine as { watch_release?: (owner: string) => void }).watch_release = (owner): void => { released.push(owner); };
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    const port = await daemon.start();
    try {
      const watcher = await client_attach(port);
      const answered = message_next(watcher);
      send(watcher, { type: 'watch', subject: '/proc/jobs/feed_7' });
      expect(await answered).toEqual({ type: 'watched', subject: '/proc/jobs/feed_7', state: 'live' });
      expect(calls).toEqual([{ subject: '/proc/jobs/feed_7', owner: expect.any(String), on: true }]);

      const refused = message_next(watcher);
      send(watcher, { type: 'watch', subject: '/vfs/home' });
      expect((await refused).type).toBe('error');

      watcher.terminate();
      await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, 50); });
      expect(released).toEqual([calls[0].owner]);
    } finally {
      await daemon.stop();
    }
  });

  it('relays ambient engine events to every surface: models on the bus as the daemon, watch states as their own message', async () => {
    const engine = stubEngine_create();
    let publish: ((event: unknown) => void) | null = null;
    (engine as { ambient_listen?: (l: (event: unknown) => void) => () => void }).ambient_listen =
      (listener): (() => void) => { publish = listener; return (): void => { publish = null; }; };
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    const port = await daemon.start();
    try {
      const a = await client_attach(port);
      const b = await client_attach(port);
      const envelope = { status: 'ok', rendered: 'dag', model: { kind: 'feed.dag', data: {} } };
      const gotA = messages_collect(a, 2);
      const gotB = messages_collect(b, 2);
      publish!({ kind: 'envelope', envelope });
      publish!({ kind: 'watched', subject: '/proc/jobs/feed_7', state: 'settled' });
      for (const got of [await gotA, await gotB]) {
        expect(got[0]).toMatchObject({ type: 'session', surface: 'daemon' });
        expect(got[1]).toEqual({ type: 'watched', subject: '/proc/jobs/feed_7', state: 'settled' });
      }
      a.terminate();
      b.terminate();
    } finally {
      await daemon.stop();
    }
    expect(publish).toBeNull();
  });

  it('hands each line its surface as origin, and tells only that surface what its listing numbered (#1273)', async () => {
    const engine = stubEngine_create();
    let publish: ((event: unknown) => void) | null = null;
    (engine as { ambient_listen?: (l: (event: unknown) => void) => () => void }).ambient_listen =
      (listener): (() => void) => { publish = listener; return (): void => { publish = null; }; };
    const origins: Array<string | undefined> = [];
    engine.line_execute = async (line: string, options?: { origin?: string }): Promise<CommandEnvelope[]> => {
      origins.push(options?.origin);
      publish!({ kind: 'numbered', origin: options?.origin, id: origins.length, source: line, rows: 1, handles: [] });
      return [{ status: 'ok', rendered: '' } as CommandEnvelope];
    };
    const forgotten: string[] = [];
    (engine as { origin_forget?: (origin: string) => void }).origin_forget = (origin: string): void => { forgotten.push(origin); };
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    const port = await daemon.start();
    try {
      const a = await client_attach(port);
      const b = await client_attach(port);
      const heardA: Record<string, unknown>[] = [];
      const heardB: Record<string, unknown>[] = [];
      a.on('message', (data) => heardA.push(JSON.parse(String(data))));
      b.on('message', (data) => heardB.push(JSON.parse(String(data))));
      send(a, { type: 'execute', id: '1', line: 'ls /a' });
      await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, 100); });
      send(b, { type: 'execute', id: '2', line: 'ls /b' });
      await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, 100); });
      const numbered = (heard: Record<string, unknown>[]): unknown[] => heard.filter((m) => m.type === 'numbered').map((m) => m.source);
      expect(origins).toHaveLength(2);
      expect(origins[0]).not.toBe(origins[1]);
      expect(numbered(heardA)).toEqual(['ls /a']);
      expect(numbered(heardB)).toEqual(['ls /b']);
      a.terminate();
      await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, 50); });
      expect(forgotten).toEqual([origins[0]]);
      b.terminate();
    } finally {
      await daemon.stop();
    }
  });

  it('sends an envelope for one surface (a joblet notice) to it alone, and to everyone once it has gone (#1273)', async () => {
    const engine = stubEngine_create();
    let publish: ((event: unknown) => void) | null = null;
    (engine as { ambient_listen?: (l: (event: unknown) => void) => () => void }).ambient_listen =
      (listener): (() => void) => { publish = listener; return (): void => { publish = null; }; };
    const origins: string[] = [];
    engine.line_execute = async (_line: string, options?: { origin?: string }): Promise<CommandEnvelope[]> => {
      origins.push(options?.origin ?? '');
      return [{ status: 'ok', rendered: '' } as CommandEnvelope];
    };
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    const port = await daemon.start();
    try {
      const a = await client_attach(port);
      const b = await client_attach(port);
      const heardA: Record<string, unknown>[] = [];
      const heardB: Record<string, unknown>[] = [];
      a.on('message', (data) => heardA.push(JSON.parse(String(data))));
      b.on('message', (data) => heardB.push(JSON.parse(String(data))));
      send(a, { type: 'execute', id: '1', line: 'pull &' });
      await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, 100); });
      const notice = (text: string): unknown => ({ kind: 'envelope', origin: origins[0], envelope: { status: 'ok', rendered: text } });
      const sessionTexts = (heard: Record<string, unknown>[]): string[] => heard.filter((m) => m.type === 'session' && m.surface === 'daemon')
        .map((m) => (m.envelope as { rendered: string }).rendered);
      // A joblet's progress is its surface's alone.
      publish!({ kind: 'progress', origin: origins[0], id: 'joblet-1', progress: { operation: 'pull', phase: 'watching', itemId: '1.2' } });
      publish!(notice('[1]+ Done  pull\n'));
      await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, 50); });
      expect(sessionTexts(heardA)).toEqual(['[1]+ Done  pull\n']);
      expect(sessionTexts(heardB)).toEqual([]);
      expect(heardA.filter((m) => m.type === 'progress')).toEqual([{ type: 'progress', id: 'joblet-1', operation: 'pull', phase: 'watching', itemId: '1.2' }]);
      expect(heardB.filter((m) => m.type === 'progress')).toEqual([]);
      a.terminate();
      await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, 50); });
      publish!(notice('[2]+ Done  pull\n'));
      await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, 50); });
      expect(sessionTexts(heardB)).toEqual(['[2]+ Done  pull\n']);
      b.terminate();
    } finally {
      await daemon.stop();
    }
  });

  it('gives work outside any line (a joblet) a hold in the same lane as the lines', async () => {
    const engine = stubEngine_create();
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    await daemon.start();
    try {
      const release = await daemon.hold_take(['cohort']);
      let second: boolean = false;
      const waiting = daemon.hold_take(['cohort']).then((give) => { second = true; return give; });
      const beside = await daemon.hold_take(['cwd']);
      await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, 20); });
      expect(second).toBe(false);
      release();
      release();
      (await waiting)();
      beside();
      expect(second).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  it('retains a regard write, mirrors it into the engine, and rebroadcasts to every surface', async () => {
    const engine = stubEngine_create();
    const noted: unknown[] = [];
    (engine as { regard_note?: (regard: unknown) => void }).regard_note = (regard): void => {
      noted.push(regard);
    };
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    const port = await daemon.start();
    try {
      const writer = await client_attach(port);
      const sibling = await client_attach(port);
      const regard = { address: '/vfs/feeds/feed_12/data', modelKind: 'feed.node', groupId: 'g1', paneId: 'dag-1' };
      const echoed = message_next(writer);
      const relayed = message_next(sibling);
      send(writer, { type: 'regard', regard });
      expect(await echoed).toEqual({ type: 'regard', regard });
      expect(await relayed).toEqual({ type: 'regard', regard });
      expect(noted).toEqual([regard]);
      // A late attacher receives the retained cell with its ack, before any
      // new indication.
      const late = await client_open(port);
      const collected = messages_collect(late, 2); // attached + retained regard
      send(late, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN });
      const messages = await collected;
      expect(messages[0].type).toBe('attached');
      expect(messages[1]).toEqual({ type: 'regard', regard });
      writer.terminate();
      sibling.terminate();
      late.terminate();
    } finally {
      await daemon.stop();
    }
  });

  it('serves a retained regard from the engine when the daemon itself holds none', async () => {
    const engine = stubEngine_create();
    const engineRegard = { address: '/home/user/report.txt', groupId: 'g2', paneId: 'files-1' };
    (engine as { regard_get?: () => unknown }).regard_get = () => engineRegard;
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    const port = await daemon.start();
    try {
      const ws = await client_open(port);
      const collected = messages_collect(ws, 2);
      send(ws, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN });
      const messages = await collected;
      expect(messages[1]).toEqual({ type: 'regard', regard: engineRegard });
      ws.terminate();
    } finally {
      await daemon.stop();
    }
  });


describe('CalypsoDaemon host control', () => {
  it('declares its tiers in the attach ack', async () => {
    const own: CalypsoDaemon = new CalypsoDaemon({ engine: stubEngine_create(), token: TOKEN, hostControl: ['shell', 'files'] });
    const ownPort: number = await own.start();
    try {
      const ws = await client_open(ownPort);
      const acked = message_next(ws);
      send(ws, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN, capabilities: { hiddenInput: true, shellCommands: false } });
      const ack = await acked;
      expect(ack.type).toBe('attached');
      expect(ack.hostControl).toEqual(['shell', 'files']);
      ws.terminate();
    } finally {
      await own.stop();
    }
  });
});
});

describe('CalypsoDaemon typed asks', () => {
  /** A daemon whose engine asks one question while running a command. */
  function asking_daemon(request: Record<string, unknown>): {
    daemon: CalypsoDaemon;
    asked: () => Promise<string>;
  } {
    let ask: ((answer: string) => void) | null = null;
    const answered: Promise<string> = new Promise((resolve) => { ask = resolve; });
    const engine: HostedEngine = {
      line_execute: async (): Promise<CommandEnvelope[]> => {
        const answer: string = await daemon.prompt_current(request as never)
          .catch((error: Error): string => `refused: ${error.message}`);
        (ask as (a: string) => void)(answer);
        return [{ status: 'ok', rendered: '' }];
      },
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    return { daemon, asked: (): Promise<string> => answered };
  }

  it('relays what the question wants, so a surface can choose its instrument', async () => {
    const { daemon, asked } = asking_daemon({
      message: 'Where should the table go? ',
      hidden: false,
      wants: 'path',
      path: { anchor: '/home/chris', wantsDirectory: false, suggest: 'pacs.csv' },
      commit: 'EXPORT HERE',
    });
    const port = await daemon.start();
    try {
      const ws = await client_open(port);
      const got: Record<string, unknown>[] = [];
      ws.on('message', (d) => got.push(JSON.parse(d.toString())));
      send(ws, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN });
      await until(() => got.some((m) => m.type === 'attached'));

      send(ws, { type: 'execute', id: '1', line: 'pacs query --csv-to' });
      await until(() => got.some((m) => m.type === 'prompt'));
      const prompt = got.find((m) => m.type === 'prompt') as Record<string, unknown>;
      expect(prompt.wants).toBe('path');
      expect(prompt.commit).toBe('EXPORT HERE');
      expect(prompt.path).toEqual({ anchor: '/home/chris', wantsDirectory: false, suggest: 'pacs.csv' });

      send(ws, { type: 'promptAnswer', promptId: prompt.promptId, answer: '/home/chris/x.csv' });
      expect(await asked()).toBe('/home/chris/x.csv');
    } finally {
      await daemon.stop();
    }
  });

  // A pane's silent refresh must never interrupt the operator with a
  // question they never invited: they did not issue the command that
  // raised it and cannot be expected to answer for it.
  it('refuses an ask raised by an instrument command', async () => {
    const { daemon, asked } = asking_daemon({ message: 'Administrator password: ', hidden: false });
    const port = await daemon.start();
    try {
      const ws = await client_open(port);
      const got: Record<string, unknown>[] = [];
      ws.on('message', (d) => got.push(JSON.parse(d.toString())));
      send(ws, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN });
      await until(() => got.some((m) => m.type === 'attached'));

      send(ws, { type: 'execute', id: '1', line: 'pacs list', instrument: true });
      const answer: string = await asked();
      expect(answer).toContain('refused');
      expect(answer).toContain('instrument');
      // The operator was never shown anything.
      expect(got.some((m) => m.type === 'prompt')).toBe(false);
    } finally {
      await daemon.stop();
    }
  });

  it('still refuses a hidden ask a surface cannot collect', async () => {
    const { daemon, asked } = asking_daemon({ message: 'Password: ', hidden: true });
    const port = await daemon.start();
    try {
      const ws = await client_open(port);
      const got: Record<string, unknown>[] = [];
      ws.on('message', (d) => got.push(JSON.parse(d.toString())));
      send(ws, {
        type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN,
        capabilities: { shellCommands: false, hiddenInput: false },
      });
      await until(() => got.some((m) => m.type === 'attached'));

      send(ws, { type: 'execute', id: '1', line: 'sudo plugin add x' });
      expect(await asked()).toContain('cannot securely collect hidden input');
    } finally {
      await daemon.stop();
    }
  });
});

describe('CalypsoDaemon a question does not block the errand', () => {
  // The errand that answers a question browses with instrument reads, and
  // the command that asked is waiting on that answer: queuing them behind
  // it deadlocks — the answer waits on the browsing, the browsing waits on
  // the answer.
  it('runs an instrument command beside a command waiting on a question', async () => {
    let asked: ((answer: string) => void) | null = null;
    const answered: Promise<string> = new Promise((resolve) => { asked = resolve; });
    const ran: string[] = [];
    const engine: HostedEngine = {
      line_execute: async (line: string): Promise<CommandEnvelope[]> => {
        ran.push(line);
        if (line === 'asking') {
          const answer: string = await daemon.prompt_current({ message: 'where? ', hidden: false });
          (asked as (a: string) => void)(answer);
          return [{ status: 'ok', rendered: `got ${answer}` }];
        }
        return [{ status: 'ok', rendered: `listed ${line}` }];
      },
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    const port = await daemon.start();
    try {
      const ws = await client_open(port);
      const got: Record<string, unknown>[] = [];
      ws.on('message', (d) => got.push(JSON.parse(d.toString())));
      send(ws, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN });
      await until(() => got.some((m) => m.type === 'attached'));

      send(ws, { type: 'execute', id: '1', line: 'asking' });
      await until(() => got.some((m) => m.type === 'prompt'));

      // The errand browses while the question stands open.
      send(ws, { type: 'execute', id: '2', line: 'ls ~', instrument: true });
      await until(() => ran.includes('ls ~'));
      const listed = got.find((m) => m.type === 'result' && m.id === '2') as Record<string, unknown>;
      expect(listed).toBeDefined();

      // And the answer still lands on the command that asked for it.
      const prompt = got.find((m) => m.type === 'prompt') as Record<string, unknown>;
      send(ws, { type: 'promptAnswer', promptId: prompt.promptId, answer: '~/x.csv' });
      expect(await answered).toBe('~/x.csv');
      await until(() => got.some((m) => m.type === 'result' && m.id === '1'));
    } finally {
      await daemon.stop();
    }
  });

  // A command that changes state is never instrument traffic, so nothing
  // else may overtake the queue.
  it('runs an ordinary command while another waits on a question, and the asker resumes in its own turn', async () => {
    const ran: string[] = [];
    let releaseSlow: () => void = (): void => undefined;
    const engine: HostedEngine = {
      line_execute: async (line: string): Promise<CommandEnvelope[]> => {
        ran.push(line);
        if (line === 'asking') {
          const answer = await daemon.prompt_current({ message: 'where? ', hidden: false });
          ran.push(`answered ${answer}`);
          daemon.output_current('data', `asker says ${answer}\n`);
          return [{ status: 'ok', rendered: `went ${answer}` }];
        }
        if (line === 'slow') {
          await new Promise<void>((resolve) => { releaseSlow = resolve; });
          ran.push('slow done');
        }
        return [{ status: 'ok', rendered: line }];
      },
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    const port = await daemon.start();
    try {
      const asker = await client_open(port);
      const other = await client_open(port);
      const got: Record<string, unknown>[] = [];
      const gotOther: Record<string, unknown>[] = [];
      asker.on('message', (d) => got.push(JSON.parse(d.toString())));
      other.on('message', (d) => gotOther.push(JSON.parse(d.toString())));
      send(asker, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN });
      send(other, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN });
      await until(() => got.some((m) => m.type === 'attached') && gotOther.some((m) => m.type === 'attached'));

      send(asker, { type: 'execute', id: '1', line: 'asking' });
      await until(() => got.some((m) => m.type === 'prompt'));
      // The question is open: the session is free, and another surface's command runs.
      send(other, { type: 'execute', id: '9', line: 'cd /bin' });
      await until(() => gotOther.some((m) => m.type === 'result' && m.id === '9'));
      expect(ran).toEqual(['asking', 'cd /bin']);

      // A slow command holds the lane when the answer arrives: the asker waits its turn.
      send(other, { type: 'execute', id: '10', line: 'slow' });
      await until(() => ran.includes('slow'));
      const prompt = got.find((m) => m.type === 'prompt') as Record<string, unknown>;
      send(asker, { type: 'promptAnswer', promptId: prompt.promptId, answer: 'home' });
      await new Promise((r) => setTimeout(r, 200));
      expect(ran).toEqual(['asking', 'cd /bin', 'slow']);
      releaseSlow();
      await until(() => got.some((m) => m.type === 'result' && m.id === '1'));
      expect(ran).toEqual(['asking', 'cd /bin', 'slow', 'slow done', 'answered home']);
      // Resumed in its own slot: its output and result went home, under its own id.
      expect(got.some((m) => m.type === 'output' && m.id === '1' && m.chunk === 'asker says home\n')).toBe(true);
      expect(gotOther.some((m) => m.type === 'output' && m.chunk === 'asker says home\n')).toBe(false);
      expect(daemon.busy_get()).toBe(false);
    } finally {
      await daemon.stop();
    }
  });

  it('an editor open is a person waiting too: the session is free meanwhile', async () => {
    const ran: string[] = [];
    const engine: HostedEngine = {
      line_execute: async (line: string): Promise<CommandEnvelope[]> => {
        ran.push(line);
        if (line === 'editing') await daemon.edit_current('text', 'txt').catch(() => undefined);
        return [{ status: 'ok', rendered: line }];
      },
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    const port = await daemon.start();
    try {
      const ws = await client_open(port);
      const got: Record<string, unknown>[] = [];
      ws.on('message', (d) => got.push(JSON.parse(d.toString())));
      send(ws, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN });
      await until(() => got.some((m) => m.type === 'attached'));
      send(ws, { type: 'execute', id: '1', line: 'editing' });
      await until(() => got.some((m) => m.type === 'edit'));
      send(ws, { type: 'execute', id: '2', line: 'pwd' });
      await until(() => got.some((m) => m.type === 'result' && m.id === '2'));
      const edit = got.find((m) => m.type === 'edit') as Record<string, unknown>;
      send(ws, { type: 'editError', editId: edit.editId, reason: 'closed' });
      await until(() => got.some((m) => m.type === 'result' && m.id === '1'));
      expect(ran).toEqual(['editing', 'pwd']);
    } finally {
      await daemon.stop();
    }
  });
});

describe('an open question shows across the session', () => {
  it('rides the heartbeat, counts in every prompt context, names itself in the surface list, and clears when answered', async () => {
    const engine: HostedEngine = {
      line_execute: async (line: string): Promise<CommandEnvelope[]> => {
        if (line === 'asking') await daemon.prompt_current({ message: 'Another game: ', hidden: false });
        return [{ status: 'ok', rendered: '' }];
      },
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    };
    const promptContext = () => ({ user: 'u', uri: 'http://cube', cwd: '/home/u', pacsserver: null, physicalMode: false, lastExitCode: 0, lastCommandDurationMs: 0 });
    const daemon = new CalypsoDaemon({
      engine, token: TOKEN, promptProvider: promptContext,
      telemetryProvider: (): { jobs: number; feeds: number } => ({ jobs: 1, feeds: 1 }),
    });
    const port = await daemon.start();
    try {
      const asker = await client_open(port);
      const other = await client_open(port);
      const got: Record<string, unknown>[] = [];
      const seen: Record<string, unknown>[] = [];
      asker.on('message', (d) => got.push(JSON.parse(d.toString())));
      other.on('message', (d) => seen.push(JSON.parse(d.toString())));
      send(asker, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN });
      send(other, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN });
      await until(() => got.some((m) => m.type === 'attached') && seen.some((m) => m.type === 'attached'));

      send(asker, { type: 'execute', id: '1', line: 'asking' });
      await until(() => got.some((m) => m.type === 'prompt'));
      // The other surface's prompt context counts it at once.
      await until(() => seen.some((m) => m.type === 'promptline' && (m.context as { questions?: number }).questions === 1));
      // The surface list says who asks what.
      const listed = daemon.surfaces_list();
      expect(listed.filter((s) => s.asking === 'Another game: ')).toHaveLength(1);
      // The heartbeat carries it.
      await until(() => seen.some((m) => m.type === 'telemetry' && ((m.lane as { questions?: unknown[] }).questions ?? []).length === 1));
      const beat = [...seen].reverse().find((m) => m.type === 'telemetry') as { lane: { questions: Array<{ message: string; surface: string }> } };
      expect(beat.lane.questions[0]?.message).toBe('Another game: ');

      const prompt = got.find((m) => m.type === 'prompt') as Record<string, unknown>;
      send(asker, { type: 'promptAnswer', promptId: prompt.promptId, answer: 'n' });
      await until(() => got.some((m) => m.type === 'result' && m.id === '1'));
      await until(() => {
        const last = [...seen].reverse().find((m) => m.type === 'promptline') as { context: { questions?: number } } | undefined;
        return last !== undefined && last.context.questions === undefined;
      });
      expect(daemon.surfaces_list().some((s) => s.asking !== undefined)).toBe(false);
    } finally {
      await daemon.stop();
    }
  }, 15_000);
});

