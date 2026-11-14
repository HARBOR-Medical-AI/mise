/**
 * @file Shared prompt rendering utilities.
 * @module
 */

/**
 * Returns the visible (non-ANSI) length of a string.
 *
 * @param s - String possibly containing ANSI escape codes.
 * @returns Number of visible columns.
 */
export function ansi_visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/**
 * Replaces the authenticated user's home-directory prefix with `~`.
 *
 * Other users' home directories and similarly prefixed usernames remain
 * unchanged.
 *
 * @param path - Logical working-directory path.
 * @param user - Authenticated username that owns `/home/<user>`.
 * @returns Home-relative display path, or the original path when outside home.
 */
export function homePath_abbreviate(path: string, user: string): string {
  if (!user) return path;
  const home: string = `/home/${user}`;
  if (path === home || path === `${home}/`) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * Truncates a filesystem path to fit within `maxLen` visible columns.
 *
 * Drops leading path segments (oldest ancestors) replacing them with
 * `...`, then — if the leaf alone still exceeds the budget — truncates
 * the leaf itself from the front.
 *
 * @param path - Absolute or relative path string.
 * @param maxLen - Maximum number of visible columns allowed.
 * @returns Truncated path string (no ANSI codes).
 */
export function path_truncate(path: string, maxLen: number): string {
  if (maxLen <= 0) return '...';
  if (path.length <= maxLen) return path;

  const segments: string[] = path.split('/').filter(Boolean);

  for (let drop: number = 1; drop < segments.length; drop++) {
    const candidate: string = '.../' + segments.slice(drop).join('/');
    if (candidate.length <= maxLen) return candidate;
  }

  const leaf: string = segments[segments.length - 1] ?? path;
  const budget: number = maxLen - 3;
  return '...' + leaf.slice(-Math.max(budget, 0));
}

/**
 * Truncates text from the left, keeping its tail: an identity that is an
 * e-mail address at a tenancy keeps its ending, where the tenancy is, the
 * way a long path keeps its leaf.
 *
 * @param text - The text to fit.
 * @param maxLen - Maximum number of visible columns allowed.
 * @returns The text, or its tail behind `…` when it was longer.
 */
export function text_truncateLeft(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  if (maxLen <= 1) return '…';
  return '…' + text.slice(-(maxLen - 1));
}

/**
 * Formats active `/proc` warm-up progress for prompt themes.
 *
 * Active work is capped at 99%; completion removes the prompt segment instead
 * of briefly presenting a misleading 100% while the sweep is still settling.
 *
 * @param loaded - Number of unique plugin instances loaded.
 * @param total - Server-reported visible plugin-instance total.
 * @returns Compact `N/M f%` progress text, or `N/?` before total is known.
 */
export function procProgress_format(loaded: number, total: number): string {
  if (total <= 0) return `${loaded}/?`;
  const percent: number = Math.min(99, Math.floor((loaded / total) * 100));
  return `${loaded}/${total} ${percent}%`;
}

/**
 * Formats roster arrivals for a prompt: the ids when few, a count when many.
 *
 * @param arrived - Feed ids the roster gained recently.
 * @returns A leading-space segment such as ` [+feed 812]` or ` [+3 feeds]`.
 */
export function feedArrivals_format(arrived: number[]): string {
  if (arrived.length === 0) return '';
  if (arrived.length <= 2) return ` [+feed ${arrived.join(', ')}]`;
  return ` [+${arrived.length} feeds]`;
}

/**
 * Names the warm-up steps that failed behind the prompt.
 *
 * Named rather than counted: "Groups" tells an operator which capability
 * is degraded, where "1 warm-up failed" only tells them to go looking.
 *
 * @param failures - Steps that failed and have not since succeeded.
 * @returns A leading-space segment, or an empty string when none.
 */
export function warmupFailures_format(failures: ReadonlyArray<{ label: string }>): string {
  if (failures.length === 0) return '';
  const named: string = failures.map((failure): string => failure.label.toLowerCase()).join(' ');
  return ` [warm-up failed: ${named}]`;
}

/**
 * Names the warm-up steps still running behind the prompt.
 *
 * @param pending - Labels of the steps that have started and not settled.
 * @returns A leading-space segment, or an empty string when none.
 *
 * @example
 * warmupPending_format(['Public', 'Queries']); // ' [warming: public queries]'
 */
export function warmupPending_format(pending: ReadonlyArray<string>): string {
  if (pending.length === 0) return '';
  return ` [warming: ${pending.map((label: string): string => label.toLowerCase()).join(' ')}]`;
}
