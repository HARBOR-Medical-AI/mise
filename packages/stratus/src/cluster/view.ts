/**
 * @file A cluster this daemon builds, seen as every cluster is seen: the same
 * shape the tree, `cluster status` and the CLUSTERS tile read for a cluster
 * read from a `harbor-oci` checkout, from its own state on the host.
 *
 * @module
 */
import type { HarborCluster, StepState } from '../checkout/harborOci.js';
import { BUILD_STEPS, STEPS_WRITTEN } from './steps.js';
import type { ClusterRecord, ClusterStore, StepRecord } from './state.js';

/** The compartment step of a cluster adopted in a compartment of its own. */
export const ADOPTED_COMPARTMENT: StepRecord = { state: 'done', note: 'its own compartment, made before adoption' };

/**
 * A built cluster's steps, numbered in build order.
 *
 * @param record - Its state.
 * @returns Every step, with its state and what it rests on.
 */
export function builtSteps_derive(record: ClusterRecord): StepState[] {
  return BUILD_STEPS.map((step: string, index: number): StepState => {
    // An adopted cluster came with its compartment; one adopted before that step existed keeps no record of it.
    const kept: StepRecord | undefined = record.steps[step] ?? (step === 'compartment' && record.adopted !== undefined ? ADOPTED_COMPARTMENT : undefined);
    const evidence: string = kept?.note ?? (STEPS_WRITTEN.includes(step) ? 'not run yet' : 'not a step this session has yet');
    return { folder: `${String(index + 1).padStart(2, '0')}-${step}`, name: step, state: kept?.state ?? 'not done', evidence };
  });
}

/**
 * A built cluster, read now.
 *
 * @param store - The clusters this daemon builds.
 * @param name - The cluster.
 * @returns It, or null when none of that name is kept.
 */
export function builtCluster_read(store: ClusterStore, name: string): HarborCluster | null {
  const record: ClusterRecord | null = store.record_read(name);
  if (record === null) return null;
  return {
    name,
    root: store.folder_derive(name),
    spec: store.spec_read(name)?.text ?? null,
    settings: { CLUSTER_NAME: name, BASE_DOMAIN: record.baseDomain, OCI_REGION: record.region, ...(record.compartmentId !== undefined ? { OCI_COMPARTMENT_OCID: record.compartmentId } : {}) },
    state: { ...record },
    steps: builtSteps_derive(record),
    secrets: store.secrets_list(name),
    cluster: `${name}.${record.baseDomain}`,
    origin: 'built',
  };
}
