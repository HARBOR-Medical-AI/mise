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
import { envelope_error, envelope_ok, STRATUS_NET_STATUS_MODEL_KIND, type CommandEnvelope, type NetStatusRow } from '@fnndsc/menu';
import { repl_confirm, repl_question, type CommandHelp } from '@fnndsc/brasa/core';
import { plan_count, planCounts_alter, planCounts_words, type CloudBuilder, type InfraPlan, type PlanCounts } from '../cloud/builder.js';
import type { CloudDriver } from '../cloud/driver.js';
import { cidr_read, NET_RESOURCES, netSpec_diff, subnet_derive, type NetSpec } from '../net/spec.js';
import { NET_NAME, type NetRecord, type NetStore } from '../net/state.js';
import { netsFound_read, type FoundNet } from '../vm/found.js';
import { NET_JOBS, netApplyRun_make, netPlanRun_make, netTeardownRun_make, standing_words, type NetDeps } from '../net/build.js';
import { job_runFollowed, options_read, tasks_granted } from './build.js';
import { TIER_REFUSAL } from '../tier.js';

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
function netStatus_lines(record: NetRecord, spec: NetSpec | null, stands: NetStands | null): string[] {
  const state: string = netState_word(record);
  const tone = state === 'built' ? chalk.cyan : state === 'gone' ? chalk.gray : chalk.yellow;
  const lines: string[] = [`${chalk.bold(record.name)}  ${tone(state)}  ${spec === null ? chalk.red('spec.yaml does not read') : `${spec.cidr} (subnet ${subnet_derive(spec.cidr)})`}  ${record.region}`];
  if (record.placeId !== undefined) lines.push(`  place    ${record.placeId}${record.placeMade === false ? chalk.gray(' (adopted)') : ''}`);
  if (record.stackRef !== undefined) lines.push(`  stack    ${record.stackRef}`);
  if (stands !== null) lines.push(`  vcn      ${stands.cidr ?? chalk.yellow('the tenancy holds no VCN of it')}${chalk.gray(`  (read from the tenancy ${stands.at.slice(11, 16)} UTC)`)}`);
  if (record.clientCidr !== undefined) lines.push(`  bastion  ${record.outputs?.['bastion_id'] ?? chalk.gray('not built')}, admitting ${record.clientCidr}`);
  if (record.outputs?.['subnet_id'] !== undefined) lines.push(`  subnet   ${record.outputs['subnet_id']}`);
  if (record.built !== undefined) lines.push(chalk.gray(`  built ${record.built}`));
  if (record.gone !== undefined) lines.push(chalk.gray(`  torn down ${record.gone}: net build ${record.name} builds it again`));
  return lines;
}

/** A network's VCN as the tenancy answers it: the range it holds, null when it holds none, and when it was read. */
interface NetStands {
  readonly cidr: string | null;
  readonly at: string;
}

/**
 * A kept network's VCN, read from the tenancy (a-change-is-a-loop, clause 1):
 * the range it was built with is the VCN's, not this host's record of it.
 *
 * @param context - The session.
 * @param record - Its state.
 * @returns What stands, or null when nothing of it is built or the cloud did not answer.
 */
async function netStands_read(context: NetCommandContext, record: NetRecord): Promise<NetStands | null> {
  const vcn: string | undefined = record.outputs?.['vcn_id'];
  if (record.placeId === undefined || vcn === undefined || record.gone !== undefined) return null;
  try {
    const networks = await context.driver.networks_list(record.placeId, record.region);
    const found = networks.find((network): boolean => network.id === vcn);
    return { cidr: found === undefined ? null : (found.cidrs ?? []).join(',') || null, at: new Date().toISOString() };
  } catch {
    return null;
  }
}

/**
 * `net status [<name>…]`.
 *
 * @param context - The session.
 * @param names - The networks asked about; every one when none.
 * @returns The envelope.
 */
async function netStatus_run(context: NetCommandContext, names: ReadonlyArray<string>): Promise<CommandEnvelope> {
  // The tenancy is the truth about which networks stand (docs/stratus.adoc, D16): one carrying stratus's tag that
  // this session keeps no record of is listed as found, from the cloud.
  const kept: string[] = context.store.names_list();
  const region: string | null = context.region();
  let found: FoundNet[] = [];
  let tenancy: FoundNet[] = [];
  let read: string | null = null;
  let unsearched: string | null = region === null ? 'not connected' : null;
  if (region !== null) {
    try {
      tenancy = await netsFound_read(context.driver, region);
      read = new Date().toISOString();
      found = tenancy.filter((net: FoundNet): boolean => !kept.includes(net.name));
    } catch (error: unknown) {
      unsearched = error instanceof Error ? error.message : String(error);
    }
  }
  const unsearchedLine: string = unsearched === null ? '' : `${chalk.yellow(`the tenancy was not searched for networks (${unsearched}): only those this session keeps are listed`)}\n`;
  const all: string[] = [...kept, ...found.map((net: FoundNet): string => net.name)];
  if (all.length === 0) return envelope_ok(`${unsearchedLine}no networks${unsearched === null ? ' here or in the tenancy' : ''}: net new <name> --cidr <range> declares one\n`, { kind: STRATUS_NET_STATUS_MODEL_KIND, data: { read, nets: [] } });
  const missing: string[] = names.filter((name: string): boolean => !all.includes(name));
  if (missing.length > 0) return envelope_error('', undefined, `net: ${missing.join(', ')}: no such network (${all.join(', ')})\n`);
  const foundBy: Map<string, FoundNet> = new Map(found.map((net: FoundNet): [string, FoundNet] => [net.name, net]));
  const standing: Map<string, NetStands | null> = new Map();
  for (const name of names.length === 0 ? kept : names.filter((one: string): boolean => kept.includes(one))) {
    standing.set(name, await netStands_read(context, context.store.record_read(name) as NetRecord));
  }
  const blocks: string[] = (names.length === 0 ? all : [...names]).map((name: string): string => {
    const seen: FoundNet | undefined = foundBy.get(name);
    if (seen !== undefined) {
      return [
        `${chalk.bold(name)}  ${chalk.magenta('found')}  ${chalk.gray('built by stratus, not kept in this session')}`,
        `  ${seen.stack !== null ? `stack ${seen.stack.id} (${seen.stack.state})` : 'no stack'}${seen.compartmentId !== null ? `, compartment ${seen.compartmentId}` : ''}`,
      ].join('\n');
    }
    const read = context.store.spec_read(name);
    return netStatus_lines(context.store.record_read(name) as NetRecord, read !== null && 'spec' in read ? read.spec : null, standing.get(name) ?? null).join('\n');
  });
  // The same as a model: what is declared, what its last build made, and its stack as the tenancy answers it, with when it was read.
  const stacks: Map<string, FoundNet> = new Map(tenancy.map((net: FoundNet): [string, FoundNet] => [net.name, net]));
  const rows: NetStatusRow[] = (names.length === 0 ? all : [...names]).map((name: string): NetStatusRow => {
    const record: NetRecord | null = context.store.record_read(name);
    const spec = context.store.spec_read(name);
    const stack = stacks.get(name)?.stack ?? null;
    return {
      name, state: record === null ? 'found' : record.gone !== undefined ? 'gone' : record.built !== undefined ? 'built' : 'declared',
      cidr: spec !== null && 'spec' in spec ? spec.spec.cidr : null, builtCidr: record?.builtCidr ?? null, stands: standing.get(name) ?? null,
      stack: stack === null ? null : { id: stack.id, state: stack.state }, bastion: record?.outputs?.['bastion_id'] ?? null, admits: record?.clientCidr ?? null, subnet: record?.outputs?.['subnet_id'] ?? null,
    };
  });
  return envelope_ok(`${unsearchedLine}${blocks.join('\n\n')}\n`, { kind: STRATUS_NET_STATUS_MODEL_KIND, data: { read, nets: rows } });
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
  const replaces: boolean = kept.built !== undefined && (kept.builtCidr ?? (before !== null && 'spec' in before ? before.spec.cidr : spec.cidr)) !== spec.cidr;
  const built: string = replaces ? chalk.red('; a new CIDR on a built network replaces its VCN and subnet, and every machine on them: net build refuses it unless --allow-alter') : kept.built !== undefined ? chalk.gray(`; built: net build ${name} plans the change and asks`) : '';
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
  const lines: string[] = [...netStatus_lines(record, spec, await netStands_read(context, record)), 'made of:', ...NET_RESOURCES.map((kind: string): string => `  ${kind}`), chalk.gray('cost  none: nothing a network is made of is in the price list')];
  if (record.stackRef !== undefined && tasks_granted()) {
    const deps = deps_make(context);
    if ('error' in deps) return envelope_error('', undefined, `net plan: ${deps.error}\n`);
    const ran = await job_runFollowed(NET_JOBS.plan(name), `plan ${name}`, netPlanRun_make(name, deps));
    if ('error' in ran) return envelope_error('', undefined, `net plan: ${ran.error}\n`);
  }
  const kept = planKept_read(context, name);
  if (kept !== null) lines.push(`plan  ${planCounts_words(kept.counts)}${planCounts_alter(kept.counts) ? chalk.red(' · an apply would touch what exists: refused unless --allow-alter') : ''}`);
  else if (record.stackRef !== undefined && !tasks_granted()) lines.push(chalk.gray(`plan  planning again: ${TIER_REFUSAL}`));
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
  if (!tasks_granted()) return envelope_error('', undefined, `net build: ${TIER_REFUSAL}\n`);
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
  const made: string[] = context.store.record_read(name)?.planMade ?? [];
  const already: string = made.length === 0 ? '' : ` Already made to plan it, free: ${made.join(', ')}; STOP leaves ${made.length === 1 ? 'it' : 'them'}, and a later build reuses ${made.length === 1 ? 'it' : 'them'}.`;
  const yes: boolean = await repl_confirm(`net build ${name}: ${planCounts_words(kept.counts)}. Nothing a network is made of bills.${already} Continue? [y/N]`);
  if (!yes) return envelope_ok(`${chalk.gray(made.length === 0 ? `stopped before the apply; nothing changed (net build ${name} plans and asks again)` : `stopped before the apply; nothing else was made (made to plan it, free: ${made.join(', ')}; net build ${name} reuses ${made.length === 1 ? 'it' : 'them'})`)}\n`);
  const applied = await job_runFollowed(NET_JOBS.apply(name), `apply ${name}`, netApplyRun_make(name, deps));
  if ('error' in applied) return envelope_error('', undefined, `net build: ${applied.error}\n`);
  // The receipt is what stands, read back: the VCN's range as the tenancy holds it after the apply.
  const after: NetRecord = context.store.record_read(name) as NetRecord;
  return envelope_ok(`${netStatus_lines(after, need.spec, await netStands_read(context, after)).join('\n')}\n`);
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
  if (!tasks_granted()) return envelope_error('', undefined, `net teardown: ${TIER_REFUSAL}\n`);
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
