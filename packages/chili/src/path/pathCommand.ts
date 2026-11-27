/**
 * @file Path scan/transfer commands and the recursive ChRIS path scanner.
 *
 * @module
 */

import { Command } from "commander";
import {
  chrisIO,
  ChrisIO,
  chrisContext,
  Context,
  errorStack,
  ChRISEmbeddedResourceGroup,
  objContext_create,
  Result,
} from "@fnndsc/cumin";
import { vfsDispatcher, VFSItem } from "@fnndsc/salsa";
import chalk from "chalk";
import fs from "fs";
import path from "path";
import cliProgress from "cli-progress";
import { table_display, border_draw, TableOptions } from "../screen/screen.js";
import { options_convertToParams } from "../utils/cli.js";
import archy from "archy";
import open from "open";
import { execFile } from "child_process";
import os from "os";
import { files_downloadWithProgress, DownloadSummary } from "../commands/fs/download.js";
import { chiliErrLog, chiliLog } from "../screen/output.js";

interface TransferCLI {
  hostpath: string;
  force?: boolean;
}

interface DownloadCLI {
  hostdir: string;
  chrisdir: string;
}

interface FileInfo {
  id: number;
  hostPath: string;
  chrisPath: string;
  size: number;
  isLink: boolean;
  linkTarget: string;
  isDirectory: boolean;
}

/**
 * Aggregated result of a recursive ChRIS path scan.
 */
export interface ScanRecord {
  fileInfo: FileInfo[];
  totalSize: number;
}

interface DirWalkResult {
  files: FileInfo[];
  totalSize: number;
}

interface TransferDetail {
  startTime: number;
  endTime: number;
  totalFiles: number;
  transferredCount: number;
  failedCount: number;
  transferSize: number;
  speed: number;
  duration: number;
}

interface Tranmission {
  speed: number;
  duration: number;
}

/**
 * CLI options controlling a path scan or transfer.
 */
export interface CLIscan {
  tree?: boolean;
  follow?: boolean;
  silent?: boolean;
  hostpath?: string;
  dirsOnly?: boolean;
  filter?: string;
  endsWith?: string;
  mermaid?: boolean;
  save?: string;
  /** Stops traversal between CUBE listing operations when aborted. */
  signal?: AbortSignal;
  /** The folder to scan; the context's folder when absent. */
  folder?: string;
}

/**
 * Raised internally to stop a recursive scan without recording a scan failure.
 */
class ScanCancelledError extends Error {}

/**
 * Stops traversal when the calling foreground command requested cancellation.
 *
 * @param signal - Foreground command signal, when the caller supports cancellation.
 * @returns Nothing.
 * @throws {ScanCancelledError} When the signal has been aborted.
 */
function scanCancellation_throwIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ScanCancelledError('Scan cancelled.');
}

/**
 * Creates a summary table for file transfer details.
 *
 * @param summary - The TransferDetail object containing transfer statistics.
 * @returns A 2D array representing the summary table.
 */
function summaryTable_create(summary: TransferDetail): string[][] {
  const summaryTable: string[][] = [
    ["Total files", summary.totalFiles.toString()],
    [
      "Successfully transferred",
      chalk.green(summary.transferredCount.toString()),
    ],
    ["Failed to transfer", chalk.red(summary.failedCount.toString())],
    [
      "Total data transferred",
      chalk.blueBright(bytes_format(summary.transferSize)),
    ],
    [
      "Average transfer speed",
      chalk.blueBright(`${bytes_format(summary.speed)}/s`),
    ],
    ["Duration", `${summary.duration.toFixed(2)} seconds`],
  ];

  return summaryTable;
}


/**
 * Generates a Mermaid diagram definition from a scan result.
 *
 * @param scanResult - The ScanRecord containing file information.
 * @returns The Mermaid diagram definition string.
 */
function mermaidDefinition_generate(scanResult: ScanRecord): string {
  let definition: string = "graph TD\n";
  definition += "    %% Styles\n";
  definition +=
    "    classDef default fill:#f9f,stroke:#333,stroke-width:2px;\n";
  definition += "    classDef root fill:#ff9,stroke:#333,stroke-width:4px;\n";
  definition += "    classDef leaf fill:#9f9,stroke:#333,stroke-width:2px;\n\n";

  const nodes: Map<string, number> = new Map<string, number>();
  const edges: Set<string> = new Set<string>();
  let nodeCounter: number = 0;

  function nodeId_getOrCreate(path: string): number {
    if (!nodes.has(path)) {
      nodes.set(path, nodeCounter++);
    }
    return nodes.get(path)!;
  }

  const leafNodes: Set<number> = new Set<number>();

  scanResult.fileInfo.forEach((file) => {
    const parts: string[] = file.chrisPath.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const parentPath: string = "/" + parts.slice(0, i).join("/");
      const currentPath: string = "/" + parts.slice(0, i + 1).join("/");

      const parentNode: number = nodeId_getOrCreate(parentPath);
      const currentNode: number = nodeId_getOrCreate(currentPath);

      const edge: string = `${parentNode} --> ${currentNode}`;
      if (!edges.has(edge)) {
        edges.add(edge);
        definition += `    ${parentNode}[${parts[i - 1]}] --> ${currentNode}[${
          parts[i]
        }]
`;
      }

      if (i === parts.length - 1) {
        leafNodes.add(currentNode);
      }
    }
  });

  // Apply styles
  definition += "\n    %% Applying styles\n";
  definition += `    class ${nodeId_getOrCreate("/")} root;\n`;
  leafNodes.forEach((nodeId) => {
    definition += `    class ${nodeId} leaf;\n`;
  });

  return definition;
}

/**
 * Generates an HTML page for displaying a Mermaid diagram.
 *
 * @param mermaidDefinition - The Mermaid diagram definition string.
 * @returns The HTML content as a string.
 */
function mermaidHtml_generate(mermaidDefinition: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Plugin DAG</title>
    <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
</head>
<body>
    <div class="mermaid">
    ${mermaidDefinition}
    </div>
    <script>
        mermaid.initialize({ startOnLoad: true });
    </script>
</body>
</html>
  `;
}

/**
 * Renders a Mermaid diagram in a browser window.
 *
 * @param mermaidDefinition - The Mermaid diagram definition string.
 */
async function mermaid_renderInBrowser(mermaidDefinition: string) {
  const html: string = mermaidHtml_generate(mermaidDefinition);
  const tempDir: string = os.tmpdir();
  const filePath: string = path.join(tempDir, "mermaid-diagram.html");
  fs.writeFileSync(filePath, html);
  await open(filePath);
}

/**
 * Renders a Mermaid diagram on the server-side and saves it to a file.
 * Requires `mmdc` (Mermaid CLI) to be installed.
 *
 * @param mermaidDefinition - The Mermaid diagram definition string.
 * @param outputFile - The path to save the output file.
 * @returns A Promise resolving to the output file path.
 */
async function mermaid_renderServerSide(
  mermaidDefinition: string,
  outputFile: string
): Promise<string> {
  const tempDir: string = os.tmpdir();
  const inputFile: string = path.join(tempDir, "input.mmd");

  fs.writeFileSync(inputFile, mermaidDefinition);

  // Pass args as an array (execFile, no shell) so a user-supplied --save path
  // cannot inject shell commands. Requires `mmdc` (@mermaid-js/mermaid-cli),
  // which is fetched on demand via npx and is not a hard dependency.
  return new Promise((resolve, reject) => {
    execFile(
      "npx",
      ["mmdc", "-i", inputFile, "-o", outputFile],
      (error) => {
        if (error) {
          chiliErrLog(
            `Mermaid render failed. Ensure @mermaid-js/mermaid-cli is available (npx mmdc): ${error.message}`
          );
          reject(error);
          return;
        }
        resolve(outputFile);
      }
    );
  });
}

/**
 * Creates an Archy-formatted tree structure from file information.
 *
 * @param files - An array of FileInfo objects.
 * @returns The Archy-formatted tree string.
 */
export function archyTree_create(files: FileInfo[]): string {
  interface ArchyNode {
    label: string;
    nodes: { [key: string]: ArchyNode };
  }

  const root: ArchyNode = { label: "", nodes: {} };

  files.forEach((file: FileInfo) => {
    if (file.chrisPath) {
      const parts: string[] = file.chrisPath.split("/").filter(Boolean);
      let current: ArchyNode = root;
      parts.forEach((part: string, index: number) => {
        if (!current.nodes[part]) {
          current.nodes[part] = { label: part, nodes: {} };
        }
        current = current.nodes[part];
        if (index === parts.length - 1 && file.isLink) {
          current.label += ` -> ${file.linkTarget}`;
        }
      });
    }
  });

  function archyFormat_convert(node: ArchyNode): archy.Data {
    return {
      label: node.label,
      nodes: Object.values(node.nodes).map(archyFormat_convert),
    };
  }

  return archy(archyFormat_convert(root));
}




async function chrisDir_walk(
  currentPath: string,
  chrisPath: string,
  hostBasePath: string,
  followLinks: boolean,
  dirsOnly: boolean,
  linkedPath: string = "",
  signal: AbortSignal | undefined = undefined,
): Promise<DirWalkResult> {
  scanCancellation_throwIfRequested(signal);
  const listResult: Result<VFSItem[]> = await vfsDispatcher.list(currentPath);
  scanCancellation_throwIfRequested(signal);
  if (!listResult.ok) {
    // An unlistable subtree must not scan as an empty one: a transfer built
    // on this walk would silently omit the subtree and still report success.
    errorStack.stack_push("error", `scan: cannot list ${currentPath}; its contents are excluded from this operation.`);
    return { files: [], totalSize: 0 };
  }
  const items: VFSItem[] = listResult.value || [];

  const dirs: VFSItem[] = items.filter((item) => item.type === "dir" || item.type === "vfs" || item.type === "job");
  const normalFiles: VFSItem[] = items.filter((item) => item.type === "file");
  const links: VFSItem[] = items.filter((item) => item.type === "link");

  const files: FileInfo[] = [];
  let totalSize: number = 0;

  const dirInfos: FileInfo[] = dirs.map((dir) => {
    const fullPath: string = currentPath === "/" ? "/" + dir.name : path.join(currentPath, dir.name);
    const relativeChrisPath: string = linkedPath ? path.join(linkedPath, dir.name) : fullPath;
    return {
      id: 0,
      hostPath: path.join(hostBasePath, path.relative(chrisPath, relativeChrisPath)),
      chrisPath: relativeChrisPath,
      size: 0,
      isLink: false,
      linkTarget: "",
      isDirectory: true,
    };
  });
  files.push(...dirInfos);

  if (!dirsOnly) {
    const fileInfos: FileInfo[] = normalFiles.map((file) => {
      const fullPath: string = currentPath === "/" ? "/" + file.name : path.join(currentPath, file.name);
      const relativeChrisPath: string = linkedPath ? path.join(linkedPath, file.name) : fullPath;
      return {
        id: 0,
        hostPath: path.join(hostBasePath, path.relative(chrisPath, relativeChrisPath)),
        chrisPath: relativeChrisPath,
        size: file.size,
        isLink: !!linkedPath,
        linkTarget: linkedPath ? fullPath : "",
        isDirectory: false,
      };
    });
    files.push(...fileInfos);
    totalSize += fileInfos.reduce((sum, f) => sum + f.size, 0);

    const linkInfos: FileInfo[] = links.map((link) => {
      const fullPath: string = currentPath === "/" ? "/" + link.name : path.join(currentPath, link.name);
      const relativeChrisPath: string = linkedPath ? path.join(linkedPath, link.name) : fullPath;
      return {
        id: 0,
        hostPath: path.join(hostBasePath, path.relative(chrisPath, relativeChrisPath)),
        chrisPath: relativeChrisPath,
        isLink: true,
        linkTarget: link.target || "",
        size: 0,
        isDirectory: false,
      };
    });
    files.push(...linkInfos);

    if (followLinks) {
      for (const link of linkInfos) {
        scanCancellation_throwIfRequested(signal);
        const sub: DirWalkResult = await chrisDir_walk(
          link.linkTarget, chrisPath, hostBasePath, followLinks, dirsOnly, link.chrisPath, signal,
        );
        files.push(...sub.files);
        totalSize += sub.totalSize;
      }
    }
  }

  for (const dir of dirs) {
    scanCancellation_throwIfRequested(signal);
    const fullPath: string = currentPath === "/" ? "/" + dir.name : path.join(currentPath, dir.name);
    const nextLinkedPath: string = linkedPath ? path.join(linkedPath, dir.name) : "";
    const sub: DirWalkResult = await chrisDir_walk(
      fullPath, chrisPath, hostBasePath, followLinks, dirsOnly, nextLinkedPath, signal,
    );
    files.push(...sub.files);
    totalSize += sub.totalSize;
  }

  return { files, totalSize };
}

async function chrisFS_scan(
  chrisPath: string,
  hostBasePath: string,
  followLinks: boolean = false,
  dirsOnly: boolean = false,
  signal: AbortSignal | undefined = undefined,
): Promise<ScanRecord | null> {
  try {
    const result: DirWalkResult = await chrisDir_walk(
      chrisPath, chrisPath, hostBasePath, followLinks, dirsOnly, '', signal,
    );
    return { fileInfo: result.files, totalSize: result.totalSize };
  } catch (error: unknown) {
    if (error instanceof ScanCancelledError) return null;
    errorStack.stack_push("error", `Failed to scan ChRIS filesystem: ${error}`);
    return null;
  }
}

function scanResult_filter(scanResult: ScanRecord, options: CLIscan): ScanRecord {
  if (!options.filter && !options.endsWith) {
    return scanResult;
  }
  const keepPaths: Set<string> = new Set<string>();
  for (const file of scanResult.fileInfo) {
    scanCancellation_throwIfRequested(options.signal);
    const basename: string = path.basename(file.chrisPath);
    if (
      (!options.filter || file.chrisPath.includes(options.filter)) &&
      (!options.endsWith || basename.includes(options.endsWith))
    ) {
      let currentPath: string = file.chrisPath;
      while (currentPath !== "/") {
        keepPaths.add(currentPath);
        currentPath = path.dirname(currentPath);
      }
      keepPaths.add("/");
    }
  }
  const fileInfo: FileInfo[] = scanResult.fileInfo.filter((f) => keepPaths.has(f.chrisPath));
  return { fileInfo, totalSize: fileInfo.reduce((sum, f) => sum + f.size, 0) };
}

async function scanResult_render(scanResult: ScanRecord, options: CLIscan): Promise<void> {
  if (options.mermaid) {
    const mermaidDefinition: string = mermaidDefinition_generate(scanResult);
    if (options.save) {
      try {
        const outputFile: string = path.resolve(options.save);
        const savedFilePath: string = await mermaid_renderServerSide(mermaidDefinition, outputFile);
        chiliLog(`Mermaid diagram saved to: ${savedFilePath}`);
      } catch (error: unknown) {
        chiliErrLog(`Failed to save Mermaid diagram: ${error}`);
      }
    } else {
      await mermaid_renderInBrowser(mermaidDefinition);
    }
    return;
  }
  if (options.tree) {
    chiliLog(archyTree_create(scanResult.fileInfo));
    return;
  }
  if (!options.silent) {
    for (const file of scanResult.fileInfo) {
      if (file.isLink && !options.follow) {
        chiliLog(`${file.chrisPath} -> ${file.linkTarget}`);
      } else {
        chiliLog(`${file.chrisPath}`);
      }
    }
  }
}

/**
 * Performs a recursive scan of the current ChRIS folder.
 *
 * @param options - Scan options.
 * @returns The scan record, or null if no context is set.
 */
export async function scan_do(options: CLIscan): Promise<ScanRecord | null> {
  scanCancellation_throwIfRequested(options.signal);
  // A scan of a named folder never moves the shared context to it: another
  // line resolving paths meanwhile would stand there (#1273).
  const chrisFolder: string | null = options.folder ?? await chrisContext.current_get(
    Context.ChRISfolder
  );
  if (!chrisFolder) {
    chiliErrLog(chalk.red("No ChRIS folder context set. Use 'folder=' to set a context."));
    return null;
  }
  if (!options.silent) {
    chiliLog(chalk.cyan(`Scanning for ${options.dirsOnly ? "directories" : "all files"} recursively from ${chrisFolder}`));
  }
  const hostBasePath: string = options.hostpath || process.cwd();
  const scanResult: ScanRecord | null = await chrisFS_scan(
    chrisFolder, hostBasePath, options.follow, options.dirsOnly, options.signal,
  );
  scanCancellation_throwIfRequested(options.signal);
  if (!scanResult) {
    chiliErrLog(chalk.red("Failed to scan ChRIS filesystem."));
    return null;
  }
  const filtered: ScanRecord = scanResult_filter(scanResult, options);
  scanCancellation_throwIfRequested(options.signal);
  await scanResult_render(filtered, options);
  if (!options.silent) {
    chiliLog(chalk.green(`Total size: ${bytes_format(filtered.totalSize)}`));
    if (options.filter || options.endsWith) {
      chiliLog(chalk.cyan(`Filtered results: ${filtered.fileInfo.length} items`));
    }
  }
  return filtered;
}

/**
 * Recursively gets files from the host path to be uploaded to ChRIS.
 *
 * @param hostpath - The host system path to scan.
 * @param chrisdir - The target ChRIS directory path.
 * @returns A Promise resolving to an array of FileInfo objects for files to upload.
 */
async function filesToUpload_get(
  hostpath: string,
  chrisdir: string
): Promise<FileInfo[]> {
  const files: FileInfo[] = [];
  let idCounter: number = 1;

  async function dir_walk(
    currentPath: string,
    currentChrisPath: string
  ): Promise<void> {
    const entries: fs.Dirent[] = await fs.promises.readdir(currentPath, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const hostFilePath: string = path.join(currentPath, entry.name);
      const chrisFilePath: string = path.join(currentChrisPath, entry.name);

      if (entry.isDirectory()) {
        await dir_walk(hostFilePath, chrisFilePath);
      } else {
        files.push({
          id: idCounter++,
          hostPath: hostFilePath,
          chrisPath: chrisFilePath,
          isLink: false, // Assuming local files are not symlinks
          size: (await fs.promises.stat(hostFilePath)).size,
          linkTarget: "",
          isDirectory: false,
        });
      }
    }
  }

  // Preserve the basename of the source directory in the target path
  const hostBasename: string = path.basename(hostpath);
  await dir_walk(hostpath, path.join(chrisdir, hostBasename));
  return files;
}

/**
 * Scans the local filesystem for files to upload to ChRIS.
 *
 * @param options - TransferCLI options specifying the host path.
 * @returns A Promise resolving to a ScanRecord of local files, or null on error.
 */
async function localFS_scan(options: TransferCLI): Promise<ScanRecord | null> {
  await chrisContext.currentContext_update();
  const folder: string | null = chrisContext.singleContext.folder;
  if (!folder) {
    chiliErrLog("ChRIS folder context is undefined, cannot initialize chrisIO.");
    return null;
  }

  // Validate that the folder context exists in CUBE before proceeding
  try {
    const testGroup: ChRISEmbeddedResourceGroup<unknown> | null = await objContext_create("ChRISDirsContext", `folder:${folder}`);
    if (!testGroup) {
      chiliErrLog(chalk.red(`Folder context '${folder}' does not exist in CUBE. Please specify an existing directory.`));
      return null;
    }
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    chiliErrLog(chalk.red(`Cannot use folder '${folder}': ${msg}`));
    return null;
  }

  // Folder exists, so just set chrisFolder without calling init()
  // (init() tries to CREATE the folder which will fail if it already exists)
  chrisIO.chrisFolder = folder;

  chiliLog(border_draw(chalk.cyan("Scanning files to upload...")));
  const filesToUpload: FileInfo[] = await filesToUpload_get(
    options.hostpath,
    folder as string
  );

  let totalSize: number = 0;
  for (const file of filesToUpload) {
    if (file.hostPath) {
      const stats: fs.Stats = await fs.promises.stat(file.hostPath);
      totalSize += stats.size;
    }
  }
  return {
    fileInfo: filesToUpload,
    totalSize: totalSize,
  };
}

/**
 * Sets up and starts a CLI progress bar for file transfers.
 *
 * @param scanRecord - The ScanRecord containing total files and size.
 * @returns The initialized cliProgress.SingleBar instance.
 */
function progressBar_setupAndStart(
  scanRecord: ScanRecord
): cliProgress.SingleBar {
  const progressBar: cliProgress.SingleBar = new cliProgress.SingleBar(
    {
      format:
        "Transferring [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} files | {bytes}/{totalBytes}",
    },
    cliProgress.Presets.shades_classic
  );
  progressBar.start(scanRecord.fileInfo.length, 0, {
    bytes: "0 B",
    totalBytes: bytes_format(scanRecord.totalSize), // Renamed
  });
  return progressBar;
}

/**
 * Initializes a TransferDetail object.
 *
 * @returns An initialized TransferDetail object.
 */
function transferDetail_init(): TransferDetail {
  const uploadSummary: TransferDetail = {
    startTime: 0 as number,
    endTime: 0 as number,
    totalFiles: 0 as number,
    transferredCount: 0 as number,
    failedCount: 0 as number,
    transferSize: 0 as number,
    speed: 0 as number,
    duration: 0 as number,
  };
  return uploadSummary;
}

/**
 * Calculates transmission summary details (duration and speed).
 *
 * @param transfer - The TransferDetail object to update.
 * @returns A Tranmission object with calculated speed and duration.
 */
function transmissionSummary_get(transfer: TransferDetail): Tranmission {
  let transmission: Tranmission = {
    duration: 0,
    speed: 0,
  };
  transfer.endTime = Date.now();
  transmission.duration = (transfer.endTime - transfer.startTime) / 1000; // in seconds
  transmission.speed = transfer.transferSize / transmission.duration; // bytes per second
  return transmission;
}

/**
 * Pushes files from the local filesystem to ChRIS.
 *
 * @param scanRecord - The ScanRecord of files to push.
 * @param progressBar - The CLI progress bar instance.
 * @returns A Promise resolving to a TransferDetail object with push statistics.
 */
async function chris_push(
  scanRecord: ScanRecord,
  progressBar: cliProgress.SingleBar
): Promise<TransferDetail> {
  let summary: TransferDetail = transferDetail_init();
  summary.startTime = Date.now();

  for (const [index, file] of scanRecord.fileInfo.entries()) {
    try {
      if (!file.hostPath) {
        continue;
      }
      const fileContent: Buffer = await fs.promises.readFile(file.hostPath);
      const fileBlob: Blob = new Blob([new Uint8Array(fileContent)]);
      const uploadResult: boolean = await chrisIO.file_upload(
        fileBlob,
        path.dirname(file.chrisPath),
        path.basename(file.chrisPath)
      );

      if (uploadResult) {
        summary.transferredCount++;
        summary.transferSize += fileContent.length;
      } else {
        summary.failedCount++;
        chiliLog(chalk.yellow(`Failed to upload: ${file.hostPath}`));
      }
    } catch (error: unknown) {
      summary.failedCount++;
      chiliLog(
        chalk.red(
          `Error uploading ${file.hostPath}: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }

    progressBar.update(index + 1, {
      bytes: bytes_format(summary.transferSize), // Renamed
    });
  }
  const transmission: Tranmission = transmissionSummary_get(summary);
  progressBar.stop();

  summary.totalFiles = scanRecord.fileInfo.length;
  summary.duration = transmission.duration;
  summary.speed = transmission.speed;

  return summary;
}

/**
 * Downloads files from ChRIS to the local filesystem.
 *
 * @param options - TransferCLI options including host path.
 * @returns A Promise resolving to true if download was successful, false otherwise.
 */
async function download_handle(options: TransferCLI): Promise<boolean> { // Renamed
  await chrisContext.currentContext_update();
  const folder: string | null = chrisContext.singleContext.folder;
  if (!folder) {
    chiliErrLog(chalk.red("No ChRIS folder context set. Use 'connect' to establish a session."));
    return false;
  }

  const localTarget: string = path.resolve(options.hostpath || process.cwd());
  try {
    const summary: DownloadSummary = await files_downloadWithProgress(folder, localTarget, {
      force: options.force,
    });
    table_display(summaryTable_create(summary), ["Metric", "Value"], {
      title: { title: "Download summary", justification: "center" },
    });
    return summary.failedCount === 0;
  } catch (error: unknown) {
    const msg: string = error instanceof Error ? error.message : String(error);
    chiliErrLog(chalk.red(`Download failed: ${msg}`));
    return false;
  }
}

/**
 * Uploads files from the local filesystem to ChRIS.
 *
 * @param options - TransferCLI options including host path.
 * @returns A Promise resolving to true if upload was successful, false otherwise.
 */
async function upload_handle(options: TransferCLI): Promise<boolean> { // Renamed
  const scanRecord: ScanRecord | null = await localFS_scan(options);
  if (!scanRecord) {
    return false;
  }
  const progressBar: cliProgress.SingleBar =
    progressBar_setupAndStart(scanRecord);
  const summary: TransferDetail = await chris_push(scanRecord, progressBar);
  table_display(summaryTable_create(summary), ["Metric", "Value"], { // Renamed
    title: { title: "Upload summary", justification: "center" },
  });

  return summary.failedCount === 0;
}

/**
 * Formats a number of bytes into a human-readable string.
 *
 * @param bytes - The number of bytes.
 * @returns A formatted string (e.g., "1.23 MB").
 */
export function bytes_format(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k: number = 1024;
  const sizes: string[] = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
  const i: number = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Sets up the 'path' command for performing operations on ChRIS paths.
 *
 * @param program - The Commander.js program instance.
 */
export async function pathCommand_setup(program: Command): Promise<void> {
  const pathCommand: Command = program
    .command("path")
    .description("Perform operations on ChRIS paths");

  pathCommand
    .command("upload <hostpath>")
    .description(
      "upload the <hostpath> from your computer into the current ChRIS folder context"
    )
    .action(async (hostpath: string) => {
      const result: boolean = await upload_handle({ hostpath });
    });

  pathCommand
    .command("download [hostpath]")
    .description(
      "download the current ChRIS folder context to current dir or [hostdir]"
    )
    .option("-f, --force", "overwrite existing local path")
    .action(async (hostpath: string, options: { force?: boolean }) => {
      const result: boolean = await download_handle({
        hostpath: hostpath || process.cwd(),
        force: options.force,
      });
      chiliLog(result);
    });

  pathCommand
    .command("scan")
    .description(
      "scan and list all files recursively from the current ChRIS folder context"
    )
    .option("--tree", "present in a style reminiscent of the UNIX tree command")
    .option("--follow", "follow chrislinks")
    .option("--dirsOnly", "scan only directories")
    .option("--silent", "suppress output")
    .option("--hostpath <path>", "specify host path for file mapping")
    .option(
      "--filter <text>",
      "filter results to include only paths containing the specified text"
    )
    .option(
      "--endsWith <text>",
      "filter results to include only paths ending with the specified text"
    )
    .option("--mermaid", "render the result as a Mermaid.js diagram")
    .option(
      "--save <filename>",
      "save the Mermaid diagram to the specified file"
    )
    .action(async (options: CLIscan) => {
      await scan_do(options);
    });
}
