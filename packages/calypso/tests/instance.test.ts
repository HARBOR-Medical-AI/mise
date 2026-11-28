/**
 * @file The instance probe and its route: a record is believed only when the instance that wrote it answers.
 *
 * Every server here is this test's own, on loopback; no real service is contacted.
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as netServer, type Server as NetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { berthInstance_probe, instanceProof_compute, probeKey_generate, type Berth, type InstanceFacts } from '../src/daemon/berth.js';
import { instanceRequest_serve } from '../src/daemon/instance.js';

const servers: Array<Server | NetServer> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** A loopback HTTP server of this test's, answering with a handler; its port. */
async function server_start(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<number> {
  const server: Server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** A daemon's instance route for facts, recording each request's URL and headers. */
async function daemon_start(facts: InstanceFacts | null, seen: Array<{ url: string; headers: string }> = []): Promise<number> {
  return server_start((request: IncomingMessage, response: ServerResponse): void => {
    seen.push({ url: request.url ?? '', headers: JSON.stringify(request.headers) });
    instanceRequest_serve(request, response, facts);
  });
}

const IDENTITY: string = 'chris@http://cube/api/v1/';
const facts_of = (over: Partial<InstanceFacts> = {}): InstanceFacts => ({ probeKey: probeKey_generate(), identity: IDENTITY, pid: 4242, booted: '2026-11-28T10:00:00.000Z', ...over });
const record_of = (facts: InstanceFacts, port: number): Berth => ({ identity: facts.identity, url: `ws://127.0.0.1:${port}`, token: 'the-attach-token', pid: facts.pid, booted: facts.booted, probeKey: facts.probeKey });

/** A GET of a path on a port: its status. */
function status_get(port: number, path: string, method: string = 'GET'): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method }, (response: IncomingMessage) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject);
    request.end();
  });
}

describe('the instance probe', () => {
  it('a keyed record is live when its own instance answers; the request carries the nonce and nothing else of the record', async () => {
    const facts: InstanceFacts = facts_of();
    const seen: Array<{ url: string; headers: string }> = [];
    const port: number = await daemon_start(facts, seen);
    expect(await berthInstance_probe(record_of(facts, port))).toBe('live');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toMatch(/^\/instance\?nonce=[0-9a-f]{64}$/);
    const sent: string = `${seen[0]?.url ?? ''} ${seen[0]?.headers ?? ''}`;
    expect(sent).not.toContain('the-attach-token');
    expect(sent).not.toContain(facts.probeKey);
    expect(sent).not.toContain('cube');
    // A fresh nonce each time.
    await berthInstance_probe(record_of(facts, port));
    expect(seen[1]?.url).not.toBe(seen[0]?.url);
  });

  it('another instance at the same address is dead: another key, another pid, another boot, another identity', async () => {
    const facts: InstanceFacts = facts_of();
    for (const other of [facts_of(), { ...facts, pid: 4243 }, { ...facts, booted: '2026-11-28T10:00:01.000Z' }, { ...facts, identity: 'eve@http://cube/api/v1/' }]) {
      const port: number = await daemon_start(other);
      expect(await berthInstance_probe(record_of(facts, port))).toBe('dead');
    }
  });

  it('a proof for an earlier nonce is dead, as is any answer that is not a proof', async () => {
    const facts: InstanceFacts = facts_of();
    const replayed: string = instanceProof_compute(facts, 'b'.repeat(64));
    const answers: Array<[number, string]> = [[200, JSON.stringify({ proof: replayed })], [200, 'not json'], [200, JSON.stringify({ proof: 42 })], [401, ''], [404, 'not found'], [200, JSON.stringify({ proof: 'zz' })]];
    for (const [status, body] of answers) {
      const port: number = await server_start((_request: IncomingMessage, response: ServerResponse): void => {
        response.writeHead(status);
        response.end(body);
      });
      expect(await berthInstance_probe(record_of(facts, port))).toBe('dead');
    }
  });

  it('a keyed record whose address refuses, or never answers, is dead', async () => {
    const facts: InstanceFacts = facts_of();
    const port: number = await daemon_start(facts);
    await new Promise<void>((resolve) => (servers.pop() as Server).close(() => resolve()));
    expect(await berthInstance_probe(record_of(facts, port))).toBe('dead');
    const held: Array<import('node:net').Socket> = [];
    const silent: NetServer = netServer((socket) => { held.push(socket); });
    servers.push(silent);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    expect(await berthInstance_probe(record_of(facts, (silent.address() as AddressInfo).port))).toBe('dead');
    held.forEach((socket) => socket.destroy());
  }, 10000);

  it('an earlier release\'s record (no key): unverified when its address accepts, dead only when it refuses', async () => {
    const legacy = (port: number): Berth => ({ identity: IDENTITY, url: `ws://127.0.0.1:${port}`, token: 't', pid: 1 });
    const port: number = await server_start((_request: IncomingMessage, response: ServerResponse): void => { response.end(); });
    expect(await berthInstance_probe(legacy(port))).toBe('unverified');
    await new Promise<void>((resolve) => (servers.pop() as Server).close(() => resolve()));
    expect(await berthInstance_probe(legacy(port))).toBe('dead');
    // A name that does not resolve is inconclusive, so unverified, never dead.
    expect(await berthInstance_probe({ identity: IDENTITY, url: 'ws://no-such-host.invalid:9', token: 't' })).toBe('unverified');
  }, 10000);
});

describe('the instance route', () => {
  it('takes only GET and only a query of one nonce of 64 lowercase hex characters', async () => {
    const port: number = await daemon_start(facts_of());
    const nonce: string = 'c'.repeat(64);
    expect(await status_get(port, `/instance?nonce=${nonce}`)).toBe(200);
    expect(await status_get(port, `/instance?nonce=${nonce}`, 'POST')).toBe(405);
    for (const bad of ['/instance', '/instance?nonce=', `/instance?nonce=${'C'.repeat(64)}`, `/instance?nonce=${nonce}0`, `/instance?nonce=${nonce}&x=1`, `/instance?x=1&nonce=${nonce}`, `/instance?nonce=${nonce.slice(1)}`, `/instance?nonce=${nonce}%0a`]) {
      expect([bad, await status_get(port, bad)]).toEqual([bad, 400]);
    }
  });

  it('answers 404 before the record is written', async () => {
    const port: number = await daemon_start(null);
    expect(await status_get(port, `/instance?nonce=${'c'.repeat(64)}`)).toBe(404);
  });
});
