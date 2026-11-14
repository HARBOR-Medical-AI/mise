/**
 * @file The ChRIS argument kinds a resource command's line names: a feed and
 * a compute resource. Each checks its word and completes from the session:
 * a feed from the feeds its index holds, a compute resource from CUBE.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockFeedIDs = jest.fn((): number[] => [3, 12, 120]);
const mockComputeAll = jest.fn(async (): Promise<unknown> => ({ ok: true, value: [{ name: 'host' }, { name: 'moc' }] }));
jest.unstable_mockModule('@fnndsc/cumin', () => ({
  procCache_get: () => ({ feedIDs_get: mockFeedIDs }),
  computeResources_getAll: mockComputeAll,
}));

const { FEED_KIND, COMPUTE_KIND, chrisArgumentKinds } = await import('../src/chris/kinds.js');
const { errorStack } = await import('@fnndsc/fond');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('the feed kind', () => {
  it('takes any word that names a feed, and refuses an empty one', () => {
    expect(FEED_KIND.word_read('feed_12', { kind: 'feed' })).toEqual({ ok: true, value: 'feed_12' });
    expect(FEED_KIND.word_read('Brain', { kind: 'feed' })).toEqual({ ok: true, value: 'Brain' });
    expect(FEED_KIND.word_read('', { kind: 'feed' }).ok).toBe(false);
  });

  it('completes the feed_N of every feed the index holds, newest first, or the ids when a digit is typed', async () => {
    expect(await FEED_KIND.words_complete?.('feed_1', { kind: 'feed' })).toEqual(['feed_120', 'feed_12']);
    expect(await FEED_KIND.words_complete?.('', { kind: 'feed' })).toEqual(['feed_120', 'feed_12', 'feed_3']);
    expect(await FEED_KIND.words_complete?.('1', { kind: 'feed' })).toEqual(['120', '12']);
  });
});

describe('the compute kind', () => {
  it('completes the names CUBE lists, after the last comma typed', async () => {
    expect(await COMPUTE_KIND.words_complete?.('', { kind: 'compute' })).toEqual(['host', 'moc']);
    expect(await COMPUTE_KIND.words_complete?.('host,m', { kind: 'compute' })).toEqual(['host,moc']);
  });

  it('completes nothing, and leaves nothing on the error stack, when CUBE cannot be read', async () => {
    mockComputeAll.mockImplementationOnce(async (): Promise<unknown> => {
      errorStack.stack_push('error', 'CUBE unreachable');
      return { ok: false };
    });
    const before: number = errorStack.checkpoint_mark();
    expect(await COMPUTE_KIND.words_complete?.('h', { kind: 'compute' })).toEqual([]);
    expect(errorStack.checkpoint_mark()).toBe(before);
  });
});

describe('the ChRIS kinds', () => {
  it('are registered through the backend seam, by name', () => {
    expect(chrisArgumentKinds.map((kind) => kind.name)).toEqual(['anchor', 'feed', 'compute']);
  });
});
