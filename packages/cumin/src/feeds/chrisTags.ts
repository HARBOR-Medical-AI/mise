/**
 * @file A feed's tags: CUBE's freeform labels, which a user owns and hangs
 * on feeds through taggings. The kernel speaks them as extended attributes
 * (`getfattr`, `setfattr`); this is the adapter beneath.
 *
 * A tag is the user's own object (a name and a colour); a tagging joins one
 * tag to one feed. The user's tags are a vocabulary of their own, made,
 * renamed and deleted as folders under `/proc/tags`: hanging a tag on a feed
 * names one that exists and never makes one; removing it from a feed deletes
 * the tagging and leaves the tag, which may hang on other feeds.
 *
 * @module
 */
import {
  itemData_get,
  listData_get,
  type Client,
  type Feed,
  type FeedTagList,
  type FeedTaggingList,
  type TagList,
  type Tagging,
  type Tag,
  type TagFeedList,
  shape_object,
  shape_build,
  type Shape,
} from "../chrisapi/adapter.js";
import { chrisConnection } from "../connect/chrisConnection.js";
import { collectionPage_wrap, listPages_drain, type ListPage } from "../chrisapi/contract.js";
import { errorStack } from "../error/errorStack.js";
import { Result, Ok, Err } from "../utils/result.js";

/** One tag as a feed wears it. */
export interface FeedTag {
  id: number;
  name: string;
  color: string;
}

/** A tag in a list: its name is compared and shown as text, its id used as a number. */
const FEED_TAG_SHAPE: Shape<FeedTag> = shape_build<FeedTag>('a tag')(['id', 'number'], ['name', 'string']);

/** One of the user's own tags, read for the roster: its id and colour are kept as they are; its name is looked at first. */
const OWNED_TAG_SHAPE: Shape<FeedTag> = shape_build<FeedTag>('a tag')(['id', 'number'], ['color', 'string']);

/** The data of a tagging: what joins a tag to a feed. */
interface TaggingData {
  /** The tag's id; only compared. */
  ['tag_id']?: number;
}

/** A feed that wears a tag. */
interface TaggedFeed {
  /** The feed's id. */
  id: number;
}

/** A tagging: an object, its tag's id only compared. */
const TAGGING_SHAPE: Shape<TaggingData> = shape_object<TaggingData>('a tagging');

/** A feed that wears a tag: its id is kept as a number. */
const TAGGED_FEED_SHAPE: Shape<TaggedFeed> = shape_build<TaggedFeed>('a tagged feed')(['id', 'number']);

/** One of the user's tags, and the feeds that wear it. */
export interface TagEntry {
  id: number;
  name: string;
  color: string;
  /** The feeds wearing it, by id. */
  feeds: number[];
}

/** How long the tags index serves before it is read again, ms. */
export const TAGS_MAP_TTL_MS: number = 60_000;

/** The tags index, and when it was read; null until first asked. */
let tagsMap: { at: number; tags: Map<string, TagEntry>; resources: Map<string, Tag>; byFeed: Map<number, string[]> } | null = null;

/** Forgets the tags index: a tag changed here, or a test starts clean. */
export function feedTagsMap_forget(): void {
  tagsMap = null;
}

/**
 * The message a name the vocabulary does not hold earns, naming the cure.
 *
 * @param name - The tag asked for.
 * @returns The refusal's words.
 */
export function tagMissing_message(name: string): string {
  return `${name}: No such tag (mkdir /proc/tags/${name})`;
}

/** The colour a tag is made in when the kernel makes it: CUBE requires one. */
export const TAG_COLOR_DEFAULT: string = '#888888';

/**
 * The connected client and the feed, or the reason there are none.
 *
 * @param feedId - The feed.
 * @param doing - What was being done, for the error.
 * @returns The client and feed, or null with the error stacked.
 */
async function feed_reach(feedId: number, doing: string): Promise<{ client: Client; feed: Feed } | null> {
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
  return { client, feed };
}

/**
 * Every tag a feed wears.
 *
 * @param feed - The feed.
 * @returns Its tags.
 */
async function tags_drain(feed: Feed): Promise<FeedTag[]> {
  return listPages_drain(async (offset: number, limit: number): Promise<ListPage<FeedTag>> => {
    const list: FeedTagList = await feed.getTags({ limit, offset });
    return collectionPage_wrap(list, listData_get(list, FEED_TAG_SHAPE));
  });
}

/**
 * Lists the tags a feed wears.
 *
 * @param feedId - The feed.
 * @returns Its tags, by name.
 */
export async function feedTags_list(feedId: number): Promise<Result<FeedTag[]>> {
  try {
    const reached = await feed_reach(feedId, 'tags');
    if (reached === null) return Err();
    return Ok(await tags_drain(reached.feed));
  } catch (error: unknown) {
    errorStack.stack_push('error', `Failed to list tags of feed ${feedId}: ${error instanceof Error ? error.message : String(error)}`);
    return Err();
  }
}

/**
 * Hangs a tag on a feed by name: the user's tag of that name, which must
 * exist (it is made with `mkdir /proc/tags/<name>`).
 *
 * @param feedId - The feed.
 * @param name - The tag's name.
 * @returns True when it was added, false when the feed already wore it.
 */
export async function feedTag_add(feedId: number, name: string): Promise<Result<boolean>> {
  try {
    const reached = await feed_reach(feedId, 'tag');
    if (reached === null) return Err();
    const worn: FeedTag[] = await tags_drain(reached.feed);
    if (worn.some((tag: FeedTag): boolean => tag.name === name)) return Ok(false);
    // CUBE lists a user their own tags: a name found here is theirs.
    const owned: TagList = await reached.client.getTags({ name });
    const found: FeedTag | undefined = listData_get(owned, FEED_TAG_SHAPE).find((tag: FeedTag): boolean => tag.name === name);
    if (found === undefined) {
      errorStack.stack_push('error', tagMissing_message(name));
      return Err();
    }
    await reached.feed.addTagging(found.id);
    feedTagsMap_forget();
    return Ok(true);
  } catch (error: unknown) {
    errorStack.stack_push('error', `Failed to tag feed ${feedId} with ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return Err();
  }
}

/**
 * Takes a tag off a feed by name: the tagging goes, the tag stays (it may
 * hang on other feeds).
 *
 * @param feedId - The feed.
 * @param name - The tag's name.
 * @returns True when it was removed, false when the feed did not wear it.
 */
export async function feedTag_remove(feedId: number, name: string): Promise<Result<boolean>> {
  try {
    const reached = await feed_reach(feedId, 'untag');
    if (reached === null) return Err();
    const tag: FeedTag | undefined = (await tags_drain(reached.feed)).find((one: FeedTag): boolean => one.name === name);
    if (tag === undefined) return Ok(false);
    const taggings: FeedTaggingList = await reached.feed.getTaggings({ limit: 100, offset: 0 });
    const tagging: Tagging | undefined = ((taggings.getItems() ?? []) as Tagging[])
      .find((one: Tagging): boolean => itemData_get(one, TAGGING_SHAPE)?.tag_id === tag.id);
    if (tagging === undefined) return Ok(false);
    await tagging.delete();
    feedTagsMap_forget();
    return Ok(true);
  } catch (error: unknown) {
    errorStack.stack_push('error', `Failed to untag feed ${feedId} of ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return Err();
  }
}

/**
 * The user's tags and each tag's feeds, read once and kept: the user's tags
 * (one read) and each tag's feeds (one read per tag) — a listing of a
 * thousand feeds costs as many reads as the user has tags, never one per
 * feed. Kept for {@link TAGS_MAP_TTL_MS}, and forgotten whenever a tag or a
 * tagging changes here.
 *
 * @param now - The clock (a test hands in its own).
 * @returns The index, or Err with the reason stacked.
 */
async function tagsIndex_read(now: number): Promise<Result<NonNullable<typeof tagsMap>>> {
  if (tagsMap !== null && now - tagsMap.at < TAGS_MAP_TTL_MS) return Ok(tagsMap);
  const client: Client | null = await chrisConnection.client_get();
  if (!client) {
    errorStack.stack_push('error', 'Not connected to ChRIS.');
    return Err();
  }
  try {
    const byFeed: Map<number, string[]> = new Map();
    const tags: Map<string, TagEntry> = new Map();
    const resources: Map<string, Tag> = new Map();
    const found: Tag[] = [];
    for (let offset: number = 0; ; offset += 100) {
      const page: TagList = await client.getTags({ limit: 100, offset });
      found.push(...((page.getItems() ?? []) as Tag[]));
      if (!page.hasNextPage) break;
    }
    for (const tag of found) {
      const data: FeedTag | null = itemData_get(tag, OWNED_TAG_SHAPE);
      const name: string = data?.name ?? '';
      if (name === '' || data === null) continue;
      const feeds: Array<{ id: number }> = await listPages_drain(async (offset: number, limit: number): Promise<ListPage<{ id: number }>> => {
        const list: TagFeedList = await tag.getTaggedFeeds({ limit, offset });
        return collectionPage_wrap(list, listData_get(list, TAGGED_FEED_SHAPE));
      });
      tags.set(name, { id: data.id, name, color: data.color, feeds: feeds.map((feed: { id: number }): number => feed.id) });
      resources.set(name, tag);
      for (const feed of feeds) byFeed.set(feed.id, [...(byFeed.get(feed.id) ?? []), name]);
    }
    tagsMap = { at: now, tags, resources, byFeed };
    return Ok(tagsMap);
  } catch (error: unknown) {
    errorStack.stack_push('error', `Failed to read the tags: ${error instanceof Error ? error.message : String(error)}`);
    return Err();
  }
}

/**
 * Every feed's tags at once, for a listing that shows them (see
 * {@link tagsIndex_read} for what it costs and how long it is kept).
 *
 * @param now - The clock (a test hands in its own).
 * @returns Feed id to its tag names.
 */
export async function feedTags_readByFeed(now: number = Date.now()): Promise<Result<Map<number, string[]>>> {
  const index = await tagsIndex_read(now);
  return index.ok ? Ok(index.value.byFeed) : Err();
}

/**
 * The user's tags, each with the feeds that wear it: the vocabulary
 * `/proc/tags` lists, and the feeds each of its folders holds.
 *
 * @param now - The clock (a test hands in its own).
 * @returns Tag name to its entry.
 */
export async function tags_index(now: number = Date.now()): Promise<Result<Map<string, TagEntry>>> {
  const index = await tagsIndex_read(now);
  return index.ok ? Ok(index.value.tags) : Err();
}

/**
 * Makes a tag in the user's vocabulary (`mkdir /proc/tags/<name>`).
 *
 * @param name - The new tag's name.
 * @returns True when made; Err with "File exists" when the user has it already.
 */
export async function tag_create(name: string): Promise<Result<boolean>> {
  const client: Client | null = await chrisConnection.client_get();
  if (!client) {
    errorStack.stack_push('error', 'Not connected to ChRIS.');
    return Err();
  }
  try {
    const owned: TagList = await client.getTags({ name });
    if (listData_get(owned, FEED_TAG_SHAPE).some((tag: FeedTag): boolean => tag.name === name)) {
      errorStack.stack_push('error', `${name}: File exists`);
      return Err();
    }
    await client.createTag({ name, color: TAG_COLOR_DEFAULT });
    feedTagsMap_forget();
    return Ok(true);
  } catch (error: unknown) {
    errorStack.stack_push('error', `Failed to make tag ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return Err();
  }
}

/**
 * The user's tag of a name, as a resource to change, read fresh.
 *
 * @param name - The tag's name.
 * @returns The tag and its feeds, or Err with "No such tag" stacked.
 */
async function tag_reach(name: string): Promise<Result<{ tag: Tag; entry: TagEntry }>> {
  feedTagsMap_forget();
  const index = await tagsIndex_read(Date.now());
  if (!index.ok) return Err();
  const tag: Tag | undefined = index.value.resources.get(name);
  const entry: TagEntry | undefined = index.value.tags.get(name);
  if (tag === undefined || entry === undefined) {
    errorStack.stack_push('error', `${name}: No such file or directory`);
    return Err();
  }
  return Ok({ tag, entry });
}

/**
 * Deletes a tag from the user's vocabulary (`rmdir /proc/tags/<name>`); a
 * tag that still hangs on a feed is refused, as a folder that holds
 * something is.
 *
 * @param name - The tag's name.
 * @returns True when deleted; Err with "Directory not empty" while feeds wear it.
 */
export async function tag_delete(name: string): Promise<Result<boolean>> {
  try {
    const reached = await tag_reach(name);
    if (!reached.ok) return Err();
    if (reached.value.entry.feeds.length > 0) {
      const count: number = reached.value.entry.feeds.length;
      errorStack.stack_push('error', `${name}: Directory not empty (${count} ${count === 1 ? 'feed wears' : 'feeds wear'} it)`);
      return Err();
    }
    await reached.value.tag.delete();
    feedTagsMap_forget();
    return Ok(true);
  } catch (error: unknown) {
    errorStack.stack_push('error', `Failed to delete tag ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return Err();
  }
}

/**
 * Renames one of the user's tags (`mv /proc/tags/<from> /proc/tags/<to>`):
 * every feed wearing it wears the new name.
 *
 * @param from - The tag's name now.
 * @param to - Its new name.
 * @returns True when renamed; Err with "File exists" when the user has a tag of the new name.
 */
export async function tag_rename(from: string, to: string): Promise<Result<boolean>> {
  try {
    const reached = await tag_reach(from);
    if (!reached.ok) return Err();
    if (tagsMap?.tags.has(to) === true) {
      errorStack.stack_push('error', `${to}: File exists`);
      return Err();
    }
    // CUBE's PUT takes the whole tag: the colour is sent back as it was.
    await reached.value.tag.put({ name: to, color: reached.value.entry.color });
    feedTagsMap_forget();
    return Ok(true);
  } catch (error: unknown) {
    errorStack.stack_push('error', `Failed to rename tag ${from}: ${error instanceof Error ? error.message : String(error)}`);
    return Err();
  }
}
