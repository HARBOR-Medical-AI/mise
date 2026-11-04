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
import type { CloudDriver, FoundCluster, FoundInstance } from '../cloud/driver.js';
import { CLUSTER_TAG } from '../cluster/state.js';
import { NET_TAG } from '../net/state.js';
import { VM_TAG } from './state.js';

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
    found.set(name, { name, tagged: tag !== undefined && tag !== '', instance });
  }
  // A tagged stack with no instance left: the data a default teardown keeps.
  for (const stack of tagged) if (!found.has(stack.name)) found.set(stack.name, { name: stack.name, tagged: true, instance: null });
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
