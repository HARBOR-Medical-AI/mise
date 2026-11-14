/**
 * @file The words of a feed's tags: the one attribute, the targets a feed
 * is named by, and `getfattr`'s dump.
 *
 * A feed's tags are, in POSIX terms, an extended attribute: `setfattr -n
 * tag -v urgent feed_12` hangs one, `getfattr feed_12` reads them. One
 * attribute exists, `tag` (also spelled `user.tag`), and it holds many
 * values — CUBE's tags on the feed.
 *
 * The line itself is parsed against each command's declaration
 * (`xattr.ts`). Dependency-free, as `acl.args.ts` is, so these are tested
 * without the engine.
 *
 * @module
 */
import { aclTarget_resolve } from './acl.args.js';

/** The one attribute a feed carries. */
export const XATTR_TAG: string = 'tag';

/** The names that attribute answers to: `tag`, and `user.tag` as Linux namespaces it. */
export const XATTR_NAMES: readonly ['tag', 'user.tag'] = ['tag', 'user.tag'];

/**
 * The feed a path names: an id, a `feed_N`, a path through `/feeds/` as
 * setfacl reads it, or the projection `/proc/jobs/feed_N`.
 *
 * @param target - The path as typed.
 * @returns The feed id, or null.
 *
 * @example
 * ```ts
 * xattrTarget_resolve('/proc/jobs/feed_12'); // 12
 * ```
 */
export function xattrTarget_resolve(target: string): number | null {
  const held: number | null = aclTarget_resolve(target);
  if (held !== null) return held;
  const projected: RegExpMatchArray | null = target.match(/\/jobs\/feed_(\d+)(?:\/|$)/);
  return projected !== null ? Number(projected[1]) : null;
}

/**
 * Renders a feed's tags the way `getfattr` dumps attributes: a `# file:`
 * line, then one `tag="…"` line per value; nothing under it when bare.
 *
 * @param path - The path as named.
 * @param tags - The tag names.
 * @returns The block.
 *
 * @example
 * ```ts
 * xattr_render('feed_12', ['urgent']); // '# file: feed_12\ntag="urgent"'
 * ```
 */
export function xattr_render(path: string, tags: ReadonlyArray<string>): string {
  return [`# file: ${path}`, ...tags.map((tag: string): string => `${XATTR_TAG}="${tag.replace(/"/g, '\\"')}"`)].join('\n');
}
