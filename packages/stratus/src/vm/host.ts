/**
 * @file A VM's own setup after its stacks (docs/stratus.adoc, D16): the
 * machine's firewall and public SSH, set over the network's bastion.
 *
 * The cloud's security group opens a port; the image's own firewall (Ubuntu
 * on OCI rejects all but 22) still has to admit it, and cloud-init does that
 * only at the machine's first boot. So a build that opens or closes a port on
 * a machine that stands, or opens public SSH, ends with this step: the ports
 * the spec opens are admitted in the machine's firewall (a port closed is
 * dropped from it, 22 never), and public SSH's Linux user is made with sudo
 * and its public key, sshd told to listen on the port too (22 stays: the
 * network's bastion reaches the machine there) with password login off. A
 * door closed takes the port away and keeps the user and the key.
 *
 * Key components:
 * - VmHostState: what the machine was last set up with.
 * - vmHost_desired: what the spec asks of it.
 * - vmHost_owed: what a build still has to do on it, in words.
 * - vmHostScript_render: the shell lines that do it.
 * - vmHostRun_make: the step, as a task.
 *
 * Typical usage:
 * ```ts
 * const owed: string[] = vmHost_owed(record, spec);
 * if (owed.length > 0) await job_runFollowed(VM_HOST_JOB(name), `set up ${name}`, vmHostRun_make(name, spec, record, deps));
 * ```
 *
 * Dependencies: the machine is Ubuntu with iptables and netfilter-persistent
 * (the image stratus builds from), reached through {@link vmRemote_open}.
 *
 * @module
 */
import type { JobContext, JobRun } from '@fnndsc/brasa/core';
import type { BuildCall } from '../cloud/builder.js';
import type { VmDeps } from './build.js';
import type { VmRemote } from './remote.js';
import { vmRemote_open } from './remote.js';
import { vmPorts_open, type VmSpec, type VmSsh } from './spec.js';
import type { VmRecord } from './state.js';

/** The line the host step runs; its script comes on stdin. */
export const VM_HOST_LINE: string = 'bash -s';

/** The host step's job id. */
export const VM_HOST_JOB = (name: string): string => `vm-${name}-host`;

/** The drop-in sshd reads for public SSH: its own file, so the image's config stays as shipped. */
export const SSHD_DROP_IN: string = '/etc/ssh/sshd_config.d/60-stratus-public.conf';

/** What the machine was last set up with: the ports its own firewall admits, and public SSH. */
export interface VmHostState {
  /** The ports the machine's firewall admits for the internet, sorted. */
  ports: number[];
  /** Public SSH as set up, or null when never. */
  ssh: VmSsh | null;
}

/**
 * What the spec asks of the machine itself.
 *
 * @param spec - The spec.
 * @returns The ports to admit and the SSH door.
 */
export function vmHost_desired(spec: VmSpec): VmHostState {
  return { ports: vmPorts_open(spec), ssh: spec.ssh ?? null };
}

/**
 * What the machine was set up with, or, for one no host step has touched,
 * what its first boot left: the ports the spec it was built to opened, no SSH.
 *
 * @param record - The VM's record.
 * @param spec - The spec declared, when no build is kept.
 * @returns The state.
 */
export function vmHost_current(record: VmRecord, spec: VmSpec): VmHostState {
  if (record.host !== undefined) return record.host;
  return { ports: [...(record.builtSpec ?? spec).open].sort((a: number, b: number): number => a - b), ssh: null };
}

/**
 * What a build still has to do on the machine, in words; nothing for a
 * machine not built yet (its first boot admits the ports, and the build's
 * host step follows the machine's apply).
 *
 * @param record - The VM's record.
 * @param spec - The spec declared.
 * @returns `public SSH opened on 2222 for ops`, … ; empty when nothing is owed.
 */
export function vmHost_owed(record: VmRecord, spec: VmSpec): string[] {
  const now: VmHostState = record.built === undefined ? { ports: vmPorts_open(spec), ssh: null } : vmHost_current(record, spec);
  const want: VmHostState = vmHost_desired(spec);
  const words: string[] = [];
  const was: VmSsh | null = now.ssh;
  const will: VmSsh | null = want.ssh;
  const open = (ssh: VmSsh | null): boolean => ssh !== null && ssh.on;
  if (open(will) && !open(was)) words.push(`public SSH opened on ${will?.port} for ${will?.user}, key-only, with sudo`);
  else if (!open(will) && open(was)) words.push(`public SSH on ${was?.port} closed (${was?.user} and its key kept)`);
  else if (open(will) && open(was)) {
    if (was?.port !== will?.port) words.push(`public SSH moved ${was?.port} → ${will?.port}`);
    if (was?.user !== will?.user) words.push(`public SSH's user ${was?.user} → ${will?.user}`);
    if (was?.key !== will?.key) words.push(`${will?.user}'s SSH key replaced`);
  }
  const ports = (list: ReadonlyArray<number>): string => list.join(',');
  const sshPorts = (state: VmHostState): number[] => state.ports.filter((port: number): boolean => port !== state.ssh?.port || state.ssh?.on !== true);
  if (record.built !== undefined && ports(sshPorts(now)) !== ports(sshPorts(want))) words.push(`its firewall admits ${ports(sshPorts(want)) || 'no port'}`);
  return words;
}

/**
 * Single-quotes a word for the machine's shell.
 *
 * @param word - The word.
 * @returns It, quoted.
 */
function shQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell lines that set the machine up as the spec asks: its firewall,
 * then public SSH.
 *
 * @param want - What the spec asks.
 * @param now - What the machine was set up with.
 * @returns The lines, `set -e`.
 */
export function vmHostScript_render(want: VmHostState, now: VmHostState): string {
  const rule = (port: number): string => `INPUT -p tcp --dport ${port} -m state --state NEW -j ACCEPT`;
  const lines: string[] = ['set -e'];
  for (const port of want.ports) lines.push(`sudo iptables -C ${rule(port)} 2>/dev/null || sudo iptables -I ${rule(port).replace('INPUT', 'INPUT 5')}`);
  // A port closed leaves the firewall too; 22 is the image's own and the bastion's way in, never touched.
  for (const port of now.ports.filter((port: number): boolean => !want.ports.includes(port) && port !== 22)) lines.push(`while sudo iptables -C ${rule(port)} 2>/dev/null; do sudo iptables -D ${rule(port)}; done`);
  lines.push('sudo netfilter-persistent save >/dev/null');
  const ssh: VmSsh | null = want.ssh;
  if (ssh !== null) {
    const home: string = `/home/${ssh.user}`;
    lines.push(
      `id -u ${ssh.user} >/dev/null 2>&1 || sudo useradd -m -s /bin/bash ${ssh.user}`,
      `sudo install -d -m 700 -o ${ssh.user} -g ${ssh.user} ${home}/.ssh`,
      `printf '%s\\n' ${shQuote(ssh.key)} | sudo tee ${home}/.ssh/authorized_keys >/dev/null`,
      `sudo chown ${ssh.user}:${ssh.user} ${home}/.ssh/authorized_keys && sudo chmod 600 ${home}/.ssh/authorized_keys`,
      `printf '%s ALL=(ALL) NOPASSWD:ALL\\n' ${ssh.user} | sudo tee /etc/sudoers.d/90-stratus-${ssh.user} >/dev/null && sudo chmod 440 /etc/sudoers.d/90-stratus-${ssh.user}`,
    );
  }
  // sshd keeps 22 (the bastion's way in) and listens on the public port while the door is open; password login is off either way.
  const listen: string[] = ['Port 22', ...(ssh !== null && ssh.on && ssh.port !== 22 ? [`Port ${ssh.port}`] : [])];
  if (ssh !== null || now.ssh !== null) {
    lines.push(
      `printf '%s\\n' ${listen.map(shQuote).join(' ')} 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' | sudo tee ${SSHD_DROP_IN} >/dev/null`,
      'sudo sshd -t',
      // Ubuntu starts sshd from a socket whose ports are generated from sshd's config: both are reloaded.
      'sudo systemctl daemon-reload && { sudo systemctl restart ssh.socket 2>/dev/null || true; } && sudo systemctl restart ssh',
    );
  }
  lines.push(`echo stratus-host ${want.ports.join(',') || 'none'} ${ssh !== null && ssh.on ? `ssh:${ssh.port}` : 'ssh:off'}`);
  return lines.join('\n');
}

/**
 * The host step: the machine set up as the spec asks, and the record told.
 *
 * @param name - The VM.
 * @param spec - The spec declared.
 * @param deps - The VM's stores and builder.
 * @param remote_open - Reaches the VM; {@link vmRemote_open} when absent.
 * @returns The step.
 */
export function vmHostRun_make(name: string, spec: VmSpec, deps: VmDeps, remote_open?: (name: string, call: BuildCall) => Promise<VmRemote>): JobRun {
  return async (context: JobContext): Promise<void> => {
    const call: BuildCall = { log: (line: string): void => context.log_write(line), signal: context.signal };
    const record: VmRecord | null = deps.store.record_read(name);
    if (record === null) throw new Error(`${name}: no record`);
    const want: VmHostState = vmHost_desired(spec);
    const now: VmHostState = vmHost_current(record, spec);
    context.log_write(`${name}: reaching the machine to set up its firewall${want.ssh !== null || now.ssh !== null ? ' and public SSH' : ''}`);
    const remote: VmRemote = await (remote_open ?? ((vm: string, inner: BuildCall): Promise<VmRemote> => vmRemote_open(vm, { store: deps.store, nets: deps.nets, builder: deps.builder }, inner)))(name, call);
    if (context.signal.aborted) return;
    const answer = await remote.run(VM_HOST_LINE, vmHostScript_render(want, now));
    if (answer.code !== 0) throw new Error(`setting up ${name}: ${(answer.stderr || answer.stdout).trim().split('\n').slice(-3).join(' ')}`);
    deps.store.record_update(name, (current: VmRecord): void => { current.host = want; });
    context.log_write(`its firewall admits ${want.ports.join(',') || 'no port'}; public SSH ${want.ssh === null ? 'none' : want.ssh.on ? `on ${want.ssh.port} for ${want.ssh.user}` : `off (${want.ssh.user} kept)`}`);
  };
}
