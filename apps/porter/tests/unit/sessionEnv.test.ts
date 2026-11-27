/**
 * @file A session's environment is built from a list, never porter's own:
 * the key that signs door cookies, the operator's host policy and anything
 * else porter carries stay with porter, and each session has a home and
 * state of its own.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostControl_parseArgv } from '@fnndsc/calypso';
import { ProcessHost, sessionDir_settle, type SpawnedSession, type SessionSpawn } from '../../src/host/processHost.js';
import { address_isPlain, sessionEnv_build, sessionEnv_withheld } from '../../src/host/sessionEnv.js';

const IDENTITY: string = 'chris@https://cube.example.org/api/v1/';
const STRATUS: string = `stratus:oci@${IDENTITY}`;

/** Porter's environment as an operator might leave it: secrets, canaries, and what a session needs. */
const PARENT: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  LC_ALL: 'en_US.UTF-8',
  NO_PROXY: 'localhost,.example.org',
  HTTPS_PROXY: 'http://proxy.example.org:3128',
  HTTP_PROXY: 'http://me:pw@proxy.example.org:3128',
  https_proxy: 'http://proxy.example.org:3128/?key=k',
  CHELL_DOOR: 'https://door.example.org/#t',
  PORTER_SECRET: 'synthetic-signing-key-0123456789',
  PORTER_LAUNCHER_SECRET_FILE: '/etc/porter/launcher.secret',
  CHRIS_SUPERUSER_PASSWORD: 'synthetic',
  SSH_AUTH_SOCK: '/run/user/1/agent.sock',
  OCI_REGION: 'us-ashburn-1',
  NODE_OPTIONS: '--require /tmp/evil.js',
  CALYPSO_HOST_CONTROL: 'all',
  CALYPSO_ELEVATION_URL: 'https://elsewhere.example.org/api/v1/',
  CALYPSO_CANARY: 'c',
  LC_CANARY: 'c',
  CHELL_CANARY: 'c',
  XDG_CANARY: 'c',
  HOME: '/home/porter',
  XDG_STATE_HOME: '/home/porter/.local/state',
};

/** What a session is given of PARENT: nothing else. */
const GIVEN: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  LC_ALL: 'en_US.UTF-8',
  NO_PROXY: 'localhost,.example.org',
  HTTPS_PROXY: 'http://proxy.example.org:3128',
};

/** A child the test can let boot. */
class FakeChild extends EventEmitter implements SpawnedSession {
  public pid: number = 4242;
  public stdout: PassThrough = new PassThrough();
  public stderr: PassThrough = new PassThrough();
  public stdin: PassThrough = new PassThrough();
  public exitCode: number | null = null;
  kill(): boolean { return true; }
}

let stateDir: string;
let spawnCalls: Array<{ args: string[]; env: NodeJS.ProcessEnv }>;
let saved: NodeJS.ProcessEnv;

const spawn: SessionSpawn = (_command, args, options): SpawnedSession => {
  spawnCalls.push({ args, env: options.env });
  return new FakeChild();
};

/** A host whose sessions never answer: only what it was started with matters here. */
function host_make(): ProcessHost {
  return new ProcessHost({ stateDir, chellEntry: '/opt/chell/dist/index.js', stratusEntry: '/opt/stratus/dist/stratus.js', spawn, alive: async (): Promise<boolean> => false, bootTimeoutMs: 60, pollMs: 10 });
}

/** Waits for the n-th spawn. */
async function spawned(n: number): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
  for (let i = 0; i < 50 && spawnCalls.length < n; i++) await new Promise((r) => setTimeout(r, 5));
  const call = spawnCalls[n - 1];
  if (call === undefined) throw new Error('the session was never started');
  return call;
}

/** The session's own names, for an identity. */
function own_expected(host: ProcessHost, identity: string): NodeJS.ProcessEnv {
  const dirs = host.dirs_build(identity);
  const root: string = join(dirs.config, '..');
  return {
    XDG_CONFIG_HOME: dirs.config, XDG_RUNTIME_DIR: dirs.runtime, XDG_CACHE_HOME: dirs.cache, TMPDIR: dirs.tmp,
    HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'state'), XDG_DATA_HOME: join(root, 'data'),
    FORCE_COLOR: '3',
  };
}

/** The tiers the session ends up with, as calypso itself reads the argv and environment it was started with. */
function tiers_effective(call: { args: string[]; env: NodeJS.ProcessEnv }): string[] {
  const built = hostControl_parseArgv(call.args, call.env);
  if ('error' in built) throw new Error(built.error);
  return [...built.policy.tiers].sort();
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'porter-env-'));
  spawnCalls = [];
  saved = process.env;
});
afterEach(() => {
  process.env = saved;
  rmSync(stateDir, { recursive: true, force: true });
});

describe('sessionEnv_build', () => {
  it('gives only the listed names, and an address only when it is plain', () => {
    expect(sessionEnv_build(PARENT, {})).toEqual(GIVEN);
  });

  it('lets the session\'s own names win, and never a PORTER_ name from either side', () => {
    expect(sessionEnv_build({ PATH: '/a', PORTER_SECRET: 's' }, { PATH: '/b', PORTER_X: 'x' })).toEqual({ PATH: '/b' });
  });

  it('names what it withholds for not being a plain address, never its value', () => {
    expect(sessionEnv_withheld(PARENT)).toEqual(['CHELL_DOOR', 'HTTP_PROXY', 'https_proxy']);
  });

  it('reads a plain address as http or https with no user, password, query or fragment', () => {
    expect(address_isPlain('https://door.example.org/')).toBe(true);
    for (const bad of ['http://u@p.example.org', 'http://p.example.org/?t=1', 'http://p.example.org/#x', 'http://p.example.org/?', 'socks5://p.example.org', 'not a url']) {
      expect(address_isPlain(bad)).toBe(false);
    }
  });
});

describe('a session porter starts', () => {
  it('is given exactly the listed names and its own folders, and no host control (ChRIS)', async () => {
    process.env = { ...PARENT };
    const host: ProcessHost = host_make();
    void host.spawn(IDENTITY, 'chris', 'https://cube.example.org/api/v1/', 'MINTED').catch(() => undefined);
    const call = await spawned(1);
    expect(call.env).toEqual({ ...GIVEN, ...own_expected(host, IDENTITY) });
    expect(call.args.some((arg: string): boolean => arg.startsWith('--host-control'))).toBe(false);
    expect(tiers_effective(call)).toEqual([]);
  });

  it('gives a READ stratus session no host control, and an armed one tasks alone', async () => {
    process.env = { ...PARENT };
    const host: ProcessHost = host_make();
    const door = { cubeUrl: 'https://cube.example.org/api/v1/', user: 'chris' };
    host.stratus_begin(STRATUS, '/creds/oci/config', false, false, door);
    const read = await spawned(1);
    expect(read.env).toEqual({ ...GIVEN, ...own_expected(host, STRATUS), CALYPSO_ELEVATION_URL: door.cubeUrl, CALYPSO_ELEVATION_USER: 'chris' });
    expect(tiers_effective(read)).toEqual([]);
    const armedIdentity: string = `stratus:oci@other@https://cube.example.org/api/v1/`;
    host.stratus_begin(armedIdentity, '/creds/oci/config', true, false);
    const armed = await spawned(2);
    expect(armed.env).toEqual({ ...GIVEN, ...own_expected(host, armedIdentity) });
    expect(tiers_effective(armed)).toEqual(['tasks']);
  });

  it('gives no host control whatever porter\'s own CALYPSO_HOST_CONTROL says, and tasks only to an armed stratus session', async () => {
    let n: number = 0;
    for (const [i, value] of [undefined, '', '  ', 'all', 'shell,files,pipes'].entries()) {
      process.env = { PATH: '/usr/bin', ...(value !== undefined ? { CALYPSO_HOST_CONTROL: value } : {}) };
      const host: ProcessHost = host_make();
      void host.spawn(`u${i}@https://cube.example.org/api/v1/`, `u${i}`, 'https://cube.example.org/api/v1/', 'MINTED').catch(() => undefined);
      host.stratus_begin(`stratus:oci@r${i}@https://cube.example.org/api/v1/`, '/creds/oci/config', false, false);
      host.stratus_begin(`stratus:oci@a${i}@https://cube.example.org/api/v1/`, '/creds/oci/config', true, false);
      const [chris, read, armed] = [await spawned(n + 1), await spawned(n + 2), await spawned(n + 3)];
      n += 3;
      for (const call of [chris, read, armed]) expect(call.env['CALYPSO_HOST_CONTROL']).toBeUndefined();
      expect(chris.args.filter((arg: string): boolean => arg.startsWith('--host-control'))).toEqual([]);
      expect(read.args.filter((arg: string): boolean => arg.startsWith('--host-control'))).toEqual([]);
      expect(armed.args.filter((arg: string): boolean => arg.startsWith('--host-control'))).toEqual(['--host-control=tasks']);
      expect([tiers_effective(chris), tiers_effective(read), tiers_effective(armed)]).toEqual([[], [], ['tasks']]);
    }
  });

  it('gives each person a home, state and data of their own, private to them', async () => {
    process.env = { PATH: '/usr/bin' };
    const host: ProcessHost = host_make();
    void host.spawn(IDENTITY, 'chris', 'https://cube.example.org/api/v1/', 'MINTED').catch(() => undefined);
    void host.spawn('other@https://cube.example.org/api/v1/', 'other', 'https://cube.example.org/api/v1/', 'MINTED').catch(() => undefined);
    const [a, b] = [await spawned(1), await spawned(2)];
    for (const name of ['HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME']) {
      expect(a.env[name]).not.toBe(b.env[name]);
      for (const call of [a, b]) expect(statSync(call.env[name] as string).mode & 0o777).toBe(0o700);
    }
  });
});

describe('the spawner', () => {
  it('never hands a session porter\'s whole environment', () => {
    const source: string = readFileSync(new URL('../../src/host/processHost.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\.\.\.\s*process\.env/);
    expect(source).toMatch(/sessionEnv_build\(process\.env,/);
  });
});

describe('sessionDir_settle', () => {
  it('makes a folder 0700, and makes one already there 0700 again', () => {
    const fresh: string = join(stateDir, 'k', 'home');
    sessionDir_settle(fresh, stateDir);
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
    const open: string = join(stateDir, 'k', 'state');
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    sessionDir_settle(open, join(stateDir, 'k'));
    expect(statSync(open).mode & 0o777).toBe(0o700);
  });

  it('refuses a link, a file, or a folder outside where it must be', () => {
    const elsewhere: string = mkdtempSync(join(tmpdir(), 'porter-elsewhere-'));
    try {
      mkdirSync(join(stateDir, 'k'));
      symlinkSync(elsewhere, join(stateDir, 'k', 'home'));
      expect(() => sessionDir_settle(join(stateDir, 'k', 'home'), join(stateDir, 'k'))).toThrow('not a folder of its own');
      writeFileSync(join(stateDir, 'k', 'cache'), 'x');
      expect(() => sessionDir_settle(join(stateDir, 'k', 'cache'), join(stateDir, 'k'))).toThrow();
      expect(() => sessionDir_settle(elsewhere, join(stateDir, 'k'))).toThrow('lies outside');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('refuses the start of a session whose folder is a link, and starts nothing', async () => {
    process.env = { PATH: '/usr/bin' };
    const host: ProcessHost = host_make();
    const elsewhere: string = mkdtempSync(join(tmpdir(), 'porter-elsewhere-'));
    try {
      const root: string = join(host.dirs_build(IDENTITY).config, '..');
      mkdirSync(root, { recursive: true });
      symlinkSync(elsewhere, join(root, 'home'));
      await expect(host.spawn(IDENTITY, 'chris', 'https://cube.example.org/api/v1/', 'MINTED')).rejects.toThrow('not a folder of its own');
      expect(spawnCalls).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
