/**
 * @file Replacing a file's content without losing the old content on the way.
 *
 * CUBE's upload does not replace: uploaded over a held path, the bytes land
 * under another name, or the old content stays. So a rewrite used to remove
 * the old file and then create the new one, two requests, and a failure of
 * the second left nothing at the name. Here the old content stays
 * recoverable until the new content is verified at the name:
 *
 * 1. The new content is uploaded beside the old, under a staging name.
 * 2. The old file is moved aside, not deleted.
 * 3. The new file is moved onto the name.
 * 4. The old file is deleted.
 *
 * Every step acts on a file by its id, never on "whatever is at this path".
 * A move's reply can be lost though the move happened, so after an error
 * the store is asked where the file is before anything is undone. And one
 * rule covers every branch: nothing is deleted unless both its id and its
 * place are known. When either is uncertain, the copies stay and the error
 * names their paths.
 *
 * Key components:
 * - file_replace: put new content at a path that holds a file.
 *
 * Typical usage:
 * ```ts
 * const replaced: boolean = await file_replace('/home/ada/notes.txt', new Blob(['new']), 41);
 * ```
 *
 * Dependencies: cumin's `chrisIO` (an upload that answers what was stored, a
 * move and a delete by id, a lookup of a file's place by id) and the strict
 * lookup of `./proof.js`. CUBE has no move that refuses a held destination,
 * so the check and the move are two requests and a file can arrive between
 * them (docs/CUBE-gaps.adoc). Paths are absolute CUBE paths.
 *
 * @module
 */

import { randomBytes } from 'crypto';
import * as path from 'path';

import { chrisIO, errorStack, type Result, type UploadReceipt } from '@fnndsc/cumin';

import { pathHolders_prove, type PathProof } from './proof.js';

/** Random bytes in a staging name: enough that two saves of one file do not meet. */
const STAGING_BYTES: number = 4;

/** Where a file was found after a move that may or may not have happened. */
type Place =
  /** At the path it was being moved from: the move did not happen. */
  | 'origin'
  /** At the path it was being moved to: the move happened. */
  | 'destination'
  /** Somewhere else, gone, or CUBE would not say. */
  | 'unknown';

/**
 * Whether a path is proved to hold nothing.
 *
 * @param target - The absolute CUBE path.
 * @returns True only on proof of absence; false when something holds it or
 *   the proof failed (its reason is then on the error stack).
 */
async function path_proveIsFree(target: string): Promise<boolean> {
  const proof: Result<PathProof> = await pathHolders_prove(target);
  return proof.ok && proof.value.kind === 'absent';
}

/**
 * Moves a file by id onto a path proved free, and says where the file is
 * afterwards.
 *
 * The destination is proved absent first; held, or not provable, no move is
 * asked for. A move that errors is not taken for a move that did not
 * happen: the file is located by its id, and so is one that reported
 * success, since "moved" is only true once the file is seen at the path.
 *
 * @param fileId - The file to move.
 * @param origin - Where it is now.
 * @param destination - Where it is to go.
 * @returns `destination` when the file is seen there, `origin` when it is
 *   seen where it was (no move was asked for, or it did not happen), and
 *   `unknown` when it is neither or CUBE would not say.
 */
async function file_moveProved(fileId: number, origin: string, destination: string): Promise<Place> {
  if (!await path_proveIsFree(destination)) {
    errorStack.stack_push('error', `${destination} is held, or could not be checked: nothing was moved onto it`);
    return 'origin';
  }
  await chrisIO.file_moveById(fileId, destination);
  const where: Result<string | null> = await chrisIO.file_locate(fileId);
  if (!where.ok) return 'unknown';
  if (where.value === destination) return 'destination';
  if (where.value === origin) return 'origin';
  return 'unknown';
}

/**
 * Removes a staged or set-aside file whose id and place are both known.
 *
 * @param fileId - The file.
 * @param where - Its path, for the warning if the removal fails.
 * @param what - What it is, in the warning's words.
 * @returns Nothing: a removal that fails leaves a warning naming the path,
 *   and whatever error came before it stays on the stack.
 */
async function leftover_remove(fileId: number, where: string, what: string): Promise<void> {
  const removed: Result<boolean> = await chrisIO.file_deleteById(fileId);
  if (!removed.ok) errorStack.stack_push('warning', `${what} was left at ${where}`);
}

/**
 * Puts new content at a path that holds a file, keeping the old content
 * recoverable until the new is verified in place.
 *
 * @param target - The absolute CUBE path of the file to rewrite.
 * @param content - The new content.
 * @param oldId - The id of the file now at the path.
 * @returns True when the path holds the new content. False otherwise, with
 *   the reason on the error stack; the old content is then still at the
 *   path, or, where that could not be restored or made sure of, at a path
 *   the error names.
 *
 * @example
 * ```ts
 * const replaced: boolean = await file_replace('/home/ada/notes.txt', new Blob(['second draft']), 41);
 * ```
 */
export async function file_replace(target: string, content: Blob, oldId: number): Promise<boolean> {
  const dir: string = path.posix.dirname(target);
  const name: string = path.posix.basename(target);
  const mark: string = randomBytes(STAGING_BYTES).toString('hex');
  const staged: string = path.posix.join(dir, `.${name}.mise-new-${mark}`);
  const aside: string = path.posix.join(dir, `.${name}.mise-old-${mark}`);

  // 1. The new content, beside the old. Nothing has changed if this fails.
  const receipt: Result<UploadReceipt> = await chrisIO.file_uploadReceipted(content, dir, path.posix.basename(staged));
  if (!receipt.ok) {
    errorStack.stack_push('error', `Could not rewrite ${target}: the new content could not be stored. The file is as it was.`);
    return false;
  }
  const newId: number = receipt.value.id;
  if (receipt.value.path !== staged) {
    // It landed under another name: the staging name was taken. What is at
    // the staging name is somebody else's and is left alone.
    errorStack.stack_push('error', `Could not rewrite ${target}: the new content landed at ${receipt.value.path}, not at ${staged}. The file is as it was.`);
    await leftover_remove(newId, receipt.value.path, 'The new content');
    return false;
  }

  // 2. The old file, aside. Not deleted: it is the way back.
  const oldPlace: Place = await file_moveProved(oldId, target, aside);
  if (oldPlace === 'origin') {
    errorStack.stack_push('error', `Could not rewrite ${target}: the file there could not be set aside. It is as it was.`);
    await leftover_remove(newId, staged, 'The new content');
    return false;
  }
  if (oldPlace === 'unknown') {
    errorStack.stack_push('error', `Could not rewrite ${target}: it is not known whether the file there was set aside. Look at ${target} and ${aside} for the old content; the new content is at ${staged}. Nothing was removed.`);
    return false;
  }

  // 3. The new file, onto the name.
  const newPlace: Place = await file_moveProved(newId, staged, target);
  if (newPlace === 'unknown') {
    errorStack.stack_push('error', `Could not rewrite ${target}: it is not known whether the new content reached it. The old content is at ${aside}; look at ${target} and ${staged} for the new. Nothing was removed.`);
    return false;
  }
  if (newPlace === 'origin') {
    // The way back: the old file returns to its name, by the same proved move.
    const restored: Place = await file_moveProved(oldId, aside, target);
    if (restored !== 'destination') {
      errorStack.stack_push('error', `Could not rewrite ${target}, and the old content could not be put back: it is at ${aside}. The new content is at ${staged}. Nothing was removed.`);
      return false;
    }
    errorStack.stack_push('error', `Could not rewrite ${target}: the new content could not be moved onto it. The file is as it was.`);
    await leftover_remove(newId, staged, 'The new content');
    return false;
  }

  // 4. The new content is seen at the name, under its own id: the old goes.
  await leftover_remove(oldId, aside, `${target} was rewritten; the old content`);
  return true;
}
