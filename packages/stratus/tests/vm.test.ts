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
import type { CloudDriver, CloudPrice, ResourceCounts, ServicePrices } from '../src/cloud/driver.js';
import { FakeBuildWorld, FakeCloudBuilder } from '../src/cloud/fake/builder.js';
import { vmCloudInit_render, vmMachineVariables_build, vmModule_zip, vmOs_lower } from '../src/cloud/oci/modules/vm.js';
import { ports_read, vmSpec_dataLoss, vmSpec_diff, vmSpec_read, vmSpecYaml_parse, vmSpecYaml_render, type VmSpec } from '../src/vm/spec.js';
import { VmStore } from '../src/vm/state.js';
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

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'stratus-vm-'));
    store = new VmStore(join(root, 'vms'));
    nets = new NetStore(join(root, 'nets'));
    world = new FakeBuildWorld(0);
    const driver = { resources_search: async (): Promise<ResourceCounts> => ({}), prices_list: async (): Promise<CloudPrice[]> => PRICES, servicePrices_get: async (): Promise<ServicePrices> => SERVICE } as unknown as CloudDriver;
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
    expect(plain((await vm_run(context, ['new', 'store', '--memory', '16'])).rendered)).toBe('store: memory 8 → 16\n');
    expect(store.record_read('store')?.protected).toBe(true);
    expect((await vm_run(context, ['new', 'Store', ...STORE_LINE])).renderedErr).toContain('a VM\'s name is a hostname');
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

  it('refuses a verb it does not have, by name', async () => {
    expect((await vm_run(context, ['restart', 'store'])).renderedErr).toBe('vm: restart: not a verb (vm status, new, plan, build, shell, protect, teardown)\n');
  });
});
