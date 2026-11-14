/**
 * @file The words of a feed's access list: `setfacl`'s entries, the
 * targets a feed is named by, and `getfacl`'s block.
 *
 * A feed shared with another identity is, in POSIX terms, an access
 * control entry: `setfacl -m u:someone:r <path>`, `setfacl -m g:lab:r`,
 * and the other entry `setfacl -m o::r` for everyone (a public feed). That
 * is the verb a terminal already knows. "Share X with Y" is a sentence — it
 * belongs to a natural-language assist, not to a shell.
 *
 * The line itself is parsed against each command's declaration (`acl.ts`);
 * these read the words inside its values. Dependency-free, so they are
 * tested without the engine.
 *
 * @module
 */

/** Which identity an entry names. */
export type AclKind = 'user' | 'group' | 'other';

/** One access control entry, as `setfacl -m` spells it. */
export interface AclEntry {
  kind: AclKind;
  /** The user or group; empty for the other entry. */
  name: string;
  /** Permission letters, in `rwx` order, minus omitted. */
  perms: string;
}

/** A grant to withdraw, as `setfacl -x` names it. */
export interface AclRemoval {
  kind: 'user' | 'group';
  name: string;
}

/** Who can read a feed besides its owner, as `getfacl` shows it. */
export interface AclView {
  users: readonly string[];
  groups: readonly string[];
  public: boolean;
}

/** The words for an entry's kind, short and long. */
const KIND_OF: Readonly<Record<string, AclKind>> = { u: 'user', user: 'user', g: 'group', group: 'group', o: 'other', other: 'other' };

/**
 * Reads an access control entry: `u:<user>:<perms>`, `g:<group>:<perms>`,
 * or the other entry `o::<perms>` (also `o:<perms>`); long kinds read too.
 *
 * @param spec - The entry as typed.
 * @returns The entry, or null when it is none of these.
 */
export function aclEntry_parse(spec: string): AclEntry | null {
  const parts: string[] = spec.split(':');
  const kind: AclKind | undefined = KIND_OF[parts[0] ?? ''];
  if (kind === undefined) return null;
  if (kind === 'other') {
    // `o::r` names no one; `o:r` is the same entry spelled shorter.
    const perms: string | null = parts.length === 3 && parts[1] === '' ? (parts[2] ?? '') : parts.length === 2 ? (parts[1] ?? '') : null;
    return perms !== null && /^[rwx-]*$/.test(perms) ? { kind, name: '', perms } : null;
  }
  if (parts.length !== 3) return null;
  const name: string = parts[1] ?? '';
  const perms: string = parts[2] ?? '';
  if (name === '' || !/^[rwx-]*$/.test(perms)) return null;
  return { kind, name, perms };
}

/**
 * Reads the grant `setfacl -x` withdraws: `u:<user>` or `g:<group>` (a bare
 * name is a user, as on Linux).
 *
 * @param spec - The entry as typed.
 * @returns The grant, or the refusal's words.
 */
export function aclRemoval_parse(spec: string): AclRemoval | string {
  const parts: string[] = spec.split(':');
  // `o` or `other` alone names the other entry, never a user called "o".
  const bareOther: boolean = parts.length === 1 && KIND_OF[spec] === 'other';
  const kind: AclKind | undefined = bareOther ? 'other' : parts.length === 1 ? 'user' : KIND_OF[parts[0] ?? ''];
  const name: string = parts.length === 1 ? (parts[0] ?? '') : (parts[1] ?? '');
  if (kind === 'other') return "setfacl: the other entry cannot be removed; make the feed private with setfacl -m o::- (or chmod o-r)";
  if (kind === undefined || name === '') return `setfacl: '${spec}' names no user or group (want u:<user> or g:<group>)`;
  return { kind, name };
}

/**
 * Resolves a feed id from an id, a `feed_N` name, a path through `/feeds/`,
 * or its projection `/proc/jobs/feed_N`.
 *
 * @param target - What the operator typed.
 * @returns The feed id, or null when nothing in it names a feed.
 */
export function aclTarget_resolve(target: string): number | null {
  const bare: number = Number(target);
  if (Number.isInteger(bare) && bare > 0) return bare;
  const named: RegExpMatchArray | null = target.match(/^feed_(\d+)$/);
  if (named !== null) return Number(named[1]);
  const inPath: RegExpMatchArray | null = target.match(/\/(?:feeds|proc\/jobs)\/feed_(\d+)(?:\/|$)/);
  return inPath !== null ? Number(inPath[1]) : null;
}

/**
 * Renders an access list the way `getfacl` does: the owner's entry, one line
 * per user and per group granted read, then the other entry (public or not).
 *
 * @param path - The path as the operator named it.
 * @param owner - The owning identity, when known.
 * @param access - Who can read it.
 * @returns The rendered block, without a trailing newline.
 */
export function acl_render(path: string, owner: string | null, access: AclView): string {
  const name: string = path.replace(/^\//, '');
  const lines: string[] = [`# file: ${name}`];
  if (owner !== null) lines.push(`# owner: ${owner}`);
  lines.push('user::rw-');
  for (const user of access.users) lines.push(`user:${user}:r--`);
  for (const group of access.groups) lines.push(`group:${group}:r--`);
  lines.push(access.public ? 'other::r--' : 'other::---');
  return lines.join('\n');
}
