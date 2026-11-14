/**
 * @file Where the store keeps a path: one answer for every reader and
 * lister, whatever form the path is asked in, through a link at any depth.
 *
 * The defect it pins (2026-11-14): a run's output read through the graph's
 * own address, `/proc/jobs/feed_N/pl-dircopy_M/data/<link>/file`, was
 * mapped to the feed path and read there with the `.chrislink` in it
 * unfollowed, so CUBE found no folder and every such file was unreadable
 * (`Failed to initialize ChRIS context`), while `ls` of the same folder,
 * which followed the link, listed it.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Ok, Err, VFSDispatcher, errorStack, type Result, type VFSItem, type VFSProvider } from '@fnndsc/fond';

let cwd: string = '/home/alice';
jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: async (): Promise<string> => cwd },
}));

const { backend_install } = await import('../src/core/backend.js');
const { storePath_resolve } = await import('../src/core/paths.js');

/** A run's output folder in the store, as CUBE records it. */
const OUTPUT: string = '/home/alice/feeds/feed_5/pl-dircopy_10/data';
/** The `.chrislink` a pl-dircopy leaves in its output, and where it points. */
const LINK: string = `${OUTPUT}/home_alice_uploads_set`;
const LINKED: string = '/home/alice/uploads/set';

/** A mount that stands for a store folder under its `data` and holds the rest itself, as `/proc/jobs` does. */
const proc: VFSProvider = {
  prefix: '/proc/jobs',
  async list(): Promise<Result<VFSItem[]>> { return Ok([]); },
  async cp() { return { ok: false as const, errno: 'EROFS' as const }; },
  async storePath_resolve(path: string): Promise<Result<string | null>> {
    const data: RegExpExecArray | null = /^\/proc\/jobs\/feed_5\/pl-dircopy_10\/data(\/.*)?$/.exec(path);
    if (data !== null) return Ok(`${OUTPUT}${data[1] ?? ''}`);
    if (path.startsWith('/proc/jobs/feed_5/pl-gone_11/data')) {
      errorStack.stack_push('error', 'No CFS output path is available for job 11');
      return Err();
    }
    return Ok(null);
  },
};
/** A mount a link may land under, which holds its files itself. */
const pacs: VFSProvider = {
  prefix: '/SERVICES/PACS',
  async list(): Promise<Result<VFSItem[]>> { return Ok([]); },
  async cp() { return { ok: false as const, errno: 'EROFS' as const }; },
};

/** The store's link walk, as the ChRIS backend contributes it (the session's `.chrislink`s). */
const walked: string[] = [];
async function links_follow(path: string): Promise<string> {
  walked.push(path);
  if (path === LINK || path.startsWith(`${LINK}/`)) return `${LINKED}${path.slice(LINK.length)}`;
  if (path.startsWith('/home/alice/pulled')) return `/SERVICES/PACS/PACSDCM${path.slice('/home/alice/pulled'.length)}`;
  errorStack.stack_push('error', `no link walk for ${path}`);
  return path;
}

/** The store itself: every path no mount claims. */
const store: VFSProvider = {
  prefix: '',
  async list(): Promise<Result<VFSItem[]>> { return Ok([]); },
  async cp() { return { ok: false as const, errno: 'EROFS' as const }; },
};
const dispatcher: VFSDispatcher = new VFSDispatcher(store);
dispatcher.provider_register(proc);
dispatcher.provider_register(pacs);
backend_install({
  id: 'test',
  session: { home_get: async (): Promise<string> => '/home/alice' },
  vfs: { dispatcher, path_physical: links_follow },
} as never);

beforeEach((): void => {
  cwd = '/home/alice';
  walked.length = 0;
  errorStack.stack_clear();
});

describe('storePath_resolve: every form of a path, through a link', () => {
  it('an absolute feed path through the link in a run output', async () => {
    expect(await storePath_resolve(`${LINK}/hello.txt`)).toBe(`${LINKED}/hello.txt`);
  });

  it('a path under the home, `~`', async () => {
    expect(await storePath_resolve('~/feeds/feed_5/pl-dircopy_10/data/home_alice_uploads_set/hello.txt')).toBe(`${LINKED}/hello.txt`);
  });

  it('a path relative to the working directory', async () => {
    cwd = OUTPUT;
    expect(await storePath_resolve('home_alice_uploads_set/sphere.nii.gz')).toBe(`${LINKED}/sphere.nii.gz`);
  });

  it("a node's own data path in /proc/jobs, the link inside it followed after the mount's answer", async () => {
    expect(await storePath_resolve('/proc/jobs/feed_5/pl-dircopy_10/data/home_alice_uploads_set/hello.txt')).toBe(`${LINKED}/hello.txt`);
    expect(walked).toEqual([`${OUTPUT}/home_alice_uploads_set/hello.txt`]);
  });

  it('the data link itself, and a folder through the link inside it', async () => {
    cwd = '/proc/jobs/feed_5/pl-dircopy_10';
    expect(await storePath_resolve('data')).toBe(OUTPUT);
    expect(await storePath_resolve('data/home_alice_uploads_set')).toBe(LINKED);
  });

  it('a link that lands under another mount stops there, read by that mount', async () => {
    expect(await storePath_resolve('/home/alice/pulled/series/1.dcm')).toBe('/SERVICES/PACS/PACSDCM/series/1.dcm');
    expect(walked).toEqual(['/home/alice/pulled/series/1.dcm']);
  });

  it('a file a mount makes itself is asked of the mount where it stands, never walked', async () => {
    expect(await storePath_resolve('/proc/jobs/feed_5/pl-dircopy_10/log')).toBe('/proc/jobs/feed_5/pl-dircopy_10/log');
    expect(walked).toEqual([]);
  });

  it('a path that resolves no further stands as asked, and its walk leaves no note for the read', async () => {
    expect(await storePath_resolve('/home/alice/notes.txt')).toBe('/home/alice/notes.txt');
    expect(errorStack.stack_search('no link walk')).toEqual([]);
    expect(await storePath_resolve('/proc/jobs/feed_5/pl-gone_11/data/a.txt')).toBe('/proc/jobs/feed_5/pl-gone_11/data/a.txt');
  });
});
