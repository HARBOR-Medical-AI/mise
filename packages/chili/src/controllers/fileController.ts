/**
 * @file Controller for file business logic and presentation.
 *
 * @module
 */

import { ChRISEmbeddedResourceGroup, errorStack, Result, ChrisPathNode } from "@fnndsc/cumin";
import chalk from 'chalk';
import { BaseController } from "./baseController.js";
import { CLIoptions } from "../utils/cli.js";
import {
  files_getGroup,
  files_getSingle,
  files_share as salsaFiles_share,
  fileContent_get,
  FileShareOptions
} from "@fnndsc/salsa";
import { chiliErrLog, chiliLog } from "../screen/output.js";

/**
 * Controller for managing ChRIS file system resources (files, links, directories).
 * Extends BaseController to provide file-specific functionality.
 * This class now acts as a CLI-specific adapter for the core file logic in Salsa.
 */
export class FileController extends BaseController {
  private _path: string;
  private _assetName: string;

  constructor(
    chrisObject: ChRISEmbeddedResourceGroup<ChrisPathNode>,
    path: string,
    assetName: string
  ) {
    super(chrisObject);
    this._path = path;
    this._assetName = assetName;
  }

  /**
   * Factory method to create a FileController for a specific asset type.
   * Now leverages `salsa`'s `files_getGroup`.
   *
   * @param assetName - The type of asset ('files', 'links', 'dirs').
   * @param path - Optional path. Defaults to current context.
   * @returns A Promise resolving to a new FileController instance, or null on error.
   * @throws Error if asset type is unsupported or context creation fails.
   */
  static async handler_create(
    assetName: string,
    path?: string
  ): Promise<FileController | null> {
    const chrisFileSystemGroup: ChRISEmbeddedResourceGroup<ChrisPathNode> | null = await files_getGroup(assetName, path);
    if (!chrisFileSystemGroup) {
      // Error handling is done in salsa, so we just pass null here
      return null;
    }
    
    // `folder` is a runtime property the group type does not declare.
    const folderValue: unknown = Reflect.get(chrisFileSystemGroup, 'folder');
    const effectivePath: string = path || (typeof folderValue === 'string' ? folderValue : "");
    
    return new FileController(chrisFileSystemGroup, effectivePath, assetName);
  }

  /**
   * Factory method to create a FileController for a single file.
   * Now leverages `salsa`'s `files_getSingle`.
   *
   * @param path - The path to the file.
   * @returns A Promise resolving to a new FileController, or null on error.
   * @throws Error if context creation fails.
   */
  static async member_create(path: string): Promise<FileController | null> {
    const chrisFilesGroup: ChRISEmbeddedResourceGroup<ChrisPathNode> | null = await files_getSingle(path);
    if (!chrisFilesGroup) {
      // Error handling is done in salsa, so we just pass null here
      return null;
    }
    return new FileController(chrisFilesGroup, path, "file");
  }

  /**
   * Shares files using `salsa`'s logic.
   *
   * @param options - CLI options for sharing. Expected to contain `fileId` and other sharing parameters.
   * @returns A Promise resolving to void.
   */
  async files_share(options: CLIoptions): Promise<void> {
    const fileId: unknown = options.fileId; // Assuming CLIoptions has a fileId property
    if (fileId === undefined) {
      chiliErrLog("Error: fileId is required for sharing.");
      return;
    }
    const shareOptions: FileShareOptions = { ...options }; // Pass all CLI options as share options for now
    const shared: boolean = await salsaFiles_share(fileId as number, shareOptions);
    if (!shared) chiliErrLog(`Error: ${errorStack.stack_pop()?.message ?? 'the file was not shared.'}`);
  }

  /**
   * Views content of a file using `salsa`'s logic.
   *
   * @param options - CLI options for viewing. Expected to contain `fileId` and other viewing parameters.
   * @returns A Promise resolving to void (output is handled by salsa or logged).
   */
  async file_view(filePath: string): Promise<void> {
    const result: Result<string> = await fileContent_get(filePath);
    if (!result.ok) {
        const error = errorStack.stack_pop();
        chiliErrLog(chalk.red(`Error viewing file: ${error?.message || 'Unknown error'}`));
        return;
    }
    chiliLog(result.value);
  }

  /**
   * Gets the current path associated with this controller.
   * @returns The path string.
   */
  get path_get(): string {
    return this._path;
  }
}
