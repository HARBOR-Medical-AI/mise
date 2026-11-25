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
 * Every step acts on a file by its id, never on "whatever is at this path",
 * and only after CUBE has said the id is at the path it is taken to be at.
 * A move's reply can be lost though the move happened, so after an error
 * the store is asked where the file is before anything is undone. And one
 * rule covers every branch: nothing is moved or deleted unless both its id
 * and its place are known. When either is uncertain, the copies stay and
 * the error names their paths.
 *
 * Key components:
 * - file_write: write content to a path on proof of what holds it.
 * - file_replace: put new content at a path that holds a file.
 *
 * Typical usage:
 * ```ts
 * const written: boolean = await file_write('/home/ada/notes.txt', new Blob(['new']));
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

import { pathHolders_prove, type PathHolderRecord, type PathProof } from './proof.js';

/** Random bytes in a staging name: enough that two saves of one file do not meet. */
const STAGING_BYTES: number = 4;

/** What became of a file that was to be moved. */
type Place =
  /** Seen at the path it was to go to: the move happened. */
  | 'destination'
  /** A move was asked for, and the file is seen where it was: it did not happen. */
  | 'origin'
  /** No move was asked for: the destination is held, or could not be proved free. The file was seen where it was just before. */
  | 'blocked'
  /** Not where it was expected before the move, or neither place after it, or CUBE would not say. */
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
 * Whether CUBE says a file is at a path, asked by the file's id.
 *
 * @param fileId - The file.
 * @param expected - The path it is taken to be at.
 * @returns True only when CUBE answered and named that path.
 */
async function file_isAt(fileId: number, expected: string): Promise<boolean> {
  const where: Result<string | null> = await chrisIO.file_locate(fileId);
  return where.ok && where.value === expected;
}

/**
 * Moves a file by id onto a path proved free, and says what became of it.
 *
 * Before anything is asked of CUBE the file is located: an id is only
 * moved from the path it is taken to be at, since another writer may have
 * moved it since. Then the destination is proved absent; held, or not
 * provable, no move is asked for. A move that errors is not taken for a
 * move that did not happen: the file is located again, and so is one that
 * reported success, since "moved" is only true once the file is seen at the
 * path.
 *
 * @param fileId - The file to move.
 * @param origin - Where it is taken to be now.
 * @param destination - Where it is to go.
 * @returns What became of it; see {@link Place}.
 */
async function file_moveProved(fileId: number, origin: string, destination: string): Promise<Place> {
  if (!await file_isAt(fileId, origin)) return 'unknown';
  if (!await path_proveIsFree(destination)) {
    errorStack.stack_push('error', `${destination} is held, or could not be checked: nothing was moved onto it`);
    return 'blocked';
  }
  await chrisIO.file_moveById(fileId, destination, (): Promise<boolean> => path_proveIsFree(destination));
  const where: Result<string | null> = await chrisIO.file_locate(fileId);
  if (!where.ok) return 'unknown';
  if (where.value === destination) return 'destination';
  if (where.value === origin) return 'origin';
  return 'unknown';
}

/**
 * Removes a staged or set-aside file, once CUBE says it is where it was put.
 *
 * An id is only deleted at the path it is taken to be at. A file that
 * another writer has moved since is theirs now, and one CUBE will not
 * locate is not known to be ours to remove.
 *
 * @param fileId - The file.
 * @param where - The path it was put at.
 * @param what - What it is, in the warning's words.
 * @returns Nothing: a file that is not removed leaves a warning naming the
 *   path, and whatever error came before it stays on the stack.
 */
async function leftover_remove(fileId: number, where: string, what: string): Promise<void> {
  if (!await file_isAt(fileId, where)) {
    errorStack.stack_push('warning', `${what} was not removed: it could not be seen at ${where}, where it was put`);
    return;
  }
  const removed: Result<boolean> = await chrisIO.file_deleteById(fileId);
  if (!removed.ok) errorStack.stack_push('warning', `${what} was left at ${where}`);
}

/**
 * Stores content at a path proved to hold nothing, and makes sure it is
 * there.
 *
 * CUBE may store an upload under another name than the one asked for. Then
 * the file is moved onto the name by its id, through the same proved move
 * as any other, and the write is a success only when the file is seen
 * there.
 *
 * @param target - The absolute CUBE path, proved absent by the caller.
 * @param content - The content.
 * @returns True when the path holds the content; false otherwise, with the
 *   reason on the error stack.
 */
async function file_createProved(target: string, content: Blob): Promise<boolean> {
  const receipt: Result<UploadReceipt> = await chrisIO.file_uploadReceipted(content, path.posix.dirname(target), path.posix.basename(target));
  if (!receipt.ok) {
    errorStack.stack_push('error', `Could not write ${target}: the content could not be stored.`);
    return false;
  }
  const landed: string = receipt.value.path;
  if (landed === target) return true;
  const place: Place = await file_moveProved(receipt.value.id, landed, target);
  if (place === 'destination') return true;
  if (place === 'unknown') {
    errorStack.stack_push('error', `Could not write ${target}: the content landed at ${landed}, and it is not known whether it was then moved. Look at ${landed} and ${target}. Nothing was removed.`);
    return false;
  }
  errorStack.stack_push('error', `Could not write ${target}: the content landed at ${landed} and could not be moved onto the name.`);
  await leftover_remove(receipt.value.id, landed, 'The content');
  return false;
}

/**
 * Writes content to a path, whatever holds it now, on proof of what does.
 *
 * Nothing there: the content is stored and seen at the path. One file
 * there: its content is replaced by {@link file_replace}. Anything else (a
 * folder, a link, more than one holder, or a lookup that could not be
 * completed) and nothing is written: a listing that failed or was cut short
 * is not taken for an empty one.
 *
 * @param target - The absolute CUBE path.
 * @param content - The content.
 * @returns True when the path holds the content; false otherwise, with the
 *   reason on the error stack.
 *
 * @example
 * ```ts
 * const written: boolean = await file_write('/home/ada/notes.txt', new Blob(['draft']));
 * ```
 */
export async function file_write(target: string, content: Blob): Promise<boolean> {
  const proof: Result<PathProof> = await pathHolders_prove(target);
  if (!proof.ok) {
    errorStack.stack_push('error', `Could not write ${target}: what holds that path could not be learned. Nothing was written.`);
    return false;
  }
  if (proof.value.kind === 'absent') return await file_createProved(target, content);
  const holders: readonly PathHolderRecord[] = proof.value.holders;
  const sole: PathHolderRecord | undefined = holders.length === 1 ? holders[0] : undefined;
  if (sole === undefined || sole.kind !== 'file') {
    const kinds: string = holders.map((holder: PathHolderRecord): string => holder.kind).join(' and a ');
    errorStack.stack_push('error', `Could not write ${target}: a ${kinds} holds that path. Nothing was written.`);
    return false;
  }
  return await file_replace(target, content, sole.id);
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
  if (oldPlace === 'origin' || oldPlace === 'blocked') {
    errorStack.stack_push('error', `Could not rewrite ${target}: the file there could not be set aside. It is as it was.`);
    await leftover_remove(newId, staged, 'The new content');
    return false;
  }
  if (oldPlace === 'unknown') {
    errorStack.stack_push('error', `Could not rewrite ${target}: the file there is not where it was seen, or it is not known whether it was set aside. Look at ${target} and ${aside} for the old content; the new content is at ${staged}. Nothing was removed.`);
    return false;
  }

  // 3. The new file, onto the name.
  const newPlace: Place = await file_moveProved(newId, staged, target);
  if (newPlace === 'unknown') {
    errorStack.stack_push('error', `Could not rewrite ${target}: it is not known whether the new content reached it. The old content is at ${aside}; look at ${target} and ${staged} for the new. Nothing was removed.`);
    return false;
  }
  if (newPlace === 'blocked') {
    // Something holds the name now, or CUBE would not say. Whatever it is,
    // it is not ours to move onto, in either direction: both copies stay.
    errorStack.stack_push('error', `Could not rewrite ${target}: once the file there was set aside, the name was held or could not be checked. The old content is at ${aside} and the new at ${staged}. Nothing was removed.`);
    return false;
  }
  if (newPlace === 'origin') {
    // A move was asked for and did not happen. The way back: the old file
    // returns to its name, by the same proved move.
    const restored: Place = await file_moveProved(oldId, aside, target);
    if (restored !== 'destination') {
      errorStack.stack_push('error', `Could not rewrite ${target}, and the old content could not be put back: look for it at ${aside}, or at ${target} if the move back happened unseen. The new content is at ${staged}. Nothing was removed.`);
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
