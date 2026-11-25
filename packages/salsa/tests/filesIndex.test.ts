/**
 * Boundary-only tests for salsa files/index. Real Result/errorStack; stubbed
 * cumin objContext_create/chrisContext/chrisIO, the content helpers and the
 * vfs dispatcher. The module's own logic (resolution, dispatch, recursion) runs.
 */
const mockObjCreate = jest.fn();
const mockCtxGet = jest.fn();
const mockIO = {
  file_upload: jest.fn(),
  folder_deleteByPath: jest.fn(),
  file_download: jest.fn(),
  folder_create: jest.fn(),
  folder_moveByPath: jest.fn(),
  file_moveById: jest.fn(),
  file_deleteById: jest.fn(),
  uploadLocalPath: jest.fn(),
};
const mockPipeline = { fileContent_getPipeline: jest.fn(), fileContent_getPipelineBinary: jest.fn() };
const mockRegular = {
  fileContent_getRegular: jest.fn(),
  fileContent_getRegularBinary: jest.fn(),
  fileContent_getRegularStream: jest.fn(),
};
const mockPacs = { fileContent_getPACS: jest.fn(), fileContent_getPACSBinary: jest.fn() };
const mockDispatcher = { provider_get: jest.fn(), read: jest.fn(), readBinary: jest.fn(), path_isVirtual: jest.fn((): boolean => false) };

jest.mock('@fnndsc/cumin', () => ({
  ...jest.requireActual('@fnndsc/cumin'),
  objContext_create: mockObjCreate,
  chrisContext: { current_get: mockCtxGet },
  chrisIO: mockIO,
}));
jest.mock('../src/files/pipeline_content', () => mockPipeline);
jest.mock('../src/files/regular_content', () => mockRegular);
jest.mock('../src/files/pacs_content', () => mockPacs);
jest.mock('../src/vfs/dispatcher', () => ({ vfsDispatcher: mockDispatcher }));
const mockReplace = jest.fn();
jest.mock('../src/files/replace', () => ({ file_replace: mockReplace }));

import { Ok, Err, errorStack } from '@fnndsc/cumin';
import {
  files_getGroup,
  files_getSingle,
  files_listRecursive,
  files_copyRecursively,
  files_list,
  files_listAll,
  files_listOutcome,
  fileFields_get,
  files_delete,
  folderByPath_delete,
  files_create,
  files_touch,
  files_mkdir,
  files_uploadPath,
  files_share,
  files_copy,
  files_move,
  fileContent_get,
  fileContent_getBinary,
  fileContent_getBinaryStream,
} from '../src/files/index';

/** A fake embedded resource group with the asset methods the module calls. */
function group(asset: Record<string, unknown>): unknown {
  return { asset };
}

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

beforeEach(() => {
  jest.clearAllMocks();
  errorStack.stack_clear();
});

describe('files_getGroup', () => {
  it.each([
    ['files', 'ChRISFilesContext'],
    ['links', 'ChRISLinksContext'],
    ['dirs', 'ChRISDirsContext'],
  ])('creates the %s context', async (asset, ctxName) => {
    mockObjCreate.mockResolvedValue(group({}));
    await files_getGroup(asset, '/p');
    expect(mockObjCreate).toHaveBeenCalledWith(ctxName, 'folder:/p');
  });

  it('defaults the path to the current folder context', async () => {
    mockCtxGet.mockResolvedValue('/home/chris');
    mockObjCreate.mockResolvedValue(group({}));
    await files_getGroup('files');
    expect(mockObjCreate).toHaveBeenCalledWith('ChRISFilesContext', 'folder:/home/chris');
  });

  it('defaults to "/" when no context is set', async () => {
    mockCtxGet.mockResolvedValue(null);
    mockObjCreate.mockResolvedValue(group({}));
    await files_getGroup('files');
    expect(mockObjCreate).toHaveBeenCalledWith('ChRISFilesContext', 'folder:/');
  });

  it('returns null for an unsupported asset type', async () => {
    expect(await files_getGroup('bogus', '/p')).toBeNull();
  });

  it('returns null for a projection path without asking cumin to build a context', async () => {
    // /proc, /net/pacs and the like have no CUBE folder; a path walk that
    // visited every ancestor turned that into a wall of identical errors.
    mockDispatcher.path_isVirtual.mockReturnValueOnce(true);
    mockObjCreate.mockResolvedValue(group({}));
    expect(await files_getGroup('links', '/proc/jobs/feed_4461/pl-dircopy_588089')).toBeNull();
    expect(mockDispatcher.path_isVirtual).toHaveBeenCalledWith('/proc/jobs/feed_4461/pl-dircopy_588089');
    expect(mockObjCreate).not.toHaveBeenCalled();
  });

  it('still builds a context for a real folder the projection guard passes', async () => {
    mockDispatcher.path_isVirtual.mockReturnValue(false);
    mockObjCreate.mockResolvedValue(group({}));
    await files_getGroup('files', '/home/chris/feeds');
    expect(mockObjCreate).toHaveBeenCalledWith('ChRISFilesContext', 'folder:/home/chris/feeds');
  });

  it('returns null when creation throws', async () => {
    mockObjCreate.mockRejectedValue(new Error('x'));
    expect(await files_getGroup('files', '/p')).toBeNull();
  });

  it('returns null when creation yields nothing', async () => {
    mockObjCreate.mockResolvedValue(null);
    expect(await files_getGroup('files', '/p')).toBeNull();
  });
});

describe('list / fields / delete delegate to the group asset', () => {
  it('files_list', async () => {
    mockObjCreate.mockResolvedValue(group({ resources_listAndFilterByOptions: jest.fn().mockResolvedValue('L') }));
    expect(await files_list({ limit: 1 } as never, 'files', '/p')).toBe('L');
  });
  it('files_list returns null when the group is unavailable', async () => {
    mockObjCreate.mockResolvedValue(null);
    expect(await files_list({} as never, 'files', '/p')).toBeNull();
  });
  it('files_listAll returns the walk, and null for empty or missing', async () => {
    mockObjCreate.mockResolvedValue(group({ resources_getAll: jest.fn().mockResolvedValue({ tableData: ['A'] }) }));
    expect(await files_listAll({} as never, 'files', '/p')).toEqual({ tableData: ['A'] });
    mockObjCreate.mockResolvedValue(group({ resources_getAll: jest.fn().mockResolvedValue(null) }));
    expect(await files_listAll({} as never, 'files', '/p')).toBeNull();
    mockObjCreate.mockResolvedValue(null);
    expect(await files_listAll({} as never, 'files', '/p')).toBeNull();
  });

  it('files_listOutcome tells an empty folder from a missing one from a refusal', async () => {
    // The three answers `files_listAll` spells the same way (#462).
    mockObjCreate.mockResolvedValue(group({ resources_getAll: jest.fn().mockResolvedValue({ tableData: ['A'] }) }));
    expect(await files_listOutcome({} as never, 'files', '/p')).toEqual({ kind: 'listing', data: { tableData: ['A'] } });
    mockObjCreate.mockResolvedValue(group({ resources_getAll: jest.fn().mockResolvedValue(null) }));
    expect(await files_listOutcome({} as never, 'files', '/p')).toEqual({ kind: 'empty' });
    mockObjCreate.mockResolvedValue(null);
    expect(await files_listOutcome({} as never, 'files', '/p')).toEqual({ kind: 'missing' });
    mockObjCreate.mockResolvedValue(group({
      resources_getAll: jest.fn().mockRejectedValue(new Error('Internal server error')),
    }));
    const refused = await files_listOutcome({} as never, 'files', '/p');
    expect(refused.kind).toBe('refused');
    expect(refused.kind === 'refused' && refused.error.message).toBe('Internal server error');
  });

  it('files_listAll rethrows a refusal rather than spelling it null', async () => {
    mockObjCreate.mockResolvedValue(group({
      resources_getAll: jest.fn().mockRejectedValue(new Error('Internal server error')),
    }));
    await expect(files_listAll({} as never, 'files', '/p')).rejects.toThrow('Internal server error');
  });
  it('fileFields_get returns fields, or null', async () => {
    mockObjCreate.mockResolvedValue(group({ resourceFields_get: jest.fn().mockResolvedValue({ fields: ['a'] }) }));
    expect(await fileFields_get('files')).toEqual(['a']);
    mockObjCreate.mockResolvedValue(group({ resourceFields_get: jest.fn().mockResolvedValue(null) }));
    expect(await fileFields_get('files')).toBeNull();
  });
  it('deletes a FILE by its id, without listing the folder it is in', async () => {
    // A folder whose listing the server refuses is exactly the one an
    // operator needs to clear, and a delete that walks the parent cannot
    // help there (#462).
    const load = jest.fn().mockResolvedValue({});
    const del = jest.fn().mockResolvedValue(true);
    mockObjCreate.mockResolvedValue(group({ resources_getAll: load, resourceItem_delete: del }));
    mockIO.file_deleteById.mockResolvedValue(Ok(true));
    expect(await files_delete(3, 'files', '/home/alice/scratch')).toBe(true);
    expect(mockIO.file_deleteById).toHaveBeenCalledWith(3);
    expect(load).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('still resolves other asset kinds through the parent group', async () => {
    const load = jest.fn().mockResolvedValue({});
    const del = jest.fn().mockResolvedValue(true);
    mockObjCreate.mockResolvedValue(group({ resources_getAll: load, resourceItem_delete: del }));
    expect(await files_delete(3, 'dirs', '/home/alice/scratch')).toBe(true);
    // The group must be anchored at the given parent, not the ambient cwd.
    expect(mockObjCreate).toHaveBeenCalledWith(expect.any(String), 'folder:/home/alice/scratch');
    // Deletion resolves the id against the loaded collection.
    expect(load.mock.invocationCallOrder[0]).toBeLessThan(del.mock.invocationCallOrder[0]);
    mockObjCreate.mockResolvedValue(null);
    expect(await files_delete(3, 'dirs')).toBe(false);
  });

  it('folderByPath_delete unwraps the chrisIO result', async () => {
    mockIO.folder_deleteByPath.mockResolvedValue(Ok(true));
    expect(await folderByPath_delete('/home/alice/scratch')).toBe(true);
    expect(mockIO.folder_deleteByPath).toHaveBeenCalledWith('/home/alice/scratch', {});
    mockIO.folder_deleteByPath.mockResolvedValue(Err());
    expect(await folderByPath_delete('/home/alice/scratch')).toBe(false);
  });
});

describe('files_getSingle', () => {
  it('creates a single-file context', async () => {
    mockObjCreate.mockResolvedValue(group({}));
    expect(await files_getSingle('/a/f.txt')).not.toBeNull();
  });
  it('returns null when creation throws', async () => {
    mockObjCreate.mockRejectedValue(new Error('x'));
    expect(await files_getSingle('/a/f.txt')).toBeNull();
  });
});

describe('files_create / touch', () => {
  it('uploads string content', async () => {
    mockIO.file_upload.mockResolvedValue(true);
    expect(await files_create('hello', '/a/f.txt')).toBe(true);
    expect(mockIO.file_upload).toHaveBeenCalledWith(expect.any(Blob), '/a', 'f.txt');
  });
  it('uploads Buffer content', async () => {
    mockIO.file_upload.mockResolvedValue(true);
    expect(await files_create(Buffer.from('x'), '/a/f.bin')).toBe(true);
  });
  it('records an error when upload fails', async () => {
    mockIO.file_upload.mockResolvedValue(false);
    expect(await files_create('x', '/a/f.txt')).toBe(false);
    expect(errorStack.stack_search('upload failed').length).toBeGreaterThan(0);
  });
  it('returns false when upload throws', async () => {
    mockIO.file_upload.mockRejectedValue(new Error('io'));
    expect(await files_create('x', '/a/f.txt')).toBe(false);
  });
  it('files_touch creates an empty file by default', async () => {
    mockIO.file_upload.mockResolvedValue(true);
    expect(await files_touch('/a/empty')).toBe(true);
  });

  // CUBE's upload does not replace, so a touch carrying content over a file
  // that already exists kept the OLD content and still reported success: a
  // session file written twice never changed after its first write. A
  // rewrite is handed to the swap in files/replace, which has its own tests;
  // here, only that it is handed over, with the id of the file that is there.
  it('files_touch hands a rewrite of a file that is there to the swap, by that file\'s id', async () => {
    mockObjCreate.mockResolvedValue(group({
      resources_getAll: jest.fn().mockResolvedValue({ tableData: [{ id: 7, fname: '/a/held.json' }] }),
    }));
    mockReplace.mockResolvedValue(true);

    expect(await files_touch('/a/held.json', 'new')).toBe(true);
    expect(mockReplace).toHaveBeenCalledWith('/a/held.json', expect.any(Blob), 7);
    expect(await (mockReplace.mock.calls[0][1] as Blob).text()).toBe('new');
    // The file there is neither deleted nor uploaded over from here.
    expect(mockIO.file_deleteById).not.toHaveBeenCalled();
    expect(mockIO.file_upload).not.toHaveBeenCalled();
  });

  it('files_touch answers false when the swap could not be made', async () => {
    mockObjCreate.mockResolvedValue(group({
      resources_getAll: jest.fn().mockResolvedValue({ tableData: [{ id: 7, fname: '/a/held.json' }] }),
    }));
    mockReplace.mockResolvedValue(false);
    expect(await files_touch('/a/held.json', 'new')).toBe(false);
  });

  it('writes content to a path holding nothing without reporting a miss', async () => {
    mockObjCreate.mockResolvedValue(group({
      resources_getAll: jest.fn().mockResolvedValue({ tableData: [] }),
    }));
    mockIO.file_upload.mockResolvedValue(true);

    expect(await files_touch('/a/fresh.json', 'new')).toBe(true);
    expect(mockIO.file_deleteById).not.toHaveBeenCalled();
    // Nothing being there is the ordinary case, not a fault to report.
    expect(errorStack.stack_search('not found').length).toBe(0);
  });

});

describe('files_mkdir / uploadPath / share', () => {
  it('mkdir returns true on success (created or already-exists)', async () => {
    mockIO.folder_create.mockResolvedValue(Ok(true));
    expect(await files_mkdir('/a/dir')).toBe(true);
  });
  it('mkdir returns false on failure', async () => {
    mockIO.folder_create.mockResolvedValue(Err());
    expect(await files_mkdir('/a/dir')).toBe(false);
  });
  it('uploadPath delegates to chrisIO', async () => {
    mockIO.uploadLocalPath.mockResolvedValue(true);
    expect(await files_uploadPath('/local', '/remote')).toBe(true);
  });
  it('share returns true', async () => {
    expect(await files_share(1, { is_public: true })).toBe(true);
  });
});

describe('files_copy', () => {
  function filesGroupWith(rows: unknown[]): void {
    mockObjCreate.mockResolvedValue(group({ resources_getAll: jest.fn().mockResolvedValue({ tableData: rows }) }));
  }

  it('resolves, downloads and re-uploads a file', async () => {
    filesGroupWith([{ id: 1, fname: '/a/f.txt' }]);
    mockIO.file_download.mockResolvedValue(Buffer.from('data'));
    mockIO.file_upload.mockResolvedValue(true);
    expect(await files_copy('/a/f.txt', '/b/f.txt')).toBe(true);
    expect(mockIO.file_download).toHaveBeenCalledWith(1);
  });

  it('fails when the source file is not found', async () => {
    filesGroupWith([{ id: 1, fname: '/a/other.txt' }]);
    expect(await files_copy('/a/f.txt', '/b/f.txt')).toBe(false);
  });

  it('fails when download returns null', async () => {
    filesGroupWith([{ id: 1, fname: '/a/f.txt' }]);
    mockIO.file_download.mockResolvedValue(null);
    expect(await files_copy('/a/f.txt', '/b/f.txt')).toBe(false);
  });
});

describe('files_move', () => {
  it('renames a directory server-side', async () => {
    // path_isDir(src) true -> dirs listing contains src; dest not a dir
    mockObjCreate.mockImplementation(async (_ctx: string) =>
      group({ resources_getAll: jest.fn().mockResolvedValue({ tableData: [{ path: '/a/dir' }] }) })
    );
    mockIO.folder_moveByPath.mockResolvedValue(Ok(true));
    expect(await files_move('/a/dir', '/b/newdir')).toBe(true);
    expect(mockIO.folder_moveByPath).toHaveBeenCalled();
  });

  it('moves a file by id when source is not a directory', async () => {
    // dirs listing empty -> src not dir; files listing has the file for id resolve
    mockObjCreate.mockImplementation(async (ctx: string) => {
      if (ctx === 'ChRISDirsContext') return group({ resources_getAll: jest.fn().mockResolvedValue({ tableData: [] }) });
      return group({ resources_getAll: jest.fn().mockResolvedValue({ tableData: [{ id: 9, fname: '/a/f.txt' }] }) });
    });
    mockIO.file_moveById.mockResolvedValue(Ok(true));
    expect(await files_move('/a/f.txt', '/b/g.txt')).toBe(true);
    expect(mockIO.file_moveById).toHaveBeenCalledWith(9, '/b/g.txt');
  });
});

describe('fileContent_get routing', () => {
  it('routes to the dispatcher for a matched provider', async () => {
    mockDispatcher.provider_get.mockReturnValue({ prefix: '/net/pacs' });
    mockDispatcher.read.mockResolvedValue(Ok('via-dispatcher'));
    expect((await fileContent_get('/net/pacs/x')).ok).toBe(true);
    expect(mockDispatcher.read).toHaveBeenCalled();
  });

  it('routes /PIPELINES/ to the pipeline handler', async () => {
    mockDispatcher.provider_get.mockReturnValue({ prefix: '' });
    mockPipeline.fileContent_getPipeline.mockResolvedValue(Ok('pipe'));
    await fileContent_get('/PIPELINES/p');
    expect(mockPipeline.fileContent_getPipeline).toHaveBeenCalled();
  });

  it('routes /SERVICES/PACS/ to the pacs handler', async () => {
    mockDispatcher.provider_get.mockReturnValue(null);
    mockPacs.fileContent_getPACS.mockResolvedValue(Ok('pacs'));
    await fileContent_get('/SERVICES/PACS/x');
    expect(mockPacs.fileContent_getPACS).toHaveBeenCalled();
  });

  it('falls back to the regular handler', async () => {
    mockDispatcher.provider_get.mockReturnValue({ prefix: '' });
    mockRegular.fileContent_getRegular.mockResolvedValue(Ok('reg'));
    await fileContent_get('/home/chris/f.txt');
    expect(mockRegular.fileContent_getRegular).toHaveBeenCalled();
  });
});

describe('fileContent_getBinary + stream routing', () => {
  it('binary via dispatcher', async () => {
    mockDispatcher.provider_get.mockReturnValue({ prefix: '/net/pacs' });
    mockDispatcher.readBinary.mockResolvedValue(Ok(Buffer.from('b')));
    expect((await fileContent_getBinary('/net/pacs/x')).ok).toBe(true);
  });
  it('binary falls back to regular', async () => {
    mockDispatcher.provider_get.mockReturnValue({ prefix: '' });
    mockRegular.fileContent_getRegularBinary.mockResolvedValue(Ok(Buffer.from('b')));
    await fileContent_getBinary('/home/f');
    expect(mockRegular.fileContent_getRegularBinary).toHaveBeenCalled();
  });
  it('stream via dispatcher wraps buffer with size', async () => {
    mockDispatcher.provider_get.mockReturnValue({ prefix: '/net/pacs' });
    mockDispatcher.readBinary.mockResolvedValue(Ok(Buffer.from('abc')));
    const r = await fileContent_getBinaryStream('/net/pacs/x');
    expect(r.ok && r.value.size).toBe(3);
  });
  it('stream falls back to the regular stream handler', async () => {
    mockDispatcher.provider_get.mockReturnValue({ prefix: '' });
    mockRegular.fileContent_getRegularStream.mockResolvedValue(Ok({ stream: 's' }));
    await fileContent_getBinaryStream('/home/f');
    expect(mockRegular.fileContent_getRegularStream).toHaveBeenCalled();
  });

  it('binary routes /PIPELINES/ and /SERVICES/PACS/', async () => {
    mockDispatcher.provider_get.mockReturnValue({ prefix: '' });
    mockPipeline.fileContent_getPipelineBinary.mockResolvedValue(Ok(Buffer.from('p')));
    await fileContent_getBinary('/PIPELINES/x');
    expect(mockPipeline.fileContent_getPipelineBinary).toHaveBeenCalled();

    mockPacs.fileContent_getPACSBinary.mockResolvedValue(Ok(Buffer.from('p')));
    await fileContent_getBinary('/SERVICES/PACS/x');
    expect(mockPacs.fileContent_getPACSBinary).toHaveBeenCalled();
  });

  it('stream routes /PIPELINES/ and /SERVICES/PACS/', async () => {
    mockDispatcher.provider_get.mockReturnValue({ prefix: '' });
    mockPipeline.fileContent_getPipelineBinary.mockResolvedValue(Ok(Buffer.from('pp')));
    const rp = await fileContent_getBinaryStream('/PIPELINES/x');
    expect(rp.ok && rp.value.size).toBe(2);

    mockPacs.fileContent_getPACSBinary.mockResolvedValue(Ok(Buffer.from('qqq')));
    const rq = await fileContent_getBinaryStream('/SERVICES/PACS/x');
    expect(rq.ok && rq.value.size).toBe(3);
  });
});

describe('files_listRecursive', () => {
  it('walks files and subdirectories depth-first', async () => {
    mockObjCreate.mockImplementation(async (ctx: string, value: string) => {
      const isRoot = value === 'folder:/root';
      if (ctx === 'ChRISFilesContext') {
        return group({ resources_getAll: jest.fn().mockResolvedValue({ tableData: isRoot ? [{ fname: '/root/a.txt', fsize: 10 }] : [] }) });
      }
      // dirs
      return group({ resources_getAll: jest.fn().mockResolvedValue({ tableData: isRoot ? [{ path: '/root/sub' }] : [] }) });
    });

    const items = await files_listRecursive('/root');
    expect(items).toEqual([
      { path: '/root/a.txt', type: 'file', size: 10 },
      { path: '/root/sub', type: 'dir' },
    ]);
  });
});

describe('files_copyRecursively', () => {
  function tree(): void {
    mockObjCreate.mockImplementation(async (ctx: string, value: string) => {
      if (ctx === 'ChRISFilesContext' && value === 'folder:/src') {
        return group({ resources_getAll: jest.fn().mockResolvedValue({ tableData: [{ id: 1, fname: '/src/f.txt', fsize: 5 }] }) });
      }
      if (ctx === 'ChRISDirsContext' && value === 'folder:/src') {
        return group({ resources_getAll: jest.fn().mockResolvedValue({ tableData: [{ path: '/src/d' }] }) });
      }
      return group({ resources_getAll: jest.fn().mockResolvedValue({ tableData: [] }) });
    });
  }

  it('mkdir + copy each item, returning true when all succeed', async () => {
    tree();
    mockIO.folder_create.mockResolvedValue(Ok(true));
    mockIO.file_download.mockResolvedValue(Buffer.from('data'));
    mockIO.file_upload.mockResolvedValue(true);

    expect(await files_copyRecursively('/src', '/dest')).toBe(true);
    expect(mockIO.folder_create).toHaveBeenCalledWith('/dest');
  });

  it('returns false when the initial mkdir throws', async () => {
    mockIO.folder_create.mockRejectedValue(new Error('io'));
    expect(await files_copyRecursively('/src', '/dest')).toBe(false);
  });
});

describe('a folder and a file never share a path', () => {
  /**
   * CUBE as three collections per folder: each listing answers only its own
   * kind, a folder row naming itself by `path`, a file row by `fname`.
   */
  function store_set(entries: { dirs?: string[]; files?: string[] }): void {
    mockObjCreate.mockImplementation(async (context: string, folder: string) => {
      const at: string = folder.replace(/^folder:/, '').replace(/^\//, '');
      // A folder CUBE does not have: the lookup says so on the stack and gives nothing.
      if (at !== '' && !(entries.dirs ?? []).includes(at)) {
        errorStack.stack_push('error', `Folder not found: /${at}`);
        return null;
      }
      const under = (paths: string[] = []): string[] => paths.filter((p: string): boolean => p.slice(0, p.lastIndexOf('/')) === at);
      const rows = context === 'ChRISDirsContext'
        ? under(entries.dirs).map((p: string, i: number) => ({ id: 100 + i, path: p }))
        : context === 'ChRISFilesContext'
          ? under(entries.files).map((p: string, i: number) => ({ id: 200 + i, fname: p }))
          : [];
      return group({ resources_getAll: jest.fn().mockResolvedValue({ tableData: rows }) });
    });
  }

  it('makes no folder where a file is: the shell\'s File exists', async () => {
    store_set({ dirs: ['a'], files: ['a/report.csv'] });
    expect(await files_mkdir('/a/report.csv')).toBe(false);
    expect(errorStack.stack_pop()?.message).toContain('File exists: a file already holds /a/report.csv');
    expect(mockIO.folder_create).not.toHaveBeenCalled();
  });

  it('makes no folder beneath a file either, since CUBE would make the file\'s path a folder on the way', async () => {
    store_set({ dirs: ['a'], files: ['a/report.csv'] });
    expect(await files_mkdir('/a/report.csv/sub')).toBe(false);
    expect(errorStack.stack_pop()?.message).toContain('Not a directory: a file holds /a/report.csv');
    expect(mockIO.folder_create).not.toHaveBeenCalled();
  });

  it('writes no file where a folder is', async () => {
    store_set({ dirs: ['a', 'a/x'] });
    expect(await files_create('content', '/a/x')).toBe(false);
    expect(errorStack.stack_pop()?.message).toContain('Is a directory: a folder already holds /a/x');
    expect(mockIO.file_upload).not.toHaveBeenCalled();
  });

  it('moves nothing onto a path something holds', async () => {
    store_set({ dirs: ['a', 'a/sub'], files: ['a/f.txt', 'a/taken'] });
    expect(await files_move('/a/f.txt', '/a/taken')).toBe(false);
    expect(errorStack.stack_pop()?.message).toContain('Destination exists: /a/taken');
    expect(mockIO.file_moveById).not.toHaveBeenCalled();
  });

  it('makes missing parents with the folder, a parent not there being an answer, not a failure', async () => {
    store_set({ dirs: ['a'] });
    mockIO.folder_create.mockResolvedValue(Ok(true));
    expect(await files_mkdir('/a/new/deeper')).toBe(true);
    expect(mockIO.folder_create).toHaveBeenCalledWith('/a/new/deeper');
    expect(errorStack.stack_getAll()).toEqual([]);
  });
});
