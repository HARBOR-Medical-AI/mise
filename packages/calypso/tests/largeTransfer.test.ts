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

/** The most a download may ever have in hand ahead of its reader, whatever the file's size. */
const READ_AHEAD_MAX_MIB: number = 24;

describe('a large download', () => {
  it.each([32, 128, 256])('of %d MiB streams: the bytes are right, nothing is read whole, and the read-ahead stays under one fixed bound', async (SIZE: number) => {
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
      /** The read-ahead: the furthest the source ever was ahead of what the reader had taken, in mebibytes. */
      let readAhead: number = 0;
      const status: number = await new Promise<number>((resolve, reject) => {
        const request: ClientRequest = httpRequest({ hostname: '127.0.0.1', port, path: `/vfs?path=${encodeURIComponent('/home/demo/big.bin')}&token=${TOKEN}&download=1` }, (response: IncomingMessage): void => {
          response.on('data', (chunk: Buffer): void => {
            got.update(chunk);
            received += chunk.length;
            readAhead = Math.max(readAhead, (file?.made() ?? 0) - received / MIB);
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
      // The read-ahead is what was in hand for the transfer at its worst (in the daemon, in the socket's
      // buffers, on the wire). One bound holds for every size: it does not grow with the file. A daemon that
      // gathered the file before sending it would have had the whole file in hand.
      expect(readAhead).toBeLessThan(READ_AHEAD_MAX_MIB);
    } finally {
      await daemon.stop();
    }
  }, 120_000);
});

interface Answer { status: number; body: string }

/** Posts a body of a stated length; `send` sends only so many of its bytes; `cut` then drops the connection, after `cutWhen` when given. */
function upload_post(port: number, name: string, length: number, how: { send?: number; cut?: boolean; cutWhen?: () => Promise<void> } = {}): Promise<Answer | 'cut'> {
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
      // Cut once what the test waits for has been seen (the bytes reserved), or at once.
      if (how.cut === true) void (how.cutWhen?.() ?? Promise.resolve()).then((): void => { request.destroy(); });
      else request.end();
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
  /** Writes held open by the test, each ended by calling its entry. */
  let waiting: Array<() => void>;
  let gated: boolean;
  const held = (): number => (daemon as unknown as { uploads: { held: number } }).uploads.held;
  const held_await = async (bytes: number): Promise<void> => {
    for (let i = 0; i < 400 && held() !== bytes; i++) await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    expect(held()).toBe(bytes);
  };

  beforeEach(async () => {
    written = [];
    failing = false;
    waiting = [];
    gated = false;
    daemon = new CalypsoDaemon({
      engine: {
        ...base,
        file_write: async (filePath: string, bytes: Buffer): Promise<void> => {
          if (gated) await new Promise<void>((resolve) => { waiting.push(resolve); });
          if (failing) throw new Error('CUBE refused the upload');
          written.push({ path: filePath, bytes: bytes.length });
        },
      },
      token: TOKEN,
      uploadHeld: SIZE,
    });
    port = await daemon.start();
  });
  afterEach(async () => {
    for (const end of waiting) end();
    await daemon.stop();
  });

  it('a body as large as the ceiling is reserved whole, lands whole, and is given back', async () => {
    gated = true;
    const landing = upload_post(port, 'big.bin', SIZE);
    // The whole of it is reserved, and stays reserved while CUBE takes it.
    await held_await(SIZE);
    for (let i = 0; i < 400 && waiting.length === 0; i++) await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    expect(held()).toBe(SIZE);
    gated = false;
    waiting[0]?.();
    expect(await landing).toMatchObject({ status: 200 });
    expect(written).toEqual([{ path: '/home/demo/big.bin', bytes: SIZE }]);
    await held_await(0);
    // Given back in full: the same again fits.
    expect(await upload_post(port, 'again.bin', SIZE)).toMatchObject({ status: 200 });
    await held_await(0);
  }, 120_000);

  it('while the ceiling is held, one more byte is told to come back (503); a length over the request\'s own limit is refused outright (413)', async () => {
    gated = true;
    const landing = upload_post(port, 'big.bin', SIZE);
    await held_await(SIZE);
    // The session holds as many uploaded bytes as it may.
    const noRoom = await upload_post(port, 'one.bin', 1);
    expect(noRoom).toMatchObject({ status: 503 });
    // A length no request may have, whatever is held.
    const tooLarge = await upload_post(port, 'huge.bin', VFS_POST_LIMIT + 1, { send: 0 });
    expect(tooLarge).toMatchObject({ status: 413 });
    expect(held()).toBe(SIZE);
    gated = false;
    for (let i = 0; i < 400 && waiting.length === 0; i++) await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    waiting[0]?.();
    expect(await landing).toMatchObject({ status: 200 });
    await held_await(0);
    expect(written).toEqual([{ path: '/home/demo/big.bin', bytes: SIZE }]);
  }, 120_000);

  it('an upload that fails at CUBE gives its bytes back', async () => {
    gated = true;
    failing = true;
    const failed = upload_post(port, 'big.bin', SIZE);
    await held_await(SIZE);
    for (let i = 0; i < 400 && waiting.length === 0; i++) await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    waiting[0]?.();
    expect(((await failed) as Answer).status).toBeGreaterThanOrEqual(400);
    await held_await(0);
    gated = false;
    failing = false;
    expect(await upload_post(port, 'big.bin', SIZE)).toMatchObject({ status: 200 });
  }, 120_000);

  it('an upload abandoned part way (the connection dropped) gives its bytes back, and nothing of it is written', async () => {
    const abandoned = upload_post(port, 'half.bin', SIZE, { send: SIZE / 2, cut: true, cutWhen: (): Promise<void> => held_await(SIZE) });
    expect(await abandoned).toBe('cut');
    await held_await(0);
    expect(written).toEqual([]);
    // The room is there again for a whole one.
    expect(await upload_post(port, 'whole.bin', SIZE)).toMatchObject({ status: 200 });
  }, 120_000);
});
