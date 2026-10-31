/**
 * @file The manifests stratus ships: `tenant.mise`, the procedure that
 * builds a Trusted Domain from its written spec to a verified cluster
 * (docs/stratus.adoc, D14).
 *
 * They are files of the package, read once from beside `dist/`, and shown in
 * the session's home (`~/tenant.mise`, beside the clusters), so `play` finds
 * one there as a ChRIS session finds a manifest in its home.
 *
 * @module
 */
import { readFileSync } from 'node:fs';

/** One manifest the engine ships. */
export interface ShippedManifest {
  /** Its name in the session's home. */
  readonly name: string;
  /** Its text. */
  readonly text: string;
}

/** The tenant's manifest, by its name in the home. */
export const TENANT_MANIFEST: string = 'tenant.mise';

/** The manifests the package holds, by name. */
const SHIPPED: ReadonlyArray<string> = [TENANT_MANIFEST];

/**
 * Reads the shipped manifests from the package's `manifests/`; one that
 * cannot be read is left out rather than shown empty.
 *
 * @param folder - Where they are; the package's own folder when absent.
 * @returns The manifests.
 */
export function shippedManifests_read(folder: URL = new URL('../../manifests/', import.meta.url)): ShippedManifest[] {
  const read: ShippedManifest[] = [];
  for (const name of SHIPPED) {
    try {
      read.push({ name, text: readFileSync(new URL(name, folder), 'utf8') });
    } catch {
      // A package without its manifests still builds and reads clusters.
    }
  }
  return read;
}
