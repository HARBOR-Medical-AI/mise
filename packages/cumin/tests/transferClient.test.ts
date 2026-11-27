/**
 * @file Whose client carries a transfer.
 *
 * The session's one file adapter (`chrisIO`) and its one connection are
 * driven as they are in use: a user connects, downloads; a second connects,
 * downloads; the first connects again, downloads. Each client the
 * connection makes is a double of the SDK's that records the file lookups
 * and the byte reads made of it. A download made after a change of user
 * must reach the client of whoever is connected then, and no other.
 */

jest.mock('../src/chrisapi/adapter', () => ({
  ...jest.requireActual('../src/chrisapi/adapter'),
  authToken_get: jest.fn(),
  client_create: jest.fn(),
  token_verify: jest.fn(),
}));
jest.mock('../src/config/config', () => ({
  config_init: jest.fn(),
  connectionConfig: {
    tokenFilepath: '/cfg/token',
    context_set: jest.fn(async () => undefined),
    chrisURL_load: jest.fn(async () => 'https://cube/api/v1/'),
  },
}));
jest.mock('../src/context/chrisContext', () => ({
  chrisContextURL_parse: jest.fn(),
  chrisContext: { current_set: jest.fn() },
  Context: { ChRISuser: 'user', ChRISURL: 'url', ChRISfolder: 'folder', ChRISfeed: 'feed', ChRISplugin: 'plugin' },
}));

import { authToken_get, client_create } from '../src/chrisapi/adapter';
import { chrisConnection } from '../src/connect/chrisConnection';
import { connectionConfig } from '../src/config/config';
import { chrisIO } from '../src/io/chrisIO';
import { IStorageProvider } from '../src/io/io';

const mockAuthToken: jest.Mock = authToken_get as unknown as jest.Mock;
const mockClientCreate: jest.Mock = client_create as unknown as jest.Mock;

/** A double of the SDK's client for one user: it records each file looked up and each read of bytes. */
interface ClientDouble {
  /** The ids of the files looked up through it. */
  looked: number[];
  /** The ids of the files whose bytes were read through it. */
  read: number[];
  /** The SDK's file lookup. */
  getUserFile: (id: number) => Promise<{ data: { id: number }; getFileBlob: () => Promise<string> }>;
}

/**
 * Makes a client double for a user.
 *
 * @param who - Whose client it is; the bytes it serves say so.
 * @returns The double.
 */
function double_make(who: string): ClientDouble {
  const looked: number[] = [];
  const read: number[] = [];
  return {
    looked,
    read,
    getUserFile: async (id: number) => {
      looked.push(id);
      return { data: { id }, getFileBlob: async (): Promise<string> => { read.push(id); return `file ${String(id)} as served to ${who}`; } };
    },
  };
}

describe('a transfer is carried by the client of whoever is connected when it is made', () => {
  let errSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('first, then second, then first again: the last download reaches the first\'s new client, and the second\'s is asked nothing more', async () => {
    const files: Record<string, string> = {};
    const storage = {
      read: async (path: string): Promise<string> => { if (!(path in files)) throw new Error('ENOENT'); return files[path] as string; },
      write: async (path: string, data: string): Promise<void> => { files[path] = data; },
      remove: async (path: string): Promise<void> => { delete files[path]; },
    } as unknown as IStorageProvider;
    // The session's own connection and its own adapter: the instances every caller shares.
    chrisConnection.init(connectionConfig, storage);
    chrisConnection.loginProbe = async (): Promise<string | null> => null;
    const first: ClientDouble = double_make('the first');
    const second: ClientDouble = double_make('the second');
    const firstAgain: ClientDouble = double_make('the first, again');
    mockClientCreate.mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(firstAgain);
    const connect = async (user: string, token: string): Promise<void> => {
      mockAuthToken.mockResolvedValue(token);
      expect(await chrisConnection.connection_connect({ user, password: 'pw', debug: false, url: 'https://cube/api/v1/' })).toBe(token);
    };

    await connect('first', 'FIRST');
    expect((await chrisIO.file_download(11))?.toString()).toBe('file 11 as served to the first');

    await connect('second', 'SECOND');
    expect((await chrisIO.file_download(22))?.toString()).toBe('file 22 as served to the second');
    const secondAsked: { looked: number[]; read: number[] } = { looked: [...second.looked], read: [...second.read] };

    await connect('first', 'FIRST-AGAIN');
    // The second's file, asked for as the first: the first's new client is the one asked.
    expect((await chrisIO.file_download(22))?.toString()).toBe('file 22 as served to the first, again');
    expect(firstAgain.looked).toEqual([22]);
    expect(firstAgain.read).toEqual([22]);
    // The second's client heard nothing after the first connected again; nor did the first's old one.
    expect({ looked: second.looked, read: second.read }).toEqual(secondAsked);
    expect(secondAsked).toEqual({ looked: [22], read: [22] });
    expect(first.looked).toEqual([11]);
    expect(first.read).toEqual([11]);
    expect(mockClientCreate.mock.calls.map((call: unknown[]): unknown => call[1])).toEqual(['FIRST', 'SECOND', 'FIRST-AGAIN']);
  });
});
