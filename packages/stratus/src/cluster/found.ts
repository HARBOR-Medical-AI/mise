/**
 * @file A cluster found in the tenancy by its tag, read from the cloud
 * alone (docs/stratus.adoc, D15): the tenancy is the truth about its clusters,
 * and what the cloud says of one is shown before anyone adopts it. Its
 * address and spec come from its stack's variables, its condition from what
 * lives in its compartment and what its stack still holds. Adoption is where
 * a session takes responsibility for acting on it; seeing never waits on it.
 *
 * @module
 */
import type { CloudBuilder } from '../cloud/builder.js';
import type { CloudDriver, FoundCluster, ResourceCounts } from '../cloud/driver.js';
import type { HarborCluster, StepState } from '../checkout/harborOci.js';
import type { ClusterSpec } from './spec.js';
import { CLUSTER_TAG, type ClusterRecord } from './state.js';
import { BUILD_STEPS, FIRST_BILLING_STEP } from './steps.js';

/** Where a found cluster stands, from the cloud: machines live, something of its stack stands, or nothing is left but its tag. */
export type FoundCondition = 'UP' | 'STOPPED' | 'GONE';

/** What the cloud says of a found cluster, beside what carries its tag. */
export interface FoundRead {
  readonly stack: FoundCluster['stack'];
  readonly compartmentId: string | null;
  /** The zone its stack's variables name, else the tenancy's only zone, else null. */
  readonly baseDomain: string | null;
  /** The spec its stack's variables say, or null when the stack said no sizes or there is none. */
  readonly spec: ClusterSpec | null;
  /** Its compartment's live resources, or null when not counted. */
  readonly resources: ResourceCounts | null;
  /** How many resources its stack's state holds, when asked (nothing live), or null. */
  readonly stackResources: number | null;
  readonly condition: FoundCondition;
}

/**
 * A found cluster as the verbs read one, before the cloud is asked anything
 * more: no spec, no steps, no secrets; its compartment the tagged one, else
 * the stack's.
 *
 * @param found - What the search found.
 * @returns The cluster.
 */
export function foundCluster_make(found: FoundCluster): HarborCluster {
  const compartmentId: string | null = found.compartmentId ?? found.stack?.compartmentId ?? null;
  return {
    name: found.name,
    root: found.stack?.id ?? compartmentId ?? '',
    spec: null,
    settings: { CLUSTER_NAME: found.name, OCI_REGION: found.region, ...(compartmentId !== null ? { OCI_COMPARTMENT_OCID: compartmentId } : {}) },
    state: null,
    steps: [],
    secrets: [],
    cluster: null,
    origin: 'found',
    found: { stack: found.stack, compartmentId: found.compartmentId, baseDomain: null, spec: null, resources: null, stackResources: null, condition: 'STOPPED' },
  };
}

/**
 * A found cluster's steps, as far as the cloud attests them: its compartment
 * when one carries the tag, the apply when machines live. The rest is
 * unknown while it is up (the host keeps no record; adopting and verifying
 * tells), and not done when nothing of it is left.
 *
 * @param read - What the cloud said.
 * @returns Every step, in build order.
 */
export function foundSteps_derive(read: FoundRead): StepState[] {
  const instances: number = read.resources?.instances ?? 0;
  return BUILD_STEPS.map((step: string, index: number): StepState => {
    const folder: string = `${String(index + 1).padStart(2, '0')}-${step}`;
    if (step === 'compartment') return { folder, name: step, state: read.compartmentId !== null ? 'done' : 'not done', evidence: read.compartmentId !== null ? `found ${read.compartmentId}` : 'no compartment carries the tag' };
    if (step === FIRST_BILLING_STEP && read.condition === 'UP') return { folder, name: step, state: 'done', evidence: `${instances} instance${instances === 1 ? '' : 's'} live in its compartment` };
    if (read.condition === 'GONE') return { folder, name: step, state: 'not done', evidence: 'nothing of it is left in the tenancy' };
    return { folder, name: step, state: 'unknown', evidence: 'the cloud does not say; adopt it and verify to know' };
  });
}

/**
 * Reads a found cluster from the cloud: its stack's variables for the zone
 * and the spec, its compartment's live resources, and when nothing lives
 * there, whether its stack still holds anything.
 *
 * @param found - What the search found.
 * @param driver - The cloud's read half.
 * @param builder - Its build half, which reads stacks, or null.
 * @returns The cluster, described.
 */
export async function foundCluster_describe(found: FoundCluster, driver: CloudDriver, builder: CloudBuilder | null): Promise<HarborCluster> {
  const bare: HarborCluster = foundCluster_make(found);
  const compartmentId: string | null = bare.settings['OCI_COMPARTMENT_OCID'] ?? null;
  let baseDomain: string | null = null;
  let spec: ClusterSpec | null = null;
  if (found.stack !== null && builder?.stack_describe !== undefined) {
    try {
      const described = await builder.stack_describe(found.stack.id, found.region);
      baseDomain = described.baseDomain;
      spec = described.spec;
    } catch {
      // A stack that cannot be read leaves the address and spec unknown; the cluster is still shown.
    }
  }
  if (baseDomain === null && builder?.zones_list !== undefined) {
    try {
      const zones: string[] = await builder.zones_list(found.region);
      if (zones.length === 1) baseDomain = zones[0] as string;
    } catch {
      // No zone known.
    }
  }
  let resources: ResourceCounts | null = null;
  if (compartmentId !== null) {
    try { resources = await driver.resources_search(compartmentId, found.region); } catch { resources = null; }
  }
  const instances: number = resources?.instances ?? 0;
  let stackResources: number | null = null;
  if (instances === 0 && found.stack !== null && builder?.stackResources_count !== undefined) {
    try { stackResources = await builder.stackResources_count({ region: found.region, stackRef: found.stack.id }); } catch { stackResources = null; }
  }
  const condition: FoundCondition = instances > 0 ? 'UP' : found.stack === null || stackResources === 0 ? 'GONE' : 'STOPPED';
  const read: FoundRead = { stack: found.stack, compartmentId, baseDomain, spec, resources, stackResources, condition };
  return {
    ...bare,
    settings: { ...bare.settings, ...(baseDomain !== null ? { BASE_DOMAIN: baseDomain } : {}) },
    steps: foundSteps_derive(read),
    cluster: baseDomain !== null ? `${found.name}.${baseDomain}` : null,
    found: read,
  };
}

/**
 * The record a session keeps of a found cluster when it takes it on: by
 * `cluster adopt`, or by the teardown of one with nothing left but its tag.
 * The compartment step is done when one carries the tag, the apply when
 * machines live; the rest the host never saw.
 *
 * @param cluster - The found cluster, described.
 * @param now - The clock.
 * @param protect - Whether it is born protected (adoption) or not (a teardown of what is left).
 * @returns The record.
 */
export function foundRecord_make(cluster: HarborCluster, now: string, protect: boolean): ClusterRecord {
  const read: HarborCluster['found'] = cluster.found;
  const compartmentId: string | null = read?.compartmentId ?? read?.stack?.compartmentId ?? null;
  const instances: number = read?.resources?.instances ?? 0;
  const steps: ClusterRecord['steps'] = { compartment: { state: 'done', ended: now, note: compartmentId === null ? 'no compartment tagged' : `found ${compartmentId}` } };
  if (instances > 0) steps[FIRST_BILLING_STEP] = { state: 'done', ended: now, note: `${instances} instance${instances === 1 ? '' : 's'} live in its compartment` };
  return {
    name: cluster.name, created: now, region: cluster.settings['OCI_REGION'] ?? '', baseDomain: read?.baseDomain ?? '', steps,
    ids: read?.stack !== null && read?.stack !== undefined ? { stackRef: read.stack.id } : {},
    ...(compartmentId !== null ? { compartmentId } : {}),
    adopted: { from: 'the tenancy', at: now },
    protected: protect,
  };
}

/**
 * The clusters the tenancy holds that a session keeps nothing of, each read
 * from the cloud.
 *
 * @param driver - The cloud's read half.
 * @param builder - Its build half, or null.
 * @param region - The session's region.
 * @param kept - The names the session keeps, which stand in for found ones.
 * @returns The found clusters, sorted by name.
 */
export async function foundClusters_describe(driver: CloudDriver, builder: CloudBuilder | null, region: string, kept: ReadonlyArray<string>): Promise<HarborCluster[]> {
  const found: FoundCluster[] = await driver.clusters_find(CLUSTER_TAG, region);
  return Promise.all(found.filter((entry: FoundCluster): boolean => !kept.includes(entry.name)).map((entry: FoundCluster): Promise<HarborCluster> => foundCluster_describe(entry, driver, builder)));
}
