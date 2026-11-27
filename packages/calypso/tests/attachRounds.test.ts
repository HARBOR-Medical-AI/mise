/**
 * @file Acceptance: a surface that attaches and detaches many times leaves
 * the daemon as it was while nobody was attached.
 *
 * A real daemon over a real socket, with an engine that counts what it is
 * handed (watches, ambient listeners, origins) and terminals over a pty
 * the test stands in for. No CUBE.
 *
 * The measure is taken while detached, before the first attach, and every
 * detach is held to it: what one attachment adds for its viewer and its
 * socket (a surface, its watch, its questions, its running commands, its
 * socket) is gone after its detach, every round, not merely equal to the
 * count after the first.
 *
 * A terminal is meant to outlive its viewer: detached, it runs on with its
 * idle timer started, to be reattached by id. So it is measured in two
 * steps: straight after a detach the terminal and its timer are still
 * there while everything of the viewer is gone; it is then reattached and
 * shown to be the same one; and once it is closed the whole baseline holds.
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
const ROUNDS = 25;

/** An engine that counts what the daemon hands it and takes back. */
function countingEngine_create(): HostedEngine & { watches: Map<string, Set<string>>; ambient: Set<unknown>; forgotten: string[]; executed: string[] } {
  const watches: Map<string, Set<string>> = new Map();
  const ambient: Set<unknown> = new Set();
  const forgotten: string[] = [];
  const executed: string[] = [];
  return {
    watches, ambient, forgotten, executed,
    line_execute: async (line: string): Promise<CommandEnvelope[]> => { executed.push(line); return [{ status: 'ok', rendered: `ran: ${line}` }]; },
    line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    watch_set: (subject: string, owner: string, on: boolean) => {
      const owners: Set<string> = watches.get(subject) ?? new Set();
      if (on) owners.add(owner); else owners.delete(owner);
      if (owners.size > 0) watches.set(subject, owners); else watches.delete(subject);
      return on ? 'live' : null;
    },
    watch_release: (owner: string): void => {
      for (const [subject, owners] of watches) { owners.delete(owner); if (owners.size === 0) watches.delete(subject); }
    },
    ambient_listen: (listener: unknown): (() => void) => { ambient.add(listener); return (): void => { ambient.delete(listener); }; },
    origin_forget: (origin: string): void => { forgotten.push(origin); },
  };
}

/** A pty the test stands in for; the test counts those alive. */
function fakeSpawn_create(): { spawn: PtySpawn; alive: () => number; all: Array<{ killed: boolean; end: (code: number) => void }> } {
  const all: Array<{ killed: boolean; end: (code: number) => void }> = [];
  const spawn: PtySpawn = (): PtyProcess => {
    let onExit: (event: { exitCode: number }) => void = (): void => undefined;
    const pty = {
      killed: false,
      onData: (): void => undefined,
      onExit: (listener: (event: { exitCode: number }) => void): void => { onExit = listener; },
      write: (): void => undefined,
      resize: (): void => undefined,
      kill: (): void => { pty.killed = true; onExit({ exitCode: 0 }); },
      end: (code: number): void => { onExit({ exitCode: code }); },
    };
    all.push(pty);
    return pty as unknown as PtyProcess;
  };
  return { spawn, all, alive: (): number => all.filter((one) => !one.killed).length };
}

function send(ws: WebSocket, message: unknown): void { ws.send(JSON.stringify(message)); }

/** The next message of a type from a socket. */
function message_wait(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const heard = (data: unknown): void => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      if (message['type'] !== type) return;
      ws.off('message', heard);
      resolve(message);
    };
    ws.on('message', heard);
  });
}

async function attach(port: number): Promise<WebSocket> {
  const ws: WebSocket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const acked = message_wait(ws, 'attached');
  send(ws, { type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN, capabilities: { hiddenInput: true, shellCommands: false } });
  await acked;
  return ws;
}

/** Closes a socket and waits until the daemon has let its surface go. */
async function detach(ws: WebSocket, daemon: CalypsoDaemon, toSurfaces: number): Promise<void> {
  ws.close();
  for (let waited = 0; waited < 200 && daemon.surfaces_count() !== toSurfaces; waited++) await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
}

/** What the daemon holds, counted: its own books by name, the engine's, and its sockets. */
interface Measure {
  surfaces: number;
  sockets: number;
  hostPtys: number;
  questionsOpen: number;
  running: number;
  stopPending: number;
  viewerOf: number;
  watchedSubjects: number;
  ambientListeners: number;
}

function measure_take(daemon: CalypsoDaemon, engine: ReturnType<typeof countingEngine_create>): Measure {
  const inner = daemon as unknown as {
    wss: { clients: Set<unknown> }; hostPtys: Map<unknown, unknown>; questionsOpen: Map<unknown, unknown>; running: Set<unknown>; stopPending: Map<unknown, unknown>; viewerOf: Map<unknown, unknown>;
  };
  return {
    surfaces: daemon.surfaces_count(),
    sockets: inner.wss.clients.size,
    hostPtys: inner.hostPtys.size,
    questionsOpen: inner.questionsOpen.size,
    running: inner.running.size,
    stopPending: inner.stopPending.size,
    viewerOf: inner.viewerOf.size,
    watchedSubjects: engine.watches.size,
    ambientListeners: engine.ambient.size,
  };
}

describe('attach and detach, many times', () => {
  let daemon: CalypsoDaemon;
  let engine: ReturnType<typeof countingEngine_create>;
  let port: number;
  let ptys: ReturnType<typeof fakeSpawn_create>;
  let terminals: Terminals;

  beforeEach(async () => {
    engine = countingEngine_create();
    daemon = new CalypsoDaemon({ engine, token: TOKEN });
    ptys = fakeSpawn_create();
    terminals = new Terminals({ spawn: ptys.spawn, launch: { exec: '/usr/bin/node', prefixArgs: ['/opt/chell/index.js'] }, target: { identity: 'someone@cube', url: 'ws://127.0.0.1:1', token: 'tok' }, idleMs: 60_000 });
    daemon.terminals_set(terminals);
    port = await daemon.start();
  });

  afterEach(async () => {
    terminals.stop();
    await daemon.stop();
  });

  it(`after each of ${ROUNDS} rounds of attach, watch, run and detach, the daemon holds what it held while detached`, async () => {
    const detached: Measure = measure_take(daemon, engine);
    expect(detached).toMatchObject({ surfaces: 0, sockets: 0, viewerOf: 0, watchedSubjects: 0 });
    for (let round = 0; round < ROUNDS; round++) {
      const ws: WebSocket = await attach(port);
      const watched = message_wait(ws, 'watched');
      send(ws, { type: 'watch', subject: `/proc/jobs/feed_${round % 3}` });
      await watched;
      const ran = message_wait(ws, 'result');
      send(ws, { type: 'execute', id: `round-${round}`, line: 'pwd' });
      await ran;
      // Attached: the daemon holds this attachment's part.
      const attached: Measure = measure_take(daemon, engine);
      expect(attached.surfaces).toBe(1);
      expect(attached.watchedSubjects).toBe(1);
      await detach(ws, daemon, 0);
      await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
      expect(measure_take(daemon, engine)).toEqual(detached);
    }
    // Each attachment's origin was forgotten as it left: one per round.
    expect(engine.forgotten).toHaveLength(ROUNDS);
    expect(new Set(engine.forgotten).size).toBe(ROUNDS);
    expect(engine.executed).toHaveLength(ROUNDS);
  });

  it('two surfaces at once, leaving in either order, leave nothing of either', async () => {
    const detached: Measure = measure_take(daemon, engine);
    for (let round = 0; round < 6; round++) {
      const a: WebSocket = await attach(port);
      const b: WebSocket = await attach(port);
      for (const ws of [a, b]) {
        const watched = message_wait(ws, 'watched');
        send(ws, { type: 'watch', subject: '/proc/jobs/feed_7' });
        await watched;
      }
      expect(engine.watches.get('/proc/jobs/feed_7')?.size).toBe(2);
      const [first, second] = round % 2 === 0 ? [a, b] : [b, a];
      await detach(first as WebSocket, daemon, 1);
      // The one that stayed still holds its watch.
      expect(engine.watches.get('/proc/jobs/feed_7')?.size).toBe(1);
      await detach(second as WebSocket, daemon, 0);
      await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
      expect(measure_take(daemon, engine)).toEqual(detached);
    }
  });

  /** The terminals the store holds, and each one's clock: armed while nobody watches it. */
  const book_of = (store: Terminals): Map<string, { idle: unknown; viewer: unknown }> => (store as unknown as { terminals: Map<string, { idle: unknown; viewer: unknown }> }).terminals;

  it('a terminal outlives its viewer on purpose: detached it stays for a reattach, is the same one when reattached, and closed leaves the baseline', async () => {
    const detached: Measure = measure_take(daemon, engine);
    expect(book_of(terminals).size).toBe(0);
    let terminalId: string = '';
    for (let round = 0; round < 8; round++) {
      const ws: WebSocket = await attach(port);
      const opened = message_wait(ws, 'terminalOpened');
      send(ws, { type: 'terminalOpen', cols: 80, rows: 24, ...(terminalId !== '' ? { terminalId } : {}) });
      const answer = await opened;
      // The first round makes it; every later round is given the same one back.
      if (terminalId === '') terminalId = String(answer['terminalId']);
      expect(answer['terminalId']).toBe(terminalId);
      expect(ptys.all).toHaveLength(1);
      // Watched: one terminal, and its clock is not running.
      expect(book_of(terminals).size).toBe(1);
      expect(book_of(terminals).get(terminalId)?.idle).toBeNull();
      await detach(ws, daemon, 0);
      await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
      // Everything of the viewer and its socket is gone; the terminal, and the timer that would end it, are still there.
      expect(measure_take(daemon, engine)).toEqual(detached);
      expect(ptys.alive()).toBe(1);
      expect(terminals.viewer_get(terminalId)).toBeNull();
      // Still one terminal, and the detach armed the clock that will end it if nobody comes back.
      expect(book_of(terminals).size).toBe(1);
      expect(book_of(terminals).get(terminalId)?.idle).not.toBeNull();
    }
    // Reattached once more and closed: nothing of it is left.
    const last: WebSocket = await attach(port);
    const opened = message_wait(last, 'terminalOpened');
    send(last, { type: 'terminalOpen', cols: 80, rows: 24, terminalId });
    expect((await opened)['terminalId']).toBe(terminalId);
    send(last, { type: 'terminalClose', terminalId });
    for (let waited = 0; waited < 100 && ptys.alive() !== 0; waited++) await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
    expect(ptys.alive()).toBe(0);
    await detach(last, daemon, 0);
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    expect(measure_take(daemon, engine)).toEqual(detached);
    expect(ptys.all).toHaveLength(1);
    expect(book_of(terminals).size).toBe(0);
  });

  it('a terminal nobody comes back to ends when its time is up, and the count of terminals is back at none', async () => {
    const brief: Terminals = new Terminals({ spawn: ptys.spawn, launch: { exec: '/usr/bin/node', prefixArgs: ['/opt/chell/index.js'] }, target: { identity: 'someone@cube', url: 'ws://127.0.0.1:1', token: 'tok' }, idleMs: 60 });
    daemon.terminals_set(brief);
    const detached: Measure = measure_take(daemon, engine);
    const ws: WebSocket = await attach(port);
    const opened = message_wait(ws, 'terminalOpened');
    send(ws, { type: 'terminalOpen', cols: 80, rows: 24 });
    const terminalId: string = String((await opened)['terminalId']);
    expect(book_of(brief).size).toBe(1);
    await detach(ws, daemon, 0);
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    // Detached: still there, its clock armed by the socket's close.
    expect(book_of(brief).get(terminalId)?.idle).not.toBeNull();
    for (let waited = 0; waited < 100 && book_of(brief).size !== 0; waited++) await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    expect(book_of(brief).size).toBe(0);
    expect(ptys.alive()).toBe(0);
    expect(measure_take(daemon, engine)).toEqual(detached);
    brief.stop();
  });
});
