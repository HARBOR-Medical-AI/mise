/**
 * @file Changing a VM that stands (docs/stratus.adoc, D16): its plan read for
 * what an apply does to it, and the filesystems grown after a disk grows.
 *
 * A VM's size changes in place: more or fewer vCPUs or memory reshape its
 * machine, which the cloud reboots to take the new shape (its services are
 * down for a few minutes, and the operator is told so before the apply); a
 * boot disk or a data volume grows, online, and the filesystem on it is
 * grown after over the network's bastion, so the space appears. A port is
 * opened or closed, a volume's backups turned on or off. Anything else that
 * touches what stands (the machine replaced, a disk shrunk or replaced, the
 * data detached) is refused unless the build is asked with `--allow-alter`.
 *
 * @module
 */
import type { JobContext, JobRun } from '@fnndsc/brasa/core';
import type { BuildCall, InfraPlan, PlanRow } from '../cloud/builder.js';
import type { VmRemote } from './remote.js';
import { vmRemote_open } from './remote.js';
import type { VmDeps } from './build.js';

/** What a VM's plan does to what stands, read. */
export interface VmPlanJudged {
  /** What it does that is refused unless asked with `--allow-alter`, a line each. */
  readonly refused: string[];
  /** Whether the machine reboots to take a new shape. */
  readonly reboot: boolean;
  /** The boot disk's growth, GB before and after, or null. */
  readonly bootGrow: readonly [number, number] | null;
  /** The data volume's growth, GB before and after, or null. */
  readonly dataGrow: readonly [number, number] | null;
  /** What it changes in place, in the operator's words. */
  readonly words: string[];
}

/** A leaf's value as a number, or NaN. */
const numeric = (value: string | null): number => (value === null ? Number.NaN : Number(value));

/**
 * Reads what a VM part's plan does to what stands. A plan of a part not yet
 * built creates everything and is read as nothing done to what stands.
 *
 * @param plan - Its plan.
 * @returns What it does.
 */
export function vmPlan_judge(plan: InfraPlan): VmPlanJudged {
  const refused: string[] = [];
  const words: string[] = [];
  let reboot: boolean = false;
  let bootGrow: readonly [number, number] | null = null;
  let dataGrow: readonly [number, number] | null = null;
  const rows: ReadonlyArray<PlanRow> = plan.rows.filter((row: PlanRow): boolean => row.drift !== true);
  const created: Set<string> = new Set(rows.filter((row: PlanRow): boolean => row.action === 'create').map((row: PlanRow): string => row.name));
  const replaced: Set<string> = new Set(rows.filter((row: PlanRow): boolean => row.action === 'destroy' && created.has(row.name)).map((row: PlanRow): string => row.name));
  for (const row of rows) {
    const type: string = row.type ?? '';
    const isRule: boolean = type === 'oci_core_network_security_group_security_rule';
    const isBackup: boolean = type === 'oci_core_volume_backup_policy_assignment';
    if (replaced.has(row.name)) {
      if (row.action !== 'destroy') continue;
      if (isRule || isBackup) continue;
      if (type === 'oci_core_instance') refused.push('the machine is replaced: a new machine with a new host key (the data volume stays)');
      else if (type === 'oci_core_volume') refused.push('the data volume is replaced: a new, EMPTY volume');
      else refused.push(`${row.name} is replaced`);
      continue;
    }
    if (row.action === 'create') {
      if (isRule) words.push('a port opened');
      else if (isBackup) words.push('daily backups on');
      continue;
    }
    if (row.action === 'destroy') {
      if (isRule) words.push('a port closed');
      else if (isBackup) words.push('daily backups off');
      else if (type === 'oci_core_instance') refused.push('the machine is removed');
      else if (type === 'oci_core_volume') refused.push('the data volume is removed');
      else if (type === 'oci_core_volume_attachment') refused.push('the data volume is detached from the machine');
      else refused.push(`${row.name} is removed`);
      continue;
    }
    // A change in place: only a size is changed so.
    const changes = row.changes ?? [];
    if (changes.length === 0) { refused.push(`${row.name} changes (the plan does not say how)`); continue; }
    for (const change of changes) {
      const from: number = numeric(change.before);
      const to: number = numeric(change.after);
      if (type === 'oci_core_instance' && change.path === 'shape_config.ocpus') { reboot = true; words.push(`${from * 2} → ${to * 2} vCPU`); continue; }
      if (type === 'oci_core_instance' && change.path === 'shape_config.memory_in_gbs') { reboot = true; words.push(`memory ${from} → ${to} GiB`); continue; }
      if (type === 'oci_core_instance' && change.path.startsWith('shape_config.')) { reboot = true; continue; }
      if (type === 'oci_core_instance' && change.path === 'source_details.boot_volume_size_in_gbs') {
        if (!(to > from)) { refused.push(`the boot disk shrinks ${from} → ${to} GB (a disk only grows)`); continue; }
        bootGrow = [from, to]; words.push(`boot disk ${from} → ${to} GB`); continue;
      }
      if (type === 'oci_core_volume' && change.path === 'size_in_gbs') {
        if (!(to > from)) { refused.push(`the data volume shrinks ${from} → ${to} GB (a volume only grows)`); continue; }
        dataGrow = [from, to]; words.push(`data ${from} → ${to} GB`); continue;
      }
      refused.push(`${row.name}: ${change.path} changes${change.before !== null || change.after !== null ? ` (${change.before ?? 'none'} → ${change.after ?? 'none'})` : ''}`);
    }
  }
  return { refused, reboot, bootGrow, dataGrow, words };
}

/** The grow step's job id. */
export const VM_GROW_JOB = (name: string): string => `vm-${name}-grow`;

/** The line that grows the filesystem on the data volume, after the cloud grew the volume: the device rescanned, ext4 grown online. */
export const DATA_GROW_LINE: string = [
  'dev=$(readlink -f /dev/oracleoci/oraclevdb)',
  'sudo dd iflag=direct if="$dev" of=/dev/null count=1 status=none',
  'echo 1 | sudo tee "/sys/class/block/$(basename "$dev")/device/rescan" >/dev/null',
  'sudo resize2fs "$dev"',
  'df -BG --output=size /srv/data | tail -1',
].join(' && ');

/** The line that grows the root filesystem, after the cloud grew the boot disk: the disk rescanned, its partition grown, the filesystem grown online. */
export const BOOT_GROW_LINE: string = [
  'src=$(findmnt -no SOURCE /)',
  'disk=/dev/$(lsblk -no PKNAME "$src")',
  'part=$(cat "/sys/class/block/$(basename "$src")/partition")',
  'sudo dd iflag=direct if="$disk" of=/dev/null count=1 status=none',
  'echo 1 | sudo tee "/sys/class/block/$(basename "$disk")/device/rescan" >/dev/null',
  '{ sudo growpart "$disk" "$part" || true; }',
  'if [ "$(findmnt -no FSTYPE /)" = xfs ]; then sudo xfs_growfs /; else sudo resize2fs "$src"; fi',
  'df -BG --output=size / | tail -1',
].join(' && ');

/**
 * The grow step: the filesystems on the disks the apply grew, grown over the
 * network's bastion so the space appears. A machine just rebooted is waited
 * on (opening the remote waits until the machine admits a line).
 *
 * @param name - The VM.
 * @param grow - Which disks grew.
 * @param deps - What it runs over.
 * @param remote_open - Reaches the VM; {@link vmRemote_open} when absent.
 * @returns The job's work.
 */
export function vmGrowRun_make(name: string, grow: { boot: boolean; data: boolean }, deps: VmDeps, remote_open?: (name: string, call: BuildCall) => Promise<VmRemote>): JobRun {
  return async (context: JobContext): Promise<void> => {
    const call: BuildCall = { log: (line: string): void => context.log_write(line), signal: context.signal };
    context.log_write(`${name}: reaching the machine to grow its filesystems`);
    const remote: VmRemote = await (remote_open ?? ((vm: string, inner: BuildCall): Promise<VmRemote> => vmRemote_open(vm, { store: deps.store, nets: deps.nets, builder: deps.builder }, inner)))(name, call);
    for (const [which, line, where] of [['boot', BOOT_GROW_LINE, '/'], ['data', DATA_GROW_LINE, '/srv/data']] as Array<['boot' | 'data', string, string]>) {
      if (!grow[which]) continue;
      if (context.signal.aborted) return;
      const answer = await remote.run(line);
      if (answer.code !== 0) throw new Error(`growing ${where}: ${(answer.stderr || answer.stdout).trim().split('\n').slice(-3).join(' ')}`);
      context.log_write(`${where} is ${answer.stdout.trim().split('\n').at(-1)?.trim() ?? '?'} now`);
    }
  };
}
