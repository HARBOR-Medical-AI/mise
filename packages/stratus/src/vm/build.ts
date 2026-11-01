/**
 * @file A VM's build and teardown as jobs (docs/stratus.adoc, D16). A VM is
 * two stacks: its data (volume, backups, reserved address), which a default
 * teardown keeps, and its machine (instance, boot disk, security group, the
 * volume's attachment), which needs what the data stack left (the volume and
 * its availability domain). So the data is planned and applied first, then
 * the machine, and the reserved address is pointed at it.
 *
 * Each job runs in the core's runner under the `tasks` tier; the command
 * between them asks the operator.
 *
 * @module
 */
import type { JobContext, JobRun } from '@fnndsc/brasa/core';
import type { CloudDriver, CloudPrice, ServicePrices } from '../cloud/driver.js';
import { plan_count, planCounts_words, type BuildCall, type CloudBuilder, type InfraPlan, type StackModule } from '../cloud/builder.js';
import { HOURS_PER_MONTH } from '../cluster/spend.js';
import type { NetRecord, NetStore } from '../net/state.js';
import type { VmSpec } from './spec.js';
import { VM_TAG, type VmRecord, type VmStore } from './state.js';

/** What a VM's jobs run over. */
export interface VmDeps {
  readonly store: VmStore;
  readonly nets: NetStore;
  readonly builder: CloudBuilder;
  readonly driver: CloudDriver;
}

/** A VM's two stacks. */
export type VmPart = 'data' | 'machine';

/** A VM's job ids, in the build steps' source. */
export const VM_JOBS = {
  plan: (name: string, part: VmPart): string => `vm-${name}-plan-${part}`,
  apply: (name: string, part: VmPart): string => `vm-${name}-apply-${part}`,
  teardown: (name: string): string => `vm-${name}-teardown`,
} as const;

/** Which module each part is. */
const PART_MODULE: Readonly<Record<VmPart, StackModule>> = { data: 'vmData', machine: 'vmMachine' };

/**
 * The file a part's plan is kept in.
 *
 * @param part - The part.
 * @returns `plan-data.json` or `plan-machine.json`.
 */
export function planFile_derive(part: VmPart): string {
  return `plan-${part}.json`;
}

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
 * The builder's VM calls, or why this cloud has none.
 *
 * @param builder - The cloud's build half.
 * @returns The calls, bound.
 * @throws Error - When the cloud cannot build VMs.
 */
function builder_check(builder: CloudBuilder): Required<Pick<CloudBuilder, 'modulePlan_run' | 'moduleApply_run' | 'moduleDestroy_run' | 'address_point'>> {
  const { modulePlan_run, moduleApply_run, moduleDestroy_run, address_point } = builder;
  if (modulePlan_run === undefined || moduleApply_run === undefined || moduleDestroy_run === undefined || address_point === undefined) throw new Error(`the ${builder.id} cloud builds no VMs yet`);
  return { modulePlan_run: modulePlan_run.bind(builder), moduleApply_run: moduleApply_run.bind(builder), moduleDestroy_run: moduleDestroy_run.bind(builder), address_point: address_point.bind(builder) };
}

/**
 * A VM's record and spec, both there.
 *
 * @param store - The VMs.
 * @param name - The VM.
 * @returns Both.
 * @throws Error - When either is missing or the spec does not read.
 */
export function vm_read(store: VmStore, name: string): { record: VmRecord; spec: VmSpec } {
  const record: VmRecord | null = store.record_read(name);
  const read = store.spec_read(name);
  if (record === null || read === null) throw new Error(`${name}: no such VM`);
  if ('error' in read) throw new Error(`${name}: spec.yaml: ${read.error}`);
  return { record, spec: read.spec };
}

/**
 * The network a VM stands on, built.
 *
 * @param nets - The networks.
 * @param spec - The VM's spec.
 * @returns The network's record, with its place and what its apply left.
 * @throws Error - When the network is not declared or not built.
 */
export function vmNet_read(nets: NetStore, spec: VmSpec): NetRecord & { placeId: string; outputs: Record<string, string> } {
  const net: NetRecord | null = nets.record_read(spec.net);
  if (net === null) throw new Error(`the network ${spec.net} is not declared (net new ${spec.net} --cidr <range>)`);
  if (net.placeId === undefined || net.outputs === undefined || net.built === undefined) throw new Error(`the network ${spec.net} is not built (net build ${spec.net})`);
  return net as NetRecord & { placeId: string; outputs: Record<string, string> };
}

/**
 * A part's inputs, in neutral words.
 *
 * @param part - The part.
 * @param record - The VM's state.
 * @param spec - Its spec.
 * @param net - Its network, built.
 * @param publicKey - Its SSH key's public line.
 * @returns The inputs.
 * @throws Error - When the machine is asked for before the data stands.
 */
function partInputs_build(part: VmPart, record: VmRecord, spec: VmSpec, net: NetRecord & { outputs: Record<string, string> }, publicKey: string): Record<string, string> {
  if (part === 'data') return { data: String(spec.data), dataBackup: spec.dataBackup };
  const data: Record<string, string> | undefined = record.dataOutputs;
  if (data === undefined) throw new Error(`${record.name}: its data is not built yet, so its machine cannot be planned`);
  return {
    os: spec.os, open: spec.open.join(','), vcpu: String(spec.vcpu), memory: String(spec.memory), disk: String(spec.disk),
    image: record.image ?? '', sshPublicKey: publicKey,
    availabilityDomain: data['availability_domain'] ?? '', volumeId: data['volume_id'] ?? '',
    subnetId: net.outputs['subnet_id'] ?? '', vcnId: net.outputs['vcn_id'] ?? '',
  };
}

/**
 * A part's plan job: the stack made or found in the network's place, planned, kept as `plan-<part>.json`.
 *
 * @param name - The VM.
 * @param part - Which stack.
 * @param deps - What it runs over.
 * @returns The job's work.
 */
export function vmPlanRun_make(name: string, part: VmPart, deps: VmDeps): JobRun {
  return async (context: JobContext): Promise<void> => {
    const builder = builder_check(deps.builder);
    const { record, spec } = vm_read(deps.store, name);
    const net = vmNet_read(deps.nets, spec);
    const { publicKey } = deps.store.key_ensure(name);
    const stackRef: string | undefined = part === 'data' ? record.dataStackRef : record.machineStackRef;
    const plan: InfraPlan = await builder.modulePlan_run({
      module: PART_MODULE[part], owner: { tag: VM_TAG, name }, region: record.region, placeId: net.placeId,
      inputs: partInputs_build(part, record, spec, net, publicKey),
      ...(stackRef !== undefined ? { stackRef } : {}),
    }, call_make(context));
    if (context.signal.aborted) return;
    deps.store.record_update(name, (current: VmRecord): void => {
      current.placeId = net.placeId;
      if (plan.stackRef === undefined) return;
      if (part === 'data') current.dataStackRef = plan.stackRef;
      else current.machineStackRef = plan.stackRef;
    });
    deps.store.file_write(name, planFile_derive(part), `${JSON.stringify(plan, null, 2)}\n`);
    context.log_write(`${part} plan: ${planCounts_words(plan_count(plan))}`);
  };
}

/**
 * A part's apply job. The machine's apply pins the image it was made from and
 * points the reserved address at it.
 *
 * @param name - The VM.
 * @param part - Which stack.
 * @param deps - What it runs over.
 * @returns The job's work.
 */
export function vmApplyRun_make(name: string, part: VmPart, deps: VmDeps): JobRun {
  return async (context: JobContext): Promise<void> => {
    const builder = builder_check(deps.builder);
    const call: BuildCall = call_make(context);
    const { record } = vm_read(deps.store, name);
    const planText: string | null = deps.store.file_read(name, planFile_derive(part));
    const stackRef: string | undefined = part === 'data' ? record.dataStackRef : record.machineStackRef;
    if (planText === null || stackRef === undefined) throw new Error(`${name}: no ${part} plan to apply (vm build ${name} makes one)`);
    const plan: InfraPlan = JSON.parse(planText) as InfraPlan;
    const outputs: Record<string, string> = await builder.moduleApply_run({ region: record.region, stackRef, plan, label: `${name} ${part}` }, call);
    deps.store.file_remove(name, planFile_derive(part));
    if (part === 'data') {
      deps.store.record_update(name, (current: VmRecord): void => { current.dataOutputs = outputs; delete current.gone; });
      context.log_write(`${name}: its data stands (volume ${outputs['volume_id']}, address ${outputs['public_ip']})`);
      return;
    }
    const publicIpId: string | undefined = record.dataOutputs?.['public_ip_id'];
    const privateIpId: string | undefined = outputs['private_ip_id'];
    if (publicIpId !== undefined && privateIpId !== undefined) await builder.address_point({ region: record.region, publicIpId, privateIpId }, call);
    deps.store.record_update(name, (current: VmRecord): void => {
      current.machineOutputs = outputs;
      if (current.image === undefined && outputs['image_id'] !== undefined) current.image = outputs['image_id'];
      current.built = new Date().toISOString();
      delete current.machineGone; delete current.gone;
    });
    context.log_write(`${name}: built (instance ${outputs['instance_id']}, ${outputs['private_ip']} inside, ${record.dataOutputs?.['public_ip']} outside)`);
  };
}

/**
 * The teardown's job: the machine's stack, and with `all` the data's too.
 *
 * @param name - The VM.
 * @param all - Whether the data, its backups and the address go too.
 * @param deps - What it runs over.
 * @returns The job's work.
 */
export function vmTeardownRun_make(name: string, all: boolean, deps: VmDeps): JobRun {
  return async (context: JobContext): Promise<void> => {
    const builder = builder_check(deps.builder);
    const call: BuildCall = call_make(context);
    const { record } = vm_read(deps.store, name);
    if (record.machineStackRef !== undefined) {
      for (const line of await builder.moduleDestroy_run({ region: record.region, stackRef: record.machineStackRef, label: `${name} machine` }, call)) context.log_write(`removed ${line}`);
      deps.store.record_update(name, (current: VmRecord): void => {
        delete current.machineStackRef; delete current.machineOutputs; delete current.built;
        current.machineGone = new Date().toISOString();
      });
      deps.store.file_remove(name, planFile_derive('machine'));
    }
    if (!all || context.signal.aborted) return;
    if (record.dataStackRef !== undefined) {
      for (const line of await builder.moduleDestroy_run({ region: record.region, stackRef: record.dataStackRef, label: `${name} data` }, call)) context.log_write(`removed ${line}`);
    }
    deps.store.record_update(name, (current: VmRecord): void => {
      delete current.dataStackRef; delete current.dataOutputs; delete current.image; delete current.placeId; delete current.machineGone;
      current.gone = new Date().toISOString();
    });
    deps.store.file_remove(name, planFile_derive('data'));
  };
}

/** What a VM costs: its machine (compute, memory, boot disk) and its data (kept by a default teardown). */
export interface VmCost {
  readonly machineHour: number;
  readonly dataHour: number;
  readonly currency: string;
}

/**
 * What a spec costs at list price. The machine is its vCPUs and memory at
 * the family's price and its boot disk; the data is its volume at the
 * balanced performance (ten VPUs a GB). Backups are their changed blocks and
 * are not counted; nothing a network is made of is priced.
 *
 * @param spec - The spec.
 * @param shape - The shape the driver makes VMs of.
 * @param prices - The shapes' prices.
 * @param service - Storage prices.
 * @returns The cost, or null when the shape or storage is not priced.
 */
export function vmCost_estimate(spec: VmSpec, shape: string | undefined, prices: ReadonlyArray<CloudPrice>, service: ServicePrices | null): VmCost | null {
  const price: CloudPrice | undefined = prices.find((entry: CloudPrice): boolean => entry.shape === shape);
  if (price === undefined || service === null) return null;
  const gbHour: number = (service.volumeGibMonth + 10 * service.vpuGibMonth) / HOURS_PER_MONTH;
  return {
    machineHour: spec.vcpu * price.vcpuHour + spec.memory * price.gibHour + spec.disk * gbHour,
    dataHour: spec.data * gbHour,
    currency: price.currency,
  };
}

/**
 * A cost as the operator reads it.
 *
 * @param hour - Per hour.
 * @param currency - Its currency.
 * @returns `$0.052 an hour, $37.96 a month`.
 */
export function cost_words(hour: number, currency: string): string {
  const symbol: string = currency === 'USD' ? '$' : `${currency} `;
  return `${symbol}${hour.toFixed(3)} an hour, ${symbol}${(hour * HOURS_PER_MONTH).toFixed(2)} a month`;
}
