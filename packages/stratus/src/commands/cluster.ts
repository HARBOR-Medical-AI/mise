/**
 * @file `cluster`: where each OpenShift cluster's build stands (docs/stratus.adoc, D7).
 *
 * `cluster status [<name>]` prints, per cluster, its address, its checkout,
 * each step with its state and the evidence for it, and how many live
 * resources its compartment holds in the session's region. A bare `cluster`
 * is `cluster status` for every cluster. `new`, `plan`, `build` and `adopt`
 * are in `build.ts`, `verify` in `verify.ts`; any other verb is refused by name.
 *
 * @module
 */
import chalk from 'chalk';
import { envelope_error, envelope_ok, STRATUS_CLUSTERS_MODEL_KIND, type CommandEnvelope, type ClusterSummary, type ClustersModel } from '@fnndsc/menu';
import type { CommandGroup, CommandHelp } from '@fnndsc/brasa/core';
import type { CloudDriver, ResourceCounts } from '../cloud/driver.js';
import { foundCluster_make, foundClusters_describe } from '../cluster/found.js';
import type { HarborCluster, StepState } from '../checkout/harborOci.js';
import type { ClusterTree } from '../vfs/clusters.js';
import { stateTone_paint } from '../vfs/look.js';
import { lastDone_find } from '../checkout/harborOci.js';
import { capacity_run, CAPACITY_HELP } from './capacity.js';
import { spend_line, spend_read, type Spend } from '../cluster/spend.js';
import { spend_run, SPEND_HELP } from './spend.js';
import { clusterAdopt_run, clusterBuild_run, clusterNew_run, clusterPlan_run, type BuildCommandContext } from './build.js';
import { clusterVerify_run, verifyReach_default } from './verify.js';
import { clusterTeardown_run } from './teardown.js';
import { clusterProtect_run } from './protect.js';
import { clusterSize_run } from './size.js';
import { clusterSummary_read } from '../cluster/readout.js';
import type { AnswerCache } from '../cache.js';

/** What `cluster` reads from the session. */
export interface ClusterCommandContext {
  readonly clusters: ClusterTree;
  readonly driver: CloudDriver;
  /** The session's region, or null when not connected. */
  readonly region: () => string | null;
  /** The folder the clusters stand in (`/net/oci/<tenancy>/clusters`). */
  readonly clustersPath: () => string;
  /** What the build verbs run over; absent, `new`, `plan` and `build` refuse. */
  readonly build?: BuildCommandContext;
  /** Where `capacity` keeps the limits it read; absent, every ask reads the cloud. */
  readonly cache?: AnswerCache;
}

/** The order the counted kinds are said in. */
const COUNT_ORDER: ReadonlyArray<keyof ResourceCounts> = ['instances', 'networks', 'subnets', 'securitygroups', 'loadbalancers', 'volumes', 'buckets', 'dns'];

/**
 * A compartment's live resources, and the line that says them or why they
 * could not be counted.
 *
 * @param context - The session.
 * @param compartmentId - The compartment, from the cluster's settings.
 * @param known - Counts already read (a found cluster's), so the cloud is not asked twice.
 * @returns The counts (null when not counted) and the line.
 */
async function compartment_count(context: ClusterCommandContext, compartmentId: string | undefined, known: ResourceCounts | null = null): Promise<{ counts: ResourceCounts | null; line: string }> {
  const region: string | null = context.region();
  if (compartmentId === undefined) return { counts: null, line: 'compartment  not in the cluster\'s settings' };
  if (region === null) return { counts: null, line: 'compartment  not counted: not connected' };
  try {
    const counts: ResourceCounts = known ?? await context.driver.resources_search(compartmentId, region);
    const said: string[] = COUNT_ORDER.filter((kind): boolean => (counts[kind] ?? 0) > 0).map((kind): string => `${counts[kind]} ${kind}`);
    return { counts, line: `compartment  ${said.length > 0 ? said.join(', ') : 'nothing live'} (${region})` };
  } catch (error: unknown) {
    return { counts: null, line: `compartment  not counted: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * What a cluster costs, and the line that says it or why it is not priced.
 *
 * @param context - The session.
 * @param cluster - The cluster.
 * @returns The spend (null when not priced) and the line.
 */
async function clusterCost_read(context: ClusterCommandContext, cluster: HarborCluster): Promise<{ spend: Spend | null; line: string }> {
  const compartmentId: string | undefined = cluster.settings['OCI_COMPARTMENT_OCID'];
  const region: string | null = cluster.settings['OCI_REGION'] ?? context.region();
  if (compartmentId === undefined || region === null) return { spend: null, line: 'cost         not priced: no compartment known' };
  try {
    const spend: Spend = await spend_read(context.driver, compartmentId, region, new Date());
    return { spend, line: `cost         ${spend_line(spend)}` };
  } catch (error: unknown) {
    return { spend: null, line: `cost         not priced: ${error instanceof Error ? error.message : String(error)}` };
  }
}


export { foundCluster_make };

/**
 * The clusters the tenancy holds that this session keeps nothing of: found by
 * the tag on their stacks and compartments and read from the cloud
 * (docs/stratus.adoc, D15). The tenancy is the truth about its clusters; the
 * folder is what this host knows of each.
 *
 * @param context - The session.
 * @param kept - The clusters read from checkouts and the folder.
 * @returns The found clusters, and why the tenancy was not searched when it was not.
 */
async function foundClusters_read(context: ClusterCommandContext, kept: ReadonlyArray<HarborCluster>): Promise<{ clusters: HarborCluster[]; unsearched: string | null }> {
  const region: string | null = context.region();
  if (region === null) return { clusters: [], unsearched: 'not connected' };
  try {
    return { clusters: await foundClusters_describe(context.driver, context.build?.builder ?? null, region, kept.map((cluster: HarborCluster): string => cluster.name)), unsearched: null };
  } catch (error: unknown) {
    return { clusters: [], unsearched: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * One cluster's status: its lines, and its summary for the model.
 *
 * @param context - The session.
 * @param cluster - The cluster.
 * @returns The lines and the summary.
 */
export async function clusterStatus_read(context: ClusterCommandContext, cluster: HarborCluster): Promise<{ lines: string[]; summary: ClusterSummary }> {
  const width: number = Math.max(0, ...cluster.steps.map((step: StepState): number => step.folder.length));
  const found = cluster.found;
  const [compartment, cost] = await Promise.all([compartment_count(context, cluster.settings['OCI_COMPARTMENT_OCID'], found?.resources ?? null), clusterCost_read(context, cluster)]);
  // A found cluster's line: what carries its tag, what the cloud makes of it, and the one line that moves it on.
  const foundLine = (): string => {
    const carried: string = `${found?.stack !== null && found?.stack !== undefined ? `stack ${found.stack.id} (${found.stack.state})` : 'no stack'}${found?.compartmentId !== null && found?.compartmentId !== undefined ? `, compartment ${found.compartmentId}` : ''}`;
    const onward: string = found?.condition === 'GONE' ? `nothing of it is left but its tag: cluster teardown ${cluster.name} removes that` : `not adopted: cluster adopt ${cluster.name} keeps it here`;
    return `found        ${carried}; ${onward}`;
  };
  const lines: string[] = [
    `${chalk.bold(cluster.name)}  ${cluster.cluster ?? '(no cluster name in its settings)'}`,
    cluster.origin === 'found'
      ? foundLine()
      : `${cluster.origin !== 'built' ? 'checkout   ' : (cluster.state as { adopted?: unknown } | null)?.adopted !== undefined ? 'adopted    ' : (cluster.state as { gone?: unknown } | null)?.gone !== undefined ? 'torn down  ' : 'built here '}  ${cluster.root}`,
    ...cluster.steps.map((step: StepState): string => `  ${step.folder.padEnd(width)}  ${stateTone_paint(step.state, step.state.padEnd(8))}  ${chalk.gray(step.evidence)}`),
    compartment.line,
    cost.line,
  ];
  const summary: ClusterSummary = {
    ...clusterSummary_read(context.build?.store ?? null, context.clustersPath(), cluster),
    resources: compartment.counts === null ? null : { ...compartment.counts },
    cost: cost.spend === null ? null : { hourly: cost.spend.hourly, soFar: cost.spend.soFar, currency: cost.spend.currency },
  };
  return { lines, summary };
}

/**
 * Runs `cluster`.
 *
 * @param context - The session.
 * @param args - The words after `cluster`.
 * @returns The envelope.
 */
export async function cluster_run(context: ClusterCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const [verb = 'status', ...rest] = args;
  const builds: Readonly<Record<string, (context: BuildCommandContext, args: ReadonlyArray<string>) => Promise<CommandEnvelope>>> = { new: clusterNew_run, plan: clusterPlan_run, build: clusterBuild_run, adopt: clusterAdopt_run, teardown: clusterTeardown_run, protect: clusterProtect_run, size: clusterSize_run, verify: (build: BuildCommandContext, words: ReadonlyArray<string>) => clusterVerify_run(build, build.verifyReach ?? verifyReach_default(), words) };
  const build = builds[verb];
  const kept: HarborCluster[] = context.clusters.clusters_read();
  if (build !== undefined) {
    if (context.build === undefined) return envelope_error('', undefined, `cluster: ${verb}: this session builds no clusters\n`);
    // A cluster found in the tenancy and not adopted answers reads and `adopt`
    // only; one with nothing left of it but its tag takes `teardown` too, which
    // removes that (docs/stratus.adoc, D15).
    const named: string | undefined = rest.find((word: string): boolean => !word.startsWith('--'));
    if (verb !== 'adopt' && named !== undefined && !kept.some((cluster: HarborCluster): boolean => cluster.name === named)) {
      const found = await foundClusters_read(context, kept);
      const match: HarborCluster | undefined = found.clusters.find((cluster: HarborCluster): boolean => cluster.name === named);
      if (match !== undefined && !(verb === 'teardown' && match.found?.condition === 'GONE')) {
        return envelope_error('', undefined, `cluster ${verb}: ${named}: ${match.found?.condition === 'GONE' ? 'nothing of it is left in the tenancy but its tag: cluster teardown ' + named + ' removes that' : `found in the tenancy, not adopted: cluster adopt ${named} first`}\n`);
      }
    }
    return build(context.build, rest);
  }
  const found = await foundClusters_read(context, kept);
  const all: HarborCluster[] = [...kept, ...found.clusters];
  // `cluster <name>` is that cluster's status: the line the TD controller opens on, and the same line as text in chell.
  if (verb !== 'status' && rest.length === 0 && all.some((cluster: HarborCluster): boolean => cluster.name === verb)) return cluster_run(context, ['status', verb]);
  if (verb !== 'status') return envelope_error('', undefined, `cluster: ${verb}: not a verb this session has yet (cluster status, new, size, plan, build, adopt, verify, protect, teardown)\n`);
  if (all.length === 0) return envelope_ok(`no clusters${found.unsearched === null ? ' here or in the tenancy' : ` here (the tenancy was not searched: ${found.unsearched})`}: cluster new <name> makes one; stratus --cluster <name>=<harbor-oci checkout> reads one\n`, { kind: STRATUS_CLUSTERS_MODEL_KIND, data: { clusters: [] } });
  const chosen: HarborCluster[] = rest.length === 0 ? all : all.filter((cluster: HarborCluster): boolean => rest.includes(cluster.name));
  const missing: string[] = rest.filter((name: string): boolean => !all.some((cluster: HarborCluster): boolean => cluster.name === name));
  if (missing.length > 0) return envelope_error('', undefined, `cluster: ${missing.join(', ')}: no such cluster (${all.map((cluster: HarborCluster): string => cluster.name).join(', ')})\n`);
  const blocks: string[] = [];
  const model: ClustersModel = { clusters: [] };
  for (const cluster of chosen) {
    const read = await clusterStatus_read(context, cluster);
    blocks.push(read.lines.join('\n'));
    model.clusters.push(read.summary);
  }
  if (found.unsearched !== null && rest.length === 0) blocks.push(chalk.gray(`the tenancy was not searched for clusters: ${found.unsearched}`));
  return envelope_ok(`${blocks.join('\n\n')}\n`, { kind: STRATUS_CLUSTERS_MODEL_KIND, data: model });
}

/** `cluster`'s help. */
export const CLUSTER_HELP: CommandHelp = {
  usage: 'cluster [status [<name>…]] | cluster <name> | cluster new <name> [options] | cluster size [--family <family>] | cluster plan [<name>] | cluster build [<name>] [--through <step>] | cluster adopt <name> --from <checkout> | cluster verify [<name>] | cluster protect <name> [on|off] | cluster teardown <name>',
  summary: 'Make, plan, build, and see where each OpenShift cluster stands',
  category: 'Resources',
  description: 'cluster status prints each cluster: those this daemon builds, and those read from a harbor-oci checkout (stratus --cluster <name>=<checkout>), with its address, each build step with its state and the evidence for it, and its compartment\'s live resources in the session\'s region. A bare cluster is cluster status for every cluster, and cluster <name> is that one\'s. cluster new writes a cluster\'s spec and nothing else (--family E5, --plane 3x8/24, --workers 2x8/32 as count x vCPU / GiB, --data, --database, --queue in GiB, --base-domain zone). cluster size reads what a new cluster is sized against in the region: each availability domain\'s free cores and memory for the family, its price, and the spec a new cluster starts from. cluster plan reads only: whether the spec fits each availability domain, what it costs an hour, where the steps stand; the infrastructure plan needs the tasks tier. cluster build runs the steps from the first not done as a task (/proc/steps/<name>-build) and follows it; before the first step that bills it asks, with the plan\'s counts and the cost. Ctrl-C stops following, not the build: wait <name>-build follows it again, kill <name>-build asks it to stop. cluster adopt keeps a cluster harbor-oci built and, with the tasks tier, takes its stack and state into the cloud\'s Resource Manager; an adopted cluster is planned against, never built on. A cluster is born protected: cluster teardown refuses it until cluster protect <name> off, a line of its own, and then still asks for its name typed back. cluster verify runs ten checks against the cluster through its kubeconfig, which stays on the host: nine read, and the block-volume probe, which makes a claim and a pod, runs only with the tasks tier. The cluster\'s files are under ~ (clusters/<name>/); its credentials stay on the host.',
  examples: ['cluster', 'cluster size', 'cluster new trial --workers 2x8/32 --data 100', 'cluster plan trial', 'cluster build trial --through infra-plan', 'cluster build trial', 'cluster adopt harbor --from ~/src/harbor-oci', 'cluster verify harbor', 'cluster protect quay off', 'cat ~/harbor/steps/05-infra-apply/evidence'],
};

/**
 * The stratus backend's commands: `cluster` and `capacity`.
 *
 * @param context - The session.
 * @returns The group to register as the backend's.
 */
export function stratusCommands_make(context: ClusterCommandContext): CommandGroup {
  return {
    envelope: {
      cluster: (args: string[]): Promise<CommandEnvelope> => cluster_run(context, args),
      capacity: (args: string[]): Promise<CommandEnvelope> => capacity_run(context, args),
      spend: (args: string[]): Promise<CommandEnvelope> => spend_run(context, args),
    },
    help: { cluster: CLUSTER_HELP, capacity: CAPACITY_HELP, spend: SPEND_HELP },
    // `capacity` and `spend` read the cloud and change nothing of the session,
    // so they run beside any other line; `cluster` writes a cluster's folder
    // and so, unnamed here, holds the whole session.
    holds: { capacity: [], spend: [] },
  };
}
