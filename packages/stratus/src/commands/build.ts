/**
 * @file `cluster new`, `cluster plan` and `cluster build`: making a cluster's
 * spec, saying what it would take and cost, and building it (docs/stratus.adoc,
 * D6, D7, D10).
 *
 * `cluster new` writes the spec and nothing else. `cluster plan` reads only,
 * without the `tasks` tier: the fit per availability domain, the hourly cost
 * from the price list, where the steps stand; it says by name that the
 * infrastructure plan needs the tier. `cluster build` starts the cluster's run
 * in the core's runner and follows it; the run stops before the first step
 * that bills, and the command asks the operator, with the plan's counts and
 * the cost, before it goes on. Ctrl-C stops following, not the build.
 *
 * @module
 */
import chalk from 'chalk';
import { envelope_error, envelope_ok, STRATUS_CLUSTER_STATE_EVENT, taskState_isOver, type CommandEnvelope } from '@fnndsc/menu';
import {
  commandCancellation_enable, commandCancellation_signalGet, JobRefusal, repl_confirm, repl_question, repl_questionHidden, runner_get, sink_dataLine, sink_get, surface_get,
  type JobRecord, type JobRunner,
} from '@fnndsc/brasa/core';
import type { CloudDriver, CloudPrice, CloudShape, FoundCluster } from '../cloud/driver.js';
import { planCounts_alter, plan_count, planCounts_words, type CloudBuilder, type InfraPlan } from '../cloud/builder.js';
import { adoption_keep, adoptRun_make, checkout_read, type CheckoutRead } from '../cluster/adopt.js';
import { foundCluster_describe, foundRecord_make } from '../cluster/found.js';
import type { InstallerAccountKeeper } from '../installer/account.js';
import type { VerifyReach } from './verify.js';
import type { HarborCluster } from '../checkout/harborOci.js';
import type { ClusterTree } from '../vfs/clusters.js';
import { CLUSTER_NAME, CLUSTER_TAG, type ClusterRecord, type ClusterStore } from '../cluster/state.js';
import { SPEC_DEFAULT, specOptions_apply, type ClusterSpec } from '../cluster/spec.js';
import { cost_words, familyShape_find, specCost_compute, specFit_read, type SpecCost, type ZoneFit } from '../cluster/sizing.js';
import { clusterSummary_read } from '../cluster/readout.js';
import { BUILD_STEPS, buildJob_id, buildRun_make, FIRST_BILLING_STEP, planRun_make, stepNext_find, STEPS_SOURCE, STEPS_WRITTEN, type BuildDeps } from '../cluster/steps.js';

/** What the build verbs read from the session. */
export interface BuildCommandContext {
  readonly clusters: ClusterTree;
  readonly store: ClusterStore;
  readonly driver: CloudDriver;
  /** The session's region, or null when not connected. */
  readonly region: () => string | null;
  /** What the steps run over, or null when this cloud cannot build yet. */
  readonly deps: BuildDeps | null;
  /** The cloud's build half, for adopting and planning, or null when it has none. */
  readonly builder: CloudBuilder | null;
  /** How `verify` reaches a cluster; the network when absent. */
  readonly verifyReach?: VerifyReach;
  /** The DNS zone a new cluster's names live under when `--base-domain` is not given. */
  readonly baseDomain: string | null;
  /** Where the installer's account is kept; a build asks for it when it is missing. */
  readonly account?: InstallerAccountKeeper;
  /** The folder the clusters stand in (`/net/oci/<tenancy>/clusters`), for the state event's paths. */
  readonly clustersPath?: () => string;
}

/**
 * Shows a cluster as the host knows it, as a `stratus.cluster.state` event: at
 * a build's start, on each line it logs and before each question,
 * so a surface watching (the TD controller) redraws without asking.
 *
 * @param context - The session.
 * @param name - The cluster.
 * @param asking - The question about to be put, or null.
 */
export function clusterState_show(context: BuildCommandContext, name: string, asking: string | null = null): void {
  const cluster: HarborCluster | null = context.clusters.cluster_read(name);
  if (cluster === null) return;
  sink_get().event_write?.(STRATUS_CLUSTER_STATE_EVENT, clusterSummary_read(context.store, context.clustersPath?.() ?? '', cluster, asking));
}

/** The options `cluster new` takes, each with a value. */
const NEW_OPTIONS: ReadonlyArray<string> = ['--family', '--plane', '--workers', '--data', '--database', '--queue', '--base-domain', '--compartment'];

/**
 * Reads `--name value` and `--name=value` pairs.
 *
 * @param words - The words.
 * @param known - The options taken.
 * @returns The options and the other words, or the word refused.
 */
export function options_read(words: ReadonlyArray<string>, known: ReadonlyArray<string>): { options: Map<string, string>; rest: string[] } | { error: string } {
  const options: Map<string, string> = new Map();
  const rest: string[] = [];
  for (let i: number = 0; i < words.length; i++) {
    const word: string = words[i] as string;
    if (!word.startsWith('-')) { rest.push(word); continue; }
    const name: string = word.includes('=') ? word.slice(0, word.indexOf('=')) : word;
    if (!known.includes(name)) return { error: `${name}: unknown option` };
    const value: string | undefined = word.includes('=') ? word.slice(word.indexOf('=') + 1) : words[++i];
    if (value === undefined || value === '') return { error: `${name} takes a value` };
    options.set(name, value);
  }
  return { options, rest };
}

/**
 * A spec in a line.
 *
 * @param spec - The spec.
 * @returns `E5 · plane 3 × 8 vCPU 24 GiB · …`.
 */
export function spec_line(spec: ClusterSpec): string {
  const workers: string = spec.workers.count === 0 ? 'workers 0 (compact)' : `workers ${spec.workers.count} × ${spec.workers.vcpu} vCPU ${spec.workers.ramGib} GiB`;
  return `${spec.family} · plane ${spec.controlPlane.count} × ${spec.controlPlane.vcpu} vCPU ${spec.controlPlane.ramGib} GiB · ${workers} · ChRIS data ${spec.chris.dataGib} GiB`;
}

/**
 * The DNS zones the tenancy holds, by name; none when the cloud cannot say.
 *
 * @param context - The session.
 * @param region - The region the calls go through.
 * @returns The zones' names.
 */
export async function dnsZones_read(context: BuildCommandContext, region: string): Promise<string[]> {
  if (context.builder?.zones_list === undefined) return [];
  try {
    return await context.builder.zones_list(region);
  } catch {
    return [];
  }
}

/**
 * The zone a new cluster's names live under when none is named: the session's,
 * else the tenancy's only one; null when there is none, or several to choose
 * between.
 *
 * @param context - The session.
 * @param zones - The tenancy's zones.
 * @returns The zone, or null.
 */
export function baseDomain_default(context: BuildCommandContext, zones: ReadonlyArray<string>): string | null {
  return context.baseDomain ?? (zones.length === 1 ? zones[0] as string : null);
}

/**
 * `cluster new <name> [options]`.
 *
 * @param context - The session.
 * @param args - The words after `new`.
 * @returns The envelope.
 */
export async function clusterNew_run(context: BuildCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const read = options_read(args, NEW_OPTIONS);
  if ('error' in read) return envelope_error('', undefined, `cluster new: ${read.error} (${NEW_OPTIONS.join(', ')})\n`);
  const [name, ...extra] = read.rest;
  if (name === undefined || extra.length > 0) return envelope_error('', undefined, 'cluster new: usage: cluster new <name> [--family E5] [--plane 3x8/24] [--workers 2x8/32] [--data GiB] [--base-domain zone] [--compartment ocid]\n');
  if (!CLUSTER_NAME.test(name)) return envelope_error('', undefined, `cluster new: ${name}: a cluster's name is a DNS label: lower-case letters, digits and '-', starting with a letter, at most 54\n`);
  if (context.clusters.cluster_read(name) !== null) return envelope_error('', undefined, `cluster new: ${name}: File exists\n`);
  const region: string | null = context.region();
  if (region === null) return envelope_error('', undefined, 'cluster new: not connected\n');
  // The zone is found where it lives (D14): named, it must be one the tenancy holds; unnamed, the tenancy's only one.
  const zones: string[] = await dnsZones_read(context, region);
  const named: string | undefined = read.options.get('--base-domain');
  if (named !== undefined && zones.length > 0 && !zones.includes(named)) return envelope_error('', undefined, `cluster new: --base-domain ${named}: no such zone in the tenancy (${zones.join(', ')})\n`);
  const baseDomain: string | null = named ?? baseDomain_default(context, zones);
  if (baseDomain === null) {
    const why: string = zones.length === 0 ? 'the tenancy holds no DNS zone to find' : `the tenancy holds ${zones.length}: ${zones.join(', ')}`;
    return envelope_error('', undefined, `cluster new: --base-domain <zone> is needed: the DNS zone the cluster's names live under (${why})\n`);
  }
  const sized = specOptions_apply(SPEC_DEFAULT, new Map([...read.options].filter(([option]: [string, string]): boolean => option !== '--base-domain' && option !== '--compartment')));
  const compartmentId: string | undefined = read.options.get('--compartment');
  if ('error' in sized) return envelope_error('', undefined, `cluster new: ${sized.error}\n`);
  const record: ClusterRecord = { name, created: new Date().toISOString(), region, baseDomain, steps: {}, ids: {}, protected: true, ...(compartmentId !== undefined ? { compartmentId } : {}) };
  context.store.create(record, sized.spec);
  const lines: string[] = [
    `${chalk.bold(name)}  ${name}.${baseDomain}  spec written: ${context.store.folder_derive(name)}/spec.yaml`,
    `  ${spec_line(sized.spec)}`,
    chalk.gray(`Nothing is made in the tenancy until cluster build ${name}; cluster plan ${name} says what it takes and costs.`),
  ];
  return envelope_ok(`${lines.join('\n')}\n`);
}

/**
 * A built cluster and its spec, or why the verb refuses it.
 *
 * @param context - The session.
 * @param verb - The verb, for the refusal.
 * @param name - The cluster's name, or undefined for the only one.
 * @returns The cluster, its record and its spec, or the refusal.
 */
function builtCluster_need(context: BuildCommandContext, verb: string, name: string | undefined): { cluster: HarborCluster; record: ClusterRecord; spec: ClusterSpec } | { error: string } {
  const built: string[] = context.store.names_list();
  const chosen: string | undefined = name ?? (built.length === 1 ? built[0] : undefined);
  if (chosen === undefined) return { error: `cluster ${verb}: which cluster? (${built.join(', ') || 'none built here; cluster new <name>'})` };
  const cluster: HarborCluster | null = context.clusters.cluster_read(chosen);
  if (cluster === null) return { error: `cluster ${verb}: ${chosen}: no such cluster` };
  if (cluster.origin !== 'built') return { error: `cluster ${verb}: ${chosen}: read from a harbor-oci checkout, not built here; adopting it comes with cluster adopt` };
  const record: ClusterRecord | null = context.store.record_read(chosen);
  const spec = context.store.spec_read(chosen);
  if (record === null || spec === null || spec.spec === null) return { error: `cluster ${verb}: ${chosen}: its spec.yaml does not read${spec?.error !== undefined ? ` (${spec.error})` : ''}` };
  return { cluster, record, spec: spec.spec };
}

/**
 * What a spec costs in this region, read now.
 *
 * @param context - The session.
 * @param region - The region.
 * @param spec - The spec.
 * @returns The cost, or null when the family is not priced.
 */
async function cost_read(context: BuildCommandContext, region: string, spec: ClusterSpec): Promise<SpecCost | null> {
  const shape: CloudShape | undefined = familyShape_find(await context.driver.shapes_list(region), spec.family);
  const prices: CloudPrice[] = await context.driver.prices_list();
  return specCost_compute(spec, shape, prices);
}

/**
 * Whether the session may start jobs: the `tasks` tier.
 *
 * @returns True when granted.
 */
function tasks_granted(): boolean {
  return surface_get().capabilities.tasks === true;
}

/**
 * `cluster plan [<name>]`: the fit, the cost and the steps, read; the plan itself with the tier.
 *
 * @param context - The session.
 * @param args - The words after `plan`.
 * @returns The envelope.
 */
export async function clusterPlan_run(context: BuildCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  if (args.length > 1 || args.some((word: string): boolean => word.startsWith('-'))) return envelope_error('', undefined, 'cluster plan: usage: cluster plan [<name>]\n');
  const need = builtCluster_need(context, 'plan', args[0]);
  if ('error' in need) return envelope_error('', undefined, `${need.error}\n`);
  const { cluster, record, spec } = need;
  const fits: ZoneFit[] = await specFit_read(context.driver, record.region, cluster.name, spec);
  const cost: SpecCost | null = await cost_read(context, record.region, spec);
  const lines: string[] = [`${chalk.bold(cluster.name)}  ${cluster.cluster ?? ''}`, `  ${spec_line(spec)}`, `fit, ${spec.family} per availability domain (${record.region}):`];
  for (const fit of fits) {
    const room = (needed: number, free: number | null, unit: string): string => `${needed} of ${free ?? '?'} ${unit}`;
    const verdict: string = fit.fits === null ? chalk.gray('not said') : fit.fits ? chalk.cyan('fits') : chalk.red('does not fit');
    lines.push(`  ${fit.zone.padEnd(24)} ${fit.nodes.join(' ').padEnd(28)} ${room(fit.coresNeeded, fit.coresFree, 'cores')}, ${room(fit.memoryNeeded, fit.memoryFree, 'GiB')}  ${verdict}`);
  }
  lines.push(`cost  ${cost === null ? chalk.gray(`${spec.family} is not in the price list`) : chalk.yellow(cost_words(cost))}`);
  const next: string | null = stepNext_find(record);
  lines.push(`steps ${next === null ? 'every step done' : `next: ${next}`}`);
  if (record.ids['stackRef'] !== undefined && tasks_granted() && context.builder !== null) {
    const ran = await job_runFollowed(`${cluster.name}-plan`, `plan ${cluster.name}`, planRun_make(cluster.name, context.builder, context.store));
    if ('error' in ran) return envelope_error('', undefined, `cluster plan: ${ran.error}\n`);
  } else if (record.adopted !== undefined && record.ids['stackRef'] === undefined) {
    lines.push(chalk.gray(`plan  ${cluster.name} is not in Resource Manager yet: cluster adopt ${cluster.name} --from ${record.adopted.from} with the tasks tier puts it there`));
  }
  const planText: string | null = context.store.file_read(cluster.name, 'plan.json');
  if (planText !== null) {
    const counts = plan_count(JSON.parse(planText) as InfraPlan);
    lines.push(`plan  ${planCounts_words(counts)}${planCounts_alter(counts) ? chalk.red(' · an apply would touch what exists: refused unless allowed by name') : ''}`);
    if (record.adopted !== undefined) lines.push(chalk.gray(`      adopted from ${record.adopted.from}: planned against, never built on`));
  } else if (!tasks_granted() && record.adopted === undefined) {
    lines.push(chalk.gray('plan  the infrastructure plan needs the tasks tier (stratus --host-control tasks): without it, nothing outside this host changes'));
  } else {
    lines.push(chalk.gray(`plan  not made yet: cluster build ${cluster.name} --through infra-plan makes it, and nothing it makes bills`));
  }
  return envelope_ok(`${lines.join('\n')}\n`);
}

/**
 * Follows a run to its end, or until the operator stops following.
 *
 * @param runner - The runner.
 * @param id - The run's job id.
 * @param shown - Called after each line, to show the cluster again.
 * @returns Its record then.
 */
async function run_follow(runner: JobRunner, id: string, shown?: () => void): Promise<JobRecord | undefined> {
  commandCancellation_enable();
  const signal: AbortSignal | undefined = commandCancellation_signalGet();
  return runner.job_followAside(STEPS_SOURCE, id, (line: string): void => { sink_dataLine(line); shown?.(); }, signal);
}

/**
 * Starts a job and follows it to its end.
 *
 * @param id - Its id in the build steps' source.
 * @param label - What it is called.
 * @param run - Its work.
 * @returns Its record at the end, or why it did not start or end.
 */
export async function job_runFollowed(id: string, label: string, run: Parameters<JobRunner['job_start']>[3]): Promise<{ record: JobRecord } | { error: string }> {
  const runner: JobRunner | null = runner_get();
  if (runner === null) return { error: 'this session runs no tasks' };
  try {
    runner.job_start(STEPS_SOURCE, id, label, run);
  } catch (error: unknown) {
    return { error: error instanceof JobRefusal ? error.message : String(error) };
  }
  sink_dataLine(chalk.gray(`following /proc/${STEPS_SOURCE}/${id}; Ctrl-C stops following, not the task (wait ${id} follows it again)`));
  const ended: JobRecord | undefined = await run_follow(runner, id);
  if (ended === undefined) return { error: `/proc/${STEPS_SOURCE}/${id}: gone` };
  if (!taskState_isOver(ended.state)) return { error: `stopped following; /proc/${STEPS_SOURCE}/${id} goes on` };
  if (ended.state !== 'done') return { error: `${id}: ${ended.state}${ended.outcome !== undefined ? `: ${ended.outcome}` : ''}` };
  return { record: ended };
}

/**
 * The question before the first billing step.
 *
 * @param context - The session.
 * @param name - The cluster.
 * @param record - Its state.
 * @param spec - Its spec.
 * @returns The question.
 */
async function billing_question(context: BuildCommandContext, name: string, record: ClusterRecord, spec: ClusterSpec): Promise<string> {
  const planText: string | null = context.store.file_read(name, 'plan.json');
  const created: number = planText === null ? 0 : plan_count(JSON.parse(planText) as InfraPlan).create;
  const cost: SpecCost | null = await cost_read(context, record.region, spec);
  return `${FIRST_BILLING_STEP} creates ${created} resources. Billing starts at ${cost === null ? 'an unpriced rate' : cost_words(cost)}. Continue? [y/N]`;
}

/**
 * `cluster build [<name>] [--through <step>]`.
 *
 * @param context - The session.
 * @param args - The words after `build`.
 * @returns The envelope.
 */
export async function clusterBuild_run(context: BuildCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const read = options_read(args, ['--through']);
  if ('error' in read) return envelope_error('', undefined, `cluster build: ${read.error} (--through)\n`);
  if (read.rest.length > 1) return envelope_error('', undefined, 'cluster build: usage: cluster build [<name>] [--through <step>]\n');
  const through: string | undefined = read.options.get('--through');
  if (through !== undefined && !BUILD_STEPS.includes(through)) return envelope_error('', undefined, `cluster build: --through ${through}: no such step (${BUILD_STEPS.join(' ')})\n`);
  const need = builtCluster_need(context, 'build', read.rest[0]);
  if ('error' in need) return envelope_error('', undefined, `${need.error}\n`);
  if (need.record.adopted !== undefined) return envelope_error('', undefined, `cluster build: ${need.cluster.name}: adopted from ${need.record.adopted.from}: building on it is refused until it is allowed by name\n`);
  if (context.deps === null) return envelope_error('', undefined, 'cluster build: this cloud\'s build steps are not written yet; stratus --fake builds over the fake cloud\n');
  const runner: JobRunner | null = runner_get();
  if (runner === null) return envelope_error('', undefined, 'cluster build: this session runs no tasks\n');
  const name: string = need.cluster.name;
  const asked: string | null = await account_askWhenMissing(context, need.record, through);
  if (asked !== null) return envelope_error('', undefined, `cluster build: ${asked}\n`);
  const id: string = buildJob_id(name);
  for (;;) {
    const running: JobRecord | undefined = runner.job_get(STEPS_SOURCE, id);
    if (running === undefined || taskState_isOver(running.state)) {
      try {
        runner.job_start(STEPS_SOURCE, id, `build ${name}`, buildRun_make(name, through, context.deps), { cluster: name, ...(through !== undefined ? { through } : {}) });
      } catch (error: unknown) {
        return envelope_error('', undefined, `cluster build: ${error instanceof JobRefusal ? error.message : String(error)}\n`);
      }
    }
    sink_dataLine(chalk.gray(`following /proc/${STEPS_SOURCE}/${id}; Ctrl-C stops following, not the build (wait ${id} follows it again)`));
    clusterState_show(context, name);
    // Shown again after each line; at the end, by the question that follows or by the next read.
    const ended: JobRecord | undefined = await run_follow(runner, id, (): void => clusterState_show(context, name));
    if (ended === undefined) return envelope_error('', undefined, `cluster build: /proc/${STEPS_SOURCE}/${id}: gone\n`);
    if (!taskState_isOver(ended.state)) return envelope_ok(`${chalk.gray(`stopped following; the build goes on (wait ${id})`)}\n`);
    if (ended.state !== 'done') return envelope_error('', undefined, `cluster build: ${name}: ${ended.state}${ended.outcome !== undefined ? `: ${ended.outcome}` : ''}\n`);
    const stoppedBefore: string | undefined = ended.data['stoppedBefore'] as string | undefined;
    const record: ClusterRecord = context.store.record_read(name) as ClusterRecord;
    if (stoppedBefore === FIRST_BILLING_STEP && record.billingAccepted === undefined && (through === undefined || BUILD_STEPS.indexOf(through) >= BUILD_STEPS.indexOf(FIRST_BILLING_STEP))) {
      const question: string = await billing_question(context, name, record, need.spec);
      clusterState_show(context, name, question);
      const yes: boolean = await repl_confirm(question);
      clusterState_show(context, name);
      if (!yes) return envelope_ok(`${chalk.gray(`stopped before ${FIRST_BILLING_STEP}; nothing bills (cluster build ${name} asks again)`)}\n`);
      context.store.record_update(name, (current: ClusterRecord): void => { current.billingAccepted = new Date().toISOString(); });
      continue;
    }
    const next: string | null = stepNext_find(record);
    const summary: string = next === null
      ? `${name}: every step done`
      : !STEPS_WRITTEN.includes(next) ? `${name}: built through ${BUILD_STEPS[BUILD_STEPS.indexOf(next) - 1] ?? ''}; ${next} and after are not steps this session has yet`
        : `${name}: done through ${BUILD_STEPS[BUILD_STEPS.indexOf(next) - 1] ?? ''}; next: ${next}`;
    return envelope_ok(`${summary}\n`);
  }
}

/**
 * Asks for the installer's account when the build will need it and the host
 * has none: the id in the open, the secret hidden, kept on the host only.
 *
 * @param context - The session.
 * @param record - The cluster's state.
 * @param through - The last step asked for, when one was.
 * @returns Why the build cannot go on, or null when it can.
 */
async function account_askWhenMissing(context: BuildCommandContext, record: ClusterRecord, through: string | undefined): Promise<string | null> {
  const account: InstallerAccountKeeper | undefined = context.account;
  if (account === undefined || account.present()) return null;
  const next: string | null = stepNext_find(record);
  const needs: boolean = next !== null && BUILD_STEPS.indexOf(next) <= BUILD_STEPS.indexOf('cluster')
    && (through === undefined || BUILD_STEPS.indexOf(through) >= BUILD_STEPS.indexOf('cluster'));
  if (!needs) return null;
  sink_dataLine(chalk.yellow(`The build needs Red Hat's service account (console.redhat.com, Service Accounts); none is kept in ${account.path}.`));
  clusterState_show(context, record.name, 'Red Hat service account client id:');
  const clientId: string = (await repl_question('Red Hat service account client id:')).trim();
  if (clientId === '') return 'no client id given; nothing kept, nothing started';
  const secret: string = (await repl_questionHidden('Its client secret:')).trim();
  if (secret === '') return 'no secret given; nothing kept, nothing started';
  account.keep(clientId, secret);
  sink_dataLine(chalk.gray(`kept in ${account.path}, mode 600, on this host only`));
  return null;
}

/**
 * `cluster adopt <name> --from <checkout> [--stack-compartment <ocid>]`.
 *
 * @param context - The session.
 * @param args - The words after `adopt`.
 * @returns The envelope.
 */
/**
 * Adopts a cluster found in the tenancy by its tag (docs/stratus.adoc, D15):
 * writes its folder from what the cloud says — its stack and compartment,
 * the zone and spec read back from the stack's variables — and no secrets,
 * which no cloud read recovers. Reads only, so no tier is needed; from then
 * on the cluster is adopted, planned against and never built on.
 *
 * @param context - The session's build half.
 * @param name - The cluster.
 * @returns The envelope.
 */
async function tenancyAdopt_run(context: BuildCommandContext, name: string): Promise<CommandEnvelope> {
  const region: string | null = context.region();
  if (region === null) return envelope_error('', undefined, 'cluster adopt: not connected: the tenancy cannot be searched\n');
  const kept: ClusterRecord | null = context.store.record_read(name);
  if (kept !== null) return kept.adopted === undefined ? envelope_error('', undefined, `cluster adopt: ${name}: a cluster of that name was built here\n`) : envelope_ok(`${name}: already adopted${kept.ids['stackRef'] !== undefined ? `; its stack is ${kept.ids['stackRef']}` : ''}\n`);
  let found: FoundCluster | undefined;
  try {
    found = (await context.driver.clusters_find(CLUSTER_TAG, region)).find((entry: FoundCluster): boolean => entry.name === name);
  } catch (error: unknown) {
    return envelope_error('', undefined, `cluster adopt: the tenancy was not searched: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  if (found === undefined) return envelope_error('', undefined, `cluster adopt: ${name}: nothing in the tenancy is tagged ${CLUSTER_TAG}=${name}; a harbor-oci checkout adopts with --from\n`);
  if (found.stack !== null && context.builder?.stack_describe !== undefined) {
    // The stack's variables are the spec and the zone; a stack that cannot be read is not adopted blind.
    try {
      await context.builder.stack_describe(found.stack.id, region);
    } catch (error: unknown) {
      return envelope_error('', undefined, `cluster adopt: ${name}: its stack ${found.stack.id} could not be read: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  const described: HarborCluster = await foundCluster_describe(found, context.driver, context.builder);
  const now: string = new Date().toISOString();
  const record: ClusterRecord = foundRecord_make(described, now, true);
  const compartmentId: string | undefined = record.compartmentId;
  const instances: number = described.found?.resources?.instances ?? 0;
  context.store.create(record, described.found?.spec ?? SPEC_DEFAULT);
  const lines: string[] = [
    `${chalk.bold(name)}  adopted from the tenancy: ${found.stack !== null ? `stack ${found.stack.id} (${found.stack.state})` : 'no stack'}${compartmentId !== undefined ? `, compartment ${compartmentId}` : ''}`,
    `  kept here: its record${described.found?.spec !== null && described.found?.spec !== undefined ? ' and the spec its stack says' : ' and the default spec (its stack said no sizes)'} in ${context.store.folder_derive(name)}; ${instances > 0 ? `${instances} instances live, so it bills` : 'nothing live'}`,
    chalk.gray(`  its kubeconfig and CUBE token are not in the cloud: copy them into ${context.store.folder_derive(name)}/auth/ before cluster verify or attach`),
  ];
  return envelope_ok(`${lines.join('\n')}\n`);
}

export async function clusterAdopt_run(context: BuildCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const read = options_read(args, ['--from', '--stack-compartment']);
  if ('error' in read) return envelope_error('', undefined, `cluster adopt: ${read.error} (--from, --stack-compartment)\n`);
  const [name, ...extra] = read.rest;
  const from: string | undefined = read.options.get('--from');
  if (name === undefined || extra.length > 0) return envelope_error('', undefined, 'cluster adopt: usage: cluster adopt <name> [--from <harbor-oci checkout>] [--stack-compartment <ocid>]\n');
  if (!CLUSTER_NAME.test(name)) return envelope_error('', undefined, `cluster adopt: ${name}: a cluster's name is a DNS label\n`);
  if (from === undefined) return tenancyAdopt_run(context, name);
  const checkout: CheckoutRead | { error: string } = checkout_read(name, from, new Date());
  if ('error' in checkout) return envelope_error('', undefined, `cluster adopt: ${checkout.error}\n`);
  const kept: ClusterRecord | null = context.store.record_read(name);
  const lines: string[] = [];
  if (kept === null) {
    adoption_keep(context.store, checkout);
    lines.push(`${chalk.bold(name)}  ${name}.${checkout.record.baseDomain}  adopted from ${from}`);
    lines.push(`  kept here: its ids (${Object.keys(checkout.record.ids).join(', ')}), its spec, its settings, its secrets (${checkout.secrets.map((secret) => secret.name).join(', ') || 'none'}) in ${context.store.folder_derive(name)}`);
  } else if (kept.adopted === undefined) {
    return envelope_error('', undefined, `cluster adopt: ${name}: a cluster of that name was built here\n`);
  } else {
    // An adopted cluster catches up with steps the checkout shows done that this session had no name for when it was adopted.
    const caught: string[] = Object.keys(checkout.record.steps).filter((step: string): boolean => kept.steps[step] === undefined);
    if (caught.length > 0) {
      context.store.record_update(name, (current: ClusterRecord): void => {
        for (const step of caught) current.steps[step] = checkout.record.steps[step] as ClusterRecord['steps'][string];
      });
      lines.push(`${chalk.bold(name)}: caught up from ${from}: ${caught.join(', ')}`);
    }
    if (kept.ids['stackRef'] !== undefined) return envelope_ok(`${[...lines, `${name}: already adopted; its stack is ${kept.ids['stackRef']}`].join('\n')}\n`);
  }
  if (!tasks_granted()) {
    lines.push(chalk.gray(`  its stack and Terraform state go to Resource Manager with the tasks tier: cluster adopt ${name} --from ${from} again, under stratus --host-control tasks`));
    return envelope_ok(`${lines.join('\n')}\n`);
  }
  if (context.builder === null || context.builder.stack_adopt === undefined) return envelope_error('', undefined, `cluster adopt: ${lines.join('\n')}\nthis cloud cannot take a stack in yet\n`);
  const compartment: string = read.options.get('--stack-compartment') ?? checkout.record.compartmentId ?? '';
  for (const line of lines) sink_dataLine(line);
  const ran = await job_runFollowed(`${name}-adopt`, `adopt ${name}`, adoptRun_make(context.store, context.builder, name, checkout.variables, checkout.stateFile, compartment, checkout.stackVersion));
  if ('error' in ran) return envelope_error('', undefined, `cluster adopt: ${ran.error}\n`);
  return envelope_ok(`${name}: adopted; its stack is ${context.store.record_read(name)?.ids['stackRef'] ?? '?'} (cluster plan ${name} plans against it)\n`);
}
