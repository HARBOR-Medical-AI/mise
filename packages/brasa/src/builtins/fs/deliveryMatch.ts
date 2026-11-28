/**
 * @file A delivery a line asked for, and whether a delivery that arrives is it.
 *
 * Kept apart from the reader (`deliveryIntent.ts`), which needs the
 * delivering commands' declarations: this half needs nothing, and a
 * surface's own code and tests can hold it without the engine.
 *
 * @module
 */

import { minimatch } from 'minimatch';

/**
 * One source a delivering line named, as far as the surface can bind a delivered file to it: by the source's base
 * name, by its last segment's pattern (a wildcard the engine expands), or any folder (`.`, `/`, `~`).
 *
 * @example
 * ```ts
 * const named: SourceIntent = { name: 'scan.dcm' };
 * ```
 */
export type SourceIntent = NamedSource | PatternSource | AnyFolderSource;

/**
 * A source named by its base name.
 *
 * @example
 * ```ts
 * const named: NamedSource = { name: 'scan.dcm' };
 * ```
 */
export interface NamedSource {
  /** The base name. */
  readonly name: string;
}

/**
 * A source the engine expands from a pattern: its last segment's pattern.
 *
 * @example
 * ```ts
 * const matched: PatternSource = { pattern: '*.dcm' };
 * ```
 */
export interface PatternSource {
  /** The pattern. */
  readonly pattern: string;
}

/**
 * A source that is any folder (`.`, `..`, `/`, `~`).
 *
 * @example
 * ```ts
 * const here: AnyFolderSource = { anyFolder: true };
 * ```
 */
export interface AnyFolderSource {
  /** Any folder. */
  readonly anyFolder: true;
}

/** One delivery a line asks for. */
export interface DeliveryIntent {
  /** The command that asked. */
  readonly verb: string;
  /** The destination as the operator typed it, quoting removed; null when the command gave none or it cannot be bound. */
  readonly destination: string | null;
  /**
   * Why this intent can authorise no delivery, when it cannot: the
   * destination is written with a reference (`$OUT`), whose value only the
   * engine knows. Such an intent matches nothing, whatever the engine sends.
   */
  readonly unbound?: string;
  /** The sources the line named, each as it binds a delivered file; absent when the line's command names none. */
  readonly sources?: ReadonlyArray<SourceIntent>;
}

/**
 * A delivered file, as the engine names it: where it is in the store, and the name it is to be written by.
 *
 * @example
 * ```ts
 * const file: DeliveredFile = { path: '/home/me/scans/a/1.dcm', filename: 'a/1.dcm' };
 * ```
 */
export interface DeliveredFile {
  /** Its path in the store. */
  readonly path: string;
  /** The name to write it by under the destination: its base name, or its path inside a downloaded folder. */
  readonly filename: string;
}

/**
 * Whether a delivery's destination is one a line asked for.
 *
 * @param intents - What the delivery's own line asked for.
 * @param destination - The destination a delivery names; undefined or empty when it names none.
 * @returns True when some bound intent has exactly that destination, or none where the delivery has none.
 */
export function deliveryIntent_matches(intents: ReadonlyArray<DeliveryIntent>, destination: string | undefined): boolean {
  const asked: string | null = destination === undefined || destination.length === 0 ? null : destination;
  return intents.some((intent: DeliveryIntent): boolean => intent.unbound === undefined && intent.destination === asked);
}

/**
 * Whether a delivered file is one a source the line named would send: the source itself (its base name, both as
 * the file's own and as the name written), or a file inside it when it is a folder (the store path ends with the
 * folder's name and the written name, which is the file's path inside it). The written name is relative and never
 * climbs.
 *
 * @param sources - What the line named.
 * @param file - The file the engine says it delivers.
 * @returns True when some source sends it.
 *
 * @example
 * ```ts
 * deliverySource_matches([{ name: 'scans' }], { path: '/home/me/scans/a/1.dcm', filename: 'a/1.dcm' }); // true
 * ```
 */
export function deliverySource_matches(sources: ReadonlyArray<SourceIntent>, file: DeliveredFile): boolean {
  const parts: string[] = file.filename.split('/');
  if (file.filename.length === 0 || file.filename.startsWith('/') || parts.some((part: string): boolean => part === '..' || part === '' || part === '.')) return false;
  const base: string = file.path.split('/').filter((part: string): boolean => part.length > 0).pop() ?? '';
  const inside: boolean = file.path.endsWith(`/${file.filename}`);
  const folder: string = inside ? (file.path.slice(0, -(file.filename.length + 1)).split('/').filter((part: string): boolean => part.length > 0).pop() ?? '') : '';
  return sources.some((source: SourceIntent): boolean => {
    if ('anyFolder' in source) return inside || file.path === file.filename;
    if ('name' in source) return (file.filename === source.name && base === source.name) || (inside && folder === source.name);
    return (file.filename === base && minimatch(base, source.pattern)) || (inside && folder.length > 0 && minimatch(folder, source.pattern));
  });
}

