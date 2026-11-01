/**
 * @file ChRIS on a VM (docs/stratus.adoc, D16): the profile's floor, the
 * compose file and its environment, the secrets kept, and `chris deploy`
 * end to end over the fake cloud and a fake VM that answers its lines:
 * the files written, the compute registered once, the admin API seen, the
 * password generated and shown once, and the DNS wait with a host.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { BufferSink, HeadlessSurface, JobRunner, runner_install, sink_set, surface_set, type PromptRequest } from '@fnndsc/brasa/core';
import type { CloudDriver, CloudPrice, ResourceCounts, ServicePrices } from '../src/cloud/driver.js';
import { FakeBuildWorld, FakeCloudBuilder } from '../src/cloud/fake/builder.js';
import { CHRIS_PROFILES, floor_short } from '../src/chris/profiles.js';
import { caddyfile_render, compose_render, cubeEnv_render, type ChrisSecrets } from '../src/chris/compose.js';
import { curlQuote } from '../src/chris/deploy.js';
import { secrets_read } from '../src/chris/secrets.js';
import { goDaddy_make, host_split, point_plan, type Registrar, type RegistrarRecord } from '../src/chris/registrar.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { sshArgs_build, type RemoteAnswer, type VmRemote } from '../src/vm/remote.js';
import { VmStore } from '../src/vm/state.js';
import { NetStore } from '../src/net/state.js';
import { STEPS_SOURCE } from '../src/cluster/steps.js';
import { net_run } from '../src/commands/net.js';
import { vm_run, type VmCommandContext } from '../src/commands/vm.js';
import { chris_run, type ChrisCommandContext } from '../src/commands/chris.js';

const plain = (text: string | undefined): string => (text ?? '').replace(/\x1b\[[0-9;]*m/g, '');
const SECRETS: ChrisSecrets = { djangoKey: 'dk', postgresPassword: 'pg', pfconSecretKey: 'ps', pfconPassword: 'pp', adminPassword: 'admin-pass' };
const VM_LINE: string[] = ['new', 'store', '--net', 'scratch', '--open', '80,443', '--vcpu', '2', '--memory', '8', '--disk', '50', '--data', '50', '--os', 'ubuntu-26.04'];

/** A VM that answers the deploy's lines, recording them and the files written. */
class FakeVm implements VmRemote {
  lines: string[] = [];
  files: Map<string, string> = new Map();
  computes: string[] = [];
  async run(line: string, input?: string): Promise<RemoteAnswer> {
    this.lines.push(line);
    const written: RegExpMatchArray | null = /cat > (\S+)\.new/.exec(line);
    if (written !== null) this.files.set(written[1] as string, input ?? '');
    if (line.includes('-o /dev/null')) return { code: 0, stdout: '200', stderr: '' };
    if (line.includes('computeresources/search/')) return { code: 0, stdout: `{"results":[${this.computes.map((name: string): string => `{"name":"${name}"}`).join(',')}]}\n200`, stderr: '' };
    if (line.includes('chris-admin/api/v1/computeresources/')) {
      const quoted: string = (/json = (".*")/.exec(input ?? '') as RegExpMatchArray)[1] as string;
      this.computes.push((JSON.parse(JSON.parse(quoted) as string) as { name: string }).name);
      return { code: 0, stdout: '{}\n201', stderr: '' };
    }
    if (line.endsWith('http://127.0.0.1:8000/api/v1/')) return { code: 0, stdout: '{"collection_links":{"admin":"http://127.0.0.1:8000/chris-admin/api/v1/"}}\n200', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  }
}

describe('a ChRIS profile and what it renders', () => {
  it('says by how much a target is below the floor', () => {
    const minimal = CHRIS_PROFILES['minimal'];
    if (minimal === undefined) throw new Error('no minimal profile');
    expect(floor_short(minimal, { vcpu: 2, memory: 8, data: 50 })).toEqual([]);
    expect(floor_short(minimal, { vcpu: 1, memory: 2, data: 50 })).toEqual(['1 vCPU, 1 short of 2', '2 GiB, 2 short of 4']);
  });

  it('runs CUBE in production beside pfcon in-network, the files on one volume pfcon finds by its label', () => {
    const minimal = CHRIS_PROFILES['minimal'];
    if (minimal === undefined) throw new Error('no minimal profile');
    const compose = yaml.load(compose_render(minimal)) as { name: string; services: Record<string, Record<string, unknown>> };
    expect(compose.name).toBe('chris');
    expect(Object.keys(compose.services)).toEqual(['db', 'dragonfly', 'nats', 'files-fix', 'migrate', 'chris', 'worker', 'worker-periodic', 'scheduler', 'pfcon', 'caddy']);
    expect(compose.services['chris']?.['ports']).toEqual(['127.0.0.1:8000:8000']);
    expect(compose.services['pfcon']?.['labels']).toEqual({ 'org.chrisproject.role': 'pfcon' });
    expect(compose.services['pfcon']?.['volumes']).toEqual(['files:/var/local/storeBase', '/var/run/docker.sock:/var/run/docker.sock']);
    expect(compose.services['pfcon']?.['networks']).toEqual({ default: { aliases: ['pfcon.local'] } });
    expect(compose.services['caddy']?.['ports']).toEqual(['80:80', '443:443']);
    expect(JSON.stringify(compose).includes('rabbitmq') || JSON.stringify(compose).includes('pman')).toBe(false);
  });

  it('allows any host and plain HTTP on the address, only the name and HTTPS behind the proxy with one', () => {
    expect(cubeEnv_render({ host: null, address: '1.2.3.4' }, SECRETS)).toContain('DJANGO_ALLOWED_HOSTS=*\n');
    expect(cubeEnv_render({ host: null, address: '1.2.3.4' }, SECRETS)).toContain('CHRIS_STORE_URL=http://1.2.3.4/api/v1/\n');
    const named: string = cubeEnv_render({ host: 'cube.example.org', address: '1.2.3.4' }, SECRETS);
    expect(named).toContain('DJANGO_ALLOWED_HOSTS=cube.example.org,localhost,127.0.0.1,chris\n');
    expect(named).toContain('DJANGO_SECURE_PROXY_SSL_HEADER=HTTP_X_FORWARDED_PROTO,https\n');
    expect(caddyfile_render({ host: 'cube.example.org', address: '1.2.3.4' })).toBe('cube.example.org {\n\treverse_proxy chris:8000\n}\n');
    expect(caddyfile_render({ host: null, address: '1.2.3.4' }).startsWith(':80 {')).toBe(true);
    expect(curlQuote('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it('reaches a VM through the bastion as its proxy, with the VM\'s own key', () => {
    expect(sshArgs_build({ sessionId: 's', host: 'h' }, '/k/ssh/id_ed25519', '10.0.0.5').slice(-2)).toEqual(['ProxyCommand=ssh -i /k/ssh/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/k/ssh/known_hosts -W %h:%p -p 22 s@h', 'ubuntu@10.0.0.5']);
  });
});

describe('chris deploy, over the fake cloud and a fake VM', () => {
  let root: string;
  let vms: VmStore;
  let vm: FakeVm;
  let resolved: string[];
  let context: ChrisCommandContext;
  let vmContext: VmCommandContext;
  let surface: HeadlessSurface & { answers: string[]; asked: string[] };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'stratus-chris-'));
    vms = new VmStore(join(root, 'vms'));
    const nets: NetStore = new NetStore(join(root, 'nets'));
    const builder: FakeCloudBuilder = new FakeCloudBuilder(new FakeBuildWorld(0));
    const driver = { resources_search: async (): Promise<ResourceCounts> => ({}), prices_list: async (): Promise<CloudPrice[]> => [], servicePrices_get: async (): Promise<ServicePrices | null> => null } as unknown as CloudDriver;
    vm = new FakeVm();
    resolved = [];
    context = { vms, nets, builder, resolve: async (): Promise<string[]> => resolved, nameservers_get: async (): Promise<string[]> => ['ns37.domaincontrol.com', 'ns38.domaincontrol.com'], registrar: null, status_get: async (): Promise<number | null> => 200, remote_open: async (): Promise<VmRemote> => vm, tickMs: 0 };
    vmContext = { store: vms, nets, driver, builder, region: (): string => 'us-ashburn-1' };
    surface = Object.assign(new HeadlessSurface(), { answers: [] as string[], asked: [] as string[] });
    (surface.capabilities as { tasks?: boolean }).tasks = true;
    surface.prompt = async (request: PromptRequest): Promise<string> => { surface.asked.push(request.message); return surface.answers.shift() ?? ''; };
    surface_set(surface);
    runner_install(new JobRunner(join(root, 'jobs'), [{ id: STEPS_SOURCE, label: 'steps' }]));
    sink_set(new BufferSink());
    const netContext = { store: nets, driver, builder, region: (): string => 'us-ashburn-1', clientCidr_read: async (): Promise<string> => '134.174.21.21/32' };
    await net_run(netContext, ['new', 'scratch', '--cidr', '10.40.0.0/16']);
    surface.answers = ['y'];
    await net_run(netContext, ['build', 'scratch']);
    await vm_run(vmContext, VM_LINE);
    surface.answers = ['y'];
    await vm_run(vmContext, ['build', 'store']);
    surface.asked = [];
  });
  afterEach(() => { runner_install(null); surface_set(new HeadlessSurface()); rmSync(root, { recursive: true, force: true }); });

  it('refuses an unknown profile, a VM not declared, and a VM below the floor', async () => {
    expect((await chris_run(context, ['deploy', 'store', '--profile', 'huge'])).renderedErr).toContain('--profile huge: one of minimal');
    expect((await chris_run(context, ['deploy', 'nowhere', '--profile', 'minimal'])).renderedErr).toContain('nowhere: no such VM');
    await vm_run(vmContext, ['new', 'store', '--memory', '2']);
    expect((await chris_run(context, ['deploy', 'store', '--profile', 'minimal'])).renderedErr).toContain('below the minimal profile\'s floor: 2 GiB, 2 short of 4');
  });

  it('deploys: the password generated and shown once, the files written, CUBE waited for, the compute registered once, the admin API seen', async () => {
    surface.answers = [''];
    const deployed = await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--compute', 'NERC']);
    expect(deployed.renderedErr ?? '').toBe('');
    const secrets: ChrisSecrets | null = secrets_read(vms, 'store');
    expect(plain(deployed.rendered)).toContain(`the admin password for chris, generated, shown this once: ${secrets?.adminPassword}`);
    expect(plain(deployed.rendered)).toContain('store: ChRIS minimal at http://203.0.113.10/api/v1/, compute NERC');
    expect(statSync(join(vms.folder_derive('store'), 'auth', 'chris.json')).mode & 0o777).toBe(0o600);
    expect([...vm.files.keys()]).toEqual(['/srv/data/chris/compose.yml', '/srv/data/chris/cube.env', '/srv/data/chris/pfcon.env', '/srv/data/chris/Caddyfile']);
    expect(vm.files.get('/srv/data/chris/cube.env')).toContain(`CHRIS_SUPERUSER_PASSWORD=${secrets?.adminPassword}\n`);
    expect(vm.lines).toContain('cd /srv/data/chris && docker compose pull -q && docker compose up -d --remove-orphans');
    expect(vm.computes).toEqual(['NERC']);
    expect(vm.lines.some((line: string): boolean => line.includes(secrets?.adminPassword ?? '?'))).toBe(false);
    expect(vms.record_read('store')?.chris).toMatchObject({ profile: 'minimal', compute: 'NERC', host: null, url: 'http://203.0.113.10/api/v1/' });
    surface.asked = [];
    const again = await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--compute', 'NERC']);
    expect(plain(again.rendered)).not.toContain('generated');
    expect(surface.asked).toEqual([]);
    expect(vm.computes).toEqual(['NERC']);
    expect(secrets_read(vms, 'store')).toEqual(secrets);
    expect(plain((await chris_run(context, [])).rendered)).toContain('store  minimal  http://203.0.113.10/api/v1/  compute NERC');
  });

  it('with a host, waits on DNS and says so; once the name gives the address, it is done', async () => {
    surface.answers = ['a-typed-password'];
    const waiting = await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--host', 'cube.example.org']);
    expect(waiting.renderedErr).toContain('waiting on DNS: cube.example.org does not resolve to 203.0.113.10 yet (chris deploy again resumes here)');
    expect(secrets_read(vms, 'store')?.adminPassword).toBe('a-typed-password');
    expect(vms.record_read('store')?.chris?.dns).toBe('waiting');
    resolved = ['203.0.113.10'];
    const done = await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--host', 'cube.example.org']);
    expect(done.renderedErr ?? '').toBe('');
    expect(plain(done.rendered)).toContain('at https://cube.example.org/api/v1/');
    expect(vms.record_read('store')?.chris?.dns).toBe('seen');
  });

  it('with a host and a registrar it holds a token for, shows the change, asks, and points the name', async () => {
    const records: RegistrarRecord[] = [{ id: 'r-1', type: 'CNAME', name: 'cube', data: 'router-default.apps.example.org.', ttl: 3600 }];
    const calls: string[] = [];
    const registrar: Registrar = {
      id: 'GoDaddy',
      serves: (servers: ReadonlyArray<string>): boolean => servers.every((server: string): boolean => server.endsWith('.domaincontrol.com')),
      records_list: async (): Promise<RegistrarRecord[]> => records,
      record_delete: async (zone: string, id: string): Promise<void> => { calls.push(`delete ${zone} ${id}`); },
      record_create: async (zone: string, record: { name: string; type: string; data: string; ttl: number }): Promise<void> => { calls.push(`create ${zone} ${record.type} ${record.name} ${record.data} ${record.ttl}`); resolved = [record.data]; },
    };
    context = { ...context, registrar };
    surface.answers = ['a-typed-password', 'n'];
    const declined = await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--host', 'cube.example.org']);
    expect(surface.asked[1]).toBe('chris deploy: at GoDaddy, in example.org: remove CNAME cube → router-default.apps.example.org., add A cube → 203.0.113.10 (TTL 600)? [y/N]');
    expect(calls).toEqual([]);
    expect(declined.renderedErr).toContain('example.org at GoDaddy not changed');
    surface.answers = ['y'];
    const done = await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--host', 'cube.example.org']);
    expect(calls).toEqual(['delete example.org r-1', 'create example.org A cube 203.0.113.10 600']);
    expect(plain(done.rendered)).toContain('cube.example.org points at 203.0.113.10 at GoDaddy (resolvers may keep the old answer up to 3600 s)');
    expect(vms.record_read('store')?.chris?.dns).toBe('seen');
  });

  it('needs the tasks tier', async () => {
    surface_set(new HeadlessSurface());
    expect((await chris_run(context, ['deploy', 'store', '--profile', 'minimal'])).renderedErr).toContain('needs the tasks tier');
  });
});

describe('a registrar', () => {
  it('splits a host into its zone and name, and plans what pointing it takes', () => {
    expect(host_split('cube.chrisproject.org')).toEqual({ zone: 'chrisproject.org', name: 'cube' });
    expect(host_split('chrisproject.org')).toEqual({ zone: 'chrisproject.org', name: '@' });
    const cname: RegistrarRecord = { id: 'c', type: 'CNAME', name: 'cube', data: 'x.', ttl: 3600 };
    const right: RegistrarRecord = { id: 'a', type: 'A', name: 'cube', data: '1.2.3.4', ttl: 600 };
    expect(point_plan([cname], '1.2.3.4')).toEqual({ remove: [cname], create: true });
    expect(point_plan([right], '1.2.3.4')).toEqual({ remove: [], create: false });
    expect(point_plan([{ ...right, data: '9.9.9.9' }], '1.2.3.4').create).toBe(true);
  });

  it('speaks GoDaddy\'s v3 API with the token kept on the host, and is absent without one', async () => {
    const root: string = mkdtempSync(join(tmpdir(), 'stratus-godaddy-'));
    expect(goDaddy_make(join(root, 'none'))).toBeNull();
    mkdirSync(join(root, 'stratus'));
    writeFileSync(join(root, 'stratus', 'godaddy'), 'tok-123\n', { mode: 0o600 });
    const asked: string[] = [];
    const fetcher = (async (url: string, init: RequestInit): Promise<Response> => {
      asked.push(`${init.method} ${url} ${(init.headers as Record<string, string>)['Authorization']} ${init.body ?? ''}`);
      if (init.method === 'GET') return new Response(JSON.stringify({ items: [{ recordId: 'r-1', type: 'CNAME', name: 'cube', data: 'x.', ttl: 3600 }, { recordId: 'r-2', type: 'A', name: 'cube1', data: '5.5.5.5', ttl: 600 }] }), { status: 200 });
      return new Response(init.method === 'POST' ? '{}' : null, { status: init.method === 'POST' ? 201 : 204 });
    }) as unknown as typeof fetch;
    const registrar = goDaddy_make(join(root, 'stratus', 'godaddy'), fetcher);
    expect(registrar?.serves(['ns37.domaincontrol.com', 'ns38.domaincontrol.com.'])).toBe(true);
    expect(registrar?.serves(['ns1.p201.dns.oraclecloud.net'])).toBe(false);
    expect(await registrar?.records_list('chrisproject.org', 'cube')).toEqual([{ id: 'r-1', type: 'CNAME', name: 'cube', data: 'x.', ttl: 3600 }]);
    await registrar?.record_delete('chrisproject.org', 'r-1');
    await registrar?.record_create('chrisproject.org', { name: 'cube', type: 'A', data: '1.2.3.4', ttl: 600 });
    expect(asked).toEqual([
      'GET https://api.godaddy.com/v3/domains/zones/chrisproject.org/dns-records?name=cube&pageSize=100 Bearer tok-123 ',
      'DELETE https://api.godaddy.com/v3/domains/zones/chrisproject.org/dns-records/r-1 Bearer tok-123 ',
      'POST https://api.godaddy.com/v3/domains/zones/chrisproject.org/dns-records Bearer tok-123 {"name":"cube","type":"A","data":"1.2.3.4","ttl":600}',
    ]);
    rmSync(root, { recursive: true, force: true });
  });
});

