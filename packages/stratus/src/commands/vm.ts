/**
 * @file `vm`: the VMs a tenancy runs on its networks (docs/stratus.adoc, D16).
 *
 * `vm new <name> --net … --vcpu … --memory … --disk … --data … --os …`
 * declares a VM and builds nothing; on one already declared it compares,
 * saying `unchanged` or the change. `vm plan [<name>]` says its size, its
 * network and its cost. `vm build <name>` plans its data and its machine as
 * tasks, says the counts and the cost and asks, then applies the data, the
 * machine, and points the reserved address at it; a plan that replaces or removes what
 * exists is refused unless `--allow-alter`. `vm shell <name>` opens a session
 * on the network's bastion and prints the SSH line that reaches the VM.
 * On a VM that stands, `vm build` resizes in place (`vm/resize.ts`). `vm
 * keep <name>` keeps the VM's secrets in the tenancy, of which this host's
 * records are a cache (`vm/keep.ts`).
 * `vm protect <name> on|off`: a VM is born protected, and teardown refuses
 * while it is. `vm teardown <name>` removes the machine and keeps the data,
 * its backups and the address; `--all` takes those too, asking for the name
 * typed back. A bare `vm` is `vm status`.
 *
 * @module
 */
import * as path from 'path';
import chalk from 'chalk';
import { envelope_error, envelope_ok, STRATUS_VM_COST_MODEL_KIND, STRATUS_VM_LIMITS_MODEL_KIND, STRATUS_VM_STATE_EVENT, STRATUS_VM_STATUS_MODEL_KIND, type CommandEnvelope, type VmCostRow, type VmState, type VmStatusRow } from '@fnndsc/menu';
import { repl_confirm, repl_question, sink_dataLine, sink_get, surface_get, type CommandHelp } from '@fnndsc/brasa/core';
import { plan_count, planCounts_words, type BuildCall, type CloudBuilder, type InfraPlan, type PlanCounts } from '../cloud/builder.js';
import type { VmRemote } from '../vm/remote.js';
import type { CloudDriver } from '../cloud/driver.js';
import type { NetStore } from '../net/state.js';
import { VM_OPTIONS, vmLimits_derive, vmLimits_lines, vmSpec_dataLoss, vmSpec_diff, vmSpec_read, type VmSpec } from '../vm/spec.js';
import type { CloudShape } from '../cloud/driver.js';
import { CHRIS_PORTER_TAG, CHRIS_URL_TAG, VM_NAME, VM_USER, type VmRecord, type VmStore } from '../vm/state.js';
import { vmsFound_read, vmTakeover_run, type FoundVm } from '../vm/found.js';
import { VM_KEYLESS, vmKey_held, vmKeyless_is, vmKept_write } from '../vm/keep.js';
import { cost_words, planFile_derive, VM_JOBS, vmApplyRun_make, vmCost_estimate, vmNet_read, vmPlanRun_make, vmTeardownRun_make, type VmCost, type VmDeps, type VmPart } from '../vm/build.js';
import { job_runFollowed, options_read, tasks_granted } from './build.js';
import { VM_GROW_JOB, vmGrowRun_make, vmPlan_judge, type VmPlanJudged } from '../vm/resize.js';
import { HOURS_PER_MONTH } from '../cluster/spend.js';
import { TIER_REFUSAL } from '../tier.js';

/** What `vm` reads from the session. */
export interface VmCommandContext {
  readonly store: VmStore;
  readonly nets: NetStore;
  readonly driver: CloudDriver;
  /** The cloud's build half, or null when it has none. */
  readonly builder: CloudBuilder | null;
  /** The session's region, or null when not connected. */
  readonly region: () => string | null;
  /** Reaches a VM over its bastion, for the filesystems a build grew; the network's bastion and `ssh` when absent. */
  readonly remote_open?: (name: string, call: BuildCall) => Promise<VmRemote>;
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
function vmState_word(record: VmRecord): VmState {
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
 * A VM, read, or taken over from the tenancy on this first act when the
 * tenancy runs it and this session keeps no record of it (built by another
 * session): its records read back from its stacks, born protected here.
 *
 * @param context - The session.
 * @param name - The VM; the only one kept when absent and there is one.
 * @param verb - The verb asking, for its refusals.
 * @returns Its name, record and spec, and the line saying it was taken over (empty when it was kept), or why not.
 */
async function vm_needOrTake(context: VmCommandContext, name: string | undefined, verb: string): Promise<{ name: string; record: VmRecord; spec: VmSpec; said: string } | { error: string }> {
  const need = vm_need(context, name, verb);
  if (!('error' in need)) return { ...need, said: '' };
  const region: string | null = context.region();
  if (name === undefined || region === null || context.store.record_read(name) !== null) return need;
  let took: Awaited<ReturnType<typeof vmTakeover_run>>;
  try {
    took = await vmTakeover_run({ store: context.store, nets: context.nets, driver: context.driver, builder: context.builder, region }, name);
  } catch (error: unknown) {
    return { error: `vm ${verb}: ${name}: the tenancy was not read (${error instanceof Error ? error.message : String(error)})` };
  }
  if ('absent' in took) return need;
  if ('error' in took) return { error: `vm ${verb}: ${took.error}` };
  const again = vm_need(context, name, verb);
  if ('error' in again) return again;
  return { ...again, said: chalk.gray(`${name}: read from the tenancy (built by a session that left no record here): its stacks${took.keyed ? ' and the secrets its vault keeps' : ''}; protected here until lifted\n`) };
}

/**
 * One VM's lines.
 *
 * @param store - The VMs.
 * @param record - Its state.
 * @param spec - Its spec, or null when it does not read.
 * @returns The lines.
 */
function vmStatus_lines(store: VmStore, record: VmRecord, spec: VmSpec | null): string[] {
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
  if (record.takenFrom !== undefined) lines.push(chalk.gray(`  read from the tenancy ${record.takenFrom}`) + (vmKey_held(store, record.name) ? '' : chalk.yellow(`: ${VM_KEYLESS}`)));
  if (record.machineGone !== undefined && record.built === undefined) lines.push(chalk.gray(`  machine torn down ${record.machineGone}: vm build ${record.name} makes it again over the kept data`));
  if (record.gone !== undefined) lines.push(chalk.gray(`  torn down ${record.gone}: vm build ${record.name} builds it again, empty`));
  return lines;
}

/**
 * A kept VM as a row of the model `vm status` answers, and the VM state event carries.
 *
 * @param context - The session.
 * @param name - The VM, kept here.
 * @returns The row.
 */
function vmRowKept_make(context: VmCommandContext, name: string): VmStatusRow {
  const record: VmRecord = context.store.record_read(name) as VmRecord;
  const read = context.store.spec_read(name);
  const steps = record.teardown?.steps ?? {};
  return {
    name,
    state: vmState_word(record),
    region: record.region,
    spec: read !== null && 'spec' in read ? read.spec : null,
    address: record.dataOutputs?.['public_ip'] ?? null,
    inside: record.machineOutputs?.['private_ip'] ?? null,
    protected: record.protected === true,
    built: record.built ?? null,
    chris: record.chris === undefined ? null : { profile: record.chris.profile, compute: record.chris.compute, host: record.chris.host, url: record.chris.url, porter: record.chris.porter ?? null },
    takenFrom: record.takenFrom ?? null,
    keyless: vmKeyless_is(context.store, record),
    teardown: record.teardown === undefined ? null : {
      started: record.teardown.started,
      steps: ['machine', 'data'].map((part: string) => ({ name: part, state: steps[part]?.state ?? 'not done', started: steps[part]?.started ?? null, ended: steps[part]?.ended ?? null, note: steps[part]?.note ?? null })),
    },
  };
}

/**
 * A VM the tenancy runs that this session keeps no record of, in lines.
 *
 * @param found - What the cloud says of it.
 * @returns The lines.
 */
function vmFound_lines(found: FoundVm): string[] {
  const instance = found.instance;
  const state: string = instance === null ? 'data only' : instance.state;
  const lines: string[] = [`${chalk.bold(found.name)}  ${chalk.magenta('found')} ${state}  ${chalk.gray(found.tagged ? 'built by stratus, not kept in this session' : 'made outside stratus')}`];
  if (instance !== null) {
    const size: string = instance.vcpus !== undefined ? ` · ${instance.vcpus} vCPU${instance.memoryGib !== undefined ? ` · ${instance.memoryGib} GiB` : ''}` : '';
    lines.push(`  ${instance.shape}${size} · ${instance.zone}`);
    const [inside, ...outside] = instance.ips;
    if (outside.length > 0) lines.push(`  address  ${outside.join(', ')}`);
    if (inside !== undefined) lines.push(`  inside   ${inside}, instance ${instance.id}`);
    if (instance.tags[CHRIS_URL_TAG] !== undefined) lines.push(`  chris    ${instance.tags[CHRIS_URL_TAG]}${instance.tags[CHRIS_PORTER_TAG] !== undefined ? `, porter ${instance.tags[CHRIS_PORTER_TAG]}` : ''}`);
  } else {
    lines.push(chalk.gray('  its machine is gone; its data stack stands'));
  }
  return lines;
}

/**
 * Brings this host's cache in line with the tenancy (docs/stratus.adoc, D16:
 * the tenancy is the truth, a host's records its cache). A VM stratus built
 * that the cache lacks is read in from its stacks and the vault; a cached VM
 * the tenancy has moved past (its machine rebuilt, resized, or torn down from
 * another session) is read again or marked so. A VM made outside stratus
 * stays found, read and never acted on. A VM with an act in flight here (a
 * plan waiting on its apply, a teardown running) is left as it is.
 *
 * @param context - The session.
 * @param region - The region searched.
 * @param tenancy - Every VM the tenancy runs there.
 * @returns The VMs that stay found (not read into the cache), and a line for each the cache could not read.
 */
async function vmCache_reconcile(context: VmCommandContext, region: string, tenancy: ReadonlyArray<FoundVm>): Promise<{ found: FoundVm[]; notes: string[] }> {
  const notes: string[] = [];
  const found: FoundVm[] = [];
  const busy = (name: string): boolean => context.store.file_read(name, planFile_derive('data')) !== null || context.store.file_read(name, planFile_derive('machine')) !== null
    || Object.values(context.store.record_read(name)?.teardown?.steps ?? {}).some((step): boolean => step.state === 'running');
  const take = async (name: string): Promise<boolean> => {
    try {
      const took = await vmTakeover_run({ store: context.store, nets: context.nets, driver: context.driver, builder: context.builder, region }, name);
      if ('error' in took) { notes.push(took.error); return false; }
      return 'taken' in took;
    } catch (error: unknown) {
      notes.push(`${name}: not read from the tenancy (${error instanceof Error ? error.message : String(error)})`);
      return false;
    }
  };
  const byName: Map<string, FoundVm> = new Map(tenancy.map((vm: FoundVm): [string, FoundVm] => [vm.name, vm]));
  for (const vm of tenancy) {
    if (context.store.record_read(vm.name) !== null) continue;
    if (!vm.tagged || !await take(vm.name)) found.push(vm);
  }
  for (const name of context.store.names_list()) {
    const record: VmRecord | null = context.store.record_read(name);
    if (record === null || record.region !== region || busy(name)) continue;
    const there: FoundVm | undefined = byName.get(name);
    const stands: boolean = record.built !== undefined || (record.dataOutputs !== undefined && record.gone === undefined);
    if (there === undefined) {
      if (stands) context.store.record_update(name, (current: VmRecord): void => {
        delete current.built; delete current.machineOutputs; delete current.machineStackRef; delete current.dataOutputs; delete current.dataStackRef; delete current.seen; delete current.machineGone;
        current.gone = new Date().toISOString();
      });
      continue;
    }
    const instance = there.instance;
    if (instance === null) {
      if (record.built !== undefined) context.store.record_update(name, (current: VmRecord): void => {
        delete current.built; delete current.machineOutputs; delete current.machineStackRef; delete current.seen;
        current.machineGone = new Date().toISOString();
      });
      continue;
    }
    if (record.built === undefined) { await take(name); continue; }
    if (record.seen === undefined) {
      context.store.record_update(name, (current: VmRecord): void => { current.seen = { instanceId: instance.id, vcpus: instance.vcpus ?? 0, memoryGib: instance.memoryGib ?? 0 }; });
      continue;
    }
    const moved: boolean = record.seen.instanceId !== instance.id
      || (instance.vcpus !== undefined && record.seen.vcpus !== instance.vcpus) || (instance.memoryGib !== undefined && record.seen.memoryGib !== instance.memoryGib);
    if (moved) await take(name);
  }
  return { found, notes };
}

/**
 * `vm status [<name>…]`: every VM the tenancy runs. The tenancy is the truth
 * about what runs (docs/stratus.adoc, D16), and this host's records a cache
 * of it, brought in line on each listing: a VM stratus built is listed with
 * its records whichever session built it; one made outside stratus is listed
 * as found, from the cloud alone.
 *
 * @param context - The session.
 * @param names - The VMs asked about; every one when none.
 * @returns The envelope.
 */
async function vmStatus_run(context: VmCommandContext, names: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const region: string | null = context.region();
  const notes: string[] = [];
  let found: FoundVm[] = [];
  let unsearched: string | null = region === null ? 'not connected' : null;
  if (region !== null) {
    let tenancy: FoundVm[] | null = null;
    try {
      tenancy = await vmsFound_read(context.driver, region);
    } catch (error: unknown) {
      unsearched = error instanceof Error ? error.message : String(error);
    }
    if (tenancy !== null) {
      const reconciled = await vmCache_reconcile(context, region, tenancy);
      found = reconciled.found;
      notes.push(...reconciled.notes);
    }
  }
  const kept: string[] = context.store.names_list();
  const unsearchedLine: string = (unsearched === null ? '' : `${chalk.yellow(`the tenancy was not searched for VMs (${unsearched}): only those this host keeps are listed`)}\n`)
    + notes.map((note: string): string => `${chalk.yellow(note)}\n`).join('');
  const all: string[] = [...kept, ...found.map((vm: FoundVm): string => vm.name)];
  if (all.length === 0) return envelope_ok(`${unsearchedLine}no VMs${unsearched === null ? ' here or in the tenancy' : ''}: vm new <name> --net <network> --vcpu … declares one\n`, { kind: STRATUS_VM_STATUS_MODEL_KIND, data: { vms: [] } });
  const missing: string[] = names.filter((name: string): boolean => !all.includes(name));
  if (missing.length > 0) return envelope_error('', undefined, `vm: ${missing.join(', ')}: no such VM (${all.join(', ')})\n`);
  const shown: string[] = names.length === 0 ? all : [...names];
  const foundBy: Map<string, FoundVm> = new Map(found.map((vm: FoundVm): [string, FoundVm] => [vm.name, vm]));
  const blocks: string[] = shown.map((name: string): string => {
    const seen: FoundVm | undefined = foundBy.get(name);
    if (seen !== undefined) return vmFound_lines(seen).join('\n');
    const read = context.store.spec_read(name);
    return vmStatus_lines(context.store, context.store.record_read(name) as VmRecord, read !== null && 'spec' in read ? read.spec : null).join('\n');
  });
  // The same rows as a model, for a surface's tile (docs/stratus.adoc, D17): a kept VM from its records, a found one from the cloud.
  const rows: VmStatusRow[] = shown.map((name: string): VmStatusRow => {
    const seen: FoundVm | undefined = foundBy.get(name);
    if (seen !== undefined) {
      const instance = seen.instance;
      const [inside, ...outside] = instance?.ips ?? [];
      return {
        name, state: 'found', region: instance?.region ?? region ?? '', spec: null,
        // Found, it stands protected: acting on it takes it over born protected, and the lock is lifted as its own line.
        address: outside[0] ?? null, inside: inside ?? null, protected: true, built: null, chris: null,
        found: {
          state: instance === null ? 'data only' : instance.state, instanceId: instance?.id ?? null, shape: instance?.shape ?? null,
          vcpus: instance?.vcpus ?? null, memoryGib: instance?.memoryGib ?? null, tagged: seen.tagged,
          chris: instance?.tags[CHRIS_URL_TAG] !== undefined ? { url: instance.tags[CHRIS_URL_TAG] as string, porter: instance.tags[CHRIS_PORTER_TAG] ?? null } : null,
        },
      };
    }
    return vmRowKept_make(context, name);
  });
  return envelope_ok(`${unsearchedLine}${blocks.join('\n\n')}\n`, { kind: STRATUS_VM_STATUS_MODEL_KIND, data: { vms: rows } });
}

/** `vm cost`'s usage. */
const VM_COST_USAGE: string = 'vm cost [<name> [--vcpu <n>] [--memory <GiB>] [--disk <GB>] [--data <GB>] [--data-backup daily|none] [--os <os>] [--net <network>] [--open <ports>]]';

/**
 * `vm new <name> …`: declares; on one declared, compares.
 *
 * @param context - The session.
 * @param args - The words after `new`.
 * @returns The envelope.
 */
async function vmNew_run(context: VmCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
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
  // A name the tenancy already runs, kept by no record here (built by another session, or made outside stratus), is
  // refused: declaring it here would build a second machine beside the first, under the same tag.
  if (kept === null && region !== null) {
    let running: FoundVm | undefined;
    try {
      running = (await vmsFound_read(context.driver, region)).find((vm: FoundVm): boolean => vm.name === name);
    } catch (error: unknown) {
      return envelope_error('', undefined, `vm new: ${name}: the tenancy was not searched (${error instanceof Error ? error.message : String(error)}): refusing, a VM by that name may already run\n`);
    }
    if (running !== undefined) return envelope_error('', undefined, `vm new: ${name}: Operation not permitted: the tenancy already runs a VM by that name (${running.tagged ? 'built by another stratus session' : 'made outside stratus'}); this session keeps no record of it, so it is read here (vm ${name}), never built over\n`);
  }
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
 * What a spec bills, in words: the machine's size and the data's.
 *
 * @param spec - The spec.
 * @returns `2 vCPU · 8 GiB · disk 50 GB · data 50 GB (daily backups)`.
 */
function size_line(spec: VmSpec): string {
  return `${spec.vcpu} vCPU · ${spec.memory} GiB · disk ${spec.disk} GB · data ${spec.data} GB${spec.dataBackup === 'daily' ? ' (daily backups)' : ''}`;
}

/**
 * A change in cost, from one spec's to another's.
 *
 * @param before - The cost declared.
 * @param after - The cost with the change.
 * @returns `$0.052 → $0.068 an hour, $37.83 → $49.51 a month (+$11.68 a month)`.
 */
function costChange_line(before: VmCost, after: VmCost): string {
  const symbol: string = after.currency === 'USD' ? '$' : `${after.currency} `;
  const hourA: number = before.machineHour + before.dataHour;
  const hourB: number = after.machineHour + after.dataHour;
  const monthA: number = hourA * HOURS_PER_MONTH;
  const monthB: number = hourB * HOURS_PER_MONTH;
  const delta: number = monthB - monthA;
  return `${symbol}${hourA.toFixed(3)} → ${symbol}${hourB.toFixed(3)} an hour, ${symbol}${monthA.toFixed(2)} → ${symbol}${monthB.toFixed(2)} a month (${delta < 0 ? '-' : '+'}${symbol}${Math.abs(delta).toFixed(2)} a month)`;
}

/**
 * `vm cost [<name> …]`: what a VM bills at list price, declaring nothing. The
 * words are `vm new`'s: on a declared VM the options given change its spec
 * for the answer and the difference is said; on a name not declared they are
 * the whole spec, `--net` not needed (the price is the session's region's).
 * Bare, every declared VM.
 *
 * @param context - The session.
 * @param args - The words after `cost`.
 * @returns The envelope.
 */
async function vmCost_run(context: VmCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const read = options_read(args, VM_OPTIONS);
  if ('error' in read) return envelope_error('', undefined, `vm cost: ${read.error} (${VM_OPTIONS.join(', ')})\n`);
  const [name, ...extra] = read.rest;
  if (extra.length > 0 || (name === undefined && read.options.size > 0)) return envelope_error('', undefined, `vm cost: usage: ${VM_COST_USAGE}\n`);
  if (name === undefined) {
    const names: string[] = context.store.names_list();
    if (names.length === 0) return envelope_ok('no VM declared: vm cost <name> --vcpu <n> --memory <GiB> --disk <GB> --data <GB> --os <os> prices one without declaring it\n');
    const lines: string[] = [];
    const rows: VmCostRow[] = [];
    for (const each of names) {
      const kept = context.store.spec_read(each);
      if (kept === null || 'error' in kept) { lines.push(`${chalk.bold(each)}: ${chalk.yellow('its spec cannot be read')}`); continue; }
      const cost: VmCost | null = await cost_read(context, kept.spec);
      lines.push(`${chalk.bold(each)}: ${size_line(kept.spec)}: ${cost_line(cost)}`);
      rows.push({ name: each, declared: true, spec: kept.spec, cost, changes: [], before: null });
    }
    return envelope_ok(`${lines.join('\n')}\n`, { kind: STRATUS_VM_COST_MODEL_KIND, data: { vms: rows } });
  }
  const before = context.store.spec_read(name);
  const keptSpec: VmSpec | null = before !== null && 'spec' in before ? before.spec : null;
  const options: Map<string, string> = new Map(read.options);
  // The network only places a VM; its price is the session's region's.
  if (keptSpec === null && !options.has('--net')) options.set('--net', '-');
  const spec = vmSpec_read(options, keptSpec);
  if ('error' in spec) return envelope_error('', undefined, `vm cost: ${spec.error}\n`);
  const after: VmCost | null = await cost_read(context, spec.spec);
  const row = (changes: string[], was: VmCost | null): { kind: string; data: { vms: VmCostRow[] } } => ({ kind: STRATUS_VM_COST_MODEL_KIND, data: { vms: [{ name, declared: keptSpec !== null, spec: spec.spec, cost: after, changes, before: was }] } });
  if (keptSpec === null) return envelope_ok(`${name} (not declared): ${size_line(spec.spec)}: ${cost_line(after)}\n`, row([], null));
  const changes: string[] = vmSpec_diff(keptSpec, spec.spec);
  if (changes.length === 0) return envelope_ok(`${name}: ${size_line(spec.spec)}: ${cost_line(after)}\n`, row([], null));
  const was: VmCost | null = await cost_read(context, keptSpec);
  const priced: string = was === null || after === null ? cost_line(after) : costChange_line(was, after);
  return envelope_ok(`${name}, ${changes.join(', ')}: ${priced}; nothing declared (vm new ${name} with the same options declares it)\n`, row(changes, was));
}

/**
 * `vm limits`: what the shape VMs are built from sells, in the spec's words,
 * so a slider's ends and steps come from the cloud and never from a page.
 *
 * @param context - The session.
 * @param args - The words after `limits`; none are taken.
 * @returns The envelope.
 */
async function vmLimits_run(context: VmCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  if (args.length > 0) return envelope_error('', undefined, 'vm limits: usage: vm limits\n');
  const region: string | null = context.region();
  if (region === null) return envelope_error('', undefined, 'vm limits: not connected: the limits are the session\'s region\'s\n');
  const shapeName: string | undefined = context.builder?.vmShape;
  if (shapeName === undefined) return envelope_error('', undefined, 'vm limits: this cloud builds no VMs yet\n');
  let shapes: CloudShape[];
  try {
    shapes = await context.driver.shapes_list(region);
  } catch (error: unknown) {
    return envelope_error('', undefined, `vm limits: asking ${region} for its shapes: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  const shape: CloudShape | undefined = shapes.find((each: CloudShape): boolean => each.name === shapeName);
  if (shape === undefined) return envelope_error('', undefined, `vm limits: ${region} does not offer ${shapeName}\n`);
  const limits = vmLimits_derive(shape);
  return envelope_ok(`${vmLimits_lines(limits).join('\n')}\n`, { kind: STRATUS_VM_LIMITS_MODEL_KIND, data: limits });
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
  const need = await vm_needOrTake(context, args[0], 'plan');
  if ('error' in need) return envelope_error('', undefined, `${need.error}\n`);
  if (vmKeyless_is(context.store, need.record)) return envelope_error(need.said, undefined, `vm plan: ${need.name}: ${VM_KEYLESS}\n`);
  const { record, spec } = need;
  const lines: string[] = vmStatus_lines(context.store, record, spec);
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
 * Grows the filesystems on the disks a build grew, as a task
 * (/proc/steps/vm-<name>-grow), then says the VM. Owed on the record until
 * it succeeds, so a build replayed after a failure grows them.
 *
 * @param context - The session.
 * @param deps - What it runs over.
 * @param name - The VM.
 * @param grow - Which disks grew.
 * @param said - What to say before the VM.
 * @returns The envelope.
 */
async function grow_run(context: VmCommandContext, deps: VmDeps, name: string, grow: { boot: boolean; data: boolean }, said: string): Promise<CommandEnvelope> {
  const ran = await job_runFollowed(VM_GROW_JOB(name), `grow ${name}`, vmGrowRun_make(name, grow, deps, context.remote_open));
  if ('error' in ran) return envelope_error(said, undefined, `vm build: ${name}: the disks grew, their filesystems did not: ${ran.error} (vm build ${name} grows them again)\n`);
  context.store.record_update(name, (current: VmRecord): void => { delete current.growOwed; });
  const read = context.store.spec_read(name);
  return envelope_ok(`${said}${vmStatus_lines(context.store, context.store.record_read(name) as VmRecord, read !== null && 'spec' in read ? read.spec : null).join('\n')}\n`);
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
  const need = await vm_needOrTake(context, words[0], 'build');
  if ('error' in need) return envelope_error('', undefined, `${need.error}\n`);
  if (vmKeyless_is(context.store, need.record)) return envelope_error(need.said, undefined, `vm build: ${need.name}: ${VM_KEYLESS}\n`);
  if (!tasks_granted()) return envelope_error('', undefined, `vm build: ${TIER_REFUSAL}\n`);
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
  const owed = context.store.record_read(name)?.growOwed;
  if (counts_total(data.counts) === 0 && machine !== null && counts_total(machine.counts) === 0) {
    context.store.file_remove(name, planFile_derive('data'));
    context.store.file_remove(name, planFile_derive('machine'));
    if (owed !== undefined) return await grow_run(context, deps, name, owed, `${name}: the plan reads nothing to do; growing the filesystems a build left ungrown\n`);
    return envelope_ok(`${name}: built, and the plan reads nothing to do\n`);
  }
  // What each plan does to what stands: a size changed in place, a port, the backups; anything else is refused unless asked.
  const judged: Array<[VmPart, VmPlanJudged]> = (['data', 'machine'] as VmPart[])
    .map((part: VmPart): [VmPart, VmPlanJudged | null] => { const kept = planKept_read(context, name, part); return [part, kept === null ? null : vmPlan_judge(kept.plan)]; })
    .filter((entry): entry is [VmPart, VmPlanJudged] => entry[1] !== null);
  for (const [part, judge] of judged) {
    if (judge.refused.length > 0 && !allowAlter) return envelope_error('', undefined, `vm build: ${name}: the ${part} plan ${judge.refused.join('; ')}: refused unless vm build ${name} --allow-alter\n`);
  }
  const reboot: boolean = judged.some(([, judge]): boolean => judge.reboot);
  const grow = { boot: judged.some(([, judge]): boolean => judge.bootGrow !== null), data: judged.some(([, judge]): boolean => judge.dataGrow !== null) };
  const changed: string[] = judged.flatMap(([, judge]): string[] => judge.words);
  const chrisUrl: string | undefined = context.store.record_read(name)?.chris?.url;
  const machineWords: string = machine === null ? `planned once its data stands (${spec.vcpu} vCPU, ${spec.memory} GiB, disk ${spec.disk} GB)` : planCounts_words(machine.counts);
  const warning: string = reboot ? ` ${name} REBOOTS to take its new shape: it${chrisUrl !== undefined ? `, and ChRIS at ${chrisUrl},` : ''} is down for a few minutes.` : '';
  const growing: string = grow.boot || grow.data ? ` The ${grow.boot && grow.data ? 'filesystems grow' : 'filesystem grows'} after, online, so the space appears.` : '';
  const what: string = changed.length > 0 ? `${changed.join(', ')}.` : `data ${planCounts_words(data.counts)}; machine ${machineWords}.`;
  const yes: boolean = await repl_confirm(`vm build ${name}: ${what}${warning}${growing} It bills: ${cost_line(await cost_read(context, spec))}. Continue? [y/N]`);
  if (!yes) return envelope_ok(`${chalk.gray(`stopped before the apply; nothing changed (vm build ${name} plans and asks again)`)}\n`);
  if (grow.boot || grow.data) context.store.record_update(name, (current: VmRecord): void => { current.growOwed = { boot: grow.boot || current.growOwed?.boot === true, data: grow.data || current.growOwed?.data === true }; });
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
    const kept = planKept_read(context, name, 'machine');
    const judge: VmPlanJudged | null = kept === null ? null : vmPlan_judge(kept.plan);
    if (judge !== null && judge.refused.length > 0 && !allowAlter) return envelope_error('', undefined, `vm build: ${name}: the machine plan ${judge.refused.join('; ')}: refused unless vm build ${name} --allow-alter\n`);
    machineCounts = planned.counts;
  }
  if (machineCounts !== undefined && counts_total(machineCounts) > 0) {
    const applied = await job_runFollowed(VM_JOBS.apply(name, 'machine'), `apply ${name} machine`, vmApplyRun_make(name, 'machine', deps));
    if ('error' in applied) return envelope_error('', undefined, `vm build: ${applied.error}\n`);
  } else {
    context.store.file_remove(name, planFile_derive('machine'));
  }
  const growOwed = context.store.record_read(name)?.growOwed;
  if (growOwed !== undefined) return await grow_run(context, deps, name, growOwed, '');
  return envelope_ok(`${vmStatus_lines(context.store, context.store.record_read(name) as VmRecord, spec).join('\n')}\n`);
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
  const need = await vm_needOrTake(context, words[0], 'shell');
  if ('error' in need) return envelope_error('', undefined, `${need.error}\n`);
  if (vmKeyless_is(context.store, need.record)) return envelope_error(need.said, undefined, `vm shell: ${need.name}: ${VM_KEYLESS}\n`);
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
 * `vm keep <name>`: keeps the VM's secrets in the tenancy from this host's
 * cache: its SSH key, and its ChRIS's record and passwords when deployed. A
 * build and a deploy keep them as they go; this is for a VM built before
 * stratus kept them, from the host that holds them.
 *
 * @param context - The session.
 * @param args - The words after `keep`.
 * @returns The envelope.
 */
async function vmKeep_run(context: VmCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  if (args.length !== 1 || args[0]?.startsWith('-') === true) return envelope_error('', undefined, 'vm keep: usage: vm keep <name>\n');
  const need = vm_need(context, args[0], 'keep');
  if ('error' in need) return envelope_error('', undefined, `${need.error}\n`);
  if (!tasks_granted()) return envelope_error('', undefined, `vm keep: ${TIER_REFUSAL}\n`);
  if (context.builder?.keep_write === undefined) return envelope_error('', undefined, 'vm keep: this cloud keeps nothing in the tenancy\n');
  if (!vmKey_held(context.store, need.name)) return envelope_error('', undefined, `vm keep: ${need.name}: this host holds no SSH key for it: ${VM_KEYLESS}\n`);
  const lines: string[] = [];
  try {
    const kept: string | null = await vmKept_write(context.builder, context.store, need.name, need.record.region, { log: (line: string): void => { lines.push(line); }, signal: new AbortController().signal });
    if (kept === null) return envelope_error('', undefined, `vm keep: ${need.name}: nothing to keep\n`);
    return envelope_ok(`${lines.map((line: string): string => chalk.gray(`${line}\n`)).join('')}${need.name}: ${kept} kept in the tenancy: any session holding its credentials reaches it\n`);
  } catch (error: unknown) {
    return envelope_error('', undefined, `vm keep: ${need.name}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/**
 * `vm protect <name> on|off`.
 *
 * @param context - The session.
 * @param args - The words after `protect`.
 * @returns The envelope.
 */
async function vmProtect_run(context: VmCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const [nameWord, setting, ...extra] = args;
  if (nameWord === undefined || (setting !== 'on' && setting !== 'off') || extra.length > 0) return envelope_error('', undefined, 'vm protect: usage: vm protect <name> on|off\n');
  const need = await vm_needOrTake(context, nameWord, 'protect');
  if ('error' in need) return envelope_error('', undefined, `${need.error}\n`);
  context.store.record_update(need.name, (current: VmRecord): void => { current.protected = setting === 'on'; });
  return envelope_ok(`${need.said}${need.name}: ${setting === 'on' ? 'protected: teardown refuses' : `unprotected: vm teardown ${need.name} may remove it`}\n`);
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
  const need = await vm_needOrTake(context, words[0], 'teardown');
  if ('error' in need) return envelope_error('', undefined, `${need.error}\n`);
  const { name, record, spec } = need;
  if (need.said !== '') sink_dataLine(need.said.trimEnd());
  if (record.machineStackRef === undefined && (!all || record.dataStackRef === undefined)) return envelope_ok(`${name}: nothing of it ${all ? 'is built' : 'but its kept data is built (vm teardown --all takes that)'}\n`);
  if (record.protected === true) return envelope_error('', undefined, `vm teardown: ${name}: protected (vm protect ${name} off)\n`);
  if (!tasks_granted()) return envelope_error('', undefined, `vm teardown: ${TIER_REFUSAL}\n`);
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
  // The VM's row is shown as each step begins and ends, so a screen watching draws the teardown going and gone.
  const shown = (): void => sink_get().event_write?.(STRATUS_VM_STATE_EVENT, vmRowKept_make(context, name));
  const ran = await job_runFollowed(VM_JOBS.teardown(name), `teardown ${name}`, vmTeardownRun_make(name, all, deps, shown), shown);
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
    case 'new': return await vmNew_run(context, rest);
    case 'cost': return await vmCost_run(context, rest);
    case 'limits': return await vmLimits_run(context, rest);
    case 'plan': return await vmPlan_run(context, rest);
    case 'build': return await vmBuild_run(context, rest);
    case 'shell': return await vmShell_run(context, rest);
    case 'protect': return await vmProtect_run(context, rest);
    case 'teardown': return await vmTeardown_run(context, rest);
    case 'keep': return await vmKeep_run(context, rest);
    default:
      if (rest.length === 0 && context.store.names_list().includes(verb)) return vmStatus_run(context, [verb]);
      // A VM the tenancy runs that this session keeps no record of is read by its name too.
      if (rest.length === 0 && VM_NAME.test(verb)) {
        const read: CommandEnvelope = await vmStatus_run(context, [verb]);
        if (read.status === 'ok') return read;
      }
      return envelope_error('', undefined, `vm: ${verb}: not a verb (vm status, new, cost, limits, plan, build, shell, protect, teardown) nor a VM\n`);
  }
}

/** `vm`'s help. */
export const VM_HELP: CommandHelp = {
  usage: 'vm [status [<name>…]] | vm <name> | vm new <name> --net <network> --vcpu <n> --memory <GiB> --disk <GB> --data <GB> --os <os> [--open <ports>] [--data-backup daily|none] | vm cost [<name> [<vm new\'s options>]] | vm limits | vm plan [<name>] | vm build [<name>] [--allow-alter] | vm shell [<name>] | vm protect <name> on|off | vm teardown <name> [--all] | vm keep <name>',
  summary: 'Declare, build, reach and tear down VMs on a network',
  category: 'Resources',
  description: 'vm new declares a VM and builds nothing; on a VM already declared it compares, printing unchanged or the change (a script is the truth), and an option not given keeps its value. A VM stands on a built network (--net) and is named in portable words only: vCPUs, memory in GiB, a boot disk and a data volume in GB (50 at least), the operating system (ubuntu-26.04), the ports open to the internet (--open 80,443; SSH goes through the network\'s bastion) and daily backups of its data. The driver chooses the rest: on OCI an E5.Flex (two vCPUs to an OCPU), the newest image of the OS (pinned at the first build), the first availability domain. A VM is two stacks: its data (the volume, its backups, a reserved address) and its machine (the instance, its boot disk, a security group, the volume\'s attachment); cloud-init formats the volume once, mounts it at /srv/data and puts Docker\'s data there. vm cost says what a VM bills at list price, an hour and a month, and what its data alone keeps billing after a teardown; it declares and saves nothing. Its words are vm new\'s: on a declared VM the options given change its spec for the answer and the difference is said (vm cost store --memory 16); on a name not declared they are the whole spec, without --net (the price is the session\'s region\'s); bare, every declared VM. vm limits says what the shape VMs are built from sells, in the same words: vCPUs from the least to the most in the cloud\'s steps, memory in GiB and per vCPU, the disks\' floors and ceilings; a slider takes its ends from it. vm plan says the size, the network and the cost. vm build plans as tasks (/proc/steps/vm-<name>-plan-data, -machine), says the counts and the cost and asks, applies the data and the machine and points the address at it. On a VM that stands it resizes in place: new vCPUs or memory reshape the machine, which the cloud reboots (the question says so first); a grown boot disk or data volume has its filesystem grown after, over the bastion (/proc/steps/vm-<name>-grow); ports open and close, backups turn on and off; a shrink, a new OS (a new machine) or a replaced volume is refused unless --allow-alter. vm shell (shell tier) opens a three-hour session on the network\'s bastion for the VM\'s own key and prints the ssh line. A VM is born protected: vm protect <name> off lets teardown run. vm teardown removes the machine and keeps the data, backups and address, so the next build brings it back with its data and name; --all takes those too, asking for the name typed back. The tenancy is the truth and this host\'s records its cache: a VM\'s SSH key and its ChRIS\'s record and passwords are kept in the tenancy\'s vault (mise), so every session on every host holding the tenancy\'s credentials reads a VM stratus built whole, on vm status; vm keep <name> keeps them from this host for a VM built before they were kept.',
  examples: ['vm new store --net chrisproject-services --open 80,443 --vcpu 2 --memory 8 --disk 50 --data 50 --data-backup daily --os ubuntu-26.04', 'vm cost store --memory 16', 'vm cost blt --vcpu 4 --memory 16 --disk 50 --data 1024 --data-backup daily --os ubuntu-26.04', 'vm limits', 'vm plan store', 'vm build store', 'vm shell store', 'vm protect store off', 'vm teardown store'],
};
