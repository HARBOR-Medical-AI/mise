/**
 * @file Where a delivered file is written on this machine, decided once.
 *
 * A delivery names a destination (the operator's word) and a suggested name (the engine's). The place is resolved
 * here, on this machine: a destination naming an existing folder receives the file under its name, placed inside it
 * or refused (`wireName_place`); any other destination is the file itself. A remote engine reserves that place
 * before it fetches the bytes, so two deliveries cannot write one file, and the writer writes that same place.
 *
 * Key components:
 * - deliveryPlace_resolve: the place, or a refusal.
 * - PlacedDelivery: a delivery carrying the place reserved for it.
 *
 * Typical usage:
 * ```ts
 * const place: string = deliveryPlace_resolve(request.destination, request.filename);
 * ```
 *
 * Dependencies: brasa's `wireName_place`.
 *
 * @module
 */

import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { wireName_place, type HostPlace } from '@fnndsc/brasa';
import type { FileDeliverRequest } from '@fnndsc/menu';

/**
 * A delivery with the place this machine reserved for it: set by this chell, never by the engine.
 *
 * @example
 * ```ts
 * const placed: PlacedDelivery = { ...request, place: '/home/me/out/scan.dcm' };
 * ```
 */
export interface PlacedDelivery extends FileDeliverRequest {
  /** The absolute path reserved for the file. */
  place?: string;
}

/**
 * Resolves where a delivered file should be written.
 *
 * A destination naming an existing directory receives the file under its
 * suggested name; anything else is taken as the filename itself. With no
 * destination the file lands in the working directory.
 *
 * The destination is the operator's own word and is taken as written. The
 * suggested name is not: it comes from the engine, which may be across a
 * wire, out of a listing a store made. It is placed inside the folder it
 * belongs in or refused (`wireName_place`): never absolute, never climbing
 * out with `..`, never through a link that leads elsewhere.
 *
 * @param destination - Where the operator asked for it, if they said.
 * @param filename - The suggested name.
 * @returns An absolute path to write.
 * @throws {Error} When the suggested name has no place inside the folder.
 *
 * @example
 * ```ts
 * deliveryPlace_resolve('./out', 'a/1.dcm'); // '/home/me/out/a/1.dcm' when ./out is a folder
 * ```
 */
export function deliveryPlace_resolve(destination: string | undefined, filename: string): string {
  const given: boolean = destination !== undefined && destination.length > 0;
  const resolved: string = given ? path.resolve(destination as string) : process.cwd();
  if (given && !(existsSync(resolved) && statSync(resolved).isDirectory())) {
    return resolved;
  }
  const placed: HostPlace = wireName_place(resolved, filename);
  if (!placed.ok) throw new Error(`refused: the name ${placed.reason}; nothing was written`);
  return placed.place;
}
