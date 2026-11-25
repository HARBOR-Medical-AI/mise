/**
 * @file Upload command implementation.
 * @module
 */
import fs from "fs";
import path from "path";

import chalk from "chalk";
import { glob } from "glob";

import { chrisIO, TRANSFER_JOBS_DEFAULT, transferPool_run, type TransferPoolResult, type TransferSettled } from "@fnndsc/cumin";
import { files_uploadPath, pathHolders_prove, type PathHolderRecord, type PathProof } from "@fnndsc/salsa";
import { errorStack, type Result, type StackMessage } from "@fnndsc/fond";
import { chiliLog } from "../../screen/output.js";
import { prompt_confirmOrThrow } from "../../utils/input_format.js";
import { path_resolveChrisFs } from "../../utils/cli.js";

/**
 * File information for upload tracking.
 */
export interface UploadFileInfo {
  hostPath: string;
  chrisPath: string;
  size: number;
}

/**
 * Upload summary statistics.
 */
export interface UploadSummary {
  startTime: number;
  endTime: number;
  totalFiles: number;
  transferredCount: number;
  failedCount: number;
  transferSize: number;
  duration: number;
  speed: number;
  actualTargetPath: string; // The actual path where files were uploaded
  /** The local paths that failed after their retry, in the order they ended. */
  failedPaths: string[];
  /** Files a cancel left unuploaded. */
  cancelledCount: number;
}

/** Upload progress fact emitted to callers that want to render progress. */
export interface UploadProgressEvent {
  operation: "upload";
  kind: "transfer";
  phase: "scanning" | "transferring" | "complete" | "failed";
  label?: string;
  current?: number;
  total?: number;
  percent?: number;
  unit?: "files";
  status?: "running" | "done" | "error";
}

/** Options for upload execution. */
export interface UploadOptions {
  force?: boolean;
  /** Whether the host-local source word contained unquoted glob syntax. */
  expandLocalGlob?: boolean;
  /** Confirms replacement of an existing upload directory target. */
  confirm?: (message: string) => Promise<void>;
  /** Reports a live transfer notice on the caller's chosen output channel. */
  onNotice?: (message: string, channel: "status" | "err") => void;
  onProgress?: (event: UploadProgressEvent) => void;
  /** How many files move at once; the transfer pool's default when absent. */
  jobs?: number;
  /** The line's abort signal: a cancel starts no more files. */
  signal?: AbortSignal;
}

/**
 * Emits a live upload notice through the caller's output boundary.
 *
 * @param options - Upload options that may own live presentation.
 * @param message - Unstyled user-facing notice.
 * @param channel - Semantic output channel for the notice.
 * @returns Nothing.
 */
function uploadNotice_emit(
  options: UploadOptions,
  message: string,
  channel: "status" | "err",
): void {
  if (options.onNotice) {
    options.onNotice(message, channel);
    return;
  }
  const styled: string = channel === "err" ? chalk.red(message) : chalk.cyan(message);
  chiliLog(styled);
}

/**
 * Formats bytes into human-readable format.
 * @param bytes - Number of bytes.
 * @returns Formatted string (e.g., "1.23 MB").
 */
export function bytes_format(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k: number = 1024;
  const sizes: string[] = ["B", "KB", "MB", "GB", "TB"];
  const i: number = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Formats seconds into a human-friendly ETA string.
 * @param seconds - Remaining seconds.
 */
export function eta_format(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "--";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const hrs: number = Math.floor(seconds / 3600);
  const mins: number = Math.floor((seconds % 3600) / 60);
  const secs: number = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}h ${mins}m ${secs}s`;
  }
  return `${mins}m ${secs}s`;
}

/**
 * Formats a bytes-per-second rate into human-readable string.
 * @param rateBytesPerSec - Rate in bytes per second.
 */
export function rate_format(rateBytesPerSec: number): string {
  if (!Number.isFinite(rateBytesPerSec) || rateBytesPerSec <= 0) return "--";
  return `${bytes_format(rateBytesPerSec)}/s`;
}

/**
 * Expands one host-local source path or glob pattern.
 *
 * An exact existing path takes precedence over pattern interpretation so a
 * literal filename containing glob metacharacters remains addressable.
 *
 * @param localPattern - The local filesystem path or glob pattern.
 * @returns Matching host-local paths in deterministic order.
 * @throws If the exact path cannot be read or the pattern has no matches.
 */
async function localPaths_expand(localPattern: string, expandLocalGlob: boolean): Promise<string[]> {
  try {
    await fs.promises.stat(localPattern);
    return [localPattern];
  } catch (error: unknown) {
    const isNotFound: boolean = typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ENOENT';
    if (!isNotFound) {
      throw error;
    }
  }

  if (!expandLocalGlob) {
    throw new Error(`No local file exists at '${localPattern}'`);
  }

  const matches: string[] = await glob(localPattern, { dot: false });

  if (matches.length === 0) {
    throw new Error(`No local files matched '${localPattern}'`);
  }

  return matches.sort();
}

/**
 * Recursively scans local files and directories for upload.
 * @param localPaths - The local filesystem paths to scan.
 * @param remotePath - The target ChRIS path.
 * @returns Array of UploadFileInfo objects.
 */
async function localFiles_scan(localPaths: readonly string[], remotePath: string): Promise<UploadFileInfo[]> {
  const files: UploadFileInfo[] = [];

  async function walkDir(currentLocal: string, currentRemote: string): Promise<void> {
    const entries: fs.Dirent<string>[] = await fs.promises.readdir(currentLocal, { withFileTypes: true });

    for (const entry of entries) {
      const localFilePath: string = path.join(currentLocal, entry.name);
      const remoteFilePath: string = currentRemote.endsWith('/')
        ? currentRemote + entry.name
        : currentRemote + '/' + entry.name;

      if (entry.isDirectory()) {
        await walkDir(localFilePath, remoteFilePath);
      } else {
        const stats: fs.Stats = await fs.promises.stat(localFilePath);
        files.push({
          hostPath: localFilePath,
          chrisPath: remoteFilePath,
          size: stats.size,
        });
      }
    }
  }

  for (const localPath of localPaths) {
    const stats: fs.Stats = await fs.promises.stat(localPath);
    if (stats.isDirectory()) {
      // Preserve each directory basename in the remote path (Unix cp semantics).
      const basename: string = path.basename(localPath);
      const targetDir: string = remotePath.endsWith('/')
        ? remotePath + basename
        : remotePath + '/' + basename;
      await walkDir(localPath, targetDir);
    } else {
      const filename: string = path.basename(localPath);
      const targetPath: string = remotePath.endsWith('/')
        ? remotePath + filename
        : remotePath + '/' + filename;
      files.push({
        hostPath: localPath,
        chrisPath: targetPath,
        size: stats.size,
      });
    }
  }

  return files;
}

/**
 * Uploads one scanned file to its ChRIS path.
 *
 * @param file - The local file and its ChRIS path.
 * @returns The bytes sent.
 * @throws {Error} When CUBE did not take it, with the reasons the upload
 *   noted, so the transfer pool tries it again and then names it.
 */
async function uploadFile_send(file: UploadFileInfo): Promise<number> {
  const fileContent: NonSharedBuffer = await fs.promises.readFile(file.hostPath);
  const fileBlob: Blob = new Blob([new Uint8Array(fileContent)]);
  const lastSlash: number = file.chrisPath.lastIndexOf('/');
  const dir: string = file.chrisPath.substring(0, lastSlash) || '/';
  const filename: string = file.chrisPath.substring(lastSlash + 1);
  const since: number = errorStack.checkpoint_mark();
  if (!await chrisIO.file_upload(fileBlob, dir, filename)) {
    const reasons: string = errorStack.checkpoint_drain(since)
      .map((note: StackMessage): string => note.message.replace(/^\[[^\]]*\]\s*\|\s*/, '').trim())
      .filter((line: string): boolean => line.length > 0)
      .join('; ');
    throw new Error(reasons.length > 0 ? reasons : "CUBE did not take it");
  }
  return fileContent.length;
}

/**
 * Where each folder among the sources lands in ChRIS.
 *
 * A folder keeps its own name under the destination, as `cp -r` does; a
 * file goes into the destination and has no target folder of its own.
 *
 * @param localPaths - The sources on this machine, files and folders.
 * @param remotePath - The resolved ChRIS destination.
 * @returns The ChRIS path of each folder source, in the order given. Empty
 *   when no source is a folder.
 */
async function directoryTargets_derive(localPaths: readonly string[], remotePath: string): Promise<string[]> {
  const targets: string[] = [];
  for (const localPath of localPaths) {
    if (!(await fs.promises.stat(localPath)).isDirectory()) continue;
    const basename: string = path.basename(localPath);
    targets.push(remotePath.endsWith('/') ? remotePath + basename : `${remotePath}/${basename}`);
  }
  return targets;
}

/**
 * Settles, for every folder about to be uploaded, that its place in ChRIS
 * is free or that the operator agrees to merge into what is there.
 *
 * Nothing here is caught. The question was once asked inside a `try` whose
 * `catch` meant "the listing failed, carry on", so a "no", and a prompt that
 * could not be shown, were both swallowed and the upload went ahead. A place
 * that cannot be checked is not a free place either: only proved absence,
 * or a yes, lets a folder through.
 *
 * @param targets - The ChRIS path each folder source lands at.
 * @param options - The upload's options, for the injected confirmation.
 * @returns Nothing: it returns when every target is settled.
 * @throws {Error} When a target could not be checked, when a file or a link
 *   holds a target's path, when the operator declines, or when the question
 *   cannot be asked. Nothing has been sent in any of these cases.
 */
async function directoryTargets_confirm(targets: readonly string[], options: UploadOptions): Promise<void> {
  for (const target of targets) {
    const since: number = errorStack.checkpoint_mark();
    const proof: Result<PathProof> = await pathHolders_prove(target);
    if (!proof.ok) {
      const reasons: string = errorStack.checkpoint_drain(since)
        .map((note: StackMessage): string => note.message.replace(/^\[[^\]]*\]\s*\|\s*/, '').trim())
        .filter((line: string): boolean => line.length > 0)
        .join('; ');
      throw new Error(`Cannot tell whether '${target}' is already in ChRIS${reasons.length > 0 ? ` (${reasons})` : ''}. Nothing was uploaded.`);
    }
    if (proof.value.kind === 'absent') continue;
    const other: PathHolderRecord | undefined = proof.value.holders.find((holder: PathHolderRecord): boolean => holder.kind !== 'dir');
    if (other !== undefined) {
      throw new Error(`A ${other.kind} already holds '${target}' in ChRIS, and a folder cannot be uploaded onto it. Nothing was uploaded.`);
    }
    const message: string = `Target '${target}' already exists in ChRIS. Merge/overwrite? (y/N)`;
    if (options.confirm) {
      await options.confirm(message);
    } else {
      await prompt_confirmOrThrow(message);
    }
  }
}

/**
 * Uploads files and optionally emits structured progress events.
 * @param localPath - Local path (file or directory) or a host-local glob.
 * @param remotePath - Remote ChRIS path.
 * @param options - Upload options, including an optional progress callback.
 * @returns Promise<UploadSummary> with upload statistics.
 * @throws {Error} Before anything is sent, when a folder's place in ChRIS
 *   could not be checked, is held by a file or a link, or the operator
 *   declined to merge into it (`directoryTargets_confirm`).
 */
export async function files_uploadWithProgress(
  localPath: string,
  remotePath: string,
  options: UploadOptions = {}
): Promise<UploadSummary> {
  const resolvedRemote: string = await path_resolveChrisFs(remotePath, {});
  const localPaths: string[] = await localPaths_expand(localPath, options.expandLocalGlob ?? true);

  // Scan files
  uploadNotice_emit(options, "Scanning files to upload...", "status");
  options.onProgress?.({
    operation: "upload",
    kind: "transfer",
    phase: "scanning",
    label: "Scanning files to upload",
    status: "running",
  });
  const fileList: UploadFileInfo[] = await localFiles_scan(localPaths, resolvedRemote);

  // Determine actual target path (where files will be uploaded)
  let actualTarget: string = resolvedRemote;
  if (localPaths.length === 1) {
    const stats: fs.Stats = await fs.promises.stat(localPaths[0]);
    if (stats.isDirectory()) {
      const basename: string = path.basename(localPaths[0]);
      actualTarget = resolvedRemote.endsWith('/')
        ? resolvedRemote + basename
        : resolvedRemote + '/' + basename;
    }
  }

  // Asked and settled before the first file is sent: a "no" at the second
  // of two folders must not leave the first already uploaded.
  if (!options.force) {
    await directoryTargets_confirm(await directoryTargets_derive(localPaths, resolvedRemote), options);
  }

  // Upload files
  const summary: UploadSummary = {
    startTime: Date.now(),
    endTime: 0,
    totalFiles: fileList.length,
    transferredCount: 0,
    failedCount: 0,
    transferSize: 0,
    duration: 0,
    speed: 0,
    actualTargetPath: actualTarget,
    failedPaths: [],
    cancelledCount: 0,
  };

  options.onProgress?.({
    operation: "upload",
    kind: "transfer",
    phase: "transferring",
    label: "Uploading files",
    current: 0,
    total: fileList.length,
    percent: fileList.length === 0 ? 100 : 0,
    unit: "files",
    status: "running",
  });

  let settledCount: number = 0;
  const result: TransferPoolResult<UploadFileInfo, number> = await transferPool_run(fileList, uploadFile_send, {
    jobs: options.jobs ?? TRANSFER_JOBS_DEFAULT,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    onSettled: (settled: TransferSettled<UploadFileInfo, number>): void => {
      settledCount++;
      if (settled.ok) {
        summary.transferredCount++;
        summary.transferSize += settled.value;
      } else {
        summary.failedCount++;
        summary.failedPaths.push(settled.item.hostPath);
        uploadNotice_emit(options, `Error uploading ${settled.item.hostPath}: ${settled.reason}`, "err");
      }
      options.onProgress?.({
        operation: "upload",
        kind: "transfer",
        phase: "transferring",
        label: "Uploading files",
        current: settledCount,
        total: fileList.length,
        percent: fileList.length === 0 ? 100 : (settledCount / fileList.length) * 100,
        unit: "files",
        status: "running",
      });
    },
  });
  summary.cancelledCount = result.cancelled.length;

  summary.endTime = Date.now();
  summary.duration = (summary.endTime - summary.startTime) / 1000; // seconds
  summary.speed = summary.transferSize / summary.duration; // bytes per second

  options.onProgress?.({
    operation: "upload",
    kind: "transfer",
    phase: summary.failedCount === 0 && summary.cancelledCount === 0 ? "complete" : "failed",
    label: "Upload complete",
    current: summary.transferredCount,
    total: summary.totalFiles,
    percent: summary.totalFiles === 0 ? 100 : (summary.transferredCount / summary.totalFiles) * 100,
    unit: "files",
    status: summary.failedCount === 0 && summary.cancelledCount === 0 ? "done" : "error",
  });

  return summary;
}

/**
 * Uploads a local file or directory to ChRIS.
 *
 * @param localPath - Local path.
 * @param remotePath - Remote ChRIS path.
 * @returns Promise<boolean> true if successful.
 */
export async function files_upload(localPath: string, remotePath: string): Promise<boolean> {
  const resolvedRemote: string = await path_resolveChrisFs(remotePath, {});
  const localPaths: string[] = await localPaths_expand(localPath, true);

  for (const matchedPath of localPaths) {
    if (!await files_uploadPath(matchedPath, resolvedRemote)) {
      return false;
    }
  }

  return true;
}
