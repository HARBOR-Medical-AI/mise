/**
 * @file Native ChRIS VFS Provider.
 *
 * Implements filesystem operations mapping directly to CUBE storage.
 *
 * @module
 */

import { vfsOutcome_convertFromBoolean, vfs_ok, vfs_fail, vfs_failFromStack, type VfsOutcome, type VfsErrno } from '@fnndsc/fond';
import { Result, Ok, Err, errorStack, listCache_get, chrisConnection } from "@fnndsc/cumin";
import { VFSProvider, VFSItem, CpOptions } from "../provider.js";
import { vfsItems_sort } from "../sort.js";
import {
  files_copy,
  files_copyRecursively,
  files_listAll,
  files_listOutcome,
  fileContent_get,
  fileContent_getBinary,
  files_touch,
  files_mkdir,
  folderPath_holder,
  type FolderPathHolder,
  files_delete,
  files_move,
  type ListingOutcome,
} from "../../files/index.js";
import { folderEmptiness_prove, pathHolders_prove, type PathProof } from "../../files/proof.js";
import path from "path";

/** How long `rm -r` waits for CUBE to finish removing a folder it accepted the removal of. */
const FOLDER_GONE_WAIT_MS: number = 15_000;

/** How often it asks. */
const FOLDER_GONE_POLL_MS: number = 400;

/**
 * Shape of raw file browser items returned by the ChRIS API.
 */
interface ChrisFileOrDirRaw {
  id?: number | string;
  path?: string;
  fname?: string;
  fsize?: number;
  owner_username?: string;
  creation_date?: string;
}

/**
 * One CUBE files/dirs/links row as a listing item: its name (the last path
 * segment, a link's `.chrislink` dropped) and, for a link, where it points.
 *
 * @param raw - The row.
 * @param type - What kind of row it is.
 * @returns The item.
 */
export function chrisRow_convertToItem(raw: ChrisFileOrDirRaw, type: "dir" | "file" | "link" | "vfs"): VFSItem {
  let name: string = raw.fname || raw.path || "";
  if (name.includes("/")) {
    name = name.split("/").pop() || name;
  }
  if (type === "link" && name.endsWith(".chrislink")) {
    name = name.slice(0, -10);
  }
  const targetPath: string | undefined = raw.path
    ? raw.path.startsWith("/")
      ? raw.path
      : "/" + raw.path
    : undefined;
  return {
    name,
    type,
    size: raw.fsize || 0,
    owner: raw.owner_username || "unknown",
    date: raw.creation_date || "",
    target: targetPath,
  };
}

/**
 * Native ChRIS filesystem provider operating on absolute CUBE folders.
 */
export class NativeVfsProvider implements VFSProvider {
  /** Prefix matches everything. */
  prefix = "";

  /**
   * Lists native ChRIS folder contents (dirs, files, links).
   *
   * @param pathStr - Absolute directory path.
   * @param options - Sorting parameters.
   */
  async list(
    pathStr: string,
    options?: { sort?: "name" | "size" | "date" | "owner"; reverse?: boolean }
  ): Promise<Result<VFSItem[]>> {
    try {
      const fetchOpts = { limit: 1000, offset: 0 };
      const resolvedPath: string = pathStr || "/";

      // Parallelize files/dirs/links API requests. The typed outcome tells a
      // refusal from an empty folder, which is the whole point: they read
      // the same on screen and only one of them is true (#462).
      const outcomes: ListingOutcome[] = await Promise.all([
        files_listOutcome(fetchOpts, "dirs", resolvedPath),
        files_listOutcome(fetchOpts, "files", resolvedPath),
        files_listOutcome(fetchOpts, "links", resolvedPath),
      ]);
      const results = outcomes.map((outcome: ListingOutcome) =>
        outcome.kind === "refused"
          ? { status: "rejected" as const, reason: outcome.error }
          : { status: "fulfilled" as const, value: outcome.kind === "listing" ? outcome.data : null },
      );

      const [dirsResult, filesResult, linksResult] = results;

      // A sub-listing that FAILED is not a sub-listing that was empty. The
      // folders of a home root list while its files 500, and rendering the
      // folders alone as the answer is the listing lying about the store
      // (#462). What could not be read is named, and the caller decides
      // what to do with a partial answer — it is never silently whole.
      const unread: string[] = [];
      const kinds: string[] = ['directories', 'files', 'links'];
      results.forEach((settled, index: number): void => {
        const kind: string = kinds[index] ?? 'entries';
        if (settled.status === 'rejected') {
          const reason: unknown = settled.reason;
          const message: string = reason instanceof Error ? reason.message : String(reason);
          unread.push(`${kind} (${message})`);
          return;
        }
        const short = settled.value?.incomplete;
        if (short !== undefined) unread.push(`${kind} (${short.reason})`);
      });
      if (unread.length > 0) {
        errorStack.stack_push(
          'error',
          `Cannot fully list ${resolvedPath}: could not read ${unread.join(', ')}`,
        );
      }

      // files_listAll returns null both for a failed folder resolution and for
      // an existing folder whose collection is simply empty. When every
      // sub-listing comes back empty-or-failed the two cases are
      // indistinguishable here, so probe the parent listing: a missing folder
      // must surface as an error, not render as an empty directory.
      // Nothing came back from any of the three, and none of them refused:
      // either the folder is empty or it is not there, and only the parent
      // can say which.
      const noneSucceeded: boolean = outcomes.every(
        (outcome: ListingOutcome) => outcome.kind !== "listing",
      );
      if (noneSucceeded && resolvedPath !== "/") {
        const dirExists: Result<boolean> = await path_checkIsDir(resolvedPath);
        if (!dirExists.ok) {
          // The probe itself failed: report the verification failure rather
          // than claiming the folder is absent.
          return Err();
        }
        if (!dirExists.value) {
          errorStack.stack_push(
            "error",
            `Cannot list ${resolvedPath}: No such file or directory`
          );
          return Err();
        }
      }

      const items: VFSItem[] = [];

      const mapToItem = chrisRow_convertToItem;

      if (dirsResult.status === "fulfilled" && dirsResult.value?.tableData) {
        dirsResult.value.tableData.forEach((d: unknown) =>
          items.push(mapToItem(d as ChrisFileOrDirRaw, "dir"))
        );
      }

      if (filesResult.status === "fulfilled" && filesResult.value?.tableData) {
        filesResult.value.tableData.forEach((f: unknown) =>
          items.push(mapToItem(f as ChrisFileOrDirRaw, "file"))
        );
      }

      if (linksResult.status === "fulfilled" && linksResult.value?.tableData) {
        linksResult.value.tableData.forEach((l: unknown) =>
          items.push(mapToItem(l as ChrisFileOrDirRaw, "link"))
        );
      }

      // A directory listing is name-unique by definition; CUBE's links
      // search can return the same row more than once (observed on /PUBLIC),
      // so keep the first occurrence of each name.
      const seen: Set<string> = new Set();
      const unique: VFSItem[] = items.filter((item: VFSItem): boolean => {
        if (seen.has(item.name)) return false;
        seen.add(item.name);
        return true;
      });

      const sorted: VFSItem[] = vfsItems_sort(unique, options?.sort, options?.reverse);
      return Ok(sorted);
    } catch (error: unknown) {
      const msg: string = error instanceof Error ? error.message : String(error);
      errorStack.stack_push("error", `Native VFS list failed: ${msg}`);
      return Err();
    }
  }

  /** @inheritdoc */
  async cp(src: string, dest: string, options: CpOptions): Promise<VfsOutcome> {
    return vfsOutcome_convertFromBoolean(await this.copy_run(src, dest, options), 'EIO');
  }

  /**
   * What a path is in its parent folder: a folder, a file or a link, and its
   * id, found the way CUBE can be asked (its parent's three listings).
   *
   * @param target - The absolute path.
   * @returns The entry, null when the parent does not hold it, or Err when
   *   the parent could not be read (its reason stacked).
   */
  private async entry_find(target: string): Promise<Result<{ type: 'dir' | 'file' | 'link'; id: number } | null>> {
    const all: Result<Array<{ type: 'dir' | 'file' | 'link'; id: number }>> = await this.entries_find(target);
    if (!all.ok) return Err();
    return Ok(all.value[0] ?? null);
  }

  /**
   * Everything holding a path in its parent folder. CUBE lets a folder and a
   * file share one path, so there can be more than one; a disk never has.
   *
   * @param target - The absolute path.
   * @returns Each holder (folders first), or Err when the parent could not
   *   be read (its reason stacked).
   */
  private async entries_find(target: string): Promise<Result<Array<{ type: 'dir' | 'file' | 'link'; id: number }>>> {
    const clean: string = target.length > 1 && target.endsWith('/') ? target.slice(0, -1) : target;
    if (clean === '/') return Ok([{ type: 'dir', id: 0 }]);
    const parent: string = path.posix.dirname(clean);
    const name: string = path.posix.basename(clean);
    const fetchOpts = { limit: 1000, offset: 0 };
    const kinds: Array<['dirs' | 'files' | 'links', 'dir' | 'file' | 'link']> = [['dirs', 'dir'], ['files', 'file'], ['links', 'link']];
    const found: Array<{ type: 'dir' | 'file' | 'link'; id: number }> = [];
    for (const [asset, type] of kinds) {
      const mark: number = errorStack.checkpoint_mark();
      const outcome: ListingOutcome = await files_listOutcome(fetchOpts, asset, parent);
      if (outcome.kind === 'refused') {
        const msg: string = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        errorStack.stack_push('error', `Cannot read ${parent}: ${msg}`);
        return Err();
      }
      // A parent that is not there holds nothing: an answer, not a failure to leave on the stack.
      if (outcome.kind === 'missing') errorStack.checkpoint_drain(mark);
      if (outcome.kind !== 'listing') continue;
      const row: ChrisFileOrDirRaw | undefined = ((outcome.data.tableData ?? []) as ChrisFileOrDirRaw[])
        .find((r: ChrisFileOrDirRaw): boolean => chrisRow_convertToItem(r, type).name === name && r.id !== undefined);
      if (row !== undefined) found.push({ type, id: Number(row.id) });
    }
    return Ok(found);
  }

  /**
   * The one thing a removal may act on, or why it may not: ENOENT when
   * nothing holds the path, and a refusal when a folder and a file share
   * it, since CUBE's delete of either damages the other's record and every
   * listing of the parent fails after (CUBE #732).
   *
   * @param target - The path to remove.
   * @returns The single holder, or the failure.
   */
  private async removable_find(target: string): Promise<VfsOutcome<{ type: 'dir' | 'file' | 'link'; id: number }>> {
    const all: Result<Array<{ type: 'dir' | 'file' | 'link'; id: number }>> = await this.entries_find(target);
    if (!all.ok) return vfs_failFromStack('EIO');
    if (all.value.length === 0) return vfs_fail('ENOENT');
    if (all.value.length > 1) {
      return vfs_fail('EPERM', `a folder and a file share ${target}, and removing either would damage the other in CUBE`);
    }
    return vfs_ok(all.value[0]);
  }

  /**
   * Why an operation on a path failed, once it has: ENOENT when the path
   * is not there, the given errno for what is, EIO when its parent could
   * not be read. The store's own words, when it gave any, are the reason
   * for ENOENT and EIO; for anything else the errno's own words stand.
   *
   * @param target - The path.
   * @param whenThere - The errno when the path is there (`EISDIR` for a read of a folder).
   * @returns The failure.
   */
  private async failure_classify(target: string, whenThere: (type: 'dir' | 'file' | 'link') => VfsErrno): Promise<VfsOutcome<never>> {
    const said: VfsOutcome<never> = vfs_failFromStack('EIO');
    const entry: Result<{ type: 'dir' | 'file' | 'link'; id: number } | null> = await this.entry_find(target);
    const errno: VfsErrno = !entry.ok ? 'EIO' : entry.value === null ? 'ENOENT' : whenThere(entry.value.type);
    if (!entry.ok) errorStack.stack_pop();
    // CUBE's words describe a file it could not find; for a path that is
    // there (a folder read as a file) they would be untrue, so the errno speaks.
    const storeSpeaks: boolean = errno === 'ENOENT' || errno === 'EIO';
    return storeSpeaks && !said.ok && said.reason !== undefined ? vfs_fail(errno, said.reason) : vfs_fail(errno);
  }

  /** @inheritdoc */
  async read(target: string): Promise<VfsOutcome<string>> {
    // Read first: a file that is there costs no more than it always has.
    const content: Result<string> = await fileContent_get(target);
    if (content.ok) return vfs_ok(content.value);
    return this.failure_classify(target, (type) => (type === 'dir' ? 'EISDIR' : 'EIO'));
  }

  /**
   * Proves that nothing in CUBE holds a path: its parent was listed whole
   * and no folder, file or link there has the name (`pathHolders_prove`).
   * A listing that was refused, failed or came back short proves nothing.
   *
   * @param target - An absolute CUBE path.
   * @returns True only on that proof.
   */
  async absence_prove(target: string): Promise<boolean> {
    const mark: number = errorStack.checkpoint_mark();
    const proof: Result<PathProof> = await pathHolders_prove(target);
    errorStack.checkpoint_drain(mark);
    return proof.ok && proof.value.kind === 'absent';
  }

  /** @inheritdoc */
  async readBinary(target: string): Promise<VfsOutcome<Buffer>> {
    const bytes: Result<Buffer> = await fileContent_getBinary(target);
    if (bytes.ok) return vfs_ok(bytes.value);
    return this.failure_classify(target, (type) => (type === 'dir' ? 'EISDIR' : 'EIO'));
  }

  /** @inheritdoc */
  async write(target: string, content: string | Buffer): Promise<VfsOutcome> {
    const there: Result<{ type: 'dir' | 'file' | 'link'; id: number } | null> = await this.entry_find(target);
    if (!there.ok) return vfs_failFromStack('EIO');
    if (there.value?.type === 'dir') return vfs_fail('EISDIR');
    const parent: Result<{ type: 'dir' | 'file' | 'link'; id: number } | null> = await this.entry_find(path.posix.dirname(target));
    if (!parent.ok) return vfs_failFromStack('EIO');
    if (parent.value === null) return vfs_fail('ENOENT');
    if (parent.value.type !== 'dir') return vfs_fail('ENOTDIR');
    // files_touch replaces: CUBE's upload does not, so a file already there is removed first.
    return vfsOutcome_convertFromBoolean(await files_touch(target, content), 'EIO');
  }

  /** @inheritdoc */
  async mkdir(target: string): Promise<VfsOutcome> {
    // CUBE answers success for a folder already there; a disk says EEXIST.
    const there: Result<{ type: 'dir' | 'file' | 'link'; id: number } | null> = await this.entry_find(target);
    if (!there.ok) return vfs_failFromStack('EIO');
    if (there.value !== null) return vfs_fail('EEXIST');
    const parent: Result<{ type: 'dir' | 'file' | 'link'; id: number } | null> = await this.entry_find(path.posix.dirname(target));
    if (!parent.ok) return vfs_failFromStack('EIO');
    if (parent.value === null) return vfs_fail('ENOENT');
    if (parent.value.type !== 'dir') return vfs_fail('ENOTDIR');
    return vfsOutcome_convertFromBoolean(await files_mkdir(target, { cleared: true }), 'EIO');
  }

  /** @inheritdoc */
  async mkdirTree(target: string): Promise<VfsOutcome> {
    // CUBE makes a folder's missing parents with it, in one request, and
    // would make them over a file too: the nearest thing holding the path
    // or a parent decides first.
    const first: Result<FolderPathHolder | null> = await folderPath_holder(target);
    if (!first.ok) return vfs_failFromStack('EIO');
    if (first.value?.atTarget === true) return vfs_fail('EEXIST');
    if (first.value !== null && first.value.holder !== 'dir') return vfs_fail('ENOTDIR');
    return vfsOutcome_convertFromBoolean(await files_mkdir(target, { cleared: true }), 'EIO');
  }

  /**
   * Removes a folder that is proved to be a folder, alone at its path, and
   * empty.
   *
   * CUBE's delete of a folder takes everything in it, so an answer that only
   * looks like "empty" is not enough. `list` keeps the rows it has when part
   * of a listing fails, which is right for showing a folder and wrong here:
   * the proofs come from `files/proof`, where a listing refused, one that
   * could not be made, or one cut short is a failure and nothing is deleted.
   *
   * One gap stays open: CUBE has no request that deletes a folder only if it
   * is empty, so a child that arrives between the proof and the delete goes
   * with the folder (docs/CUBE-gaps.adoc).
   *
   * @param target - The folder's path.
   * @returns Done, or why not: `ENOENT`, `ENOTDIR`, `ENOTEMPTY`, `EPERM`
   *   when a folder and a file share the path, `EIO` when a proof failed.
   */
  async rmdir(target: string): Promise<VfsOutcome> {
    const holding: Result<PathProof> = await pathHolders_prove(target);
    if (!holding.ok) return vfs_failFromStack('EIO');
    if (holding.value.kind === 'absent') return vfs_fail('ENOENT');
    if (holding.value.holders.length > 1) {
      return vfs_fail('EPERM', `a folder and a file share ${target}, and removing either would damage the other in CUBE`);
    }
    const [holder] = holding.value.holders;
    if (holder === undefined || holder.kind !== 'dir') return vfs_fail('ENOTDIR');
    const empty: Result<boolean> = await folderEmptiness_prove(target);
    if (!empty.ok) return vfs_failFromStack('EIO');
    if (!empty.value) return vfs_fail('ENOTEMPTY');
    if (!await files_delete(holder.id, 'dirs', path.posix.dirname(target))) return vfs_failFromStack('EIO');
    return await this.folderGone_await(target);
  }

  /** @inheritdoc */
  async rename(src: string, dest: string): Promise<VfsOutcome> {
    const from: Result<{ type: 'dir' | 'file' | 'link'; id: number } | null> = await this.entry_find(src);
    if (!from.ok) return vfs_failFromStack('EIO');
    if (from.value === null) return vfs_fail('ENOENT');
    const onto: Result<{ type: 'dir' | 'file' | 'link'; id: number } | null> = await this.entry_find(dest);
    if (!onto.ok) return vfs_failFromStack('EIO');
    // CUBE has no overwrite (docs/CUBE-gaps.adoc), and the request it would
    // take leaves a row its own API cannot serve, which poisons every
    // listing of that folder: refused here, by name.
    if (onto.value !== null) {
      return vfs_fail('EEXIST', `Destination exists: ${dest} — mise cannot overwrite a file; remove it first`);
    }
    const parent: Result<{ type: 'dir' | 'file' | 'link'; id: number } | null> = await this.entry_find(path.posix.dirname(dest));
    if (!parent.ok) return vfs_failFromStack('EIO');
    if (parent.value === null) return vfs_fail('ENOENT');
    if (parent.value.type !== 'dir') return vfs_fail('ENOTDIR');
    return vfsOutcome_convertFromBoolean(await files_move(src, dest), 'EIO');
  }

  /** @inheritdoc */
  async rm(target: string): Promise<VfsOutcome> {
    const there: VfsOutcome<{ type: 'dir' | 'file' | 'link'; id: number }> = await this.removable_find(target);
    if (!there.ok) return there;
    if (there.value.type === 'dir') return vfs_fail('EISDIR');
    const asset: string = there.value.type === 'link' ? 'links' : 'files';
    return vfsOutcome_convertFromBoolean(await files_delete(there.value.id, asset, path.posix.dirname(target)), 'EIO');
  }

  /** @inheritdoc */
  async rmTree(target: string): Promise<VfsOutcome> {
    // CUBE removes a folder with everything in it in one request.
    const there: VfsOutcome<{ type: 'dir' | 'file' | 'link'; id: number }> = await this.removable_find(target);
    if (!there.ok) return there;
    if (there.value.type !== 'dir') return vfs_fail('ENOTDIR');
    if (!await files_delete(there.value.id, 'dirs', path.posix.dirname(target))) return vfs_failFromStack('EIO');
    return await this.folderGone_await(target);
  }

  /**
   * Waits for a folder CUBE has accepted the removal of to be gone.
   *
   * CUBE answers a folder's DELETE with 202: queued, not done. Its parent
   * goes on listing the folder for a moment, and a listing read then (an
   * `ls`, a pane's refresh) is the folder as it was, kept as current. An
   * `rm` that returns before the folder is gone has not removed it yet, so
   * it waits, a few seconds at most, for the parent to stop naming it.
   *
   * @param target - The folder removed.
   * @param timeoutMs - How long to wait.
   * @returns Done when the parent no longer names it; a failure in words when it still does.
   */
  private async folderGone_await(target: string, timeoutMs: number = FOLDER_GONE_WAIT_MS): Promise<VfsOutcome> {
    const parent: string = path.posix.dirname(target);
    const name: string = path.posix.basename(target);
    const deadline: number = Date.now() + timeoutMs;
    for (;;) {
      const mark: number = errorStack.checkpoint_mark();
      const outcome: ListingOutcome = await files_listOutcome({ limit: 1000, offset: 0 }, 'dirs', parent);
      errorStack.checkpoint_drain(mark);
      const named: boolean = outcome.kind === 'listing' && ((outcome.data.tableData ?? []) as ChrisFileOrDirRaw[])
        .some((row: ChrisFileOrDirRaw): boolean => chrisRow_convertToItem(row, 'dir').name === name);
      if (!named) return vfs_ok(true);
      if (Date.now() >= deadline) {
        return vfs_fail('EIO', `CUBE accepted the removal of ${target} but still lists it after ${Math.round(timeoutMs / 1000)}s`);
      }
      await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, FOLDER_GONE_POLL_MS); });
    }
  }

  /**
   * Copies native files or folders using Salsa's files_copy algorithms.
   *
   * @param src - Source absolute path.
   * @param dest - Destination absolute path.
   * @param options - Copy options.
   */
  private async copy_run(src: string, dest: string, options: CpOptions): Promise<boolean> {
    try {
      const srcIsDir: Result<boolean> = await path_checkIsDir(src);
      if (!srcIsDir.ok) {
        return false;
      }
      if (srcIsDir.value && !options.recursive) {
        errorStack.stack_push(
          "error",
          `Source is a directory. Re-run with --recursive to copy: ${src}`
        );
        return false;
      }

      const destIsDir: Result<boolean> = await path_checkIsDir(dest);
      if (!destIsDir.ok) {
        return false;
      }
      const destLooksDir: boolean = dest.endsWith("/");
      const finalDest = (destIsDir.value || destLooksDir)
        ? path.posix.join(dest, path.posix.basename(src))
        : dest;

      // A write onto a path the store already holds leaves a row CUBE's own
      // API cannot serve, and one such row makes every listing of that
      // folder fail (docs/CUBE-gaps.adoc). The store has no overwrite, so
      // this is refused by name rather than attempted.
      if (!srcIsDir.value && await path_checkFileExists(finalDest)) {
        errorStack.stack_push(
          "error",
          `Destination exists: ${finalDest} — mise cannot overwrite a file; remove it first`,
        );
        return false;
      }

      if (options.recursive) {
        return await files_copyRecursively(src, finalDest);
      } else {
        return await files_copy(src, finalDest);
      }
    } catch (error: unknown) {
      const msg: string = error instanceof Error ? error.message : String(error);
      errorStack.stack_push("error", `Native VFS copy failed: ${msg}`);
      return false;
    }
  }
}

/**
 * Whether a ChRIS path is already held by a file.
 *
 * The question a write must ask first, since the store has no overwrite and
 * a write onto an occupied path damages the folder's listing.
 *
 * @param targetPath - The absolute ChRIS path to check.
 * @returns True when a file of that name is already there, or when the
 *   probe itself could not answer.
 */
async function path_checkFileExists(targetPath: string): Promise<boolean> {
  const parent: string = path.posix.dirname(targetPath);
  const name: string = path.posix.basename(targetPath);
  try {
    const results = await files_listAll({ limit: 1000, offset: 0 }, "files", parent);
    if (!results || !results.tableData) {
      return false;
    }
    return results.tableData.some((entry: Record<string, unknown>) => {
      const candidate: string = typeof entry.fname === "string" ? entry.fname : "";
      return candidate === targetPath || path.posix.basename(candidate) === name;
    });
  } catch {
    // A probe that cannot answer counts the path as taken: the cost of
    // guessing wrong is the operator's folder.
    return true;
  }
}

/**
 * Determines whether a given ChRIS path refers to a directory.
 *
 * Distinguishes "verified absent" from "could not verify": a listing failure
 * while probing must not masquerade as a missing directory, since callers use
 * this probe to decide between not-found errors and real operations.
 *
 * @param targetPath - The absolute ChRIS path to check.
 * @returns Ok(true/false) when the parent listing answered, Err when the
 *   probe itself failed (an error has been pushed to the stack).
 */
async function path_checkIsDir(targetPath: string): Promise<Result<boolean>> {
  const parent: string = path.posix.dirname(targetPath);
  const name: string = path.posix.basename(targetPath);
  // A parent listed freshly already says which of its children are folders.
  const kept = listCache_get().cache_get<VFSItem[]>(parent);
  if (kept !== null && kept.fresh && Array.isArray(kept.data)) {
    return Ok(kept.data.some((item: VFSItem): boolean => item.name === name && (item.type === "dir" || item.type === "vfs")));
  }
  // The folder lookup is memoised for the session, a miss included: asked
  // once, it answers every later probe of the same path without CUBE. The
  // parent is listed only when there is no client to ask.
  const client = await chrisConnection.client_get();
  const lookup = (client as { getFileBrowserFolderByPath?: (p: string) => Promise<unknown> } | null)?.getFileBrowserFolderByPath;
  if (client !== null && typeof lookup === "function") {
    try {
      const folder: unknown = await lookup.call(client, targetPath);
      return Ok(folder !== null && folder !== undefined);
    } catch {
      // A lookup that failed is not an answer: the listing below decides.
    }
  }
  try {
    const results = await files_listAll({ limit: 1000, offset: 0 }, "dirs", parent);
    if (!results || !results.tableData) {
      // files_listAll returns null for both an empty parent and a failed
      // context: an empty parent simply has no dirs, so absent is the answer.
      return Ok(false);
    }
    const found: boolean = results.tableData.some((entry: Record<string, unknown>) => {
      const candidate: string =
        typeof entry.path === "string" && entry.path.length > 0
          ? entry.path
          : typeof entry.fname === "string"
            ? entry.fname
            : "";
      return candidate === targetPath || path.posix.basename(candidate) === name;
    });
    return Ok(found);
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push("error", `Cannot verify directory ${targetPath}: ${msg}`);
    return Err();
  }
}

