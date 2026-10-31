/**
 * @file OCI resource records as the driver's generic kinds.
 *
 * Every OCI resource answers a display name, an OCID, an upper-case
 * lifecycle state and two tag maps; these become the fields every kind has.
 * What is OCI's own (a VCN's CIDR blocks, an NSG's rules) stays in `raw`,
 * which the tree shows as `info.json`.
 *
 * @module
 */
import type { CloudResource, FoundCluster, ResourceCounts, ResourceKind } from '../driver.js';
import type { OciResourceRecord, OciSearchRecord } from './resourceApi.js';
import { ociTags_flatten } from './driver.js';

/** Resource Search's type names, as the tree's kinds. */
export const OCI_SEARCH_KINDS: Readonly<Record<string, ResourceKind>> = {
  Instance: 'instances',
  Vcn: 'networks',
  Subnet: 'subnets',
  NetworkSecurityGroup: 'securitygroups',
  LoadBalancer: 'loadbalancers',
  Volume: 'volumes',
  BootVolume: 'volumes',
  Bucket: 'buckets',
  CustomerDnsZone: 'dns',
};

/** The states a search leaves out: what is gone. */
const GONE_STATES: ReadonlyArray<string> = ['TERMINATED', 'DELETED'];

/**
 * The fields every kind has, from an OCI record.
 *
 * @param record - The record.
 * @param region - The region it was asked in.
 * @returns The generic resource.
 */
export function resource_convert(record: OciResourceRecord, region: string): CloudResource {
  return {
    name: record.displayName,
    id: record.id,
    state: record.lifecycleState.toLowerCase(),
    region,
    created: record.timeCreated,
    tags: ociTags_flatten(record.freeformTags, record.definedTags),
    raw: record.raw,
  };
}

/**
 * The Resource Search query that counts a compartment's resources of every
 * kind the tree shows.
 *
 * @param compartmentId - The compartment.
 * @returns The structured query.
 */
export function searchQuery_format(compartmentId: string): string {
  const types: string = Object.keys(OCI_SEARCH_KINDS).map((type: string): string => type.toLowerCase()).join(', ');
  return `query ${types} resources where compartmentId = '${compartmentId}'`;
}

/**
 * The search for every carrier of a tag across the tenancy: the stacks and
 * the compartments, which are what a build or an adoption tags with the
 * cluster's name.
 *
 * @param tagKey - The freeform tag's key (`mise-cluster`).
 * @returns The structured query.
 */
export function tagQuery_format(tagKey: string): string {
  return `query ormstack, compartment resources where freeformTags.key = '${tagKey}'`;
}

/** A carrier's state that means it is gone or going. */
const GONE_CARRIER: RegExp = /^(deleted|deleting|terminated|terminating)$/i;

/**
 * The tag's carriers folded into clusters: one per tag value, its stack and
 * its compartment when each carries the tag, sorted by name; a carrier that
 * is gone is left out, and a name with no carrier left is not a cluster.
 *
 * @param hits - The search's hits.
 * @param tagKey - The tag's key.
 * @param region - The region searched.
 * @returns The clusters found.
 */
export function foundClusters_fold(hits: ReadonlyArray<OciSearchRecord>, tagKey: string, region: string): FoundCluster[] {
  const byName: Map<string, { stack: FoundCluster['stack']; compartmentId: string | null }> = new Map();
  for (const hit of hits) {
    const name: string | undefined = hit.freeformTags[tagKey];
    if (name === undefined || name === '' || GONE_CARRIER.test(hit.lifecycleState)) continue;
    const entry = byName.get(name) ?? { stack: null, compartmentId: null };
    if (hit.resourceType.toLowerCase() === 'ormstack') entry.stack = { id: hit.identifier, state: hit.lifecycleState.toLowerCase(), compartmentId: hit.compartmentId };
    else if (hit.resourceType.toLowerCase() === 'compartment') entry.compartmentId = hit.identifier;
    byName.set(name, entry);
  }
  return [...byName.entries()]
    .sort(([a], [b]): number => a.localeCompare(b))
    .map(([name, entry]): FoundCluster => ({ name, stack: entry.stack, compartmentId: entry.compartmentId, region }));
}

/**
 * A search's hits counted by kind, gone resources left out.
 *
 * @param hits - The hits.
 * @returns The counts.
 */
export function searchHits_count(hits: ReadonlyArray<OciSearchRecord>): ResourceCounts {
  const counts: Partial<Record<ResourceKind, number>> = {};
  for (const hit of hits) {
    const kind: ResourceKind | undefined = OCI_SEARCH_KINDS[hit.resourceType];
    if (kind === undefined || GONE_STATES.includes(hit.lifecycleState.toUpperCase())) continue;
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

/**
 * Sorts resources by name, the order every listing keeps.
 *
 * @param resources - The resources.
 * @returns A sorted copy.
 */
export function byName_sort<T extends CloudResource>(resources: ReadonlyArray<T>): T[] {
  return [...resources].sort((a: T, b: T): number => a.name.localeCompare(b.name));
}
