/**
 * @file Whether a daemon may start for an identity: what this runtime's record of it says, probed.
 *
 * A daemon refuses to host a rival for an identity one of its own already serves. A record proves its daemon is
 * running only by answering a probe (`berthInstance_probe`); an earlier release's record cannot, and whether it
 * still runs is unknown unless its address refuses a connection. Neither a live record nor an unverified one is
 * grounds to start beside it.
 *
 * Key components:
 * - RivalStanding: a record in the way of a start, and what its probe said.
 * - rival_read: this runtime's record for an identity, probed.
 * - rivalRefusal_lines: what a refused start says.
 *
 * Typical usage:
 * ```ts
 * const rival: RivalStanding | null = await rival_read(identity);
 * if (rival !== null) rivalRefusal_lines(rival, '').forEach((line: string): void => { console.error(line); });
 * ```
 *
 * Dependencies: ./berth.js (berthOwn_read, berthInstance_probe).
 *
 * @module
 */

import { berthInstance_probe, berthOwn_read, type Berth, type BerthLiveness } from './berth.js';

/**
 * A record that stands in the way of a start, and what its probe said.
 *
 * @example
 * ```ts
 * const rival: RivalStanding = { berth, liveness: 'unverified' };
 * ```
 */
export interface RivalStanding {
  /** The record. */
  berth: Berth;
  /** Live, or unverified (an earlier release's). */
  liveness: Exclude<BerthLiveness, 'dead'>;
}

/**
 * Reads this runtime's own record for an identity and probes it.
 *
 * @param identity - The normalised identity.
 * @param probe - The probe (a test's seam).
 * @returns The record standing in the way, or null when a daemon may start.
 *
 * @example
 * ```ts
 * const rival: RivalStanding | null = await rival_read(identity);
 * ```
 */
export async function rival_read(identity: string, probe: (berth: Berth) => Promise<BerthLiveness> = berthInstance_probe): Promise<RivalStanding | null> {
  const berth: Berth | null = berthOwn_read(identity);
  if (berth === null) return null;
  const liveness: BerthLiveness = await probe(berth);
  return liveness === 'dead' ? null : { berth, liveness };
}

/**
 * What is said when a start is refused: a live daemon is pointed at; an unverified one is named with how to stop
 * it. Its pid is not offered to kill: an unverified record's pid may since be another program's.
 *
 * @param rival - The record in the way.
 * @param attachHint - The identity to attach by, with a leading space, or empty.
 * @returns The lines, the first the refusal.
 *
 * @example
 * ```ts
 * rivalRefusal_lines(rival, ` ${identity}`).forEach((line: string): void => console.error(line));
 * ```
 */
export function rivalRefusal_lines(rival: RivalStanding, attachHint: string): [string, string] {
  const { berth } = rival;
  if (rival.liveness === 'live') return [`[!] Calypso is already running for ${berth.identity} at ${berth.url}`, `    attach with:  chell --remote${attachHint}`];
  const pid: string = berth.pid !== undefined ? ` (pid ${String(berth.pid)} when it was written)` : '';
  return [
    `[!] A daemon of an earlier release may still be running for ${berth.identity} at ${berth.url}${pid}.`,
    '    Stop the old daemon from its original terminal (Ctrl-C at the idle daemon prompt) or through its service manager, then retry.',
  ];
}
