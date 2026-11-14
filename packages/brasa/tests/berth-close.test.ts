/**
 * @file `berth close`: the outgoing folder uploaded to a fake CUBE and made
 * one node; every placement the anchors decide, the refusal of anchors that
 * point two ways and both flags that settle it, an empty outgoing folder,
 * berth.json, the running-process question, a changed input said and
 * recorded, an attach that fails keeping the upload, and lastClosedAt.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join, posix } from 'node:path';

import { cuminMock_install } from './support/cuminMock.js';

/** The fake CUBE's files under anchored paths: path to size. */
const cubeFiles: Map<string, number> = new Map();
/** What the fake upload received: ChRIS path to content. */
const uploaded: Map<string, string> = new Map();
/** Local file names the fake upload fails on. */
const uploadFailures: Set<string> = new Set();

/**
 * Lists one folder of the fake CUBE as the dispatcher would.
 *
 * @param folder - The folder.
 * @returns Its entries, or a failure when nothing is under it.
 */
function cubeFolder_list(folder: string): { ok: true; value: Array<{ name: string; type: string; size: number; owner: string; date: string }> } | { ok: false } {
  const prefix: string = `${folder}/`;
  const entries: Map<string, { name: string; type: string; size: number; owner: string; date: string }> = new Map();
  for (const [path, size] of cubeFiles) {
    if (!path.startsWith(prefix)) continue;
    const rest: string[] = path.slice(prefix.length).split('/');
    const name: string = rest[0] as string;
    entries.set(name, rest.length === 1 ? { name, type: 'file', size, owner: 'alice', date: '' } : { name, type: 'dir', size: 0, owner: 'alice', date: '' });
  }
  return entries.size === 0 ? { ok: false } : { ok: true, value: [...entries.values()] };
}

/**
 * The fake upload: every file under a local path, kept by the ChRIS path it lands at.
 *
 * @param local - A local file or folder.
 * @param target - The ChRIS folder it goes into, keeping its name.
 * @returns The summary the real upload gives.
 */
function upload_fake(local: string, target: string): { transferredCount: number; transferSize: number; failedCount: number } {
  let transferredCount: number = 0;
  let transferSize: number = 0;
  let failedCount: number = 0;
  const walk = (path: string, remote: string): void => {
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path)) walk(join(path, name), `${remote}/${name}`);
      return;
    }
    if (uploadFailures.has(basename(path))) {
      failedCount += 1;
      return;
    }
    const content: string = readFileSync(path, 'utf8');
    uploaded.set(remote, content);
    transferredCount += 1;
    transferSize += Buffer.byteLength(content);
  };
  walk(local, `${target}/${basename(local)}`);
  return { transferredCount, transferSize, failedCount };
}

const mockUpload = jest.fn(async (local: string, target: string, _options: unknown) => upload_fake(local, target));
let instanceNext: number = 100;
let feedNext: number = 20;
const mockPluginRun = jest.fn(async (_selector: string, _parameters: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
  const id: number = instanceNext++;
  return { id, plugin_name: 'pl-dsdircopy', feed_id: 5 };
});
const mockFeedCreate = jest.fn(async (_dirs: string[], _params: Record<string, unknown>) => {
  const id: number = instanceNext++;
  return { id: feedNext++, name: 'x', owner_username: 'alice', pluginInstance: { data: { id } } };
});
const mockFeedRename = jest.fn(async (_feed: number, _name: string) => ({ ok: true, value: true }));
const mockConfirm = jest.fn(async (_prompt: string): Promise<boolean> => true);
const mockProcesses = jest.fn((_folder: string): Array<{ pid: number; command: string; open: string[] }> => []);
const mockInstanceAdd = jest.fn();
const mockCacheAdd = jest.fn();
const mockFollow = jest.fn();
const mockInvalidate = jest.fn();
const dataLines: string[] = [];

jest.unstable_mockModule('../src/core/paths.js', () => ({ path_resolve: async (typed: string): Promise<string> => typed }));
/** The home the session names; '/' with no session. */
let homeNamed: string = '/home/alice';
jest.unstable_mockModule('../src/core/backend.js', () => ({ backendInstalled_get: () => ({ session: { home_get: async (): Promise<string> => homeNamed } }) }));
jest.unstable_mockModule('../src/core/filesystem.js', () => ({ vfsDispatcher_get: () => ({ list: async (folder: string) => cubeFolder_list(folder) }) }));
jest.unstable_mockModule('@fnndsc/chili/utils', () => ({ logicalPath_resolve: async (logical: string) => ({ ok: true, value: logical }) }));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/upload.js', () => ({ files_uploadWithProgress: mockUpload }));
cuminMock_install(() => ({
  path_extractFeedID: (): number | null => null,
  path_extractPluginInstanceID: (): number | null => null,
  procCache_get: () => ({ instance_add: mockInstanceAdd }),
  listCache_get: () => ({ cache_invalidateTree: mockInvalidate, cache_invalidate: mockInvalidate }),
  feed_rename: mockFeedRename,
}));
jest.unstable_mockModule('@fnndsc/salsa', () => ({ plugin_run: mockPluginRun, feed_create: mockFeedCreate, job_statusFetch: jest.fn(), fileContent_getBinaryStream: jest.fn() }));
jest.unstable_mockModule('../src/core/question.js', () => ({ repl_confirm: mockConfirm }));
jest.unstable_mockModule('../src/core/sink.js', () => ({
  sink_get: () => ({ progress_write: jest.fn(), data_write: jest.fn(), err_write: jest.fn(), status_write: jest.fn() }),
  sink_dataLine: (text: string): void => { dataLines.push(text); },
}));
jest.unstable_mockModule('../src/builtins/berth/berthProcesses.js', () => ({ processesOwn_list: mockProcesses }));
jest.unstable_mockModule('../src/builtins/feedCreation.js', () => ({ newFeed_cacheAdd: mockCacheAdd, run_follow: mockFollow }));

const { errorStack } = await import('@fnndsc/fond');
const { builtin_berth } = await import('../src/builtins/berth/berth.js');
const { berthState_read, berthState_write } = await import('../src/builtins/berth/berthState.js');
const { anchorChanges_compare, berthSource_read } = await import('../src/builtins/berth/berthRecord.js');

/** Colour codes, gone. */
const strip = (text: string | undefined): string => (text ?? '').replace(/\u001b\[[0-9;]*m/g, '');

/** Made-up anchors: two under one node, one under another, two with none. */
const SUB01 = { name: 'sub-01', path: '/home/alice/feeds/feed_5/pl-dircopy_7/pl-fshack_41/data/sub-01', node: 41, feed: 5, files: [{ name: 't1.nii', size: 4 }], anchoredAt: '2026-11-13T10:00:00.000Z' };
const SUB02 = { name: 'sub-02', path: '/home/alice/feeds/feed_5/pl-dircopy_7/pl-fshack_41/data/sub-02', node: 41, feed: 5, files: [{ name: 't1.nii', size: 3 }], anchoredAt: '2026-11-13T10:01:00.000Z' };
const SEG = { name: 'seg', path: '/home/alice/feeds/feed_8/pl-dircopy_80/pl-unet_81/data', node: 81, feed: 8, files: [{ name: 'mask.nii', size: 2 }], anchoredAt: '2026-11-13T10:02:00.000Z' };
const WEIGHTS = { name: 'weights', path: '/home/alice/uploads/weights', node: null, feed: null, files: [{ name: 'model.pt', size: 5 }], anchoredAt: '2026-11-13T10:03:00.000Z' };
const ATLAS = { name: 'atlas', path: '/PUBLIC/atlas', node: null, feed: null, files: [{ name: 'w.bin', size: 5 }], anchoredAt: '2026-11-13T10:04:00.000Z' };

/** The folder a close uploads to: the person's berth folder and a uuid. */
const FOLDER: RegExp = /^\/home\/alice\/berth\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let root: string;
let anchors: string;
let outgoing: string;
let cwdBefore: string;

/**
 * Stands anchors in the berth's state.
 *
 * @param standing - The anchors.
 */
function anchors_stand(...standing: Array<typeof SUB01 | typeof WEIGHTS>): void {
  berthState_write(anchors, { version: 1, anchors: standing, lastClosedAt: null });
}

/**
 * The berth.json the close left in the outgoing folder.
 *
 * @returns Its parsed content.
 */
function record_read(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(outgoing, 'berth.json'), 'utf8')) as Record<string, unknown>;
}

/**
 * The folder the close uploaded to, from its first upload call.
 *
 * @returns The folder.
 */
function folder_uploaded(): string {
  return mockUpload.mock.calls[0]?.[1] as string;
}

beforeEach(() => {
  jest.clearAllMocks();
  dataLines.length = 0;
  uploaded.clear();
  uploadFailures.clear();
  cubeFiles.clear();
  instanceNext = 100;
  feedNext = 20;
  homeNamed = '/home/alice';
  process.exitCode = 0;
  root = mkdtempSync(join(tmpdir(), 'berth-close-'));
  anchors = join(root, 'anchors');
  outgoing = join(root, 'outgoing');
  mkdirSync(anchors);
  mkdirSync(join(outgoing, 'results'), { recursive: true });
  writeFileSync(join(outgoing, 'results', 'seg.nii'), 'SEGMENT');
  writeFileSync(join(outgoing, 'notes.md'), 'notes');
  process.env['MISE_BERTH_ANCHORS'] = anchors;
  process.env['MISE_BERTH_OUTGOING'] = outgoing;
  delete process.env['MISE_BERTH_IMAGE'];
  cubeFiles.set('/home/alice/uploads/weights/model.pt', 5);
  cubeFiles.set('/PUBLIC/atlas/w.bin', 5);
  // A folder outside any git repository, so the record names no source.
  cwdBefore = process.cwd();
  mkdirSync(join(root, 'home'));
  process.chdir(join(root, 'home'));
});

afterEach(() => {
  process.chdir(cwdBefore);
  rmSync(root, { recursive: true, force: true });
  delete process.env['MISE_BERTH_ANCHORS'];
  delete process.env['MISE_BERTH_OUTGOING'];
  delete process.env['MISE_BERTH_IMAGE'];
});

describe('berth close: the outgoing folder', () => {
  it('refuses an empty outgoing folder: nothing to close', async () => {
    rmSync(outgoing, { recursive: true });
    mkdirSync(outgoing);
    const result = await builtin_berth(['close']);
    expect(result.status).toBe('error');
    expect(strip(result.renderedErr)).toBe(`berth: close: ${outgoing} is empty; nothing to close\n`);
    expect(process.exitCode).toBe(1);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('counts a folder holding only an earlier close\'s berth.json as empty', async () => {
    rmSync(outgoing, { recursive: true });
    mkdirSync(outgoing);
    writeFileSync(join(outgoing, 'berth.json'), '{}');
    expect(strip((await builtin_berth(['close'])).renderedErr)).toBe(`berth: close: ${outgoing} is empty; nothing to close\n`);
  });

  it('uploads every file of the folder into the person\'s berth files, keeping its names, and removes nothing', async () => {
    anchors_stand(SUB01);
    const result = await builtin_berth(['close']);
    expect(result.status).toBe('ok');
    const folder: string = folder_uploaded();
    expect(folder).toMatch(FOLDER);
    expect(mockUpload.mock.calls.map((call) => call[0])).toEqual([join(outgoing, 'berth.json'), join(outgoing, 'notes.md'), join(outgoing, 'results')]);
    expect([...uploaded.keys()].sort()).toEqual([`${folder}/berth.json`, `${folder}/notes.md`, `${folder}/results/seg.nii`]);
    expect(dataLines).toContain(`berth: close: uploading 2 files, 12 B, and berth.json to ${folder}`);
    expect(readFileSync(join(outgoing, 'results', 'seg.nii'), 'utf8')).toBe('SEGMENT');
    expect(berthState_read(anchors).anchors).toHaveLength(1);
  });

  it('refuses a session that names no ChRIS home, before it asks or uploads anything', async () => {
    homeNamed = '/';
    mockProcesses.mockReturnValueOnce([{ pid: 412, command: 'python train.py', open: [] }]);
    expect(strip((await builtin_berth(['close'])).renderedErr)).toBe('berth: close: the session names no ChRIS home to upload to; connect first\n');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('refuses words it does not know', async () => {
    expect(strip((await builtin_berth(['close', '--yes'])).renderedErr)).toBe('berth: close: unknown option --yes; berth close [--infeed <anchor> | --newfeed] [--name <feed>] [--title <text>] [--force]\n');
    expect(strip((await builtin_berth(['close', 'now'])).renderedErr)).toBe('berth: close: takes no operand (now); berth close [--infeed <anchor> | --newfeed] [--name <feed>] [--title <text>] [--force]\n');
    expect(strip((await builtin_berth(['close', '--title'])).renderedErr)).toBe('berth: close: --title wants a value; berth close [--infeed <anchor> | --newfeed] [--name <feed>] [--title <text>] [--force]\n');
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

describe('berth close: where the node goes', () => {
  it('every anchor under one node: pl-dsdircopy over the upload, a child of that node', async () => {
    anchors_stand(SUB01, SUB02);
    const result = await builtin_berth(['close']);
    const folder: string = folder_uploaded();
    expect(mockFeedCreate).not.toHaveBeenCalled();
    expect(mockPluginRun).toHaveBeenCalledTimes(1);
    expect(mockPluginRun).toHaveBeenCalledWith('name_exact:pl-dsdircopy', { dir: folder, title: 'berth work', previous_id: 41 });
    expect(strip(result.rendered)).toBe(`berth: close: the work is feed 5, node 100 (pl-dsdircopy), a child of pl-fshack_41\nberth: close: its files are in ${folder}\n`);
    expect(mockInstanceAdd).toHaveBeenCalledWith({ id: 100, feedID: 5, parentID: 41, pluginName: 'pl-dsdircopy', params: null, status: 'scheduled' });
    expect(mockFollow).toHaveBeenCalledWith(5);
    expect(process.exitCode).toBe(0);
  });

  it('no anchor under your feeds: a new feed, pl-dircopy over every anchored path, the work its child', async () => {
    anchors_stand(WEIGHTS, ATLAS);
    const result = await builtin_berth(['close', '--name', 'seg run', '--title', 'unet weights']);
    const folder: string = folder_uploaded();
    expect(mockFeedCreate).toHaveBeenCalledWith(['/home/alice/uploads/weights', '/PUBLIC/atlas'], { title: 'seg run' });
    expect(mockPluginRun).toHaveBeenCalledWith('name_exact:pl-dsdircopy', { dir: folder, title: 'unet weights', previous_id: 100 });
    expect(strip(result.rendered)).toBe(`berth: close: the work is the new feed 20 "seg run", node 101 (pl-dsdircopy), a child of pl-dircopy_100 over 2 anchored paths\nberth: close: its files are in ${folder}\n`);
    expect(mockCacheAdd).toHaveBeenCalledWith({ feedID: 20, title: 'seg run', ownerUsername: 'alice', rootInstanceID: 100, child: { id: 101, pluginName: 'pl-dsdircopy' } });
    expect(mockFeedRename).not.toHaveBeenCalled();
  });

  it('a new feed is named after the title when no name is given', async () => {
    anchors_stand(WEIGHTS);
    await builtin_berth(['close', '--title=unet weights']);
    expect(mockFeedCreate).toHaveBeenCalledWith(['/home/alice/uploads/weights'], { title: 'unet weights' });
  });

  it('no anchor at all: the root of a new feed is pl-dircopy over the upload itself', async () => {
    const result = await builtin_berth(['close']);
    const folder: string = folder_uploaded();
    expect(mockFeedCreate).toHaveBeenCalledWith([folder], { title: 'berth work' });
    expect(mockPluginRun).not.toHaveBeenCalled();
    expect(strip(result.rendered)).toBe(`berth: close: the work is the new feed 20 "berth work", node 100 (pl-dircopy), its root\nberth: close: its files are in ${folder}\n`);
    expect(mockCacheAdd).toHaveBeenCalledWith({ feedID: 20, title: 'berth work', ownerUsername: 'alice', rootInstanceID: 100 });
    expect(mockFeedRename).not.toHaveBeenCalled();
  });

  it('no anchor at all, with a name: the root keeps the title and the feed takes the name', async () => {
    await builtin_berth(['close', '--name', 'seg run']);
    expect(mockFeedCreate).toHaveBeenCalledWith([folder_uploaded()], { title: 'berth work' });
    expect(mockFeedRename).toHaveBeenCalledWith(20, 'seg run');
  });
});

describe('berth close: anchors that point two ways', () => {
  it('refuses anchors of two nodes, says why and names the two choices, before anything is uploaded', async () => {
    anchors_stand(SUB01, SEG);
    const result = await builtin_berth(['close']);
    expect(result.status).toBe('error');
    expect(strip(result.renderedErr)).toBe('berth: close: the anchors are under two nodes, sub-01 (pl-fshack_41) and seg (pl-unet_81); a node has one parent: --infeed <anchor> makes the work a child of that anchor\'s node, --newfeed a new feed over every anchor\n');
    expect(process.exitCode).toBe(1);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(existsSync(join(outgoing, 'berth.json'))).toBe(false);
  });

  it('refuses a node and a path with none', async () => {
    anchors_stand(SUB01, WEIGHTS);
    const result = await builtin_berth(['close']);
    expect(strip(result.renderedErr)).toBe('berth: close: sub-01 (pl-fshack_41) is under a node and weights is under none; a node has one parent: --infeed <anchor> makes the work a child of that anchor\'s node, --newfeed a new feed over every anchor\n');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('--infeed <anchor> makes the work a child of that anchor\'s node', async () => {
    anchors_stand(SUB01, SEG, WEIGHTS);
    const result = await builtin_berth(['close', '--infeed', 'seg']);
    expect(result.status).toBe('ok');
    expect(mockPluginRun).toHaveBeenCalledWith('name_exact:pl-dsdircopy', { dir: folder_uploaded(), title: 'berth work', previous_id: 81 });
    expect(record_read()['placement']).toEqual({ kind: 'child', by: '--infeed', parent: 81, parentName: 'pl-unet_81', feed: 8, anchor: 'seg' });
  });

  it('--newfeed makes a new feed over every anchor, in every case', async () => {
    anchors_stand(SUB01, SEG, WEIGHTS);
    expect((await builtin_berth(['close', '--newfeed'])).status).toBe('ok');
    expect(mockFeedCreate).toHaveBeenCalledWith([SUB01.path, SEG.path, WEIGHTS.path], { title: 'berth work' });
    expect(mockPluginRun).toHaveBeenCalledWith('name_exact:pl-dsdircopy', { dir: folder_uploaded(), title: 'berth work', previous_id: 100 });

    jest.clearAllMocks();
    anchors_stand(SUB01, SUB02);
    expect((await builtin_berth(['close', '--newfeed', '--name', 'again'])).status).toBe('ok');
    expect(mockFeedCreate).toHaveBeenCalledWith([SUB01.path, SUB02.path], { title: 'again' });
  });

  it('refuses --infeed of an anchor with no node or not there, both flags at once, and --name for a child', async () => {
    anchors_stand(SUB01, WEIGHTS);
    expect(strip((await builtin_berth(['close', '--infeed', 'weights'])).renderedErr)).toBe('berth: close: --infeed: weights has no node; --infeed takes an anchor under a node of your feeds, or --newfeed makes a new feed\n');
    expect(strip((await builtin_berth(['close', '--infeed', 'sub-09'])).renderedErr)).toBe('berth: close: --infeed: no anchor named sub-09\n');
    expect(strip((await builtin_berth(['close', '--infeed', 'sub-01', '--newfeed'])).renderedErr)).toBe('berth: close: --infeed and --newfeed are two places; give one\n');
    expect(strip((await builtin_berth(['close', '--infeed', 'sub-01', '--name', 'x'])).renderedErr)).toBe('berth: close: --name names a new feed; the work goes into feed 5 under pl-fshack_41\n');
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

describe('berth close: berth.json', () => {
  it('records who, every anchor, the session, the image, the time, the folder and where the node went', async () => {
    process.env['MISE_BERTH_IMAGE'] = 'ghcr.io/harbor-medical-ai/mise-berth:latest';
    anchors_stand(SUB01, SUB02);
    const before: number = Date.now();
    await builtin_berth(['close', '--title', 'seg run']);
    const folder: string = folder_uploaded();
    const record: Record<string, unknown> = record_read();
    expect(record).toEqual({
      version: 1,
      who: 'alice',
      session: hostname(),
      image: 'ghcr.io/harbor-medical-ai/mise-berth:latest',
      source: null,
      closedAt: expect.any(String),
      title: 'seg run',
      anchors: [{ ...SUB01, changes: null }, { ...SUB02, changes: null }],
      outgoing,
      folder,
      placement: { kind: 'child', by: 'anchors', parent: 41, parentName: 'pl-fshack_41', feed: 5, anchor: null },
      attached: { feed: 5, node: 100, plugin: 'pl-dsdircopy', root: null },
    });
    expect(Date.parse(record['closedAt'] as string)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('is uploaded with the placement decided and no node yet, and the berth\'s copy gets the node', async () => {
    anchors_stand(WEIGHTS);
    await builtin_berth(['close']);
    const sent: Record<string, unknown> = JSON.parse(uploaded.get(`${folder_uploaded()}/berth.json`) ?? '{}') as Record<string, unknown>;
    expect(sent['placement']).toEqual({ kind: 'newFeed', by: 'anchors', name: 'berth work', inputs: ['/home/alice/uploads/weights'] });
    expect(sent['attached']).toBeNull();
    expect(record_read()['attached']).toEqual({ feed: 20, node: 101, plugin: 'pl-dsdircopy', root: 100 });
  });

  it('names the image as none when the berth names none', async () => {
    await builtin_berth(['close']);
    expect(record_read()['image']).toBeNull();
  });

  it('records the source commit of the git repository the session runs in, and none outside one', async () => {
    const repo: string = join(root, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]): string => execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.org', ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    writeFileSync(join(repo, 'train.py'), 'print(1)\n');
    git('add', 'train.py');
    git('commit', '-q', '-m', 'first');
    const commit: string = git('rev-parse', 'HEAD');
    expect(berthSource_read(join(root, 'home'))).toBeNull();
    process.chdir(repo);
    await builtin_berth(['close']);
    expect(record_read()['source']).toEqual({ repository: git('rev-parse', '--show-toplevel'), commit, dirty: false });
    writeFileSync(join(repo, 'train.py'), 'print(2)\n');
    expect(berthSource_read(repo)?.dirty).toBe(true);
  });
});

describe('berth close: processes still running', () => {
  const RUNNING = [{ pid: 412, command: 'python train.py', open: [] as string[] }, { pid: 418, command: 'vim notes.md', open: [] as string[] }];

  it('lists them with the files they hold open and asks; no closes nothing', async () => {
    mockProcesses.mockReturnValueOnce([{ ...RUNNING[0]!, open: [join(outgoing, 'results', 'seg.nii')] }, RUNNING[1]!]);
    mockConfirm.mockResolvedValueOnce(false);
    const result = await builtin_berth(['close']);
    expect(mockProcesses).toHaveBeenCalledWith(outgoing);
    expect(dataLines.slice(0, 4)).toEqual([
      'berth: close: 2 processes of yours still run in the berth:',
      `  PID  COMMAND          OPEN UNDER ${outgoing}`,
      `  412  python train.py  ${join(outgoing, 'results', 'seg.nii')}`,
      '  418  vim notes.md     -',
    ]);
    expect(mockConfirm).toHaveBeenCalledWith(`berth: close: return ${outgoing} while they run?`);
    expect(strip(result.rendered)).toBe('berth: close: nothing closed\n');
    expect(process.exitCode).toBe(1);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(berthState_read(anchors).lastClosedAt).toBeNull();
  });

  it('yes goes on', async () => {
    mockProcesses.mockReturnValueOnce([RUNNING[0]!]);
    expect((await builtin_berth(['close'])).status).toBe('ok');
    expect(mockConfirm).toHaveBeenCalledWith(`berth: close: return ${outgoing} while it runs?`);
    expect(mockUpload).toHaveBeenCalled();
  });

  it('--force answers yes: they are listed and nothing is asked', async () => {
    mockProcesses.mockReturnValueOnce(RUNNING);
    expect((await builtin_berth(['close', '--force'])).status).toBe('ok');
    expect(dataLines[0]).toBe('berth: close: 2 processes of yours still run in the berth:');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockUpload).toHaveBeenCalled();
  });

  it('asks nothing when none of yours runs', async () => {
    await builtin_berth(['close']);
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});

describe('berth close: a changed input', () => {
  it('says what changed under an anchor with no node, records it, and goes on', async () => {
    anchors_stand(WEIGHTS, ATLAS);
    cubeFiles.set('/home/alice/uploads/weights/model.pt', 6);
    cubeFiles.set('/home/alice/uploads/weights/extra.pt', 1);
    cubeFiles.delete('/PUBLIC/atlas/w.bin');
    cubeFiles.set('/PUBLIC/atlas/v2.bin', 9);
    const result = await builtin_berth(['close']);
    expect(result.status).toBe('ok');
    expect(dataLines).toContain('berth: close: weights: changed in ChRIS since anchored: 1 file added, 1 file of another size; berth.json lists them');
    expect(dataLines).toContain('berth: close: atlas: changed in ChRIS since anchored: 1 file added, 1 file gone; berth.json lists them');
    const recorded = record_read()['anchors'] as Array<Record<string, unknown>>;
    expect(recorded[0]?.['changes']).toEqual({ added: ['extra.pt'], removed: [], resized: [{ name: 'model.pt', anchored: 5, atClose: 6 }], unreadable: null });
    expect(recorded[1]?.['changes']).toEqual({ added: ['v2.bin'], removed: ['w.bin'], resized: [], unreadable: null });
    expect(mockFeedCreate).toHaveBeenCalled();
  });

  it('says nothing for an anchor that did not change, and records that it was compared', async () => {
    anchors_stand(WEIGHTS);
    await builtin_berth(['close']);
    expect(dataLines.some((line: string): boolean => line.includes('changed in ChRIS'))).toBe(false);
    expect((record_read()['anchors'] as Array<Record<string, unknown>>)[0]?.['changes']).toEqual({ added: [], removed: [], resized: [], unreadable: null });
  });

  it('a path that is gone is every file gone; a path that cannot be read is said and recorded', async () => {
    anchors_stand(WEIGHTS);
    cubeFiles.clear();
    cubeFiles.set('/home/alice/uploads/notes.txt', 1);
    await builtin_berth(['close']);
    expect((record_read()['anchors'] as Array<Record<string, unknown>>)[0]?.['changes']).toEqual({ added: [], removed: ['model.pt'], resized: [], unreadable: null });

    cubeFiles.clear();
    jest.clearAllMocks();
    dataLines.length = 0;
    await builtin_berth(['close']);
    expect(dataLines).toContain('berth: close: weights: cannot compare with ChRIS: cannot list /home/alice/uploads; berth.json lists them');
    expect((record_read()['anchors'] as Array<Record<string, unknown>>)[0]?.['changes']).toEqual({ added: [], removed: [], resized: [], unreadable: 'cannot list /home/alice/uploads' });
  });

  it('does not compare an anchor under a finished node', async () => {
    anchors_stand(SUB01);
    await builtin_berth(['close']);
    expect((record_read()['anchors'] as Array<Record<string, unknown>>)[0]?.['changes']).toBeNull();
  });

  it('compares by name and size', () => {
    expect(anchorChanges_compare([{ name: 'a', size: 1 }, { name: 'b', size: 2 }], [{ name: 'b', size: 3 }, { name: 'c', size: 1 }]))
      .toEqual({ added: ['c'], removed: ['a'], resized: [{ name: 'b', anchored: 2, atClose: 3 }], unreadable: null });
  });
});

describe('berth close: when it cannot attach, and the last close', () => {
  it('an attach that fails keeps the upload and says uploaded, not attached, with CUBE\'s reason', async () => {
    anchors_stand(SUB01);
    mockPluginRun.mockImplementationOnce(async () => {
      errorStack.stack_push('error', 'Error running plugin instance | pl-dsdircopy is not registered to a compute resource');
      return null;
    });
    const result = await builtin_berth(['close']);
    const folder: string = folder_uploaded();
    expect(strip(result.rendered)).toBe(`berth: close: uploaded, not attached: Error running plugin instance | pl-dsdircopy is not registered to a compute resource\nberth: close: the work stays in ${folder}\n`);
    expect(process.exitCode).toBe(1);
    expect(uploaded.has(`${folder}/results/seg.nii`)).toBe(true);
    expect(record_read()['attached']).toBeNull();
    expect(berthState_read(anchors).lastClosedAt).toBeNull();
    expect(mockFollow).not.toHaveBeenCalled();
  });

  it('a new feed whose work cannot attach says the feed its root made', async () => {
    anchors_stand(WEIGHTS);
    mockPluginRun.mockResolvedValueOnce(null);
    const result = await builtin_berth(['close']);
    expect(strip(result.rendered)).toContain('berth: close: uploaded, not attached: CUBE made no pl-dsdircopy instance; the new feed 20 holds the anchored paths under pl-dircopy_100\n');
  });

  it('a feed CUBE does not make is not attached either', async () => {
    mockFeedCreate.mockResolvedValueOnce(null as never);
    const result = await builtin_berth(['close']);
    expect(strip(result.rendered)).toContain('berth: close: uploaded, not attached: CUBE made no feed\n');
  });

  it('an upload that fails attaches nothing', async () => {
    anchors_stand(SUB01);
    uploadFailures.add('seg.nii');
    const result = await builtin_berth(['close']);
    expect(strip(result.renderedErr)).toBe(`berth: close: 1 file did not reach ${folder_uploaded()}; nothing attached, and what did reach it stays there\n`);
    expect(mockPluginRun).not.toHaveBeenCalled();
    expect(berthState_read(anchors).lastClosedAt).toBeNull();
  });

  it('a close that attached sets lastClosedAt, which clear reads, and a second close is a second node', async () => {
    anchors_stand(SUB01);
    const before: number = Date.now();
    await builtin_berth(['close']);
    const closed: string | null = berthState_read(anchors).lastClosedAt;
    expect(closed).not.toBeNull();
    expect(Date.parse(closed ?? '')).toBeGreaterThanOrEqual(before - 1000);
    // Nothing written after the close counts as unclosed: clear asks nothing.
    expect((await builtin_berth(['clear'])).status).toBe('ok');
    expect(mockConfirm).not.toHaveBeenCalled();

    writeFileSync(join(outgoing, 'again.txt'), 'again');
    anchors_stand(SUB01);
    await builtin_berth(['close']);
    expect(mockPluginRun).toHaveBeenCalledTimes(2);
    const folders: string[] = mockUpload.mock.calls.map((call) => call[1] as string);
    expect(new Set(folders).size).toBe(2);
    expect(folders.every((folder: string): boolean => FOLDER.test(folder) && posix.dirname(folder) === '/home/alice/berth')).toBe(true);
  });
});
