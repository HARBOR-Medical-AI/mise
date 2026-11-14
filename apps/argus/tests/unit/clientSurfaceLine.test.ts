/**
 * @file A line typed in a chell whose subject this surface claims: the client
 * runs it through its handler and answers with the text, says why when it
 * cannot, and declares its claims and notes on the wire.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { CONTRACT_VERSION } from '@fnndsc/menu';
import { ArgusClient, type ClientHandlers } from '../../src/calypso/client.js';
import { claims_list } from '../../src/console/argusLang.js';

/** A socket the test drives: it records what the client sends. */
class FakeSocket {
  public static last: FakeSocket | null = null;
  public sent: Array<Record<string, unknown>> = [];
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: string }) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onclose: (() => void) | null = null;
  constructor(_url: string) {
    FakeSocket.last = this;
    queueMicrotask((): void => this.onopen?.());
  }
  public send(text: string): void { this.sent.push(JSON.parse(text) as Record<string, unknown>); }
  public close(): void { /* nothing to release */ }
  public deliver(message: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify(message) }); }
}

/** Attaches a client over the fake socket. */
async function client_attach(handlers: ClientHandlers): Promise<{ socket: FakeSocket; client: ArgusClient }> {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  const attaching = ArgusClient.session_attach('ws://test', 'token', handlers);
  await Promise.resolve();
  const socket: FakeSocket = FakeSocket.last as FakeSocket;
  socket.deliver({ type: 'attached', session: 's', protocolVersion: CONTRACT_VERSION });
  const attached = await attaching;
  socket.sent = [];
  return { socket, client: (attached as unknown as { client: ArgusClient }).client };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('lines in this surface\'s own language', () => {
  beforeEach((): void => { FakeSocket.last = null; });

  it('runs a routed line through its handler and answers with the text', async () => {
    const lines: string[] = [];
    const { socket } = await client_attach({ surfaceLine_receive: async (line: string) => { lines.push(line); return { rendered: 'census on', status: 'ok' }; } });
    socket.deliver({ type: 'surfaceLine', lineId: 'l1', line: 'dag %1 census on' });
    await settle();
    expect(lines).toEqual(['dag %1 census on']);
    expect(socket.sent).toEqual([{ type: 'surfaceLineResult', lineId: 'l1', rendered: 'census on', status: 'ok' }]);
  });

  it('says why when the handler refuses, or when there is none', async () => {
    const { socket } = await client_attach({ surfaceLine_receive: async () => { throw new Error('not a line of this surface'); } });
    socket.deliver({ type: 'surfaceLine', lineId: 'l2', line: 'dag x' });
    await settle();
    expect(socket.sent).toEqual([{ type: 'surfaceLineError', lineId: 'l2', reason: 'not a line of this surface' }]);
    const bare = await client_attach({});
    bare.socket.deliver({ type: 'surfaceLine', lineId: 'l3', line: 'dag x' });
    expect(bare.socket.sent).toEqual([{ type: 'surfaceLineError', lineId: 'l3', reason: 'this surface runs no lines of its own' }]);
  });

  it('declares its claims and sends notes', async () => {
    const { socket, client } = await client_attach({});
    client.claims_send([{ subject: 'dag' }]);
    client.note_send('ran 3 lines');
    expect(socket.sent).toEqual([{ type: 'surfaceClaims', claims: [{ subject: 'dag' }] }, { type: 'note', text: 'ran 3 lines' }]);
  });

  it('the frame\'s claims: whole subjects bare, a shared subject with its claimed verbs', () => {
    const claims = claims_list();
    expect(claims).toContainEqual({ subject: 'desktop' });
    expect(claims).toContainEqual({ subject: 'pane' });
    expect(claims.find((claim) => claim.subject === 'help')).toEqual({ subject: 'help', verbs: ['keys', 'pane', 'verbs'] });
    expect(claims.find((claim) => claim.subject === 'file')?.verbs).toContain('open');
  });
});

describe('a line sent with a signal', () => {
  beforeEach((): void => { FakeSocket.last = null; });

  it('is cancelled on the wire by its own id when the signal aborts, and settles with the daemon\'s answer', async () => {
    const { socket, client } = await client_attach({});
    const asking: AbortController = new AbortController();
    const outcome = client.line_execute('dcm series "/home/someone/uploads/series-a"', { silent: true, observe: false, signal: asking.signal });
    const id: unknown = socket.sent[0]?.['id'];
    expect(socket.sent).toEqual([{ type: 'execute', id, line: 'dcm series "/home/someone/uploads/series-a"', instrument: true }]);
    asking.abort();
    expect(socket.sent[1]).toEqual({ type: 'cancel', id });
    socket.deliver({ type: 'result', id, envelopes: [{ status: 'error', rendered: '', renderedErr: 'dcm series: stopped\n' }] });
    expect((await outcome).envelopes[0]?.status).toBe('error');
  });

  it('sends no cancel for a line that has already been answered', async () => {
    const { socket, client } = await client_attach({});
    const asking: AbortController = new AbortController();
    const outcome = client.line_execute('dcm series "/home/someone/uploads/series-a"', { silent: true, observe: false, signal: asking.signal });
    const id: unknown = socket.sent[0]?.['id'];
    socket.deliver({ type: 'result', id, envelopes: [{ status: 'ok', rendered: '' }] });
    await outcome;
    asking.abort();
    expect(socket.sent).toHaveLength(1);
  });
});
