/**
 * Tests for the chili controllers (thin delegators over cumin + salsa).
 * Mocks @fnndsc/salsa; partial-mocks cumin (real listParams/record_extract/
 * dictionary_parseFromCLI, stubbed group/feed constructors).
 */
const mockSalsa = {
  files_getGroup: jest.fn(),
  files_getSingle: jest.fn(),
  files_share: jest.fn(),
  fileContent_get: jest.fn(),
  plugin_run: jest.fn(),
  plugins_searchableToIDs: jest.fn(),
  pluginMeta_readmeContentFetch: jest.fn(),
  pluginReadme_fetchFromRepository: jest.fn(),
  pluginMeta_documentationUrlGet: jest.fn(),
  pluginMeta_pluginIDFromSearch: jest.fn(),
};
const mockCreateFromDirs = jest.fn();

jest.mock('@fnndsc/salsa', () => mockSalsa);
jest.mock('@fnndsc/cumin', () => ({
  ...jest.requireActual('@fnndsc/cumin'),
  ChRISFeedGroup: jest.fn(),
  ChRISPluginGroup: jest.fn(),
  ChRISFeed: jest.fn().mockImplementation(() => ({ createFromDirs: mockCreateFromDirs })),
}));

import { Ok, Err, errorStack } from '@fnndsc/cumin';
import { BaseController } from '../src/controllers/baseController';
import { FeedController } from '../src/controllers/feedController';
import { FileController } from '../src/controllers/fileController';
import { PluginController } from '../src/controllers/pluginController';

function baseWith(asset: Record<string, unknown>) {
  return new BaseController({ asset } as never);
}

let logSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('BaseController', () => {
  it('resources_get returns results, or null on error', async () => {
    const ok = baseWith({ resources_listAndFilterByOptions: jest.fn().mockResolvedValue('R') });
    expect(await ok.resources_get({})).toBe('R');
    const bad = baseWith({ resources_listAndFilterByOptions: jest.fn().mockRejectedValue(new Error('x')) });
    expect(await bad.resources_get({})).toBeNull();
  });

  it('resourceFields_get + resource_delete delegate', async () => {
    const c = baseWith({
      resourceFields_get: jest.fn().mockResolvedValue({ fields: ['id'] }),
      resourceItem_delete: jest.fn().mockResolvedValue(true),
    });
    expect(await c.resourceFields_get()).toEqual({ fields: ['id'] });
    expect(await c.resource_delete(3)).toBe(true);
  });

  it('resourceIDs_resolve extracts ids, or null', async () => {
    const c = baseWith({
      resources_listAndFilterByOptions: jest.fn().mockResolvedValue({ selectedFields: ['id'], tableData: [{ id: 1 }, { id: 2 }] }),
    });
    expect(await c.resourceIDs_resolve({})).toEqual([1, 2]);
    const none = baseWith({ resources_listAndFilterByOptions: jest.fn().mockResolvedValue(null) });
    expect(await none.resourceIDs_resolve({})).toBeNull();
  });
});

describe('FeedController', () => {
  it('controller_create builds an instance', () => {
    expect(FeedController.controller_create()).toBeInstanceOf(FeedController);
  });
  it('feeds_share resolves', async () => {
    await expect(FeedController.controller_create().feeds_share({})).resolves.toBeUndefined();
  });
  it('feed_create returns the created record, or null on error', async () => {
    const c = FeedController.controller_create();
    mockCreateFromDirs.mockResolvedValue({ id: 1 });
    expect(await c.feed_create({ dirs: '/a' })).toEqual({ id: 1 });
    mockCreateFromDirs.mockRejectedValue(new Error('x'));
    expect(await c.feed_create({ dirs: '/a' })).toBeNull();
  });
});

describe('FileController', () => {
  it('handler_create returns a controller, or null', async () => {
    mockSalsa.files_getGroup.mockResolvedValue({ folder: '/p' });
    const c = await FileController.handler_create('files');
    expect(c).toBeInstanceOf(FileController);
    expect(c?.path_get).toBe('/p');
    mockSalsa.files_getGroup.mockResolvedValue(null);
    expect(await FileController.handler_create('files')).toBeNull();
  });

  it('member_create returns a controller, or null', async () => {
    mockSalsa.files_getSingle.mockResolvedValue({});
    expect(await FileController.member_create('/f')).toBeInstanceOf(FileController);
    mockSalsa.files_getSingle.mockResolvedValue(null);
    expect(await FileController.member_create('/f')).toBeNull();
  });

  it('files_share requires a fileId', async () => {
    mockSalsa.files_getSingle.mockResolvedValue({});
    const c = (await FileController.member_create('/f'))!;
    await c.files_share({});
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('fileId is required'));
    await c.files_share({ fileId: 5 });
    expect(mockSalsa.files_share).toHaveBeenCalled();
  });

  it('files_share says the reason when nothing was shared', async () => {
    mockSalsa.files_getSingle.mockResolvedValue({});
    const c = (await FileController.member_create('/f'))!;
    mockSalsa.files_share.mockImplementation(async (): Promise<boolean> => {
      errorStack.stack_push('error', 'Sharing file 5 by its id is not offered here: nothing was shared.');
      return false;
    });
    await c.files_share({ fileId: 5 });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('nothing was shared'));
  });

  it('file_view prints content or an error', async () => {
    mockSalsa.files_getSingle.mockResolvedValue({});
    const c = (await FileController.member_create('/f'))!;
    mockSalsa.fileContent_get.mockResolvedValue(Ok('hello'));
    await c.file_view('/f');
    expect(logSpy).toHaveBeenCalledWith('hello');
    mockSalsa.fileContent_get.mockResolvedValue(Err());
    await c.file_view('/f');
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('PluginController', () => {
  it('controller_create builds an instance', () => {
    expect(PluginController.controller_create()).toBeInstanceOf(PluginController);
  });

  it('plugin_run parses params and delegates', async () => {
    const c = PluginController.controller_create();
    mockSalsa.plugin_run.mockResolvedValue({ id: 1 });
    expect(await c.plugin_run('pl-x', '--a 1')).toEqual({ id: 1 });
    expect(mockSalsa.plugin_run).toHaveBeenCalledWith('pl-x', expect.objectContaining({ a: expect.anything() }));
  });

  it('delegates the remaining salsa-backed methods', async () => {
    const c = PluginController.controller_create();
    mockSalsa.plugins_searchableToIDs.mockResolvedValue(['1']);
    expect(await c.plugin_searchableToIDs('pl')).toEqual(['1']);
    mockSalsa.pluginMeta_readmeContentFetch.mockResolvedValue('README');
    expect(await c.readmeContent_fetch('http://r')).toBe('README');
    const document = { content: 'README', format: 'markdown', sourceUrl: 'README.md' };
    mockSalsa.pluginReadme_fetchFromRepository.mockResolvedValue(document);
    expect(await c.readmeDocument_fetch('http://r')).toEqual(document);
    mockSalsa.pluginMeta_documentationUrlGet.mockResolvedValue('http://d');
    expect(await c.documentationUrl_get('5')).toBe('http://d');
    mockSalsa.pluginMeta_pluginIDFromSearch.mockResolvedValue('7');
    expect(await c.pluginID_findBySearch({ name: 'pl' })).toBe('7');
    await expect(c.plugins_overview()).resolves.toBeUndefined();
    await expect(c.plugin_infoGet('5')).resolves.toBeUndefined();
  });
});
