/**
 * @file VMs (docs/stratus.adoc, D16): the spec a `vm new` line takes, its
 * record and key on the host, the two modules' text, variables and
 * cloud-init, the cost, and the verbs end to end over the fake cloud on a
 * built network: declare and compare, build in two stacks with one question,
 * the address pointed, nothing to do again, the shell line, protection, and
 * teardown keeping the data or, with --all, taking it.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BufferSink, HeadlessSurface, JobRunner, runner_install, sink_set, surface_set, type PromptRequest } from '@fnndsc/brasa/core';
import type { CloudBackups, CloudDriver, CloudIngress, CloudPrice, CloudVolume, CloudShape, FoundCluster, FoundInstance, ResourceCounts, ServicePrices } from '../src/cloud/driver.js';
import type { CommandEnvelope } from '@fnndsc/menu';
import { FakeDriver, fakeCloud_sample } from '../src/cloud/fake/driver.js';
import { FakeBuildWorld, FakeCloudBuilder } from '../src/cloud/fake/builder.js';
import { vmCloudInit_render, vmMachineVariables_build, vmModule_zip, vmOs_lower } from '../src/cloud/oci/modules/vm.js';
import { ports_read, vmLimits_derive, vmSpec_dataLoss, vmSpec_diff, vmSpec_read, vmSpecYaml_parse, vmSpecYaml_render, vmStands_diff, type VmSpec } from '../src/vm/spec.js';
import { VmStore, type VmRecord } from '../src/vm/state.js';
import { vmCost_estimate } from '../src/vm/build.js';
import { vmKept_merge, vmKept_write } from '../src/vm/keep.js';
import { lineStatusProviders_make } from '../src/commands/lineStatus.js';
import { vmPlan_judge } from '../src/vm/resize.js';
import { secrets_write } from '../src/chris/secrets.js';
import type { CloudBuilder, InfraPlan, PlanRow } from '../src/cloud/builder.js';
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
    // What a build would change is the declaration against what runs; a size the cloud was not read for says nothing.
    expect(vmStands_diff({ vcpu: 2, memory: 8, disk: 50, data: null }, { ...SPEC, disk: 180, data: 100 })).toEqual(['disk 50 → 180 GB']);
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

describe('a VM plan read for what it does to what stands', () => {
  const plan = (rows: PlanRow[]): InfraPlan => ({ ref: 'p', rows });
  it('passes a size changed in place, ports and backups; refuses a shrink, a replace, a detach and anything else', () => {
    const resized = vmPlan_judge(plan([
      { action: 'change', kind: 'instances', type: 'oci_core_instance', name: 'oci_core_instance.machine', changes: [{ path: 'shape_config.ocpus', before: '1', after: '2' }, { path: 'shape_config.memory_in_gbs', before: '8', after: '16' }, { path: 'source_details.boot_volume_size_in_gbs', before: '50', after: '80' }] },
      { action: 'change', kind: 'volumes', type: 'oci_core_volume', name: 'oci_core_volume.data', changes: [{ path: 'size_in_gbs', before: '50', after: '100' }] },
      { action: 'create', kind: 'securitygroups', type: 'oci_core_network_security_group_security_rule', name: 'r["8080"]' },
      { action: 'destroy', kind: 'securitygroups', type: 'oci_core_network_security_group_security_rule', name: 'r["80"]' },
      { action: 'destroy', kind: 'backuppolicies', type: 'oci_core_volume_backup_policy_assignment', name: 'b' },
      { action: 'change', kind: 'instances', type: 'oci_core_instance', name: 'drifted', drift: true },
    ]));
    expect(resized).toEqual({ refused: [], reboot: true, bootGrow: [50, 80], dataGrow: [50, 100], words: ['2 → 4 vCPU', 'memory 8 → 16 GiB', 'boot disk 50 → 80 GB', 'data 50 → 100 GB', 'a port opened', 'a port closed', 'daily backups off'] });
    const refused = vmPlan_judge(plan([
      { action: 'change', kind: 'volumes', type: 'oci_core_volume', name: 'v', changes: [{ path: 'size_in_gbs', before: '100', after: '50' }] },
      { action: 'destroy', kind: 'attachments', type: 'oci_core_volume_attachment', name: 'a' },
      { action: 'change', kind: 'instances', type: 'oci_core_instance', name: 'm', changes: [{ path: 'display_name', before: 'a', after: 'b' }] },
      { action: 'change', kind: 'instances', type: 'oci_core_instance', name: 'n' },
      { action: 'destroy', kind: 'volumes', type: 'oci_core_volume', name: 'w' }, { action: 'create', kind: 'volumes', type: 'oci_core_volume', name: 'w' },
    ]));
    expect(refused.refused).toEqual([
      'the data volume shrinks 100 → 50 GB (a volume only grows)',
      'the data volume is detached from the machine',
      'm: display_name changes (a → b)',
      'n changes (the plan does not say how)',
      'the data volume is replaced: a new, EMPTY volume',
    ]);
    expect(refused.reboot).toBe(false);
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
    let pricesRead: string | null = null;
    const built = (): FakeDriver => new FakeDriver({ ...fakeCloud_sample(), resources: [] }).built_see(world);
    const driver = {
      // What the tenancy runs beside this session's records; none until a test puts some there.
      // The fake tenancy answers what the fake builder applied (a VM's machine an instance, its stacks and the
      // networks' found by their tags), beside what a test puts there.
      instances_find: async (): Promise<FoundInstance[]> => [...seen.instances, ...[...world.moduleStacks.values()]
        .filter((stack) => stack.module === 'vmMachine' && stack.applied !== null && !seen.instances.some((one) => one.name === stack.owner))
        .map((stack): FoundInstance => ({
          name: stack.owner, id: `ocid1.instance.oc1..fake-${stack.owner}`, state: 'running', region: 'us-ashburn-1', created: '2026-11-01T21:22:15Z', tags: { 'mise-service': stack.owner, ...(world.instanceTags.get(`ocid1.instance.oc1..fake-${stack.owner}`) ?? {}) }, raw: {},
          shape: 'VM.Standard.E5.Flex', zone: 'AD-1', ips: ['10.40.0.10', '203.0.113.10'], vcpus: Number(stack.applied?.['vcpu']), memoryGib: Number(stack.applied?.['memory']), containerId: stack.placeId,
          imageId: stack.applied?.['image'] ?? '', securityGroupIds: [`ocid1.networksecuritygroup.oc1..fake-${stack.owner}`],
        }))],
      // The volumes, the images, the security groups' rules and the backups, as the fake tenancy answers what the builder applied.
      volumes_list: async (place: string, region: string): Promise<CloudVolume[]> => built().volumes_list(place, region),
      image_read: async (imageId: string, region: string): Promise<string | null> => built().image_read(imageId, region),
      ingress_list: async (groupId: string, region: string): Promise<CloudIngress[]> => built().ingress_list(groupId, region),
      backups_read: async (volumeId: string, region: string): Promise<CloudBackups | null> => built().backups_read(volumeId, region),
      clusters_find: async (tagKey: string): Promise<FoundCluster[]> => [...seen.stacks.filter((one: FoundCluster & { tagKey: string }): boolean => one.tagKey === tagKey), ...[...world.moduleStacks.entries()]
        .filter(([, stack]) => stack.tag === tagKey && stack.applied !== null && (stack.module === 'net' || stack.module === 'vmData'))
        .map(([id, stack]): FoundCluster => ({ name: stack.owner, stack: { id, state: 'active', compartmentId: stack.placeId }, compartmentId: stack.placeId, region: 'us-ashburn-1' }))],
      resources_search: async (): Promise<ResourceCounts> => ({}), prices_list: async (): Promise<CloudPrice[]> => { pricesRead = '2026-11-04T23:00:00.000Z'; return PRICES; }, pricesRead_get: (): string | null => pricesRead, servicePrices_get: async (): Promise<ServicePrices> => SERVICE, shapes_list: async (): Promise<CloudShape[]> => (await new FakeDriver(fakeCloud_sample()).shapes_list('us-ashburn-1')) } as unknown as CloudDriver;
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

  /** A ChRIS deployed on a VM, as a deploy leaves it: its record, its passwords, both kept in the tenancy. */
  const chris_seed = async (name: string): Promise<void> => {
    store.record_update(name, (current: VmRecord): void => { current.chris = { profile: 'minimal', compute: name, host: 'cube.example', url: 'https://cube.example/api/v1/', deployed: '2026-11-02T00:00:00Z' }; });
    secrets_write(store, name, { djangoKey: 'd', postgresPassword: 'p', pfconSecretKey: 's', pfconPassword: 'f', adminPassword: 'pw' });
    await vmKept_write(context.builder as CloudBuilder, store, name, 'us-ashburn-1', { log: (): void => undefined, signal: new AbortController().signal });
  };

  it('declares protected, says unchanged on the same line, and the change on a different one', async () => {
    expect(plain((await vm_run(context, ['new', 'store', ...STORE_LINE])).rendered)).toBe('store: declared, 2 vCPU · 8 GiB · disk 50 GB · data 50 GB (daily backups) · ubuntu-26.04 · open 80,443 · on scratch, in us-ashburn-1; protected; vm build store builds it\nkept in the tenancy: every session reads this declaration\n');
    // Unchanged, a MANAGE session still keeps the declaration in the tenancy (one made at READ reaches it this way).
    expect(plain((await vm_run(context, ['new', 'store', ...STORE_LINE])).rendered)).toBe('store: unchanged\nkept in the tenancy: every session reads this declaration\n');
    // The status carries the same rows as a model, for a surface's tile, from the records alone.
    expect((await vm_run(context, ['status'])).model).toMatchObject({ kind: 'stratus.vm.status', data: { vms: [{ name: 'store', state: 'declared', region: 'us-ashburn-1', spec: { vcpu: 2, memory: 8, net: 'scratch' }, address: null, inside: null, protected: true, built: null, chris: null }] } });
    expect(plain((await vm_run(context, ['new', 'store', '--memory', '16'])).rendered)).toBe('store: memory 8 → 16\nkept in the tenancy: every session reads this declaration\n');
    expect(store.record_read('store')?.protected).toBe(true);
    expect((await vm_run(context, ['new', 'Store', ...STORE_LINE])).renderedErr).toContain('a VM\'s name is a hostname');
  });

  it('costs a VM without declaring it: the same words as vm new, a change on a declared one with its difference', async () => {
    expect(plain((await vm_run(context, ['cost'])).rendered)).toContain('no VM declared');
    const lone = await vm_run(context, ['cost', 'blt', '--vcpu', '2', '--memory', '8', '--disk', '50', '--data', '50', '--data-backup', 'daily', '--os', 'ubuntu-26.04']);
    // The first price reads the price list and says so; the session keeps it, so no later price says it again.
    expect(plain(lone.rendered)).toBe('read Oracle\'s price list, kept for this session: every price after this is worked out here\nblt (not declared): 2 vCPU · 8 GiB · disk 50 GB · data 50 GB (daily backups): $0.052 an hour, $37.83 a month (the data alone, kept after a teardown: $0.003 an hour, $2.13 a month)\n');
    // The model under the text: a surface prices a step from it as its levers move.
    expect(lone.model).toMatchObject({ kind: 'stratus.vm.cost', data: { vms: [{ name: 'blt', declared: false, spec: { vcpu: 2, memory: 8, data: 50 }, changes: [], before: null }], pricesRead: '2026-11-04T23:00:00.000Z' } });
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
    // Declared, priced as declared; nothing of it runs, read from the tenancy, so what runs bills nothing.
    expect(plain((await vm_run(context, ['cost'])).rendered)).toMatch(/^store: declared 2 vCPU · 8 GiB · disk 50 GB · data 50 GB \(daily backups\): \$0\.052 an hour, \$37\.83 a month \(the data alone, kept after a teardown: \$0\.003 an hour, \$2\.13 a month\); runs \$0\.000 an hour/);
    expect((await vm_run(context, ['cost'])).model).toMatchObject({ data: { vms: [{ name: 'store', runs: { rate: { machineHour: 0, dataHour: 0 }, at: expect.any(String) } }] } });
    // Built, what runs is priced; its machine torn down, only its kept data bills.
    surface.answers = ['y'];
    await vm_run(context, ['build', 'store']);
    const built = ((await vm_run(context, ['cost'])).model as { data: { vms: Array<{ runs: { rate: { machineHour: number; dataHour: number } } }> } }).data.vms[0]?.runs.rate;
    expect(built?.machineHour).toBeGreaterThan(0);
    expect(built?.dataHour).toBeGreaterThan(0);
    await vm_run(context, ['protect', 'store', 'off']);
    surface.answers = ['y'];
    await vm_run(context, ['teardown', 'store']);
    const kept = ((await vm_run(context, ['cost'])).model as { data: { vms: Array<{ runs: { rate: { machineHour: number; dataHour: number } } }> } }).data.vms[0]?.runs.rate;
    expect(kept).toMatchObject({ machineHour: 0, dataHour: built?.dataHour });
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
    expect(surface.asked).toEqual(['vm build store: data 3 to create, 0 to change, 0 to destroy; machine planned once its data stands (2 vCPU, 8 GiB, disk 50 GB). It bills: $0.052 an hour, $37.83 a month (the data alone, kept after a teardown: $0.003 an hour, $2.13 a month). Already made to plan it, free: its data stack fake-stack-vmData-store; STOP leaves it, and a later build reuses it. Continue? [y/N]']);
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

  it('asks before any apply, naming the free stack its plan made, and a no makes nothing that bills', async () => {
    await vm_run(context, ['new', 'store', ...STORE_LINE]);
    surface.answers = ['n'];
    expect(plain((await vm_run(context, ['build', 'store'])).rendered)).toContain('stopped before the apply; nothing that bills was made (made to plan it, free: its data stack fake-stack-vmData-store; vm build store reuses it)');
    expect(world.moduleStacks.get('fake-stack-vmData-store')?.applied).toBeNull();
    expect(world.moduleStacks.has('fake-stack-vmMachine-store')).toBe(false);
  });

  it('resizes a VM that stands, in place: told it reboots, its filesystems grown after; a replace refused unless --allow-alter', async () => {
    const lines: string[] = [];
    const resizing: VmCommandContext = { ...context, remote_open: async () => ({ run: async (line: string) => { lines.push(line); return { code: 0, stdout: line.includes('/srv/data') ? '  100G\n' : '  80G\n', stderr: '' }; } }) };
    await vm_run(resizing, ['new', 'store', ...STORE_LINE]);
    surface.answers = ['y'];
    await vm_run(resizing, ['build', 'store']);
    await chris_seed('store');
    // More memory and vCPUs reshape the machine, which the cloud reboots: said before the apply, with what runs on it.
    await vm_run(resizing, ['new', 'store', '--vcpu', '4', '--memory', '16']);
    surface.answers = ['y'];
    const reshaped: CommandEnvelope = await vm_run(resizing, ['build', 'store']);
    expect(reshaped.status).toBe('ok');
    expect(surface.asked.at(-1)).toContain('vm build store: 2 → 4 vCPU, memory 8 → 16 GiB. store REBOOTS to take its new shape: it, and ChRIS at https://cube.example/api/v1/, is down for a few minutes.');
    expect(store.record_read('store')?.seen).toMatchObject({ vcpus: 4, memoryGib: 16 });
    expect(lines).toEqual([]);
    // A disk and the data volume grow online, and their filesystems are grown after, so the space appears.
    await vm_run(resizing, ['new', 'store', '--disk', '80', '--data', '100']);
    surface.answers = ['y'];
    const grown: CommandEnvelope = await vm_run(resizing, ['build', 'store']);
    expect(grown.status).toBe('ok');
    expect(surface.asked.at(-1)).toContain('data 50 → 100 GB, boot disk 50 → 80 GB. The filesystems grow after, online, so the space appears.');
    expect(surface.asked.at(-1)).not.toContain('REBOOTS');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('growpart');
    expect(lines[1]).toContain('resize2fs "$dev"');
    expect(store.record_read('store')?.growOwed).toBeUndefined();
    // A filesystem not grown is owed, and the next build grows it though the plan reads nothing to do.
    const failing: VmCommandContext = { ...context, remote_open: async () => ({ run: async () => ({ code: 1, stdout: '', stderr: 'resize2fs: busy' }) }) };
    await vm_run(failing, ['new', 'store', '--data', '120']);
    surface.answers = ['y'];
    expect((await vm_run(failing, ['build', 'store'])).renderedErr).toContain('vm build: store: the disks grew, their filesystems did not: vm-store-grow: failed: growing /srv/data: resize2fs: busy (vm build store grows them again)');
    expect(store.record_read('store')?.growOwed).toEqual({ boot: false, data: true });
    // The data volume grew alone (no machine applied): the build is still done for what was declared.
    expect(store.record_read('store')?.builtSpec).toMatchObject({ data: 120, disk: 80, vcpu: 4 });
    expect(plain((await vm_run(resizing, ['build', 'store'])).rendered)).toContain('store: the plan reads nothing to do; growing the filesystems a build left ungrown');
    expect(store.record_read('store')?.growOwed).toBeUndefined();
    // A shrink and a new OS (a new machine) are refused unless asked by name.
    await vm_run(resizing, ['new', 'store', '--os', 'ubuntu-24.04']);
    expect((await vm_run(resizing, ['build', 'store'])).renderedErr).toContain('vm build: store: the machine plan the machine is replaced: a new machine with a new host key (the data volume stays): refused unless vm build store --allow-alter');
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
    expect(plain((await vm_run(context, ['protect', 'store', 'off'])).rendered)).toBe('store: unprotected: vm teardown store may remove it\nkept in the tenancy: every session reads this lock\n');
    surface.answers = ['y'];
    expect(plain((await vm_run(context, ['teardown', 'store'])).rendered)).toBe('store: its machine is gone; its data and address stay (vm build store makes the machine again over them)\n');
    expect(surface.asked.at(-1)).toContain('keep its data volume, backups and address 203.0.113.10 ($0.003 an hour, $2.13 a month)');
    expect(world.removed).toEqual(['stack fake-stack-vmMachine-store']);
    // Each part is a step on the record, the state shown as each began and ended: the machine gone, the data kept.
    expect(store.record_read('store')?.teardown?.steps).toMatchObject({ machine: { state: 'done', started: expect.any(String), ended: expect.any(String) }, data: { state: 'kept', note: expect.stringContaining('stay') } });
    const row = ((await vm_run(context, ['status'])).model as { data: { vms: Array<{ name: string; teardown?: { steps: Array<{ name: string; state: string }> } | null }> } }).data.vms.find((one) => one.name === 'store');
    expect(row?.teardown?.steps.map((one) => `${one.name}:${one.state}`)).toEqual(['machine:done', 'data:kept']);
    expect(plain((await vm_run(context, ['store'])).rendered)).toContain('store  data kept');
    surface.answers = ['y'];
    await vm_run(context, ['build', 'store']);
    expect(store.record_read('store')?.built).toEqual(expect.any(String));
    surface.answers = ['stor'];
    expect(plain((await vm_run(context, ['teardown', 'store', '--all'])).rendered)).toContain('stor is not store: nothing removed');
    surface.answers = ['store'];
    expect(plain((await vm_run(context, ['teardown', 'store', '--all'])).rendered)).toBe('store: torn down whole; its spec stays (vm build store builds it again, empty)\n');
    expect(world.removed.slice(-2)).toEqual(['stack fake-stack-vmMachine-store', 'stack fake-stack-vmData-store']);
    expect(store.record_read('store')?.teardown?.steps['data']?.state).toBe('done');
    expect(store.record_read('store')).toMatchObject({ gone: expect.any(String) });
    expect(store.record_read('store')?.image).toBeUndefined();
    expect(existsSync(join(store.folder_derive('store'), 'spec.yaml'))).toBe(true);
  });

  it('reads a VM another session built from the tenancy, whole: its stacks, its network, its SSH key and ChRIS from the vault; any host then resizes it', async () => {
    // Session A builds the store and deploys ChRIS on it; a second host, keeping nothing, lists the tenancy.
    await vm_run(context, ['new', 'store', ...STORE_LINE]);
    surface.answers = ['y'];
    await vm_run(context, ['build', 'store']);
    await chris_seed('store');
    const built: VmRecord = store.record_read('store') as VmRecord;
    expect(JSON.parse(world.kept.get('mise-vm-store') ?? '{}')).toMatchObject({ vm: 'store', ssh: { publicKey: expect.stringContaining('stratus-store') }, chris: { record: { url: 'https://cube.example/api/v1/' }, secrets: { adminPassword: 'pw' } } });
    const other: VmStore = new VmStore(join(root, 'vms-other'));
    const otherNets: NetStore = new NetStore(join(root, 'nets-other'));
    const there: VmCommandContext = { ...context, store: other, nets: otherNets, remote_open: async () => ({ run: async () => ({ code: 0, stdout: '100G\n', stderr: '' }) }) };
    const status: CommandEnvelope = await vm_run(there, ['status']);
    // Listed with its records, never as found: the cache filled from the tenancy.
    expect(status.rendered).not.toContain('found');
    expect((status.model as { data: { vms: Array<{ name: string; state: string; keyless?: boolean; chris: { url: string } | null }> } }).data.vms).toMatchObject([{ name: 'store', state: 'built', keyless: false, chris: { url: 'https://cube.example/api/v1/' } }]);
    expect(other.record_read('store')).toMatchObject({
      takenFrom: expect.any(String), placeId: built.placeId, dataStackRef: 'fake-stack-vmData-store', machineStackRef: 'fake-stack-vmMachine-store', protected: true,
      machineOutputs: built.machineOutputs, dataOutputs: built.dataOutputs, chris: { url: 'https://cube.example/api/v1/' }, image: built.image,
    });
    expect(otherNets.record_read('scratch')).toMatchObject({ placeId: built.placeId, outputs: { bastion_id: 'ocid1.bastion.oc1..fake-scratch' }, clientCidr: '134.174.21.21/32' });
    expect(readFileSync(join(other.folder_derive('store'), 'ssh', 'id_ed25519'), 'utf-8')).toBe(readFileSync(join(store.folder_derive('store'), 'ssh', 'id_ed25519'), 'utf-8'));
    expect(JSON.parse(readFileSync(join(other.folder_derive('store'), 'auth', 'chris.json'), 'utf-8'))).toMatchObject({ adminPassword: 'pw' });
    // The second host resizes it as the first would; the first host's cache then reads the tenancy again.
    await vm_run(there, ['new', 'store', '--memory', '16']);
    surface.answers = ['y'];
    expect((await vm_run(there, ['build', 'store'])).status).toBe('ok');
    expect(surface.asked.at(-1)).toContain('memory 8 → 16 GiB. store REBOOTS');
    await vm_run(context, ['status']);
    expect(store.spec_read('store')).toMatchObject({ spec: { memory: 16 } });
    // Torn down whole from either host, the tenancy's keep goes with it, and the other host's cache says so.
    await vm_run(there, ['protect', 'store', 'off']);
    surface.answers = ['store'];
    expect(plain((await vm_run(there, ['teardown', 'store', '--all'])).rendered)).toContain('store: torn down whole');
    expect(world.kept.has('mise-vm-store')).toBe(false);
    await vm_run(context, ['status']);
    expect(store.record_read('store')).toMatchObject({ gone: expect.any(String) });
    // A VM the tenancy keeps no key for (built before keys were kept) is read and torn down, never reached; vm keep, on the host that holds it, keeps it.
    await vm_run(context, ['new', 'old', ...STORE_LINE]);
    surface.answers = ['y'];
    await vm_run(context, ['build', 'old']);
    world.kept.delete('mise-vm-old');
    const third: VmCommandContext = { ...context, store: new VmStore(join(root, 'vms-third')), nets: new NetStore(join(root, 'nets-third')) };
    const keyless = ((await vm_run(third, ['status'])).model as { data: { vms: Array<{ name: string; keyless?: boolean }> } }).data.vms.find((one) => one.name === 'old');
    expect(keyless?.keyless).toBe(true);
    expect((await vm_run(third, ['build', 'old'])).renderedErr).toContain('vm build: old: the tenancy keeps no SSH key for it, and this host holds none');
    expect(plain((await vm_run(context, ['keep', 'old'])).rendered)).toContain('old: its SSH key, what was declared and its lock kept in the tenancy: any session holding its credentials reaches it');
    expect(world.kept.has('mise-vm-old')).toBe(true);
    // A VM made outside stratus is read, never taken over.
    seen.instances = [{ name: 'lab-box', id: 'ocid1.instance.lab', state: 'running', region: 'us-ashburn-1', created: '', tags: {}, raw: {}, shape: 'VM.Standard.E5.Flex', zone: 'AD-1', ips: ['10.0.0.9'], vcpus: 2, memoryGib: 8, containerId: built.placeId as string }];
    expect((await vm_run(there, ['protect', 'lab-box', 'off'])).renderedErr).toContain('vm protect: lab-box: made outside stratus (no mise-service tag): stratus acts only on what it built');
  });

  it('keeps a declaration in the tenancy from a MANAGE session, so another host reads it declared and not built; at READ it stays here and says so', async () => {
    await vm_run(context, ['new', 'store', ...STORE_LINE]);
    surface.answers = ['y'];
    await vm_run(context, ['build', 'store']);
    // A bigger disk declared here reaches the vault with when it was declared.
    expect(plain((await vm_run(context, ['new', 'store', '--disk', '180'])).rendered)).toContain('disk 50 → 180; built: vm build store plans the change and asks\nkept in the tenancy: every session reads this declaration');
    expect(JSON.parse(world.kept.get('mise-vm-store') as string).declared).toMatchObject({ spec: { disk: 180 } });
    // Another host reads the store whole from the tenancy: built at 50, declared 180, and its build line says what a build would change.
    const there: VmCommandContext = { ...context, store: new VmStore(join(root, 'vms-there')), nets: new NetStore(join(root, 'nets-there')) };
    const row = ((await vm_run(there, ['status'])).model as { data: { vms: Array<{ name: string; declaredKept?: boolean; stands?: { vcpu: number | null } | null }> } }).data.vms.find((one) => one.name === 'store');
    expect(there.store.spec_read('store')).toMatchObject({ spec: { disk: 180 } });
    expect(row?.declaredKept).toBe(true);
    expect(row?.stands?.vcpu).toBe(2);
    // The rest of what runs is read from the tenancy too: the ports its security group opens to the internet, its data's backups, its OS.
    expect(row?.stands).toMatchObject({ open: [80, 443], backup: 'daily', os: 'ubuntu-26.04' });
    expect(plain((await vm_run(there, ['store'])).rendered)).toMatch(/runs {6}2 vCPU · 8 GiB · disk 50 GB · data 50 GB · open 80,443 · backups daily · ubuntu-26\.04 {2}\(read from the tenancy \d\d:\d\d UTC\)/);
    const providers = new Map(lineStatusProviders_make({ nets: there.nets, vms: there.store }).map((provider) => [provider.verb, provider]));
    // Every part is compared with what runs, read from the tenancy: the disk as its volume's size.
    expect(await providers.get('vm')?.read(['vm', 'build', 'store'])).toMatchObject({ state: 'changed', detail: 'declared, not built: disk 50 → 180 GB; the build plans and asks' });
    // A port declared since is said against what the security group opens now.
    await vm_run(there, ['new', 'store', '--open', '80,443,8080']);
    expect(await providers.get('vm')?.read(['vm', 'build', 'store'])).toMatchObject({ state: 'changed', detail: 'declared, not built: disk 50 → 180 GB, open 80,443 → 80,443,8080; the build plans and asks' });
    await vm_run(there, ['new', 'store', '--open', '80,443']);
    // A keep written from a host whose declaration is older takes the vault's newer one; nothing it lacks is dropped.
    await vm_run(context, ['new', 'store', '--disk', '200']);
    there.store.record_update('store', (current: VmRecord): void => { current.declared = '2000-01-01T00:00:00.000Z'; });
    await vmKept_write(context.builder as CloudBuilder, there.store, 'store', 'us-ashburn-1', { log: (): void => undefined, signal: new AbortController().signal });
    expect(JSON.parse(world.kept.get('mise-vm-store') as string)).toMatchObject({ declared: { spec: { disk: 200 } }, ssh: { publicKey: expect.any(String) } });
    expect(there.store.spec_read('store')).toMatchObject({ spec: { disk: 200 } });
    // At READ a declaration stays on this host and says so; the vault keeps the last one a MANAGE session made.
    (surface.capabilities as { tasks?: boolean }).tasks = false;
    expect(plain((await vm_run(context, ['new', 'store', '--disk', '220'])).rendered)).toContain('kept on this host only: a session with the tasks tier keeps it in the tenancy');
    expect(JSON.parse(world.kept.get('mise-vm-store') as string).declared.spec.disk).toBe(200);
    (surface.capabilities as { tasks?: boolean }).tasks = true;
    // Two keeps as one: each part from whichever holds it, the newer declaration of the two.
    const spec180: VmSpec = { ...SPEC, disk: 180 };
    expect(vmKept_merge({ vm: 'x', ssh: { privateKey: 'k', publicKey: 'p' }, declared: { spec: spec180, at: '2026-11-05' } }, { vm: 'x', declared: { spec: SPEC, at: '2026-11-04' } }))
      .toEqual({ vm: 'x', ssh: { privateKey: 'k', publicKey: 'p' }, declared: { spec: spec180, at: '2026-11-05' } });
  });

  it('keeps the lock in the tenancy: a lock set on one host holds on another, and stops its teardown there; at READ it stays here and says so', async () => {
    await vm_run(context, ['new', 'store', ...STORE_LINE]);
    surface.answers = ['y'];
    await vm_run(context, ['build', 'store']);
    const there: VmCommandContext = { ...context, store: new VmStore(join(root, 'vms-there')), nets: new NetStore(join(root, 'nets-there')) };
    await vm_run(there, ['status']);
    // Lifted here, the vault keeps it with when; the other host reads it lifted on its next listing.
    expect(plain((await vm_run(context, ['protect', 'store', 'off'])).rendered)).toContain('kept in the tenancy: every session reads this lock');
    expect(JSON.parse(world.kept.get('mise-vm-store') as string).lock).toEqual({ protected: false, at: expect.any(String) });
    const row = async (): Promise<{ protected: boolean; lock?: { at: string; kept: boolean } } | undefined> =>
      ((await vm_run(there, ['status'])).model as { data: { vms: Array<{ name: string; protected: boolean; lock?: { at: string; kept: boolean } }> } }).data.vms.find((one) => one.name === 'store');
    expect(await row()).toMatchObject({ protected: false, lock: { kept: true } });
    expect(plain((await vm_run(there, ['store'])).rendered)).toMatch(/unprotected \(kept in the tenancy, set \d{4}-\d\d-\d\d \d\d:\d\d UTC\)/);
    // Locked again here: the other host, still holding it lifted, is refused its teardown by the vault's newer lock.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await vm_run(context, ['protect', 'store', 'on']);
    expect(there.store.record_read('store')?.protected).toBe(false);
    expect((await vm_run(there, ['teardown', 'store'])).renderedErr).toBe('vm teardown: store: protected (vm protect store off)\n');
    expect(there.store.record_read('store')?.protected).toBe(true);
    // At READ the lock is this host's alone, and the line and the listing say so.
    (surface.capabilities as { tasks?: boolean }).tasks = false;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(plain((await vm_run(there, ['protect', 'store', 'off'])).rendered)).toContain('kept on this host only: a session with the tasks tier keeps the lock in the tenancy');
    expect(JSON.parse(world.kept.get('mise-vm-store') as string).lock.protected).toBe(true);
    expect(await row()).toMatchObject({ protected: false, lock: { kept: false } });
    (surface.capabilities as { tasks?: boolean }).tasks = true;
    expect(vmKept_merge({ vm: 'x', lock: { protected: true, at: '2026-11-05' } }, { vm: 'x', lock: { protected: false, at: '2026-11-04' } })).toEqual({ vm: 'x', lock: { protected: true, at: '2026-11-05' } });
  });

  it('lists the VMs the tenancy runs beside those kept here, and refuses to declare over one (the tenancy is the truth)', async () => {
    const instance = (name: string, tags: Record<string, string>, state: string = 'running'): FoundInstance => ({
      name, id: `ocid1.instance.${name}`, state, region: 'us-ashburn-1', created: '', tags, raw: {}, shape: 'VM.Standard.E5.Flex', zone: 'AD-1',
      ips: ['10.20.0.234', '129.158.63.113'], vcpus: 2, memoryGib: 8, containerId: 'ocid1.compartment.services',
    });
    seen.instances = [
      instance('store', { 'mise-service': 'store', 'mise-chris': 'https://cube.chrisproject.org/api/v1/', 'mise-porter': 'porter.chrisproject.org' }),
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
    expect(status.rendered).toContain('chris    https://cube.chrisproject.org/api/v1/, porter porter.chrisproject.org');
    expect((status.model as { data: { vms: Array<{ name: string; found?: { chris?: { url: string; porter: string | null } | null } | null }> } }).data.vms.find((one) => one.name === 'store')?.found?.chris).toEqual({ url: 'https://cube.chrisproject.org/api/v1/', porter: 'porter.chrisproject.org' });
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
