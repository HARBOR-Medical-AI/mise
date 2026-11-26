/**
 * @file Tests for identity-keyed berths: normalisation, keying, file IO, and
 * the local resolver's liveness reaping.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  closing_write,
  closing_take,
  closing_pathIn,
  identity_normalise,
  identity_deriveForSession,
  DISCONNECTED_IDENTITY,
  berthKey_compute,
  berthDir_path,
  berth_path,
  berth_write,
  berth_read,
  berthOwn_read,
  berthPaths_list,
  berth_pathIn,
  berthAll_read,
  berth_remove,
  berthUrl_isAlive,
  LocalBerthResolver,
  type Berth,
} from '../src/daemon/berth.js';
import { berthLines_say } from '../src/daemon/token.js';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';

let runtimeDir: string;
const savedXdg: string | undefined = process.env.XDG_RUNTIME_DIR;
const savedState: string | undefined = process.env.XDG_STATE_HOME;
const savedPorter: string | undefined = process.env.PORTER_STATE_DIR;

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'berth-test-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  // A porter's sessions are looked for under the user's state: this test's own.
  process.env.XDG_STATE_HOME = join(runtimeDir, 'state');
  delete process.env.PORTER_STATE_DIR;
  // Some tests write a berth file directly (bypassing berth_write, which would
  // otherwise create the directory) to exercise malformed/mismatched reads.
  mkdirSync(join(runtimeDir, 'calypso'), { recursive: true });
});

afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
  if (savedState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = savedState;
  if (savedPorter === undefined) delete process.env.PORTER_STATE_DIR; else process.env.PORTER_STATE_DIR = savedPorter;
  if (savedXdg === undefined) {
    delete process.env.XDG_RUNTIME_DIR;
  } else {
    process.env.XDG_RUNTIME_DIR = savedXdg;
  }
});

const berth_of = (identity: string, url: string = 'ws://127.0.0.1:4321'): Berth => ({ identity, url, token: 'abc123' });

describe('identity_normalise', () => {
  it('lowercases scheme and host but preserves the trailing slash, port, and user case', () => {
    expect(identity_normalise('Chris', 'HTTPS://Cube.Example.ORG:8000/api/v1/'))
      .toBe('Chris@https://cube.example.org:8000/api/v1/');
  });

  it('keeps the path case exactly (only the authority is lowercased)', () => {
    expect(identity_normalise('u', 'http://host/API/v1/')).toBe('u@http://host/API/v1/');
  });

  it('treats a short host and its FQDN as different identities (no DNS merge)', () => {
    expect(identity_normalise('u', 'http://ekanite:3223/api/v1/'))
      .not.toBe(identity_normalise('u', 'http://ekanite.tch.harvard.edu:3223/api/v1/'));
  });

  it('passes through a URL with no scheme unchanged (aside from the user join)', () => {
    expect(identity_normalise('u', 'host/api/v1/')).toBe('u@host/api/v1/');
  });
});

describe('identity_deriveForSession', () => {
  it('normalises when both user and url are present', () => {
    expect(identity_deriveForSession('u', 'http://h/api/v1/')).toBe('u@http://h/api/v1/');
  });

  it('falls back to the disconnected identity when either is missing', () => {
    expect(identity_deriveForSession(null, 'http://h/api/v1/')).toBe(DISCONNECTED_IDENTITY);
    expect(identity_deriveForSession('u', null)).toBe(DISCONNECTED_IDENTITY);
    expect(identity_deriveForSession(undefined, undefined)).toBe(DISCONNECTED_IDENTITY);
  });
});

describe('berthKey_compute', () => {
  it('is deterministic and 16 hex characters', () => {
    const key: string = berthKey_compute('u@http://h/api/v1/');
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(berthKey_compute('u@http://h/api/v1/')).toBe(key);
  });

  it('differs for different identities', () => {
    expect(berthKey_compute('a@http://h/api/v1/')).not.toBe(berthKey_compute('b@http://h/api/v1/'));
  });
});

describe('berthDir_path', () => {
  it('is the calypso subdirectory of XDG_RUNTIME_DIR when set', () => {
    expect(berthDir_path()).toBe(join(runtimeDir, 'calypso'));
  });
});

describe('berth file IO', () => {
  it('round-trips a berth by identity', () => {
    const berth: Berth = berth_of('u@http://h/api/v1/');
    berth_write(berth);
    expect(berth_read('u@http://h/api/v1/')).toEqual(berth);
  });

  it('returns null when no berth is advertised', () => {
    expect(berth_read('missing@http://h/api/v1/')).toBeNull();
  });

  it('rejects a berth whose stored identity does not match the requested one', () => {
    // Write a berth whose file lands at one identity's path but records another.
    const path: string = berth_path('u@http://h/api/v1/');
    writeFileSync(path, JSON.stringify({ identity: 'other@http://h/api/v1/', url: 'ws://x', token: 't' }));
    expect(berth_read('u@http://h/api/v1/')).toBeNull();
  });

  it('returns null for a malformed berth file', () => {
    const path: string = berth_path('u@http://h/api/v1/');
    writeFileSync(path, 'not json');
    expect(berth_read('u@http://h/api/v1/')).toBeNull();
  });

  it('reads every advertised berth and ignores non-berth files', () => {
    berth_write(berth_of('a@http://h/api/v1/'));
    berth_write(berth_of('b@http://h/api/v1/'));
    writeFileSync(join(berthDir_path(), 'not-a-berth.txt'), 'ignore me');
    const identities: string[] = berthAll_read().map((b: Berth) => b.identity).sort();
    expect(identities).toEqual(['a@http://h/api/v1/', 'b@http://h/api/v1/']);
  });

  it('returns an empty list when the berth directory is absent', () => {
    rmSync(berthDir_path(), { recursive: true, force: true });
    expect(berthAll_read()).toEqual([]);
  });

  it('removes a berth file', () => {
    const berth: Berth = berth_of('u@http://h/api/v1/');
    berth_write(berth);
    expect(existsSync(berth_path(berth.identity))).toBe(true);
    berth_remove(berth.identity);
    expect(existsSync(berth_path(berth.identity))).toBe(false);
  });
});

describe('berthUrl_isAlive', () => {
  it('is true when a TCP listener accepts on the berth port', async () => {
    const server: Server = createServer();
    await new Promise<void>((resolve: () => void): void => { server.listen(0, '127.0.0.1', resolve); });
    const port: number = (server.address() as AddressInfo).port;
    try {
      expect(await berthUrl_isAlive(`ws://127.0.0.1:${port}`)).toBe(true);
    } finally {
      await new Promise<void>((resolve: () => void): void => { server.close(() => resolve()); });
    }
  });

  it('is false for a port with no listener', async () => {
    // Port 1 is privileged and unbound in test environments.
    expect(await berthUrl_isAlive('ws://127.0.0.1:1', 200)).toBe(false);
  });

  it('is false for a malformed url or a url with no port', async () => {
    expect(await berthUrl_isAlive('not a url')).toBe(false);
    expect(await berthUrl_isAlive('ws://127.0.0.1')).toBe(false);
  });
});

describe('LocalBerthResolver', () => {
  it('resolves a berth with no probe injected', async () => {
    const berth: Berth = berth_of('u@http://h/api/v1/');
    berth_write(berth);
    const resolver: LocalBerthResolver = new LocalBerthResolver();
    expect(await resolver.resolve(berth.identity)).toEqual(berth);
  });

  it('reaps a dead berth on resolve and returns null', async () => {
    const berth: Berth = berth_of('u@http://h/api/v1/');
    berth_write(berth);
    const resolver: LocalBerthResolver = new LocalBerthResolver(async () => false);
    expect(await resolver.resolve(berth.identity)).toBeNull();
    expect(existsSync(berth_path(berth.identity))).toBe(false);
  });

  it('keeps a live berth on resolve', async () => {
    const berth: Berth = berth_of('u@http://h/api/v1/');
    berth_write(berth);
    const resolver: LocalBerthResolver = new LocalBerthResolver(async () => true);
    expect(await resolver.resolve(berth.identity)).toEqual(berth);
    expect(existsSync(berth_path(berth.identity))).toBe(true);
  });

  it('lists only live berths and reaps the dead', async () => {
    const live: Berth = berth_of('live@http://h/api/v1/', 'ws://127.0.0.1:1111');
    const dead: Berth = berth_of('dead@http://h/api/v1/', 'ws://127.0.0.1:2222');
    berth_write(live);
    berth_write(dead);
    const resolver: LocalBerthResolver = new LocalBerthResolver(async (b: Berth) => b.identity === live.identity);
    const listed: Berth[] = await resolver.list();
    expect(listed).toEqual([live]);
    expect(existsSync(berth_path(dead.identity))).toBe(false);
    expect(existsSync(berth_path(live.identity))).toBe(true);
  });
});

describe('closing reasons', () => {
  const IDENTITY: string = 'chris@https://cube.example.org/api/v1/';
  it('takes the reason a host left, once, and only while it is fresh', () => {
    const runtime: string = mkdtempSync(join(tmpdir(), 'closing-'));
    try {
      expect(closing_take(IDENTITY, runtime)).toBeNull();
      closing_write(runtime, IDENTITY, 'restart');
      expect(existsSync(closing_pathIn(runtime, IDENTITY))).toBe(true);
      expect(closing_take(IDENTITY, runtime)).toBe('restart');
      expect(existsSync(closing_pathIn(runtime, IDENTITY))).toBe(false);
      expect(closing_take(IDENTITY, runtime)).toBeNull();
      writeFileSync(closing_pathIn(runtime, IDENTITY), JSON.stringify({ cause: 'end', at: Date.now() - 3_600_000 }));
      expect(closing_take(IDENTITY, runtime)).toBeNull();
    } finally {
      rmSync(runtime, { recursive: true, force: true });
    }
  });
});

describe('a porter\'s sessions', () => {
  it('are found by identity and listed, under the porter\'s own layout; a starting daemon ignores them', () => {
    const identity: string = identity_normalise('chris', 'http://cube/api/v1/');
    const root: string = join(runtimeDir, 'state', 'porter');
    const path: string = berth_pathIn(join(root, berthKey_compute(identity), 'run'), identity);
    expect(berthPaths_list(identity)).toContain(path);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(berth_of(identity, 'ws://127.0.0.1:9999')));
    expect(berth_read(identity)?.url).toBe('ws://127.0.0.1:9999');
    expect(berthAll_read().map((one) => one.identity)).toContain(identity);
    // The start-up guard is this runtime's own: a porter session is not a rival.
    expect(berthOwn_read(identity)).toBeNull();
    // This runtime's own berth wins over the porter's.
    berth_write(berth_of(identity, 'ws://127.0.0.1:1111'));
    expect(berth_read(identity)?.url).toBe('ws://127.0.0.1:1111');
    expect(berthAll_read().filter((one) => one.identity === identity)).toHaveLength(1);
  });

  it('a berth only a porter session holds is listed with that session\'s record, and off a terminal its lines name that file and hold no token', async () => {
    const identity: string = identity_normalise('chris', 'http://cube/api/v1/');
    const root: string = join(runtimeDir, 'state', 'porter');
    const path: string = berth_pathIn(join(root, berthKey_compute(identity), 'run'), identity);
    mkdirSync(join(path, '..'), { recursive: true });
    const berth = berth_of(identity, 'ws://127.0.0.1:9999');
    writeFileSync(path, JSON.stringify(berth));
    const located = await new LocalBerthResolver().listLocated();
    expect(located).toEqual([{ berth: expect.objectContaining({ identity, token: berth.token }), path }]);
    // Not the path an identity alone would give in this runtime, where no such file is.
    expect(path).not.toBe(berth_path(identity));
    expect(existsSync(berth_path(identity))).toBe(false);
    expect(existsSync(path)).toBe(true);
    const off: string = berthLines_say(berth.identity, berth.url, berth.token, false, located[0]!.path).join('\n');
    expect(off).not.toContain(berth.token);
    expect(off).toContain(`--token <the token kept in ${path}>`);
    expect(off).toContain(`http://127.0.0.1:9999/ (its token is kept in ${path})`);
    const on: string = berthLines_say(berth.identity, berth.url, berth.token, true, located[0]!.path).join('\n');
    expect(on).toContain(`http://127.0.0.1:9999/?token=${berth.token}`);
    expect(on).toContain(`--token ${berth.token}`);
  });

  it('honours PORTER_STATE_DIR', () => {
    process.env.PORTER_STATE_DIR = join(runtimeDir, 'elsewhere');
    const identity: string = identity_normalise('chris', 'http://cube/api/v1/');
    expect(berthPaths_list(identity)[1]).toContain(join(runtimeDir, 'elsewhere'));
  });
});
