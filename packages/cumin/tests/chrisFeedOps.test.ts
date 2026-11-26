/**
 * @file Tests for feed operations: creation from directories, visibility,
 * notes and comments. Connection mocked at the client boundary; the plugin
 * lookup used by createFromDirs is mocked at the ChRISPlugin seam.
 */

let mockPluginIDsGet: jest.Mock;

jest.mock('../src/connect/chrisConnection', () => ({
  chrisConnection: { client_get: jest.fn() },
}));
jest.mock('../src/plugins/chrisPlugins', () => ({
  ChRISPlugin: class {
    pluginIDs_get(name: string): Promise<unknown> {
      return mockPluginIDsGet(name) as Promise<unknown>;
    }
  },
}));

import { chrisConnection } from '../src/connect/chrisConnection';
import {
  ChRISFeed,
  feed_makePublic,
  feed_makePrivate,
  feed_delete,
  feed_get,
  feed_resolve,
  feedNote_get,
  feedNote_update,
  feedComments_list,
  feedComment_create,
  feedComment_delete,
  feedComment_update,
} from '../src/feeds/chrisFeed';
import { errorStack } from '../src/error/errorStack';
import { procCache_get } from '../src/cache/procCache';
import type { FeedRecord } from '../src/feeds/chrisFeed';
import type { Result } from '../src/utils/result';

const mockClientGet: jest.Mock = chrisConnection.client_get as unknown as jest.Mock;

/** Feed resource carrying a collection+json body for resourceFields_get. */
const feedCollection = (fields: Record<string, unknown>): Record<string, unknown> => ({
  collection: {
    items: [{
      data: Object.entries(fields).map(([name, value]: [string, unknown]) => ({ name, value })),
      href: `https://cube/api/v1/feeds/${String(fields.id)}/`,
      links: [],
    }],
  },
});

let pushSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  mockPluginIDsGet = jest.fn();
  pushSpy = jest.spyOn(errorStack, 'stack_push').mockImplementation(() => undefined);
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  pushSpy.mockRestore();
  errSpy.mockRestore();
});

describe('ChRISFeed.createFromDirs', () => {
  it('creates a dircopy instance and reports the new feed detail', async () => {
    const createPluginInstance = jest.fn(async () => ({
      getFeed: jest.fn(async () => feedCollection({ id: 5, name: 'My Feed', owner_username: 'chris' })),
    }));
    mockClientGet.mockResolvedValue({ createPluginInstance });
    mockPluginIDsGet.mockResolvedValue({ hits: [17] });

    const detail = await new ChRISFeed().createFromDirs('/home/chris/data', { params: '' });
    expect(mockPluginIDsGet).toHaveBeenCalledWith('pl-dircopy');
    expect(createPluginInstance).toHaveBeenCalledWith(17, expect.objectContaining({ dir: '/home/chris/data' }));
    expect(detail).toMatchObject({ name: 'My Feed', owner_username: 'chris' });
    expect(detail?.pluginInstance).toBeDefined();
  });

  it('passes structured feed parameters without comma-delimited title parsing', async () => {
    const createPluginInstance = jest.fn(async () => ({
      getFeed: jest.fn(async () => feedCollection({
        id: 9,
        name: 'Baseline, repeat: 2',
        owner_username: 'chris',
      })),
    }));
    mockClientGet.mockResolvedValue({ createPluginInstance });
    mockPluginIDsGet.mockResolvedValue({ hits: [17] });

    await new ChRISFeed().createFromDirs('/home/chris/data', { title: 'Baseline, repeat: 2' });

    expect(createPluginInstance).toHaveBeenCalledWith(17, {
      dir: '/home/chris/data',
      title: 'Baseline, repeat: 2',
    });
  });

  it('fails when pl-dircopy is not registered', async () => {
    mockClientGet.mockResolvedValue({});
    mockPluginIDsGet.mockResolvedValue(null);
    expect(await new ChRISFeed().createFromDirs('/d', { params: '' })).toBeNull();
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('pl-dircopy was not found'));
  });

  it('fails when not connected', async () => {
    mockClientGet.mockResolvedValue(null);
    expect(await new ChRISFeed().createFromDirs('/d', { params: '' })).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('fails when instance creation throws', async () => {
    mockClientGet.mockResolvedValue({
      createPluginInstance: jest.fn(async () => { throw new Error('422'); }),
    });
    mockPluginIDsGet.mockResolvedValue({ hits: [17] });
    expect(await new ChRISFeed().createFromDirs('/d', { params: '' })).toBeNull();
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('422'));
  });

  it('returns null when the created instance yields no feed', async () => {
    mockClientGet.mockResolvedValue({
      createPluginInstance: jest.fn(async () => ({ getFeed: jest.fn(async () => null) })),
    });
    mockPluginIDsGet.mockResolvedValue({ hits: [17] });
    expect(await new ChRISFeed().createFromDirs('/d', { params: '' })).toBeNull();
  });
});

describe('feed visibility and lifecycle', () => {
  it('resolves numeric and feed-directory specifiers directly', async () => {
    const getFeed: jest.Mock = jest.fn(async (id: number) => ({ data: { id, name: `Feed ${id}` } }));
    mockClientGet.mockResolvedValue({ getFeed });

    const numeric: Result<FeedRecord> = await feed_resolve('5');
    const directory: Result<FeedRecord> = await feed_resolve('feed_6');

    expect(numeric.ok && numeric.value).toMatchObject({ id: 5, name: 'Feed 5' });
    expect(directory.ok && directory.value).toMatchObject({ id: 6, name: 'Feed 6' });
    expect(getFeed).toHaveBeenCalledTimes(2);
  });

  it('resolves an exact or unambiguous feed-title search', async () => {
    const getFeeds: jest.Mock = jest.fn(async ({ name }: { name: string }) => ({
      data: name === 'Brain Run'
        ? [{ id: 8, name: 'Brain Run' }, { id: 9, name: 'Brain Run extended' }]
        : [{ id: 10, name: 'Unique reconstruction' }],
    }));
    mockClientGet.mockResolvedValue({ getFeeds });

    const exact: Result<FeedRecord> = await feed_resolve('Brain Run');
    const unique: Result<FeedRecord> = await feed_resolve('reconstruction');

    expect(exact.ok && exact.value.id).toBe(8);
    expect(unique.ok && unique.value.id).toBe(10);
  });

  it('rejects ambiguous feed-title searches', async () => {
    mockClientGet.mockResolvedValue({
      getFeeds: jest.fn(async () => ({
        data: [{ id: 8, name: 'Brain A' }, { id: 9, name: 'Brain B' }],
      })),
    });

    expect((await feed_resolve('Brain')).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('8'));
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('9'));
  });

  it('makes a feed public', async () => {
    const makePublic = jest.fn(async () => ({}));
    mockClientGet.mockResolvedValue({ getFeed: jest.fn(async () => ({ makePublic })) });
    expect((await feed_makePublic(5)).ok).toBe(true);
    expect(makePublic).toHaveBeenCalled();
  });

  it('makes a feed private', async () => {
    const makeUnpublic = jest.fn(async () => ({}));
    mockClientGet.mockResolvedValue({ getFeed: jest.fn(async () => ({ makeUnpublic })) });
    expect((await feed_makePrivate(5)).ok).toBe(true);
    expect(makeUnpublic).toHaveBeenCalled();
  });

  it('deletes a feed, and the session\'s index forgets it at once', async () => {
    procCache_get().cache_clear();
    procCache_get().feed_add({ id: 5, name: 'gone soon', creation_date: '2026-10-03', owner_username: 'chris' } as never);
    expect(procCache_get().feedIDs_get()).toContain(5);
    const del = jest.fn(async () => ({}));
    mockClientGet.mockResolvedValue({ getFeed: jest.fn(async () => ({ delete: del })) });
    expect((await feed_delete(5)).ok).toBe(true);
    expect(del).toHaveBeenCalled();
    expect(procCache_get().feedIDs_get()).not.toContain(5);
  });

  it('keeps the feed in the index when CUBE refuses the delete', async () => {
    procCache_get().cache_clear();
    procCache_get().feed_add({ id: 6, name: 'stays', creation_date: '2026-10-03', owner_username: 'chris' } as never);
    mockClientGet.mockResolvedValue({ getFeed: jest.fn(async () => ({ delete: jest.fn(async () => { throw new Error('403'); }) })) });
    expect((await feed_delete(6)).ok).toBe(false);
    expect(procCache_get().feedIDs_get()).toContain(6);
  });

  it('fetches a feed resource', async () => {
    const feed = { id: 5 };
    mockClientGet.mockResolvedValue({ getFeed: jest.fn(async () => feed) });
    const result = await feed_get(5);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(feed);
  });

  it('errors when the feed is missing', async () => {
    mockClientGet.mockResolvedValue({ getFeed: jest.fn(async () => null) });
    expect((await feed_makePublic(5)).ok).toBe(false);
    expect((await feed_makePrivate(5)).ok).toBe(false);
    expect((await feed_delete(5)).ok).toBe(false);
    expect((await feed_get(5)).ok).toBe(false);
  });

  it('errors when not connected', async () => {
    mockClientGet.mockResolvedValue(null);
    expect((await feed_makePublic(5)).ok).toBe(false);
    expect((await feed_delete(5)).ok).toBe(false);
  });

  it('errors when the visibility call throws', async () => {
    mockClientGet.mockResolvedValue({
      getFeed: jest.fn(async () => ({ makePublic: jest.fn(async () => { throw new Error('403'); }) })),
    });
    expect((await feed_makePublic(5)).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('403'));
  });
});

describe('feed notes', () => {
  it('reads the note title and content', async () => {
    mockClientGet.mockResolvedValue({
      getFeed: jest.fn(async () => ({
        getNote: jest.fn(async () => ({ data: { title: 'Note', content: 'Body' } })),
      })),
    });
    const result = await feedNote_get(5);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ title: 'Note', content: 'Body' });
  });

  it('defaults missing note data to empty strings', async () => {
    mockClientGet.mockResolvedValue({
      getFeed: jest.fn(async () => ({ getNote: jest.fn(async () => ({})) })),
    });
    const result = await feedNote_get(5);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ title: '', content: '' });
  });

  it('keeps the field a note has and reads a missing or null one as empty text', async () => {
    const note_ask = async (data: unknown): Promise<unknown> => {
      mockClientGet.mockResolvedValue({ getFeed: jest.fn(async () => ({ getNote: jest.fn(async () => ({ data })) })) });
      const result = await feedNote_get(5);
      return result.ok ? result.value : 'Err';
    };
    expect(await note_ask({ title: 'Only a title' })).toEqual({ title: 'Only a title', content: '' });
    expect(await note_ask({ title: null, content: 'Body' })).toEqual({ title: '', content: 'Body' });
    // There, and not text: refused.
    expect(await note_ask({ title: 'T', content: 7 })).toBe('Err');
    expect(await note_ask({ title: {}, content: 'Body' })).toBe('Err');
  });

  it('updates the note in place', async () => {
    const put = jest.fn(async () => ({}));
    mockClientGet.mockResolvedValue({
      getFeed: jest.fn(async () => ({ getNote: jest.fn(async () => ({ put })) })),
    });
    expect((await feedNote_update(5, { title: 'T' })).ok).toBe(true);
    expect(put).toHaveBeenCalledWith({ title: 'T' });
  });

  it('errors when the feed is missing', async () => {
    mockClientGet.mockResolvedValue({ getFeed: jest.fn(async () => null) });
    expect((await feedNote_get(5)).ok).toBe(false);
    expect((await feedNote_update(5, {})).ok).toBe(false);
  });
});

describe('feed comments', () => {
  it('lists comments', async () => {
    mockClientGet.mockResolvedValue({
      getFeed: jest.fn(async () => ({
        getComments: jest.fn(async () => ({ data: [{ id: 1, title: 'c', content: 'x', owner_username: 'u' }] })),
      })),
    });
    const result = await feedComments_list(5);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(1);
  });

  it('creates a comment and returns the created payload', async () => {
    const post = jest.fn(async () => ({ data: [{ id: 3, title: 'hi', content: 'there', owner_username: 'u' }] }));
    mockClientGet.mockResolvedValue({
      getFeed: jest.fn(async () => ({ getComments: jest.fn(async () => ({ post })) })),
    });
    const result = await feedComment_create(5, { title: 'hi', content: 'there' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(3);
    expect(post).toHaveBeenCalledWith({ title: 'hi', content: 'there' });
  });

  it('falls back to a synthetic record when the create response is empty', async () => {
    mockClientGet.mockResolvedValue({
      getFeed: jest.fn(async () => ({
        getComments: jest.fn(async () => ({ post: jest.fn(async () => ({})) })),
      })),
    });
    const result = await feedComment_create(5, { title: 'hi' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ id: 0, title: 'hi', content: '', owner_username: '' });
  });

  it('deletes and updates a comment', async () => {
    const del = jest.fn(async () => ({}));
    const put = jest.fn(async () => ({}));
    mockClientGet.mockResolvedValue({
      getFeed: jest.fn(async () => ({ getComment: jest.fn(async () => ({ delete: del, put })) })),
    });
    expect((await feedComment_delete(5, 3)).ok).toBe(true);
    expect(del).toHaveBeenCalled();
    expect((await feedComment_update(5, 3, { content: 'edit' })).ok).toBe(true);
    expect(put).toHaveBeenCalledWith({ content: 'edit' });
  });

  it('errors when the comment is missing', async () => {
    mockClientGet.mockResolvedValue({
      getFeed: jest.fn(async () => ({ getComment: jest.fn(async () => null) })),
    });
    expect((await feedComment_delete(5, 3)).ok).toBe(false);
    expect((await feedComment_update(5, 3, {})).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('Comment 3 not found'));
  });
});

describe('feed lifecycle error paths', () => {
  const notConnected = async (fn: () => Promise<{ ok: boolean }>): Promise<void> => {
    mockClientGet.mockResolvedValue(null);
    expect((await fn()).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('Not connected'));
  };
  const feedMissing = async (fn: () => Promise<{ ok: boolean }>): Promise<void> => {
    mockClientGet.mockResolvedValue({ getFeed: jest.fn(async () => null) });
    expect((await fn()).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('not found'));
  };

  it('every lifecycle op fails cleanly when not connected', async () => {
    expect.hasAssertions();
    await notConnected(() => feed_makePublic(1));
    await notConnected(() => feed_makePrivate(1));
    await notConnected(() => feed_delete(1));
    await notConnected(() => feed_resolve('1'));
    await notConnected(() => feedNote_get(1));
    await notConnected(() => feedNote_update(1, { title: 't', content: 'c' }));
    await notConnected(() => feedComments_list(1));
    await notConnected(() => feedComment_create(1, { title: 'hi' }));
    await notConnected(() => feedComment_delete(1, 2));
  });

  it('every lifecycle op fails cleanly on a missing feed', async () => {
    expect.hasAssertions();
    await feedMissing(() => feed_makePublic(9));
    await feedMissing(() => feed_makePrivate(9));
    await feedMissing(() => feed_delete(9));
    await feedMissing(() => feedNote_get(9));
    await feedMissing(() => feedNote_update(9, { title: 't', content: 'c' }));
    await feedMissing(() => feedComments_list(9));
    await feedMissing(() => feedComment_create(9, { title: 'hi' }));
  });

  it('reports the underlying error when a lifecycle call throws', async () => {
    mockClientGet.mockResolvedValue({
      getFeed: jest.fn(async () => ({
        makePublic: jest.fn(async () => { throw new Error('server said no'); }),
        makeUnpublic: jest.fn(async () => { throw new Error('server said no'); }),
        delete: jest.fn(async () => { throw new Error('server said no'); }),
      })),
    });
    expect((await feed_makePublic(3)).ok).toBe(false);
    expect((await feed_makePrivate(3)).ok).toBe(false);
    expect((await feed_delete(3)).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('server said no'));
  });

  it('makes a feed private and deletes a feed on the happy path', async () => {
    const makeUnpublic = jest.fn(async () => ({}));
    const del = jest.fn(async () => undefined);
    mockClientGet.mockResolvedValue({ getFeed: jest.fn(async () => ({ makeUnpublic, delete: del })) });
    expect((await feed_makePrivate(4)).ok).toBe(true);
    expect((await feed_delete(4)).ok).toBe(true);
    expect(makeUnpublic).toHaveBeenCalled();
    expect(del).toHaveBeenCalled();
  });
});

describe('feed notes and comments', () => {
  it('reads and updates a feed note', async () => {
    const put = jest.fn(async () => ({}));
    const getNote = jest.fn(async () => ({ data: { id: 1, title: 'Note', content: 'body' }, put }));
    mockClientGet.mockResolvedValue({ getFeed: jest.fn(async () => ({ getNote })) });

    const read = await feedNote_get(5);
    expect(read.ok && read.value).toMatchObject({ title: 'Note', content: 'body' });

    const write = await feedNote_update(5, { title: 'New', content: 'updated' });
    expect(write.ok).toBe(true);
    expect(put).toHaveBeenCalledWith({ title: 'New', content: 'updated' });
  });

  it('lists, creates, deletes, and updates comments', async () => {
    const commentPut = jest.fn(async () => ({ data: [{ id: 7, title: 'edited', owner_username: 'chris' }] }));
    const commentDelete = jest.fn(async () => undefined);
    const comment = { data: { id: 7, title: 'hello', owner_username: 'chris' }, put: commentPut, delete: commentDelete };
    const post = jest.fn(async () => ({ data: [comment.data] }));
    const getComments = jest.fn(async () => ({ data: [comment.data], post }));
    const getComment = jest.fn(async () => comment);
    mockClientGet.mockResolvedValue({
      getFeed: jest.fn(async () => ({ getComments, getComment })),
    });

    const listed = await feedComments_list(5);
    expect(listed.ok && listed.value).toEqual([comment.data]);

    const created = await feedComment_create(5, { title: 'hello' });
    expect(created.ok && created.value).toMatchObject({ id: 7, title: 'hello' });
    expect(post).toHaveBeenCalledWith({ title: 'hello' });

    const deleted = await feedComment_delete(5, 7);
    expect(deleted.ok).toBe(true);
    expect(commentDelete).toHaveBeenCalled();

    const updated = await feedComment_update(5, 7, { title: 'edited' });
    expect(updated.ok).toBe(true);
    expect(commentPut).toHaveBeenCalledWith({ title: 'edited' });
  });
});
