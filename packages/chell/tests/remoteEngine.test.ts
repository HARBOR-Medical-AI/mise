import { readFileSync } from 'node:fs';
import { EventEmitter } from 'events';
import chalk from 'chalk';
import { jest } from '@jest/globals';
import type { CommandEnvelope } from '@fnndsc/cumin';
import type { OutputSink } from '@fnndsc/brasa';
import type { ProgressEvent } from '@fnndsc/brasa';

type Scenario = (ws: FakeWebSocket, sent: Record<string, unknown>) => void;

let scenario: Scenario | undefined;
let attachResponse: Record<string, unknown> = {
  type: 'attached',
  session: 'test-session',
  protocolVersion: 1,
};

class FakeWebSocket extends EventEmitter {
  public static instances: FakeWebSocket[] = [];
  public sent: Record<string, unknown>[] = [];

  constructor(public readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
    process.nextTick(() => this.emit('open'));
  }

  public send(payload: string): void {
    const sent = JSON.parse(payload) as Record<string, unknown>;
    this.sent.push(sent);
    if (sent.type === 'attach') {
      process.nextTick(() => {
        this.emit('message', Buffer.from(JSON.stringify(attachResponse)));
      });
      return;
    }
    if (sent.type !== 'execute' && sent.type !== 'complete' && sent.type !== 'cancel') {
      return;
    }
    scenario?.(this, sent);
  }

  public close(): void {
    this.emit('close');
  }
}

jest.unstable_mockModule('ws', () => ({ WebSocket: FakeWebSocket }));
jest.unstable_mockModule('@fnndsc/calypso', () => ({
  CONTRACT_VERSION: 1,
  serverMessage_parse: (value: unknown) => {
    // Mirror the real parser's one behavior under test: a message whose
    // type the union does not know fails validation.
    const record = value as { type?: unknown; __malformed?: unknown } | null;
    if (record?.__malformed === true || record?.type === 'from-the-future') {
      return { ok: false, error: 'type: Invalid discriminator value' };
    }
    return { ok: true, value };
  },
  // Minimal real-shaped broker: the engine under test depends on genuine
  // correlation behavior (open/settle/fail), not just the class existing.
  RequestBroker: class {
    private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    constructor(private prefix: string, private reason: string) {}
    openWithId(id: string, _origin: unknown, send: (id: string) => void): Promise<unknown> {
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        send(id);
      });
    }
    settle(_socket: unknown, id: string, reply: unknown): void {
      const p = this.pending.get(id);
      if (p) { this.pending.delete(id); p.resolve(reply); }
    }
    fail(_socket: unknown, id: string, reason: string): void {
      const p = this.pending.get(id);
      if (p) { this.pending.delete(id); p.reject(new Error(reason)); }
    }
  },
}));

// Isolate this surface unit from the engine barrel: provide just the sink
// boundary remoteEngine and this test share (installed sink, delivery).
let activeSink: OutputSink;
let installedSurface: unknown = null;
// What a line asks to have delivered. The engine's reader cannot be loaded
// here (it brings the engine with it), so the intents come from the table
// brasa's own test holds that reader to (delivery-intent.test.ts): a line
// not in the table fails the test that used it. The match is brasa's own.
const DELIVERY_LINES: ReadonlyArray<{ line: string; intents: Array<{ verb: string; destination: string | null }> }> =
  (JSON.parse(readFileSync(new URL('../../brasa/tests/fixtures/deliveryLines.json', import.meta.url), 'utf8')) as { lines: Array<{ line: string; intents: Array<{ verb: string; destination: string | null }> }> }).lines;
const { deliveryIntent_matches, deliverySource_matches } = await import('../../brasa/dist/builtins/fs/deliveryMatch.js');
// What a line asks to have run here: the same, from the table brasa's host-grants test holds its reader to. A line
// that looks like one (a `!`, a pipe, an `edit` or `command` head) but is not in the table fails the test that used it.
interface HostLine { line: string; shells: string[]; pipes: string[]; edits: string[] }
const HOST_LINES: ReadonlyArray<HostLine> = (JSON.parse(readFileSync(new URL('../../brasa/tests/fixtures/hostLines.json', import.meta.url), 'utf8')) as { lines: HostLine[] }).lines;
jest.unstable_mockModule('@fnndsc/brasa', () => ({
  deliveryIntents_read: (line: string, backend: string | undefined): Array<{ verb: string; destination: string | null }> => {
    // The table is the ChRIS reader's. Any other backend has no delivering command (held in brasa's test too).
    if (backend !== 'chris') return [];
    const row = DELIVERY_LINES.find((one) => one.line === line);
    // Lines that are not about delivery at all (the rest of this file) ask for nothing.
    if (row === undefined && /download/.test(line)) throw new Error(`not in the shared table: ${line}`);
    return row?.intents ?? [];
  },
  deliveryIntent_matches,
  deliverySource_matches,
  lineHostOperations_read: async (line: string): Promise<{ shells: string[]; pipes: string[]; edits: string[] }> => {
    const row: HostLine | undefined = HOST_LINES.find((one: HostLine): boolean => one.line === line);
    if (row === undefined && /^\s*(!|edit |command )|\|/.test(line)) throw new Error(`not in the shared table: ${line}`);
    return { shells: row?.shells ?? [], pipes: row?.pipes ?? [], edits: row?.edits ?? [] };
  },
  sink_set: (sink: OutputSink): OutputSink => { const prev: OutputSink = activeSink; activeSink = sink; return prev; },
  sink_get: (): OutputSink => activeSink,
  surface_set: (surface: unknown): unknown => { installedSurface = surface; return surface; },
  // Imported transitively via prompt/session (promptFromContext_render); the
  // remote client renders a pushed context, it never builds one.
  sessionPromptContext_build: jest.fn(),
  // Imported transitively via config/settings (store- and index-config persistence hooks).
  storeUrl_set: jest.fn(),
  storeUrlOverride_get: jest.fn(),
  storeConfigPersist_install: jest.fn(),
  pluginIndex_set: jest.fn(),
  pluginIndexOverride_get: jest.fn(),
  indexConfigPersist_install: jest.fn(),
  envelope_deliver: (envelope: CommandEnvelope): void => {
    if (envelope.rendered.length > 0) activeSink.data_write(envelope.rendered);
    if (envelope.renderedErr !== undefined && envelope.renderedErr.length > 0) activeSink.err_write(envelope.renderedErr);
  },
  StdoutSink: class {
    public data_write(): void { /* discard */ }
    public err_write(): void { /* discard */ }
    public status_write(): void { /* discard */ }
    public progress_write(): void { /* discard */ }
  },
}));

const { RemoteEngine } = await import('../src/remote/remoteEngine.js');
const { sink_set, StdoutSink } = await import('@fnndsc/brasa');

describe('RemoteEngine live output', () => {
  let remote: InstanceType<typeof RemoteEngine> | undefined;
  let data: string[];
  let err: string[];
  let status: string[];

  beforeEach(() => {
    scenario = undefined;
    attachResponse = {
      type: 'attached',
      session: 'test-session',
      protocolVersion: 1,
    };
    FakeWebSocket.instances.length = 0;
    data = [];
    err = [];
    status = [];
    const sink: OutputSink = {
      data_write: (chunk: string | Buffer): void => { data.push(chunk.toString()); },
      err_write: (chunk: string | Buffer): void => { err.push(chunk.toString()); },
      status_write: (text: string): void => { status.push(text); },
      progress_write: (_event: ProgressEvent): void => { /* not used */ },
    };
    sink_set(sink);
  });

  afterEach(() => {
    remote?.close();
    sink_set(new StdoutSink());
  });

  it('carries the daemon\'s word on its own code: stale at attach, and the push that flips it', async () => {
    attachResponse = { type: 'attached', session: 'test-session', protocolVersion: 1, stale: true };
    const flips: boolean[] = [];
    remote = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token', onStale: (stale: boolean): void => { flips.push(stale); } });
    expect(remote.daemonStale).toBe(true);
    FakeWebSocket.instances[0].emit('message', Buffer.from(JSON.stringify({ type: 'stale', stale: false })));
    expect(remote.daemonStale).toBe(false);
    FakeWebSocket.instances[0].emit('message', Buffer.from(JSON.stringify({ type: 'stale', stale: true })));
    expect(flips).toEqual([false, true]);
  });

  it('carries the backend the attach answer names, and none from a daemon that names none', async () => {
    attachResponse = { type: 'attached', session: 'test-session', protocolVersion: 1, backend: 'stratus' };
    remote = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token' });
    expect(remote.backend_get()).toBe('stratus');
    remote.close();
    attachResponse = { type: 'attached', session: 'test-session', protocolVersion: 1 };
    remote = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token' });
    expect(remote.backend_get()).toBeUndefined();
  });

  it('installs a sink and a surface into this process through the engine\'s seam', async () => {
    remote = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token' });
    const sink: OutputSink = { data_write: jest.fn(), err_write: jest.fn(), status_write: jest.fn(), progress_write: jest.fn() } as unknown as OutputSink;
    remote.sink_install(sink);
    expect(activeSink).toBe(sink);
    const surface: unknown = { capabilities: {} };
    remote.surface_install(surface as never);
    expect(installedSurface).toBe(surface);
  });

  it('renders streamed stdout once and suppresses duplicate final data envelope text', async () => {
    scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
      const id = String(sent.id);
      process.nextTick(() => {
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'output', id, channel: 'data', chunk: 'live data' })));
        ws.emit('message', Buffer.from(JSON.stringify({
          type: 'result',
          id,
          envelopes: [{ status: 'ok', rendered: 'live data' }],
        })));
      });
    };

    remote = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token' });
    expect(FakeWebSocket.instances[0].sent[0]).toEqual(expect.objectContaining({
      type: 'attach',
      capabilities: { shellCommands: false, hiddenInput: false, fileDelivery: false, color: chalk.level > 0, localFilesystem: false },
    }));
    const envelopes: CommandEnvelope[] = await remote.line_execute('echo live');

    expect(envelopes).toEqual([{ status: 'ok', rendered: 'live data' }]);
    expect(data).toEqual(['live data']);
    expect(err).toEqual([]);
  });

  it('routes a line\'s live output and progress to the sink it was sent from, not the one active when it arrives', async () => {
    const sentFrom: string[] = [];
    const later: string[] = [];
    const sentSink: OutputSink = {
      data_write: (chunk: string | Buffer): void => { sentFrom.push(`data:${chunk.toString()}`); },
      err_write: (chunk: string | Buffer): void => { sentFrom.push(`err:${chunk.toString()}`); },
      status_write: (): void => undefined,
      progress_write: (): void => { sentFrom.push('progress'); },
    };
    const laterSink: OutputSink = {
      data_write: (chunk: string | Buffer): void => { later.push(chunk.toString()); },
      err_write: (chunk: string | Buffer): void => { later.push(chunk.toString()); },
      status_write: (): void => undefined,
      progress_write: (): void => { later.push('progress'); },
    };
    scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
      if (sent.type !== 'execute') return;
      const id = String(sent.id);
      process.nextTick(() => {
        // Another surface's work installed its own sink meanwhile.
        activeSink = laterSink;
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'output', id, channel: 'err', chunk: 'chell: command not found: motd\n' })));
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'progress', id, phase: 'start', label: 'x' })));
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'result', id, envelopes: [{ status: 'error', rendered: '', renderedErr: 'chell: command not found: motd\n' }] })));
      });
    };
    remote = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token' });
    activeSink = sentSink;
    await remote.line_execute('motd chell');
    expect(sentFrom).toEqual(['err:chell: command not found: motd\n', 'progress']);
    expect(later.filter((line) => line.includes('motd'))).toEqual([]);
  });

  it('sends an origin-correlated cancel for its active execute request', async () => {
    let resolveResult: (() => void) | undefined;
    scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
      if (sent.type !== 'execute') return;
      const id = String(sent.id);
      resolveResult = (): void => {
        ws.emit('message', Buffer.from(JSON.stringify({
          type: 'result', id, envelopes: [{ status: 'error', rendered: '', renderedErr: 'du: cancelled\n' }],
        })));
      };
    };

    remote = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token' });
    const running: Promise<CommandEnvelope[]> = remote.line_execute('du --human-readable test-upload');
    await new Promise<void>((resolve: () => void): void => process.nextTick(resolve));

    expect(remote.line_cancel()).toBe(true);
    expect(FakeWebSocket.instances[0].sent).toContainEqual({ type: 'cancel', id: '0' });
    resolveResult?.();
    await running;
    expect(remote.line_cancel()).toBe(false);
  });

  it('keeps the exit status a result names until it is taken, and says it from the envelopes when the daemon names none', async () => {
    const statuses: Array<number | undefined> = [1, undefined, undefined];
    const answers = [[{ status: 'ok', rendered: 'nothing closed\n' }], [{ status: 'error', rendered: '' }], [{ status: 'ok', rendered: '' }]];
    let call: number = 0;
    scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
      if (sent.type !== 'execute') return;
      const id = String(sent.id);
      const at: number = call++;
      const exitCode: number | undefined = statuses[at];
      process.nextTick(() => {
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'result', id, envelopes: answers[at], ...(exitCode !== undefined ? { exitCode } : {}) })));
      });
    };
    remote = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token' });
    await remote.line_execute('berth close');
    expect(remote.exitCode_take()).toBe(1);
    // Taken: it is forgotten.
    expect(remote.exitCode_take()).toBe(0);
    // An older daemon names no status: an error envelope is 1, all ok is 0.
    await remote.line_execute('cd nowhere');
    expect(remote.exitCode_take()).toBe(1);
    await remote.line_execute('pwd');
    expect(remote.exitCode_take()).toBe(0);
  });

  it('runs a daemon-requested shell command on the attached surface', async () => {
    const shell = jest.fn(async (_command: string): Promise<number> => 0);
    scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
      if (sent.type !== 'execute') return;
      const id = String(sent.id);
      process.nextTick(() => {
        ws.emit('message', Buffer.from(JSON.stringify({
          type: 'shell', shellId: 'h1', command: 'printf local', lineId: id,
        })));
        ws.emit('message', Buffer.from(JSON.stringify({
          type: 'result', id, envelopes: [{ status: 'ok', rendered: '' }],
        })));
      });
    };

    remote = await RemoteEngine.connect({
      url: 'ws://127.0.0.1:1',
      token: 'token',
      onShell: shell,
    });
    expect(FakeWebSocket.instances[0].sent[0]).toEqual(expect.objectContaining({
      type: 'attach',
      capabilities: { shellCommands: true, hiddenInput: false, fileDelivery: false, color: chalk.level > 0, localFilesystem: false },
    }));
    await remote.line_execute('!printf local');

    expect(shell).toHaveBeenCalledWith('printf local');
    expect(FakeWebSocket.instances[0].sent).toContainEqual({
      type: 'shellResult', shellId: 'h1', exitCode: 0,
    });
  });

  it('a chell in a terminal declares it on attach, and a ! on the daemon\'s pty draws here', async () => {
    const input = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, setRawMode(mode: boolean): void { input.isRaw = mode; }, resume(): void { /* flowing */ } });
    const written: string[] = [];
    const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 120, rows: 40, write(chunk: string): boolean { written.push(chunk); return true; } });
    scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
      if (sent.type !== 'execute') return;
      const id = String(sent.id);
      process.nextTick(() => {
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'hostPtyStart', ptyId: 'p1' })));
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'hostPtyData', ptyId: 'p1', data: '/dev/pts/7\r\n' })));
        input.emit('data', Buffer.from('hello\r'));
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'hostPtyExit', ptyId: 'p1', code: 0 })));
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'result', id, envelopes: [{ status: 'ok', rendered: '' }], exitCode: 0 })));
      });
    };
    remote = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token', onShell: async (): Promise<number> => 0, terminal: { input, output, term: 'xterm-kitty' } });
    const ws = FakeWebSocket.instances[0];
    expect((ws.sent[0]?.capabilities as Record<string, unknown>)['tty']).toEqual({ term: 'xterm-kitty', cols: 120, rows: 40 });
    await remote.line_execute('!tty; read x');
    expect(written).toEqual(['/dev/pts/7\r\n']);
    expect(ws.sent).toContainEqual({ type: 'hostPtyResize', ptyId: 'p1', cols: 120, rows: 40 });
    expect(ws.sent).toContainEqual({ type: 'hostPtyInput', ptyId: 'p1', data: 'hello\r' });
    expect(input.isRaw).toBe(false);
    expect(remote.exitCode_take()).toBe(0);
  });

  it('a chell on pipes declares no terminal and ignores a host pty', async () => {
    const input = Object.assign(new EventEmitter(), { isTTY: false, setRawMode(): void { throw new Error('not a terminal'); }, resume(): void { /* flowing */ } });
    const output = Object.assign(new EventEmitter(), { isTTY: false, write(): boolean { throw new Error('not drawn'); } });
    remote = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token', terminal: { input, output, term: 'dumb' } });
    const ws = FakeWebSocket.instances[0];
    expect((ws.sent[0]?.capabilities as Record<string, unknown>)['tty']).toBeUndefined();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'hostPtyStart', ptyId: 'p1' })));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'hostPtyData', ptyId: 'p1', data: 'x' })));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'hostPtyExit', ptyId: 'p1', code: 0 })));
    expect(ws.sent).toHaveLength(1);
  });

  it('reports promptError, pipeError, and editError when it has no handlers', async () => {
    // A surface without handlers must report inability rather than fabricate
    // an empty answer, a pass-through pipe, or an unchanged "successful" edit.
    scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
      if (sent.type !== 'execute') return;
      const id = String(sent.id);
      process.nextTick(() => {
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'prompt', promptId: 'p1', message: 'Password:', hidden: true })));
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'pipe', pipeId: 'x1', command: 'tr a b', input: Buffer.from('in').toString('base64'), lineId: id })));
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'edit', editId: 'e1', content: 'text', extension: 'md' })));
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'result', id, envelopes: [{ status: 'ok', rendered: '' }] })));
      });
    };

    remote = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token' });
    await remote.line_execute('cat x | tr a b');
    // The error replies are sent on the next ticks after the requests land.
    await new Promise((r) => setTimeout(r, 0));

    const sentTypes = FakeWebSocket.instances[0].sent;
    expect(sentTypes).toContainEqual(expect.objectContaining({ type: 'promptError', promptId: 'p1' }));
    // The line asked for the segment, so the refusal is the surface's own inability, not a missing grant.
    expect(sentTypes).toContainEqual(expect.objectContaining({ type: 'pipeError', pipeId: 'x1', reason: 'this surface cannot run pipeline segments' }));
    expect(sentTypes).toContainEqual(expect.objectContaining({ type: 'editError', editId: 'e1' }));
  });

  it('reports a promptError when the prompt handler itself fails', async () => {
    scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
      if (sent.type !== 'execute') return;
      const id = String(sent.id);
      process.nextTick(() => {
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'prompt', promptId: 'p2', message: 'Name:', hidden: false })));
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'result', id, envelopes: [{ status: 'ok', rendered: '' }] })));
      });
    };

    remote = await RemoteEngine.connect({
      url: 'ws://127.0.0.1:1',
      token: 'token',
      onPrompt: async () => { throw new Error('tty gone'); },
    });
    await remote.line_execute('anything');
    await new Promise((r) => setTimeout(r, 0));

    expect(FakeWebSocket.instances[0].sent).toContainEqual({ type: 'promptError', promptId: 'p2', reason: 'tty gone' });
  });

  it('does not suppress final envelope text for status-only output', async () => {
    scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
      const id = String(sent.id);
      process.nextTick(() => {
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'output', id, channel: 'status', chunk: 'working...' })));
        ws.emit('message', Buffer.from(JSON.stringify({
          type: 'result',
          id,
          envelopes: [{ status: 'ok', rendered: 'final data' }],
        })));
      });
    };

    remote = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token' });
    await remote.line_execute('status');

    expect(status).toEqual(['working...']);
    expect(data).toEqual(['final data']);
  });

  it('suppresses only the live channel and still delivers non-streamed final stderr', async () => {
    scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
      const id = String(sent.id);
      process.nextTick(() => {
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'output', id, channel: 'data', chunk: 'live data' })));
        ws.emit('message', Buffer.from(JSON.stringify({
          type: 'result',
          id,
          envelopes: [{ status: 'error', rendered: 'live data', renderedErr: 'final err' }],
        })));
      });
    };

    remote = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token' });
    await remote.line_execute('mixed');

    expect(data).toEqual(['live data']);
    expect(err).toEqual(['final err']);
  });

  it('resolves remote completions', async () => {
    scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
      const id = String(sent.id);
      process.nextTick(() => {
        ws.emit('message', Buffer.from(JSON.stringify({
          type: 'complete',
          id,
          prefix: sent.prefix,
          candidates: ['ls', 'logout'],
        })));
      });
    };

    remote = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token' });

    await expect(remote.line_complete('l')).resolves.toEqual({ prefix: 'l', candidates: ['ls', 'logout'] });
  });

  it('rejects correlated command errors', async () => {
    scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
      const id = String(sent.id);
      process.nextTick(() => {
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'error', id, reason: 'boom' })));
      });
    };

    remote = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token' });

    await expect(remote.line_execute('bad')).rejects.toThrow('boom');
  });

  it('routes session broadcasts and prompt answers', async () => {
    const sessions: CommandEnvelope[] = [];
    scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
      const id = String(sent.id);
      process.nextTick(() => {
        ws.emit('message', Buffer.from(JSON.stringify({
          type: 'session',
          surface: 'other',
          envelope: { status: 'ok', rendered: 'other output' },
        })));
        ws.emit('message', Buffer.from(JSON.stringify({
          type: 'prompt',
          promptId: 'p1',
          message: 'Password:',
          hidden: true,
        })));
        ws.emit('message', Buffer.from(JSON.stringify({
          type: 'result',
          id,
          envelopes: [{ status: 'ok', rendered: '' }],
        })));
      });
    };

    remote = await RemoteEngine.connect({
      url: 'ws://127.0.0.1:1',
      token: 'token',
      onSession: (_surface, envelope) => { sessions.push(envelope); },
      onPrompt: async () => 'secret',
    });
    await remote.line_execute('prompt');

    expect(sessions).toEqual([{ status: 'ok', rendered: 'other output' }]);
    expect(FakeWebSocket.instances[0].sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'promptAnswer', promptId: 'p1', answer: 'secret' }),
    ]));
  });

  it('answers pipe, edit, and close callbacks', async () => {
    let closed = false;
    scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
      if (sent.type !== 'execute') return;
      const id = String(sent.id);
      process.nextTick(() => {
        if (sent.line === 'cat x | tr a b') {
          ws.emit('message', Buffer.from(JSON.stringify({ type: 'pipe', pipeId: 'pipe1', command: 'tr a b', input: Buffer.from('abc').toString('base64'), lineId: id })));
        } else if (sent.line === 'edit notes.txt') {
          ws.emit('message', Buffer.from(JSON.stringify({ type: 'edit', editId: 'edit1', content: 'before', extension: '.txt', path: '/home/chris/notes.txt', lineId: id })));
        } else {
          ws.emit('message', Buffer.from(JSON.stringify({
            type: 'deliver',
            deliverId: 'deliver1',
            id,
            path: '/home/me/scan.dcm',
            filename: 'scan.dcm',
            destination: '/tmp',
          })));
        }
        // After the request's reply, so the line is still in flight when it lands.
        setTimeout(() => { ws.emit('message', Buffer.from(JSON.stringify({ type: 'result', id, envelopes: [{ status: 'ok', rendered: '' }] }))); }, 5);
      });
    };

    attachResponse = { ...attachResponse, backend: 'chris' };
    remote = await RemoteEngine.connect({
      url: 'ws://127.0.0.1:1',
      token: 'token',
      onPipe: async (_command, input) => Buffer.from(input.toString().toUpperCase()),
      onEdit: async (content) => ({ content: `${content} after`, changed: true }),
      onDeliver: async (request) => ({ location: `/tmp/${request.filename}`, bytes: 2048 }),
      onClose: () => { closed = true; },
    });
    await remote.line_execute('cat x | tr a b');
    await remote.line_execute('edit notes.txt');
    await remote.line_execute('download /home/me/scan.dcm /tmp');
    remote.close();

    expect(FakeWebSocket.instances[0].sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'pipeResult', pipeId: 'pipe1', output: Buffer.from('ABC').toString('base64') }),
      expect.objectContaining({ type: 'editResult', editId: 'edit1', content: 'before after', changed: true }),
      expect.objectContaining({ type: 'deliverResult', deliverId: 'deliver1', location: '/tmp/scan.dcm', bytes: 2048 }),
    ]));
    expect(closed).toBe(true);
  });

  describe('a delivery is bound to the download that asked for it', () => {
    // A ChRIS session, which is the one that has `download`.
    beforeEach(() => { attachResponse = { ...attachResponse, backend: 'chris' }; });

    it('the same line asks for a file in a ChRIS session and for none in a stratus one, which has no download', async () => {
      const line: string = 'ls /x | download /a ./later';
      expect((await delivery_during(line, './later')).delivered).toEqual(['./later']);
      attachResponse = { ...attachResponse, backend: 'stratus' };
      const stratus = await delivery_during(line, './later');
      expect(stratus.delivered).toEqual([]);
      expect(refusal_of(stratus.sent)).toContain('asks for no file');
      const plain = await delivery_during('download /home/me/scan.dcm ./scans', './scans');
      expect(plain.delivered).toEqual([]);
      delete attachResponse['backend'];
      expect((await delivery_during('download /home/me/scan.dcm ./scans', './scans')).delivered).toEqual([]);
    });

    /** The refusal the client sent for a delivery, if it sent one. */
    function refusal_of(sent: Array<Record<string, unknown>>, deliverId: string = 'd1'): string | undefined {
      const error: Record<string, unknown> | undefined = sent.find((one: Record<string, unknown>): boolean => one['type'] === 'deliverError' && one['deliverId'] === deliverId);
      return error === undefined ? undefined : String(error['reason']);
    }

    /** Sends the client one delivery request, as the daemon would. */
    function deliver_emit(ws: FakeWebSocket, deliverId: string, executeId: string | undefined, destination: string | undefined, path: string = '/home/me/scan.dcm'): void {
      ws.emit('message', Buffer.from(JSON.stringify({
        type: 'deliver', deliverId, path, filename: path.split('/').pop(),
        ...(executeId !== undefined ? { id: executeId } : {}),
        ...(destination !== undefined ? { destination } : {}),
      })));
    }

    /** Ends a line the client sent, as the daemon would. */
    function result_emit(ws: FakeWebSocket, id: string): void {
      ws.emit('message', Buffer.from(JSON.stringify({ type: 'result', id, envelopes: [{ status: 'ok', rendered: '' }] })));
    }

    /** Runs one line during which the daemon asks for one delivery for that line; answers what the client sent back. */
    async function delivery_during(line: string, destination: string | undefined, how: { afterResult?: boolean; unnamed?: boolean; path?: string } = {}): Promise<{ sent: Array<Record<string, unknown>>; delivered: string[] }> {
      const delivered: string[] = [];
      // The file a download of the line would send: the first source it names (a line of /a sends /a).
      const path: string = how.path ?? (/download(?:\s+-\S+(?:\s+\d+)?)*\s+(\/\S+)/.exec(line)?.[1] ?? '/home/me/scan.dcm');
      let lineId: string = '';
      scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
        lineId = String(sent.id);
        process.nextTick(() => {
          if (how.afterResult !== true) deliver_emit(ws, 'd1', how.unnamed === true ? undefined : lineId, destination, path);
          result_emit(ws, lineId);
        });
      };
      remote = await RemoteEngine.connect({
        url: 'ws://127.0.0.1:1',
        token: 'token',
        onDeliver: async (request) => { delivered.push(request.destination ?? '(none)'); return { location: `/written/${request.filename}`, bytes: 1 }; },
      });
      await remote.line_execute(line);
      if (how.afterResult === true) deliver_emit((FakeWebSocket.instances[FakeWebSocket.instances.length - 1] as FakeWebSocket), 'd1', lineId, destination, path);
      await new Promise((resolve) => setTimeout(resolve, 10));
      remote.close();
      return { sent: (FakeWebSocket.instances[FakeWebSocket.instances.length - 1] as FakeWebSocket).sent as Array<Record<string, unknown>>, delivered };
    }

    it('the destination the line named, quoted, is written to', async () => {
      const { sent, delivered } = await delivery_during('download -f /home/me/scan.dcm "./my scans"', './my scans');
      expect(delivered).toEqual(['./my scans']);
      expect(sent).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'deliverResult', deliverId: 'd1' })]));
    });

    it('a file no source of the line names is refused, though the destination is right', async () => {
      const { sent, delivered } = await delivery_during('download /home/me/scan.dcm ./scans', './scans', { path: '/home/me/.ssh/id_ed25519' });
      expect(delivered).toEqual([]);
      expect(refusal_of(sent)).toContain('"/home/me/.ssh/id_ed25519", which no source the line sent from here names');
    });

    it('two files of one folder download are written; a repeat of one, or a file outside the folder, is refused', async () => {
      const delivered: string[] = [];
      scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
        const id = String(sent.id);
        process.nextTick(() => {
          const one = (deliverId: string, path: string, filename: string): void => {
            ws.emit('message', Buffer.from(JSON.stringify({ type: 'deliver', deliverId, id, path, filename, destination: './out' })));
          };
          one('f1', '/home/me/scans/a/1.dcm', 'a/1.dcm');
          one('f2', '/home/me/scans/b.dcm', 'b.dcm');
          one('f3', '/home/me/scans/a/1.dcm', 'a/1.dcm');
          one('f4', '/home/me/other/c.dcm', 'c.dcm');
          one('f5', '/home/me/scans/../x', '../x');
          setTimeout(() => { result_emit(ws, id); }, 10);
        });
      };
      remote = await RemoteEngine.connect({
        url: 'ws://127.0.0.1:1',
        token: 'token',
        onDeliver: async (request) => { delivered.push(request.filename); return { location: `/written/${request.filename}`, bytes: 1 }; },
      });
      await remote.line_execute('download /home/me/scans ./out');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const sent = (FakeWebSocket.instances[FakeWebSocket.instances.length - 1] as FakeWebSocket).sent as Array<Record<string, unknown>>;
      expect(delivered).toEqual(['a/1.dcm', 'b.dcm']);
      expect(refusal_of(sent, 'f3')).toContain('a second time for the same line');
      expect(refusal_of(sent, 'f4')).toContain('which no source the line sent from here names');
      expect(refusal_of(sent, 'f5')).toContain('which no source the line sent from here names');
      remote.close();
    });

    it('a daemon that does not say which line is refused, even with one line running, and told to upgrade', async () => {
      const { sent, delivered } = await delivery_during('download /home/me/scan.dcm ./scans', './scans', { unnamed: true });
      expect(delivered).toEqual([]);
      expect(refusal_of(sent)).toBe('refused: the session asked to write "scan.dcm" to "./scans" and did not say which line asked for it, so it cannot be told from a delivery that is late or was never asked for; nothing was written. The session\'s daemon is older than this chell: upgrade the daemon');
    });

    it('a quoted verb later in a pipeline is the host\'s program, and asks for no file', async () => {
      const { sent, delivered } = await delivery_during('ls /x | "download" /a ./later', './later');
      expect(delivered).toEqual([]);
      expect(refusal_of(sent)).toContain('asks for no file');
    });

    it.each([
      ['its result', (ws: FakeWebSocket, id: string): void => { ws.emit('message', Buffer.from(JSON.stringify({ type: 'result', id, envelopes: [{ status: 'ok', rendered: '' }] }))); }],
      ['its error', (ws: FakeWebSocket, id: string): void => { ws.emit('message', Buffer.from(JSON.stringify({ type: 'error', id, reason: 'the line failed' }))); }],
    ])('a delivery read straight after %s, with nothing run in between, is refused', async (_ending: string, end: (ws: FakeWebSocket, id: string) => void) => {
      const delivered: string[] = [];
      scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
        const id: string = String(sent.id);
        process.nextTick(() => {
          // The ending and the delivery arrive back to back, in one turn: nothing awaits between them.
          end(ws, id);
          deliver_emit(ws, 'd1', id, './scans');
        });
      };
      remote = await RemoteEngine.connect({
        url: 'ws://127.0.0.1:1',
        token: 'token',
        onDeliver: async (request) => { delivered.push(request.destination ?? '(none)'); return { location: '/written', bytes: 1 }; },
      });
      await remote.line_execute('download /home/me/scan.dcm ./scans').catch((): undefined => undefined);
      await new Promise((resolve) => setTimeout(resolve, 10));
      remote.close();
      expect(delivered).toEqual([]);
      expect(refusal_of((FakeWebSocket.instances[FakeWebSocket.instances.length - 1] as FakeWebSocket).sent as Array<Record<string, unknown>>)).toContain('for a line that is not running here');
    });

    it('another destination is refused by name, and nothing is written', async () => {
      const { sent, delivered } = await delivery_during('download /home/me/scan.dcm ./scans', '/home/me/.ssh');
      expect(delivered).toEqual([]);
      expect(refusal_of(sent)).toBe('refused: the session asked to write "scan.dcm" to "/home/me/.ssh", and the line sent from here named "./scans"; nothing was written');
    });

    it('a source of the line is not a destination', async () => {
      const { sent, delivered } = await delivery_during('download /home/me/scan.dcm ./scans', '/home/me/scan.dcm');
      expect(delivered).toEqual([]);
      expect(refusal_of(sent)).toContain('to "/home/me/scan.dcm", and the line sent from here named "./scans"');
    });

    it('an option value, a word of another command, and a redirect\'s file are not destinations', async () => {
      const option = await delivery_during('download -j 4 /home/me/scan.dcm ./scans', '4');
      expect(option.delivered).toEqual([]);
      const other = await delivery_during('cd /etc; download /home/me/scan.dcm ./scans', '/etc');
      expect(other.delivered).toEqual([]);
      expect(refusal_of(other.sent)).toContain('named "./scans"');
      const log = await delivery_during('download /a ./out > log.txt', 'log.txt');
      expect(log.delivered).toEqual([]);
      expect(refusal_of(log.sent)).toContain('named "./out"');
    });

    it('a redirected download, and one later in a pipeline, are written where each said', async () => {
      expect((await delivery_during('download /a ./out > log.txt', './out')).delivered).toEqual(['./out']);
      expect((await delivery_during('ls /x | download /a ./later', './later')).delivered).toEqual(['./later']);
    });

    it('a delivery that names no destination is refused when the line named one', async () => {
      const { sent, delivered } = await delivery_during('download /home/me/scan.dcm ./scans', undefined);
      expect(delivered).toEqual([]);
      expect(refusal_of(sent)).toContain('to the working directory, and the line sent from here named "./scans"');
    });

    it('a line that asks for no file gets none', async () => {
      const { sent, delivered } = await delivery_during('ls /home/me', '/tmp');
      expect(delivered).toEqual([]);
      expect(refusal_of(sent)).toBe('refused: the session asked to write "scan.dcm" to "/tmp", and the line sent from here asks for no file; nothing was written');
    });

    it.each([
      ['a line sent to the background', 'download /a ./out &'],
      ['a host-shell line', '!download /a /b'],
      ['a capture', 'X=$(download /a ./out)'],
      ['a command named by a variable', '$VERB /a ./out'],
    ])('%s cannot be bound, so its delivery is refused', async (_what: string, line: string) => {
      const { sent, delivered } = await delivery_during(line, './out');
      expect(delivered).toEqual([]);
      expect(refusal_of(sent)).toContain('asks for no file');
    });

    it('a delivery after its line has ended is refused', async () => {
      const { sent, delivered } = await delivery_during('download /home/me/scan.dcm ./scans', './scans', { afterResult: true });
      expect(delivered).toEqual([]);
      expect(refusal_of(sent)).toBe('refused: the session asked to write "scan.dcm" to "./scans" for a line that is not running here; nothing was written');
    });

    it('a destination written as a variable is refused, even when the session sends its spelling back', async () => {
      const expanded = await delivery_during('download /home/me/scan.dcm $OUT', '/data/out');
      expect(expanded.delivered).toEqual([]);
      expect(refusal_of(expanded.sent)).toContain('cannot say where: its destination "$OUT" is written with a reference');
      const echoed = await delivery_during('download /home/me/scan.dcm $OUT', '$OUT');
      expect(echoed.delivered).toEqual([]);
      expect(refusal_of(echoed.sent)).toContain('written with a reference');
      // Quoted, the same letters are text: a place like any other.
      expect((await delivery_during("download /a '$OUT'", '$OUT')).delivered).toEqual(['$OUT']);
    });

    describe('with two lines running at once', () => {
      /** Two lines in flight, their ids, and what was delivered; neither ends until told. */
      async function overlap_make(first: string, second: string): Promise<{ ws: FakeWebSocket; ids: string[]; delivered: string[]; ended: Array<Promise<unknown>> }> {
        const delivered: string[] = [];
        const ids: string[] = [];
        scenario = (_ws: FakeWebSocket, sent: Record<string, unknown>): void => { ids.push(String(sent.id)); };
        remote = await RemoteEngine.connect({
          url: 'ws://127.0.0.1:1',
          token: 'token',
          onDeliver: async (request) => { delivered.push(request.destination ?? '(none)'); return { location: `/written/${request.filename}`, bytes: 1 }; },
        });
        const ended: Array<Promise<unknown>> = [remote.line_execute(first), remote.line_execute(second)];
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(ids).toHaveLength(2);
        return { ws: (FakeWebSocket.instances[FakeWebSocket.instances.length - 1] as FakeWebSocket), ids, delivered, ended };
      }

      /** Lets what was asked be answered. */
      const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

      it('one line\'s destination lends nothing to the other', async () => {
        const { ws, ids, delivered, ended } = await overlap_make('download /home/me/scan.dcm ./scans', 'ls /home/me');
        // The daemon says the listing is asking, and names the download's destination.
        deliver_emit(ws, 'd1', ids[1], './scans');
        await settle();
        expect(delivered).toEqual([]);
        expect(refusal_of(ws.sent as Array<Record<string, unknown>>, 'd1')).toContain('asks for no file');
        // The download itself, by its own id, is honoured.
        deliver_emit(ws, 'd2', ids[0], './scans');
        await settle();
        expect(delivered).toEqual(['./scans']);
        result_emit(ws, ids[0] as string); result_emit(ws, ids[1] as string);
        await Promise.all(ended);
        remote.close();
      });

      it('a late delivery for a line that ended is refused while another line still runs', async () => {
        const { ws, ids, delivered, ended } = await overlap_make('download /home/me/scan.dcm ./scans', 'download /home/me/scan.dcm /tmp');
        result_emit(ws, ids[0] as string);
        await ended[0];
        // The first line is over. Its id is no longer a claim, and the second line's destination is not its.
        deliver_emit(ws, 'd1', ids[0], './scans');
        deliver_emit(ws, 'd2', ids[0], '/tmp');
        await settle();
        expect(delivered).toEqual([]);
        expect(refusal_of(ws.sent as Array<Record<string, unknown>>, 'd1')).toContain('for a line that is not running here');
        expect(refusal_of(ws.sent as Array<Record<string, unknown>>, 'd2')).toContain('for a line that is not running here');
        result_emit(ws, ids[1] as string);
        await ended[1];
        remote.close();
      });

      it('a daemon that does not say which line is refused with two running, too', async () => {
        const { ws, ids, delivered, ended } = await overlap_make('download /home/me/scan.dcm ./scans', 'download /home/me/scan.dcm /tmp');
        deliver_emit(ws, 'd1', undefined, './scans');
        await settle();
        expect(delivered).toEqual([]);
        expect(refusal_of(ws.sent as Array<Record<string, unknown>>, 'd1')).toContain('did not say which line asked for it');
        result_emit(ws, ids[0] as string); result_emit(ws, ids[1] as string);
        await Promise.all(ended);
        remote.close();
      });
    });
  });

  it('refuses a delivery when the surface cannot receive files', async () => {
    scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
      const id: string = String(sent.id);
      process.nextTick(() => {
        ws.emit('message', Buffer.from(JSON.stringify({
          type: 'deliver',
          deliverId: 'deliver9',
          path: '/home/me/scan.dcm',
          filename: 'scan.dcm',
        })));
        ws.emit('message', Buffer.from(JSON.stringify({
          type: 'result',
          id,
          envelopes: [{ status: 'ok', rendered: '' }],
        })));
      });
    };

    remote = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token' });
    await remote.line_execute('deliver');
    remote.close();

    // Reporting success for a file nobody received would send the operator
    // looking for it.
    expect(FakeWebSocket.instances[0].sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'deliverError', deliverId: 'deliver9' }),
    ]));
  });

  describe('a request to run something here is bound to the line that asked', () => {
    /** A daemon that, for each line, sends the requests `requests(id)` gives, then (a tick later) the result. */
    const daemon_play = (requests: (id: string, line: string) => Array<Record<string, unknown>>, after: (id: string) => Array<Record<string, unknown>> = () => []): void => {
      scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
        if (sent.type !== 'execute') return;
        const id = String(sent.id);
        process.nextTick(() => {
          for (const one of requests(id, String(sent.line))) ws.emit('message', Buffer.from(JSON.stringify(one)));
          setTimeout(() => {
            ws.emit('message', Buffer.from(JSON.stringify({ type: 'result', id, envelopes: [{ status: 'ok', rendered: '' }] })));
            // After the line has settled here.
            setTimeout(() => { for (const one of after(id)) ws.emit('message', Buffer.from(JSON.stringify(one))); }, 5);
          }, 5);
        });
      };
    };
    const reasons = (type: string): string[] => FakeWebSocket.instances[0].sent.filter((one) => one.type === type).map((one) => String(one.reason));

    it('runs what the line asked for, once; refuses a request with no line, for another line, for something else, or a second time', async () => {
      const shell = jest.fn(async (_command: string): Promise<number> => 0);
      const pipe = jest.fn(async (_command: string, input: Buffer): Promise<Buffer> => input);
      daemon_play((id: string) => [
        { type: 'shell', shellId: 's-own', command: 'ls -la', lineId: id },
        { type: 'shell', shellId: 's-again', command: 'ls -la', lineId: id },
        { type: 'shell', shellId: 's-none', command: 'ls -la' },
        { type: 'shell', shellId: 's-other', command: 'ls -la', lineId: '999' },
        { type: 'shell', shellId: 's-else', command: 'rm -rf ~', lineId: id },
        { type: 'pipe', pipeId: 'p-else', command: 'tr a b', input: '', lineId: id },
      ], (id: string) => [{ type: 'shell', shellId: 's-late', command: 'ls -la', lineId: id }]);
      remote = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token', onShell: shell, onPipe: pipe });
      await remote.line_execute('!ls -la');
      await new Promise((r) => setTimeout(r, 20));
      expect(shell).toHaveBeenCalledTimes(1);
      expect(shell).toHaveBeenCalledWith('ls -la');
      expect(pipe).not.toHaveBeenCalled();
      const sent = FakeWebSocket.instances[0].sent;
      expect(sent).toContainEqual({ type: 'shellResult', shellId: 's-own', exitCode: 0 });
      const refused = (shellId: string): string => String(sent.find((one) => one.shellId === shellId && one.type === 'shellError')?.reason);
      expect(refused('s-again')).toContain('which the line sent from here did not ask for');
      expect(refused('s-none')).toContain('did not say which line asked for it');
      expect(refused('s-other')).toContain('for a line that is not running here');
      expect(refused('s-else')).toContain('"rm -rf ~", which the line sent from here did not ask for');
      expect(refused('s-late')).toContain('for a line that is not running here');
      expect(reasons('pipeError')).toEqual([expect.stringContaining('the pipeline segment "tr a b", which the line sent from here did not ask for')]);
    });

    it('runs a pipeline\'s segments in the engine\'s order, each once, and an edit only of the file the line named', async () => {
      const pipe = jest.fn(async (_command: string, input: Buffer): Promise<Buffer> => input);
      const edit = jest.fn(async (content: string) => ({ content, changed: false }));
      daemon_play((id: string, line: string) => line === 'cat x | tr a b | tr c d'
        ? [
            { type: 'pipe', pipeId: 'p2', command: 'tr c d', input: '', lineId: id },
            { type: 'pipe', pipeId: 'p1', command: 'tr a b', input: '', lineId: id },
          ]
        : [
            { type: 'edit', editId: 'e-other', content: 'x', path: '/home/chris/secrets.txt', lineId: id },
            { type: 'edit', editId: 'e-own', content: 'x', path: '/home/chris/notes.txt', lineId: id },
            { type: 'edit', editId: 'e-again', content: 'x', path: '/home/chris/notes.txt', lineId: id },
          ]);
      remote = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token', onPipe: pipe, onEdit: edit });
      await remote.line_execute('cat x | tr a b | tr c d');
      await remote.line_execute('edit notes.txt');
      await new Promise((r) => setTimeout(r, 20));
      // The second segment taken first passes the first by: it cannot be asked for after.
      expect(pipe.mock.calls.map((call) => call[0])).toEqual(['tr c d']);
      expect(reasons('pipeError')).toEqual([expect.stringContaining('"tr a b", which the line sent from here did not ask for')]);
      expect(edit).toHaveBeenCalledTimes(1);
      const editRefusals: string[] = reasons('editError');
      expect(editRefusals).toHaveLength(2);
      expect(editRefusals[0]).toContain('"/home/chris/secrets.txt"');
    });

    it('a cancelled line, and a closed connection, ask for nothing more', async () => {
      const shell = jest.fn(async (_command: string): Promise<number> => 0);
      let lineId = '';
      scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
        if (sent.type === 'execute') { lineId = String(sent.id); return; }
        if (sent.type === 'cancel') {
          process.nextTick(() => {
            ws.emit('message', Buffer.from(JSON.stringify({ type: 'shell', shellId: 's-cancelled', command: 'ls -la', lineId })));
            setTimeout(() => { ws.emit('message', Buffer.from(JSON.stringify({ type: 'result', id: lineId, envelopes: [{ status: 'ok', rendered: '' }] }))); }, 5);
          });
        }
      };
      remote = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token', onShell: shell });
      const running: Promise<unknown> = remote.line_execute('!ls -la');
      await new Promise((r) => setTimeout(r, 5));
      expect(remote.line_cancel()).toBe(true);
      await running;
      await new Promise((r) => setTimeout(r, 5));
      expect(shell).not.toHaveBeenCalled();
      expect(reasons('shellError')).toEqual([expect.stringContaining('for a line that is not running here')]);
      // A line in flight when the connection closes: its grants go with it.
      scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
        if (sent.type !== 'execute') return;
        const id = String(sent.id);
        process.nextTick(() => {
          ws.emit('close');
          ws.emit('message', Buffer.from(JSON.stringify({ type: 'shell', shellId: 's-closed', command: 'ls -la', lineId: id })));
          ws.emit('message', Buffer.from(JSON.stringify({ type: 'result', id, envelopes: [{ status: 'ok', rendered: '' }] })));
        });
      };
      await remote.line_execute('!ls -la');
      await new Promise((r) => setTimeout(r, 5));
      expect(shell).not.toHaveBeenCalled();
      expect(reasons('shellError')).toHaveLength(2);
    });

    it('two connections with the same numeric line id share no grants', async () => {
      const shellA = jest.fn(async (_command: string): Promise<number> => 0);
      const shellB = jest.fn(async (_command: string): Promise<number> => 0);
      const pending: Array<{ ws: FakeWebSocket; id: string }> = [];
      scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => { if (sent.type === 'execute') pending.push({ ws, id: String(sent.id) }); };
      const a = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token', onShell: shellA });
      const b = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token', onShell: shellB });
      const runningA: Promise<unknown> = a.line_execute('!ls -la');
      const runningB: Promise<unknown> = b.line_execute('anything');
      await new Promise((r) => setTimeout(r, 5));
      const [lineA, lineB] = pending;
      expect(lineA?.id).toBe(lineB?.id);
      // The daemon names A's line id to B, with A's command: B's line asked for nothing.
      lineB?.ws.emit('message', Buffer.from(JSON.stringify({ type: 'shell', shellId: 'cross', command: 'ls -la', lineId: lineB.id })));
      await new Promise((r) => setTimeout(r, 5));
      expect(shellB).not.toHaveBeenCalled();
      expect(lineB?.ws.sent.find((one) => one.shellId === 'cross')?.reason).toContain('which the line sent from here did not ask for');
      for (const line of pending) line.ws.emit('message', Buffer.from(JSON.stringify({ type: 'result', id: line.id, envelopes: [{ status: 'ok', rendered: '' }] })));
      await Promise.all([runningA, runningB]);
      expect(shellA).not.toHaveBeenCalled();
      a.close();
      b.close();
    });
  });

  it('returns a pipe error when the local segment fails', async () => {
    scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
      const id: string = String(sent.id);
      process.nextTick(() => {
        ws.emit('message', Buffer.from(JSON.stringify({
          type: 'pipe',
          pipeId: 'pipe1',
          command: 'signalflow',
          input: Buffer.from('pipeline: test').toString('base64'),
          lineId: id,
        })));
        ws.emit('message', Buffer.from(JSON.stringify({
          type: 'result',
          id,
          envelopes: [{ status: 'error', rendered: '' }],
        })));
      });
    };

    remote = await RemoteEngine.connect({
      url: 'ws://127.0.0.1:1',
      token: 'token',
      onPipe: async (): Promise<Buffer> => {
        throw new Error("Command 'signalflow' exited with code 1");
      },
    });
    await remote.line_execute('pipeline --signalflow | signalflow');
    await new Promise<void>((resolve: () => void): void => process.nextTick(resolve));

    expect(FakeWebSocket.instances[0].sent).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'pipeError',
        pipeId: 'pipe1',
        reason: "Command 'signalflow' exited with code 1",
      }),
    ]));
  });

  it('rejects attach errors', async () => {
    attachResponse = { type: 'error', reason: 'invalid token' };

    await expect(RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'bad' }))
      .rejects.toThrow('attach refused: invalid token');
  });

  it('skips unknown daemon message types quietly, noting each once', async () => {
    remote = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token' });
    const ws: FakeWebSocket = FakeWebSocket.instances[0];
    const spy = jest.spyOn(console, 'error').mockImplementation(() => { /* captured */ });

    // A newer daemon's message type: skipped, with one dim notice — not a
    // warning per arrival (the heartbeat case: one per second, mid-input).
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'from-the-future' })));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'from-the-future' })));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain('from-the-future');

    // A malformed message of a KNOWN type is real drift: still loud.
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'result', __malformed: true })));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[1]?.[0])).toContain('Ignoring invalid message from calypso');

    spy.mockRestore();
  });
});
