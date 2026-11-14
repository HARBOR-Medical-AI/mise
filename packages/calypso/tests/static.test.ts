import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { get, request as httpRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { CalypsoDaemon } from '../src/daemon/server';
import { bundledWebRoot_find, packageWebRoot_find, cacheControl_derive, contentDisposition_format, webRoot_resolve, webRootBuild_read, webRootVersion_read } from '../src/daemon/static';
import type { HostedEngine } from '../src/daemon/engine';
import { CONTRACT_VERSION } from '@fnndsc/menu';
import type { CommandEnvelope } from '@fnndsc/cumin';

const TOKEN = 'test-attach-token';

/** A stub engine sufficient for transport tests. */
function stubEngine_create(): HostedEngine {
  return {
    line_execute: async (line: string): Promise<CommandEnvelope[]> => [
      { status: 'ok', rendered: `ran: ${line}` },
    ],
    line_complete: async (prefix: string) => ({ candidates: [], prefix }),
  };
}

/** Fetches a URL and resolves with status, headers, and body. */
function http_get(url: string): Promise<{ status: number; type: string; cache: string; disposition: string; body: string }> {
  return new Promise((resolve, reject) => {
    get(url, (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          type: String(response.headers['content-type'] ?? ''),
          cache: String(response.headers['cache-control'] ?? ''),
          disposition: String(response.headers['content-disposition'] ?? ''),
          body: Buffer.concat(chunks).toString('utf-8'),
        }),
      );
    }).on('error', reject);
  });
}

/** Asks for a URL's headers alone (HEAD), as a download's probe does. */
function http_head(url: string): Promise<{ status: number; length: string; disposition: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'HEAD' }, (response: IncomingMessage) => {
      response.resume();
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        length: String(response.headers['content-length'] ?? ''),
        disposition: String(response.headers['content-disposition'] ?? ''),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

/** POSTs a body and reads the reply, for the delivery route. */
function http_post(url: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target: URL = new URL(url);
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: { 'content-length': Buffer.byteLength(body) },
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }),
        );
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

describe('webRoot_resolve', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'calypso-webroot-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('picks the first candidate holding an index.html', () => {
    writeFileSync(path.join(root, 'index.html'), '<html></html>');
    expect(webRoot_resolve([undefined, '/no/such/dir', root])).toBe(path.resolve(root));
  });

  it('refuses a directory without an index.html', () => {
    expect(webRoot_resolve([root])).toBeNull();
  });

  it('returns null with no candidates', () => {
    expect(webRoot_resolve([undefined, undefined])).toBeNull();
  });
});

describe('webRootVersion_read', () => {
  it('reads the version from the package.json beside the app\'s dist directory', () => {
    const app: string = mkdtempSync(path.join(tmpdir(), 'argus-app-'));
    try {
      mkdirSync(path.join(app, 'dist'));
      writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: '@fnndsc/argus', version: '0.6.0' }));
      expect(webRootVersion_read(path.join(app, 'dist'))).toBe('0.6.0');
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });

  it('says unknown when no manifest sits beside the web root', () => {
    const app: string = mkdtempSync(path.join(tmpdir(), 'argus-app-'));
    try {
      mkdirSync(path.join(app, 'dist'));
      expect(webRootVersion_read(path.join(app, 'dist'))).toBe('unknown');
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });
});

describe('webRootBuild_read', () => {
  it('reads the stamp the bundle carries, and nothing from a bundle without one', () => {
    const root: string = mkdtempSync(path.join(tmpdir(), 'argus-stamp-'));
    try {
      expect(webRootBuild_read(root)).toBeNull();
      writeFileSync(path.join(root, 'build.json'), JSON.stringify({ git: '7bedda5', built: '2026-10-03 14:20' }));
      expect(webRootBuild_read(root)).toEqual({ git: '7bedda5', built: '2026-10-03 14:20' });
      writeFileSync(path.join(root, 'build.json'), JSON.stringify({ git: 7 }));
      expect(webRootBuild_read(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('bundledWebRoot_find', () => {
  it('answers the same from any working directory', () => {
    const fromHere: string | null = bundledWebRoot_find();
    const original: string = process.cwd();
    try {
      process.chdir(tmpdir());
      expect(bundledWebRoot_find()).toBe(fromHere);
    } finally {
      process.chdir(original);
    }
  });

  it('answers an absolute bundle path or nothing at all', () => {
    const found: string | null = bundledWebRoot_find();
    const wellFormed: boolean =
      found === null ||
      (path.isAbsolute(found) && found.endsWith(path.join('apps', 'argus', 'dist')));
    expect(wellFormed).toBe(true);
  });
});

describe('packageWebRoot_find', () => {
  it('finds the bundle an installed package ships, and nothing for one without or not installed', () => {
    const root: string = mkdtempSync(path.join(tmpdir(), 'calypso-pkg-'));
    try {
      const shipped: string = path.join(root, 'node_modules', '@x', 'surface');
      mkdirSync(path.join(shipped, 'dist'), { recursive: true });
      writeFileSync(path.join(shipped, 'package.json'), JSON.stringify({ name: '@x/surface', version: '1.0.0' }));
      writeFileSync(path.join(shipped, 'dist', 'index.html'), '<html></html>');
      const bare: string = path.join(root, 'node_modules', '@x', 'bare');
      mkdirSync(bare, { recursive: true });
      writeFileSync(path.join(bare, 'package.json'), JSON.stringify({ name: '@x/bare', version: '1.0.0' }));
      const from: string = pathToFileURL(path.join(root, 'launcher.js')).href;
      expect(packageWebRoot_find('@x/surface', from)).toBe(path.join(shipped, 'dist'));
      expect(packageWebRoot_find('@x/bare', from)).toBeNull();
      expect(packageWebRoot_find('@x/absent', from)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the daemon names its backend before a surface builds', () => {
  it('answers /joblets with the joblets running, for the attach token only (#1273)', async () => {
    const engine = stubEngine_create();
    (engine as { joblets_running?: () => unknown[] }).joblets_running = () => [{ number: 1, line: 'pull pacs x', waiting: false }];
    const daemon = new CalypsoDaemon({ engine, token: TOKEN });
    const port: number = await daemon.start();
    try {
      const named = await http_get(`http://127.0.0.1:${port}/joblets?token=${TOKEN}`);
      expect(named.status).toBe(200);
      expect(JSON.parse(named.body)).toEqual({ joblets: [{ number: 1, line: 'pull pacs x', waiting: false }] });
      expect((await http_get(`http://127.0.0.1:${port}/joblets?token=wrong`)).status).toBe(404);
    } finally {
      await daemon.stop();
    }
  });

  it('answers /backend with the backend for the attach token, and nothing for any other', async () => {
    const daemon = new CalypsoDaemon({ engine: stubEngine_create(), token: TOKEN, backend: 'null' });
    const port: number = await daemon.start();
    try {
      const named = await http_get(`http://127.0.0.1:${port}/backend?token=${TOKEN}`);
      expect(named.status).toBe(200);
      expect(named.type).toContain('application/json');
      expect(JSON.parse(named.body)).toEqual({ backend: 'null' });
      expect((await http_get(`http://127.0.0.1:${port}/backend?token=wrong`)).status).toBe(404);
      expect((await http_get(`http://127.0.0.1:${port}/backend`)).status).toBe(404);
    } finally {
      await daemon.stop();
    }
    const unnamed = new CalypsoDaemon({ engine: stubEngine_create(), token: TOKEN });
    const port2: number = await unnamed.start();
    try {
      expect(JSON.parse((await http_get(`http://127.0.0.1:${port2}/backend?token=${TOKEN}`)).body)).toEqual({ backend: null });
    } finally {
      await unnamed.stop();
    }
  });
});

describe('CalypsoDaemon static serving', () => {
  let daemon: CalypsoDaemon;
  let port: number;
  let webRoot: string;

  beforeEach(async () => {
    webRoot = mkdtempSync(path.join(tmpdir(), 'calypso-static-'));
    writeFileSync(path.join(webRoot, 'index.html'), '<html>argus</html>');
    mkdirSync(path.join(webRoot, 'assets'));
    writeFileSync(path.join(webRoot, 'assets', 'app.js'), 'console.log("argus");');
    daemon = new CalypsoDaemon({ engine: stubEngine_create(), token: TOKEN, webRoot });
    port = await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    rmSync(webRoot, { recursive: true, force: true });
  });

  it('serves index.html at the root path, and tells the browser not to keep it', async () => {
    const reply = await http_get(`http://127.0.0.1:${port}/`);
    expect(reply.status).toBe(200);
    expect(reply.type).toContain('text/html');
    expect(reply.body).toContain('argus');
    // The header travels, not just the policy function: a rebuilt surface
    // reaches an operator who reloads, which it did not when this was
    // silent.
    expect(reply.cache).toBe('no-store');
  });

  it('serves nested assets with their content type', async () => {
    const reply = await http_get(`http://127.0.0.1:${port}/assets/app.js`);
    expect(reply.status).toBe(200);
    expect(reply.type).toContain('text/javascript');
  });

  it('ignores query strings when resolving files', async () => {
    const reply = await http_get(`http://127.0.0.1:${port}/?token=abc123`);
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('argus');
  });

  it('refuses path traversal outside the web root', async () => {
    const reply = await http_get(`http://127.0.0.1:${port}/..%2f..%2fetc%2fpasswd`);
    expect(reply.status).toBe(404);
  });

  it('404s a missing file', async () => {
    const reply = await http_get(`http://127.0.0.1:${port}/no-such-file.css`);
    expect(reply.status).toBe(404);
  });

  it('still accepts a WebSocket attach on the same port', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const attached = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once('error', reject);
      ws.once('open', () => {
        ws.send(JSON.stringify({ type: 'attach', protocolVersion: CONTRACT_VERSION, token: TOKEN }));
      });
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    expect(attached['type']).toBe('attached');
    ws.close();
  });
});

describe('contentDisposition_format', () => {
  it('names the attachment after the file, twice', () => {
    expect(contentDisposition_format('/home/demo/a b.csv')).toBe(`attachment; filename="a b.csv"; filename*=UTF-8''a%20b.csv`);
  });
  it('keeps the real name in filename* and a safe one in filename', () => {
    expect(contentDisposition_format('/home/demo/résumé "q".txt')).toBe(
      `attachment; filename="r_sum_ _q_.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22q%22.txt`,
    );
  });
});

describe('CalypsoDaemon /vfs route', () => {
  let daemon: CalypsoDaemon;
  let port: number;

  /** A stub engine that serves one known file through file_read. */
  function vfsEngine_create(): HostedEngine {
    return {
      ...stubEngine_create(),
      file_read: async (filePath: string): Promise<Buffer> => {
        if (filePath === '/home/demo/brain.png') {
          return Buffer.from('png-bytes');
        }
        throw new Error('no such file');
      },
    };
  }

  beforeEach(async () => {
    daemon = new CalypsoDaemon({ engine: vfsEngine_create(), token: TOKEN });
    port = await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
  });

  it('serves file bytes with the extension content type', async () => {
    const reply = await http_get(
      `http://127.0.0.1:${port}/vfs?path=${encodeURIComponent('/home/demo/brain.png')}&token=${TOKEN}`,
    );
    expect(reply.status).toBe(200);
    expect(reply.type).toContain('image/png');
    expect(reply.body).toBe('png-bytes');
  });

  it('refuses a bad token with 404', async () => {
    const reply = await http_get(
      `http://127.0.0.1:${port}/vfs?path=${encodeURIComponent('/home/demo/brain.png')}&token=wrong`,
    );
    expect(reply.status).toBe(404);
  });

  it('shows the bytes unless asked for a download', async () => {
    const shown = await http_get(
      `http://127.0.0.1:${port}/vfs?path=${encodeURIComponent('/home/demo/brain.png')}&token=${TOKEN}`,
    );
    expect(shown.disposition).toBe('');
    const saved = await http_get(
      `http://127.0.0.1:${port}/vfs?path=${encodeURIComponent('/home/demo/brain.png')}&token=${TOKEN}&download=1`,
    );
    expect(saved.status).toBe(200);
    expect(saved.body).toBe('png-bytes');
    expect(saved.disposition).toBe(`attachment; filename="brain.png"; filename*=UTF-8''brain.png`);
  });

  it('streams a file through file_stream when the engine has it, length in the header', async () => {
    const { Readable } = await import('node:stream');
    const reads: string[] = [];
    const streaming = new CalypsoDaemon({
      engine: {
        ...vfsEngine_create(),
        file_read: async (filePath: string): Promise<Buffer> => { reads.push(filePath); return Buffer.from('whole'); },
        file_stream: async (filePath: string) => {
          if (filePath !== '/home/demo/big.dcm') throw Object.assign(new Error('refused'), { status: 403, reason: 'not yours to read: CUBE refused the bytes (403)' });
          return { stream: Readable.from([Buffer.from('part1-'), Buffer.from('part2')]), size: 11 };
        },
      },
      token: TOKEN,
    });
    const streamPort: number = await streaming.start();
    try {
      const saved = await http_get(`http://127.0.0.1:${streamPort}/vfs?path=${encodeURIComponent('/home/demo/big.dcm')}&token=${TOKEN}&download=1`);
      expect(saved.status).toBe(200);
      expect(saved.body).toBe('part1-part2');
      expect(saved.disposition).toContain('filename="big.dcm"');
      // Nothing was read whole.
      expect(reads).toEqual([]);
      const refused = await http_get(`http://127.0.0.1:${streamPort}/vfs?path=${encodeURIComponent('/home/demo/other.dcm')}&token=${TOKEN}&download=1`);
      expect(refused.status).toBe(403);
      expect(refused.body).toContain('CUBE refused the bytes');
    } finally {
      await streaming.stop();
    }
  });

  it('a download with an id: the probe opens once, the save takes that stream, progress counts it', async () => {
    const { Readable } = await import('node:stream');
    let opens: number = 0;
    const streaming = new CalypsoDaemon({
      engine: {
        ...vfsEngine_create(),
        file_stream: async (filePath: string) => {
          if (filePath !== '/home/demo/big.dcm') throw Object.assign(new Error('refused'), { status: 403, reason: 'not yours to read: CUBE refused the bytes (403)' });
          opens += 1;
          return { stream: Readable.from([Buffer.from('part1-'), Buffer.from('part2')]), size: 11 };
        },
      },
      token: TOKEN,
    });
    const streamPort: number = await streaming.start();
    const base: string = `http://127.0.0.1:${streamPort}/vfs?path=${encodeURIComponent('/home/demo/big.dcm')}&token=${TOKEN}&download=1&dl=abc123`;
    const progress = async (id: string, verb: string = 'progress') => {
      const reply = await http_get(`http://127.0.0.1:${streamPort}/vfs?${verb}=${id}&token=${TOKEN}`);
      return { status: reply.status, report: JSON.parse(reply.body) as { phase: string; bytes: number; size?: number; reason?: string } };
    };
    try {
      const probed = await http_head(`${base}&probe=1`);
      expect(probed.status).toBe(200);
      expect(probed.length).toBe('11');
      expect(probed.disposition).toContain('filename="big.dcm"');
      expect((await progress('abc123')).report).toMatchObject({ phase: 'ready', bytes: 0, size: 11 });
      const saved = await http_get(base);
      expect(saved.body).toBe('part1-part2');
      // One request to CUBE for the probe and the save together.
      expect(opens).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await progress('abc123')).report).toMatchObject({ phase: 'done', bytes: 11, size: 11 });
      // A refusal is the download's answer too.
      await http_head(`http://127.0.0.1:${streamPort}/vfs?path=${encodeURIComponent('/home/demo/other.dcm')}&token=${TOKEN}&download=1&dl=xyz789&probe=1`);
      expect((await progress('xyz789')).report).toMatchObject({ phase: 'failed', reason: 'not yours to read: CUBE refused the bytes (403)' });
      // A held file can be stopped before the save comes for it.
      await http_head(`${base.replace('abc123', 'stop42')}&probe=1`);
      expect((await progress('stop42', 'cancel')).report).toMatchObject({ phase: 'cancelled' });
      expect((await progress('nothere')).status).toBe(404);
      expect((await progress('../etc')).status).toBe(404);
    } finally {
      await streaming.stop();
    }
  });

  describe('a file the engine hands over whole (a PACS file)', () => {
    /** A daemon whose one file comes back as `bytes` in the stream's place. */
    const wholeDaemon_start = async (bytes: unknown): Promise<{ daemon: CalypsoDaemon; port: number; lines: string[] }> => {
      const lines: string[] = [];
      const whole = new CalypsoDaemon({
        engine: { ...vfsEngine_create(), file_stream: async () => ({ stream: bytes as NodeJS.ReadableStream, size: 11 }) },
        token: TOKEN,
        log: (line: string): void => { lines.push(line); },
      });
      return { daemon: whole, port: await whole.start(), lines };
    };

    it('serves a Buffer whole, and the session lives on', async () => {
      const { daemon: whole, port: wholePort, lines } = await wholeDaemon_start(Buffer.from('dicom-bytes'));
      try {
        const url: string = `http://127.0.0.1:${wholePort}/vfs?path=${encodeURIComponent('/SERVICES/PACS/a/scan.dcm')}&token=${TOKEN}`;
        const first = await http_get(url);
        expect(first.status).toBe(200);
        expect(first.body).toBe('dicom-bytes');
        const again = await http_get(url);
        expect(again.status).toBe(200);
        expect(lines).toEqual([]);
      } finally {
        await whole.stop();
      }
    });

    it('serves a byte array and a web stream as they are', async () => {
      const { ReadableStream } = await import('node:stream/web');
      for (const bytes of [new Uint8Array(Buffer.from('dicom-bytes')), new ReadableStream({ start(controller): void { controller.enqueue(Buffer.from('dicom-bytes')); controller.close(); } })]) {
        const { daemon: whole, port: wholePort } = await wholeDaemon_start(bytes);
        try {
          const reply = await http_get(`http://127.0.0.1:${wholePort}/vfs?path=${encodeURIComponent('/home/demo/scan.dcm')}&token=${TOKEN}`);
          expect(reply.status).toBe(200);
          expect(reply.body).toBe('dicom-bytes');
        } finally {
          await whole.stop();
        }
      }
    });

    it('answers what is no stream with a 500 and a log line, and keeps serving', async () => {
      const { daemon: whole, port: wholePort, lines } = await wholeDaemon_start(42);
      try {
        const reply = await http_get(`http://127.0.0.1:${wholePort}/vfs?path=${encodeURIComponent('/home/demo/scan.dcm')}&token=${TOKEN}`);
        expect(reply.status).toBe(500);
        expect(reply.body).toMatch(/which is no stream/);
        expect(lines[0]).toMatch(/^\[!\] vfs: \/home\/demo\/scan\.dcm: the engine gave a file's bytes as number/);
        const again = await http_get(`http://127.0.0.1:${wholePort}/vfs?path=${encodeURIComponent('/home/demo/scan.dcm')}&token=${TOKEN}`);
        expect(again.status).toBe(500);
        expect(lines).toHaveLength(2);
      } finally {
        await whole.stop();
      }
    });
  });

  describe('a stream from CUBE that breaks', () => {
    /** A daemon whose one file streams `first` (when given) and then fails with `cause`. */
    const breakingDaemon_start = async (first: Buffer | null, cause: Error): Promise<{ daemon: CalypsoDaemon; port: number; lines: string[] }> => {
      const { Readable } = await import('node:stream');
      const lines: string[] = [];
      const breaking = new CalypsoDaemon({
        engine: {
          ...vfsEngine_create(),
          file_stream: async () => {
            const source = new Readable({ read(): void { /* pushed by hand */ } });
            if (first !== null) source.push(first);
            setTimeout((): void => { source.destroy(cause); }, 20);
            return { stream: source, size: 11 };
          },
        },
        token: TOKEN,
        log: (line: string): void => { lines.push(line); },
      });
      return { daemon: breaking, port: await breaking.start(), lines };
    };

    it('before its first byte: a 502 with the reason, and one log line', async () => {
      const { daemon: breaking, port: breakPort, lines } = await breakingDaemon_start(null, Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
      try {
        const reply = await http_get(`http://127.0.0.1:${breakPort}/vfs?path=${encodeURIComponent('/home/demo/scan.dcm')}&token=${TOKEN}`);
        expect(reply.status).toBe(502);
        expect(reply.body).toBe('the file did not arrive from CUBE: socket hang up');
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^\[!\] vfs: \/home\/demo\/scan\.dcm: the file stopped arriving from CUBE after 0 bytes of 11, \d+ ms in: socket hang up \[ECONNRESET\]$/);
      } finally {
        await breaking.stop();
      }
    });

    it('part way: the 200 is cut short, and the log line says how far it got', async () => {
      const { daemon: breaking, port: breakPort, lines } = await breakingDaemon_start(Buffer.from('part1-'), new Error('aborted'));
      try {
        const outcome = await new Promise<{ status: number; received: number; broke: boolean }>((resolve) => {
          get(`http://127.0.0.1:${breakPort}/vfs?path=${encodeURIComponent('/home/demo/scan.dcm')}&token=${TOKEN}`, (response: IncomingMessage) => {
            let received: number = 0;
            response.on('data', (chunk: Buffer) => { received += chunk.length; });
            response.on('end', () => resolve({ status: response.statusCode ?? 0, received, broke: false }));
            response.on('error', () => resolve({ status: response.statusCode ?? 0, received, broke: true }));
          });
        });
        expect(outcome).toEqual({ status: 200, received: 6, broke: true });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^\[!\] vfs: \/home\/demo\/scan\.dcm: the file stopped arriving from CUBE after 6 bytes of 11, \d+ ms in: aborted$/);
      } finally {
        await breaking.stop();
      }
    });
  });

  it('404s a read failure', async () => {
    const reply = await http_get(
      `http://127.0.0.1:${port}/vfs?path=${encodeURIComponent('/nope')}&token=${TOKEN}`,
    );
    expect(reply.status).toBe(404);
  });

  it('takes a posted file and hands the bytes to the engine', async () => {
    const written: Array<{ path: string; bytes: string }> = [];
    const taking = new CalypsoDaemon({
      engine: {
        ...stubEngine_create(),
        file_write: async (filePath: string, bytes: Buffer): Promise<void> => {
          written.push({ path: filePath, bytes: bytes.toString() });
        },
      },
      token: TOKEN,
    });
    const takingPort = await taking.start();
    try {
      const reply = await http_post(
        `http://127.0.0.1:${takingPort}/vfs?path=${encodeURIComponent('/home/demo/notes.txt')}&token=${TOKEN}`,
        'from a browser',
      );
      expect(reply.status).toBe(200);
      expect(written).toEqual([{ path: '/home/demo/notes.txt', bytes: 'from a browser' }]);
    } finally {
      await taking.stop();
    }
  });

  it('refuses a posted file with a bad token, and writes nothing', async () => {
    const written: string[] = [];
    const taking = new CalypsoDaemon({
      engine: {
        ...stubEngine_create(),
        file_write: async (filePath: string): Promise<void> => { written.push(filePath); },
      },
      token: TOKEN,
    });
    const takingPort = await taking.start();
    try {
      const reply = await http_post(`http://127.0.0.1:${takingPort}/vfs?path=/x&token=wrong`, 'x');
      expect(reply.status).toBe(404);
      expect(written).toEqual([]);
    } finally {
      await taking.stop();
    }
  });

  it('reports a refused write rather than claiming it landed', async () => {
    const taking = new CalypsoDaemon({
      engine: {
        ...stubEngine_create(),
        file_write: async (): Promise<void> => { throw new Error('the store said no'); },
      },
      token: TOKEN,
    });
    const takingPort = await taking.start();
    try {
      const reply = await http_post(`http://127.0.0.1:${takingPort}/vfs?path=/x&token=${TOKEN}`, 'x');
      expect(reply.status).toBe(502);
      expect(reply.body).toContain('the store said no');
    } finally {
      await taking.stop();
    }
  });

  it('404s a post when the engine offers no file_write', async () => {
    const reply = await http_post(
      `http://127.0.0.1:${port}/vfs?path=/x&token=${TOKEN}`,
      'x',
    );
    expect(reply.status).toBe(404);
  });

  it('404s when the engine offers no file_read', async () => {
    const bare = new CalypsoDaemon({ engine: stubEngine_create(), token: TOKEN });
    const barePort = await bare.start();
    try {
      const reply = await http_get(`http://127.0.0.1:${barePort}/vfs?path=/x&token=${TOKEN}`);
      expect(reply.status).toBe(404);
    } finally {
      await bare.stop();
    }
  });
});

describe('CalypsoDaemon without a web root', () => {
  it('404s plain HTTP while the wire still answers', async () => {
    const daemon = new CalypsoDaemon({ engine: stubEngine_create(), token: TOKEN });
    const port = await daemon.start();
    try {
      const reply = await http_get(`http://127.0.0.1:${port}/`);
      expect(reply.status).toBe(404);
    } finally {
      await daemon.stop();
    }
  });
});

/**
 * How long a browser may keep what the daemon serves.
 *
 * The defect this exists for: nothing said. With no `cache-control`, no
 * `etag` and no `last-modified`, a browser is free to guess and it guesses
 * that it may keep the page — so a rebuilt surface did not arrive at all.
 * The operator restarted the daemon, reloaded, and was served the same
 * `index.html`, which names the same old hashed assets, so the whole
 * surface stayed the previous build with nothing saying why.
 */
describe('cacheControl_derive', () => {
  it('never lets a browser keep the page that names the assets', () => {
    expect(cacheControl_derive('/web/index.html')).toBe('no-store');
    expect(cacheControl_derive('/web/INDEX.HTML')).toBe('no-store');
  });

  it('lets a hashed asset be kept forever, since a new build is a new name', () => {
    expect(cacheControl_derive('/web/assets/index-DaupQIyb.js')).toBe('public, max-age=31536000, immutable');
    expect(cacheControl_derive('/web/assets/theme-a1b2c3d4e5.css')).toBe('public, max-age=31536000, immutable');
  });

  it('makes anything else revalidate, which is the safe answer for a name that can be reused', () => {
    expect(cacheControl_derive('/web/favicon.ico')).toBe('no-cache');
    expect(cacheControl_derive('/web/fonts/Meslo.woff2')).toBe('no-cache');
  });
});
