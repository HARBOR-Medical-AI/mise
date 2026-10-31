/**
 * @file Adopting a cluster harbor-oci built: the checkout read, the cluster kept
 * here, its stack taken into Resource Manager, and plans against it; the plan
 * JSON read with drift counted apart; the OCI builder over recorded answers.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BufferSink, HeadlessSurface, JobRunner, runner_install, sink_set, surface_set, type CommandEnvelope } from '@fnndsc/brasa/core';
import { FakeDriver, fakeCloud_sample } from '../src/cloud/fake/driver.js';
import { FakeBuildWorld, FakeCloudBuilder, FakeInstaller } from '../src/cloud/fake/builder.js';
import type { BuildCall } from '../src/cloud/builder.js';
import { planRows_read, terraformType_kind, update_isDrift } from '../src/cloud/oci/planRead.js';
import { OciBuilder, STACK_RELEASE, stackZip_check } from '../src/cloud/oci/builder.js';
import type { RmApi, RmJobRecord, RmOperation } from '../src/cloud/oci/rmApi.js';
import { checkout_read, variables_stringify } from '../src/cluster/adopt.js';
import { builtSteps_derive } from '../src/cluster/view.js';
import { ClusterStore, type ClusterRecord } from '../src/cluster/state.js';
import { SPEC_DEFAULT } from '../src/cluster/spec.js';
import { STEPS_SOURCE, type BuildDeps } from '../src/cluster/steps.js';
import { ClusterTree } from '../src/vfs/clusters.js';
import { cluster_run, type ClusterCommandContext } from '../src/commands/cluster.js';
import { harborCheckout_make } from './support/harborCheckout.js';

const plain = (text: string | undefined): string => (text ?? '').replace(/\x1b\[[0-9;]*m/g, '');

/** A surface with the tier set as told. */
function surface_with(tasks: boolean): HeadlessSurface {
  const surface: HeadlessSurface = new HeadlessSurface();
  (surface.capabilities as { tasks?: boolean }).tasks = tasks;
  return surface;
}

describe('the plan read from Terraform\'s JSON', () => {
  it('counts creations, real changes, OCI\'s own tags as drift, and a replace as both', () => {
    const tagged = (extra: Record<string, string>) => ({ display_name: 'n', defined_tags: { 'mise.cluster': 'h', ...extra } });
    const rows = planRows_read({
      resource_changes: [
        { address: 'oci_core_instance.cp[0]', type: 'oci_core_instance', change: { actions: ['update'], before: tagged({ 'Oracle-Tags.CreatedBy': 'me' }), after: tagged({}) } },
        { address: 'oci_core_instance.cp[1]', type: 'oci_core_instance', change: { actions: ['update'], before: { display_name: 'a' }, after: { display_name: 'b' } } },
        { address: 'oci_load_balancer_backend.b', type: 'oci_load_balancer_backend', change: { actions: ['delete', 'create'], before: {}, after: {} } },
        { address: 'oci_core_vcn.v', type: 'oci_core_vcn', change: { actions: ['create'], before: null, after: {} } },
        { address: 'oci_core_subnet.s', type: 'oci_core_subnet', change: { actions: ['no-op'] } },
        { type: 'oci_identity_policy', name: 'p', change: { actions: ['read'] } },
      ],
    });
    expect(rows).toEqual([
      { action: 'change', kind: 'instances', name: 'oci_core_instance.cp[0]', drift: true },
      { action: 'change', kind: 'instances', name: 'oci_core_instance.cp[1]' },
      { action: 'destroy', kind: 'loadbalancers', name: 'oci_load_balancer_backend.b' },
      { action: 'create', kind: 'loadbalancers', name: 'oci_load_balancer_backend.b' },
      { action: 'create', kind: 'networks', name: 'oci_core_vcn.v' },
    ]);
    expect(planRows_read(null)).toEqual([]);
    expect(terraformType_kind('oci_dns_rrset')).toBe('dns');
    expect(terraformType_kind('oci_identity_policy')).toBe('oci_identity_policy');
    expect(update_isDrift(null, {})).toBe(false);
    expect(update_isDrift({ a: 1 }, { a: 1 })).toBe(false);
    expect(update_isDrift({ defined_tags: { 'mise.x': '1' } }, { defined_tags: { 'mise.x': '2' } })).toBe(false);
  });
});

/** A Resource Manager that answers from a script. */
class RecordedRm implements RmApi {
  calls: string[] = [];
  states: string[] = ['IN_PROGRESS', 'SUCCEEDED'];
  failure?: string;
  plan: unknown = { resource_changes: [] };
  async stack_create(request: { compartmentId: string; displayName: string; zipBase64: string; variables: Record<string, string>; tags: Record<string, string> }) {
    this.calls.push(`stack_create ${request.compartmentId} ${JSON.stringify(request.tags)} ${Object.keys(request.variables).length}`);
    return { id: 'ocid1.ormstack.1', displayName: request.displayName, state: 'ACTIVE', compartmentId: request.compartmentId, variables: request.variables };
  }
  async stack_update(): Promise<void> { this.calls.push('stack_update'); }
  variables: Record<string, string> = {};
  async stack_get(stackId: string) { return { id: stackId, displayName: 's', state: 'ACTIVE', compartmentId: 'c', variables: this.variables }; }
  tagged: Array<{ id: string; displayName: string; state: string; compartmentId: string; variables: Record<string, string>; tagValue: string }> = [];
  async stacks_tagged() { return this.tagged; }
  async job_create(stackId: string, operation: RmOperation): Promise<RmJobRecord> {
    this.calls.push(`job_create ${stackId} ${operation.kind}`);
    return { id: `job-${operation.kind}`, state: 'ACCEPTED' };
  }
  async job_get(jobId: string): Promise<RmJobRecord> {
    const state: string = this.states.shift() ?? 'SUCCEEDED';
    return { id: jobId, state, ...(this.failure !== undefined && state === 'FAILED' ? { failure: this.failure } : {}) };
  }
  async job_cancel(jobId: string): Promise<void> { this.calls.push(`job_cancel ${jobId}`); }
  async jobLog_read(): Promise<string[]> { return ['Terraform init', 'Terraform plan']; }
  async jobPlan_read(): Promise<unknown> { return this.plan; }
  async jobOutputs_read(): Promise<Record<string, string>> { return {}; }
  async stackResources_count(): Promise<number> { return 0; }
  async stack_delete(stackId: string): Promise<void> { this.calls.push(`stack_delete ${stackId}`); }
}

describe('the OCI builder over Resource Manager', () => {
  const zip: Buffer = Buffer.from('a zip');
  let rm: RecordedRm;
  let builder: OciBuilder;
  let logged: string[];
  const call = (signal: AbortSignal = new AbortController().signal): BuildCall => ({ log: (line: string): void => { logged.push(line); }, signal });

  beforeEach(() => {
    rm = new RecordedRm();
    logged = [];
    builder = new OciBuilder({ rm: (): RmApi => rm, zip_fetch: async (): Promise<Buffer> => zip, pollMs: 0 });
  });

  it('checks the stack zip against the pinned digest', () => {
    expect(() => stackZip_check(zip)).toThrow(`is not the pinned ${STACK_RELEASE.sha256}`);
  });

  it('adopts: a stack tagged with the cluster, its state imported, its log followed', async () => {
    const stack: string = await builder.stack_adopt({ cluster: 'harbor', region: 'r', compartmentId: 'ocid1.compartment.c', variables: { a: '1' }, state: Buffer.from('{}'), stackVersion: 'v1.6.1' }, call());
    expect(stack).toBe('ocid1.ormstack.1');
    expect(rm.calls).toEqual(['stack_create ocid1.compartment.c {"mise-cluster":"harbor"} 1', 'job_create ocid1.ormstack.1 import']);
    expect(logged).toEqual(expect.arrayContaining(['Resource Manager import job job-import', 'Terraform init', 'Terraform plan']));
    await expect(builder.stack_adopt({ cluster: 'h', region: 'r', compartmentId: 'c', variables: {}, state: Buffer.from(''), stackVersion: 'v1.5.0' }, call())).rejects.toThrow('built with oci-openshift v1.5.0; stratus builds with v1.6.1');
  });

  it('takes a stack already tagged with the cluster as its own, and refuses two', async () => {
    rm.tagged = [{ id: 'ocid1.ormstack.old', displayName: 'h', state: 'ACTIVE', compartmentId: 'c', variables: {}, tagValue: 'harbor' }, { id: 'ocid1.ormstack.other', displayName: 'o', state: 'ACTIVE', compartmentId: 'c', variables: {}, tagValue: 'other' }];
    const request = { cluster: 'harbor', region: 'r', compartmentId: 'c', variables: {}, state: Buffer.from('{}'), stackVersion: 'v1.6.1' };
    expect(await builder.stack_adopt(request, call())).toBe('ocid1.ormstack.old');
    expect(rm.calls).toEqual([]);
    rm.tagged.push({ id: 'ocid1.ormstack.twin', displayName: 'h', state: 'ACTIVE', compartmentId: 'c', variables: {}, tagValue: 'harbor' });
    await expect(builder.stack_adopt(request, call())).rejects.toThrow('2 stacks in c are tagged mise-cluster=harbor');
  });

  it('plans against a stack and reads the plan back; a new stack needs what it is made from', async () => {
    rm.plan = { resource_changes: [{ address: 'x', type: 'oci_core_instance', change: { actions: ['create'] } }] };
    const plan = await builder.infra_plan({ cluster: 'h', spec: SPEC_DEFAULT, region: 'r', isoObject: '', stackRef: 'ocid1.ormstack.1' }, call());
    expect(plan).toEqual({ ref: 'job-plan', rows: [{ action: 'create', kind: 'instances', name: 'x' }] });
    await expect(builder.infra_plan({ cluster: 'h', spec: SPEC_DEFAULT, region: 'r', isoObject: '' }, call())).rejects.toThrow("a new stack needs the compartment, the zone and the image's link");
    await expect(builder.preflight({ cluster: 'h', spec: SPEC_DEFAULT, region: 'r', baseDomain: 'b', compartmentId: 'c' }, call())).rejects.toThrow('this builder adopts and re-plans only');
  });

  it('never fails a job for a log read that failed while the job wrote it', async () => {
    let reads: number = 0;
    rm.jobLog_read = async (): Promise<string[]> => { reads++; if (reads === 1) throw new Error('invalid pagination token'); return ['line one', 'line two']; };
    rm.states = ['IN_PROGRESS', 'SUCCEEDED'];
    const plan = await builder.infra_plan({ cluster: 'h', spec: SPEC_DEFAULT, region: 'r', isoObject: '', stackRef: 's' }, call());
    expect(plan.ref).toBe('job-plan');
    expect(logged.filter((line: string): boolean => line.startsWith('line'))).toEqual(['line one', 'line two']);
  });

  it('says how a job failed, and passes a stop on as a cancel never forced', async () => {
    rm.states = ['FAILED'];
    rm.failure = 'quota exceeded';
    await expect(builder.infra_plan({ cluster: 'h', spec: SPEC_DEFAULT, region: 'r', isoObject: '', stackRef: 's' }, call())).rejects.toThrow('Resource Manager plan job job-plan: FAILED: quota exceeded');
    rm.states = ['IN_PROGRESS', 'CANCELING', 'CANCELED'];
    const controller: AbortController = new AbortController();
    controller.abort();
    await expect(builder.infra_plan({ cluster: 'h', spec: SPEC_DEFAULT, region: 'r', isoObject: '', stackRef: 's' }, call(controller.signal))).rejects.toThrow('CANCELED');
    expect(rm.calls.filter((entry: string): boolean => entry.startsWith('job_cancel'))).toEqual(['job_cancel job-plan']);
  });
});

describe('adopting a cluster', () => {
  let root: string;
  let checkout: string;
  let store: ClusterStore;
  let context: ClusterCommandContext;
  let runner: JobRunner;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stratus-adopt-'));
    checkout = harborCheckout_make();
    appendFileSync(join(checkout, 'config.env'), 'OCI_STACK_VERSION=v1.6.1\n');
    writeFileSync(join(checkout, 'state', 'stack', 'oci-openshift-1.6.1', 'terraform-stacks', 'create-cluster', 'harbor.auto.tfvars.json'), JSON.stringify({ cluster_name: 'harbor', control_plane_count: 3, create_public_dns: false }));
    store = new ClusterStore(join(root, 'clusters'));
    const world: FakeBuildWorld = new FakeBuildWorld(0);
    const builder: FakeCloudBuilder = new FakeCloudBuilder(world);
    const deps: BuildDeps = { store, builder, installer: new FakeInstaller(world), zones: 3, version: '4.22', pollMs: 0, hostsWaitMs: 1000, installWaitMs: 1000 };
    const clusters: ClusterTree = new ClusterTree({ sources: [{ name: 'harbor', root: checkout }], owner: (): string => 'r', now: (): Date => new Date(), store });
    const driver: FakeDriver = new FakeDriver(fakeCloud_sample());
    context = { clusters, driver, region: (): string => 'us-ashburn-1', clustersPath: (): string => '/net/oci/fnndsc/clusters', build: { clusters, store, driver, region: (): string => 'us-ashburn-1', deps, builder, baseDomain: 'fake.example' } };
    runner = new JobRunner(join(root, 'jobs'), [{ id: STEPS_SOURCE, label: 'build steps' }]);
    runner_install(runner);
    sink_set(new BufferSink());
  });
  afterEach(() => { runner_install(null); surface_set(new HeadlessSurface()); rmSync(root, { recursive: true, force: true }); rmSync(checkout, { recursive: true, force: true }); });

  it('reads what adoption needs, or says why a checkout cannot be adopted', () => {
    const read = checkout_read('harbor', checkout, new Date('2026-10-22T12:00:00Z'));
    if ('error' in read) throw new Error(read.error);
    expect(read.record).toMatchObject({ name: 'harbor', region: 'us-ashburn-1', baseDomain: 'oci.chrisproject.org', compartmentId: 'ocid1.compartment.oc1..harbor', ids: { clusterId: 'cluster-1', infraEnvId: 'infra-1', isoObject: 'harbor-discovery.iso' }, adopted: { from: checkout } });
    expect(read.record.steps['run']?.state).toBe('done');
    expect(read.record.steps['postinstall']).toEqual({ state: 'done', note: 'nothing to do after the install on this cloud' });
    // It keeps no record of ChRIS: none of its steps is carried without the evidence.
    expect(read.record.steps['chris-deploy']).toBeUndefined();
    // It came with its compartment; one adopted before that step existed reads the same.
    expect(read.record.steps['compartment']).toEqual({ state: 'done', note: 'its own compartment, made before adoption' });
    const { compartment: _kept, ...older } = read.record.steps;
    expect(builtSteps_derive({ ...read.record, steps: older })[0]).toEqual({ folder: '01-compartment', name: 'compartment', state: 'done', evidence: 'its own compartment, made before adoption' });
    expect(builtSteps_derive({ ...read.record, steps: older, adopted: undefined })[0]?.state).toBe('not done');
    expect(read.variables).toEqual({ cluster_name: 'harbor', control_plane_count: '3', create_public_dns: 'false' });
    expect(read.stackVersion).toBe('v1.6.1');
    expect(read.secrets.map((secret) => secret.name)).toEqual(['kubeadmin-password', 'kubeconfig']);
    expect(variables_stringify({ a: [1] })).toEqual({ a: '[1]' });
    expect(checkout_read('x', root, new Date())).toEqual({ error: `${root}: not a harbor-oci checkout (no config.env)` });
    expect(checkout_read('x', harborCheckout_make({ state: false }), new Date())).toMatchObject({ error: expect.stringContaining('nothing was built from it') });
    expect(checkout_read('x', harborCheckout_make({ stack: 'planned' }), new Date())).toMatchObject({ error: expect.stringContaining('infra-apply was never run') });
    expect(checkout_read('x', harborCheckout_make({ stack: false }), new Date())).toMatchObject({ error: expect.stringContaining('names no stackDir') });
  });

  it('without the tier keeps the cluster here and says the stack needs the tier; with it, takes the stack in', async () => {
    surface_set(surface_with(false));
    const kept: CommandEnvelope = await cluster_run(context, ['adopt', 'harbor', '--from', checkout]);
    expect(plain(kept.rendered)).toContain('adopted from');
    expect(plain(kept.rendered)).toContain('its stack and Terraform state go to Resource Manager with the tasks tier');
    expect(statSync(join(store.folder_derive('harbor'), 'auth', 'kubeconfig')).mode & 0o777).toBe(0o600);
    expect(plain((await cluster_run(context, ['status', 'harbor'])).rendered)).toContain('adopted');
    expect(plain((await cluster_run(context, ['plan', 'harbor'])).rendered)).toContain('is not in Resource Manager yet');
    surface_set(surface_with(true));
    const taken: CommandEnvelope = await cluster_run(context, ['adopt', 'harbor', '--from', checkout]);
    expect(plain(taken.rendered)).toMatch(/^harbor: adopted; its stack is fake-stack-\d+/);
    expect(plain((await cluster_run(context, ['adopt', 'harbor', '--from', checkout])).rendered)).toContain('already adopted');
    // Its ChRIS, seeded and smoked by harbor-oci after adoption here, is caught up by adopting again.
    mkdirSync(join(checkout, 'state', 'auth'), { recursive: true });
    writeFileSync(join(checkout, 'state', 'auth', 'chris-test-user-password'), 'pw\n');
    writeFileSync(join(checkout, 'state', 'smoke.log'), 'SMOKE PASS (23s)\n{"verdict": "pass", "duration_s": 22.9, "steps": [{"name": "a", "ok": true}]}\n');
    const caught: string = plain((await cluster_run(context, ['adopt', 'harbor', '--from', checkout])).rendered);
    expect(caught).toContain(`harbor: caught up from ${checkout}: chris-deploy, chris-seed, smoke`);
    expect(store.record_read('harbor')?.steps['smoke']).toEqual({ state: 'done', note: 'done before adoption (harbor-oci: pass · 1 step · 23 s)' });
    expect(plain((await cluster_run(context, ['adopt', 'harbor', '--from', checkout])).rendered)).not.toContain('caught up');
    const plan: string = plain((await cluster_run(context, ['plan', 'harbor'])).rendered);
    expect(plan).toContain('plan  0 to create, 0 to change and 3 Oracle-Tags drift, 0 to destroy');
    expect(plan).toContain('planned against, never built on');
    expect((await cluster_run(context, ['build', 'harbor'])).renderedErr).toContain('adopted from');
    expect((store.record_read('harbor') as ClusterRecord).ids['stackRef']).toMatch(/^fake-stack-/);
  });

  it('refuses what it cannot adopt', async () => {
    expect((await cluster_run(context, ['adopt', 'harbor'])).renderedErr).toContain('nothing in the tenancy is tagged mise-cluster=harbor; a harbor-oci checkout adopts with --from');
    expect((await cluster_run(context, ['adopt'])).renderedErr).toContain('usage: cluster adopt');
    expect((await cluster_run(context, ['adopt', 'Harbor', '--from', checkout])).renderedErr).toContain('DNS label');
    expect((await cluster_run(context, ['adopt', 'harbor', '--from', root])).renderedErr).toContain('not a harbor-oci checkout');
    expect((await cluster_run(context, ['adopt', 'harbor', '--colour', 'x'])).renderedErr).toContain('--colour: unknown option');
    store.create({ name: 'mine', created: 'now', region: 'r', baseDomain: 'b', steps: {}, ids: {} }, SPEC_DEFAULT);
    expect((await cluster_run(context, ['adopt', 'mine', '--from', checkout])).renderedErr).toBe('cluster adopt: mine: a cluster of that name was built here\n');
    surface_set(surface_with(true));
    const noBuilder: ClusterCommandContext = { ...context, build: { ...context.build!, builder: null } };
    expect((await cluster_run(noBuilder, ['adopt', 'other', '--from', checkout])).renderedErr).toContain('this cloud cannot take a stack in yet');
  });
});
