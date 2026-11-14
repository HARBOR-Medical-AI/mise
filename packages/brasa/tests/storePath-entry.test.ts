/**
 * @file The two narrower answers of the one store-path resolver: a path's
 * entry itself (what `rm` and `mv` act on: a link, not what it points at),
 * and a path with only the mounts asked (a run's `data` path named in its
 * feed, a node under it still a node).
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../src/session/index.js', () => ({
  session: { getCWD: async (): Promise<string> => '/home/alice' },
}));

const { linkedStore_install, VIA_PROC, VIA_FEED, LINKED, OUTPUT } = await import('./support/linkedStore.js');
const { storePath_resolve } = await import('../src/core/paths.js');

beforeEach((): void => {
  linkedStore_install();
});

describe('storePath_resolve: the entry, and the mounts alone', () => {
  it('follows the link by either address', async () => {
    expect(await storePath_resolve(`${VIA_PROC}/hello.txt`)).toBe(`${LINKED}/hello.txt`);
    expect(await storePath_resolve(`${VIA_FEED}/hello.txt`)).toBe(`${LINKED}/hello.txt`);
  });

  it('names a link itself as its entry, where its folder is kept', async () => {
    expect(await storePath_resolve(VIA_PROC, { entry: true })).toBe(VIA_FEED);
    expect(await storePath_resolve(VIA_FEED, { entry: true })).toBe(VIA_FEED);
  });

  it('names an entry behind the link in the folder the link points at', async () => {
    expect(await storePath_resolve(`${VIA_PROC}/inner`, { entry: true })).toBe(`${LINKED}/inner`);
    expect(await storePath_resolve('/', { entry: true })).toBe('/');
  });

  it('asks only the mounts when links are not to be followed', async () => {
    expect(await storePath_resolve(`${VIA_PROC}/hello.txt`, { links: false })).toBe(`${VIA_FEED}/hello.txt`);
    expect(await storePath_resolve('/proc/jobs/feed_5/pl-dircopy_10/data', { links: false })).toBe(OUTPUT);
  });
});
