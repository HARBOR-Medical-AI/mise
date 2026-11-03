/**
 * @file `download`: a `/proc/jobs/.../data` source resolves through the job's data link to the run's CFS output,
 * as `ls` and `cd` enter it (#1364); any other source is the path as resolved.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

const mockDownloadOne = jest.fn(async () => ({ totalFiles: 1, transferredCount: 1, failedCount: 0, transferSize: 3, duration: 0.1, speed: 30, startTime: 0, endTime: 0 }));
const mockDownloadMany = jest.fn(async () => ({ totalFiles: 2, transferredCount: 2, failedCount: 0, transferSize: 6, duration: 0.1, speed: 60, startTime: 0, endTime: 0 }));
const mockLinkTarget = jest.fn(async (link: string) => ({ ok: true, value: `/home/chris/feeds/feed_5775/pl-dircopy_814897/pl-ffmpeg_814898/${link.endsWith('pl-whisper_814899/data') ? 'pl-whisper_814899/' : ''}data` }));

jest.unstable_mockModule('@fnndsc/chili/commands/fs/download.js', () => ({
  files_downloadWithProgress: mockDownloadOne,
  files_downloadManyWithProgress: mockDownloadMany,
  bytes_format: (bytes: number): string => `${bytes} B`,
}));
jest.unstable_mockModule('../src/core/filesystem.js', () => ({ vfsDispatcher_get: () => ({ linkTarget_resolve: mockLinkTarget }) }));
jest.unstable_mockModule('../src/builtins/utils.js', () => ({ path_resolve: async (input: string): Promise<string> => (input.startsWith('/') ? input : `/home/chris/${input}`) }));
jest.unstable_mockModule('../src/lib/parser.js', () => ({ shellArguments_pathnameExpanded: (): boolean => false }));
jest.unstable_mockModule('../src/core/surface.js', () => ({ surface_get: () => ({ capabilities: { engineFilesystem: true, localFilesystem: true, fileDelivery: false } }) }));
jest.unstable_mockModule('../src/core/sink.js', () => ({ sink_get: () => ({ status_write: jest.fn(), err_write: jest.fn(), progress_write: jest.fn() }) }));
jest.unstable_mockModule('../src/core/question.js', () => ({ repl_confirm: async (): Promise<boolean> => true }));
jest.unstable_mockModule('@fnndsc/salsa', () => ({ files_path_isDirectory: async (): Promise<boolean> => false, files_listRecursive: async () => [] }));
jest.unstable_mockModule('../src/builtins/fs/archive.js', () => ({ directory_archive: async () => null }));
cuminMock_install(() => ({
  envelope_ok: (rendered: string) => ({ status: 'ok', rendered }),
  envelope_error: (rendered: string, _errors?: unknown, renderedErr?: string) => ({ status: 'error', rendered, renderedErr }),
  errorStack: { stack_pop: () => undefined, stack_getAll: () => [] },
}));

const { builtin_download } = await import('../src/builtins/fs/download.js');

beforeEach(() => { jest.clearAllMocks(); process.exitCode = 0; });

describe('download', () => {
  it('resolves a /proc/jobs data path through the job\'s link to the run\'s output (#1364)', async () => {
    const result = await builtin_download(['/proc/jobs/feed_5775/pl-whisper_814899/data', '/tmp/dl/']);
    expect(result.status).toBe('ok');
    expect(mockLinkTarget).toHaveBeenCalledWith('/proc/jobs/feed_5775/pl-whisper_814899/data');
    expect(mockDownloadOne).toHaveBeenCalledWith('/home/chris/feeds/feed_5775/pl-dircopy_814897/pl-ffmpeg_814898/pl-whisper_814899/data', expect.any(String), expect.any(Object));
  });

  it('keeps what follows the link, and leaves a CFS path as it is', async () => {
    await builtin_download(['/proc/jobs/feed_5775/pl-ffmpeg_814898/data/weekly.wav', '/tmp/dl/']);
    expect(mockLinkTarget).toHaveBeenLastCalledWith('/proc/jobs/feed_5775/pl-ffmpeg_814898/data');
    expect(mockDownloadOne).toHaveBeenLastCalledWith('/home/chris/feeds/feed_5775/pl-dircopy_814897/pl-ffmpeg_814898/data/weekly.wav', expect.any(String), expect.any(Object));
    mockLinkTarget.mockClear();
    await builtin_download(['/home/chris/uploads/a.wav', '/tmp/dl/']);
    expect(mockLinkTarget).not.toHaveBeenCalled();
    expect(mockDownloadOne).toHaveBeenLastCalledWith('/home/chris/uploads/a.wav', expect.any(String), expect.any(Object));
  });

  it('sends two typed sources together into one directory, each resolved', async () => {
    await builtin_download(['/proc/jobs/feed_5775/pl-whisper_814899/data', '/proc/jobs/feed_5775/pl-ffmpeg_814898/data', '/tmp/dl/']);
    expect(mockDownloadMany).toHaveBeenCalledWith([
      '/home/chris/feeds/feed_5775/pl-dircopy_814897/pl-ffmpeg_814898/pl-whisper_814899/data',
      '/home/chris/feeds/feed_5775/pl-dircopy_814897/pl-ffmpeg_814898/data',
    ], expect.any(String), expect.any(Object));
  });
});
