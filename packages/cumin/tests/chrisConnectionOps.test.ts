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
import { identityCache_usable, identityChange_listen, identityEpoch_get } from '../src/connect/identityEpoch';
import { errorStack } from '../src/error/errorStack';
import { ConnectionConfig } from '../src/config/config';
import { IStorageProvider } from '../src/io/io';

// Anything kept "in the default place" on a change of identity goes to a folder of this file's own.
process.env['XDG_CACHE_HOME'] = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'connection-cache-')) as string;

import { connectionConfig as globalConfig } from '../src/config/config';

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
      // A rewrite never puts the new token into the old, looser file: a new private file takes its place.
      const before: number = statSync(old).ino;
      await store.writePrivate(old, 'NEW');
      expect(mode_of(old)).toBe(0o600);
      expect(readFileSync(old, 'utf8')).toBe('NEW');
      expect(statSync(old).ino).not.toBe(before);
      expect((await import('node:fs')).readdirSync(join(root, 'old'))).toEqual(['user_token.txt']);
      // Where the folder cannot be had at all, nothing is written and the failure is said.
      writeFileSync(join(root, 'blocked'), 'a file where a folder should be');
      await expect(store.writePrivate(join(root, 'blocked', 'user_token.txt'), 'NEVER')).rejects.toThrow();
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
    // And it is not claimed saved: the session holds it, the disk does not.
    const told: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...parts: unknown[]): void => { told.push(parts.map(String).join(' ')); });
    const quiet = jest.spyOn(console, 'error').mockImplementation((): void => undefined);
    try {
      await conn.connection_connect({ user: 'chris', password: 'pw', debug: false, url: 'https://cube/api/v1/' });
    } finally {
      log.mockRestore();
      quiet.mockRestore();
    }
    expect(told).toContain('Auth token held for this session; it was not saved');
    expect(told).not.toContain('Auth token saved successfully');
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

describe('who is connected', () => {
  it('a password login drops the client made for whoever was connected before, and is a change of identity', async () => {
    const conn: ChRISConnection = connection_make({ files: { '/cfg/token': 'FIRST' } });
    const first: object = { of: 'the first' };
    const second: object = { of: 'the second' };
    mockClientCreate.mockReturnValueOnce(first).mockReturnValueOnce(second);
    expect(await conn.client_get()).toBe(first);
    const before: number = identityEpoch_get();
    mockAuthToken.mockResolvedValue('SECOND');
    await conn.connection_connect({ user: 'other', password: 'pw', debug: false, url: 'https://cube/api/v1/' });
    expect(identityEpoch_get()).toBe(before + 1);
    expect(await conn.client_get()).toBe(second);
    expect(mockClientCreate).toHaveBeenLastCalledWith('https://cube/api/v1/', 'SECOND');
  });

  it('a token login is a change of identity, with a client of its own', async () => {
    const conn: ChRISConnection = connection_make({ files: { '/cfg/token': 'FIRST' } });
    const first: object = { of: 'the first' };
    const second: object = { of: 'the second' };
    mockClientCreate.mockReturnValueOnce(first).mockReturnValueOnce(second);
    expect(await conn.client_get()).toBe(first);
    const before: number = identityEpoch_get();
    mockTokenVerify.mockResolvedValue(undefined);
    expect(await conn.connection_connectWithToken({ user: 'other', url: 'https://cube/api/v1/', token: 'SECOND' })).toEqual({ connected: true });
    expect(identityEpoch_get()).toBe(before + 1);
    expect(await conn.client_get()).toBe(second);
  });

  it('a refused token login changes nothing: the client and the epoch are as they were', async () => {
    const conn: ChRISConnection = connection_make({ files: { '/cfg/token': 'FIRST' } });
    const first: object = { of: 'the first' };
    mockClientCreate.mockReturnValue(first);
    expect(await conn.client_get()).toBe(first);
    const before: number = identityEpoch_get();
    mockTokenVerify.mockRejectedValue(Object.assign(new Error('Unauthorized'), { response: { status: 401 } }));
    expect((await conn.connection_connectWithToken({ user: 'other', url: 'https://cube/api/v1/', token: 'BAD' })).connected).toBe(false);
    expect(identityEpoch_get()).toBe(before);
    expect(await conn.client_get()).toBe(first);
  });

  it('logout leaves no client, and is a change of identity', async () => {
    const store: FakeStore = { files: { '/cfg/token': 'T' } };
    const conn: ChRISConnection = connection_make(store);
    mockClientCreate.mockReturnValue({ of: 'the one who logs out' });
    expect(await conn.client_get()).not.toBeNull();
    const before: number = identityEpoch_get();
    await conn.connection_logout();
    expect(identityEpoch_get()).toBe(before + 1);
    // Nothing on disk and nothing kept: nobody is connected.
    expect(await conn.client_get()).toBeNull();
  });

  it('a context that names another user is a change of identity; the same user named again is not', async () => {
    const conn: ChRISConnection = connection_make({ files: { '/cfg/token': 'T' } });
    mockContextSet.mockResolvedValue(true);
    mockClientCreate.mockReturnValue({});
    mockParse.mockResolvedValue({ user: 'chris', URL: 'https://cube/api/v1/', folder: null, feed: null, plugin: null });
    await conn.context_set('chris@https://cube/api/v1/');
    const settled: number = identityEpoch_get();
    await conn.context_set('chris@https://cube/api/v1/');
    expect(identityEpoch_get()).toBe(settled);
    mockParse.mockResolvedValue({ user: 'other', URL: 'https://cube/api/v1/', folder: null, feed: null, plugin: null });
    await conn.context_set('other@https://cube/api/v1/');
    expect(identityEpoch_get()).toBe(settled + 1);
    mockParse.mockResolvedValue({ user: 'other', URL: 'https://elsewhere/api/v1/', folder: null, feed: null, plugin: null });
    await conn.context_set('other@https://elsewhere/api/v1/');
    expect(identityEpoch_get()).toBe(settled + 2);
  });

  it('a refresh that finds no token leaves no client', async () => {
    const store: FakeStore = { files: { '/cfg/token': 'T' } };
    const conn: ChRISConnection = connection_make(store);
    mockClientCreate.mockReturnValue({ of: 'the first' });
    expect(await conn.client_refresh()).not.toBeNull();
    delete store.files['/cfg/token'];
    expect(await conn.client_refresh()).toBeNull();
  });

  it('work under sudo is marked as another user\'s for its own length', async () => {
    const conn: ChRISConnection = connection_make({ files: { '/cfg/token': 'NORMAL' } });
    mockClientCreate.mockReturnValue({});
    mockAuthToken.mockResolvedValue('ELEVATED');
    expect(identityCache_usable()).toBe(true);
    await expect(conn.elevation_runWithCredentials({ username: 'admin', password: 'secret' }, async (): Promise<boolean> => identityCache_usable())).resolves.toBe(false);
    expect(identityCache_usable()).toBe(true);
  });
});

describe('a change of who is connected is one step', () => {
  /** A promise and the hand that settles it. */
  function gate_make<T>(): { wait: Promise<T>; open: (value: T) => void; fail: (reason: Error) => void } {
    let open: (value: T) => void = (): void => undefined;
    let fail: (reason: Error) => void = (): void => undefined;
    const wait: Promise<T> = new Promise((resolve: (value: T) => void, reject: (reason: Error) => void): void => { open = resolve; fail = reject; });
    return { wait, open, fail };
  }

  it('while a password is being exchanged, whoever was connected is still wholly connected; then the new one wholly is', async () => {
    const conn: ChRISConnection = connection_make({ files: { '/cfg/token': 'FIRST' } });
    const first: object = { of: 'the first' };
    const second: object = { of: 'the second' };
    mockClientCreate.mockImplementation((_url: string, token: string): object => (token === 'FIRST' ? first : second));
    mockParse.mockResolvedValue({ user: 'first', URL: 'https://cube/api/v1/', folder: null, feed: null, plugin: null });
    mockContextSet.mockResolvedValue(true);
    await conn.context_set('first@https://cube/api/v1/');
    expect(await conn.client_get()).toBe(first);
    const exchanged = gate_make<string>();
    mockAuthToken.mockReturnValue(exchanged.wait);
    const before: number = identityEpoch_get();
    const login: Promise<string | null> = conn.connection_connect({ user: 'second', password: 'pw', debug: true, url: 'https://other/api/v1/' });
    await Promise.resolve(); await Promise.resolve();
    // CUBE has not answered: nothing has changed. The user, the CUBE, the client and the epoch are the first's.
    expect(await conn.user_get()).toBe('first');
    expect(await conn.chrisURL_get()).toBe('https://cube/api/v1/');
    expect(await conn.client_get()).toBe(first);
    expect(identityEpoch_get()).toBe(before);
    exchanged.open('SECOND');
    expect(await login).toBe('SECOND');
    expect(await conn.user_get()).toBe('second');
    expect(await conn.chrisURL_get()).toBe('https://other/api/v1/');
    expect(await conn.client_get()).toBe(second);
    expect(identityEpoch_get()).toBe(before + 1);
  });

  it('a refused password leaves whoever was connected as they were: user, CUBE, client and epoch', async () => {
    const conn: ChRISConnection = connection_make({ files: { '/cfg/token': 'FIRST' } });
    const first: object = { of: 'the first' };
    mockClientCreate.mockReturnValue(first);
    mockParse.mockResolvedValue({ user: 'first', URL: 'https://cube/api/v1/', folder: null, feed: null, plugin: null });
    mockContextSet.mockResolvedValue(true);
    await conn.context_set('first@https://cube/api/v1/');
    expect(await conn.client_get()).toBe(first);
    const before: number = identityEpoch_get();
    mockAuthToken.mockRejectedValue(Object.assign(new Error('Unauthorized'), { response: { status: 401 } }));
    await expect(conn.connection_connect({ user: 'second', password: 'wrong', debug: true, url: 'https://other/api/v1/' })).rejects.toThrow('Unauthorized');
    expect(await conn.user_get()).toBe('first');
    expect(await conn.chrisURL_get()).toBe('https://cube/api/v1/');
    expect(await conn.client_get()).toBe(first);
    expect(conn.connection_isConnected()).toBe(true);
    expect(identityEpoch_get()).toBe(before);
  });

  it('a read of the saved token that is still out at a logout does not bring the token back', async () => {
    const store: FakeStore = { files: { '/cfg/token': 'FIRST' } };
    const conn: ChRISConnection = connection_make(store);
    mockClientCreate.mockReturnValue({ of: 'the first' });
    expect(await conn.client_get()).not.toBeNull();
    // A forced read of the token is begun, and the disk is slow.
    const read = gate_make<string>();
    const storage = (conn as unknown as { storageProvider: { read: jest.Mock } }).storageProvider;
    storage.read.mockImplementationOnce(() => read.wait);
    const reading: Promise<string | null> = conn.authToken_get(true);
    await Promise.resolve(); await Promise.resolve();
    const before: number = identityEpoch_get();
    await conn.connection_logout();
    read.open('FIRST');
    await reading;
    // Nobody is connected: the token read from before the logout was not taken.
    expect(conn.connection_isConnected()).toBe(false);
    expect(await conn.client_get()).toBeNull();
    expect(identityEpoch_get()).toBe(before + 1);
  });

  it('a login still writing its token and a logout asked for meanwhile happen in that order: nobody is connected after, and no token is left for them', async () => {
    // Each identity's token is kept in a file of its own, as the real configuration keeps them.
    const store: FakeStore = { files: { '/cfg/first.token': 'FIRST' } };
    const config = { tokenFilepath: '/cfg/first.token', chrisURL_load: jest.fn(async () => 'https://cube/api/v1/'), context_set: jest.fn() } as unknown as ConnectionConfig & { tokenFilepath: string };
    const contextHeld = gate_make<void>();
    (config.context_set as unknown as jest.Mock).mockImplementation(async (user: string): Promise<void> => {
      // The second login's context is slow to be written; when it is, the token file is the second's.
      if (user === 'second') await contextHeld.wait;
      config.tokenFilepath = `/cfg/${user}.token`;
    });
    const conn: ChRISConnection = new ChRISConnection(config, storage_make(store));
    conn.loginProbe = async (): Promise<string | null> => null;
    mockClientCreate.mockImplementation((_url: string, token: string): object => ({ of: token }));
    mockAuthToken.mockResolvedValue('SECOND');
    const login: Promise<string | null> = conn.connection_connect({ user: 'second', password: 'pw', debug: true, url: 'https://cube/api/v1/' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    // A logout is asked for while the login is still writing.
    const logout: Promise<void> = conn.connection_logout();
    contextHeld.open();
    await login;
    await logout;
    // The login finished first, and the logout then ended it: its token is not on disk, and nobody is connected.
    expect(store.files['/cfg/second.token']).toBeUndefined();
    expect(conn.connection_isConnected()).toBe(false);
    expect(await conn.client_get()).toBeNull();
    // The first one's file was not the logout's to remove: it was no longer the connection's.
    expect(store.files['/cfg/first.token']).toBe('FIRST');
  });

  it('a login whose answer from CUBE comes after a logout was asked for signs nobody in; the first stays readable while CUBE is asked', async () => {
    const store: FakeStore = { files: { '/cfg/token': 'FIRST' } };
    const conn: ChRISConnection = connection_make(store);
    mockClientCreate.mockImplementation((_url: string, token: string): object => ({ of: token }));
    expect(await conn.client_get()).toEqual({ of: 'FIRST' });
    const answer = gate_make<string>();
    mockAuthToken.mockImplementation((): Promise<string> => answer.wait);
    const before: number = identityEpoch_get();
    const login: Promise<string | null> = conn.connection_connect({ user: 'second', password: 'pw', debug: true, url: 'https://cube/api/v1/' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    // CUBE has not answered: the first is still who is connected, and can be read.
    expect(await conn.client_get()).toEqual({ of: 'FIRST' });
    expect(identityEpoch_get()).toBe(before);
    // A logout is asked for, and finishes.
    await conn.connection_logout();
    expect(await conn.client_get()).toBeNull();
    const afterLogout: number = identityEpoch_get();
    // CUBE answers the login now.
    answer.open('SECOND');
    expect(await login).toBeNull();
    expect(conn.connection_isConnected()).toBe(false);
    expect(await conn.client_get()).toBeNull();
    expect(identityEpoch_get()).toBe(afterLogout);
    expect(Object.values(store.files)).not.toContain('SECOND');
  });

  it('of two logins asked one after the other, the later is who is connected, whichever CUBE answers first', async () => {
    const store: FakeStore = { files: {} };
    const conn: ChRISConnection = connection_make(store);
    mockClientCreate.mockImplementation((_url: string, token: string): object => ({ of: token }));
    const slow = gate_make<string>();
    mockAuthToken.mockImplementationOnce((): Promise<string> => slow.wait).mockResolvedValueOnce('LATER');
    const earlier: Promise<string | null> = conn.connection_connect({ user: 'earlier', password: 'pw', debug: true, url: 'https://cube/api/v1/' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(await conn.connection_connect({ user: 'later', password: 'pw', debug: true, url: 'https://cube/api/v1/' })).toBe('LATER');
    slow.open('EARLIER');
    expect(await earlier).toBeNull();
    expect(await conn.user_get()).toBe('later');
    expect(await conn.client_get()).toEqual({ of: 'LATER' });
  });

  it('a token login verified after a logout was asked for is not acted on', async () => {
    const conn: ChRISConnection = connection_make({ files: {} });
    const verified = gate_make<void>();
    mockTokenVerify.mockImplementation((): Promise<void> => verified.wait);
    const login = conn.connection_connectWithToken({ user: 'second', url: 'https://cube/api/v1/', token: 'SECOND' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await conn.connection_logout();
    verified.open();
    const outcome = await login;
    expect(outcome.connected).toBe(false);
    expect(conn.connection_isConnected()).toBe(false);
  });

  it('a move of context whose write fails leaves nobody connected and says the change', async () => {
    const conn: ChRISConnection = connection_make({ files: { '/cfg/token': 'T' } });
    mockClientCreate.mockReturnValue({ of: 'the first' });
    mockContextSet.mockResolvedValue(true);
    mockParse.mockResolvedValue({ user: 'chris', URL: 'https://cube/api/v1/', folder: null, feed: null, plugin: null });
    await conn.context_set('chris@https://cube/api/v1/');
    expect(await conn.client_get()).toEqual({ of: 'the first' });
    const before: number = identityEpoch_get();
    mockParse.mockResolvedValue({ user: 'other', URL: 'https://cube/api/v1/', folder: null, feed: null, plugin: null });
    mockContextSet.mockRejectedValueOnce(new Error('the disk is full'));
    await expect(conn.context_set('other@https://cube/api/v1/')).rejects.toThrow('the disk is full');
    // The caches were emptied (the change was said), and the one before's client is not kept under the new name.
    expect(identityEpoch_get()).toBe(before + 1);
    expect(conn.connection_isConnected()).toBe(false);
  });

  it('a logout asked for at once after a login, before the login has awaited anything, comes after it: nobody is connected', async () => {
    const store: FakeStore = { files: {} };
    const conn: ChRISConnection = connection_make(store);
    mockAuthToken.mockResolvedValue('SECOND');
    const login: Promise<string | null> = conn.connection_connect({ user: 'second', password: 'pw', debug: true, url: 'https://cube/api/v1/' });
    const logout: Promise<void> = conn.connection_logout();
    expect(await login).toBeNull();
    await logout;
    expect(conn.connection_isConnected()).toBe(false);
    expect(Object.values(store.files)).not.toContain('SECOND');
  });

  it('a refusal of an earlier login that comes back after a later login succeeded ends nothing and says nothing', async () => {
    const conn: ChRISConnection = connection_make({ files: {} });
    mockClientCreate.mockImplementation((_url: string, token: string): object => ({ of: token }));
    const refusal = gate_make<string>();
    mockAuthToken.mockImplementationOnce((): Promise<string> => refusal.wait).mockResolvedValueOnce('LATER');
    const earlier: Promise<string | null> = conn.connection_connect({ user: 'earlier', password: 'wrong', debug: true, url: 'https://cube/api/v1/' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(await conn.connection_connect({ user: 'later', password: 'pw', debug: true, url: 'https://cube/api/v1/' })).toBe('LATER');
    refusal.fail(new Error('CUBE answered 401'));
    // With `debug` a refusal is thrown; this one is nobody's any more.
    expect(await earlier).toBeNull();
    expect(await conn.user_get()).toBe('later');
    expect(await conn.client_get()).toEqual({ of: 'LATER' });
  });

  it('after a move of context whose write failed, the one before\'s saved token is not read back under the new name', async () => {
    const store: FakeStore = { files: { '/cfg/token': 'FIRST' } };
    const conn: ChRISConnection = connection_make(store);
    mockClientCreate.mockImplementation((_url: string, token: string): object => ({ of: token }));
    mockContextSet.mockResolvedValue(true);
    mockParse.mockResolvedValue({ user: 'chris', URL: 'https://cube/api/v1/', folder: null, feed: null, plugin: null });
    await conn.context_set('chris@https://cube/api/v1/');
    expect(await conn.client_get()).toEqual({ of: 'FIRST' });
    mockParse.mockResolvedValue({ user: 'other', URL: 'https://cube/api/v1/', folder: null, feed: null, plugin: null });
    mockContextSet.mockRejectedValueOnce(new Error('the disk is full'));
    await expect(conn.context_set('other@https://cube/api/v1/')).rejects.toThrow('the disk is full');
    // The first's token is still on disk, at the path still named.
    expect(store.files['/cfg/token']).toBe('FIRST');
    expect(await conn.authToken_get()).toBeNull();
    expect(await conn.authToken_get(true)).toBeNull();
    expect(await conn.client_get()).toBeNull();
    expect(await conn.client_refresh()).toBeNull();
    // Signing in makes the saved token readable again.
    mockAuthToken.mockResolvedValue('OTHER');
    await conn.connection_connect({ user: 'other', password: 'pw', debug: true, url: 'https://cube/api/v1/' });
    expect(await conn.authToken_get(true)).toBe('OTHER');
  });

  it('a logout whose token could not be removed stays logged out', async () => {
    const store: FakeStore = { files: { '/cfg/token': 'FIRST' } };
    const storage = storage_make(store);
    (storage.remove as unknown as jest.Mock).mockRejectedValueOnce(new Error('EACCES'));
    const conn: ChRISConnection = new ChRISConnection(config_make(), storage);
    mockClientCreate.mockImplementation((_url: string, token: string): object => ({ of: token }));
    expect(await conn.client_get()).toEqual({ of: 'FIRST' });
    const said = jest.spyOn(console, 'error').mockImplementation((): void => undefined);
    await conn.connection_logout();
    said.mockRestore();
    expect(store.files['/cfg/token']).toBe('FIRST');
    expect(await conn.authToken_get()).toBeNull();
    expect(await conn.authToken_get(true)).toBeNull();
    expect(await conn.client_get()).toBeNull();
    expect(await conn.client_refresh()).toBeNull();
  });

  let restore: () => void = (): void => undefined;
  afterEach((): void => { restore(); restore = (): void => undefined; });

  /** A configuration that keeps each user's token in a file of their own; a write of the context can be made to fail. */
  function pathsConfig_make(failFor: string | null = null): ConnectionConfig & { tokenFilepath: string } {
    const config = { tokenFilepath: '/cfg/first.token', chrisURL_load: jest.fn(async () => 'https://cube/api/v1/'), context_set: jest.fn() } as unknown as ConnectionConfig & { tokenFilepath: string };
    (config.context_set as unknown as jest.Mock).mockImplementation(async (user: string): Promise<void> => {
      if (user === failFor) throw new Error('the disk is full');
      config.tokenFilepath = `/cfg/${user}.token`;
    });
    return config;
  }

  it.each([['the earlier is read first', 'earlier'], ['the later is read first', 'later']])('of two moves of context asked together the later is made and the earlier\'s caller is told no, when %s', async (_name: string, readFirst: string) => {
    const conn: ChRISConnection = connection_make({ files: {} });
    mockContextSet.mockResolvedValue(true);
    const reads: Record<string, ReturnType<typeof gate_make<object>>> = { earlier: gate_make<object>(), later: gate_make<object>() };
    mockParse.mockImplementationOnce((): Promise<object> => reads['earlier']!.wait).mockImplementationOnce((): Promise<object> => reads['later']!.wait);
    const earlier: Promise<boolean> = conn.context_set('earlier@https://cube/api/v1/?folder=/home/earlier');
    const later: Promise<boolean> = conn.context_set('later@https://cube/api/v1/');
    const parsed: Record<string, object> = {
      earlier: { user: 'earlier', URL: 'https://cube/api/v1/', folder: '/home/earlier', feed: null, plugin: null },
      later: { user: 'later', URL: 'https://cube/api/v1/', folder: null, feed: null, plugin: null },
    };
    const second: string = readFirst === 'earlier' ? 'later' : 'earlier';
    reads[readFirst]!.open(parsed[readFirst]!);
    await new Promise((resolve) => { setImmediate(resolve); });
    reads[second]!.open(parsed[second]!);
    expect(await earlier).toBe(false);
    expect(await later).toBe(true);
    expect(await conn.user_get()).toBe('later');
    // Nothing of the earlier was written: not its user, and not its folder.
    expect(mockContextSet.mock.calls.map((call: unknown[]): unknown => call[1])).not.toContain('earlier');
    expect(mockContextSet.mock.calls.map((call: unknown[]): unknown => call[1])).not.toContain('/home/earlier');
  });

  it.each([['a password login', 'password'], ['a token login', 'token']])('%s whose context cannot be written is held for the session; the one before\'s token is not read, written or removed', async (_name: string, kind: string) => {
    const store: FakeStore = { files: { '/cfg/first.token': 'FIRST' } };
    // A login reads the process's own configuration again: that one is made to keep a file per user, and
    // to fail the second's write.
    const shared = globalConfig as unknown as { tokenFilepath: string; context_set: jest.Mock };
    shared.tokenFilepath = '/cfg/first.token';
    shared.context_set.mockImplementation(async (user: string): Promise<void> => {
      if (user === 'second') throw new Error('the disk is full');
      shared.tokenFilepath = `/cfg/${user}.token`;
    });
    restore = (): void => { shared.tokenFilepath = '/cfg/token'; shared.context_set.mockImplementation(async (): Promise<void> => undefined); };
    const conn: ChRISConnection = new ChRISConnection(pathsConfig_make('second'), storage_make(store));
    conn.loginProbe = async (): Promise<string | null> => null;
    mockClientCreate.mockImplementation((_url: string, token: string): object => ({ of: token }));
    expect(await conn.client_get()).toEqual({ of: 'FIRST' });
    const said = jest.spyOn(console, 'error').mockImplementation((): void => undefined);
    if (kind === 'password') {
      mockAuthToken.mockResolvedValue('SECOND');
      expect(await conn.connection_connect({ user: 'second', password: 'pw', debug: true, url: 'https://cube/api/v1/' })).toBe('SECOND');
    } else {
      mockTokenVerify.mockResolvedValue(undefined);
      expect((await conn.connection_connectWithToken({ user: 'second', url: 'https://cube/api/v1/', token: 'SECOND' })).connected).toBe(true);
    }
    said.mockRestore();
    // Signed in as the second, for this session; a refresh does not bring the first's token back.
    expect(await conn.authToken_get(true)).toBe('SECOND');
    expect(await conn.client_refresh()).toEqual({ of: 'SECOND' });
    expect(store.files).toEqual({ '/cfg/first.token': 'FIRST' });
    // Logging out ends the session's login and removes nothing of the first's.
    await conn.connection_logout();
    expect(await conn.authToken_get(true)).toBeNull();
    expect(await conn.client_refresh()).toBeNull();
    expect(store.files).toEqual({ '/cfg/first.token': 'FIRST' });
  });

  it('a logout after a move of context that failed removes nothing: the file still named is the one before\'s', async () => {
    const store: FakeStore = { files: { '/cfg/first.token': 'FIRST' } };
    const conn: ChRISConnection = new ChRISConnection(pathsConfig_make('second'), storage_make(store));
    mockClientCreate.mockImplementation((_url: string, token: string): object => ({ of: token }));
    mockContextSet.mockResolvedValue(true);
    expect(await conn.client_get()).toEqual({ of: 'FIRST' });
    mockParse.mockResolvedValue({ user: 'second', URL: 'https://cube/api/v1/', folder: null, feed: null, plugin: null });
    await expect(conn.context_set('second@https://cube/api/v1/')).rejects.toThrow('the disk is full');
    await conn.connection_logout();
    expect(store.files).toEqual({ '/cfg/first.token': 'FIRST' });
    expect(await conn.authToken_get(true)).toBeNull();
  });

  it('a move of context that failed once and is asked again signs in from the new identity\'s own saved token', async () => {
    const store: FakeStore = { files: { '/cfg/first.token': 'FIRST', '/cfg/second.token': 'SECOND' } };
    const config = pathsConfig_make();
    const conn: ChRISConnection = new ChRISConnection(config, storage_make(store));
    mockClientCreate.mockImplementation((_url: string, token: string): object => ({ of: token }));
    mockContextSet.mockResolvedValue(true);
    expect(await conn.client_get()).toEqual({ of: 'FIRST' });
    mockParse.mockResolvedValue({ user: 'second', URL: 'https://cube/api/v1/', folder: null, feed: null, plugin: null });
    (config.context_set as unknown as jest.Mock).mockRejectedValueOnce(new Error('the disk is full'));
    await expect(conn.context_set('second@https://cube/api/v1/')).rejects.toThrow('the disk is full');
    expect(await conn.client_get()).toBeNull();
    const names: Array<string | null> = [];
    const unlisten: () => void = identityChange_listen((now: string | null): void => { names.push(now); });
    expect(await conn.context_set('second@https://cube/api/v1/')).toBe(true);
    unlisten();
    expect(await conn.client_get()).toEqual({ of: 'SECOND' });
    expect(await conn.authToken_get(true)).toBe('SECOND');
    expect(names).toEqual(['second@https://cube/api/v1/']);
    expect(store.files).toEqual({ '/cfg/first.token': 'FIRST', '/cfg/second.token': 'SECOND' });
  });

  it('a logout from a login held for the session stays logged out when its context is named again, though an older token of theirs is on disk', async () => {
    const store: FakeStore = { files: { '/cfg/first.token': 'FIRST', '/cfg/second.token': 'OLDER' } };
    const shared = globalConfig as unknown as { tokenFilepath: string; context_set: jest.Mock };
    shared.tokenFilepath = '/cfg/first.token';
    let failing: boolean = true;
    shared.context_set.mockImplementation(async (user: string): Promise<void> => {
      if (failing) throw new Error('the disk is full');
      shared.tokenFilepath = `/cfg/${user}.token`;
    });
    restore = (): void => { shared.tokenFilepath = '/cfg/token'; shared.context_set.mockImplementation(async (): Promise<void> => undefined); };
    const conn: ChRISConnection = new ChRISConnection(shared as unknown as ConnectionConfig, storage_make(store));
    conn.loginProbe = async (): Promise<string | null> => null;
    mockClientCreate.mockImplementation((_url: string, token: string): object => ({ of: token }));
    mockContextSet.mockResolvedValue(true);
    mockAuthToken.mockResolvedValue('FRESH');
    const said = jest.spyOn(console, 'error').mockImplementation((): void => undefined);
    expect(await conn.connection_connect({ user: 'second', password: 'pw', debug: true, url: 'https://cube/api/v1/' })).toBe('FRESH');
    said.mockRestore();
    await conn.connection_logout();
    // Storage recovers, and the second's context is named again.
    failing = false;
    mockParse.mockResolvedValue({ user: 'second', URL: 'https://cube/api/v1/', folder: null, feed: null, plugin: null });
    expect(await conn.context_set('second@https://cube/api/v1/')).toBe(true);
    expect(await conn.client_get()).toBeNull();
    expect(await conn.authToken_get(true)).toBeNull();
    expect(store.files).toEqual({ '/cfg/first.token': 'FIRST', '/cfg/second.token': 'OLDER' });
  });

  it('a token whose removal failed at logout is not read back when its context is named again; a login over it is', async () => {
    const store: FakeStore = { files: { '/cfg/first.token': 'FIRST' } };
    const storage = storage_make(store);
    (storage.remove as unknown as jest.Mock).mockRejectedValueOnce(new Error('EACCES'));
    const conn: ChRISConnection = new ChRISConnection(pathsConfig_make(), storage);
    conn.loginProbe = async (): Promise<string | null> => null;
    mockClientCreate.mockImplementation((_url: string, token: string): object => ({ of: token }));
    mockContextSet.mockResolvedValue(true);
    mockParse.mockResolvedValue({ user: 'first', URL: 'https://cube/api/v1/', folder: null, feed: null, plugin: null });
    await conn.context_set('first@https://cube/api/v1/');
    expect(await conn.client_get()).toEqual({ of: 'FIRST' });
    const said = jest.spyOn(console, 'error').mockImplementation((): void => undefined);
    await conn.connection_logout();
    said.mockRestore();
    expect(store.files['/cfg/first.token']).toBe('FIRST');
    // The same context named again, and another and back: the surviving token is not read.
    await conn.context_set('first@https://cube/api/v1/');
    expect(await conn.authToken_get(true)).toBeNull();
    expect(await conn.client_refresh()).toBeNull();
    mockParse.mockResolvedValue({ user: 'second', URL: 'https://cube/api/v1/', folder: null, feed: null, plugin: null });
    await conn.context_set('second@https://cube/api/v1/');
    mockParse.mockResolvedValue({ user: 'first', URL: 'https://cube/api/v1/', folder: null, feed: null, plugin: null });
    await conn.context_set('first@https://cube/api/v1/');
    expect(await conn.authToken_get(true)).toBeNull();
    // Signing in writes a token over it: that one is read.
    mockAuthToken.mockResolvedValue('AGAIN');
    await conn.connection_connect({ user: 'first', password: 'pw', debug: true, url: 'https://cube/api/v1/' });
    expect(await conn.authToken_get(true)).toBe('AGAIN');
  });

  it('an address still being read when someone else connects is not put in place of theirs', async () => {
    const store: FakeStore = { files: { '/cfg/token': 'FIRST' } };
    const loaded = gate_make<string>();
    const config = { tokenFilepath: '/cfg/token', chrisURL_load: jest.fn((): Promise<string> => loaded.wait), context_set: jest.fn(async () => undefined) } as unknown as ConnectionConfig;
    const conn: ChRISConnection = new ChRISConnection(config, storage_make(store));
    conn.loginProbe = async (): Promise<string | null> => null;
    // Nobody has said where CUBE is: the saved address is being read, slowly.
    const reading: Promise<string | null> = conn.chrisURL_get();
    await Promise.resolve();
    mockAuthToken.mockResolvedValue('SECOND');
    await conn.connection_connect({ user: 'second', password: 'pw', debug: true, url: 'https://other/api/v1/' });
    loaded.open('https://saved/api/v1/');
    // The read comes back with the address saved before: the one connected to stands.
    expect(await reading).toBe('https://other/api/v1/');
    expect(await conn.chrisURL_get()).toBe('https://other/api/v1/');
  });

  it('a token that has gone from disk is a loss of who was connected, though the user and the CUBE named are the same', async () => {
    const store: FakeStore = { files: { '/cfg/token': 'FIRST' } };
    const conn: ChRISConnection = connection_make(store);
    mockClientCreate.mockReturnValue({ of: 'the first' });
    expect(await conn.client_get()).not.toBeNull();
    const before: number = identityEpoch_get();
    delete store.files['/cfg/token'];
    expect(await conn.authToken_get(true)).toBeNull();
    expect(identityEpoch_get()).toBe(before + 1);
    expect(await conn.client_get()).toBeNull();
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
