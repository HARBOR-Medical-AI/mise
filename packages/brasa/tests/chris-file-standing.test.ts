/**
 * @file Where a path stands in ChRIS after a read of it failed, and what
 * `play` does with that: a projection is never proved absent, whatever it
 * maps to in the store, and the engine's disk is not read behind it.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

/** Paths the tree was asked the standing of. */
let asked: string[];
let storeResolve: (typed: string) => Promise<string>;
let standing: (path: string) => Promise<string>;
/** What a read of the store answers. */
let bytes: { ok: true; value: Buffer } | { ok: false };

cuminMock_install(() => ({}));
jest.unstable_mockModule('../src/builtins/utils.js', () => ({
  path_resolve: async (typed: string): Promise<string> => (typed.startsWith('/') ? typed : `/home/u/${typed}`),
  storePath_resolve: (typed: string): Promise<string> => storeResolve(typed),
}));
jest.unstable_mockModule('../src/core/filesystem.js', () => ({
  vfsDispatcher_get: () => ({
    // The session's projections, as its tree knows them.
    path_isVirtual: (path: string): boolean => /^\/(proc|pacs|net|bin)(\/|$)/.test(path),
    path_standing: (path: string): Promise<string> => { asked.push(path); return standing(path); },
    readBinary: async (): Promise<{ ok: boolean; value?: Buffer; errno?: string }> => (bytes.ok ? { ok: true, value: bytes.value } : { ok: false, errno: 'ENOENT' }),
  }),
}));
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  fileContent_getBinary: async (): Promise<typeof bytes> => bytes,
  fileContent_getBinaryStream: async (): Promise<{ ok: false }> => ({ ok: false }),
}));

const { chrisFiles } = await import('../src/chris/files.js');
const { manifestText_read } = await import('../src/builtins/res/manifestRead.js');
const { backend_install } = await import('../src/core/backend.js');
const { surface_set, HeadlessSurface } = await import('../src/core/surface.js');

const PROJECTED: string = '/proc/jobs/7/data/x.mise';
const NATIVE: string = '/home/u/feeds/feed_1/pl-a_7/data/x.mise';

beforeEach(() => {
  asked = [];
  bytes = { ok: false };
  storeResolve = async (typed: string): Promise<string> => (typed === PROJECTED ? NATIVE : typed);
  standing = async (): Promise<string> => 'absent';
});

afterEach(() => { surface_set(new HeadlessSurface()); });

describe('chrisFiles.standing', () => {
  it('is unknown for a path a projection owns, though the place it maps to in the store is proved empty, and the store is not even asked', async () => {
    expect(await chrisFiles.standing!(PROJECTED)).toBe('unknown');
    expect(await chrisFiles.standing!('/pacs/orthanc/S1/x.mise')).toBe('unknown');
    expect(await chrisFiles.standing!('/net/pacs/x.mise')).toBe('unknown');
    expect(asked).toEqual([]);
  });

  it('puts a native path to the proof where the store keeps it, its links followed', async () => {
    storeResolve = async (typed: string): Promise<string> => (typed === '/home/u/link/x.mise' ? '/home/other/real/x.mise' : typed);
    expect(await chrisFiles.standing!('/home/u/link/x.mise')).toBe('absent');
    expect(await chrisFiles.standing!('flows/x.mise')).toBe('absent');
    expect(asked).toEqual(['/home/other/real/x.mise', 'flows/x.mise']);
    standing = async (): Promise<string> => 'unknown';
    expect(await chrisFiles.standing!('/home/u/x.mise')).toBe('unknown');
  });

  it('is unknown when the path cannot be resolved, or the tree cannot be asked', async () => {
    storeResolve = async (): Promise<string> => { throw new Error('the link could not be followed'); };
    expect(await chrisFiles.standing!('/home/u/link/x.mise')).toBe('unknown');
    storeResolve = async (typed: string): Promise<string> => typed;
    standing = async (): Promise<string> => { throw new Error('no tree'); };
    expect(await chrisFiles.standing!('/home/u/x.mise')).toBe('unknown');
  });
});

describe('play over ChRIS\'s own files, with the files tier on', () => {
  /** Paths the engine's disk was read at. */
  let diskReads: string[];
  const disk_read = async (target: string): Promise<string> => { diskReads.push(target); return 'on the disk'; };

  beforeEach(() => {
    diskReads = [];
    backend_install({ id: 'chris', session: {} as never, files: chrisFiles } as never);
    const surface = new HeadlessSurface();
    Object.assign(surface.capabilities, { engineFilesystem: true });
    surface_set(surface);
  });

  it('a mapped projection whose read fails is said as that, and the disk is read zero times', async () => {
    const answer = await manifestText_read(PROJECTED, disk_read);
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.reason).toContain("the engine's disk was not looked at");
    expect(diskReads).toEqual([]);
  });

  it('a native path proved absent is read from the disk, once', async () => {
    expect(await manifestText_read('/work/flows/battery.mise', disk_read)).toEqual({ ok: true, value: { text: 'on the disk', from: '/work/flows/battery.mise' } });
    expect(diskReads).toEqual(['/work/flows/battery.mise']);
  });

  it('a native path that is not proved absent is not read from the disk', async () => {
    standing = async (): Promise<string> => 'unknown';
    expect((await manifestText_read('/work/flows/battery.mise', disk_read)).ok).toBe(false);
    expect(diskReads).toEqual([]);
  });
});
