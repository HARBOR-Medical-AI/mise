/**
 * @file Acceptance: a large transfer, each way, through a real daemon.
 *
 * The two directions differ by design. A download streams: the daemon
 * hands the engine's stream to the response and holds none of it, so what
 * it has in hand does not grow with the file. An upload is held whole on
 * purpose (CUBE's upload takes a buffer), so what is checked is its
 * reservation against the daemon's ceiling and that the reservation is
 * given back when the upload ends: landed, failed, or abandoned.
 *
 * The engine is a stand-in that makes bytes as they are asked for and
 * counts how far ahead of the reader it was ever asked to run: that
 * distance is what the transfer held at its worst. No CUBE.
 *
 * @module
 */
import { createHash } from 'node:crypto';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { CalypsoDaemon, VFS_POST_LIMIT } from '../src/daemon/server';
import type { HostedEngine } from '../src/daemon/engine';
import type { CommandEnvelope } from '@fnndsc/cumin';

const TOKEN: string = 'test-attach-token';
const MIB: number = 1024 * 1024;

/** The bytes of a made-up file: piece `n` is one mebibyte of the byte `n mod 251`. */
function piece_make(at: number): Buffer {
  return Buffer.alloc(MIB, at % 251);
}

/** A stream of so many mebibytes, each made only when the reader asks for it; counts what it has made. */
function file_make(mebibytes: number): { stream: Readable; made: () => number } {
  let made: number = 0;
  const stream: Readable = new Readable({
    highWaterMark: MIB,
    read(): void {
      if (made >= mebibytes) { this.push(null); return; }
      this.push(piece_make(made));
      made += 1;
    },
  });
  return { stream, made: (): number => made };
}

const base: HostedEngine = {
  line_execute: async (line: string): Promise<CommandEnvelope[]> => [{ status: 'ok', rendered: `ran: ${line}` }],
  line_complete: async (prefix: string) => ({ candidates: [], prefix }),
};

describe('a large download', () => {
  it('streams: the bytes are right, nothing is read whole, and the daemon never runs far ahead of the reader', async () => {
    const SIZE: number = 192;
    let file: ReturnType<typeof file_make> | null = null;
    const whole: string[] = [];
    const daemon: CalypsoDaemon = new CalypsoDaemon({
      engine: {
        ...base,
        file_read: async (filePath: string): Promise<Buffer> => { whole.push(filePath); return Buffer.alloc(0); },
        file_stream: async () => { file = file_make(SIZE); return { stream: file.stream, size: SIZE * MIB }; },
      },
      token: TOKEN,
    });
    const port: number = await daemon.start();
    try {
      const expected = createHash('sha256');
      for (let at = 0; at < SIZE; at++) expected.update(piece_make(at));
      const got = createHash('sha256');
      let received: number = 0;
      /** The furthest the source ever was ahead of what the reader had taken, in mebibytes. */
      let furthestAhead: number = 0;
      const status: number = await new Promise<number>((resolve, reject) => {
        const request: ClientRequest = httpRequest({ hostname: '127.0.0.1', port, path: `/vfs?path=${encodeURIComponent('/home/demo/big.bin')}&token=${TOKEN}&download=1` }, (response: IncomingMessage): void => {
          response.on('data', (chunk: Buffer): void => {
            got.update(chunk);
            received += chunk.length;
            furthestAhead = Math.max(furthestAhead, (file?.made() ?? 0) - received / MIB);
            // A reader slower than the source: every so often it stops taking for a moment.
            if (received % (16 * MIB) < chunk.length) { response.pause(); setTimeout((): void => { response.resume(); }, 5); }
          });
          response.on('end', (): void => { resolve(response.statusCode ?? 0); });
          response.on('error', reject);
        });
        request.on('error', reject);
        request.end();
      });
      expect(status).toBe(200);
      expect(received).toBe(SIZE * MIB);
      expect(got.digest('hex')).toBe(expected.digest('hex'));
      // Never read whole.
      expect(whole).toEqual([]);
      // The source was asked for bytes as the reader took them: at no time was it more than a small part of
      // the file ahead. A daemon that gathered the file before sending it would have been the whole file ahead.
      // That distance is what was in hand for the transfer at its worst (in the daemon, in the socket's
      // buffers, on the wire): it is the measure of what the transfer held, and it does not grow with the
      // file. (The process's own memory figures are not used: they count buffers already let go and not yet
      // collected, the test's own included.)
      expect(furthestAhead).toBeLessThan(SIZE / 4);
    } finally {
      await daemon.stop();
    }
  }, 60_000);
});

interface Answer { status: number; body: string }

/** Posts a body of a stated length; `cut` ends the connection after so many bytes are sent. */
function upload_post(port: number, name: string, length: number, how: { send?: number; cut?: boolean } = {}): Promise<Answer | 'cut'> {
  return new Promise((resolve, reject) => {
    const request: ClientRequest = httpRequest({ hostname: '127.0.0.1', port, path: `/vfs?path=${encodeURIComponent(`/home/demo/${name}`)}&token=${TOKEN}`, method: 'POST', headers: { 'content-length': length } }, (response: IncomingMessage): void => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer): void => { chunks.push(chunk); });
      response.on('end', (): void => { resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }); });
    });
    request.on('error', (error: Error): void => { if (how.cut === true) resolve('cut'); else reject(error); });
    const send: number = how.send ?? length;
    let sent: number = 0;
    const more = (): void => {
      while (sent < send) {
        const size: number = Math.min(MIB, send - sent);
        sent += size;
        if (!request.write(Buffer.alloc(size, 7))) { request.once('drain', more); return; }
      }
      if (how.cut === true) request.destroy(); else request.end();
    };
    if (send === 0 && how.cut !== true) request.end(); else more();
  });
}

describe('a large upload', () => {
  /** A daemon whose ceiling is one upload of this size, and the bytes it holds now. */
  const SIZE: number = 32 * MIB;
  let daemon: CalypsoDaemon;
  let port: number;
  let written: Array<{ path: string; bytes: number }>;
  let failing: boolean;
  const held = (): number => (daemon as unknown as { uploads: { held: number } }).uploads.held;
  const settled = async (): Promise<void> => { for (let i = 0; i < 200 && held() !== 0; i++) await new Promise<void>((resolve) => { setTimeout(resolve, 10); }); };

  beforeEach(async () => {
    written = [];
    failing = false;
    daemon = new CalypsoDaemon({
      engine: {
        ...base,
        file_write: async (filePath: string, bytes: Buffer): Promise<void> => {
          if (failing) throw new Error('CUBE refused the upload');
          written.push({ path: filePath, bytes: bytes.length });
        },
      },
      token: TOKEN,
      uploadHeld: SIZE,
    });
    port = await daemon.start();
  });
  afterEach(async () => { await daemon.stop(); });

  it('a body as large as the ceiling is reserved whole, lands whole, and is given back', async () => {
    const landed = await upload_post(port, 'big.bin', SIZE);
    expect(landed).toMatchObject({ status: 200 });
    expect(written).toEqual([{ path: '/home/demo/big.bin', bytes: SIZE }]);
    await settled();
    expect(held()).toBe(0);
    // Given back in full: the same again fits.
    expect(await upload_post(port, 'again.bin', SIZE)).toMatchObject({ status: 200 });
    await settled();
    expect(held()).toBe(0);
  }, 60_000);

  it('one byte more than the ceiling does not fit, and is told so before it is read', async () => {
    const refused = await upload_post(port, 'over.bin', SIZE + 1, { send: 0, cut: false }).catch((): 'cut' => 'cut');
    expect(refused === 'cut' || (refused as Answer).status === 503 || (refused as Answer).status === 413).toBe(true);
    expect(written).toEqual([]);
    expect(held()).toBe(0);
  }, 60_000);

  it('a length over the request\'s own limit is refused without a byte being taken', async () => {
    const refused = await upload_post(port, 'huge.bin', VFS_POST_LIMIT + 1, { send: 0, cut: false }).catch((): 'cut' => 'cut');
    expect(refused === 'cut' || (refused as Answer).status === 413).toBe(true);
    expect(written).toEqual([]);
    expect(held()).toBe(0);
  }, 60_000);

  it('an upload that fails at CUBE gives its bytes back', async () => {
    failing = true;
    const failed = await upload_post(port, 'big.bin', SIZE);
    expect((failed as Answer).status).toBeGreaterThanOrEqual(400);
    await settled();
    expect(held()).toBe(0);
    failing = false;
    expect(await upload_post(port, 'big.bin', SIZE)).toMatchObject({ status: 200 });
  }, 60_000);

  it('an upload abandoned part way (the connection dropped) gives its bytes back, and nothing of it is written', async () => {
    expect(await upload_post(port, 'half.bin', SIZE, { send: SIZE / 2, cut: true })).toBe('cut');
    await settled();
    expect(held()).toBe(0);
    expect(written).toEqual([]);
    // The room is there again for a whole one.
    expect(await upload_post(port, 'whole.bin', SIZE)).toMatchObject({ status: 200 });
  }, 60_000);
});
