/**
 * @file What the TD controller draws of a cluster, read from the host
 * (docs/stratus.adoc, D13): its condition in one word, whether money runs,
 * what it is (built here, adopted, read from a checkout) and what is refused
 * on it, its spec, each step with its times, the build's task while it
 * runs, the last plan counted with drift apart, and the last verify check by
 * check. Nothing here asks the cloud: `cluster status` adds the live counts
 * and the cost, and a build's state event carries this alone.
 *
 * @module
 */
import * as fs from 'fs';
import * as path from 'path';
import { taskState_isOver, type ClusterCondition, type ClusterSummary, type PlanSummary, type VerifyCheckModel } from '@fnndsc/menu';
import { runner_get, type JobRecord } from '@fnndsc/brasa/core';
import { plan_count, type InfraPlan, type PlanRow } from '../cloud/builder.js';
import { lastDone_find, type HarborCluster, type StepState } from '../checkout/harborOci.js';
import type { ClusterRecord, ClusterStore } from './state.js';
import { buildJob_id, FIRST_BILLING_STEP, stepNext_find, STEPS_SOURCE } from './steps.js';

import { VERIFY_FILE, type VerifyKept } from './verify.js';

export { VERIFY_FILE, type VerifyKept };

/** The parts of a summary the controller draws, beyond the tile's glance. */
export type ClusterReadout = Required<Pick<ClusterSummary, 'condition' | 'billing' | 'origin' | 'protected' | 'refused' | 'region' | 'compartment' | 'gone' | 'spec' | 'next' | 'billingStep' | 'running' | 'plan' | 'verify' | 'asking'>>;

/**
 * A step's state, as kept or as read from a checkout.
 *
 * @param cluster - The cluster.
 * @param name - The step.
 * @returns Its state, or `not done`.
 */
function stepState_read(cluster: HarborCluster, name: string): string {
  return cluster.steps.find((step: StepState): boolean => step.name === name)?.state ?? 'not done';
}

/**
 * Where a cluster stands in one word.
 *
 * @param cluster - The cluster.
 * @param record - Its state on the host, or null for one read from a checkout.
 * @param running - Whether its build is running.
 * @param asking - Whether the engine waits on a question about it.
 * @returns The condition.
 */
export function condition_derive(cluster: HarborCluster, record: ClusterRecord | null, running: boolean, asking: boolean): ClusterCondition {
  if (record?.gone !== undefined) return 'GONE';
  // A found cluster keeps no steps here: the cloud said whether its machines live, its stack stands, or nothing is left.
  if (cluster.origin === 'found') return cluster.found?.condition ?? 'STOPPED';
  if (asking) return 'ASKING';
  if (running || cluster.steps.some((step: StepState): boolean => step.state === 'running')) return 'BUILDING';
  if (cluster.steps.some((step: StepState): boolean => step.state === 'failed')) return 'FAILED';
  if (stepState_read(cluster, 'smoke') === 'done') return 'SERVING';
  if (stepState_read(cluster, 'run') === 'done') return 'UP';
  if (cluster.steps.some((step: StepState): boolean => step.state === 'done')) return 'STOPPED';
  return 'SIZING';
}

/**
 * The verbs refused on a cluster, with why, in the words the verbs refuse with.
 *
 * @param cluster - The cluster.
 * @param record - Its state on the host, or null.
 * @returns By verb.
 */
export function refusals_derive(cluster: HarborCluster, record: ClusterRecord | null): Record<string, string> {
  if (cluster.origin === 'found') {
    // Nothing left but its tag: there is nothing to plan, verify or build on, and teardown removes the tag's carriers.
    if (cluster.found?.condition === 'GONE') {
      const why: string = `nothing of it is left in the tenancy but its tag: cluster teardown ${cluster.name} removes that`;
      return { plan: why, verify: why, build: why };
    }
    const why: string = `found in the tenancy, not adopted: cluster adopt ${cluster.name} first`;
    return { plan: why, verify: why, build: why, teardown: why };
  }
  if (cluster.origin !== 'built' || record === null) return { build: 'read from a harbor-oci checkout, not built here', teardown: 'read from a harbor-oci checkout, not built here' };
  if (record.gone !== undefined) return { build: 'torn down', teardown: 'already torn down' };
  // An adopted cluster is never built on; it is torn down as a built one is, once its lock is lifted.
  const build: Record<string, string> = record.adopted !== undefined ? { build: `adopted from ${record.adopted.from}` } : {};
  return record.protected !== false ? { ...build, teardown: `protected (cluster protect ${cluster.name} off lifts it)` } : build;
}

/**
 * The last plan, counted, its rows grouped by action and kind.
 *
 * @param plan - The plan.
 * @param at - When it was made.
 * @returns The summary.
 */
export function planSummary_build(plan: InfraPlan, at: string | null): PlanSummary {
  const counts = plan_count(plan);
  const created: Set<string> = new Set(plan.rows.filter((row: PlanRow): boolean => row.action === 'create').map((row: PlanRow): string => row.name));
  const destroyed: Set<string> = new Set(plan.rows.filter((row: PlanRow): boolean => row.action === 'destroy').map((row: PlanRow): string => row.name));
  const groups: Map<string, PlanSummary['groups'][number]> = new Map();
  for (const row of plan.rows) {
    const replaced: boolean = created.has(row.name) && destroyed.has(row.name);
    if (replaced && row.action === 'destroy') continue;
    const action: string = replaced ? 'replace' : row.action === 'change' && row.drift === true ? 'drift' : row.action;
    const key: string = `${action}\u0000${row.kind}`;
    const group = groups.get(key) ?? { action, kind: row.kind, count: 0, names: [] };
    group.count++;
    group.names.push(row.name);
    groups.set(key, group);
  }
  return { create: counts.create, replace: counts.replace, change: counts.change, drift: counts.drift, destroy: counts.destroy, groups: [...groups.values()], at };
}

/**
 * When one of a cluster's files was written.
 *
 * @param store - The clusters kept.
 * @param name - The cluster.
 * @param file - The file.
 * @returns Its time, or null.
 */
function fileTime_read(store: ClusterStore, name: string, file: string): string | null {
  try {
    return fs.statSync(path.join(store.folder_derive(name), file)).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * What the controller draws of a cluster, from the host.
 *
 * @param cluster - The cluster.
 * @param store - The clusters this daemon keeps, or null when it keeps none.
 * @param job - The build's task, when one was ever started.
 * @param asking - The question the engine waits on about it, or null.
 * @returns The readout.
 */
export function clusterReadout_build(cluster: HarborCluster, store: ClusterStore | null, job: JobRecord | undefined, asking: string | null = null): ClusterReadout {
  const record: ClusterRecord | null = store?.record_read(cluster.name) ?? null;
  const running: boolean = job !== undefined && !taskState_isOver(job.state);
  const runningStep: string | null = cluster.steps.find((step: StepState): boolean => step.state === 'running')?.name ?? null;
  const planText: string | null = store?.file_read(cluster.name, 'plan.json') ?? null;
  const verifyText: string | null = store?.file_read(cluster.name, VERIFY_FILE) ?? null;
  const verify: VerifyKept | null = verifyText === null ? null : JSON.parse(verifyText) as VerifyKept;
  const applied: boolean = stepState_read(cluster, FIRST_BILLING_STEP) === 'done' || lastDone_find(cluster) !== null && (record === null || record.adopted !== undefined);
  return {
    condition: condition_derive(cluster, record, running, asking !== null),
    // A found cluster bills when its machines live; the host attests nothing else of it.
    billing: cluster.origin === 'found' ? cluster.found?.condition === 'UP' : record?.gone === undefined && applied,
    origin: cluster.origin === 'found' ? 'found' : cluster.origin !== 'built' || record === null ? 'checkout' : record.adopted !== undefined ? 'adopted' : 'built',
    protected: record?.protected !== false,
    refused: refusals_derive(cluster, record),
    region: record?.region ?? cluster.settings['OCI_REGION'] ?? null,
    compartment: record?.compartmentId ?? cluster.settings['OCI_COMPARTMENT_OCID'] ?? null,
    gone: record?.gone ?? null,
    spec: store?.spec_read(cluster.name)?.spec ?? cluster.found?.spec ?? null,
    next: record === null || record.adopted !== undefined || record.gone !== undefined ? null : stepNext_find(record),
    billingStep: FIRST_BILLING_STEP,
    running: running ? { job: (job as JobRecord).id, step: runningStep, since: record?.steps[runningStep ?? '']?.started ?? (job as JobRecord).started } : null,
    plan: planText === null || store === null ? null : planSummary_build(JSON.parse(planText) as InfraPlan, fileTime_read(store, cluster.name, 'plan.json')),
    verify: verify === null ? null : { at: verify.at, checks: verify.checks },
    asking,
  };
}

/**
 * A cluster's steps for the model: each with its name, evidence and times.
 *
 * @param cluster - The cluster.
 * @param record - Its state on the host, or null.
 * @returns The steps.
 */
export function summarySteps_map(cluster: HarborCluster, record: ClusterRecord | null): ClusterSummary['steps'] {
  return cluster.steps.map((step: StepState) => ({
    folder: step.folder,
    state: step.state,
    name: step.name,
    evidence: step.evidence,
    started: record?.steps[step.name]?.started ?? null,
    ended: record?.steps[step.name]?.ended ?? null,
  }));
}

/**
 * One cluster's summary as the host knows it, without asking the cloud: the
 * live counts null and the cost absent. What a build's state event carries.
 *
 * @param store - The clusters this daemon keeps, or null.
 * @param clustersPath - The folder the clusters stand in.
 * @param cluster - The cluster.
 * @param asking - The question the engine waits on about it, or null.
 * @returns The summary.
 */
export function clusterSummary_read(store: ClusterStore | null, clustersPath: string, cluster: HarborCluster, asking: string | null = null): ClusterSummary {
  const job: JobRecord | undefined = runner_get()?.job_get(STEPS_SOURCE, buildJob_id(cluster.name));
  return {
    name: cluster.name,
    path: `${clustersPath}/${cluster.name}`,
    cluster: cluster.cluster,
    lastDone: lastDone_find(cluster)?.folder ?? null,
    steps: summarySteps_map(cluster, store?.record_read(cluster.name) ?? null),
    resources: null,
    ...clusterReadout_build(cluster, store, job, asking),
  };
}
