/**
 * @file A network's spec (docs/stratus.adoc, D16): the address range a
 * `net new <name> --cidr` line declares, in words every cloud understands.
 * The subnet the VMs sit on is the range's first /24; the gateway, the
 * route, the security list and the managed bastion are the driver's.
 *
 * `spec.yaml` is the record of the line, written by `net new`, never by hand.
 *
 * @module
 */
import * as yaml from 'js-yaml';

/** What a network is declared with. */
export interface NetSpec {
  /** The network's address range, IPv4 CIDR, /16 to /24. */
  cidr: string;
}

/** What a network is made of, in every cloud's words, as `net plan` says it before a plan is run. */
export const NET_RESOURCES: ReadonlyArray<string> = ['network (the address range)', 'internet gateway', 'route table (the default, routed to the gateway)', 'security list (the default: SSH only from inside the network)', 'subnet (public, the range\'s first /24)', 'bastion (the cloud\'s managed one, admitting only this host)'];

/** An IPv4 address with a prefix. */
const CIDR: RegExp = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

/** The widest and narrowest range a network may have: OCI's VCN allows /16 at widest, and the subnet is a /24 inside it. */
export const NET_PREFIX_RANGE: Readonly<{ widest: number; narrowest: number }> = { widest: 16, narrowest: 24 };

/**
 * An IPv4 address as a number.
 *
 * @param octets - Its four parts.
 * @returns The address.
 */
function octets_number(octets: ReadonlyArray<number>): number {
  return octets.reduce((sum: number, octet: number): number => sum * 256 + octet, 0);
}

/**
 * An address as dotted text.
 *
 * @param value - The address.
 * @returns `10.20.0.0`.
 */
function number_octets(value: number): string {
  return [24, 16, 8, 0].map((shift: number): number => Math.floor(value / 2 ** shift) % 256).join('.');
}

/**
 * Reads a range, refusing what a network cannot have.
 *
 * @param text - `10.20.0.0/16`.
 * @returns The range in its normal form, or why it is refused.
 */
export function cidr_read(text: string): { cidr: string } | { error: string } {
  const match: RegExpMatchArray | null = CIDR.exec(text.trim());
  if (match === null) return { error: `${text}: not an IPv4 range (10.20.0.0/16)` };
  const octets: number[] = match.slice(1, 5).map(Number);
  const prefix: number = Number(match[5]);
  if (octets.some((octet: number): boolean => octet > 255)) return { error: `${text}: not an IPv4 address` };
  if (prefix < NET_PREFIX_RANGE.widest || prefix > NET_PREFIX_RANGE.narrowest) return { error: `${text}: a network is /${NET_PREFIX_RANGE.widest} to /${NET_PREFIX_RANGE.narrowest}` };
  const address: number = octets_number(octets);
  const size: number = 2 ** (32 - prefix);
  if (address % size !== 0) return { error: `${text}: the address is not the range's first (${number_octets(address - (address % size))}/${prefix})` };
  return { cidr: `${number_octets(address)}/${prefix}` };
}

/**
 * The subnet the VMs sit on: the range's first /24.
 *
 * @param cidr - The network's range, read.
 * @returns `10.20.0.0/24`.
 */
export function subnet_derive(cidr: string): string {
  return `${cidr.split('/')[0]}/24`;
}

/**
 * The spec as `spec.yaml`.
 *
 * @param name - The network.
 * @param spec - Its spec.
 * @returns The file's text.
 */
export function netSpecYaml_render(name: string, spec: NetSpec): string {
  return `# The network ${name}, as \`net new\` declared it. Written by stratus; replay the script to change it.\n${yaml.dump({ cidr: spec.cidr })}`;
}

/**
 * Reads `spec.yaml`.
 *
 * @param text - The file's text.
 * @returns The spec, or why it does not read.
 */
export function netSpecYaml_parse(text: string): { spec: NetSpec } | { error: string } {
  let value: unknown;
  try {
    value = yaml.load(text);
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (value === null || typeof value !== 'object' || typeof (value as { cidr?: unknown }).cidr !== 'string') return { error: 'spec.yaml: no cidr' };
  const read = cidr_read((value as { cidr: string }).cidr);
  return 'error' in read ? read : { spec: { cidr: read.cidr } };
}

/**
 * What changed between two specs, a line each.
 *
 * @param before - The spec kept.
 * @param after - The spec declared now.
 * @returns `cidr 10.20.0.0/16 → 10.30.0.0/16`, or nothing when they agree.
 */
export function netSpec_diff(before: NetSpec, after: NetSpec): string[] {
  return before.cidr === after.cidr ? [] : [`cidr ${before.cidr} → ${after.cidr}`];
}
