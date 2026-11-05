/**
 * @file `cluster teardown <name>`: removes what a cluster built here, after
 * showing what goes and asking for the cluster's name (docs/stratus.adoc, D6).
 *
 * @module
 */
import { readFileSync } from 'node:fs';
import chalk from 'chalk';
import { envelope_error, envelope_ok, type CommandEnvelope } from '@fnndsc/menu';
import { repl_question, sink_dataLine, surface_get } from '@fnndsc/brasa/core';
import type { HarborCluster } from '../checkout/harborOci.js';
import { foundClusters_describe, foundRecord_make } from '../cluster/found.js';
import { clusterLock_refresh } from '../cluster/keep.js';
import { SPEC_DEFAULT } from '../cluster/spec.js';
import { TEARDOWN_STEPS, type TeardownStep } from '../cloud/builder.js';
import type { ClusterRecord, TeardownStepRecord } from '../cluster/state.js';
import { teardownJob_id } from '../cluster/steps.js';
import { clusterVolumes_read, teardownRun_make } from '../cluster/teardown.js';
import { clusterState_show, job_runFollowed, type BuildCommandContext } from './build.js';
import { verifyReach_default } from './verify.js';
import { TIER_REFUSAL } from '../tier.js';

/**
 * `cluster teardown <name>`.
 *
 * @param context - The session.
 * @param args - The words after `teardown`.
 * @returns The envelope.
 */
export async function clusterTeardown_run(context: BuildCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  if (args.length !== 1 || (args[0] as string).startsWith('-')) return envelope_error('', undefined, 'cluster teardown: usage: cluster teardown <name>\n');
  const name: string = args[0] as string;
  let cluster: HarborCluster | null = context.clusters.cluster_read(name);
  let record: ClusterRecord | null = context.store.record_read(name);
  const builder = context.builder;
  if (builder === null || builder.teardown_run === undefined) return envelope_error('', undefined, 'cluster teardown: this cloud cannot tear a cluster down yet\n');
  const torn: string | undefined = record?.gone;
  if (cluster === null || record === null || torn !== undefined) {
    // A cluster the session keeps nothing of, or one torn down here whose tag
    // the tenancy still carries (an earlier pass left its stack, bucket or
    // compartment): found with nothing left of it but its tag, its leftovers
    // go without an adoption first (docs/stratus.adoc, D15). Anything else of
    // it is adopted first.
    const alreadyGone = (): CommandEnvelope => envelope_ok(`${name}: already torn down (${(torn ?? '').slice(0, 16)}); nothing of it is left in the tenancy\n`);
    const region: string | null = context.region();
    if (region === null) return torn !== undefined ? alreadyGone() : envelope_error('', undefined, `cluster teardown: ${name}: no such cluster\n`);
    let found: HarborCluster | undefined;
    try {
      found = (await foundClusters_describe(context.driver, builder, region, context.store.names_list().filter((kept: string): boolean => kept !== name))).find((entry: HarborCluster): boolean => entry.name === name);
    } catch (error: unknown) {
      return envelope_error('', undefined, `cluster teardown: ${name}: the tenancy was not searched: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    if (found === undefined) return torn !== undefined ? alreadyGone() : envelope_error('', undefined, `cluster teardown: ${name}: no such cluster\n`);
    if (found.found?.condition !== 'GONE') return envelope_error('', undefined, `cluster teardown: ${name}: found in the tenancy, not adopted: cluster adopt ${name} first\n`);
    if (surface_get().capabilities.tasks !== true) return envelope_error('', undefined, `cluster teardown: ${name}: Operation not permitted: ${TIER_REFUSAL}\n`);
    // The record now carries only what the tenancy still holds (its stack, its compartment): what an earlier pass removed is not asked for again.
    const leftover: ClusterRecord = foundRecord_make(found, new Date().toISOString(), false);
    if (record === null) context.store.create(leftover, found.found.spec ?? SPEC_DEFAULT);
    else context.store.record_write({ ...leftover, created: record.created, ...(record.adopted !== undefined ? { adopted: record.adopted } : {}) });
    cluster = context.clusters.cluster_read(name);
    record = context.store.record_read(name);
    if (cluster === null || record === null) return envelope_error('', undefined, `cluster teardown: ${name}: could not be kept here\n`);
  }
  if (cluster.origin !== 'built') return envelope_error('', undefined, `cluster teardown: ${name}: Operation not permitted: read from a harbor-oci checkout, not built here\n`);
  if (record.gone !== undefined) return envelope_ok(`${name}: already torn down (${record.gone.slice(0, 16)})\n`);
  // The lock as the tenancy keeps it now: one set since on another host stops the teardown here.
  if ((await clusterLock_refresh(builder, context.store, name)).protected !== false) return envelope_error('', undefined, `cluster teardown: ${name}: Operation not permitted: protected (cluster protect ${name} off lifts it, as its own line)\n`);
  if (surface_get().capabilities.tasks !== true) return envelope_error('', undefined, `cluster teardown: ${name}: Operation not permitted: ${TIER_REFUSAL}\n`);
  const stackRef: string | undefined = record.ids['stackRef'];
  const inStack: number | null = stackRef !== undefined && builder.stackResources_count !== undefined ? await builder.stackResources_count({ region: record.region, stackRef }) : null;
  // A teardown that stopped part way runs again from the first step not done:
  // the record keeps each step as it ended. An empty stack with no step kept
  // (a teardown before steps were kept) means an earlier pass destroyed it,
  // the cluster with it, so there is no destroy job and no cluster to ask.
  const kept: Record<string, TeardownStepRecord> = record.teardown?.steps ?? {};
  const done: Set<TeardownStep> = new Set(TEARDOWN_STEPS.filter((step: TeardownStep): boolean => kept[step]?.state === 'done' || kept[step]?.state === 'skipped'));
  if (stackRef !== undefined && inStack === 0) done.add('destroy');
  const stackEmpty: boolean = done.has('destroy');
  // The cluster names its own volumes; read before the destroy takes it away.
  let volumeIds: string[] = [];
  const kubeconfig = cluster.secrets.find((secret): boolean => secret.name === 'kubeconfig');
  if (kubeconfig !== undefined && !stackEmpty) {
    try {
      volumeIds = await clusterVolumes_read((context.verifyReach ?? verifyReach_default()).kube_make(readFileSync(kubeconfig.hostPath, 'utf-8')));
    } catch (error: unknown) {
      return envelope_error('', undefined, `cluster teardown: ${name}: cannot read the cluster's volumes (${error instanceof Error ? error.message : String(error)}): refusing, they would be left billing\n`);
    }
  }
  // Each removal is a step; one an earlier pass finished is listed as such and not asked for again.
  const mark = (step: TeardownStep): string => done.has(step) ? chalk.gray(`  (done ${kept[step]?.ended?.slice(11, 16) ?? 'by an earlier pass'})`) : '';
  const resumes: boolean = record.teardown !== undefined && done.size > 0;
  const lines: string[] = [
    `${chalk.bold(name)}  ${record.baseDomain === '' ? '(no zone known)' : `${name}.${record.baseDomain}`}  teardown${resumes ? chalk.gray(`  (stopped ${record.teardown?.started.slice(0, 16) ?? ''}; resumes at the first step not done)`) : ''}${record.adopted !== undefined ? chalk.gray(`  (adopted from ${record.adopted.from})`) : ''}`,
    `  ${chalk.red('−')} ${stackRef === undefined ? 'no stack: nothing was applied' : stackEmpty ? 'nothing in the stack: an earlier pass destroyed it' : `the stack's ${inStack ?? '?'} resources, by a destroy job`}${mark('destroy')}`,
    ...(record.baseDomain === '' ? [] : [`  ${chalk.red('−')} the DNS records api, api-int and *.apps${mark('dns')}`]),
    ...(record.ids['isoObject'] !== undefined ? [`  ${chalk.red('−')} the image ${record.ids['isoObject']} and its link${mark('image')}`] : []),
    `  ${chalk.red('−')} ${volumeIds.length} volume${volumeIds.length === 1 ? '' : 's'} the cluster made for its claims${kubeconfig === undefined ? ' (no cluster to ask)' : stackEmpty ? ' (the cluster is gone; an earlier pass removed the ones it named)' : ''}, and any block volume left in its compartment with the attribution tag${mark('volumes')}`,
    ...(stackRef !== undefined ? [`  ${chalk.red('−')} the stack itself${mark('stack')}`] : []),
    `  ${chalk.red('−')} its compartment and the image bucket in it when stratus made them (clusters/${name}); another's keeps itself and loses the tag${mark('compartment')}`,
    ...(record.ids['clusterId'] !== undefined ? [`  ${chalk.red('−')} the installer's cluster and infra-env${mark('installer')}`] : []),
    chalk.gray('  Nothing else is touched: the zone, the tag namespace and what other clusters made stay.'),
  ];
  for (const line of lines) sink_dataLine(line);
  const answer: string = (await repl_question(`Destroy what ${name} built? Its data goes with it; billing stops. Type the cluster's name to go on:`)).trim();
  if (answer !== name) return envelope_ok(`${chalk.gray(`not torn down: '${answer}' is not ${name}`)}\n`);
  // The cluster's state is shown as the task starts (TEARING DOWN, with the task to follow), as each step begins and
  // ends, and as it ends (GONE), so a surface watching redraws without asking; the task's own lines stream to whoever follows.
  const shown = (): void => clusterState_show(context, name);
  const ran = await job_runFollowed(teardownJob_id(name), `teardown ${name}`, teardownRun_make(context.store, builder, context.deps?.installer ?? null, name, volumeIds, done, shown), shown);
  clusterState_show(context, name);
  if ('error' in ran) return envelope_error('', undefined, `cluster teardown: ${ran.error}\n`);
  return envelope_ok(`${name}: torn down\n`);
}
