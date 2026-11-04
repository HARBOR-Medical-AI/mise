/**
 * @file `find`: POSIX's expression over the namespace, walked through the
 * listing cache, in the order find prints, refusing what it does not know.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

/** What CUBE names for a workflow asked by id: run 51177's one job, pl-dylld_11, in feed_5 alone. */
const mockWorkflowJobs = jest.fn(async (workflowId: number): Promise<{ feeds: number[]; jobs: number[] }> => (workflowId === 51177 ? { feeds: [5], jobs: [11] } : { feeds: [], jobs: [] }));
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  context_getSingle: jest.fn(async () => ({ user: 'chris', folder: '/home/chris' })),
  workflowJobs_get: mockWorkflowJobs,
}));
cuminMock_install(() => ({
  envelope_ok: (rendered: string) => ({ status: 'ok', rendered }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => (renderedErr !== undefined ? { status: 'error', rendered, renderedErr } : { status: 'error', rendered }),
}));
jest.unstable_mockModule('@fnndsc/chili/models/listing.js', () => ({}));
jest.unstable_mockModule('../src/session/index.js', () => ({ session: { getCWD: jest.fn(async () => '/home/chris'), setCWD: jest.fn() } }));

/** The tree: what each folder lists. */
const TREE: Record<string, Array<{ name: string; type: string; date?: string; status?: string }>> = {
  '/proc/jobs': [{ name: 'feed_5', type: 'job' }, { name: 'feed_6', type: 'job' }],
  // feed_5 as its listing gives it (a run asked by id walks the feed, indexed or not).
  '/proc/jobs/feed_5': [{ name: 'status', type: 'file' }, { name: 'pl-dircopy_10', type: 'job', status: 'finishedSuccessfully' }],
  '/proc/jobs/feed_5/pl-dircopy_10': [{ name: 'status', type: 'file' }, { name: 'pl-dylld_11', type: 'job', status: 'finishedWithError' }],
  '/proc/jobs/feed_5/pl-dircopy_10/pl-dylld_11': [{ name: 'status', type: 'file' }],
  '/proc/jobs/feed_6': [{ name: 'pl-dylld_12', type: 'job', status: 'started' }],
  '/proc/jobs/feed_6/pl-dylld_12': [{ name: 'status', type: 'file' }],
  '/home/chris': [{ name: 'a.nii', type: 'file', date: '2026-10-01T00:00:00Z' }, { name: 'feeds', type: 'dir' }, { name: 'link1', type: 'link' }],
  '/home/chris/feeds': [{ name: 'feed_1', type: 'dir' }, { name: 'notes.txt', type: 'file', date: '2026-10-15T00:00:00Z' }],
  '/home/chris/feeds/feed_1': [{ name: 'b.nii', type: 'file', date: '2026-10-16T00:00:00Z' }],
};
const listed: string[] = [];
const mockListingGet = jest.fn(async (target: string, options: { directory?: boolean } = {}) => {
  if (options.directory) {
    if (target in TREE) return { ok: true, value: { path: target, items: [{ name: target.split('/').pop(), type: 'dir', size: 0, owner: '', date: '' }], fresh: true } };
    return { ok: false };
  }
  listed.push(target);
  const items = TREE[target];
  return items === undefined ? { ok: false } : { ok: true, value: { path: target, items: items.map((i) => ({ size: 0, owner: '', date: '', ...i })), fresh: true } };
});
jest.unstable_mockModule('../src/lib/vfs/vfs.js', () => ({ vfs: { listing_get: mockListingGet } }));
/** /proc/jobs answered whole, as its mount does from the job index: one feed indexed, one not. */
const mockSubtree = jest.fn(async (root: string) => root !== '/proc/jobs' ? null : {
  entries: [
    { rel: 'feed_5', depth: 1, item: { name: 'feed_5', type: 'job', size: 0, owner: '', date: '2026-10-01T00:00:00Z', status: 'finishedSuccessfully' }, attrs: { status: 'finishedSuccessfully' } },
    { rel: 'feed_5/status', depth: 2, item: { name: 'status', type: 'file', size: 0, owner: '', date: '' } },
    { rel: 'feed_5/pl-dircopy_10', depth: 2, item: { name: 'pl-dircopy_10', type: 'job', size: 0, owner: '', date: '2026-10-02T00:00:00Z' }, attrs: { status: 'finishedSuccessfully', plugin: 'pl-dircopy', pipeline: '', workflow: '' } },
    { rel: 'feed_5/pl-dircopy_10/pl-dylld_11', depth: 3, item: { name: 'pl-dylld_11', type: 'job', size: 0, owner: '', date: '2026-10-03T00:00:00Z' }, attrs: { status: 'finishedWithError', plugin: 'pl-dylld', pipeline: 'FreeSurfer 8.2.0 per subject', workflow: '51177' } },
    { rel: 'feed_6', depth: 1, item: { name: 'feed_6', type: 'job', size: 0, owner: '', date: '' }, attrs: { status: 'started' } },
  ],
  unanswered: ['feed_6'],
});
jest.unstable_mockModule('../src/core/filesystem.js', () => ({ vfsDispatcher_get: () => ({ subtree: mockSubtree }) }));
jest.unstable_mockModule('../src/lib/spinner.js', () => ({ spinner: { start: jest.fn(), stop: jest.fn(), updateMessage: jest.fn() } }));

const { builtin_find, find_parse, pattern_convertToRegExp } = await import('../src/builtins/fs/find.js');
const { commandCancellation_run, commandCancellation_abort } = await import('../src/core/cancellation.js');

beforeEach(() => { listed.length = 0; process.exitCode = 0; });

describe('find', () => {
  it('prints everything beneath a path, an entry before what lies under it', async () => {
    const result = await builtin_find(['.']);
    expect(result.rendered).toBe(['.', './a.nii', './feeds', './feeds/feed_1', './feeds/feed_1/b.nii', './feeds/notes.txt', './link1', ''].join('\n'));
  });

  it('selects by name and type, and does not follow links', async () => {
    expect((await builtin_find(['.', '-name', '*.nii'])).rendered).toBe('./a.nii\n./feeds/feed_1/b.nii\n');
    expect((await builtin_find(['.', '-type', 'd'])).rendered).toBe('.\n./feeds\n./feeds/feed_1\n');
    expect((await builtin_find(['.', '-type', 'l'])).rendered).toBe('./link1\n');
  });

  it('joins tests with -o, ! and parentheses, and -path matches across /', async () => {
    expect((await builtin_find(['.', '-name', '*.txt', '-o', '-name', 'b.*'])).rendered).toBe('./feeds/feed_1/b.nii\n./feeds/notes.txt\n');
    expect((await builtin_find(['.', '-type', 'f', '!', '-name', '*.nii'])).rendered).toBe('./feeds/notes.txt\n');
    expect((await builtin_find(['.', '(', '-name', 'a.*', '-o', '-name', 'notes*', ')', '-type', 'f'])).rendered).toBe('./a.nii\n./feeds/notes.txt\n');
    expect((await builtin_find(['.', '-path', './feeds*nii'])).rendered).toBe('./feeds/feed_1/b.nii\n');
  });

  it('bounds the walk with -maxdepth and -mindepth, never listing below the bound', async () => {
    expect((await builtin_find(['.', '-maxdepth', '1'])).rendered).toBe('.\n./a.nii\n./feeds\n./link1\n');
    expect(listed).toEqual(['/home/chris']);
    expect((await builtin_find(['.', '-mindepth', '2', '-type', 'f'])).rendered).toBe('./feeds/feed_1/b.nii\n./feeds/notes.txt\n');
  });

  it('-newermt compares the listing date; -print0 ends paths with NUL', async () => {
    expect((await builtin_find(['.', '-newermt', '2026-10-10'])).rendered).toBe('./feeds/feed_1/b.nii\n./feeds/notes.txt\n');
    expect((await builtin_find(['.', '-name', '*.nii', '-print0'])).rendered).toBe('./a.nii\0./feeds/feed_1/b.nii\0');
  });

  it('refuses an unknown predicate or a bad argument by name, and names a path that is not there', async () => {
    expect(find_parse(['.', '-bogus'])).toBe("find: unknown predicate '-bogus'");
    expect(find_parse(['.', '-type', 'x'])).toBe("find: -type takes f, d or l, not 'x'");
    expect(find_parse(['.', '-maxdepth', 'two'])).toBe("find: -maxdepth takes a number, not 'two'");
    expect(find_parse(['.', '-name'])).toBe('find: -name needs an argument');
    expect(find_parse(['.', '(', '-name', 'x'])).toBe("find: a '(' is not closed");
    const refused = await builtin_find(['.', '-bogus']);
    expect(refused.status).toBe('error');
    expect(process.exitCode).toBe(1);
    const missing = await builtin_find(['/nowhere']);
    expect(missing.renderedErr).toContain("find: '/nowhere': No such file or directory");
  });

  it('Ctrl-C (or STOP) stops a walk, saying how far it got', async () => {
    const result = await commandCancellation_run(async () => {
      mockListingGet.mockImplementationOnce(async (target: string) => {
        commandCancellation_abort();
        listed.push(target);
        return { ok: true, value: { path: target, items: [{ name: 'feeds', type: 'dir', size: 0, owner: '', date: '' }], fresh: true } };
      });
      return builtin_find(['/home/chris']);
    });
    expect(result.renderedErr).toMatch(/find: stopped \(Ctrl-C\) after \d+ folders; \d+ found so far/);
    expect(listed.length).toBeLessThanOrEqual(1);      // nothing walked past the stop
  });

  it('answers /proc/jobs from the job index, walking only what it left unanswered', async () => {
    const result = await builtin_find(['/proc/jobs', '-plugin', 'pl-dy*']);
    expect(result.rendered).toBe('/proc/jobs/feed_5/pl-dircopy_10/pl-dylld_11\n/proc/jobs/feed_6/pl-dylld_12\n');
    expect(listed).toEqual(['/proc/jobs/feed_6', '/proc/jobs/feed_6/pl-dylld_12']);   // only the feed not indexed is walked
    expect((await builtin_find(['/proc/jobs', '-status', 'finishedWithError'])).rendered).toBe('/proc/jobs/feed_5/pl-dircopy_10/pl-dylld_11\n');
    expect((await builtin_find(['/proc/jobs', '-maxdepth', '1'])).rendered).toBe('/proc/jobs\n/proc/jobs/feed_5\n/proc/jobs/feed_6\n');
  });

  it('-pipeline and -workflow ask which pipeline run made a job, and say what they could not judge', async () => {
    const result = await builtin_find(['/proc/jobs', '-pipeline', 'freesurfer*']);
    expect(result.rendered).toBe('/proc/jobs/feed_5/pl-dircopy_10/pl-dylld_11\n');
    // feed_6's job came from the walk, its run not known: said, and the find is not a failure.
    expect(result.renderedErr).toContain('find: 1 job not judged: which pipeline run made it is not known yet');
    expect(result.status).toBe('ok');
    expect((await builtin_find(['/proc/jobs', '-workflow', '51177'])).rendered).toBe('/proc/jobs/feed_5/pl-dircopy_10/pl-dylld_11\n');
    expect((await builtin_find(['/proc/jobs', '-pipeline', ''])).rendered).toBe('/proc/jobs/feed_5/pl-dircopy_10\n');   // run directly
  });

  it('-workflow by id reads the run\'s feeds alone, each judged by the run\'s own jobs, index or no index (#1364)', async () => {
    listed.length = 0;
    const result = await builtin_find(['/proc/jobs', '-workflow', '51177', '-plugin', 'pl-dylld']);
    expect(mockWorkflowJobs).toHaveBeenCalledWith(51177);
    expect(result.rendered).toBe('/proc/jobs/feed_5/pl-dircopy_10/pl-dylld_11\n');
    // The run's feed is walked as its listing gives it; /proc/jobs itself and feed_6 are never listed, nothing is left unjudged.
    expect(listed).toEqual(['/proc/jobs/feed_5', '/proc/jobs/feed_5/pl-dircopy_10', '/proc/jobs/feed_5/pl-dircopy_10/pl-dylld_11']);
    expect(result.renderedErr).toBeUndefined();
    // A job in the run's feed but not of the run (pl-dircopy_10 rooted it) is not the run's.
    expect((await builtin_find(['/proc/jobs', '-workflow', '51177'])).rendered).toBe('/proc/jobs/feed_5/pl-dircopy_10/pl-dylld_11\n');
    // A pattern is not an id: every feed is still read.
    listed.length = 0;
    await builtin_find(['/proc/jobs', '-workflow', '5*']);
    expect(listed).toContain('/proc/jobs/feed_6');
  });

  it('matches shell patterns: * crosses /, ? one character, [..] a class, \\ escapes', () => {
    expect(pattern_convertToRegExp('*.nii').test('a/b.nii')).toBe(true);
    expect(pattern_convertToRegExp('?.nii').test('ab.nii')).toBe(false);
    expect(pattern_convertToRegExp('[ab].nii').test('b.nii')).toBe(true);
    expect(pattern_convertToRegExp('[!ab].nii').test('b.nii')).toBe(false);
    expect(pattern_convertToRegExp('\\*').test('*')).toBe(true);
    expect(pattern_convertToRegExp('A*', true).test('abc')).toBe(true);
  });
});
