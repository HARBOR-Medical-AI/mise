/**
 * @file `vm`: the VMs a tenancy runs on its networks (docs/stratus.adoc, D16).
 *
 * `vm new <name> --net … --vcpu … --memory … --disk … --data … --os …`
 * declares a VM and builds nothing; on one already declared it compares,
 * saying `unchanged` or the change. `vm plan [<name>]` says its size, its
 * network and its cost. `vm build <name>` plans its data and its machine as
 * tasks, says the counts and the cost and asks, then applies the data, the
 * machine, and points the reserved address at it; a plan that touches what
 * exists is refused unless `--allow-alter`. `vm shell <name>` opens a session
 * on the network's bastion and prints the SSH line that reaches the VM.
 * `vm protect <name> on|off`: a VM is born protected, and teardown refuses
 * while it is. `vm teardown <name>` removes the machine and keeps the data,
 * its backups and the address; `--all` takes those too, asking for the name
 * typed back. A bare `vm` is `vm status`.
 *
 * @module
 */
import * as path from 'path';
import chalk from 'chalk';
import { envelope_error, envelope_ok, type CommandEnvelope } from '@fnndsc/menu';
import { repl_confirm, repl_question, surface_get, type CommandHelp } from '@fnndsc/brasa/core';
import { plan_count, planCounts_alter, planCounts_words, type CloudBuilder, type InfraPlan, type PlanCounts } from '../cloud/builder.js';
import type { CloudDriver } from '../cloud/driver.js';
import type { NetStore } from '../net/state.js';
import { VM_OPTIONS, vmSpec_dataLoss, vmSpec_diff, vmSpec_read, type VmSpec } from '../vm/spec.js';
import { VM_NAME, VM_USER, type VmRecord, type VmStore } from '../vm/state.js';
import { cost_words, planFile_derive, VM_JOBS, vmApplyRun_make, vmCost_estimate, vmNet_read, vmPlanRun_make, vmTeardownRun_make, type VmCost, type VmDeps, type VmPart } from '../vm/build.js';
import { job_runFollowed, options_read, tasks_granted } from './build.js';

/** What `vm` reads from the session. */
export interface VmCommandContext {
  readonly store: VmStore;
  readonly nets: NetStore;
  readonly driver: CloudDriver;
  /** The cloud's build half, or null when it has none. */
  readonly builder: CloudBuilder | null;
  /** The session's region, or null when not connected. */
  readonly region: () => string | null;
}

/** How long a shell session lasts: three hours, the bastion's longest. */
const SESSION_TTL_SECONDS: number = 10_800;

/**
 * A VM's jobs' inputs, or why there are none.
 *
 * @param context - The session.
 * @returns The deps.
 */
function deps_make(context: VmCommandContext): VmDeps | { error: string } {
  if (context.builder === null) return { error: 'this cloud builds nothing yet' };
  return { store: context.store, nets: context.nets, builder: context.builder, driver: context.driver };
}

/**
 * Where a VM stands, in a word.
 *
 * @param record - Its state.
 * @returns `declared`, `data only`, `built` or `gone`.
 */
function vmState_word(record: VmRecord): string {
  if (record.built !== undefined) return 'built';
  if (record.gone !== undefined) return 'gone';
  if (record.dataOutputs !== undefined) return record.machineGone !== undefined ? 'data kept' : 'data only';
  return 'declared';
}

/**
 * A spec in a line.
 *
 * @param spec - The spec.
 * @returns `2 vCPU · 8 GiB · disk 50 GB · data 50 GB (daily backups) · ubuntu-26.04 · open 80,443 · on chrisproject-services`.
 */
function spec_line(spec: VmSpec): string {
  const backup: string = spec.dataBackup === 'daily' ? ' (daily backups)' : '';
  return `${spec.vcpu} vCPU · ${spec.memory} GiB · disk ${spec.disk} GB · data ${spec.data} GB${backup} · ${spec.os} · open ${spec.open.length === 0 ? 'none' : spec.open.join(',')} · on ${spec.net}`;
}

/**
 * A VM, read, by name or the only one.
 *
 * @param context - The session.
 * @param name - The VM; the only one when absent and there is one.
 * @param verb - The verb asking, for its refusals.
 * @returns Its name, record and spec, or why not.
 */
function vm_need(context: VmCommandContext, name: string | undefined, verb: string): { name: string; record: VmRecord; spec: VmSpec } | { error: string } {
  const names: string[] = context.store.names_list();
  if (name === undefined) {
    if (names.length === 1) name = names[0] as string;
    else return { error: `vm ${verb}: name the VM (${names.length === 0 ? 'none declared: vm new <name> --net <network> …' : names.join(', ')})` };
  }
  const record: VmRecord | null = context.store.record_read(name);
  const read = context.store.spec_read(name);
  if (record === null || read === null) return { error: `vm ${verb}: ${name}: no such VM${names.length > 0 ? ` (${names.join(', ')})` : ''}` };
  if ('error' in read) return { error: `vm ${verb}: ${name}: spec.yaml: ${read.error}` };
  return { name, record, spec: read.spec };
}

/**
 * One VM's lines.
 *
 * @param record - Its state.
 * @param spec - Its spec, or null when it does not read.
 * @returns The lines.
 */
function vmStatus_lines(record: VmRecord, spec: VmSpec | null): string[] {
  const state: string = vmState_word(record);
  const tone = state === 'built' ? chalk.cyan : state === 'gone' ? chalk.gray : chalk.yellow;
  const guard: string = record.protected === true ? chalk.gray('  protected') : chalk.yellow('  unprotected');
  const lines: string[] = [`${chalk.bold(record.name)}  ${tone(state)}${guard}  ${record.region}`];
  lines.push(`  ${spec === null ? chalk.red('spec.yaml does not read') : spec_line(spec)}`);
  if (record.dataOutputs !== undefined) lines.push(`  address  ${record.dataOutputs['public_ip'] ?? '?'}${record.built === undefined ? chalk.gray(' (reserved, kept)') : ''}`);
  if (record.machineOutputs !== undefined) lines.push(`  inside   ${record.machineOutputs['private_ip'] ?? '?'}, instance ${record.machineOutputs['instance_id'] ?? '?'}`);
  if (record.dataOutputs?.['volume_id'] !== undefined) lines.push(`  data     ${record.dataOutputs['volume_id']}`);
  if (record.image !== undefined) lines.push(chalk.gray(`  image    ${record.image} (pinned)`));
  if (record.built !== undefined) lines.push(chalk.gray(`  built ${record.built}`));
  if (record.machineGone !== undefined && record.built === undefined) lines.push(chalk.gray(`  machine torn down ${record.machineGone}: vm build ${record.name} makes it again over the kept data`));
  if (record.gone !== undefined) lines.push(chalk.gray(`  torn down ${record.gone}: vm build ${record.name} builds it again, empty`));
  return lines;
}

/**
 * `vm status [<name>…]`.
 *
 * @param context - The session.
 * @param names - The VMs asked about; every one when none.
 * @returns The envelope.
 */
function vmStatus_run(context: VmCommandContext, names: ReadonlyArray<string>): CommandEnvelope {
  const kept: string[] = context.store.names_list();
  if (kept.length === 0) return envelope_ok('no VMs: vm new <name> --net <network> --vcpu … declares one\n');
  const missing: string[] = names.filter((name: string): boolean => !kept.includes(name));
  if (missing.length > 0) return envelope_error('', undefined, `vm: ${missing.join(', ')}: no such VM (${kept.join(', ')})\n`);
  const blocks: string[] = (names.length === 0 ? kept : [...names]).map((name: string): string => {
    const read = context.store.spec_read(name);
    return vmStatus_lines(context.store.record_read(name) as VmRecord, read !== null && 'spec' in read ? read.spec : null).join('\n');
  });
  return envelope_ok(`${blocks.join('\n\n')}\n`);
}

/**
 * `vm new <name> …`: declares; on one declared, compares.
 *
 * @param context - The session.
 * @param args - The words after `new`.
 * @returns The envelope.
 */
function vmNew_run(context: VmCommandContext, args: ReadonlyArray<string>): CommandEnvelope {
  const read = options_read(args, VM_OPTIONS);
  if ('error' in read) return envelope_error('', undefined, `vm new: ${read.error} (${VM_OPTIONS.join(', ')})\n`);
  const [name, ...extra] = read.rest;
  if (name === undefined || extra.length > 0) return envelope_error('', undefined, 'vm new: usage: vm new <name> --net <network> --vcpu <n> --memory <GiB> --disk <GB> --data <GB> --os <os> [--open <ports>] [--data-backup daily|none]\n');
  if (!VM_NAME.test(name)) return envelope_error('', undefined, `vm new: ${name}: a VM's name is a hostname: lower-case letters, digits and hyphens, starting with a letter, at most 32\n`);
  const before = context.store.spec_read(name);
  const keptSpec: VmSpec | null = before !== null && 'spec' in before ? before.spec : null;
  const spec = vmSpec_read(read.options, keptSpec);
  if ('error' in spec) return envelope_error('', undefined, `vm new: ${spec.error}\n`);
  const region: string | null = context.region();
  const kept: VmRecord | null = context.store.record_read(name);
  if (kept === null && region === null) return envelope_error('', undefined, 'vm new: not connected: the region a VM is built in is the session\'s\n');
  const changes: string[] = keptSpec !== null ? vmSpec_diff(keptSpec, spec.spec) : [];
  if (kept !== null && keptSpec !== null && changes.length === 0) return envelope_ok(`${name}: unchanged\n`);
  context.store.declare(name, spec.spec, kept?.region ?? (region as string));
  if (kept === null || keptSpec === null) return envelope_ok(`${name}: declared, ${spec_line(spec.spec)}, in ${kept?.region ?? region}; protected; vm build ${name} builds it\n`);
  const lost: string[] = kept.dataOutputs !== undefined ? vmSpec_dataLoss(keptSpec, spec.spec) : [];
  const note: string = lost.length > 0 ? chalk.red(`; the build refuses this unless --allow-alter: it makes a new, empty data volume (${lost.join('; ')})`) : kept.built !== undefined ? chalk.gray(`; built: vm build ${name} plans the change and asks`) : '';
  return envelope_ok(`${name}: ${changes.join(', ')}${note}\n`);
}

/**
 * The VM's cost at list price, or null when the cloud does not price it.
 *
 * @param context - The session.
 * @param spec - The spec.
 * @returns The cost.
 */
async function cost_read(context: VmCommandContext, spec: VmSpec): Promise<VmCost | null> {
  try {
    return vmCost_estimate(spec, context.builder?.vmShape, await context.driver.prices_list(), await context.driver.servicePrices_get());
  } catch {
    return null;
  }
}

/**
 * A cost in a line: the whole, then what a default teardown keeps.
 *
 * @param cost - The cost, or null.
 * @returns `$0.052 an hour, $37.96 a month (the data, kept after a teardown: …)`.
 */
function cost_line(cost: VmCost | null): string {
  if (cost === null) return 'not priced (the cloud gave no list price for its shape or storage)';
  return `${cost_words(cost.machineHour + cost.dataHour, cost.currency)} (the data alone, kept after a teardown: ${cost_words(cost.dataHour, cost.currency)})`;
}

/**
 * `vm plan [<name>]`.
 *
 * @param context - The session.
 * @param args - The words after `plan`.
 * @returns The envelope.
 */
async function vmPlan_run(context: VmCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  if (args.length > 1 || args.some((word: string): boolean => word.startsWith('-'))) return envelope_error('', undefined, 'vm plan: usage: vm plan [<name>]\n');
  const need = vm_need(context, args[0], 'plan');
  if ('error' in need) return envelope_error('', undefined, `${need.error}\n`);
  const { record, spec } = need;
  const lines: string[] = vmStatus_lines(record, spec);
  lines.push(`cost  ${cost_line(await cost_read(context, spec))}`);
  try {
    vmNet_read(context.nets, spec);
    lines.push(chalk.gray(`net   ${spec.net} is built`));
  } catch (error: unknown) {
    lines.push(chalk.yellow(`net   ${error instanceof Error ? error.message : String(error)}`));
  }
  return envelope_ok(`${lines.join('\n')}\n`);
}

/**
 * A part's plan kept, and its counts.
 *
 * @param context - The session.
 * @param name - The VM.
 * @param part - Which stack.
 * @returns The plan and counts, or null when none is kept.
 */
function planKept_read(context: VmCommandContext, name: string, part: VmPart): { plan: InfraPlan; counts: PlanCounts } | null {
  const text: string | null = context.store.file_read(name, planFile_derive(part));
  if (text === null) return null;
  const plan: InfraPlan = JSON.parse(text) as InfraPlan;
  return { plan, counts: plan_count(plan) };
}

/**
 * How many changes a plan makes.
 *
 * @param counts - Its counts.
 * @returns The total, drift aside.
 */
function counts_total(counts: PlanCounts): number {
  return counts.create + counts.replace + counts.change + counts.destroy;
}

/**
 * Plans a part as a task.
 *
 * @param name - The VM.
 * @param part - Which stack.
 * @param deps - What it runs over.
 * @param context - The session.
 * @returns The counts, or why not.
 */
async function part_plan(name: string, part: VmPart, deps: VmDeps, context: VmCommandContext): Promise<{ counts: PlanCounts } | { error: string }> {
  const ran = await job_runFollowed(VM_JOBS.plan(name, part), `plan ${name} ${part}`, vmPlanRun_make(name, part, deps));
  if ('error' in ran) return ran;
  const kept = planKept_read(context, name, part);
  if (kept === null) return { error: `${name}: the ${part} plan left nothing to read` };
  return { counts: kept.counts };
}

/**
 * `vm build <name> [--allow-alter]`: plans the data (and the machine, when the
 * data stands) as tasks, asks with the cost, applies the data, then the machine.
 *
 * @param context - The session.
 * @param args - The words after `build`.
 * @returns The envelope.
 */
async function vmBuild_run(context: VmCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const allowAlter: boolean = args.includes('--allow-alter');
  const words: string[] = args.filter((word: string): boolean => word !== '--allow-alter');
  const unknown: string | undefined = words.find((word: string): boolean => word.startsWith('-'));
  if (unknown !== undefined) return envelope_error('', undefined, `vm build: ${unknown}: unknown option (--allow-alter)\n`);
  if (words.length > 1) return envelope_error('', undefined, 'vm build: usage: vm build [<name>] [--allow-alter]\n');
  const need = vm_need(context, words[0], 'build');
  if ('error' in need) return envelope_error('', undefined, `${need.error}\n`);
  if (!tasks_granted()) return envelope_error('', undefined, 'vm build: needs the tasks tier (stratus --host-control tasks): without it, nothing outside this host changes\n');
  const deps = deps_make(context);
  if ('error' in deps) return envelope_error('', undefined, `vm build: ${deps.error}\n`);
  const { name, spec } = need;
  try {
    vmNet_read(context.nets, spec);
  } catch (error: unknown) {
    return envelope_error('', undefined, `vm build: ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  const data = await part_plan(name, 'data', deps, context);
  if ('error' in data) return envelope_error('', undefined, `vm build: ${data.error}\n`);
  const dataStands: boolean = context.store.record_read(name)?.dataOutputs !== undefined;
  const machine = dataStands ? await part_plan(name, 'machine', deps, context) : null;
  if (machine !== null && 'error' in machine) return envelope_error('', undefined, `vm build: ${machine.error}\n`);
  if (counts_total(data.counts) === 0 && machine !== null && counts_total(machine.counts) === 0) {
    context.store.file_remove(name, planFile_derive('data'));
    context.store.file_remove(name, planFile_derive('machine'));
    return envelope_ok(`${name}: built, and the plan reads nothing to do\n`);
  }
  for (const [part, counts] of [['data', data.counts], ['machine', machine?.counts]] as Array<[VmPart, PlanCounts | undefined]>) {
    if (counts !== undefined && planCounts_alter(counts) && !allowAlter) return envelope_error('', undefined, `vm build: ${name}: the ${part} plan ${planCounts_words(counts)}: it touches what exists, refused unless vm build ${name} --allow-alter\n`);
  }
  const machineWords: string = machine === null ? `planned once its data stands (${spec.vcpu} vCPU, ${spec.memory} GiB, disk ${spec.disk} GB)` : planCounts_words(machine.counts);
  const yes: boolean = await repl_confirm(`vm build ${name}: data ${planCounts_words(data.counts)}; machine ${machineWords}. It bills: ${cost_line(await cost_read(context, spec))}. Continue? [y/N]`);
  if (!yes) return envelope_ok(`${chalk.gray(`stopped before the apply; nothing changed (vm build ${name} plans and asks again)`)}\n`);
  if (counts_total(data.counts) > 0) {
    const applied = await job_runFollowed(VM_JOBS.apply(name, 'data'), `apply ${name} data`, vmApplyRun_make(name, 'data', deps));
    if ('error' in applied) return envelope_error('', undefined, `vm build: ${applied.error}\n`);
  } else {
    context.store.file_remove(name, planFile_derive('data'));
  }
  let machineCounts: PlanCounts | undefined = machine?.counts;
  if (machine === null) {
    const planned = await part_plan(name, 'machine', deps, context);
    if ('error' in planned) return envelope_error('', undefined, `vm build: ${planned.error}\n`);
    if (planCounts_alter(planned.counts) && !allowAlter) return envelope_error('', undefined, `vm build: ${name}: the machine plan ${planCounts_words(planned.counts)}: it touches what exists, refused unless vm build ${name} --allow-alter\n`);
    machineCounts = planned.counts;
  }
  if (machineCounts !== undefined && counts_total(machineCounts) > 0) {
    const applied = await job_runFollowed(VM_JOBS.apply(name, 'machine'), `apply ${name} machine`, vmApplyRun_make(name, 'machine', deps));
    if ('error' in applied) return envelope_error('', undefined, `vm build: ${applied.error}\n`);
  } else {
    context.store.file_remove(name, planFile_derive('machine'));
  }
  return envelope_ok(`${vmStatus_lines(context.store.record_read(name) as VmRecord, spec).join('\n')}\n`);
}

/**
 * The SSH line that reaches a VM through a bastion session: the bastion as
 * the proxy, the VM's own key for both hops, the VM's host key kept in its folder.
 *
 * @param session - The session's id and the bastion's host.
 * @param keyPath - The VM's private key.
 * @param privateIp - The VM's address inside the network.
 * @returns The line.
 */
export function sshLine_build(session: { sessionId: string; host: string }, keyPath: string, privateIp: string): string {
  const known: string = path.join(path.dirname(keyPath), 'known_hosts');
  const common: string = `-i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${known}`;
  return `ssh ${common} -o ProxyCommand="ssh ${common} -W %h:%p -p 22 ${session.sessionId}@${session.host}" ${VM_USER}@${privateIp}`;
}

/**
 * `vm shell <name>`: a session on the network's bastion, and the SSH line that uses it.
 *
 * @param context - The session.
 * @param args - The words after `shell`.
 * @returns The envelope.
 */
async function vmShell_run(context: VmCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const words: string[] = args.filter((word: string): boolean => word !== '--print');
  if (words.length > 1 || words.some((word: string): boolean => word.startsWith('-'))) return envelope_error('', undefined, 'vm shell: usage: vm shell [<name>] [--print]\n');
  const need = vm_need(context, words[0], 'shell');
  if ('error' in need) return envelope_error('', undefined, `${need.error}\n`);
  if (surface_get().capabilities.shellCommands !== true) return envelope_error('', undefined, 'vm shell: needs the shell tier (stratus --host-control shell)\n');
  const { name, record, spec } = need;
  const privateIp: string | undefined = record.machineOutputs?.['private_ip'];
  if (record.built === undefined || privateIp === undefined) return envelope_error('', undefined, `vm shell: ${name}: not built (vm build ${name})\n`);
  const open = context.builder?.shellSession_open?.bind(context.builder);
  if (open === undefined) return envelope_error('', undefined, `vm shell: the ${context.builder?.id ?? 'session\'s'} cloud opens no shell sessions\n`);
  let bastionId: string | undefined;
  try {
    bastionId = vmNet_read(context.nets, spec).outputs['bastion_id'];
  } catch (error: unknown) {
    return envelope_error('', undefined, `vm shell: ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  if (bastionId === undefined) return envelope_error('', undefined, `vm shell: ${name}: the network ${spec.net} has no bastion\n`);
  const key = context.store.key_ensure(name);
  try {
    const session = await open({ region: record.region, bastionId, privateIp, publicKey: key.publicKey, ttlSeconds: SESSION_TTL_SECONDS, label: name }, { log: (): void => undefined, signal: new AbortController().signal });
    return envelope_ok(`${sshLine_build(session, key.privatePath, privateIp)}\n${chalk.gray(`(the session lasts three hours; the bastion may refuse the key for its first half minute; run the line with ! here or in a terminal on this host)`)}\n`);
  } catch (error: unknown) {
    return envelope_error('', undefined, `vm shell: ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/**
 * `vm protect <name> on|off`.
 *
 * @param context - The session.
 * @param args - The words after `protect`.
 * @returns The envelope.
 */
function vmProtect_run(context: VmCommandContext, args: ReadonlyArray<string>): CommandEnvelope {
  const [nameWord, setting, ...extra] = args;
  if (nameWord === undefined || (setting !== 'on' && setting !== 'off') || extra.length > 0) return envelope_error('', undefined, 'vm protect: usage: vm protect <name> on|off\n');
  const need = vm_need(context, nameWord, 'protect');
  if ('error' in need) return envelope_error('', undefined, `${need.error}\n`);
  context.store.record_update(need.name, (current: VmRecord): void => { current.protected = setting === 'on'; });
  return envelope_ok(`${need.name}: ${setting === 'on' ? 'protected: teardown refuses' : `unprotected: vm teardown ${need.name} may remove it`}\n`);
}

/**
 * `vm teardown <name> [--all]`.
 *
 * @param context - The session.
 * @param args - The words after `teardown`.
 * @returns The envelope.
 */
async function vmTeardown_run(context: VmCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const all: boolean = args.includes('--all');
  const words: string[] = args.filter((word: string): boolean => word !== '--all');
  if (words.length !== 1 || (words[0] as string).startsWith('-')) return envelope_error('', undefined, 'vm teardown: usage: vm teardown <name> [--all]\n');
  const need = vm_need(context, words[0], 'teardown');
  if ('error' in need) return envelope_error('', undefined, `${need.error}\n`);
  const { name, record, spec } = need;
  if (record.machineStackRef === undefined && (!all || record.dataStackRef === undefined)) return envelope_ok(`${name}: nothing of it ${all ? 'is built' : 'but its kept data is built (vm teardown --all takes that)'}\n`);
  if (record.protected === true) return envelope_error('', undefined, `vm teardown: ${name}: protected (vm protect ${name} off)\n`);
  if (!tasks_granted()) return envelope_error('', undefined, 'vm teardown: needs the tasks tier (stratus --host-control tasks)\n');
  const deps = deps_make(context);
  if ('error' in deps) return envelope_error('', undefined, `vm teardown: ${deps.error}\n`);
  const cost: VmCost | null = await cost_read(context, spec);
  if (all) {
    const answer: string = (await repl_question(`Remove the VM ${name} whole: its machine, its data volume and backups, and its address ${record.dataOutputs?.['public_ip'] ?? ''}? The data cannot be had back. Type the VM's name to go on:`)).trim();
    if (answer !== name) return envelope_ok(`${chalk.gray(`${answer === '' ? 'nothing typed' : `${answer} is not ${name}`}: nothing removed`)}\n`);
  } else {
    const kept: string = cost === null ? '' : ` (${cost_words(cost.dataHour, cost.currency)})`;
    const yes: boolean = await repl_confirm(`vm teardown ${name}: remove its machine and boot disk; keep its data volume, backups and address ${record.dataOutputs?.['public_ip'] ?? ''}${kept}. Continue? [y/N]`);
    if (!yes) return envelope_ok(`${chalk.gray('nothing removed')}\n`);
  }
  const ran = await job_runFollowed(VM_JOBS.teardown(name), `teardown ${name}`, vmTeardownRun_make(name, all, deps));
  if ('error' in ran) return envelope_error('', undefined, `vm teardown: ${ran.error}\n`);
  return envelope_ok(all ? `${name}: torn down whole; its spec stays (vm build ${name} builds it again, empty)\n` : `${name}: its machine is gone; its data and address stay (vm build ${name} makes the machine again over them)\n`);
}

/**
 * `vm`.
 *
 * @param context - The session.
 * @param args - The words after `vm`.
 * @returns The envelope.
 */
export async function vm_run(context: VmCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const [verb = 'status', ...rest] = args;
  switch (verb) {
    case 'status': return vmStatus_run(context, rest);
    case 'new': return vmNew_run(context, rest);
    case 'plan': return await vmPlan_run(context, rest);
    case 'build': return await vmBuild_run(context, rest);
    case 'shell': return await vmShell_run(context, rest);
    case 'protect': return vmProtect_run(context, rest);
    case 'teardown': return await vmTeardown_run(context, rest);
    default:
      if (rest.length === 0 && context.store.names_list().includes(verb)) return vmStatus_run(context, [verb]);
      return envelope_error('', undefined, `vm: ${verb}: not a verb (vm status, new, plan, build, shell, protect, teardown)\n`);
  }
}

/** `vm`'s help. */
export const VM_HELP: CommandHelp = {
  usage: 'vm [status [<name>…]] | vm <name> | vm new <name> --net <network> --vcpu <n> --memory <GiB> --disk <GB> --data <GB> --os <os> [--open <ports>] [--data-backup daily|none] | vm plan [<name>] | vm build [<name>] [--allow-alter] | vm shell [<name>] | vm protect <name> on|off | vm teardown <name> [--all]',
  summary: 'Declare, build, reach and tear down VMs on a network',
  category: 'Resources',
  description: 'vm new declares a VM and builds nothing; on a VM already declared it compares, printing unchanged or the change (a script is the truth), and an option not given keeps its value. A VM stands on a built network (--net) and is named in portable words only: vCPUs, memory in GiB, a boot disk and a data volume in GB (50 at least), the operating system (ubuntu-26.04), the ports open to the internet (--open 80,443; SSH goes through the network\'s bastion) and daily backups of its data. The driver chooses the rest: on OCI an E5.Flex (two vCPUs to an OCPU), the newest image of the OS (pinned at the first build), the first availability domain. A VM is two stacks: its data (the volume, its backups, a reserved address) and its machine (the instance, its boot disk, a security group, the volume\'s attachment); cloud-init formats the volume once, mounts it at /srv/data and puts Docker\'s data there. vm plan says the size, the network and the cost. vm build plans as tasks (/proc/steps/vm-<name>-plan-data, -machine), says the counts and the cost and asks, applies the data and the machine and points the address at it; a plan that touches what exists is refused unless --allow-alter. vm shell (shell tier) opens a three-hour session on the network\'s bastion for the VM\'s own key and prints the ssh line. A VM is born protected: vm protect <name> off lets teardown run. vm teardown removes the machine and keeps the data, backups and address, so the next build brings it back with its data and name; --all takes those too, asking for the name typed back.',
  examples: ['vm new store --net chrisproject-services --open 80,443 --vcpu 2 --memory 8 --disk 50 --data 50 --data-backup daily --os ubuntu-26.04', 'vm plan store', 'vm build store', 'vm shell store', 'vm protect store off', 'vm teardown store'],
};
