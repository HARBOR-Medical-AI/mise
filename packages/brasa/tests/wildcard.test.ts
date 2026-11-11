import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();
const mockGetCWD = jest.fn();
const mockVfsList = jest.fn();
const mockResolveChrisFs = jest.fn();

jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: mockGetCWD },
}));
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  vfsDispatcher: { list: mockVfsList },
  context_getSingle: jest.fn(async () => ({ user: 'testuser' })),
}));
jest.unstable_mockModule('@fnndsc/chili/utils/cli.js', () => ({
  path_resolveChrisFs: mockResolveChrisFs,
}));
cuminMock_install(() => ({
  feedTags_readByFeed: jest.fn(),
  Err: (): { ok: false } => ({ ok: false }),
  Ok: <T>(value: T): { ok: true; value: T } => ({ ok: true, value }),
  errorStack: { stack_push: jest.fn() },
  listCache_get: (): { cache_get: typeof mockCacheGet; cache_set: typeof mockCacheSet } => ({
    cache_get: mockCacheGet,
    cache_set: mockCacheSet,
  }),
}));

const { shellWords_expand, wildcard_expandMatches, wildcard_expand, wildcards_expandAll } = await import('../src/builtins/wildcard.js');
const { shellWords_tokenize } = await import('../src/lib/parser.js');
await (await import('./support/chrisPieces.js')).chrisPieces_install({ vfs: true });

describe('wildcard_expandMatches()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCacheGet.mockReturnValue(undefined);
    mockGetCWD.mockResolvedValue('/home/testuser');
    mockResolveChrisFs.mockImplementation(async (value: string): Promise<string> => value);
  });

  it('preserves a CFS link match for target classification', async () => {
    mockVfsList.mockResolvedValue({
      ok: true,
      value: [{ name: 'shared', type: 'link', target: '/PUBLIC/shared' }],
    });

    const result = await wildcard_expandMatches('/PUBLIC/*');

    expect(result).toEqual({
      ok: true,
      value: [{ path: '/PUBLIC/shared', type: 'link' }],
    });
  });

  it('expands an unquoted CFS/VFS word without a command allow-list', async () => {
    mockVfsList.mockResolvedValue({
      ok: true,
      value: [
        { name: 'scan-one.nii', type: 'file' },
        { name: 'scan-two.nii', type: 'file' },
      ],
    });

    const result = await shellWords_expand(shellWords_tokenize('scan-*.nii'), (): boolean => true);

    expect(result).toEqual({
      ok: true,
      value: [
        expect.objectContaining({ value: 'scan-one.nii', pathnameExpanded: true }),
        expect.objectContaining({ value: 'scan-two.nii', pathnameExpanded: true }),
      ],
    });
  });

  it('normalizes a home-relative pattern before listing', async () => {
    mockVfsList.mockResolvedValue({ ok: true, value: [{ name: 'scan.nii', type: 'file' }] });

    const result = await shellWords_expand(shellWords_tokenize('~/feeds/*.nii'), (): boolean => true);

    expect(mockVfsList).toHaveBeenCalledWith('/home/testuser/feeds');
    expect(result).toEqual({
      ok: true,
      value: [expect.objectContaining({ value: '/home/testuser/feeds/scan.nii' })],
    });
  });

  it('lists through a CFS directory link but retains its logical output path', async () => {
    mockResolveChrisFs.mockResolvedValue('/PUBLIC/shared');
    mockVfsList.mockResolvedValue({ ok: true, value: [{ name: 'scan.nii', type: 'file' }] });

    const result = await shellWords_expand(shellWords_tokenize('~/public/*.nii'), (): boolean => true);

    expect(mockVfsList).toHaveBeenCalledWith('/PUBLIC/shared');
    expect(result).toEqual({
      ok: true,
      value: [expect.objectContaining({ value: '/home/testuser/public/scan.nii' })],
    });
  });

  it('expands a wildcard in a middle component, and in two components, sorted at each level (#1439)', async () => {
    const tree: Record<string, Array<{ name: string; type: string }>> = {
      '/home/testuser/feeds': [{ name: 'feed_2', type: 'dir' }, { name: 'feed_1', type: 'dir' }, { name: 'notes.txt', type: 'file' }],
      '/home/testuser/feeds/feed_1': [{ name: 'pl-dircopy_10', type: 'dir' }],
      '/home/testuser/feeds/feed_2': [{ name: 'pl-dircopy_21', type: 'dir' }, { name: 'pl-dircopy_20', type: 'dir' }, { name: 'pl-other_22', type: 'dir' }],
      '/home/testuser/feeds/feed_1/pl-dircopy_10': [{ name: 'data', type: 'dir' }],
      '/home/testuser/feeds/feed_2/pl-dircopy_20': [{ name: 'data', type: 'dir' }],
      '/home/testuser/feeds/feed_2/pl-dircopy_21': [],
    };
    mockVfsList.mockImplementation(async (dir: string) => (tree[dir] !== undefined ? { ok: true, value: tree[dir] } : { ok: false }));
    const values = async (line: string): Promise<string[]> => {
      const result = await shellWords_expand(shellWords_tokenize(line), (): boolean => true);
      return result.ok ? result.value.map((word: { value: string }): string => word.value) : ['<error>'];
    };

    expect(await values('~/feeds/feed_*/pl-dircopy_10')).toEqual(['/home/testuser/feeds/feed_1/pl-dircopy_10']);
    expect(await values('~/feeds/feed_*/pl-dircopy_*/data')).toEqual([
      '/home/testuser/feeds/feed_1/pl-dircopy_10/data',
      '/home/testuser/feeds/feed_2/pl-dircopy_20/data',
    ]);
    // A file matched on the way is not listed, and a pattern matching nothing stays as typed.
    expect(mockVfsList).not.toHaveBeenCalledWith('/home/testuser/feeds/notes.txt');
    expect(await values('~/feeds/feed_9*/pl-dircopy_*/data')).toEqual(['~/feeds/feed_9*/pl-dircopy_*/data']);
    expect(await values('~/feeds/*/pl-nothing_*')).toEqual(['~/feeds/*/pl-nothing_*']);
  });

  it('keeps quoted wildcard syntax literal', async () => {
    const result = await shellWords_expand(shellWords_tokenize("'scan-*.nii'"), (): boolean => true);

    expect(result).toEqual({
      ok: true,
      value: [expect.objectContaining({ value: 'scan-*.nii', pathnameExpanded: false })],
    });
    expect(mockVfsList).not.toHaveBeenCalled();
  });

  it('expands an unquoted wildcard fragment beside a quoted literal fragment', async () => {
    mockVfsList.mockResolvedValue({
      ok: true,
      value: [
        { name: 'scan*1.nii', type: 'file' },
        { name: 'scan-a.nii', type: 'file' },
      ],
    });

    const result = await shellWords_expand(shellWords_tokenize('scan"*"?.nii'), (): boolean => true);

    expect(result).toEqual({
      ok: true,
      value: [expect.objectContaining({ value: 'scan*1.nii', pathnameExpanded: true })],
    });
  });
});

describe('wildcard_expand()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCWD.mockResolvedValue('/home/chris');
    mockResolveChrisFs.mockImplementation(async (p: string) => p);
    mockCacheGet.mockReturnValue(null);
  });

  it('returns a literal pattern untouched when it has no wildcard', async () => {
    const r = await wildcard_expand('plain.txt');
    expect(r.ok && r.value).toEqual(['plain.txt']);
    expect(mockVfsList).not.toHaveBeenCalled();
  });

  it('expands a matching pattern to the matched names', async () => {
    mockVfsList.mockResolvedValue({ ok: true, value: [
      { name: 'a.txt', type: 'file' },
      { name: 'b.log', type: 'file' },
      { name: 'c.txt', type: 'file' },
    ] });
    const r = await wildcard_expand('*.txt');
    expect(r.ok && r.value).toEqual(['a.txt', 'c.txt']);
  });

  it('returns an empty match list when nothing matches', async () => {
    mockVfsList.mockResolvedValue({ ok: true, value: [{ name: 'a.log', type: 'file' }] });
    const r = await wildcard_expand('*.txt');
    expect(r.ok && r.value).toEqual([]);
  });

  it('propagates a listing failure as Err', async () => {
    mockVfsList.mockResolvedValue({ ok: false });
    expect((await wildcard_expand('*.txt')).ok).toBe(false);
  });

  it('serves matches from the listing cache without hitting the dispatcher', async () => {
    mockCacheGet.mockReturnValue({ data: [{ name: 'hit.txt', type: 'file' }], fresh: true });
    const r = await wildcard_expand('*.txt');
    expect(r.ok && r.value).toEqual(['hit.txt']);
    expect(mockVfsList).not.toHaveBeenCalled();
  });

  it('prefixes matches with their directory for pathed patterns', async () => {
    mockVfsList.mockResolvedValue({ ok: true, value: [{ name: 'x.dcm', type: 'file' }] });
    const r = await wildcard_expand('data/*.dcm');
    expect(r.ok && r.value).toEqual(['/home/chris/data/x.dcm']);
  });
});

describe('wildcards_expandAll()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCWD.mockResolvedValue('/home/chris');
    mockResolveChrisFs.mockImplementation(async (p: string) => p);
    mockCacheGet.mockReturnValue(null);
  });

  it('expands wildcard args and passes literals through in order', async () => {
    mockVfsList.mockResolvedValue({ ok: true, value: [
      { name: 'a.txt', type: 'file' },
      { name: 'b.txt', type: 'file' },
    ] });
    const r = await wildcards_expandAll(['keep-me', '*.txt']);
    expect(r.ok && r.value).toEqual(['keep-me', 'a.txt', 'b.txt']);
  });

  it('keeps the original pattern when nothing matches', async () => {
    mockVfsList.mockResolvedValue({ ok: true, value: [] });
    const r = await wildcards_expandAll(['*.nope']);
    expect(r.ok && r.value).toEqual(['*.nope']);
  });

  it('propagates the first expansion failure', async () => {
    mockVfsList.mockResolvedValue({ ok: false });
    expect((await wildcards_expandAll(['*.txt', 'literal'])).ok).toBe(false);
  });
});
