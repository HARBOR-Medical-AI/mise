/**
 * @file The berth launcher: its policy's arithmetic, the container it fixes,
 * its wires and volumes, its start, stop and status over a fake engine, its
 * API behind the secret, porter's switch, and porter's launcher host over
 * the API.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { berthKey_compute, identity_normalise } from '@fnndsc/calypso/berth';
import { berthCapacity_derive, profileFloor_get } from '@fnndsc/menu';
import type { DockerAnswer, DockerApi, ExecAnswer } from '../../src/launcher/docker.js';
import { dockerStream_demux } from '../../src/launcher/docker.js';
import { BERTH_LABEL, BerthLauncher, berthContainer_spec, berthNames_derive, cohort_word, stats_digest } from '../../src/launcher/launcher.js';
import { BERTH_LIMITS_DEFAULT, berthPolicy_read, capacityRefusal_words, type BerthPolicy } from '../../src/launcher/policy.js';
import { launcherServer_create, secret_matches } from '../../src/launcher/server.js';
import { launcherSecret_read } from '../../src/launcher/secret.js';
import { LauncherHost, identity_split, launcher_call } from '../../src/host/launcherHost.js';
import { porterConfig_resolve } from '../../src/config.js';

const CUBE: string = 'http://cube.example.org/api/v1/';
const SECRET: string = 's'.repeat(40);

/** An engine in memory: networks with their members, volumes with their labels, containers, the commands run in them and what they read on stdin. */
class FakeDocker implements DockerApi {
  networks: Map<string, { options: Record<string, string>; members: Set<string> }> = new Map();
  volumes: Map<string, Record<string, string>> = new Map();
  containers: Map<string, { spec: Record<string, unknown>; running: boolean; ip: string; token: string | null }> = new Map();
  execs: Array<{ container: string; cmd: string[]; user: string; stdin: string | null }> = [];
  /** A berth whose session never writes its berth file. */
  silent: boolean = false;
  /** The gateway every network inspect names; null: the network has an address range and no gateway. */
  gateway: string | null = '172.18.0.1';
  /** What the one-shot container that gives the volumes away exits with. */
  ownExit: number = 0;
  /** The CPUs and bytes of memory the engine reports for the host. */
  host: { cpus: number; memory: number } = { cpus: 24, memory: 64 * 1024 ** 3 };
  /** The stats sample the engine gives for a running container; absent: none. */
  stats: Record<string, unknown> = {};
  private serial: number = 2;

  async call(method: string, path: string, body?: unknown): Promise<DockerAnswer> {
    const [route = '', query = ''] = path.split('?');
    const parts: string[] = route.split('/');
    const name: string = decodeURIComponent(parts[2] ?? '');
    if (method === 'GET' && route === '/info') return { status: 200, body: { NCPU: this.host.cpus, MemTotal: this.host.memory } };
    if (route === '/networks/create') { const spec = body as { Name: string; Options?: Record<string, string> }; this.networks.set(spec.Name, { options: spec.Options ?? {}, members: new Set() }); return { status: 201, body: {} }; }
    if (method === 'GET' && route === '/networks') return { status: 200, body: [...this.networks.keys()].map((one) => ({ Name: one })) };
    if (route.endsWith('/connect') && parts[1] === 'networks') { this.networks.get(name)?.members.add((body as { Container: string }).Container); return { status: 200, body: null }; }
    if (route.endsWith('/disconnect') && parts[1] === 'networks') { this.networks.get(name)?.members.delete((body as { Container: string }).Container); return { status: 200, body: null }; }
    if (method === 'GET' && parts[1] === 'networks') {
      const net = this.networks.get(name);
      return net === undefined ? { status: 404, body: {} } : { status: 200, body: { Name: name, Containers: Object.fromEntries([...net.members].map((member) => [member, { Name: member }])), IPAM: { Config: [{ Subnet: '172.18.0.0/16', ...(this.gateway !== null ? { Gateway: this.gateway } : {}) }] } } };
    }
    if (method === 'DELETE' && parts[1] === 'networks') { const had = this.networks.delete(name); return { status: had ? 204 : 404, body: null }; }
    if (route === '/volumes/create') { const spec = body as { Name: string; Labels: Record<string, string> }; this.volumes.set(spec.Name, spec.Labels); return { status: 201, body: {} }; }
    if (method === 'DELETE' && parts[1] === 'volumes') { const had = this.volumes.delete(name); return { status: had ? 204 : 404, body: null }; }
    if (method === 'GET' && route === '/volumes') {
      const filter = JSON.parse(decodeURIComponent(new URLSearchParams(query).get('filters') ?? '{}')) as { label?: string[] };
      const wanted: string[] = filter.label ?? [];
      return { status: 200, body: { Volumes: [...this.volumes.entries()].filter(([, labels]) => wanted.every((one) => { const [key = '', value = ''] = one.split('='); return labels[key] === value; })).map(([one, labels]) => ({ Name: one, Labels: labels })), Warnings: null } };
    }
    if (method === 'GET' && route.endsWith('/stats')) {
      const sample = this.stats[name];
      return this.containers.get(name)?.running === true && sample !== undefined ? { status: 200, body: sample } : { status: 404, body: {} };
    }
    if (method === 'GET' && parts[1] === 'volumes') return { status: this.volumes.has(name) ? 200 : 404, body: {} };
    if (route === '/containers/json') {
      const filter = JSON.parse(decodeURIComponent(new URLSearchParams(query).get('filters') ?? '{}')) as { name?: string[] };
      return { status: 200, body: [...this.containers.entries()].filter(([one]) => filter.name === undefined || one.startsWith(filter.name[0] ?? '')).map(([one, each]) => ({ Names: [`/${one}`], Labels: each.spec['Labels'], State: each.running ? 'running' : 'exited' })) };
    }
    if (route === '/containers/create') {
      const made: string = new URLSearchParams(query).get('name') ?? '';
      const spec = body as Record<string, unknown>;
      const nets = Object.keys(((spec['NetworkingConfig'] as { EndpointsConfig?: Record<string, unknown> } | undefined)?.EndpointsConfig) ?? {});
      for (const net of nets) this.networks.get(net)?.members.add(made);
      this.containers.set(made, { spec, running: false, ip: `10.213.77.${this.serial++}`, token: null });
      return { status: 201, body: { Id: made } };
    }
    const found = this.containers.get(name);
    if (method === 'GET' && route.endsWith('/json')) {
      if (found === undefined) return { status: 404, body: {} };
      const wire: string = String((found.spec['HostConfig'] as Record<string, unknown>)['NetworkMode']);
      return { status: 200, body: { State: { Running: found.running }, Config: { User: found.spec['User'], Labels: found.spec['Labels'] }, NetworkSettings: { Networks: { [wire]: { IPAddress: found.ip } } } } };
    }
    if (route.endsWith('/start')) { if (found !== undefined) found.running = true; return { status: 204, body: null }; }
    if (route.endsWith('/wait')) { if (found !== undefined) found.running = false; return { status: 200, body: { StatusCode: name.endsWith('-own') ? this.ownExit : 0 } }; }
    if (route.endsWith('/stop')) { if (found !== undefined) found.running = false; return { status: 204, body: null }; }
    if (method === 'DELETE' && parts[1] === 'containers') { for (const net of this.networks.values()) net.members.delete(name); this.containers.delete(name); return { status: found === undefined ? 404 : 204, body: null }; }
    return { status: 404, body: {} };
  }

  async exec(container: string, cmd: ReadonlyArray<string>, user: string, stdin: string | null): Promise<ExecAnswer> {
    this.execs.push({ container, cmd: [...cmd], user, stdin });
    const found = this.containers.get(container);
    const line: string = cmd.join(' ');
    if (found === undefined) return { code: 1, stdout: '', stderr: 'no such container' };
    if (line.includes('.token.new')) { found.token = stdin; return { code: 0, stdout: '', stderr: '' }; }
    if (line.includes('berth-') && !this.silent && found.token !== null) {
      const identity: string = (found.spec['Labels'] as Record<string, string>)[`${BERTH_LABEL}.identity`] ?? '';
      if (!line.includes(berthKey_compute(identity))) return { code: 1, stdout: '', stderr: 'no such file' };
      return { code: 0, stdout: JSON.stringify({ identity, url: 'ws://berth-host.example:41234', token: `attach-${container}` }), stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'no such file' };
  }
}

const POLICY: BerthPolicy = { limits: BERTH_LIMITS_DEFAULT, holds: null };
const ANA: string = identity_normalise('ana', CUBE);

/** A launcher over a fake engine, quick to give up; porter a container when named. */
function launcher_make(docker: FakeDocker, policy: BerthPolicy = POLICY, porterContainer: string | null = 'porter'): BerthLauncher {
  return new BerthLauncher({ docker, policy, image: 'mbw/mise-berth@sha256:abc', prefix: 'mbw', cubeNetwork: 'mbw-cube-net', porterContainer, bootMs: 300, pollMs: 10 });
}

describe('the berth policy', () => {
  it('holds the memory left of the host above the profile\'s floor, divided by one berth\'s memory; CPUs do not count', () => {
    const floor = profileFloor_get('minimal');
    expect(floor).toEqual({ vcpu: 2, memory: 4, data: 50 });
    expect(berthCapacity_derive({ cpus: 24, memoryGib: 62.7 }, floor, POLICY)).toBe(29);
    expect(berthCapacity_derive({ cpus: 4, memoryGib: 16 }, floor, { limits: { cpus: 1, memoryGib: 4, pids: 512 }, holds: null })).toBe(3);
    expect(berthCapacity_derive({ cpus: 2, memoryGib: 4 }, floor, POLICY)).toBe(0);
    expect(berthCapacity_derive({ cpus: 2, memoryGib: 8 }, floor, POLICY)).toBe(2);
    expect(berthCapacity_derive({ cpus: 24, memoryGib: 62.7 }, floor, { limits: BERTH_LIMITS_DEFAULT, holds: 1 })).toBe(1);
    expect(berthCapacity_derive({ cpus: 4, memoryGib: 8 }, floor, { limits: BERTH_LIMITS_DEFAULT, holds: 10 })).toBe(2);
  });

  it('refuses a full spoke naming who holds it', () => {
    const room = { hostGib: 8, floorGib: 4, berthGib: 2 };
    expect(capacityRefusal_words(2, ['rudolph', 'ana'], room)).toBe('this ChRIS holds 2 berths, in use by ana, rudolph');
    expect(capacityRefusal_words(1, ['ana'], room)).toBe('this ChRIS holds 1 berth, in use by ana');
    expect(capacityRefusal_words(0, [], { ...room, berthGib: 6 })).toBe('this ChRIS holds no berth: 6 GiB each does not fit above the profile\'s floor (8 GiB, the floor takes 4 GiB)');
    expect(capacityRefusal_words(0, [], room)).toBe('this ChRIS holds no berth: its policy holds none');
  });

  it('reads a policy file, refusing one that is not', () => {
    const dir: string = mkdtempSync(join(tmpdir(), 'policy-'));
    try {
      writeFileSync(join(dir, 'p.json'), JSON.stringify({ cpus: 2, holds: 3 }));
      expect(berthPolicy_read(join(dir, 'p.json'))).toEqual({ limits: { cpus: 2, memoryGib: 2, pids: 1024 }, holds: 3 });
      writeFileSync(join(dir, 'bad.json'), JSON.stringify({ cpus: -1, docker: true }));
      expect(() => berthPolicy_read(join(dir, 'bad.json'))).toThrow('not a berth policy');
      expect(berthPolicy_read(null)).toEqual({ limits: BERTH_LIMITS_DEFAULT, holds: null });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the names and the container a berth is', () => {
  it('names one home for life, one cohort volume per person and cohort, and one wire per person', () => {
    const key: string = berthKey_compute(ANA);
    expect(berthNames_derive('mbw', ANA, 'ana', null)).toEqual({ container: `mbw-${key}`, network: 'mbw-net-ana', home: `mbw-${key}-home`, cohort: `mbw-${key}-cohort-none` });
    expect(berthNames_derive('mbw', ANA, 'ana', 42).cohort).toBe(`mbw-${key}-cohort-42`);
    expect(berthNames_derive('mbw', ANA, 'ana', 42).home).toBe(`mbw-${key}-home`);
    expect(berthNames_derive('mbw', identity_normalise('a.b+c@x', CUBE), 'a.b+c@x', null).network).toBe('mbw-net-a.b-c-x');
    expect(cohort_word(undefined)).toBe('none');
    expect(cohort_word(7)).toBe('7');
  });

  it('fixes everything but who it is for and which cohort: the image, the home and the cohort pair by subpath, the token tmpfs, the limits, no privilege, no engine, a read-only root, its own wire and cube-net', () => {
    const spec = berthContainer_spec({ image: 'img@sha256:abc', prefix: 'mbw', cubeNetwork: 'mbw-cube-net', policy: POLICY }, { user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'secret-cube-token', cohort: 42 }, ANA);
    const names = berthNames_derive('mbw', ANA, 'ana', 42);
    const host = spec['HostConfig'] as Record<string, unknown>;
    expect(spec['Image']).toBe('img@sha256:abc');
    expect(spec['User']).toBe('7:7');
    expect(spec['Env']).toContain('MISE_COHORT=42');
    expect(host['Mounts']).toEqual([
      { Type: 'volume', Source: names.home, Target: '/home/ana', ReadOnly: false, VolumeOptions: { NoCopy: true } },
      { Type: 'volume', Source: names.cohort, Target: '/incoming', ReadOnly: true, VolumeOptions: { NoCopy: true, Subpath: 'incoming' } },
      { Type: 'volume', Source: names.cohort, Target: '/outgoing', ReadOnly: false, VolumeOptions: { NoCopy: true, Subpath: 'outgoing' } },
    ]);
    expect((host['Tmpfs'] as Record<string, string>)['/run/mise']).toBe('rw,nosuid,nodev,noexec,size=1m,mode=0700,uid=7,gid=7');
    expect(host).toMatchObject({ ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], NanoCpus: 1e9, Memory: 2 * 1024 ** 3, PidsLimit: 1024, NetworkMode: 'mbw-net-ana' });
    expect(Object.keys((spec['NetworkingConfig'] as { EndpointsConfig: Record<string, unknown> }).EndpointsConfig)).toEqual(['mbw-net-ana', 'mbw-cube-net']);
    expect(JSON.stringify(spec)).not.toContain('docker.sock');
    expect(JSON.stringify(spec)).not.toContain('secret-cube-token');
    expect(host).not.toHaveProperty('ExtraHosts');
  });

  it('carries the host lines it is given as the engine\'s ExtraHosts, and none when given none', () => {
    const options = { image: 'img@sha256:abc', prefix: 'mbw', cubeNetwork: 'mbw-cube-net', policy: POLICY };
    const ask = { user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 't', cohort: 42 };
    expect((berthContainer_spec(options, ask, ANA, ['cube.example.org:172.18.0.1'])['HostConfig'] as Record<string, unknown>)['ExtraHosts']).toEqual(['cube.example.org:172.18.0.1']);
    expect(berthContainer_spec(options, ask, ANA, [])['HostConfig']).not.toHaveProperty('ExtraHosts');
  });
});

describe('the launcher over an engine', () => {
  let docker: FakeDocker;
  beforeEach(() => { docker = new FakeDocker(); });

  it('counts a host at its nominal GiB: the engine\'s 7.7 of an 8 GiB machine holds the berths 8 does', async () => {
    docker.host = { cpus: 4, memory: Math.floor(7.7 * 1024 ** 3) };
    expect(await launcher_make(docker).capacity_get()).toBe(2);
    docker.host = { cpus: 4, memory: 8 * 1024 ** 3 };
    expect(await launcher_make(docker).capacity_get()).toBe(2);
    // CPUs do not count: a berth's are a cap on shared CPUs.
    docker.host = { cpus: 2, memory: 8 * 1024 ** 3 };
    expect(await launcher_make(docker).capacity_get()).toBe(2);
    docker.host = { cpus: 3, memory: Math.floor(15.6 * 1024 ** 3) };
    expect(await launcher_make(docker).capacity_get()).toBe(6);
  });

  it('with a cubeHost, reads cube-net\'s gateway from the engine and puts CUBE\'s name at it inside the berth; without one, adds no host', async () => {
    docker.gateway = '172.31.0.1';
    const named: BerthLauncher = new BerthLauncher({ docker, policy: POLICY, image: 'mbw/mise-berth@sha256:abc', prefix: 'mbw', cubeNetwork: 'mbw-cube-net', porterContainer: 'porter', cubeHost: 'cube.example.org', bootMs: 300, pollMs: 10 });
    await named.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' });
    const names = berthNames_derive('mbw', ANA, 'ana', null);
    expect((docker.containers.get(names.container)?.spec['HostConfig'] as Record<string, unknown>)['ExtraHosts']).toEqual(['cube.example.org:172.31.0.1']);
    const plain = new FakeDocker();
    await launcher_make(plain).start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' });
    expect(plain.containers.get(names.container)?.spec['HostConfig']).not.toHaveProperty('ExtraHosts');
  });

  it('refuses to start a berth when cube-net names no gateway for CUBE\'s name, and makes no container', async () => {
    docker.gateway = null;
    const named: BerthLauncher = new BerthLauncher({ docker, policy: POLICY, image: 'mbw/mise-berth@sha256:abc', prefix: 'mbw', cubeNetwork: 'mbw-cube-net', porterContainer: 'porter', cubeHost: 'cube.example.org', bootMs: 300, pollMs: 10 });
    await expect(named.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' })).rejects.toMatchObject({ status: 502, message: 'cube-net mbw-cube-net names no gateway for cube.example.org' });
    expect(docker.containers.size).toBe(0);
  });

  it('starts a berth: cube-net blocking its containers from one another, the person\'s own wire with porter joined, the home and the cohort pair made and given to the uid, the token written on stdin as the user, the address on the wire', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    const berth = await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token', cohort: 42 });
    const names = berthNames_derive('mbw', ANA, 'ana', 42);
    expect(docker.networks.get('mbw-cube-net')?.options).toEqual({ 'com.docker.network.bridge.enable_icc': 'false' });
    expect([...docker.networks.get('mbw-net-ana')?.members ?? []].sort()).toEqual([names.container, 'porter']);
    expect([...docker.networks.get('mbw-cube-net')?.members ?? []]).toEqual([names.container]);
    expect([...docker.volumes.keys()].sort()).toEqual([names.cohort, names.home].sort());
    expect(docker.volumes.get(names.cohort)).toMatchObject({ [`${BERTH_LABEL}.volume`]: 'cohort', [`${BERTH_LABEL}.cohort`]: '42' });
    expect(berth).toEqual({ identity: ANA, user: 'ana', state: 'running', url: 'ws://10.213.77.3:41234', token: `attach-${names.container}`, container: names.container, cohort: '42' });
    const own = docker.execs.length;
    const write = docker.execs.find((one) => one.cmd.join(' ').includes('.token.new'));
    expect(write).toMatchObject({ container: names.container, user: '7:7', stdin: 'ana-token\n' });
    expect(write?.cmd.join(' ')).not.toContain('ana-token');
    // A second start on the same cohort rewrites the token and makes nothing new; the helper ran once.
    const again = await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token-2', cohort: 42 });
    expect(again.url).toBe(berth.url);
    expect(docker.containers.get(names.container)?.token).toBe('ana-token-2\n');
    expect(docker.containers.size).toBe(1);
    expect(docker.execs.length).toBeGreaterThan(own);
    expect(docker.volumes.size).toBe(2);
  });

  it('joins porter to a running berth\'s wire again when porter was made again and left it, making nothing new', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token', cohort: 42 });
    docker.networks.get('mbw-net-ana')?.members.delete('porter');
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token-2', cohort: 42 });
    expect(docker.networks.get('mbw-net-ana')?.members.has('porter')).toBe(true);
    expect(docker.containers.size).toBe(1);
  });

  it('removes the volumes it made when they could not be given to the person, so the next start gives them anew', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    docker.ownExit = 1;
    await expect(launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token', cohort: null })).rejects.toThrow('ana\'s volumes were not given to them (exit 1)');
    expect(docker.volumes.size).toBe(0);
    docker.ownExit = 0;
    const berth = await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token', cohort: null });
    expect(berth.state).toBe('running');
    expect(docker.volumes.size).toBe(2);
  });

  it('switches cohort: the berth is made again on the new pair, the home the same; none is a pair of its own', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token', cohort: 42 });
    const moved = await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token', cohort: null });
    expect(moved.cohort).toBe('none');
    const names = berthNames_derive('mbw', ANA, 'ana', null);
    expect([...docker.volumes.keys()].sort()).toEqual([names.home, `${names.home.replace(/-home$/, '')}-cohort-42`, names.cohort].sort());
    expect(docker.containers.size).toBe(1);
    expect((docker.containers.get(names.container)?.spec['Labels'] as Record<string, string>)[`${BERTH_LABEL}.cohort`]).toBe('none');
    await expect(launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 't', cohort: -1 })).rejects.toThrow('a cohort is a feed\'s id');
  });

  it('refuses a full spoke naming who holds it; a stop frees the room, takes porter off the wire and removes it, and keeps the volumes', async () => {
    const launcher: BerthLauncher = launcher_make(docker, { limits: BERTH_LIMITS_DEFAULT, holds: 1 });
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' });
    await expect(launcher.start({ user: 'rudolph', uid: 3, gid: 3, cubeUrl: CUBE, token: 'r-token' })).rejects.toThrow('this ChRIS holds 1 berth, in use by ana');
    expect(await launcher.stop('ana', CUBE)).toBe(true);
    expect(docker.containers.size).toBe(0);
    expect(docker.networks.has('mbw-net-ana')).toBe(false);
    expect(docker.networks.has('mbw-cube-net')).toBe(true);
    expect(docker.volumes.size).toBe(2);
    expect((await launcher.start({ user: 'rudolph', uid: 3, gid: 3, cubeUrl: CUBE, token: 'r-token' })).state).toBe('running');
    expect(await launcher.stop('nobody', CUBE)).toBe(false);
  });

  it('refuses root, a name CUBE would not take, and a start with no token it holds', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    await expect(launcher.start({ user: 'ana', uid: 0, gid: 0, cubeUrl: CUBE, token: 't' })).rejects.toThrow('never root');
    await expect(launcher.start({ user: 'a b', uid: 7, gid: 7, cubeUrl: CUBE, token: 't' })).rejects.toThrow('not a CUBE user name');
    await expect(launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: null })).rejects.toThrow('log in again');
  });

  it('restarts on the token it holds, says a berth that never answers, and clears what an earlier run left', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' });
    const names = berthNames_derive('mbw', ANA, 'ana', null);
    docker.containers.get(names.container)!.running = false;
    const restarted = await launcher.start({ user: 'ana', uid: 0, gid: 0, cubeUrl: CUBE, token: null });
    expect(restarted.state).toBe('running');
    expect(docker.containers.get(names.container)?.spec['User']).toBe('7:7');
    docker.silent = true;
    await expect(launcher.start({ user: 'rudolph', uid: 3, gid: 3, cubeUrl: CUBE, token: 'r' })).rejects.toThrow('did not answer');
    // An earlier run's helper and a wire with no berth on it are removed, whoever else stands on it (porter, a helper); a wire with a berth is kept.
    docker.networks.set('mbw-net-ghost', { options: {}, members: new Set(['porter', 'mbw-porter-standin', 'mbw-x-own']) });
    docker.containers.set('mbw-x-own', { spec: { Labels: { [BERTH_LABEL]: 'mbw' } }, running: false, ip: '', token: null });
    expect((await launcher.orphans_clear()).sort()).toEqual(['mbw-net-ghost', 'mbw-x-own']);
    expect(docker.networks.has('mbw-net-ana')).toBe(true);
  });

  it('reads each person\'s berth for the operator: a running one with what it uses, a stopped one as the home kept, a person with neither absent', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token', cohort: 42 });
    await launcher.start({ user: 'benito', uid: 8, gid: 8, cubeUrl: CUBE, token: 'benito-token' });
    await launcher.stop('benito', CUBE);
    await launcher.start({ user: 'carla', uid: 9, gid: 9, cubeUrl: CUBE, token: 'carla-token' });
    // Carla's container is up but the engine cannot sample it: she is running, her usage unread.
    docker.stats[berthNames_derive('mbw', ANA, 'ana', 42).container] = {
      cpu_stats: { cpu_usage: { total_usage: 2_300_000 }, system_cpu_usage: 100_000_000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 2_000_000 }, system_cpu_usage: 90_000_000 },
      memory_stats: { usage: 300 * 1024 ** 2, limit: 2 * 1024 ** 3, stats: { inactive_file: 90 * 1024 ** 2 } },
    };
    docker.volumes.set('mbw-other-home', { [BERTH_LABEL]: 'another-spoke', [`${BERTH_LABEL}.user`]: 'zed', [`${BERTH_LABEL}.volume`]: 'home' });
    expect(await launcher.access_read()).toEqual([
      { user: 'ana', state: 'running', cohort: '42', cpuPercent: 12, memoryBytes: 210 * 1024 ** 2, memoryLimitBytes: 2 * 1024 ** 3 },
      { user: 'benito', state: 'stopped', cohort: null, cpuPercent: null, memoryBytes: null, memoryLimitBytes: null },
      { user: 'carla', state: 'running', cohort: 'none', cpuPercent: null, memoryBytes: null, memoryLimitBytes: null },
    ]);
  });

  it('reads CPU as the engine\'s sample against the host\'s time, and memory without the page cache', () => {
    expect(stats_digest({})).toEqual({ cpuPercent: null, memoryBytes: null, memoryLimitBytes: null });
    expect(stats_digest({ cpu_stats: { cpu_usage: { total_usage: 5, percpu_usage: [1, 2] }, system_cpu_usage: 10 }, precpu_stats: { cpu_usage: { total_usage: 5 }, system_cpu_usage: 0 }, memory_stats: { usage: 50, stats: { cache: 80 } } }))
      .toEqual({ cpuPercent: 0, memoryBytes: 0, memoryLimitBytes: null });
  });

  it('a porter on the host joins no wire', async () => {
    const launcher: BerthLauncher = launcher_make(docker, POLICY, null);
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' });
    expect([...docker.networks.get('mbw-net-ana')?.members ?? []]).toEqual([berthNames_derive('mbw', ANA, 'ana', null).container]);
  });

  it('demuxes the engine\'s stream into stdout and stderr', () => {
    const frame = (kind: number, text: string): Buffer => Buffer.concat([Buffer.from([kind, 0, 0, 0]), Buffer.from([0, 0, 0, text.length]), Buffer.from(text)]);
    expect(dockerStream_demux(Buffer.concat([frame(1, 'out'), frame(2, 'err'), frame(1, '!')]))).toEqual({ stdout: 'out!', stderr: 'err' });
  });
});

describe('the launcher\'s API and porter\'s host over it', () => {
  let dir: string;
  let server: Server;
  let docker: FakeDocker;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'launcher-'));
    docker = new FakeDocker();
    server = launcherServer_create(launcher_make(docker), SECRET);
    await new Promise<void>((resolve) => { server.listen(join(dir, 'launcher.sock'), resolve); });
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers porter alone: no secret, no berth', async () => {
    expect(secret_matches(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(secret_matches('Bearer wrong', SECRET)).toBe(false);
    const refused = await launcher_call({ listen: join(dir, 'launcher.sock'), secret: 'x'.repeat(40) }, 'GET', '/berths/status');
    expect(refused.status).toBe(401);
    const unknown = await launcher_call({ listen: join(dir, 'launcher.sock'), secret: SECRET }, 'POST', '/berths/exec', {});
    expect(unknown.status).toBe(404);
  });

  it('answers the operator\'s read over the API, and porter\'s host asks for it', async () => {
    const reach = { listen: join(dir, 'launcher.sock'), secret: SECRET };
    const host: LauncherHost = new LauncherHost(reach, async (): Promise<number> => 7);
    await host.spawn(ANA, 'ana', CUBE, 'ana-token');
    expect(await host.access_read()).toEqual([{ user: 'ana', state: 'running', cohort: 'none', cpuPercent: null, memoryBytes: null, memoryLimitBytes: null }]);
    expect((await launcher_call({ ...reach, secret: 'x'.repeat(40) }, 'GET', '/berths/access')).status).toBe(401);
  });

  it('porter\'s host starts a berth at login with the user\'s CUBE id and no cohort, finds it, follows its boot, and stops it', async () => {
    const host: LauncherHost = new LauncherHost({ listen: join(dir, 'launcher.sock'), secret: SECRET }, async (cubeUrl: string, token: string): Promise<number> => (token === 'ana-token' && cubeUrl === CUBE ? 7 : 0));
    expect(identity_split(ANA)).toEqual({ user: 'ana', cubeUrl: CUBE });
    const berth = await host.spawn(ANA, 'ana', CUBE, 'ana-token');
    expect(berth.url).toBe('ws://10.213.77.3:41234');
    const names = berthNames_derive('mbw', ANA, 'ana', null);
    expect(docker.containers.get(names.container)?.spec['User']).toBe('7:7');
    expect(docker.volumes.has(names.cohort)).toBe(true);
    expect((await host.find(ANA))?.token).toBe(berth.token);
    expect((await host.sessions_adopt()).map((one) => one.identity)).toEqual([ANA]);
    const followed = host.boot_follow(ANA, { line: () => undefined, done: () => undefined });
    expect(followed?.report.state).toBe('ready');
    expect(followed?.report.lines.map((line) => line.text)).toEqual(['[ OK ]    Identity     ana is CUBE user 7', '[PENDING] Berth        starting ana\'s berth', '[ OK ]    Berth        ana\'s berth answers']);
    expect(await host.evict(ANA)).toBe(true);
    expect(await host.find(ANA)).toBeNull();
    host.stratus_begin('stratus:oci@' + ANA);
    expect(host.boot_follow('stratus:oci@' + ANA, { line: () => undefined, done: () => undefined })?.report.reason).toBe('a stratus session is not offered on a door that starts berths');
  });
});

describe('porter\'s switch', () => {
  const locate = (): string => '/opt/chell/dist/index.js';
  it('starts sessions beside itself unless the deployment turns berths on, and then needs the launcher and its secret', () => {
    expect(porterConfig_resolve({ PORTER_CUBE_URL: CUBE }, locate).berths).toEqual({ mode: 'local' });
    expect(porterConfig_resolve({ PORTER_CUBE_URL: CUBE, PORTER_BERTHS: 'launcher', PORTER_LAUNCHER: '/run/launcher.sock', PORTER_LAUNCHER_SECRET_FILE: '/etc/porter/launcher.secret' }, locate).berths)
      .toEqual({ mode: 'launcher', listen: '/run/launcher.sock', secretFile: '/etc/porter/launcher.secret' });
    expect(() => porterConfig_resolve({ PORTER_CUBE_URL: CUBE, PORTER_BERTHS: 'launcher' }, locate)).toThrow('needs PORTER_LAUNCHER');
    expect(() => porterConfig_resolve({ PORTER_CUBE_URL: CUBE, PORTER_BERTHS: 'pods' }, locate)).toThrow('PORTER_BERTHS is local or launcher');
  });

  it('reads the launcher\'s secret only from a file its owner alone can read', () => {
    const dir: string = mkdtempSync(join(tmpdir(), 'secret-'));
    try {
      writeFileSync(join(dir, 'open'), SECRET, { mode: 0o644 });
      expect(() => launcherSecret_read(join(dir, 'open'))).toThrow('give it mode 0600');
      writeFileSync(join(dir, 'short'), 'x', { mode: 0o600 });
      expect(() => launcherSecret_read(join(dir, 'short'))).toThrow('shorter than 32');
      writeFileSync(join(dir, 'kept'), `${SECRET}\n`, { mode: 0o600 });
      expect(launcherSecret_read(join(dir, 'kept'))).toBe(SECRET);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
