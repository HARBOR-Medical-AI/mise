/**
 * @file The ChRIS argument kinds a resource command's line names: a feed, a
 * compute resource, and a run's CPU and memory limits. Each checks its word
 * and completes from the session: a feed from the feeds its index holds, a
 * compute resource from CUBE.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockFeedIDs = jest.fn((): number[] => [3, 12, 120]);
const mockComputeAll = jest.fn(async (): Promise<unknown> => ({ ok: true, value: [{ name: 'host' }, { name: 'moc' }] }));
jest.unstable_mockModule('@fnndsc/cumin', () => ({
  procCache_get: () => ({ feedIDs_get: mockFeedIDs }),
  computeResources_getAll: mockComputeAll,
}));

const { FEED_KIND, COMPUTE_KIND, CPU_KIND, MEMORY_KIND, chrisArgumentKinds } = await import('../src/chris/kinds.js');
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

describe('the cpu and memory kinds', () => {
  it('take a limit as CUBE writes it: bare, a number in the field\'s unit; with a unit, the word', () => {
    expect(CPU_KIND.word_read('2000m', { kind: 'cpu' })).toEqual({ ok: true, value: '2000m' });
    expect(CPU_KIND.word_read('2000', { kind: 'cpu' })).toEqual({ ok: true, value: 2000 });
    expect(MEMORY_KIND.word_read('8Gi', { kind: 'memory' })).toEqual({ ok: true, value: '8Gi' });
    expect(MEMORY_KIND.word_read('512Mi', { kind: 'memory' })).toEqual({ ok: true, value: '512Mi' });
    expect(MEMORY_KIND.word_read('512', { kind: 'memory' })).toEqual({ ok: true, value: 512 });
  });

  it('refuse a word CUBE would not read, a unit of the other field, and nought', () => {
    for (const word of ['x', '', '0', '0m', '-1', '2Gi', '1.5', 'm']) expect(CPU_KIND.word_read(word, { kind: 'cpu' }).ok).toBe(false);
    for (const word of ['x', '', '0', '0Gi', '8G', '8gi', '2000m', '1.5Gi']) expect(MEMORY_KIND.word_read(word, { kind: 'memory' }).ok).toBe(false);
  });

  it('describe their value in a schema: a positive whole number or the word with its unit', () => {
    expect(CPU_KIND.schema_make({ kind: 'cpu' }).safeParse('2000m').success).toBe(true);
    expect(CPU_KIND.schema_make({ kind: 'cpu' }).safeParse(2000).success).toBe(true);
    expect(CPU_KIND.schema_make({ kind: 'cpu' }).safeParse('2Gi').success).toBe(false);
    expect(MEMORY_KIND.schema_make({ kind: 'memory' }).safeParse('8Gi').success).toBe(true);
    expect(MEMORY_KIND.schema_make({ kind: 'memory' }).safeParse(0).success).toBe(false);
  });
});

describe('the ChRIS kinds', () => {
  it('are registered through the backend seam, by name', () => {
    expect(chrisArgumentKinds.map((kind) => kind.name)).toEqual(['anchor', 'feed', 'compute', 'cpu', 'memory', 'pacsQuery', 'plugin', 'pipeline']);
  });
});
