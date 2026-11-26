/**
 * @file Tests for ChRISConnection: connect/token lifecycle, context
 * switching, client creation and logout. The adapter lifecycle, config and
 * context modules are mocked at their seams; a fake storage provider holds
 * the token.
 */

jest.mock('../src/chrisapi/adapter', () => ({
  ...jest.requireActual('../src/chrisapi/adapter'),
  authToken_get: jest.fn(),
  client_create: jest.fn(),
  token_verify: jest.fn(),
}));
jest.mock('../src/config/config', () => ({
  config_init: jest.fn(),
  // connection_connect re-reads the global config after init; give it the
  // same shape as the per-instance fake so the token lands in /cfg/token.
  connectionConfig: {
    tokenFilepath: '/cfg/token',
    context_set: jest.fn(async () => undefined),
    chrisURL_load: jest.fn(async () => 'https://cube/api/v1/'),
  },
}));
jest.mock('../src/context/chrisContext', () => ({
  chrisContextURL_parse: jest.fn(),
  chrisContext: { current_set: jest.fn() },
  Context: {
    ChRISuser: 'user', ChRISURL: 'url', ChRISfolder: 'folder',
    ChRISfeed: 'feed', ChRISplugin: 'plugin',
  },
}));
jest.mock('../src/io/chrisIO', () => ({
  chrisIO: { storageProvider_set: jest.fn() },
}));

import { authToken_get, client_create, token_verify } from '../src/chrisapi/adapter';
import { chrisContextURL_parse, chrisContext } from '../src/context/chrisContext';
import { ChRISConnection, chrisConnection_init } from '../src/connect/chrisConnection';
import { errorStack } from '../src/error/errorStack';
import { ConnectionConfig } from '../src/config/config';
import { IStorageProvider } from '../src/io/io';

const mockAuthToken: jest.Mock = authToken_get as unknown as jest.Mock;
const mockClientCreate: jest.Mock = client_create as unknown as jest.Mock;
const mockTokenVerify: jest.Mock = token_verify as unknown as jest.Mock;
const mockParse: jest.Mock = chrisContextURL_parse as unknown as jest.Mock;
const mockContextSet: jest.Mock = chrisContext.current_set as unknown as jest.Mock;

interface FakeStore { files: Record<string, string> }

const storage_make = (store: FakeStore): IStorageProvider => ({
  read: jest.fn(async (path: string) => {
    if (!(path in store.files)) throw new Error('ENOENT');
    return store.files[path];
  }),
  write: jest.fn(async (path: string, data: string) => { store.files[path] = data; }),
  remove: jest.fn(async (path: string) => { delete store.files[path]; }),
} as unknown as IStorageProvider);

const config_make = (): ConnectionConfig => ({
  tokenFilepath: '/cfg/token',
  context_set: jest.fn(async () => undefined),
  chrisURL_load: jest.fn(async () => 'https://cube/api/v1/'),
} as unknown as ConnectionConfig);

const connection_make = (store: FakeStore, probed: string | null = null): ChRISConnection => {
  const conn: ChRISConnection = new ChRISConnection(config_make(), storage_make(store));
  // A failed login asks the network once; here the network says what the test says.
  conn.loginProbe = async (): Promise<string | null> => probed;
  return conn;
};

/** chrisapi's error for a request with no response: the network's code is gone. */
const noResponse = (): Error => Object.assign(new Error('No server response!'), { request: {} });

/** What the operator read on stderr. */
const said = (): string => errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');

let logSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  errorStack.type_clear('error');
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe('a token on disk is its owner\'s alone', () => {
  it('is written through the store\'s private write when it has one, and tightened before it is read', async () => {
    const { mkdtempSync, statSync, writeFileSync, chmodSync, mkdirSync, rmSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { NodeStorageProvider } = await import('../src/io/node_io');
    const root: string = mkdtempSync(join(tmpdir(), 'cumin-token-'));
    const mode_of = (target: string): number => statSync(target).mode & 0o777;
    try {
      const store = new NodeStorageProvider();
      const file: string = join(root, 'context', 'user_token.txt');
      await store.writePrivate(file, 'TOKEN');
      expect(readFileSync(file, 'utf8')).toBe('TOKEN');
      expect(mode_of(file)).toBe(0o600);
      expect(mode_of(join(root, 'context'))).toBe(0o700);
      // One written before, readable by anyone, is made private by a write and by a tighten alike.
      const old: string = join(root, 'old', 'user_token.txt');
      mkdirSync(join(root, 'old'), { mode: 0o755 });
      writeFileSync(old, 'OLD', { mode: 0o644 });
      chmodSync(join(root, 'old'), 0o755);
      chmodSync(old, 0o644);
      await store.private_tighten(old);
      expect(mode_of(old)).toBe(0o600);
      expect(mode_of(join(root, 'old'))).toBe(0o700);
      chmodSync(old, 0o644);
      await store.writePrivate(old, 'NEW');
      expect(mode_of(old)).toBe(0o600);
      expect(readFileSync(old, 'utf8')).toBe('NEW');
      // A file that is not there is no error.
      await expect(store.private_tighten(join(root, 'none', 'x'))).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('connection_connect', () => {
  it('authenticates, saves the token, and returns it', async () => {
    const store: FakeStore = { files: {} };
    const conn: ChRISConnection = connection_make(store);
    mockAuthToken.mockResolvedValue('TOKEN');
    const token: string | null = await conn.connection_connect({
      user: 'chris', password: 'pw', debug: false, url: 'https://cube/api/v1/',
    });
    expect(token).toBe('TOKEN');
    expect(mockAuthToken).toHaveBeenCalledWith('https://cube/api/v1/auth-token/', 'chris', 'pw');
    expect(store.files['/cfg/token']).toBe('TOKEN');
    expect(conn.connection_isConnected()).toBe(true);
  });

  it('saves the token through the store\'s private write when the store has one, and never says the token when the save fails', async () => {
    const store: FakeStore = { files: {} };
    const privately: string[] = [];
    const conn: ChRISConnection = connection_make(store);
    const storage = (conn as unknown as { storageProvider: IStorageProvider & { writePrivate?: (path: string, data: string) => Promise<void> } }).storageProvider;
    storage.writePrivate = async (path: string, data: string): Promise<void> => { privately.push(path); store.files[path] = data; };
    mockAuthToken.mockResolvedValue('TOKEN-SECRET');
    await conn.connection_connect({ user: 'chris', password: 'pw', debug: false, url: 'https://cube/api/v1/' });
    expect(privately).toEqual(['/cfg/token']);
    expect(storage.write).not.toHaveBeenCalledWith('/cfg/token', expect.anything());
    storage.writePrivate = async (): Promise<void> => { throw new Error('disk full'); };
    const said: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...parts: unknown[]): void => { said.push(parts.map(String).join(' ')); });
    try {
      await conn.connection_connect({ user: 'chris', password: 'pw', debug: false, url: 'https://cube/api/v1/' });
    } finally {
      spy.mockRestore();
    }
    expect(said.join('\n')).toContain('disk full');
    expect(said.join('\n')).not.toContain('TOKEN-SECRET');
  });

  it('returns null when no token is issued', async () => {
    const conn: ChRISConnection = connection_make({ files: {} });
    mockAuthToken.mockResolvedValue(null);
    expect(await conn.connection_connect({
      user: 'chris', password: 'pw', debug: false, url: 'https://cube/api/v1/',
    })).toBeNull();
  });

  it('rethrows auth errors in debug mode', async () => {
    const conn: ChRISConnection = connection_make({ files: {} });
    mockAuthToken.mockRejectedValue(new Error('bad credentials'));
    await expect(conn.connection_connect({
      user: 'chris', password: 'wrong', debug: true, url: 'https://cube/api/v1/',
    })).rejects.toThrow('bad credentials');
  });

  it('exits the process on auth errors outside debug mode', async () => {
    const conn: ChRISConnection = connection_make({ files: {} });
    mockAuthToken.mockRejectedValue(new Error('bad credentials'));
    const exitSpy: jest.SpyInstance = jest.spyOn(process, 'exit')
      .mockImplementation((() => { throw new Error('EXIT'); }) as never);
    await expect(conn.connection_connect({
      user: 'chris', password: 'wrong', debug: false, url: 'https://cube/api/v1/',
    })).rejects.toThrow('EXIT');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe('a failed login says what failed (#965)', () => {
  const login = async (conn: ChRISConnection): Promise<void> => {
    const exitSpy: jest.SpyInstance = jest.spyOn(process, 'exit').mockImplementation((() => { throw new Error('EXIT'); }) as never);
    await expect(conn.connection_connect({ user: 'chris', password: 'pw', debug: false, url: 'https://cube.example.org/api/v1/' })).rejects.toThrow('EXIT');
    exitSpy.mockRestore();
  };

  it('an untrusted certificate names the certificate and NODE_EXTRA_CA_CERTS, never the credentials', async () => {
    mockAuthToken.mockRejectedValue(noResponse());
    await login(connection_make({ files: {} }, 'SELF_SIGNED_CERT_IN_CHAIN'));
    expect(said()).toMatch(/TLS certificate of cube\.example\.org is not trusted \(SELF_SIGNED_CERT_IN_CHAIN\)/);
    expect(said()).toContain('NODE_EXTRA_CA_CERTS');
    expect(said()).not.toMatch(/password|credentials|NODE_TLS_REJECT_UNAUTHORIZED/);
  });

  it('an unreachable CUBE says it could not be reached', async () => {
    mockAuthToken.mockRejectedValue(noResponse());
    await login(connection_make({ files: {} }, 'ENOTFOUND'));
    expect(said()).toMatch(/Could not reach https:\/\/cube\.example\.org\/api\/v1\/ \(ENOTFOUND\)/);
  });

  it('CUBE refusing the credentials still blames the credentials, without asking the network', async () => {
    mockAuthToken.mockRejectedValue(Object.assign(new Error('Unable to log in with provided credentials.'), { response: { status: 400 } }));
    const conn: ChRISConnection = connection_make({ files: {} });
    const probe: jest.Mock = jest.fn(async () => null);
    conn.loginProbe = probe;
    await login(conn);
    expect(said()).toMatch(/refused the login \(HTTP 400\): the username or password is not right/);
    expect(probe).not.toHaveBeenCalled();
  });

  it('anything else prints the error itself', async () => {
    mockAuthToken.mockRejectedValue(new Error('CUBE is in maintenance'));
    await login(connection_make({ files: {} }, null));
    expect(said()).toContain('Could not log in to https://cube.example.org/api/v1/: CUBE is in maintenance');
  });

  it('a token login that meets a certificate problem says so instead of "refused the token"', async () => {
    mockClientCreate.mockReturnValue({});
    mockTokenVerify.mockRejectedValue(noResponse());
    const outcome = await connection_make({ files: {} }, 'CERT_HAS_EXPIRED').connection_connectWithToken({ user: 'chris', url: 'https://cube.example.org/api/v1/', token: 'T' });
    expect(outcome.connected).toBe(false);
    expect((outcome as { reason: string }).reason).toMatch(/not trusted \(CERT_HAS_EXPIRED\)/);
  });
});

describe('connection_connectWithToken', () => {
  const options = { user: 'chris', url: 'https://cube/api/v1/', token: 'MINTED' };

  it('proves the token, then saves it and takes the identity', async () => {
    const store: FakeStore = { files: {} };
    const conn: ChRISConnection = connection_make(store);
    mockClientCreate.mockReturnValue({});
    mockTokenVerify.mockResolvedValue(undefined);
    await expect(conn.connection_connectWithToken(options)).resolves.toEqual({ connected: true });
    expect(mockClientCreate).toHaveBeenCalledWith('https://cube/api/v1/', 'MINTED');
    expect(mockTokenVerify).toHaveBeenCalledWith('https://cube/api/v1/', 'MINTED');
    expect(store.files['/cfg/token']).toBe('MINTED');
    expect(conn.connection_isConnected()).toBe(true);
    expect(mockAuthToken).not.toHaveBeenCalled();
  });

  it('keeps the folder lookups memoised on the client it takes, as client_get makes them', async () => {
    const lookup: jest.Mock = jest.fn(async (path: string) => ({ data: { path } }));
    mockClientCreate.mockReturnValue({ getFileBrowserFolderByPath: lookup });
    mockTokenVerify.mockResolvedValue(undefined);
    const conn: ChRISConnection = connection_make({ files: {} });
    await conn.connection_connectWithToken(options);
    const client = (await conn.client_get()) as unknown as { getFileBrowserFolderByPath: (p: string) => Promise<unknown> };
    await client.getFileBrowserFolderByPath('/home/chris/token-boot');
    await client.getFileBrowserFolderByPath('/home/chris/token-boot');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('refuses in the outcome, writes nothing, and leaves the error stack clean', async () => {
    const store: FakeStore = { files: {} };
    const conn: ChRISConnection = connection_make(store);
    mockClientCreate.mockReturnValue({});
    mockTokenVerify.mockRejectedValue(Object.assign(new Error('401 Unauthorized'), { response: { status: 401 } }));
    const outcome = await conn.connection_connectWithToken(options);
    expect(outcome.connected).toBe(false);
    expect(outcome.reason).toContain('refused the token for chris');
    expect(outcome.reason).toContain('401 Unauthorized');
    expect(store.files).toEqual({});
    expect(conn.connection_isConnected()).toBe(false);
    expect(errorStack.messagesOfType_has('error')).toBe(false);
  });

  it('a CUBE that does not answer the check is said to be silent, never to have refused the token', async () => {
    const store: FakeStore = { files: {} };
    const conn: ChRISConnection = connection_make(store, null);
    mockClientCreate.mockReturnValue({});
    mockTokenVerify.mockRejectedValue(new Error('No server response!'));
    const outcome = await conn.connection_connectWithToken(options);
    expect(outcome.connected).toBe(false);
    expect(outcome.reason).toBe('https://cube/api/v1/ did not answer the token check for chris within 30 s; CUBE may be busy, try again');
    expect(store.files).toEqual({});
  });
});

describe('token and URL access', () => {
  it('loads the token from storage on demand', async () => {
    const conn: ChRISConnection = connection_make({ files: { '/cfg/token': 'STORED' } });
    expect(await conn.authToken_get()).toBe('STORED');
  });

  it('yields null when no token is stored', async () => {
    const conn: ChRISConnection = connection_make({ files: {} });
    expect(await conn.authToken_get()).toBeNull();
    expect(conn.connection_isConnected()).toBe(false);
  });

  it('loads the ChRIS URL from config when unset', async () => {
    const conn: ChRISConnection = connection_make({ files: {} });
    expect(await conn.chrisURL_get()).toBe('https://cube/api/v1/');
  });

  it('yields null for the URL when config is uninitialized', async () => {
    const conn: ChRISConnection = new ChRISConnection();
    expect(await conn.chrisURL_get()).toBeNull();
  });
});

describe('client creation', () => {
  it('creates a client once token and URL resolve', async () => {
    const conn: ChRISConnection = connection_make({ files: { '/cfg/token': 'TOK' } });
    const fake: object = { fake: true };
    mockClientCreate.mockReturnValue(fake);
    expect(await conn.client_get()).toBe(fake);
    expect(mockClientCreate).toHaveBeenCalledWith('https://cube/api/v1/', 'TOK');
    // Second call reuses the cached client.
    expect(await conn.client_get()).toBe(fake);
    expect(mockClientCreate).toHaveBeenCalledTimes(1);
  });

  it('returns null without a stored token', async () => {
    const conn: ChRISConnection = connection_make({ files: {} });
    expect(await conn.client_get()).toBeNull();
  });

  it('refreshes the client from current context', async () => {
    const conn: ChRISConnection = connection_make({ files: { '/cfg/token': 'TOK2' } });
    const fake: object = { refreshed: true };
    mockClientCreate.mockReturnValue(fake);
    expect(await conn.client_refresh()).toBe(fake);
  });
});

describe('elevation_runWithCredentials', () => {
  it('scopes an elevated client to one operation without changing stored session state', async () => {
    const store: FakeStore = { files: { '/cfg/token': 'NORMAL' } };
    const conn: ChRISConnection = connection_make(store);
    const normalClient: object = { identity: 'normal' };
    const elevatedClient: object = { identity: 'elevated' };
    mockClientCreate
      .mockReturnValueOnce(normalClient)
      .mockReturnValueOnce(elevatedClient);
    mockAuthToken.mockResolvedValue('ELEVATED');
    expect(await conn.client_get()).toBe(normalClient);

    await expect(conn.elevation_runWithCredentials(
      { username: 'admin', password: 'secret' },
      async (): Promise<object | null> => await conn.client_get(),
    )).resolves.toBe(elevatedClient);

    expect(mockAuthToken).toHaveBeenCalledWith('https://cube/api/v1/auth-token/', 'admin', 'secret');
    expect(await conn.client_get()).toBe(normalClient);
    expect(store.files['/cfg/token']).toBe('NORMAL');
  });

  it('restores the normal client when elevated work throws', async () => {
    const conn: ChRISConnection = connection_make({ files: { '/cfg/token': 'NORMAL' } });
    const normalClient: object = { identity: 'normal' };
    const elevatedClient: object = { identity: 'elevated' };
    mockClientCreate
      .mockReturnValueOnce(normalClient)
      .mockReturnValueOnce(elevatedClient);
    mockAuthToken.mockResolvedValue('ELEVATED');
    expect(await conn.client_get()).toBe(normalClient);

    await expect(conn.elevation_runWithCredentials(
      { username: 'admin', password: 'secret' },
      async (): Promise<void> => { throw new Error('operation failed'); },
    )).rejects.toThrow('operation failed');

    expect(await conn.client_get()).toBe(normalClient);
  });

  it('keeps a concurrent normal operation on its normal client', async () => {
    const conn: ChRISConnection = connection_make({ files: { '/cfg/token': 'NORMAL' } });
    const normalClient: object = { identity: 'normal' };
    const elevatedClient: object = { identity: 'elevated' };
    let releaseElevatedWork: (() => void) | undefined;
    const elevatedWorkContinue: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseElevatedWork = resolve;
    });
    mockClientCreate
      .mockReturnValueOnce(normalClient)
      .mockReturnValueOnce(elevatedClient);
    mockAuthToken.mockResolvedValue('ELEVATED');
    expect(await conn.client_get()).toBe(normalClient);

    let beginElevatedWork: (() => void) | undefined;
    const elevatedStarted: Promise<void> = new Promise<void>((resolve: () => void): void => {
      beginElevatedWork = resolve;
    });
    const elevatedOperation: Promise<object | null> = conn.elevation_runWithCredentials(
      { username: 'admin', password: 'secret' },
      async (): Promise<object | null> => {
        beginElevatedWork?.();
        await elevatedWorkContinue;
        return await conn.client_get();
      },
    );

    await elevatedStarted;
    expect(await conn.client_get()).toBe(normalClient);
    releaseElevatedWork?.();
    await expect(elevatedOperation).resolves.toBe(elevatedClient);
  });
});

describe('context_set', () => {
  it('applies user, URL and folder from a parsed context and refreshes', async () => {
    const conn: ChRISConnection = connection_make({ files: { '/cfg/token': 'T' } });
    mockParse.mockResolvedValue({
      user: 'chris', URL: 'https://cube/api/v1/', folder: '/home/chris',
      feed: null, plugin: null,
    });
    mockContextSet.mockResolvedValue(true);
    mockClientCreate.mockReturnValue({});
    expect(await conn.context_set('chris@https://cube/api/v1/?folder=/home/chris')).toBe(true);
    expect(mockContextSet).toHaveBeenCalledWith('user', 'chris');
    expect(mockContextSet).toHaveBeenCalledWith('url', 'https://cube/api/v1/');
    expect(mockContextSet).toHaveBeenCalledWith('folder', '/home/chris');
  });

  it('applies feed and plugin context values', async () => {
    const conn: ChRISConnection = connection_make({ files: {} });
    mockParse.mockResolvedValue({ user: null, URL: null, folder: null, feed: '9', plugin: '4' });
    mockContextSet.mockResolvedValue(true);
    expect(await conn.context_set('?feed=9&plugin=4')).toBe(true);
    expect(mockContextSet).toHaveBeenCalledWith('feed', '9');
    expect(mockContextSet).toHaveBeenCalledWith('plugin', '4');
  });

  it('fails fast when parsing pushed an error', async () => {
    const conn: ChRISConnection = connection_make({ files: {} });
    mockParse.mockImplementation(async () => {
      errorStack.stack_push('error', 'bad context string');
      return { user: null, URL: null, folder: null, feed: null, plugin: null };
    });
    expect(await conn.context_set('nonsense')).toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('connection_logout', () => {
  it('clears the token from storage', async () => {
    const store: FakeStore = { files: { '/cfg/token': 'T' } };
    const conn: ChRISConnection = connection_make(store);
    await conn.authToken_get();
    await conn.connection_logout();
    expect(store.files['/cfg/token']).toBeUndefined();
    expect(conn.connection_isConnected()).toBe(false);
  });

  it('reports but survives a storage failure', async () => {
    const conn: ChRISConnection = new ChRISConnection(config_make(), {
      read: jest.fn(), write: jest.fn(),
      remove: jest.fn(async () => { throw new Error('EIO'); }),
    } as unknown as IStorageProvider);
    await conn.connection_logout();
    expect(errSpy).toHaveBeenCalledWith('Error during logout:', expect.any(Error));
  });
});

describe('chrisConnection_init', () => {
  it('initializes the global connection with the storage provider', async () => {
    const conn: ChRISConnection = await chrisConnection_init(storage_make({ files: {} }));
    expect(conn).toBeInstanceOf(ChRISConnection);
  });
});
