/**
 * @jest-environment node
 */
/**
 * @file The plugin run builtin with an input operand (#1303): a directory
 * is the place the run stands, files are staged and the feed named by their
 * subjects, an fs plugin takes the operand as its dir, a refusal runs nothing.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

const mockExecuteInPlace = jest.fn();
const mockPluginsList = jest.fn();
jest.unstable_mockModule('@fnndsc/salsa', () => ({ plugin_executeInPlace: mockExecuteInPlace, plugins_list: mockPluginsList }));
cuminMock_install(() => ({
  path_isInFeed: (path: string): boolean => path.includes('/feeds/feed_'),
  path_extractPluginInstanceID: (path: string): number | null => { const found = path.match(/\/pl-[^/]+_(\d+)(\/|$)/); return found ? Number(found[1]) : null; },
  procCache_get: () => ({ instance_get: () => null, instance_add: () => undefined, feed_add: () => undefined }),
  envelope_ok: (rendered: string, model?: unknown) => ({ status: 'ok', rendered, ...(model !== undefined ? { model } : {}) }),
  envelope_error: (rendered: string) => ({ status: 'error', rendered }),
  errorStack: { stack_pop: () => undefined, stack_push: () => undefined, checkpoint_mark: () => 0, checkpoint_drain: () => undefined },
}));
jest.unstable_mockModule('../src/session/index.js', () => ({ session: { getCWD: async () => '/home/u/uploads' } }));
jest.unstable_mockModule('../src/lib/vfs/vfs.js', () => ({ vfs: { data_get: async () => ({ ok: true, value: [{ name: 'pl-dircopy-v2.1.2', type: 'plugin' }] }) } }));
jest.unstable_mockModule('../src/builtins/feedCreation.js', () => ({ newFeed_cacheAdd: jest.fn(), run_follow: jest.fn() }));
jest.unstable_mockModule('../src/builtins/res/runWait.js', () => ({
  runs_awaitSettled: async () => ({ outcome: 'settled', failed: 0 }), settlement_render: () => 'settled', settlementStatus_derive: () => 'finishedSuccessfully',
}));
const lines: string[] = [];
const errors: string[] = [];
jest.unstable_mockModule('../src/core/sink.js', () => ({ sink_dataLine: (line: string) => { lines.push(line); }, sink_errLine: (line: string) => { errors.push(line); } }));
jest.unstable_mockModule('../src/core/handlerRun.js', () => ({ exitCode_set: jest.fn() }));
jest.unstable_mockModule('../src/core/paths.js', () => ({ path_resolve: async (input: string) => input === '~' ? '/home/u' : input }));
/** A CFS by path: what stands where, and what the run made on it. */
const world: Record<string, 'dir' | 'file'> = {};
const made: string[] = [];
const copied: Array<[string, string]> = [];
jest.unstable_mockModule('../src/core/filesystem.js', () => ({
  vfsDispatcher_get: () => ({
    list: async (parent: string) => ({ ok: true, value: Object.entries(world).filter(([path]) => path.slice(0, path.lastIndexOf('/')) === parent).map(([path, type]) => ({ name: path.slice(path.lastIndexOf('/') + 1), type })) }),
    mkdir: async (path: string) => { made.push(path); world[path] = 'dir'; return { ok: true, value: true }; },
    cp: async (source: string, destination: string) => { copied.push([source, destination]); world[destination] = 'file'; return { ok: true, value: true }; },
    path_isVirtual: () => false,
  }),
}));

const { builtin_executePlugin } = await import('../src/builtins/pluginExecute.js');
const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

beforeEach(() => {
  jest.clearAllMocks();
  lines.length = 0;
  errors.length = 0;
  made.length = 0;
  copied.length = 0;
  for (const key of Object.keys(world)) delete world[key];
  Object.assign(world, { '/home/u/uploads/subjects': 'dir', '/home/u/uploads/t1.nii': 'file', '/home/u/uploads/t2.nii': 'file' });
  mockPluginsList.mockResolvedValue({ tableData: [{ id: 1, name: 'pl-freesurfer', version: '1.0.4', type: 'ds' }] });
  mockExecuteInPlace.mockResolvedValue({ pluginInstanceID: 77, pluginName: 'pl-freesurfer', outputPath: '/home/u/feeds/feed_9/pl-dircopy_40/pl-freesurfer_77/data/', feedID: 9, dircopyInstanceID: 40, parentID: 40 });
});

describe('builtin_executePlugin with an operand', () => {
  it('runs on the directory operand instead of cwd, the plugin keeping its own flags', async () => {
    await builtin_executePlugin('pl-freesurfer-v1.0.4', ['/home/u/uploads/subjects', '--threads', '2']);
    expect(mockExecuteInPlace).toHaveBeenCalledWith('name_exact:pl-freesurfer,version:1.0.4', { threads: 2 }, { feed_title: 'subjects' }, '/home/u/uploads/subjects', ['pl-dircopy-v2.1.2']);
  });

  it('stages file operands, names the feed by the subjects, and says what CUBE made', async () => {
    await builtin_executePlugin('pl-freesurfer-v1.0.4', ['/home/u/uploads/t1.nii', 'as', 'sub-01']);
    const stage: string = made[0] as string;
    expect(stage).toMatch(/^\/home\/u\/\.mise\/stage\/\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect(made).toEqual([stage, `${stage}/sub-01`]);
    expect(copied).toEqual([['/home/u/uploads/t1.nii', `${stage}/sub-01/t1.nii`]]);
    expect(mockExecuteInPlace).toHaveBeenCalledWith('name_exact:pl-freesurfer,version:1.0.4', {}, { feed_title: 'sub-01' }, stage, ['pl-dircopy-v2.1.2']);
    const said: string[] = lines.map(strip);
    expect(said).toContain('subject sub-01 from /home/u/uploads/t1.nii');
    expect(said).toContain(`made /home/u/feeds/feed_9/pl-dircopy_40/data/${stage.slice(1).replace(/\//g, '_')}/sub-01/t1.nii`);
  });

  it('hands an fs plugin its operands as dir, untranslated, and refuses as there', async () => {
    mockPluginsList.mockResolvedValue({ tableData: [{ id: 2, name: 'pl-dircopy', version: '2.1.2', type: 'fs' }] });
    await builtin_executePlugin('pl-dircopy-v2.1.2', ['/home/u/uploads/t1.nii']);
    expect(made).toEqual([]);
    expect(mockExecuteInPlace).toHaveBeenCalledWith('name_exact:pl-dircopy,version:2.1.2', { dir: '/home/u/uploads/t1.nii' }, { feed_title: 'uploads' }, '/home/u/uploads', ['pl-dircopy-v2.1.2']);
    const refused = await builtin_executePlugin('pl-dircopy-v2.1.2', ['/home/u/uploads/t1.nii', 'as', 'x']);
    expect(refused.status).toBe('error');
    expect(errors.map(strip).join('\n')).toContain('an fs plugin takes paths as its dir, not subjects');
  });

  it('runs once per directory when the line names several, and nothing when one of them is refused (#1449)', async () => {
    world['/home/u/uploads/sub-02'] = 'dir';
    const ran = await builtin_executePlugin('pl-freesurfer-v1.0.4', ['/home/u/uploads/subjects', '/home/u/uploads/sub-02', '--threads', '2']);
    expect(ran.status).toBe('ok');
    expect(mockExecuteInPlace).toHaveBeenCalledTimes(2);
    expect(mockExecuteInPlace).toHaveBeenNthCalledWith(1, 'name_exact:pl-freesurfer,version:1.0.4', { threads: 2 }, { feed_title: 'subjects' }, '/home/u/uploads/subjects', ['pl-dircopy-v2.1.2']);
    expect(mockExecuteInPlace).toHaveBeenNthCalledWith(2, 'name_exact:pl-freesurfer,version:1.0.4', { threads: 2 }, { feed_title: 'sub-02' }, '/home/u/uploads/sub-02', ['pl-dircopy-v2.1.2']);
    expect(lines.map(strip)).toEqual(expect.arrayContaining(['pl-freesurfer-v1.0.4 /home/u/uploads/subjects:', 'pl-freesurfer-v1.0.4 /home/u/uploads/sub-02:']));
    mockExecuteInPlace.mockClear();
    const refused = await builtin_executePlugin('pl-freesurfer-v1.0.4', ['/home/u/uploads/subjects', '/home/u/uploads/none']);
    expect(refused.status).toBe('error');
    expect(mockExecuteInPlace).not.toHaveBeenCalled();
  });

  it('hands an fs plugin several directories as its one dir, in one run', async () => {
    world['/home/u/uploads/sub-02'] = 'dir';
    mockPluginsList.mockResolvedValue({ tableData: [{ id: 2, name: 'pl-dircopy', version: '2.1.2', type: 'fs' }] });
    await builtin_executePlugin('pl-dircopy-v2.1.2', ['/home/u/uploads/subjects', '/home/u/uploads/sub-02']);
    expect(mockExecuteInPlace).toHaveBeenCalledTimes(1);
    expect(mockExecuteInPlace).toHaveBeenCalledWith('name_exact:pl-dircopy,version:2.1.2', { dir: '/home/u/uploads/subjects,/home/u/uploads/sub-02' }, { feed_title: 'uploads' }, '/home/u/uploads', ['pl-dircopy-v2.1.2']);
  });

  it('runs nothing when the operand is refused, or the plugin kind cannot be read', async () => {
    const refused = await builtin_executePlugin('pl-freesurfer-v1.0.4', ['/home/u/uploads/none.nii']);
    expect(refused.status).toBe('error');
    expect(errors.map(strip).join('\n')).toContain('pl-freesurfer-v1.0.4: /home/u/uploads/none.nii: no such file or directory');
    expect(mockExecuteInPlace).not.toHaveBeenCalled();
    mockPluginsList.mockResolvedValue(null);
    const unknown = await builtin_executePlugin('pl-freesurfer-v1.0.4', ['/home/u/uploads/subjects']);
    expect(unknown.status).toBe('error');
    expect(mockExecuteInPlace).not.toHaveBeenCalled();
  });

  it('leaves a line with no operand as it was: cwd, the title from cwd', async () => {
    await builtin_executePlugin('pl-freesurfer-v1.0.4', ['--threads', '2']);
    expect(mockPluginsList).not.toHaveBeenCalled();
    expect(mockExecuteInPlace).toHaveBeenCalledWith('name_exact:pl-freesurfer,version:1.0.4', { threads: 2 }, { feed_title: 'uploads' }, '/home/u/uploads', ['pl-dircopy-v2.1.2']);
  });
});
