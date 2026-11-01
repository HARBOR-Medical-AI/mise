/**
 * @file A VM's spec (docs/stratus.adoc, D16): what a `vm new` line declares,
 * in words every cloud understands. The driver chooses the family, the image
 * and the zone; a script never names them.
 *
 * `spec.yaml` is the record of the line, written by `vm new`, never by hand.
 *
 * @module
 */
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
}

/** The smallest disk and data volume any cloud stratus drives will make, GB. */
export const VM_DISK_FLOOR: number = 50;

/** An operating system's word. */
const OS_WORD: RegExp = /^[a-z]+-[0-9][0-9.]*$/;

/** The options `vm new` reads, each a value. */
export const VM_OPTIONS: ReadonlyArray<string> = ['--net', '--open', '--vcpu', '--memory', '--disk', '--data', '--data-backup', '--os'];

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
    if (read.value === 22) return { error: '--open 22: SSH goes through the network\'s bastion (vm shell); opening it to the internet is its own decision, not yet a word' };
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
  const numbers: Array<[keyof VmSpec, string, number, number]> = [['vcpu', '--vcpu', 1, 128], ['memory', '--memory', 1, 1024], ['disk', '--disk', VM_DISK_FLOOR, 32768], ['data', '--data', VM_DISK_FLOOR, 32768]];
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
  return { spec: { net, open, vcpu: values.vcpu as number, memory: values.memory as number, disk: values.disk as number, data: values.data as number, dataBackup: backup, os } };
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
  const spec = vmSpec_read(options, null);
  return 'error' in spec ? { error: `spec.yaml: ${spec.error}` } : spec;
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
  return (Object.keys(after) as Array<keyof VmSpec>).filter((key: keyof VmSpec): boolean => shown(before[key]) !== shown(after[key])).map((key: keyof VmSpec): string => `${key} ${shown(before[key])} → ${shown(after[key])}`);
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
