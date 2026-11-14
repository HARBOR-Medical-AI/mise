/**
 * @file `berth`: anchors downloaded from a fake CUBE into a temporary berth,
 * the node read from the path, the size question and refusals, the soft
 * read-only files, the state file, the listing, drop and clear, and a
 * session on a host.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { Readable } from 'node:stream';

import { cuminMock_install } from './support/cuminMock.js';

/** The fake CUBE: file paths with their bytes and the size the listing reports. */
interface FakeFile { bytes: Buffer; size: number }
const cubeFiles: Map<string, FakeFile> = new Map();
/** Links in the fake CUBE: path to target. */
const cubeLinks: Map<string, string> = new Map();

/**
 * Puts a file in the fake CUBE.
 *
 * @param path - Its path.
 * @param text - Its bytes, as text.
 * @param size - The size its listing reports, when not its length.
 */
function cubeFile_put(path: string, text: string, size?: number): void {
  cubeFiles.set(path, { bytes: Buffer.from(text), size: size ?? Buffer.byteLength(text) });
}

/**
 * Lists one folder of the fake CUBE as the dispatcher would.
 *
 * @param folder - The folder.
 * @returns Its entries, or a failure when nothing is under it.
 */
function cubeFolder_list(folder: string): { ok: true; value: Array<{ name: string; type: string; size: number; owner: string; date: string; target?: string }> } | { ok: false } {
  const prefix: string = folder === '/' ? '/' : `${folder}/`;
  const entries: Map<string, { name: string; type: string; size: number; owner: string; date: string; target?: string }> = new Map();
  for (const [path, file] of cubeFiles) {
    if (!path.startsWith(prefix)) continue;
    const rest: string[] = path.slice(prefix.length).split('/');
    const name: string = rest[0] as string;
    entries.set(name, rest.length === 1
      ? { name, type: 'file', size: file.size, owner: 'alice', date: '' }
      : { name, type: 'dir', size: 0, owner: 'alice', date: '' });
  }
  for (const [path, target] of cubeLinks) {
    if (posix.dirname(path) === folder) entries.set(posix.basename(path), { name: posix.basename(path), type: 'link', size: 0, owner: 'alice', date: '', target });
    else if (path.startsWith(prefix)) {
      const name: string = path.slice(prefix.length).split('/')[0] as string;
      if (!entries.has(name)) entries.set(name, { name, type: 'dir', size: 0, owner: 'alice', date: '' });
    }
  }
  if (entries.size === 0 && ![...cubeFiles.keys()].some((path: string): boolean => path.startsWith(prefix))) return { ok: false };
  return { ok: true, value: [...entries.values()] };
}

const mockStatus = jest.fn(async (_id: number) => ({ ok: true, value: 'finishedSuccessfully' }));
const mockOpen = jest.fn(async (path: string) => {
  const file: FakeFile | undefined = cubeFiles.get(path);
  if (file === undefined) return { ok: false };
  // A PACS file comes back whole, as the kernel gives it; any other as a stream.
  return { ok: true, value: { stream: path.startsWith('/SERVICES/PACS/') ? file.bytes : Readable.from([file.bytes]), size: file.size } };
});
const mockConfirm = jest.fn(async (_prompt: string): Promise<boolean> => true);
const dataLines: string[] = [];
const mockProgress = jest.fn();
const mockFree = jest.fn((_folder: string): number => 1024 ** 4);

jest.unstable_mockModule('../src/builtins/berth/berthDisk.js', () => ({ freeBytes_get: mockFree }));
jest.unstable_mockModule('../src/core/paths.js', () => ({
  path_resolve: async (typed: string): Promise<string> => {
    if (typed.startsWith('~/')) return `/home/alice/${typed.slice(2)}`;
    return typed.startsWith('/') ? typed : `/home/alice/${typed}`;
  },
}));
jest.unstable_mockModule('../src/core/backend.js', () => ({ backendInstalled_get: () => ({ session: { home_get: async (): Promise<string> => '/home/alice' } }) }));
jest.unstable_mockModule('../src/core/filesystem.js', () => ({
  vfsDispatcher_get: () => ({
    list: async (folder: string) => cubeFolder_list(folder),
    linkTarget_resolve: async (link: string) => ({ ok: true, value: link.replace('/proc/jobs/feed_5/pl-dircopy_7/pl-fshack_41/data', '/home/alice/feeds/feed_5/pl-dircopy_7/pl-fshack_41/data') }),
  }),
}));
jest.unstable_mockModule('@fnndsc/chili/utils', () => ({
  logicalPath_resolve: async (logical: string) => {
    for (const [link, target] of cubeLinks) {
      if (logical === link || logical.startsWith(`${link}/`)) return { ok: true, value: `${target}${logical.slice(link.length)}` };
    }
    return { ok: true, value: logical };
  },
}));
// cumin's own rule for a node: the last `<name>_<ID>` after `feed_N`, the
// walk stopping at the first `data`, so a folder inside an output is never a node.
cuminMock_install(() => ({
  path_extractFeedID: (path: string): number | null => { const found = path.match(/(?:^|\/)feed_(\d+)(?:\/|$)/); return found ? Number(found[1]) : null; },
  path_extractPluginInstanceID: (path: string): number | null => {
    const segments: string[] = path.split('/').filter(Boolean);
    const feedAt: number = segments.findIndex((segment: string): boolean => /^feed_\d+$/.test(segment));
    if (feedAt === -1) return null;
    let id: number | null = null;
    for (const segment of segments.slice(feedAt + 1)) {
      if (segment === 'data') break;
      const found = segment.match(/^.+_(\d+)$/);
      if (found === null) break;
      id = Number(found[1]);
    }
    return id;
  },
}));
jest.unstable_mockModule('@fnndsc/salsa', () => ({ job_statusFetch: mockStatus, fileContent_getBinaryStream: mockOpen }));
jest.unstable_mockModule('../src/core/question.js', () => ({ repl_confirm: mockConfirm }));
jest.unstable_mockModule('../src/core/sink.js', () => ({
  sink_get: () => ({ progress_write: mockProgress, data_write: jest.fn(), err_write: jest.fn(), status_write: jest.fn() }),
  sink_dataLine: (text: string): void => { dataLines.push(text); },
}));

const { builtin_berth, ANCHOR_ASK_BYTES } = await import('../src/builtins/berth/berth.js');
const { berthState_read, berthState_update, berthState_write, berthPlaces_read, BerthStateError, BERTH_STATE_FILE } = await import('../src/builtins/berth/berthState.js');

/** Colour codes, gone. */
const strip = (text: string | undefined): string => (text ?? '').replace(/\u001b\[[0-9;]*m/g, '');

const NODE_DATA: string = '/home/alice/feeds/feed_5/pl-dircopy_7/pl-fshack_41/data';
let root: string;
let anchors: string;
let outgoing: string;

beforeEach(() => {
  jest.clearAllMocks();
  mockFree.mockReturnValue(1024 ** 4);
  dataLines.length = 0;
  process.exitCode = 0;
  root = mkdtempSync(join(tmpdir(), 'berth-test-'));
  anchors = join(root, 'anchors');
  outgoing = join(root, 'outgoing');
  mkdirSync(anchors);
  mkdirSync(outgoing);
  process.env['MISE_BERTH_ANCHORS'] = anchors;
  process.env['MISE_BERTH_OUTGOING'] = outgoing;
  cubeFiles.clear();
  cubeLinks.clear();
  cubeFile_put(`${NODE_DATA}/sub-01/anat/t1.nii`, 'T1T1');
  cubeFile_put(`${NODE_DATA}/sub-01/func/bold.nii`, 'BOLDBO');
  cubeFile_put(`${NODE_DATA}/sub-02/t1.nii`, 'T2T');
  cubeFile_put('/home/alice/feeds/feed_5/pl-dircopy_7/pl-fshack_41/pl-child_42/data/out.txt', 'child');
  cubeFile_put('/home/alice/feeds/feed_5/pl-dircopy_7/data/in.txt', 'root');
  cubeFile_put('/home/alice/uploads/weights/model.pt', 'MODEL');
  cubeFile_put('/home/alice/uploads/notes.txt', 'notes');
  cubeFile_put('/home/bob/feeds/feed_9/pl-dircopy_10/data/scan/a.nii', 'bob');
  cubeFile_put('/PUBLIC/atlas/weights/w.bin', 'ATLAS');
  cubeFile_put('/SERVICES/PACS/orthanc/S1/img1.dcm', 'DICM1');
  cubeFile_put('/SERVICES/PACS/orthanc/S1/img2.dcm', 'DICM22');
  cubeFile_put('/home/alice/feeds/feed_6/pl-dircopy_9/data/.keep', '');
  cubeLinks.set('/home/alice/feeds/feed_6/pl-dircopy_9/data/PACS_S1', '/SERVICES/PACS/orthanc/S1');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env['MISE_BERTH_ANCHORS'];
  delete process.env['MISE_BERTH_OUTGOING'];
});

describe('berth on a host', () => {
  it('says the session runs on the host, and refuses every subcommand', async () => {
    delete process.env['MISE_BERTH_ANCHORS'];
    delete process.env['MISE_BERTH_OUTGOING'];
    expect(berthPlaces_read()).toBeNull();
    const listed = await builtin_berth([]);
    expect(listed.status).toBe('ok');
    expect(strip(listed.rendered)).toBe('berth: this session runs on the host, not in a berth\n');
    expect(process.exitCode).toBe(0);
    for (const words of [['anchor', '~/uploads/weights'], ['drop', 'weights'], ['clear'], ['close']]) {
      process.exitCode = 0;
      const refused = await builtin_berth(words);
      expect(refused.status).toBe('error');
      expect(strip(refused.renderedErr)).toBe(`berth: ${words[0]}: this session runs on the host, not in a berth\n`);
      expect(process.exitCode).toBe(1);
    }
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it('reads both places from the environment, and none when either is missing', () => {
    expect(berthPlaces_read({ MISE_BERTH_ANCHORS: '/anchors', MISE_BERTH_OUTGOING: '/outgoing' })).toEqual({ anchors: '/anchors', outgoing: '/outgoing' });
    expect(berthPlaces_read({ MISE_BERTH_ANCHORS: '/anchors' })).toBeNull();
    expect(berthPlaces_read({ MISE_BERTH_ANCHORS: '', MISE_BERTH_OUTGOING: '/outgoing' })).toBeNull();
  });
});

describe('berth anchor: the node is read from the path', () => {
  it('a path inside a node of your feeds has that node, and anchors that part alone', async () => {
    const result = await builtin_berth(['anchor', '~/feeds/feed_5/pl-dircopy_7/pl-fshack_41/data/sub-01']);
    expect(result.status).toBe('ok');
    expect(strip(result.rendered)).toContain('node pl-fshack_41');
    expect(mockStatus).toHaveBeenCalledWith(41);
    expect(readFileSync(join(anchors, 'sub-01', 'anat', 't1.nii'), 'utf8')).toBe('T1T1');
    expect(readFileSync(join(anchors, 'sub-01', 'func', 'bold.nii'), 'utf8')).toBe('BOLDBO');
    expect(existsSync(join(anchors, 'sub-02'))).toBe(false);
    const [anchor] = berthState_read(anchors).anchors;
    expect(anchor).toMatchObject({ name: 'sub-01', path: `${NODE_DATA}/sub-01`, node: 41, feed: 5 });
    expect([...(anchor?.files ?? [])].sort((a, b) => a.name.localeCompare(b.name))).toEqual([{ name: 'anat/t1.nii', size: 4 }, { name: 'func/bold.nii', size: 6 }]);
  });

  it('a path naming the node itself anchors its data, not its child nodes', async () => {
    const result = await builtin_berth(['anchor', '/home/alice/feeds/feed_5/pl-dircopy_7/pl-fshack_41']);
    expect(result.status).toBe('ok');
    expect(existsSync(join(anchors, 'pl-fshack_41', 'sub-01', 'anat', 't1.nii'))).toBe(true);
    expect(existsSync(join(anchors, 'pl-fshack_41', 'sub-02', 't1.nii'))).toBe(true);
    expect(existsSync(join(anchors, 'pl-fshack_41', 'pl-child_42'))).toBe(false);
    expect(berthState_read(anchors).anchors[0]).toMatchObject({ name: 'pl-fshack_41', path: NODE_DATA, node: 41, feed: 5 });
  });

  it('a /proc/jobs data path anchors the output its link names, with its node', async () => {
    const result = await builtin_berth(['anchor', '/proc/jobs/feed_5/pl-dircopy_7/pl-fshack_41/data/sub-02']);
    expect(result.status).toBe('ok');
    expect(berthState_read(anchors).anchors[0]).toMatchObject({ name: 'sub-02', path: `${NODE_DATA}/sub-02`, node: 41, feed: 5 });
  });

  it('an upload, PUBLIC and another person\'s feed have no node, and CUBE is not asked for a status', async () => {
    expect((await builtin_berth(['anchor', '~/uploads/weights'])).status).toBe('ok');
    expect((await builtin_berth(['anchor', '/PUBLIC/atlas/weights', 'atlas-weights'])).status).toBe('ok');
    expect((await builtin_berth(['anchor', '/home/bob/feeds/feed_9/pl-dircopy_10/data/scan'])).status).toBe('ok');
    expect(mockStatus).not.toHaveBeenCalled();
    const state = berthState_read(anchors);
    expect(state.anchors.map((anchor) => [anchor.name, anchor.node, anchor.feed])).toEqual([['weights', null, null], ['atlas-weights', null, null], ['scan', null, null]]);
    expect(readFileSync(join(anchors, 'atlas-weights', 'w.bin'), 'utf8')).toBe('ATLAS');
  });

  it('a single file anchors into a folder of its name', async () => {
    expect((await builtin_berth(['anchor', 'uploads/notes.txt'])).status).toBe('ok');
    expect(readFileSync(join(anchors, 'notes.txt', 'notes.txt'), 'utf8')).toBe('notes');
    expect(berthState_read(anchors).anchors[0]?.files).toEqual([{ name: 'notes.txt', size: 5 }]);
  });

  it('refuses a node that is not finishedSuccessfully, with its status, and downloads nothing', async () => {
    mockStatus.mockResolvedValueOnce({ ok: true, value: 'started' });
    const result = await builtin_berth(['anchor', `${NODE_DATA}/sub-01`]);
    expect(result.status).toBe('error');
    expect(strip(result.renderedErr)).toBe('berth: anchor: pl-fshack_41 is started, not finishedSuccessfully; its output may still change\n');
    expect(process.exitCode).toBe(1);
    expect(mockOpen).not.toHaveBeenCalled();
    expect(berthState_read(anchors).anchors).toEqual([]);
  });

  it('says so when CUBE does not give the node\'s status', async () => {
    mockStatus.mockResolvedValueOnce({ ok: false } as never);
    const result = await builtin_berth(['anchor', `${NODE_DATA}/sub-01`]);
    expect(strip(result.renderedErr)).toBe('berth: anchor: cannot read the status of plugin instance 41\n');
  });

  it('refuses a path in your feeds that is at no node', async () => {
    const result = await builtin_berth(['anchor', '~/feeds/feed_5']);
    expect(strip(result.renderedErr)).toBe('berth: anchor: /home/alice/feeds/feed_5 is in your feeds but not at a node (…/feeds/feed_N/pl-x_ID)\n');
  });

  it('refuses a path that is not there', async () => {
    const result = await builtin_berth(['anchor', '~/uploads/missing']);
    expect(strip(result.renderedErr)).toBe('berth: anchor: ~/uploads/missing: no such file or directory\n');
  });
});

describe('berth anchor: names', () => {
  it('two paths that end alike need a name; the second is refused until it has one', async () => {
    await builtin_berth(['anchor', '~/uploads/weights']);
    const refused = await builtin_berth(['anchor', '/PUBLIC/atlas/weights']);
    expect(refused.status).toBe('error');
    expect(strip(refused.renderedErr)).toBe('berth: anchor: the anchor weights holds /home/alice/uploads/weights; name this one: berth anchor <path> <name> [--refresh] [--yes]\n');
    expect(readFileSync(join(anchors, 'weights', 'model.pt'), 'utf8')).toBe('MODEL');
    expect((await builtin_berth(['anchor', '/PUBLIC/atlas/weights', 'atlas'])).status).toBe('ok');
    expect(berthState_read(anchors).anchors.map((anchor) => anchor.name)).toEqual(['weights', 'atlas']);
  });

  it('an anchor that stands is refused without --refresh, and downloaded again with it', async () => {
    await builtin_berth(['anchor', '~/uploads/weights']);
    const again = await builtin_berth(['anchor', '~/uploads/weights']);
    expect(strip(again.renderedErr)).toBe('berth: anchor: weights is anchored already; --refresh downloads it again\n');
    cubeFile_put('/home/alice/uploads/weights/model.pt', 'MODEL2');
    cubeFile_put('/home/alice/uploads/weights/extra.pt', 'X');
    process.exitCode = 0;
    expect((await builtin_berth(['anchor', '~/uploads/weights', '--refresh'])).status).toBe('ok');
    expect(readFileSync(join(anchors, 'weights', 'model.pt'), 'utf8')).toBe('MODEL2');
    const state = berthState_read(anchors);
    expect(state.anchors).toHaveLength(1);
    expect(state.anchors[0]?.files.map((file) => file.name).sort()).toEqual(['extra.pt', 'model.pt']);
  });

  it('refuses a name that is not one folder name, a folder that is not an anchor, and words it does not know', async () => {
    expect(strip((await builtin_berth(['anchor', '~/uploads/weights', '.hidden'])).renderedErr)).toContain('berth: anchor: .hidden cannot name an anchor');
    expect(strip((await builtin_berth(['anchor', '~/uploads/weights', 'a/b'])).renderedErr)).toContain('berth: anchor: a/b cannot name an anchor');
    mkdirSync(join(anchors, 'mine'));
    expect(strip((await builtin_berth(['anchor', '~/uploads/weights', 'mine'])).renderedErr)).toBe(`berth: anchor: ${join(anchors, 'mine')} is there and is not an anchor\n`);
    expect(strip((await builtin_berth(['anchor', '~/uploads/weights', '--force'])).renderedErr)).toBe('berth: anchor: unknown option --force; berth anchor <path> [name] [--refresh] [--yes]\n');
    expect(strip((await builtin_berth(['anchor'])).renderedErr)).toBe('berth: anchor: usage: berth anchor <path> [name] [--refresh] [--yes]\n');
    expect(strip((await builtin_berth(['anchor', 'a', 'b', 'c'])).renderedErr)).toBe('berth: anchor: usage: berth anchor <path> [name] [--refresh] [--yes]\n');
  });
});

describe('berth anchor: the size', () => {
  it('says the files, the bytes and the room before it downloads, and does not ask under 10 GB', async () => {
    mockFree.mockReturnValue(1024 * 1024);
    await builtin_berth(['anchor', `${NODE_DATA}/sub-01`]);
    expect(dataLines).toEqual([`berth: anchor: sub-01: 2 files, 10 B; 1 MB free in ${anchors}`]);
    expect(mockFree).toHaveBeenCalledWith(anchors);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('above 10 GB it asks; no downloads nothing, yes and --yes download', async () => {
    mockFree.mockReturnValue(100 * 1024 ** 4);
    cubeFile_put('/home/alice/uploads/big/huge.bin', 'BIG', ANCHOR_ASK_BYTES + 1);
    mockConfirm.mockResolvedValueOnce(false);
    const declined = await builtin_berth(['anchor', '~/uploads/big']);
    expect(mockConfirm).toHaveBeenCalledWith(`berth: anchor: download 10 GB into ${join(anchors, 'big')}? [y/N] `);
    expect(strip(declined.rendered)).toBe('berth: anchor: big: nothing downloaded\n');
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(anchors, 'big'))).toBe(false);
    expect(berthState_read(anchors).anchors).toEqual([]);

    process.exitCode = 0;
    expect((await builtin_berth(['anchor', '~/uploads/big'])).status).toBe('ok');
    expect(mockConfirm).toHaveBeenCalledTimes(2);
    expect(existsSync(join(anchors, 'big', 'huge.bin'))).toBe(true);

    await builtin_berth(['drop', 'big']);
    mockConfirm.mockClear();
    expect((await builtin_berth(['anchor', '~/uploads/big', '--yes'])).status).toBe('ok');
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('refuses what does not fit, and advises a folder inside it', async () => {
    mockFree.mockReturnValue(8);
    const result = await builtin_berth(['anchor', `${NODE_DATA}/sub-01`]);
    expect(strip(result.renderedErr)).toBe('berth: anchor: sub-01 does not fit: 10 B with 8 B free; anchor a folder inside it\n');
    expect(mockOpen).not.toHaveBeenCalled();
    expect(readdirSync(anchors)).toEqual([]);
  });

  it('a refresh counts the room its old copy frees', async () => {
    mockFree.mockReturnValue(1024 ** 3);
    await builtin_berth(['anchor', `${NODE_DATA}/sub-01`]);
    mockFree.mockReturnValue(0);
    expect((await builtin_berth(['anchor', `${NODE_DATA}/sub-01`, '--refresh'])).status).toBe('ok');
  });
});

describe('berth anchor: the files', () => {
  it('downloads without write permission, streams with progress, and leaves no partial folder', async () => {
    await builtin_berth(['anchor', `${NODE_DATA}/sub-01`]);
    for (const file of ['anat/t1.nii', 'func/bold.nii']) {
      expect(statSync(join(anchors, 'sub-01', file)).mode & 0o222).toBe(0);
    }
    expect(mockProgress).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'download', phase: 'complete', current: 10, total: 10, unit: 'bytes', label: 'sub-01' }));
    expect(readdirSync(anchors).sort()).toEqual([BERTH_STATE_FILE, 'sub-01']);
  });

  it('writes a PACS series that comes back as whole Buffers', async () => {
    expect((await builtin_berth(['anchor', '/SERVICES/PACS/orthanc/S1'])).status).toBe('ok');
    expect(readFileSync(join(anchors, 'S1', 'img1.dcm'), 'utf8')).toBe('DICM1');
    expect(readFileSync(join(anchors, 'S1', 'img2.dcm'), 'utf8')).toBe('DICM22');
    expect(statSync(join(anchors, 'S1', 'img2.dcm')).mode & 0o222).toBe(0);
    expect(berthState_read(anchors).anchors[0]).toMatchObject({ node: null, feed: null });
  });

  it('follows a node\'s link to a PACS series, keeping the node', async () => {
    expect((await builtin_berth(['anchor', '~/feeds/feed_6/pl-dircopy_9'])).status).toBe('ok');
    expect(readFileSync(join(anchors, 'pl-dircopy_9', 'PACS_S1', 'img1.dcm'), 'utf8')).toBe('DICM1');
    expect(berthState_read(anchors).anchors[0]).toMatchObject({ node: 9, feed: 6 });
  });

  it('a download that fails leaves nothing anchored', async () => {
    mockOpen.mockResolvedValueOnce({ ok: false });
    const result = await builtin_berth(['anchor', '~/uploads/weights']);
    expect(strip(result.renderedErr)).toBe('berth: anchor: weights: cannot read /home/alice/uploads/weights/model.pt; nothing anchored\n');
    expect(readdirSync(anchors)).toEqual([]);
  });
});

describe('the state file', () => {
  it('holds every anchor with its path, node, feed, files and time, and the last close', async () => {
    await builtin_berth(['anchor', '~/uploads/weights']);
    const raw: Record<string, unknown> = JSON.parse(readFileSync(join(anchors, BERTH_STATE_FILE), 'utf8')) as Record<string, unknown>;
    expect(raw).toEqual({
      version: 1,
      anchors: [{ name: 'weights', path: '/home/alice/uploads/weights', node: null, feed: null, files: [{ name: 'model.pt', size: 5 }], anchoredAt: expect.any(String) }],
      lastClosedAt: null,
    });
  });

  it('is written whole through a temporary file, and reads back as written', () => {
    const state = { version: 1, anchors: [], lastClosedAt: '2026-11-13T12:00:00.000Z' };
    berthState_write(anchors, state);
    expect(readdirSync(anchors)).toEqual([BERTH_STATE_FILE]);
    expect(berthState_read(anchors)).toEqual(state);
    const updated = berthState_update(anchors, (now) => ({ ...now, lastClosedAt: null }));
    expect(updated.lastClosedAt).toBeNull();
    expect(berthState_read(anchors).lastClosedAt).toBeNull();
  });

  it('reads as empty when it is not there, and refuses one that is not a berth\'s state', async () => {
    expect(berthState_read(anchors)).toEqual({ version: 1, anchors: [], lastClosedAt: null });
    writeFileSync(join(anchors, BERTH_STATE_FILE), '{ not json');
    expect(() => berthState_read(anchors)).toThrow(BerthStateError);
    writeFileSync(join(anchors, BERTH_STATE_FILE), JSON.stringify({ anchors: [{ name: 'x' }], lastClosedAt: null }));
    expect(() => berthState_read(anchors)).toThrow('an anchor wants');
    writeFileSync(join(anchors, BERTH_STATE_FILE), JSON.stringify({ anchors: [{ name: 'x', path: '/p', node: null, feed: null, anchoredAt: 't', files: [{ name: 1 }] }], lastClosedAt: null }));
    expect(() => berthState_read(anchors)).toThrow('a file entry wants');
    writeFileSync(join(anchors, BERTH_STATE_FILE), JSON.stringify({ anchors: 'none' }));
    expect(() => berthState_read(anchors)).toThrow('not a berth state');
    const listed = await builtin_berth([]);
    expect(strip(listed.renderedErr)).toContain(`berth: ${join(anchors, BERTH_STATE_FILE)}: not a berth state`);
  });
});

describe('berth: the listing', () => {
  it('says there are no anchors, and that the berth never closed', async () => {
    const result = await builtin_berth([]);
    expect(strip(result.rendered)).toBe(`no anchors in ${anchors}; berth anchor <path> [name] [--refresh] [--yes] downloads one\nlast close: never\n`);
  });

  it('lists name, path, node or none, files, size and time, and when the berth last closed', async () => {
    await builtin_berth(['anchor', `${NODE_DATA}/sub-01`]);
    await builtin_berth(['anchor', '~/uploads/weights']);
    berthState_update(anchors, (state) => ({ ...state, lastClosedAt: '2026-11-13T12:00:00.000Z' }));
    const lines: string[] = strip((await builtin_berth([])).rendered).split('\n');
    expect(lines[0]).toMatch(/^NAME\s+PATH\s+NODE\s+FILES\s+SIZE\s+ANCHORED$/);
    expect(lines[1]).toMatch(new RegExp(`^sub-01\\s+${NODE_DATA}/sub-01\\s+pl-fshack_41\\s+2\\s+10 B\\s+\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d$`));
    expect(lines[2]).toMatch(/^weights\s+\/home\/alice\/uploads\/weights\s+none\s+1\s+5 B\s+\d{4}-\d\d-\d\d \d\d:\d\d$/);
    expect(lines[3]).toMatch(/^last close: 2026-11-1[34] \d\d:\d\d$/);
  });
});

describe('berth drop', () => {
  it('removes one anchor with no question, and keeps the others', async () => {
    await builtin_berth(['anchor', `${NODE_DATA}/sub-01`]);
    await builtin_berth(['anchor', '~/uploads/weights']);
    const result = await builtin_berth(['drop', 'sub-01']);
    expect(strip(result.rendered)).toBe(`dropped sub-01; ChRIS still holds ${NODE_DATA}/sub-01\n`);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(existsSync(join(anchors, 'sub-01'))).toBe(false);
    expect(existsSync(join(anchors, 'weights', 'model.pt'))).toBe(true);
    expect(berthState_read(anchors).anchors.map((anchor) => anchor.name)).toEqual(['weights']);
  });

  it('refuses a name it does not hold, and a missing name', async () => {
    expect(strip((await builtin_berth(['drop', 'sub-01'])).renderedErr)).toBe('berth: drop: no anchor named sub-01\n');
    expect(process.exitCode).toBe(1);
    expect(strip((await builtin_berth(['drop'])).renderedErr)).toBe('berth: drop: usage: berth drop <name>\n');
  });
});

describe('berth clear', () => {
  it('with nothing unclosed in outgoing, removes every anchor without a question', async () => {
    await builtin_berth(['anchor', `${NODE_DATA}/sub-01`]);
    await builtin_berth(['anchor', '~/uploads/weights']);
    const result = await builtin_berth(['clear']);
    expect(strip(result.rendered)).toBe(`cleared 2 anchors and emptied ${outgoing}\n`);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(readdirSync(anchors)).toEqual([BERTH_STATE_FILE]);
    expect(berthState_read(anchors).anchors).toEqual([]);
    expect(existsSync(outgoing)).toBe(true);
  });

  it('asks when outgoing holds files and the berth never closed; no removes nothing', async () => {
    await builtin_berth(['anchor', '~/uploads/weights']);
    mkdirSync(join(outgoing, 'results'));
    writeFileSync(join(outgoing, 'results', 'seg.nii'), 'SEG');
    mockConfirm.mockResolvedValueOnce(false);
    const declined = await builtin_berth(['clear']);
    expect(mockConfirm).toHaveBeenCalledWith(`berth: clear: ${outgoing} holds 1 file not yet closed; remove them and every anchor? [y/N] `);
    expect(strip(declined.rendered)).toBe('berth: clear: nothing removed\n');
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(outgoing, 'results', 'seg.nii'))).toBe(true);
    expect(existsSync(join(anchors, 'weights'))).toBe(true);

    process.exitCode = 0;
    expect((await builtin_berth(['clear'])).status).toBe('ok');
    expect(readdirSync(outgoing)).toEqual([]);
    expect(existsSync(join(anchors, 'weights'))).toBe(false);
  });

  it('does not ask for files older than the last close, and asks for one changed after it', async () => {
    writeFileSync(join(outgoing, 'old.txt'), 'old');
    const before: Date = new Date('2026-11-01T00:00:00Z');
    utimesSync(join(outgoing, 'old.txt'), before, before);
    berthState_update(anchors, (state) => ({ ...state, lastClosedAt: '2026-11-02T00:00:00.000Z' }));
    expect((await builtin_berth(['clear'])).status).toBe('ok');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(readdirSync(outgoing)).toEqual([]);
    expect(berthState_read(anchors).lastClosedAt).toBe('2026-11-02T00:00:00.000Z');

    writeFileSync(join(outgoing, 'new.txt'), 'new');
    await builtin_berth(['clear']);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it('takes no words', async () => {
    expect(strip((await builtin_berth(['clear', 'now'])).renderedErr)).toBe('berth: clear: usage: berth clear\n');
  });
});

describe('berth: subcommands', () => {
  it('refuses one it does not know, with the usage', async () => {
    const result = await builtin_berth(['close']);
    expect(strip(result.renderedErr)).toBe('berth: close: unknown subcommand; usage: berth [anchor <path> [name] [--refresh] [--yes] | drop <name> | clear]\n');
    expect(process.exitCode).toBe(1);
  });
});
