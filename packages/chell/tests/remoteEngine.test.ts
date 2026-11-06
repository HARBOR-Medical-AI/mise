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
jest.unstable_mockModule('@fnndsc/brasa', () => ({
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

  it('runs a daemon-requested shell command on the attached surface', async () => {
    const shell = jest.fn(async (_command: string): Promise<number> => 0);
    scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
      if (sent.type !== 'execute') return;
      const id = String(sent.id);
      process.nextTick(() => {
        ws.emit('message', Buffer.from(JSON.stringify({
          type: 'shell', shellId: 'h1', command: 'printf local',
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

  it('reports promptError, pipeError, and editError when it has no handlers', async () => {
    // A surface without handlers must report inability rather than fabricate
    // an empty answer, a pass-through pipe, or an unchanged "successful" edit.
    scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
      if (sent.type !== 'execute') return;
      const id = String(sent.id);
      process.nextTick(() => {
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'prompt', promptId: 'p1', message: 'Password:', hidden: true })));
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'pipe', pipeId: 'x1', command: 'grep x', input: Buffer.from('in').toString('base64') })));
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'edit', editId: 'e1', content: 'text', extension: 'md' })));
        ws.emit('message', Buffer.from(JSON.stringify({ type: 'result', id, envelopes: [{ status: 'ok', rendered: '' }] })));
      });
    };

    remote = await RemoteEngine.connect({ url: 'ws://127.0.0.1:1', token: 'token' });
    await remote.line_execute('anything');
    // The error replies are sent on the next ticks after the requests land.
    await new Promise((r) => setTimeout(r, 0));

    const sentTypes = FakeWebSocket.instances[0].sent;
    expect(sentTypes).toContainEqual(expect.objectContaining({ type: 'promptError', promptId: 'p1' }));
    expect(sentTypes).toContainEqual(expect.objectContaining({ type: 'pipeError', pipeId: 'x1' }));
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
      const id = String(sent.id);
      process.nextTick(() => {
        ws.emit('message', Buffer.from(JSON.stringify({
          type: 'pipe',
          pipeId: 'pipe1',
          command: 'wc -c',
          input: Buffer.from('abc').toString('base64'),
        })));
        ws.emit('message', Buffer.from(JSON.stringify({
          type: 'edit',
          editId: 'edit1',
          content: 'before',
          extension: '.txt',
        })));
        ws.emit('message', Buffer.from(JSON.stringify({
          type: 'deliver',
          deliverId: 'deliver1',
          path: '/home/me/scan.dcm',
          filename: 'scan.dcm',
          destination: '/tmp',
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
      onPipe: async (_command, input) => Buffer.from(input.toString().toUpperCase()),
      onEdit: async (content) => ({ content: `${content} after`, changed: true }),
      onDeliver: async (request) => ({ location: `/tmp/${request.filename}`, bytes: 2048 }),
      onClose: () => { closed = true; },
    });
    await remote.line_execute('callbacks');
    remote.close();

    expect(FakeWebSocket.instances[0].sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'pipeResult', pipeId: 'pipe1', output: Buffer.from('ABC').toString('base64') }),
      expect.objectContaining({ type: 'editResult', editId: 'edit1', content: 'before after', changed: true }),
      expect.objectContaining({ type: 'deliverResult', deliverId: 'deliver1', location: '/tmp/scan.dcm', bytes: 2048 }),
    ]));
    expect(closed).toBe(true);
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

  it('returns a pipe error when the local segment fails', async () => {
    scenario = (ws: FakeWebSocket, sent: Record<string, unknown>): void => {
      const id: string = String(sent.id);
      process.nextTick(() => {
        ws.emit('message', Buffer.from(JSON.stringify({
          type: 'pipe',
          pipeId: 'pipe1',
          command: 'signalflow',
          input: Buffer.from('pipeline: test').toString('base64'),
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
