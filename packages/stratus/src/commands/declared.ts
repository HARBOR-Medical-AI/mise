/**
 * @file What stratus's command declarations share: the argument kinds its
 * commands name (a cluster, a VM, a network, a ChRIS profile), registered
 * through the backend seam, and the bag of `--flag value` pairs the spec
 * readers take, made from a parsed line's options.
 *
 * Key components:
 * - stratusKinds_make: the kinds, completing from what the session keeps.
 * - flags_map: a parsed line's options as the spec readers read them.
 *
 * @module
 */
import { namedKind_make, type ArgumentKind } from '@fnndsc/brasa/core';

/** Where the kinds read the names they complete. */
export interface StratusKindSources {
  /** The clusters the session knows. */
  readonly clusters: () => ReadonlyArray<string>;
  /** The VMs declared here. */
  readonly vms: () => ReadonlyArray<string>;
  /** The networks declared here. */
  readonly nets: () => ReadonlyArray<string>;
  /** The ChRIS profiles a deploy takes. */
  readonly profiles: () => ReadonlyArray<string>;
}

/**
 * The kinds stratus's commands name, beside the core's: each takes any word
 * (the command says when it names nothing kept) and completes what the
 * session keeps now.
 *
 * @param sources - Where the names are read.
 * @returns The kinds, for `Backend.argumentKinds`.
 *
 * @example
 * ```ts
 * const backend: Backend = { …, argumentKinds: stratusKinds_make({ clusters: () => store.names_list(), … }) };
 * ```
 */
export function stratusKinds_make(sources: StratusKindSources): ReadonlyArray<ArgumentKind> {
  return [
    namedKind_make('cluster', 'a cluster: one built here, read from a checkout, or found in the tenancy', sources.clusters),
    namedKind_make('vm', 'a VM declared here, or one the tenancy runs', sources.vms),
    namedKind_make('network', 'a network declared here', sources.nets),
    namedKind_make('chrisProfile', 'a ChRIS profile a deploy puts on a VM', sources.profiles),
  ];
}

/**
 * A parsed line's options as the spec readers take them: each one given, by
 * its `--flag`, its value as text; a switch or an option not given is left out.
 *
 * @param options - The parsed options, by property.
 * @param flags - Each property's flag (`baseDomain` → `--base-domain`).
 * @returns The pairs, in the order the flags are named.
 *
 * @example
 * ```ts
 * flags_map({ family: 'E5', baseDomain: undefined }, { family: '--family', baseDomain: '--base-domain' }); // Map { '--family' => 'E5' }
 * ```
 */
export function flags_map(options: Readonly<Record<string, unknown>>, flags: Readonly<Record<string, string>>): Map<string, string> {
  const pairs: Map<string, string> = new Map();
  for (const [key, flag] of Object.entries(flags)) {
    const value: unknown = options[key];
    if (typeof value === 'string' || typeof value === 'number') pairs.set(flag, String(value));
  }
  return pairs;
}
