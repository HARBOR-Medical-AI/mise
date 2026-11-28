/**
 * @file Tests for identity-keyed berths: normalisation, keying, file IO, and
 * owner-only records, and the local resolver's walk past dead records.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync, readFileSync, lstatSync } from 'fs';
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
  berthUrl_connect,
  berthUrl_target,
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
  mkdirSync(join(runtimeDir, 'calypso'), { recursive: true, mode: 0o700 });
});

/** Writes a file as a berth record is held: this account's, 0600 (umask aside). */
const record_put = (path: string, content: string): void => {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
};

/** Makes a folder as a berth folder is held: this account's, 0700. */
const folder_put = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
};

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
    record_put(path, JSON.stringify({ identity: 'other@http://h/api/v1/', url: 'ws://x', token: 't' }));
    expect(berth_read('u@http://h/api/v1/')).toBeNull();
  });

  it('returns null for a malformed berth file', () => {
    const path: string = berth_path('u@http://h/api/v1/');
    record_put(path, 'not json');
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

  it('refuses a record that is a link, wider than 0600, or in a folder wider than 0700; the writer leaves a planted link and its target as they are', () => {
    const identity: string = 'u@http://h/api/v1/';
    const elsewhere: string = mkdtempSync(join(tmpdir(), 'berth-elsewhere-'));
    const target: string = join(elsewhere, 'theirs.json');
    record_put(target, JSON.stringify(berth_of(identity, 'ws://127.0.0.1:6666')));
    symlinkSync(target, berth_path(identity));
    expect(berth_read(identity)).toBeNull();
    expect(() => berth_write(berth_of(identity))).toThrow('a link, left as it is');
    expect(readFileSync(target, 'utf8')).toContain('6666');
    expect(lstatSync(berth_path(identity)).isSymbolicLink()).toBe(true);
    rmSync(berth_path(identity));
    record_put(berth_path(identity), JSON.stringify(berth_of(identity)));
    chmodSync(berth_path(identity), 0o644);
    expect(berth_read(identity)).toBeNull();
    expect(() => berth_write(berth_of(identity))).toThrow('wider than 0600');
    chmodSync(berth_path(identity), 0o600);
    expect(berth_read(identity)).not.toBeNull();
    chmodSync(berthDir_path(), 0o755);
    expect(berth_read(identity)).toBeNull();
    expect(berthAll_read()).toEqual([]);
    expect(() => berth_write(berth_of(identity))).toThrow('wider than 0700');
    chmodSync(berthDir_path(), 0o700);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('a runtime folder reached by a link inside a folder open to other accounts is not trusted, though the link lands in a folder of this account\'s', () => {
    const identity: string = 'u@http://h/api/v1/';
    berth_write(berth_of(identity));
    const open: string = mkdtempSync(join(tmpdir(), 'berth-open-'));
    chmodSync(open, 0o777);
    symlinkSync(runtimeDir, join(open, 'link'));
    process.env.XDG_RUNTIME_DIR = join(open, 'link');
    expect(berth_read(identity)).toBeNull();
    expect(berthAll_read()).toEqual([]);
    expect(() => berth_write(berth_of(identity))).toThrow('open to other accounts');
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    expect(berth_read(identity)).not.toBeNull();
    rmSync(open, { recursive: true, force: true });
  });

  it('a runtime folder spelled with `..` is refused by every reader, writer and note, never folded into the folder it names', async () => {
    const identity: string = 'u@http://h/api/v1/';
    // A valid record, note and closing note where the folded spelling would land: a reader that folds finds them.
    berth_write(berth_of(identity));
    const { attachFile_write, attachFile_path } = await import('../src/daemon/attachFile.js');
    attachFile_write(['the note as it was']);
    closing_write(runtimeDir, identity, 'restart');
    mkdirSync(join(runtimeDir, 'x'), { mode: 0o700 });
    process.env.XDG_RUNTIME_DIR = `${runtimeDir}/x/..`;
    expect(berthDir_path()).toBe(`${runtimeDir}/x/../calypso`);
    expect(berth_path(identity)).toBe(`${runtimeDir}/x/../calypso/${berth_path(identity).split('/').pop() ?? ''}`);
    expect(berth_read(identity)).toBeNull();
    expect(berthOwn_read(identity)).toBeNull();
    expect(berthAll_read()).toEqual([]);
    expect(await new LocalBerthResolver().resolve(identity)).toBeNull();
    expect(() => berth_write(berth_of(identity, 'ws://127.0.0.1:7777'))).toThrow("names '..'");
    expect(attachFile_path()).toBe(`${runtimeDir}/x/../calypso/attach.txt`);
    expect(attachFile_write(['a new note'])).toBeNull();
    expect(closing_take(identity)).toBeNull();
    expect(closing_take(identity, `${runtimeDir}/x/..`)).toBeNull();
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    // Left as they were: the record, the note, and the closing note, untouched by the refused calls.
    expect(berth_read(identity)?.url).toBe('ws://127.0.0.1:4321');
    expect(readFileSync(join(runtimeDir, 'calypso', 'attach.txt'), 'utf8')).toBe('the note as it was\n');
    expect(closing_take(identity, runtimeDir)).toBe('restart');
  });

  it('without a runtime folder, a temporary folder spelled with `..` is refused too; the ordinary fallback works', () => {
    const identity: string = 'u@http://h/api/v1/';
    const savedTmp: string | undefined = process.env.TMPDIR;
    const base: string = mkdtempSync(join(tmpdir(), 'berth-tmp-'));
    try {
      delete process.env.XDG_RUNTIME_DIR;
      process.env.TMPDIR = base;
      // The control: the ordinary fallback writes and reads.
      expect(berthDir_path()).toBe(`${base}/calypso-${String(process.getuid?.())}`);
      berth_write(berth_of(identity));
      expect(berth_read(identity)?.url).toBe('ws://127.0.0.1:4321');
      // The same folder reached by a spelling that climbs: refused, though the record is there.
      mkdirSync(join(base, 'x'), { mode: 0o700 });
      process.env.TMPDIR = `${base}/x/..`;
      expect(berthDir_path()).toBe(`${base}/x/../calypso-${String(process.getuid?.())}`);
      expect(berth_read(identity)).toBeNull();
      expect(berthAll_read()).toEqual([]);
      expect(() => berth_write(berth_of(identity, 'ws://127.0.0.1:7777'))).toThrow("names '..'");
      process.env.TMPDIR = base;
      expect(berth_read(identity)?.url).toBe('ws://127.0.0.1:4321');
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
      process.env.XDG_RUNTIME_DIR = runtimeDir;
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('an empty base stays relative and a base of `/` is the root, as before', () => {
    const identity: string = 'u@http://h/api/v1/';
    const name: string = `berth-${berthKey_compute(identity)}.json`;
    expect(berth_pathIn('', identity)).toBe(`calypso/${name}`);
    expect(berth_pathIn('/', identity)).toBe(`/calypso/${name}`);
    expect(closing_pathIn('', identity)).toBe(`calypso/closing-${berthKey_compute(identity)}.json`);
    expect(closing_pathIn('/', identity)).toBe(`/calypso/closing-${berthKey_compute(identity)}.json`);
  });

  it('a reader never makes the berth folder; a writer makes it 0700', () => {
    rmSync(berthDir_path(), { recursive: true, force: true });
    expect(berth_read('u@http://h/api/v1/')).toBeNull();
    expect(existsSync(berthDir_path())).toBe(false);
    berth_write(berth_of('u@http://h/api/v1/'));
    expect(lstatSync(berthDir_path()).mode & 0o777).toBe(0o700);
    expect(lstatSync(berth_path('u@http://h/api/v1/')).mode & 0o777).toBe(0o600);
  });

  it('without a runtime folder the berth folder is this account\'s own name under the temporary folder', () => {
    delete process.env.XDG_RUNTIME_DIR;
    expect(berthDir_path()).toBe(join(tmpdir(), `calypso-${String(process.getuid?.())}`));
    process.env.XDG_RUNTIME_DIR = runtimeDir;
  });

  it('a record with a probe key holds every fact a proof is made over, or is no record', () => {
    const identity: string = 'u@http://h/api/v1/';
    const key: string = 'a'.repeat(64);
    record_put(berth_path(identity), JSON.stringify({ ...berth_of(identity), probeKey: key }));
    expect(berth_read(identity)).toBeNull();
    record_put(berth_path(identity), JSON.stringify({ ...berth_of(identity), probeKey: 'short', pid: 1, booted: 'b' }));
    expect(berth_read(identity)).toBeNull();
    record_put(berth_path(identity), JSON.stringify({ ...berth_of(identity), probeKey: key, pid: 1, booted: 'b' }));
    expect(berth_read(identity)?.probeKey).toBe(key);
  });
});

describe('berthUrl_connect', () => {
  it('is accepted when a TCP listener accepts on the berth port', async () => {
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port: number = (server.address() as AddressInfo).port;
    try {
      expect(await berthUrl_connect(`ws://127.0.0.1:${port}`)).toBe('accepted');
    } finally {
      server.close();
    }
  });

  it('is refused only for a refused connection; a url that names no daemon is inconclusive and nothing is sent', async () => {
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port: number = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await berthUrl_connect(`ws://127.0.0.1:${port}`, 200)).toBe('refused');
    for (const bad of ['not a url', 'http://127.0.0.1:1', 'ws://u:p@127.0.0.1:1', 'ws://127.0.0.1:0']) expect([bad, await berthUrl_connect(bad)]).toEqual([bad, 'inconclusive']);
  });

  it('reads a berth address: a scheme\'s default port filled in, an IPv6 host unbracketed, the origin alone kept', () => {
    expect(berthUrl_target('ws://127.0.0.1')).toEqual({ host: '127.0.0.1', port: 80, secure: false, origin: 'http://127.0.0.1' });
    expect(berthUrl_target('wss://cube.example.org/path?q=1')).toEqual({ host: 'cube.example.org', port: 443, secure: true, origin: 'https://cube.example.org' });
    expect(berthUrl_target('ws://[::1]:4000')).toEqual({ host: '::1', port: 4000, secure: false, origin: 'http://[::1]:4000' });
    for (const bad of ['ws://alice:secret@127.0.0.1:1', 'ws://alice@127.0.0.1:1', 'http://127.0.0.1:1', 'file:///x', 'nonsense']) expect([bad, berthUrl_target(bad)]).toEqual([bad, null]);
  });

  it('a record whose address is not a ws/wss address without credentials is no record', () => {
    const identity: string = 'u@http://h/api/v1/';
    record_put(berth_path(identity), JSON.stringify({ ...berth_of(identity), url: 'ws://alice:secret@127.0.0.1:1' }));
    expect(berth_read(identity)).toBeNull();
    record_put(berth_path(identity), JSON.stringify({ ...berth_of(identity), url: 'http://127.0.0.1:1' }));
    expect(berth_read(identity)).toBeNull();
    record_put(berth_path(identity), JSON.stringify({ ...berth_of(identity), url: 'ws://127.0.0.1' }));
    expect(berth_read(identity)?.url).toBe('ws://127.0.0.1');
  });

  it('is inconclusive for a timeout or a name that does not resolve: neither means nothing is there', async () => {
    // TEST-NET-1 is never routed: the connect times out or the network says it cannot reach it.
    expect(await berthUrl_connect('ws://192.0.2.1:9', 150)).toBe('inconclusive');
    expect(await berthUrl_connect('ws://no-such-host.invalid:9', 2000)).toBe('inconclusive');
  });
});

describe('LocalBerthResolver', () => {
  it('resolves a berth with no probe injected', async () => {
    const berth: Berth = berth_of('u@http://h/api/v1/');
    berth_write(berth);
    const resolver: LocalBerthResolver = new LocalBerthResolver();
    expect(await resolver.resolve(berth.identity)).toEqual(berth);
  });

  it('passes over a dead berth on resolve and leaves its record', async () => {
    const berth: Berth = berth_of('u@http://h/api/v1/');
    berth_write(berth);
    const resolver: LocalBerthResolver = new LocalBerthResolver(async () => 'dead');
    expect(await resolver.resolve(berth.identity)).toBeNull();
    expect(existsSync(berth_path(berth.identity))).toBe(true);
  });

  it('an unverified berth is not resolved to (nothing proves who answers), and is listed as unverified', async () => {
    const berth: Berth = berth_of('u@http://h/api/v1/');
    berth_write(berth);
    const resolver: LocalBerthResolver = new LocalBerthResolver(async () => 'unverified');
    expect(await resolver.resolve(berth.identity)).toBeNull();
    expect(await resolver.list()).toEqual([]);
    expect((await resolver.probed_list()).map((one) => one.liveness)).toEqual(['unverified']);
  });

  it('lists only live berths and removes nothing', async () => {
    const live: Berth = berth_of('live@http://h/api/v1/', 'ws://127.0.0.1:1111');
    const dead: Berth = berth_of('dead@http://h/api/v1/', 'ws://127.0.0.1:2222');
    berth_write(live);
    berth_write(dead);
    const resolver: LocalBerthResolver = new LocalBerthResolver(async (b: Berth) => (b.identity === live.identity ? 'live' : 'dead'));
    expect(await resolver.list()).toEqual([live]);
    expect(existsSync(berth_path(dead.identity))).toBe(true);
    expect(existsSync(berth_path(live.identity))).toBe(true);
  });

  it('a dead record of this runtime never hides a live porter record of the same identity behind it', async () => {
    const identity: string = identity_normalise('chris', 'http://cube/api/v1/');
    berth_write(berth_of(identity, 'ws://127.0.0.1:1111'));
    const porterPath: string = berth_pathIn(join(runtimeDir, 'state', 'porter', berthKey_compute(identity), 'run'), identity);
    folder_put(join(porterPath, '..'));
    record_put(porterPath, JSON.stringify(berth_of(identity, 'ws://127.0.0.1:9999')));
    const resolver: LocalBerthResolver = new LocalBerthResolver(async (b: Berth) => (b.url.endsWith('9999') ? 'live' : 'dead'));
    for (let round = 0; round < 2; round++) {
      expect((await resolver.resolve(identity))?.url).toBe('ws://127.0.0.1:9999');
      expect(await resolver.listLocated()).toEqual([{ berth: expect.objectContaining({ url: 'ws://127.0.0.1:9999' }), path: porterPath }]);
    }
    expect(existsSync(berth_path(identity))).toBe(true);
    expect(existsSync(porterPath)).toBe(true);
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
      record_put(closing_pathIn(runtime, IDENTITY), JSON.stringify({ cause: 'end', at: Date.now() - 3_600_000 }));
      expect(closing_take(IDENTITY, runtime)).toBeNull();
      // A note another account could have put there is not taken.
      record_put(closing_pathIn(runtime, IDENTITY), JSON.stringify({ cause: 'end', at: Date.now() }));
      chmodSync(closing_pathIn(runtime, IDENTITY), 0o644);
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
    folder_put(join(path, '..'));
    record_put(path, JSON.stringify(berth_of(identity, 'ws://127.0.0.1:9999')));
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
    folder_put(join(path, '..'));
    const berth = berth_of(identity, 'ws://127.0.0.1:9999');
    record_put(path, JSON.stringify(berth));
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

  it('a porter root porter itself would refuse (the shared /tmp) is passed over; a later root still counts', async () => {
    const tmpStats = (await import('node:fs')).lstatSync('/tmp');
    if (!(tmpStats.uid === 0 && (tmpStats.mode & 0o1000) !== 0)) return;
    const refusedId: string = identity_normalise(`berth-test-${String(process.pid)}-${String(Date.now())}`, 'http://cube/api/v1/');
    const keptId: string = identity_normalise('kept', 'http://cube/api/v1/');
    // A session folder of this account's straight under /tmp, its record valid: only the root is wrong. The folder
    // is claimed first (no recursive make, so one already there is someone else's and is never touched), and only
    // a folder this run made is removed.
    const underTmp: string = join('/tmp', berthKey_compute(refusedId));
    mkdirSync(underTmp, { mode: 0o700 });
    try {
      const refusedPath: string = berth_pathIn(join(underTmp, 'run'), refusedId);
      folder_put(join(refusedPath, '..'));
      record_put(refusedPath, JSON.stringify(berth_of(refusedId, 'ws://127.0.0.1:6001')));
      const keptPath: string = berth_pathIn(join(runtimeDir, 'state', 'porter', berthKey_compute(keptId), 'run'), keptId);
      folder_put(join(keptPath, '..'));
      record_put(keptPath, JSON.stringify(berth_of(keptId, 'ws://127.0.0.1:6002')));
      process.env.PORTER_STATE_DIR = '/tmp';
      expect(berth_read(refusedId)).toBeNull();
      expect(await new LocalBerthResolver().resolve(refusedId)).toBeNull();
      const listed: string[] = (await new LocalBerthResolver().listLocated()).map((one) => one.berth.identity);
      expect(listed).not.toContain(refusedId);
      expect(listed).toContain(keptId);
      expect(berth_read(keptId)?.url).toBe('ws://127.0.0.1:6002');
    } finally {
      delete process.env.PORTER_STATE_DIR;
      rmSync(underTmp, { recursive: true, force: true });
    }
  });

  it('a home spelled with `..` keeps it in the porter root, and a record at the folded place is not found', () => {
    const identity: string = identity_normalise('chris', 'http://cube/api/v1/');
    const savedHome: string | undefined = process.env.HOME;
    const home: string = join(runtimeDir, 'home');
    const folded: string = berth_pathIn(join(home, '.local', 'state', 'porter', berthKey_compute(identity), 'run'), identity);
    folder_put(join(folded, '..'));
    record_put(folded, JSON.stringify(berth_of(identity, 'ws://127.0.0.1:6100')));
    folder_put(join(home, 'x'));
    delete process.env.XDG_STATE_HOME;
    try {
      process.env.HOME = home;
      expect(berth_read(identity)?.url).toBe('ws://127.0.0.1:6100');
      process.env.HOME = `${home}/x/..`;
      // The root spelled with `..` is refused and passed over: no candidate is the folded place.
      expect(berthPaths_list(identity).some((one: string): boolean => one.startsWith(join(home, '.local')))).toBe(false);
      expect(berth_read(identity)).toBeNull();
      expect(berthAll_read().map((one) => one.identity)).not.toContain(identity);
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      process.env.XDG_STATE_HOME = join(runtimeDir, 'state');
    }
  });

  it('honours PORTER_STATE_DIR', () => {
    process.env.PORTER_STATE_DIR = join(runtimeDir, 'elsewhere');
    const identity: string = identity_normalise('chris', 'http://cube/api/v1/');
    expect(berthPaths_list(identity)[1]).toContain(join(runtimeDir, 'elsewhere'));
  });
});
