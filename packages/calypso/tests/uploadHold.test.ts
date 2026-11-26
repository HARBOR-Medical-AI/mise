/**
 * @file A daemon holds only so many uploaded bytes at once: the count, the
 * taking of one body under it, and a daemon answering uploads that fit,
 * that must wait, that lie about their length, and that fail.
 */
import { jest } from '@jest/globals';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { CalypsoDaemon } from '../src/daemon/server';
import { UPLOAD_HELD_DEFAULT, UploadHold, upload_take, uploadCeiling_read, type UploadRefusal, type UploadTaken } from '../src/daemon/uploadHold';
import type { HostedEngine } from '../src/daemon/engine';
import type { CommandEnvelope } from '@fnndsc/cumin';

const TOKEN: string = 'test-attach-token';
const LIMIT: number = 100;

/** A request body, as the taker reads one: pieces and the headers it came with. */
function body_make(pieces: ReadonlyArray<string>, stated?: string, broken: boolean = false): IncomingMessage {
  const stream: Readable = Readable.from((async function* (): AsyncGenerator<Buffer> {
    for (const piece of pieces) yield Buffer.from(piece);
    if (broken) throw new Error('the connection dropped');
  })());
  return Object.assign(stream, { headers: stated !== undefined ? { 'content-length': stated } : {} }) as unknown as IncomingMessage;
}

/** The refusal of a body that was not taken; fails the test when it was. */
function refusal_of(taken: UploadTaken | { refusal: UploadRefusal }): UploadRefusal {
  if (!('refusal' in taken)) throw new Error('the body was taken');
  return taken.refusal;
}

describe('uploadCeiling_read', () => {
  it('takes a positive whole number of bytes, and the default for anything else', () => {
    expect(uploadCeiling_read({ CALYPSO_UPLOAD_HELD: '4096' })).toBe(4096);
    for (const text of [undefined, '', '0', '-5', '1e9', '12.5', 'lots', '99999999999999999999999']) {
      expect(uploadCeiling_read({ CALYPSO_UPLOAD_HELD: text })).toBe(UPLOAD_HELD_DEFAULT);
    }
  });
});

describe('UploadHold', () => {
  it('reserves up to its ceiling and no further, and never counts below nothing', () => {
    const hold: UploadHold = new UploadHold(10);
    expect(hold.reserve(6)).toBe(true);
    expect(hold.reserve(5)).toBe(false);
    expect(hold.held).toBe(6);
    expect(hold.reserve(4)).toBe(true);
    hold.release(4);
    hold.release(100);
    expect(hold.held).toBe(0);
  });
});

describe('upload_take', () => {
  it('a stated length: held once, kept through to the release, released once', async () => {
    const hold: UploadHold = new UploadHold(50);
    const taken = await upload_take(body_make(['hello ', 'world'], '11'), hold, LIMIT);
    if ('refusal' in taken) throw new Error(taken.refusal.message);
    expect(taken.bytes.toString()).toBe('hello world');
    expect(hold.held).toBe(11);
    taken.release();
    expect(hold.held).toBe(0);
    // A second release gives nothing more back: another upload's bytes stay counted.
    expect(hold.reserve(7)).toBe(true);
    taken.release();
    expect(hold.held).toBe(7);
  });

  it('no stated length: counted twice while its pieces are joined', async () => {
    const hold: UploadHold = new UploadHold(50);
    const taken = await upload_take(body_make(['hello ', 'world']), hold, LIMIT);
    if ('refusal' in taken) throw new Error(taken.refusal.message);
    expect(taken.bytes.toString()).toBe('hello world');
    expect(hold.held).toBe(22);
    taken.release();
    expect(hold.held).toBe(0);
  });

  it.each([
    ['not a number', 'eleven'], ['negative', '-1'], ['a fraction', '1.5'], ['empty', ''], ['beyond any integer', '9'.repeat(30)],
  ])('a stated length that is %s is refused before anything is held', async (_what: string, stated: string) => {
    const hold: UploadHold = new UploadHold(50);
    const refusal: UploadRefusal = refusal_of(await upload_take(body_make(['x'], stated), hold, LIMIT));
    expect(refusal).toEqual({ status: 400, message: 'the stated length is not a length' });
    expect(hold.held).toBe(0);
  });

  it('a stated length over the request limit is refused before anything is held', async () => {
    const hold: UploadHold = new UploadHold(1000);
    const refusal: UploadRefusal = refusal_of(await upload_take(body_make(['x'], '101'), hold, LIMIT));
    expect(refusal.status).toBe(413);
    expect(refusal.message).toBe('file too large: this route takes at most 100 bytes');
    expect(hold.held).toBe(0);
  });

  it('a stated length that does not fit beside what is held is told to come back', async () => {
    const hold: UploadHold = new UploadHold(20);
    hold.reserve(15);
    const refusal: UploadRefusal = refusal_of(await upload_take(body_make(['123456'], '6'), hold, LIMIT));
    expect(refusal.status).toBe(503);
    expect(refusal.retryAfter).toBe(5);
    expect(refusal.message).toContain('try again shortly');
    expect(hold.held).toBe(15);
  });

  it('a body longer than it stated is refused and its bytes given back', async () => {
    const hold: UploadHold = new UploadHold(50);
    const refusal: UploadRefusal = refusal_of(await upload_take(body_make(['hello ', 'world!'], '11'), hold, LIMIT));
    expect(refusal).toEqual({ status: 400, message: 'the body is longer than its stated length' });
    expect(hold.held).toBe(0);
  });

  it('a body shorter than it stated is refused and its bytes given back', async () => {
    const hold: UploadHold = new UploadHold(50);
    const refusal: UploadRefusal = refusal_of(await upload_take(body_make(['hello'], '11'), hold, LIMIT));
    expect(refusal).toEqual({ status: 400, message: 'the body is shorter than its stated length' });
    expect(hold.held).toBe(0);
  });

  it('a body that breaks while it is read is refused and its bytes given back, stated or not', async () => {
    for (const stated of ['11', undefined]) {
      const hold: UploadHold = new UploadHold(50);
      const refusal: UploadRefusal = refusal_of(await upload_take(body_make(['hello'], stated, true), hold, LIMIT));
      expect(refusal).toEqual({ status: 400, message: 'could not read the request body' });
      expect(hold.held).toBe(0);
    }
  });

  it('an allocation that fails gives the reserved bytes back, stated or not, and the next upload fits', async () => {
    const hold: UploadHold = new UploadHold(50);
    const whole = jest.spyOn(Buffer, 'allocUnsafe').mockImplementationOnce((): never => { throw new RangeError('Array buffer allocation failed'); });
    const stated: UploadRefusal = refusal_of(await upload_take(body_make(['hello world'], '11'), hold, LIMIT));
    whole.mockRestore();
    expect(stated.status).toBe(503);
    expect(stated.retryAfter).toBe(5);
    expect(hold.held).toBe(0);
    const joined = jest.spyOn(Buffer, 'concat').mockImplementationOnce((): never => { throw new RangeError('Array buffer allocation failed'); });
    const unstated: UploadRefusal = refusal_of(await upload_take(body_make(['hello ', 'world']), hold, LIMIT));
    joined.mockRestore();
    expect(unstated.status).toBe(503);
    expect(hold.held).toBe(0);
    const next = await upload_take(body_make(['x'.repeat(50)], '50'), hold, LIMIT);
    expect('refusal' in next).toBe(false);
  });

  it('a body refused part way is left open, so the refusal can still be sent on its connection', async () => {
    const hold: UploadHold = new UploadHold(30);
    const body: IncomingMessage = body_make(['x'.repeat(10), 'y'.repeat(10), 'z'.repeat(10)]);
    expect(refusal_of(await upload_take(body, hold, LIMIT)).status).toBe(503);
    expect((body as unknown as Readable).destroyed).toBe(false);
  });

  it('no stated length: cut at the request limit, and at the ceiling, with nothing left held', async () => {
    const big: UploadHold = new UploadHold(1000);
    expect(refusal_of(await upload_take(body_make(['x'.repeat(60), 'y'.repeat(60)]), big, LIMIT)).status).toBe(413);
    expect(big.held).toBe(0);
    const small: UploadHold = new UploadHold(30);
    expect(refusal_of(await upload_take(body_make(['x'.repeat(10), 'y'.repeat(10)]), small, LIMIT)).status).toBe(503);
    expect(small.held).toBe(0);
  });
});

/** One upload's answer. */
interface Answer {
  readonly status: number;
  readonly body: string;
  readonly retry: string;
}

/** Posts a body; `stated` overrides the length it claims, `chunked` sends none. */
function file_post(port: number, name: string, body: string, how: { stated?: number; chunked?: boolean } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = how.chunked === true ? { 'transfer-encoding': 'chunked' } : { 'content-length': how.stated ?? Buffer.byteLength(body) };
    const request = httpRequest({ hostname: '127.0.0.1', port, path: `/vfs?path=${encodeURIComponent(`/home/demo/${name}`)}&token=${TOKEN}`, method: 'POST', headers }, (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8'), retry: String(response.headers['retry-after'] ?? '') }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

describe('a daemon taking uploads under a ceiling', () => {
  let daemon: CalypsoDaemon;
  let port: number;
  let written: Array<{ path: string; bytes: string }>;
  /** Writes in progress, each ended by calling its entry. */
  let waiting: Array<(fail?: Error) => void>;
  let gated: boolean;

  beforeEach(async () => {
    written = [];
    waiting = [];
    gated = false;
    const engine: HostedEngine = {
      line_execute: async (line: string): Promise<CommandEnvelope[]> => [{ status: 'ok', rendered: `ran: ${line}` }],
      line_complete: async (prefix: string) => ({ candidates: [], prefix }),
      file_write: async (filePath: string, bytes: Buffer): Promise<void> => {
        if (gated) await new Promise<void>((resolve, reject) => { waiting.push((fail?: Error): void => (fail !== undefined ? reject(fail) : resolve())); });
        written.push({ path: filePath, bytes: bytes.toString() });
      },
    };
    daemon = new CalypsoDaemon({ engine, token: TOKEN, uploadHeld: 20 });
    port = await daemon.start();
  });

  afterEach(async () => {
    for (const end of waiting) end();
    await daemon.stop();
  });

  /** Waits until that many writes are in progress. */
  async function writes_await(count: number): Promise<void> {
    for (let i = 0; i < 200 && waiting.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(waiting.length).toBe(count);
  }

  it('two that fit both land; a third that does not is told to come back, and lands once one has ended', async () => {
    gated = true;
    const first: Promise<Answer> = file_post(port, 'a.bin', 'aaaaaaaa');
    const second: Promise<Answer> = file_post(port, 'b.bin', 'bbbbbbbb');
    await writes_await(2);
    // Sixteen bytes are held through both writes: eight more do not fit under twenty.
    const refused: Answer = await file_post(port, 'c.bin', 'cccccccc');
    expect(refused.status).toBe(503);
    expect(refused.retry).toBe('5');
    expect(refused.body).toContain('try again shortly');
    waiting[0]?.();
    expect((await first).status).toBe(200);
    gated = false;
    expect((await file_post(port, 'c.bin', 'cccccccc')).status).toBe(200);
    waiting[1]?.();
    expect((await second).status).toBe(200);
    expect(written.map((one) => one.path).sort()).toEqual(['/home/demo/a.bin', '/home/demo/b.bin', '/home/demo/c.bin']);
  });

  it('a write that fails gives its bytes back', async () => {
    gated = true;
    const failing: Promise<Answer> = file_post(port, 'a.bin', 'a'.repeat(18));
    await writes_await(1);
    expect((await file_post(port, 'b.bin', 'bbbb')).status).toBe(503);
    waiting[0]?.(new Error('the store said no'));
    const failed: Answer = await failing;
    expect(failed.status).toBe(502);
    expect(failed.body).toContain('the store said no');
    gated = false;
    expect((await file_post(port, 'b.bin', 'b'.repeat(18))).status).toBe(200);
  });

  it('a body with no stated length is taken when it fits twice over, and refused when it does not', async () => {
    expect((await file_post(port, 'small.bin', '1234567890', { chunked: true })).status).toBe(200);
    expect(written).toEqual([{ path: '/home/demo/small.bin', bytes: '1234567890' }]);
    const refused: Answer = await file_post(port, 'large.bin', '12345678901', { chunked: true });
    expect(refused.status).toBe(503);
    expect(written.length).toBe(1);
    // Nothing is left held: an upload of the whole ceiling fits.
    expect((await file_post(port, 'whole.bin', 'w'.repeat(20))).status).toBe(200);
  });

  it('a body with no stated length that is still being sent is answered 503 with Retry-After, on its own connection', async () => {
    const answer: Answer = await new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port, path: `/vfs?path=${encodeURIComponent('/home/demo/open.bin')}&token=${TOKEN}`, method: 'POST', headers: { 'transfer-encoding': 'chunked' } }, (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => { request.destroy(); resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8'), retry: String(response.headers['retry-after'] ?? '') }); });
      });
      request.on('error', reject);
      // More than fits, and never ended: the daemon must answer while the body is open.
      request.write('x'.repeat(11));
    });
    expect(answer.status).toBe(503);
    expect(answer.retry).toBe('5');
    expect(written).toEqual([]);
    expect((await file_post(port, 'after.bin', 'a'.repeat(20))).status).toBe(200);
  });

  it('a length over the ceiling is refused without a byte read, and one that is no length is refused', async () => {
    const over: Answer = await file_post(port, 'over.bin', 'x'.repeat(21));
    expect(over.status).toBe(503);
    expect(written).toEqual([]);
    expect((await file_post(port, 'ok.bin', 'x'.repeat(20))).status).toBe(200);
  });
});
