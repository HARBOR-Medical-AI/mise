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
import type { NetStore } from '../net/state.js';
import type { VmSpec } from './spec.js';
import { VM_TAG, type VmRecord, type VmStore } from './state.js';

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
 * Takes a VM the tenancy runs over into this session's records, on the first
 * act on it (the operator, 2026-11-03: nobody adopts a folder before deleting
 * it): its stacks read back from the cloud give its spec and handles, its
 * instance its addresses, and it is born protected here as anywhere, so the
 * lock and the name typed back stay its guards. A VM made outside stratus is
 * refused: stratus acts only on what it built.
 *
 * @param deps - The session's stores, the cloud and the region.
 * @param name - The VM.
 * @returns `taken` with its record, `absent` when the tenancy runs no VM by that name, or why it cannot be taken.
 */
export async function vmTakeover_run(deps: VmTakeoverDeps, name: string): Promise<{ taken: VmRecord } | { absent: true } | { error: string }> {
  const found: FoundVm | undefined = (await vmsFound_read(deps.driver, deps.region)).find((vm: FoundVm): boolean => vm.name === name);
  if (found === undefined) return { absent: true };
  if (!found.tagged) return { error: `${name}: made outside stratus (no ${VM_TAG} tag): stratus acts only on what it built; it is read here, and acted on in the cloud's own console` };
  if (found.placeId === null) return { error: `${name}: the cloud does not say where it stands` };
  if (deps.builder?.moduleStacks_read === undefined) return { error: `${name}: this cloud cannot read a VM's stacks back` };
  const stacks: ModuleStackRead[] = await deps.builder.moduleStacks_read({ region: deps.region, placeId: found.placeId, tag: VM_TAG, owner: name });
  const data: ModuleStackRead | undefined = stacks.find((stack: ModuleStackRead): boolean => stack.module === 'vmData');
  const machine: ModuleStackRead | undefined = stacks.find((stack: ModuleStackRead): boolean => stack.module === 'vmMachine');
  if (data === undefined && machine === undefined) return { error: `${name}: no stack of it was found in its place; nothing to act on` };
  const net: string | undefined = deps.nets.names_list().find((one: string): boolean => deps.nets.record_read(one)?.placeId === found.placeId)
    ?? (await netsFound_read(deps.driver, deps.region)).find((one: FoundNet): boolean => one.compartmentId === found.placeId)?.name;
  if (net === undefined) return { error: `${name}: its network is not found (no ${'mise-net'} tag on its place)` };
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
  const [inside, ...outside] = found.instance?.ips ?? [];
  const taken: VmRecord = deps.store.record_update(name, (current: VmRecord): void => {
    current.placeId = found.placeId as string;
    current.takenFrom = now;
    if (words['image'] !== undefined && words['image'] !== '') current.image = words['image'];
    if (data !== undefined) {
      current.dataStackRef = data.stackRef;
      current.dataOutputs = { ...(outside[0] !== undefined ? { public_ip: outside[0] } : {}), ...(words['volumeId'] ? { volume_id: words['volumeId'] } : {}) };
    }
    if (machine !== undefined && found.instance !== null) {
      current.machineStackRef = machine.stackRef;
      current.machineOutputs = { instance_id: found.instance.id, ...(inside !== undefined ? { private_ip: inside } : {}) };
      current.built = found.instance.created || now;
    } else if (machine === undefined && data !== undefined) {
      current.machineGone = now;
    }
  });
  return { taken };
}
