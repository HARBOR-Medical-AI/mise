/**
 * @file The stratus composition's words in the ARGUS language: `cluster`
 * opens the TD controller (docs/stratus.adoc, D13).
 *
 * `cluster` is the session's command too. The surface claims only bare
 * `cluster` and `cluster <name>` for a cluster the session has, the lines the
 * controller opens on; every other `cluster` line (`cluster status`, `cluster
 * plan quay`, `cluster build quay`) reaches the session as it always did, and
 * in chell the same lines play as text.
 *
 * @module
 */
import type { ArgusHost, LanguageExtension } from '../../console/argusLang.js';

/** The stratus verbs the surface's host answers, beside the frame's. */
export interface StratusHostVerbs {
  /** Opens the TD controller on a cluster (`''` for the first); answers what happened. */
  controller_open(name: string): Promise<string>;
}

/** The host the stratus words reach. */
export type StratusLangHost = ArgusHost & StratusHostVerbs;

/**
 * The words of `cluster` the surface claims: bare, and each cluster's name as
 * the session's reads find them. Held by reference in the language's claims,
 * so a name added here is claimed at once.
 */
export const CLUSTER_CLAIMS: Set<string> = new Set<string>(['']);

/**
 * Claims the clusters' names, so `cluster <name>` opens the controller on one.
 *
 * @param names - The clusters the session has.
 * @returns True when the claims changed (the daemon is told them again).
 */
export function clusterClaims_set(names: ReadonlyArray<string>): boolean {
  const next: Set<string> = new Set<string>(['', ...names]);
  if (next.size === CLUSTER_CLAIMS.size && [...next].every((name: string): boolean => CLUSTER_CLAIMS.has(name))) return false;
  CLUSTER_CLAIMS.clear();
  for (const name of next) CLUSTER_CLAIMS.add(name);
  return true;
}

/**
 * The stratus composition's extension of the language.
 *
 * @param host - The surface, read when a sentence runs.
 * @returns The extension.
 */
export function stratusLanguage(host: () => StratusLangHost): LanguageExtension {
  return {
    subjects: { cluster: CLUSTER_CLAIMS },
    views: {},
    claims: {},
    listings: {},
    chords: [],
    lines: [{ after: 'view', line: 'cluster [<name>]             (the TD controller takes the screen; every other cluster line is the session\'s)' }],
    run: (_argus: ArgusHost, sentence: { subject: string; words: string[] }): Promise<string> | undefined => {
      if (sentence.subject !== 'cluster') return undefined;
      return host().controller_open(sentence.words[0] ?? '');
    },
  };
}
