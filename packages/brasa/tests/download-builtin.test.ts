/**
 * @file `download`: a source is read where the store keeps it, resolved as every reader resolves a path
 * (`storePath_resolve`: a `/proc/jobs/.../data` source through the job's data link to the run's output, #1364;
 * the store's links on the way); the transfer is handed that path.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { cuminMock_install } from './support/cuminMock.js';

const mockDownloadOne = jest.fn(async () => ({ totalFiles: 1, transferredCount: 1, failedCount: 0, transferSize: 3, duration: 0.1, speed: 30, startTime: 0, endTime: 0, failedPaths: [], cancelledCount: 0 }));
const mockDownloadMany = jest.fn(async () => ({ totalFiles: 2, transferredCount: 2, failedCount: 0, transferSize: 6, duration: 0.1, speed: 60, startTime: 0, endTime: 0, failedPaths: [], cancelledCount: 0 }));
// The session's one resolver, its own rules pinned in storePath.test.ts: here, a node's data is its feed output.
const OUTPUTS: Record<string, string> = {
  '/proc/jobs/feed_5775/pl-whisper_814899/data': '/home/chris/feeds/feed_5775/pl-dircopy_814897/pl-ffmpeg_814898/pl-whisper_814899/data',
  '/proc/jobs/feed_5775/pl-ffmpeg_814898/data': '/home/chris/feeds/feed_5775/pl-dircopy_814897/pl-ffmpeg_814898/data',
};
const mockStorePath = jest.fn(async (input: string): Promise<string> => {
  const at: string = input.startsWith('/') ? input : `/home/chris/${input}`;
  const link: string | undefined = Object.keys(OUTPUTS).find((data: string): boolean => at === data || at.startsWith(`${data}/`));
  return link === undefined ? at : `${OUTPUTS[link]}${at.slice(link.length)}`;
});

jest.unstable_mockModule('@fnndsc/chili/commands/fs/download.js', () => ({
  files_downloadWithProgress: mockDownloadOne,
  files_downloadManyWithProgress: mockDownloadMany,
  bytes_format: (bytes: number): string => `${bytes} B`,
}));
jest.unstable_mockModule('../src/builtins/utils.js', () => ({ storePath_resolve: mockStorePath }));
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
const { variable_set, variable_unset, textAnswer_make } = await import('../src/core/variables.js');
const { commandCancellation_run } = await import('../src/core/cancellation.js');

beforeEach(() => { jest.clearAllMocks(); process.exitCode = 0; });

describe('download', () => {
  it('resolves a /proc/jobs data path through the job\'s link to the run\'s output (#1364)', async () => {
    const result = await builtin_download(['/proc/jobs/feed_5775/pl-whisper_814899/data', '/tmp/dl/']);
    expect(result.status).toBe('ok');
    expect(mockStorePath).toHaveBeenCalledWith('/proc/jobs/feed_5775/pl-whisper_814899/data');
    expect(mockDownloadOne).toHaveBeenCalledWith('/home/chris/feeds/feed_5775/pl-dircopy_814897/pl-ffmpeg_814898/pl-whisper_814899/data', expect.any(String), expect.any(Object));
  });

  it('keeps what follows the link, and leaves a CFS path as it is', async () => {
    await builtin_download(['/proc/jobs/feed_5775/pl-ffmpeg_814898/data/weekly.wav', '/tmp/dl/']);
    expect(mockStorePath).toHaveBeenLastCalledWith('/proc/jobs/feed_5775/pl-ffmpeg_814898/data/weekly.wav');
    expect(mockDownloadOne).toHaveBeenLastCalledWith('/home/chris/feeds/feed_5775/pl-dircopy_814897/pl-ffmpeg_814898/data/weekly.wav', expect.any(String), expect.any(Object));
    await builtin_download(['/home/chris/uploads/a.wav', '/tmp/dl/']);
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

describe('download: files at once', () => {
  /** The options the last transfer was handed. */
  const optionsGiven = (): { jobs?: number; signal?: AbortSignal } =>
    (mockDownloadOne.mock.calls.at(-1) as unknown as [string, string, { jobs?: number; signal?: AbortSignal }])[2];

  beforeEach(() => { variable_unset('TRANSFER_JOBS'); });

  it('hands the pool 8 by default, the line\'s -j or --jobs, and the line\'s cancel signal', async () => {
    await builtin_download(['/home/chris/uploads/study', '/tmp/dl/']);
    expect(optionsGiven().jobs).toBe(8);
    await builtin_download(['-j', '16', '/home/chris/uploads/study', '/tmp/dl/']);
    expect(optionsGiven().jobs).toBe(16);
    await builtin_download(['--jobs=1', '/home/chris/uploads/study', '/tmp/dl/']);
    expect(optionsGiven().jobs).toBe(1);
    await commandCancellation_run(async () => builtin_download(['/home/chris/uploads/study', '/tmp/dl/']));
    expect(optionsGiven().signal).toBeInstanceOf(AbortSignal);
  });

  it('hands several sources the same jobs', async () => {
    await builtin_download(['-j', '4', '/home/chris/a', '/home/chris/b', '/tmp/dl/']);
    expect((mockDownloadMany.mock.calls.at(-1) as unknown as [string[], string, { jobs?: number }])[2].jobs).toBe(4);
  });

  it('refuses -j above 32 before anything moves', async () => {
    const result = await builtin_download(['-j', '33', '/home/chris/uploads/study', '/tmp/dl/']);
    expect(result.status).toBe('error');
    expect(result.renderedErr).toContain('at most 32');
    expect(mockDownloadOne).not.toHaveBeenCalled();
  });

  it('takes TRANSFER_JOBS when the line gives none; the line wins over it', async () => {
    variable_set('TRANSFER_JOBS', textAnswer_make(' 3 ', 'TRANSFER_JOBS=3'));
    await builtin_download(['/home/chris/uploads/study', '/tmp/dl/']);
    expect(optionsGiven().jobs).toBe(3);
    await builtin_download(['-j', '5', '/home/chris/uploads/study', '/tmp/dl/']);
    expect(optionsGiven().jobs).toBe(5);
  });

  it('refuses a TRANSFER_JOBS that is not a number of jobs, in a plain line, before anything moves', async () => {
    for (const bad of ['0', '40', 'many', '']) {
      jest.clearAllMocks();
      process.exitCode = 0;
      variable_set('TRANSFER_JOBS', textAnswer_make(bad, `TRANSFER_JOBS=${bad}`));
      const result = await builtin_download(['/home/chris/uploads/study', '/tmp/dl/']);
      expect(result.status).toBe('error');
      expect(result.renderedErr).toContain(`download: TRANSFER_JOBS is ${bad === '' ? "''" : bad}; it says how many files move at once, a whole number from 1 to 32`);
      expect(process.exitCode).toBe(1);
      expect(mockDownloadOne).not.toHaveBeenCalled();
    }
  });

  it('refuses a TRANSFER_JOBS that holds a command\'s answer, not text', async () => {
    variable_set('TRANSFER_JOBS', { source: 'ls', kind: 'listing', rows: [], data: [] });
    const result = await builtin_download(['/home/chris/uploads/study', '/tmp/dl/']);
    expect(result.renderedErr).toContain('download: TRANSFER_JOBS holds a listing; it says how many files move at once');
  });

  it('names each file that failed and what a cancel left, and fails the line', async () => {
    mockDownloadOne.mockResolvedValueOnce({
      totalFiles: 4, transferredCount: 1, failedCount: 2, transferSize: 3, duration: 0.1, speed: 30, startTime: 0, endTime: 0,
      failedPaths: ['/home/chris/uploads/study/b.dcm', '/home/chris/uploads/study/c.dcm'] as never[], cancelledCount: 1,
    });
    const result = await builtin_download(['/home/chris/uploads/study', '/tmp/dl/']);
    expect(result.status).toBe('error');
    expect(process.exitCode).toBe(1);
    expect(result.rendered).toContain('Downloaded 1 file(s), 2 failed');
    expect(result.rendered).toContain('  failed: /home/chris/uploads/study/b.dcm\n');
    expect(result.rendered).toContain('  failed: /home/chris/uploads/study/c.dcm\n');
    expect(result.rendered).toContain('  cancelled: 1 file(s) not downloaded\n');
  });
});
