/**
 * @file A VM's spec (docs/stratus.adoc, D16): what a `vm new` line declares,
 * in words every cloud understands. The driver chooses the family, the image
 * and the zone; a script never names them.
 *
 * `spec.yaml` is the record of the line, written by `vm new`, never by hand.
 *
 * @module
 */
import * as fs from 'fs';
import * as yaml from 'js-yaml';

/** What a VM is declared with. */
export interface VmSpec {
  /** The network it stands on (`net new`). */
  net: string;
  /** The ports open to the internet, TCP. */
  open: number[];
  /** Virtual CPUs. */
  vcpu: number;
  /** Memory, GiB. */
  memory: number;
  /** The boot disk, GB. */
  disk: number;
  /** The data volume, GB: kept by a default teardown. */
  data: number;
  /** The data volume's backups: `daily` (seven kept) or `none`. */
  dataBackup: 'daily' | 'none';
  /** The operating system, as `<name>-<version>` (`ubuntu-26.04`). */
  os: string;
  /** SSH open to the internet for an administrative Linux user, or absent when never declared (`vm new --ssh`). */
  ssh?: VmSsh;
}

/**
 * A public SSH door: a port open to the internet, the administrative Linux
 * user it admits (not a ChRIS account), that user's public key, and whether
 * it is open now. Closed, the user and the key are kept, so opening it again
 * loses nothing. Password login is always off; the user has sudo.
 */
export interface VmSsh {
  /** The port open to the internet. */
  port: number;
  /** The Linux user it admits (`ops`). */
  user: string;
  /** That user's public key, one OpenSSH line; never a private key. */
  key: string;
  /** Whether the door is open. */
  on: boolean;
}

/** The administrative user public SSH admits when none is named. */
export const VM_SSH_USER: string = 'ops';

/** A Linux user's name a door may admit: not root, not the image's own user (the stratus key's). */
const SSH_USER_WORD: RegExp = /^[a-z_][a-z0-9_-]{0,31}$/;

/** One OpenSSH public key line. */
const SSH_KEY_LINE: RegExp = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]{16,}( [^\n]*)?$/;

/** The smallest disk and data volume any cloud stratus drives will make, GB. */
export const VM_DISK_FLOOR: number = 50;

/** The most a disk or a data volume is, in GB (OCI's block volume ceiling). */
export const VM_DISK_CEILING: number = 32768;

/** What a shape sells, in the spec's words: the ends and steps the sliders take. */
export interface VmLimits {
  /** The shape (`VM.Standard.E5.Flex`) and its family (`E5`). */
  readonly shape: string;
  readonly family: string;
  /** vCPUs: from the least to the most, in steps of the cloud's core unit. */
  readonly vcpu: { readonly min: number; readonly max: number; readonly step: number };
  /** Memory in GiB: the shape's range, and per vCPU when the cloud bounds it. */
  readonly memory: { readonly min: number; readonly max: number; readonly perVcpu: { readonly min: number; readonly max: number } | null };
  /** The boot disk and the data volume, in GB. */
  readonly disk: { readonly min: number; readonly max: number };
  readonly data: { readonly min: number; readonly max: number };
}

/**
 * The limits a shape gives a VM's spec.
 *
 * @param shape - The shape the builder uses for VMs.
 * @returns The ends and steps.
 */
export function vmLimits_derive(shape: { name: string; family: string; vcpuPerCore: number; cores: { min: number; max: number }; memoryGib: { min: number; max: number }; memoryPerVcpuGib?: { min: number; max: number } }): VmLimits {
  const step: number = Math.max(1, shape.vcpuPerCore);
  const min: number = Math.max(step, Math.ceil(shape.cores.min / step) * step);
  const max: number = Math.max(min, Math.floor(shape.cores.max / step) * step);
  return {
    shape: shape.name,
    family: shape.family,
    vcpu: { min, max, step },
    memory: { min: shape.memoryGib.min, max: shape.memoryGib.max, perVcpu: shape.memoryPerVcpuGib ?? null },
    disk: { min: VM_DISK_FLOOR, max: VM_DISK_CEILING },
    data: { min: VM_DISK_FLOOR, max: VM_DISK_CEILING },
  };
}

/**
 * The limits as lines.
 *
 * @param limits - The limits.
 * @returns One line per word of the spec.
 */
export function vmLimits_lines(limits: VmLimits): string[] {
  const per: string = limits.memory.perVcpu === null ? '' : `, ${limits.memory.perVcpu.min} to ${limits.memory.perVcpu.max} GiB per vCPU`;
  return [
    `shape   ${limits.shape} (${limits.family})`,
    `vcpu    ${limits.vcpu.min} to ${limits.vcpu.max}, in steps of ${limits.vcpu.step}`,
    `memory  ${limits.memory.min} to ${limits.memory.max} GiB${per}`,
    `disk    ${limits.disk.min} to ${limits.disk.max} GB`,
    `data    ${limits.data.min} to ${limits.data.max} GB, backups daily or none`,
  ];
}

/** An operating system's word. */
const OS_WORD: RegExp = /^[a-z]+-[0-9][0-9.]*$/;

/** The options `vm new` reads, each a value. */
export const VM_OPTIONS: ReadonlyArray<string> = ['--net', '--open', '--vcpu', '--memory', '--disk', '--data', '--data-backup', '--os', '--ssh', '--ssh-user', '--ssh-key', '--ssh-key-file'];

/**
 * Whether a line is one OpenSSH public key, and never a private one.
 *
 * @param key - The line.
 * @returns Why not, or null when it is one.
 */
export function sshKey_check(key: string): string | null {
  if (/PRIVATE KEY/.test(key)) return 'that is a private key: give the public one (the .pub file)';
  if (!SSH_KEY_LINE.test(key.trim())) return 'not an OpenSSH public key line (ssh-ed25519 AAAA… comment)';
  return null;
}

/**
 * The ports a VM opens to the internet: the declared ones, and public SSH's
 * when its door is open.
 *
 * @param spec - The spec.
 * @returns The ports, sorted.
 */
export function vmPorts_open(spec: VmSpec): number[] {
  const ports: number[] = [...spec.open];
  if (spec.ssh?.on === true && !ports.includes(spec.ssh.port)) ports.push(spec.ssh.port);
  return ports.sort((a: number, b: number): number => a - b);
}

/**
 * Public SSH, in words.
 *
 * @param ssh - The door, or absent.
 * @returns `2222 for ops`, `off (2222 for ops kept)`, or `none`.
 */
export function vmSsh_words(ssh: VmSsh | undefined): string {
  if (ssh === undefined) return 'none';
  return ssh.on ? `${ssh.port} for ${ssh.user}` : `off (${ssh.port} for ${ssh.user} kept)`;
}

/**
 * A whole number in a range.
 *
 * @param word - The option, for the refusal.
 * @param text - Its value.
 * @param least - The smallest allowed.
 * @param most - The largest allowed.
 * @returns The number, or why not.
 */
function count_read(word: string, text: string, least: number, most: number): { value: number } | { error: string } {
  const value: number = Number(text);
  if (!/^[0-9]+$/.test(text) || value < least || value > most) return { error: `${word} ${text}: a whole number from ${least} to ${most}` };
  return { value };
}

/**
 * Reads `--open 80,443`.
 *
 * @param text - The ports.
 * @returns The ports, sorted, or why not.
 */
export function ports_read(text: string): { ports: number[] } | { error: string } {
  if (text.trim() === '' || text === 'none') return { ports: [] };
  const ports: number[] = [];
  for (const word of text.split(',')) {
    const read = count_read('--open', word.trim(), 1, 65535);
    if ('error' in read) return read;
    if (read.value === 22) return { error: '--open 22: SSH is its own service: --ssh 22 --ssh-key-file <key.pub> opens it for an administrative user, key-only' };
    if (!ports.includes(read.value)) ports.push(read.value);
  }
  return { ports: ports.sort((a: number, b: number): number => a - b) };
}

/**
 * The spec from `vm new`'s options, over the spec kept (an option not given keeps its value).
 *
 * @param options - The options given.
 * @param kept - The spec kept, or null for a new VM.
 * @returns The spec, or why not.
 */
export function vmSpec_read(options: ReadonlyMap<string, string>, kept: VmSpec | null): { spec: VmSpec } | { error: string } {
  const given = (word: string): string | undefined => options.get(word);
  const net: string | undefined = given('--net') ?? kept?.net;
  if (net === undefined) return { error: '--net <network> is needed (net new declares one)' };
  const numbers: Array<[keyof VmSpec, string, number, number]> = [['vcpu', '--vcpu', 1, 128], ['memory', '--memory', 1, 1024], ['disk', '--disk', VM_DISK_FLOOR, VM_DISK_CEILING], ['data', '--data', VM_DISK_FLOOR, VM_DISK_CEILING]];
  const values: Partial<Record<keyof VmSpec, number>> = {};
  for (const [key, word, least, most] of numbers) {
    const text: string | undefined = given(word);
    if (text === undefined) {
      const was: unknown = kept?.[key];
      if (typeof was !== 'number') return { error: `${word} is needed` };
      values[key] = was;
      continue;
    }
    const read = count_read(word, text, least, most);
    if ('error' in read) return read;
    values[key] = read.value;
  }
  let open: number[] = kept?.open ?? [];
  const openText: string | undefined = given('--open');
  if (openText !== undefined) {
    const read = ports_read(openText);
    if ('error' in read) return read;
    open = read.ports;
  }
  const backup: string = given('--data-backup') ?? kept?.dataBackup ?? 'none';
  if (backup !== 'daily' && backup !== 'none') return { error: `--data-backup ${backup}: daily or none` };
  const os: string | undefined = given('--os') ?? kept?.os;
  if (os === undefined) return { error: '--os is needed (ubuntu-26.04)' };
  if (!OS_WORD.test(os)) return { error: `--os ${os}: a name and a version (ubuntu-26.04)` };
  const ssh = vmSsh_read(options, kept?.ssh, open);
  if (ssh !== undefined && 'error' in ssh) return ssh;
  const spec: VmSpec = { net, open, vcpu: values.vcpu as number, memory: values.memory as number, disk: values.disk as number, data: values.data as number, dataBackup: backup, os };
  if (ssh !== undefined) spec.ssh = ssh;
  return { spec };
}

/**
 * Public SSH from `vm new`'s options, over the door kept: `--ssh <port>` opens
 * it, `--ssh off` closes it and keeps its user and key, `--ssh-user` and
 * `--ssh-key` change them (`--ssh-key-file` is read to `--ssh-key` before).
 *
 * @param options - The options given.
 * @param kept - The door kept, or absent.
 * @param open - The other ports declared, which the door may not take.
 * @returns The door, absent when none is declared, or why not.
 */
function vmSsh_read(options: ReadonlyMap<string, string>, kept: VmSsh | undefined, open: ReadonlyArray<number>): VmSsh | undefined | { error: string } {
  const portWord: string | undefined = options.get('--ssh');
  const userWord: string | undefined = options.get('--ssh-user');
  const keyWord: string | undefined = options.get('--ssh-key');
  if (portWord === undefined && userWord === undefined && keyWord === undefined) return kept;
  const user: string = userWord ?? kept?.user ?? VM_SSH_USER;
  if (!SSH_USER_WORD.test(user) || user === 'root' || user === 'ubuntu') return { error: `--ssh-user ${user}: a Linux user's name (lower case, at most 32), not root or ubuntu (the machine's own)` };
  const key: string | undefined = keyWord?.trim() ?? kept?.key;
  if (key !== undefined) {
    const bad: string | null = sshKey_check(key);
    if (bad !== null) return { error: `--ssh-key: ${bad}` };
  }
  if (portWord === 'off') return kept === undefined && key === undefined ? undefined : kept === undefined ? { error: '--ssh off: no SSH door was declared to close' } : { ...kept, user, key: key ?? kept.key, on: false };
  let port: number | undefined = kept?.port;
  if (portWord !== undefined) {
    const read = count_read('--ssh', portWord, 1, 65535);
    if ('error' in read) return { error: `${read.error}, or off` };
    port = read.value;
  }
  if (port === undefined) return { error: '--ssh <port> opens SSH to the internet (22, or another port)' };
  if (open.includes(port)) return { error: `--ssh ${port}: --open already opens ${port} for another service` };
  if (key === undefined) return { error: '--ssh needs the user\'s public key: --ssh-key-file <key.pub> or --ssh-key "<ssh-ed25519 …>"' };
  return { port, user, key, on: portWord !== undefined ? true : kept?.on ?? true };
}

/**
 * The spec as `spec.yaml`.
 *
 * @param name - The VM.
 * @param spec - Its spec.
 * @returns The file's text.
 */
export function vmSpecYaml_render(name: string, spec: VmSpec): string {
  return `# The VM ${name}, as \`vm new\` declared it. Written by stratus; replay the script to change it.\n${yaml.dump({ ...spec })}`;
}

/**
 * Reads `spec.yaml`.
 *
 * @param text - The file's text.
 * @returns The spec, or why it does not read.
 */
export function vmSpecYaml_parse(text: string): { spec: VmSpec } | { error: string } {
  let value: unknown;
  try {
    value = yaml.load(text);
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (value === null || typeof value !== 'object') return { error: 'spec.yaml: not a mapping' };
  const read: Record<string, unknown> = value as Record<string, unknown>;
  const options: Map<string, string> = new Map();
  const pairs: Array<[string, string]> = [['net', '--net'], ['vcpu', '--vcpu'], ['memory', '--memory'], ['disk', '--disk'], ['data', '--data'], ['dataBackup', '--data-backup'], ['os', '--os']];
  for (const [key, word] of pairs) if (read[key] !== undefined) options.set(word, String(read[key]));
  options.set('--open', Array.isArray(read['open']) ? read['open'].join(',') : 'none');
  const ssh: unknown = read['ssh'];
  if (ssh !== null && typeof ssh === 'object') {
    const door: Record<string, unknown> = ssh as Record<string, unknown>;
    options.set('--ssh', String(door['port']));
    options.set('--ssh-user', String(door['user']));
    options.set('--ssh-key', String(door['key']));
  }
  const spec = vmSpec_read(options, null);
  if ('error' in spec) return { error: `spec.yaml: ${spec.error}` };
  if (spec.spec.ssh !== undefined && ssh !== null && typeof ssh === 'object' && (ssh as Record<string, unknown>)['on'] === false) spec.spec.ssh.on = false;
  return spec;
}

/**
 * What a build would change: the declared spec against what the tenancy
 * runs, for each part the tenancy was read for (the sizes, the ports open to
 * the internet, the data's backups, the OS).
 *
 * @param stands - What the tenancy runs, read from the cloud.
 * @param spec - The spec declared.
 * @returns The changes, `disk 50 → 180 GB`; empty when what runs is what is declared.
 */
export function vmStands_diff(stands: { vcpu: number | null; memory: number | null; disk: number | null; data: number | null; open?: ReadonlyArray<number> | null; backup?: string | null; os?: string | null }, spec: VmSpec): string[] {
  const owed: string[] = [];
  const unit: Readonly<Record<string, string>> = { vcpu: '', memory: ' GiB', disk: ' GB', data: ' GB' };
  for (const key of ['vcpu', 'memory', 'disk', 'data'] as const) {
    const now: number | null = stands[key];
    if (now !== null && now !== spec[key]) owed.push(`${key} ${now} → ${spec[key]}${unit[key]}`);
  }
  const ports = (list: ReadonlyArray<number>): string => (list.length === 0 ? 'none' : list.join(','));
  if (stands.open !== undefined && stands.open !== null && ports(stands.open) !== ports(vmPorts_open(spec))) owed.push(`open ${ports(stands.open)} → ${ports(vmPorts_open(spec))}`);
  if (stands.backup !== undefined && stands.backup !== null && stands.backup !== spec.dataBackup) owed.push(`backups ${stands.backup} → ${spec.dataBackup}`);
  if (stands.os !== undefined && stands.os !== null && stands.os !== spec.os) owed.push(`os ${stands.os} → ${spec.os}`);
  return owed;
}

/**
 * What changed between two specs, a line each.
 *
 * @param before - The spec kept.
 * @param after - The spec declared now.
 * @returns `memory 8 → 16`, one per field changed.
 */
export function vmSpec_diff(before: VmSpec, after: VmSpec): string[] {
  const shown = (value: VmSpec[keyof VmSpec]): string => Array.isArray(value) ? (value.length === 0 ? 'none' : value.join(',')) : String(value);
  const keys: Array<keyof VmSpec> = [...new Set([...Object.keys(before), ...Object.keys(after)])] as Array<keyof VmSpec>;
  return keys.filter((key: keyof VmSpec): boolean => key !== 'ssh' || before.ssh !== undefined || after.ssh !== undefined)
    .map((key: keyof VmSpec): [keyof VmSpec, string, string] => [key, key === 'ssh' ? vmSshDiff_shown(before.ssh) : shown(before[key]), key === 'ssh' ? vmSshDiff_shown(after.ssh) : shown(after[key])])
    .filter(([, was, now]: [keyof VmSpec, string, string]): boolean => was !== now)
    .map(([key, was, now]: [keyof VmSpec, string, string]): string => `${key} ${was} → ${now}`);
}

/**
 * Public SSH as a spec diff shows it: the door and a key's tail, so a replaced key is a change.
 *
 * @param ssh - The door, or absent.
 * @returns `2222 for ops (key …AbCdEf12)`, or `none`.
 */
function vmSshDiff_shown(ssh: VmSsh | undefined): string {
  return ssh === undefined ? 'none' : `${vmSsh_words(ssh)} (key …${(ssh.key.split(' ')[1] ?? '').slice(-8)})`;
}

/**
 * Which changes destroy what the data volume holds, or the machine: a smaller
 * data volume cannot be had without a new one.
 *
 * @param before - The spec built.
 * @param after - The spec declared now.
 * @returns The fields whose change makes a new data volume.
 */
export function vmSpec_dataLoss(before: VmSpec, after: VmSpec): string[] {
  const lost: string[] = [];
  if (after.data < before.data) lost.push(`data ${before.data} → ${after.data} (a volume only grows)`);
  if (after.net !== before.net) lost.push(`net ${before.net} → ${after.net} (a volume stays in its network's place)`);
  return lost;
}

/**
 * Reads `--ssh-key-file` into `--ssh-key`: the public key's first line, so the
 * declaration keeps the key itself and a rebuild needs no file.
 *
 * @param options - The options; changed in place.
 * @returns Why the file did not read, or null.
 */
export function sshKeyFile_resolve(options: Map<string, string>): string | null {
  const keyFile: string | undefined = options.get('--ssh-key-file');
  if (keyFile === undefined) return null;
  if (options.has('--ssh-key')) return '--ssh-key and --ssh-key-file: one of them';
  try {
    options.set('--ssh-key', fs.readFileSync(keyFile.replace(/^~(?=\/)/, process.env['HOME'] ?? '~'), 'utf-8').trim().split('\n')[0] ?? '');
  } catch (error: unknown) {
    return `--ssh-key-file ${keyFile}: ${error instanceof Error ? error.message : String(error)}`;
  }
  options.delete('--ssh-key-file');
  return null;
}
