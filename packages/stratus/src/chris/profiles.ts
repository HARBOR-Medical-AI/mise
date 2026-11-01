/**
 * @file ChRIS profiles (docs/stratus.adoc, D16): what a `chris deploy
 * --profile` names, as data. A profile is the all-in-one CUBE, never a half
 * one: it always has a compute (pfcon, in-network, running plugins through
 * the host's Docker). It names its services and its floor; a target below
 * the floor is refused and told by how much. No profile carries the ChRIS
 * UI: the UI is porter and ARGUS.
 *
 * @module
 */

/** The images a profile runs, pinned. */
export const CHRIS_IMAGES = {
  cube: 'ghcr.io/fnndsc/cube:6.11.0',
  // 5.3.1, not 6: CUBE 6.11.0's pfcon client asks /api/v1/jobs/, which pfcon 6 renamed.
  pfcon: 'ghcr.io/fnndsc/pfcon:5.3.1',
  postgres: 'docker.io/library/postgres:17',
  dragonfly: 'docker.dragonflydb.io/dragonflydb/dragonfly:v1.37.0',
  nats: 'docker.io/library/nats:2.10.20-alpine3.20',
  caddy: 'docker.io/library/caddy:2.10',
  alpine: 'docker.io/library/alpine:3.22',
} as const;

/** A profile: its services and the least it runs on. */
export interface ChrisProfile {
  readonly name: string;
  readonly summary: string;
  /** The compose services it runs. */
  readonly services: ReadonlyArray<string>;
  /** The least a target has: vCPUs, GiB of memory, GB of data. */
  readonly floor: { readonly vcpu: number; readonly memory: number; readonly data: number };
}

/** The profiles, by name. */
export const CHRIS_PROFILES: Readonly<Record<string, ChrisProfile>> = {
  minimal: {
    name: 'minimal',
    summary: 'CUBE, its workers and scheduler, Postgres, Dragonfly, NATS and pfcon, behind Caddy',
    services: ['db', 'dragonfly', 'nats', 'files-fix', 'migrate', 'chris', 'worker', 'worker-periodic', 'scheduler', 'pfcon', 'caddy'],
    floor: { vcpu: 2, memory: 4, data: 50 },
  },
};

/**
 * Why a target is below a profile's floor, a line each.
 *
 * @param profile - The profile.
 * @param target - The target's vCPUs, memory and data.
 * @returns The shortfalls, empty when it fits.
 */
export function floor_short(profile: ChrisProfile, target: { vcpu: number; memory: number; data: number }): string[] {
  const short: string[] = [];
  if (target.vcpu < profile.floor.vcpu) short.push(`${target.vcpu} vCPU, ${profile.floor.vcpu - target.vcpu} short of ${profile.floor.vcpu}`);
  if (target.memory < profile.floor.memory) short.push(`${target.memory} GiB, ${profile.floor.memory - target.memory} short of ${profile.floor.memory}`);
  if (target.data < profile.floor.data) short.push(`data ${target.data} GB, ${profile.floor.data - target.data} short of ${profile.floor.data}`);
  return short;
}
