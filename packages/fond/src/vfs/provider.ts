/**
 * @file The virtual filesystem's contracts: a mount (provider), the items it
 * lists, and the options a copy takes.
 *
 * A session's filesystem is a tree of mounts. Each provider claims a path
 * prefix and answers for everything at or under it; whatever no provider
 * claims goes to the dispatcher's fallback (see `dispatcher.ts`).
 *
 * @module
 */

import { Result } from "../result.js";
import type { VfsOutcome } from "./outcome.js";

/**
 * Standard interface representing a virtual file system item.
 */
export interface VFSItem {
  /** The display name of the item. */
  name: string;
  
  /**
   * What the item is: `dir`, `file`, `link` or `vfs` (a mount), or a kind a
   * backend lists beside them. An open string: a consumer handles the kinds it
   * knows and treats any other as a plain entry.
   */
  type: string;
  
  /** Size in bytes. */
  size: number;
  
  /** Username of the owner. */
  owner: string;
  
  /** Creation date (ISO string). */
  date: string;
  
  /** Target path (for links). */
  target?: string;
  
  /** Version string (for plugins). */
  version?: string;
  
  /** Title or description, when the item has one. */
  title?: string;

  /** Backing resource ID, when the virtual entry represents one. */
  id?: number;

  /** Execution status (for job type items). */
  status?: string;

  /** Tags a backend hangs on the item, shown in a long listing as `#tag`. */
  tags?: string[];
}

/**
 * Options for VFS copy operations.
 */
export interface CpOptions {
  /** Recursively copy subdirectories. */
  recursive?: boolean;
}

/** One entry of a subtree a mount answers whole, from what it already holds. */
export interface VFSSubtreeEntry {
  /** The entry's path below the subtree's root (`feed_5/pl-x_10/status`). */
  rel: string;
  /** The entry as a listing would show it. */
  item: VFSItem;
  /** Levels below the root (1 for its children). */
  depth: number;
  /** What a test may ask of it beyond the listing (`status`, `plugin`, ...). */
  attrs?: Readonly<Record<string, string>>;
}

/** A subtree a mount answered: its entries in walk order, and what it could not answer. */
export interface VFSSubtree {
  entries: VFSSubtreeEntry[];
  /** Folders below the root (`rel` paths) whose contents must be walked instead. */
  unanswered: string[];
}

/**
 * Base contract that every Virtual File System Provider must implement.
 */
export interface VFSProvider {
  /** The path prefix this provider matches (e.g. '/net/pacs', '/bin'); empty for a fallback. */
  prefix: string;

  /**
   * Lists the contents of a directory matching this provider.
   *
   * @param path - The absolute virtual directory path.
   * @param options - Optional sorting controls.
   * @returns A Promise resolving to a Result containing VFSItems.
   */
  list(
    path: string,
    options?: { sort?: "name" | "size" | "date" | "owner"; reverse?: boolean }
  ): Promise<Result<VFSItem[]>>;

  /**
   * Copies files or folders from/to paths under this provider.
   *
   * @param src - The absolute source path.
   * @param dest - The absolute destination path.
   * @param options - Copy flags like recursive.
   * @returns Done, or why not.
   */
  cp(src: string, dest: string, options: CpOptions): Promise<VfsOutcome>;

  /**
   * Reads a file whole, as text.
   *
   * @param path - The absolute path of the file.
   * @returns Its content, or why not (`ENOENT`, `EISDIR`, ...).
   */
  read?(path: string): Promise<VfsOutcome<string>>;

  /**
   * Reads a file whole, as bytes.
   *
   * @param path - The absolute path of the file.
   * @returns Its bytes, or why not.
   */
  readBinary?(path: string): Promise<VfsOutcome<Buffer>>;

  /**
   * Writes a file whole: its content after the write is exactly what was
   * given, whether or not it existed before. Absent, the mount holds no
   * writable files.
   *
   * @param path - The absolute path of the file.
   * @param content - The new content, whole.
   * @returns Done, or why not (`ENOENT` for a missing folder, `EISDIR`, ...).
   */
  write?(path: string, content: string | Buffer): Promise<VfsOutcome>;

  /**
   * Makes one folder; its parent must exist. Absent, the mount makes none.
   *
   * @param path - The absolute path of the new folder.
   * @returns Done, or why not (`EEXIST`, `ENOENT` for a missing parent, ...).
   */
  mkdir?(path: string): Promise<VfsOutcome>;

  /**
   * Makes a folder and any missing parents in one step, for a mount whose
   * store can (`mkdir -p`). Absent, `mkdir -p` makes each missing parent in
   * turn.
   *
   * @param path - The absolute path of the folder.
   * @returns Done, or why not (`EEXIST` when something is already there).
   */
  mkdirTree?(path: string): Promise<VfsOutcome>;

  /**
   * Removes an empty folder (`rmdir`).
   *
   * @param path - The absolute path of the folder.
   * @returns Done, or why not (`ENOENT`, `ENOTDIR`, `ENOTEMPTY`, ...).
   */
  rmdir?(path: string): Promise<VfsOutcome>;

  /**
   * Renames an entry within this mount (`mv`).
   *
   * @param src - The absolute path now.
   * @param dest - The absolute path it takes.
   * @returns Done, or why not (`ENOENT`, `EEXIST` where the mount cannot replace, ...).
   */
  rename?(src: string, dest: string): Promise<VfsOutcome>;

  /**
   * Removes a file or a link (`rm`); a folder is refused with `EISDIR`.
   *
   * @param path - The absolute path of the entry.
   * @returns Done, or why not.
   */
  rm?(path: string): Promise<VfsOutcome>;

  /**
   * Removes a folder and everything under it in one step, for a mount
   * whose store can (`rm -r`). Absent, `rm -r` removes what it holds one
   * entry at a time.
   *
   * @param path - The absolute path of the folder.
   * @returns Done, or why not.
   */
  rmTree?(path: string): Promise<VfsOutcome>;

  /**
   * Resolves the target of a provider-defined lazy link when an operation
   * actually follows it.
   *
   * Listings must not use this hook: providers may expose an unresolved link
   * as structural metadata without paying for its target until navigation.
   *
   * @param path - Absolute virtual path naming the link.
   * @returns The target path, or an error when the provider cannot resolve it.
   */
  linkTarget_resolve?(path: string): Promise<Result<string>>;

  /**
   * The path in the backend's store a path under this mount stands for:
   * where the mount's own link leads, with the rest of the path after it
   * (`/proc/jobs/feed_1/pl-x_2/data/a.txt` is the job's output folder and
   * `a.txt` in it). Null when the mount holds the path itself (a file it
   * makes, a folder of its own). The session's path resolver asks it, then
   * follows the store's links on what it answers.
   *
   * @param path - Absolute path under this mount.
   * @returns The store path, null when the mount holds the path, or an error
   *   (its reason stacked) when the link leads nowhere.
   */
  storePath_resolve?(path: string): Promise<Result<string | null>>;

  /**
   * Answers everything beneath a path at once, from what the mount already
   * holds, so a walk (`find`) need not list it folder by folder. Null when
   * the mount holds nothing it can answer from.
   *
   * @param path - The subtree's root.
   * @returns The entries in walk order and what is left to walk, or null.
   */
  subtree?(path: string): Promise<VFSSubtree | null>;
}
