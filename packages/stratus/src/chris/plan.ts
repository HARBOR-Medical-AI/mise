/**
 * @file What a `chris deploy` would do to the ChRIS it replays over, worked
 * out before it acts (AEGIS's a-change-is-a-loop, clauses 2 and 4): the
 * options that change against the deploy's record, the services that
 * restart and why (a new CUBE image, a new porter, a CUBE whose environment
 * changes), and what a porter restart ends (its open sessions, read from it).
 * A replay that restarts nothing and changes nothing does not ask; one that
 * does asks with all of it first. Twice on 2026-11-04 a replay restarted
 * porter and ended every session, asked by nothing and said by nothing.
 *
 * @module
 */
import type { VmRecord } from '../vm/state.js';
import { CHRIS_IMAGES, PORTER_VERSION } from './profiles.js';

/** What a deploy is asked to put up. */
export interface ChrisPlanAsk {
  readonly profile: string;
  readonly compute: string;
  readonly host: string | null;
  readonly porter: string | null;
}

/** What a deploy would do, worked out without acting. */
export interface ChrisPlan {
  readonly changes: string[];
  readonly restarts: string[];
  readonly sessions: number | null;
  readonly asks: boolean;
}

/**
 * What a deploy would do over what was deployed.
 *
 * @param deployed - The deploy's record, or undefined for a first deploy.
 * @param ask - What this deploy is asked to put up.
 * @param sessions - Porter's open sessions, read from it, or null.
 * @returns The changes, the restarts, the sessions a porter restart ends, and whether it asks.
 */
export function chrisPlan_derive(deployed: VmRecord['chris'], ask: ChrisPlanAsk, sessions: number | null): ChrisPlan {
  if (deployed === undefined) return { changes: ['a first deploy: CUBE and its services are put up'], restarts: [], sessions: null, asks: false };
  const changes: string[] = [];
  const want = (word: string, kept: string | null | undefined, asked: string | null): void => {
    if ((kept ?? null) !== asked) changes.push(`${word} ${kept ?? 'none'} → ${asked ?? 'none'}`);
  };
  want('profile', deployed.profile, ask.profile);
  want('compute', deployed.compute, ask.compute);
  want('host', deployed.host, ask.host);
  want('porter', deployed.porter, ask.porter);
  const restarts: string[] = [];
  const known: boolean = deployed.image !== undefined;
  if (!known) restarts.push('CUBE and porter, perhaps (this deploy\'s record predates kept versions)');
  else if (deployed.image !== CHRIS_IMAGES.cube) restarts.push(`CUBE and its workers (${deployed.image} → ${CHRIS_IMAGES.cube})`);
  else if ((deployed.host ?? null) !== ask.host || (deployed.porter ?? null) !== ask.porter) restarts.push('CUBE and its workers (their environment changes)');
  if (known && ask.porter !== null) {
    if (deployed.porter === undefined) restarts.push('porter is put up');
    else if (deployed.porterVersion !== PORTER_VERSION) restarts.push(`porter (${deployed.porterVersion ?? '?'} → ${PORTER_VERSION}): its open sessions end`);
  }
  return { changes, restarts, sessions, asks: changes.length > 0 || restarts.length > 0 };
}

/**
 * The plan in words, for the question and for `--plan`.
 *
 * @param vm - The VM.
 * @param plan - The plan.
 * @returns One line.
 */
export function chrisPlan_words(vm: string, plan: ChrisPlan): string {
  const changes: string = plan.changes.length === 0 ? 'as deployed' : plan.changes.join(', ');
  const restarts: string = plan.restarts.length === 0 ? 'nothing restarts' : `restarts ${plan.restarts.join('; ')}`;
  const ends: string = plan.restarts.some((one: string): boolean => one.startsWith('porter (') || one.startsWith('CUBE and porter')) && plan.sessions !== null
    ? plan.sessions === 0 ? '; no porter session is open now' : `; ${plan.sessions} porter session${plan.sessions === 1 ? '' : 's'} open now ${plan.sessions === 1 ? 'ends' : 'end'}` : '';
  return `chris deploy ${vm}: ${changes}; ${restarts}${ends}`;
}
