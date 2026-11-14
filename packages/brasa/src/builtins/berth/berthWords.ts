/**
 * @file The words the `berth` subcommands share: a refusal in the verb's
 * tone, a count with its noun, the bytes of some files, and an anchor's node
 * as the listing names it.
 *
 * Key components:
 * - BerthRefusal: a refusal, said after `berth: ` with an exit status of 1.
 * - count_say: `1 file`, `3 files`.
 * - columns_render: rows laid out in columns.
 * - bytes_sum: the sum of some files' sizes.
 * - anchorNode_show: an anchor's node by its folder name, or `none`.
 *
 * Typical usage:
 * ```ts
 * throw new BerthRefusal(`close: ${count_say(2, 'anchor')} have no node`);
 * ```
 *
 * Dependencies: none.
 *
 * @module
 */
import type { BerthAnchor } from './berthState.js';

/**
 * A refusal: the verb's words for it, and an exit status of 1.
 *
 * @example
 * ```ts
 * throw new BerthRefusal('drop: no anchor named sub-01');
 * ```
 */
export class BerthRefusal extends Error {
  /**
   * @param message - The words after `berth: `.
   */
  constructor(message: string) {
    super(message);
    this.name = 'BerthRefusal';
  }
}

/**
 * A count with its noun, `1 file`, `3 files`.
 *
 * @param count - The count.
 * @param noun - The noun, singular.
 * @returns The words.
 *
 * @example
 * ```ts
 * count_say(3, 'file'); // '3 files'
 * ```
 */
export function count_say(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The sum of the sizes of some files.
 *
 * @param files - The files.
 * @returns Their bytes.
 *
 * @example
 * ```ts
 * bytes_sum([{ size: 4 }, { size: 6 }]); // 10
 * ```
 */
export function bytes_sum(files: ReadonlyArray<{ readonly size: number }>): number {
  return files.reduce((total: number, file: { readonly size: number }): number => total + file.size, 0);
}

/**
 * Lays rows out in columns, each as wide as its widest cell.
 *
 * @param rows - The rows, the header first.
 * @returns The lines.
 *
 * @example
 * ```ts
 * columns_render([['PID', 'COMMAND'], ['412', 'vim']]); // ['PID  COMMAND', '412  vim']
 * ```
 */
export function columns_render(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = (rows[0] ?? []).map((_cell: string, at: number): number => Math.max(...rows.map((row: readonly string[]): number => (row[at] ?? '').length)));
  return rows.map((row: readonly string[]): string => row.map((cell: string, at: number): string => (at === row.length - 1 ? cell : cell.padEnd(widths[at] ?? 0))).join('  ').trimEnd());
}

/**
 * The node of an anchor by its folder name, read from its path.
 *
 * @param anchor - The anchor.
 * @returns `pl-fshack_41`, the id when the path names no such folder, or `none`.
 *
 * @example
 * ```ts
 * anchorNode_show({ name: 'sub-01', path: '/home/alice/feeds/feed_5/pl-fshack_41/data/sub-01', node: 41, feed: 5, files: [], anchoredAt: '' }); // 'pl-fshack_41'
 * ```
 */
export function anchorNode_show(anchor: BerthAnchor): string {
  if (anchor.node === null) return 'none';
  return anchor.path.split('/').reverse().find((segment: string): boolean => segment.endsWith(`_${anchor.node}`)) ?? String(anchor.node);
}
