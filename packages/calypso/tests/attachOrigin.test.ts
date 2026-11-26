/**
 * @file Where an attach came from: the daemon's own page and programs are
 * taken, a page from elsewhere is refused before a word is exchanged; and
 * a download is stopped by POST, never by a read.
 */
import { jest } from '@jest/globals';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { CalypsoDaemon } from '../src/daemon/server';
import { attachOrigin_allowed, attachOrigins_read } from '../src/daemon/attachOrigin';
import type { HostedEngine } from '../src/daemon/engine';
import type { CommandEnvelope } from '@fnndsc/cumin';

const TOKEN = 'test-attach-token';

/** A stub engine sufficient for transport tests. */
function stubEngine_create(): HostedEngine {
  return {
    line_execute: async (line: string): Promise<CommandEnvelope[]> => [{ status: 'ok', rendered: `ran: ${line}` }],
    line_complete: async (prefix: string) => ({ candidates: [], prefix }),
  };
}

/** Tries an attach and says how it ended. */
function attach_try(port: number, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const socket: WebSocket = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`, { headers });
    socket.once('open', () => { socket.close(); resolve('open'); });
    socket.once('unexpected-response', (_request: unknown, response: IncomingMessage) => { socket.terminate(); resolve(`refused ${response.statusCode}`); });
    socket.once('error', (error: Error) => resolve(`error ${error.message}`));
  });
}

/** Sends a request with no body and resolves with its status, `Allow` and body. */
function http_ask(method: string, url: string): Promise<{ status: number; allow: string; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method }, (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, allow: String(response.headers['allow'] ?? ''), body: Buffer.concat(chunks).toString('utf-8') }));
    });
    request.on('error', reject);
    request.end();
  });
}

describe('where an attach came from', () => {
  it('takes no origin, the daemon\'s own page, and a named origin; nothing else', () => {
    expect(attachOrigin_allowed(undefined, '127.0.0.1:4000', [])).toBe(true);
    expect(attachOrigin_allowed('http://127.0.0.1:4000', '127.0.0.1:4000', [])).toBe(true);
    expect(attachOrigin_allowed('http://pangea.example.org:4000', 'Pangea.example.org:4000', [])).toBe(true);
    // A port left off is the one the page's scheme means, on either side.
    expect(attachOrigin_allowed('http://pangea.example.org', 'pangea.example.org:80', [])).toBe(true);
    expect(attachOrigin_allowed('http://pangea.example.org', 'pangea.example.org', [])).toBe(true);
    expect(attachOrigin_allowed('https://pangea.example.org', 'pangea.example.org:443', [])).toBe(true);
    expect(attachOrigin_allowed('https://pangea.example.org', 'pangea.example.org', [])).toBe(true);
    expect(attachOrigin_allowed('https://pangea.example.org', 'pangea.example.org:80', [])).toBe(false);
    expect(attachOrigin_allowed('http://pangea.example.org', 'pangea.example.org:443', [])).toBe(false);
    expect(attachOrigin_allowed('http://pangea.example.org:8080', 'pangea.example.org', [])).toBe(false);
    expect(attachOrigin_allowed('http://[::1]:4000', '[::1]:4000', [])).toBe(true);
    // Only one origin, as a browser serializes it; a hand-written spelling of the right one is refused.
    for (const hand of ['HTTP://127.0.0.1:4000', 'http://127.0.0.1:4000/', ' http://127.0.0.1:4000', 'http://127.0.0.1:4000, http://127.0.0.1:4000', 'http://user@127.0.0.1:4000', 'http://Pangea.example.org:4000']) {
      expect([hand, attachOrigin_allowed(hand, hand.includes('angea') ? 'pangea.example.org:4000' : '127.0.0.1:4000', [])]).toEqual([hand, false]);
    }
    expect(attachOrigin_allowed(['http://127.0.0.1:4000', 'http://127.0.0.1:4000'], '127.0.0.1:4000', [])).toBe(false);
    // A Host that is more than a host is not compared at all.
    for (const host of ['127.0.0.1:4000/x', 'user@127.0.0.1:4000', '127.0.0.1:4000?x', 'not a host']) expect(attachOrigin_allowed('http://127.0.0.1:4000', host, [])).toBe(false);
    // Another port on this machine is another page: there is no pass for loopback.
    expect(attachOrigin_allowed('http://127.0.0.1:5173', '127.0.0.1:4000', [])).toBe(false);
    expect(attachOrigin_allowed('http://localhost:4000', '127.0.0.1:4000', [])).toBe(false);
    expect(attachOrigin_allowed('https://elsewhere.example', '127.0.0.1:4000', [])).toBe(false);
    expect(attachOrigin_allowed('null', '127.0.0.1:4000', [])).toBe(false);
    expect(attachOrigin_allowed('http://127.0.0.1:4000', undefined, [])).toBe(false);
    expect(attachOrigin_allowed('http://127.0.0.1:5173', '127.0.0.1:4000', ['http://127.0.0.1:5173'])).toBe(true);
  });

  it('reads the named origins from the environment, leaving out what is not one', () => {
    expect(attachOrigins_read({})).toEqual([]);
    expect(attachOrigins_read({ CALYPSO_ORIGINS: 'http://127.0.0.1:5173/, nonsense ,https://dev.example.org,http://127.0.0.1:5173' })).toEqual(['http://127.0.0.1:5173', 'https://dev.example.org']);
  });

  it('refuses an attach from another page though it holds the token, and takes the daemon\'s own page and a program', async () => {
    const errors: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((line?: unknown): void => { errors.push(String(line)); });
    const daemon = new CalypsoDaemon({ engine: stubEngine_create(), token: TOKEN });
    const port: number = await daemon.start();
    try {
      expect(await attach_try(port, {})).toBe('open');
      expect(await attach_try(port, { origin: `http://127.0.0.1:${port}` })).toBe('open');
      expect(await attach_try(port, { origin: 'https://elsewhere.example' })).toBe('refused 401');
      expect(await attach_try(port, { origin: `http://127.0.0.1:${port + 1}` })).toBe('refused 401');
      expect(await attach_try(port, { origin: 'null' })).toBe('refused 401');
      expect(errors.filter((line: string): boolean => line.includes('refused an attach from'))).toHaveLength(3);
    } finally {
      await daemon.stop();
      spy.mockRestore();
    }
  });

  it('takes an origin its operator named', async () => {
    const before: string | undefined = process.env['CALYPSO_ORIGINS'];
    process.env['CALYPSO_ORIGINS'] = 'http://127.0.0.1:5173';
    const spy = jest.spyOn(console, 'error').mockImplementation((): void => undefined);
    const daemon = new CalypsoDaemon({ engine: stubEngine_create(), token: TOKEN });
    const port: number = await daemon.start();
    try {
      expect(await attach_try(port, { origin: 'http://127.0.0.1:5173' })).toBe('open');
      expect(await attach_try(port, { origin: 'http://127.0.0.1:5174' })).toBe('refused 401');
    } finally {
      await daemon.stop();
      spy.mockRestore();
      if (before === undefined) delete process.env['CALYPSO_ORIGINS']; else process.env['CALYPSO_ORIGINS'] = before;
    }
  });
});

describe('a download\'s stop', () => {
  it('is a POST: a read of the same address stops nothing and is told so', async () => {
    const daemon = new CalypsoDaemon({ engine: stubEngine_create(), token: TOKEN });
    const port: number = await daemon.start();
    const ledger = (daemon as unknown as { downloads: { begin: (id: string, path: string) => void; report: (id: string) => { phase: string } | null } }).downloads;
    try {
      ledger.begin('dl-abc123', '/f');
      const base: string = `http://127.0.0.1:${port}/vfs?token=${TOKEN}`;
      for (const method of ['GET', 'HEAD']) {
        const read = await http_ask(method, `${base}&cancel=dl-abc123`);
        expect([method, read.status, read.allow]).toEqual([method, 405, 'POST']);
      }
      expect(ledger.report('dl-abc123')?.phase).toBe('opening');
      // Progress is a read, as before.
      const progress = await http_ask('GET', `${base}&progress=dl-abc123`);
      expect(progress.status).toBe(200);
      expect(JSON.parse(progress.body)).toMatchObject({ phase: 'opening' });
      const stopped = await http_ask('POST', `${base}&cancel=dl-abc123`);
      expect(stopped.status).toBe(200);
      expect(JSON.parse(stopped.body)).toMatchObject({ phase: 'cancelled' });
      expect((await http_ask('POST', `${base}&cancel=dl-nosuch`)).status).toBe(404);
      expect((await http_ask('POST', `http://127.0.0.1:${port}/vfs?token=wrong&cancel=dl-abc123`)).status).toBe(404);
      // One ask names one download for one purpose. A stop and a progress ask together, or either twice, is
      // refused before the ledger is touched: both downloads go on.
      ledger.begin('dl-one111', '/a');
      ledger.begin('dl-two222', '/b');
      for (const pair of ['progress=dl-one111&cancel=dl-two222', 'cancel=dl-two222&progress=dl-one111', 'cancel=dl-one111&cancel=dl-two222', 'progress=dl-one111&progress=dl-two222']) {
        for (const method of ['POST', 'GET']) expect([pair, method, (await http_ask(method, `${base}&${pair}`)).status]).toEqual([pair, method, 400]);
      }
      expect(ledger.report('dl-one111')?.phase).toBe('opening');
      expect(ledger.report('dl-two222')?.phase).toBe('opening');
    } finally {
      await daemon.stop();
    }
  });
});
