/**
 * @file The tenancy is the truth about its clusters (docs/stratus.adoc, D15):
 * a session lists what the tenancy holds by the `mise-cluster` tag, a found
 * cluster answers reads and `adopt` only, and `cluster adopt <name>` with no
 * checkout keeps it here from what its stack says.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDriver, fakeCloud_sample, type FakeCloud, type FakeStack } from '../src/cloud/fake/driver.js';
import { FakeBuildWorld, FakeCloudBuilder, FakeInstaller } from '../src/cloud/fake/builder.js';
import type { CloudContainer, CloudDriver, FoundCluster } from '../src/cloud/driver.js';
import { foundClusters_fold, tagQuery_format } from '../src/cloud/oci/resourceMap.js';
import type { OciSearchRecord } from '../src/cloud/oci/resourceApi.js';
import { stackSpec_derive, stackVariables_build } from '../src/cloud/oci/stackVars.js';
import { ClusterStore, CLUSTER_TAG, type ClusterRecord } from '../src/cluster/state.js';
import { SPEC_DEFAULT, type ClusterSpec } from '../src/cluster/spec.js';
import type { BuildDeps } from '../src/cluster/steps.js';
import { ClusterTree } from '../src/vfs/clusters.js';
import { BufferSink, HeadlessSurface, JobRunner, runner_install, sink_set, surface_set } from '@fnndsc/brasa/core';
import { STEPS_SOURCE } from '../src/cluster/steps.js';
import { foundCluster_describe } from '../src/cluster/found.js';
import { cluster_run, foundCluster_make, type ClusterCommandContext } from '../src/commands/cluster.js';

const REGION: string = 'us-ashburn-1';
const QUAY_COMPARTMENT: string = 'ocid1.compartment.oc1..quay';
const QUAY_STACK: string = 'ocid1.ormstack.oc1..quay';
const ANSI: RegExp = /\u001b\[[0-9;]*m/g;

/** A compartment carrying the cluster tag. */
function compartment_make(name: string, id: string, state: string = 'active'): CloudContainer {
  return { name, id, parentId: 'ocid1.tenancy.oc1..root', state, created: '2026-10-23T19:00:00.000Z', description: `${name}'s compartment`, tags: { [CLUSTER_TAG]: name }, noun: 'compartment' };
}

/** A stack carrying the cluster tag. */
function stack_make(name: string, id: string, compartmentId: string, state: string = 'active', region: string = REGION): FakeStack {
  return { id, displayName: `${name} · a Trusted Domain`, compartmentId, state, region, tags: { [CLUSTER_TAG]: name } };
}

/** The sample cloud with quay's compartment and stack in it, tagged. */
function cloud_make(extra: Partial<FakeCloud> = {}): FakeCloud {
  const sample: FakeCloud = fakeCloud_sample();
  return { ...sample, containers: [...sample.containers, compartment_make('quay', QUAY_COMPARTMENT)], stacks: [stack_make('quay', QUAY_STACK, QUAY_COMPARTMENT)], ...extra };
}

describe('finding clusters by their tag', () => {
  it('the fake cloud folds a tagged stack and compartment into one cluster, sorted, the gone and the other region left out', async () => {
    const driver = new FakeDriver(cloud_make({
      containers: [...fakeCloud_sample().containers, compartment_make('quay', QUAY_COMPARTMENT), compartment_make('old', 'ocid1.compartment.oc1..old', 'deleted'), compartment_make('alpha', 'ocid1.compartment.oc1..alpha')],
      stacks: [stack_make('quay', QUAY_STACK, QUAY_COMPARTMENT), stack_make('old', 'ocid1.ormstack.oc1..old', 'ocid1.compartment.oc1..old', 'deleted'), stack_make('far', 'ocid1.ormstack.oc1..far', 'c', 'active', 'eu-frankfurt-1')],
    }));
    const found: FoundCluster[] = await driver.clusters_find(CLUSTER_TAG, REGION);
    expect(found.map((cluster: FoundCluster): string => cluster.name)).toEqual(['alpha', 'quay']);
    expect(found[1]).toEqual({ name: 'quay', stack: { id: QUAY_STACK, state: 'active', compartmentId: QUAY_COMPARTMENT }, compartmentId: QUAY_COMPARTMENT, region: REGION });
    expect(found[0]?.stack).toBeNull();
  });

  it('the OCI search asks for every stack and compartment carrying the tag, and folds the hits the same way', () => {
    expect(tagQuery_format(CLUSTER_TAG)).toBe("query ormstack, compartment resources where freeformTags.key = 'mise-cluster'");
    const hit = (resourceType: string, identifier: string, compartmentId: string, name: string, lifecycleState: string = 'ACTIVE'): OciSearchRecord => ({ resourceType, lifecycleState, identifier, displayName: name, compartmentId, freeformTags: { [CLUSTER_TAG]: name } });
    const folded: FoundCluster[] = foundClusters_fold([
      hit('OrmStack', QUAY_STACK, QUAY_COMPARTMENT, 'quay'),
      hit('Compartment', QUAY_COMPARTMENT, 'ocid1.tenancy.oc1..root', 'quay'),
      hit('Compartment', 'ocid1.compartment.oc1..harbor', 'ocid1.tenancy.oc1..root', 'harbor'),
      hit('OrmStack', 'ocid1.ormstack.oc1..gone', 'c', 'gone', 'DELETED'),
      { resourceType: 'Instance', lifecycleState: 'RUNNING', identifier: 'i', displayName: 'i', compartmentId: 'c', freeformTags: {} },
    ], CLUSTER_TAG, REGION);
    expect(folded).toEqual([
      { name: 'harbor', stack: null, compartmentId: 'ocid1.compartment.oc1..harbor', region: REGION },
      { name: 'quay', stack: { id: QUAY_STACK, state: 'active', compartmentId: QUAY_COMPARTMENT }, compartmentId: QUAY_COMPARTMENT, region: REGION },
    ]);
  });

  it('a found cluster reads as one before the cloud is asked more: no spec, no steps, its compartment the tagged one else the stack\'s', () => {
    const cluster = foundCluster_make({ name: 'quay', stack: { id: QUAY_STACK, state: 'active', compartmentId: 'ocid1.compartment.oc1..other' }, compartmentId: null, region: REGION });
    expect(cluster.origin).toBe('found');
    expect(cluster.steps).toEqual([]);
    expect(cluster.settings['OCI_COMPARTMENT_OCID']).toBe('ocid1.compartment.oc1..other');
    expect(cluster.root).toBe(QUAY_STACK);
    expect(cluster.found?.condition).toBe('STOPPED');
  });

  it('described from the cloud, a found cluster has its address and spec from its stack, and its condition from what lives and what the stack holds', async () => {
    const world: FakeBuildWorld = new FakeBuildWorld(0);
    const builder: FakeCloudBuilder = new FakeCloudBuilder(world);
    const spec: ClusterSpec = { ...SPEC_DEFAULT, workers: { count: 2, vcpu: 8, ramGib: 32, bootGib: 120, bootTier: 'balanced' } };
    world.stacks.set(QUAY_STACK, { state: 'active', compartmentId: QUAY_COMPARTMENT, baseDomain: 'oci.example.org', spec });
    const found: FoundCluster = { name: 'quay', stack: { id: QUAY_STACK, state: 'active', compartmentId: QUAY_COMPARTMENT }, compartmentId: QUAY_COMPARTMENT, region: REGION };
    // Nothing lives, the stack still holds 17 resources: STOPPED, half built.
    const stopped = await foundCluster_describe(found, new FakeDriver(cloud_make()), builder);
    expect(stopped.cluster).toBe('quay.oci.example.org');
    expect(stopped.settings['BASE_DOMAIN']).toBe('oci.example.org');
    expect(stopped.found).toMatchObject({ baseDomain: 'oci.example.org', spec, stackResources: 17, condition: 'STOPPED' });
    expect(stopped.steps.map((step) => [step.name, step.state])).toEqual([['compartment', 'done'], ...['preflight', 'cluster', 'iso', 'infra-plan', 'infra-apply', 'dns', 'manifests', 'hosts', 'run', 'postinstall', 'verify', 'chris-deploy', 'chris-seed', 'smoke'].map((name) => [name, 'unknown'])]);
    // The stack emptied by an earlier teardown: GONE, every step not done.
    world.stackResources.set(QUAY_STACK, 0);
    const gone = await foundCluster_describe(found, new FakeDriver(cloud_make()), builder);
    expect(gone.found?.condition).toBe('GONE');
    expect(gone.steps.every((step) => step.state === (step.name === 'compartment' ? 'done' : 'not done'))).toBe(true);
    // Machines live: UP, the apply attested by them.
    const live = new FakeDriver(cloud_make({ resources: [...fakeCloud_sample().resources, { kind: 'instances', containerId: QUAY_COMPARTMENT, record: { name: 'quay-cp-0', id: 'ocid1.instance.1', state: 'running', region: REGION, created: '', tags: {}, raw: {}, shape: 'VM.Standard.E5.Flex', zone: 'AD-1', ips: [] } } as never] }));
    const up = await foundCluster_describe(found, live, builder);
    expect(up.found?.condition).toBe('UP');
    expect(up.steps.find((step) => step.name === 'infra-apply')).toMatchObject({ state: 'done', evidence: '1 instance live in its compartment' });
    // No stack, only a compartment: the tenancy's one zone names it; nothing live and no stack is GONE.
    const alone = await foundCluster_describe({ name: 'alpha', stack: null, compartmentId: 'ocid1.compartment.oc1..alpha', region: REGION }, new FakeDriver(cloud_make()), builder);
    expect(alone.cluster).toBe('alpha.fake.example');
    expect(alone.found?.condition).toBe('GONE');
    // A stack that cannot be read, or no builder at all, still shows the cluster.
    const unread = await foundCluster_describe(found, new FakeDriver(cloud_make()), null);
    expect(unread.cluster).toBeNull();
    expect(unread.found?.condition).toBe('STOPPED');
  });

  it('a stack\'s variables read back into the spec and zone they were built from', () => {
    const spec: ClusterSpec = { ...SPEC_DEFAULT, workers: { count: 2, vcpu: 8, ramGib: 32, bootGib: 120, bootTier: 'balanced' } };
    const variables: Record<string, string> = stackVariables_build({ cluster: 'quay', spec, tenancyId: 't', compartmentId: QUAY_COMPARTMENT, region: REGION, baseDomain: 'oci.example.org', isoLink: 'https://x', sshPublicKey: 'ssh-ed25519 k' });
    expect(stackSpec_derive(variables)).toEqual({ spec, baseDomain: 'oci.example.org' });
    expect(stackSpec_derive({ zone_dns: 'z' })).toEqual({ spec: null, baseDomain: 'z' });
  });
});

describe('a session over a tenancy holding a cluster it keeps nothing of', () => {
  let root: string;
  let store: ClusterStore;
  let world: FakeBuildWorld;
  let builder: FakeCloudBuilder;
  let context: ClusterCommandContext;

  /** The session over a driver. */
  function context_make(driver: CloudDriver): ClusterCommandContext {
    const clusters: ClusterTree = new ClusterTree({ sources: [], owner: (): string => 'rudolph', now: (): Date => new Date('2026-10-26T20:00:00.000Z'), store });
    const deps: BuildDeps = { store, builder, installer: new FakeInstaller(world), zones: 3, version: '4.22', pollMs: 0, hostsWaitMs: 1000, installWaitMs: 1000 };
    return { clusters, driver, region: (): string => REGION, clustersPath: (): string => '/net/oci/fnndsc/clusters', build: { clusters, store, driver, region: (): string => REGION, deps, builder, baseDomain: 'fake.example' } };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stratus-found-'));
    store = new ClusterStore(root);
    world = new FakeBuildWorld(0);
    builder = new FakeCloudBuilder(world);
    context = context_make(new FakeDriver(cloud_make()));
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('cluster status lists it as found, not adopted, STOPPED while nothing lives in its compartment and its stack holds something, with what the cloud says of it', async () => {
    world.stacks.set(QUAY_STACK, { state: 'active', compartmentId: QUAY_COMPARTMENT, baseDomain: 'oci.example.org', spec: SPEC_DEFAULT });
    const answer = await cluster_run(context, []);
    const text: string = answer.rendered.replace(ANSI, '');
    expect(text).toContain('quay  quay.oci.example.org');
    expect(text).toContain(`found        stack ${QUAY_STACK} (active), compartment ${QUAY_COMPARTMENT}; not adopted: cluster adopt quay keeps it here`);
    expect(text).toMatch(/01-compartment\s+done\s+found ocid1\.compartment\.oc1\.\.quay/);
    expect(text).toContain('the cloud does not say; adopt it and verify to know');
    const model = answer.model?.data as { clusters: Array<{ name: string; origin?: string; condition?: string; cluster?: string | null; spec?: unknown; refused?: Record<string, string>; steps: unknown[] }> };
    expect(model.clusters.map((cluster) => [cluster.name, cluster.origin, cluster.condition, cluster.cluster])).toEqual([['quay', 'found', 'STOPPED', 'quay.oci.example.org']]);
    expect(model.clusters[0]?.spec).toEqual(SPEC_DEFAULT);
    expect(model.clusters[0]?.steps).toHaveLength(15);
    expect(model.clusters[0]?.refused?.['build']).toBe('found in the tenancy, not adopted: cluster adopt quay first');
    expect((await cluster_run(context, ['quay'])).rendered).toBe(answer.rendered);
  });

  it('a found cluster is refused the build verbs by name, and the status says when the tenancy was not searched', async () => {
    expect((await cluster_run(context, ['plan', 'quay'])).renderedErr).toBe('cluster plan: quay: found in the tenancy, not adopted: cluster adopt quay first\n');
    expect((await cluster_run(context, ['teardown', 'quay'])).renderedErr).toBe('cluster teardown: quay: found in the tenancy, not adopted: cluster adopt quay first\n');
    const failing = new FakeDriver(cloud_make());
    failing.clusters_find = async (): Promise<FoundCluster[]> => { throw new Error('search refused'); };
    const unsearched = await cluster_run(context_make(failing), []);
    expect(unsearched.rendered.replace(ANSI, '')).toContain('no clusters here (the tenancy was not searched: search refused)');
  });

  it('a found cluster with nothing left but its tag reads GONE, refuses the build verbs, and cluster teardown removes the tag\'s carriers without an adoption', async () => {
    world.stacks.set(QUAY_STACK, { state: 'active', compartmentId: QUAY_COMPARTMENT, baseDomain: 'oci.example.org', spec: null });
    world.stackResources.set(QUAY_STACK, 0);
    world.compartments.set('quay', QUAY_COMPARTMENT);
    const status = await cluster_run(context, ['quay']);
    expect(status.rendered.replace(ANSI, '')).toContain('nothing of it is left but its tag: cluster teardown quay removes that');
    const model = status.model?.data as { clusters: Array<{ condition?: string; billing?: boolean; refused?: Record<string, string> }> };
    expect(model.clusters[0]?.condition).toBe('GONE');
    expect(model.clusters[0]?.billing).toBe(false);
    expect(model.clusters[0]?.refused).toEqual({ plan: 'nothing of it is left in the tenancy but its tag: cluster teardown quay removes that', verify: 'nothing of it is left in the tenancy but its tag: cluster teardown quay removes that', build: 'nothing of it is left in the tenancy but its tag: cluster teardown quay removes that' });
    expect((await cluster_run(context, ['plan', 'quay'])).renderedErr).toBe('cluster plan: quay: nothing of it is left in the tenancy but its tag: cluster teardown quay removes that\n');
    // Without the tasks tier nothing changes.
    const surface: HeadlessSurface & { answer: string } = Object.assign(new HeadlessSurface(), { answer: 'quay' });
    surface.prompt = async (): Promise<string> => surface.answer;
    surface_set(surface);
    sink_set(new BufferSink());
    expect((await cluster_run(context, ['teardown', 'quay'])).renderedErr).toBe('cluster teardown: quay: Operation not permitted: tearing down needs the tasks tier\n');
    expect(store.record_read('quay')).toBeNull();
    (surface.capabilities as { tasks?: boolean }).tasks = true;
    runner_install(new JobRunner(join(root, 'jobs'), [{ id: STEPS_SOURCE, label: 'steps' }]));
    expect((await cluster_run(context, ['teardown', 'quay'])).rendered.replace(ANSI, '')).toBe('quay: torn down\n');
    expect(world.removed).toEqual(['3 DNS records', 'the stack itself', 'the compartment clusters/quay']);
    const record: ClusterRecord | null = store.record_read('quay');
    expect(record?.adopted?.from).toBe('the tenancy');
    expect(record?.protected).toBe(false);
    expect(record?.gone).toBeDefined();
    expect(world.stacks.has(QUAY_STACK)).toBe(false);
  });

  it('cluster adopt <name> with no checkout keeps the found cluster here from what its stack says, and the build verbs then answer', async () => {
    const spec: ClusterSpec = { ...SPEC_DEFAULT, workers: { count: 2, vcpu: 8, ramGib: 32, bootGib: 120, bootTier: 'balanced' } };
    world.stacks.set(QUAY_STACK, { state: 'active', compartmentId: QUAY_COMPARTMENT, baseDomain: 'oci.example.org', spec });
    const adopted = await cluster_run(context, ['adopt', 'quay']);
    expect(adopted.renderedErr ?? '').toBe('');
    const text: string = adopted.rendered.replace(ANSI, '');
    expect(text).toContain(`quay  adopted from the tenancy: stack ${QUAY_STACK} (active), compartment ${QUAY_COMPARTMENT}`);
    expect(text).toContain('the spec its stack says');
    expect(text).toContain('copy them into');
    const record: ClusterRecord | null = store.record_read('quay');
    expect(record?.ids['stackRef']).toBe(QUAY_STACK);
    expect(record?.adopted?.from).toBe('the tenancy');
    expect(record?.compartmentId).toBe(QUAY_COMPARTMENT);
    expect(record?.baseDomain).toBe('oci.example.org');
    expect(record?.steps['compartment']?.state).toBe('done');
    expect(record?.protected).toBe(true);
    expect(store.spec_read('quay')?.spec).toEqual(spec);
    const status = await cluster_run(context, ['status', 'quay']);
    const model = status.model?.data as { clusters: Array<{ origin?: string }> };
    expect(model.clusters[0]?.origin).toBe('adopted');
    expect((await cluster_run(context, ['adopt', 'quay'])).rendered).toBe(`quay: already adopted; its stack is ${QUAY_STACK}\n`);
    expect((await cluster_run(context, ['adopt', 'nope'])).renderedErr).toBe('cluster adopt: nope: nothing in the tenancy is tagged mise-cluster=nope; a harbor-oci checkout adopts with --from\n');
  });

  it('a cluster kept here stands in for the one found under its name', async () => {
    world.stacks.set(QUAY_STACK, { state: 'active', compartmentId: QUAY_COMPARTMENT, baseDomain: null, spec: null });
    await cluster_run(context, ['adopt', 'quay']);
    expect(store.spec_read('quay')?.spec).toEqual(SPEC_DEFAULT);
    const model = (await cluster_run(context, [])).model?.data as { clusters: Array<{ name: string; origin?: string }> };
    expect(model.clusters).toHaveLength(1);
    expect(model.clusters[0]?.origin).toBe('adopted');
  });
});
