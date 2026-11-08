/**
 * @file A spoke's berth policy (docs/dev-bastion.adoc, stand-in, Q5): what
 * one berth may use, and how many the host holds. Capacity is the host less
 * the ChRIS profile's floor, divided by the limit per berth; a policy may
 * name a smaller number. A spoke that is full refuses, naming who holds it.
 *
 * @module
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CHRIS_PROFILE_OFFERS, type ChrisProfileFloor } from '@fnndsc/menu';

/** What one berth may use. */
export interface BerthLimits {
  /** CPUs. */
  readonly cpus: number;
  /** Memory, in GiB. */
  readonly memoryGib: number;
  /** Processes and threads. */
  readonly pids: number;
}

/** A spoke's berth policy: the limits per berth, and the number it holds when the policy names one. */
export interface BerthPolicy {
  readonly limits: BerthLimits;
  /** The berths the spoke holds, when the policy says; null: as many as the host holds. */
  readonly holds: number | null;
}

/** The host a spoke runs on, as its engine reports it. */
export interface HostSize {
  readonly cpus: number;
  readonly memoryGib: number;
}

/** The limits a berth has when the policy names none: one CPU, 2 GiB, 1024 processes. */
export const BERTH_LIMITS_DEFAULT: BerthLimits = { cpus: 1, memoryGib: 2, pids: 1024 };

/** A policy file, as the operator writes it. */
const policySchema = z.object({
  cpus: z.number().positive().optional(),
  memoryGib: z.number().positive().optional(),
  pids: z.number().int().positive().optional(),
  holds: z.number().int().nonnegative().optional(),
}).strict();

/**
 * Reads a policy file (JSON: `cpus`, `memoryGib`, `pids`, `holds`, each optional), or the defaults when none is named.
 *
 * @param path - The file, or null.
 * @returns The policy.
 * @throws {Error} When the file is not a policy.
 */
export function berthPolicy_read(path: string | null): BerthPolicy {
  if (path === null) return { limits: BERTH_LIMITS_DEFAULT, holds: null };
  const parsed = policySchema.safeParse(JSON.parse(readFileSync(path, 'utf-8')));
  if (!parsed.success) throw new Error(`${path}: not a berth policy (${parsed.error.issues.map((issue): string => `${issue.path.join('.')}: ${issue.message}`).join('; ')})`);
  return {
    limits: { cpus: parsed.data.cpus ?? BERTH_LIMITS_DEFAULT.cpus, memoryGib: parsed.data.memoryGib ?? BERTH_LIMITS_DEFAULT.memoryGib, pids: parsed.data.pids ?? BERTH_LIMITS_DEFAULT.pids },
    holds: parsed.data.holds ?? null,
  };
}

/** The floor of the ChRIS profile a spoke runs: what CUBE takes before any berth. */
export function profileFloor_get(profile: string = 'minimal'): ChrisProfileFloor {
  const floor: ChrisProfileFloor | null | undefined = CHRIS_PROFILE_OFFERS.find((offer): boolean => offer.name === profile)?.floor;
  return floor ?? { vcpu: 2, memory: 4, data: 50 };
}

/**
 * How many berths a host holds: what is left of it above the profile's
 * floor, divided by one berth's limits, the scarcer of CPU and memory
 * deciding; a policy's own number when it names a smaller one.
 *
 * @param host - The host's size.
 * @param floor - The profile's floor.
 * @param policy - The policy.
 * @returns The berths it holds, never less than none.
 */
export function berthCapacity_derive(host: HostSize, floor: ChrisProfileFloor, policy: BerthPolicy): number {
  const byCpu: number = Math.floor((host.cpus - floor.vcpu) / policy.limits.cpus);
  const byMemory: number = Math.floor((host.memoryGib - floor.memory) / policy.limits.memoryGib);
  const fits: number = Math.max(0, Math.min(byCpu, byMemory));
  return policy.holds === null ? fits : Math.min(fits, policy.holds);
}

/**
 * The refusal a full spoke gives, naming who holds it.
 *
 * @param capacity - The berths it holds.
 * @param users - Who is in them.
 * @returns The words.
 */
export function capacityRefusal_words(capacity: number, users: ReadonlyArray<string>): string {
  if (capacity === 0) return 'this ChRIS holds no berth: its host has nothing above the profile\'s floor';
  return `this ChRIS holds ${capacity} berth${capacity === 1 ? '' : 's'}, in use by ${[...users].sort().join(', ')}`;
}
