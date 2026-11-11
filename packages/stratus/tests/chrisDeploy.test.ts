/**
 * @file ChRIS on a VM (docs/stratus.adoc, D16): the profile's floor, the
 * compose file and its environment, the secrets kept, and `chris deploy`
 * end to end over the fake cloud and a fake VM that answers its lines:
 * the files written, the compute registered once, the admin API seen, the
 * password generated and shown once, and the DNS wait with a host; and
 * `chris passwd`, the admin's kept on the host, in cube.env and in CUBE together.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { BufferSink, HeadlessSurface, JobRunner, runner_get, runner_install, sink_set, surface_set, type JobContext, type PromptRequest } from '@fnndsc/brasa/core';
import type { CloudDriver, CloudPrice, ResourceCounts, ServicePrices } from '../src/cloud/driver.js';
import { FakeDriver, fakeCloud_sample } from '../src/cloud/fake/driver.js';
import { FakeBuildWorld, FakeCloudBuilder } from '../src/cloud/fake/builder.js';
import { CHRIS_IMAGES, CHRIS_PROFILES, floor_short, PORTER_VERSION, type ChrisProfile } from '../src/chris/profiles.js';
import { BERTH_SOCKET, berths_has, caddyfile_render, compose_render, cubeEnv_render, launcherEnv_render, PORTER_CONTAINER, porterEnv_render, type ChrisSecrets, type ChrisTarget } from '../src/chris/compose.js';
import { chrisDeployRun_make, curlQuote, type DeployDeps, type DeployRequest } from '../src/chris/deploy.js';
import { launcherSecret_ensure, secrets_read } from '../src/chris/secrets.js';
import { goDaddy_make, host_split, point_plan, type Registrar, type RegistrarRecord } from '../src/chris/registrar.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { remoteRetried_make, sshArgs_build, type RemoteAnswer, type VmRemote } from '../src/vm/remote.js';
import { VmStore } from '../src/vm/state.js';
import { NetStore } from '../src/net/state.js';
import { STEPS_SOURCE } from '../src/cluster/steps.js';
import { net_run } from '../src/commands/net.js';
import { vm_run, type VmCommandContext } from '../src/commands/vm.js';
import { chris_run, type ChrisCommandContext } from '../src/commands/chris.js';
import { CUBE_PYTHON_LINE, userAnswer_parse } from '../src/chris/users.js';
import { PASSWD_JOBS } from '../src/chris/passwd.js';
import { lineStatusProviders_make } from '../src/commands/lineStatus.js';
import { VM_JOBS } from '../src/vm/build.js';
import { USER_JOBS } from '../src/chris/users.js';
import type { LineStatusProvider } from '@fnndsc/brasa/core';
import { chrisReach_fake, FakeChrisFleet, FakeChrisVm as FakeVm } from '../src/cloud/fake/chris.js';
import { LINE_DECLINED_MODEL_KIND } from '@fnndsc/menu';

const plain = (text: string | undefined): string => (text ?? '').replace(/\x1b\[[0-9;]*m/g, '');
const SECRETS: ChrisSecrets = { djangoKey: 'dk', postgresPassword: 'pg', pfconSecretKey: 'ps', pfconPassword: 'pp', adminPassword: 'admin-pass' };
const VM_LINE: string[] = ['new', 'store', '--net', 'scratch', '--open', '80,443', '--vcpu', '2', '--memory', '8', '--disk', '50', '--data', '50', '--os', 'ubuntu-26.04'];

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

  it('with berths, renders the launcher beside porter: the socket, the docker group, no network, a healthcheck; porter waits on it and finds it by its socket and secret', () => {
    const minimal = CHRIS_PROFILES['minimal'] as ChrisProfile;
    const keyed: ChrisSecrets = { ...SECRETS, porterSecret: 'porter-s', launcherSecret: 'launcher-s' };
    const berthed: ChrisTarget = { host: 'cube.example.org', address: '1.2.3.4', porter: 'porter.example.org', berths: { dockerGid: 998 } };
    const plain_: ChrisTarget = { host: 'cube.example.org', address: '1.2.3.4', porter: 'porter.example.org' };
    type Service = Record<string, unknown>;
    const compose = yaml.load(compose_render(minimal, berthed)) as { services: Record<string, Service> };
    expect(Object.keys(compose.services).slice(-3)).toEqual(['caddy', 'porter', 'berth-launcher']);
    const launcher: Service = compose.services['berth-launcher'] as Service;
    expect(launcher['command']).toEqual(['berth-launcher']);
    expect(launcher['image']).toBe(`stratus/porter:${PORTER_VERSION}`);
    expect(launcher['env_file']).toEqual(['launcher.env']);
    expect(launcher['group_add']).toEqual(['998']);
    expect(launcher['network_mode']).toBe('none');
    expect(launcher['volumes']).toEqual(['/var/run/docker.sock:/var/run/docker.sock', './berth/launcher.secret:/srv/berth/launcher.secret:ro', './berth/policy.json:/srv/berth/policy.json:ro', './berth/run:/srv/berth/run']);
    expect(launcher['healthcheck']).toEqual({ test: ['CMD', 'test', '-S', '/srv/berth/run/launcher.sock'], interval: '5s', timeout: '3s', retries: 12, start_period: '10s' });
    expect(BERTH_SOCKET).toBe('/srv/berth/run/launcher.sock');
    const porter: Service = compose.services['porter'] as Service;
    expect(porter['volumes']).toEqual(['porter:/var/lib/porter', './berth/launcher.secret:/srv/berth/launcher.secret:ro', './berth/run:/srv/berth/run']);
    expect(porter['depends_on']).toEqual({ caddy: { condition: 'service_started' }, 'berth-launcher': { condition: 'service_started' } });
    // Only the launcher is given Docker's socket among the porter pair.
    expect(JSON.stringify(porter)).not.toContain('docker.sock');
    expect(compose_render(minimal, berthed).startsWith('# ChRIS, profile minimal, with porter and berths:')).toBe(true);
    expect(porterEnv_render(berthed, keyed)).toBe('PORTER_CUBE_URL=https://cube.example.org/api/v1/\nPORTER_STATE_DIR=/var/lib/porter/sessions\nPORTER_HOST=0.0.0.0\nPORTER_PORT=4180\nPORTER_SECRET=porter-s\nPORTER_BERTHS=launcher\nPORTER_LAUNCHER=/srv/berth/run/launcher.sock\nPORTER_LAUNCHER_SECRET_FILE=/srv/berth/launcher.secret\n');
    expect(() => porterEnv_render(berthed, { ...SECRETS, porterSecret: 'porter-s' })).toThrow('berths need the launcher\'s secret');
    expect(launcherEnv_render(minimal, berthed)).toBe(`BERTH_LAUNCHER_LISTEN=/srv/berth/run/launcher.sock\nBERTH_LAUNCHER_SECRET_FILE=/srv/berth/launcher.secret\nBERTH_POLICY_FILE=/srv/berth/policy.json\nBERTH_PROFILE=minimal\nBERTH_PORTER_CONTAINER=${PORTER_CONTAINER}\nBERTH_CUBE_HOST=cube.example.org\n`);
    expect(PORTER_CONTAINER).toBe('chris-porter-1');
    expect(launcherEnv_render(minimal, { host: null, address: '1.2.3.4' })).not.toContain('BERTH_CUBE_HOST');
    // No berths: no launcher, nothing of it in porter or its environment.
    for (const target of [plain_, { ...plain_, berths: null }, { host: 'cube.example.org', address: '1.2.3.4', berths: { dockerGid: 998 } }, null]) {
      const without = yaml.load(compose_render(minimal, target)) as { services: Record<string, Service> };
      expect(Object.keys(without.services)).not.toContain('berth-launcher');
      expect((without.services['porter'] as Service | undefined)?.['depends_on']).toEqual(target?.porter !== undefined && target.porter !== null ? { caddy: { condition: 'service_started' } } : undefined);
      expect(berths_has(target)).toBe(false);
    }
    expect(compose_render(minimal, plain_)).not.toContain('berth');
    expect(porterEnv_render(plain_, keyed)).not.toContain('BERTH');
    expect(berths_has(berthed)).toBe(true);
  });

  it('tries a line again when ssh itself failed to carry it, never one the VM ran', async () => {
    const answers: RemoteAnswer[] = [{ code: 255, stdout: '', stderr: 'Connection closed by UNKNOWN port 65535' }, { code: 0, stdout: 'ok', stderr: '' }, { code: 255, stdout: 'partial', stderr: '' }];
    const ran: string[] = [];
    const logged: string[] = [];
    const remote: VmRemote = remoteRetried_make({ run: async (line: string): Promise<RemoteAnswer> => { ran.push(line); return answers.shift() ?? { code: 255, stdout: '', stderr: 'gone' }; } }, { log: (line: string): void => { logged.push(line); }, signal: new AbortController().signal }, 0);
    expect(await remote.run('mkdir x')).toEqual({ code: 0, stdout: 'ok', stderr: '' });
    expect(logged).toEqual(['ssh through the bastion did not carry a line (Connection closed by UNKNOWN port 65535); trying again']);
    expect((await remote.run('make y')).stdout).toBe('partial');
    expect((await remote.run('never')).stderr).toBe('gone');
    expect(ran.filter((line: string): boolean => line === 'never')).toHaveLength(6);
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
    // The tenancy answers what the fake builder applied: a VM's machine an instance, read again after each act.
    const built = (): FakeDriver => new FakeDriver({ ...fakeCloud_sample(), resources: [] }).built_see(world);
    const driver = { instances_find: async (region: string): Promise<unknown[]> => built().instances_find(region), clusters_find: async (): Promise<unknown[]> => [], resources_search: async (): Promise<ResourceCounts> => ({}), prices_list: async (): Promise<CloudPrice[]> => [], servicePrices_get: async (): Promise<ServicePrices | null> => null } as unknown as CloudDriver;
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
    surface.answers = ['y', 'y'];
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
    surface.answers = ['n'];
    const declined = await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--compute', 'NERC']);
    expect(surface.asked).toEqual(['chris deploy store: a first deploy: CUBE (minimal) with its workers, Postgres, dragonfly, nats and pfcon are put up, compute NERC; the admin password for chris is asked next, hidden (empty: one is generated). A NO changes nothing. Continue? [y/N]']);
    expect(declined.model?.kind).toBe(LINE_DECLINED_MODEL_KIND);
    expect(vms.record_read('store')?.chris).toBeUndefined();
    expect(secrets_read(vms, 'store')).toBeNull();
    surface.answers = ['y', ''];
    const deployed = await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--compute', 'NERC']);
    expect(deployed.renderedErr ?? '').toBe('');
    const secrets: ChrisSecrets | null = secrets_read(vms, 'store');
    expect(plain(deployed.rendered)).toContain(`the admin password for chris, generated, shown this once: ${secrets?.adminPassword}`);
    expect(plain(deployed.rendered)).toContain('store: ChRIS minimal at http://203.0.113.10/api/v1/, compute NERC');
    expect(statSync(join(vms.folder_derive('store'), 'auth', 'chris.json')).mode & 0o777).toBe(0o600);
    expect([...vm.files.keys()]).toEqual(['/srv/data/chris/compose.yml', '/srv/data/chris/cube.env', '/srv/data/chris/pfcon.env', '/srv/data/chris/Caddyfile']);
    expect(vm.files.get('/srv/data/chris/cube.env')).toContain(`CHRIS_SUPERUSER_PASSWORD=${secrets?.adminPassword}\n`);
    expect(vm.lines).toContain('cd /srv/data/chris && docker compose pull -q --ignore-buildable');
    expect(vm.lines).toContain('cd /srv/data/chris && docker compose up -d --build --remove-orphans');
    expect(vm.lines.some((line: string): boolean => line.includes('docker compose build'))).toBe(false);
    expect(vm.files.get('/srv/data/chris/compose.yml')).not.toContain('porter');
    expect(vm.computes).toEqual(['NERC']);
    expect(vm.adminHome).toBe(true);
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
    surface.answers = ['y', 'a-typed-password'];
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
    surface.answers = ['y', 'a-typed-password', 'n'];
    const declined = await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--host', 'cube.example.org']);
    expect(surface.asked[2]).toBe('chris deploy: at GoDaddy, in example.org: remove CNAME cube → router-default.apps.example.org., add A cube → 203.0.113.10 (TTL 600)? [y/N]');
    expect(calls).toEqual([]);
    expect(declined.renderedErr).toContain('example.org at GoDaddy not changed');
    surface.answers = ['y'];
    const done = await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--host', 'cube.example.org']);
    expect(calls).toEqual(['delete example.org r-1', 'create example.org A cube 203.0.113.10 600']);
    expect(plain(done.rendered)).toContain('cube.example.org points at 203.0.113.10 at GoDaddy (resolvers may keep the old answer up to 3600 s)');
    expect(vms.record_read('store')?.chris?.dns).toBe('seen');
  });

  it('adds a user on the only ChRIS: asked first with the account and where, the password asked after, given on stdin, never kept', async () => {
    expect((await chris_run(context, ['user', 'add', 'jorge', '--email', 'jorge@example.org'])).renderedErr).toContain('no ChRIS deployed');
    surface.answers = ['y', 'admin-password'];
    await chris_run(context, ['deploy', 'store', '--profile', 'minimal']);
    surface.asked = [];
    surface.answers = ['n'];
    const declined = await chris_run(context, ['user', 'add', 'jorge', '--email', 'jorge@example.org']);
    expect(declined.model?.kind).toBe(LINE_DECLINED_MODEL_KIND);
    expect(plain(declined.rendered)).toContain('stopped before jorge was made; nothing changed on store');
    expect(surface.asked).toEqual(['chris user add jorge: makes the account jorge (jorge@example.org) on the ChRIS at http://203.0.113.10/api/v1/, on store (its accounts not read); its password asked next, hidden. A NO makes nothing. Continue? [y/N]']);
    expect(vm.made).toEqual([]);
    surface.asked = [];
    surface.answers = ['y', 'jorge-password'];
    const added = await chris_run(context, ['user', 'add', 'jorge', '--email', 'jorge@example.org']);
    expect(added.renderedErr ?? '').toBe('');
    expect(surface.asked[1]).toBe('jorge\'s password (empty: generate one):');
    expect(plain(added.rendered)).toBe('store: jorge added at http://203.0.113.10/api/v1/ (jorge@example.org)\n');
    expect(vm.made).toEqual([{ username: 'jorge', email: 'jorge@example.org', password: 'jorge-password' }]);
    expect(vm.lines.some((line: string): boolean => line.includes('jorge-password'))).toBe(false);
    expect(JSON.stringify(vms.record_read('store'))).not.toContain('jorge-password');
    surface.answers = ['y', 'jorge-password'];
    expect(plain((await chris_run(context, ['user', 'add', 'jorge', '--email', 'jorge@example.org'])).rendered)).toBe('store: jorge is there already (jorge@example.org); left as it is\n');
    surface.answers = ['y', 'jorge-password'];
    expect((await chris_run(context, ['user', 'add', 'jorge', '--email', 'other@example.org'])).renderedErr).toContain('store: jorge already exists, with jorge@example.org; left as it is');
    surface.answers = ['y', 'sandip-password'];
    expect((await chris_run(context, ['user', 'add', 'sandip', '--email', 'jorge@example.org'])).renderedErr).toContain('jorge@example.org is jorge\'s already');
    expect(vm.made).toHaveLength(1);
  });

  it('reads CUBE\'s accounts before it asks: one already there is left as it is, unasked; the question counts what stands', async () => {
    const fleet: FakeChrisFleet = new FakeChrisFleet();
    const reach: ChrisCommandContext = { ...context, ...chrisReach_fake(fleet, 0), registrar: null };
    surface.answers = ['y', 'admin-password'];
    await chris_run(reach, ['deploy', 'store', '--profile', 'minimal']);
    surface.asked = [];
    surface.answers = ['y', 'jorge-password'];
    await chris_run(reach, ['user', 'add', 'jorge', '--email', 'jorge@example.org']);
    expect(surface.asked[0]).toMatch(/^chris user add jorge: makes the account jorge \(jorge@example\.org\) on the ChRIS at http:\/\/203\.0\.113\.10\/api\/v1\/, on store \(1 account there now, read \d\d:\d\d UTC\); its password asked next, hidden\. A NO makes nothing\. Continue\? \[y\/N\]$/);
    surface.asked = [];
    const again = await chris_run(reach, ['user', 'add', 'jorge', '--email', 'jorge@example.org']);
    expect(surface.asked).toEqual([]);
    expect(plain(again.rendered)).toMatch(/^store: jorge is there already \(jorge@example\.org, read \d\d:\d\d UTC\); left as it is\n$/);
  });

  it('adds a user into the groups CUBE holds, and changes an account\'s groups and email: read first, a group CUBE lacks refused unasked, asked with the change', async () => {
    const fleet: FakeChrisFleet = new FakeChrisFleet();
    const reach: ChrisCommandContext = { ...context, ...chrisReach_fake(fleet, 0), registrar: null };
    surface.answers = ['y', 'admin-password'];
    await chris_run(reach, ['deploy', 'store', '--profile', 'minimal']);
    const cube = fleet.vm_get('store');
    surface.asked = [];
    expect((await chris_run(reach, ['user', 'add', 'anabela', '--email', 'ana@example.org', '--groups', 'pacs_users,radiology'])).renderedErr).toContain('store: CUBE has no group radiology (it holds all_users, pacs_users)');
    expect(surface.asked).toEqual([]);
    surface.answers = ['y', 'ana-password-1'];
    const added = await chris_run(reach, ['user', 'add', 'anabela', '--email', 'ana@example.org', '--groups', 'all_users,pacs_users']);
    expect(surface.asked[0]).toMatch(/^chris user add anabela: makes the account anabela \(ana@example\.org, in all_users, pacs_users\) on the ChRIS/);
    expect(plain(added.rendered)).toBe('store: anabela added at http://203.0.113.10/api/v1/ (ana@example.org, in all_users, pacs_users)\n');
    expect([...cube.groups.get('pacs_users') ?? []]).toContain('anabela');
    // The status reads each account's id and groups, and the groups CUBE holds.
    const status = await chris_run(reach, ['status']);
    expect(status.model).toMatchObject({ data: { chris: [{ live: { groups: ['all_users', 'pacs_users'], accounts: [{ username: 'anabela', id: 2, groups: ['all_users', 'pacs_users'] }, { username: 'chris', id: 1 }] } }] } });
    surface.asked = [];
    surface.answers = ['n'];
    const declined = await chris_run(reach, ['user', 'mod', 'anabela', '--groups', 'all_users', '--email', 'anabela@example.org']);
    expect(surface.asked).toEqual(['chris user mod anabela: on the ChRIS at http://203.0.113.10/api/v1/, on store: email ana@example.org → anabela@example.org; groups − pacs_users. A NO changes nothing. Continue? [y/N]']);
    expect(declined.model?.kind).toBe(LINE_DECLINED_MODEL_KIND);
    expect([...cube.groups.get('pacs_users') ?? []]).toContain('anabela');
    surface.answers = ['y'];
    const changed = await chris_run(reach, ['user', 'mod', 'anabela', '--groups', 'all_users', '--email', 'anabela@example.org']);
    expect(plain(changed.rendered)).toBe('store: anabela changed at http://203.0.113.10/api/v1/: email ana@example.org → anabela@example.org; groups − pacs_users\n');
    expect([...cube.groups.get('pacs_users') ?? []]).not.toContain('anabela');
    expect([...cube.groups.get('all_users') ?? []]).toContain('anabela');
    expect(cube.users.get('anabela')).toBe('anabela@example.org');
    surface.asked = [];
    expect(plain((await chris_run(reach, ['user', 'mod', 'anabela', '--email', 'anabela@example.org'])).rendered)).toMatch(/^store: anabela is so already/);
    expect((await chris_run(reach, ['user', 'mod', 'nobody', '--groups', 'pacs_users'])).renderedErr).toContain('store: no account nobody');
    expect((await chris_run(reach, ['user', 'mod', 'anabela', '--email', 'dev@babymri.org'])).renderedErr).toContain('dev@babymri.org is chris\'s already');
    expect((await chris_run(reach, ['user', 'mod', 'anabela'])).renderedErr).toContain('nothing to change: --email or --groups');
    expect(surface.asked).toEqual([]);
  });

  it('generates a password when none is typed, shows it once, and reads one from a file', async () => {
    surface.answers = ['y', 'admin-password'];
    await chris_run(context, ['deploy', 'store', '--profile', 'minimal']);
    surface.answers = ['y', ''];
    const generated = await chris_run(context, ['user', 'add', 'sandip', '--email', 'sandip@example.org']);
    expect(plain(generated.rendered)).toContain(`the password for sandip, generated, shown this once: ${vm.made[0]?.password}`);
    expect(vm.made[0]?.password.length).toBeGreaterThanOrEqual(32);
    const file: string = join(root, 'josh-password');
    writeFileSync(file, 'from-a-file-1\n', { mode: 0o600 });
    surface.asked = [];
    surface.answers = ['y'];
    await chris_run(context, ['user', 'add', 'joshua', '--email', 'josh@example.org', '--password-file', file, '--on', 'store']);
    expect(surface.asked).toHaveLength(1);
    expect(surface.asked[0]).toContain(`its password read from ${file}`);
    expect(vm.made[1]).toEqual({ username: 'joshua', email: 'josh@example.org', password: 'from-a-file-1' });
    writeFileSync(file, 'short\n');
    expect((await chris_run(context, ['user', 'add', 'joshua2', '--email', 'josh2@example.org', '--password-file', file])).renderedErr).toContain('shorter than eight characters');
  });

  it('refuses without an email, a bad name, a VM with no ChRIS, and more than one ChRIS without --on', async () => {
    surface.answers = ['y', 'admin-password'];
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
    expect(userAnswer_parse('stratus-user no-group ["radiology"]\n')).toEqual({ kind: 'noGroup', groups: ['radiology'] });
    expect(userAnswer_parse('Traceback (most recent call last):\n')).toBeNull();
  });

  it('with --porter, runs porter beside CUBE under its own name, its secret kept, both names pointed and waited for', async () => {
    expect((await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--porter', 'porter.example.org'])).renderedErr).toContain('--porter porter.example.org needs --host');
    expect((await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--host', 'cube.example.org', '--porter', 'cube.example.org'])).renderedErr).toContain('porter needs a name of its own');
    surface.answers = ['y', 'admin-password'];
    resolved = ['203.0.113.10'];
    const asked: string[] = [];
    context = { ...context, status_get: async (url: string): Promise<number | null> => { asked.push(url); return 200; } };
    const deployed = await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--host', 'cube.example.org', '--porter', 'porter.example.org', '--berths', 'off']);
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
    expect(compose.services['porter']?.['image']).toBe('stratus/porter:0.11.1');
    expect(String((compose.services['porter']?.['build'] as { dockerfile_inline: string }).dockerfile_inline)).toContain('npm install -g @fnndsc/porter@0.11.1');
    expect(compose.services['porter']?.['volumes']).toEqual(['porter:/var/lib/porter']);
    expect(compose.services['caddy']?.['networks']).toEqual({ default: { aliases: ['cube.example.org'] } });
    expect(Object.keys(compose.volumes)).toContain('porter');
    expect(vm.files.get('/srv/data/chris/Caddyfile')).toBe('cube.example.org {\n\treverse_proxy chris:8000\n}\n\nporter.example.org {\n\treverse_proxy porter:4180\n}\n');
    expect(vm.files.get('/srv/data/chris/porter.env')).toBe(`PORTER_CUBE_URL=https://cube.example.org/api/v1/\nPORTER_STATE_DIR=/var/lib/porter/sessions\nPORTER_HOST=0.0.0.0\nPORTER_PORT=4180\nPORTER_SECRET=${secrets?.porterSecret}\n`);
    expect(vm.lines.some((line: string): boolean => line.includes(secrets?.porterSecret ?? '?'))).toBe(false);
    expect(vms.record_read('store')?.chris).toMatchObject({ porter: 'porter.example.org', dns: 'seen' });
    expect(plain((await chris_run(context, ['status'])).rendered)).toContain('porter https://porter.example.org/');
    await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--host', 'cube.example.org', '--porter', 'porter.example.org', '--berths', 'off']);
    expect(secrets_read(vms, 'store')).toEqual(secrets);
    // The deploy keeps what it put up; a replay as deployed restarts nothing and asks nothing.
    expect(vms.record_read('store')?.chris).toMatchObject({ image: 'ghcr.io/fnndsc/cube:6.11.0', porterVersion: '0.11.1' });
    const line: string[] = ['deploy', 'store', '--profile', 'minimal', '--host', 'cube.example.org', '--porter', 'porter.example.org', '--berths', 'off'];
    const planned = await chris_run(context, [...line, '--plan']);
    expect(plain(planned.rendered)).toBe('chris deploy store: as deployed; nothing restarts\n');
    expect(planned.model).toMatchObject({ kind: 'stratus.chris.plan', data: { vm: 'store', changes: [], restarts: [], asks: false } });
    // A porter older than this stratus's: the replay plans porter's restart, reads the sessions it ends from porter, and asks first; no, and nothing changes.
    vms.record_update('store', (record): void => { if (record.chris !== undefined) record.chris.porterVersion = '0.9.10'; });
    const live: ChrisCommandContext = { ...context, http_get: async (url: string) => (url === 'https://porter.example.org/healthz' ? { status: 200, body: { ok: true, sessions: 2, version: '0.9.10' } } : null) };
    expect(plain((await chris_run(live, [...line, '--plan'])).rendered)).toBe('chris deploy store: as deployed; restarts porter (0.9.10 → 0.11.1): its open sessions end; 2 porter sessions open now end\n');
    surface.asked = [];
    surface.answers = ['n'];
    const before: number = vm.lines.length;
    expect(plain((await chris_run(live, line)).rendered)).toContain('stopped before the deploy; nothing changed');
    expect(surface.asked.at(-1)).toBe('chris deploy store: as deployed; restarts porter (0.9.10 → 0.11.1): its open sessions end; 2 porter sessions open now end. A NO changes nothing. Continue? [y/N]');
    expect(vm.lines.length).toBe(before);
    // status reads what runs from it, over HTTPS, under the deploy's record.
    const reading: ChrisCommandContext = { ...context, http_get: async (url: string, auth) => (url === 'https://porter.example.org/healthz' ? { status: 200, body: { sessions: 2, version: '0.9.11' } }
      : url === 'https://cube.example.org/api/v1/' ? { status: auth !== null ? 200 : 401, body: {} }
        : url.includes('groups/?limit') ? { status: 200, body: { next: null, results: [{ id: 3, name: 'all_users' }] } }
          : url.includes('groups/3/users') ? { status: 200, body: { next: null, results: [{ username: 'chris', email: 'dev@babyMRI.org' }] } } : null) };
    const status = await chris_run(reading, ['status']);
    expect(plain(status.rendered)).toMatch(/runs {6}CUBE answers 200, chris signs in; porter answers 200, 2 sessions open, porter 0\.9\.11 {2}\(read \d\d:\d\d UTC\)/);
    expect(plain(status.rendered)).toContain('accounts  1 account: chris');
    expect(plain(status.rendered)).toContain('berths    not read: porter does not answer');
    // Porter answering its berths: each person's berth or kept home, in the lines and in the model.
    const berthed: ChrisCommandContext = { ...reading, http_get: async (url: string, auth) => url === 'https://porter.example.org/berths'
      ? { status: 200, body: { berths: [{ user: 'ana', state: 'running', cohort: 'none', cpuPercent: 3, memoryBytes: 220200960, memoryLimitBytes: 2147483648 }, { user: 'benito', state: 'stopped', cohort: null, cpuPercent: null, memoryBytes: null, memoryLimitBytes: null }] } }
      : reading.http_get!(url, auth) };
    const berthStatus = await chris_run(berthed, ['status']);
    expect(plain(berthStatus.rendered)).toContain('berths    1 running, 1 home kept (ana running, benito stopped)');
    expect(berthStatus.model).toMatchObject({ data: { chris: [{ live: { berthsWhy: null, berths: [{ user: 'ana', state: 'running', memoryBytes: 220200960 }, { user: 'benito', state: 'stopped', cohort: null }] } }] } });
    // A porter that starts no berths says so: the line says off, not a failed read.
    const off = await chris_run({ ...reading, http_get: async (url: string, auth) => url === 'https://porter.example.org/berths' ? { status: 200, body: { berths: null, why: 'this porter starts no berths' } } : reading.http_get!(url, auth) }, ['status']);
    expect(plain(off.rendered)).toContain('berths    off');
    expect(off.model).toMatchObject({ data: { chris: [{ live: { berths: null, berthsWhy: null, berthsOff: true } }] } });
    expect(status.model).toMatchObject({ kind: 'stratus.chris.status', data: { chris: [{ vm: 'store', image: 'ghcr.io/fnndsc/cube:6.11.0', live: { cube: { admin: true }, accounts: [{ username: 'chris' }] } }] } });
  });

  describe('berths at deploy', () => {
    const keyed: ChrisSecrets = { ...SECRETS, porterSecret: 'porter-s', launcherSecret: 'launcher-s' };
    const job = (logged: string[]): JobContext => ({ signal: new AbortController().signal, data: {}, progress_set: (): void => undefined, log_write: (line: string): void => { logged.push(line); }, data_set: (): void => undefined });
    const request = (over: Partial<DeployRequest> = {}): DeployRequest => ({ vm: 'store', profile: CHRIS_PROFILES['minimal'] as ChrisProfile, compute: 'store', host: 'cube.example.org', porter: 'porter.example.org', berths: true, secrets: keyed, ...over });
    const deps = (): DeployDeps => ({ store: vms, nets: context.nets, builder: context.builder, resolve: async (): Promise<string[]> => ['203.0.113.10'], status_get: async (): Promise<number | null> => 200, remote_open: async (): Promise<VmRemote> => vm, tickMs: 0 });

    it('reads the socket\'s group, writes the berth files as the image\'s node user, pulls the pinned image by digest, waits for the launcher, and records both', async () => {
      vm.dockerGid = '119';
      const logged: string[] = [];
      await chrisDeployRun_make(request(), deps())(job(logged));
      expect(vm.lines).toContain('stat -c %g /var/run/docker.sock');
      const compose = yaml.load(vm.files.get('/srv/data/chris/compose.yml') ?? '') as { services: Record<string, Record<string, unknown>> };
      expect(compose.services['berth-launcher']?.['group_add']).toEqual(['119']);
      expect([...vm.files.keys()]).toEqual(expect.arrayContaining(['/srv/data/chris/launcher.env', '/srv/data/chris/porter.env', '/srv/data/chris/berth/launcher.secret', '/srv/data/chris/berth/policy.json']));
      expect(vm.files.get('/srv/data/chris/berth/launcher.secret')).toBe('launcher-s\n');
      expect(vm.files.get('/srv/data/chris/berth/policy.json')).toBe('{"cpus":1,"memoryGib":2}\n');
      expect(vm.files.get('/srv/data/chris/porter.env')).toContain('PORTER_BERTHS=launcher\n');
      expect(vm.files.get('/srv/data/chris/launcher.env')).toContain('BERTH_CUBE_HOST=cube.example.org\n');
      expect(vm.lines).toContain('sudo install -d -o 1000 -g 1000 -m 0700 /srv/data/chris/berth /srv/data/chris/berth/run');
      const written: string[] = vm.lines.filter((line: string): boolean => line.startsWith('sudo sh -c'));
      expect(written).toHaveLength(2);
      for (const line of written) expect(line).toMatch(/^sudo sh -c 'umask 077 && cat > \/srv\/data\/chris\/berth\/[a-z.]+\.new && chown 1000:1000 \/srv\/data\/chris\/berth\/[a-z.]+\.new && chmod 0\d{3} .* && mv /);
      expect(vm.lines.some((line: string): boolean => line.includes('launcher-s'))).toBe(false);
      const at = (needle: string): number => vm.lines.findIndex((line: string): boolean => line.includes(needle));
      expect(vm.lines).toContain('cd /srv/data/chris && docker compose pull -q --ignore-buildable && docker compose build -q');
      const pin: string = vm.lines.find((line: string): boolean => line.startsWith('docker run --rm --entrypoint node ')) ?? '';
      expect(pin).toContain(`stratus/porter:${PORTER_VERSION}`);
      expect(pin).toContain('BERTH_IMAGE_DEFAULT');
      expect(pin).toContain('/usr/local/lib/node_modules/@fnndsc/porter/dist/launcher/launcher.js');
      expect(vm.pulled).toEqual([vm.berthPin]);
      // Built, then the pin read, the image pulled, the services up, the launcher's health asked, only then CUBE.
      const order: number[] = ['docker compose build', 'docker run --rm', 'docker pull -q', 'docker compose up', 'Health.Status', 'http://127.0.0.1:8000/api/v1/'].map(at);
      expect(order.every((index: number): boolean => index >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a: number, b: number): number => a - b));
      expect(vm.lines).toContain('docker inspect -f \'{{.State.Health.Status}}\' chris-berth-launcher-1');
      expect(logged).toContain('the berth launcher answers on its socket: porter starts a berth for each person');
      expect(vms.record_read('store')?.chris).toMatchObject({ porter: 'porter.example.org', berths: 'launcher', berthImage: vm.berthPin, berthLimits: { cpus: 1, memoryGib: 2 } });
      expect(vm.lines.some((line: string): boolean => line.includes('docker compose restart'))).toBe(false);
    });

    it('writes the limits it is asked for to the launcher\'s policy and records them; only a change on a replay restarts the launcher, after the services are up', async () => {
      const restart: string = 'cd /srv/data/chris && docker compose restart berth-launcher';
      const logged: string[] = [];
      await chrisDeployRun_make(request({ berthLimits: { cpus: 0.5, memoryGib: 1.5 } }), deps())(job(logged));
      expect(vm.files.get('/srv/data/chris/berth/policy.json')).toBe('{"cpus":0.5,"memoryGib":1.5}\n');
      expect(vms.record_read('store')?.chris?.berthLimits).toEqual({ cpus: 0.5, memoryGib: 1.5 });
      // A first deploy, then the same limits again: the launcher is not restarted.
      await chrisDeployRun_make(request({ berthLimits: { cpus: 0.5, memoryGib: 1.5 } }), deps())(job([]));
      expect(vm.lines).not.toContain(restart);
      // Other limits over a record that had berths: the file is written, the services up, then the launcher restarted, then its health asked.
      vm.lines.length = 0;
      await chrisDeployRun_make(request({ berthLimits: { cpus: 2, memoryGib: 4 } }), deps())(job(logged));
      expect(vm.files.get('/srv/data/chris/berth/policy.json')).toBe('{"cpus":2,"memoryGib":4}\n');
      expect(vm.lines.filter((line: string): boolean => line === restart)).toHaveLength(1);
      const at = (needle: string): number => vm.lines.findIndex((line: string): boolean => line.includes(needle));
      expect(at('docker compose up')).toBeGreaterThanOrEqual(0);
      expect(at('docker compose restart')).toBeGreaterThan(at('docker compose up'));
      expect(at('Health.Status')).toBeGreaterThan(at('docker compose restart'));
      expect(vms.record_read('store')?.chris?.berthLimits).toEqual({ cpus: 2, memoryGib: 4 });
      expect(logged).toContain('the berth limits changed: the berth launcher is restarted to read them; running berths keep their limits until their next start');
      // A launcher from before limits read an empty policy, the defaults: asking for the defaults restarts nothing, asking for others does.
      vm.files.set('/srv/data/chris/berth/policy.json', '{}\n');
      vm.lines.length = 0;
      await chrisDeployRun_make(request(), deps())(job([]));
      expect(vm.lines).not.toContain(restart);
      vm.files.set('/srv/data/chris/berth/policy.json', '{}\n');
      await chrisDeployRun_make(request({ berthLimits: { cpus: 3, memoryGib: 2 } }), deps())(job([]));
      expect(vm.lines).toContain(restart);
    });

    it('decides the launcher\'s restart by the policy file on the VM, not the record a failed run leaves behind', async () => {
      const restart: string = 'cd /srv/data/chris && docker compose restart berth-launcher';
      await chrisDeployRun_make(request(), deps())(job([]));
      // A run that restarts the launcher for 2 CPU, 4 GiB and then fails: the file and the launcher say 2 and 4, the record still 1 and 2.
      vm.launcherHealth = 'starting';
      await expect(chrisDeployRun_make(request({ berthLimits: { cpus: 2, memoryGib: 4 } }), deps())(job([]))).rejects.toThrow('the berth launcher did not answer');
      vm.launcherHealth = 'healthy';
      expect(vms.record_read('store')?.chris?.berthLimits).toEqual({ cpus: 1, memoryGib: 2 });
      expect(vm.lines.filter((line: string): boolean => line === restart)).toHaveLength(1);
      // The same ask again: the launcher already has them, so it is not restarted (the record would have said it differs).
      vm.lines.length = 0;
      await chrisDeployRun_make(request({ berthLimits: { cpus: 2, memoryGib: 4 } }), deps())(job([]));
      expect(vm.lines).not.toContain(restart);
      expect(vms.record_read('store')?.chris?.berthLimits).toEqual({ cpus: 2, memoryGib: 4 });
      // Back to the record's own limits after another failed run: the file differs from them, so the launcher is restarted (the record would have said it matches).
      vms.record_update('store', (record): void => { if (record.chris !== undefined) record.chris.berthLimits = { cpus: 1, memoryGib: 2 }; });
      await chrisDeployRun_make(request(), deps())(job([]));
      expect(vm.lines).toContain(restart);
    });

    it('with no record but the launcher up, a changed policy restarts it; with it not up, nothing restarts', async () => {
      const restart: string = 'cd /srv/data/chris && docker compose restart berth-launcher';
      await chrisDeployRun_make(request(), deps())(job([]));
      // The first run failed before it kept a record: the compose state alone says the launcher runs.
      vms.record_update('store', (record): void => { delete record.chris; });
      vm.lines.length = 0;
      await chrisDeployRun_make(request({ berthLimits: { cpus: 2, memoryGib: 4 } }), deps())(job([]));
      expect(vm.lines).toContain(restart);
      // No launcher, no record: a policy file left on the VM differing from the ask restarts nothing.
      await chrisDeployRun_make(request({ berths: false }), deps())(job([]));
      vms.record_update('store', (record): void => { delete record.chris; });
      vm.lines.length = 0;
      await chrisDeployRun_make(request({ berthLimits: { cpus: 3, memoryGib: 6 } }), deps())(job([]));
      expect(vm.lines).not.toContain(restart);
    });

    it('turning berths off and on again is no limits change: no restart of the launcher, which is up fresh', async () => {
      await chrisDeployRun_make(request({ berths: false }), deps())(job([]));
      await chrisDeployRun_make(request({ berthLimits: { cpus: 2, memoryGib: 4 } }), deps())(job([]));
      expect(vm.lines.some((line: string): boolean => line.includes('docker compose restart'))).toBe(false);
      expect(vms.record_read('store')?.chris?.berthLimits).toEqual({ cpus: 2, memoryGib: 4 });
    });

    it('without berths, reads no socket and writes no berth file, and records none', async () => {
      await chrisDeployRun_make(request({ berths: false }), deps())(job([]));
      expect(vm.lines).toContain('cd /srv/data/chris && docker compose pull -q --ignore-buildable && docker compose build -q');
      expect(vm.lines.some((line: string): boolean => line.startsWith('stat ') || line.startsWith('docker pull') || line.startsWith('sudo sh'))).toBe(false);
      expect([...vm.files.keys()].some((file: string): boolean => file.includes('berth') || file.includes('launcher'))).toBe(false);
      expect(vms.record_read('store')?.chris?.berths).toBeUndefined();
      expect(vms.record_read('store')?.chris?.berthImage).toBeUndefined();
      expect(vms.record_read('store')?.chris?.berthLimits).toBeUndefined();
    });

    it('turning berths off removes the berths and wires the launcher made, keeping the homes; a deploy that never had them removes nothing', async () => {
      const removal: string = 'docker ps -aq --filter label=org.fnndsc.mise.berth | xargs -r docker rm -f && docker network ls -q --filter label=org.fnndsc.mise.berth | xargs -r docker network rm';
      await chrisDeployRun_make(request({ berths: false }), deps())(job([]));
      expect(vm.lines).not.toContain(removal);
      await chrisDeployRun_make(request(), deps())(job([]));
      expect(vm.lines).not.toContain(removal);
      const logged: string[] = [];
      await chrisDeployRun_make(request({ berths: false }), deps())(job(logged));
      expect(vm.lines).toContain(removal);
      expect(vm.lines.indexOf(removal)).toBeGreaterThan(vm.lines.lastIndexOf('cd /srv/data/chris && docker compose up -d --build --remove-orphans'));
      expect(vm.lines.some((line: string): boolean => line.includes('docker volume rm'))).toBe(false);
      expect(logged).toContain('berths off: the running berths and their wires are removed; every person\'s home is kept');
    });

    it('refuses a pin that is not an image by digest, before anything is pulled or started', async () => {
      for (const pin of ['ghcr.io/fnndsc/berth:latest', 'ghcr.io/fnndsc/berth@sha256:abc', '']) {
        vm.berthPin = pin;
        await expect(chrisDeployRun_make(request(), deps())(job([]))).rejects.toThrow(`reading the berth image porter pins: ${pin || 'nothing'} is not an image by digest`);
      }
      expect(vm.pulled).toEqual([]);
      expect(vm.lines.some((line: string): boolean => line.includes('docker compose up'))).toBe(false);
      expect(vms.record_read('store')?.chris).toBeUndefined();
    });

    it('refuses a socket group that is not a number, and says the launcher\'s last words when it never answers', async () => {
      vm.dockerGid = 'docker';
      await expect(chrisDeployRun_make(request(), deps())(job([]))).rejects.toThrow('reading the group of Docker\'s socket: not a number');
      vm.dockerGid = '998';
      vm.launcherHealth = 'starting';
      await expect(chrisDeployRun_make(request(), deps())(job([]))).rejects.toThrow('the berth launcher did not answer on its socket in five minutes: listening failed / EACCES docker.sock');
      expect(vms.record_read('store')?.chris).toBeUndefined();
    });

    it('needs the launcher\'s secret', async () => {
      const bare: ChrisSecrets = { ...SECRETS, porterSecret: 'porter-s' };
      await expect(chrisDeployRun_make(request({ secrets: bare }), deps())(job([]))).rejects.toThrow('berths need the launcher\'s secret');
    });

    it('keeps the launcher\'s secret beside the others, made once', () => {
      surface.answers = [];
      const first = launcherSecret_ensure(vms, 'store', { ...SECRETS, porterSecret: 'porter-s' });
      expect(first.launcherSecret?.length).toBeGreaterThanOrEqual(32);
      expect(secrets_read(vms, 'store')?.launcherSecret).toBe(first.launcherSecret);
      expect(launcherSecret_ensure(vms, 'store', first)).toBe(first);
    });

    it('a porter brings berths unless --berths off; refuses anything but on or off, and berths without a porter', async () => {
      const line: string[] = ['deploy', 'store', '--profile', 'minimal', '--host', 'cube.example.org', '--porter', 'porter.example.org'];
      for (const word of ['on', undefined]) {
        const planned = await chris_run(context, [...line, ...(word !== undefined ? ['--berths', word] : []), '--plan']);
        expect(planned.renderedErr ?? '').toBe('');
        expect(plain(planned.rendered)).toContain('a berth for each person behind porter');
      }
      expect((await chris_run(context, [...line, '--berths', 'maybe'])).renderedErr).toContain('chris deploy: --berths maybe: on or off');
      expect((await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--berths', 'on'])).renderedErr).toContain('chris deploy: --berths on needs --porter');
      expect((await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--host', 'cube.example.org', '--berths', 'on'])).renderedErr).toContain('chris deploy: --berths on needs --porter');
      const off = await chris_run(context, [...line, '--berths', 'off', '--plan']);
      expect(off.renderedErr ?? '').toBe('');
      expect(plain(off.rendered)).not.toContain('berth');
      expect(vm.lines).toEqual([]);
    });

    it('--berth-cpus and --berth-memory take a positive number (two decimals, one decimal), default 1 and 2, and need berths', async () => {
      const line: string[] = ['deploy', 'store', '--profile', 'minimal', '--host', 'cube.example.org', '--porter', 'porter.example.org'];
      const defaults = await chris_run(context, [...line, '--plan']);
      expect(plain(defaults.rendered)).toContain('a berth for each person behind porter, 1 vCPU · 2 GiB each (the berth launcher, the berth image pulled)');
      const named = await chris_run(context, [...line, '--berth-cpus', '0.25', '--berth-memory=4', '--plan']);
      expect(named.renderedErr ?? '').toBe('');
      expect(plain(named.rendered)).toContain('behind porter, 0.25 vCPU · 4 GiB each (');
      for (const word of ['0', '-1', '1.234', 'two', '1e1', '0.00']) expect((await chris_run(context, [...line, '--berth-cpus', word, '--plan'])).renderedErr).toContain(`chris deploy: --berth-cpus ${word}: a positive number of CPUs, at most two decimals`);
      for (const word of ['0', '-2', '2.25', 'lots', '0.0']) expect((await chris_run(context, [...line, '--berth-memory', word, '--plan'])).renderedErr).toContain(`chris deploy: --berth-memory ${word}: a positive number of GiB, at most one decimal`);
      for (const option of ['--berth-cpus', '--berth-memory']) {
        const base: string[] = ['deploy', 'store', '--profile', 'minimal', '--host', 'cube.example.org'];
        expect((await chris_run(context, [...base, option, '2'])).renderedErr).toContain(`chris deploy: ${option} needs berths (a --porter, and not --berths off)`);
        expect((await chris_run(context, [...line, '--berths', 'off', option, '2'])).renderedErr).toContain(`chris deploy: ${option} needs berths (a --porter, and not --berths off)`);
      }
      expect(vm.lines).toEqual([]);
    });

    it('refuses berths its machine cannot hold, by memory above the profile\'s floor and by CPUs it has; berths off and limits that fit are not refused', async () => {
      const line: string[] = ['deploy', 'store', '--profile', 'minimal', '--host', 'cube.example.org', '--porter', 'porter.example.org', '--plan'];
      // store is 2 vCPU, 8 GiB: the floor takes 4 GiB, leaving 4; CPUs are a cap on shared ones, so they decide nothing but a limit above the machine's.
      expect((await chris_run(context, [...line, '--berth-cpus', '3'])).renderedErr).toBe('chris deploy: --berth-cpus 3: store has 2 vCPU\n');
      expect((await chris_run(context, [...line, '--berth-memory', '4.5'])).renderedErr).toBe('chris deploy: berths of 4.5 GiB do not fit store above the minimal profile\'s floor (8 GiB; the floor takes 4 GiB)\n');
      expect((await chris_run(context, line)).renderedErr ?? '').toBe('');
      expect(plain((await chris_run(context, line)).rendered)).toContain('1 vCPU · 2 GiB each');
      expect((await chris_run(context, [...line, '--berth-cpus', '2', '--berth-memory', '4'])).renderedErr ?? '').toBe('');
      expect((await chris_run(context, [...line.filter((word: string): boolean => word !== '--porter' && word !== 'porter.example.org')])).renderedErr ?? '').toBe('');
      expect((await chris_run(context, [...line, '--berths', 'off'])).renderedErr ?? '').toBe('');
      expect(vm.lines).toEqual([]);
    });

    it('a replay with other limits plans the change and the launcher\'s restart, and asks; the same limits ask nothing', async () => {
      const line: string[] = ['deploy', 'store', '--profile', 'minimal', '--host', 'cube.example.org', '--porter', 'porter.example.org'];
      vms.record_update('store', (record): void => { record.chris = { profile: 'minimal', compute: 'store', host: 'cube.example.org', url: 'https://cube.example.org/api/v1/', deployed: '2026-11-09T00:00:00.000Z', porter: 'porter.example.org', image: CHRIS_IMAGES.cube, porterVersion: PORTER_VERSION, berths: 'launcher', berthImage: vm.berthPin }; });
      expect(plain((await chris_run(context, [...line, '--plan'])).rendered)).toBe('chris deploy store: as deployed; nothing restarts\n');
      const changed = await chris_run(context, [...line, '--berth-cpus', '2', '--berth-memory', '4', '--plan']);
      expect(plain(changed.rendered)).toBe('chris deploy store: berth limits 1 vCPU · 2 GiB → 2 vCPU · 4 GiB; restarts the berth launcher: running berths keep their limits and sessions until their next start, which needs a fresh login\n');
      expect(changed.model).toMatchObject({ data: { asks: true } });
      // `chris status` carries the berths and their limits, for a screen to set the line beside them.
      expect((await chris_run(context, ['status'])).model).toMatchObject({ data: { chris: [{ vm: 'store', berths: true, berthLimits: null }] } });
      vms.record_update('store', (record): void => { if (record.chris !== undefined) record.chris.berthLimits = { cpus: 2, memoryGib: 4 }; });
      expect((await chris_run(context, ['status'])).model).toMatchObject({ data: { chris: [{ berths: true, berthLimits: { cpus: 2, memoryGib: 4 } }] } });
    });
  });

  it('with --porter and a name not yet seen, says it waits on porter\'s DNS', async () => {
    surface.answers = ['y', 'admin-password'];
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
    expect(await read('net new scratch --cidr 10.50.0.0/16')).toBe('changed (cidr 10.40.0.0/16 → 10.50.0.0/16; a new CIDR on a built network replaces its VCN and subnet, and every machine on them: net build refuses it unless --allow-alter)');
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
    surface.answers = ['y', 'admin-password'];
    await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--compute', 'NERC']);
    expect(await read('chris deploy store --profile minimal --compute NERC')).toMatch(/^done \(deployed /);
    expect(await read('chris deploy store --profile minimal --compute NERC --host cube.example.org')).toBe('changed (host none → cube.example.org)');
    expect(await read('chris deploy store --profile minimal')).toBe('changed (compute NERC → store)');
    expect(await read('chris user add jorge --email j@example.org')).toBe('ready (asks CUBE when it runs; a name already there is left as it is)');
    expect(await read('chris user add jorge --email j@example.org --on blt')).toBe('not yet (no ChRIS on blt (chris deploy blt))');
    // The spec moves under what was built: the build and the deploy have a change to plan.
    await vm_run(vmContext, ['new', 'store', '--memory', '16']);
    expect(await read('vm new store --net scratch --open 80,443 --vcpu 2 --memory 16 --disk 50 --data 50 --os ubuntu-26.04')).toBe('done (unchanged)');
    // The record keeps what the build made, so the build line says what it would change.
    // What runs is read from the tenancy after the build, so the change is said against it, with its unit.
    expect(await read('vm build store')).toBe('changed (declared, not built: memory 8 → 16 GiB; the build plans and asks)');
    // A record from before builds kept their spec, and not read from the tenancy, says only that it was declared again.
    vms.record_update('store', (record): void => { delete record.builtSpec; delete record.stands; });
    expect(await read('vm build store')).toBe('changed (declared again since it was built; the build plans and asks)');
    // Declaring the VM again changes nothing of its ChRIS (the operator, 2026-11-07).
    expect(await read('chris deploy store --profile minimal --compute NERC')).toMatch(/^done \(deployed /);
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
    surface.answers = ['y', 'admin-password'];
    await chris_run(context, ['deploy', 'store', '--profile', 'minimal', '--compute', 'NERC']);
    runner.job_start(STEPS_SOURCE, USER_JOBS.add('store'), 'add jorge to the ChRIS on store', held);
    expect(await running('chris user add jorge --email j@example.org')).toBe('/proc/steps/chris-store-user-add');
    expect(await running('chris user add maria --email m@example.org')).toBeUndefined();
    runner.job_stop(STEPS_SOURCE, USER_JOBS.add('store'));
    await new Promise((resolve: (value: unknown) => void): void => { setTimeout(resolve, 20); });
  });

  it('changes the admin\'s password: asked first, typed twice, kept on the host, in cube.env and in CUBE, the services started again, signed in with, kept in the tenancy', async () => {
    surface.answers = ['y', 'admin-password'];
    await chris_run(context, ['deploy', 'store', '--profile', 'minimal']);
    expect(vm.passwords.get('chris')).toBe('admin-password');
    surface.asked = [];
    vm.lines = [];
    surface.answers = ['n'];
    expect(plain((await chris_run(context, ['passwd'])).rendered)).toBe('store: chris\'s password not changed\n');
    expect(surface.asked).toEqual(['chris passwd: chris on store: CUBE at http://203.0.113.10/api/v1/ starts again to take the new password, and is down for a minute or so. Continue? [y/N]']);
    expect(vm.lines).toEqual([]);
    surface.answers = ['y', 'a-new-password', 'not-the-same'];
    expect((await chris_run(context, ['passwd'])).renderedErr).toContain('the two passwords typed differ; nothing changed');
    surface.answers = ['y', 'short'];
    expect((await chris_run(context, ['passwd'])).renderedErr).toContain('the password is shorter than eight characters');
    expect(secrets_read(vms, 'store')?.adminPassword).toBe('admin-password');
    expect(vm.lines).toEqual([]);
    surface.asked = [];
    surface.answers = ['y', 'a-new-password', 'a-new-password'];
    const changed = await chris_run(context, ['passwd', 'chris', '--on', 'store']);
    expect(changed.renderedErr ?? '').toBe('');
    expect(surface.asked.slice(1)).toEqual(['chris\'s new password (empty: generate one):', 'chris\'s new password, again:']);
    expect(plain(changed.rendered)).toBe('store: chris\'s password changed at http://203.0.113.10/api/v1/ (kept on this host and in the tenancy, never shown again)\n');
    expect(secrets_read(vms, 'store')?.adminPassword).toBe('a-new-password');
    expect(vm.files.get('/srv/data/chris/cube.env')).toContain('CHRIS_SUPERUSER_PASSWORD=a-new-password\n');
    expect(vm.passwords.get('chris')).toBe('a-new-password');
    expect(vm.lines).toContain('cd /srv/data/chris && docker compose up -d');
    expect(vm.lines.some((line: string): boolean => line.includes('a-new-password'))).toBe(false);
    expect([...world.kept.values()].some((content: string): boolean => content.includes('a-new-password'))).toBe(true);
    const keep = context.builder?.keep_write;
    if (context.builder !== null) context.builder.keep_write = async (): Promise<void> => { throw new Error('Bad Gateway'); };
    surface.answers = ['y', 'a-second-password', 'a-second-password'];
    expect(plain((await chris_run(context, ['passwd'])).rendered)).toBe('store: chris\'s password changed at http://203.0.113.10/api/v1/ (kept on this host, never shown again; NOT in the tenancy: vm keep store keeps it there)\n');
    if (context.builder !== null && keep !== undefined) context.builder.keep_write = keep;
    surface.answers = ['y', ''];
    const generated = await chris_run(context, ['passwd']);
    const made: string = secrets_read(vms, 'store')?.adminPassword ?? '?';
    expect(made.length).toBeGreaterThanOrEqual(32);
    expect(plain(generated.rendered)).toContain(`the new password for chris, generated, shown this once: ${made}`);
    expect(vm.passwords.get('chris')).toBe(made);
  });

  it('a change stopped part way is kept on the host and finishes when asked again with the same password', async () => {
    surface.answers = ['y', 'admin-password'];
    await chris_run(context, ['deploy', 'store', '--profile', 'minimal']);
    vm.failing.add('cd /srv/data/chris && docker compose up -d');
    surface.answers = ['y', 'a-new-password', 'a-new-password'];
    const stopped = await chris_run(context, ['passwd']);
    expect(stopped.renderedErr).toContain('chris passwd: chris-store-passwd: failed: docker compose up: exit 1: it failed (this host keeps the new password already: chris passwd again, with the same one, finishes it)');
    expect(secrets_read(vms, 'store')?.adminPassword).toBe('a-new-password');
    surface.answers = ['y', 'a-new-password', 'a-new-password'];
    expect((await chris_run(context, ['passwd'])).renderedErr ?? '').toBe('');
    expect(vm.passwords.get('chris')).toBe('a-new-password');
  });

  it('changes another account\'s password in CUBE alone, never kept, without starting CUBE again; refuses one not there', async () => {
    surface.answers = ['y', 'admin-password'];
    await chris_run(context, ['deploy', 'store', '--profile', 'minimal']);
    surface.answers = ['y', 'jorge-password'];
    await chris_run(context, ['user', 'add', 'jorge', '--email', 'jorge@example.org']);
    surface.asked = [];
    vm.lines = [];
    surface.answers = ['jorge-new-password', 'jorge-new-password'];
    const changed = await chris_run(context, ['passwd', 'jorge']);
    expect(changed.renderedErr ?? '').toBe('');
    expect(surface.asked).toEqual(['jorge\'s new password (empty: generate one):', 'jorge\'s new password, again:']);
    expect(plain(changed.rendered)).toBe('store: jorge\'s password changed at http://203.0.113.10/api/v1/ (never kept)\n');
    expect(vm.passwords.get('jorge')).toBe('jorge-new-password');
    expect(vm.lines.some((line: string): boolean => line.includes('docker compose up'))).toBe(false);
    expect(JSON.stringify(secrets_read(vms, 'store'))).not.toContain('jorge-new-password');
    surface.answers = ['maria-password', 'maria-password'];
    expect((await chris_run(context, ['passwd', 'maria'])).renderedErr).toContain('store: no account maria (chris user add maria --email <address>)');
    expect((await chris_run(context, ['passwd', 'a,b'])).renderedErr).toContain('a user name is 4 to 32');
    expect(PASSWD_JOBS.passwd('store')).toBe('chris-store-passwd');
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

