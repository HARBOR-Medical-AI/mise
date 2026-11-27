/**
 * @file The berth launcher: its policy's arithmetic, the container it fixes,
 * its wires and volumes, its start, stop and status over a fake engine, its
 * API behind the secret, porter's switch, and porter's launcher host over
 * the API.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { berthKey_compute, identity_normalise } from '@fnndsc/calypso/berth';
import { berthCapacity_derive, profileFloor_get } from '@fnndsc/menu';
import type { DockerAnswer, DockerApi, ExecAnswer, LogFollow, LogLineSink } from '../../src/launcher/docker.js';
import { DockerLogLines, dockerStream_demux } from '../../src/launcher/docker.js';
import { BERTH_ANCHORS_DIR, BERTH_IMAGE_DEFAULT, BERTH_LABEL, BERTH_OUTGOING_DIR, BerthLauncher, type BerthNames, berthContainer_spec, berthName_matches, berthNames_derive, berthPlaces_check, cohort_word, imageRecord_read, pullFailure_read, stats_digest, volumesOwnScript_build } from '../../src/launcher/launcher.js';
import { BERTH_LIMITS_DEFAULT, berthPolicy_read, capacityRefusal_words, type BerthPolicy } from '../../src/launcher/policy.js';
import { launcherServer_create, secret_matches } from '../../src/launcher/server.js';
import { launcherSecret_read } from '../../src/launcher/secret.js';
import { LauncherHost, identity_split, launcher_call } from '../../src/host/launcherHost.js';
import { porterConfig_resolve } from '../../src/config.js';
import { SessionRegistry } from '../../src/registry.js';
import { idleSweep_run } from '../../src/sweep.js';

const CUBE: string = 'http://cube.example.org/api/v1/';
const SECRET: string = 's'.repeat(40);

/** An engine in memory: networks with their members, volumes with their labels, containers, the commands run in them and what they read on stdin. */
class FakeDocker implements DockerApi {
  networks: Map<string, { options: Record<string, string>; members: Set<string> }> = new Map();
  volumes: Map<string, Record<string, string>> = new Map();
  containers: Map<string, { spec: Record<string, unknown>; running: boolean; ip: string; token: string | null }> = new Map();
  execs: Array<{ container: string; cmd: string[]; user: string; stdin: string | null }> = [];
  /** What the engine answers a network removal with; 204 unless a test has it refuse. */
  unwireStatus: number = 204;
  /** What the engine answers a container stop with; 204 unless a test has it refuse. */
  stopStatus: number = 204;
  /** A berth whose session never writes its berth file. */
  silent: boolean = false;
  /** Each container's log, a line each; absent: nothing written. */
  logs: Map<string, string[]> = new Map();
  /** Who follows each container's log, and how each follow ends. */
  private followers: Map<string, Set<{ onLine: LogLineSink; settle: () => void }>> = new Map();

  /** A line the container writes to its log, told to whoever follows it. */
  log_write(container: string, line: string): void {
    this.logs.set(container, [...(this.logs.get(container) ?? []), line]);
    for (const one of this.followers.get(container) ?? []) one.onLine(line, 'out');
  }

  /** The engine ends every follow of a container's log, as it does when the container stops. */
  log_end(container: string): void {
    for (const one of this.followers.get(container) ?? []) one.settle();
    this.followers.delete(container);
  }

  logs_follow(container: string, fromStart: boolean, onLine: LogLineSink): LogFollow {
    if (fromStart) for (const line of this.logs.get(container) ?? []) onLine(line, 'out');
    let settle: () => void = (): void => undefined;
    const ended: Promise<void> = new Promise<void>((resolve) => { settle = resolve; });
    const one = { onLine, settle: (): void => { settle(); } };
    const set = this.followers.get(container) ?? new Set();
    set.add(one);
    this.followers.set(container, set);
    return { stop: (): void => { set.delete(one); settle(); }, ended };
  }
  /** The gateway every network inspect names; null: the network has an address range and no gateway. */
  gateway: string | null = '172.18.0.1';
  /** What the one-shot container that gives the volumes away exits with. */
  ownExit: number = 0;
  /** The CPUs and bytes of memory the engine reports for the host. */
  host: { cpus: number; memory: number } = { cpus: 24, memory: 64 * 1024 ** 3 };
  /** The stats sample the engine gives for a running container; absent: none. */
  stats: Record<string, unknown> = {};
  /** Containers whose stats call the engine never answers. */
  hung: Set<string> = new Set();
  /** The images the host holds a copy of. */
  images: Set<string> = new Set(['mbw/mise-berth@sha256:abc']);
  /** Every container made, helpers too, in order, with the body it was made from. */
  made: Array<{ name: string; spec: Record<string, unknown> }> = [];
  /** Each image a pull asked the registry for. */
  pulls: string[] = [];
  /** Why the registry refuses a pull, said in the progress stream; null: it gives the image. */
  pullError: string | null = null;
  /** The status the engine answers a pull with. */
  pullStatus: number = 200;
  /** Whether the engine never answers a pull. */
  pullHangs: boolean = false;
  /** A pull that waits on this before it answers; null: it answers at once. */
  pullGate: Promise<void> | null = null;
  /** What a pull that lands says last. */
  pullSays: string = 'Status: Image is up to date for the image';
  private serial: number = 2;

  async call(method: string, path: string, body?: unknown): Promise<DockerAnswer> {
    const [route = '', query = ''] = path.split('?');
    const parts: string[] = route.split('/');
    const name: string = decodeURIComponent(parts[2] ?? '');
    if (method === 'POST' && route === '/images/create') {
      const image: string = new URLSearchParams(query).get('fromImage') ?? '';
      this.pulls.push(image);
      if (this.pullHangs) return new Promise<DockerAnswer>((): void => undefined);
      if (this.pullGate !== null) await this.pullGate;
      if (this.pullStatus !== 200) return { status: this.pullStatus, body: { message: 'the registry is away' } };
      if (this.pullError !== null) return { status: 200, body: `{"status":"Pulling from mise-berth"}\r\n${JSON.stringify({ errorDetail: { message: this.pullError }, error: this.pullError })}\r\n` };
      this.images.add(image);
      return { status: 200, body: `{"status":"Pulling from mise-berth"}\r\n${JSON.stringify({ status: this.pullSays })}\r\n` };
    }
    if (method === 'GET' && parts[1] === 'images') {
      const image: string = route.slice('/images/'.length, -'/json'.length);
      // As the engine names a pulled tag: by its repository and the digest it holds.
      return this.images.has(image) ? { status: 200, body: { RepoDigests: [`${image.replace(/:[^/:@]+$/, '')}@sha256:feed`] } } : { status: 404, body: {} };
    }
    if (method === 'GET' && route === '/info') return { status: 200, body: { NCPU: this.host.cpus, MemTotal: this.host.memory } };
    if (route === '/networks/create') { const spec = body as { Name: string; Options?: Record<string, string> }; this.networks.set(spec.Name, { options: spec.Options ?? {}, members: new Set() }); return { status: 201, body: {} }; }
    if (method === 'GET' && route === '/networks') return { status: 200, body: [...this.networks.keys()].map((one) => ({ Name: one })) };
    if (route.endsWith('/connect') && parts[1] === 'networks') { this.networks.get(name)?.members.add((body as { Container: string }).Container); return { status: 200, body: null }; }
    if (route.endsWith('/disconnect') && parts[1] === 'networks') { this.networks.get(name)?.members.delete((body as { Container: string }).Container); return { status: 200, body: null }; }
    if (method === 'GET' && parts[1] === 'networks') {
      const net = this.networks.get(name);
      return net === undefined ? { status: 404, body: {} } : { status: 200, body: { Name: name, Containers: Object.fromEntries([...net.members].map((member) => [member, { Name: member }])), IPAM: { Config: [{ Subnet: '172.18.0.0/16', ...(this.gateway !== null ? { Gateway: this.gateway } : {}) }] } } };
    }
    if (method === 'DELETE' && parts[1] === 'networks') {
      if (this.unwireStatus !== 204) return { status: this.unwireStatus, body: { message: 'network has active endpoints' } };
      const had = this.networks.delete(name);
      return { status: had ? 204 : 404, body: null };
    }
    if (route === '/volumes/create') { const spec = body as { Name: string; Labels: Record<string, string> }; this.volumes.set(spec.Name, spec.Labels); return { status: 201, body: {} }; }
    if (method === 'DELETE' && parts[1] === 'volumes') { const had = this.volumes.delete(name); return { status: had ? 204 : 404, body: null }; }
    if (method === 'GET' && route === '/volumes') {
      const filter = JSON.parse(decodeURIComponent(new URLSearchParams(query).get('filters') ?? '{}')) as { label?: string[] };
      const wanted: string[] = filter.label ?? [];
      return { status: 200, body: { Volumes: [...this.volumes.entries()].filter(([, labels]) => wanted.every((one) => { const [key = '', value = ''] = one.split('='); return labels[key] === value; })).map(([one, labels]) => ({ Name: one, Labels: labels })), Warnings: null } };
    }
    if (method === 'GET' && route.endsWith('/stats')) {
      if (this.hung.has(name)) return new Promise<DockerAnswer>((): void => undefined);
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
      this.made.push({ name: made, spec });
      return { status: 201, body: { Id: made } };
    }
    const found = this.containers.get(name);
    if (method === 'GET' && route.endsWith('/logs')) {
      const tail: number = Number(new URLSearchParams(query).get('tail') ?? '0');
      const lines: string[] = this.logs.get(name) ?? [];
      return { status: found === undefined ? 404 : 200, body: lines.length === 0 ? null : `${lines.slice(-tail).join('\n')}\n` };
    }
    if (method === 'GET' && route.endsWith('/json')) {
      if (found === undefined) return { status: 404, body: {} };
      const wire: string = String((found.spec['HostConfig'] as Record<string, unknown>)['NetworkMode']);
      return { status: 200, body: { State: { Running: found.running }, Config: { User: found.spec['User'], Labels: found.spec['Labels'] }, HostConfig: found.spec['HostConfig'], NetworkSettings: { Networks: { [wire]: { IPAddress: found.ip } } } } };
    }
    if (route.endsWith('/start')) { if (found !== undefined) found.running = true; return { status: 204, body: null }; }
    if (route.endsWith('/wait')) { if (found !== undefined) found.running = false; return { status: 200, body: { StatusCode: name.endsWith('-own') ? this.ownExit : 0 } }; }
    if (route.endsWith('/stop')) {
      if (this.stopStatus !== 204) return { status: this.stopStatus, body: { message: 'cannot stop container: permission denied' } };
      if (found !== undefined) found.running = false;
      return { status: 204, body: null };
    }
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
function launcher_make(docker: FakeDocker, policy: BerthPolicy = POLICY, porterContainer: string | null = 'porter', statsMs?: number): BerthLauncher {
  return new BerthLauncher({ docker, policy, image: 'mbw/mise-berth@sha256:abc', prefix: 'mbw', cubeNetwork: 'mbw-cube-net', porterContainer, bootMs: 300, pollMs: 10, ...(statsMs !== undefined ? { statsMs } : {}) });
}

/** A running berth under the legacy name, `<prefix>-<key>`, on its person's wire with porter. */
function legacy_put(docker: FakeDocker, user: string, identity: string): void {
  const names = berthNames_derive('mbw', identity, user);
  docker.networks.set(names.network, { options: {}, members: new Set(['porter', names.containerLegacy]) });
  docker.containers.set(names.containerLegacy, { spec: { User: '7:7', Labels: { [BERTH_LABEL]: 'mbw', [`${BERTH_LABEL}.identity`]: identity, [`${BERTH_LABEL}.user`]: user, [`${BERTH_LABEL}.cohort`]: 'none' }, HostConfig: { NetworkMode: names.network } }, running: true, ip: '10.213.77.99', token: 'old-token' });
}

/** The mounts a berth had on the cohort volume: `/incoming` read-only and `/outgoing`, both from `…-cohort-none`. */
function mountsOld_build(names: BerthNames): Array<Record<string, unknown>> {
  return [
    { Type: 'volume', Source: names.home, Target: '/home/ana', ReadOnly: false, VolumeOptions: { NoCopy: true } },
    { Type: 'volume', Source: names.cohortLegacy, Target: '/incoming', ReadOnly: true, VolumeOptions: { NoCopy: true, Subpath: 'incoming' } },
    { Type: 'volume', Source: names.cohortLegacy, Target: '/outgoing', ReadOnly: false, VolumeOptions: { NoCopy: true, Subpath: 'outgoing' } },
  ];
}

/** Ana's berth as a launcher on the cohort volume left it: her home, her `…-cohort-none` volume, and her berth running on their places, on her wire with porter. */
function oldShape_put(docker: FakeDocker, names: BerthNames): void {
  docker.volumes.set(names.home, { [BERTH_LABEL]: 'mbw', [`${BERTH_LABEL}.user`]: 'ana', [`${BERTH_LABEL}.volume`]: 'home' });
  docker.volumes.set(names.cohortLegacy, { [BERTH_LABEL]: 'mbw', [`${BERTH_LABEL}.identity`]: ANA, [`${BERTH_LABEL}.user`]: 'ana', [`${BERTH_LABEL}.volume`]: 'cohort', [`${BERTH_LABEL}.cohort`]: 'none' });
  docker.networks.set(names.network, { options: {}, members: new Set(['porter', names.container]) });
  docker.containers.set(names.container, { spec: { User: '7:7', Labels: { [BERTH_LABEL]: 'mbw', [`${BERTH_LABEL}.identity`]: ANA, [`${BERTH_LABEL}.user`]: 'ana', [`${BERTH_LABEL}.cohort`]: 'none' }, HostConfig: { Mounts: mountsOld_build(names), NetworkMode: names.network } }, running: true, ip: '10.213.77.98', token: 'old-token' });
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
  it('names one home for life, one work volume per person, the cohort volume /outgoing was on, and one wire per person', () => {
    const key: string = berthKey_compute(ANA);
    expect(berthNames_derive('mbw', ANA, 'ana')).toEqual({ container: `mbw-ana-${key}`, containerLegacy: `mbw-${key}`, network: 'mbw-net-ana', home: `mbw-${key}-home`, work: `mbw-${key}-work`, cohortLegacy: `mbw-${key}-cohort-none` });
    expect(berthNames_derive('mbw', identity_normalise('a.b+c@x', CUBE), 'a.b+c@x').network).toBe('mbw-net-a.b-c-x');
    expect(cohort_word(undefined)).toBe('none');
    expect(cohort_word(7)).toBe('7');
  });

  it('names the container by the prefix, the user as the wire spells them, and the key: readable, and apart for the same user on two CUBEs', () => {
    const odd: string = identity_normalise('a.b+c@x', CUBE);
    expect(berthNames_derive('mbw', odd, 'a.b+c@x').container).toBe(`mbw-a.b-c-x-${berthKey_compute(odd)}`);
    const elsewhere: string = identity_normalise('ana', 'http://other.example.org/api/v1/');
    expect(berthNames_derive('mbw', elsewhere, 'ana').container).toBe(`mbw-ana-${berthKey_compute(elsewhere)}`);
    expect(berthNames_derive('mbw', elsewhere, 'ana').container).not.toBe(berthNames_derive('mbw', ANA, 'ana').container);
    // The volumes hold a person's data: named by the key alone, whatever the container is called.
    expect(berthNames_derive('mbw', odd, 'a.b+c@x')).toMatchObject({ home: `mbw-${berthKey_compute(odd)}-home`, work: `mbw-${berthKey_compute(odd)}-work` });
  });

  it('knows a berth by its name, the legacy one too, and a helper, porter or another prefix as none', () => {
    const names = berthNames_derive('mise.berth', ANA, 'ana');
    expect(berthName_matches('mise.berth', names.container)).toBe(true);
    expect(berthName_matches('mise.berth', names.containerLegacy)).toBe(true);
    expect(berthName_matches('mise.berth', berthNames_derive('mise.berth', identity_normalise('a.b+c@x', CUBE), 'a.b+c@x').container)).toBe(true);
    expect(berthName_matches('mise.berth', `${names.container}-own`)).toBe(false);
    expect(berthName_matches('mise.berth', `${names.containerLegacy}-own`)).toBe(false);
    expect(berthName_matches('mise.berth', 'mise.berth-porter-standin')).toBe(false);
    expect(berthName_matches('mise.berth', 'porter')).toBe(false);
    // The prefix is read as written, never as a pattern.
    expect(berthName_matches('mise.berth', names.container.replace('mise.berth', 'misexberth'))).toBe(false);
  });

  it('fixes everything but who it is for: the image, the home and the work volume\'s anchors and outgoing by subpath, both writable, no /incoming, the places named in the environment, the token tmpfs, the limits, no privilege, no engine, a read-only root, its own wire and cube-net', () => {
    const spec = berthContainer_spec({ image: 'img@sha256:abc', prefix: 'mbw', cubeNetwork: 'mbw-cube-net', policy: POLICY }, { user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'secret-cube-token', cohort: 42 }, ANA);
    const names = berthNames_derive('mbw', ANA, 'ana');
    const host = spec['HostConfig'] as Record<string, unknown>;
    expect(spec['Image']).toBe('img@sha256:abc');
    expect(spec['User']).toBe('7:7');
    expect(spec['Env']).toContain('MISE_COHORT=42');
    expect(spec['Env']).toEqual(expect.arrayContaining(['MISE_BERTH_ANCHORS=/anchors', 'MISE_BERTH_OUTGOING=/outgoing', 'MISE_BERTH_IMAGE=img@sha256:abc']));
    expect(BERTH_ANCHORS_DIR).toBe('/anchors');
    expect(BERTH_OUTGOING_DIR).toBe('/outgoing');
    expect(host['Mounts']).toEqual([
      { Type: 'volume', Source: names.home, Target: '/home/ana', ReadOnly: false, VolumeOptions: { NoCopy: true } },
      { Type: 'volume', Source: names.work, Target: '/anchors', ReadOnly: false, VolumeOptions: { NoCopy: true, Subpath: 'anchors' } },
      { Type: 'volume', Source: names.work, Target: '/outgoing', ReadOnly: false, VolumeOptions: { NoCopy: true, Subpath: 'outgoing' } },
    ]);
    expect(JSON.stringify(spec)).not.toContain('/incoming');
    expect(JSON.stringify(spec)).not.toContain('-cohort-');
    // The cohort selects no volume: another cohort, or none, mounts the same work volume.
    expect(berthContainer_spec({ image: 'img@sha256:abc', prefix: 'mbw', cubeNetwork: 'mbw-cube-net', policy: POLICY }, { user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 't', cohort: null }, ANA)['HostConfig']).toMatchObject({ Mounts: host['Mounts'] });
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
    const names = berthNames_derive('mbw', ANA, 'ana');
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

  it('starts a berth: cube-net blocking its containers from one another, the person\'s own wire with porter joined, the home and the work volume made, labelled and given to the uid, the token written on stdin as the user, the address on the wire', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    const berth = await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token', cohort: 42 });
    const names = berthNames_derive('mbw', ANA, 'ana');
    expect(docker.networks.get('mbw-cube-net')?.options).toEqual({ 'com.docker.network.bridge.enable_icc': 'false' });
    expect([...docker.networks.get('mbw-net-ana')?.members ?? []].sort()).toEqual([names.container, 'porter']);
    expect([...docker.networks.get('mbw-cube-net')?.members ?? []]).toEqual([names.container]);
    expect([...docker.volumes.keys()].sort()).toEqual([names.home, names.work].sort());
    expect(docker.volumes.get(names.work)).toEqual({ [BERTH_LABEL]: 'mbw', [`${BERTH_LABEL}.identity`]: ANA, [`${BERTH_LABEL}.user`]: 'ana', [`${BERTH_LABEL}.volume`]: 'work' });
    // The one-shot root container gives both volumes to the uid, anchors/ and outgoing/ made in the work volume, and copies nothing when there is no cohort volume.
    const helper = docker.made.find((one) => one.name === `${names.container}-own`);
    expect(helper?.spec).toMatchObject({ User: '0:0', Entrypoint: ['sh', '-c', volumesOwnScript_build(7, 7, false)], HostConfig: { Binds: [`${names.home}:/v/home`, `${names.work}:/v/work`], NetworkMode: 'none', CapDrop: ['ALL'], CapAdd: ['CHOWN', 'DAC_OVERRIDE'] } });
    expect(docker.containers.has(`${names.container}-own`)).toBe(false);
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

  it('pulls the image before it makes a berth from it, so a tag that moved is followed; a running berth is handed back with no pull', async () => {
    const said: string[] = [];
    const launcher: BerthLauncher = new BerthLauncher({ docker, policy: POLICY, image: BERTH_IMAGE_DEFAULT, prefix: 'mbw', cubeNetwork: 'mbw-cube-net', porterContainer: 'porter', bootMs: 300, pollMs: 10, log: (line: string): void => { said.push(line); } });
    expect(BERTH_IMAGE_DEFAULT).toBe('ghcr.io/harbor-medical-ai/mise-berth:latest');
    docker.images.clear();
    docker.pullSays = `Status: Downloaded newer image for ${BERTH_IMAGE_DEFAULT}`;
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' });
    const names = berthNames_derive('mbw', ANA, 'ana');
    expect(docker.pulls).toEqual([BERTH_IMAGE_DEFAULT]);
    expect(docker.containers.get(names.container)?.spec['Image']).toBe(BERTH_IMAGE_DEFAULT);
    // The berth is told the build it runs: the tag with the digest the host holds for it.
    expect(docker.containers.get(names.container)?.spec['Env']).toContain(`MISE_BERTH_IMAGE=${BERTH_IMAGE_DEFAULT}@sha256:feed`);
    expect(said).toEqual([`pulled a newer berth image ${BERTH_IMAGE_DEFAULT}`]);
    // The same berth asked for again is running: nothing is made, so nothing is pulled.
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token-2' });
    expect(docker.pulls).toHaveLength(1);
    // Made again (another cohort): pulled again; an image already the newest is not worth a line.
    docker.pullSays = `Status: Image is up to date for ${BERTH_IMAGE_DEFAULT}`;
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token', cohort: 9 });
    expect(docker.pulls).toHaveLength(2);
    expect(said).toHaveLength(1);
  });

  it('names the image a close records: the tag with the digest the engine holds, or the tag alone', () => {
    expect(imageRecord_read('ghcr.io/x/mise-berth:latest', { RepoDigests: ['ghcr.io/x/mise-berth@sha256:abc'] })).toBe('ghcr.io/x/mise-berth:latest@sha256:abc');
    expect(imageRecord_read('ghcr.io/x/mise-berth:latest', { RepoDigests: [] })).toBe('ghcr.io/x/mise-berth:latest');
    expect(imageRecord_read('ghcr.io/x/mise-berth:latest', { message: 'no such image' })).toBe('ghcr.io/x/mise-berth:latest');
    expect(imageRecord_read('ghcr.io/x/mise-berth:latest', null)).toBe('ghcr.io/x/mise-berth:latest');
    // An image already named by its digest is recorded as it is.
    expect(imageRecord_read('img@sha256:abc', { RepoDigests: ['img@sha256:other'] })).toBe('img@sha256:abc');
  });

  it('a pull that fails does not fail the start when the host holds the image: it is said in the log and the copy is used', async () => {
    const said: string[] = [];
    const launcher: BerthLauncher = new BerthLauncher({ docker, policy: POLICY, image: BERTH_IMAGE_DEFAULT, prefix: 'mbw', cubeNetwork: 'mbw-cube-net', porterContainer: 'porter', bootMs: 300, pollMs: 10, pullMs: 30, log: (line: string): void => { said.push(line); } });
    docker.images.add(BERTH_IMAGE_DEFAULT);
    docker.pullError = 'manifest unknown';
    expect((await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' })).state).toBe('running');
    docker.pullError = null;
    docker.pullStatus = 500;
    expect((await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token', cohort: 2 })).state).toBe('running');
    docker.pullStatus = 200;
    docker.pullHangs = true;
    expect((await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token', cohort: 3 })).state).toBe('running');
    expect(said).toEqual([
      `the berth image ${BERTH_IMAGE_DEFAULT} was not pulled (manifest unknown): the copy this host holds is used`,
      `the berth image ${BERTH_IMAGE_DEFAULT} was not pulled (the engine answered 500: the registry is away): the copy this host holds is used`,
      `the berth image ${BERTH_IMAGE_DEFAULT} was not pulled (the engine gave no answer in time): the copy this host holds is used`,
    ]);
    // A launcher given no log says nothing and starts the berth all the same.
    const quiet = new FakeDocker();
    quiet.pullError = 'manifest unknown';
    expect((await launcher_make(quiet).start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' })).state).toBe('running');
  });

  it('refuses a start when the pull fails and the host holds no copy of the image, making nothing', async () => {
    docker.images.clear();
    docker.pullError = 'denied';
    await expect(launcher_make(docker).start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' })).rejects.toMatchObject({ status: 502, message: 'the berth image mbw/mise-berth@sha256:abc was not pulled (denied) and this host holds no copy of it' });
    expect(docker.containers.size).toBe(0);
    expect(docker.volumes.size).toBe(0);
  });

  it('reads why a pull did not land: no answer, a refusal, an error in the progress stream; a pull that landed has none', () => {
    expect(pullFailure_read({ status: 0, body: null })).toBe('the engine gave no answer in time');
    expect(pullFailure_read({ status: 404, body: { message: 'no such image' } })).toBe('the engine answered 404: no such image');
    expect(pullFailure_read({ status: 500, body: 'oops' })).toBe('the engine answered 500');
    expect(pullFailure_read({ status: 200, body: '{"status":"Pulling"}\r\nnot json\r\n{"error":"manifest unknown"}\r\n' })).toBe('manifest unknown');
    expect(pullFailure_read({ status: 200, body: { error: 'denied' } })).toBe('denied');
    expect(pullFailure_read({ status: 200, body: { status: 'Image is up to date' } })).toBeNull();
    expect(pullFailure_read({ status: 200, body: '{"status":"Pulling"}\r\n{"status":"Downloaded newer image"}\r\n' })).toBeNull();
    expect(pullFailure_read({ status: 200, body: null })).toBeNull();
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

  it('takes a cohort as a label alone: another cohort makes the berth again on the same home and work volume, and no cohort volume is made', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token', cohort: 42 });
    const moved = await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token', cohort: null });
    expect(moved.cohort).toBe('none');
    const names = berthNames_derive('mbw', ANA, 'ana');
    expect([...docker.volumes.keys()].sort()).toEqual([names.home, names.work].sort());
    expect(docker.containers.size).toBe(1);
    expect((docker.containers.get(names.container)?.spec['Labels'] as Record<string, string>)[`${BERTH_LABEL}.cohort`]).toBe('none');
    // The volumes were given once, at the first start.
    expect(docker.made.filter((one) => one.name.endsWith('-own'))).toHaveLength(1);
    await expect(launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 't', cohort: -1 })).rejects.toThrow('a cohort is a feed\'s id');
  });

  it('reads a container\'s places from either list the engine names its mounts in, and knows the cohort volume\'s places as not the work volume\'s', () => {
    const names = berthNames_derive('mbw', ANA, 'ana');
    const current = (berthContainer_spec({ image: 'img', prefix: 'mbw', cubeNetwork: 'mbw-cube-net', policy: POLICY }, { user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 't' }, ANA)['HostConfig'] as Record<string, unknown>)['Mounts'];
    expect(berthPlaces_check({ HostConfig: { Mounts: current } }, names.work)).toBe(true);
    expect(berthPlaces_check({ Mounts: [{ Type: 'volume', Name: names.work, Destination: '/anchors' }, { Type: 'volume', Name: names.work, Destination: '/outgoing' }] }, names.work)).toBe(true);
    expect(berthPlaces_check({ HostConfig: { Mounts: mountsOld_build(names) } }, names.work)).toBe(false);
    expect(berthPlaces_check({ Mounts: [{ Type: 'volume', Name: names.cohortLegacy, Destination: '/incoming' }, { Type: 'volume', Name: names.cohortLegacy, Destination: '/outgoing' }] }, names.work)).toBe(false);
    expect(berthPlaces_check({ HostConfig: { Mounts: [{ Source: names.work, Target: '/anchors' }] } }, names.work)).toBe(false);
    expect(berthPlaces_check({}, names.work)).toBe(false);
  });

  it('makes a berth running on the cohort volume\'s places again on the work volume\'s, rather than handing it back; the home and the cohort volume are kept', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    const names = berthNames_derive('mbw', ANA, 'ana');
    oldShape_put(docker, names);
    const berth = await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' });
    expect(berth.state).toBe('running');
    expect(docker.made.filter((one) => one.name === names.container)).toHaveLength(1);
    const spec = docker.containers.get(names.container)?.spec ?? {};
    expect(((spec['HostConfig'] as Record<string, unknown>)['Mounts'] as Array<Record<string, unknown>>).map((one) => `${String(one['Source'])}:${String(one['Target'])}`)).toEqual([`${names.home}:/home/ana`, `${names.work}:/anchors`, `${names.work}:/outgoing`]);
    expect(spec['Env']).toEqual(expect.arrayContaining(['MISE_BERTH_ANCHORS=/anchors', 'MISE_BERTH_OUTGOING=/outgoing']));
    expect(docker.volumes.has(names.cohortLegacy)).toBe(true);
    expect(docker.volumes.get(names.home)).toEqual({ [BERTH_LABEL]: 'mbw', [`${BERTH_LABEL}.user`]: 'ana', [`${BERTH_LABEL}.volume`]: 'home' });
    // On its new places it is handed back as it stands at the next start.
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token-2' });
    expect(docker.made.filter((one) => one.name === names.container)).toHaveLength(1);
    expect(docker.containers.get(names.container)?.token).toBe('ana-token-2\n');
  });

  it('copies the cohort volume\'s outgoing/ into the work volume once, as the work volume is made, the cohort volume read-only and kept', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    const names = berthNames_derive('mbw', ANA, 'ana');
    oldShape_put(docker, names);
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' });
    const helpers = (): Array<{ name: string; spec: Record<string, unknown> }> => docker.made.filter((one) => one.name === `${names.container}-own`);
    expect(helpers()).toHaveLength(1);
    expect(helpers()[0]?.spec).toMatchObject({ User: '0:0', Entrypoint: ['sh', '-c', volumesOwnScript_build(7, 7, true)], HostConfig: { Binds: [`${names.home}:/v/home`, `${names.work}:/v/work`, `${names.cohortLegacy}:/v/old:ro`] } });
    expect(docker.volumes.get(names.work)).toMatchObject({ [`${BERTH_LABEL}.volume`]: 'work' });
    expect(docker.volumes.has(names.cohortLegacy)).toBe(true);
    // The work volume stands: a berth made again copies nothing and runs no helper.
    await launcher.stop('ana', CUBE);
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' });
    expect(helpers()).toHaveLength(1);
    // A home made anew beside a work volume that stands is given without a copy.
    docker.volumes.delete(names.home);
    await launcher.stop('ana', CUBE);
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' });
    expect(helpers()).toHaveLength(2);
    expect(helpers()[1]?.spec).toMatchObject({ Entrypoint: ['sh', '-c', volumesOwnScript_build(7, 7, false)], HostConfig: { Binds: [`${names.home}:/v/home`, `${names.work}:/v/work`] } });
  });

  it('a copy that fails removes the work volume it was made into, so the next start copies again; the cohort volume is kept', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    const names = berthNames_derive('mbw', ANA, 'ana');
    oldShape_put(docker, names);
    docker.ownExit = 1;
    await expect(launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' })).rejects.toThrow('ana\'s volumes were not given to them (exit 1)');
    expect(docker.volumes.has(names.work)).toBe(false);
    expect(docker.volumes.has(names.home)).toBe(true);
    expect(docker.volumes.has(names.cohortLegacy)).toBe(true);
    docker.ownExit = 0;
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' });
    expect(docker.made.filter((one) => one.name === `${names.container}-own`).map((one) => (one.spec['HostConfig'] as { Binds: string[] }).Binds.at(-1))).toEqual([`${names.cohortLegacy}:/v/old:ro`, `${names.cohortLegacy}:/v/old:ro`]);
  });

  it('builds the helper\'s command: the work volume\'s two places made and both volumes given to the uid, and the copy only when asked, links kept as links', () => {
    expect(volumesOwnScript_build(7, 8, false)).toBe('mkdir -p /v/work/anchors /v/work/outgoing && chown 7:8 /v/home /v/work /v/work/anchors /v/work/outgoing');
    expect(volumesOwnScript_build(7, 8, true)).toBe('mkdir -p /v/work/anchors /v/work/outgoing && chown 7:8 /v/home /v/work /v/work/anchors /v/work/outgoing && if [ -d /v/old/outgoing ]; then cp -R /v/old/outgoing/. /v/work/outgoing/ && chown -hR 7:8 /v/work/outgoing; fi');
    expect(volumesOwnScript_build(7, 8, true)).not.toContain('incoming');
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

  it('a start removes the container left under the legacy name and makes the berth under its own; the home and the wire are the same', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    const names = berthNames_derive('mbw', ANA, 'ana');
    legacy_put(docker, 'ana', ANA);
    expect((await launcher.status({ user: 'ana', cubeUrl: CUBE }))[0]).toMatchObject({ state: 'running', container: names.containerLegacy });
    const berth = await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' });
    expect(berth).toMatchObject({ state: 'running', container: names.container });
    expect([...docker.containers.keys()]).toEqual([names.container]);
    expect([...docker.networks.get(names.network)?.members ?? []].sort()).toEqual([names.container, 'porter']);
    expect(docker.volumes.has(names.home)).toBe(true);
    expect((await launcher.status(null)).map((one) => one.container)).toEqual([names.container]);
  });

  it('a berth under the legacy name holds its place on a full spoke until its person starts again', async () => {
    const launcher: BerthLauncher = launcher_make(docker, { limits: BERTH_LIMITS_DEFAULT, holds: 1 });
    legacy_put(docker, 'ana', ANA);
    await expect(launcher.start({ user: 'rudolph', uid: 3, gid: 3, cubeUrl: CUBE, token: 'r-token' })).rejects.toThrow('this ChRIS holds 1 berth, in use by ana');
    expect((await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' })).state).toBe('running');
    expect(docker.containers.size).toBe(1);
  });

  it('a stop removes the container under the legacy name, alone or beside the one under its own, with the wire', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    const names = berthNames_derive('mbw', ANA, 'ana');
    legacy_put(docker, 'ana', ANA);
    expect(await launcher.stop('ana', CUBE)).toBe(true);
    expect(docker.containers.size).toBe(0);
    expect(docker.networks.has(names.network)).toBe(false);
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' });
    legacy_put(docker, 'ana', ANA);
    expect(await launcher.stop('ana', CUBE)).toBe(true);
    expect(docker.containers.size).toBe(0);
    expect(await launcher.stop('ana', CUBE)).toBe(false);
  });

  it('the sweep keeps a wire with a berth on it, under its name or the legacy one, and removes one with neither', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' });
    const rudolph: string = identity_normalise('rudolph', CUBE);
    legacy_put(docker, 'rudolph', rudolph);
    docker.networks.set('mbw-net-ghost', { options: {}, members: new Set(['porter', `${berthNames_derive('mbw', ANA, 'ana').container}-own`]) });
    expect(await launcher.orphans_clear()).toEqual(['mbw-net-ghost']);
    expect(docker.networks.has('mbw-net-ana')).toBe(true);
    expect(docker.networks.has('mbw-net-rudolph')).toBe(true);
    expect(docker.containers.has(berthNames_derive('mbw', rudolph, 'rudolph').containerLegacy)).toBe(true);
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
    const names = berthNames_derive('mbw', ANA, 'ana');
    docker.containers.get(names.container)!.running = false;
    const restarted = await launcher.start({ user: 'ana', uid: 0, gid: 0, cubeUrl: CUBE, token: null });
    expect(restarted.state).toBe('running');
    expect(docker.containers.get(names.container)?.spec['User']).toBe('7:7');
    docker.silent = true;
    await expect(launcher.start({ user: 'rudolph', uid: 3, gid: 3, cubeUrl: CUBE, token: 'r' })).rejects.toThrow('the berth wrote nothing for 0 s and did not answer: no words');
    // An earlier run's helper and a wire with no berth on it are removed, whoever else stands on it (porter, a helper); a wire with a berth is kept.
    docker.networks.set('mbw-net-ghost', { options: {}, members: new Set(['porter', 'mbw-porter-standin', 'mbw-x-own']) });
    docker.containers.set('mbw-x-own', { spec: { Labels: { [BERTH_LABEL]: 'mbw' } }, running: false, ip: '', token: null });
    expect((await launcher.orphans_clear()).sort()).toEqual(['mbw-net-ghost', 'mbw-x-own']);
    expect(docker.networks.has('mbw-net-ana')).toBe(true);
  });

  /** Writes one stamped line to a berth's log every few ms, as a session at work does; the returned call stops it. */
  function log_keepMoving(container: string): () => void {
    let line: number = 0;
    const timer: NodeJS.Timeout = setInterval((): void => {
      docker.log_write(container, `[PENDING] Queries     Indexing prior PACS queries behind the prompt (${line++})`);
    }, 15);
    return (): void => { clearInterval(timer); };
  }

  it('waits past the silence limit for a berth whose log still moves, and hands it back once its berth file is written', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    const names: BerthNames = berthNames_derive('mbw', ANA, 'ana');
    docker.silent = true;
    const halt: () => void = log_keepMoving(names.container);
    try {
      const started: Promise<unknown> = launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' });
      // Twice the 300 ms limit, the log moving all the while: still waited for.
      await new Promise<void>((resolve) => { setTimeout(resolve, 650); });
      docker.silent = false;
      await expect(started).resolves.toMatchObject({ state: 'running', token: `attach-${names.container}` });
    } finally {
      halt();
    }
  });

  it('refuses a berth whose log stops moving for the whole limit, with the last words it wrote', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    const names: BerthNames = berthNames_derive('mbw', ANA, 'ana');
    docker.silent = true;
    docker.logs.set(names.container, ['[ OK ]    CUBE        Connected']);
    await expect(launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' })).rejects.toMatchObject({ status: 502, message: 'the berth wrote nothing for 0 s and did not answer: [ OK ]    CUBE        Connected' });
  });

  it('refuses a berth that stops while it boots, as it always did, with its last words', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    const names: BerthNames = berthNames_derive('mbw', ANA, 'ana');
    docker.silent = true;
    // The session says why and exits; the engine ends the log with the container.
    setTimeout((): void => {
      docker.log_write(names.container, '[!] could not reach CUBE');
      docker.containers.get(names.container)!.running = false;
      docker.log_end(names.container);
    }, 40);
    await expect(launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' })).rejects.toMatchObject({ status: 502, message: 'the berth stopped as it started: [!] could not reach CUBE' });
  });

  it('refuses a berth still writing at the ceiling that never answered, saying so', async () => {
    const launcher: BerthLauncher = new BerthLauncher({ docker, policy: POLICY, image: 'mbw/mise-berth@sha256:abc', prefix: 'mbw', cubeNetwork: 'mbw-cube-net', porterContainer: 'porter', bootMs: 300, bootCeilingMs: 400, pollMs: 10 });
    const names: BerthNames = berthNames_derive('mbw', ANA, 'ana');
    docker.silent = true;
    const halt: () => void = log_keepMoving(names.container);
    try {
      await expect(launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' })).rejects.toThrow(/^the berth was still starting after 0 s and did not answer: .*Indexing prior PACS queries/);
    } finally {
      halt();
    }
  });

  it('tells each line of a new berth\'s log as it boots, from its first, its attach token taken out; a berth found running, only the lines from then', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    const names: BerthNames = berthNames_derive('mbw', ANA, 'ana');
    docker.logs.set(names.container, ['[ OK ]    Plugins      Cached 284 plugins', '    token:     0123456789abcdef0123456789abcdef']);
    docker.silent = true;
    const told: string[] = [];
    setTimeout((): void => { docker.log_write(names.container, '[PENDING] Engine       5 steps warming'); docker.silent = false; }, 40);
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' }, (line: string): void => { told.push(line); });
    expect(told).toEqual(['[ OK ]    Plugins      Cached 284 plugins', '    token:     (held by the porter)', '[PENDING] Engine       5 steps warming']);
    // A later line is no longer followed, and a berth already running replays none.
    docker.log_write(names.container, '[ OK ]    Engine       Ready');
    expect(told).toHaveLength(3);
    const again: string[] = [];
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' }, (line: string): void => { again.push(line); });
    expect(again).toEqual([]);
  });

  it('splits the engine\'s framed log into lines across frames and chunks, stdout and stderr apart', () => {
    const frame = (kind: number, text: string): Buffer => Buffer.concat([Buffer.from([kind, 0, 0, 0]), Buffer.from([0, 0, 0, Buffer.byteLength(text)]), Buffer.from(text)]);
    const lines: Array<[string, string]> = [];
    const reader: DockerLogLines = new DockerLogLines((line: string, channel: 'out' | 'err'): void => { lines.push([channel, line]); });
    const stream: Buffer = Buffer.concat([frame(1, '[ OK ]    CUBE  Conn'), frame(1, 'ected\r\n[PENDING] '), frame(2, 'a warning\n'), frame(1, 'Public  Warming\n'), frame(1, 'no end')]);
    for (let at: number = 0; at < stream.length; at += 7) reader.chunk_take(stream.subarray(at, at + 7));
    reader.end();
    expect(lines).toEqual([['out', '[ OK ]    CUBE  Connected'], ['err', 'a warning'], ['out', '[PENDING] Public  Warming'], ['out', 'no end']]);
  });

  it('a login while the berth runs and has written no berth file yet joins the wait, rather than being refused at once', async () => {
    const first: BerthLauncher = launcher_make(docker);
    await first.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' });
    const names: BerthNames = berthNames_derive('mbw', ANA, 'ana');
    // The launcher made again (a restart) finds the berth running, its session still booting.
    docker.silent = true;
    const halt: () => void = log_keepMoving(names.container);
    try {
      const again: Promise<unknown> = launcher_make(docker).start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token-2' });
      await new Promise<void>((resolve) => { setTimeout(resolve, 400); });
      docker.silent = false;
      await expect(again).resolves.toMatchObject({ state: 'running', container: names.container });
      expect(docker.containers.get(names.container)?.token).toBe('ana-token-2\n');
    } finally {
      halt();
    }
  });

  it('reads each person\'s berth for the operator: a running one with what it uses, a stopped one as the home kept, a person with neither absent', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token', cohort: 42 });
    await launcher.start({ user: 'benito', uid: 8, gid: 8, cubeUrl: CUBE, token: 'benito-token' });
    await launcher.stop('benito', CUBE);
    await launcher.start({ user: 'carla', uid: 9, gid: 9, cubeUrl: CUBE, token: 'carla-token' });
    // Carla's container is up but the engine cannot sample it: she is running, her usage unread.
    docker.stats[berthNames_derive('mbw', ANA, 'ana').container] = {
      cpu_stats: { cpu_usage: { total_usage: 2_300_000 }, system_cpu_usage: 100_000_000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 2_000_000 }, system_cpu_usage: 90_000_000 },
      memory_stats: { usage: 300 * 1024 ** 2, limit: 2 * 1024 ** 3, stats: { inactive_file: 90 * 1024 ** 2 } },
    };
    docker.volumes.set('mbw-other-home', { [BERTH_LABEL]: 'another-spoke', [`${BERTH_LABEL}.user`]: 'zed', [`${BERTH_LABEL}.volume`]: 'home' });
    expect(await launcher.access_read(CUBE)).toEqual([
      { user: 'ana', state: 'running', cohort: '42', cpuPercent: 12, memoryBytes: 210 * 1024 ** 2, memoryLimitBytes: 2 * 1024 ** 3 },
      { user: 'benito', state: 'stopped', cohort: null, cpuPercent: null, memoryBytes: null, memoryLimitBytes: null },
      { user: 'carla', state: 'running', cohort: 'none', cpuPercent: null, memoryBytes: null, memoryLimitBytes: null },
    ]);
  });

  it('reads CPU as the engine\'s sample against the host\'s time, and memory without the page cache', () => {
    expect(stats_digest({})).toEqual({ cpuPercent: null, memoryBytes: null, memoryLimitBytes: null });
    expect(stats_digest({ cpu_stats: { cpu_usage: { total_usage: 5, percpu_usage: [1, 2] }, system_cpu_usage: 10 }, precpu_stats: { cpu_usage: { total_usage: 5 }, system_cpu_usage: 0 }, memory_stats: { usage: 50, stats: { cache: 80 } } }))
      .toEqual({ cpuPercent: 0, memoryBytes: 50, memoryLimitBytes: null });
  });

  it('reads memory as docker stats does: total_inactive_file first on cgroup v1, inactive_file on v2, a cache as large as the usage not taken', () => {
    const memory = (stats: Record<string, number>): number | null => stats_digest({ memory_stats: { usage: 1000, stats } }).memoryBytes;
    expect(memory({ total_inactive_file: 300, inactive_file: 100, cache: 500 })).toBe(700);
    expect(memory({ inactive_file: 100, cache: 500 })).toBe(900);
    expect(memory({ cache: 400 })).toBe(600);
    expect(memory({ total_inactive_file: 1000 })).toBe(1000);
    expect(memory({ total_inactive_file: 1200 })).toBe(1000);
  });

  it('reads the people of this CUBE only: a leftover of an earlier CUBE is not this person\'s, a home made before the label still counts for its user', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    const OLD: string = 'http://old-cube.example.org/api/v1/';
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' });
    await launcher.start({ user: 'dora', uid: 8, gid: 8, cubeUrl: OLD, token: 'dora-token' });
    await launcher.start({ user: 'eli', uid: 9, gid: 9, cubeUrl: CUBE, token: 'eli-token' });
    await launcher.stop('eli', CUBE);
    // Eli had a home on the earlier CUBE as well, and Fay's was made before volumes carried an identity.
    docker.volumes.set('mbw-eli-old-home', { [BERTH_LABEL]: 'mbw', [`${BERTH_LABEL}.identity`]: identity_normalise('eli', OLD), [`${BERTH_LABEL}.user`]: 'eli', [`${BERTH_LABEL}.volume`]: 'home' });
    docker.volumes.set('mbw-gil-old-home', { [BERTH_LABEL]: 'mbw', [`${BERTH_LABEL}.identity`]: identity_normalise('gil', OLD), [`${BERTH_LABEL}.user`]: 'gil', [`${BERTH_LABEL}.volume`]: 'home' });
    docker.volumes.set('mbw-fay-home', { [BERTH_LABEL]: 'mbw', [`${BERTH_LABEL}.user`]: 'fay', [`${BERTH_LABEL}.volume`]: 'home' });
    expect([...docker.volumes.entries()].find(([name]) => name === berthNames_derive('mbw', ANA, 'ana').home)?.[1][`${BERTH_LABEL}.identity`]).toBe(ANA);
    expect((await launcher.access_read(CUBE)).map((row) => `${row.user}:${row.state}`)).toEqual(['ana:running', 'eli:stopped', 'fay:stopped']);
    expect((await launcher.access_read(OLD)).map((row) => `${row.user}:${row.state}`)).toEqual(['dora:running', 'eli:stopped', 'fay:stopped', 'gil:stopped']);
  });

  it('reports one running berth for a person whose identity has two containers up, the same one whatever order the engine lists them', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token', cohort: 42 });
    const first: string = berthNames_derive('mbw', ANA, 'ana').container;
    const labels = { ...(docker.containers.get(first)?.spec['Labels'] as Record<string, string>), [`${BERTH_LABEL}.cohort`]: '7' };
    docker.containers.set('mbw-aaaa', { spec: { Labels: labels }, running: true, ip: '', token: null });
    const forward = await launcher.access_read(CUBE);
    docker.containers = new Map([...docker.containers.entries()].reverse());
    expect(await launcher.access_read(CUBE)).toEqual(forward);
    expect(forward).toEqual([{ user: 'ana', state: 'running', cohort: '7', cpuPercent: null, memoryBytes: null, memoryLimitBytes: null }]);
  });

  it('gives up on a container the engine does not sample in time: the berth is running, its usage unread', async () => {
    const launcher: BerthLauncher = launcher_make(docker, POLICY, 'porter', 50);
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' });
    docker.hung.add(berthNames_derive('mbw', ANA, 'ana').container);
    expect(await launcher.access_read(CUBE)).toEqual([{ user: 'ana', state: 'running', cohort: 'none', cpuPercent: null, memoryBytes: null, memoryLimitBytes: null }]);
  });

  it('a porter on the host joins no wire', async () => {
    const launcher: BerthLauncher = launcher_make(docker, POLICY, null);
    await launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' });
    expect([...docker.networks.get('mbw-net-ana')?.members ?? []]).toEqual([berthNames_derive('mbw', ANA, 'ana').container]);
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

  it('an engine that refuses the stop is a failed stop all the way up: the berth stays, the sweep keeps its session, a restart starts nothing', async () => {
    const reach = { listen: join(dir, 'launcher.sock'), secret: SECRET };
    const host: LauncherHost = new LauncherHost(reach, async (): Promise<number> => 7);
    await host.spawn(ANA, 'ana', CUBE, 'ana-token');
    const container: string = berthNames_derive('mbw', ANA, 'ana').container;
    docker.stopStatus = 500;
    await expect(host.evict(ANA)).rejects.toThrow(`the berth was not stopped: the engine did not stop ${container} (it answered 500)`);
    expect(docker.containers.has(container)).toBe(true);
    // The sweep: the session is still remembered, and it is said.
    const registry: SessionRegistry = new SessionRegistry((): number => 1_000_000_000);
    const entry = registry.note(ANA, 'ana', { identity: ANA, url: 'ws://10.9.0.2:1', token: 'a' });
    entry.activeAt = 0;
    const said: string[] = [];
    expect(await idleSweep_run(registry, host, 1000, (line: string): void => { said.push(line); })).toEqual([]);
    expect(registry.get(entry.key)).toBe(entry);
    expect(said.join('\n')).toContain('could not end ana\'s idle session');
    // A restart: its boot fails with the reason, and no second berth is made beside the first.
    const made: number = docker.made.length;
    host.restart_begin(ANA, 'ana', CUBE, { kind: 'asked' });
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    expect(host.boot_follow(ANA, { line: () => undefined, done: () => undefined })?.report).toMatchObject({ state: 'failed', reason: expect.stringContaining('the engine did not stop') });
    expect(docker.made.length).toBe(made);
    expect(docker.containers.has(container)).toBe(true);
  });

  it('a logout that arrives while a restart is making the new berth comes after it: both settled, there is no berth and no login held to restart on', async () => {
    const reach = { listen: join(dir, 'launcher.sock'), secret: SECRET };
    const host: LauncherHost = new LauncherHost(reach, async (): Promise<number> => 7);
    await host.spawn(ANA, 'ana', CUBE, 'ana-token');
    const container: string = berthNames_derive('mbw', ANA, 'ana').container;
    const registry: SessionRegistry = new SessionRegistry();
    const key: string = berthKey_compute(ANA);
    // The restart: the old berth is stopped, and the image step of the new one is held.
    let pulled: () => void = (): void => undefined;
    docker.pullGate = new Promise<void>((resolve: () => void): void => { pulled = resolve; });
    const pullsBefore: number = docker.pulls.length;
    const restarting: Promise<void> = registry.ending_run(key, (): Promise<void> => host.restart_begin(ANA, 'ana', CUBE, { kind: 'asked' }));
    for (let waited: number = 0; waited < 100 && docker.pulls.length === pullsBefore; waited++) await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect(docker.pulls.length).toBe(pullsBefore + 1);
    expect(docker.containers.has(container)).toBe(false);
    // The logout, as the door runs it: the key's next ending.
    let loggedOut: boolean | null = null;
    const out: Promise<void> = registry.ending_run(key, (): Promise<boolean> => host.evict(ANA, 'end')).then((ended: boolean): void => { loggedOut = ended; });
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(loggedOut).toBeNull();
    docker.pullGate = null;
    pulled();
    await restarting;
    await out;
    // The logout stopped the berth the restart made.
    expect(loggedOut).toBe(true);
    expect(docker.containers.has(container)).toBe(false);
    // And nothing is held to start another on.
    void host.restart_begin(ANA, 'ana', CUBE, { kind: 'saved-login' });
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    expect(host.boot_follow(ANA, { line: () => undefined, done: () => undefined })?.report).toMatchObject({ state: 'failed', reason: 'ana: no token to start a berth on; log in again' });
    expect(docker.containers.has(container)).toBe(false);
  });

  it('a stop that arrives while the launcher is still making the berth, for a caller that has gone away, comes after the start: no berth is left, and no login to restart on', async () => {
    const launcher: BerthLauncher = launcher_make(docker);
    const container: string = berthNames_derive('mbw', ANA, 'ana').container;
    // A start whose image step is held. Whoever asked for it gives up waiting; the launcher goes on.
    let pulled: () => void = (): void => undefined;
    docker.pullGate = new Promise<void>((resolve: () => void): void => { pulled = resolve; });
    const starting: Promise<unknown> = launcher.start({ user: 'ana', uid: 7, gid: 7, cubeUrl: CUBE, token: 'ana-token' });
    void starting.catch((): void => undefined);
    for (let waited: number = 0; waited < 100 && docker.pulls.length === 0; waited++) await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect(docker.containers.has(container)).toBe(false);
    // The final stop (a logout) arrives now, with no container yet to find.
    let stopped: boolean | null = null;
    const stopping: Promise<void> = launcher.stop('ana', CUBE).then((was: boolean): void => { stopped = was; });
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(stopped).toBeNull();
    docker.pullGate = null;
    pulled();
    await starting;
    await stopping;
    // The stop removed the berth the start made, and the login held for it.
    expect(stopped).toBe(true);
    expect(docker.containers.has(container)).toBe(false);
    await expect(launcher.start({ user: 'ana', uid: 0, gid: 0, cubeUrl: CUBE, token: null })).rejects.toThrow('no token to start a berth on');
  });

  it('a stop whose container went but whose wire the engine would not remove is said as that, and asking again finishes it', async () => {
    const reach = { listen: join(dir, 'launcher.sock'), secret: SECRET };
    const host: LauncherHost = new LauncherHost(reach, async (): Promise<number> => 7);
    await host.spawn(ANA, 'ana', CUBE, 'ana-token');
    const names = berthNames_derive('mbw', ANA, 'ana');
    docker.unwireStatus = 403;
    await expect(host.evict(ANA)).rejects.toThrow(`ana's berth is stopped, but its wire ${names.network} could not be removed (the engine answered 403)`);
    expect(docker.containers.has(names.container)).toBe(false);
    expect(docker.networks.has(names.network)).toBe(true);
    docker.unwireStatus = 204;
    // Asked again: there is no container now, and the wire goes.
    expect(await host.evict(ANA)).toBe(false);
    expect(docker.networks.has(names.network)).toBe(false);
  });

  it('a restart stops the berth and starts it again on the login the launcher holds; an end forgets that login', async () => {
    const reach = { listen: join(dir, 'launcher.sock'), secret: SECRET };
    const host: LauncherHost = new LauncherHost(reach, async (): Promise<number> => 7);
    await host.spawn(ANA, 'ana', CUBE, 'ana-token');
    const container: string = berthNames_derive('mbw', ANA, 'ana').container;
    const made: number = docker.made.filter((one) => one.name === container).length;
    host.restart_begin(ANA, 'ana', CUBE, { kind: 'asked' });
    await new Promise((resolve) => { setTimeout(resolve, 400); });
    expect(host.boot_follow(ANA, { line: () => undefined, done: () => undefined })?.report.state).toBe('ready');
    expect(docker.made.filter((one) => one.name === container).length).toBe(made + 1);
    expect(docker.containers.get(container)?.running).toBe(true);
    // An end is not a restart: the login held is forgotten, and a start with no token is refused.
    expect(await host.evict(ANA)).toBe(true);
    host.restart_begin(ANA, 'ana', CUBE, { kind: 'saved-login' });
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    expect(host.boot_follow(ANA, { line: () => undefined, done: () => undefined })?.report).toMatchObject({ state: 'failed', reason: 'ana: no token to start a berth on; log in again' });
  });

  it('a launcher answer that does not say whether a berth was stopped is not taken for "none was running"', async () => {
    const odd: Server = createServer((_req, res): void => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
    await new Promise<void>((resolve) => { odd.listen(join(dir, 'odd.sock'), resolve); });
    const host: LauncherHost = new LauncherHost({ listen: join(dir, 'odd.sock'), secret: SECRET }, async (): Promise<number> => 7);
    await expect(host.evict(ANA)).rejects.toThrow('the launcher did not say whether it stopped one');
    await new Promise<void>((resolve) => { odd.close(() => resolve()); });
  });

  it('answers the operator\'s read over the API, and porter\'s host asks for it', async () => {
    const reach = { listen: join(dir, 'launcher.sock'), secret: SECRET };
    const host: LauncherHost = new LauncherHost(reach, async (): Promise<number> => 7);
    await host.spawn(ANA, 'ana', CUBE, 'ana-token');
    expect(await host.access_read(CUBE)).toEqual([{ user: 'ana', state: 'running', cohort: 'none', cpuPercent: null, memoryBytes: null, memoryLimitBytes: null }]);
    expect((await launcher_call({ ...reach, secret: 'x'.repeat(40) }, 'GET', '/berths/access')).status).toBe(401);
  });

  it('asks the launcher for the access read with a CUBE, and gives up on a launcher that never answers', async () => {
    const reach = { listen: join(dir, 'launcher.sock'), secret: SECRET };
    const refused = await launcher_call(reach, 'GET', '/berths/access');
    expect(refused.status).toBe(400);
    const silent: Server = createServer((): void => undefined);
    const hung: string = join(dir, 'hung.sock');
    await new Promise<void>((resolve) => { silent.listen(hung, resolve); });
    try {
      await expect(launcher_call({ listen: hung, secret: SECRET }, 'GET', '/berths/access?cubeUrl=x', undefined, 100)).rejects.toThrow(/berth launcher did not answer/);
    } finally {
      silent.closeAllConnections();
      await new Promise<void>((resolve) => { silent.close(() => resolve()); });
    }
  });

  it('porter\'s host shows the berth\'s own boot rows as it boots, its token never on the page, an open row settled in place', async () => {
    const host: LauncherHost = new LauncherHost({ listen: join(dir, 'launcher.sock'), secret: SECRET }, async (): Promise<number> => 7);
    const names: BerthNames = berthNames_derive('mbw', ANA, 'ana');
    docker.logs.set(names.container, [
      '\x1b[36m[PENDING]\x1b[39m Public       Warming /PUBLIC behind the prompt',
      '    token:     0123456789abcdef0123456789abcdef',
      '[+] ARGUS web surface at http://127.0.0.1:41234/?token=0123456789abcdef0123456789abcdef',
    ]);
    docker.silent = true;
    setTimeout((): void => { docker.log_write(names.container, '[ OK ]    Public       Cached 9 items from /PUBLIC'); docker.silent = false; }, 40);
    const seen: Array<{ text: string; replaces?: number }> = [];
    const booting: Promise<unknown> = host.spawn(ANA, 'ana', CUBE, 'ana-token');
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    host.boot_follow(ANA, { line: (line) => { seen.push({ text: line.text, ...(line.replaces !== undefined ? { replaces: line.replaces } : {}) }); }, done: () => undefined });
    await booting;
    const report = host.boot_follow(ANA, { line: () => undefined, done: () => undefined })?.report;
    const texts: string[] = report?.lines.map((line) => line.text) ?? [];
    expect(texts).toEqual([
      '[ OK ]    Identity     ana is CUBE user 7',
      '[PENDING] Berth        starting ana\'s berth',
      '[ OK ]    Public       Cached 9 items from /PUBLIC',
      '    token:     (held by the porter)',
      '[+] ARGUS web surface at http://127.0.0.1:41234/?token=…',
      '[ OK ]    Berth        ana\'s berth answers',
    ]);
    expect(JSON.stringify(report)).not.toContain('0123456789abcdef');
    expect(JSON.stringify(seen)).not.toContain('0123456789abcdef');
    // The row printed open is settled where it stands, for a follower as for the kept lines.
    expect(seen).toContainEqual({ text: '[ OK ]    Public       Cached 9 items from /PUBLIC', replaces: 2 });
  });

  it('porter\'s host reads a launcher that answers a start plainly, as one from before the boot rows does', async () => {
    const plain: Server = createServer((req, res): void => {
      req.resume();
      req.on('end', (): void => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ identity: ANA, user: 'ana', state: 'running', url: 'ws://10.0.0.9:4000', token: 'attach' })); });
    });
    const at: string = join(dir, 'plain.sock');
    await new Promise<void>((resolve) => { plain.listen(at, resolve); });
    try {
      const host: LauncherHost = new LauncherHost({ listen: at, secret: SECRET }, async (): Promise<number> => 7);
      expect((await host.spawn(ANA, 'ana', CUBE, 'ana-token')).url).toBe('ws://10.0.0.9:4000');
    } finally {
      await new Promise<void>((resolve) => { plain.close(() => resolve()); });
    }
  });

  it('porter\'s host starts a berth at login with the user\'s CUBE id and no cohort, finds it, follows its boot, and stops it', async () => {
    const host: LauncherHost = new LauncherHost({ listen: join(dir, 'launcher.sock'), secret: SECRET }, async (cubeUrl: string, token: string): Promise<number> => (token === 'ana-token' && cubeUrl === CUBE ? 7 : 0));
    expect(identity_split(ANA)).toEqual({ user: 'ana', cubeUrl: CUBE });
    const berth = await host.spawn(ANA, 'ana', CUBE, 'ana-token');
    expect(berth.url).toBe('ws://10.213.77.3:41234');
    const names = berthNames_derive('mbw', ANA, 'ana');
    expect(docker.containers.get(names.container)?.spec['User']).toBe('7:7');
    expect(docker.volumes.has(names.work)).toBe(true);
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

describe('a door that starts berths and the cloud session', () => {
  it('says it cannot start one, so the switch refuses before the cookie moves', () => {
    const host: LauncherHost = new LauncherHost({ listen: '127.0.0.1:1', secret: 'unused' }, async (): Promise<number> => 7);
    expect(host.stratus_refusal()).toMatch(/a cloud session is not offered/);
  });
});
