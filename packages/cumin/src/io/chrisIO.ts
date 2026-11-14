/**
 * @file ChRIS IO Operations
 *
 * This module handles file input/output operations with the ChRIS backend,
 * including downloading and uploading files.
 *
 * @module
 */

import { chrisConnection } from "../connect/chrisConnection.js";
import {
  client_userFileUpload,
  filebrowserFile_get,
  itemData_get,
  resource_call,
  type FileBytesSource,
  type Client,
  type FileBrowserFolder,
  type UserFile,
} from "../chrisapi/adapter.js";
import { errorStack } from "../error/errorStack.js";
import { IStorageProvider } from "./io.js";
import { Err, Ok, Result } from "../utils/result.js";
import { STREAM_STALL_MS, stream_watchStalls, upload_watchStalls, type UploadWatch } from "./streamWatch.js";
import type { Readable } from "node:stream";

/**
 * UserFile data with fname field.
 */
interface UserFileData {
  fname?: string;
  [key: string]: unknown;
}

/**
 * UserFile with data property.
 */
interface UserFileWithData extends UserFile {
  data: UserFileData;
}

/**
 * UserFile with getFileStream method.
 */
interface UserFileWithStream extends UserFile {
  getFileStream(timeout?: number): Promise<FileStreamResponse>;
}

/**
 * Response from getFileStream method.
 */
interface FileStreamResponse {
  data: unknown;
  headers?: {
    "content-length"?: string | number;
    "Content-Length"?: string | number;
    [key: string]: unknown;
  };
}

/**
 * Class for handling IO operations with ChRIS.
 */
/**
 * Reads the HTTP status out of a rejected client call.
 *
 * The client wraps axios, so the status hides at a couple of depths
 * depending on how the failure arose. Absent a status, the caller says so
 * rather than guessing at a reason.
 *
 * @param error - The thrown value.
 * @returns The HTTP status, or null when the failure carried none.
 */
function httpStatus_extract(error: unknown): number | null {
  if (error === null || typeof error !== "object") return null;
  const candidate: { status?: unknown; response?: { status?: unknown } } = error as {
    status?: unknown;
    response?: { status?: unknown };
  };
  const status: unknown = candidate.response?.status ?? candidate.status;
  return typeof status === "number" ? status : null;
}

export class ChrisIO {
  private _chrisFolder: string = "";
  private _client: Client | null = null;
  private storageProvider: IStorageProvider | null = null;

  constructor() {
    // Client initialization is deferred or handled via async accessor
  }

  /**
   * Sets the storage provider for local IO operations.
   * @param provider - The storage provider instance.
   */
  storageProvider_set(provider: IStorageProvider): void {
    this.storageProvider = provider;
  }

  /**
   * Gets the ChRIS client instance, initializing it if necessary.
   * @returns A Promise resolving to the Client instance or null.
   */
  async client_get(): Promise<Client | null> {
    if (!this._client) {
      this._client = await chrisConnection.client_get();
    }
    return this._client;
  }

  get chrisFolder(): string {
    return this._chrisFolder;
  }

  set chrisFolder(folder: string) {
    this._chrisFolder = folder;
  }

  /**
   * Initializes the ChrisIO instance by creating a file browser folder.
   * @returns A Promise resolving to true on success, false on failure, or null if client is missing.
   */
  async init(): Promise<boolean | null> {
    const client: Client | null = await this.client_get();
    if (!client) {
      return null;
    }
    try {
      const fileBrowserFolder: FileBrowserFolder =
        await client.createFileBrowserFolder({ path: this.chrisFolder });
      return true;
    } catch (error: unknown) {
      errorStack.stack_push(
        "error",
        `Failed to create FileBrowserFolder: 
        ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  private isArrayBuffer(obj: unknown): obj is ArrayBuffer {
    return (
      obj instanceof ArrayBuffer ||
      (typeof obj === "object" && obj !== null && "byteLength" in obj)
    );
  }

  /**
   * Downloads a file from ChRIS by its ID as a stream (Node) or blob (browser).
   * Returns the raw response data plus optional size metadata when available.
   *
   * @param fileId - The ID of the file to download.
   * @returns A Result containing the stream/blob and optional size metadata.
   */

  /**
   * Fetches a downloadable file resource by id, trying the userfiles
   * collection first and falling back to PACS files.
   *
   * Filebrowser folder listings mix file kinds (a /SERVICES path holds PACS
   * files, a /home path holds userfiles) but yield only numeric ids, so the
   * downloader must probe both collections; a PACS id is invisible at the
   * userfiles endpoint and previously read as "not found".
   *
   * @param client - The connected ChRIS client.
   * @param fileId - The file id from a folder listing.
   * @returns The file resource, or null when neither collection knows the id.
   */
  private async downloadableFile_get(client: Client, fileId: number): Promise<UserFile | FileBytesSource | null> {
    this.lastFileRefusal = null;
    try {
      const userFile: UserFile | null = await client.getUserFile(fileId);
      if (userFile) return userFile;
    } catch (error: unknown) {
      // A refusal is not an absence. CUBE answers 403 for a file this
      // identity may see listed but not read — the shape a shared feed
      // takes — and reporting that as "not found" sends an operator
      // looking for a missing file that is in fact right there.
      this.lastFileRefusal = httpStatus_extract(error);
    }
    try {
      const pacsFile: UserFile | null = await resource_call<UserFile | null>(client, 'getPACSFile', fileId);
      if (pacsFile) return pacsFile;
    } catch (error: unknown) {
      this.lastFileRefusal ??= httpStatus_extract(error);
    }
    // A file in a feed shared with this identity: CUBE serves it through
    // the file browser while `/userfiles/` answers 403.
    try {
      const shared: FileBytesSource | null = await filebrowserFile_get(client, fileId);
      if (shared) {
        this.lastFileRefusal = null;
        return shared;
      }
    } catch (error: unknown) {
      this.lastFileRefusal ??= httpStatus_extract(error);
    }
    // The client answers a refusal with null as readily as it does an
    // absence, so neither branch above necessarily carries a status. Ask
    // CUBE plainly what it thinks of this file, once, on the failure path
    // only: an operator told "not found" about a file they can see listed
    // will go looking for the wrong problem.
    this.lastFileRefusal ??= await this.fileStatus_probe(fileId);
    return null;
  }

  /**
   * Asks CUBE directly what it answers for a file id.
   *
   * @param fileId - The file the lookup could not resolve.
   * @returns The HTTP status, or null when it could not be asked.
   */
  private async fileStatus_probe(fileId: number): Promise<number | null> {
    try {
      const url: string | null = await chrisConnection.chrisURL_get();
      const token: string | null = await chrisConnection.authToken_get();
      if (!url || !token) return null;
      const response: Response = await fetch(`${url.replace(/\/$/, "")}/userfiles/${fileId}/`, {
        headers: { Authorization: `Token ${token}` },
      });
      return response.status;
    } catch {
      return null;
    }
  }

  /** HTTP status of the most recent failed file lookup, when CUBE gave one. */
  private lastFileRefusal: number | null = null;

  /**
   * Explains why a file lookup came back empty, in CUBE's own terms.
   *
   * @param fileId - The file the operator asked for.
   * @returns A sentence naming what CUBE actually answered.
   */
  private fileRefusal_describe(fileId: number): string {
    if (this.lastFileRefusal === 403) {
      return `File ID ${fileId}: CUBE refused access (403). It is listed but not readable by this identity — a feed shared with you grants the listing, not the contents.`;
    }
    if (this.lastFileRefusal === 404) {
      return `File ID ${fileId} does not exist (404).`;
    }
    if (this.lastFileRefusal !== null) {
      return `File ID ${fileId} could not be read: CUBE answered ${this.lastFileRefusal}.`;
    }
    return `File ID ${fileId} is not in the file collections this client can read.`;
  }

  async file_downloadStream(
    fileId: number
  ): Promise<Result<{ stream: unknown; size?: number; filename?: string }>> {
    const client: Client | null = await this.client_get();
    if (!client) {
      errorStack.stack_push("error", "ChRIS client is not initialized");
      return Err();
    }

    try {
      const userFile: UserFile | FileBytesSource | null = await this.downloadableFile_get(client, fileId);

      if (!userFile) {
        errorStack.stack_push(
          "error",
          this.fileRefusal_describe(fileId)
        );
        return Err();
      }

      // No deadline on the transfer (chrisapi's default is 30 s, which a
      // large file's wait for its first byte alone can exceed): a watchdog
      // fails the stream when it falls silent instead, and says so.
      const response: FileStreamResponse = await (userFile as UserFileWithStream).getFileStream(0);
      if (!response || response.data === undefined) {
        errorStack.stack_push("error", `File ID ${fileId} returned no data.`);
        return Err();
      }

      const lengthHeader: string | undefined | number =
        response.headers?.["content-length"] ||
        response.headers?.["Content-Length"];
      const size: number | undefined =
        typeof lengthHeader === "string" ? parseInt(lengthHeader, 10) : undefined;

      const body: unknown = response.data;
      const watched: unknown =
        body !== null && typeof body === "object" && typeof (body as Readable).pipe === "function"
          ? stream_watchStalls(body as Readable, STREAM_STALL_MS, `file ${fileId}`)
          : body;
      return Ok({
        stream: watched,
        size: Number.isFinite(size) ? size : undefined,
        filename: (userFile as UserFileWithData).data?.fname,
      });
    } catch (error: unknown) {
      const msg: string = error instanceof Error ? error.message : String(error);
      errorStack.stack_push(
        "error",
        `Download stream failed for file ${fileId}: ${msg}`
      );
      return Err();
    }
  }

  /**
   * A file's size as CUBE records it, without reading its bytes.
   *
   * @param fileId - The file's id.
   * @returns The size in bytes, or null when the file cannot be read or CUBE gives none.
   */
  async file_size(fileId: number): Promise<number | null> {
    const client: Client | null = await this.client_get();
    if (!client) return null;
    try {
      const userFile: UserFile | FileBytesSource | null = await this.downloadableFile_get(client, fileId);
      const fsize: unknown = (userFile as UserFileWithData | null)?.data?.fsize;
      return typeof fsize === "number" ? fsize : null;
    } catch {
      return null;
    }
  }

  /**
   * Downloads a file from ChRIS by its ID.
   * @param fileId - The ID of the file to download.
   * @returns A Promise resolving to a Buffer of the file content, or null on failure.
   */
  async file_download(fileId: number): Promise<Buffer | null> {
    const client: Client | null = await this.client_get();
    if (!client) {
      errorStack.stack_push("error", "ChRIS client is not initialized");
      return null;
    }

    try {
      const userFile: UserFile | FileBytesSource | null = await this.downloadableFile_get(client, fileId);

      if (!userFile) {
        // This is a common case: the file ID was scraped from a listing, but
        // the file itself is not retrievable (e.g. 404, or permissions)
        errorStack.stack_push("error", this.fileRefusal_describe(fileId));
        return null;
      }

      const blob: unknown = await userFile.getFileBlob();
      
      if (!blob) {
         errorStack.stack_push("error", `File ID ${fileId} exists but returned no content/blob.`);
         return null;
      }

      if (typeof blob === "string") {
        return Buffer.from(blob);
      } else if (Buffer.isBuffer(blob)) {
        // Already a Node.js Buffer
        return blob;
      } else if (blob instanceof ArrayBuffer) {
        return Buffer.from(blob);
      } else if (blob instanceof Blob) {
        const arrayBuffer: ArrayBuffer = await blob.arrayBuffer();
        return Buffer.from(arrayBuffer);
      } else {
        throw new Error(`Unexpected blob type: ${typeof blob}`);
      }
    } catch (error: unknown) {
      // Catch network errors, timeouts, or specific API error messages
      const msg: string = error instanceof Error ? error.message : String(error);
      errorStack.stack_push(
        "error",
        `Download failed for file ${fileId}: ${msg}`
      );
      return null;
    }
  }

  /**
   * Uploads a file to ChRIS.
   *
   * The upload has no deadline as a whole; it fails when it has made no
   * progress for `STREAM_STALL_MS`, with a sentence saying how far it got.
   *
   * @param fileBlob - The file content as a Blob.
   * @param uploadDir - The directory path in ChRIS to upload to.
   * @param filename - The name of the file to create.
   * @returns A Promise resolving to true on success, false on failure.
   */
  async file_upload(fileBlob: Blob, uploadDir: string, filename: string): Promise<boolean> {
    const client: Client | null = await this.client_get();
    if (!client) {
      console.error("ChRIS client is not initialized");
      return false;
    }

    try {
      // ChRIS API expects paths WITHOUT leading slash
      // upload_path should be the FULL PATH including filename
      const normalizedUploadDir: string = uploadDir.startsWith('/') ? uploadDir.substring(1) : uploadDir;
      const fullPath: string = normalizedUploadDir.endsWith('/')
        ? normalizedUploadDir + filename
        : normalizedUploadDir + '/' + filename;

      // No deadline on the whole upload (CUBE takes bytes at about 0.4 MB/s,
      // so any fixed one fails a healthy large file): the watch fails it when
      // it stops moving, abandons the request, and says how far it got.
      const watch: UploadWatch = upload_watchStalls(fileBlob, filename, STREAM_STALL_MS);
      const abandon: AbortController = new AbortController();
      watch.stalled.catch((stall: unknown): void => { abandon.abort(stall); });
      let uploaded: Record<string, unknown>;
      try {
        uploaded = await client_userFileUpload(client, fullPath, watch.file, abandon.signal);
      } finally {
        watch.stop();
      }

      // ChRIS may rename the file to avoid collisions (e.g. world.txt → world_XXXXXXX.txt)
      // when the path was recently deleted and not yet committed. Renaming
      // it back is right THEN and catastrophic when the path is genuinely
      // occupied: a write onto a path the store already holds leaves a row
      // CUBE's own API cannot serve, and one such row makes every listing
      // of that folder fail (docs/CUBE-gaps.adoc). So the rename happens
      // only when the wanted path is free, and a check that cannot answer
      // counts as occupied — the safe reading, since the cost of guessing
      // wrong is the operator's folder.
      const actualFname: string = typeof uploaded.fname === 'string' ? uploaded.fname : '';
      const normalizedActual: string = actualFname.startsWith('/') ? actualFname.substring(1) : actualFname;
      if (normalizedActual && normalizedActual !== fullPath) {
        const free: boolean = await this.path_isFree(client, fullPath, normalizedActual);
        if (!free) {
          errorStack.stack_push(
            'warning',
            `'${fullPath}' already exists — the upload landed as '${actualFname}' rather than overwriting it`,
          );
        } else {
          try {
            const userFile: UserFile | null = typeof uploaded.id === 'number' ? await client.getUserFile(uploaded.id) : null;
            if (userFile === null) throw new Error('CUBE did not name the uploaded file');
            await userFile.put({ upload_path: fullPath });
          } catch (renameErr: unknown) {
            const renameMsg: string = renameErr instanceof Error ? renameErr.message : String(renameErr);
            errorStack.stack_push('warning', `Uploaded as '${actualFname}' — rename to '${fullPath}' failed: ${renameMsg}`);
            // Don't fail the upload — file was uploaded, just at wrong name
          }
        }
      }

      return true;
    } catch (error: unknown) {
      const errorMsg: string = error instanceof Error ? error.message : String(error);
      errorStack.stack_push(
        "error",
        `Failed to upload file ${filename} to ${uploadDir}: ${errorMsg}`
      );
      return false;
    }
  }

  /**
   * Deletes one file by its id, without listing anything.
   *
   * A file that cannot be LISTED must still be deletable: a folder whose
   * listing the server refuses is exactly the folder an operator most needs
   * to clear, and a delete that resolves its id through the parent's
   * collection cannot help there (#462).
   *
   * @param fileId - The file's id.
   * @returns Ok(true) when the file is gone, Err when the server refused.
   */
  async file_deleteById(fileId: number): Promise<Result<boolean>> {
    const client: Client | null = await this.client_get();
    if (!client) {
      errorStack.stack_push("error", "ChRIS client is not initialized");
      return Err<boolean>();
    }
    try {
      const userFile: UserFile | null = await client.getUserFile(fileId);
      if (!userFile) {
        errorStack.stack_push("error", `File not found with ID ${fileId}`);
        return Err<boolean>();
      }
      await resource_call<unknown>(userFile, '_delete');
      return Ok(true);
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      errorStack.stack_push("error", `Failed to delete file ID ${fileId}: ${message}`);
      return Err<boolean>();
    }
  }

  /**
   * Whether a path is free to be written to.
   *
   * Asked by exact name rather than by listing the folder: one request, and
   * it still answers when the folder's own listing is broken. Anything the
   * server will not answer counts as occupied.
   *
   * @param client - The connected client.
   * @param wanted - The path a write wants, without a leading slash.
   * @param mine - The path the just-uploaded file currently occupies, which
   *   is not a collision with itself.
   * @returns True when nothing else holds the path.
   */
  private async path_isFree(client: Client, wanted: string, mine: string): Promise<boolean> {
    try {
      // listing-bound: one exact path can only be held by one file; five is
      // room for a server that answers loosely, not a page of a collection.
      const held = await client.getUserFiles({ limit: 5, fname_exact: wanted });
      const items: unknown[] = held.getItems() ?? [];
      for (const item of items) {
        const fname: string = itemData_get<UserFileData>(item as never)?.fname ?? '';
        const normalized: string = fname.startsWith('/') ? fname.substring(1) : fname;
        if (normalized !== mine) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Creates a new folder in ChRIS at the specified path.
   *
   * @param folderPath - The path where the folder should be created.
   * @returns A Result containing true if created, false if already exists, or Err on error.
   *
   * @example
   * ```typescript
   * const result = await chrisIO.folder_create('/uploads/data');
   * if (result.ok && result.value) {
   *   console.log('Folder created successfully');
   * }
   * ```
   */
  async folder_create(folderPath: string): Promise<Result<boolean>> {
    const client: Client | null = await this.client_get();
    if (!client) {
      errorStack.stack_push("error", "ChRIS client is not initialized");
      return Err();
    }

    try {
      const folderList = await client.getFileBrowserFolders();

      const response = await folderList.post({ path: folderPath });

      if (response && response.data) {
        return Ok(true); // Folder created successfully
      } else {
        errorStack.stack_push("error", `Failed to create folder: ${folderPath}. No data in response.`);
        return Err();
      }
    } catch (error: unknown) {
      // Check if this is an "already exists" error (400 status with specific message)
      if (
        error &&
        typeof error === 'object' &&
        'response' in error &&
        error.response &&
        typeof error.response === 'object' &&
        'status' in error.response &&
        error.response.status === 400 &&
        'data' in error.response &&
        error.response.data &&
        typeof error.response.data === 'object' &&
        'path' in error.response.data &&
        Array.isArray(error.response.data.path) &&
        error.response.data.path[0] &&
        typeof error.response.data.path[0] === 'string' &&
        error.response.data.path[0].includes('already exists')
      ) {
        errorStack.stack_push("warning", `Folder '${folderPath}' already exists.`);
        return Ok(false); // Return false to indicate folder already existed
      }

      // Other errors
      const errorMessage: string = error instanceof Error ? error.message : String(error);
      errorStack.stack_push("error", `Error creating folder '${folderPath}': ${errorMessage}`);
      return Err();
    }
  }

  /**
   * Moves (renames) a folder in ChRIS by updating its path.
   * @param srcPath - The current folder path.
   * @param destPath - The new folder path.
   * @returns Promise resolving to true on success, false on failure.
   */
  async folder_moveByPath(srcPath: string, destPath: string): Promise<Result<boolean>> {
    const client: Client | null = await this.client_get();
    if (!client) {
      errorStack.stack_push("error", "ChRIS client is not initialized");
      return Err<boolean>();
    }

    try {
      const folder: FileBrowserFolder | null = await client.getFileBrowserFolderByPath(srcPath);
      if (!folder) {
        errorStack.stack_push("error", `Folder not found: ${srcPath}`);
        return Err<boolean>();
      }
      // chrisapi typings omit the path field, but API supports it for renames
      await resource_call<unknown>(folder, 'put', { path: destPath });
      return Ok(true);
    } catch (error: unknown) {
      const errorMsg: string = error instanceof Error ? error.message : String(error);
      errorStack.stack_push("error", `Failed to move folder ${srcPath} to ${destPath}: ${errorMsg}`);
      return Err<boolean>();
    }
  }

  /**
   * Deletes a folder (and its contents) addressed by path, waiting until the
   * CUBE confirms it is gone.
   *
   * Deletion is asynchronous server-side (the DELETE is only accepted), so
   * success is defined as the path no longer resolving within the timeout.
   *
   * @param path - The folder's CUBE path (leading slash optional).
   * @param options - `timeoutMs` bounds the disappearance poll (default 10s).
   * @returns Ok(true) when the folder is verifiably gone (or never existed),
   *   Err on failure or timeout.
   */
  async folder_deleteByPath(path: string, options: { timeoutMs?: number } = {}): Promise<Result<boolean>> {
    const client: Client | null = await this.client_get();
    if (!client) {
      errorStack.stack_push("error", "ChRIS client is not initialized");
      return Err<boolean>();
    }

    const cleanPath: string = path.startsWith('/') ? path.slice(1) : path;
    try {
      const folder: FileBrowserFolder | null = await client.getFileBrowserFolderByPath(cleanPath);
      if (!folder) {
        return Ok(true);
      }
      await resource_call<unknown>(folder, 'delete');

      const deadline: number = Date.now() + (options.timeoutMs ?? 10_000);
      while (Date.now() < deadline) {
        if (!(await client.getFileBrowserFolderByPath(cleanPath))) {
          return Ok(true);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      errorStack.stack_push("error", `Folder ${cleanPath} still resolves after queued deletion`);
      return Err<boolean>();
    } catch (error: unknown) {
      const errorMsg: string = error instanceof Error ? error.message : String(error);
      errorStack.stack_push("error", `Failed to delete folder ${cleanPath}: ${errorMsg}`);
      return Err<boolean>();
    }
  }

  /**
   * Moves (renames) a file in ChRIS by updating its path.
   * @param fileId - The file ID.
   * @param destPath - The target path including filename.
   * @returns Promise resolving to true on success, false on failure.
   */
  async file_moveById(fileId: number, destPath: string): Promise<Result<boolean>> {
    const client: Client | null = await this.client_get();
    if (!client) {
      errorStack.stack_push("error", "ChRIS client is not initialized");
      return Err<boolean>();
    }

    try {
      const userFile: UserFile | null = await client.getUserFile(fileId);
      if (!userFile) {
        errorStack.stack_push("error", `File not found with ID ${fileId}`);
        return Err<boolean>();
      }
      // The rename field drifted across CUBE versions: newer servers take
      // `upload_path`, older ones `path` (chrisapi types neither). Try the
      // current name first and fall back for older CUBEs.
      try {
        await resource_call<unknown>(userFile, 'put', { upload_path: destPath });
      } catch {
        await resource_call<unknown>(userFile, 'put', { path: destPath });
      }
      return Ok(true);
    } catch (error: unknown) {
      const errorMsg: string = error instanceof Error ? error.message : String(error);
      errorStack.stack_push("error", `Failed to move file ID ${fileId} to ${destPath}: ${errorMsg}`);
      return Err<boolean>();
    }
  }

  /**
   * Uploads a local directory or file to ChRIS recursively.
   * @param localPath - The path on the local filesystem.
   * @param remotePath - The destination path on ChRIS. For directories, follows Unix cp semantics:
   *                     the source directory name is appended to remotePath.
   * @returns Promise<boolean> success status.
   */
  async uploadLocalPath(localPath: string, remotePath: string): Promise<boolean> {
    if (!this.storageProvider) {
      errorStack.stack_push("error", "Storage provider not configured in ChrisIO.");
      return false;
    }

    try {
      const isDir: boolean = await this.storageProvider.isDirectory(localPath);

      if (isDir) {
        // For directories, follow Unix cp semantics: append source dir basename to target
        // e.g., upload ~/test-upload /home/user -> /home/user/test-upload/
        const dirBasename: string = this.storageProvider.basename(localPath);
        const targetDir: string = remotePath.endsWith('/')
          ? remotePath + dirBasename
          : remotePath + '/' + dirBasename;

        const entries: string[] = await this.storageProvider.readdir(localPath);
        let success: boolean = true;

        for (const entry of entries) {
          const childLocal: string = this.storageProvider.join(localPath, entry);
          const childRemote: string = targetDir.endsWith('/')
             ? targetDir + entry
             : targetDir + '/' + entry;

          const result: boolean = await this.uploadLocalPath(childLocal, childRemote);
          if (!result) success = false;
        }
        return success;
      } else {
        // It's a file
        const content: ArrayBuffer | null = await this.storageProvider.readBinary(localPath);
        if (!content) {
           errorStack.stack_push("error", `Failed to read local file: ${localPath}`);
           return false;
        }

        const blob: Blob = new Blob([content]);

        // Split remotePath into dir and filename
        // Since remote path is ChRIS path (Unix-like), we split by last '/'
        const lastSlashIndex: number = remotePath.lastIndexOf('/');
        let dir: string = "";
        let name: string = remotePath;
        if (lastSlashIndex !== -1) {
          dir = remotePath.substring(0, lastSlashIndex);
          name = remotePath.substring(lastSlashIndex + 1);
        }

        // If dir is empty, use root
        if (!dir) dir = "/";

        return await this.file_upload(blob, dir, name);
      }
    } catch (error: unknown) {
      const msg: string = error instanceof Error ? error.message : String(error);
      errorStack.stack_push("error", `Recursive upload failed for ${localPath}: ${msg}`);
      return false;
    }
  }

  /**
   * Performs a dummy upload for testing purposes.
   * @returns A Promise resolving to true on success, or null if client is missing.
   */
  async dummy_upload(): Promise<boolean | null> {
    const client: Client | null = await this.client_get();
    if (!client) {
      return null;
    }
    
    // dummy_upload is deprecated/test logic, fixing for compilation
    const data: { upload_path: string } = {
      upload_path: this.chrisFolder,
    };

    const fileContent: string = "This is a test file";
    const fileData: string = JSON.stringify(fileContent);
    const uploadFileBlob: Blob = new Blob([fileData], {
      type: "application/json",
    });
    const filename: string = "dummy.json";
    
    return await this.file_upload(uploadFileBlob, this.chrisFolder, filename);
  }
}

/**
 * Global ChRIS IO instance.
 */
export const chrisIO: ChrisIO = new ChrisIO();
