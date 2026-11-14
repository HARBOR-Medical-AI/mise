/**
 * @file Tests for ChRIS file IO: download (stream and blob), upload with
 * collision-rename, folder create/move, recursive local upload. Connection
 * mocked at the client boundary; a fake storage provider drives local IO.
 * Fake timers drive the upload's stall watch.
 */

jest.mock('../src/connect/chrisConnection', () => ({
  chrisConnection: { client_get: jest.fn() },
}));

import { chrisConnection } from '../src/connect/chrisConnection';
import { ChrisIO } from '../src/io/chrisIO';
import { errorStack } from '../src/error/errorStack';

const mockClientGet: jest.Mock = chrisConnection.client_get as unknown as jest.Mock;

let pushSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  pushSpy = jest.spyOn(errorStack, 'stack_push').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  pushSpy.mockRestore();
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

const io = (): ChrisIO => new ChrisIO();

describe('init', () => {
  it('creates the file browser folder', async () => {
    mockClientGet.mockResolvedValue({ createFileBrowserFolder: jest.fn(async () => ({})) });
    expect(await io().init()).toBe(true);
  });

  it('returns false when the create throws', async () => {
    mockClientGet.mockResolvedValue({
      createFileBrowserFolder: jest.fn(async () => { throw new Error('409'); }),
    });
    expect(await io().init()).toBe(false);
  });

  it('returns null when not connected', async () => {
    mockClientGet.mockResolvedValue(null);
    expect(await io().init()).toBeNull();
  });
});

describe('file_moveById field drift', () => {
  it('renames with upload_path on current CUBEs', async () => {
    const put = jest.fn(async () => ({}));
    mockClientGet.mockResolvedValue({ getUserFile: jest.fn(async () => ({ put })) });
    expect((await io().file_moveById(5, '/new/name.txt')).ok).toBe(true);
    expect(put).toHaveBeenCalledWith({ upload_path: '/new/name.txt' });
  });

  it('falls back to path for older CUBEs', async () => {
    const put = jest.fn()
      .mockRejectedValueOnce(new Error('At least one of the fields'))
      .mockResolvedValueOnce({});
    mockClientGet.mockResolvedValue({ getUserFile: jest.fn(async () => ({ put })) });
    expect((await io().file_moveById(5, '/new/name.txt')).ok).toBe(true);
    expect(put).toHaveBeenNthCalledWith(1, { upload_path: '/new/name.txt' });
    expect(put).toHaveBeenNthCalledWith(2, { path: '/new/name.txt' });
  });

  it('fails when both field spellings are rejected', async () => {
    const put = jest.fn(async () => { throw new Error('403'); });
    mockClientGet.mockResolvedValue({ getUserFile: jest.fn(async () => ({ put })) });
    expect((await io().file_moveById(5, '/new/name.txt')).ok).toBe(false);
  });
});

describe('folder_deleteByPath', () => {
  it('deletes and confirms disappearance', async () => {
    const del = jest.fn(async () => undefined);
    const byPath = jest.fn()
      .mockResolvedValueOnce({ delete: del })
      .mockResolvedValueOnce(null);
    mockClientGet.mockResolvedValue({ getFileBrowserFolderByPath: byPath });
    const result = await io().folder_deleteByPath('/home/alice/scratch');
    expect(result.ok).toBe(true);
    expect(del).toHaveBeenCalled();
    // Leading slash stripped for the filebrowser lookup.
    expect(byPath).toHaveBeenCalledWith('home/alice/scratch');
  });

  it('treats an absent folder as already deleted', async () => {
    mockClientGet.mockResolvedValue({ getFileBrowserFolderByPath: jest.fn(async () => null) });
    expect((await io().folder_deleteByPath('home/alice/gone')).ok).toBe(true);
  });

  it('fails when the delete call throws', async () => {
    mockClientGet.mockResolvedValue({
      getFileBrowserFolderByPath: jest.fn(async () => ({ delete: async () => { throw new Error('403'); } })),
    });
    expect((await io().folder_deleteByPath('home/alice/held')).ok).toBe(false);
  });
});

describe('file_downloadStream', () => {
  it('returns the stream with size and filename', async () => {
    mockClientGet.mockResolvedValue({
      getUserFile: jest.fn(async () => ({
        data: { fname: 'home/chris/a.txt' },
        getFileStream: jest.fn(async () => ({ data: 'STREAM', headers: { 'content-length': '42' } })),
      })),
    });
    const result = await io().file_downloadStream(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ stream: 'STREAM', size: 42, filename: 'home/chris/a.txt' });
  });

  it('errors on a missing file, empty response, or thrown fetch', async () => {
    mockClientGet.mockResolvedValue({ getUserFile: jest.fn(async () => null) });
    expect((await io().file_downloadStream(1)).ok).toBe(false);

    mockClientGet.mockResolvedValue({
      getUserFile: jest.fn(async () => ({ getFileStream: jest.fn(async () => ({})) })),
    });
    expect((await io().file_downloadStream(1)).ok).toBe(false);

    mockClientGet.mockResolvedValue({
      getUserFile: jest.fn(async () => ({ getFileStream: jest.fn(async () => { throw new Error('x'); }) })),
    });
    expect((await io().file_downloadStream(1)).ok).toBe(false);
  });

  it('errors when not connected', async () => {
    mockClientGet.mockResolvedValue(null);
    expect((await io().file_downloadStream(1)).ok).toBe(false);
  });
});

describe('file_download', () => {
  const withBlob = (blob: unknown): void => {
    mockClientGet.mockResolvedValue({
      getUserFile: jest.fn(async () => ({ getFileBlob: jest.fn(async () => blob) })),
    });
  };

  it('converts a string blob to a Buffer', async () => {
    withBlob('hello');
    expect((await io().file_download(1))?.toString()).toBe('hello');
  });

  it('passes a Buffer through', async () => {
    withBlob(Buffer.from('buf'));
    expect((await io().file_download(1))?.toString()).toBe('buf');
  });

  it('converts an ArrayBuffer', async () => {
    withBlob(new TextEncoder().encode('ab').buffer);
    expect((await io().file_download(1))?.toString()).toBe('ab');
  });

  it('converts a Blob', async () => {
    withBlob(new Blob(['bl']));
    expect((await io().file_download(1))?.toString()).toBe('bl');
  });

  it('rejects an unexpected blob type', async () => {
    withBlob(42);
    expect(await io().file_download(1)).toBeNull();
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('Unexpected blob type'));
  });

  it('returns null for a missing file or empty blob', async () => {
    mockClientGet.mockResolvedValue({ getUserFile: jest.fn(async () => null) });
    expect(await io().file_download(1)).toBeNull();

    withBlob(null);
    expect(await io().file_download(1)).toBeNull();
  });
});

/** What the fake CUBE does with one posted file: read it at a pace, then answer, hang, or refuse. */
interface FakeUpload {
  pauseMs?: number;
  slices?: number;
  fname?: (uploadPath: string) => string;
  status?: number;
}

/** The posts the fake CUBE saw: the path asked for and the bytes it read. */
let posted: Array<{ url: string; uploadPath: string; bytes: number; authorization: string }> = [];
let fetchSpy: jest.SpyInstance | undefined;

/**
 * Stands in for CUBE's `POST /userfiles/`: reads the form's file a slice at a
 * time as a connection would, honours the request's abort, and answers with a
 * Collection+JSON item as CUBE does.
 */
function cube_fake(upload: FakeUpload = {}): jest.SpyInstance {
  fetchSpy?.mockRestore();
  fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const form: FormData = init?.body as FormData;
    const uploadPath: string = String(form.get('upload_path'));
    const file: File = form.get('fname') as File;
    const seen = { url: String(input), uploadPath, bytes: 0, authorization: String((init?.headers as Record<string, string>).Authorization) };
    posted.push(seen);
    const aborted: Promise<never> = new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
    aborted.catch(() => undefined);
    const reader: ReadableStreamDefaultReader<Uint8Array> = file.stream().getReader();
    for (let read: number = 0; upload.slices === undefined || read < upload.slices; read++) {
      const step: ReadableStreamReadResult<Uint8Array> = await Promise.race([reader.read(), aborted]);
      if (step.done) {
        const fname: string = upload.fname?.(uploadPath) ?? uploadPath;
        const body: string = JSON.stringify({ collection: { items: [{ data: [{ name: 'id', value: 41 }, { name: 'fname', value: fname }] }] } });
        return new Response(upload.status === undefined ? body : 'nope', { status: upload.status ?? 201 });
      }
      seen.bytes += step.value.byteLength;
      if (upload.pauseMs !== undefined && upload.pauseMs > 0) {
        await Promise.race([new Promise((resolve) => setTimeout(resolve, upload.pauseMs)), aborted]);
      }
    }
    return aborted;
  });
  return fetchSpy;
}

/** A connected client as the upload uses it: its user-files address and token, and the file lookup a rename needs. */
const uploadClient = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  userFilesUrl: 'https://cube.example.org/api/v1/userfiles/',
  auth: { token: 'T0K' },
  ...extra,
});

describe('file_upload', () => {
  beforeEach(() => { posted = []; });
  afterEach(() => { fetchSpy?.mockRestore(); fetchSpy = undefined; });

  it('posts the bytes to the user files with the token, and leaves a correctly-named file alone', async () => {
    cube_fake();
    const getUserFile = jest.fn();
    mockClientGet.mockResolvedValue(uploadClient({ getUserFile }));
    expect(await io().file_upload(new Blob(['xyz']), '/home/chris/up', 'a.txt')).toBe(true);
    expect(posted).toEqual([{ url: 'https://cube.example.org/api/v1/userfiles/', uploadPath: 'home/chris/up/a.txt', bytes: 3, authorization: 'Token T0K' }]);
    expect(getUserFile).not.toHaveBeenCalled();
  });

  it('asks the client for its addresses when it has none yet', async () => {
    cube_fake();
    const client: Record<string, unknown> = { auth: { token: 'T0K' } };
    client.setUrls = jest.fn(async () => { client.userFilesUrl = 'https://cube.example.org/api/v1/userfiles/'; });
    mockClientGet.mockResolvedValue(client);
    expect(await io().file_upload(new Blob(['x']), 'up', 'a.txt')).toBe(true);
    expect(client.setUrls).toHaveBeenCalled();
    expect(posted[0]?.url).toBe('https://cube.example.org/api/v1/userfiles/');
  });

  it('renames a collision-renamed upload back when the wanted path is FREE', async () => {
    // The case the rename-back exists for: CUBE suffixed a name whose path
    // had been deleted and not yet committed, so nothing holds it now.
    cube_fake({ fname: () => 'home/chris/up/a_XYZ.txt' });
    const put = jest.fn(async () => ({}));
    const getUserFile = jest.fn(async () => ({ put }));
    mockClientGet.mockResolvedValue(uploadClient({ getUserFile, getUserFiles: jest.fn(async () => ({ getItems: () => [] })) }));
    expect(await io().file_upload(new Blob(['x']), 'home/chris/up/', 'a.txt')).toBe(true);
    expect(getUserFile).toHaveBeenCalledWith(41);
    expect(put).toHaveBeenCalledWith({ upload_path: 'home/chris/up/a.txt' });
  });

  it('never renames onto a path something else holds', async () => {
    // The write that damages a folder: a PUT onto an occupied path leaves a
    // row CUBE cannot serve afterwards (docs/CUBE-gaps.adoc). The upload
    // keeps the name it was given, and says so.
    cube_fake({ fname: () => 'home/chris/up/a_XYZ.txt' });
    const getUserFile = jest.fn();
    mockClientGet.mockResolvedValue(uploadClient({
      getUserFile,
      getUserFiles: jest.fn(async () => ({ getItems: () => [{ data: { fname: 'home/chris/up/a.txt' } }] })),
    }));
    expect(await io().file_upload(new Blob(['x']), 'home/chris/up/', 'a.txt')).toBe(true);
    expect(getUserFile).not.toHaveBeenCalled();
    expect(pushSpy).toHaveBeenCalledWith('warning', expect.stringContaining('already exists'));
  });

  it('treats a probe that cannot answer as occupied', async () => {
    cube_fake({ fname: () => 'home/chris/up/a_XYZ.txt' });
    const getUserFile = jest.fn();
    mockClientGet.mockResolvedValue(uploadClient({ getUserFile, getUserFiles: jest.fn(async () => { throw new Error('500'); }) }));
    expect(await io().file_upload(new Blob(['x']), 'home/chris/up/', 'a.txt')).toBe(true);
    expect(getUserFile).not.toHaveBeenCalled();
  });

  it('keeps the upload successful when a legitimate rename-back fails', async () => {
    cube_fake({ fname: () => 'home/chris/up/a_XYZ.txt' });
    mockClientGet.mockResolvedValue(uploadClient({
      getUserFile: jest.fn(async () => ({ put: jest.fn(async () => { throw new Error('403'); }) })),
      getUserFiles: jest.fn(async () => ({ getItems: () => [] })),
    }));
    expect(await io().file_upload(new Blob(['x']), 'home/chris/up', 'a.txt')).toBe(true);
    expect(pushSpy).toHaveBeenCalledWith('warning', expect.stringContaining('rename to'));
  });

  // Eight slices of 64 KiB.
  const big = (): Blob => new Blob([new Uint8Array(8 * 64 * 1024)]);

  it('keeps a slow upload that keeps moving, however long it takes in all', async () => {
    cube_fake({ pauseMs: 20_000 });
    mockClientGet.mockResolvedValue(uploadClient());
    const pending: Promise<boolean> = io().file_upload(big(), 'up', 'a.txt');
    await jest.advanceTimersByTimeAsync(200_000);
    expect(await pending).toBe(true);
    expect(posted[0]?.bytes).toBe(524288);
    expect(pushSpy).not.toHaveBeenCalledWith('error', expect.anything());
  });

  it('fails an upload that stops moving, saying how far it got, and abandons the request', async () => {
    const spy: jest.SpyInstance = cube_fake({ pauseMs: 1_000, slices: 3 });
    mockClientGet.mockResolvedValue(uploadClient());
    const pending: Promise<boolean> = io().file_upload(big(), 'up', 'a.txt');
    await jest.advanceTimersByTimeAsync(60_000);
    await jest.advanceTimersByTimeAsync(70_000);
    expect(await pending).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', 'Failed to upload file a.txt to up: CUBE stopped taking a.txt after 196608 of 524288 bytes (nothing for 120 s)');
    expect((spy.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
  });

  it('fails an upload CUBE took whole and never answered, and one it took nothing of', async () => {
    cube_fake({ slices: 8 });
    mockClientGet.mockResolvedValue(uploadClient());
    const answerless: Promise<boolean> = io().file_upload(big(), 'up', 'a.txt');
    await jest.advanceTimersByTimeAsync(121_000);
    expect(await answerless).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('CUBE took all 524288 bytes of a.txt and did not answer for 120 s'));

    cube_fake({ slices: 0 });
    const untouched: Promise<boolean> = io().file_upload(new Blob(['x']), 'up', 'b.txt');
    await jest.advanceTimersByTimeAsync(121_000);
    expect(await untouched).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('CUBE took none of the 1 bytes of b.txt for 120 s'));
  });

  it('fails with CUBE\'s refusal, or when the client is missing', async () => {
    cube_fake({ status: 400 });
    mockClientGet.mockResolvedValue(uploadClient());
    expect(await io().file_upload(new Blob(['x']), 'up', 'a.txt')).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('CUBE refused the upload (HTTP 400)'));

    mockClientGet.mockResolvedValue(null);
    expect(await io().file_upload(new Blob(['x']), 'up', 'a.txt')).toBe(false);
  });
});

describe('folder operations', () => {
  it('creates a folder', async () => {
    mockClientGet.mockResolvedValue({
      getFileBrowserFolders: jest.fn(async () => ({ post: jest.fn(async () => ({ data: {} })) })),
    });
    const result = await io().folder_create('/uploads/data');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(true);
  });

  it('reports an already-existing folder as Ok(false)', async () => {
    const alreadyExists = Object.assign(new Error('400'), {
      response: { status: 400, data: { path: ['folder already exists at this path'] } },
    });
    mockClientGet.mockResolvedValue({
      getFileBrowserFolders: jest.fn(async () => ({ post: jest.fn(async () => { throw alreadyExists; }) })),
    });
    const result = await io().folder_create('/uploads/data');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(false);
  });

  it('errors on any other create failure', async () => {
    mockClientGet.mockResolvedValue({
      getFileBrowserFolders: jest.fn(async () => ({ post: jest.fn(async () => { throw new Error('500'); }) })),
    });
    expect((await io().folder_create('/x')).ok).toBe(false);
  });

  it('moves a folder by path', async () => {
    const put = jest.fn(async () => ({}));
    mockClientGet.mockResolvedValue({ getFileBrowserFolderByPath: jest.fn(async () => ({ put })) });
    expect((await io().folder_moveByPath('/a', '/b')).ok).toBe(true);
    expect(put).toHaveBeenCalledWith({ path: '/b' });
  });

  it('moves a file by id', async () => {
    const put = jest.fn(async () => ({}));
    mockClientGet.mockResolvedValue({ getUserFile: jest.fn(async () => ({ put })) });
    expect((await io().file_moveById(9, '/b/c.txt')).ok).toBe(true);
    expect(put).toHaveBeenCalledWith({ upload_path: '/b/c.txt' });
  });

  it('errors when the move target is missing', async () => {
    mockClientGet.mockResolvedValue({
      getFileBrowserFolderByPath: jest.fn(async () => null),
      getUserFile: jest.fn(async () => null),
    });
    expect((await io().folder_moveByPath('/a', '/b')).ok).toBe(false);
    expect((await io().file_moveById(9, '/b')).ok).toBe(false);
  });
});

describe('uploadLocalPath', () => {
  const storage = {
    isDirectory: jest.fn(),
    basename: jest.fn((p: string) => p.split('/').pop() ?? ''),
    readdir: jest.fn(),
    join: jest.fn((a: string, b: string) => `${a}/${b}`),
    readBinary: jest.fn(),
  };

  const connectedIO = (): ChrisIO => {
    const chrisIO: ChrisIO = io();
    chrisIO.storageProvider_set(storage as never);
    posted = [];
    cube_fake();
    mockClientGet.mockResolvedValue(uploadClient());
    return chrisIO;
  };

  it('uploads a single file into its remote directory', async () => {
    storage.isDirectory.mockResolvedValue(false);
    storage.readBinary.mockResolvedValue(new TextEncoder().encode('data').buffer);
    expect(await connectedIO().uploadLocalPath('/local/a.txt', '/home/chris/a.txt')).toBe(true);
  });

  it('recurses into a directory with cp semantics', async () => {
    storage.isDirectory.mockResolvedValueOnce(true).mockResolvedValue(false);
    storage.readdir.mockResolvedValue(['x.txt', 'y.txt']);
    storage.readBinary.mockResolvedValue(new TextEncoder().encode('d').buffer);
    expect(await connectedIO().uploadLocalPath('/local/dir', '/home/chris')).toBe(true);
    expect(storage.readdir).toHaveBeenCalledWith('/local/dir');
  });

  it('fails when a local file cannot be read', async () => {
    storage.isDirectory.mockResolvedValue(false);
    storage.readBinary.mockResolvedValue(null);
    expect(await connectedIO().uploadLocalPath('/local/a.txt', '/x/a.txt')).toBe(false);
  });

  it('fails without a storage provider', async () => {
    expect(await io().uploadLocalPath('/a', '/b')).toBe(false);
    expect(pushSpy).toHaveBeenCalledWith('error', expect.stringContaining('Storage provider'));
  });
});
