/**
 * @file Wildcard expansion for shell commands.
 *
 * Matches glob patterns against the session's filesystem.
 *
 * @module
 */
import { Minimatch, minimatch } from 'minimatch';
import { listingItemsFromVfs_make } from './vfs/listing.js';
import { session } from '../session/index.js';
import type { ListingItem } from '@fnndsc/menu';
import { ShellWord, shellWord_literal, shellWord_unquoted } from './parser.js';
import { path_resolve } from '../core/paths.js';
import { backendInstalled_get } from '../core/backend.js';
import { listingCache_get, vfsDispatcher_get } from '../core/filesystem.js';
import type { ListingCache } from '../core/backend.js';
import { Result, Ok, Err, errorStack } from '@fnndsc/fond';

/**
 * Checks if a string contains wildcard characters.
 *
 * @param arg - The argument to check.
 * @returns True if the argument contains wildcards.
 */
export function string_checkHasWildcard(arg: string): boolean {
  return /[*?[\]]/.test(arg);
}

/** A VFS item selected by wildcard expansion. */
export interface WildcardMatch {
  path: string;
  type: ListingItem['type'];
}

/**
 * Lists a directory for expansion, through a CFS link and the listing cache.
 *
 * @param logicalDir - The directory as the caller spells it.
 * @returns Its items, or null when it cannot be listed.
 */
async function directoryItems_list(logicalDir: string): Promise<ListingItem[] | null> {
  const physicalDir: string = (await backendInstalled_get()?.vfs?.path_physical?.(logicalDir)) ?? logicalDir;
  const listCache: ListingCache = listingCache_get();
  const cached = listCache.cache_get<ListingItem[]>(physicalDir);
  if (cached) return cached.data;
  const vfsResult = await vfsDispatcher_get().list(physicalDir);
  if (!vfsResult.ok) return null;
  const items: ListingItem[] = listingItemsFromVfs_make(vfsResult.value);
  listCache.cache_set(physicalDir, items);
  return items;
}

/**
 * Expands a rendered pattern and its quote-aware minimatch pattern, one path
 * component at a time, as POSIX `sh` does: a wildcard may stand in any component. The
 * literal lead is listed once, then each match of each later component.
 *
 * @param value - Rendered shell-word value.
 * @param globPattern - Quote-aware minimatch pattern.
 * @returns A Promise resolving to Result<WildcardMatch[]>, sorted by name at each level.
 *          Ok([]) = no matches (not an error).
 *          Err(...) = couldn't expand (API failure, permission denied, etc.).
 */
async function wildcardMatches_expand(
  value: string,
  globPattern: string,
): Promise<Result<WildcardMatch[]>> {
  try {
    const cwd: string = await session.getCWD();
    const resolvedValue: string = await path_resolve(value);
    const resolvedPattern: string = await path_resolve(globPattern);

    // A word with no directory part is one component, matched in cwd. A path
    // keeps its literal lead (`~/...` resolved, a quoted `*` as itself) and
    // expands from the first component that holds a wildcard.
    const valueParts: string[] = resolvedValue.includes('/') ? resolvedValue.split('/') : [resolvedValue];
    const patternParts: string[] = resolvedValue.includes('/') ? resolvedPattern.split('/') : [resolvedPattern];
    const magicIndex: number = patternParts.findIndex((part: string): boolean => new Minimatch(part).hasMagic());
    const first: number = magicIndex === -1 ? patternParts.length - 1 : magicIndex;
    const base: string = resolvedValue.includes('/') ? (valueParts.slice(0, first).join('/') || '/') : cwd;

    let matches: WildcardMatch[] = [{ path: base, type: 'dir' }];
    for (let index: number = first; index < patternParts.length; index++) {
      const pattern: string = patternParts[index] || '*';
      const literal: string | null = new Minimatch(pattern).hasMagic() ? null : (valueParts[index] ?? pattern);
      const next: WildcardMatch[] = [];
      for (const parent of matches) {
        // Past the first level a match that is a file, or cannot be listed, has nothing under it.
        if (index > first && parent.type === 'file') continue;
        const items: ListingItem[] | null = await directoryItems_list(parent.path);
        if (items === null) {
          if (index === first) return Err();
          continue;
        }
        const kept: ListingItem[] = items
          .filter((item: ListingItem): boolean => literal !== null ? item.name === literal : minimatch(item.name, pattern))
          .sort((a: ListingItem, b: ListingItem): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const item of kept) next.push({ path: `${parent.path}/${item.name}`.replace(/\/+/g, '/'), type: item.type });
      }
      matches = next;
    }

    // A match under cwd reads as the caller typed it: the bare name.
    if (base === cwd) {
      matches = matches.map((match: WildcardMatch): WildcardMatch => ({ ...match, path: match.path.slice(cwd.replace(/\/+$/, '').length + 1) }));
    }
    return Ok(matches);

  } catch (error: unknown) {
    const errorMsg: string = error instanceof Error ? error.message : String(error);
    errorStack.stack_push("error", `Failed to expand wildcard '${value}': ${errorMsg}`);
    return Err();
  }
}

/**
 * Expands one quote-aware shell word against the ChRIS filesystem.
 *
 * @param word - Parsed shell word.
 * @returns Expanded words, or the original word when it has no match.
 */
export async function shellWord_expand(word: ShellWord): Promise<Result<ShellWord[]>> {
  if (!word.pathnameExpansion) return Ok([word]);

  const result: Result<WildcardMatch[]> = await wildcardMatches_expand(word.value, word.globPattern);
  if (!result.ok) return result;
  if (result.value.length === 0) return Ok([word]);
  return Ok(result.value.map((match: WildcardMatch): ShellWord => ({
    ...shellWord_literal(match.path),
    pathnameExpanded: true,
  })));
}

/**
 * Expands selected quote-aware shell words in argument order.
 *
 * @param words - Parsed shell words.
 * @param eligible - Predicate that preserves explicit cross-realm operands.
 * @returns Expanded words, retaining literal words when no path matches.
 */
export async function shellWords_expand(
  words: readonly ShellWord[],
  eligible: (word: ShellWord, index: number) => boolean,
): Promise<Result<ShellWord[]>> {
  const expanded: ShellWord[] = [];
  for (const [index, word] of words.entries()) {
    if (!eligible(word, index)) {
      expanded.push(word);
      continue;
    }
    const result: Result<ShellWord[]> = await shellWord_expand(word);
    if (!result.ok) return result;
    expanded.push(...result.value);
  }
  return Ok(expanded);
}

/**
 * Expands a wildcard pattern against the current directory with item type.
 *
 * @param pattern - The glob pattern (e.g., "*.ts", "test*.json").
 * @returns A Promise resolving to Result<WildcardMatch[]>.
 *          Ok([]) = no matches (not an error).
 *          Err(...) = couldn't expand (API failure, permission denied, etc.).
 */
export async function wildcard_expandMatches(pattern: string): Promise<Result<WildcardMatch[]>> {
  if (!string_checkHasWildcard(pattern)) return Ok([{ path: pattern, type: 'file' }]);
  return wildcardMatches_expand(pattern, pattern);
}

/**
 * Expands a wildcard pattern against the current directory.
 *
 * @param pattern - The glob pattern (e.g., "*.ts", "test*.json").
 * @returns A Promise resolving to Result<string[]>.
 *          Ok([]) = no matches (not an error).
 *          Err(...) = couldn't expand (API failure, permission denied, etc.).
 */
export async function wildcard_expand(pattern: string): Promise<Result<string[]>> {
  if (!string_checkHasWildcard(pattern)) return Ok([pattern]);
  const word: ShellWord = shellWord_unquoted(pattern);
  const result: Result<ShellWord[]> = await shellWord_expand(word);
  if (!result.ok) return result;
  if (result.value.length === 1 && result.value[0] === word) return Ok([]);
  return Ok(result.value.map((match: ShellWord) => match.value));
}

/**
 * Expands all wildcards in an argument list.
 *
 * @param args - The argument list potentially containing wildcards.
 * @returns A Promise resolving to Result<string[]>.
 *          On error expanding any pattern, returns the error.
 *          Empty matches return the original pattern.
 */
export async function wildcards_expandAll(args: string[]): Promise<Result<string[]>> {
  const words: ShellWord[] = args.map((arg: string): ShellWord => shellWord_unquoted(arg));
  const result: Result<ShellWord[]> = await shellWords_expand(words, (): boolean => true);
  if (!result.ok) return result;
  return Ok(result.value.map((word: ShellWord): string => word.value));
}
