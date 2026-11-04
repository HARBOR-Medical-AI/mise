import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { bytes_format, eta_format, files_upload, files_uploadWithProgress, rate_format, type UploadProgressEvent } from '../../../src/commands/fs/upload';
import { files_downloadManyWithProgress, files_downloadWithProgress, type DownloadProgressEvent } from '../../../src/commands/fs/download';
import * as cliUtils from '../../../src/utils/cli';
import { chrisIO } from '@fnndsc/cumin';
import { fileContent_getBinaryStream, files_listRecursive, files_path_isDirectory, files_uploadPath } from '@fnndsc/salsa';
import { prompt_confirmOrThrow } from '../../../src/utils/input_format';
import { errorStack } from '@fnndsc/fond';

jest.mock('../../../src/utils/cli');
jest.mock('../../../src/utils/input_format', () => ({
  prompt_confirmOrThrow: jest.fn(),
}));
jest.mock('@fnndsc/cumin', () => ({
  chrisIO: {
    client_get: jest.fn(),
    file_upload: jest.fn(),
  },
}));
jest.mock('@fnndsc/salsa', () => ({
  fileContent_getBinaryStream: jest.fn(),
  files_listRecursive: jest.fn(),
  files_path_isDirectory: jest.fn(),
  files_uploadPath: jest.fn(),
}));

describe('fs structured progress producers', () => {
  let tmpDir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chili-progress-'));
    (cliUtils.path_resolveChrisFs as jest.Mock).mockImplementation(async (p: string | undefined) => p ?? '/');
    (files_path_isDirectory as jest.Mock).mockResolvedValue(false);
    (chrisIO.client_get as jest.Mock).mockResolvedValue(null);
    (chrisIO.file_upload as jest.Mock).mockResolvedValue(true);
    (prompt_confirmOrThrow as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('emits upload scan, transfer, and completion events', async () => {
    const localFile = path.join(tmpDir, 'image.dcm');
    await fs.promises.writeFile(localFile, 'abc');
    const events: UploadProgressEvent[] = [];

    const summary = await files_uploadWithProgress(localFile, '/remote', {
      onProgress: event => { events.push(event); },
    });

    expect(summary.transferredCount).toBe(1);
    expect(events).toEqual([
      expect.objectContaining({ operation: 'upload', phase: 'scanning', status: 'running' }),
      expect.objectContaining({ operation: 'upload', phase: 'transferring', current: 0, total: 1, percent: 0, unit: 'files' }),
      expect.objectContaining({ operation: 'upload', phase: 'transferring', current: 1, total: 1, percent: 100, unit: 'files' }),
      expect.objectContaining({ operation: 'upload', phase: 'complete', current: 1, total: 1, percent: 100, unit: 'files', status: 'done' }),
    ]);
  });

  it('expands a host-filesystem glob before scanning an upload', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'earthandmoon-1.png'), 'one');
    await fs.promises.writeFile(path.join(tmpDir, 'earthandmoon-2.png'), 'two');
    await fs.promises.writeFile(path.join(tmpDir, 'unrelated.png'), 'three');

    const summary = await files_uploadWithProgress(path.join(tmpDir, 'earthandmoon*'), '/remote', {
      force: true,
    });

    expect(summary.totalFiles).toBe(2);
    expect(summary.transferredCount).toBe(2);
    expect(summary.transferSize).toBe(6);
    expect(chrisIO.file_upload).toHaveBeenCalledWith(expect.any(Blob), '/remote', 'earthandmoon-1.png');
    expect(chrisIO.file_upload).toHaveBeenCalledWith(expect.any(Blob), '/remote', 'earthandmoon-2.png');
  });

  it('reports a host glob with no matches before transferring', async () => {
    await expect(files_uploadWithProgress(path.join(tmpDir, 'missing*'), '/remote', {
      force: true,
    })).rejects.toThrow(`No local files matched '${path.join(tmpDir, 'missing*')}'`);

    expect(chrisIO.file_upload).not.toHaveBeenCalled();
  });

  it('does not interpret a literal host wildcard as a glob', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'scan-1.txt'), 'one');

    await expect(files_uploadWithProgress(path.join(tmpDir, 'scan-*.txt'), '/remote', {
      expandLocalGlob: false,
    })).rejects.toThrow(`No local file exists at '${path.join(tmpDir, 'scan-*.txt')}'`);

    expect(chrisIO.file_upload).not.toHaveBeenCalled();
  });

  it('emits failed upload completion when one file does not upload', async () => {
    const localFile = path.join(tmpDir, 'bad.dcm');
    await fs.promises.writeFile(localFile, 'abc');
    const events: UploadProgressEvent[] = [];
    (chrisIO.file_upload as jest.Mock).mockResolvedValue(false);

    const summary = await files_uploadWithProgress(localFile, '/remote', {
      onProgress: event => { events.push(event); },
    });

    expect(summary.failedCount).toBe(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'upload', phase: 'failed', current: 0, total: 1, status: 'error' }),
    ]));
  });

  it('scans directory uploads and confirms an existing target', async () => {
    const localDir = path.join(tmpDir, 'study');
    await fs.promises.mkdir(path.join(localDir, 'series'), { recursive: true });
    await fs.promises.writeFile(path.join(localDir, 'a.dcm'), 'a');
    await fs.promises.writeFile(path.join(localDir, 'series', 'b.dcm'), 'bb');
    const events: UploadProgressEvent[] = [];
    (chrisIO.client_get as jest.Mock).mockResolvedValue({
      getFileBrowserFolders: jest.fn().mockResolvedValue({
        getItems: jest.fn().mockResolvedValue([{ path: '/remote/study' }]),
      }),
    });

    const summary = await files_uploadWithProgress(localDir, '/remote', {
      onProgress: event => { events.push(event); },
    });

    expect(prompt_confirmOrThrow).toHaveBeenCalledWith(expect.stringContaining("Target '/remote/study' already exists"));
    expect(summary.totalFiles).toBe(2);
    expect(summary.transferSize).toBe(3);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'upload', phase: 'transferring', current: 2, total: 2, percent: 100 }),
      expect.objectContaining({ operation: 'upload', phase: 'complete', current: 2, total: 2, status: 'done' }),
    ]));
  });

  it('places a file into an existing destination directory without confirmation', async () => {
    const localFile: string = path.join(tmpDir, 'scan.dcm');
    await fs.promises.writeFile(localFile, 'scan');
    (chrisIO.client_get as jest.Mock).mockResolvedValue({
      getFileBrowserFolders: jest.fn().mockResolvedValue({
        getItems: jest.fn().mockResolvedValue([{ path: '/remote/existing-child' }]),
      }),
    });

    await files_uploadWithProgress(localFile, '/remote');

    expect(prompt_confirmOrThrow).not.toHaveBeenCalled();
    expect(chrisIO.file_upload).toHaveBeenCalledWith(expect.any(Blob), '/remote', 'scan.dcm');
  });

  it('uses caller-owned confirmation and notices instead of terminal I/O', async () => {
    const localDir: string = path.join(tmpDir, 'study');
    await fs.promises.mkdir(localDir);
    await fs.promises.writeFile(path.join(localDir, 'scan.dcm'), 'scan');
    const confirm = jest.fn(async (): Promise<void> => undefined);
    const notices: string[] = [];
    (chrisIO.client_get as jest.Mock).mockResolvedValue({
      getFileBrowserFolders: jest.fn().mockResolvedValue({
        getItems: jest.fn().mockResolvedValue([{ path: '/remote/study' }]),
      }),
    });

    await files_uploadWithProgress(localDir, '/remote', {
      confirm,
      onNotice: (notice: string): void => { notices.push(notice); },
    });

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Target '/remote/study' already exists"));
    expect(prompt_confirmOrThrow).not.toHaveBeenCalled();
    expect(notices).toContain('Scanning files to upload...');
  });

  it('formats transfer helper values and delegates plain upload', async () => {
    const localFile: string = path.join(tmpDir, 'local.txt');
    await fs.promises.writeFile(localFile, 'content');
    (files_uploadPath as jest.Mock).mockResolvedValue(true);

    await expect(files_upload(localFile, '/remote')).resolves.toBe(true);

    expect(files_uploadPath).toHaveBeenCalledWith(localFile, '/remote');
    expect(bytes_format(0)).toBe('0 B');
    expect(bytes_format(2048)).toBe('2 KB');
    expect(eta_format(null)).toBe('--');
    expect(eta_format(59.4)).toBe('59s');
    expect(eta_format(3661)).toBe('1h 1m 1s');
    expect(rate_format(0)).toBe('--');
    expect(rate_format(2048)).toBe('2 KB/s');
  });

  it('expands a host glob for the plain upload entry point', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'scan-1.txt'), 'one');
    await fs.promises.writeFile(path.join(tmpDir, 'scan-2.txt'), 'two');
    (files_uploadPath as jest.Mock).mockResolvedValue(true);

    await expect(files_upload(path.join(tmpDir, 'scan-*'), '/remote')).resolves.toBe(true);

    expect(files_uploadPath).toHaveBeenCalledWith(path.join(tmpDir, 'scan-1.txt'), '/remote');
    expect(files_uploadPath).toHaveBeenCalledWith(path.join(tmpDir, 'scan-2.txt'), '/remote');
  });

  it('emits byte progress for a single-file download', async () => {
    const destination = path.join(tmpDir, 'out.dcm');
    const events: DownloadProgressEvent[] = [];
    (files_listRecursive as jest.Mock).mockRejectedValue(new Error('not a directory'));
    (fileContent_getBinaryStream as jest.Mock).mockResolvedValue({
      ok: true,
      value: {
        stream: Readable.from([Buffer.from('ab'), Buffer.from('cd')]),
        size: 4,
      },
    });

    const summary = await files_downloadWithProgress('/remote/image.dcm', destination, {
      onProgress: event => { events.push(event); },
    });

    expect(summary.transferredCount).toBe(1);
    expect(await fs.promises.readFile(destination, 'utf8')).toBe('abcd');
    expect(events).toEqual([
      expect.objectContaining({ operation: 'download', phase: 'transferring', current: 2, total: 4, percent: 50, unit: 'bytes' }),
      expect.objectContaining({ operation: 'download', phase: 'transferring', current: 4, total: 4, percent: 100, unit: 'bytes' }),
      expect.objectContaining({ operation: 'download', phase: 'complete', current: 4, total: 4, percent: 100, unit: 'bytes', status: 'done' }),
    ]);
  });

  it('emits failed download progress when a single file cannot be opened', async () => {
    const destination = path.join(tmpDir, 'missing.dcm');
    const events: DownloadProgressEvent[] = [];
    (files_listRecursive as jest.Mock).mockRejectedValue(new Error('not a directory'));
    (fileContent_getBinaryStream as jest.Mock).mockResolvedValue({ ok: false });

    await expect(files_downloadWithProgress('/remote/missing.dcm', destination, {
      onProgress: event => { events.push(event); },
    })).rejects.toThrow('could not open /remote/missing.dcm');

    expect(events).toEqual([
      expect.objectContaining({ operation: 'download', phase: 'failed', status: 'error' }),
    ]);
  });

  it("a download that cannot open says the kernel's reason, on the error and on the bar", async () => {
    const destination = path.join(tmpDir, 'big.dcm');
    const events: DownloadProgressEvent[] = [];
    (files_listRecursive as jest.Mock).mockRejectedValue(new Error('not a directory'));
    (fileContent_getBinaryStream as jest.Mock).mockImplementation(async () => {
      errorStack.stack_push('error', 'CUBE sent no bytes of file 30916964 for 120 s');
      return { ok: false };
    });

    await expect(files_downloadWithProgress('/remote/big.dcm', destination, {
      onProgress: event => { events.push(event); },
    })).rejects.toThrow('CUBE sent no bytes of file 30916964 for 120 s');

    expect(events[0]).toEqual(expect.objectContaining({ phase: 'failed', label: 'Download failed: CUBE sent no bytes of file 30916964 for 120 s' }));
  });

  it('downloads multiple CFS files into one local directory with aggregate progress', async () => {
    const destination: string = path.join(tmpDir, 'downloads');
    const events: DownloadProgressEvent[] = [];
    (fileContent_getBinaryStream as jest.Mock)
      .mockResolvedValueOnce({ ok: true, value: { stream: Readable.from([Buffer.from('one')]), size: 3 } })
      .mockResolvedValueOnce({ ok: true, value: { stream: Readable.from([Buffer.from('two')]), size: 3 } });

    const summary = await files_downloadManyWithProgress([
      '/remote/one.txt',
      '/remote/two.txt',
    ], destination, {
      onProgress: event => { events.push(event); },
    });

    expect(summary.totalFiles).toBe(2);
    expect(summary.transferredCount).toBe(2);
    expect(summary.transferSize).toBe(6);
    expect(await fs.promises.readFile(path.join(destination, 'one.txt'), 'utf8')).toBe('one');
    expect(await fs.promises.readFile(path.join(destination, 'two.txt'), 'utf8')).toBe('two');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'download', phase: 'scanning', status: 'running' }),
      expect.objectContaining({ operation: 'download', phase: 'transferring', current: 0, total: 2, unit: 'files' }),
      expect.objectContaining({ operation: 'download', phase: 'transferring', current: 2, total: 2, percent: 100, unit: 'files' }),
      expect.objectContaining({ operation: 'download', phase: 'complete', current: 2, total: 2, percent: 100, unit: 'files', status: 'done' }),
    ]));
  });

  it('keeps two directory sources that share a name, each under its parent, and says so (#1364)', async () => {
    const destination: string = path.join(tmpDir, 'downloads');
    const notices: Array<{ message: string; channel: string }> = [];
    (files_path_isDirectory as jest.Mock).mockResolvedValue(true);
    (files_listRecursive as jest.Mock).mockImplementation(async (source: string) => [
      { path: `${source}/out.txt`, type: 'file', size: 3 },
    ]);
    (fileContent_getBinaryStream as jest.Mock)
      .mockResolvedValueOnce({ ok: true, value: { stream: Readable.from([Buffer.from('one')]), size: 3 } })
      .mockResolvedValueOnce({ ok: true, value: { stream: Readable.from([Buffer.from('two')]), size: 3 } });

    const summary = await files_downloadManyWithProgress([
      '/feeds/feed_1/pl-ffmpeg_2/pl-whisper_3/data',
      '/feeds/feed_1/pl-ffmpeg_2/data',
    ], destination, { onNotice: (message: string, channel: 'status' | 'err') => { notices.push({ message, channel }); } });

    expect(summary.transferredCount).toBe(2);
    expect(await fs.promises.readFile(path.join(destination, 'pl-whisper_3', 'data', 'out.txt'), 'utf8')).toBe('one');
    expect(await fs.promises.readFile(path.join(destination, 'pl-ffmpeg_2', 'data', 'out.txt'), 'utf8')).toBe('two');
    expect(notices).toEqual([{ message: "'data' named more than once: each lands under its parent's name (pl-whisper_3/data, pl-ffmpeg_2/data)", channel: 'status' }]);
  });

  it('routes aggregate download failures to the caller-owned notice channel', async () => {
    const destination: string = path.join(tmpDir, 'downloads');
    const notices: Array<{ message: string; channel: string }> = [];
    (fileContent_getBinaryStream as jest.Mock).mockResolvedValue({ ok: false });

    const summary = await files_downloadManyWithProgress(['/remote/missing.txt'], destination, {
      onNotice: (message: string, channel: "status" | "err"): void => { notices.push({ message, channel }); },
    });

    expect(summary.failedCount).toBe(1);
    expect(notices).toEqual([
      { message: 'Error downloading /remote/missing.txt: could not open /remote/missing.txt', channel: 'err' },
    ]);
  });

  it('preserves an empty matched CFS directory', async () => {
    const destination: string = path.join(tmpDir, 'downloads');
    (files_path_isDirectory as jest.Mock).mockResolvedValue(true);
    (files_listRecursive as jest.Mock).mockResolvedValue([]);

    const summary = await files_downloadManyWithProgress([
      '/remote/empty',
    ], destination);

    expect(summary.totalFiles).toBe(0);
    expect(summary.transferredCount).toBe(0);
    const stats: fs.Stats = await fs.promises.stat(path.join(destination, 'empty'));
    expect(stats.isDirectory()).toBe(true);
    expect(fileContent_getBinaryStream).not.toHaveBeenCalled();
  });

  it('resolves a link source to its file target before downloading', async () => {
    const destination: string = path.join(tmpDir, 'downloads');
    (cliUtils.path_resolveChrisFs as jest.Mock).mockResolvedValue('/remote/target.txt');
    (files_path_isDirectory as jest.Mock).mockResolvedValue(false);
    (fileContent_getBinaryStream as jest.Mock).mockResolvedValue({
      ok: true,
      value: { stream: Readable.from([Buffer.from('link target')]), size: 11 },
    });

    const summary = await files_downloadManyWithProgress([
      '/PUBLIC/shared',
    ], destination);

    expect(summary.transferredCount).toBe(1);
    expect(files_path_isDirectory).toHaveBeenCalledWith('/remote/target.txt');
    expect(await fs.promises.readFile(path.join(destination, 'target.txt'), 'utf8')).toBe('link target');
  });

  it('preserves an empty directory reached through a link source', async () => {
    const destination: string = path.join(tmpDir, 'downloads');
    (cliUtils.path_resolveChrisFs as jest.Mock).mockResolvedValue('/remote/target');
    (files_path_isDirectory as jest.Mock).mockResolvedValue(true);
    (files_listRecursive as jest.Mock).mockResolvedValue([]);

    const summary = await files_downloadManyWithProgress([
      '/PUBLIC/shared',
    ], destination);

    expect(summary.totalFiles).toBe(0);
    const stats: fs.Stats = await fs.promises.stat(path.join(destination, 'target'));
    expect(stats.isDirectory()).toBe(true);
    expect(fileContent_getBinaryStream).not.toHaveBeenCalled();
  });

  it('throws before download when the local file exists without force', async () => {
    const destination = path.join(tmpDir, 'exists.dcm');
    await fs.promises.writeFile(destination, 'old');

    await expect(files_downloadWithProgress('/remote/image.dcm', destination)).rejects.toThrow('Use -f flag');
  });

  it('emits directory download scan, transfer, and failed completion events', async () => {
    const destination = path.join(tmpDir, 'downloads');
    const events: DownloadProgressEvent[] = [];
    (files_path_isDirectory as jest.Mock).mockResolvedValue(true);
    (files_listRecursive as jest.Mock).mockResolvedValue([
      { type: 'dir', path: '/remote/study' },
      { type: 'file', path: '/remote/study/a.dcm', size: 1 },
      { type: 'file', path: '/remote/study/nested/b.dcm', size: 2 },
      { type: 'file', path: '/remote/study/c.dcm', size: 3 },
    ]);
    (fileContent_getBinaryStream as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        value: { stream: Readable.from([Buffer.from('a')]), size: 1 },
      })
      .mockResolvedValueOnce({ ok: false })
      .mockRejectedValueOnce(new Error('boom'));

    const summary = await files_downloadWithProgress('/remote/study', destination, {
      onProgress: event => { events.push(event); },
    });

    expect(summary.totalFiles).toBe(3);
    expect(summary.transferredCount).toBe(1);
    expect(summary.failedCount).toBe(2);
    expect(await fs.promises.readFile(path.join(destination, 'study', 'a.dcm'), 'utf8')).toBe('a');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'download', phase: 'scanning', status: 'running' }),
      expect.objectContaining({ operation: 'download', phase: 'transferring', current: 0, total: 3, unit: 'files' }),
      expect.objectContaining({ operation: 'download', phase: 'transferring', current: 3, total: 3, percent: 100 }),
      expect.objectContaining({ operation: 'download', phase: 'failed', current: 1, total: 3, status: 'error' }),
    ]));
  });
});
