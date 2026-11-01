/**
 * @file A network's build and teardown as jobs (docs/stratus.adoc, D16): the
 * plan (the place made or adopted, the bastion's address read, the module's
 * stack planned), the apply, and the teardown. Each runs in the core's
 * runner under the `tasks` tier; the command between them asks the operator.
 *
 * The place is adopted only when it holds nothing: a compartment of the
 * network's name with anything in it is someone else's, and the build stops.
 *
 * @module
 */
import type { JobContext, JobRun } from '@fnndsc/brasa/core';
import type { CloudDriver, ResourceCounts } from '../cloud/driver.js';
import { plan_count, planCounts_words, type BuildCall, type CloudBuilder, type InfraPlan } from '../cloud/builder.js';
import { NET_TAG, type NetRecord, type NetStore } from './state.js';
import type { NetSpec } from './spec.js';

/** What a network's jobs run over. */
export interface NetDeps {
  readonly store: NetStore;
  readonly builder: CloudBuilder;
  readonly driver: CloudDriver;
  /** The mise bastion's public address as a /32: the one address the managed bastion admits. */
  readonly clientCidr_read: () => Promise<string>;
}

/** A network's job ids, in the build steps' source: apart from any cluster's. */
export const NET_JOBS = {
  plan: (name: string): string => `net-${name}-plan`,
  apply: (name: string): string => `net-${name}-apply`,
  teardown: (name: string): string => `net-${name}-teardown`,
} as const;

/**
 * The call a builder is given from a job.
 *
 * @param context - The job.
 * @returns Its log and stop.
 */
function call_make(context: JobContext): BuildCall {
  return { log: (line: string): void => context.log_write(line), signal: context.signal };
}

/**
 * How many things stand in a place, by kind, and the total.
 *
 * @param counts - The cloud's counts.
 * @returns The words (`2 instances, 1 volumes`) and the total.
 */
export function standing_words(counts: ResourceCounts): { words: string; total: number } {
  const said: Array<[string, number]> = Object.entries(counts).filter(([, count]): boolean => (count ?? 0) > 0).map(([kind, count]): [string, number] => [kind, count ?? 0]);
  return { words: said.map(([kind, count]): string => `${count} ${kind}`).join(', '), total: said.reduce((sum: number, [, count]): number => sum + count, 0) };
}

/**
 * The builder's network calls, or why this cloud has none.
 *
 * @param builder - The cloud's build half.
 * @returns The builder, checked.
 * @throws Error - When the cloud cannot build networks.
 */
function builder_check(builder: CloudBuilder): Required<Pick<CloudBuilder, 'place_ensure' | 'place_tag' | 'place_release' | 'modulePlan_run' | 'moduleApply_run' | 'moduleDestroy_run'>> {
  const { place_ensure, place_tag, place_release, modulePlan_run, moduleApply_run, moduleDestroy_run } = builder;
  if (place_ensure === undefined || place_tag === undefined || place_release === undefined || modulePlan_run === undefined || moduleApply_run === undefined || moduleDestroy_run === undefined) {
    throw new Error(`the ${builder.id} cloud builds no networks yet`);
  }
  return {
    place_ensure: place_ensure.bind(builder), place_tag: place_tag.bind(builder), place_release: place_release.bind(builder),
    modulePlan_run: modulePlan_run.bind(builder), moduleApply_run: moduleApply_run.bind(builder), moduleDestroy_run: moduleDestroy_run.bind(builder),
  };
}

/**
 * A network's record and spec, both there.
 *
 * @param store - The networks.
 * @param name - The network.
 * @returns Both.
 * @throws Error - When either is missing or the spec does not read.
 */
function net_read(store: NetStore, name: string): { record: NetRecord; spec: NetSpec } {
  const record: NetRecord | null = store.record_read(name);
  const read = store.spec_read(name);
  if (record === null || read === null) throw new Error(`${name}: no such network`);
  if ('error' in read) throw new Error(`${name}: spec.yaml: ${read.error}`);
  return { record, spec: read.spec };
}

/**
 * The plan's job: the place, the address, the stack's plan, kept as `plan.json`.
 *
 * @param name - The network.
 * @param deps - What it runs over.
 * @returns The job's work.
 */
export function netPlanRun_make(name: string, deps: NetDeps): JobRun {
  return async (context: JobContext): Promise<void> => {
    const builder = builder_check(deps.builder);
    const call: BuildCall = call_make(context);
    const { record, spec } = net_read(deps.store, name);
    let placeId: string | undefined = record.placeId;
    if (placeId === undefined) {
      const place = await builder.place_ensure({ name, region: record.region, tag: NET_TAG }, call);
      if (!place.tagged) {
        const standing = standing_words(await deps.driver.resources_search(place.id, record.region));
        if (standing.total > 0) throw new Error(`the compartment ${name} is there and holds ${standing.words}: a network is built in an empty compartment or its own`);
        await builder.place_tag({ placeId: place.id, region: record.region, tag: NET_TAG, name }, call);
      }
      placeId = place.id;
      deps.store.record_update(name, (current: NetRecord): void => { current.placeId = place.id; current.placeMade = place.made; });
    }
    const clientCidr: string = await deps.clientCidr_read();
    context.log_write(`the bastion admits ${clientCidr}, this host's public address`);
    const plan: InfraPlan = await builder.modulePlan_run({
      module: 'net', owner: { tag: NET_TAG, name }, region: record.region, placeId,
      inputs: { cidr: spec.cidr, clientCidr },
      ...(record.stackRef !== undefined ? { stackRef: record.stackRef } : {}),
    }, call);
    if (context.signal.aborted) return;
    deps.store.record_update(name, (current: NetRecord): void => { if (plan.stackRef !== undefined) current.stackRef = plan.stackRef; current.clientCidr = clientCidr; });
    deps.store.file_write(name, 'plan.json', `${JSON.stringify(plan, null, 2)}\n`);
    context.log_write(`plan: ${planCounts_words(plan_count(plan))}`);
  };
}

/**
 * The apply's job: the plan kept, applied; what it left recorded.
 *
 * @param name - The network.
 * @param deps - What it runs over.
 * @returns The job's work.
 */
export function netApplyRun_make(name: string, deps: NetDeps): JobRun {
  return async (context: JobContext): Promise<void> => {
    const builder = builder_check(deps.builder);
    const { record } = net_read(deps.store, name);
    const planText: string | null = deps.store.file_read(name, 'plan.json');
    if (planText === null || record.stackRef === undefined) throw new Error(`${name}: no plan to apply (net build ${name} makes one)`);
    const plan: InfraPlan = JSON.parse(planText) as InfraPlan;
    const outputs: Record<string, string> = await builder.moduleApply_run({ region: record.region, stackRef: record.stackRef, plan, label: name }, call_make(context));
    deps.store.record_update(name, (current: NetRecord): void => { current.outputs = outputs; current.built = new Date().toISOString(); delete current.gone; });
    deps.store.file_remove(name, 'plan.json');
    context.log_write(`${name}: built (${Object.entries(outputs).map(([key, value]): string => `${key} ${value}`).join(', ')})`);
  };
}

/**
 * The teardown's job: the stack's resources and the stack, then the place
 * (removed when the build made it, untagged when it was adopted).
 *
 * @param name - The network.
 * @param deps - What it runs over.
 * @returns The job's work.
 */
export function netTeardownRun_make(name: string, deps: NetDeps): JobRun {
  return async (context: JobContext): Promise<void> => {
    const builder = builder_check(deps.builder);
    const call: BuildCall = call_make(context);
    const { record } = net_read(deps.store, name);
    if (record.stackRef !== undefined) {
      for (const line of await builder.moduleDestroy_run({ region: record.region, stackRef: record.stackRef, label: name }, call)) context.log_write(`removed ${line}`);
    }
    if (context.signal.aborted) return;
    if (record.placeId !== undefined) context.log_write(await builder.place_release({ placeId: record.placeId, region: record.region, tag: NET_TAG, made: record.placeMade === true }, call));
    deps.store.record_update(name, (current: NetRecord): void => {
      delete current.stackRef; delete current.outputs; delete current.built; delete current.placeId; delete current.placeMade;
      current.gone = new Date().toISOString();
    });
    deps.store.file_remove(name, 'plan.json');
  };
}
