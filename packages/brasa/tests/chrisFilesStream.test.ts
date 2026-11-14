/**
 * @file A ChRIS file served as a stream: a CUBE file is opened as one and
 * never read whole; a refusal names CUBE's status; a small projection is
 * read whole, as before.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Readable } from 'node:stream';
import { errorStack } from '@fnndsc/fond';

const pathResolve_mock = jest.fn(async (p: string): Promise<string> => p);
const isVirtual_mock = jest.fn((_p: string): boolean => false);
const linkTarget_mock = jest.fn(async (): Promise<{ ok: boolean; value?: string }> => ({ ok: false }));
const readBinary_mock = jest.fn(async (): Promise<{ ok: true; value: Buffer }> => ({ ok: true, value: Buffer.from('status') }));
const stream_mock = jest.fn(async (_p: string): Promise<unknown> => ({ ok: false }));
const catBinary_mock = jest.fn(async (): Promise<unknown> => ({ ok: false }));

jest.unstable_mockModule('../src/builtins/utils.js', () => ({ path_resolve: pathResolve_mock }));
jest.unstable_mockModule('@fnndsc/salsa', () => ({
  vfsDispatcher: { path_isVirtual: isVirtual_mock, linkTarget_resolve: linkTarget_mock, readBinary: readBinary_mock },
  fileContent_getBinaryStream: stream_mock,
}));
jest.unstable_mockModule('@fnndsc/chili/utils/cli.js', () => ({ path_resolveChrisFs: async (p: string): Promise<string> => p }));
jest.unstable_mockModule('@fnndsc/chili/commands/fs/cat.js', () => ({ files_catBinary: catBinary_mock }));
jest.unstable_mockModule('@fnndsc/chili/utils', () => ({ logicalPath_resolve: async (p: string) => ({ ok: true, value: p }) }));

const { chrisFiles } = await import('../src/chris/files.js');

async function drain(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

beforeEach(() => {
  jest.clearAllMocks();
  isVirtual_mock.mockReturnValue(false);
});

describe('chrisFiles.stream', () => {
  it('opens a CUBE file as a stream with its size, and reads nothing whole', async () => {
    stream_mock.mockResolvedValueOnce({ ok: true, value: { stream: Readable.from([Buffer.from('big-'), Buffer.from('file')]), size: 8 } });
    const opened = await chrisFiles.stream!('/home/s/feeds/feed_4389/x.dcm');
    expect(opened.size).toBe(8);
    expect(await drain(opened.stream)).toBe('big-file');
    expect(stream_mock).toHaveBeenCalledWith('/home/s/feeds/feed_4389/x.dcm');
    expect(catBinary_mock).not.toHaveBeenCalled();
  });

  it('hands a PACS file, which arrives whole, on as a stream of its bytes', async () => {
    stream_mock.mockResolvedValueOnce({ ok: true, value: { stream: Buffer.from('DICM-pacs'), size: 9 } });
    const opened = await chrisFiles.stream!('/SERVICES/PACS/PACSDCM/a/scan.dcm');
    expect(typeof (opened.stream as AsyncIterable<Buffer>)[Symbol.asyncIterator]).toBe('function');
    expect(opened.size).toBe(9);
    expect(await drain(opened.stream)).toBe('DICM-pacs');
  });

  it("refuses with CUBE's status when the file cannot be opened", async () => {
    stream_mock.mockImplementationOnce(async () => {
      errorStack.stack_push('error', 'File ID 12: CUBE refused access (403). It is listed but not readable by this identity.');
      return { ok: false };
    });
    await expect(chrisFiles.stream!('/home/s/x.dcm')).rejects.toMatchObject({ status: 403 });
  });

  it('reads a projection with no data link whole, as before', async () => {
    isVirtual_mock.mockReturnValue(true);
    const opened = await chrisFiles.stream!('/proc/jobs/feed_1/status');
    expect(await drain(opened.stream)).toBe('status');
    expect(opened.size).toBe(6);
    expect(stream_mock).not.toHaveBeenCalled();
  });

  it("streams a node's data path through the file behind its link", async () => {
    isVirtual_mock.mockReturnValue(true);
    linkTarget_mock.mockResolvedValueOnce({ ok: true, value: '/home/s/feeds/feed_1/pl-x_7/data' });
    stream_mock.mockResolvedValueOnce({ ok: true, value: { stream: Readable.from([Buffer.from('dcm')]), size: 3 } });
    const opened = await chrisFiles.stream!('/proc/jobs/feed_1/pl-x_7/data/a.dcm');
    expect(await drain(opened.stream)).toBe('dcm');
    expect(stream_mock).toHaveBeenCalledWith('/home/s/feeds/feed_1/pl-x_7/data/a.dcm');
  });
});
