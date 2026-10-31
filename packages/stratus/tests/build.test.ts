/**
 * @file Building a cluster over the fake cloud and the fake installer: its
 * state on the host, the steps' run in the core's runner, and the verbs
 * `cluster new`, `cluster plan` and `cluster build`.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BufferSink, HeadlessSurface, JobRunner, runner_install, sink_set, surface_set, type CommandEnvelope, type JobRecord, type PromptRequest } from '@fnndsc/brasa/core';
import { FakeDriver, fakeCloud_sample } from '../src/cloud/fake/driver.js';
import { FakeBuildWorld, FakeCloudBuilder, FakeInstaller } from '../src/cloud/fake/builder.js';
import type { BuildCall, CloudBuilder, InfraPlan, PreflightCheck } from '../src/cloud/builder.js';
import { planCounts_alter, plan_count, planCounts_words } from '../src/cloud/builder.js';
import { ClusterStore, clustersRoot_derive, clustersRoot_settle, type ClusterRecord } from '../src/cluster/state.js';
import { SPEC_DEFAULT, specOptions_apply, type ClusterSpec } from '../src/cluster/spec.js';
import { buildJob_id, buildRun_make, stepNext_find, STEPS_SOURCE, type BuildDeps } from '../src/cluster/steps.js';
import { cost_words, familyShape_find, specCost_compute, specFit_read } from '../src/cluster/sizing.js';
import { builtCluster_read } from '../src/cluster/view.js';
import { condition_derive, clusterReadout_build, planSummary_build, refusals_derive } from '../src/cluster/readout.js';
import type { HarborCluster } from '../src/checkout/harborOci.js';
import { ClusterTree } from '../src/vfs/clusters.js';
import { FakeKube, fakeChrisWork, fakeVerifyReach } from '../src/kube/fakeKube.js';
import type { KubeApi } from '../src/kube/kube.js';
import { cluster_run, type ClusterCommandContext } from '../src/commands/cluster.js';
import { options_read, spec_line, type BuildCommandContext } from '../src/commands/build.js';
import { STRATUS_CLUSTER_SIZE_MODEL_KIND, STRATUS_CLUSTER_STATE_EVENT, type ClusterSizeModel, type ClusterSummary, type ClustersModel } from '@fnndsc/menu';

const plain = (text: string | undefined): string => (text ?? '').replace(/\x1b\[[0-9;]*m/g, '');

/** A surface that may start tasks and answers every question as told. */
class GrantedSurface extends HeadlessSurface {
  answers: string[] = [];
  asked: string[] = [];
  constructor(tasks: boolean) {
    super();
    (this.capabilities as { tasks?: boolean }).tasks = tasks;
  }
  override async prompt(request: PromptRequest): Promise<string> {
    this.asked.push(request.message);
    return this.answers.shift() ?? 'n';
  }
}

describe('building a cluster over the fakes', () => {
  let root: string;
  let store: ClusterStore;
  let deps: BuildDeps;
  let runner: JobRunner;
  let surface: GrantedSurface;
  let sink: BufferSink;
  let context: ClusterCommandContext;

  const record_new = (name: string, spec: ClusterSpec = SPEC_DEFAULT): void => {
    store.create({ name, created: '2026-10-22T00:00:00.000Z', region: 'us-ashburn-1', baseDomain: 'fake.example', steps: {}, ids: {} }, spec);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stratus-build-'));
    store = new ClusterStore(join(root, 'clusters'));
    const world: FakeBuildWorld = new FakeBuildWorld(0);
    deps = {
      store, builder: new FakeCloudBuilder(world), installer: new FakeInstaller(world), zones: 3, version: '4.22', pollMs: 0, hostsWaitMs: 1000, installWaitMs: 1000, verifyWaitMs: 0,
      reach: fakeVerifyReach((kubeconfig: string) => world.hosts_now(/cluster-([a-z0-9-]+)/.exec(kubeconfig)?.[1] ?? '').map((host) => ({ name: host.name, zone: host.zone, shape: 'VM.Standard.E5.Flex' }))),
      chris: fakeChrisWork,
    };
    surface = new GrantedSurface(true);
    surface_set(surface);
    runner = new JobRunner(join(root, 'jobs'), [{ id: STEPS_SOURCE, label: 'build steps' }]);
    runner_install(runner);
    sink = new BufferSink();
    sink_set(sink);
    const driver: FakeDriver = new FakeDriver(fakeCloud_sample());
    const clusters: ClusterTree = new ClusterTree({ sources: [], owner: (): string => 'rudolph', now: (): Date => new Date('2026-10-22T12:00:00Z'), store });
    const build: BuildCommandContext = { clusters, store, driver, region: (): string => 'us-ashburn-1', deps, baseDomain: 'fake.example' };
    context = { clusters, driver, region: (): string => 'us-ashburn-1', clustersPath: (): string => '/net/oci/fnndsc/clusters', build };
  });
  afterEach(() => { runner_install(null); surface_set(new HeadlessSurface()); rmSync(root, { recursive: true, force: true }); });

  it('moves the folder clusters were kept in as domains, once, and never over one already there', () => {
    const base: string = mkdtempSync(join(tmpdir(), 'stratus-settle-'));
    try {
      const root: string = join(base, 'stratus', 'clusters');
      expect(clustersRoot_settle(root)).toBe(false);
      mkdirSync(join(base, 'stratus', 'domains', 'harbor'), { recursive: true });
      writeFileSync(join(base, 'stratus', 'domains', 'harbor', 'state.json'), '{}');
      expect(clustersRoot_settle(root)).toBe(true);
      expect(existsSync(join(root, 'harbor', 'state.json'))).toBe(true);
      expect(existsSync(join(base, 'stratus', 'domains'))).toBe(false);
      mkdirSync(join(base, 'stratus', 'domains'));
      expect(clustersRoot_settle(root)).toBe(false);
      expect(existsSync(join(base, 'stratus', 'domains'))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('keeps a cluster on the host: spec, state, secrets, files', () => {
    expect(clustersRoot_derive({ XDG_STATE_HOME: '/s' })).toBe('/s/stratus/clusters');
    record_new('trial');
    expect(store.names_list()).toEqual(['trial']);
    expect(() => record_new('trial')).toThrow('already kept');
    expect(store.spec_read('trial')?.spec).toEqual(SPEC_DEFAULT);
    expect(statSync(join(store.folder_derive('trial'), 'state.json')).mode & 0o777).toBe(0o600);
    store.secret_write('trial', 'kubeconfig', 'secret');
    expect(store.secrets_list('trial')).toEqual([{ name: 'kubeconfig', hostPath: join(store.folder_derive('trial'), 'auth', 'kubeconfig') }]);
    store.file_write('trial', 'plan.json', '{}');
    expect(store.file_read('trial', 'plan.json')).toBe('{}');
    expect(store.file_read('trial', 'nope')).toBeNull();
    expect(store.record_read('nope')).toBeNull();
    expect(store.spec_read('nope')).toBeNull();
    expect(() => store.record_update('nope', () => {})).toThrow('no such cluster');
    expect(new ClusterStore(join(root, 'none')).names_list()).toEqual([]);
  });

  it('runs to the first billing step, then from it once accepted, to the end of the steps it has', async () => {
    record_new('trial');
    const first: JobRecord = await runner.job_start(STEPS_SOURCE, buildJob_id('trial'), 'build trial', buildRun_make('trial', undefined, deps)).finished;
    expect(first.state).toBe('done');
    expect(first.data['stoppedBefore']).toBe('infra-apply');
    expect(stepNext_find(store.record_read('trial') as ClusterRecord)).toBe('infra-apply');
    const planned: InfraPlan = JSON.parse(store.file_read('trial', 'plan.json') as string) as InfraPlan;
    expect(plan_count(planned)).toEqual({ create: 17, replace: 0, change: 0, drift: 0, destroy: 0, replacedKinds: [] });
    store.record_update('trial', (record: ClusterRecord): void => { record.billingAccepted = 'now'; });
    const second: JobRecord = await runner.job_start(STEPS_SOURCE, buildJob_id('trial'), 'build trial', buildRun_make('trial', undefined, deps)).finished;
    expect(second.data['stoppedBefore']).toBeUndefined();
    const record: ClusterRecord = store.record_read('trial') as ClusterRecord;
    expect(stepNext_find(record)).toBeNull();
    expect(record.steps['verify']).toMatchObject({ state: 'done', note: '10 of 10 pass' });
    expect(record.steps['chris-deploy']?.note).toContain('fnndsc/chris 1.0.8 at https://cube.apps.trial.fake.example/api/v1/');
    expect(record.ids['cubeUrl']).toBe('https://cube.apps.trial.fake.example/api/v1/');
    expect(record.steps['smoke']).toMatchObject({ state: 'done', note: 'the smoke journey passes as smoke (fake)' });
    expect(record.steps['run']).toMatchObject({ state: 'done', note: "installed; the kubeconfig and the administrator's password are on the host" });
    expect(record.ids).toMatchObject({ clusterId: 'cluster-trial', infraEnvId: 'infraenv-trial', isoObject: 'trial-discovery.iso' });
    expect(store.secrets_list('trial').map((secret) => secret.name)).toEqual(['chris-test-password', 'iso-link', 'kubeadmin-password', 'kubeconfig']);
    expect(runner.log_read(STEPS_SOURCE, buildJob_id('trial'))).toContain('trial-cp-2 registered');
  });

  it('verifies a new cluster until it settles, and fails it when it never does', async () => {
    record_new('trial');
    store.record_update('trial', (record: ClusterRecord): void => { record.billingAccepted = 'now'; });
    const reach = deps.reach as NonNullable<BuildDeps['reach']>;
    const nodes = [0, 1, 2].map((index: number) => ({ name: `trial-cp-${index}`, zone: `AD-${index + 1}`, shape: 'VM.Standard.E5.Flex' }));
    // The operators are still rolling at the first ask, settled at the second.
    let asks: number = 0;
    const settling = (): KubeApi => {
      const degraded: FakeKube = new FakeKube({ nodes, degraded: ['kube-apiserver'] });
      const healthy: FakeKube = new FakeKube({ nodes });
      return {
        json_get: (path: string) => (path.endsWith('/clusteroperators') && ++asks <= 1 ? degraded : healthy).json_get(path),
        text_get: (path: string) => healthy.text_get(path),
        json_post: (path: string, body: unknown) => healthy.json_post(path, body),
        delete: (path: string) => healthy.delete(path),
      };
    };
    const settles: BuildDeps = { ...deps, verifyWaitMs: 60_000, reach: { ...reach, kube_make: settling } };
    const job: JobRecord = await runner.job_start(STEPS_SOURCE, buildJob_id('trial'), 'build trial', buildRun_make('trial', 'verify', settles)).finished;
    expect(job.state).toBe('done');
    expect(store.record_read('trial')?.steps['verify']).toMatchObject({ state: 'done', note: '10 of 10 pass' });
    expect(runner.log_read(STEPS_SOURCE, buildJob_id('trial'))).toContain('verify: 9 of 10 pass, 1 fail; the cluster may still be settling, asking again: operators: 5 operators, not settled: kube-apiserver');
    // A cluster that never settles fails the step when its time is up.
    store.record_update('trial', (record: ClusterRecord): void => { record.steps['verify'] = { state: 'not done' }; });
    const never: BuildDeps = { ...deps, verifyWaitMs: 0, reach: { ...reach, kube_make: (): KubeApi => new FakeKube({ nodes, degraded: ['etcd'] }) } };
    const failed: JobRecord = await runner.job_start(STEPS_SOURCE, buildJob_id('trial'), 'build trial', buildRun_make('trial', 'verify', never)).finished;
    expect(failed.state).toBe('failed');
    expect(store.record_read('trial')?.steps['verify']).toMatchObject({ state: 'failed', note: '9 of 10 pass, 1 fail after 0 minutes: operators: 5 operators, not settled: etcd' });
  });

  it('stops where it was asked to, and a step already done repeats nothing', async () => {
    record_new('trial');
    const run: JobRecord = await runner.job_start(STEPS_SOURCE, 'a', 'a', buildRun_make('trial', 'cluster', deps)).finished;
    expect(run.data['stoppedBefore']).toBe('iso');
    store.record_update('trial', (record: ClusterRecord): void => { record.steps['cluster'] = { state: 'not done' }; });
    await runner.job_start(STEPS_SOURCE, 'b', 'b', buildRun_make('trial', 'cluster', deps)).finished;
    expect(store.record_read('trial')?.steps['cluster']?.note).toBe('already made: cluster-trial');
  });

  it('fails a step that fails, saying why, and refuses a plan that alters what exists', async () => {
    record_new('trial');
    const refusing: CloudBuilder = Object.assign(Object.create(deps.builder) as CloudBuilder, {
      preflight: async (): Promise<PreflightCheck[]> => [{ name: 'quota', ok: false, note: 'no E5 cores left' }],
    });
    const failed: JobRecord = await runner.job_start(STEPS_SOURCE, 'a', 'a', buildRun_make('trial', undefined, { ...deps, builder: refusing })).finished;
    expect(failed).toMatchObject({ state: 'failed', outcome: 'preflight: preflight: quota: no E5 cores left' });
    expect(store.record_read('trial')?.steps['preflight']?.state).toBe('failed');
    const altering: CloudBuilder = Object.assign(Object.create(deps.builder) as CloudBuilder, {
      infra_plan: async (_r: unknown, _c: BuildCall): Promise<InfraPlan> => ({ ref: 'p', rows: [{ action: 'change', kind: 'instances', name: 'x' }, { action: 'change', kind: 'instances', name: 'y', drift: true }] }),
    });
    const refused: JobRecord = await runner.job_start(STEPS_SOURCE, 'b', 'b', buildRun_make('trial', undefined, { ...deps, builder: altering })).finished;
    expect(refused.outcome).toBe('infra-plan: the plan touches what exists (0 to create, 1 to change and 1 Oracle-Tags drift, 0 to destroy): refused');
    expect(plan_count({ ref: 'p', rows: [{ action: 'change', kind: 'i', name: 'y', drift: true }, { action: 'destroy', kind: 'i', name: 'z' }] })).toEqual({ create: 0, replace: 0, change: 0, drift: 1, destroy: 1, replacedKinds: [] });
    const replacing = plan_count({ ref: 'p', rows: [{ action: 'destroy', kind: 'loadbalancers', name: 'b' }, { action: 'create', kind: 'loadbalancers', name: 'b' }, { action: 'create', kind: 'instances', name: 'n' }] });
    expect(planCounts_words(replacing)).toBe('1 to create, 1 to replace (loadbalancers), 0 to change, 0 to destroy');
    expect(planCounts_alter(replacing)).toBe(true);
  });

  it('a run with no spec, or no cluster, fails saying so', async () => {
    expect((await runner.job_start(STEPS_SOURCE, 'a', 'a', buildRun_make('ghost', undefined, deps)).finished).outcome).toBe('ghost: its spec.yaml does not read');
  });

  it('stops when asked, leaving the step not done', async () => {
    record_new('slow');
    const world: FakeBuildWorld = new FakeBuildWorld(40);
    const slow: BuildDeps = { ...deps, builder: new FakeCloudBuilder(world), installer: new FakeInstaller(world) };
    const { finished } = runner.job_start(STEPS_SOURCE, 'slow', 'slow', buildRun_make('slow', undefined, slow));
    setTimeout(() => runner.job_stop(STEPS_SOURCE, 'slow'), 10);
    expect((await finished).state).toBe('cancelled');
    expect(store.record_read('slow')?.steps['compartment']).toMatchObject({ state: 'not done', note: 'stopped when asked' });
  });

  it('times a host wait and an install out', async () => {
    record_new('stuck');
    store.record_update('stuck', (record: ClusterRecord): void => {
      for (const step of ['preflight', 'cluster', 'iso', 'infra-plan', 'infra-apply', 'dns', 'manifests']) record.steps[step] = { state: 'done' };
      record.ids['clusterId'] = 'cluster-stuck';
      record.ids['infraEnvId'] = 'infraenv-stuck';
    });
    const failed: JobRecord = await runner.job_start(STEPS_SOURCE, 'a', 'a', buildRun_make('stuck', undefined, { ...deps, hostsWaitMs: -1 })).finished;
    expect(failed.outcome).toBe('hosts: 0 of 3 hosts registered, 0 ready, after 0 minutes');
  });

  it('shows a built cluster as every cluster is shown', () => {
    record_new('trial');
    const view = builtCluster_read(store, 'trial');
    expect(view).toMatchObject({ name: 'trial', origin: 'built', cluster: 'trial.fake.example', settings: { CLUSTER_NAME: 'trial', BASE_DOMAIN: 'fake.example' } });
    expect(view?.steps[0]).toEqual({ folder: '01-compartment', name: 'compartment', state: 'not done', evidence: 'not run yet' });
    expect(view?.steps[10]?.evidence).toBe('not run yet');
    expect(builtCluster_read(store, 'nope')).toBeNull();
  });

  it('reads what a spec needs and costs', async () => {
    const driver: FakeDriver = new FakeDriver(fakeCloud_sample());
    const spec: ClusterSpec = (specOptions_apply(SPEC_DEFAULT, new Map([['--workers', '2x8/32']])) as { spec: ClusterSpec }).spec;
    const shape = familyShape_find(await driver.shapes_list('us-ashburn-1'), 'e5');
    const cost = specCost_compute(spec, shape, await driver.prices_list());
    expect(cost?.hourly).toBeCloseTo(40 * 0.015 + 136 * 0.002);
    expect(cost_words(cost!)).toBe('$0.87 an hour (compute and memory (40 vCPU, 136 GiB); volumes and load balancers are not priced yet)');
    expect(cost_words({ hourly: 1, currency: 'EUR', covers: 'x' })).toBe('EUR 1.00 an hour (x)');
    expect(specCost_compute(spec, undefined, [])).toBeNull();
    const fits = await specFit_read(driver, 'us-ashburn-1', 'trial', spec);
    expect(fits[0]).toMatchObject({ zone: 'Uocm:US-ASHBURN-AD-1', nodes: ['trial-cp-0', 'trial-w-0'], coresNeeded: 8, coresFree: 9238, memoryNeeded: 56 });
  });

  it('cluster new writes a spec and nothing else, and refuses what it cannot take', async () => {
    const made: CommandEnvelope = await cluster_run(context, ['new', 'trial', '--workers', '2x8/32', '--data=100']);
    expect(plain(made.rendered)).toContain('trial  trial.fake.example  spec written');
    expect(plain(made.rendered)).toContain('workers 2 × 8 vCPU 32 GiB · ChRIS data 100 GiB');
    expect((await cluster_run(context, ['new', 'trial'])).renderedErr).toBe('cluster new: trial: File exists\n');
    expect((await cluster_run(context, ['new', 'Trial'])).renderedErr).toContain("a cluster's name is a DNS label");
    expect((await cluster_run(context, ['new'])).renderedErr).toContain('usage: cluster new <name>');
    expect((await cluster_run(context, ['new', 'x', '--colour', 'red'])).renderedErr).toContain('--colour: unknown option');
    expect((await cluster_run(context, ['new', 'x', '--workers'])).renderedErr).toContain('--workers takes a value');
    expect((await cluster_run(context, ['new', 'x', '--plane', '2x8/24'])).renderedErr).toContain('the control plane is three nodes');
    const unanchored: ClusterCommandContext = { ...context, build: { ...context.build!, baseDomain: null } };
    expect((await cluster_run(unanchored, ['new', 'y'])).renderedErr).toContain('--base-domain <zone> is needed: the DNS zone the cluster\'s names live under (the tenancy holds no DNS zone to find)');
    const offline: ClusterCommandContext = { ...context, build: { ...context.build!, region: (): null => null } };
    expect((await cluster_run(offline, ['new', 'y'])).renderedErr).toBe('cluster new: not connected\n');
    expect(options_read(['a', '--x=1'], ['--x'])).toEqual({ options: new Map([['--x', '1']]), rest: ['a'] });
    expect(spec_line(SPEC_DEFAULT)).toBe('E5 · plane 3 × 8 vCPU 24 GiB · workers 0 (compact) · ChRIS data 20 GiB');
  });

  it('cluster new and cluster size find the zone where it lives: the tenancy\'s only one, else one named', async () => {
    const world: FakeBuildWorld = new FakeBuildWorld(0);
    world.zones.splice(0, world.zones.length, 'oci.example.org');
    const zoned: ClusterCommandContext = { ...context, build: { ...context.build!, baseDomain: null, builder: new FakeCloudBuilder(world) } };
    expect(plain((await cluster_run(zoned, ['new', 'quay'])).rendered)).toContain('quay  quay.oci.example.org  spec written');
    expect(store.record_read('quay')?.baseDomain).toBe('oci.example.org');
    const sized: ClusterSizeModel = (await cluster_run(zoned, ['size'])).model?.data as ClusterSizeModel;
    expect(sized).toMatchObject({ baseDomain: 'oci.example.org', dnsZones: ['oci.example.org'] });
    expect((await cluster_run(zoned, ['new', 'pier', '--base-domain', 'elsewhere.org'])).renderedErr).toBe('cluster new: --base-domain elsewhere.org: no such zone in the tenancy (oci.example.org)\n');
    world.zones.push('lab.example.org');
    expect((await cluster_run(zoned, ['new', 'pier'])).renderedErr).toContain('(the tenancy holds 2: oci.example.org, lab.example.org)');
    expect((await cluster_run(zoned, ['size'])).model?.data).toMatchObject({ baseDomain: null, dnsZones: ['oci.example.org', 'lab.example.org'] });
    expect(plain((await cluster_run(zoned, ['size'])).rendered)).toContain('names under: none chosen; cluster new --base-domain names one (oci.example.org, lab.example.org)');
    expect(plain((await cluster_run(zoned, ['new', 'pier', '--base-domain', 'lab.example.org'])).rendered)).toContain('pier.lab.example.org');
  });

  it('cluster plan reads only, and says the plan itself needs the tier', async () => {
    record_new('trial');
    surface_set(new GrantedSurface(false));
    const plan: string = plain((await cluster_run(context, ['plan', 'trial'])).rendered);
    expect(plan).toContain('fit, E5 per availability domain (us-ashburn-1):');
    expect(plan).toContain('$0.50 an hour');
    expect(plan).toContain('steps next: compartment');
    expect(plan).toContain('the infrastructure plan needs the tasks tier');
    surface_set(surface);
    expect(plain((await cluster_run(context, ['plan'])).rendered)).toContain('cluster build trial --through infra-plan makes it');
    store.file_write('trial', 'plan.json', JSON.stringify({ ref: 'p', rows: [{ action: 'create', kind: 'i', name: 'a' }, { action: 'change', kind: 'i', name: 'b', drift: true }] }));
    expect(plain((await cluster_run(context, ['plan', 'trial'])).rendered)).toContain('plan  1 to create, 0 to change and 1 Oracle-Tags drift, 0 to destroy');
    expect((await cluster_run(context, ['plan', 'nope'])).renderedErr).toBe('cluster plan: nope: no such cluster\n');
    expect((await cluster_run(context, ['plan', '-x'])).renderedErr).toBe('cluster plan: usage: cluster plan [<name>]\n');
    record_new('other');
    expect((await cluster_run(context, ['plan'])).renderedErr).toBe('cluster plan: which cluster? (other, trial)\n');
  });

  it('cluster build asks before billing, follows the run, and says where it stopped', async () => {
    record_new('trial');
    surface.answers = ['n'];
    const declined: CommandEnvelope = await cluster_run(context, ['build', 'trial']);
    expect(plain(declined.rendered)).toBe('stopped before infra-apply; nothing bills (cluster build trial asks again)\n');
    expect(surface.asked[0]).toBe('infra-apply creates 17 resources. Billing starts at $0.50 an hour (compute and memory (24 vCPU, 72 GiB); volumes and load balancers are not priced yet). Continue? [y/N]');
    expect(sink.text_get()).toContain('infra-plan: done');
    surface.answers = ['y'];
    const built: CommandEnvelope = await cluster_run(context, ['build', 'trial']);
    expect(plain(built.rendered)).toBe('trial: every step done\n');
    expect(store.record_read('trial')?.billingAccepted).toBeDefined();
    expect(plain((await cluster_run(context, ['status', 'trial'])).rendered)).toContain('built here');
  });

  it('cluster build shows its cluster as a state event at each line and before it asks', async () => {
    record_new('trial');
    const shown: Array<{ kind: string; data: ClusterSummary }> = [];
    sink.event_write = (kind: string, data: unknown): void => { shown.push({ kind, data: data as ClusterSummary }); };
    context = { ...context, build: { ...context.build!, clustersPath: (): string => '/net/oci/fnndsc/clusters' } };
    surface.answers = ['n'];
    await cluster_run(context, ['build', 'trial']);
    expect(shown.length).toBeGreaterThan(3);
    expect(shown.every((event) => event.kind === STRATUS_CLUSTER_STATE_EVENT && event.data.name === 'trial' && event.data.resources === null && event.data.cost === undefined)).toBe(true);
    expect(shown.some((event) => event.data.condition === 'BUILDING' && event.data.running?.job === 'trial-build')).toBe(true);
    const asking = shown.find((event) => event.data.condition === 'ASKING');
    expect(asking?.data.asking).toContain('infra-apply creates 17 resources');
    expect(asking?.data.path).toBe('/net/oci/fnndsc/clusters/trial');
    const last: ClusterSummary = (shown.at(-1) as { data: ClusterSummary }).data;
    expect(last.condition).toBe('STOPPED');
    expect(last.asking).toBeNull();
    expect(last.next).toBe('infra-apply');
    expect(last.steps.find((step) => step.name === 'infra-plan')).toMatchObject({ state: 'done', started: expect.any(String), ended: expect.any(String) });
  });

  it('cluster status carries what the controller draws', async () => {
    record_new('trial');
    const before: ClusterSummary = ((await cluster_run(context, ['status', 'trial'])).model?.data as ClustersModel).clusters[0] as ClusterSummary;
    expect(before).toMatchObject({ condition: 'SIZING', billing: false, origin: 'built', protected: true, gone: null, region: 'us-ashburn-1', next: 'compartment', billingStep: 'infra-apply', running: null, plan: null, verify: null, asking: null });
    expect(before.refused).toEqual({ teardown: 'protected (cluster protect trial off lifts it)' });
    expect(before.spec).toEqual(SPEC_DEFAULT);
    expect(before.steps[0]).toEqual({ folder: '01-compartment', state: 'not done', name: 'compartment', evidence: 'not run yet', started: null, ended: null });
    surface.answers = ['y'];
    await cluster_run(context, ['build', 'trial']);
    store.file_write('trial', 'verify.json', JSON.stringify({ at: '2026-10-23T00:00:00.000Z', checks: [{ name: 'API', ok: true, detail: '/readyz ok', how: 'reads' }] }));
    const after: ClusterSummary = ((await cluster_run(context, ['status', 'trial'])).model?.data as ClustersModel).clusters[0] as ClusterSummary;
    expect(after).toMatchObject({ condition: 'SERVING', billing: true, next: null });
    expect(after.plan).toMatchObject({ create: 17, change: 0, drift: 0, destroy: 0, at: expect.any(String) });
    expect(after.verify?.checks).toEqual([{ name: 'API', ok: true, detail: '/readyz ok', how: 'reads' }]);
  });

  it('cluster size reads what a new cluster is sized against, and refuses what it cannot', async () => {
    const sized = await cluster_run(context, ['size']);
    const model: ClusterSizeModel = sized.model?.data as ClusterSizeModel;
    expect(sized.model?.kind).toBe(STRATUS_CLUSTER_SIZE_MODEL_KIND);
    expect(model).toMatchObject({ region: 'us-ashburn-1', family: 'E5', baseDomain: 'fake.example', start: SPEC_DEFAULT });
    expect(model.families).toContain('E5');
    expect(model.zones).toHaveLength(3);
    expect(model.price).toMatchObject({ currency: 'USD' });
    expect(plain(sized.rendered)).toContain('starts from: E5');
    expect((await cluster_run(context, ['size', '--family', 'Z9'])).renderedErr).toContain('Z9: no such family');
    expect((await cluster_run(context, ['size', 'x'])).renderedErr).toBe('cluster size: usage: cluster size [--family <family>]\n');
    expect((await cluster_run({ ...context, build: { ...context.build!, region: (): null => null } }, ['size'])).renderedErr).toBe('cluster size: not connected\n');
  });

  it('cluster build stops where asked, and refuses what it cannot do', async () => {
    record_new('trial');
    expect(plain((await cluster_run(context, ['build', 'trial', '--through', 'cluster'])).rendered)).toBe('trial: done through cluster; next: iso\n');
    expect((await cluster_run(context, ['build', 'trial', '--through', 'nope'])).renderedErr).toContain('--through nope: no such step');
    expect((await cluster_run(context, ['build', 'trial', '--colour'])).renderedErr).toContain('--colour: unknown option');
    expect((await cluster_run(context, ['build', 'a', 'b'])).renderedErr).toContain('usage: cluster build');
    surface_set(new GrantedSurface(false));
    expect((await cluster_run(context, ['build', 'trial'])).renderedErr).toContain('starting a task needs the tasks tier');
    const unbuildable: ClusterCommandContext = { ...context, build: { ...context.build!, deps: null } };
    expect((await cluster_run(unbuildable, ['build', 'trial'])).renderedErr).toContain('build steps are not written yet');
    runner_install(null);
    expect((await cluster_run(context, ['build', 'trial'])).renderedErr).toBe('cluster build: this session runs no tasks\n');
    const noBuild: ClusterCommandContext = { ...context, build: undefined };
    expect((await cluster_run(noBuild, ['new', 'x'])).renderedErr).toBe('cluster: new: this session builds no clusters\n');
  });

  it('cluster build refuses a cluster read from a checkout', async () => {
    const checkout: ClusterTree = new ClusterTree({ sources: [{ name: 'harbor', root: join(root, 'missing') }], owner: (): string => 'r', now: (): Date => new Date(), store });
    const ctx: ClusterCommandContext = { ...context, clusters: checkout, build: { ...context.build!, clusters: checkout } };
    expect((await cluster_run(ctx, ['build', 'harbor'])).renderedErr).toBe('cluster build: harbor: read from a harbor-oci checkout, not built here; adopting it comes with cluster adopt\n');
  });
});

describe("the installer's account", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'stratus-account-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('is kept on the host, mode 600, and never replaced from a question', async () => {
    const { fileAccount_make } = await import('../src/installer/account.js');
    const { serviceAccount_read } = await import('../src/installer/assisted.js');
    const { readFileSync } = await import('node:fs');
    const account = fileAccount_make(join(root, 'ocm', 'service-account.env'));
    expect(account.present()).toBe(false);
    account.keep('abc', 's3');
    expect(account.present()).toBe(true);
    expect(statSync(account.path).mode & 0o777).toBe(0o600);
    expect(serviceAccount_read(readFileSync(account.path, 'utf-8'))).toEqual({ clientId: 'abc', clientSecret: 's3' });
    expect(() => account.keep('x', 'y')).toThrow('is there already');
  });
});

describe('the controller readout', () => {
  const cluster_with = (states: Record<string, string>, origin: 'built' | 'checkout' = 'built'): HarborCluster => ({
    name: 'd', root: '/r', spec: null, settings: {}, state: null, secrets: [], cluster: 'd.example', origin,
    steps: Object.entries(states).map(([name, state], index) => ({ folder: `${index}-${name}`, name, state, evidence: '' })),
  });
  const record_of = (extra: Partial<ClusterRecord> = {}): ClusterRecord => ({ name: 'd', created: '', region: 'r', baseDomain: 'example', steps: {}, ids: {}, ...extra });

  it('says where a cluster stands in one word', () => {
    expect(condition_derive(cluster_with({ run: 'not done' }), record_of(), false, false)).toBe('SIZING');
    expect(condition_derive(cluster_with({ run: 'done' }), record_of(), false, false)).toBe('UP');
    expect(condition_derive(cluster_with({ 'infra-plan': 'done', run: 'not done' }), record_of(), false, false)).toBe('STOPPED');
    expect(condition_derive(cluster_with({ run: 'done', smoke: 'done' }), record_of(), false, false)).toBe('SERVING');
    expect(condition_derive(cluster_with({ run: 'failed' }), record_of(), false, false)).toBe('FAILED');
    expect(condition_derive(cluster_with({ run: 'running' }), record_of(), false, false)).toBe('BUILDING');
    expect(condition_derive(cluster_with({ run: 'failed' }), record_of(), true, false)).toBe('BUILDING');
    expect(condition_derive(cluster_with({ run: 'done' }), record_of(), true, true)).toBe('ASKING');
    expect(condition_derive(cluster_with({ run: 'done' }), record_of({ gone: 'x' }), false, true)).toBe('GONE');
    expect(condition_derive(cluster_with({ run: 'done' }, 'checkout'), null, false, false)).toBe('UP');
  });

  it('names what is refused on each kind of cluster', () => {
    expect(refusals_derive(cluster_with({}, 'checkout'), null)).toEqual({ build: 'read from a harbor-oci checkout, not built here', teardown: 'read from a harbor-oci checkout, not built here' });
    // An adopted cluster is torn down as a built one is: the lock is its only guard.
    expect(refusals_derive(cluster_with({}), record_of({ adopted: { from: '~/h', at: '' } }))).toEqual({ build: 'adopted from ~/h', teardown: 'protected (cluster protect d off lifts it)' });
    expect(refusals_derive(cluster_with({}), record_of({ adopted: { from: '~/h', at: '' }, protected: false }))).toEqual({ build: 'adopted from ~/h' });
    expect(refusals_derive(cluster_with({}), record_of({ gone: 'x' }))).toEqual({ build: 'torn down', teardown: 'already torn down' });
    expect(refusals_derive(cluster_with({}), record_of({ protected: false }))).toEqual({});
  });

  it('names no next step on a cluster not built on here', () => {
    const root: string = mkdtempSync(join(tmpdir(), 'stratus-readout-'));
    const store: ClusterStore = new ClusterStore(root);
    store.create(record_of({ adopted: { from: '~/h', at: '' } }), SPEC_DEFAULT);
    expect(clusterReadout_build(cluster_with({ run: 'done' }), store, undefined).next).toBeNull();
    store.record_update('d', (record: ClusterRecord): void => { delete record.adopted; });
    expect(clusterReadout_build(cluster_with({ run: 'done' }), store, undefined).next).toBe('compartment');
    rmSync(root, { recursive: true, force: true });
  });

  it('groups a plan by action and kind, a replacement once, drift apart', () => {
    const summary = planSummary_build({ ref: 'p', rows: [
      { action: 'create', kind: 'instances', name: 'a' },
      { action: 'create', kind: 'loadbalancers', name: 'lb' },
      { action: 'destroy', kind: 'loadbalancers', name: 'lb' },
      { action: 'change', kind: 'instances', name: 'b', drift: true },
      { action: 'change', kind: 'instances', name: 'c' },
      { action: 'destroy', kind: 'volumes', name: 'v' },
    ] }, null);
    expect(summary).toMatchObject({ create: 1, replace: 1, change: 1, drift: 1, destroy: 1, at: null });
    expect(summary.groups).toEqual([
      { action: 'create', kind: 'instances', count: 1, names: ['a'] },
      { action: 'replace', kind: 'loadbalancers', count: 1, names: ['lb'] },
      { action: 'drift', kind: 'instances', count: 1, names: ['b'] },
      { action: 'change', kind: 'instances', count: 1, names: ['c'] },
      { action: 'destroy', kind: 'volumes', count: 1, names: ['v'] },
    ]);
  });
});
