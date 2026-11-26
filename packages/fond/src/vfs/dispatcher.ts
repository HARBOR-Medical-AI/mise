/**
 * @file The virtual filesystem's dispatcher: routes each request to the
 * mount that owns the path.
 *
 * Mounts (providers) are registered with a path prefix; the longest prefix
 * that matches at a segment boundary wins, so `/proc/jobs` takes precedence
 * over `/proc`, and `/procs` is not under `/proc`. A path no mount claims
 * goes to the fallback, the provider given to the constructor. The
 * dispatcher itself knows no backend: a backend registers its mounts and
 * names its fallback.
 *
 * @module
 */

import { Result, Ok, Err } from "../result.js";
import { errorStack } from "../errorStack.js";
import { VFSProvider, VFSItem, CpOptions, type VFSSubtree } from "./provider.js";
import { vfs_ok, vfs_fail, type VfsOutcome } from "./outcome.js";

/**
 * The fallback when none is given: it holds nothing, and says so by name
 * rather than answering with an empty folder.
 */
const VFS_FALLBACK_NONE: VFSProvider = {
  prefix: "",
  async list(path: string): Promise<Result<VFSItem[]>> {
    errorStack.stack_push("error", `No mount serves ${path}.`);
    return Err();
  },
  async cp(src: string): Promise<VfsOutcome> {
    return vfs_fail("ENOENT", `cp: no mount serves ${src}`);
  },
};

/**
 * Routes filesystem requests to the mount that owns each path, or to the
 * fallback.
 */
export class VFSDispatcher {
  private providers: VFSProvider[] = [];
  private defaultProvider: VFSProvider;
  private pathResolver?: (path: string) => Promise<string>;
  /** Whether an item type is a folder; folders and mounts until a backend's look says more. */
  private containerTest: (type: string) => boolean = (type: string): boolean => type === 'dir' || type === 'vfs';

  /**
   * @param fallback - The provider for paths no mount claims; one that holds
   *   nothing, and says so, when none is given.
   */
  constructor(fallback: VFSProvider = VFS_FALLBACK_NONE) {
    this.defaultProvider = fallback;
  }

  /**
   * Says which item types are folders, beyond `dir` and `vfs`: the installed
   * backend's listing look, through `itemType_isContainer`.
   *
   * @param test - True for a type that holds other items.
   */
  containerTest_register(test: (type: string) => boolean): void {
    this.containerTest = test;
  }

  /**
   * Registers a path resolution hook that maps logical paths to physical paths.
   *
   * @param resolver - The resolver function mapping a logical path to a physical path.
   */
  pathResolver_register(resolver: (path: string) => Promise<string>): void {
    this.pathResolver = resolver;
  }

  /**
   * Registers a new VFS Provider.
   *
   * @param provider - The provider instance to register.
   */
  provider_register(provider: VFSProvider): void {
    this.providers.push(provider);
    // Sort by prefix length descending to match most specific prefix first
    this.providers.sort((a: VFSProvider, b: VFSProvider) => b.prefix.length - a.prefix.length);
  }

  /**
   * Returns every registered mount (not the fallback). Used by callers that
   * need to detect parent-of-prefix paths.
   */
  providers_get(): VFSProvider[] {
    return [...this.providers];
  }

  /**
   * Resolves the matching provider for a given virtual path.
   *
   * @param pathStr - The absolute virtual path.
   * @returns The matching mount, or the fallback.
   */
  provider_get(pathStr: string): VFSProvider {
    const absolutePath: string = pathStr.startsWith("/") ? pathStr : "/" + pathStr;
    const match: VFSProvider | undefined = this.providers.find(
      (p: VFSProvider) => absolutePath === p.prefix || absolutePath.startsWith(p.prefix + "/")
    );
    return match || this.defaultProvider;
  }

  /**
   * Whether a path belongs to a mount rather than to the fallback.
   *
   * Two shapes count: a path a mount owns (at or under its prefix), and a
   * path that is a strict ancestor of a mount's prefix (`/proc` above
   * `/proc/jobs`), whose only children are the mounts beneath it. The root
   * `/` never counts: it is the fallback's own root.
   *
   * It keeps the fallback from being asked to answer for a path it has no
   * folder behind, which cannot succeed and only fills the error stack once
   * per ancestor a path walk visits.
   *
   * @param pathStr - The absolute (or root-relative) path to classify.
   * @returns True when a mount owns, or is owned by, the path.
   */
  path_isVirtual(pathStr: string): boolean {
    const absolutePath: string = pathStr.startsWith("/") ? pathStr : "/" + pathStr;
    const clean: string =
      absolutePath.length > 1 && absolutePath.endsWith("/") ? absolutePath.slice(0, -1) : absolutePath;
    if (clean === "/") return false;
    return this.providers.some(
      (p: VFSProvider) =>
        p.prefix.length > 0 &&
        (clean === p.prefix || clean.startsWith(p.prefix + "/") || p.prefix.startsWith(clean + "/")),
    );
  }

  /**
   * Asks the mount that owns a path to answer its whole subtree from what it
   * holds (see {@link VFSProvider.subtree}).
   *
   * @param pathStr - The subtree's root.
   * @returns The answer, or null when the mount cannot give one.
   */
  async subtree(pathStr: string): Promise<VFSSubtree | null> {
    const absolutePath: string = pathStr.startsWith("/") ? pathStr : "/" + pathStr;
    const clean: string = absolutePath.length > 1 && absolutePath.endsWith("/") ? absolutePath.slice(0, -1) : absolutePath;
    const provider: VFSProvider = this.provider_get(clean);
    if (provider === this.defaultProvider || provider.subtree === undefined) return null;
    return provider.subtree(clean);
  }

  /**
   * Dispatches directory listing to matched provider.
   * Supports dynamic intermediate parent path synthesis for virtual prefixes.
   *
   * @param pathStr - The absolute virtual path to list.
   * @param options - Sort controls.
   * @returns Promise resolving to Result<VFSItem[]>.
   */
  async list(
    pathStr: string,
    options?: { sort?: "name" | "size" | "date" | "owner"; reverse?: boolean }
  ): Promise<Result<VFSItem[]>> {
    const absolutePath: string = pathStr.startsWith("/") ? pathStr : "/" + pathStr;
    const cleanPath: string = absolutePath.endsWith("/") && absolutePath.length > 1 ? absolutePath.slice(0, -1) : absolutePath;

    // Check if cleanPath is a parent of any registered provider's prefix
    const prefixParent: string = cleanPath === "/" ? "/" : cleanPath + "/";
    const children: VFSProvider[] = this.providers.filter(
      (p) => p.prefix.startsWith(prefixParent)
    );

    if (children.length > 0) {
      const segmentIndex: number = cleanPath === "/" ? 1 : cleanPath.split("/").length;
      const virtualSubdirs: Set<string> = new Set<string>();

      for (const p of children) {
        const segments: string[] = p.prefix.split("/");
        const nextSegment: string = segments[segmentIndex];
        if (nextSegment) {
          virtualSubdirs.add(nextSegment);
        }
      }

      if (virtualSubdirs.size > 0) {
        const vfsItems: VFSItem[] = Array.from(virtualSubdirs).map((name) => ({
          name,
          type: "vfs",
          size: 0,
          owner: "root",
          date: new Date().toISOString(),
        }));

        // The fallback may hold real items in this folder too: list them beside the mounts
        let resolvedPathStr: string = pathStr;
        if (this.pathResolver) {
          try {
            resolvedPathStr = await this.pathResolver(pathStr);
          } catch (e: unknown) {
            // Deliberate absorption: for a read-only listing, the logical
            // path is a valid fallback (the provider lists what it can);
            // contrast cp(), where a guessed path could write wrongly.
          }
        }
        // The store holding nothing here is an answer: the mounts are the
        // listing, and what the store said is not left to fail the command.
        const mark: number = errorStack.checkpoint_mark();
        const fallbackResult: Result<VFSItem[]> = await this.defaultProvider.list(resolvedPathStr, options);
        if (!fallbackResult.ok) errorStack.checkpoint_drain(mark);
        if (fallbackResult.ok && fallbackResult.value) {
          const fallbackItems: VFSItem[] = fallbackResult.value;
          for (const item of fallbackItems) {
            if (!virtualSubdirs.has(item.name)) {
              vfsItems.push(item);
            }
          }
        }

        return Ok(vfsItems);
      }
    }

    const provider: VFSProvider = this.provider_get(pathStr);
    if (provider === this.defaultProvider && this.pathResolver) {
      try {
        const resolvedPath: string = await this.pathResolver(pathStr);
        return provider.list(resolvedPath, options);
      } catch (e: unknown) {
        // Deliberate absorption: same read-only-listing rationale as above.
      }
    }
    return provider.list(pathStr, options);
  }

  /**
   * The path a provider is asked with: as given for a mount, and through
   * the path resolver for the fallback, when one is registered. An
   * operation never proceeds on a guessed path: a path that does not
   * resolve fails the operation.
   *
   * @param provider - The provider the path belongs to.
   * @param pathStr - The path as asked.
   * @param what - How a resolution failure names the path (`source path`, `path`).
   * @param operation - The verb, for the failure's words.
   * @returns The path to ask with, or why the operation cannot proceed.
   */
  private async pathFor_provider(provider: VFSProvider, pathStr: string, what: string, operation: string): Promise<VfsOutcome<string>> {
    if (provider !== this.defaultProvider || !this.pathResolver) return vfs_ok(pathStr);
    try {
      return vfs_ok(await this.pathResolver(pathStr));
    } catch (e: unknown) {
      const msg: string = e instanceof Error ? e.message : String(e);
      return vfs_fail('EIO', `${operation}: cannot resolve ${what} ${pathStr}: ${msg}`);
    }
  }

  /**
   * The mount that owns a path, or none.
   *
   * {@link provider_get} answers the fallback for whatever no mount claims,
   * and that includes a path that is only a parent of mounts (`/net` above
   * `/net/pacs`), which the fallback has no folder behind. Such a path has
   * no owner: nothing can be copied out of it or into it.
   *
   * @param pathStr - The absolute path.
   * @returns The owning mount or the fallback; null for a parent of mounts.
   */
  private owner_find(pathStr: string): VFSProvider | null {
    const provider: VFSProvider = this.provider_get(pathStr);
    return provider === this.defaultProvider && this.path_isVirtual(pathStr) ? null : provider;
  }

  /**
   * Copies within a mount, or out of a mount that offers it into the
   * fallback; any other pair of mounts answers `EXDEV`.
   *
   * A mount's `cp` is given two paths and treats both as its own, so a copy
   * handed to the source's mount with a destination it does not own writes
   * somewhere nobody asked for. Who owns each path is settled here, before
   * either mount is asked anything, and again once the paths are resolved,
   * since a resolver can answer a path another mount owns:
   *
   * - both paths in one mount: that mount copies;
   * - the source in a mount that declares `copiesOut`, the destination in
   *   the fallback: the source's mount copies, and the destination is
   *   resolved as the fallback resolves its own paths;
   * - anything else, a parent of mounts on either side included: `EXDEV`.
   *
   * @param src - Source path.
   * @param dest - Destination path.
   * @param options - Copy options.
   * @returns Done, or why not.
   */
  async cp(src: string, dest: string, options: CpOptions): Promise<VfsOutcome> {
    const source: VFSProvider | null = this.owner_find(src);
    const destination: VFSProvider | null = this.owner_find(dest);
    if (source === null) return vfs_fail('EXDEV', `cp: ${src} is a folder of mounts, and holds nothing of its own to copy`);
    if (destination === null) return vfs_fail('EXDEV', `cp: ${dest} is a folder of mounts, and nothing is copied into it`);
    const across: boolean = source !== destination;
    if (across && !(source.copiesOut === true && destination === this.defaultProvider)) {
      return vfs_fail('EXDEV', `cp: ${src} and ${dest} are on different mounts, and no copy between them is offered`);
    }
    const from: VfsOutcome<string> = await this.pathFor_provider(source, src, 'source path', 'cp');
    if (!from.ok) return from;
    const to: VfsOutcome<string> = await this.pathFor_provider(destination, dest, 'destination path', 'cp');
    if (!to.ok) return to;
    if (this.owner_find(from.value) !== source) return vfs_fail('EXDEV', `cp: ${src} resolves to ${from.value}, which another mount owns`);
    if (this.owner_find(to.value) !== destination) return vfs_fail('EXDEV', `cp: ${dest} resolves to ${to.value}, which another mount owns`);
    return source.cp(from.value, to.value, options);
  }

  /**
   * Reads a file whole, as text, through the provider that owns it.
   *
   * @param pathStr - The absolute path of the file.
   * @returns Its content, or why not (`EROFS` where no read is offered).
   */
  async read(pathStr: string): Promise<VfsOutcome<string>> {
    const provider: VFSProvider = this.provider_get(pathStr);
    if (!provider.read) return this.readFailure_classify(pathStr, vfs_fail('EROFS'));
    const at: VfsOutcome<string> = await this.pathFor_provider(provider, pathStr, 'path', 'read');
    return this.readFailure_classify(pathStr, at.ok ? await provider.read(at.value) : at);
  }

  /**
   * A failed read of a folder says so: whatever the owning mount answered
   * (CUBE's "File not found", a projection's own words, a mount that reads
   * nothing), a path its parent lists as a folder is a directory, as a
   * disk says.
   *
   * @param pathStr - The path read.
   * @param outcome - The read's answer.
   * @returns The answer, or `EISDIR` when it failed on a folder.
   */
  private async readFailure_classify<T>(pathStr: string, outcome: VfsOutcome<T>): Promise<VfsOutcome<T>> {
    if (outcome.ok || outcome.errno === 'EISDIR') return outcome;
    const clean: string = pathStr.length > 1 && pathStr.endsWith('/') ? pathStr.slice(0, -1) : pathStr;
    if (clean === '/') return vfs_fail('EISDIR');
    const slash: number = clean.lastIndexOf('/');
    const name: string = clean.slice(slash + 1);
    const mark: number = errorStack.checkpoint_mark();
    const siblings: Result<VFSItem[]> = await this.list(clean.slice(0, slash) || '/');
    errorStack.checkpoint_drain(mark);
    const folder: boolean = siblings.ok && siblings.value.some((item: VFSItem): boolean => item.name === name && this.containerTest(item.type));
    return folder ? vfs_fail('EISDIR') : outcome;
  }

  /**
   * Reads a file whole, as bytes, through the provider that owns it.
   *
   * @param pathStr - The absolute path of the file.
   * @returns Its bytes, or why not.
   */
  async readBinary(pathStr: string): Promise<VfsOutcome<Buffer>> {
    const provider: VFSProvider = this.provider_get(pathStr);
    if (!provider.readBinary) return this.readFailure_classify(pathStr, vfs_fail('EROFS'));
    const at: VfsOutcome<string> = await this.pathFor_provider(provider, pathStr, 'path', 'read');
    return this.readFailure_classify(pathStr, at.ok ? await provider.readBinary(at.value) : at);
  }

  /**
   * Writes a file whole, through the provider that owns it; a mount that
   * holds no writable files answers `EROFS`.
   *
   * @param pathStr - The absolute path of the file.
   * @param content - The new content, whole.
   * @returns Done, or why not.
   */
  async write(pathStr: string, content: string | Buffer): Promise<VfsOutcome> {
    const provider: VFSProvider = this.provider_get(pathStr);
    if (!provider.write) return vfs_fail('EROFS');
    const at: VfsOutcome<string> = await this.pathFor_provider(provider, pathStr, 'path', 'write');
    return at.ok ? provider.write(at.value, content) : at;
  }

  /**
   * Makes a folder, through the provider that owns its path.
   *
   * @param pathStr - The absolute path of the new folder.
   * @returns Done, or why not.
   */
  async mkdir(pathStr: string): Promise<VfsOutcome> {
    const provider: VFSProvider = this.provider_get(pathStr);
    if (!provider.mkdir) return vfs_fail('EROFS');
    const at: VfsOutcome<string> = await this.pathFor_provider(provider, pathStr, 'path', 'mkdir');
    return at.ok ? provider.mkdir(at.value) : at;
  }

  /**
   * Whether the provider that owns a folder makes it and its parents in one step.
   *
   * @param pathStr - The absolute path of the folder.
   * @returns True when `mkdirTree` is offered there.
   */
  mkdirTree_offered(pathStr: string): boolean {
    return this.provider_get(pathStr).mkdirTree !== undefined;
  }

  /**
   * Makes a folder and any missing parents in one step, where the owning
   * provider can; elsewhere `EROFS`, and `mkdir -p` walks instead.
   *
   * @param pathStr - The absolute path of the folder.
   * @returns Done, or why not.
   */
  async mkdirTree(pathStr: string): Promise<VfsOutcome> {
    const provider: VFSProvider = this.provider_get(pathStr);
    if (!provider.mkdirTree) return vfs_fail('EROFS');
    const at: VfsOutcome<string> = await this.pathFor_provider(provider, pathStr, 'path', 'mkdir');
    return at.ok ? provider.mkdirTree(at.value) : at;
  }

  /**
   * Removes an empty folder, through the provider that owns it.
   *
   * @param pathStr - The absolute path of the folder.
   * @returns Done, or why not.
   */
  async rmdir(pathStr: string): Promise<VfsOutcome> {
    const provider: VFSProvider = this.provider_get(pathStr);
    if (!provider.rmdir) return vfs_fail('EROFS');
    const at: VfsOutcome<string> = await this.pathFor_provider(provider, pathStr, 'path', 'rmdir');
    return at.ok ? provider.rmdir(at.value) : at;
  }

  /**
   * Renames within one mount; a rename across mounts answers `EXDEV`.
   *
   * @param src - The absolute path now.
   * @param dest - The absolute path it takes.
   * @returns Done, or why not.
   */
  async rename(src: string, dest: string): Promise<VfsOutcome> {
    const provider: VFSProvider = this.provider_get(src);
    if (provider !== this.provider_get(dest)) return vfs_fail('EXDEV');
    if (!provider.rename) return vfs_fail('EROFS');
    const from: VfsOutcome<string> = await this.pathFor_provider(provider, src, 'source path', 'mv');
    if (!from.ok) return from;
    const to: VfsOutcome<string> = await this.pathFor_provider(provider, dest, 'destination path', 'mv');
    return to.ok ? provider.rename(from.value, to.value) : to;
  }

  /**
   * Removes a file or a link, through the provider that owns it.
   *
   * @param pathStr - The absolute path of the entry.
   * @returns Done, or why not.
   */
  async rm(pathStr: string): Promise<VfsOutcome> {
    const provider: VFSProvider = this.provider_get(pathStr);
    if (!provider.rm) return vfs_fail('EROFS');
    const at: VfsOutcome<string> = await this.pathFor_provider(provider, pathStr, 'path', 'rm');
    return at.ok ? provider.rm(at.value) : at;
  }

  /**
   * Whether the provider that owns a folder removes it whole in one step.
   *
   * @param pathStr - The absolute path of the folder.
   * @returns True when `rmTree` is offered there.
   */
  rmTree_offered(pathStr: string): boolean {
    return this.provider_get(pathStr).rmTree !== undefined;
  }

  /**
   * Removes a folder and everything under it in one step, where the
   * owning provider can; elsewhere `EROFS`, and `rm -r` walks instead.
   *
   * @param pathStr - The absolute path of the folder.
   * @returns Done, or why not.
   */
  async rmTree(pathStr: string): Promise<VfsOutcome> {
    const provider: VFSProvider = this.provider_get(pathStr);
    if (!provider.rmTree) return vfs_fail('EROFS');
    const at: VfsOutcome<string> = await this.pathFor_provider(provider, pathStr, 'path', 'rm');
    return at.ok ? provider.rmTree(at.value) : at;
  }

  /**
   * Resolves a lazy link through the provider that owns it.
   *
   * This is deliberately distinct from {@link list}: a structural traversal
   * can display an unresolved link without causing its provider to fetch the
   * target from a remote service.
   *
   * @param pathStr - Absolute path of the provider-defined link.
   * @returns The resolved target path, or an error if unsupported or absent.
   */
  async linkTarget_resolve(pathStr: string): Promise<Result<string>> {
    const provider: VFSProvider = this.provider_get(pathStr);
    if (provider.linkTarget_resolve) {
      return provider.linkTarget_resolve(pathStr);
    }
    errorStack.stack_push('error', `Link resolution not supported for path: ${pathStr}`);
    return Err();
  }
}
