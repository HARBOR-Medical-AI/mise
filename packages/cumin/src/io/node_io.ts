/**
 * @file Node.js implementation of the Storage Provider interface.
 *
 * This module provides a concrete implementation of `IStorageProvider` using
 * Node.js's native `fs` module. It handles file system operations such as
 * reading, writing, listing directories, and checking file existence.
 *
 * @module
 */

import { IStorageProvider } from "./io.js";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { randomBytes } from "crypto";

/**
 * Type guard for Node.js filesystem errors.
 */
function nodeError_is(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error
  );
}

/** A credential's file: its owner reads and writes it, nobody else anything. */
const PRIVATE_FILE_MODE: number = 0o600;

/** A credential's folder: its owner alone may enter it. */
const PRIVATE_FOLDER_MODE: number = 0o700;

/** The permission bits of anybody but the owner. */
const OTHERS_MASK: number = 0o077;

/**
 * NodeStorageProvider implements IStorageProvider using Node.js's native 'fs' module.
 * It handles file system operations for reading, writing, and removing files,
 * and creating directories.
 */
export class NodeStorageProvider implements IStorageProvider {
  private resolvePath(filepath: string): string {
    if (filepath.startsWith("~")) {
      return path.join(os.homedir(), filepath.slice(1));
    }
    return filepath;
  }

  async read(filepath: string): Promise<string | null> {
    const resolvedPath: string = this.resolvePath(filepath);
    try {
      if (await this.exists(resolvedPath)) {
        return await fs.readFile(resolvedPath, "utf-8");
      }
      return null;
    } catch (error: unknown) {
      if (nodeError_is(error) && error.code === "ENOENT") {
        return null; // File not found is not an error for read
      }
      const message = nodeError_is(error) ? error.message : String(error);
      throw new Error(`Failed to read file ${resolvedPath}: ${message}`);
    }
  }

  async readBinary(filepath: string): Promise<ArrayBuffer | null> {
    const resolvedPath: string = this.resolvePath(filepath);
    try {
      if (await this.exists(resolvedPath)) {
        const buffer = await fs.readFile(resolvedPath);
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      }
      return null;
    } catch (error: unknown) {
      if (nodeError_is(error) && error.code === "ENOENT") {
        return null;
      }
      const message = nodeError_is(error) ? error.message : String(error);
      throw new Error(`Failed to read binary file ${resolvedPath}: ${message}`);
    }
  }

  async write(filepath: string, data: string): Promise<void> {
    const resolvedPath: string = this.resolvePath(filepath);
    const dir = path.dirname(resolvedPath);
    await this.mkdir(dir, { recursive: true });
    try {
      await fs.writeFile(resolvedPath, data, "utf-8");
    } catch (error: unknown) {
      const message = nodeError_is(error) ? error.message : String(error);
      throw new Error(`Failed to write file ${resolvedPath}: ${message}`);
    }
  }

  /**
   * Writes a credential: the file at 0600 and its folder at 0700, whatever
   * either was before. The mode given to `writeFile` applies only to a file
   * it creates, so both are set again after.
   *
   * @param filepath - The file.
   * @param data - Its text.
   */
  async writePrivate(filepath: string, data: string): Promise<void> {
    const resolvedPath: string = this.resolvePath(filepath);
    const dir: string = path.dirname(resolvedPath);
    await this.mkdir(dir, { recursive: true });
    // The credential never stands in a file anybody else could read: it is
    // written to a new file made private at its creation, in a folder shown
    // private first, and only then takes the old file's place. A file
    // already there, looser, is never written into.
    const fresh: string = `${resolvedPath}.${process.pid}.${randomBytes(6).toString("hex")}.new`;
    let made: boolean = false;
    try {
      await fs.chmod(dir, PRIVATE_FOLDER_MODE);
      if (((await fs.stat(dir)).mode & OTHERS_MASK) !== 0) throw new Error(`${dir} could not be made its owner's alone`);
      const handle = await fs.open(fresh, "wx", PRIVATE_FILE_MODE);
      made = true;
      try {
        await handle.chmod(PRIVATE_FILE_MODE);
        if (((await handle.stat()).mode & OTHERS_MASK) !== 0) throw new Error(`${fresh} could not be made its owner's alone`);
        await handle.writeFile(data, "utf-8");
      } finally {
        await handle.close();
      }
      await fs.rename(fresh, resolvedPath);
    } catch (error: unknown) {
      if (made) await fs.unlink(fresh).catch((): void => undefined);
      const message = nodeError_is(error) ? error.message : error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to write file ${resolvedPath} privately: ${message}`);
    }
  }

  /**
   * Makes a credential already on disk, and its folder, its owner's alone
   * when any other reader could reach them.
   *
   * @param filepath - The file; a file that is not there is left alone.
   */
  async private_tighten(filepath: string): Promise<void> {
    const resolvedPath: string = this.resolvePath(filepath);
    try {
      const file = await fs.stat(resolvedPath);
      if ((file.mode & OTHERS_MASK) !== 0) await fs.chmod(resolvedPath, PRIVATE_FILE_MODE);
      const dir: string = path.dirname(resolvedPath);
      if (((await fs.stat(dir)).mode & OTHERS_MASK) !== 0) await fs.chmod(dir, PRIVATE_FOLDER_MODE);
    } catch (error: unknown) {
      if (nodeError_is(error) && error.code === "ENOENT") return;
      const message = nodeError_is(error) ? error.message : String(error);
      throw new Error(`Failed to make ${resolvedPath} private: ${message}`);
    }
  }

  async remove(filepath: string): Promise<void> {
    const resolvedPath: string = this.resolvePath(filepath);
    try {
      if (await this.exists(resolvedPath)) {
        await fs.unlink(resolvedPath);
      }
    } catch (error: unknown) {
      const message = nodeError_is(error) ? error.message : String(error);
      throw new Error(
        `Failed to remove file ${resolvedPath}: ${message}`
      );
    }
  }

  async mkdir(filepath: string, options?: { recursive?: boolean }): Promise<void> {
    const resolvedPath: string = this.resolvePath(filepath);
    try {
      await fs.mkdir(resolvedPath, options);
    } catch (error: unknown) {
      if (!nodeError_is(error) || error.code !== "EEXIST") {
        const message = nodeError_is(error) ? error.message : String(error);
        throw new Error(
          `Failed to create directory ${resolvedPath}: ${message}`
        );
      }
    }
  }

  async exists(filepath: string): Promise<boolean> {
    const resolvedPath: string = this.resolvePath(filepath);
    try {
      await fs.access(resolvedPath);
      return true;
    } catch (error: unknown) {
      if (nodeError_is(error) && error.code === "ENOENT") {
        return false;
      }
      const message = nodeError_is(error) ? error.message : String(error);
      throw new Error(
        `Failed to check existence of ${resolvedPath}: ${message}`
      );
    }
  }

  async readdir(filepath: string): Promise<string[]> {
    const resolvedPath: string = this.resolvePath(filepath);
    try {
      return await fs.readdir(resolvedPath);
    } catch (error: unknown) {
      if (nodeError_is(error) && error.code === "ENOENT") {
        return [];
      }
      const message = nodeError_is(error) ? error.message : String(error);
      throw new Error(
        `Failed to read directory ${resolvedPath}: ${message}`
      );
    }
  }

  async isDirectory(filepath: string): Promise<boolean> {
    const resolvedPath: string = this.resolvePath(filepath);
    try {
      const stats = await fs.stat(resolvedPath);
      return stats.isDirectory();
    } catch (error: unknown) {
      if (nodeError_is(error) && error.code === "ENOENT") {
        return false;
      }
      const message = nodeError_is(error) ? error.message : String(error);
      throw new Error(
        `Failed to check if directory ${resolvedPath}: ${message}`
      );
    }
  }

  join(...paths: string[]): string {
    return path.join(...paths);
  }

  basename(filepath: string): string {
    return path.basename(filepath);
  }
}