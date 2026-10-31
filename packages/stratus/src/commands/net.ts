/**
 * @file `net`: the networks a tenancy's VMs stand on (docs/stratus.adoc, D16).
 *
 * `net new <name> --cidr <range>` declares a network and builds nothing: on
 * a network already declared it compares, saying `unchanged` or the change.
 * `net plan [<name>]` says what the network is made of and, with the `tasks`
 * tier and a stack, plans it again (a network nobody changed reads nothing
 * to do). `net build <name>` plans as a task, says the plan's counts and
 * asks, then applies; a plan that touches what exists is refused unless
 * `--allow-alter` is given. `net teardown <name>` refuses while anything
 * stands on the network, then asks for the name typed back. A bare `net` is
 * `net status`.
 *
 * @module
 */
import chalk from 'chalk';
import { envelope_error, envelope_ok, type CommandEnvelope } from '@fnndsc/menu';
import { repl_confirm, repl_question, type CommandHelp } from '@fnndsc/brasa/core';
import { plan_count, planCounts_alter, planCounts_words, type CloudBuilder, type InfraPlan, type PlanCounts } from '../cloud/builder.js';
import type { CloudDriver } from '../cloud/driver.js';
import { cidr_read, NET_RESOURCES, netSpec_diff, subnet_derive, type NetSpec } from '../net/spec.js';
import { NET_NAME, type NetRecord, type NetStore } from '../net/state.js';
import { NET_JOBS, netApplyRun_make, netPlanRun_make, netTeardownRun_make, standing_words, type NetDeps } from '../net/build.js';
import { job_runFollowed, options_read, tasks_granted } from './build.js';

/** What `net` reads from the session. */
export interface NetCommandContext {
  readonly store: NetStore;
  readonly driver: CloudDriver;
  /** The cloud's build half, or null when it has none. */
  readonly builder: CloudBuilder | null;
  /** The session's region, or null when not connected. */
  readonly region: () => string | null;
  /** The mise bastion's public address as a /32. */
  readonly clientCidr_read: () => Promise<string>;
}

/** The kinds that stand on a network: while any is in its place, teardown refuses. */
const STANDING_KINDS: ReadonlyArray<string> = ['instances', 'volumes', 'loadbalancers', 'buckets'];

/**
 * A network's jobs' inputs, or why there are none.
 *
 * @param context - The session.
 * @returns The deps.
 */
function deps_make(context: NetCommandContext): NetDeps | { error: string } {
  if (context.builder === null) return { error: 'this cloud builds nothing yet' };
  return { store: context.store, builder: context.builder, driver: context.driver, clientCidr_read: context.clientCidr_read };
}

/**
 * Where a network stands, in a word.
 *
 * @param record - Its state.
 * @returns `declared`, `planned`, `built` or `gone`.
 */
function netState_word(record: NetRecord): string {
  if (record.built !== undefined) return 'built';
  if (record.gone !== undefined) return 'gone';
  if (record.stackRef !== undefined) return 'planned';
  return 'declared';
}

/**
 * A network's spec, read.
 *
 * @param context - The session.
 * @param name - The network; the only one when absent and there is one.
 * @param verb - The verb asking, for its refusals.
 * @returns Its name, record and spec, or why not.
 */
function net_need(context: NetCommandContext, name: string | undefined, verb: string): { name: string; record: NetRecord; spec: NetSpec } | { error: string } {
  const names: string[] = context.store.names_list();
  if (name === undefined) {
    if (names.length === 1) name = names[0] as string;
    else return { error: `net ${verb}: name the network (${names.length === 0 ? 'none declared: net new <name> --cidr <range>' : names.join(', ')})` };
  }
  const record: NetRecord | null = context.store.record_read(name);
  const read = context.store.spec_read(name);
  if (record === null || read === null) return { error: `net ${verb}: ${name}: no such network${names.length > 0 ? ` (${names.join(', ')})` : ''}` };
  if ('error' in read) return { error: `net ${verb}: ${name}: spec.yaml: ${read.error}` };
  return { name, record, spec: read.spec };
}

/**
 * One network's lines.
 *
 * @param record - Its state.
 * @param spec - Its spec, or null when it does not read.
 * @returns The lines.
 */
function netStatus_lines(record: NetRecord, spec: NetSpec | null): string[] {
  const state: string = netState_word(record);
  const tone = state === 'built' ? chalk.cyan : state === 'gone' ? chalk.gray : chalk.yellow;
  const lines: string[] = [`${chalk.bold(record.name)}  ${tone(state)}  ${spec === null ? chalk.red('spec.yaml does not read') : `${spec.cidr} (subnet ${subnet_derive(spec.cidr)})`}  ${record.region}`];
  if (record.placeId !== undefined) lines.push(`  place    ${record.placeId}${record.placeMade === false ? chalk.gray(' (adopted)') : ''}`);
  if (record.stackRef !== undefined) lines.push(`  stack    ${record.stackRef}`);
  if (record.clientCidr !== undefined) lines.push(`  bastion  ${record.outputs?.['bastion_id'] ?? chalk.gray('not built')}, admitting ${record.clientCidr}`);
  if (record.outputs?.['subnet_id'] !== undefined) lines.push(`  subnet   ${record.outputs['subnet_id']}`);
  if (record.built !== undefined) lines.push(chalk.gray(`  built ${record.built}`));
  if (record.gone !== undefined) lines.push(chalk.gray(`  torn down ${record.gone}: net build ${record.name} builds it again`));
  return lines;
}

/**
 * `net status [<name>…]`.
 *
 * @param context - The session.
 * @param names - The networks asked about; every one when none.
 * @returns The envelope.
 */
function netStatus_run(context: NetCommandContext, names: ReadonlyArray<string>): CommandEnvelope {
  const kept: string[] = context.store.names_list();
  if (kept.length === 0) return envelope_ok('no networks: net new <name> --cidr <range> declares one\n');
  const missing: string[] = names.filter((name: string): boolean => !kept.includes(name));
  if (missing.length > 0) return envelope_error('', undefined, `net: ${missing.join(', ')}: no such network (${kept.join(', ')})\n`);
  const blocks: string[] = (names.length === 0 ? kept : [...names]).map((name: string): string => {
    const read = context.store.spec_read(name);
    return netStatus_lines(context.store.record_read(name) as NetRecord, read !== null && 'spec' in read ? read.spec : null).join('\n');
  });
  return envelope_ok(`${blocks.join('\n\n')}\n`);
}

/**
 * `net new <name> --cidr <range>`: declares; on one declared, compares.
 *
 * @param context - The session.
 * @param args - The words after `new`.
 * @returns The envelope.
 */
function netNew_run(context: NetCommandContext, args: ReadonlyArray<string>): CommandEnvelope {
  const read = options_read(args, ['--cidr']);
  if ('error' in read) return envelope_error('', undefined, `net new: ${read.error} (--cidr)\n`);
  const [name, ...extra] = read.rest;
  if (name === undefined || extra.length > 0) return envelope_error('', undefined, 'net new: usage: net new <name> --cidr <range>\n');
  if (!NET_NAME.test(name)) return envelope_error('', undefined, `net new: ${name}: a network's name is lower-case letters, digits and hyphens, starting with a letter\n`);
  const cidrText: string | undefined = read.options.get('--cidr');
  if (cidrText === undefined) return envelope_error('', undefined, 'net new: --cidr <range> is needed (10.20.0.0/16)\n');
  const cidr = cidr_read(cidrText);
  if ('error' in cidr) return envelope_error('', undefined, `net new: --cidr ${cidr.error}\n`);
  const spec: NetSpec = { cidr: cidr.cidr };
  const region: string | null = context.region();
  const kept: NetRecord | null = context.store.record_read(name);
  if (kept === null && region === null) return envelope_error('', undefined, 'net new: not connected: the region a network is built in is the session\'s\n');
  const before = context.store.spec_read(name);
  const changes: string[] = before !== null && 'spec' in before ? netSpec_diff(before.spec, spec) : [];
  if (kept !== null && before !== null && 'spec' in before && changes.length === 0) return envelope_ok(`${name}: unchanged\n`);
  context.store.declare(name, spec, kept?.region ?? (region as string));
  if (kept === null) return envelope_ok(`${name}: declared, ${spec.cidr} in ${region}; net build ${name} builds it\n`);
  const built: string = kept.built !== undefined ? chalk.gray(`; built: net build ${name} plans the change and asks`) : '';
  return envelope_ok(`${name}: ${changes.join(', ')}${built}\n`);
}

/**
 * The plan kept, in a line, and whether an apply of it would be refused.
 *
 * @param context - The session.
 * @param name - The network.
 * @returns The plan's counts, or null when none is kept.
 */
function planKept_read(context: NetCommandContext, name: string): { plan: InfraPlan; counts: PlanCounts } | null {
  const text: string | null = context.store.file_read(name, 'plan.json');
  if (text === null) return null;
  const plan: InfraPlan = JSON.parse(text) as InfraPlan;
  return { plan, counts: plan_count(plan) };
}

/**
 * `net plan [<name>]`.
 *
 * @param context - The session.
 * @param args - The words after `plan`.
 * @returns The envelope.
 */
async function netPlan_run(context: NetCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  if (args.length > 1 || args.some((word: string): boolean => word.startsWith('-'))) return envelope_error('', undefined, 'net plan: usage: net plan [<name>]\n');
  const need = net_need(context, args[0], 'plan');
  if ('error' in need) return envelope_error('', undefined, `${need.error}\n`);
  const { name, record, spec } = need;
  const lines: string[] = [...netStatus_lines(record, spec), 'made of:', ...NET_RESOURCES.map((kind: string): string => `  ${kind}`), chalk.gray('cost  none: nothing a network is made of is in the price list')];
  if (record.stackRef !== undefined && tasks_granted()) {
    const deps = deps_make(context);
    if ('error' in deps) return envelope_error('', undefined, `net plan: ${deps.error}\n`);
    const ran = await job_runFollowed(NET_JOBS.plan(name), `plan ${name}`, netPlanRun_make(name, deps));
    if ('error' in ran) return envelope_error('', undefined, `net plan: ${ran.error}\n`);
  }
  const kept = planKept_read(context, name);
  if (kept !== null) lines.push(`plan  ${planCounts_words(kept.counts)}${planCounts_alter(kept.counts) ? chalk.red(' · an apply would touch what exists: refused unless --allow-alter') : ''}`);
  else if (record.stackRef !== undefined && !tasks_granted()) lines.push(chalk.gray('plan  planning again needs the tasks tier (stratus --host-control tasks)'));
  else if (record.stackRef === undefined) lines.push(chalk.gray(`plan  not made yet: net build ${name} makes it and asks before it changes anything`));
  return envelope_ok(`${lines.join('\n')}\n`);
}

/**
 * `net build <name> [--allow-alter]`: plans as a task, asks, applies.
 *
 * @param context - The session.
 * @param args - The words after `build`.
 * @returns The envelope.
 */
async function netBuild_run(context: NetCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const allowAlter: boolean = args.includes('--allow-alter');
  const words: string[] = args.filter((word: string): boolean => word !== '--allow-alter');
  const unknown: string | undefined = words.find((word: string): boolean => word.startsWith('-'));
  if (unknown !== undefined) return envelope_error('', undefined, `net build: ${unknown}: unknown option (--allow-alter)\n`);
  if (words.length > 1) return envelope_error('', undefined, 'net build: usage: net build [<name>] [--allow-alter]\n');
  const need = net_need(context, words[0], 'build');
  if ('error' in need) return envelope_error('', undefined, `${need.error}\n`);
  if (!tasks_granted()) return envelope_error('', undefined, 'net build: needs the tasks tier (stratus --host-control tasks): without it, nothing outside this host changes\n');
  const deps = deps_make(context);
  if ('error' in deps) return envelope_error('', undefined, `net build: ${deps.error}\n`);
  const name: string = need.name;
  const planned = await job_runFollowed(NET_JOBS.plan(name), `plan ${name}`, netPlanRun_make(name, deps));
  if ('error' in planned) return envelope_error('', undefined, `net build: ${planned.error}\n`);
  const kept = planKept_read(context, name);
  if (kept === null) return envelope_error('', undefined, `net build: ${name}: the plan left nothing to read\n`);
  const total: number = kept.counts.create + kept.counts.replace + kept.counts.change + kept.counts.destroy;
  if (total === 0) {
    context.store.file_remove(name, 'plan.json');
    return envelope_ok(`${name}: built, and the plan reads nothing to do\n`);
  }
  if (planCounts_alter(kept.counts) && !allowAlter) return envelope_error('', undefined, `net build: ${name}: the plan ${planCounts_words(kept.counts)}: it touches what exists, refused unless net build ${name} --allow-alter\n`);
  const yes: boolean = await repl_confirm(`net build ${name}: ${planCounts_words(kept.counts)}. Nothing a network is made of bills. Continue? [y/N]`);
  if (!yes) return envelope_ok(`${chalk.gray(`stopped before the apply; nothing changed (net build ${name} plans and asks again)`)}\n`);
  const applied = await job_runFollowed(NET_JOBS.apply(name), `apply ${name}`, netApplyRun_make(name, deps));
  if ('error' in applied) return envelope_error('', undefined, `net build: ${applied.error}\n`);
  return envelope_ok(`${netStatus_lines(context.store.record_read(name) as NetRecord, need.spec).join('\n')}\n`);
}

/**
 * `net teardown <name>`: refuses while anything stands on the network, then asks for its name.
 *
 * @param context - The session.
 * @param args - The words after `teardown`.
 * @returns The envelope.
 */
async function netTeardown_run(context: NetCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  if (args.length !== 1 || (args[0] as string).startsWith('-')) return envelope_error('', undefined, 'net teardown: usage: net teardown <name>\n');
  const need = net_need(context, args[0], 'teardown');
  if ('error' in need) return envelope_error('', undefined, `${need.error}\n`);
  const { name, record } = need;
  if (record.placeId === undefined && record.stackRef === undefined) return envelope_ok(`${name}: nothing of it is built\n`);
  if (!tasks_granted()) return envelope_error('', undefined, 'net teardown: needs the tasks tier (stratus --host-control tasks)\n');
  const deps = deps_make(context);
  if ('error' in deps) return envelope_error('', undefined, `net teardown: ${deps.error}\n`);
  if (record.placeId !== undefined) {
    const counts = await context.driver.resources_search(record.placeId, record.region);
    const standing = standing_words(Object.fromEntries(STANDING_KINDS.map((kind: string): [string, number] => [kind, (counts as Record<string, number | undefined>)[kind] ?? 0])));
    if (standing.total > 0) return envelope_error('', undefined, `net teardown: ${name}: Device or resource busy: ${standing.words} stand on it; they go first\n`);
  }
  const answer: string = (await repl_question(`Remove the network ${name}: its gateway, subnet and bastion${record.placeMade === true ? ', and its compartment' : ''}? Type the network's name to go on:`)).trim();
  if (answer !== name) return envelope_ok(`${chalk.gray(`${answer === '' ? 'nothing typed' : `${answer} is not ${name}`}: nothing removed`)}\n`);
  const ran = await job_runFollowed(NET_JOBS.teardown(name), `teardown ${name}`, netTeardownRun_make(name, deps));
  if ('error' in ran) return envelope_error('', undefined, `net teardown: ${ran.error}\n`);
  return envelope_ok(`${name}: torn down; its spec stays (net build ${name} builds it again)\n`);
}

/**
 * `net`.
 *
 * @param context - The session.
 * @param args - The words after `net`.
 * @returns The envelope.
 */
export async function net_run(context: NetCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const [verb = 'status', ...rest] = args;
  switch (verb) {
    case 'status': return netStatus_run(context, rest);
    case 'new': return netNew_run(context, rest);
    case 'plan': return await netPlan_run(context, rest);
    case 'build': return await netBuild_run(context, rest);
    case 'teardown': return await netTeardown_run(context, rest);
    default:
      if (rest.length === 0 && context.store.names_list().includes(verb)) return netStatus_run(context, [verb]);
      return envelope_error('', undefined, `net: ${verb}: not a verb (net status, new, plan, build, teardown)\n`);
  }
}

/** `net`'s help. */
export const NET_HELP: CommandHelp = {
  usage: 'net [status [<name>…]] | net <name> | net new <name> --cidr <range> | net plan [<name>] | net build [<name>] [--allow-alter] | net teardown <name>',
  summary: 'Declare, build and tear down the networks VMs stand on',
  category: 'Resources',
  description: 'net new declares a network and builds nothing; on a network already declared it compares, printing unchanged or the change (the one place where a replayed line outranks a refusal: a script is the truth). A network is its address range (--cidr, /16 to /24); its subnet is the range\'s first /24. On OCI it is a compartment of its name under the tenancy\'s root, holding a VCN, an internet gateway, the default route and security list (SSH only from inside the network), one public subnet and an OCI Bastion admitting only this host\'s public address, read when it is built. A compartment of that name that holds nothing is adopted; one that holds anything is refused. net plan says what the network is made of and, with the tasks tier, plans a built one again. net build plans as a task (/proc/steps/net-<name>-plan), says the counts and asks, then applies; a plan that touches what exists is refused unless --allow-alter. net teardown refuses while instances, volumes, load balancers or buckets stand in its compartment, asks for the name typed back, then destroys the stack and removes the compartment it made (one adopted keeps itself and loses its tag). Nothing a network is made of bills.',
  examples: ['net new chrisproject-services --cidr 10.20.0.0/16', 'net plan chrisproject-services', 'net build chrisproject-services', 'net', 'net teardown scratch'],
};
