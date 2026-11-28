/**
 * @file The attach note: which daemon this account last started, and where to find how to reach it.
 *
 * A daemon prints its ARGUS link and attach command once, into a terminal it then occupies with a live boot
 * animation; scrollback is lost the moment anyone clears it. The note says, in a file, which daemon that was and
 * that `calypso --berths` reprints its address and token while it proves it is running.
 *
 * The note is written as the berth record is, in the same owner-only folder (`berthDir_path`, held to this account
 * through a trusted path), by a fresh `0600` file renamed over the name: never written through a link.
 *
 * It stays when the daemon ends, as the record does: no process can unlink a published note without racing the next
 * daemon that replaces it. So it carries no credential (no token, no tokened link, no attach command): who the
 * daemon was, when, and where to ask what is running now.
 *
 * `calypso --berths` reads the address and token from the berth, for each daemon that proves it is running.
 *
 * @module
 */

import { basename, dirname, join } from 'node:path';

import { ownFile_write, ownFolder_settle, type OwnFolder, type OwnHeld, type OwnRefusal } from '@fnndsc/fond';

import { berthDir_path, spelled_join } from './berth.js';

/**
 * What the attach note says: who the daemon was, when it was written, and where to ask for what is running now. It
 * outlives the daemon, so it carries no token, no tokened link and no attach command: `calypso --berths` gives
 * those for a daemon that proves it is running.
 *
 * @param identity - The daemon's identity.
 * @param booted - When it booted, ISO.
 * @returns The note's lines.
 *
 * @example
 * ```ts
 * attachFile_write(attachNote_lines(identity, booted));
 * ```
 */
export function attachNote_lines(identity: string, booted: string): string[] {
  return [
    `# Written by the daemon at ${booted}; left when it ends.`,
    `identity:  ${identity}`,
    'attach:    calypso --berths   (on this machine: the address and token of each daemon that proves it is running)',
  ];
}

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
  return spelled_join(berthDir_path(), 'attach.txt');
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
  const held: OwnFolder | OwnRefusal = ownFolder_settle(dirname(path), true);
  if (!held.ok) return null;
  const written: OwnHeld | OwnRefusal = ownFile_write(held.path, basename(path), `${lines.join('\n')}\n`);
  return written.ok ? join(held.path, basename(path)) : null;
}
