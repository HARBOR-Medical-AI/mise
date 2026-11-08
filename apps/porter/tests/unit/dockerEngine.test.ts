/**
 * @file The launcher's wire to the engine, and porter's host to the
 * launcher, each against a fake on the other end: an in-process Engine API
 * on a unix socket (containers, networks, volumes, a hijacked exec stream),
 * a CUBE that names its user, and a launcher that records what porter asks.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { berthKey_compute, identity_normalise } from '@fnndsc/calypso/berth';
import { DOCKER_API, DockerSocket } from '../../src/launcher/docker.js';
import { BERTH_LABEL, BerthLauncher, berthNames_derive } from '../../src/launcher/launcher.js';
import { BERTH_LIMITS_DEFAULT } from '../../src/launcher/policy.js';
import { LauncherHost, cubeUserId_read, launcher_call } from '../../src/host/launcherHost.js';

const CUBE: string = 'http://cube.example.org/api/v1/';

/** One frame of the engine's multiplexed stream. */
function frame(kind: number, text: string): Buffer {
  const size: Buffer = Buffer.alloc(4);
  size.writeUInt32BE(Buffer.byteLength(text));
  return Buffer.concat([Buffer.from([kind, 0, 0, 0]), size, Buffer.from(text)]);
}

/** A body read whole. */
function body_read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => { const chunks: Buffer[] = []; req.on('data', (c: Buffer) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8'))); });
}

/**
 * An engine in a process: what the launcher asks of Docker, answered as
 * Docker would, the exec stream hijacked and multiplexed.
 */
class FakeEngine {
  readonly server: Server;
  readonly containers: Map<string, { body: Record<string, unknown>; running: boolean }> = new Map();
  readonly networks: Map<string, Set<string>> = new Map();
  readonly volumes: Set<string> = new Set();
  readonly execs: Map<string, { container: string; body: Record<string, unknown>; stdin: string }> = new Map();
  /** Berths whose session died as it started. */
  dead: Set<string> = new Set();
  private execSerial: number = 0;

  constructor() {
    this.server = createServer((req: IncomingMessage, res: ServerResponse): void => { void this.answer(req, res); });
    this.server.on('upgrade', (req: IncomingMessage, socket: Socket): void => { this.hijack(req, socket); });
  }

  private async answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url: URL = new URL(req.url ?? '/', 'http://engine');
    const path: string = url.pathname.replace(DOCKER_API, '');
    const parts: string[] = path.split('/');
    const name: string = decodeURIComponent(parts[2] ?? '');
    const text: string = await body_read(req);
    const body: Record<string, unknown> = text === '' ? {} : JSON.parse(text) as Record<string, unknown>;
    const send = (status: number, payload?: unknown, raw?: Buffer): void => {
      if (raw !== undefined) { res.writeHead(status, { 'Content-Type': 'application/vnd.docker.raw-stream' }); res.end(raw); return; }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(payload === undefined ? '' : JSON.stringify(payload));
    };
    if (path === '/info') return send(200, { NCPU: 8, MemTotal: 32 * 1024 ** 3 });
    if (path === '/networks/create') { this.networks.set(String(body['Name']), new Set()); return send(201, { Id: body['Name'] }); }
    if (parts[1] === 'networks' && parts[3] === 'connect') { this.networks.get(name)?.add(String(body['Container'])); return send(200); }
    if (parts[1] === 'networks' && parts[3] === 'disconnect') { this.networks.get(name)?.delete(String(body['Container'])); return send(200); }
    if (parts[1] === 'networks' && req.method === 'DELETE') return send(this.networks.delete(name) ? 204 : 404, { message: 'no such network' });
    if (parts[1] === 'networks' && name !== '') return this.networks.has(name) ? send(200, { Name: name, Containers: {} }) : send(404, { message: 'no such network' });
    if (path === '/volumes/create') { this.volumes.add(String(body['Name'])); return send(201, { Name: body['Name'] }); }
    if (parts[1] === 'volumes') return send(this.volumes.has(name) ? 200 : 404, {});
    if (path === '/containers/json') {
      return send(200, [...this.containers.entries()].map(([one, each]) => ({ Names: [`/${one}`], Labels: each.body['Labels'] ?? {}, State: each.running ? 'running' : 'exited' })));
    }
    if (path === '/containers/create') {
      const made: string = url.searchParams.get('name') ?? '';
      if (made === 'refused') return send(400, { message: 'the engine refuses this one' });
      this.containers.set(made, { body, running: false });
      for (const net of Object.keys((body['NetworkingConfig'] as { EndpointsConfig?: Record<string, unknown> } | undefined)?.EndpointsConfig ?? {})) this.networks.get(net)?.add(made);
      return send(201, { Id: made });
    }
    const found = this.containers.get(name);
    if (parts[1] === 'containers' && parts[3] === 'exec') {
      if (found === undefined) return send(404, { message: 'no such container' });
      const id: string = `exec-${++this.execSerial}`;
      this.execs.set(id, { container: name, body, stdin: '' });
      return send(201, { Id: id });
    }
    if (parts[1] === 'exec' && parts[3] === 'json') return send(200, { ExitCode: this.execs.get(name)?.container === 'failing' ? 3 : 0 });
    if (parts[1] === 'exec' && parts[3] === 'start') {
      // An engine that does not upgrade: the stream is the body.
      return send(200, undefined, Buffer.concat([frame(1, 'plain '), frame(1, 'body')]));
    }
    if (found === undefined && parts[1] === 'containers') return send(404, { message: 'no such container' });
    if (parts[3] === 'json') {
      const wire: string = String((found?.body['HostConfig'] as Record<string, unknown> | undefined)?.['NetworkMode'] ?? '');
      const running: boolean = (found?.running ?? false) && !this.dead.has(name);
      return send(200, { State: { Running: running }, Config: { User: found?.body['User'], Labels: found?.body['Labels'] ?? {} }, NetworkSettings: { Networks: { [wire]: { IPAddress: '10.9.0.2' } } } });
    }
    if (parts[3] === 'start') { if (found !== undefined) found.running = true; return send(204); }
    if (parts[3] === 'stop') { if (found !== undefined) found.running = false; return send(204); }
    if (parts[3] === 'wait') { if (found !== undefined) found.running = false; return send(200, { StatusCode: 0 }); }
    if (parts[3] === 'logs') return send(200, undefined, Buffer.concat([frame(1, 'starting\n'), frame(2, 'boom: the session died\n')]));
    if (req.method === 'DELETE') { for (const members of this.networks.values()) members.delete(name); return send(this.containers.delete(name) ? 204 : 404, {}); }
    send(404, { message: `unknown ${req.method ?? ''} ${path}` });
  }

  /** The hijacked exec stream: its stdin read, its answer by what the command is. */
  private hijack(req: IncomingMessage, socket: Socket): void {
    const id: string = (req.url ?? '').split('/')[3] ?? '';
    const exec = this.execs.get(id);
    socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    const cmd: string = Array.isArray(exec?.body['Cmd']) ? (exec?.body['Cmd'] as string[]).join(' ') : '';
    if (exec !== undefined && cmd.includes('berth-')) {
      const identity: string = String(((this.containers.get(exec.container)?.body['Labels'] as Record<string, string> | undefined) ?? {})[`${BERTH_LABEL}.identity`] ?? '');
      socket.write(frame(1, JSON.stringify({ identity, url: 'ws://inside:40000', token: `attach-${exec.container}` })));
    }
    if (exec !== undefined && cmd === 'echo') socket.write(Buffer.concat([frame(1, 'out\n'), frame(2, 'err\n')]));
    socket.on('data', (chunk: Buffer): void => { if (exec !== undefined) exec.stdin += chunk.toString('utf-8'); });
    socket.on('end', (): void => { socket.end(); });
    socket.on('error', (): void => undefined);
  }
}

describe('the engine over its socket', () => {
  let dir: string;
  let engine: FakeEngine;
  let docker: DockerSocket;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'engine-'));
    engine = new FakeEngine();
    await new Promise<void>((resolve) => { engine.server.listen(join(dir, 'docker.sock'), resolve); });
    docker = new DockerSocket(join(dir, 'docker.sock'));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => { engine.server.close(() => resolve()); });
    rmSync(dir, { recursive: true, force: true });
  });

  it('calls the API: JSON in and out, an empty answer as null, a raw stream as text, and an engine that is not there as an error', async () => {
    expect(await docker.call('GET', '/info')).toEqual({ status: 200, body: { NCPU: 8, MemTotal: 32 * 1024 ** 3 } });
    expect(await docker.call('POST', '/containers/create?name=c1', { Image: 'img', Labels: {} })).toEqual({ status: 201, body: { Id: 'c1' } });
    expect(await docker.call('POST', '/containers/c1/start')).toEqual({ status: 204, body: null });
    expect((await docker.call('GET', '/containers/c1/logs')).body).toContain('boom: the session died');
    expect(await docker.call('GET', '/networks/nope')).toMatchObject({ status: 404 });
    expect((await docker.bytes_get('/containers/c1/logs')).length).toBeGreaterThan(16);
    expect(await docker.call('DELETE', '/containers/c1')).toMatchObject({ status: 204 });
    await expect(new DockerSocket(join(dir, 'absent.sock')).call('GET', '/info')).rejects.toThrow();
  });

  it('runs a command in a container on a hijacked stream: the input on stdin, the output demuxed, the exit code read; a plain answer is taken as the stream too', async () => {
    await docker.call('POST', '/containers/create?name=c2', { Image: 'img' });
    const echoed = await docker.exec('c2', ['echo'], '7:7', 'the token\n');
    expect(echoed).toEqual({ code: 0, stdout: 'out\n', stderr: 'err\n' });
    const exec = [...engine.execs.values()].find((one) => one.container === 'c2');
    expect(exec).toMatchObject({ body: { User: '7:7', AttachStdin: true, Cmd: ['echo'] }, stdin: 'the token\n' });
    await expect(docker.exec('nowhere', ['true'], '7:7', null)).rejects.toThrow('the engine answered 404');
    // An exec start the engine answers without upgrading (no hijack): the body is the stream.
    const plain = new DockerSocket(join(dir, 'docker.sock'));
    const original = engine.server.listeners('upgrade');
    engine.server.removeAllListeners('upgrade');
    try {
      await docker.call('POST', '/containers/create?name=failing', { Image: 'img' });
      expect(await plain.exec('failing', ['false'], '0:0', null)).toEqual({ code: 3, stdout: 'plain body', stderr: '' });
    } finally {
      for (const listener of original) engine.server.on('upgrade', listener as (...args: unknown[]) => void);
    }
  });

  it('carries a berth from start to stop through the real wire: the volumes, the helper, the wires, porter joined, the token on stdin, the berth read back; a berth that dies is refused with its last words', async () => {
    const launcher: BerthLauncher = new BerthLauncher({ docker, policy: { limits: BERTH_LIMITS_DEFAULT, holds: null }, image: 'img@sha256:abc', prefix: 'eng', cubeNetwork: 'eng-cube-net', porterContainer: 'porter', bootMs: 2000, pollMs: 20 });
    const identity: string = identity_normalise('ana', CUBE);
    const names = berthNames_derive('eng', identity, 'ana', 5);
    const berth = await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'cube-token', cohort: 5 });
    expect(berth).toMatchObject({ state: 'running', url: 'ws://10.9.0.2:40000', token: `attach-${names.container}`, cohort: '5' });
    expect([...engine.volumes]).toEqual(expect.arrayContaining([names.home, names.cohort]));
    expect([...engine.networks.get(names.network) ?? []].sort()).toEqual([names.container, 'porter']);
    expect(engine.networks.has('eng-cube-net')).toBe(true);
    const wrote = [...engine.execs.values()].find((one) => one.container === names.container && String(one.body['Cmd']).includes('.token.new'));
    expect(wrote).toMatchObject({ stdin: 'cube-token\n', body: { User: '7:7' } });
    expect(engine.containers.has(`${names.container}-own`)).toBe(false);
    expect((await launcher.status({ user: 'ana', cubeUrl: CUBE }))[0]).toMatchObject({ state: 'running', cohort: '5' });
    expect(await launcher.stop('ana', CUBE)).toBe(true);
    expect(engine.networks.has(names.network)).toBe(false);
    // A berth whose session dies as it starts: refused with what it last said.
    const deadNames = berthNames_derive('eng', identity_normalise('dead', CUBE), 'dead', null);
    engine.dead.add(deadNames.container);
    await expect(launcher.start({ user: 'dead', uid: 8, gid: 8, cubeUrl: CUBE, token: 't' })).rejects.toThrow('the berth stopped as it started: starting / boom: the session died');
    expect(berthKey_compute(identity)).toHaveLength(16);
  });
});

describe('porter\'s host: the CUBE id and the launcher\'s answers', () => {
  let cube: Server;
  let cubeUrl: string;
  let launcherDir: string;
  let launcher: Server;
  const asked: Array<{ method: string; path: string; body: string }> = [];
  beforeAll(async () => {
    cube = createServer((req: IncomingMessage, res: ServerResponse): void => {
      const auth: string = req.headers.authorization ?? '';
      res.writeHead(auth === 'Token good' ? 200 : auth === 'Token odd' ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(auth === 'Token odd' ? { collection_links: {} } : { collection_links: { user: 'http://cube/api/v1/users/42/' } }));
    });
    await new Promise<void>((resolve) => { cube.listen(0, '127.0.0.1', resolve); });
    const port: number = (cube.address() as { port: number }).port;
    cubeUrl = `http://127.0.0.1:${port}/api/v1/`;
    launcherDir = mkdtempSync(join(tmpdir(), 'lh-'));
    launcher = createServer((req: IncomingMessage, res: ServerResponse): void => {
      void body_read(req).then((body: string): void => {
        asked.push({ method: req.method ?? '', path: req.url ?? '', body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if ((req.url ?? '').startsWith('/berths/stop')) { res.end(JSON.stringify({ stopped: true })); return; }
        if ((req.url ?? '').startsWith('/berths/status')) { res.end(JSON.stringify({ berths: [] })); return; }
        res.end(JSON.stringify({ identity: identity_normalise('ana', cubeUrl), user: 'ana', state: 'running', url: 'ws://10.9.0.2:1', token: 'a', container: 'c', cohort: 'none' }));
      });
    });
    await new Promise<void>((resolve) => { launcher.listen(join(launcherDir, 'l.sock'), resolve); });
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => { cube.close(() => resolve()); });
    await new Promise<void>((resolve) => { launcher.close(() => resolve()); });
    rmSync(launcherDir, { recursive: true, force: true });
  });

  it('reads the token\'s CUBE id from the API root\'s user link, and refuses a token CUBE refuses or a root that names no user', async () => {
    expect(await cubeUserId_read(cubeUrl, 'good')).toBe(42);
    await expect(cubeUserId_read(cubeUrl, 'bad')).rejects.toThrow('CUBE answered 401');
    await expect(cubeUserId_read(cubeUrl, 'odd')).rejects.toThrow('did not say who');
  });

  it('renews a token on a berth already up, restarts on the token the launcher holds after an evict, begins a spawn without waiting, and knows no stratus arming', async () => {
    const host: LauncherHost = new LauncherHost({ listen: join(launcherDir, 'l.sock'), secret: 's'.repeat(40) }, async (): Promise<number> => 42);
    const identity: string = identity_normalise('ana', cubeUrl);
    asked.length = 0;
    await host.token_renew(identity, 'ana', cubeUrl, 'new-token');
    expect(JSON.parse(asked[0]?.body ?? '{}')).toMatchObject({ user: 'ana', uid: 42, gid: 42, token: 'new-token' });
    host.restart_begin(identity, 'ana', cubeUrl, { kind: 'stale', behind: ['chell 1 → 2'] });
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    expect(asked.map((one) => one.path)).toEqual(['/berths/start', '/berths/stop', '/berths/start']);
    expect(JSON.parse(asked[2]?.body ?? '{}')).toMatchObject({ token: null, uid: 0 });
    expect(host.boot_follow(identity, { line: () => undefined, done: () => undefined })?.report.lines[0]?.text).toBe('Restarting a stale calypso daemon (chell 1 → 2)');
    host.restart_begin(identity, 'ana', cubeUrl, { kind: 'saved-login' });
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    expect(asked.at(-1)?.path).toBe('/berths/start');
    expect(asked.filter((one) => one.path === '/berths/stop')).toHaveLength(1);
    host.spawn_begin(identity, 'ana', cubeUrl, 'good');
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    expect(host.boot_follow(identity, { line: () => undefined, done: () => undefined })?.report.state).toBe('ready');
    expect(host.stratus_armed()).toBeNull();
    expect(await host.evict('not-an-identity')).toBe(false);
    expect(await host.find('not-an-identity')).toBeNull();
    // A launcher that answers with a refusal fails the boot with its words.
    const refusing: LauncherHost = new LauncherHost({ listen: join(launcherDir, 'l.sock'), secret: 's'.repeat(40) }, async (): Promise<number> => { throw new Error('CUBE is away'); });
    await expect(refusing.spawn(identity, 'ana', cubeUrl, 'good')).rejects.toThrow('CUBE is away');
    expect(refusing.boot_follow(identity, { line: () => undefined, done: () => undefined })?.report).toMatchObject({ state: 'failed', reason: 'CUBE is away' });
    await expect(refusing.spawn('wrong@http://x/', 'ana', cubeUrl, 'good')).rejects.toThrow('not the user\'s at this CUBE');
    expect(() => new LauncherHost({ listen: `/${'x'.repeat(120)}`, secret: 's' })).toThrow('longer than 100 bytes');
    const answer = await launcher_call({ listen: join(launcherDir, 'l.sock'), secret: 's' }, 'GET', '/berths/status');
    expect(answer.body).toEqual({ berths: [] });
  });
});
