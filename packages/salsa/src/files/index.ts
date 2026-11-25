/**
 * @file File group resolution and content dispatch across file source types.
 *
 * @module
 */

import { vfsOutcome_convertToResult } from '@fnndsc/fond';
import * as path from 'path';
import {
  ChRISEmbeddedResourceGroup,
  objContext_create,
  chrisContext,
  Context,
  errorStack,
  chrisIO,
  ListOptions,
  FilteredResourceData,
  Result,
  Ok,
  Err,
  runtimeOutput_data,
  runtimeOutput_err,
} from "@fnndsc/cumin";
import { ChrisPathNode } from "@fnndsc/cumin";
import { fileContent_getPipeline, fileContent_getPipelineBinary } from './pipeline_content';
import { fileContent_getRegular, fileContent_getRegularBinary, fileContent_getRegularStream } from './regular_content';
import { fileContent_getPACS, fileContent_getPACSBinary } from './pacs_content';
import { vfsDispatcher } from '../vfs/dispatcher.js';

/**
 * Represents a file or directory item in a recursive listing.
 */
export interface FsItem {
  path: string;
  type: 'file' | 'dir';
  size?: number;
}

/**
 * Recursively lists all files and directories under a given ChRIS path.
 *
 * @param rootPath - The starting directory path.
 * @returns A Promise resolving to an array of FsItem objects.
 */
export async function files_listRecursive(rootPath: string): Promise<FsItem[]> {
  let items: FsItem[] = [];

  // 1. List files in current directory
  const filesGroup: ChRISEmbeddedResourceGroup<ChrisPathNode> | null = await files_getGroup('files', rootPath);
  if (filesGroup) {
    const fileResults: FilteredResourceData | null = await filesGroup.asset.resources_getAll();
    if (fileResults && fileResults.tableData) {
      fileResults.tableData.forEach((f: Record<string, unknown>) => {
        items.push({
          path: (f['fname'] as string) || '', // fname is the full path
          type: 'file',
          size: (f['fsize'] as number) || 0
        });
      });
    }
  }

  // 2. List subdirectories
  const dirsGroup: ChRISEmbeddedResourceGroup<ChrisPathNode> | null = await files_getGroup('dirs', rootPath);
  if (dirsGroup) {
    const dirResults: FilteredResourceData | null = await dirsGroup.asset.resources_getAll();
    if (dirResults && dirResults.tableData) {
      for (const d of dirResults.tableData) {
        const dirPath: string = d.path as string;
        items.push({ path: dirPath, type: 'dir' });
        
        // Recurse
        const subItems: FsItem[] = await files_listRecursive(dirPath);
        items = items.concat(subItems);
      }
    }
  }

  return items;
}

/**
 * Recursively copies a directory from source to destination within ChRIS.
 *
 * @param srcPath - The source directory path.
 * @param destPath - The destination directory path (the parent + new dir name).
 * @returns A Promise resolving to true on success, false on failure.
 */
export async function files_copyRecursively(srcPath: string, destPath: string): Promise<boolean> {
  try {
    // Ensure destination directory exists (mkdir -p behavior ideally, but files_mkdir is shallow?)
    // Actually files_mkdir assumes parent exists.
    // For a copy, we create the target root first.
    await files_mkdir(destPath);

    const items: FsItem[] = await files_listRecursive(srcPath);
    let successCount: number = 0;
    let failCount: number = 0;
    // The folders each target folder holds, listed once: a file is never
    // copied onto a folder's name, and a large copy pays one listing per
    // folder rather than one per file.
    const foldersIn: Map<string, Set<string>> = new Map();
    const folders_fetch = async (folder: string): Promise<Set<string>> => {
      const known: Set<string> | undefined = foldersIn.get(folder);
      if (known !== undefined) return known;
      const outcome: ListingOutcome = await files_listOutcome({ limit: 1000, offset: 0 }, 'dirs', folder);
      const names: Set<string> = new Set(outcome.kind === 'listing'
        ? (outcome.data.tableData ?? []).map((row: Record<string, unknown>): string => path.posix.basename(String(row.path ?? row.fname ?? '')))
        : []);
      foldersIn.set(folder, names);
      return names;
    };

    for (const item of items) {
      // Normalize item.path to ensure it has a leading slash
      const normalizedItemPath: string = item.path.startsWith('/') ? item.path : '/' + item.path;

      const relativePath: string = normalizedItemPath.substring(srcPath.length).replace(/^\//, '');
      const targetPath: string = path.posix.join(destPath, relativePath); // Use posix for ChRIS paths

      if (item.type === 'dir') {
        runtimeOutput_data(`  Creating directory: ${targetPath}\n`);
        const created: boolean = await files_mkdir(targetPath);
        if (!created) {
          runtimeOutput_err(`  Warning: Failed to create directory ${targetPath}\n`);
          failCount++;
        } else {
          (await folders_fetch(path.posix.dirname(targetPath))).add(path.posix.basename(targetPath));
          successCount++;
        }
      } else if (item.type === 'file') {
        runtimeOutput_data(`  Copying file: ${path.posix.basename(normalizedItemPath)}\n`);
        if ((await folders_fetch(path.posix.dirname(targetPath))).has(path.posix.basename(targetPath))) {
          runtimeOutput_err(`  Warning: a folder already holds ${targetPath}; the file is not copied over it\n`);
          failCount++;
          continue;
        }
        const copied: boolean = await files_copy(normalizedItemPath, targetPath, { folderClear: true });
        if (!copied) {
          runtimeOutput_err(`  Warning: Failed to copy file ${normalizedItemPath}\n`);
          failCount++;
          // Continue trying to copy other files instead of aborting
        } else {
          successCount++;
        }
      }
    }

    runtimeOutput_data(`Copied ${successCount} items, ${failCount} failed\n`);
    return failCount === 0;
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push("error", `Recursive copy failed: ${msg}`);
    return false;
  }
}

/**
 * Resolves a file ID from a ChRIS path.
 *
 * @param srcPath - The absolute ChRIS file path.
 * @returns Result containing the file ID or Err on failure.
 */
async function fileId_resolve(srcPath: string): Promise<Result<number>> {
  const srcDir: string = path.posix.dirname(srcPath);
  const srcName: string = path.posix.basename(srcPath);

  const group: ChRISEmbeddedResourceGroup<ChrisPathNode> | null = await files_getGroup('files', srcDir);
  if (!group) {
      errorStack.stack_push("error", `Could not access source directory: ${srcDir}`);
      return Err<number>();
  }

  const results: FilteredResourceData | null = await group.asset.resources_getAll();

  let fileId: number | undefined;
  if (results && results.tableData) {
      const match: { id?: number, fname?: string } | undefined = results.tableData.find((f: { fname?: string }) => {
          const fname: string = f.fname || '';
          return fname === srcPath || path.posix.basename(fname) === srcName;
      });
      if (match && match.id !== undefined) {
          fileId = Number(match.id);
      }
  }

  if (fileId === undefined) {
      errorStack.stack_push("error", `Source file not found: ${srcPath}`);
      return Err<number>();
  }

  return Ok(fileId);
}

/**
 * Determines whether a given ChRIS path refers to a directory.
 *
 * @param targetPath - The absolute ChRIS path to check.
 * @returns Promise resolving to true if the path is a directory, false otherwise.
 */
export async function files_path_isDirectory(targetPath: string): Promise<boolean> {
  const parent: string = path.posix.dirname(targetPath);
  const name: string = path.posix.basename(targetPath);
  const results: FilteredResourceData | null = await files_listAll({ limit: 1000, offset: 0 }, "dirs", parent);

  if (!results || !results.tableData) {
    return false;
  }

  return results.tableData.some((entry: { path?: string, fname?: string }) => {
    const candidate: string = entry.path || entry.fname || "";
    return candidate === targetPath || path.posix.basename(candidate) === name;
  });
}

/**
 * Uploads content to a specified ChRIS path, effectively creating or overwriting a file.
 *
 * @param content - The content to upload (string, Buffer, or Blob).
 * @param pathStr - The ChRIS path for the new file.
 * @returns A Promise resolving to true on success, false on failure.
 */
export async function files_create(
  content: string | Buffer | Blob,
  pathStr: string,
  options: { folderClear?: boolean } = {},
): Promise<boolean> {
  // A file is never written over a folder: CUBE would keep both, and
  // removing either later damages the other (CUBE #732). A caller that has
  // already checked the folder's names says so, and is not asked again.
  if (options.folderClear !== true) {
    const holders: Result<PathHolder[]> = await pathHolders_find(pathStr);
    if (!holders.ok) return false;
    if (holders.value.includes('dir')) {
      errorStack.stack_push('error', `Is a directory: a folder already holds ${pathStr}`);
      return false;
    }
  }
  try {
    let uploadContent: Blob;
    if (typeof content === 'string') {
      uploadContent = new Blob([content]);
    } else if (Buffer.isBuffer(content)) {
      uploadContent = new Blob([new Uint8Array(content)]); // Convert Buffer to Uint8Array for Blob
    } else {
      uploadContent = content; // Assume it's already a Blob
    }
    
    // Split path into directory and filename
    const dir = path.posix.dirname(pathStr);
    const name = path.posix.basename(pathStr);
    
    const success: boolean = await chrisIO.file_upload(uploadContent, dir, name);
    if (!success) {
      errorStack.stack_push("error", `File upload failed for ${pathStr}.`);
    }
    return success;
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push("error", `File creation failed for ${pathStr}: ${msg}`);
    return false;
  }
}

/**
 * Creates a new empty file at the specified path (like Unix touch).
 * Optionally creates the file with specified content.
 *
 * @param path - The ChRIS path for the new file.
 * @param content - Optional content to write to the file (string, Buffer, or Blob).
 * @returns A Promise resolving to true on success, false on failure.
 */
export async function files_touch(
  target: string,
  content?: string | Buffer | Blob
): Promise<boolean> {
  const fileContent: string | Buffer | Blob = content ?? new Blob([""]);

  // A projection's file (a feed's note under /proc) is written through the
  // projection that owns it, never uploaded into CUBE's store as a file of
  // that name.
  const { vfsDispatcher } = await import("../vfs/dispatcher.js");
  if (vfsDispatcher.path_isVirtual(target)) {
    if (typeof content !== "string") {
      errorStack.stack_push("error", `touch: ${target}: a projected file takes text (--withContents)`);
      return false;
    }
    return vfsOutcome_convertToResult(await vfsDispatcher.write(target, content), 'write', target).ok;
  }

  // CUBE's upload does not replace: uploading over a path that already holds
  // a file leaves the OLD content in place and still reports success, so a
  // caller writing content to a file it has written before was silently
  // keeping the first version forever. Content given for a path that already
  // exists is a REWRITE, so the file it holds is removed first and the
  // failure to remove it is reported rather than written over.
  if (content !== undefined) {
    const mark: number = errorStack.checkpoint_mark();
    const existing: Result<number> = await fileId_resolve(target);
    if (!existing.ok) {
      // Not being there is the ordinary case, not a fault to report.
      errorStack.checkpoint_drain(mark);
    } else {
      const parent: string = path.posix.dirname(target);
      const removed: boolean = await files_delete(existing.value, "files", parent);
      if (!removed) {
        errorStack.stack_push("error", `Could not rewrite ${target}: the file already there could not be removed.`);
        return false;
      }
    }
  }

  return await files_create(fileContent, target);
}

/**
 * Copies a single file from one ChRIS path to another.
 *
 * @param srcPath - The full path to the source file.
 * @param destPath - The full path to the destination file (including filename).
 * @returns A Promise resolving to true on success, false on failure.
 */
export async function files_copy(
  srcPath: string,
  destPath: string,
  options: { folderClear?: boolean } = {},
): Promise<boolean> {
  try {
    // 1. Resolve source file to get ID (needed for download)
    const fileIdResult: Result<number> = await fileId_resolve(srcPath);
    if (!fileIdResult.ok) {
      return false;
    }
    const fileId: number = fileIdResult.value;

    // 2. Download content
    const content: Buffer | null = await chrisIO.file_download(fileId);
    if (content === null) {
        errorStack.stack_push("error", `Failed to download source file (ID: ${fileId}): ${srcPath}`);
        return false;
    }

    // 3. Upload to destination
    // files_create handles Blob/Buffer conversion and path splitting
    const uploadSuccess: boolean = await files_create(content, destPath, options);
    if (!uploadSuccess) {
        const lastError = errorStack.stack_pop();
        if (lastError) {
            runtimeOutput_err(`    Error: ${lastError.message}\n`);
        }
    }
    return uploadSuccess;

  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push("error", `Copy failed from ${srcPath} to ${destPath}: ${msg}`);
    return false;
  }
}

/**
 * Moves a file or directory by updating its path on the server.
 *
 * For directories, this performs a server-side rename without data transfer.
 * For files, the file ID is resolved and the path is updated.
 *
 * @param srcPath - The source file or directory path.
 * @param destPath - The target path. If an existing directory or trailing slash is provided,
 *                   the source basename is appended.
 * @returns Promise resolving to true on success, false on failure.
 */
export async function files_move(srcPath: string, destPath: string): Promise<boolean> {
  try {
    const srcIsDir: boolean = await files_path_isDirectory(srcPath);
    const destIsDir: boolean = await files_path_isDirectory(destPath);
    const destLooksDir: boolean = destPath.endsWith("/");
    const finalDest: string = (destIsDir || destLooksDir)
      ? path.posix.join(destPath, path.posix.basename(srcPath))
      : destPath;

    // Nothing is moved onto a path something already holds: CUBE has no
    // overwrite, and a folder and a file sharing one path damage each other
    // when either is removed (CUBE #732).
    const holders: Result<PathHolder[]> = await pathHolders_find(finalDest);
    if (!holders.ok) return false;
    if (holders.value.length > 0) {
      errorStack.stack_push('error', `Destination exists: ${finalDest} — mise cannot overwrite a ${holders.value[0]}; remove it first`);
      return false;
    }

    if (srcIsDir) {
      const moveResult: Result<boolean> = await chrisIO.folder_moveByPath(srcPath, finalDest);
      return moveResult.ok && moveResult.value;
    }

    const fileIdResult: Result<number> = await fileId_resolve(srcPath);
    if (!fileIdResult.ok) {
      return false;
    }

    const moveResult: Result<boolean> = await chrisIO.file_moveById(fileIdResult.value, finalDest);
    return moveResult.ok && moveResult.value;
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push("error", `Move failed from ${srcPath} to ${destPath}: ${msg}`);
    return false;
  }
}

/**
 * Uploads a local file or directory to ChRIS recursively.
 *
 * @param localPath - The local filesystem path.
 * @param remotePath - The ChRIS destination path.
 * @returns Promise<boolean> success.
 */
export async function files_uploadPath(localPath: string, remotePath: string): Promise<boolean> {
  return await chrisIO.uploadLocalPath(localPath, remotePath);
}

/** What holds a CUBE path: folders, files and links may each hold the same one. */
export type PathHolder = 'dir' | 'file' | 'link';

/**
 * Every kind of entry that holds a path, from its parent's three listings.
 *
 * CUBE lets a folder and a file share one path, and that is a hazard: a
 * folder made over a file, then deleted, takes the file's record with it
 * and every listing of the parent fails (CUBE #732, mise #462). Writers ask
 * this first and refuse a path something else holds.
 *
 * @param target - The absolute CUBE path.
 * @returns The kinds holding it (none, one, or more than one), or Err when
 *   the parent could not be read (the reason stacked): a probe that cannot
 *   answer counts the path as taken.
 */
export async function pathHolders_find(target: string): Promise<Result<PathHolder[]>> {
  const clean: string = target.length > 1 && target.endsWith('/') ? target.slice(0, -1) : target;
  if (clean === '/' || clean === '') return Ok(['dir']);
  const parent: string = path.posix.dirname(clean);
  const name: string = path.posix.basename(clean);
  const holders: PathHolder[] = [];
  const kinds: Array<['dirs' | 'files' | 'links', PathHolder]> = [['dirs', 'dir'], ['files', 'file'], ['links', 'link']];
  for (const [asset, kind] of kinds) {
    const mark: number = errorStack.checkpoint_mark();
    const outcome: ListingOutcome = await files_listOutcome({ limit: 1000, offset: 0 }, asset, parent);
    if (outcome.kind === 'refused') {
      errorStack.stack_push('error', `Cannot check ${clean}: ${outcome.error.message}`);
      return Err();
    }
    // A parent that is not there holds nothing: an answer, so what the
    // lookup said on the way is not left to fail the command.
    if (outcome.kind === 'missing') errorStack.checkpoint_drain(mark);
    if (outcome.kind !== 'listing') continue;
    // A folder row names itself by `path`; a file or link row by `fname`
    // (a link's ends in `.chrislink`, and its `path` is where it points).
    const held: boolean = (outcome.data.tableData ?? []).some((row: Record<string, unknown>): boolean => {
      const raw: string = String((kind === 'dir' ? row.path : row.fname) ?? '');
      const entry: string = path.posix.basename(raw).replace(/\.chrislink$/, '');
      return entry === name;
    });
    if (held) holders.push(kind);
  }
  return Ok(holders);
}

/** The first thing holding a folder path or one of its parents, walking up. */
export interface FolderPathHolder {
  /** The path held. */
  path: string;
  /** What holds it. */
  holder: PathHolder;
  /** Whether that path is the folder asked about, not a parent of it. */
  atTarget: boolean;
}

/**
 * What already holds a folder path, or the nearest parent of it that is
 * held: a folder there ends the walk, as does a file or a link, which no
 * folder may be made over or under (CUBE would make one anyway, and
 * deleting it later takes the file's record with it, CUBE #732).
 *
 * @param folderPath - The folder's absolute path.
 * @returns The first holder walking up, null when nothing up to the root
 *   holds any of it, or Err when a parent could not be read (stacked).
 */
export async function folderPath_holder(folderPath: string): Promise<Result<FolderPathHolder | null>> {
  const target: string = folderPath.length > 1 && folderPath.endsWith('/') ? folderPath.slice(0, -1) : folderPath;
  let at: string = target;
  while (at !== '/' && at !== '') {
    const holders: Result<PathHolder[]> = await pathHolders_find(at);
    if (!holders.ok) return Err();
    if (holders.value.length > 0) {
      const holder: PathHolder = holders.value.includes('dir') ? 'dir' : holders.value[0];
      return Ok({ path: at, holder, atTarget: at === target });
    }
    at = path.posix.dirname(at);
  }
  return Ok(null);
}

/**
 * Whether a folder may be made at a path: no file or link holds it or any
 * parent of it. Says why not on the error stack.
 *
 * @param folderPath - The folder's absolute path.
 * @returns True when it may.
 */
async function folderPath_clear(folderPath: string): Promise<boolean> {
  const first: Result<FolderPathHolder | null> = await folderPath_holder(folderPath);
  if (!first.ok) return false;
  if (first.value === null || first.value.holder === 'dir') return true;
  errorStack.stack_push('error', first.value.atTarget
    ? `File exists: a ${first.value.holder} already holds ${first.value.path}`
    : `Not a directory: a ${first.value.holder} holds ${first.value.path}`);
  return false;
}

/**
 * Creates a new folder (directory) at the specified ChRIS path.
 *
 * @param folderPath - The full ChRIS path for the new folder.
 * @param options - `cleared` when the caller has already found no file or link holding the path or a parent of it.
 * @returns A Promise resolving to true on success, false on failure.
 */
export async function files_mkdir(folderPath: string, options: { cleared?: boolean } = {}): Promise<boolean> {
  // A folder is never made over a file: deleting it later would take the
  // file's record with it (CUBE #732). A caller that has looked already says so.
  if (options.cleared !== true && !(await folderPath_clear(folderPath))) return false;
  const result: Result<boolean> = await chrisIO.folder_create(folderPath);

  if (!result.ok) {
    return false;
  }

  // result.value is true if created, false if already exists
  // Both cases are considered success
  return true;
}


/**
 * Interface for file sharing options.
 */
export interface FileShareOptions {
  is_public?: boolean;
  // Define options for sharing files
  // e.g., userId: number, permission: 'read' | 'write'
  [key: string]: unknown;
}

/**
 * Creates a ChRISEmbeddedResourceGroup for a specific asset type (files, links, dirs).
 * This function encapsulates the logic from `FileController.handler_create`.
 *
 * @param assetName - The type of asset ('files', 'links', 'dirs').
 * @param path - Optional ChRIS path. Defaults to current folder context.
 * @returns A Promise resolving to a ChRISEmbeddedResourceGroup instance, or null on error.
 */
export async function files_getGroup(
  assetName: string,
  path?: string
): Promise<ChRISEmbeddedResourceGroup<ChrisPathNode> | null> {
  if (!path) {
    const fileContext: string | null = await chrisContext.current_get(
      Context.ChRISfolder
    );
    path = fileContext ? fileContext : "/";
  }

  // A projection path (/proc, /net/pacs, /etc, /usr/share, or an ancestor of
  // one) has no CUBE folder of files behind it: its provider lists it. Asking
  // cumin to build a folder context for it cannot succeed, and a path walk
  // that visits every ancestor — `cd` resolving a /proc job's links, a
  // listing probing parents — turns that failure into a wall of identical
  // errors. The group a projection would answer with is no group at all.
  if (vfsDispatcher.path_isVirtual(path)) {
    return null;
  }

  let chrisFileSystemGroup: ChRISEmbeddedResourceGroup<ChrisPathNode> | null = null;

  try {
    switch (assetName) {
      case "files":
        chrisFileSystemGroup = (await objContext_create(
          "ChRISFilesContext",
          `folder:${path}`
        )) as ChRISEmbeddedResourceGroup<ChrisPathNode>;
        break;
      case "links":
        chrisFileSystemGroup = (await objContext_create(
          "ChRISLinksContext",
          `folder:${path}`
        )) as ChRISEmbeddedResourceGroup<ChrisPathNode>;
        break;
      case "dirs":
        chrisFileSystemGroup = (await objContext_create(
          "ChRISDirsContext",
          `folder:${path}`
        )) as ChRISEmbeddedResourceGroup<ChrisPathNode>;
        break;
      default:
        errorStack.stack_push("error", `Unsupported asset type: ${assetName}`);
        return null;
    }

    if (!chrisFileSystemGroup) {
      errorStack.stack_push("error", `Failed to initialize ChRIS context for ${assetName} at ${path}`);
      return null;
    }
  } catch (error: unknown) {
    errorStack.stack_push("error", `Error creating ChRISEmbeddedResourceGroup for ${assetName}: ${error}`);
    return null;
  }

  return chrisFileSystemGroup;
}

/**
 * List files, links, or directories based on options.
 *
 * @param options - Search and pagination options.
 * @param assetName - The type of asset to list ('files', 'links', 'dirs').
 * @param path - Optional ChRIS path. Defaults to current folder context.
 * @returns A Promise resolving to FilteredResourceData or null.
 */
export async function files_list(options: ListOptions, assetName: string = "files", path?: string): Promise<FilteredResourceData | null> {
  const group: ChRISEmbeddedResourceGroup<ChrisPathNode> | null = await files_getGroup(assetName, path);
  if (!group) {
    return null;
  }
  return await group.asset.resources_listAndFilterByOptions(options);
}

/**
 * List *all* files, links, or directories by automatically handling pagination.
 *
 * @param options - Search options (limit and offset will be managed internally).
 * @param assetName - The type of asset to list ('files', 'links', 'dirs').
 * @param path - Optional ChRIS path. Defaults to current folder context.
 * @returns A Promise resolving to FilteredResourceData containing all matching assets, or null.
 */
export async function files_listAll(options: ListOptions, assetName: string = "files", path?: string): Promise<FilteredResourceData | null> {
  const outcome: ListingOutcome = await files_listOutcome(options, assetName, path);
  if (outcome.kind === "refused") throw outcome.error;
  return outcome.kind === "listing" ? outcome.data : null;
}

/**
 * What a listing attempt came back as.
 *
 * `files_listAll` answers `null` for three different things — an empty
 * folder, a folder that is not there, and a folder the server would not
 * describe — and nothing above it can behave correctly on one word that
 * means all three (#462). This says which.
 */
export type ListingOutcome =
  /** The folder answered, with these entries (possibly none of them). */
  | { kind: "listing"; data: FilteredResourceData }
  /** The folder answered and holds nothing of this kind. */
  | { kind: "empty" }
  /** No such folder, or no context to resolve one against. */
  | { kind: "missing" }
  /** The folder exists as far as anyone knows; the server would not say. */
  | { kind: "refused"; error: Error };

/**
 * Lists files, links or directories, saying which of the three answers it got.
 *
 * The typed complement to {@link files_listAll}: same walk, same options, but
 * an empty folder, a missing one and a refusal are told apart. A caller that
 * renders a listing must use this — "nothing here" and "I could not read it"
 * look identical to an operator otherwise, and only one of them is true.
 *
 * @param options - Search options (limit and offset are managed internally).
 * @param assetName - The type of asset to list ('files', 'links', 'dirs').
 * @param path - Optional ChRIS path. Defaults to current folder context.
 * @returns Which answer the folder gave.
 */
export async function files_listOutcome(
  options: ListOptions,
  assetName: string = "files",
  path?: string,
): Promise<ListingOutcome> {
  const group: ChRISEmbeddedResourceGroup<ChrisPathNode> | null = await files_getGroup(assetName, path);
  if (!group) {
    return { kind: "missing" };
  }
  try {
    const data: FilteredResourceData | null = await group.asset.resources_getAll(options);
    if (data === null || !data.tableData) return { kind: "empty" };
    return { kind: "listing", data };
  } catch (error: unknown) {
    return { kind: "refused", error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/**
 * Lists every file, link or directory of a folder, or says it could not.
 *
 * The strict counterpart of {@link files_listOutcome}, for an act that
 * destroys or overwrites on the strength of what a folder holds. That
 * listing is made for showing: a page it cannot read ends its walk with the
 * rows it has, and an answer that is no list at all reads as `empty`. Here
 * the whole collection is walked (cumin's `resources_getWhole`), and a page
 * that could not be fetched, is not a list, or carries no items is `refused`.
 *
 * @param assetName - The type of asset to list ('files', 'links', 'dirs').
 * @param path - The absolute ChRIS path of the folder.
 * @returns `listing` with every row, `empty` when the folder answered in
 *   full and holds none of this kind, `missing` when no listing could be
 *   made for the path, `refused` when the walk failed.
 *
 * @example
 * ```ts
 * const files: ListingOutcome = await files_listWhole('files', '/home/ada/uploads');
 * const proved: boolean = files.kind === 'listing' || files.kind === 'empty';
 * ```
 */
export async function files_listWhole(assetName: string, path: string): Promise<ListingOutcome> {
  const group: ChRISEmbeddedResourceGroup<ChrisPathNode> | null = await files_getGroup(assetName, path);
  if (!group) {
    return { kind: "missing" };
  }
  try {
    const data: FilteredResourceData = await group.asset.resources_getWhole();
    return data.tableData.length === 0 ? { kind: "empty" } : { kind: "listing", data };
  } catch (error: unknown) {
    return { kind: "refused", error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/**
 * Get the list of available fields for files, links, or directories.
 *
 * @param assetName - The type of asset ('files', 'links', 'dirs').
 * @returns A Promise resolving to an array of field names or null.
 */
export async function fileFields_get(assetName: string = "files"): Promise<string[] | null> {
  const group: ChRISEmbeddedResourceGroup<ChrisPathNode> | null = await files_getGroup(assetName);
  if (!group) {
    return null;
  }
  const results = await group.asset.resourceFields_get();
  return results ? results.fields : null;
}

/**
 * Deletes a file, link, or directory by its ID.
 *
 * @param id - The ID of the asset to delete.
 * @param assetName - The type of asset ('files', 'links', 'dirs').
 * @returns A Promise resolving to true on success, false on failure.
 */
export async function files_delete(
  id: number,
  assetName: string = "files",
  parentPath?: string,
): Promise<boolean> {
  // The group must be anchored at the item's parent folder: deletion looks
  // the id up in that folder's loaded collection, so falling back to the
  // ambient folder context only works when the caller's cwd happens to be
  // the parent. Callers that know the path must pass it.
  const group: ChRISEmbeddedResourceGroup<ChrisPathNode> | null = await files_getGroup(assetName, parentPath);
  if (!group) {
    return false;
  }
  // A file is deleted by its id, not by finding it in a listing first: the
  // folder whose listing the server refuses is exactly the one an operator
  // needs to clear, and a delete that walks the parent cannot help there
  // (#462). Other asset kinds still resolve through the group.
  if (assetName === "files") {
    const removed: Result<boolean> = await chrisIO.file_deleteById(id);
    return removed.ok && removed.value;
  }
  // A freshly created group has no loaded collection, and deletion resolves
  // the id against the loaded list; load it explicitly so deleting works
  // without depending on a prior listing of the same folder.
  await group.asset.resources_getAll({ limit: 1000, offset: 0 });
  return await group.asset.resourceItem_delete(id);
}

/**
 * Deletes a folder (and its contents) addressed by CUBE path.
 *
 * The path-addressed complement to `files_delete`: no id lookup, no ambient
 * folder context, and the call returns only once the CUBE confirms the
 * folder no longer resolves (server-side deletion is asynchronous).
 *
 * @param path - The folder's CUBE path (e.g. `/home/alice/scratch`).
 * @param options - `timeoutMs` bounds the disappearance poll (default 10s).
 * @returns True when the folder is verifiably gone (or never existed).
 */
export async function folderByPath_delete(
  path: string,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const result: Result<boolean> = await chrisIO.folder_deleteByPath(path, options);
  return result.ok;
}

/**
 * Creates a ChRISEmbeddedResourceGroup for a single file.
 * This function encapsulates the logic from `FileController.member_create`.
 *
 * @param path - The ChRIS path to the file.
 * @returns A Promise resolving to a ChRISEmbeddedResourceGroup instance, or null on error.
 */
export async function files_getSingle(
  path: string
): Promise<ChRISEmbeddedResourceGroup<ChrisPathNode> | null> {
  let chrisFilesGroup: ChRISEmbeddedResourceGroup<ChrisPathNode> | null = null;
  try {
    chrisFilesGroup = (await objContext_create(
      "ChRISFilesContext",
      `folder:${path}`
    )) as ChRISEmbeddedResourceGroup<ChrisPathNode>;

    if (!chrisFilesGroup) {
      errorStack.stack_push("error", `Failed to create ChRISFilesContext for path: ${path}`);
      return null;
    }
  } catch (error: unknown) {
    errorStack.stack_push("error", `Error creating ChRISFilesContext for path ${path}: ${error}`);
    return null;
  }
  return chrisFilesGroup;
}


/**
 * Shares files in ChRIS.
 *
 * @param fileId - The ID of the file to share.
 * @param options - Options for sharing (e.g., user, permissions).
 * @returns A Promise resolving to true.
 */
export async function files_share(fileId: number, options: FileShareOptions): Promise<boolean> {
  // Implement actual sharing logic using cumin/chrisapi
  runtimeOutput_data(`Sharing file ${fileId} with options: ${JSON.stringify(options)}\n`);
  return Promise.resolve(true);
}

/**
 * Retrieves the content of a file by its path.
 *
 * Router function that delegates to specialized handlers based on path type.
 *
 * @param filePath - The full ChRIS path to the file.
 * @returns A Result containing the content string or error.
 */
export async function fileContent_get(filePath: string): Promise<Result<string>> {
  const provider = vfsDispatcher.provider_get(filePath);
  if (provider && provider.prefix !== '') {
    return vfsOutcome_convertToResult(await vfsDispatcher.read(filePath), 'read', filePath);
  }
  if (filePath.startsWith('/PIPELINES/')) {
    return fileContent_getPipeline(filePath);
  }
  if (filePath.startsWith('/SERVICES/PACS/')) {
    return fileContent_getPACS(filePath);
  }
  return fileContent_getRegular(filePath);
}

/**
 * Retrieves the binary content of a file by its path.
 *
 * Router function that delegates to specialized handlers based on path type.
 * Returns raw Buffer instead of converting to UTF-8 string.
 *
 * @param filePath - The full ChRIS path to the file.
 * @returns A Result containing the content Buffer or error.
 */
export async function fileContent_getBinary(filePath: string): Promise<Result<Buffer>> {
  const provider = vfsDispatcher.provider_get(filePath);
  if (provider && provider.prefix !== '') {
    return vfsOutcome_convertToResult(await vfsDispatcher.readBinary(filePath), 'readBinary', filePath);
  }
  if (filePath.startsWith('/PIPELINES/')) {
    return fileContent_getPipelineBinary(filePath);
  }
  if (filePath.startsWith('/SERVICES/PACS/')) {
    return fileContent_getPACSBinary(filePath);
  }
  return fileContent_getRegularBinary(filePath);
}

/**
 * Retrieves the binary content of a file by its path as a stream/blob.
 *
 * Router function that delegates to specialized handlers based on path type.
 *
 * @param filePath - The full ChRIS path to the file.
 * @returns A Result containing the stream/blob and metadata or error.
 */
export async function fileContent_getBinaryStream(
  filePath: string
): Promise<Result<{ stream: unknown; size?: number; filename?: string }>> {
  const provider = vfsDispatcher.provider_get(filePath);
  if (provider && provider.prefix !== '') {
    const res: Result<Buffer> = vfsOutcome_convertToResult(await vfsDispatcher.readBinary(filePath), 'readBinary', filePath);
    return res.ok ? Ok({ stream: res.value, size: res.value.length }) : Err();
  }
  if (filePath.startsWith('/PIPELINES/')) {
    return fileContent_getPipelineBinary(filePath).then((res: Result<Buffer>) => {
      if (res.ok) {
        return Ok({ stream: res.value, size: res.value.length });
      }
      return Err();
    });
  }
  if (filePath.startsWith('/SERVICES/PACS/')) {
    return fileContent_getPACSBinary(filePath).then((res: Result<Buffer>) => {
      if (res.ok) {
        return Ok({ stream: res.value, size: res.value.length });
      }
      return Err();
    });
  }
  return fileContent_getRegularStream(filePath);
}
