/**
 * @file Tests for the filebrowser cluster: browser binding, inode creation,
 * PACS file download and pipeline source file download. Connection mocked
 * at the client boundary.
 */

jest.mock('../src/connect/chrisConnection', () => ({
  chrisConnection: { client_get: jest.fn() },
}));

import { chrisConnection } from '../src/connect/chrisConnection';
import { ChRISFileBrowser, BrowserType } from '../src/filebrowser/chrisFileBrowser';
import { ChRISinode, ChRISinode_create } from '../src/filebrowser/chrisFiles';
import { PACS_FILE_FETCH_MS, pacsFile_getBlob, pacsFile_getText } from '../src/filebrowser/chrisPACS';
import { pipelineFile_getByPath, pipelineFile_getTextByPath } from '../src/filebrowser/chrisPipeline';
import { errorStack } from '../src/error/errorStack';

const mockClientGet: jest.Mock = chrisConnection.client_get as unknown as jest.Mock;

const folder_make = (): Record<string, jest.Mock> => ({
  getFiles: jest.fn(),
  getLinkFiles: jest.fn(),
  getChildren: jest.fn(),
});

let pushSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  pushSpy = jest.spyOn(errorStack, 'stack_push').mockImplementation(() => undefined);
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  pushSpy.mockRestore();
  errSpy.mockRestore();
});

describe('ChRISFileBrowser', () => {
  it.each([
    [BrowserType.Files, 'getFiles'],
    [BrowserType.Links, 'getLinkFiles'],
    [BrowserType.Dirs, 'getChildren'],
  ])('binds the %s variant', (variant: BrowserType, method: string) => {
    const browser: ChRISFileBrowser = new ChRISFileBrowser(variant, folder_make() as never);
    expect(browser.bindOp_get.status).toBe(true);
    expect(browser.bindOp_get.message).toContain(method);
    expect(browser.resource_get).not.toBeNull();
    expect(browser.fileBrowserFolder_get).not.toBeNull();
  });

  it('exposes the shared client accessor', async () => {
    mockClientGet.mockResolvedValue({ me: true });
    const browser: ChRISFileBrowser = new ChRISFileBrowser(BrowserType.Files, folder_make() as never);
    expect(await browser.client_get()).toEqual({ me: true });
  });
});

describe('ChRISinode', () => {
  it('creates an inode with all three browsers bound', async () => {
    mockClientGet.mockResolvedValue({
      getFileBrowserFolderByPath: jest.fn(async () => folder_make()),
    });
    const inode: ChRISinode = await ChRISinode.inode_create('/home/chris');
    expect(inode.path_get).toBe('/home/chris');
    expect(inode.fileBrowser_get?.bindOp_get.status).toBe(true);
    expect(inode.linkBrowser_get?.bindOp_get.status).toBe(true);
    expect(inode.dirBrowser_get?.bindOp_get.status).toBe(true);
    expect(inode.fileBrowserFolder_get).not.toBeNull();
  });

  it('throws when not connected', async () => {
    mockClientGet.mockResolvedValue(null);
    await expect(ChRISinode.inode_create('/x')).rejects.toThrow('Could not access ChRIS');
  });

  it('throws when the folder lookup fails or yields nothing', async () => {
    mockClientGet.mockResolvedValue({
      getFileBrowserFolderByPath: jest.fn(async () => { throw new Error('404'); }),
    });
    await expect(ChRISinode.inode_create('/x')).rejects.toThrow('Failed to get FileBrowserFolder');

    mockClientGet.mockResolvedValue({ getFileBrowserFolderByPath: jest.fn(async () => null) });
    await expect(ChRISinode.inode_create('/x')).rejects.toThrow('Failed to initialize');
  });

  it('ChRISinode_create wraps failures into null', async () => {
    mockClientGet.mockResolvedValue(null);
    expect(await ChRISinode_create('/x')).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('pacsFile_getBlob / pacsFile_getText', () => {
  const withPacsBlob = (blob: unknown): void => {
    mockClientGet.mockResolvedValue({
      getPACSFile: jest.fn(async () => ({ getFileBlob: jest.fn(async () => blob) })),
    });
  };

  it('preserves binary content from a string response', async () => {
    withPacsBlob('DICM\x00\x01');
    const result = await pacsFile_getBlob(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.subarray(0, 4).toString('binary')).toBe('DICM');
  });

  it('gives a PACS file ten minutes to arrive, not the client\'s 30 s', async () => {
    const getFileBlob = jest.fn(async () => Buffer.from('DICM'));
    mockClientGet.mockResolvedValue({ getPACSFile: jest.fn(async () => ({ getFileBlob })) });
    expect((await pacsFile_getBlob(1)).ok).toBe(true);
    expect(getFileBlob).toHaveBeenCalledWith(PACS_FILE_FETCH_MS);
    expect(PACS_FILE_FETCH_MS).toBe(600_000);
  });

  it('converts ArrayBuffer, Blob and Buffer responses', async () => {
    withPacsBlob(new TextEncoder().encode('ab').buffer);
    expect((await pacsFile_getBlob(1)).ok).toBe(true);

    withPacsBlob(new Blob(['bl']));
    expect((await pacsFile_getBlob(1)).ok).toBe(true);

    withPacsBlob(Buffer.from('bf'));
    expect((await pacsFile_getBlob(1)).ok).toBe(true);
  });

  it('errors on unexpected types, missing files, empty blobs and disconnects', async () => {
    withPacsBlob(42);
    expect((await pacsFile_getBlob(1)).ok).toBe(false);

    mockClientGet.mockResolvedValue({ getPACSFile: jest.fn(async () => null) });
    expect((await pacsFile_getBlob(1)).ok).toBe(false);

    withPacsBlob(null);
    expect((await pacsFile_getBlob(1)).ok).toBe(false);

    mockClientGet.mockResolvedValue(null);
    expect((await pacsFile_getBlob(1)).ok).toBe(false);
  });

  it('renders the blob as UTF-8 text', async () => {
    withPacsBlob('report text');
    const result = await pacsFile_getText(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('report text');
  });

  it('propagates blob failure to the text variant', async () => {
    mockClientGet.mockResolvedValue(null);
    expect((await pacsFile_getText(1)).ok).toBe(false);
  });
});

describe('pipelineFile_getByPath / pipelineFile_getTextByPath', () => {
  const sourceFileList = (fnames: string[], blob: unknown = 'yaml: content'): Record<string, unknown> => ({
    getItems: (): unknown[] => fnames.map((fname: string) => ({
      data: { fname },
      getFileBlob: jest.fn(async () => blob),
    })),
  });

  it('finds the file by full fname and returns its content', async () => {
    mockClientGet.mockResolvedValue({
      getPipelineSourceFiles: jest.fn(async () =>
        sourceFileList(['PIPELINES/u/other.yml', 'PIPELINES/u/target.yml'])),
    });
    const result = await pipelineFile_getByPath('/PIPELINES/u/target.yml');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.toString()).toBe('yaml: content');
  });

  it('errors when no fname matches', async () => {
    mockClientGet.mockResolvedValue({
      getPipelineSourceFiles: jest.fn(async () => sourceFileList(['PIPELINES/u/other.yml'])),
    });
    expect((await pipelineFile_getByPath('/PIPELINES/u/missing.yml')).ok).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('not found'));
  });

  it('errors on a null list, empty blob or disconnect', async () => {
    mockClientGet.mockResolvedValue({ getPipelineSourceFiles: jest.fn(async () => null) });
    expect((await pipelineFile_getByPath('/x.yml')).ok).toBe(false);

    mockClientGet.mockResolvedValue({
      getPipelineSourceFiles: jest.fn(async () => sourceFileList(['x.yml'], null)),
    });
    expect((await pipelineFile_getByPath('x.yml')).ok).toBe(false);

    mockClientGet.mockResolvedValue(null);
    expect((await pipelineFile_getByPath('/x.yml')).ok).toBe(false);
  });

  it('returns the content as text', async () => {
    mockClientGet.mockResolvedValue({
      getPipelineSourceFiles: jest.fn(async () => sourceFileList(['PIPELINES/u/t.yml'])),
    });
    const result = await pipelineFile_getTextByPath('/PIPELINES/u/t.yml');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('yaml');
  });
});
