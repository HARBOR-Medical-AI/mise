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
 * One source a delivering line named, as far as the surface can bind a delivered file to it: the operand as typed,
 * a pattern the engine expands, or none (a place only the session knows).
 *
 * @example
 * ```ts
 * const named: SourceIntent = { operand: '/home/me/scans' };
 * ```
 */
export type SourceIntent = OperandSource | PatternSource | UnresolvedSource;

/**
 * A source named by its operand as typed, quoting removed.
 *
 * @example
 * ```ts
 * const named: OperandSource = { operand: 'scans' };
 * ```
 */
export interface OperandSource {
  /** The operand. */
  readonly operand: string;
}

/**
 * A source the engine expands from a pattern: the operand's pattern as typed.
 *
 * @example
 * ```ts
 * const matched: PatternSource = { pattern: '/home/me/*.dcm' };
 * ```
 */
export interface PatternSource {
  /** The pattern. */
  readonly pattern: string;
}

/**
 * A source whose place only the session knows (`.`, `~`, a path climbing with `..`): it binds nothing.
 *
 * @example
 * ```ts
 * const unknown: UnresolvedSource = { unresolved: 'its source "." names a place only the session knows' };
 * ```
 */
export interface UnresolvedSource {
  /** Why. */
  readonly unresolved: string;
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
 * A delivered file, as the engine names it: where it is in the store, the name it is to be written by, and the
 * source it came from as the engine resolved it.
 *
 * @example
 * ```ts
 * const file: DeliveredFile = { path: '/home/me/scans/a/1.dcm', filename: 'a/1.dcm', source: '/home/me/scans' };
 * ```
 */
export interface DeliveredFile {
  /** Its path in the store. */
  readonly path: string;
  /** The name to write it by under the destination: its base name, or its path inside a downloaded folder. */
  readonly filename: string;
  /** The source it came from, as the engine resolved it; absent from an engine that does not say. */
  readonly source: string | undefined;
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
 * A store path in one spelling: no empty or `.` segments, no trailing slash, `/` for the root; relative stays
 * relative.
 *
 * @param spelled - The path.
 * @returns The same path, normalised.
 *
 * @example
 * ```ts
 * storePath_normalise('././a//b/'); // 'a/b'
 * ```
 */
export function storePath_normalise(spelled: string): string {
  const parts: string[] = spelled.split('/').filter((part: string): boolean => part.length > 0 && part !== '.');
  return spelled.startsWith('/') ? `/${parts.join('/')}` : parts.join('/');
}

/**
 * Settles a line's download sources against the session folder this chell was last shown, taken when the line is
 * sent: a relative operand or pattern becomes absolute under it. Without a folder shown, an intent with a relative
 * source binds nothing (a delivery for it is put to the person).
 *
 * @param intents - The line's intents.
 * @param cwd - The session folder this chell showed, absolute; null when none was shown.
 * @returns The intents with every source absolute, or unbound.
 *
 * @example
 * ```ts
 * sourceIntents_settle(intents, '/home/me'); // { operand: 'scans' } becomes { operand: '/home/me/scans' }
 * ```
 */
export function sourceIntents_settle(intents: ReadonlyArray<DeliveryIntent>, cwd: string | null): DeliveryIntent[] {
  return intents.map((intent: DeliveryIntent): DeliveryIntent => {
    if (intent.sources === undefined) return intent;
    const settled: SourceIntent[] = [];
    for (const source of intent.sources) {
      if ('unresolved' in source) return { verb: intent.verb, destination: null, unbound: source.unresolved };
      const spelled: string = 'operand' in source ? source.operand : source.pattern;
      if (!spelled.startsWith('/') && cwd === null) {
        return { verb: intent.verb, destination: null, unbound: `its source ${JSON.stringify(spelled)} is relative, and no session folder has been shown here: type its full path` };
      }
      const absolute: string = storePath_normalise(spelled.startsWith('/') ? spelled : `${cwd ?? ''}/${spelled}`);
      settled.push('operand' in source ? { operand: absolute } : { pattern: absolute });
    }
    return { ...intent, sources: settled };
  });
}

/**
 * Whether an operand, settled absolute, names a resolved root: the same path, both normalised.
 *
 * @param operand - The operand, absolute.
 * @param root - The root the engine resolved.
 * @returns True when it names it.
 */
function operand_names(operand: string, root: string): boolean {
  return operand.startsWith('/') && storePath_normalise(operand) === storePath_normalise(root);
}

/**
 * Whether a resolved root is one a pattern, settled absolute, names: its last segment matches the pattern's last
 * segment and its folder is the pattern's folder.
 *
 * @param pattern - The pattern, absolute.
 * @param root - The root the engine resolved.
 * @returns True when it names it.
 */
function pattern_names(pattern: string, root: string): boolean {
  if (!pattern.startsWith('/')) return false;
  const wanted: string = storePath_normalise(pattern);
  const resolved: string = storePath_normalise(root);
  const cut: number = wanted.lastIndexOf('/');
  const name: string = resolved.slice(resolved.lastIndexOf('/') + 1);
  if (!minimatch(name, wanted.slice(cut + 1))) return false;
  const folder: string = wanted.slice(0, cut) || '/';
  const parent: string = resolved.slice(0, resolved.lastIndexOf('/')) || '/';
  return folder === parent;
}

/**
 * Whether a delivered file is one a source the line named sends: the root the engine resolved is one the line's
 * operand (or pattern) names, and the file is that root (written by its base name) or a file under it (written by
 * its path inside). The written name is relative and never climbs. A file with no root named is no source's.
 *
 * @param sources - What the line named.
 * @param file - The file the engine says it delivers.
 * @returns True when some source sends it.
 *
 * @example
 * ```ts
 * deliverySource_matches([{ operand: 'scans' }], { path: '/home/me/scans/a/1.dcm', filename: 'a/1.dcm', source: '/home/me/scans' }); // true
 * ```
 */
export function deliverySource_matches(sources: ReadonlyArray<SourceIntent>, file: DeliveredFile): boolean {
  const parts: string[] = file.filename.split('/');
  if (file.filename.length === 0 || file.filename.startsWith('/') || parts.some((part: string): boolean => part === '..' || part === '' || part === '.')) return false;
  if (file.source === undefined) return false;
  const root: string = storePath_normalise(file.source);
  const base: string = root.slice(root.lastIndexOf('/') + 1);
  const path: string = storePath_normalise(file.path);
  const shaped: boolean = (path === root && file.filename === base) || path === `${root === '/' ? '' : root}/${file.filename}`;
  if (!shaped) return false;
  return sources.some((source: SourceIntent): boolean => {
    if ('operand' in source) return operand_names(source.operand, root);
    if ('pattern' in source) return pattern_names(source.pattern, root);
    return false;
  });
}
