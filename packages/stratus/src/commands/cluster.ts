/**
 * @file `cluster`: where each OpenShift cluster's build stands (docs/stratus.adoc, D7).
 *
 * `cluster status [<name>]` prints, per cluster, its address, its checkout,
 * each step with its state and the evidence for it, and how many live
 * resources its compartment holds in the session's region. A bare `cluster`
 * is `cluster status` for every cluster. `new`, `plan`, `build` and `adopt`
 * are in `build.ts`, `verify` in `verify.ts`; any other verb is refused by name.
 *
 * Declared in one record (`clusterCommand_make`), its line parsed against the
 * grammar before anything here runs; `stratusCommands_make` registers it with
 * stratus's other commands, each declared in its own module.
 *
 * @module
 */
import chalk from 'chalk';
import { envelope_error, envelope_ok, STRATUS_CLUSTERS_MODEL_KIND, type CommandEnvelope, type ClusterSummary, type ClustersModel } from '@fnndsc/menu';
import { command_declare, declaredCommand_run, type AnyCommandDeclaration, type CommandArguments, type CommandDeclaration, type CommandGrammar, type CommandGroup } from '@fnndsc/brasa/core';
import type { CloudDriver, ResourceCounts } from '../cloud/driver.js';
import { TEARDOWN_STEPS, type TeardownStep } from '../cloud/builder.js';
import type { TeardownRecord } from '../cluster/state.js';
import { foundCluster_make, foundClusters_describe } from '../cluster/found.js';
import type { HarborCluster, StepState } from '../checkout/harborOci.js';
import type { ClusterTree } from '../vfs/clusters.js';
import { stateTone_paint } from '../vfs/look.js';
import { lastDone_find } from '../checkout/harborOci.js';
import { capacityCommand_make } from './capacity.js';
import { spend_line, spend_read, type Spend } from '../cluster/spend.js';
import { spendCommand_make } from './spend.js';
import { clusterAdopt_run, clusterBuild_run, clusterNew_run, clusterPlan_run, type BuildCommandContext } from './build.js';
import { flags_map } from './declared.js';
import { clusterVerify_run, verifyReach_default } from './verify.js';
import { clusterTeardown_run } from './teardown.js';
import { clusterProtect_run } from './protect.js';
import { clusterLock_refresh } from '../cluster/keep.js';
import { clusterSize_run } from './size.js';
import { clusterSummary_read } from '../cluster/readout.js';
import type { AnswerCache } from '../cache.js';
import { netCommand_make, type NetCommandContext } from './net.js';
import { vmCommand_make, type VmCommandContext } from './vm.js';
import { chrisCommand_make, type ChrisCommandContext } from './chris.js';
import { scriptsCommand_make, type ScriptsCommandContext } from './scripts.js';

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
  /** What `net` runs over; absent, the session has no `net`. */
  readonly net?: NetCommandContext;
  /** What `vm` runs over; absent, the session has no `vm`. */
  readonly vm?: VmCommandContext;
  /** What `chris` runs over; absent, the session has no `chris`. */
  readonly chris?: ChrisCommandContext;
  /** The library of scripts; absent, `scripts` is not a word. */
  readonly scripts?: ScriptsCommandContext;
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
  // A checkout names its compartment in its settings; a cluster built here keeps it in its record: either is priced as it runs.
  const compartmentId: string | undefined = cluster.settings['OCI_COMPARTMENT_OCID'] ?? (cluster.state as { compartmentId?: string } | null)?.compartmentId;
  const region: string | null = cluster.settings['OCI_REGION'] ?? context.region();
  // Torn down, nothing of it bills: said as nothing, never as the rate it ran at.
  const gone: string | undefined = (cluster.state as { gone?: string } | null)?.gone;
  if (gone !== undefined) return { spend: { items: [], hourly: 0, soFar: 0, currency: 'USD', unpriced: 0 }, line: `cost         nothing: torn down ${gone.slice(0, 16).replace('T', ' ')}` };
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
/**
 * The teardown's steps as lines, once one has started: each where it stands, in the order they run.
 *
 * @param cluster - The cluster.
 * @param width - The build steps' folder width, matched.
 * @returns The lines, none when no teardown has started.
 */
function teardownLines_make(cluster: HarborCluster, width: number): string[] {
  const teardown: TeardownRecord | undefined = (cluster.state as { teardown?: TeardownRecord } | null)?.teardown;
  if (teardown === undefined) return [];
  return [
    `  teardown ${chalk.gray(`started ${teardown.started.slice(0, 16).replace('T', ' ')}`)}`,
    ...TEARDOWN_STEPS.map((name: TeardownStep): string => {
      const step = teardown.steps[name];
      const state: string = step?.state ?? 'not done';
      return `  ${`− ${name}`.padEnd(width)}  ${stateTone_paint(state, state.padEnd(8))}  ${chalk.gray(step?.note ?? '')}`;
    }),
  ];
}

export async function clusterStatus_read(context: ClusterCommandContext, cluster: HarborCluster): Promise<{ lines: string[]; summary: ClusterSummary }> {
  const width: number = Math.max(0, ...cluster.steps.map((step: StepState): number => step.folder.length));
  const found = cluster.found;
  // A cluster built here keeps its compartment in its record, a checkout in its settings: either is counted in the tenancy.
  const compartmentId: string | undefined = cluster.settings['OCI_COMPARTMENT_OCID'] ?? (cluster.state as { compartmentId?: string } | null)?.compartmentId;
  // The lock as the tenancy keeps it (a lock set on another host holds here), read before the summary draws it.
  if (cluster.origin === 'built' && context.build !== undefined && context.build.store.record_read(cluster.name) !== null) await clusterLock_refresh(context.build.builder, context.build.store, cluster.name);
  const [compartment, cost] = await Promise.all([compartment_count(context, compartmentId, found?.resources ?? null), clusterCost_read(context, cluster)]);
  const countedAt: string = new Date().toISOString();
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
    ...teardownLines_make(cluster, width),
    compartment.line,
    cost.line,
  ];
  const summary: ClusterSummary = {
    ...clusterSummary_read(context.build?.store ?? null, context.clustersPath(), cluster),
    resources: compartment.counts === null ? null : { ...compartment.counts },
    resourcesAt: compartment.counts === null ? null : countedAt,
    cost: cost.spend === null ? null : { hourly: cost.spend.hourly, soFar: cost.spend.soFar, currency: cost.spend.currency },
  };
  return { lines, summary };
}

/**
 * The status of every cluster, or of those named: those kept here and those
 * the tenancy holds, a cluster torn down whole said in a line of its own.
 *
 * @param context - The session.
 * @param names - The clusters named; none, every one.
 * @param byName - The line was `cluster <name>`, which is also where a word that names nothing is refused.
 * @returns The envelope.
 */
async function clusterStatus_answer(context: ClusterCommandContext, names: ReadonlyArray<string>, byName: boolean): Promise<CommandEnvelope> {
  const kept: HarborCluster[] = context.clusters.clusters_read();
  // A cluster torn down here is the tenancy's to list again: found by what still carries its tag, it stands as found
  // (GONE until that is removed, D15); with nothing of it left it is history, not a cluster: its record stays on disk,
  // it is listed nowhere, and the status says so in a line at the end.
  const torn = (cluster: HarborCluster): boolean => (cluster.state as { gone?: unknown } | null)?.gone !== undefined;
  const standing: HarborCluster[] = kept.filter((cluster: HarborCluster): boolean => !torn(cluster));
  const found = await foundClusters_read(context, standing);
  const foundNames: Set<string> = new Set(found.clusters.map((cluster: HarborCluster): string => cluster.name));
  const history: HarborCluster[] = kept.filter((cluster: HarborCluster): boolean => torn(cluster) && !foundNames.has(cluster.name));
  const all: HarborCluster[] = [...standing, ...found.clusters];
  const historyLine: string = history.length === 0 ? '' : `\n${chalk.gray(`torn down and gone: ${history.map((cluster: HarborCluster): string => cluster.name).join(', ')} (the record stays in ${history.map((cluster: HarborCluster): string => cluster.root).join(', ')})`)}`;
  // A cluster torn down whole is history in the text, but the model carries it as GONE, so a screen coming back shows
  // where its loop ended (its teardown's blocks, nothing billing), as the VM list keeps a VM torn down whole.
  const historyRows = (): ClusterSummary[] => history.map((cluster: HarborCluster): ClusterSummary => ({ ...clusterSummary_read(context.build?.store ?? null, context.clustersPath(), cluster), resources: null, resourcesAt: null, cost: { hourly: 0, soFar: 0, currency: 'USD' } }));
  // A cluster torn down whole answers too: where its loop ended (torn down, when; nothing bills), never 'no such cluster'.
  const wentNamed: string | undefined = names.length === 1 ? names[0] : undefined;
  const went: HarborCluster | undefined = history.find((cluster: HarborCluster): boolean => cluster.name === wentNamed);
  if (went !== undefined && !all.some((cluster: HarborCluster): boolean => cluster.name === went.name)) {
    const gone: string = ((went.state as { gone?: string } | null)?.gone ?? '').slice(0, 16).replace('T', ' ');
    return envelope_ok(`${chalk.bold(went.name)}  torn down whole ${gone}; nothing of it stands or bills (the record stays in ${went.root})\n`, { kind: STRATUS_CLUSTERS_MODEL_KIND, data: { clusters: historyRows().filter((row: ClusterSummary): boolean => row.name === went.name) } });
  }
  // `cluster <name>` is that cluster's status (the line the TD controller opens on); a word naming none is no verb either.
  if (byName && !all.some((cluster: HarborCluster): boolean => cluster.name === names[0])) {
    return envelope_error('', undefined, `cluster: ${names[0] ?? ''}: not a verb this session has yet (cluster status, new, size, plan, build, adopt, verify, protect, teardown)\n`);
  }
  if (all.length === 0) return envelope_ok(`no clusters${found.unsearched === null ? ' here or in the tenancy' : ` here (the tenancy was not searched: ${found.unsearched})`}: cluster new <name> makes one; stratus --cluster <name>=<harbor-oci checkout> reads one${historyLine}\n`, { kind: STRATUS_CLUSTERS_MODEL_KIND, data: { clusters: names.length === 0 ? historyRows() : [] } });
  const chosen: HarborCluster[] = names.length === 0 ? all : all.filter((cluster: HarborCluster): boolean => names.includes(cluster.name));
  const missing: string[] = names.filter((name: string): boolean => !all.some((cluster: HarborCluster): boolean => cluster.name === name));
  if (missing.length > 0) return envelope_error('', undefined, `cluster: ${missing.join(', ')}: no such cluster (${all.map((cluster: HarborCluster): string => cluster.name).join(', ')})\n`);
  const blocks: string[] = [];
  const model: ClustersModel = { clusters: [] };
  for (const cluster of chosen) {
    const read = await clusterStatus_read(context, cluster);
    blocks.push(read.lines.join('\n'));
    model.clusters.push(read.summary);
  }
  if (found.unsearched !== null && names.length === 0) blocks.push(chalk.gray(`the tenancy was not searched for clusters: ${found.unsearched}`));
  if (names.length === 0) model.clusters.push(...historyRows());
  return envelope_ok(`${blocks.join('\n\n')}${historyLine}\n`, { kind: STRATUS_CLUSTERS_MODEL_KIND, data: model });
}

/** A cluster, as a line names it. */
const CLUSTER_OPERAND = { name: 'name', kind: 'cluster', summary: 'The cluster' } as const;

/** The same, left out for the only one. */
const ONLY_CLUSTER_OPERAND = { name: 'name', kind: 'cluster', optional: true, summary: 'The cluster; none, the only one' } as const;

/** `cluster new`'s options, by property, and the flag each is. */
const NEW_FLAGS: Readonly<Record<string, string>> = {
  family: '--family', plane: '--plane', workers: '--workers', data: '--data', database: '--database', queue: '--queue', baseDomain: '--base-domain', compartment: '--compartment',
};

/** What a `cluster` line may hold. */
const CLUSTER_GRAMMAR = {
  operands: [{ name: 'name', kind: 'cluster', optional: true, summary: 'A cluster: cluster <name> is its status' }],
  bare: { summary: 'Every cluster\'s status: those built here, read from a checkout, or found in the tenancy' },
  subcommands: {
    status: { summary: 'Where each cluster stands: its steps, its compartment\'s live resources, its cost', operands: [{ name: 'names', kind: 'cluster', optional: true, repeat: true, summary: 'The clusters; none, every one' }] },
    new: {
      summary: 'Write a cluster\'s spec and nothing else (or compare with the one kept)',
      operands: [{ name: 'name', kind: 'word', summary: 'Its name, a DNS label' }],
      options: {
        family: { long: 'family', summary: 'The shape family (E5)', value: { name: 'family', kind: 'word' } },
        plane: { long: 'plane', summary: 'The control plane, count x vCPU / GiB (3x8/24)', value: { name: 'nodes', kind: 'word' } },
        workers: { long: 'workers', summary: 'The workers, count x vCPU / GiB (2x8/32)', value: { name: 'nodes', kind: 'word' } },
        data: { long: 'data', summary: 'ChRIS\'s data, in GiB', value: { name: 'GiB', kind: 'word' } },
        database: { long: 'database', summary: 'The database\'s volume, in GiB', value: { name: 'GiB', kind: 'word' } },
        queue: { long: 'queue', summary: 'The queue\'s volume, in GiB', value: { name: 'GiB', kind: 'word' } },
        baseDomain: { long: 'base-domain', summary: 'The DNS zone the cluster\'s names live under', value: { name: 'zone', kind: 'word' } },
        compartment: { long: 'compartment', summary: 'The compartment it lives in', value: { name: 'ocid', kind: 'word' } },
      },
    },
    size: { summary: 'What a new cluster is sized against in the region', options: { family: { long: 'family', summary: 'The shape family (default E5)', value: { name: 'family', kind: 'word' } } } },
    plan: { summary: 'Whether the spec fits, what it costs, where the steps stand', operands: [ONLY_CLUSTER_OPERAND] },
    build: {
      summary: 'Run the steps from the first not done, as a task, asking before the first that bills',
      operands: [ONLY_CLUSTER_OPERAND],
      options: { through: { long: 'through', summary: 'Stop after this step', value: { name: 'step', kind: 'word' } } },
    },
    adopt: {
      summary: 'Keep a cluster harbor-oci built, or one the tenancy holds',
      operands: [{ ...CLUSTER_OPERAND, kind: 'word' }],
      options: {
        from: { long: 'from', summary: 'The harbor-oci checkout it was built from', value: { name: 'checkout', kind: 'hostPath' } },
        stackCompartment: { long: 'stack-compartment', summary: 'The compartment its stack goes to', value: { name: 'ocid', kind: 'word' } },
      },
    },
    verify: { summary: 'Run the ten checks against the cluster through its kubeconfig', operands: [ONLY_CLUSTER_OPERAND] },
    protect: {
      summary: 'Say whether teardown is refused, or set it',
      operands: [CLUSTER_OPERAND, { name: 'setting', kind: 'enum', values: ['on', 'off'], optional: true, summary: 'on refuses teardown; off lets it ask for the name' }],
    },
    teardown: { summary: 'Remove a cluster not protected, its name typed back first', operands: [CLUSTER_OPERAND] },
  },
} as const satisfies CommandGrammar;

/** The build verbs' lines. */
type BuildLine = Exclude<CommandArguments<typeof CLUSTER_GRAMMAR>, { readonly subcommand: null | 'status' }>;

/**
 * The cluster a build verb's line names, if any.
 *
 * @param args - The line.
 * @returns The name, or undefined.
 */
function buildLine_named(args: BuildLine): string | undefined {
  return args.subcommand === 'size' ? undefined : args.operands.name;
}

/**
 * Runs one build verb's line over the session's builds.
 *
 * @param context - The session.
 * @param build - What the build verbs run over.
 * @param args - The line.
 * @returns The envelope.
 */
async function buildLine_run(context: ClusterCommandContext, build: BuildCommandContext, args: BuildLine): Promise<CommandEnvelope> {
  switch (args.subcommand) {
    case 'new': return clusterNew_run(build, args.operands.name, flags_map(args.options, NEW_FLAGS));
    case 'size': return clusterSize_run(build, args.options.family);
    case 'plan': return clusterPlan_run(build, args.operands.name);
    case 'build': return clusterBuild_run(build, args.operands.name, args.options.through);
    case 'adopt': return clusterAdopt_run(build, args.operands.name, args.options.from, args.options.stackCompartment);
    case 'verify': return clusterVerify_run(build, build.verifyReach ?? verifyReach_default(), args.operands.name);
    case 'protect': return clusterProtect_run(build, args.operands.name, args.operands.setting);
    case 'teardown': return clusterTeardown_run(build, args.operands.name);
  }
}

/**
 * Runs one `cluster` line.
 *
 * @param context - The session.
 * @param args - The line, parsed.
 * @returns The envelope.
 */
async function clusterLine_run(context: ClusterCommandContext, args: CommandArguments<typeof CLUSTER_GRAMMAR>): Promise<CommandEnvelope> {
  if (args.subcommand === null) return clusterStatus_answer(context, args.operands.name === undefined ? [] : [args.operands.name], args.operands.name !== undefined);
  if (args.subcommand === 'status') return clusterStatus_answer(context, args.operands.names, false);
  if (context.build === undefined) return envelope_error('', undefined, `cluster: ${args.subcommand}: this session builds no clusters\n`);
  // A cluster found in the tenancy and not adopted answers reads and `adopt`
  // only; one with nothing left of it but its tag takes `teardown` too, which
  // removes that (docs/stratus.adoc, D15).
  const named: string | undefined = buildLine_named(args);
  const kept: HarborCluster[] = context.clusters.clusters_read();
  if (args.subcommand !== 'adopt' && named !== undefined && !kept.some((cluster: HarborCluster): boolean => cluster.name === named)) {
    const found = await foundClusters_read(context, kept);
    const match: HarborCluster | undefined = found.clusters.find((cluster: HarborCluster): boolean => cluster.name === named);
    if (match !== undefined && !(args.subcommand === 'teardown' && match.found?.condition === 'GONE')) {
      return envelope_error('', undefined, `cluster ${args.subcommand}: ${named}: ${match.found?.condition === 'GONE' ? 'nothing of it is left in the tenancy but its tag: cluster teardown ' + named + ' removes that' : `found in the tenancy, not adopted: cluster adopt ${named} first`}\n`);
    }
  }
  return buildLine_run(context, context.build, args);
}

/**
 * `cluster`: the declaration, over the session's clusters.
 *
 * @param context - The session.
 * @returns The declaration.
 *
 * @example
 * ```ts
 * commands_register({ declarations: [clusterCommand_make(context)] }, 'backend');
 * ```
 */
export function clusterCommand_make(context: ClusterCommandContext): CommandDeclaration<typeof CLUSTER_GRAMMAR> {
  return command_declare({
    name: 'cluster',
    grammar: CLUSTER_GRAMMAR,
    help: {
      summary: 'Make, plan, build, and see where each OpenShift cluster stands',
      category: 'Resources',
      description: 'cluster status prints each cluster: those this daemon builds, and those read from a harbor-oci checkout (stratus --cluster <name>=<checkout>), with its address, each build step with its state and the evidence for it, and its compartment\'s live resources in the session\'s region. A bare cluster is cluster status for every cluster, and cluster <name> is that one\'s. cluster new writes a cluster\'s spec and nothing else (--family E5, --plane 3x8/24, --workers 2x8/32 as count x vCPU / GiB, --data, --database, --queue in GiB, --base-domain zone). cluster size reads what a new cluster is sized against in the region: each availability domain\'s free cores and memory for the family, its price, and the spec a new cluster starts from. cluster plan reads only: whether the spec fits each availability domain, what it costs an hour, where the steps stand; the infrastructure plan needs MANAGE at the door (the tasks tier). cluster build runs the steps from the first not done as a task (/proc/steps/<name>-build) and follows it; before the first step that bills it asks, with the plan\'s counts and the cost. Ctrl-C stops following, not the build: wait <name>-build follows it again, kill <name>-build asks it to stop. cluster adopt keeps a cluster harbor-oci built and, with the tasks tier, takes its stack and state into the cloud\'s Resource Manager; an adopted cluster is planned against, never built on. A cluster is born protected: cluster teardown refuses it until cluster protect <name> off, a line of its own, and then still asks for its name typed back. cluster verify runs ten checks against the cluster through its kubeconfig, which stays on the host: nine read, and the block-volume probe, which makes a claim and a pod, runs only with the tasks tier. The cluster\'s files are under ~ (clusters/<name>/); its credentials stay on the host.',
      examples: ['cluster', 'cluster size', 'cluster new trial --workers 2x8/32 --data 100', 'cluster plan trial', 'cluster build trial --through infra-plan', 'cluster build trial', 'cluster adopt harbor --from ~/src/harbor-oci', 'cluster verify harbor', 'cluster protect quay off', 'cat ~/harbor/steps/05-infra-apply/evidence'],
    },
    handler: (args): Promise<CommandEnvelope> => clusterLine_run(context, args),
  });
}

/**
 * `cluster` over words already split: the declaration's parse and handler.
 *
 * @param context - The session.
 * @param args - The words after `cluster`.
 * @returns The envelope, or the refusal of a bad line.
 *
 * @example
 * ```ts
 * await cluster_run(context, ['status', 'harbor']);
 * ```
 */
export async function cluster_run(context: ClusterCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  return declaredCommand_run(clusterCommand_make(context), [...args]);
}

/**
 * The stratus backend's commands, each declared in one record: `cluster`,
 * `capacity`, `spend` and, when the session has them, `net`, `vm`, `chris`
 * and `scripts`.
 *
 * @param context - The session.
 * @returns The group to register as the backend's.
 *
 * @example
 * ```ts
 * commands_register(stratusCommands_make(context), 'backend');
 * ```
 */
export function stratusCommands_make(context: ClusterCommandContext): CommandGroup {
  const declarations: AnyCommandDeclaration[] = [clusterCommand_make(context), capacityCommand_make(context), spendCommand_make(context)];
  if (context.net !== undefined) declarations.push(netCommand_make(context.net));
  if (context.vm !== undefined) declarations.push(vmCommand_make(context.vm));
  if (context.chris !== undefined) declarations.push(chrisCommand_make(context.chris));
  if (context.scripts !== undefined) declarations.push(scriptsCommand_make(context.scripts));
  return { declarations };
}
