/**
 * @file What `/vfs` says of a file's bytes: never a type a browser runs,
 * always the type it was given, and a save for what would open as a
 * document. Asked of the function, and of a daemon on both of its paths
 * (a file read whole, a file streamed).
 */
import { get, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { CalypsoDaemon } from '../src/daemon/server';
import { VFS_CONTENT_POLICY, vfsHeaders_build } from '../src/daemon/vfsHeaders';
import type { HostedEngine } from '../src/daemon/engine';
import type { CommandEnvelope } from '@fnndsc/cumin';

const TOKEN: string = 'test-attach-token';

/** One file kind and what its bytes must be sent as. */
interface Expected {
  /** The file's name. */
  readonly name: string;
  /** The content type sent. */
  readonly type: string;
  /** Whether it is an attachment without being asked. */
  readonly saved: boolean;
}

const KINDS: ReadonlyArray<Expected> = [
  { name: 'page.html', type: 'application/octet-stream', saved: true },
  { name: 'PAGE.HTM', type: 'application/octet-stream', saved: true },
  { name: 'page.xhtml', type: 'application/octet-stream', saved: true },
  { name: 'code.js', type: 'application/octet-stream', saved: true },
  { name: 'code.mjs', type: 'application/octet-stream', saved: true },
  { name: 'look.css', type: 'application/octet-stream', saved: true },
  { name: 'mod.wasm', type: 'application/octet-stream', saved: true },
  { name: 'data.xml', type: 'application/octet-stream', saved: true },
  { name: 'sheet.xsl', type: 'application/octet-stream', saved: true },
  { name: 'drawing.svg', type: 'image/svg+xml', saved: true },
  { name: 'paper.pdf', type: 'application/pdf', saved: true },
  { name: 'brain.png', type: 'image/png', saved: false },
  { name: 'scan.dcm', type: 'application/octet-stream', saved: false },
  { name: 'notes.txt', type: 'text/plain; charset=utf-8', saved: false },
  { name: 'table.json', type: 'application/json; charset=utf-8', saved: false },
  { name: 'README', type: 'application/octet-stream', saved: false },
];

describe('vfsHeaders_build', () => {
  it.each(KINDS)('$name is sent as $type, with nosniff and the policy', ({ name, type, saved }: Expected) => {
    const headers: Record<string, string | number> = vfsHeaders_build(`/home/demo/${name}`, false, 9);
    expect(headers['content-type']).toBe(type);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(headers['content-length']).toBe(9);
    expect(typeof headers['content-disposition'] === 'string').toBe(saved);
    if (saved) expect(String(headers['content-disposition'])).toMatch(/^attachment; filename="/);
  });

  it('is an attachment for any file when a save was asked, and leaves the length out when unknown', () => {
    const headers: Record<string, string | number> = vfsHeaders_build('/home/demo/brain.png', true);
    expect(headers['content-disposition']).toBe(`attachment; filename="brain.png"; filename*=UTF-8''brain.png`);
    expect('content-length' in headers).toBe(false);
  });
});

/** An engine that has every file asked for, whole or as a stream. */
function engine_make(streamed: boolean): HostedEngine {
  const base: HostedEngine = {
    line_execute: async (line: string): Promise<CommandEnvelope[]> => [{ status: 'ok', rendered: `ran: ${line}` }],
    line_complete: async (prefix: string) => ({ candidates: [], prefix }),
    file_read: async (): Promise<Buffer> => Buffer.from('the-bytes'),
  };
  return streamed ? { ...base, file_stream: async () => ({ stream: Readable.from([Buffer.from('the-'), Buffer.from('bytes')]), size: 9 }) } : base;
}

/** Fetches a URL and answers its status, headers and body. */
function file_get(url: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    get(url, (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf-8') }));
    }).on('error', reject);
  });
}

describe.each([['read whole', false], ['streamed', true]])('a daemon serving /vfs, the file %s', (_label: string, streamed: boolean) => {
  let daemon: CalypsoDaemon;
  let port: number;

  beforeEach(async () => {
    daemon = new CalypsoDaemon({ engine: engine_make(streamed), token: TOKEN });
    port = await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
  });

  it.each(KINDS)('$name', async ({ name, type, saved }: Expected) => {
    const reply = await file_get(`http://127.0.0.1:${port}/vfs?path=${encodeURIComponent(`/home/demo/${name}`)}&token=${TOKEN}`);
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('the-bytes');
    expect(reply.headers['content-type']).toBe(type);
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
    expect(reply.headers['content-security-policy']).toBe(VFS_CONTENT_POLICY);
    expect(reply.headers['content-length']).toBe('9');
    expect(reply.headers['content-disposition'] !== undefined).toBe(saved);
  });

  it('a save that was asked for is an attachment, with the rest unchanged', async () => {
    const reply = await file_get(`http://127.0.0.1:${port}/vfs?path=${encodeURIComponent('/home/demo/brain.png')}&token=${TOKEN}&download=1`);
    expect(reply.headers['content-disposition']).toBe(`attachment; filename="brain.png"; filename*=UTF-8''brain.png`);
    expect(reply.headers['content-type']).toBe('image/png');
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
  });
});
