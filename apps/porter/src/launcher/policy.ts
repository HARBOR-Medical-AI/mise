/**
 * @file A spoke's berth policy (docs/dev-bastion.adoc, stand-in, Q5): what
 * one berth may use, and how many the host holds. Capacity is the host's
 * memory less the ChRIS profile's floor, divided by the memory per berth (a
 * berth's CPUs are a cap on shared CPUs, not counted); a policy may name a
 * smaller number. A spoke that is full refuses, naming who holds it.
 *
 * @module
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { BerthCapacityRule, BerthLimits as BerthSize } from '@fnndsc/menu';

/** What one berth may use. */
export interface BerthLimits extends BerthSize {
  /** Processes and threads. */
  readonly pids: number;
}

/** A spoke's berth policy: the limits per berth, and the number it holds when the policy names one. */
export interface BerthPolicy extends BerthCapacityRule {
  /** What one berth may use, processes included. */
  readonly limits: BerthLimits;
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

/** The memory a spoke's capacity is counted from, in GiB. */
export interface BerthRoom {
  /** The host's memory. */
  readonly hostGib: number;
  /** What the ChRIS profile's floor takes of it. */
  readonly floorGib: number;
  /** What one berth may use. */
  readonly berthGib: number;
}

/**
 * The refusal a full spoke gives, naming who holds it; when it holds none, why: one berth's memory does not fit above the floor, or the policy names none.
 *
 * @param capacity - The berths it holds.
 * @param users - Who is in them.
 * @param room - The memory the capacity is counted from.
 * @returns The words.
 *
 * @example
 * ```ts
 * capacityRefusal_words(0, [], { hostGib: 8, floorGib: 4, berthGib: 6 }); // 'this ChRIS holds no berth: 6 GiB each does not fit above the profile\'s floor (8 GiB, the floor takes 4 GiB)'
 * ```
 */
export function capacityRefusal_words(capacity: number, users: ReadonlyArray<string>, room: BerthRoom): string {
  if (capacity === 0) {
    if (room.hostGib - room.floorGib >= room.berthGib) return 'this ChRIS holds no berth: its policy holds none';
    return `this ChRIS holds no berth: ${room.berthGib} GiB each does not fit above the profile's floor (${room.hostGib} GiB, the floor takes ${room.floorGib} GiB)`;
  }
  return `this ChRIS holds ${capacity} berth${capacity === 1 ? '' : 's'}, in use by ${[...users].sort().join(', ')}`;
}
