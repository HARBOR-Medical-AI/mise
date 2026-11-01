/**
 * @file Networks (docs/stratus.adoc, D16): the range a `net new` line takes,
 * its record on the host, the module's zip and variables, the OCI builder's
 * stack calls against recorded answers, and the verbs end to end over the
 * fake cloud: declare and compare, plan, ask, apply, adopt an empty place
 * and refuse a full one, and teardown's refusals and its question.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { BufferSink, HeadlessSurface, JobRunner, runner_install, sink_set, surface_set, type PromptRequest } from '@fnndsc/brasa/core';
import type { CloudDriver, ResourceCounts } from '../src/cloud/driver.js';
import type { BuildCall } from '../src/cloud/builder.js';
import type { OciBuildApi } from '../src/cloud/oci/buildApi.js';
import type { RmApi, RmJobRecord, RmOperation } from '../src/cloud/oci/rmApi.js';
import { OciBuilder } from '../src/cloud/oci/builder.js';
import { files_zip } from '../src/cloud/oci/zip.js';
import { netModule_zip, netVariables_build } from '../src/cloud/oci/modules/net.js';
import { FakeBuildWorld, FakeCloudBuilder } from '../src/cloud/fake/builder.js';
import { cidr_read, netSpec_diff, netSpecYaml_parse, netSpecYaml_render, subnet_derive } from '../src/net/spec.js';
import { NET_TAG, NetStore } from '../src/net/state.js';
import { echoAnswer_read } from '../src/net/address.js';
import { STEPS_SOURCE } from '../src/cluster/steps.js';
import { net_run, type NetCommandContext } from '../src/commands/net.js';

const plain = (text: string | undefined): string => (text ?? '').replace(/\x1b\[[0-9;]*m/g, '');
const call: BuildCall = { log: (): void => {}, signal: new AbortController().signal };

describe('a network\'s range', () => {
  it('is an IPv4 range from /16 to /24 starting at its first address', () => {
    expect(cidr_read('10.20.0.0/16')).toEqual({ cidr: '10.20.0.0/16' });
    expect(cidr_read(' 192.168.4.0/24 ')).toEqual({ cidr: '192.168.4.0/24' });
    expect(cidr_read('10.20.1.0/16')).toEqual({ error: '10.20.1.0/16: the address is not the range\'s first (10.20.0.0/16)' });
    expect(cidr_read('10.0.0.0/8')).toEqual({ error: '10.0.0.0/8: a network is /16 to /24' });
    expect(cidr_read('10.0.0.0/25')).toEqual({ error: '10.0.0.0/25: a network is /16 to /24' });
    expect(cidr_read('10.300.0.0/16')).toEqual({ error: '10.300.0.0/16: not an IPv4 address' });
    expect(cidr_read('fd00::/48')).toEqual({ error: 'fd00::/48: not an IPv4 range (10.20.0.0/16)' });
    expect(subnet_derive('10.20.0.0/16')).toBe('10.20.0.0/24');
  });

  it('is kept as spec.yaml, read back, and compared', () => {
    const text: string = netSpecYaml_render('store', { cidr: '10.20.0.0/16' });
    expect(text).toContain('cidr: 10.20.0.0/16');
    expect(netSpecYaml_parse(text)).toEqual({ spec: { cidr: '10.20.0.0/16' } });
    expect(netSpecYaml_parse('cidr: 10.20.0.0/8\n')).toEqual({ error: '10.20.0.0/8: a network is /16 to /24' });
    expect(netSpec_diff({ cidr: '10.20.0.0/16' }, { cidr: '10.20.0.0/16' })).toEqual([]);
    expect(netSpec_diff({ cidr: '10.20.0.0/16' }, { cidr: '10.30.0.0/16' })).toEqual(['cidr 10.20.0.0/16 → 10.30.0.0/16']);
  });
});

describe('this host\'s address', () => {
  it('is the echo\'s answer as a /32, and nothing else is', () => {
    expect(echoAnswer_read('134.174.21.21\n')).toBe('134.174.21.21/32');
    expect(() => echoAnswer_read('<html>')).toThrow('not an address');
    expect(() => echoAnswer_read('999.1.1.1')).toThrow('not an address');
  });
});

describe('the network module', () => {
  it('zips stored, the same bytes every time, readable by its directory', () => {
    const zip: Buffer = files_zip([{ path: 'main.tf', text: 'a = 1\n' }, { path: 'b.tf', text: 'b = 2\n' }]);
    expect(files_zip([{ path: 'main.tf', text: 'a = 1\n' }, { path: 'b.tf', text: 'b = 2\n' }]).equals(zip)).toBe(true);
    const end: number = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    expect(zip.readUInt16LE(end + 10)).toBe(2);
    const directory: number = zip.readUInt32LE(end + 16);
    expect(zip.readUInt32LE(directory)).toBe(0x02014b50);
    expect(zip.readUInt32LE(directory + 16)).toBe(crc32(Buffer.from('a = 1\n')));
    expect(zip.subarray(directory + 46, directory + 46 + 7).toString()).toBe('main.tf');
    expect(zip.subarray(30 + 7, 30 + 7 + 6).toString()).toBe('a = 1\n');
  });

  it('makes the network, gateway, route, security list, subnet and bastion, each tagged, Oracle-Tags aside', () => {
    const text: string = netModule_zip().toString('utf-8');
    for (const resource of ['oci_core_vcn', 'oci_core_internet_gateway', 'oci_core_default_route_table', 'oci_core_default_security_list', 'oci_core_subnet', 'oci_bastion_bastion']) expect(text).toContain(`resource "${resource}"`);
    expect(text.match(/freeform_tags\s+= local\.tags/g)).toHaveLength(6);
    expect(text.match(/ignore_changes = \[defined_tags\]/g)).toHaveLength(6);
    expect(text).toContain('display_name   = "${var.net_name}-gateway"');
    expect(text).not.toContain('source   = "0.0.0.0/0"\n    tcp_options');
  });

  it('is given the range, its first /24, labels in letters and digits, and the one address the bastion admits', () => {
    expect(netVariables_build({ name: 'chrisproject-services', cidr: '10.20.0.0/16', region: 'us-ashburn-1', compartmentId: 'c', clientCidr: '134.174.21.21/32' })).toEqual({
      region: 'us-ashburn-1', compartment_ocid: 'c', net_name: 'chrisproject-services', cidr: '10.20.0.0/16', subnet_cidr: '10.20.0.0/24',
      dns_label: 'chrisprojectser', bastion_name: 'chrisprojectservices', client_cidr: '134.174.21.21/32',
    });
  });
});

/** Resource Manager, every job a success, recording what was asked. */
class RecordedRm implements RmApi {
  calls: string[] = [];
  tagged: Array<{ id: string; displayName: string; state: string; compartmentId: string; variables: Record<string, string>; tagValue: string }> = [];
  held: number = 6;
  async stack_create(request: { compartmentId: string; displayName: string; description: string; zipBase64: string; variables: Record<string, string>; tags: Record<string, string> }) {
    this.calls.push(`create in ${request.compartmentId} "${request.displayName}" ${JSON.stringify(request.tags)} ${request.variables['subnet_cidr']} zip ${Buffer.from(request.zipBase64, 'base64').equals(netModule_zip())}`);
    return { id: 'stack-net', displayName: request.displayName, state: 'ACTIVE', compartmentId: request.compartmentId, variables: request.variables };
  }
  async stack_update(stackId: string, request: { zipBase64?: string; variables?: Record<string, string> }) { this.calls.push(`update ${stackId} ${request.variables?.['client_cidr']}`); }
  async stack_get(id: string) { return { id, displayName: 's', state: 'ACTIVE', compartmentId: 'c', variables: {} }; }
  async stacks_tagged(_compartmentId: string, tagKey: string) { this.calls.push(`tagged ${tagKey}`); return this.tagged; }
  async job_create(stackId: string, operation: RmOperation): Promise<RmJobRecord> { this.calls.push(`${operation.kind} ${stackId}${operation.kind === 'apply' ? ` from ${operation.planJobId}` : ''}`); return { id: `job-${operation.kind}`, state: 'ACCEPTED' }; }
  async job_get(id: string): Promise<RmJobRecord> { return { id, state: 'SUCCEEDED' }; }
  async job_cancel() {}
  async jobLog_read() { return []; }
  async jobPlan_read() { return { resource_changes: [{ address: 'oci_core_vcn.net', type: 'oci_core_vcn', change: { actions: ['create'] } }, { address: 'oci_bastion_bastion.shell', type: 'oci_bastion_bastion', change: { actions: ['create'] } }] }; }
  async jobOutputs_read() { return { vcn_id: 'ocid1.vcn.v', subnet_id: 'ocid1.subnet.s', bastion_id: 'ocid1.bastion.b' }; }
  async stackResources_count() { return this.held; }
  async stack_delete(stackId: string) { this.calls.push(`delete ${stackId}`); }
}

/** The compartment calls a network's place needs; the rest refuse. */
function placeApi_make(calls: string[], kept: { id: string; tags: Record<string, string> } | null): OciBuildApi {
  const refuse = async (): Promise<never> => { throw new Error('not asked for here'); };
  return {
    tenancy_get: async () => ({ id: 'ocid1.tenancy.t', name: 'fnndsc-bch' }),
    compartmentState_get: async () => 'ACTIVE',
    compartmentChild_ensure: async (parentId: string, name: string, _description: string, tags: Record<string, string>) => {
      calls.push(`ensure ${name} under ${parentId} ${JSON.stringify(tags)}`);
      return kept === null ? { id: `ocid1.compartment.${name}`, made: true } : { id: kept.id, made: false };
    },
    compartment_describe: async () => ({ name: 'x', parentName: null, tags: kept?.tags ?? {} }),
    compartment_tagSet: async (id: string, key: string, value: string) => { calls.push(`tag ${id} ${key}=${value}`); },
    compartment_tagRemove: async (id: string, key: string) => { calls.push(`untag ${id} ${key}`); },
    compartment_delete: async (id: string) => { calls.push(`delete ${id}`); },
    zoneCompartment_find: refuse, zoneNames_list: refuse, tagNamespaceCompartment_find: refuse, tag_exists: refuse, limitFree_get: refuse, zoneNameservers_get: refuse,
    bucket_ensure: refuse, object_put: refuse, object_delete: refuse, link_create: refuse, link_delete: refuse, record_upsert: refuse, record_delete: refuse,
    volume_delete: refuse, volumes_list: refuse, bucket_remove: refuse,
    publicIp_assign: refuse, bastionSession_create: refuse, bastionSession_state: refuse,
  };
}

describe('the OCI builder\'s network calls', () => {
  it('makes the compartment under the root with the tag, and says whether one found carries it', async () => {
    const calls: string[] = [];
    const made = await new OciBuilder({ rm: () => new RecordedRm(), api: () => placeApi_make(calls, null), pollMs: 0 }).place_ensure({ name: 'scratch', region: 'r', tag: NET_TAG }, call);
    expect(made).toEqual({ id: 'ocid1.compartment.scratch', made: true, tagged: true });
    expect(calls).toEqual(['ensure scratch under ocid1.tenancy.t {"mise-net":"scratch"}']);
    const found = await new OciBuilder({ rm: () => new RecordedRm(), api: () => placeApi_make([], { id: 'c-1', tags: {} }), pollMs: 0 }).place_ensure({ name: 'scratch', region: 'r', tag: NET_TAG }, call);
    expect(found).toEqual({ id: 'c-1', made: false, tagged: false });
  });

  it('plans in a new stack tagged with the network, then applies that plan and reads the outputs', async () => {
    const rm: RecordedRm = new RecordedRm();
    const builder: OciBuilder = new OciBuilder({ rm: () => rm, api: () => placeApi_make([], null), pollMs: 0 });
    const plan = await builder.modulePlan_run({ module: 'net', owner: { tag: NET_TAG, name: 'scratch' }, region: 'r', placeId: 'c-1', inputs: { cidr: '10.40.0.0/16', clientCidr: '1.2.3.4/32' } }, call);
    expect(plan.stackRef).toBe('stack-net');
    expect(plan.rows.map((row) => `${row.action} ${row.kind}`)).toEqual(['create networks', 'create oci_bastion_bastion']);
    expect(await builder.moduleApply_run({ region: 'r', stackRef: 'stack-net', plan, label: 'scratch' }, call)).toEqual({ vcn_id: 'ocid1.vcn.v', subnet_id: 'ocid1.subnet.s', bastion_id: 'ocid1.bastion.b' });
    expect(rm.calls).toEqual(['tagged mise-net', 'create in c-1 "scratch · a network" {"mise-net":"scratch"} 10.40.0.0/24 zip true', 'plan stack-net', 'apply stack-net from job-plan']);
  });

  it('plans again in the stack an earlier plan made for the same module, its variables set again', async () => {
    const rm: RecordedRm = new RecordedRm();
    rm.tagged = [
      { id: 'stack-old', displayName: 'scratch · a network', state: 'ACTIVE', compartmentId: 'c-1', variables: {}, tagValue: 'scratch' },
      { id: 'stack-other', displayName: 'scratch · its data', state: 'ACTIVE', compartmentId: 'c-1', variables: {}, tagValue: 'scratch' },
    ];
    await new OciBuilder({ rm: () => rm, pollMs: 0 }).modulePlan_run({ module: 'net', owner: { tag: NET_TAG, name: 'scratch' }, region: 'r', placeId: 'c-1', inputs: { cidr: '10.40.0.0/16', clientCidr: '5.6.7.8/32' } }, call);
    expect(rm.calls).toEqual(['tagged mise-net', 'update stack-old 5.6.7.8/32', 'plan stack-old']);
  });

  it('destroys what the stack holds, then the stack; an empty one is only deleted', async () => {
    const rm: RecordedRm = new RecordedRm();
    const builder: OciBuilder = new OciBuilder({ rm: () => rm, pollMs: 0 });
    expect(await builder.moduleDestroy_run({ region: 'r', stackRef: 'stack-net', label: 'scratch' }, call)).toEqual(['6 resources the stack held', 'the stack stack-net']);
    rm.held = 0;
    await builder.moduleDestroy_run({ region: 'r', stackRef: 'stack-net', label: 'scratch' }, call);
    expect(rm.calls).toEqual(['destroy stack-net', 'delete stack-net', 'delete stack-net']);
  });

  it('removes a compartment it made, and only untags one it adopted', async () => {
    const calls: string[] = [];
    const builder: OciBuilder = new OciBuilder({ rm: () => new RecordedRm(), api: () => placeApi_make(calls, null), pollMs: 0 });
    expect(await builder.place_release({ placeId: 'c-1', region: 'r', tag: NET_TAG, made: true }, call)).toContain('removal asked');
    expect(await builder.place_release({ placeId: 'c-2', region: 'r', tag: NET_TAG, made: false }, call)).toContain('stays (adopted, not made)');
    expect(calls).toEqual(['delete c-1', 'untag c-2 mise-net']);
  });
});

describe('net, over the fake cloud', () => {
  let root: string;
  let store: NetStore;
  let world: FakeBuildWorld;
  let standing: ResourceCounts;
  let context: NetCommandContext;
  let surface: HeadlessSurface & { answers: string[]; asked: string[] };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stratus-net-'));
    store = new NetStore(join(root, 'nets'));
    world = new FakeBuildWorld(0);
    standing = {};
    const driver = { resources_search: async (): Promise<ResourceCounts> => standing } as unknown as CloudDriver;
    context = { store, driver, builder: new FakeCloudBuilder(world), region: (): string => 'us-ashburn-1', clientCidr_read: async (): Promise<string> => '134.174.21.21/32' };
    surface = Object.assign(new HeadlessSurface(), { answers: [] as string[], asked: [] as string[] });
    (surface.capabilities as { tasks?: boolean }).tasks = true;
    surface.prompt = async (request: PromptRequest): Promise<string> => { surface.asked.push(request.message); return surface.answers.shift() ?? ''; };
    surface_set(surface);
    runner_install(new JobRunner(join(root, 'jobs'), [{ id: STEPS_SOURCE, label: 'steps' }]));
    sink_set(new BufferSink());
  });
  afterEach(() => { runner_install(null); surface_set(new HeadlessSurface()); rmSync(root, { recursive: true, force: true }); });

  it('declares, says unchanged on the same line, and the change on a different one', async () => {
    expect(plain((await net_run(context, ['new', 'scratch', '--cidr', '10.40.0.0/16'])).rendered)).toBe('scratch: declared, 10.40.0.0/16 in us-ashburn-1; net build scratch builds it\n');
    expect(plain((await net_run(context, ['new', 'scratch', '--cidr', '10.40.0.0/16'])).rendered)).toBe('scratch: unchanged\n');
    expect(plain((await net_run(context, ['new', 'scratch', '--cidr=10.50.0.0/16'])).rendered)).toBe('scratch: cidr 10.40.0.0/16 → 10.50.0.0/16\n');
    expect((await net_run(context, ['new', 'Scratch', '--cidr', '10.40.0.0/16'])).renderedErr).toContain('lower-case letters');
    expect((await net_run(context, ['new', 'scratch'])).renderedErr).toContain('--cidr <range> is needed');
    expect((await net_run(context, ['new', 'scratch', '--cidr', '10.40.0.0/8'])).renderedErr).toContain('a network is /16 to /24');
    expect(plain((await net_run(context, [])).rendered)).toContain('scratch  declared  10.50.0.0/16 (subnet 10.50.0.0/24)  us-ashburn-1');
  });

  it('builds: the plan as a task, the question with the counts, the apply; again, nothing to do', async () => {
    await net_run(context, ['new', 'scratch', '--cidr', '10.40.0.0/16']);
    surface.answers = ['y'];
    const built = await net_run(context, ['build', 'scratch']);
    expect(built.renderedErr ?? '').toBe('');
    expect(surface.asked).toEqual(['net build scratch: 6 to create, 0 to change, 0 to destroy. Nothing a network is made of bills. Continue? [y/N]']);
    expect(plain(built.rendered)).toContain('scratch  built');
    expect(plain(built.rendered)).toContain('bastion  ocid1.bastion.oc1..fake-scratch, admitting 134.174.21.21/32');
    const record = store.record_read('scratch');
    expect(record).toMatchObject({ placeId: 'ocid1.compartment.oc1..fake-scratch', placeMade: true, stackRef: 'fake-stack-net-scratch', clientCidr: '134.174.21.21/32' });
    expect(store.file_read('scratch', 'plan.json')).toBeNull();
    expect(world.places.get('scratch')?.tags).toEqual({ [NET_TAG]: 'scratch' });
    surface.asked = [];
    expect(plain((await net_run(context, ['build', 'scratch'])).rendered)).toBe('scratch: built, and the plan reads nothing to do\n');
    expect(surface.asked).toEqual([]);
  });

  it('asks before the apply, and a no changes nothing', async () => {
    await net_run(context, ['new', 'scratch', '--cidr', '10.40.0.0/16']);
    surface.answers = ['n'];
    expect(plain((await net_run(context, ['build', 'scratch'])).rendered)).toContain('stopped before the apply; nothing changed');
    expect(store.record_read('scratch')?.built).toBeUndefined();
    expect(world.moduleStacks.get('fake-stack-net-scratch')?.applied).toBeNull();
  });

  it('refuses a change to what exists unless --allow-alter', async () => {
    await net_run(context, ['new', 'scratch', '--cidr', '10.40.0.0/16']);
    surface.answers = ['y'];
    await net_run(context, ['build', 'scratch']);
    context = { ...context, clientCidr_read: async (): Promise<string> => '5.6.7.8/32' };
    expect((await net_run(context, ['build', 'scratch'])).renderedErr).toContain('it touches what exists, refused unless net build scratch --allow-alter');
    surface.answers = ['y'];
    expect((await net_run(context, ['build', 'scratch', '--allow-alter'])).renderedErr ?? '').toBe('');
    expect(store.record_read('scratch')?.clientCidr).toBe('5.6.7.8/32');
  });

  it('adopts an empty compartment of its name, and refuses one that holds anything', async () => {
    world.places.set('scratch', { id: 'ocid1.compartment.kept', tags: {}, others: 0 });
    await net_run(context, ['new', 'scratch', '--cidr', '10.40.0.0/16']);
    standing = { instances: 1, volumes: 2 };
    expect((await net_run(context, ['build', 'scratch'])).renderedErr).toContain('the compartment scratch is there and holds 1 instances, 2 volumes');
    expect(world.places.get('scratch')?.tags).toEqual({});
    standing = {};
    surface.answers = ['y'];
    await net_run(context, ['build', 'scratch']);
    expect(store.record_read('scratch')).toMatchObject({ placeId: 'ocid1.compartment.kept', placeMade: false });
    expect(world.places.get('scratch')?.tags).toEqual({ [NET_TAG]: 'scratch' });
  });

  it('needs the tasks tier to build or tear down', async () => {
    await net_run(context, ['new', 'scratch', '--cidr', '10.40.0.0/16']);
    surface_set(new HeadlessSurface());
    expect((await net_run(context, ['build', 'scratch'])).renderedErr).toContain('needs the tasks tier');
    expect(plain((await net_run(context, ['plan', 'scratch'])).rendered)).toContain('not made yet: net build scratch makes it');
  });

  it('tears down only when nothing stands on it and the name is typed back; the place it made goes, the spec stays', async () => {
    await net_run(context, ['new', 'scratch', '--cidr', '10.40.0.0/16']);
    surface.answers = ['y'];
    await net_run(context, ['build', 'scratch']);
    standing = { instances: 1, networks: 1 };
    expect((await net_run(context, ['teardown', 'scratch'])).renderedErr).toContain('Device or resource busy: 1 instances stand on it');
    standing = { networks: 1, subnets: 1 };
    surface.answers = ['scrach'];
    expect(plain((await net_run(context, ['teardown', 'scratch'])).rendered)).toContain('scrach is not scratch: nothing removed');
    surface.answers = ['scratch'];
    expect(plain((await net_run(context, ['teardown', 'scratch'])).rendered)).toBe('scratch: torn down; its spec stays (net build scratch builds it again)\n');
    expect(world.removed).toEqual(['stack fake-stack-net-scratch', 'compartment scratch']);
    expect(store.record_read('scratch')).toMatchObject({ gone: expect.any(String) });
    expect(store.record_read('scratch')?.placeId).toBeUndefined();
    expect(plain((await net_run(context, ['scratch'])).rendered)).toContain('scratch  gone');
    expect(plain((await net_run(context, ['teardown', 'scratch'])).rendered)).toBe('scratch: nothing of it is built\n');
  });

  it('refuses a verb it does not have, by name', async () => {
    expect((await net_run(context, ['delete', 'x'])).renderedErr).toBe('net: delete: not a verb (net status, new, plan, build, teardown)\n');
  });
});
