/**
 * @file A new cluster's build and teardown over OCI, against recorded
 * answers: preflight's checks, the image's bucket and link, a new stack's
 * variables and plan, the apply's outputs, the records, and the teardown in
 * its order; and the teardown verb.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { BufferSink, HeadlessSurface, JobRunner, runner_install, sink_set, surface_set, type PromptRequest } from '@fnndsc/brasa/core';
import type { BuildCall } from '../src/cloud/builder.js';
import type { OciBuildApi, OciLink } from '../src/cloud/oci/buildApi.js';
import type { RmApi, RmJobRecord, RmOperation } from '../src/cloud/oci/rmApi.js';
import { OciBuilder } from '../src/cloud/oci/builder.js';
import { familyShape_resolve, stackVariables_build } from '../src/cloud/oci/stackVars.js';
import { FakeDriver, fakeCloud_sample } from '../src/cloud/fake/driver.js';
import { FakeBuildWorld, FakeCloudBuilder, FakeInstaller } from '../src/cloud/fake/builder.js';
import { FakeKube, fakeVerifyReach } from '../src/kube/fakeKube.js';
import type { KubeApi } from '../src/kube/kube.js';
import { SPEC_DEFAULT, specOptions_apply, type ClusterSpec } from '../src/cluster/spec.js';
import { ClusterStore, type ClusterRecord } from '../src/cluster/state.js';
import { STEPS_SOURCE, type BuildDeps } from '../src/cluster/steps.js';
import { clusterVolumes_read } from '../src/cluster/teardown.js';
import { ClusterTree } from '../src/vfs/clusters.js';
import { cluster_run, type ClusterCommandContext } from '../src/commands/cluster.js';

const plain = (text: string | undefined): string => (text ?? '').replace(/\x1b\[[0-9;]*m/g, '');

/** OCI's other calls, answering from fields and recording what was asked. */
class RecordedApi implements OciBuildApi {
  calls: string[] = [];
  compartment: string = 'ACTIVE';
  tagged: boolean = true;
  lbFree: number | null = 7;
  served: string[] = ['ns1.p68.dns.oraclecloud.net', 'ns2.p68.dns.oraclecloud.net'];
  async tenancy_get() { return { id: 'ocid1.tenancy.t', name: 'fnndsc-bch' }; }
  async compartmentState_get() { return this.compartment; }
  zoneHome: string | null = 'ocid1.compartment.oc1..harbor-oci';
  tagHome: string | null = 'ocid1.compartment.oc1..harbor-oci';
  children: Map<string, string> = new Map();
  async zoneCompartment_find() { return this.zoneHome; }
  async zoneNames_list() { return ['oci.chrisproject.org']; }
  async tagNamespaceCompartment_find() { return this.tagHome; }
  async compartmentChild_ensure(parentId: string, name: string, _description: string, tags: Record<string, string>) {
    const key: string = `${parentId}/${name}`;
    const kept: string | undefined = this.children.get(key);
    if (kept !== undefined) return { id: kept, made: false };
    const id: string = `ocid1.compartment.oc1..${name}`;
    this.children.set(key, id);
    this.calls.push(`compartment ${name} under ${parentId} ${JSON.stringify(tags)}`);
    return { id, made: true };
  }
  async tag_exists() { return this.tagged; }
  async limitFree_get() { return this.lbFree; }
  async zoneNameservers_get() { return this.served; }
  async bucket_ensure(bucket: string) { this.calls.push(`bucket ${bucket}`); }
  async object_put(bucket: string, object: string, _body: Readable | Buffer, length?: number) { this.calls.push(`put ${bucket}/${object} ${length}`); }
  async object_delete(bucket: string, object: string) { this.calls.push(`delete ${bucket}/${object}`); }
  async link_create(bucket: string, object: string): Promise<OciLink> { this.calls.push(`link ${bucket}/${object}`); return { id: 'par-1', url: 'https://objectstorage/p/SECRET/o/x.iso' }; }
  async link_delete(_bucket: string, linkId: string) { this.calls.push(`unlink ${linkId}`); }
  async record_upsert(zone: string, name: string, address: string, compartmentId: string) { this.calls.push(`A ${name} ${address} in ${zone} (${compartmentId})`); }
  async record_delete(_zone: string, name: string) { this.calls.push(`unrecord ${name}`); }
  async volume_delete(id: string) { this.calls.push(`volume ${id}`); }
  /** Block volumes left in a compartment, by compartment. */
  volumes: Record<string, Array<{ id: string; name: string; tags: Record<string, string> }>> = {};
  async volumes_list(compartmentId: string) { return this.volumes[compartmentId] ?? []; }
  /** What `compartment_describe` answers, by compartment. */
  described: Record<string, { name: string; parentName: string | null; tags: Record<string, string> }> = {};
  async compartment_describe(compartmentId: string) { return this.described[compartmentId] ?? { name: 'other', parentName: null, tags: {} }; }
  async compartment_tagRemove(compartmentId: string, key: string) { this.calls.push(`untag ${compartmentId} ${key}`); }
  /** Whether `compartment_delete` refuses (the compartment is not empty). */
  compartmentFull: boolean = false;
  async compartment_delete(compartmentId: string) { if (this.compartmentFull) throw new Error('CompartmentNotEmpty'); this.calls.push(`delete compartment ${compartmentId}`); }
  /** The buckets by compartment, for `bucket_remove`. */
  buckets: Record<string, string> = {};
  async bucket_remove(bucket: string, compartmentId: string) { if (this.buckets[bucket] !== compartmentId) return false; this.calls.push(`delete bucket ${bucket}`); return true; }
}

/** Resource Manager, answering every job with success. */
class OkRm implements RmApi {
  calls: string[] = [];
  variables: Record<string, string> = {};
  async stack_create(request: { compartmentId: string; displayName: string; zipBase64: string; variables: Record<string, string>; tags: Record<string, string> }) {
    this.variables = request.variables;
    this.calls.push(`stack ${JSON.stringify(request.tags)}`);
    return { id: 'stack-1', displayName: request.displayName, state: 'ACTIVE', compartmentId: request.compartmentId };
  }
  async stack_update() {}
  async stack_get(id: string) { return { id, displayName: 's', state: 'ACTIVE', compartmentId: 'c' }; }
  async stacks_tagged() { return []; }
  async job_create(stackId: string, operation: RmOperation): Promise<RmJobRecord> { this.calls.push(`${operation.kind} ${stackId}${operation.kind === 'apply' ? ` from ${operation.planJobId}` : ''}`); return { id: `job-${operation.kind}`, state: 'ACCEPTED' }; }
  async job_get(id: string): Promise<RmJobRecord> { return { id, state: 'SUCCEEDED' }; }
  async job_cancel() {}
  async jobLog_read() { return []; }
  async jobPlan_read() { return { resource_changes: [{ address: 'oci_core_instance.cp[0]', type: 'oci_core_instance', change: { actions: ['create'] } }] }; }
  outputs: Record<string, string> = { open_shift_api_lb_addr: '129.0.0.1', open_shift_api_int_lb_addr: '10.0.0.2', open_shift_apps_lb_addr: '129.0.0.3', dynamic_custom_manifest: 'kind: List\n' };
  async jobOutputs_read() { return this.outputs; }
  async stackResources_count() { return 79; }
  async stack_delete(stackId: string) { this.calls.push(`delete ${stackId}`); }
}

describe('a new stack\'s variables', () => {
  it('are the spec in OCI units and harbor-oci\'s choices, every value a string', () => {
    const variables = stackVariables_build({ cluster: 'trial', spec: SPEC_DEFAULT, tenancyId: 't', compartmentId: 'c', region: 'r', baseDomain: 'b.org', isoLink: 'https://iso', sshPublicKey: 'ssh-ed25519 k' });
    expect(variables).toMatchObject({
      cluster_name: 'trial', zone_dns: 'b.org', installation_method: 'Assisted', openshift_image_source_uri: 'https://iso',
      control_plane_count: '3', control_plane_shape: 'VM.Standard.E5.Flex', control_plane_ocpu: '4', control_plane_memory: '24', control_plane_boot_size: '200', control_plane_boot_volume_vpus_per_gb: '100',
      compute_count: '0', create_public_dns: 'false', create_private_dns: 'false', tag_namespace_compartment_ocid_resource_tagging: 'c', oci_driver_version: 'v1.34.0',
    });
    const workers: ClusterSpec = (specOptions_apply(SPEC_DEFAULT, new Map([['--workers', '2x8/32']])) as { spec: ClusterSpec }).spec;
    expect(stackVariables_build({ cluster: 't', spec: workers, tenancyId: 't', compartmentId: 'c', region: 'r', baseDomain: 'b', isoLink: 'i', sshPublicKey: 'k' })).toMatchObject({ compute_count: '2', compute_ocpu: '4', compute_boot_volume_vpus_per_gb: '10' });
    expect(() => stackVariables_build({ cluster: 't', spec: { ...SPEC_DEFAULT, controlPlane: { ...SPEC_DEFAULT.controlPlane, vcpu: 7 } }, tenancyId: 't', compartmentId: 'c', region: 'r', baseDomain: 'b', isoLink: 'i', sshPublicKey: 'k' })).toThrow('7 vCPU is not whole OCPUs');
    expect(() => stackVariables_build({ cluster: 't', spec: { ...SPEC_DEFAULT, controlPlane: { ...SPEC_DEFAULT.controlPlane, bootTier: 'gold' } }, tenancyId: 't', compartmentId: 'c', region: 'r', baseDomain: 'b', isoLink: 'i', sshPublicKey: 'k' })).toThrow('boot tier gold');
    expect(() => familyShape_resolve('Z9')).toThrow('no flexible shape known');
    expect(familyShape_resolve('A1')).toEqual({ shape: 'VM.Standard.A1.Flex', vcpuPerOcpu: 1 });
  });
});

describe('the OCI builder\'s build and teardown', () => {
  let api: RecordedApi;
  let rm: OkRm;
  let builder: OciBuilder;
  let logged: string[];
  const call = (): BuildCall => ({ log: (line: string): void => { logged.push(line); }, signal: new AbortController().signal });
  const builder_make = (visibleWaitMs?: number): OciBuilder => new OciBuilder({
    rm: () => rm, api: () => api, driver: new FakeDriver(fakeCloud_sample()), sshPublicKey: () => 'ssh-ed25519 k\n',
    nameservers_resolve: async () => ['ns2.p68.dns.oraclecloud.net.', 'ns1.p68.dns.oraclecloud.net.'],
    iso_fetch: async () => ({ body: Readable.from(['iso']), length: 3 }), zip_fetch: async () => Buffer.from('zip'), pollMs: 0,
    ...(visibleWaitMs !== undefined ? { visibleWaitMs } : {}),
  });

  beforeEach(() => {
    api = new RecordedApi();
    rm = new OkRm();
    logged = [];
    builder = builder_make();
  });

  it("makes the cluster's compartment under clusters, once, tagged with its name", async () => {
    const made = await builder.compartment_ensure({ cluster: 'quay', region: 'r' }, call());
    expect(made).toEqual({ id: 'ocid1.compartment.oc1..quay', made: true });
    expect(api.calls).toEqual([
      'compartment clusters under ocid1.tenancy.t {"mise-role":"clusters"}',
      'compartment quay under ocid1.compartment.oc1..clusters {"mise-cluster":"quay"}',
    ]);
    expect(await builder.compartment_ensure({ cluster: 'quay', region: 'r' }, call())).toEqual({ id: 'ocid1.compartment.oc1..quay', made: false });
    expect(api.calls).toHaveLength(2);
  });

  it('waits out a parent just made that the identity service does not yet find, and gives up when told', async () => {
    const ensure = api.compartmentChild_ensure.bind(api);
    let refusals: number = 2;
    api.compartmentChild_ensure = async (parentId: string, name: string, description: string, tags: Record<string, string>) => {
      if (name === 'quay' && refusals-- > 0) throw Object.assign(new Error('Authorization failed or requested resource not found.'), { statusCode: 404 });
      return await ensure(parentId, name, description, tags);
    };
    let unseen: number = 2;
    const state = api.compartmentState_get.bind(api);
    api.compartmentState_get = async (id: string) => {
      if (id === 'ocid1.compartment.oc1..quay' && unseen-- > 0) throw Object.assign(new Error('Authorization failed or requested resource not found.'), { statusCode: 404 });
      return await state(id);
    };
    expect(await builder.compartment_ensure({ cluster: 'quay', region: 'r' }, call())).toEqual({ id: 'ocid1.compartment.oc1..quay', made: true });
    expect(logged.filter((line: string): boolean => line === 'clusters is not yet usable; waiting')).toHaveLength(2);
    expect(logged.filter((line: string): boolean => line === 'ocid1.compartment.oc1..quay is not yet found; waiting')).toHaveLength(2);
    refusals = Infinity;
    api.children.clear();
    const impatient: OciBuilder = builder_make(0);
    await expect(impatient.compartment_ensure({ cluster: 'quay', region: 'r' }, call())).rejects.toThrow('not found');
  });

  it('preflight checks what harbor-oci checked, each on its own', async () => {
    const checks = await builder.preflight({ cluster: 'trial', spec: SPEC_DEFAULT, region: 'us-ashburn-1', baseDomain: 'b.org', compartmentId: 'c' }, call());
    expect(checks.map((check) => `${check.name}:${check.ok}`)).toEqual(['credential:true', 'compartment:true', 'attribution tag:true', 'spec:true', 'room:false', 'load balancers:true', 'zone:true', 'SSH key:true']);
    expect(checks.find((check) => check.name === 'room')?.note).toContain('not said');
    api.compartment = 'DELETED'; api.tagged = false; api.lbFree = 2; api.served = ['ns9'];
    const workers: ClusterSpec = (specOptions_apply(SPEC_DEFAULT, new Map([['--workers', '2x8/32']])) as { spec: ClusterSpec }).spec;
    const bad = Object.fromEntries((await builder.preflight({ cluster: 'trial', spec: workers, region: 'us-ashburn-1', baseDomain: 'b.org', compartmentId: 'c' }, call())).map((check) => [check.name, check]));
    expect(bad['compartment']).toMatchObject({ ok: false, note: 'deleted' });
    expect(bad['attribution tag']?.ok).toBe(false);
    expect(bad['spec']?.note).toContain('workers are not proven on OCI yet');
    expect(bad['load balancers']).toMatchObject({ ok: false, note: '3 needed, 2 free' });
    expect(bad['zone']?.note).toBe('b.org: OCI serves ns9, the world asks ns1.p68.dns.oraclecloud.net ns2.p68.dns.oraclecloud.net');
    const none = Object.fromEntries((await builder.preflight({ cluster: 'trial', spec: SPEC_DEFAULT, region: 'us-ashburn-1', baseDomain: 'b.org', compartmentId: '' }, call())).map((check) => [check.name, check]));
    expect(none['compartment']?.note).toBe('none chosen: cluster new --compartment <ocid>');
  });

  it('copies the image again while a bucket just made answers not found', async () => {
    const put = api.object_put.bind(api);
    let refusals: number = 1;
    api.object_put = async (bucket: string, object: string, body: Readable | Buffer, length?: number) => {
      if (refusals-- > 0) throw Object.assign(new Error("Either the bucket named 'stratus-iso' does not exist"), { statusCode: 404 });
      await put(bucket, object, body, length);
    };
    await builder.iso_store({ cluster: 'trial', url: 'https://img', region: 'r', compartmentId: 'c' }, call());
    expect(api.calls).toEqual(['bucket stratus-iso', 'put stratus-iso/trial-discovery.iso 3', 'link stratus-iso/trial-discovery.iso']);
    expect(logged.filter((line: string): boolean => line.startsWith('copying the discovery image'))).toHaveLength(2);
    expect(logged).toContain('stratus-iso is not yet usable; waiting');
  });

  it('copies the image into a private bucket and links it, makes a stack from the spec, plans, applies and writes the records', async () => {
    const stored = await builder.iso_store({ cluster: 'trial', url: 'https://img', region: 'r', compartmentId: 'c' }, call());
    expect(stored).toMatchObject({ object: 'trial-discovery.iso', link: 'https://objectstorage/p/SECRET/o/x.iso', linkId: 'par-1' });
    expect(api.calls).toEqual(['bucket stratus-iso', 'put stratus-iso/trial-discovery.iso 3', 'link stratus-iso/trial-discovery.iso']);
    const plan = await builder.infra_plan({ cluster: 'trial', spec: SPEC_DEFAULT, region: 'r', isoObject: 'trial-discovery.iso', compartmentId: 'c', baseDomain: 'b.org', isoLink: stored.link }, call());
    expect(plan).toMatchObject({ ref: 'job-plan', stackRef: 'stack-1', rows: [{ action: 'create', kind: 'instances' }] });
    expect(rm.variables).toMatchObject({ cluster_name: 'trial', openshift_image_source_uri: 'https://objectstorage/p/SECRET/o/x.iso', tenancy_ocid: 'ocid1.tenancy.t', public_ssh_key: 'ssh-ed25519 k' });
    const outputs = await builder.infra_apply({ cluster: 'trial', plan, region: 'r' }, call());
    expect(outputs).toEqual({ stackRef: 'stack-1', apiIp: '129.0.0.1', apiIntIp: '10.0.0.2', appsIp: '129.0.0.3', manifests: [{ name: 'oci-dynamic-custom-manifest.yml', content: 'kind: List\n' }] });
    expect(rm.calls).toEqual(['stack {"mise-cluster":"trial"}', 'plan stack-1', 'apply stack-1 from job-plan']);
    expect(await builder.dns_upsert({ cluster: 'trial', baseDomain: 'b.org', outputs, compartmentId: 'c', region: 'r' }, call())).toEqual(['api.trial.b.org', 'api-int.trial.b.org', '*.apps.trial.b.org']);
    // The records go in the zone where it lives (harbor-oci's), not the cluster's own compartment.
    const zone: string = '(ocid1.compartment.oc1..harbor-oci)';
    expect(api.calls.slice(-3)).toEqual([`A api.trial.b.org 129.0.0.1 in b.org ${zone}`, `A api-int.trial.b.org 10.0.0.2 in b.org ${zone}`, `A *.apps.trial.b.org 129.0.0.3 in b.org ${zone}`]);
    // The stack attributes with the tenancy's one tag namespace, where it lives.
    expect(rm.variables['tag_namespace_compartment_ocid_resource_tagging']).toBe('ocid1.compartment.oc1..harbor-oci');
    delete rm.outputs['dynamic_custom_manifest'];
    await expect(builder.infra_apply({ cluster: 'trial', plan, region: 'r' }, call())).rejects.toThrow('the apply left no dynamic_custom_manifest');
    await expect(builder.infra_apply({ cluster: 'trial', plan: { ref: 'p', rows: [] }, region: 'r' }, call())).rejects.toThrow('no stack to apply in');
  });

  it('tears down in its order: the stack, the records, the image, the cluster\'s volumes, then the stack itself and the cluster\'s own compartment with its bucket', async () => {
    expect(await builder.stackResources_count({ region: 'r', stackRef: 'stack-1' })).toBe(79);
    api.described['c'] = { name: 'trial', parentName: 'clusters', tags: { 'mise-cluster': 'trial' } };
    api.buckets['stratus-iso'] = 'c';
    // A volume the cluster never named, left in the compartment with the attribution tag; one without the tag is not the cluster's.
    api.volumes['c'] = [{ id: 'vol-2', name: 'csi-left', tags: { 'openshift-tags.openshift-resource': 'openshift-resource-infra' } }, { id: 'vol-3', name: 'someone-elses', tags: {} }];
    const gone = await builder.teardown_run({ cluster: 'trial', region: 'r', compartmentId: 'c', baseDomain: 'b.org', stackRef: 'stack-1', isoObject: 'trial-discovery.iso', isoLinkId: 'par-1', volumeIds: ['vol-1'] }, call());
    expect(rm.calls).toEqual(['destroy stack-1', 'delete stack-1']);
    expect(api.calls).toEqual(['unrecord api.trial.b.org', 'unrecord api-int.trial.b.org', 'unrecord *.apps.trial.b.org', 'unlink par-1', 'delete stratus-iso/trial-discovery.iso', 'volume vol-1', 'volume vol-2', 'delete bucket stratus-iso', 'delete compartment c']);
    expect(gone).toEqual(["the stack's resources (stack-1)", '3 DNS records', 'the image trial-discovery.iso and its link', '1 volumes the cluster made', '1 volumes left in the compartment with the attribution tag', 'the stack itself', 'the image bucket stratus-iso', 'the compartment clusters/trial']);
  });

  it('runs no destroy job for a stack an earlier pass emptied, does the rest again, and leaves a compartment that is not its own with only the tag gone', async () => {
    // harbor-oci's compartment: the zone and the tag namespace live there, so it keeps itself.
    api.described['c'] = { name: 'harbor-oci', parentName: null, tags: { 'mise-cluster': 'trial', 'other': 'x' } };
    const gone = await builder.teardown_run({ cluster: 'trial', region: 'r', compartmentId: 'c', baseDomain: 'b.org', stackRef: 'stack-1', volumeIds: [], stackEmpty: true }, call());
    expect(rm.calls).toEqual(['delete stack-1']);
    expect(api.calls).toEqual(['unrecord api.trial.b.org', 'unrecord api-int.trial.b.org', 'unrecord *.apps.trial.b.org', 'untag c mise-cluster']);
    expect(gone).toEqual(['3 DNS records', 'the stack itself', 'the tag mise-cluster=trial off the compartment harbor-oci']);
  });

  it('leaves a compartment of its own that still holds something, saying so, and looks for no records without a zone', async () => {
    api.described['c'] = { name: 'trial', parentName: 'clusters', tags: { 'mise-cluster': 'trial' } };
    api.compartmentFull = true;
    const logged: string[] = [];
    const gone = await builder.teardown_run({ cluster: 'trial', region: 'r', compartmentId: 'c', baseDomain: '', volumeIds: [] }, { log: (line: string): void => { logged.push(line); }, signal: new AbortController().signal });
    expect(api.calls).toEqual([]);
    expect(gone).toEqual([]);
    expect(logged).toEqual(['no zone known for it: no records looked for', 'the compartment clusters/trial stays: CompartmentNotEmpty']);
  });

  it('reads the cluster\'s own block volumes from its PersistentVolumes', async () => {
    const kube: KubeApi = { ...new FakeKube({ nodes: [] }), json_get: async () => ({ items: [
      { spec: { csi: { driver: 'blockvolume.csi.oraclecloud.com', volumeHandle: 'ocid1.volume.a' } } },
      { spec: { csi: { driver: 'other.csi', volumeHandle: 'x' } } },
      { spec: { nfs: {} } },
    ] }) } as KubeApi;
    expect(await clusterVolumes_read(kube)).toEqual(['ocid1.volume.a']);
  });
});

describe('cluster teardown', () => {
  let root: string;
  let store: ClusterStore;
  let context: ClusterCommandContext;
  let surface: HeadlessSurface & { answer: string };
  let installer: FakeInstaller;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stratus-teardown-'));
    store = new ClusterStore(join(root, 'clusters'));
    const world: FakeBuildWorld = new FakeBuildWorld(0);
    const builder: FakeCloudBuilder = new FakeCloudBuilder(world);
    installer = new FakeInstaller(world);
    const deps: BuildDeps = { store, builder, installer, zones: 3, version: '4.22', pollMs: 0, hostsWaitMs: 1000, installWaitMs: 1000 };
    const clusters: ClusterTree = new ClusterTree({ sources: [], owner: (): string => 'r', now: (): Date => new Date(), store });
    const driver: FakeDriver = new FakeDriver(fakeCloud_sample());
    const verifyReach = { ...fakeVerifyReach(() => []), kube_make: (): KubeApi => ({ ...new FakeKube({ nodes: [] }), json_get: async () => ({ items: [{ spec: { csi: { driver: 'blockvolume.csi.oraclecloud.com', volumeHandle: 'v1' } } }] }) }) as KubeApi };
    context = { clusters, driver, region: (): string => 'r', clustersPath: (): string => '/d', build: { clusters, store, driver, region: (): string => 'r', deps, builder, baseDomain: 'b', verifyReach } };
    surface = Object.assign(new HeadlessSurface(), { answer: 'trial' });
    (surface.capabilities as { tasks?: boolean }).tasks = true;
    surface.prompt = async (_request: PromptRequest): Promise<string> => surface.answer;
    surface_set(surface);
    runner_install(new JobRunner(join(root, 'jobs'), [{ id: STEPS_SOURCE, label: 'steps' }]));
    sink_set(new BufferSink());
    // Unprotected: these tests are about teardown itself; protection has its own.
    store.create({ name: 'trial', created: 'now', region: 'r', baseDomain: 'b', steps: {}, ids: { stackRef: 'stack-1', isoObject: 'trial-discovery.iso', clusterId: 'cluster-trial', infraEnvId: 'infraenv-trial' }, compartmentId: 'c', protected: false }, SPEC_DEFAULT);
    store.secret_write('trial', 'kubeconfig', 'clusters: []\n');
  });
  afterEach(() => { runner_install(null); surface_set(new HeadlessSurface()); rmSync(root, { recursive: true, force: true }); });

  it("asks for the installer's account when a build will need it and none is kept, and keeps it on the host", async () => {
    const { fileAccount_make } = await import('../src/installer/account.js');
    const account = fileAccount_make(join(root, 'ocm', 'service-account.env'));
    const asking: ClusterCommandContext = { ...context, build: { ...context.build!, account } };
    store.create({ name: 'fresh', created: 'now', region: 'r', baseDomain: 'b', steps: {}, ids: {}, protected: true }, SPEC_DEFAULT);
    surface.answer = 'client-1';
    await cluster_run(asking, ['build', 'fresh', '--through', 'compartment']);
    expect(account.present()).toBe(false);
    await cluster_run(asking, ['build', 'fresh', '--through', 'cluster']);
    expect(account.present()).toBe(true);
    expect(store.record_read('fresh')?.compartmentId).toBe('ocid1.compartment.oc1..fake-fresh');
  });

  it('refuses a protected cluster by name, and lifting it is a line of its own', async () => {
    store.record_update('trial', (record: ClusterRecord): void => { record.protected = true; });
    expect((await cluster_run(context, ['teardown', 'trial'])).renderedErr).toBe('cluster teardown: trial: Operation not permitted: protected (cluster protect trial off lifts it, as its own line)\n');
    expect(plain((await cluster_run(context, ['protect', 'trial'])).rendered)).toBe('trial: protected (teardown refused)\n');
    expect(plain((await cluster_run(context, ['protect', 'trial', 'off'])).rendered)).toBe('trial: no longer protected; cluster teardown trial will ask for its name\n');
    expect(store.record_read('trial')?.protected).toBe(false);
    expect((await cluster_run(context, ['protect', 'trial', 'maybe'])).renderedErr).toBe('cluster protect: usage: cluster protect <name> [on|off]\n');
    expect((await cluster_run(context, ['protect', 'ghost', 'on'])).renderedErr).toBe('cluster protect: ghost: no such cluster kept here\n');
  });

  it('shows what goes, asks for the name, and removes it; a wrong name removes nothing', async () => {
    surface.answer = 'tria';
    expect(plain((await cluster_run(context, ['teardown', 'trial'])).rendered)).toBe("not torn down: 'tria' is not trial\n");
    expect(store.record_read('trial')?.gone).toBeUndefined();
    surface.answer = 'trial';
    expect(plain((await cluster_run(context, ['teardown', 'trial'])).rendered)).toBe('trial: torn down\n');
    expect((store.record_read('trial') as ClusterRecord).gone).toBeDefined();
    expect(installer.deleted).toEqual(['cluster-trial']);
    expect(plain((await cluster_run(context, ['teardown', 'trial'])).rendered)).toContain('already torn down');
    expect(plain((await cluster_run(context, ['status', 'trial'])).rendered)).toContain('torn down');
    expect((await cluster_run(context, ['build', 'trial'])).renderedErr).toContain('was torn down');
  });

  it('refuses what it must not tear down, and when it cannot read the cluster\'s volumes', async () => {
    // An adopted cluster is guarded by its lock alone, as a built one is; lifted, it is torn down.
    store.create({ name: 'harbor', created: 'now', region: 'r', baseDomain: 'b', steps: {}, ids: {}, adopted: { from: '/x', at: 'now' } }, SPEC_DEFAULT);
    expect((await cluster_run(context, ['teardown', 'harbor'])).renderedErr).toBe('cluster teardown: harbor: Operation not permitted: protected (cluster protect harbor off lifts it, as its own line)\n');
    await cluster_run(context, ['protect', 'harbor', 'off']);
    surface.answer = 'harbor';
    expect(plain((await cluster_run(context, ['teardown', 'harbor'])).rendered)).toBe('harbor: torn down\n');
    expect(store.record_read('harbor')?.gone).toBeDefined();
    surface.answer = 'trial';
    expect((await cluster_run(context, ['teardown', 'nope'])).renderedErr).toBe('cluster teardown: nope: no such cluster\n');
    expect((await cluster_run(context, ['teardown'])).renderedErr).toBe('cluster teardown: usage: cluster teardown <name>\n');
    const blind: ClusterCommandContext = { ...context, build: { ...context.build!, verifyReach: { ...context.build!.verifyReach!, kube_make: (): KubeApi => ({ ...new FakeKube({ nodes: [] }), json_get: async () => { throw new Error('unreachable'); } }) as KubeApi } } };
    expect((await cluster_run(blind, ['teardown', 'trial'])).renderedErr).toBe("cluster teardown: trial: cannot read the cluster's volumes (unreachable): refusing, they would be left billing\n");
    // Once an earlier pass emptied the stack the cluster is gone with it:
    // the teardown runs again without asking it, and finishes.
    const builderUsed = context.build!.builder!;
    const counted = jest.spyOn(builderUsed, 'stackResources_count').mockResolvedValue(0);
    const resumed = await cluster_run(blind, ['teardown', 'trial']);
    expect(plain(resumed.rendered)).toBe('trial: torn down\n');
    expect((store.record_read('trial') as ClusterRecord).gone).toBeDefined();
    counted.mockRestore();
    store.record_update('trial', (current: ClusterRecord): void => { delete current.gone; });
    const untiered: HeadlessSurface = new HeadlessSurface();
    surface_set(untiered);
    expect((await cluster_run(context, ['teardown', 'trial'])).renderedErr).toContain('tearing down needs the tasks tier');
    const noBuilder: ClusterCommandContext = { ...context, build: { ...context.build!, builder: null } };
    expect((await cluster_run(noBuilder, ['teardown', 'trial'])).renderedErr).toBe('cluster teardown: this cloud cannot tear a cluster down yet\n');
  });
});
