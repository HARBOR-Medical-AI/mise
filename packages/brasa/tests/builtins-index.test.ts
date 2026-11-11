import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';
import type { ChrisIdentity, CommandEnvelope, Result } from '@fnndsc/cumin';
import type { DownloadSummary } from '@fnndsc/chili/commands/fs/download.js';
import type { ShellArguments } from '../src/lib/parser.js';

// Mock dependencies BEFORE imports
const mockGetCWD = jest.fn();
const mockSetCWD = jest.fn();
const mockDirectoryChange = jest.fn(async (path: string): Promise<void> => { mockSetCWD(path); });
const mockPreviousCWDGet = jest.fn<() => string | undefined>();
const mockUserGet = jest.fn();
const mockClientGet = jest.fn();
const mockGetFileBrowserFolderByPath = jest.fn();
// vfs.list hands back the listing it rendered (the third argument), as the real one does.
const mockVfsList = jest.fn(async (target?: string, _options?: unknown, kept?: { listing?: unknown }) => {
  if (kept !== undefined) {
    const listing = await mockVfsListingGet(target);
    if (listing.ok) kept.listing = (listing as { value: unknown }).value;
  }
  return { status: 'ok', rendered: '' };
});
const mockVfsDataGet = jest.fn(async () => ({ ok: true, value: [] }));
const mockVfsListingGet = jest.fn(async (target?: string) => {
  const result = await mockVfsDataGet(target);
  return result.ok ? { ok: true, value: { path: target ?? '/', items: result.value, fresh: true } } : { ok: false };
});
const mockVfsDispatcherList = jest.fn().mockResolvedValue({ ok: true, value: [] });
const mockVfsDispatcherLinkTargetResolve = jest.fn();
const mockContextGetSingle = jest.fn();
const mockConnectLogin = jest.fn();
const mockConnectLogout = jest.fn();
const mockPluginsFetchList = jest.fn();
const mockPluginExecute = jest.fn();
const mockFeedsFetchList = jest.fn();
const mockFeedCreate = jest.fn();
const mockFilesFetchList = jest.fn();
const mockFileFieldsFetch = jest.fn();
const mockChefsMkdir = jest.fn();
const mockChefsTouch = jest.fn();
const mockChefsUpload = jest.fn();
const mockChefsDownload = jest.fn();
const mockChefsDownloadMany = jest.fn();
const mockChefsCat = jest.fn();
const mockChefsRm = jest.fn();
const mockTableDisplay = jest.fn();
const mockTableRender = jest.fn(() => '');
const mockPluginListRender = jest.fn();
const mockPluginRunRender = jest.fn();
const mockFeedListRender = jest.fn();
const mockFeedCreateRender = jest.fn();
const mockLoginRender = jest.fn();
const mockLogoutRender = jest.fn();
const mockMkdirRender = jest.fn();
const mockTouchRender = jest.fn();
const mockUploadRender = jest.fn();
const mockCatRender = jest.fn();
const mockRmRender = jest.fn();
const mockChiliCommandRun = jest.fn();
const mockPluginFieldsFetch = jest.fn().mockResolvedValue([]);
const mockFeedFieldsFetch = jest.fn().mockResolvedValue([]);
const mockPipelineFieldsFetch = jest.fn().mockResolvedValue([]);
const mockComputeFieldsFetch = jest.fn().mockResolvedValue([]);
const STORE_DEFAULT = 'https://default/api/v1/';
let mockStoreUrl: string | undefined;
const mockStorePersist = jest.fn().mockResolvedValue(undefined);
const mockWildcardExpand = jest.fn();
const mockWildcardExpandMatches = jest.fn();
const mockStringCheckHasWildcard = jest.fn();

// Define local Ok, Err, and errorStack for consistent use across mocks and tests
const Ok = (val: any) => ({ ok: true, value: val });
const Err = (err: any) => ({ ok: false, error: err });
const errorStack = { stack_push: jest.fn(), stack_pop: jest.fn(), checkpoint_mark: jest.fn(() => 0), checkpoint_drain: jest.fn(() => []) };

// Mock chili utils
jest.unstable_mockModule('@fnndsc/chili/utils', () => ({
  logicalPath_resolve: jest.fn().mockResolvedValue({ ok: true, value: '/resolved/path' }),
  pathMapper_get: jest.fn()
}));

// Mock chili screen
jest.unstable_mockModule('@fnndsc/chili/screen/screen.js', () => ({
  table_display: mockTableDisplay,
  table_render: mockTableRender,
  border_draw: jest.fn(),
  chalkColor_get: jest.fn(() => undefined),
  screen: { print: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

// Mock chili path module
jest.unstable_mockModule('@fnndsc/chili/path/pathCommand.js', () => ({
  scan_do: jest.fn().mockResolvedValue({ fileInfo: [], totalSize: 0 }),
  archyTree_create: jest.fn().mockReturnValue('mock tree output'),
}));

// Mock cumin
const dicomPayload = await import('@fnndsc/cumin/dicom-payload');
const pacsGrammar = await import('@fnndsc/salsa/pacs-grammar');
cuminMock_install(() => ({
  feedTags_readByFeed: jest.fn(),
  feedStatus_deriveFromCounts: (): string => 'finishedSuccessfully',
  feed_share: jest.fn(async () => ({ ok: true, value: true })),
  plugin_find: jest.fn(async () => null),
  pluginParameters_drain: jest.fn(async () => []),
  feedShares_list: jest.fn(async () => ({ ok: true, value: [] })),
  feedAccess_read: jest.fn(async () => ({ ok: true, value: { users: [], groups: [], public: false } })),
  feedShare_group: jest.fn(async () => ({ ok: true, value: true })),
  feedShare_revoke: jest.fn(async () => ({ ok: true, value: true })),
  feed_makePublic: jest.fn(async () => ({ ok: true, value: true })),
  feed_makePrivate: jest.fn(async () => ({ ok: true, value: true })),
  feedTags_list: jest.fn(async () => ({ ok: true, value: [] })),
  feedTag_add: jest.fn(async () => ({ ok: true, value: true })),
  feedTag_remove: jest.fn(async () => ({ ok: true, value: true })),
  path_extractFeedID: (p: string) => { const m = /\/feeds\/feed_(\d+)(?:\/|$)/.exec(p); return m ? Number(m[1]) : null; },
  // The payload helpers are pure and side-effect free: forward the real ones.
  tag_extractValue: dicomPayload.tag_extractValue,
  studies_extractFromDecoded: dicomPayload.studies_extractFromDecoded,
  series_extractFromStudy: dicomPayload.series_extractFromStudy,
  seriesStorage_resolve: jest.fn(async () => ({ ok: false })),
  seriesStorage_resolveMany: jest.fn(async () => ({ ok: true, value: new Map() })),
  currentIdentity_get: jest.fn<() => Promise<Result<ChrisIdentity>>>(),
  envelope_ok: (rendered: string, model?: unknown) =>
    model === undefined ? { status: 'ok', rendered } : { status: 'ok', rendered, model },
  envelope_error: (rendered: string, errors?: unknown, renderedErr?: string) => {
    const envelope: Record<string, unknown> = { status: 'error', rendered };
    if (errors !== undefined) envelope.errors = errors;
    if (renderedErr !== undefined) envelope.renderedErr = renderedErr;
    return envelope;
  },
  listCache_get: () => ({
    cache_get: jest.fn(),
    cache_set: jest.fn(),
    cache_invalidate: jest.fn(),
    cache_invalidateTree: jest.fn(),
    cache_markDirty: jest.fn(),
  }),
  queryIndex_get: () => ({
    entry_note: jest.fn(),
    entry_find: jest.fn(() => null),
  }),
  procCache_get: () => ({
    instance_get: jest.fn(),
    lifecycle_get: jest.fn(() => ({ state: 'empty' })),
    warmupProgress_get: jest.fn(() => ({ loaded: 0, total: 0, active: false })),
    feedIDs_get: jest.fn(() => []),
    feedScopeCounts_get: jest.fn(() => ({ user: 0, public: 0, shared: 0, total: 0 })),
    get warmupComplete(): boolean { return false; },
  }),
  connectionConfig: { debug: false },
  errorStack: errorStack,
  Result: {},
  Ok: Ok,
  Err: Err,
  Context: {
    ChRISuser: 'ChRISuser',
    ChRISurl: 'ChRISurl',
    ChRISfolder: 'ChRISfolder',
    ChRISfeed: 'ChRISfeed',
    ChRISplugin: 'ChRISplugin'
  },
  FilteredResourceData: {},
  SingleContext: {},
  chrisContext: {
    current_get: jest.fn(),
    current_set: jest.fn(),
    currentContext_update: jest.fn()
  },
  keyPairParams_apply: jest.fn((baseParams, keyPair) => baseParams),
  logicalPath_resolve: jest.fn().mockResolvedValue({ ok: true, value: '/resolved/path' }),
  pathMapper_get: jest.fn(),
  chrisConnection: {
    client_get: jest.fn(),
    user_get: jest.fn()
  },
  computeResourceNames_parse: jest.fn(),
  computeResources_validate: jest.fn(),
  dictionary_parseFromCLI: jest.fn().mockReturnValue({}),
  StackMessage: {},
  Client: jest.fn(),
  pacsQueries_create: jest.fn(),
  pacsQueries_list: jest.fn(async () => ({ ok: false })),
  pacsRetrieve_statusForQuery: jest.fn(async () => ({ ok: false })),
  pacsRetrieve_create: jest.fn(),
  pacsQuery_get: jest.fn(),
  pacsQuery_resultDecode: jest.fn(),
  pacsServers_list: jest.fn(),
  path_isInFeed: jest.fn().mockReturnValue(false),
  path_extractPluginInstanceID: jest.fn().mockReturnValue(null),
  path_extractFeedID: jest.fn().mockReturnValue(null),
  feed_resolve: jest.fn().mockResolvedValue({ ok: false }),
  path_findLatestDircopy: jest.fn().mockReturnValue(null),
  pipeline_resolve: jest.fn().mockResolvedValue({ ok: false }),
  computeResources_getAll: jest.fn().mockResolvedValue({ ok: true, value: [] }),
}));

// Mock session
jest.unstable_mockModule('../src/session/index.js', () => ({
  session: {
    getCWD: mockGetCWD,
    setCWD: mockSetCWD,
    directory_change: mockDirectoryChange,
    previousCWD_get: mockPreviousCWDGet,
    physicalMode_get: jest.fn().mockReturnValue(false),
    timingEnabled_get: jest.fn().mockReturnValue(false),
    connection: {
      user_get: mockUserGet,
      client_get: mockClientGet
    }
  }
}));

jest.unstable_mockModule('../src/builtins/wildcard.js', () => ({
  wildcard_expand: mockWildcardExpand,
  wildcard_expandMatches: mockWildcardExpandMatches,
  string_checkHasWildcard: mockStringCheckHasWildcard,
}));

// Mock VFS
jest.unstable_mockModule('../src/lib/vfs/vfs.js', () => ({
  vfs: {
    list: mockVfsList,
    data_get: mockVfsDataGet,
    listing_get: mockVfsListingGet,
  }
}));

// Mock salsa
const isDirectoryMock = jest.fn(async (): Promise<boolean> => false);
const listRecursiveMock = jest.fn(async (): Promise<unknown[]> => []);
const archiveMock = jest.fn(async (): Promise<unknown> => null);
jest.unstable_mockModule('../src/builtins/fs/archive.js', () => ({
  directory_archive: archiveMock,
}));
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  pipelineInvocation_prepare: jest.fn(() => ({ ok: true, value: { pipelineID: 1, nodeOverrides: [] } })),
  syncSeams_cube: { cubeDescriptor_read: async () => null },
  PROC_TAGS_PREFIX: '/proc/tags',
  // The wait for a run to settle asks for statuses in one batch.
  jobs_statusBatch: async (ids: number[]): Promise<Map<number, string>> =>
    new Map(ids.map((id: number): [number, string] => [id, 'finishedSuccessfully'])),
  dicomSeries_summarize: jest.fn(),
  dicomSlice_gray: jest.fn(async () => ({ ok: false })),
  dicomFolder_list: jest.fn(),
  dicomHeader_get: jest.fn(),
  dicomTags_summarize: jest.fn(),
  dicomFiles_sample: jest.fn(),
  files_path_isDirectory: isDirectoryMock,
  files_listRecursive: listRecursiveMock,
  retrieveTask_make: (info: Record<string, unknown>) => ({ ...info, syntheticQueryId: null, retrieveId: null, status: 'pending', actualFiles: 0, lastProgressFiles: 0, lastProgressTime: 0, startTime: 0, lonkConfirmed: false, cubePathDir: null }),
  retrieveTasks_fire: jest.fn(),
  retrieveTasks_skipComplete: jest.fn(async () => 0),
  retrieve_fireAndWatch: jest.fn(async () => 0),
  retrieve_confirmLoop: jest.fn(async () => 0),
  retrieveProgress_classify: () => 'running',
  // The grammar is pure and side-effect free: forward the real functions so
  // these tests never drift against a stale copy.
  queryId_extractFromFolder: pacsGrammar.queryId_extractFromFolder,
  queryLabel_extractFromFolder: pacsGrammar.queryLabel_extractFromFolder,
  folderUID_get: pacsGrammar.folderUID_get,
  queryFolderName_build: pacsGrammar.queryFolderName_build,
  answer_standIn: (value: unknown): unknown => value,
  criteria_standIn: (criteria: Record<string, string>): Record<string, string> => criteria,
  localAccount_adminAccessEnsure: jest.fn(),
  localAccount_create: jest.fn(),
  localAccount_find: jest.fn(),
  localAccount_action: jest.fn(),
  context_getSingle: mockContextGetSingle,
  procCache_refresh: jest.fn().mockResolvedValue(undefined),
  feedGraphData_ensure: jest.fn(),
  feedGraph_build: jest.fn(),
  files_listAll: jest.fn().mockResolvedValue(null),
  files_copy: jest.fn().mockResolvedValue(true),
  files_copyRecursively: jest.fn().mockResolvedValue(true),
  files_mkdir: jest.fn().mockResolvedValue(true),
  files_touch: jest.fn().mockResolvedValue(true),
  files_uploadPath: jest.fn().mockResolvedValue(true),
  files_delete: jest.fn().mockResolvedValue(true),
  fileContent_get: jest.fn().mockResolvedValue(''),
  files_move: jest.fn().mockResolvedValue(true),
  files_list: jest.fn().mockResolvedValue(null),
  feeds_list: jest.fn().mockResolvedValue(null),
  feed_create: jest.fn().mockResolvedValue(null),
  pluginInstances_list: jest.fn().mockResolvedValue(null),
  plugin_assignToComputeResources: jest.fn(),
  plugin_checkExists: jest.fn(),
  plugin_importFromStore: jest.fn(),
  plugin_registerWithAdmin: jest.fn(),
  plugins_searchPeers: jest.fn(),
  store_list: jest.fn(),
  store_search: jest.fn(),
  vfsDispatcher: {
    provider_get: jest.fn().mockImplementation((path: string) => ({
      prefix: path.startsWith('/net') ? '/net/pacs' : path.startsWith('/proc') ? '/proc/jobs' : (path.startsWith('/bin') || path.startsWith('/usr')) ? path : ''
    })),
    providers_get: jest.fn().mockReturnValue([
      { prefix: '/net/pacs' },
      { prefix: '/bin' },
      { prefix: '/usr/bin' },
      { prefix: '/etc' },
      { prefix: '/proc/jobs' },
    ]),
    list: mockVfsDispatcherList,
    linkTarget_resolve: mockVfsDispatcherLinkTargetResolve,
    // cat reads through the session's filesystem: chili's cat stub answers it.
    read: async (p: string) => {
      const read = await mockChefsCat(p) as { ok: boolean; value?: string };
      return read.ok ? { ok: true, value: read.value } : { ok: false, errno: 'ENOENT' };
    },
    path_isVirtual: (path: string): boolean => /^\/(proc|net|bin|usr|etc)(\/|$)/.test(path),
  },
  pipelines_list: jest.fn().mockResolvedValue(null),
  pipelines_listAll: jest.fn().mockResolvedValue(null),
  pipelineFields_get: jest.fn().mockResolvedValue(null),
  pipeline_run: jest.fn().mockResolvedValue({ ok: false }),
  pipeline_sourceGet: jest.fn().mockResolvedValue({ ok: false }),
  pipelineDiagram_get: jest.fn().mockResolvedValue({ ok: false }),
  pipelineManifest_get: jest.fn().mockResolvedValue({ ok: false }),
  pipelineManifestBySlug_get: jest.fn().mockResolvedValue({ ok: false }),
  plugin_run: jest.fn().mockResolvedValue(null),
  tags_list: jest.fn().mockResolvedValue(null),
  tags_listAll: jest.fn().mockResolvedValue(null),
  tagFields_get: jest.fn().mockResolvedValue(null),
  groups_list: jest.fn().mockResolvedValue(null),
  groups_listAll: jest.fn().mockResolvedValue(null),
  groupFields_get: jest.fn().mockResolvedValue(null),
  pluginMetas_list: jest.fn().mockResolvedValue(null),
  pluginMetas_listAll: jest.fn().mockResolvedValue(null),
  pluginMetaFields_get: jest.fn().mockResolvedValue(null),
  pluginInstances_listAll: jest.fn().mockResolvedValue(null),
  pluginInstanceFields_get: jest.fn().mockResolvedValue(null),
  workflows_list: jest.fn().mockResolvedValue(null),
  workflows_listAll: jest.fn().mockResolvedValue(null),
  workflowFields_get: jest.fn().mockResolvedValue(null),
  feeds_listAll: jest.fn().mockResolvedValue(null),
  feedNote_get: jest.fn().mockResolvedValue({ ok: true, value: { title: '', content: '' } }),
  feedNote_update: jest.fn().mockResolvedValue({ ok: true, value: true }),
  feedComments_list: jest.fn().mockResolvedValue({ ok: true, value: [] }),
  feedComment_create: jest.fn().mockResolvedValue({ ok: true, value: { id: 1, title: '', content: '', owner_username: '' } }),
  feedComment_delete: jest.fn().mockResolvedValue({ ok: true, value: true }),
  feedComment_update: jest.fn().mockResolvedValue({ ok: true, value: true }),
}));

// Mock chili commands
jest.unstable_mockModule('@fnndsc/chili/commands/connect/login.js', () => ({ connect_login: mockConnectLogin }));
jest.unstable_mockModule('@fnndsc/chili/commands/connect/logout.js', () => ({ connect_logout: mockConnectLogout }));
jest.unstable_mockModule('@fnndsc/chili/commands/plugins/list.js', () => ({ plugins_fetchList: mockPluginsFetchList }));
jest.unstable_mockModule('@fnndsc/chili/commands/plugin/run.js', () => ({ plugin_execute: mockPluginExecute }));
jest.unstable_mockModule('@fnndsc/chili/commands/feeds/list.js', () => ({ feeds_fetchList: mockFeedsFetchList }));
jest.unstable_mockModule('@fnndsc/chili/commands/feed/create.js', () => ({ feed_create: mockFeedCreate }));
jest.unstable_mockModule('@fnndsc/chili/commands/files/list.js', () => ({ files_fetchList: mockFilesFetchList }));
jest.unstable_mockModule('@fnndsc/chili/commands/files/fields.js', () => ({ fileFields_fetch: mockFileFieldsFetch }));
jest.unstable_mockModule('@fnndsc/chili/commands/plugins/fields.js', () => ({ pluginFields_fetch: mockPluginFieldsFetch }));
jest.unstable_mockModule('@fnndsc/chili/commands/feeds/fields.js', () => ({ feedFields_fetch: mockFeedFieldsFetch }));
jest.unstable_mockModule('@fnndsc/chili/commands/pipeline/fields.js', () => ({ pipelineFields_fetch: mockPipelineFieldsFetch }));
jest.unstable_mockModule('@fnndsc/chili/commands/compute/fields.js', () => ({ computeFields_fetch: mockComputeFieldsFetch }));
jest.unstable_mockModule('../src/config/storeConfig.js', () => ({
  DEFAULT_STORE_URL: STORE_DEFAULT,
  storeUrl_get: (): string => mockStoreUrl ?? STORE_DEFAULT,
  storeUrl_isDefault: (): boolean => mockStoreUrl === undefined,
  storeUrl_set: (url: string): void => { mockStoreUrl = url; },
  storeUrl_clear: (): void => { mockStoreUrl = undefined; },
  storeConfig_persist: mockStorePersist,
}));
jest.unstable_mockModule('@fnndsc/chili/commands/tags/list.js', () => ({ tags_fetchList: jest.fn().mockResolvedValue({ tags: [], selectedFields: [] }) }));
jest.unstable_mockModule('@fnndsc/chili/commands/tags/fields.js', () => ({ tagFields_fetch: jest.fn().mockResolvedValue([]) }));
jest.unstable_mockModule('@fnndsc/chili/commands/groups/list.js', () => ({ groups_fetchList: jest.fn().mockResolvedValue({ groups: [], selectedFields: [] }) }));
jest.unstable_mockModule('@fnndsc/chili/commands/groups/fields.js', () => ({ groupFields_fetch: jest.fn().mockResolvedValue([]) }));
jest.unstable_mockModule('@fnndsc/chili/commands/groups/membership.js', () => ({
  groupMembers_fetch: jest.fn().mockResolvedValue({ ok: true, value: [] }),
  groupReference_resolve: jest.fn().mockResolvedValue({ ok: true, value: { id: 7, name: 'pacs_users' } }),
  groupUser_add: jest.fn().mockResolvedValue({ ok: false }),
  groupUser_remove: jest.fn().mockResolvedValue({ ok: false }),
}));
jest.unstable_mockModule('../src/core/elevation.js', () => ({
  authorizationFailure_is: jest.fn(() => false),
  sudoHint_build: jest.fn(() => ''),
}));
jest.unstable_mockModule('@fnndsc/chili/commands/pluginmetas/list.js', () => ({ pluginMetas_fetchList: jest.fn().mockResolvedValue({ pluginMetas: [], selectedFields: [] }) }));
jest.unstable_mockModule('@fnndsc/chili/commands/pluginmetas/fields.js', () => ({ pluginMetaFields_fetch: jest.fn().mockResolvedValue([]) }));
jest.unstable_mockModule('@fnndsc/chili/commands/plugininstances/list.js', () => ({ pluginInstances_fetchList: jest.fn().mockResolvedValue({ pluginInstances: [], selectedFields: [] }) }));
jest.unstable_mockModule('@fnndsc/chili/commands/plugininstances/fields.js', () => ({ pluginInstanceFields_fetch: jest.fn().mockResolvedValue([]) }));
jest.unstable_mockModule('@fnndsc/chili/commands/workflows/list.js', () => ({ workflows_fetchList: jest.fn().mockResolvedValue({ workflows: [], selectedFields: [] }) }));
jest.unstable_mockModule('@fnndsc/chili/commands/workflows/fields.js', () => ({ workflowFields_fetch: jest.fn().mockResolvedValue([]) }));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/mkdir.js', () => ({ files_mkdir: mockChefsMkdir }));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/touch.js', () => ({ files_touch: mockChefsTouch }));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/upload.js', () => ({ 
  files_upload: mockChefsUpload, 
  files_uploadWithProgress: mockChefsUpload,
  bytes_format: (n: number) => `${n} B`
}));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/cat.js', () => ({
  files_cat: mockChefsCat,
  files_catBinary: jest.fn()
}));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/rm.js', () => ({ files_rm: mockChefsRm, RmOptions: {}, RmResult: {} }));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/cp.js', () => ({ files_cp: jest.fn() }));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/mv.js', () => ({ files_mv: jest.fn() }));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/download.js', () => ({
  files_downloadWithProgress: mockChefsDownload,
  files_downloadManyWithProgress: mockChefsDownloadMany,
  bytes_format: (n: number) => `${n} B`,
}));

const DOWNLOAD_SUMMARY: DownloadSummary = {
  transferredCount: 1,
  failedCount: 0,
  transferSize: 1024,
  duration: 1,
  speed: 1024,
  totalFiles: 1,
  endTime: Date.now(),
  startTime: Date.now(),
};

mockChefsDownload.mockResolvedValue(DOWNLOAD_SUMMARY);
mockChefsDownloadMany.mockResolvedValue({
  ...DOWNLOAD_SUMMARY,
  totalFiles: 2,
  transferredCount: 2,
});

// Mock chili views
jest.unstable_mockModule('@fnndsc/chili/views/plugin.js', () => ({ pluginList_render: mockPluginListRender, pluginRun_render: mockPluginRunRender }));
jest.unstable_mockModule('@fnndsc/chili/views/feed.js', () => ({
  feedList_render: mockFeedListRender,
  feedCreate_render: mockFeedCreateRender,
  feedNote_render: jest.fn().mockReturnValue(''),
  feedComments_render: jest.fn().mockReturnValue(''),
}));
jest.unstable_mockModule('@fnndsc/chili/views/connect.js', () => ({ login_render: mockLoginRender, logout_render: mockLogoutRender }));
jest.unstable_mockModule('@fnndsc/chili/views/fs.js', () => ({
  mkdir_render: mockMkdirRender,
  touch_render: mockTouchRender,
  upload_render: mockUploadRender,
  cat_render: mockCatRender,
  rm_render: mockRmRender,
  cp_render: mockRmRender,
  mv_render: mockRmRender
}));

// Mock parametersofplugin
jest.unstable_mockModule('../src/builtins/parametersofplugin.js', () => ({
  builtin_parametersofplugin: jest.fn()
}));

// Mock chell
jest.unstable_mockModule('../src/chris/chiliDelegate.js', () => ({
  chiliCommand_run: mockChiliCommandRun
}));

// Mock console
const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

// Import module under test
const {
  path_resolve,
  builtin_cd,
  builtin_pwd,
  builtin_ls,
  builtin_upload,
  builtin_download,
  builtin_connect,
  builtin_logout,
  builtin_plugin,
  builtin_feed,
  builtin_files,
  builtin_links,
  builtin_dirs,
  builtin_cat,
  builtin_rm,
  builtin_context,
  builtin_tag,
  builtin_group,
  builtin_pluginmeta,
  builtin_plugininstance,
  builtin_workflow,
} = await import('../src/builtins/index.js');
// `~` is the session's home, read from the context this file mocks.
await (await import('./support/chrisPieces.js')).chrisPieces_install({ vfs: true, listingLook: true, home_get: async (): Promise<string> => { const { context_getSingle } = await import('@fnndsc/salsa'); const user: string | null = (await context_getSingle()).user; return user ? `/home/${user}` : '/'; } });

afterEach(() => {
  process.exitCode = 0;
});

describe('Builtins - Core Functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChefsDownload.mockResolvedValue(DOWNLOAD_SUMMARY);
    mockChefsDownloadMany.mockResolvedValue({
      ...DOWNLOAD_SUMMARY,
      totalFiles: 2,
      transferredCount: 2,
    });
    mockStringCheckHasWildcard.mockImplementation((value: string): boolean => /[*?[\]]/.test(value));
    mockWildcardExpand.mockResolvedValue(Ok([]));
    mockWildcardExpandMatches.mockResolvedValue(Ok([]));
    mockVfsDispatcherList.mockResolvedValue({ ok: true, value: [] });
    mockGetCWD.mockResolvedValue('/home/user');
    mockContextGetSingle.mockReturnValue({
      user: 'testuser',
      URL: 'http://localhost:8000',
      folder: '/home/user',
      feed: null,
      plugin: null
    });
  });

  describe('path_resolve()', () => {
    it('should resolve tilde to user home', async () => {
      mockContextGetSingle.mockReturnValue({ user: 'chris', folder: null, URL: null, feed: null, plugin: null });
      mockGetCWD.mockResolvedValue('/');

      const result = await path_resolve('~');
      expect(result).toBe('/home/chris');
    });

    it('should resolve relative path against CWD', async () => {
      mockGetCWD.mockResolvedValue('/home/user');

      const result = await path_resolve('data');
      expect(result).toBe('/home/user/data');
    });

    it('should resolve absolute path as-is', async () => {
      const result = await path_resolve('/tmp/test');
      expect(result).toBe('/tmp/test');
    });
  });

  describe('builtin_pwd()', () => {
    it('should report the current working directory in its envelope', async () => {
      mockGetCWD.mockResolvedValue('/home/user/data');

      const envelope: CommandEnvelope = await builtin_pwd();

      expect(envelope.status).toBe('ok');
      expect(envelope.rendered).toBe('/home/user/data\n');
    });
  });

  describe('builtin_cd()', () => {
    it('should change to home directory when no args', async () => {
      mockUserGet.mockResolvedValue('testuser');
      mockClientGet.mockResolvedValue({ getFileBrowserFolderByPath: mockGetFileBrowserFolderByPath });
      mockGetFileBrowserFolderByPath.mockResolvedValue({ path: '/resolved/path' });

      await builtin_cd([]);

      expect(mockSetCWD).toHaveBeenCalledWith('/home/testuser');
    });

    it('should change to virtual /bin directory', async () => {
      await builtin_cd(['/bin']);

      expect(mockSetCWD).toHaveBeenCalledWith('/bin');
    });

    it('returns to the previous interactive directory with cd -', async () => {
      mockPreviousCWDGet.mockReturnValue('/proc/jobs/feed_5/pl-root_10');
      mockVfsDispatcherList.mockResolvedValue({ ok: true, value: [] });

      const envelope: CommandEnvelope = await builtin_cd(['-']);

      expect(envelope.status).toBe('ok');
      expect(envelope.rendered).toContain('/proc/jobs/feed_5/pl-root_10');
      expect(mockDirectoryChange).toHaveBeenCalledWith('/proc/jobs/feed_5/pl-root_10');
    });

    it('reports a clear error when cd - has no previous directory', async () => {
      mockPreviousCWDGet.mockReturnValue(undefined);

      const envelope: CommandEnvelope = await builtin_cd(['-']);

      expect(envelope.status).toBe('error');
      expect(envelope.renderedErr).toContain('OLDPWD not set');
    });

    it('rejects a virtual file even when its provider can list the containing directory', async () => {
      // cd reads the parent through the listing façade (S3/S4), so the
      // containing listing is answered there.
      mockVfsListingGet.mockResolvedValueOnce({
        ok: true,
        value: {
          path: '/proc/jobs/feed_5',
          fresh: true,
          items: [
            { name: 'status', type: 'file', size: 0, owner: '', date: '' },
            { name: 'pl-dircopy_10', type: 'job', size: 0, owner: '', date: '' },
          ],
        },
      });

      const envelope: CommandEnvelope = await builtin_cd(['/proc/jobs/feed_5/status']);

      expect(envelope.status).toBe('error');
      expect(envelope.renderedErr).toContain('Not a directory');
      expect(mockSetCWD).not.toHaveBeenCalled();
    });

    it("follows a tag folder's feed link into /proc/jobs as the projection it is", async () => {
      mockVfsListingGet
        .mockResolvedValueOnce({ ok: true, value: { path: '/proc/tags/urgent', fresh: true, items: [{ name: 'feed_12', type: 'link', size: 0, owner: '', date: '', target: '/proc/jobs/feed_12' }] } })
        .mockResolvedValueOnce({ ok: true, value: { path: '/proc/jobs', fresh: true, items: [{ name: 'feed_12', type: 'job', size: 0, owner: '', date: '' }] } })
        .mockResolvedValueOnce({ ok: true, value: { path: '/proc/jobs/feed_12', fresh: true, items: [] } });
      const envelope: CommandEnvelope = await builtin_cd(['/proc/tags/urgent/feed_12']);
      expect(envelope.status).toBe('ok');
      expect(mockSetCWD).toHaveBeenCalledWith('/proc/jobs/feed_12');
    });

    it('resolves an unresolved virtual job data link only when cd follows it', async () => {
      mockVfsListingGet.mockResolvedValueOnce({
        ok: true,
        value: {
          path: '/proc/jobs/feed_5/pl-root_10',
          fresh: true,
          items: [{ name: 'data', type: 'link', size: 0, owner: '', date: '' }],
        },
      });
      mockVfsDispatcherLinkTargetResolve.mockResolvedValueOnce({
        ok: true,
        value: '/home/alice/outputs/result-set',
      });
      mockClientGet.mockResolvedValue({ getFileBrowserFolderByPath: mockGetFileBrowserFolderByPath });
      mockGetFileBrowserFolderByPath.mockResolvedValue({ path: '/resolved/path' });

      const envelope: CommandEnvelope = await builtin_cd(['/proc/jobs/feed_5/pl-root_10/data']);

      expect(envelope.status).toBe('ok');
      expect(mockVfsDispatcherLinkTargetResolve)
        .toHaveBeenCalledWith('/proc/jobs/feed_5/pl-root_10/data');
      expect(mockGetFileBrowserFolderByPath).toHaveBeenCalledWith('/resolved/path');
      expect(mockSetCWD).toHaveBeenCalledWith('/home/alice/outputs/result-set');
    });

    it('should change to valid ChRIS directory', async () => {
      mockClientGet.mockResolvedValue({ getFileBrowserFolderByPath: mockGetFileBrowserFolderByPath });
      mockGetFileBrowserFolderByPath.mockResolvedValue({ path: '/resolved/path' });

      await builtin_cd(['/home/user/data']);

      expect(mockSetCWD).toHaveBeenCalledWith('/home/user/data');
    });

    it('should error on non-existent directory', async () => {
      mockClientGet.mockResolvedValue({ getFileBrowserFolderByPath: mockGetFileBrowserFolderByPath });
      mockGetFileBrowserFolderByPath.mockResolvedValue(null);

      const envelope: CommandEnvelope = await builtin_cd(['/nonexistent']);

      expect(envelope.status).toBe('error');
      expect(envelope.renderedErr).toContain('No such file or directory');
      expect(mockSetCWD).not.toHaveBeenCalled();
    });

    it('should error on mismatched directory path (prevent substring matches)', async () => {
      mockClientGet.mockResolvedValue({ getFileBrowserFolderByPath: mockGetFileBrowserFolderByPath });
      mockGetFileBrowserFolderByPath.mockResolvedValue({ path: '/SHARED/entry' });

      const envelope: CommandEnvelope = await builtin_cd(['/ent']);

      expect(envelope.status).toBe('error');
      expect(envelope.renderedErr).toContain('No such file or directory');
      expect(mockSetCWD).not.toHaveBeenCalled();
    });

    it('should error when not connected', async () => {
      mockClientGet.mockResolvedValue(null);

      const envelope: CommandEnvelope = await builtin_cd(['/home/user']);

      expect(envelope.status).toBe('error');
      expect(envelope.renderedErr).toContain('Not connected');
    });
  });

  describe('builtin_ls()', () => {
    it('carries the fs.listing model with per-target entries', async () => {
      mockVfsDataGet.mockResolvedValueOnce({ ok: true, value: [{ name: 'a.txt', type: 'file', size: 1, owner: 'u', date: '' }] });
      const envelope = await builtin_ls(['/data']);
      expect(envelope.model?.kind).toBe('fs.listing');
      const listings = envelope.model?.data as Array<{ path: string; items: Array<{ name: string }> }>;
      expect(listings[0].path).toBe('/data');
      expect(listings[0].items[0].name).toBe('a.txt');
    });

    it('omits failed targets from the model and reports error status', async () => {
      mockVfsList.mockReturnValueOnce({ status: 'error', rendered: '', renderedErr: 'ls: nope\n' });
      const envelope = await builtin_ls(['/missing']);
      expect(envelope.status).toBe('error');
      expect((envelope.model?.data as unknown[]).length).toBe(0);
      expect(mockVfsDataGet).not.toHaveBeenCalled();
    });

    it('should list current directory when no args', async () => {
      await builtin_ls([]);

      expect(mockVfsList).toHaveBeenCalledWith(undefined, { long: false, human: false, sort: 'name', reverse: false, directory: false, oneColumn: false }, expect.anything());
    });

    it('should list specified path', async () => {
      mockGetCWD.mockResolvedValue('/home/user');

      await builtin_ls(['/tmp']);

      expect(mockVfsList).toHaveBeenCalledWith('/tmp', { long: false, human: false, sort: 'name', reverse: false, directory: false, oneColumn: false }, expect.anything());
    });

    it('should handle -l flag for long format', async () => {
      await builtin_ls(['-l']);

      expect(mockVfsList).toHaveBeenCalledWith(undefined, { long: true, human: false, sort: 'name', reverse: false, directory: false, oneColumn: false }, expect.anything());
    });

    it('should handle -h flag for human-readable sizes', async () => {
      await builtin_ls(['-l', '-h']);

      expect(mockVfsList).toHaveBeenCalledWith(undefined, { long: true, human: true, sort: 'name', reverse: false, directory: false, oneColumn: false }, expect.anything());
    });

    it('should list multiple operands independently', async () => {
      await builtin_ls(['file1.txt', 'file2.txt']);

      expect(mockVfsList).toHaveBeenNthCalledWith(1, '/home/user/file1.txt', { long: false, human: false, sort: 'name', reverse: false, directory: false, oneColumn: false }, expect.anything());
      expect(mockVfsList).toHaveBeenNthCalledWith(2, '/home/user/file2.txt', { long: false, human: false, sort: 'name', reverse: false, directory: false, oneColumn: false }, expect.anything());
    });

    it('should handle --sort flag with size option', async () => {
      await builtin_ls(['--sort', 'size']);

      expect(mockVfsList).toHaveBeenCalledWith(undefined, { long: false, human: false, sort: 'size', reverse: false, directory: false, oneColumn: false }, expect.anything());
    });

    it('should handle --sort flag with date option', async () => {
      await builtin_ls(['--sort', 'date']);

      expect(mockVfsList).toHaveBeenCalledWith(undefined, { long: false, human: false, sort: 'date', reverse: false, directory: false, oneColumn: false }, expect.anything());
    });

    it('should handle --sort flag with owner option', async () => {
      await builtin_ls(['--sort', 'owner']);

      expect(mockVfsList).toHaveBeenCalledWith(undefined, { long: false, human: false, sort: 'owner', reverse: false, directory: false, oneColumn: false }, expect.anything());
    });

    it('should handle --reverse flag', async () => {
      await builtin_ls(['--reverse']);

      expect(mockVfsList).toHaveBeenCalledWith(undefined, { long: false, human: false, sort: 'name', reverse: true, directory: false, oneColumn: false }, expect.anything());
    });

    it('should handle -r flag for reverse', async () => {
      await builtin_ls(['-r']);

      expect(mockVfsList).toHaveBeenCalledWith(undefined, { long: false, human: false, sort: 'name', reverse: true, directory: false, oneColumn: false }, expect.anything());
    });

    it('should handle combined --sort and --reverse flags', async () => {
      await builtin_ls(['--sort', 'size', '--reverse']);

      expect(mockVfsList).toHaveBeenCalledWith(undefined, { long: false, human: false, sort: 'size', reverse: true, directory: false, oneColumn: false }, expect.anything());
    });

    it('takes the path after a switch as a path, never as the switch\'s value', async () => {
      await builtin_ls(['--refresh', '/tmp']);
      expect(mockVfsList).toHaveBeenCalledWith('/tmp', { long: false, human: false, sort: 'name', reverse: false, directory: false, oneColumn: false }, expect.anything());
      mockVfsList.mockClear();
      await builtin_ls(['-l', '--reverse', '/tmp']);
      expect(mockVfsList).toHaveBeenCalledWith('/tmp', { long: true, human: false, sort: 'name', reverse: true, directory: false, oneColumn: false }, expect.anything());
    });

    it('refuses an option it does not have by name, listing nothing', async () => {
      const recursive = await builtin_ls(['-R', '/tmp']);
      expect(recursive.status).toBe('error');
      expect(recursive.renderedErr).toContain("ls: invalid option -- 'R'");
      const long = await builtin_ls(['--color', '/tmp']);
      expect(long.renderedErr).toContain("ls: unrecognized option '--color'");
      const sort = await builtin_ls(['--sort', 'colour']);
      expect(sort.renderedErr).toContain("ls: invalid argument 'colour' for '--sort'");
      expect(mockVfsList).not.toHaveBeenCalled();
    });

    it('takes -a, since nothing in a listing is hidden', async () => {
      await builtin_ls(['-la', '/tmp']);
      expect(mockVfsList).toHaveBeenCalledWith('/tmp', { long: true, human: false, sort: 'name', reverse: false, directory: false, oneColumn: false }, expect.anything());
    });

    it('should handle combined -l, --sort, and --reverse flags', async () => {
      await builtin_ls(['-l', '--sort', 'date', '--reverse']);

      expect(mockVfsList).toHaveBeenCalledWith(undefined, { long: true, human: false, sort: 'date', reverse: true, directory: false, oneColumn: false }, expect.anything());
    });
  });

  describe('builtin_upload()', () => {
    // `upload` reads the local path in the ENGINE's process, so it runs only
    // where the engine's disk is the operator's — a local shell, or a daemon
    // started with --host-control=files. These cases install such a surface.
    beforeEach(async () => {
      const { surface_set, HeadlessSurface } = await import('../src/core/surface.js');
      const surface = new HeadlessSurface() as unknown as { capabilities: { engineFilesystem: boolean } };
      surface.capabilities = { ...surface.capabilities, engineFilesystem: true };
      surface_set(surface as never);
    });

    it('refuses under a daemon whose disk is nobody\'s, naming the flag', async () => {
      const { surface_set, HeadlessSurface } = await import('../src/core/surface.js');
      const surface = new HeadlessSurface() as unknown as { capabilities: { engineFilesystem: boolean } };
      surface.capabilities = { ...surface.capabilities, engineFilesystem: false };
      surface_set(surface as never);
      const envelope = await builtin_upload(['./local.txt', 'remote.txt']);
      expect(envelope.status).toBe('error');
      expect(envelope.renderedErr).toContain('--host-control=files');
      expect(mockChefsUpload).not.toHaveBeenCalled();
    });

    it('should upload file to remote path', async () => {
      mockGetCWD.mockResolvedValue('/home/user');
      mockChefsUpload.mockResolvedValue({
        startTime: 0,
        endTime: 1,
        totalFiles: 1,
        transferredCount: 1,
        failedCount: 0,
        transferSize: 1024,
        duration: 1,
        speed: 1024,
        actualTargetPath: '/home/user/remote.txt',
      });

      const envelope = await builtin_upload(['./local.txt', 'remote.txt']);

      expect(mockChefsUpload).toHaveBeenCalledWith('./local.txt', '/home/user/remote.txt', expect.objectContaining({
        expandLocalGlob: false,
        confirm: expect.any(Function),
        onNotice: expect.any(Function),
        onProgress: expect.any(Function),
      }));
      expect(envelope.rendered).toContain('Successfully uploaded 1 file');
    });

    it('should error with insufficient args', async () => {
      const envelope = await builtin_upload(['local.txt']);

      expect(envelope.rendered).toContain('Usage:');
    });

    it('should handle upload errors', async () => {
      mockChefsUpload.mockRejectedValue(new Error('Network error'));

      const envelope = await builtin_upload(['local.txt', 'remote.txt']);

      expect(envelope.renderedErr).toContain('Upload error: Network error');
    });
  });

  describe('builtin_download()', () => {
    // `download` writes to the engine's disk only when the operator is sitting
    // at it. These cases exercise that path, so they install a surface that
    // says so; the delivery path is covered separately below.
    const localSurface = async (): Promise<void> => {
      const { surface_set, HeadlessSurface } = await import('../src/core/surface.js');
      const surface = new HeadlessSurface() as unknown as {
        capabilities: { engineFilesystem: boolean; fileDelivery: boolean };
      };
      surface.capabilities = { ...surface.capabilities, engineFilesystem: true };
      surface_set(surface as never);
    };

    /**
     * Installs a surface for which the engine's disk is not its operator's.
     * `hasDisk` distinguishes a remote shell, which owns a filesystem and
     * should receive a folder as a folder, from a browser, which does not.
     */
    const deliveringSurface = async (
      deliver: (request: { path: string; filename: string; destination?: string }) => Promise<{ location: string; bytes: number }>,
      canDeliver = true,
      hasDisk = false,
    ): Promise<void> => {
      const { surface_set } = await import('../src/core/surface.js');
      surface_set({
        capabilities: {
          hiddenInput: false, localEdit: false, tty: false, pipeSegments: false,
          shellCommands: false, fileDelivery: canDeliver, engineFilesystem: false,
          localFilesystem: hasDisk,
        },
        prompt: async (): Promise<string> => '',
        pipeSegment: async (): Promise<Buffer> => Buffer.from(''),
        shellCommand: async (): Promise<number> => 0,
        localEdit: async (): Promise<{ content: string; changed: boolean }> => ({ content: '', changed: false }),
        fileDeliver: deliver,
      } as never);
    };

    it('should show usage with insufficient args', async () => {
      const envelope = await builtin_download(['remote.txt']);

      expect(envelope.rendered).toContain('Usage: download');
    });

    it('should invoke chili download helper', async () => {
      const downloadModule = await import('@fnndsc/chili/commands/fs/download.js');
      await localSurface();

      await builtin_download(['/remote/file.txt', './local.txt']);

      expect(mockChefsDownload).toHaveBeenCalledWith('/remote/file.txt', expect.stringContaining('local.txt'), expect.objectContaining({
        force: false,
        confirm: expect.any(Function),
        onNotice: expect.any(Function),
        onProgress: expect.any(Function),
      }));
    });

    it('hands the file to the surface when the engine disk is not the operator\'s', async () => {
      const deliver = jest.fn(async (request: { path: string; filename: string }) => ({
        location: `/downloads/${request.filename}`, bytes: 4096,
      }));
      await deliveringSurface(deliver as never);

      const envelope = await builtin_download(['/remote/scan.dcm', '/downloads']);

      // The request travels; the bytes do not. A daemon writing to its own
      // host would put the file on a machine nobody is sitting at.
      expect(mockChefsDownload).not.toHaveBeenCalled();
      expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
        path: '/remote/scan.dcm', filename: 'scan.dcm', destination: '/downloads',
      }));
      expect(envelope.status).toBe('ok');
      expect(envelope.rendered).toContain('/downloads/scan.dcm');
    });

    it('delivers each source when several are named', async () => {
      const deliver = jest.fn(async (request: { filename: string }) => ({
        location: `/d/${request.filename}`, bytes: 1,
      }));
      await deliveringSurface(deliver as never);

      await builtin_download(['/remote/one.txt', '/remote/two.txt', '/d']);

      expect(deliver).toHaveBeenCalledTimes(2);
    });

    it('refuses rather than writing to the engine host when the surface cannot receive', async () => {
      await deliveringSurface(async () => ({ location: '', bytes: 0 }), false);

      const envelope = await builtin_download(['/remote/scan.dcm', '/downloads']);

      expect(mockChefsDownload).not.toHaveBeenCalled();
      expect(envelope.status).toBe('error');
      expect(envelope.renderedErr).toContain('cannot receive a file');
    });

    it('reports a failed delivery without claiming success', async () => {
      const deliver = jest.fn(async (): Promise<{ location: string; bytes: number }> => {
        throw new Error('the browser refused it');
      });
      await deliveringSurface(deliver as never);

      const envelope = await builtin_download(['/remote/scan.dcm', '/downloads']);

      expect(envelope.status).toBe('error');
      expect(envelope.rendered).toContain('the browser refused it');
    });

    it('delivers a directory file by file to a surface that has its own disk', async () => {
      const deliver = jest.fn(async (request: { filename: string }) => ({
        location: `/scans/${request.filename}`, bytes: 10,
      }));
      await deliveringSurface(deliver as never, true, true);
      isDirectoryMock.mockResolvedValueOnce(true);
      listRecursiveMock.mockResolvedValueOnce([
        { path: '/remote/series/a.dcm', type: 'file', size: 10 },
        { path: '/remote/series/sub', type: 'dir' },
        { path: '/remote/series/sub/b.dcm', type: 'file', size: 10 },
      ]);

      const envelope = await builtin_download(['/remote/series', '/scans']);

      // A shell asked for a folder and gets a folder. Archiving it would also
      // create a feed, which is a heavy side effect for a case that is fine.
      expect(archiveMock).not.toHaveBeenCalled();
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ filename: 'sub/b.dcm' }));
      expect(envelope.status).toBe('ok');
    });

    it('archives a directory into one file for a surface with no disk', async () => {
      const deliver = jest.fn(async (request: { filename: string }) => ({
        location: `/downloads/${request.filename}`, bytes: 90210,
      }));
      await deliveringSurface(deliver as never);
      isDirectoryMock.mockResolvedValueOnce(true);
      archiveMock.mockResolvedValueOnce({
        path: '/home/me/feeds/feed_9/pl-dircopy_1/pl-pfdorun_2/data/series.zip',
        filename: 'series.zip',
        size: 90210,
      });

      const envelope = await builtin_download(['/remote/series', '/downloads']);

      // A browser cannot receive several hundred DICOM instances as several
      // hundred saves, so the directory becomes one CUBE file first.
      expect(archiveMock).toHaveBeenCalledWith('/remote/series');
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
        path: '/home/me/feeds/feed_9/pl-dircopy_1/pl-pfdorun_2/data/series.zip',
        filename: 'series.zip',
        size: 90210,
      }));
      expect(envelope.status).toBe('ok');
    });

    it('reports why an archive failed rather than attempting the delivery', async () => {
      const deliver = jest.fn(async () => ({ location: '', bytes: 0 }));
      await deliveringSurface(deliver as never);
      isDirectoryMock.mockResolvedValueOnce(true);
      archiveMock.mockResolvedValueOnce(null);

      const envelope = await builtin_download(['/remote/series', '/downloads']);

      // Fetching the bytes of a directory would 404 and teach nobody anything.
      expect(deliver).not.toHaveBeenCalled();
      expect(envelope.status).toBe('error');
      expect(envelope.renderedErr).toContain('could not archive');
    });

    it('uses aggregate transfer for sources expanded by the shell', async () => {
      const args: ShellArguments = ['/remote/one.txt', '/remote/two.txt', './downloads'];
      args.pathnameExpanded = [true, true, false];
      await localSurface();

      await builtin_download(args);

      expect(mockChefsDownloadMany).toHaveBeenCalledWith(
        ['/remote/one.txt', '/remote/two.txt'],
        expect.stringContaining('downloads'),
        expect.objectContaining({ force: false, onProgress: expect.any(Function) }),
      );
    });
  });

  describe('builtin_connect()', () => {
    it('should connect with valid credentials', async () => {
      mockConnectLogin.mockResolvedValue(true);
      mockLoginRender.mockReturnValue('Connected successfully');

      const envelope = await builtin_connect(['--user', 'chris', '--password', 'chris1234', 'http://localhost:8000']);

      expect(mockConnectLogin).toHaveBeenCalledWith({
        user: 'chris',
        password: 'chris1234',
        url: 'http://localhost:8000',
        debug: false
      });
      expect(envelope.rendered).toContain('Connected successfully');
    });

    it('should error with missing credentials', async () => {
      const envelope = await builtin_connect(['http://localhost:8000']);

      expect(envelope.rendered).toContain('Usage:');
    });

    it('should handle connection errors', async () => {
      mockConnectLogin.mockRejectedValue(new Error('Auth failed'));
      mockLoginRender.mockReturnValue('Connection failed');

      const envelope = await builtin_connect(['--user', 'chris', '--password', 'wrong', 'http://localhost:8000']);

      expect(envelope.renderedErr).toContain('Auth failed');
    });
  });

  describe('builtin_logout()', () => {
    it('should logout successfully', async () => {
      mockConnectLogout.mockResolvedValue(undefined);
      mockLogoutRender.mockReturnValue('Logged out');

      const envelope = await builtin_logout();

      expect(mockConnectLogout).toHaveBeenCalled();
      expect(envelope.rendered).toContain('Logged out');
    });

    it('should handle logout errors', async () => {
      mockConnectLogout.mockRejectedValue(new Error('Logout failed'));
      mockLogoutRender.mockReturnValue('Logout failed');

      const envelope = await builtin_logout();

      expect(envelope.renderedErr).toContain('Logout failed');
    });
  });

  describe('builtin_plugin()', () => {
    it('should list plugins', async () => {
      mockPluginsFetchList.mockResolvedValue({ plugins: [], selectedFields: [] });
      mockPluginListRender.mockReturnValue('Plugin list');

      const envelope = await builtin_plugin(['list']);

      expect(mockPluginsFetchList).toHaveBeenCalled();
      expect(envelope.rendered).toContain('Plugin list');
    });

    it('should refuse the retired run', async () => {
      const envelope = await builtin_plugin(['run', 'pl-dircopy', '--arg', 'value']);

      expect(mockPluginExecute).not.toHaveBeenCalled();
      expect(envelope.renderedErr).toContain('plugin run is retired');
    });

    it('should return an error envelope for unknown subcommands', async () => {
      const envelope = await builtin_plugin(['delete', 'id:123']);

      expect(mockChiliCommandRun).not.toHaveBeenCalled();
      expect(envelope.renderedErr).toContain('Unknown subcommand');
    });

    it('should error with no subcommand', async () => {
      const envelope = await builtin_plugin([]);

      expect(envelope.rendered).toContain('Usage:');
    });
  });

  describe('builtin_feed()', () => {
    it('should list feeds', async () => {
      mockFeedsFetchList.mockResolvedValue({ feeds: [], selectedFields: [] });
      mockFeedListRender.mockReturnValue('Feed list');

      const envelope = await builtin_feed(['list']);

      expect(mockFeedsFetchList).toHaveBeenCalled();
      expect(envelope.rendered).toContain('Feed list');
    });

    it('should create a feed', async () => {
      mockFeedCreate.mockResolvedValue({ id: 456, name: 'Test Feed' });
      mockFeedCreateRender.mockReturnValue('Feed created');

      const envelope = await builtin_feed(['create', '--dirs', '/data']);

      expect(mockFeedCreate).toHaveBeenCalled();
      expect(envelope.rendered).toContain('Feed created');
    });

    it('should return an error envelope for unknown subcommands', async () => {
      const envelope = await builtin_feed(['delete', 'id:456']);

      expect(mockChiliCommandRun).not.toHaveBeenCalled();
      expect(envelope.renderedErr).toContain('Unknown subcommand');
    });
  });

  describe('builtin_files(), builtin_links(), builtin_dirs()', () => {
    it('should list files', async () => {
      mockFilesFetchList.mockResolvedValue({ tableData: [{ fname: 'test.txt' }], selectedFields: ['fname'] });

      await builtin_files(['list']);

      expect(mockFilesFetchList).toHaveBeenCalledWith(expect.anything(), 'files', undefined);
      expect(mockTableRender).toHaveBeenCalled();
    });

    it('should list fields for files', async () => {
      mockFileFieldsFetch.mockResolvedValue(['fname', 'fsize']);

      await builtin_files(['fieldslist']);

      expect(mockFileFieldsFetch).toHaveBeenCalledWith('files');
      expect(mockTableRender).toHaveBeenCalled();
    });

    it('should list links', async () => {
      mockFilesFetchList.mockResolvedValue({ tableData: [], selectedFields: [] });

      await builtin_links(['list']);

      expect(mockFilesFetchList).toHaveBeenCalledWith(expect.anything(), 'links', undefined);
    });

    it('should list dirs', async () => {
      mockFilesFetchList.mockResolvedValue({ tableData: [], selectedFields: [] });

      await builtin_dirs(['list']);

      expect(mockFilesFetchList).toHaveBeenCalledWith(expect.anything(), 'dirs', undefined);
    });

    it('should handle null results', async () => {
      mockFilesFetchList.mockResolvedValue(null);

      const envelope = await builtin_files(['list']);

      expect(envelope.renderedErr).toContain('No files resources found');
    });
  });

  describe('builtin_cat()', () => {
    it('should display file content', async () => {
      mockChefsCat.mockResolvedValue(Ok('file content here'));

      const envelope: CommandEnvelope = await builtin_cat(['/home/user/test.txt']);

      expect(mockChefsCat).toHaveBeenCalledWith('/home/user/test.txt');
      expect(envelope.rendered).toContain('file content here');
      expect(envelope.model?.kind).toBe('fs.cat');
    });

    it('should error without file argument', async () => {
      const envelope: CommandEnvelope = await builtin_cat([]);

      expect(envelope.status).toBe('error');
      expect(envelope.renderedErr).toContain('Usage:');
    });

    it('should error on /bin files', async () => {
      mockChefsCat.mockResolvedValueOnce(Err(new Error('Cannot cat plugins')));
      errorStack.stack_pop.mockReturnValueOnce({ type: 'error', message: 'Cannot cat plugins yet: pl-dircopy' });

      const envelope: CommandEnvelope = await builtin_cat(['/bin/pl-dircopy']);

      expect(envelope.status).toBe('error');
      expect(envelope.renderedErr).toContain('Cannot cat plugins');
    });

    it('should handle cat errors', async () => {
      mockChefsCat.mockResolvedValue(Err(new Error('File not found')));
      errorStack.stack_pop.mockReturnValueOnce({ type: 'error', message: 'File not found' });

      const envelope: CommandEnvelope = await builtin_cat(['/tmp/missing.txt']);

      expect(envelope.status).toBe('error');
      expect(envelope.renderedErr).toContain('File not found');
    });
  });

  describe('builtin_context()', () => {
    it('should display current context', async () => {
      mockContextGetSingle.mockReturnValue({
        user: 'chris',
        URL: 'http://localhost:8000',
        folder: '/home/chris',
        feed: '123',
        plugin: 'pl-dircopy'
      });

      await builtin_context([]);

      expect(mockTableRender).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ Context: 'ChRIS User', Value: 'chris' }),
          expect.objectContaining({ Context: 'ChRIS URL', Value: 'http://localhost:8000' })
        ]),
        ['Context', 'Value'],
        expect.anything()
      );
    });
  });
});

describe('Builtins - Subcommand dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStoreUrl = undefined;
  });

  describe('builtin_plugin', () => {
    it('inspect calls pluginFields_fetch', async () => {
      await builtin_plugin(['inspect']);
      expect(mockPluginFieldsFetch).toHaveBeenCalled();
    });

    it('inspect does not fall through to chili', async () => {
      await builtin_plugin(['inspect']);
      expect(mockChiliCommandRun).not.toHaveBeenCalled();
    });

    it('search delegates to list with --search', async () => {
      await builtin_plugin(['search', 'dircopy']);
      expect(mockPluginsFetchList).toHaveBeenCalled();
      expect(mockChiliCommandRun).not.toHaveBeenCalled();
    });
  });

  describe('builtin_feed', () => {
    it('inspect calls feedFields_fetch', async () => {
      await builtin_feed(['inspect']);
      expect(mockFeedFieldsFetch).toHaveBeenCalled();
    });

    it('inspect does not fall through to chili', async () => {
      await builtin_feed(['inspect']);
      expect(mockChiliCommandRun).not.toHaveBeenCalled();
    });

    it('search delegates to list with --search', async () => {
      await builtin_feed(['search', 'brain']);
      expect(mockFeedsFetchList).toHaveBeenCalled();
      expect(mockChiliCommandRun).not.toHaveBeenCalled();
    });
  });

  describe('builtin_files/links/dirs', () => {
    it('files inspect calls fileFields_fetch', async () => {
      await builtin_files(['inspect']);
      expect(mockFileFieldsFetch).toHaveBeenCalled();
    });

    it('files inspect does not fall through to chili', async () => {
      await builtin_files(['inspect']);
      expect(mockChiliCommandRun).not.toHaveBeenCalled();
    });

    it('links inspect calls fileFields_fetch', async () => {
      await builtin_links(['inspect']);
      expect(mockFileFieldsFetch).toHaveBeenCalled();
    });

    it('dirs inspect calls fileFields_fetch', async () => {
      await builtin_dirs(['inspect']);
      expect(mockFileFieldsFetch).toHaveBeenCalled();
    });
  });

  describe('store subcommands', () => {
    it('inspect renders the store URL without chili', async () => {
      const envelope = await (await import('../src/builtins/store.js')).builtin_store(['inspect']);
      expect(envelope.rendered).toContain('Peer store URL');
      expect(mockChiliCommandRun).not.toHaveBeenCalled();
    });

    it('set saves the store URL through the engine store config', async () => {
      await (await import('../src/builtins/store.js')).builtin_store(['set', 'https://my-store.org/api/v1/']);
      expect(mockStoreUrl).toBe('https://my-store.org/api/v1/');
      expect(mockStorePersist).toHaveBeenCalled();
    });

    it('reset clears the store URL through the engine store config', async () => {
      mockStoreUrl = 'https://custom.org/api/v1/';
      await (await import('../src/builtins/store.js')).builtin_store(['reset']);
      expect(mockStoreUrl).toBeUndefined();
      expect(mockStorePersist).toHaveBeenCalled();
    });
  });
});
