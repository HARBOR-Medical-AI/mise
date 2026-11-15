/**
 * @file Resolve an absolute ChRIS file path to its numeric file id.
 *
 * CUBE reads a file by id, and the id comes from listing the file's folder.
 * One file read lists its folder once; a transfer of a whole folder would
 * list that folder again for every file in it (223 files, 223 listings of
 * 223 rows). A transfer runs inside {@link fileIds_memoRun}, where each
 * folder is listed once and every file in it, in flight together or one
 * after another, takes its id from that listing. Outside a transfer nothing
 * is kept, so a read after an edit always lists afresh.
 *
 * Key components:
 * - pathFileId_resolve: a file path's id.
 * - fileIds_memoRun: runs work in which each folder's ids are listed once.
 *
 * Typical usage:
 * ```ts
 * await fileIds_memoRun(async () => {
 *   for (const path of paths) await pathFileId_resolve(path);
 * });
 * ```
 *
 * Dependencies: cumin's file browser groups.
 *
 * @module
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'path';
import {
  ChRISEmbeddedResourceGroup,
  ChrisPathNode,
  FilteredResourceData,
  Result,
  Ok,
  Err,
  errorStack,
} from '@fnndsc/cumin';
import { files_getGroup } from './index.js';

/** Minimal shape of a file row needed to resolve an id. */
interface FileRow {
  id?: number;
  fname?: string;
}

/** A folder's files by basename, or why the folder could not be listed. */
type FolderIds = { readonly ids: Map<string, number | null> } | { readonly refused: string };

/** The folders a transfer has listed, by folder path; a listing in flight is shared. */
type FolderIdsMemo = Map<string, Promise<FolderIds>>;

/** The memo of the transfer running on this async path, when one is. */
const memoScope: AsyncLocalStorage<FolderIdsMemo> = new AsyncLocalStorage<FolderIdsMemo>();

/**
 * Runs work in which each folder's file ids are listed once: a transfer of
 * many files. A scope inside a scope shares the outer one.
 *
 * @param operation - The work.
 * @returns What the work returns.
 *
 * @example
 * ```ts
 * const ids: number[] = await fileIds_memoRun(async () => resolveAll(paths));
 * ```
 */
export async function fileIds_memoRun<T>(operation: () => Promise<T>): Promise<T> {
  if (memoScope.getStore() !== undefined) return operation();
  return memoScope.run(new Map(), operation);
}

/**
 * Lists one folder's files by basename.
 *
 * @param dir - The folder.
 * @returns The ids by basename (null for a row with no id), or why it could not be listed.
 */
async function folderIds_list(dir: string): Promise<FolderIds> {
  const group: ChRISEmbeddedResourceGroup<ChrisPathNode> | null = await files_getGroup('files', dir);
  if (!group) return { refused: '' };
  const results: FilteredResourceData | null = await group.asset.resources_getAll();
  if (!results || !results.tableData) return { refused: `No files found in directory: ${dir}` };
  const ids: Map<string, number | null> = new Map();
  for (const row of results.tableData as FileRow[]) {
    const basename: string = path.posix.basename(row.fname || '');
    const name: string = basename.startsWith('? ') ? basename.slice(2) : basename;
    if (!ids.has(name)) ids.set(name, typeof row.id === 'number' ? row.id : null);
  }
  return { ids };
}

/**
 * One folder's ids: from the transfer's memo when one runs, else listed now.
 * A folder that could not be listed is not kept, so a retry lists again.
 *
 * @param dir - The folder.
 * @returns Its ids, or why it could not be listed.
 */
async function folderIds_get(dir: string): Promise<FolderIds> {
  const memo: FolderIdsMemo | undefined = memoScope.getStore();
  if (memo === undefined) return folderIds_list(dir);
  const kept: Promise<FolderIds> | undefined = memo.get(dir);
  if (kept !== undefined) return kept;
  const listing: Promise<FolderIds> = folderIds_list(dir);
  memo.set(dir, listing);
  const answer: FolderIds = await listing;
  if ('refused' in answer) memo.delete(dir);
  return answer;
}

/**
 * Resolves an absolute ChRIS file path to its numeric file id.
 *
 * Lists the parent directory and matches on basename, tolerating the `? <name>`
 * placeholder form the API sometimes returns. Inside {@link fileIds_memoRun}
 * the listing is the transfer's, made once per folder.
 *
 * @param filePath - Absolute ChRIS file path.
 * @returns Ok(fileId), or Err (with a message pushed to errorStack) on failure.
 */
export async function pathFileId_resolve(filePath: string): Promise<Result<number>> {
  const dir: string = path.posix.dirname(filePath);
  const name: string = path.posix.basename(filePath);

  const folder: FolderIds = await folderIds_get(dir);
  if ('refused' in folder) {
    if (folder.refused !== '') errorStack.stack_push('error', folder.refused);
    return Err();
  }

  if (!folder.ids.has(name)) {
    errorStack.stack_push('error', `File not found: ${name} in ${dir}`);
    return Err();
  }

  const id: number | null | undefined = folder.ids.get(name);
  if (typeof id !== 'number') {
    errorStack.stack_push('error', `File has no valid ID: ${name}`);
    return Err();
  }

  return Ok(id);
}
