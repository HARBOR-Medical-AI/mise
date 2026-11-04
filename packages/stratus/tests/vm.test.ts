/**
 * @file VMs (docs/stratus.adoc, D16): the spec a `vm new` line takes, its
 * record and key on the host, the two modules' text, variables and
 * cloud-init, the cost, and the verbs end to end over the fake cloud on a
 * built network: declare and compare, build in two stacks with one question,
 * the address pointed, nothing to do again, the shell line, protection, and
 * teardown keeping the data or, with --all, taking it.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BufferSink, HeadlessSurface, JobRunner, runner_install, sink_set, surface_set, type PromptRequest } from '@fnndsc/brasa/core';
import type { CloudDriver, CloudPrice, CloudShape, FoundCluster, FoundInstance, ResourceCounts, ServicePrices } from '../src/cloud/driver.js';
import type { CommandEnvelope } from '@fnndsc/menu';
import { FakeDriver, fakeCloud_sample } from '../src/cloud/fake/driver.js';
import { FakeBuildWorld, FakeCloudBuilder } from '../src/cloud/fake/builder.js';
import { vmCloudInit_render, vmMachineVariables_build, vmModule_zip, vmOs_lower } from '../src/cloud/oci/modules/vm.js';
import { ports_read, vmLimits_derive, vmSpec_dataLoss, vmSpec_diff, vmSpec_read, vmSpecYaml_parse, vmSpecYaml_render, type VmSpec } from '../src/vm/spec.js';
import { VmStore, type VmRecord } from '../src/vm/state.js';
import { vmCost_estimate } from '../src/vm/build.js';
import { NetStore } from '../src/net/state.js';
import { STEPS_SOURCE } from '../src/cluster/steps.js';
import { net_run, type NetCommandContext } from '../src/commands/net.js';
import { sshLine_build, vm_run, type VmCommandContext } from '../src/commands/vm.js';

const plain = (text: string | undefined): string => (text ?? '').replace(/\x1b\[[0-9;]*m/g, '');
const STORE_LINE: string[] = ['--net', 'scratch', '--open', '443,80', '--vcpu', '2', '--memory', '8', '--disk', '50', '--data', '50', '--data-backup', 'daily', '--os', 'ubuntu-26.04'];
const SPEC: VmSpec = { net: 'scratch', open: [80, 443], vcpu: 2, memory: 8, disk: 50, data: 50, dataBackup: 'daily', os: 'ubuntu-26.04' };
const PRICES: CloudPrice[] = [{ shape: 'VM.Standard.E5.Flex', vcpuHour: 0.015, gibHour: 0.002, currency: 'USD' }];
const SERVICE: ServicePrices = { volumeGibMonth: 0.0255, vpuGibMonth: 0.0017, balancerHour: 0, balancerMbpsHour: 0, currency: 'USD' };

/**
 * Options as `options_read` gives them.
 *
 * @param words - `--name value` pairs.
 * @returns The map.
 */
function options_make(words: string[]): Map<string, string> {
  const map: Map<string, string> = new Map();
  for (let i: number = 0; i < words.length; i += 2) map.set(words[i] as string, words[i + 1] as string);
  return map;
}

describe('a VM\'s spec', () => {
  it('reads the portable words, sorting the ports, and keeps what a later line leaves out', () => {
    expect(vmSpec_read(options_make(STORE_LINE), null)).toEqual({ spec: SPEC });
    expect(vmSpec_read(options_make(['--memory', '16']), SPEC)).toEqual({ spec: { ...SPEC, memory: 16 } });
    expect(vmSpec_read(options_make(['--vcpu', '2']), null)).toEqual({ error: '--net <network> is needed (net new declares one)' });
    expect(vmSpec_read(options_make([...STORE_LINE, '--disk', '20']), null)).toEqual({ error: '--disk 20: a whole number from 50 to 32768' });
    expect(vmSpec_read(options_make([...STORE_LINE, '--data-backup', 'hourly']), null)).toEqual({ error: '--data-backup hourly: daily or none' });
    expect(vmSpec_read(options_make([...STORE_LINE, '--os', 'Ubuntu']), null)).toEqual({ error: '--os Ubuntu: a name and a version (ubuntu-26.04)' });
  });

  it('keeps SSH off the internet', () => {
    expect(ports_read('80,443,80')).toEqual({ ports: [80, 443] });
    expect(ports_read('none')).toEqual({ ports: [] });
    expect(ports_read('22')).toEqual({ error: expect.stringContaining('SSH goes through the network\'s bastion') });
  });

  it('round-trips through spec.yaml, says each change, and names the ones that cost the data', () => {
    expect(vmSpecYaml_parse(vmSpecYaml_render('store', SPEC))).toEqual({ spec: SPEC });
    expect(vmSpec_diff(SPEC, { ...SPEC, memory: 16, open: [443] })).toEqual(['open 80,443 → 443', 'memory 8 → 16']);
    expect(vmSpec_dataLoss(SPEC, { ...SPEC, data: 100 })).toEqual([]);
    expect(vmSpec_dataLoss(SPEC, { ...SPEC, data: 40 })).toEqual(['data 50 → 40 (a volume only grows)']);
  });

  it('costs its machine and its data apart, at list price', () => {
    const cost = vmCost_estimate(SPEC, 'VM.Standard.E5.Flex', PRICES, SERVICE);
    expect(cost?.machineHour).toBeCloseTo(0.03 + 0.016 + 50 * 0.0425 / 730, 6);
    expect(cost?.dataHour).toBeCloseTo(50 * 0.0425 / 730, 6);
    expect(vmCost_estimate(SPEC, 'VM.Standard.X9', PRICES, SERVICE)).toBeNull();
  });
});

describe('a VM\'s modules on OCI', () => {
  it('lowers the words: an OCPU to two vCPUs, the OS to OCI\'s name, the ports and cloud-init', () => {
    const variables = vmMachineVariables_build({ name: 'store', region: 'r', compartmentId: 'c', inputs: { os: 'ubuntu-26.04', open: '80,443', vcpu: '2', memory: '8', disk: '50', image: '', sshPublicKey: 'ssh-ed25519 AAA', availabilityDomain: 'ad', volumeId: 'v', subnetId: 's', vcnId: 'n' } });
    expect(variables).toMatchObject({ os_name: 'Canonical Ubuntu', os_version: '26.04', shape: 'VM.Standard.E5.Flex', ocpus: '1', memory_gb: '8', open_ports: '80,443', image_id: '' });
    expect(Buffer.from(variables['user_data'] as string, 'base64').toString()).toBe(vmCloudInit_render([80, 443]));
    expect(vmOs_lower('oracle-9')).toEqual({ error: expect.stringContaining('builds ubuntu only') });
  });

  it('puts Docker on the data volume and opens only the declared ports', () => {
    const init: string = vmCloudInit_render([443]);
    expect(init.startsWith('#cloud-config\n')).toBe(true);
    expect(init).toContain(`'{"data-root": "/srv/data/docker"}'`);
    expect(init).toContain('--dport 443');
    expect(init).not.toContain('--dport 80');
    expect(init).toContain('blkid $dev >/dev/null || mkfs.ext4');
  });

  it('keeps the tenancy\'s own tags out of every comparison, and the address out of the data stack\'s', () => {
    const data: string = vmModule_zip('data').toString('latin1');
    const machine: string = vmModule_zip('machine').toString('latin1');
    expect(data).toContain('ignore_changes = [defined_tags, private_ip_id]');
    expect(data.match(/ignore_changes/g)?.length).toBe(3);
    expect(machine).toContain('metadata["user_data"]');
    expect(machine).toContain('"mise-service" = var.vm_name');
  });
});

describe('vm, over the fake cloud', () => {
  let root: string;
  let store: VmStore;
  let nets: NetStore;
  let world: FakeBuildWorld;
  let context: VmCommandContext;
  let netContext: NetCommandContext;
  let surface: HeadlessSurface & { answers: string[]; asked: string[] };
  let seen: { instances: FoundInstance[]; stacks: Array<FoundCluster & { tagKey: string }> };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'stratus-vm-'));
    store = new VmStore(join(root, 'vms'));
    nets = new NetStore(join(root, 'nets'));
    world = new FakeBuildWorld(0);
    seen = { instances: [], stacks: [] };
    const driver = {
      // What the tenancy runs beside this session's records; none until a test puts some there.
      instances_find: async (): Promise<FoundInstance[]> => seen.instances,
      clusters_find: async (tagKey: string): Promise<FoundCluster[]> => seen.stacks.filter((one: FoundCluster & { tagKey: string }): boolean => one.tagKey === tagKey),
      resources_search: async (): Promise<ResourceCounts> => ({}), prices_list: async (): Promise<CloudPrice[]> => PRICES, servicePrices_get: async (): Promise<ServicePrices> => SERVICE, shapes_list: async (): Promise<CloudShape[]> => (await new FakeDriver(fakeCloud_sample()).shapes_list('us-ashburn-1')) } as unknown as CloudDriver;
    const builder: FakeCloudBuilder = new FakeCloudBuilder(world);
    netContext = { store: nets, driver, builder, region: (): string => 'us-ashburn-1', clientCidr_read: async (): Promise<string> => '134.174.21.21/32' };
    context = { store, nets, driver, builder, region: (): string => 'us-ashburn-1' };
    surface = Object.assign(new HeadlessSurface(), { answers: [] as string[], asked: [] as string[] });
    (surface.capabilities as { tasks?: boolean }).tasks = true;
    surface.prompt = async (request: PromptRequest): Promise<string> => { surface.asked.push(request.message); return surface.answers.shift() ?? ''; };
    surface_set(surface);
    runner_install(new JobRunner(join(root, 'jobs'), [{ id: STEPS_SOURCE, label: 'steps' }]));
    sink_set(new BufferSink());
    await net_run(netContext, ['new', 'scratch', '--cidr', '10.40.0.0/16']);
    surface.answers = ['y'];
    await net_run(netContext, ['build', 'scratch']);
    surface.asked = [];
  });
  afterEach(() => { runner_install(null); surface_set(new HeadlessSurface()); rmSync(root, { recursive: true, force: true }); });

  it('declares protected, says unchanged on the same line, and the change on a different one', async () => {
    expect(plain((await vm_run(context, ['new', 'store', ...STORE_LINE])).rendered)).toBe('store: declared, 2 vCPU · 8 GiB · disk 50 GB · data 50 GB (daily backups) · ubuntu-26.04 · open 80,443 · on scratch, in us-ashburn-1; protected; vm build store builds it\n');
    expect(plain((await vm_run(context, ['new', 'store', ...STORE_LINE])).rendered)).toBe('store: unchanged\n');
    // The status carries the same rows as a model, for a surface's tile, from the records alone.
    expect((await vm_run(context, ['status'])).model).toMatchObject({ kind: 'stratus.vm.status', data: { vms: [{ name: 'store', state: 'declared', region: 'us-ashburn-1', spec: { vcpu: 2, memory: 8, net: 'scratch' }, address: null, inside: null, protected: true, built: null, chris: null }] } });
    expect(plain((await vm_run(context, ['new', 'store', '--memory', '16'])).rendered)).toBe('store: memory 8 → 16\n');
    expect(store.record_read('store')?.protected).toBe(true);
    expect((await vm_run(context, ['new', 'Store', ...STORE_LINE])).renderedErr).toContain('a VM\'s name is a hostname');
  });

  it('costs a VM without declaring it: the same words as vm new, a change on a declared one with its difference', async () => {
    expect(plain((await vm_run(context, ['cost'])).rendered)).toContain('no VM declared');
    const lone = await vm_run(context, ['cost', 'blt', '--vcpu', '2', '--memory', '8', '--disk', '50', '--data', '50', '--data-backup', 'daily', '--os', 'ubuntu-26.04']);
    expect(plain(lone.rendered)).toBe('blt (not declared): 2 vCPU · 8 GiB · disk 50 GB · data 50 GB (daily backups): $0.052 an hour, $37.83 a month (the data alone, kept after a teardown: $0.003 an hour, $2.13 a month)\n');
    // The model under the text: a surface prices a step from it as its levers move.
    expect(lone.model).toMatchObject({ kind: 'stratus.vm.cost', data: { vms: [{ name: 'blt', declared: false, spec: { vcpu: 2, memory: 8, data: 50 }, changes: [], before: null }] } });
    expect((lone.model?.data as { vms: Array<{ cost: { currency: string } }> }).vms[0]?.cost.currency).toBe('USD');
    expect(store.names_list()).toEqual([]);
    expect((await vm_run(context, ['cost', 'blt', '--vcpu', '2'])).renderedErr).toContain('--memory is needed');
    await vm_run(context, ['new', 'store', ...STORE_LINE]);
    expect(plain((await vm_run(context, ['cost', 'store'])).rendered)).toBe('store: 2 vCPU · 8 GiB · disk 50 GB · data 50 GB (daily backups): $0.052 an hour, $37.83 a month (the data alone, kept after a teardown: $0.003 an hour, $2.13 a month)\n');
    const bigger: string = plain((await vm_run(context, ['cost', 'store', '--memory', '16'])).rendered);
    expect(bigger).toMatch(/^store, memory 8 → 16: \$0\.052 → \$0\.\d{3} an hour, \$37\.83 → \$\d+\.\d{2} a month \(\+\$\d+\.\d{2} a month\); nothing declared/);
    expect((await vm_run(context, ['cost', 'store', '--memory', '16'])).model).toMatchObject({ kind: 'stratus.vm.cost', data: { vms: [{ name: 'store', declared: true, spec: { memory: 16 }, changes: ['memory 8 → 16'], before: { currency: 'USD' } }] } });
    expect((await vm_run(context, ['cost'])).model).toMatchObject({ data: { vms: [{ name: 'store', declared: true, changes: [] }] } });
    expect(store.spec_read('store')).toMatchObject({ spec: { memory: 8 } });
    expect(plain((await vm_run(context, ['cost'])).rendered)).toBe('store: 2 vCPU · 8 GiB · disk 50 GB · data 50 GB (daily backups): $0.052 an hour, $37.83 a month (the data alone, kept after a teardown: $0.003 an hour, $2.13 a month)\n');
    expect((await vm_run(context, ['cost', '--memory', '16'])).renderedErr).toContain('vm cost: usage:');
  });

  it('says what the shape sells, in the spec\'s words, from the cloud', async () => {
    expect(plain((await vm_run(context, ['limits'])).rendered)).toBe('shape   VM.Standard.E5.Flex (E5)\nvcpu    2 to 94, in steps of 2\nmemory  1 to 1049 GiB, 0.5 to 32 GiB per vCPU\ndisk    50 to 32768 GB\ndata    50 to 32768 GB, backups daily or none\n');
    expect((await vm_run(context, ['limits', 'store'])).renderedErr).toContain('usage: vm limits');
    expect((await vm_run(context, ['limits'])).model).toEqual({ kind: 'stratus.vm.limits', data: { shape: 'VM.Standard.E5.Flex', family: 'E5', vcpu: { min: 2, max: 94, step: 2 }, memory: { min: 1, max: 1049, perVcpu: { min: 0.5, max: 32 } }, disk: { min: 50, max: 32768 }, data: { min: 50, max: 32768 } } });
    const limits = vmLimits_derive({ name: 'VM.Standard.E5.Flex', family: 'E5', vcpuPerCore: 2, cores: { min: 2, max: 188 }, memoryGib: { min: 1, max: 1536 }, memoryPerVcpuGib: { min: 0.5, max: 32 } });
    expect(limits.vcpu).toEqual({ min: 2, max: 188, step: 2 });
    expect(vmLimits_derive({ name: 'x', family: 'X', vcpuPerCore: 1, cores: { min: 1, max: 8 }, memoryGib: { min: 1, max: 64 } }).memory.perVcpu).toBeNull();
  });

  it('refuses to build on a network that is not built', async () => {
    await vm_run(context, ['new', 'store', ...STORE_LINE, '--net', 'elsewhere']);
    expect((await vm_run(context, ['build', 'store'])).renderedErr).toContain('the network elsewhere is not declared');
  });

  it('builds its data, then its machine, with one question saying the cost; points the address; again, nothing to do', async () => {
    await vm_run(context, ['new', 'store', ...STORE_LINE]);
    surface.answers = ['y'];
    const built = await vm_run(context, ['build', 'store']);
    expect(built.renderedErr ?? '').toBe('');
    expect(surface.asked).toEqual(['vm build store: data 3 to create, 0 to change, 0 to destroy; machine planned once its data stands (2 vCPU, 8 GiB, disk 50 GB). It bills: $0.052 an hour, $37.83 a month (the data alone, kept after a teardown: $0.003 an hour, $2.13 a month). Continue? [y/N]']);
    expect(plain(built.rendered)).toContain('store  built  protected');
    expect(plain(built.rendered)).toContain('address  203.0.113.10');
    expect(store.record_read('store')).toMatchObject({ image: 'ocid1.image.oc1..fake-ubuntu', dataStackRef: 'fake-stack-vmData-store', machineStackRef: 'fake-stack-vmMachine-store', placeId: 'ocid1.compartment.oc1..fake-scratch' });
    expect(world.addressPoints.get('ocid1.publicip.oc1..fake-store')).toBe('ocid1.privateip.oc1..fake-store');
    expect(world.moduleStacks.get('fake-stack-vmMachine-store')?.applied).toMatchObject({ volumeId: 'ocid1.volume.oc1..fake-store', subnetId: 'ocid1.subnet.oc1..fake-scratch', availabilityDomain: 'fake:AD-1', image: 'ocid1.image.oc1..fake-ubuntu' });
    const key: string = join(store.folder_derive('store'), 'ssh', 'id_ed25519');
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(existsSync(join(store.folder_derive('store'), 'ssh', 'known_hosts'))).toBe(false);
    expect(world.moduleStacks.get('fake-stack-vmMachine-store')?.applied?.['sshPublicKey']).toMatch(/^ssh-ed25519 \S+ stratus-store$/);
    surface.asked = [];
    expect(plain((await vm_run(context, ['build', 'store'])).rendered)).toBe('store: built, and the plan reads nothing to do\n');
    expect(surface.asked).toEqual([]);
  });

  it('asks before any apply, and a no changes nothing', async () => {
    await vm_run(context, ['new', 'store', ...STORE_LINE]);
    surface.answers = ['n'];
    expect(plain((await vm_run(context, ['build', 'store'])).rendered)).toContain('stopped before the apply; nothing changed');
    expect(world.moduleStacks.get('fake-stack-vmData-store')?.applied).toBeNull();
    expect(world.moduleStacks.has('fake-stack-vmMachine-store')).toBe(false);
  });

  it('refuses a change to what exists unless --allow-alter', async () => {
    await vm_run(context, ['new', 'store', ...STORE_LINE]);
    surface.answers = ['y'];
    await vm_run(context, ['build', 'store']);
    await vm_run(context, ['new', 'store', '--memory', '16']);
    expect((await vm_run(context, ['build', 'store'])).renderedErr).toContain('the machine plan 0 to create, 1 to change, 0 to destroy: it touches what exists, refused unless vm build store --allow-alter');
  });

  it('opens a shell session on the network\'s bastion and gives the line, under the shell tier', async () => {
    await vm_run(context, ['new', 'store', ...STORE_LINE]);
    surface.answers = ['y'];
    await vm_run(context, ['build', 'store']);
    expect((await vm_run(context, ['shell', 'store'])).renderedErr).toContain('needs the shell tier');
    (surface.capabilities as { shellCommands: boolean }).shellCommands = true;
    const shell = await vm_run(context, ['shell', 'store']);
    expect(plain(shell.rendered)).toContain('-W %h:%p -p 22 ocid1.bastionsession.oc1..fake-1@host.bastion.us-ashburn-1.fake.example" ubuntu@10.40.0.10');
    expect(world.sessions).toEqual([{ bastionId: 'ocid1.bastion.oc1..fake-scratch', privateIp: '10.40.0.10' }]);
    expect(sshLine_build({ sessionId: 's', host: 'h' }, '/k/ssh/id_ed25519', '10.0.0.5')).toBe('ssh -i /k/ssh/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/k/ssh/known_hosts -o ProxyCommand="ssh -i /k/ssh/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/k/ssh/known_hosts -W %h:%p -p 22 s@h" ubuntu@10.0.0.5');
  });

  it('tears down only when unprotected: the machine, keeping the data; --all takes the data on the name typed back', async () => {
    await vm_run(context, ['new', 'store', ...STORE_LINE]);
    surface.answers = ['y'];
    await vm_run(context, ['build', 'store']);
    expect((await vm_run(context, ['teardown', 'store'])).renderedErr).toBe('vm teardown: store: protected (vm protect store off)\n');
    expect(plain((await vm_run(context, ['protect', 'store', 'off'])).rendered)).toBe('store: unprotected: vm teardown store may remove it\n');
    surface.answers = ['y'];
    expect(plain((await vm_run(context, ['teardown', 'store'])).rendered)).toBe('store: its machine is gone; its data and address stay (vm build store makes the machine again over them)\n');
    expect(surface.asked.at(-1)).toContain('keep its data volume, backups and address 203.0.113.10 ($0.003 an hour, $2.13 a month)');
    expect(world.removed).toEqual(['stack fake-stack-vmMachine-store']);
    expect(plain((await vm_run(context, ['store'])).rendered)).toContain('store  data kept');
    surface.answers = ['y'];
    await vm_run(context, ['build', 'store']);
    expect(store.record_read('store')?.built).toEqual(expect.any(String));
    surface.answers = ['stor'];
    expect(plain((await vm_run(context, ['teardown', 'store', '--all'])).rendered)).toContain('stor is not store: nothing removed');
    surface.answers = ['store'];
    expect(plain((await vm_run(context, ['teardown', 'store', '--all'])).rendered)).toBe('store: torn down whole; its spec stays (vm build store builds it again, empty)\n');
    expect(world.removed.slice(-2)).toEqual(['stack fake-stack-vmMachine-store', 'stack fake-stack-vmData-store']);
    expect(store.record_read('store')).toMatchObject({ gone: expect.any(String) });
    expect(store.record_read('store')?.image).toBeUndefined();
    expect(existsSync(join(store.folder_derive('store'), 'spec.yaml'))).toBe(true);
  });

  it('takes a VM another session built over on the first act: records read back from its stacks, protected, then torn down; plan, build and shell refused, the key being elsewhere', async () => {
    // Session A builds the store, then a second session, keeping nothing, finds it in the tenancy.
    await vm_run(context, ['new', 'store', ...STORE_LINE]);
    surface.answers = ['y'];
    await vm_run(context, ['build', 'store']);
    const built: VmRecord = store.record_read('store') as VmRecord;
    const placeId: string = built.placeId as string;
    seen.instances = [{
      name: 'store', id: built.machineOutputs?.['instance_id'] ?? 'ocid1.instance.store', state: 'running', region: 'us-ashburn-1', created: '2026-11-01T21:22:15Z', tags: { 'mise-service': 'store' }, raw: {},
      shape: 'VM.Standard.E5.Flex', zone: 'AD-1', ips: ['10.40.0.10', '203.0.113.10'], vcpus: 2, memoryGib: 8, containerId: placeId,
    }];
    seen.stacks = [{ tagKey: 'mise-net', name: 'scratch', stack: null, compartmentId: placeId, region: 'us-ashburn-1' }];
    const other: VmStore = new VmStore(join(root, 'vms-other'));
    const there: VmCommandContext = { ...context, store: other, nets: new NetStore(join(root, 'nets-other')) };
    // Taken over on the first act, born protected; the lock is lifted as its own line.
    const lifted: CommandEnvelope = await vm_run(there, ['protect', 'store', 'off']);
    expect(plain(lifted.rendered)).toContain('store: taken over from the tenancy (built by another session)');
    expect(plain(lifted.rendered)).toContain('store: unprotected: vm teardown store may remove it');
    expect(other.record_read('store')).toMatchObject({
      takenFrom: expect.any(String), placeId, dataStackRef: 'fake-stack-vmData-store', machineStackRef: 'fake-stack-vmMachine-store',
      machineOutputs: { instance_id: built.machineOutputs?.['instance_id'], private_ip: '10.40.0.10' }, dataOutputs: { public_ip: '203.0.113.10' },
    });
    const read = other.spec_read('store');
    expect(read !== null && 'spec' in read ? read.spec : null).toMatchObject({ net: 'scratch', vcpu: 2, memory: 8 });
    // What needs the machine's SSH key, which the building session keeps, is refused, saying why.
    expect((await vm_run(there, ['build', 'store'])).renderedErr).toContain('vm build: store: taken over from the tenancy: its SSH key is kept by the session that built it');
    expect((await vm_run(there, ['plan', 'store'])).renderedErr).toContain('vm plan: store: taken over from the tenancy');
    // The teardown removes its machine as from the session that built it.
    surface.answers = ['y'];
    expect(plain((await vm_run(there, ['teardown', 'store'])).rendered)).toContain('store: its machine is gone');
    expect(world.removed).toContain('stack fake-stack-vmMachine-store');
    // A VM made outside stratus is read, never taken over.
    seen.instances = [{ ...seen.instances[0]!, name: 'lab-box', id: 'ocid1.instance.lab', tags: {} }];
    expect((await vm_run(there, ['protect', 'lab-box', 'off'])).renderedErr).toContain('vm protect: lab-box: made outside stratus (no mise-service tag): stratus acts only on what it built');
  });

  it('lists the VMs the tenancy runs beside those kept here, and refuses to declare over one (the tenancy is the truth)', async () => {
    const instance = (name: string, tags: Record<string, string>, state: string = 'running'): FoundInstance => ({
      name, id: `ocid1.instance.${name}`, state, region: 'us-ashburn-1', created: '', tags, raw: {}, shape: 'VM.Standard.E5.Flex', zone: 'AD-1',
      ips: ['10.20.0.234', '129.158.63.113'], vcpus: 2, memoryGib: 8, containerId: 'ocid1.compartment.services',
    });
    seen.instances = [
      instance('store', { 'mise-service': 'store' }),
      instance('lab-box', {}, 'stopped'),
      // A cluster's node is the cluster's, never a VM.
      instance('harbor-cp-1', { 'openshift-tags.openshift-resource': 'openshift-resource-infra' }),
    ];
    // A VM whose machine is gone and whose tagged data stack stands.
    seen.stacks = [{ tagKey: 'mise-service', name: 'old', stack: { id: 'ocid1.ormstack.old', state: 'active', compartmentId: 'c' }, compartmentId: null, region: 'us-ashburn-1' }];
    await vm_run(context, ['new', 'mine', '--net', 'scratch', '--vcpu', '2', '--memory', '8', '--disk', '50', '--data', '50', '--os', 'ubuntu-26.04']);
    const status: CommandEnvelope = await vm_run(context, ['status']);
    expect(status.rendered).toContain('store  found running  built by stratus, not kept in this session');
    expect(status.rendered).toContain('lab-box  found stopped  made outside stratus');
    expect(status.rendered).toContain('old  found data only');
    expect(status.rendered).toContain('address  129.158.63.113');
    expect(status.rendered).not.toContain('harbor-cp-1');
    const rows = (status.model as { data: { vms: Array<{ name: string; state: string; found?: { state: string; tagged: boolean } | null }> } }).data.vms;
    expect(rows.map((row) => `${row.name}:${row.state}:${row.found?.state ?? ''}`)).toEqual(['mine:declared:', 'lab-box:found:stopped', 'old:found:data only', 'store:found:running']);
    // A found VM is read by name, and a name the tenancy runs is never declared over.
    expect((await vm_run(context, ['store'])).rendered).toContain('store  found running');
    const over: CommandEnvelope = await vm_run(context, ['new', 'store', '--net', 'scratch', '--vcpu', '2', '--memory', '8', '--disk', '50', '--data', '50', '--os', 'ubuntu-26.04']);
    expect(over.status).toBe('error');
    expect(over.renderedErr).toContain('the tenancy already runs a VM by that name (built by another stratus session)');
    expect(store.record_read('store')).toBeNull();
  });

  it('refuses a verb it does not have, by name', async () => {
    expect((await vm_run(context, ['restart', 'store'])).renderedErr).toBe('vm: restart: not a verb (vm status, new, cost, limits, plan, build, shell, protect, teardown) nor a VM\n');
  });
});
