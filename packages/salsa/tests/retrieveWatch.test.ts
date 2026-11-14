/**
 * Tests for the PACS retrieve engine: firing (retry, unfired), the LONK watch
 * state machine (progress, done, error, stall, timeout, no-activity), the
 * idempotency skip, and the confirm loop. The LONK WebSocket and cumin's PACS
 * calls are stubbed; timers are faked to drive the watch checker.
 */
import { EventEmitter } from 'events';

const wsInstances: MockWebSocket[] = [];
class MockWebSocket extends EventEmitter {
  public sent: Record<string, unknown>[] = [];
  constructor(public readonly url: string) {
    super();
    wsInstances.push(this);
  }
  // 'open' fires synchronously at listener registration so tests never race
  // the handshake under fake timers (which also fake process.nextTick).
  public override once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    if (event === 'open') { listener(); return this; }
    return super.once(event, listener);
  }
  public send(payload: string): void {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }
  public close(): void {
    this.emit('close');
  }
}
jest.mock('ws', () => ({ __esModule: true, default: MockWebSocket }));

const mockQueriesCreate = jest.fn();
const mockRetrieveCreate = jest.fn();
const mockStorageResolve = jest.fn();
jest.mock('@fnndsc/cumin', () => {
  const actual = jest.requireActual('@fnndsc/cumin');
  return {
    ...actual,
    pacsQueries_create: (...args: unknown[]) => mockQueriesCreate(...args),
    pacsRetrieve_create: (...args: unknown[]) => mockRetrieveCreate(...args),
    seriesStorage_resolve: (...args: unknown[]) => mockStorageResolve(...args),
  };
});

import {
  retrieveTask_make,
  retrieveTasks_skipComplete,
  retrieve_fireAndWatch,
  retrieve_confirmLoop,
  retrieveProgress_classify,
  type RetrieveTask,
} from '../src/retrieve/watch';

const ok = <T>(value: T) => ({ ok: true as const, value });
const err = () => ({ ok: false as const });

const fakeClient = {
  createDownloadToken: async () => ({
    data: { token: 'TOK' },
    url: 'https://cube.example/api/v1/downloadtokens/5/',
  }),
} as never;

const task = (uid: string = '1.2.3', expected: number = 2): RetrieveTask =>
  retrieveTask_make({ label: `series-${uid}`, seriesUID: uid, studyUID: '1.2', pacsName: 'AET', expectedFiles: expected });

const lonk = (seriesUID: string, message: Record<string, unknown>): Buffer =>
  Buffer.from(JSON.stringify({ SeriesInstanceUID: seriesUID, message }));

const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

beforeEach(() => {
  jest.clearAllMocks();
  wsInstances.length = 0;
  mockQueriesCreate.mockResolvedValue(ok({ id: 100 }));
  mockRetrieveCreate.mockResolvedValue(ok({ id: 200 }));
  mockStorageResolve.mockResolvedValue(ok({ fileCount: 0, folderPath: null }));
});
afterEach(() => {
  jest.useRealTimers();
});

describe('retrieveProgress_classify', () => {
  it('maps every lifecycle state', () => {
    const t = task();
    expect(retrieveProgress_classify(t)).toBe('running');
    t.status = 'pulled';
    t.lonkConfirmed = true;
    expect(retrieveProgress_classify(t)).toBe('done');
    t.lonkConfirmed = false;
    expect(retrieveProgress_classify(t)).toBe('unconfirmed');
    t.status = 'unfired';
    expect(retrieveProgress_classify(t)).toBe('error');
    t.status = 'stalled';
    expect(retrieveProgress_classify(t)).toBe('stalled');
  });
});

describe('retrieveTasks_skipComplete', () => {
  it('skips series already fully registered, keeping incomplete ones', async () => {
    mockStorageResolve
      .mockResolvedValueOnce(ok({ fileCount: 2, folderPath: '/SERVICES/PACS/a' }))
      .mockResolvedValueOnce(ok({ fileCount: 1, folderPath: '/SERVICES/PACS/b' }));
    const complete = task('1.2.3', 2);
    const partial = task('4.5.6', 5);
    expect(await retrieveTasks_skipComplete([complete, partial])).toBe(1);
    expect(complete.status).toBe('pulled');
    expect(complete.cubePathDir).toBe('/SERVICES/PACS/a');
    expect(partial.status).toBe('pending');
  });
});

describe('retrieve_fireAndWatch', () => {
  it('subscribes, fires, and completes a series on a LONK done message', async () => {
    jest.useFakeTimers();
    const t = task();
    const statuses: string[] = [];
    const run = retrieve_fireAndWatch([t], 'PACSDCM', fakeClient, {
      task: (_t, status) => statuses.push(status),
    });
    await flush();

    const ws = wsInstances[0];
    expect(ws.url).toBe('wss://cube.example/api/v1/pacs/ws/?token=TOK');
    expect(ws.sent).toContainEqual({ SeriesInstanceUID: '1.2.3', pacs_name: 'AET', action: 'subscribe' });

    ws.emit('message', lonk('1.2.3', { ndicom: 1 }));
    ws.emit('message', lonk('1.2.3', { done: true }));
    await jest.advanceTimersByTimeAsync(2_000);
    expect(await run).toBe(0);

    expect(t.status).toBe('pulled');
    expect(t.lonkConfirmed).toBe(true);
    expect(t.actualFiles).toBe(2);
    expect(statuses).toContain('running');
    expect(statuses).toContain('done');
  });

  it('retries firing through creation failures before declaring unfired', async () => {
    jest.useFakeTimers();
    mockQueriesCreate
      .mockResolvedValueOnce(err())
      .mockResolvedValue(ok({ id: 100 }));
    const t = task();
    const run = retrieve_fireAndWatch([t], 'PACSDCM', fakeClient, {});
    await flush();
    // Drain the firing backoff, then complete the watch.
    await jest.advanceTimersByTimeAsync(1_000);
    wsInstances[0].emit('message', lonk('1.2.3', { done: true }));
    await jest.advanceTimersByTimeAsync(2_000);
    expect(await run).toBe(0);
    expect(t.status).toBe('pulled');
    expect(mockQueriesCreate).toHaveBeenCalledTimes(2);
  });

  it('declares a series unfired when creation keeps failing', async () => {
    jest.useFakeTimers();
    mockQueriesCreate.mockResolvedValue(err());
    const t = task();
    const run = retrieve_fireAndWatch([t], 'PACSDCM', fakeClient, {});
    await flush();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(await run).toBe(1);
    expect(t.status).toBe('unfired');
  });

  it('marks a series errored on a LONK error message', async () => {
    jest.useFakeTimers();
    const t = task();
    const run = retrieve_fireAndWatch([t], 'PACSDCM', fakeClient, {});
    await flush();
    wsInstances[0].emit('message', lonk('1.2.3', { error: 'refused' }));
    await jest.advanceTimersByTimeAsync(2_000);
    await run;
    expect(t.status).toBe('error');
  });

  it('stalls a series whose progress stops', async () => {
    jest.useFakeTimers();
    const t = task();
    const run = retrieve_fireAndWatch([t], 'PACSDCM', fakeClient, {});
    await flush();
    wsInstances[0].emit('message', lonk('1.2.3', { ndicom: 1 }));
    await jest.advanceTimersByTimeAsync(34_000);
    await run;
    expect(t.status).toBe('stalled');
  });

  it('treats a silent fired series as pulled-unconfirmed after the no-activity window', async () => {
    jest.useFakeTimers();
    const t = task();
    const run = retrieve_fireAndWatch([t], 'PACSDCM', fakeClient, {});
    await flush();
    // A quiet PACS is given a minute before a series is called unconfirmed.
    await jest.advanceTimersByTimeAsync(30_000);
    expect(t.status).toBe('pending');
    await jest.advanceTimersByTimeAsync(40_000);
    await run;
    expect(t.status).toBe('pulled');
    expect(t.lonkConfirmed).toBe(false);
  });

  it('leaves the queued series alone while the PACS is still sending another', async () => {
    // A study is served in turn: while series one is arriving, the rest have
    // been fired and have nothing to report yet. Charging each of them a
    // no-activity clock from its own fire time declared every series after
    // the first dead fifteen seconds in, which is how a whole study came
    // back UNCONFIRMED while pulling one series alone always worked.
    jest.useFakeTimers();
    const first = task('1.1', 4);
    const queued = [task('2.2', 4), task('3.3', 4)];
    const run = retrieve_fireAndWatch([first, ...queued], 'PACSDCM', fakeClient, {});
    await flush();

    // Twenty-four seconds of the PACS sending series one, past the old
    // fifteen-second window, in ticks it would have fired on.
    for (let file = 1; file <= 4; file++) {
      wsInstances[0].emit('message', lonk('1.1', { ndicom: file }));
      await jest.advanceTimersByTimeAsync(6_000);
    }
    for (const t of queued) {
      expect(t.status).toBe('pending');
      expect(t.lonkConfirmed).toBe(false);
    }

    // Series one ends and series two starts: the queue was never lost.
    wsInstances[0].emit('message', lonk('1.1', { done: true }));
    wsInstances[0].emit('message', lonk('2.2', { ndicom: 1 }));
    await jest.advanceTimersByTimeAsync(4_000);
    expect(queued[0].status).toBe('pulling');

    // Now the PACS goes quiet on everything. That is the real evidence,
    // and it is what the guard is for (a minute of silence).
    await jest.advanceTimersByTimeAsync(70_000);
    await run;
    expect(first.status).toBe('pulled');
    expect(first.lonkConfirmed).toBe(true);
    expect(queued[0].status).toBe('stalled');
    expect(queued[1].status).toBe('pulled');
    expect(queued[1].lonkConfirmed).toBe(false);
  });

  it('does not charge a series for the turn it waited before its first file', async () => {
    // The long stop counts from a series' first file. One that waited ten
    // minutes in a queue and then arrived normally is not a timeout.
    jest.useFakeTimers();
    const first = task('1.1', 1);
    const late = task('9.9', 1);
    const run = retrieve_fireAndWatch([first, late], 'PACSDCM', fakeClient, {});
    await flush();
    // Ten minutes of the PACS working through the series ahead of it.
    for (let tick = 0; tick < 60; tick++) {
      wsInstances[0].emit('message', lonk('1.1', { ndicom: 1 }));
      await jest.advanceTimersByTimeAsync(10_000);
    }
    expect(late.status).toBe('pending');
    wsInstances[0].emit('message', lonk('1.1', { done: true }));
    wsInstances[0].emit('message', lonk('9.9', { ndicom: 1 }));
    wsInstances[0].emit('message', lonk('9.9', { done: true }));
    await jest.advanceTimersByTimeAsync(4_000);
    await run;
    expect(late.status).toBe('pulled');
    expect(late.lonkConfirmed).toBe(true);
  });

  it('asks whether to keep waiting after twenty silent seconds, CUBE checked first; yes waits, no ends it unconfirmed', async () => {
    jest.useFakeTimers();
    const t = task();
    mockStorageResolve.mockResolvedValue(ok({ fileCount: 0, folderPath: null }));
    const answers: boolean[] = [true, false];
    const asked: number[] = [];
    const run = retrieve_fireAndWatch([t], 'PACSDCM', fakeClient, {
      stillWaiting: async (waiting, waitedS) => { asked.push(waitedS); expect(waiting).toEqual([t]); return answers.shift() ?? false; },
    });
    await flush();
    await jest.advanceTimersByTimeAsync(15_000);
    expect(asked).toEqual([]);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(asked.length).toBe(1);
    expect(mockStorageResolve).toHaveBeenCalled();
    expect(t.status).toBe('pending');
    await jest.advanceTimersByTimeAsync(25_000);
    await run;
    expect(asked.length).toBe(2);
    expect(t.status).toBe('unconfirmed');
    expect(t.reason).toMatch(/stopped waiting/);
  });

  it('says the whole silence each time it asks, so an asker counting to a limit reaches it', async () => {
    jest.useFakeTimers();
    const t = task();
    const asked: number[] = [];
    // The policy of a caller that cannot put the question to anyone.
    const run = retrieve_fireAndWatch([t], 'PACSDCM', fakeClient, {
      stillWaiting: async (_waiting, waitedS) => { asked.push(waitedS); return waitedS < 60; },
    });
    await flush();
    await jest.advanceTimersByTimeAsync(80_000);
    await run;
    expect(asked.length).toBe(3);
    expect(asked[0]).toBeLessThan(asked[1] as number);
    expect(asked[2]).toBeGreaterThanOrEqual(60);
    expect(t.status).toBe('unconfirmed');
  });

  it('with nobody to ask, ends every silent series after the long window and never waits on an answer', async () => {
    jest.useFakeTimers();
    const first = task('1.1');
    const second = task('2.2');
    const seen: string[] = [];
    const events = { task: (t: RetrieveTask, status: string): void => { seen.push(`${t.seriesUID} ${status}`); } };
    const run = retrieve_fireAndWatch([first, second], 'PACSDCM', fakeClient, events);
    await flush();
    await jest.advanceTimersByTimeAsync(58_000);
    expect(seen).toEqual(['1.1 running', '2.2 running']);
    await jest.advanceTimersByTimeAsync(6_000);
    await run;
    await retrieve_confirmLoop([first, second], 0, 'PACSDCM', fakeClient, events);
    for (const t of [first, second]) {
      expect(t.status).toBe('unconfirmed');
      expect(t.reason).toBe('the PACS sent nothing for 60 s and CUBE has none of it');
    }
    // Each series ends with a word of its own, last.
    expect(seen.slice(-2)).toEqual(['1.1 unconfirmed', '2.2 unconfirmed']);
  });

  it('a series CUBE already has when the silence is noticed is done, and nobody is asked', async () => {
    jest.useFakeTimers();
    const t = task();
    mockStorageResolve.mockResolvedValue(ok({ fileCount: 2, folderPath: '/SERVICES/PACS/w' }));
    const asked: number[] = [];
    const run = retrieve_fireAndWatch([t], 'PACSDCM', fakeClient, { stillWaiting: async (_w, s) => { asked.push(s); return true; } });
    await flush();
    await jest.advanceTimersByTimeAsync(25_000);
    await run;
    expect(asked).toEqual([]);
    expect(t.status).toBe('pulled');
    expect(t.lonkConfirmed).toBe(true);
  });

  it('reconnects a dropped socket and keeps watching the same retrieve', async () => {
    // The retrieve runs on the server; the socket is only how the client
    // watches it. Losing the view is not losing the work, so a reconnect
    // resumes reporting instead of repeating anything.
    jest.useFakeTimers();
    const t = task();
    const reconnects: number[] = [];
    const run = retrieve_fireAndWatch([t], 'PACSDCM', fakeClient, {
      reconnect: (attempt: number): void => { reconnects.push(attempt); },
    });
    await flush();
    const firedBefore = mockRetrieveCreate.mock.calls.length;

    wsInstances[0].emit('error', new Error('dropped'));
    await flush();

    expect(reconnects).toEqual([1]);
    expect(wsInstances.length).toBe(2);
    // Re-subscribed, not re-fired.
    expect(wsInstances[1].sent[0]).toMatchObject({ action: 'subscribe', SeriesInstanceUID: t.seriesUID });
    expect(mockRetrieveCreate.mock.calls.length).toBe(firedBefore);

    wsInstances[1].emit('message', Buffer.from(JSON.stringify({
      SeriesInstanceUID: t.seriesUID, message: { done: true },
    })));
    await jest.advanceTimersByTimeAsync(2_000);
    await run;

    expect(t.status).toBe('pulled');
    expect(t.lonkConfirmed).toBe(true);
  });

  it('gives up after repeated drops, recording what it no longer knows', async () => {
    jest.useFakeTimers();
    const t = task();
    const run = retrieve_fireAndWatch([t], 'PACSDCM', fakeClient, {});
    await flush();

    // One original socket plus three reconnects; the fourth drop exhausts them.
    for (let attempt = 0; attempt < 4; attempt++) {
      wsInstances[wsInstances.length - 1].emit('error', new Error('dropped'));
      await flush();
    }
    await run;

    // Still not a failure: nothing here knows the retrieve failed.
    expect(t.status).toBe('unconfirmed');
    expect(wsInstances.length).toBe(4);
  });
});

describe('retrieve_confirmLoop', () => {
  it('confirms an unconfirmed series via storage without refiring', async () => {
    const t = task();
    t.status = 'pulled';
    t.lonkConfirmed = false;
    mockStorageResolve.mockResolvedValue(ok({ fileCount: 2, folderPath: '/SERVICES/PACS/x' }));
    expect(await retrieve_confirmLoop([t], 1, 'PACSDCM', fakeClient, {})).toBe(0);
    expect(t.lonkConfirmed).toBe(true);
    expect(t.cubePathDir).toBe('/SERVICES/PACS/x');
  });

  it('asks CUBE about a series the watch lost, and calls it pulled when it is there', async () => {
    // The defect this closes: a socket drop marked every in-flight series
    // failed, while the files were landing in CUBE the whole time.
    const t = task();
    t.status = 'unconfirmed';
    mockStorageResolve.mockResolvedValue(ok({ fileCount: 68, folderPath: '/SERVICES/PACS/y' }));

    expect(await retrieve_confirmLoop([t], 1, 'PACSDCM', fakeClient, {})).toBe(0);

    expect(t.status).toBe('pulled');
    expect(t.lonkConfirmed).toBe(true);
    expect(t.actualFiles).toBe(68);
    expect(t.cubePathDir).toBe('/SERVICES/PACS/y');
  });

  it('asks CUBE even with no retries, and a series found there is pulled, not errored', async () => {
    // The defect this closes: with retryMax 0 (what ARGUS runs) the check
    // sat inside a loop that never ran, so a PACS slow to begin sending
    // turned every series red while its files were landing in CUBE.
    const t = task();
    t.status = 'pulled';
    t.lonkConfirmed = false;
    mockStorageResolve.mockResolvedValue(ok({ fileCount: 131, folderPath: '/SERVICES/PACS/z' }));
    await retrieve_confirmLoop([t], 0, 'PACSDCM', fakeClient, {});
    expect(mockStorageResolve).toHaveBeenCalled();
    expect(t.status).toBe('pulled');
    expect(t.lonkConfirmed).toBe(true);
    expect(t.actualFiles).toBe(131);
  });

  it('with no retries, a series not yet in CUBE is unconfirmed with a reason, never an error', async () => {
    const t = task();
    t.status = 'unconfirmed';
    t.actualFiles = 1;
    mockStorageResolve.mockResolvedValue(ok({ fileCount: 0, folderPath: null }));
    const seen: string[] = [];
    await retrieve_confirmLoop([t], 0, 'PACSDCM', fakeClient, { task: (_t, status) => { seen.push(status); } });
    expect(t.status).toBe('unconfirmed');
    expect(t.reason).toMatch(/may still be sending/);
    expect(seen).toEqual(['unconfirmed']);
  });

  it('a series the PACS sent nothing of, and CUBE has none of, ends saying so', async () => {
    const t = task();
    t.status = 'pulled';
    t.lonkConfirmed = false;
    mockStorageResolve.mockResolvedValue(ok({ fileCount: 0, folderPath: null }));
    const seen: string[] = [];
    await retrieve_confirmLoop([t], 0, 'PACSDCM', fakeClient, { task: (_t, status) => { seen.push(status); } });
    expect(t.status).toBe('unconfirmed');
    expect(t.reason).toBe('the PACS sent nothing for 60 s and CUBE has none of it');
    expect(seen).toEqual(['unconfirmed']);
  });
});
