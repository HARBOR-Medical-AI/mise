/**
 * @file The VMs and networks the tenancy holds, read from the cloud alone
 * (docs/stratus.adoc, D16): the tenancy is the truth about what runs in it,
 * as it is for clusters (D15). A session's records say what it built and how;
 * they never decide what is there. A VM is every instance the tenancy runs
 * outside a cluster, named by stratus's tag when it carries one, else by the
 * cloud's display name; a VM tagged by stratus whose machine is gone and whose
 * data stack stands is found as `data only`. A network is whatever carries
 * stratus's network tag (its stack, its compartment).
 *
 * @module
 */
import type { CloudBuilder, ModuleStackRead } from '../cloud/builder.js';
import type { CloudDriver, FoundCluster, FoundInstance } from '../cloud/driver.js';
import { CLUSTER_TAG } from '../cluster/state.js';
import { NET_TAG } from '../net/state.js';
import type { NetRecord, NetStore } from '../net/state.js';
import type { VmSpec } from './spec.js';
import { VM_TAG, type VmRecord, type VmStore } from './state.js';
import { vmKept_restore } from './keep.js';

/** The tag namespace the OpenShift installer puts on a cluster's own resources; an instance carrying it is a cluster's node. */
const OPENSHIFT_TAG_NAMESPACE: string = 'openshift-tags.';

/** A VM the tenancy runs, as the cloud says it. */
export interface FoundVm {
  /** Stratus's tag value when tagged, else the instance's display name. */
  readonly name: string;
  /** Whether it carries stratus's VM tag. */
  readonly tagged: boolean;
  /** The instance, or null when only its tagged data stack stands. */
  readonly instance: FoundInstance | null;
  /** The place it stands in (its network's compartment), when the cloud says. */
  readonly placeId: string | null;
}

/** A network the tenancy holds by stratus's tag. */
export interface FoundNet {
  readonly name: string;
  readonly stack: FoundCluster['stack'];
  readonly compartmentId: string | null;
}

/**
 * Whether an instance is one of a cluster's nodes, which the cluster lists, not the VMs.
 *
 * @param instance - The instance.
 * @returns True for a node.
 */
function clusterNode_is(instance: FoundInstance): boolean {
  return instance.tags[CLUSTER_TAG] !== undefined || Object.keys(instance.tags).some((key: string): boolean => key.startsWith(OPENSHIFT_TAG_NAMESPACE));
}

/**
 * Every VM the tenancy runs in a region: its instances outside clusters, and
 * the VMs stratus tagged whose data stands without a machine.
 *
 * @param driver - The cloud.
 * @param region - The region.
 * @returns The VMs, sorted by name.
 */
export async function vmsFound_read(driver: CloudDriver, region: string): Promise<FoundVm[]> {
  const [instances, tagged]: [FoundInstance[], FoundCluster[]] = await Promise.all([driver.instances_find(region), driver.clusters_find(VM_TAG, region)]);
  const found: Map<string, FoundVm> = new Map();
  for (const instance of instances) {
    if (clusterNode_is(instance)) continue;
    const tag: string | undefined = instance.tags[VM_TAG];
    const name: string = tag !== undefined && tag !== '' ? tag : instance.name;
    found.set(name, { name, tagged: tag !== undefined && tag !== '', instance, placeId: instance.containerId });
  }
  // A tagged stack with no instance left: the data a default teardown keeps.
  for (const stack of tagged) if (!found.has(stack.name)) found.set(stack.name, { name: stack.name, tagged: true, instance: null, placeId: stack.stack?.compartmentId ?? stack.compartmentId });
  return [...found.values()].sort((a: FoundVm, b: FoundVm): number => a.name.localeCompare(b.name));
}

/**
 * Every network the tenancy holds by stratus's tag in a region.
 *
 * @param driver - The cloud.
 * @param region - The region.
 * @returns The networks, sorted by name.
 */
export async function netsFound_read(driver: CloudDriver, region: string): Promise<FoundNet[]> {
  return (await driver.clusters_find(NET_TAG, region)).map((found: FoundCluster): FoundNet => ({ name: found.name, stack: found.stack, compartmentId: found.compartmentId }));
}

/** What taking a found VM over reads and writes. */
export interface VmTakeoverDeps {
  readonly store: VmStore;
  readonly nets: NetStore;
  readonly driver: CloudDriver;
  readonly builder: CloudBuilder | null;
  readonly region: string;
}

/**
 * A network the tenancy holds that this host keeps no record of, read into
 * the cache from its stack: its range, the address its bastion admits, its
 * place, and what its apply left (the subnet, the VCN, the bastion).
 *
 * @param deps - The stores, the cloud and the region.
 * @param found - The network, as the tenancy holds it.
 * @returns Its name, or why it was not read.
 */
async function netTakeover_run(deps: VmTakeoverDeps, found: FoundNet): Promise<{ net: string } | { error: string }> {
  if (found.compartmentId === null) return { error: `the network ${found.name}: the cloud does not say where it stands` };
  if (deps.builder?.moduleStacks_read === undefined) return { error: `the network ${found.name}: this cloud cannot read a stack back` };
  const stack: ModuleStackRead | undefined = (await deps.builder.moduleStacks_read({ region: deps.region, placeId: found.compartmentId, tag: NET_TAG, owner: found.name }))
    .find((one: ModuleStackRead): boolean => one.module === 'net');
  if (stack === undefined || stack.inputs['cidr'] === undefined || stack.inputs['cidr'] === '') return { error: `the network ${found.name}: no stack of it was found in its place` };
  if (stack.outputs['subnet_id'] === undefined) return { error: `the network ${found.name}: its stack was never applied` };
  deps.nets.declare(found.name, { cidr: stack.inputs['cidr'] }, deps.region);
  const placeId: string = found.compartmentId;
  deps.nets.record_update(found.name, (current: NetRecord): void => {
    current.placeId = placeId;
    current.stackRef = stack.stackRef;
    current.outputs = { ...stack.outputs };
    if (stack.inputs['clientCidr'] !== undefined && stack.inputs['clientCidr'] !== '') current.clientCidr = stack.inputs['clientCidr'];
    current.built = current.built ?? new Date().toISOString();
  });
  return { net: found.name };
}

/**
 * Reads a VM the tenancy runs into this host's cache (docs/stratus.adoc,
 * D16: the tenancy is the truth, a host's records a cache of it): its stacks
 * give its spec and what each apply left, the tenancy's vault its SSH key and
 * its ChRIS's record and passwords, its network is read the same way when
 * this host keeps no record of it. Born protected here as anywhere, so the
 * lock and the name typed back stay its guards. Read again over a cache the
 * tenancy has moved past (the machine rebuilt or resized from another
 * session). A VM made outside stratus is refused: stratus acts only on what
 * it built.
 *
 * @param deps - The session's stores, the cloud and the region.
 * @param name - The VM.
 * @returns `taken` with its record and whether its SSH key was kept in the tenancy, `absent` when the tenancy runs no VM by that name, or why it cannot be read.
 */
export async function vmTakeover_run(deps: VmTakeoverDeps, name: string): Promise<{ taken: VmRecord; keyed: boolean } | { absent: true } | { error: string }> {
  const found: FoundVm | undefined = (await vmsFound_read(deps.driver, deps.region)).find((vm: FoundVm): boolean => vm.name === name);
  if (found === undefined) return { absent: true };
  if (!found.tagged) return { error: `${name}: made outside stratus (no ${VM_TAG} tag): stratus acts only on what it built; it is read here, and acted on in the cloud's own console` };
  if (found.placeId === null) return { error: `${name}: the cloud does not say where it stands` };
  if (deps.builder?.moduleStacks_read === undefined) return { error: `${name}: this cloud cannot read a VM's stacks back` };
  const stacks: ModuleStackRead[] = await deps.builder.moduleStacks_read({ region: deps.region, placeId: found.placeId, tag: VM_TAG, owner: name });
  const data: ModuleStackRead | undefined = stacks.find((stack: ModuleStackRead): boolean => stack.module === 'vmData');
  const machine: ModuleStackRead | undefined = stacks.find((stack: ModuleStackRead): boolean => stack.module === 'vmMachine');
  if (data === undefined && machine === undefined) return { error: `${name}: no stack of it was found in its place; nothing to act on` };
  let net: string | undefined = deps.nets.names_list().find((one: string): boolean => deps.nets.record_read(one)?.placeId === found.placeId);
  if (net === undefined) {
    const holder: FoundNet | undefined = (await netsFound_read(deps.driver, deps.region)).find((one: FoundNet): boolean => one.compartmentId === found.placeId);
    if (holder === undefined) return { error: `${name}: its network is not found (no ${NET_TAG} tag on its place)` };
    const read = await netTakeover_run(deps, holder);
    if ('error' in read) return { error: `${name}: ${read.error}` };
    net = read.net;
  }
  const words = machine?.inputs ?? {};
  const number = (value: string | undefined, fallback: number): number => (value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback);
  const spec: VmSpec = {
    net,
    open: (words['open'] ?? '').split(',').filter((port: string): boolean => port !== '').map(Number).sort((a: number, b: number): number => a - b),
    vcpu: number(words['vcpu'], found.instance?.vcpus ?? 2),
    memory: number(words['memory'], found.instance?.memoryGib ?? 8),
    disk: number(words['disk'], 50),
    data: number(data?.inputs['data'], 50),
    dataBackup: data?.inputs['dataBackup'] === 'daily' ? 'daily' : 'none',
    os: words['os'] !== undefined && words['os'] !== '' ? words['os'] : 'ubuntu-26.04',
  };
  const now: string = new Date().toISOString();
  deps.store.declare(name, spec, deps.region);
  // The stacks hold what was last applied: that is what was built, and declared as of the build, so a newer declaration
  // the vault keeps (from another session or host) reads as declared since, not lost.
  const builtAt: string = found.instance?.created || now;
  // Born protected here as of the build too: a lock the vault keeps, set since, is the newer and is taken.
  deps.store.record_update(name, (current: VmRecord): void => { current.declared = builtAt; current.builtSpec = spec; current.protectedAt = builtAt; });
  const [inside, ...outside] = found.instance?.ips ?? [];
  const placeId: string = found.placeId;
  deps.store.record_update(name, (current: VmRecord): void => {
    current.placeId = placeId;
    current.takenFrom = now;
    // The image pinned at the first build: the stack's variable when it named one, else what its apply made the machine from
    // (a first build asks for the newest); a cache without it would plan the newest image, a new machine.
    const image: string | undefined = words['image'] !== undefined && words['image'] !== '' ? words['image'] : machine?.outputs['image_id'];
    if (image !== undefined && image !== '') current.image = image;
    if (data !== undefined) {
      current.dataStackRef = data.stackRef;
      // What the data's apply left, from its stack's state; the addresses the instance answers when the state says nothing.
      current.dataOutputs = Object.keys(data.outputs).length > 0 ? { ...data.outputs } : { ...(outside[0] !== undefined ? { public_ip: outside[0] } : {}), ...(words['volumeId'] ? { volume_id: words['volumeId'] } : {}) };
    }
    if (machine !== undefined && found.instance !== null) {
      current.machineStackRef = machine.stackRef;
      current.machineOutputs = Object.keys(machine.outputs).length > 0 ? { ...machine.outputs } : { instance_id: found.instance.id, ...(inside !== undefined ? { private_ip: inside } : {}) };
      current.built = found.instance.created || now;
      current.seen = { instanceId: found.instance.id, vcpus: found.instance.vcpus ?? spec.vcpu, memoryGib: found.instance.memoryGib ?? spec.memory };
      delete current.machineGone; delete current.gone;
    } else if (machine === undefined && data !== undefined) {
      delete current.machineStackRef; delete current.machineOutputs; delete current.built; delete current.seen; delete current.host;
      current.machineGone = now;
    }
  });
  const keyed: boolean = await vmKept_restore(deps.builder, deps.store, name, deps.region);
  return { taken: deps.store.record_read(name) as VmRecord, keyed };
}
