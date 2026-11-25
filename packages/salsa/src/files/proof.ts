/**
 * @file Proof of what holds a CUBE path, and of a folder's emptiness.
 *
 * A listing made for showing keeps the rows it has when part of it fails, and
 * the lookups a writer uses to avoid a collision treat a parent that would
 * not list as holding nothing. Both are right for their purpose and neither
 * is proof. An act that destroys or overwrites (removing a folder taken to be
 * empty, uploading over a place taken to be free, swapping a file into a
 * name) needs proof, and this module is where proof is defined, once.
 *
 * Key components:
 * - PathHolderRecord: one entry holding a path, with its CUBE id.
 * - PathProof: what a strict lookup proved, `held` or `absent`.
 * - pathHolders_prove: prove what holds a path, or that nothing does.
 * - folderEmptiness_prove: prove whether a folder holds nothing.
 *
 * Typical usage:
 * ```ts
 * const proof: Result<PathProof> = await pathHolders_prove('/home/ada/uploads/scan');
 * if (!proof.ok) return refuse();                 // could not be proved
 * if (proof.value.kind === 'absent') create();    // nothing is there
 * ```
 *
 * Dependencies: `files_listOutcome` of `./index.js` for the three listings a
 * folder has (dirs, files, links), and cumin's error stack, where the reason
 * a proof failed is left. Paths are absolute CUBE paths.
 *
 * @module
 */

import * as path from 'path';

import { errorStack, Ok, Err, type Result } from '@fnndsc/cumin';

import { files_listOutcome, type ListingOutcome, type PathHolder } from './index.js';

/**
 * One thing holding a path, with the id CUBE knows it by.
 *
 * @example
 * ```ts
 * const holder: PathHolderRecord = { kind: 'dir', id: 7 };
 * ```
 */
export interface PathHolderRecord {
  /** What kind of entry holds the path. */
  readonly kind: PathHolder;
  /** Its id in CUBE; 0 for the root, which has none. */
  readonly id: number;
}

/**
 * What a strict lookup of a path proved: that these entries hold it, or that
 * nothing does.
 *
 * @example
 * ```ts
 * const proof: PathProof = { kind: 'absent' };
 * ```
 */
export type PathProof =
  /** These entries hold the path, and no part of the lookup went unread. */
  | { readonly kind: 'held'; readonly holders: readonly PathHolderRecord[] }
  /** Nothing holds the path, and every listing that says so answered in full. */
  | { readonly kind: 'absent' };

/** The three listings a folder has, each with the kind of holder it yields. */
const HOLDER_KINDS: ReadonlyArray<readonly ['dirs' | 'files' | 'links', PathHolder]> = [['dirs', 'dir'], ['files', 'file'], ['links', 'link']];

/** The bound each listing is asked with; one cut short at it is not proof. */
const LISTING_BOUND: number = 1000;

/**
 * Proves what holds a path, or that nothing does.
 *
 * A refused listing of the parent, or one cut short, is a failure. A listing
 * that could not be made at all proves absence only when the parent is
 * itself proved absent, one level up, and so on to the root: a parent that
 * is there and will not list has proved nothing, and neither has one that a
 * file or a link holds.
 *
 * @param target - The absolute CUBE path.
 * @returns What holds it, or that nothing does; Err when neither could be
 *   proved, with the reason on the error stack.
 *
 * @example
 * ```ts
 * const proof: Result<PathProof> = await pathHolders_prove('/home/ada/uploads/scan');
 * const free: boolean = proof.ok && proof.value.kind === 'absent';
 * ```
 */
export async function pathHolders_prove(target: string): Promise<Result<PathProof>> {
  const clean: string = target.length > 1 && target.endsWith('/') ? target.slice(0, -1) : target;
  if (clean === '/' || clean === '') return Ok({ kind: 'held', holders: [{ kind: 'dir', id: 0 }] });
  const parent: string = path.posix.dirname(clean);
  const name: string = path.posix.basename(clean);
  const holders: PathHolderRecord[] = [];
  let unmade: boolean = false;
  for (const [asset, kind] of HOLDER_KINDS) {
    const mark: number = errorStack.checkpoint_mark();
    const outcome: ListingOutcome = await files_listOutcome({ limit: LISTING_BOUND, offset: 0 }, asset, parent);
    if (outcome.kind === 'refused') {
      errorStack.stack_push('error', `Cannot check ${clean}: ${outcome.error.message}`);
      return Err();
    }
    if (outcome.kind === 'missing') {
      // What the lookup said on the way is settled one level up, below.
      errorStack.checkpoint_drain(mark);
      unmade = true;
      continue;
    }
    if (outcome.kind !== 'listing') continue;
    if (outcome.data.incomplete !== undefined) {
      errorStack.stack_push('error', `Cannot check ${clean}: the ${asset} of ${parent} were not all read (${outcome.data.incomplete.reason})`);
      return Err();
    }
    for (const row of outcome.data.tableData ?? []) {
      // A folder row names itself by `path`; a file or link row by `fname`
      // (a link's ends in `.chrislink`, and its `path` is where it points).
      const raw: string = String((kind === 'dir' ? row.path : row.fname) ?? '');
      const entry: string = path.posix.basename(raw).replace(/\.chrislink$/, '');
      if (entry === name && row.id !== undefined) holders.push({ kind, id: Number(row.id) });
    }
  }
  if (!unmade) return Ok(holders.length > 0 ? { kind: 'held', holders } : { kind: 'absent' });
  const above: Result<PathProof> = await pathHolders_prove(parent);
  if (!above.ok) return Err();
  if (above.value.kind === 'absent' && holders.length === 0) return Ok({ kind: 'absent' });
  errorStack.stack_push('error', `Cannot check ${clean}: ${parent} is there and could not be listed`);
  return Err();
}

/**
 * Proves whether a folder holds nothing.
 *
 * Every one of the folder's three listings must answer, in full: a listing
 * refused, one that could not be made, or one cut short leaves the question
 * open, and an open question is not "empty".
 *
 * @param target - The absolute CUBE path of a folder that is there.
 * @returns True when all three listings answered in full and hold nothing,
 *   false when any holds a row; Err when the question stays open, with the
 *   reason on the error stack.
 *
 * @example
 * ```ts
 * const empty: Result<boolean> = await folderEmptiness_prove('/home/ada/uploads/old');
 * const removable: boolean = empty.ok && empty.value;
 * ```
 */
export async function folderEmptiness_prove(target: string): Promise<Result<boolean>> {
  let rows: number = 0;
  for (const [asset] of HOLDER_KINDS) {
    const outcome: ListingOutcome = await files_listOutcome({ limit: LISTING_BOUND, offset: 0 }, asset, target);
    if (outcome.kind === 'refused') {
      errorStack.stack_push('error', `Cannot tell whether ${target} is empty: its ${asset} could not be read (${outcome.error.message})`);
      return Err();
    }
    if (outcome.kind === 'missing') {
      errorStack.stack_push('error', `Cannot tell whether ${target} is empty: its ${asset} could not be listed`);
      return Err();
    }
    if (outcome.kind !== 'listing') continue;
    if (outcome.data.incomplete !== undefined) {
      errorStack.stack_push('error', `Cannot tell whether ${target} is empty: its ${asset} were not all read (${outcome.data.incomplete.reason})`);
      return Err();
    }
    rows += (outcome.data.tableData ?? []).length;
  }
  return Ok(rows === 0);
}
