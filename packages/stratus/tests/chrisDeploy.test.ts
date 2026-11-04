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
import { BufferSink, HeadlessSurface, JobRunner, runner_get, runner_install, sink_set, surface_set, type JobContext, type PromptRequest } from '@fnndsc/brasa/core';
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
import { CUBE_PYTHON_LINE, userAnswer_parse } from '../src/chris/users.js';
import { lineStatusProviders_make } from '../src/commands/lineStatus.js';
import { VM_JOBS } from '../src/vm/build.js';
import { USER_JOBS } from '../src/chris/users.js';
import type { LineStatusProvider } from '@fnndsc/brasa/core';

const plain = (text: string | undefined): string => (text ?? '').replace(/\x1b\[[0-9;]*m/g, '');
const SECRETS: ChrisSecrets = { djangoKey: 'dk', postgresPassword: 'pg', pfconSecretKey: 'ps', pfconPassword: 'pp', adminPassword: 'admin-pass' };
const VM_LINE: string[] = ['new', 'store', '--net', 'scratch', '--open', '80,443', '--vcpu', '2', '--memory', '8', '--disk', '50', '--data', '50', '--os', 'ubuntu-26.04'];

/** A VM that answers the deploy's lines, recording them and the files written. */
class FakeVm implements VmRemote {
  lines: string[] = [];
  files: Map<string, string> = new Map();
  computes: string[] = [];
  /** CUBE's accounts, by name: their emails. */
  users: Map<string, string> = new Map([['chris', 'dev@babymri.org']]);
  /** Each account made, as CUBE was given it. */
  made: Array<{ username: string; email: string; password: string }> = [];
  async run(line: string, input?: string): Promise<RemoteAnswer> {
    this.lines.push(line);
    if (line === CUBE_PYTHON_LINE) {
      const ask = JSON.parse(Buffer.from((/b64decode\('([^']+)'\)/.exec(input ?? '') as RegExpMatchArray)[1] as string, 'base64').toString('utf-8')) as { username: string; email: string; password: string };
      const same: string | undefined = this.users.get(ask.username);
      const other: string | undefined = [...this.users.entries()].find(([name, email]): boolean => email === ask.email && name !== ask.username)?.[0];
      if (same !== undefined) return { code: 0, stdout: `stratus-user exists ${JSON.stringify(same)}\n`, stderr: '' };
      if (other !== undefined) return { code: 0, stdout: `stratus-user email-taken ${JSON.stringify(other)}\n`, stderr: '' };
      this.users.set(ask.username, ask.email);
      this.made.push(ask);
      return { code: 0, stdout: 'stratus-user added\n', stderr: '' };
    }
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

  let world: FakeBuildWorld;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'stratus-chris-'));
    vms = new VmStore(join(root, 'vms'));
    const nets: NetStore = new NetStore(join(root, 'nets'));
    world = new FakeBuildWorld(0);
    const builder: FakeCloudBuilder = new FakeCloudBuilder(world);
    const driver = { instances_find: async (): Promise<unknown[]> => [], clusters_find: async (): Promise<unknown[]> => [], resources_search: async (): Promise<ResourceCounts> => ({}), prices_list: async (): Promise<CloudPrice[]> => [], servicePrices_get: async (): Promise<ServicePrices | null> => null } as unknown as CloudDriver;
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
    expect(vm.lines).toContain('cd /srv/data/chris && docker compose pull -q --ignore-buildable && docker compose up -d --build --remove-orphans');
    expect(vm.files.get('/srv/data/chris/compose.yml')).not.toContain('porter');
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

  it('adds a user on the only ChRIS: the password asked, given on stdin, never kept; a replay leaves it as it is', async () => {
    expect((await chris_run(context, ['user', 'add', 'jorge', '--email', 'jorge@example.org'])).renderedErr).toContain('no ChRIS deployed');
    surface.answers = ['admin-password'];
    await chris_run(context, ['deploy', 'store', '--profile', 'minimal']);
    surface.asked = [];
    surface.answers = ['jorge-password'];
    const added = await chris_run(context, ['user', 'add', 'jorge', '--email', 'jorge@example.org']);
    expect(added.renderedErr ?? '').toBe('');
    expect(surface.asked).toEqual(['jorge\'s password (empty: generate one):']);
    expect(plain(added.rendered)).toBe('store: jorge added at http://203.0.113.10/api/v1/ (jorge@example.org)\n');
    expect(vm.made).toEqual([{ username: 'jorge', email: 'jorge@example.org', password: 'jorge-password' }]);
    expect(vm.lines.some((line: string): boolean => line.includes('jorge-password'))).toBe(false);
    expect(JSON.stringify(vms.record_read('store'))).not.toContain('jorge-password');
    surface.answers = ['jorge-password'];
    expect(plain((await chris_run(context, ['user', 'add', 'jorge', '--email', 'jorge@example.org'])).rendered)).toBe('store: jorge is there already (jorge@example.org); left as it is\n');
    surface.answers = ['jorge-password'];
    expect((await chris_run(context, ['user', 'add', 'jorge', '--email', 'other@example.org'])).renderedErr).toContain('store: jorge already exists, with jorge@example.org; left as it is');
    surface.answers = ['sandip-password'];
    expect((await chris_run(context, ['user', 'add', 'sandip', '--email', 'jorge@example.org'])).renderedErr).toContain('jorge@example.org is jorge\'s already');
    expect(vm.made).toHaveLength(1);
  });

  it('generates a password when none is typed, shows it once, and reads one from a file', async () => {
    surface.answers = ['admin-password'];
    await chris_run(context, ['deploy', 'store', '--profile', 'minimal']);
    surface.answers = [''];
    const generated = await chris_run(context, ['user', 'add', 'sandip', '--email', 'sandip@example.org']);
    expect(plain(generated.rendered)).toContain(`the password for sandip, generated, shown this once: ${vm.made[0]?.password}`);
    expect(vm.made[0]?.password.length).toBeGreaterThanOrEqual(32);
    const file: string = join(root, 'josh-password');
    writeFileSync(file, 'from-a-file-1\n', { mode: 0o600 });
    surface.asked = [];
    await chris_run(context, ['user', 'add', 'joshua', '--email', 'josh@example.org', '--password-file', file, '--on', 'store']);
    expect(surface.asked).toEqual([]);
    expect(vm.made[1]).toEqual({ username: 'joshua', email: 'josh@example.org', password: 'from-a-file-1' });
    writeFileSync(file, 'short\n');
    expect((await chris_run(context, ['user', 'add', 'joshua2', '--email', 'josh2@example.org', '--password-file', file])).renderedErr).toContain('shorter than eight characters');
  });

  it('refuses without an email, a bad name, a VM with no ChRIS, and more than one ChRIS without --on', async () => {
    surface.answers = ['admin-password'];
    await chris_run(context, ['deploy', 'store', '--profile', 'minimal']);
    expect((await chris_run(context, ['user', 'add', 'jorge'])).renderedErr).toContain('jorge: --email <address> is needed');
    expect((await chris_run(context, ['user', 'add', 'jo', '--email', 'jo@example.org'])).renderedErr).toContain('jo: a user name is 4 to 32');
    expect((await chris_run(context, ['user', 'add', 'jorge', '--email', 'not-an-address'])).renderedErr).toContain('not an email address');
    expect((await chris_run(context, ['user', 'add', 'jorge', '--email', 'jorge@example.org', '--on', 'nowhere'])).renderedErr).toContain('--on nowhere: no such VM');
    expect((await chris_run(context, ['user'])).renderedErr).toContain('chris user add <name> --email <address>');
    await vm_run(vmContext, ['new', 'blt', '--net', 'scratch', '--open', '80,443', '--vcpu', '2', '--memory', '8', '--disk', '50', '--data', '50', '--os', 'ubuntu-26.04']);
    expect((await chris_run(context, ['user', 'add', 'jorge', '--email', 'jorge@example.org', '--on', 'blt'])).renderedErr).toContain('--on blt: no ChRIS deployed there');
    vms.record_update('blt', (record): void => { record.chris = { profile: 'complete', compute: 'blt', host: null, url: 'http://203.0.113.11/api/v1/', deployed: 'now' }; });
    expect((await chris_run(context, ['user', 'add', 'jorge', '--email', 'jorge@example.org'])).renderedErr).toContain('stratus runs 2 ChRIS (blt, store); say which with --on');
    expect(vm.made).toEqual([]);
  });

  it('reads CUBE\'s answer line among whatever else the container prints', () => {
    expect(userAnswer_parse('warning: x\nstratus-user exists "a@b.org"\n')).toEqual({ kind: 'exists', email: 'a@b.org' });
    expect(userAnswer_parse('stratus-user email-taken "jorge"\n')).toEqual({ kind: 'emailTaken', username: 'jorge' });
    expect(userAnswer_parse('Traceback (most recent call last):\n')).toBeNull();
  });

  it('with --porter, runs porter beside CUBE under its own name, its secret kept, both names pointed and waited for', async () => {
    expect((await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--porter', 'porter.example.org'])).renderedErr).toContain('--porter porter.example.org needs --host');
    expect((await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--host', 'cube.example.org', '--porter', 'cube.example.org'])).renderedErr).toContain('porter needs a name of its own');
    surface.answers = ['admin-password'];
    resolved = ['203.0.113.10'];
    const asked: string[] = [];
    context = { ...context, status_get: async (url: string): Promise<number | null> => { asked.push(url); return 200; } };
    const deployed = await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--host', 'cube.example.org', '--porter', 'porter.example.org']);
    expect(deployed.renderedErr ?? '').toBe('');
    expect(plain(deployed.rendered)).toContain('porter.example.org already resolves to 203.0.113.10');
    expect(plain(deployed.rendered)).toContain('store: ChRIS minimal at https://cube.example.org/api/v1/, compute store; porter at https://porter.example.org/');
    expect(asked).toContain('https://porter.example.org/login');
    // What runs here is said on the machine itself, for a session that reads the tenancy and keeps no record of it.
    const instanceId: string = vms.record_read('store')?.machineOutputs?.['instance_id'] ?? '';
    expect(world.instanceTags.get(instanceId)).toEqual({ 'mise-chris': 'https://cube.example.org/api/v1/', 'mise-porter': 'porter.example.org' });
    const secrets: ChrisSecrets | null = secrets_read(vms, 'store');
    expect(secrets?.porterSecret?.length).toBeGreaterThanOrEqual(32);
    const compose = yaml.load(vm.files.get('/srv/data/chris/compose.yml') ?? '') as { services: Record<string, Record<string, unknown>>; volumes: Record<string, unknown> };
    expect(compose.services['porter']?.['image']).toBe('stratus/porter:0.9.2');
    expect(String((compose.services['porter']?.['build'] as { dockerfile_inline: string }).dockerfile_inline)).toContain('npm install -g @fnndsc/porter@0.9.2');
    expect(compose.services['porter']?.['volumes']).toEqual(['porter:/var/lib/porter']);
    expect(compose.services['caddy']?.['networks']).toEqual({ default: { aliases: ['cube.example.org'] } });
    expect(Object.keys(compose.volumes)).toContain('porter');
    expect(vm.files.get('/srv/data/chris/Caddyfile')).toBe('cube.example.org {\n\treverse_proxy chris:8000\n}\n\nporter.example.org {\n\treverse_proxy porter:4180\n}\n');
    expect(vm.files.get('/srv/data/chris/porter.env')).toBe(`PORTER_CUBE_URL=https://cube.example.org/api/v1/\nPORTER_STATE_DIR=/var/lib/porter/sessions\nPORTER_HOST=0.0.0.0\nPORTER_PORT=4180\nPORTER_SECRET=${secrets?.porterSecret}\n`);
    expect(vm.lines.some((line: string): boolean => line.includes(secrets?.porterSecret ?? '?'))).toBe(false);
    expect(vms.record_read('store')?.chris).toMatchObject({ porter: 'porter.example.org', dns: 'seen' });
    expect(plain((await chris_run(context, ['status'])).rendered)).toContain('porter https://porter.example.org/');
    await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--host', 'cube.example.org', '--porter', 'porter.example.org']);
    expect(secrets_read(vms, 'store')).toEqual(secrets);
  });

  it('with --porter and a name not yet seen, says it waits on porter\'s DNS', async () => {
    surface.answers = ['admin-password'];
    context = { ...context, resolve: async (host: string): Promise<string[]> => host === 'cube.example.org' ? ['203.0.113.10'] : [] };
    const waiting = await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--host', 'cube.example.org', '--porter', 'porter.example.org']);
    expect(waiting.renderedErr).toContain('waiting on DNS: porter.example.org does not resolve to 203.0.113.10 yet (chris deploy again resumes here)');
    expect(vms.record_read('store')?.chris?.dns).toBe('waiting');
  });

  it('reads where each line of a script stands, from the records alone: not yet, ready, done, changed', async () => {
    const providers: Map<string, LineStatusProvider> = new Map(lineStatusProviders_make({ nets: context.nets, vms }).map((provider: LineStatusProvider): [string, LineStatusProvider] => [provider.verb, provider]));
    const read = async (line: string): Promise<string> => { const answer = await (providers.get(line.split(' ')[0] as string) as LineStatusProvider).read(line.split(' ')); return answer === null ? '—' : `${answer.state}${answer.detail === '' ? '' : ` (${answer.detail})`}`; };
    // The fixture built the network scratch and the VM store already.
    expect(await read('net new scratch --cidr 10.40.0.0/16')).toBe('done (unchanged)');
    expect(await read('net new scratch --cidr 10.50.0.0/16')).toBe('changed (cidr 10.40.0.0/16 → 10.50.0.0/16)');
    expect(await read('net new other --cidr 10.60.0.0/16')).toBe('ready');
    expect(await read('net build other')).toBe('not yet (other: not declared (net new other))');
    expect(await read('net build scratch')).toMatch(/^done \(built \d{4}-\d\d-\d\d\)$/);
    expect(await read('vm new store --net scratch --open 80,443 --vcpu 2 --memory 8 --disk 50 --data 50 --os ubuntu-26.04')).toBe('done (unchanged)');
    expect(await read('vm new blt --net nowhere --vcpu 2 --memory 8 --disk 50 --data 50 --os ubuntu-26.04')).toBe('not yet (the network nowhere is not declared (net new nowhere))');
    expect(await read('vm build blt')).toBe('not yet (blt: not declared (vm new blt))');
    expect(await read('vm build store')).toMatch(/^done \(built /);
    expect(await read('vm cost store --memory 16')).toBe('—');
    expect(await read('chris deploy store --profile minimal --compute NERC')).toBe('ready');
    expect(await read('chris deploy store --profile huge')).toBe('ready (--profile huge: one of minimal)');
    expect(await read('chris user add jorge --email j@example.org')).toBe('not yet (no ChRIS deployed (chris deploy))');
    surface.answers = ['admin-password'];
    await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--compute', 'NERC']);
    expect(await read('chris deploy store --profile minimal --compute NERC')).toMatch(/^done \(deployed /);
    expect(await read('chris deploy store --profile minimal --compute NERC --host cube.example.org')).toBe('changed (host none → cube.example.org)');
    expect(await read('chris deploy store --profile minimal')).toBe('changed (compute NERC → store)');
    expect(await read('chris user add jorge --email j@example.org')).toBe('ready (asks CUBE when it runs; a name already there is left as it is)');
    expect(await read('chris user add jorge --email j@example.org --on blt')).toBe('not yet (no ChRIS on blt (chris deploy blt))');
    // The spec moves under what was built: the build and the deploy have a change to plan.
    await vm_run(vmContext, ['new', 'store', '--memory', '16']);
    expect(await read('vm new store --net scratch --open 80,443 --vcpu 2 --memory 16 --disk 50 --data 50 --os ubuntu-26.04')).toBe('done (unchanged)');
    expect(await read('vm build store')).toBe('changed (declared again since it was built; the build plans and asks)');
    expect(await read('chris deploy store --profile minimal --compute NERC')).toBe('changed (the VM was declared again since the deploy)');
    // With a host whose DNS has not caught up, the deploy is ready to resume.
    vms.record_update('store', (record): void => { if (record.chris !== undefined) { record.chris.host = 'cube.example.org'; record.chris.dns = 'waiting'; } delete record.declared; });
    expect(await read('chris deploy store --profile minimal --compute NERC --host cube.example.org')).toBe('ready (waiting on DNS for cube.example.org; a replay resumes there)');
  });

  it('names the task running a line now beside its state, and only that line\'s', async () => {
    const providers: Map<string, LineStatusProvider> = new Map(lineStatusProviders_make({ nets: context.nets, vms }).map((provider: LineStatusProvider): [string, LineStatusProvider] => [provider.verb, provider]));
    const running = async (line: string): Promise<string | undefined> => (await (providers.get(line.split(' ')[0] as string) as LineStatusProvider).read(line.split(' ')))?.running;
    const runner: JobRunner = runner_get() as JobRunner;
    // A job that goes on until it is told to stop, as a cloud apply does.
    const held = (ctx: JobContext): Promise<void> => new Promise((resolve: () => void): void => { if (ctx.signal.aborted) resolve(); ctx.signal.addEventListener('abort', (): void => resolve()); });
    expect(await running('vm build store')).toBeUndefined();
    runner.job_start(STEPS_SOURCE, VM_JOBS.apply('store', 'machine'), 'apply store machine', held);
    expect(await running('vm build store')).toBe('/proc/steps/vm-store-apply-machine');
    expect(await running('vm build blt')).toBeUndefined();
    expect(await running('net build scratch')).toBeUndefined();
    expect(await running('chris deploy store --profile minimal')).toBeUndefined();
    runner.job_stop(STEPS_SOURCE, VM_JOBS.apply('store', 'machine'));
    await new Promise((resolve: (value: unknown) => void): void => { setTimeout(resolve, 20); });
    expect(await running('vm build store')).toBeUndefined();
    // One add job serves a VM's user lines; the job's label says whose, so only that user's line runs.
    surface.answers = ['admin-password'];
    await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--compute', 'NERC']);
    runner.job_start(STEPS_SOURCE, USER_JOBS.add('store'), 'add jorge to the ChRIS on store', held);
    expect(await running('chris user add jorge --email j@example.org')).toBe('/proc/steps/chris-store-user-add');
    expect(await running('chris user add maria --email m@example.org')).toBeUndefined();
    runner.job_stop(STEPS_SOURCE, USER_JOBS.add('store'));
    await new Promise((resolve: (value: unknown) => void): void => { setTimeout(resolve, 20); });
  });

  it('needs the tasks tier', async () => {
    surface_set(new HeadlessSurface());
    expect((await chris_run(context, ['deploy', 'store', '--profile', 'minimal'])).renderedErr).toContain('entered as READ, so nothing outside this host changes');
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

