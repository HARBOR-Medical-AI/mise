/**
 * @file ChRIS profiles (docs/stratus.adoc, D16): what a `chris deploy
 * --profile` names, as data. A profile is the all-in-one CUBE, never a half
 * one: it always has a compute (pfcon, in-network, running plugins through
 * the host's Docker). It names its services and its floor; a target below
 * the floor is refused and told by how much. No profile carries the ChRIS
 * UI: the UI is porter and ARGUS, which `chris deploy --porter` adds beside
 * any profile.
 *
 * @module
 */

import { CHRIS_PROFILE_OFFERS, type ChrisProfileFloor } from '@fnndsc/menu';

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
  // The full image, not slim: calypso's node-pty builds from source on Linux.
  node: 'docker.io/library/node:24.11.1-bookworm',
} as const;

/** The porter a deploy with `--porter` installs, pinned, with the chell, calypso and ARGUS it brings. */
export const PORTER_VERSION: string = '0.9.13';

/** The first porter whose release carries the berth launcher, and the berths' way to CUBE at cube-net's gateway. */
export const PORTER_BERTHS_SINCE: string = '0.10.0';

/**
 * Whether a porter release carries the berth launcher.
 *
 * @param version - The release (`0.9.13`).
 * @returns Whether it is {@link PORTER_BERTHS_SINCE} or later.
 */
export function porterBerths_carries(version: string = PORTER_VERSION): boolean {
  const parts = (one: string): number[] => one.split('.').map((part: string): number => Number(part));
  const [have, since] = [parts(version), parts(PORTER_BERTHS_SINCE)];
  for (let i: number = 0; i < 3; i++) if ((have[i] ?? 0) !== (since[i] ?? 0)) return (have[i] ?? 0) > (since[i] ?? 0);
  return true;
}

/** A profile: its services and the least it runs on. */
export interface ChrisProfile {
  readonly name: string;
  readonly summary: string;
  /** The compose services it runs. */
  readonly services: ReadonlyArray<string>;
  /** The least a target has: vCPUs, GiB of memory, GB of data. */
  readonly floor: ChrisProfileFloor;
}

/** The compose services each deployed profile runs. */
const PROFILE_SERVICES: Readonly<Record<string, ReadonlyArray<string>>> = {
  minimal: ['db', 'dragonfly', 'nats', 'files-fix', 'migrate', 'chris', 'worker', 'worker-periodic', 'scheduler', 'pfcon', 'caddy'],
};

/**
 * The profiles the engine deploys, by name: the menu's built offers with their services. What each is and its floor are the menu's, the one source the screens list them from.
 *
 * @returns The deployable profiles.
 */
function profiles_build(): Record<string, ChrisProfile> {
  const profiles: Record<string, ChrisProfile> = {};
  for (const offer of CHRIS_PROFILE_OFFERS) {
    const services: ReadonlyArray<string> | undefined = PROFILE_SERVICES[offer.name];
    if (!offer.built || offer.floor === null || services === undefined) continue;
    profiles[offer.name] = { name: offer.name, summary: offer.summary, services, floor: offer.floor };
  }
  return profiles;
}

/** The profiles, by name. */
export const CHRIS_PROFILES: Readonly<Record<string, ChrisProfile>> = profiles_build();

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
