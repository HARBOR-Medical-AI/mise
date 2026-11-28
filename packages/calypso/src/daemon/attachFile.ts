/**
 * @file The attach note: a daemon's addresses, written where they can be read.
 *
 * A daemon prints its ARGUS link and attach command once, into a terminal it
 * then occupies with a live boot animation. Selecting text out from under a
 * repainting screen is awkward, and scrollback is lost the moment anyone
 * clears it — so the same lines are also written to a file.
 *
 * The file carries the attach token, which is a credential. It is written as the berth record is, in the same
 * owner-only folder (`berthDir_path`, held to this account through a trusted path), by a fresh `0600` file renamed
 * over the name: never written through a link, never readable by another account.
 *
 * It stays when the daemon ends, as the record does: no process can unlink a published note without racing the next
 * daemon that replaces it, so the note is the last advertisement of a daemon, not proof one is running. A client
 * probes its address as it would a record's (`berthInstance_probe`, with the record), and the next daemon writes over it.
 *
 * `calypso --berths` reads the same facts from the berth and says whether each daemon proved it is running.
 *
 * @module
 */

import { basename, dirname, join } from 'node:path';

import { ownFile_write, ownFolder_settle, type OwnHeld, type OwnRefusal } from '@fnndsc/fond';

import { berthDir_path } from './berth.js';

/**
 * The path this daemon's attach note occupies.
 *
 * Per OS user rather than per session, so it can be named in a message and
 * found again without reading one. A second daemon for a second CUBE identity
 * overwrites it; `calypso --berths` lists them all.
 *
 * @returns An absolute path in this account's berth folder.
 */
export function attachFile_path(): string {
  return join(berthDir_path(), 'attach.txt');
}

/**
 * Writes the attach note, replacing any note this user left before.
 *
 * @param lines - The addresses to record, one per line.
 * @returns The path written, or null when it could not be written safely.
 */
export function attachFile_write(lines: string[]): string | null {
  const path: string = attachFile_path();
  // A note is a convenience. Failing to write one must never stop a daemon from starting, and the addresses were
  // printed regardless.
  const held: OwnHeld | OwnRefusal = ownFolder_settle(dirname(path), true);
  if (!held.ok) return null;
  const written: OwnHeld | OwnRefusal = ownFile_write(dirname(path), basename(path), `${lines.join('\n')}\n`);
  return written.ok ? path : null;
}
