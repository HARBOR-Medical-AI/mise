/**
 * @file Storage-provider abstraction (IStorageProvider) and provider exports.
 *
 * Interface for storage providers.
 * Defines the methods required for a storage provider to be compatible with cumin.
 */
export interface IStorageProvider {
    read(path: string): Promise<string | null>;
    readBinary(path: string): Promise<ArrayBuffer | null>;
    write(path: string, data: string): Promise<void>;
    /**
     * Writes a file that only its owner may read, in a folder only its owner
     * may enter, and makes both so if they were already there and looser. For
     * a credential. A provider with no notion of other readers (a browser's
     * storage) may leave it out; `write` is used then.
     */
    writePrivate?(path: string, data: string): Promise<void>;
    /**
     * Makes a file that is already there, and its folder, its owner's alone
     * when they are looser; does nothing when the file is not there.
     */
    private_tighten?(path: string): Promise<void>;
    remove(path: string): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    exists(path: string): Promise<boolean>;
    readdir(path: string): Promise<string[]>;
    isDirectory(path: string): Promise<boolean>;
    join(...paths: string[]): string;
    basename(path: string): string;
}

export { BrowserStorageProvider } from "./browser_io";
