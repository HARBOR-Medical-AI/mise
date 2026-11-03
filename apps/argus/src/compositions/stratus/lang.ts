/**
 * @file The stratus composition's words in the ARGUS language: `cluster`
 * opens the TD controller (docs/stratus.adoc, D13), `scripts` the script
 * screen (D17).
 *
 * Both are the session's commands too. The surface claims only bare
 * `cluster` and `cluster <name>` for a cluster the session has, the lines the
 * controller opens on, and bare `scripts` and `scripts open <path>`, the
 * lines the script screen opens on; every other line of either (`cluster
 * status`, `cluster build quay`, `scripts add`, `scripts pull`) reaches the
 * session as it always did, and in chell the same lines play as text.
 *
 * @module
 */
import type { ArgusHost, LanguageExtension } from '../../console/argusLang.js';

/** The stratus verbs the surface's host answers, beside the frame's. */
export interface StratusHostVerbs {
  /** Opens the TD controller on a cluster (`''` for the first); answers what happened. */
  controller_open(name: string): Promise<string>;
  /** Opens the script screen on the library (`''`) or a script; answers what happened. */
  script_open(path: string): Promise<string>;
  /** Opens the VM controller on a machine (`''` for a new one); answers what happened. */
  vm_open(name: string): Promise<string>;
}

/**
 * The words of `scripts` the surface claims: bare (the library takes the
 * screen) and `open <path>` (a script does); `add`, `pull` and `remove` stay
 * the session's (docs/stratus.adoc, D17).
 */
export const SCRIPTS_CLAIMS: ReadonlySet<string> = new Set<string>(['', 'open']);

/** The host the stratus words reach. */
export type StratusLangHost = ArgusHost & StratusHostVerbs;

/**
 * The words of `cluster` the surface claims: bare, and each cluster's name as
 * the session's reads find them. Held by reference in the language's claims,
 * so a name added here is claimed at once.
 */
export const CLUSTER_CLAIMS: Set<string> = new Set<string>(['']);

/**
 * The words of `vm` the surface claims: bare, and each machine's name as the
 * session's reads find them; `vm status`, `new`, `build` and the rest stay
 * the session's (docs/stratus.adoc, D17 revised).
 */
export const VM_CLAIMS: Set<string> = new Set<string>(['']);

/**
 * Claims the machines' names, so `vm <name>` opens the VM controller on one.
 *
 * @param names - The VMs the session has.
 * @returns True when the claims changed (the daemon is told them again).
 */
export function vmClaims_set(names: ReadonlyArray<string>): boolean {
  const next: Set<string> = new Set<string>(['', ...names]);
  if (next.size === VM_CLAIMS.size && [...next].every((name: string): boolean => VM_CLAIMS.has(name))) return false;
  VM_CLAIMS.clear();
  for (const name of next) VM_CLAIMS.add(name);
  return true;
}

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
    subjects: { cluster: CLUSTER_CLAIMS, scripts: SCRIPTS_CLAIMS, vm: VM_CLAIMS },
    views: {},
    claims: {},
    listings: {},
    chords: [],
    lines: [
      { after: 'view', line: 'cluster [<name>]             (the TD controller takes the screen; every other cluster line is the session\'s)' },
      { after: 'view', line: 'scripts [open <path>]        (the script screen takes the screen: the library, or one script; add, pull and remove are the session\'s)' },
      { after: 'view', line: 'vm [<name>]                  (the VM controller takes the screen: a machine, or a new one; status, new, build and the rest are the session\'s)' },
    ],
    run: (_argus: ArgusHost, sentence: { subject: string; words: string[] }): Promise<string> | undefined => {
      if (sentence.subject === 'cluster') return host().controller_open(sentence.words[0] ?? '');
      if (sentence.subject === 'vm') return host().vm_open(sentence.words[0] ?? '');
      if (sentence.subject === 'scripts') {
        if (sentence.words[0] === 'open') return host().script_open(sentence.words[1] ?? '');
        return host().script_open('');
      }
      return undefined;
    },
  };
}
