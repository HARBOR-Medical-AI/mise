/**
 * @file A feed's name and its access: who it is shared with (users and
 * groups), whether it is public, and the changes to each. The kernel speaks
 * them as `setfacl` / `getfacl` / `chmod` and as the writable
 * `/proc/jobs/feed_N/title`; this is the adapter beneath.
 *
 * CUBE allows every change here to the feed's owner: a feed's name and
 * public flag are written by a PUT on the feed, a user or group grant is a
 * permission posted to the feed, and either kind of grant is withdrawn by
 * deleting that permission.
 *
 * @module
 */
import { itemData_get, listData_get, type Client, type Feed, shape_object, type Shape } from "../chrisapi/adapter.js";
import { chrisConnection } from "../connect/chrisConnection.js";
import { errorStack } from "../error/errorStack.js";
import { Result, Ok, Err } from "../utils/result.js";

/** A row of a feed's permissions: its fields are read only after a check of their own. */
const PERMISSION_ROW_SHAPE: Shape<Record<string, unknown>> = shape_object('a feed permission');

/** A feed's own record, as far as its visibility is read. */
interface FeedVisibility {
  /** Whether the feed is public: compared with `true`, never trusted to be a boolean. */
  public?: unknown;
}

/** A feed read for its visibility: an object, its one field compared and never trusted. */
const FEED_VISIBILITY_SHAPE: Shape<FeedVisibility> = shape_object<FeedVisibility>('a feed');


/** Who can read a feed besides its owner. */
export interface FeedAccess {
  /** Users granted read. */
  users: string[];
  /** Groups granted read. */
  groups: string[];
  /** Whether everyone can read it. */
  public: boolean;
}

/** The two kinds of grant a feed holds. */
export type FeedGrantKind = 'user' | 'group';

/** How many permissions a page asks for. */
const PERMISSIONS_PAGE: number = 100;

/**
 * The connected client and the feed, or the reason there are none.
 *
 * @param feedId - The feed.
 * @param doing - What was being done, for the error.
 * @returns The feed, or null with the error stacked.
 */
async function feed_reach(feedId: number, doing: string): Promise<Feed | null> {
  const client: Client | null = await chrisConnection.client_get();
  if (!client) {
    errorStack.stack_push('error', 'Not connected to ChRIS.');
    return null;
  }
  const feed: Feed | null = await client.getFeed(feedId);
  if (!feed) {
    errorStack.stack_push('error', `${doing}: feed ${feedId} not found.`);
    return null;
  }
  return feed;
}

/**
 * Every name in a feed's permission collection, page by page.
 *
 * @param fetch - Reads one page.
 * @param field - The field naming the holder (`username`, `grp_name`).
 * @returns The names.
 */
async function holders_drain(fetch: (offset: number) => Promise<{ data?: unknown } | null>, field: string): Promise<string[]> {
  const names: string[] = [];
  for (let offset: number = 0; ; offset += PERMISSIONS_PAGE) {
    const rows: Array<Record<string, unknown>> = listData_get(await fetch(offset), PERMISSION_ROW_SHAPE);
    for (const row of rows) {
      const name: string = String(row[field] ?? row['group_name'] ?? '');
      if (name !== '') names.push(name);
    }
    if (rows.length < PERMISSIONS_PAGE) break;
  }
  return names;
}

/**
 * Reads who can read a feed: its users, its groups, and whether it is public.
 *
 * @param feedId - The feed.
 * @returns The access list.
 */
export async function feedAccess_read(feedId: number): Promise<Result<FeedAccess>> {
  try {
    const feed: Feed | null = await feed_reach(feedId, 'access');
    if (feed === null) return Err();
    const users: string[] = await holders_drain((offset: number) => feed.getUserPermissions({ limit: PERMISSIONS_PAGE, offset }), 'username');
    const groups: string[] = await holders_drain((offset: number) => feed.getGroupPermissions({ limit: PERMISSIONS_PAGE, offset }), 'grp_name');
    const data: { public?: unknown } | null = itemData_get(feed, FEED_VISIBILITY_SHAPE);
    return Ok({ users, groups, public: data?.public === true });
  } catch (error: unknown) {
    errorStack.stack_push('error', `Failed to read the access list of feed ${feedId}: ${error instanceof Error ? error.message : String(error)}`);
    return Err();
  }
}

/**
 * Grants a group read on a feed.
 *
 * @param feedId - The feed.
 * @param group - The group's name.
 * @returns True when CUBE recorded the grant.
 */
export async function feedShare_group(feedId: number, group: string): Promise<Result<boolean>> {
  try {
    const feed: Feed | null = await feed_reach(feedId, 'share');
    if (feed === null) return Err();
    await feed.addGroupPermission(group);
    return Ok(true);
  } catch (error: unknown) {
    errorStack.stack_push('error', `Failed to share feed ${feedId} with group ${group}: ${error instanceof Error ? error.message : String(error)}`);
    return Err();
  }
}

/**
 * Withdraws a user's or a group's grant on a feed.
 *
 * @param feedId - The feed.
 * @param kind - Which kind of grant.
 * @param name - The user's or group's name.
 * @returns True when withdrawn; false when the feed held no such grant.
 */
export async function feedShare_revoke(feedId: number, kind: FeedGrantKind, name: string): Promise<Result<boolean>> {
  try {
    const feed: Feed | null = await feed_reach(feedId, 'unshare');
    if (feed === null) return Err();
    const held = kind === 'user' ? await feed.getUserPermission(name) : await feed.getGroupPermission(name);
    if (held === null) return Ok(false);
    await held.delete();
    return Ok(true);
  } catch (error: unknown) {
    errorStack.stack_push('error', `Failed to stop sharing feed ${feedId} with ${kind} ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return Err();
  }
}

/**
 * Renames a feed (its title).
 *
 * @param feedId - The feed.
 * @param name - The new name.
 * @returns True when CUBE took it.
 */
export async function feed_rename(feedId: number, name: string): Promise<Result<boolean>> {
  if (name.trim() === '') {
    errorStack.stack_push('error', `feed ${feedId}: a feed's name cannot be empty`);
    return Err();
  }
  try {
    const feed: Feed | null = await feed_reach(feedId, 'rename');
    if (feed === null) return Err();
    await feed.put({ name });
    return Ok(true);
  } catch (error: unknown) {
    errorStack.stack_push('error', `Failed to rename feed ${feedId}: ${error instanceof Error ? error.message : String(error)}`);
    return Err();
  }
}
