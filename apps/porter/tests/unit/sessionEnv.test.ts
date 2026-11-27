/**
 * @file A session's environment is built from a list, never porter's own:
 * the key that signs door cookies, the operator's host policy and anything
 * else porter carries stay with porter, and each session has a home and
 * state of its own.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostControl_parseArgv } from '@fnndsc/calypso';
import { berthKey_compute } from '@fnndsc/calypso/berth';
import * as nodeFs from 'node:fs';
import { identityFile_read, identityFile_write, ProcessHost, sessionDir_settle, type SettleFs, type SpawnedSession, type SessionSpawn } from '../../src/host/processHost.js';
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
      chmodSync(elsewhere, 0o755);
      expect(() => sessionDir_settle(join(stateDir, 'k', 'home'), join(stateDir, 'k'))).toThrow('not a folder of its own');
      // Only the folder checked is ever changed: what a link points at keeps its mode.
      expect(statSync(elsewhere).mode & 0o777).toBe(0o755);
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

describe('a folder swapped while it is checked', () => {
  /** Node's calls, recorded, with the name's last lookup answering for another folder. */
  function swapping(): { fs: SettleFs; opened: number[]; changed: number[]; closed: number[] } {
    const opened: number[] = [];
    const changed: number[] = [];
    const closed: number[] = [];
    const fs: SettleFs = {
      dir_make: (path, options) => nodeFs.mkdirSync(path, options),
      dir_open: (path, flags) => { const fd: number = nodeFs.openSync(path, flags); opened.push(fd); return fd; },
      open_stat: (fd) => nodeFs.fstatSync(fd),
      open_chmod: (fd, mode) => { changed.push(fd); nodeFs.fchmodSync(fd, mode); },
      name_stat: (path) => Object.assign(Object.create(Object.getPrototypeOf(nodeFs.lstatSync(path)) as object) as nodeFs.Stats, nodeFs.lstatSync(path), { ino: nodeFs.lstatSync(path).ino + 1 }),
      path_real: (path) => nodeFs.realpathSync(path),
      open_close: (fd) => { closed.push(fd); nodeFs.closeSync(fd); },
    };
    return { fs, opened, changed, closed };
  }

  it('refuses before changing anything, and closes what it opened', () => {
    const dir: string = join(stateDir, 'k');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    const seen = swapping();
    expect(() => sessionDir_settle(dir, stateDir, seen.fs)).toThrow('changed while it was checked');
    expect(seen.opened.length).toBe(1);
    expect(seen.changed).toEqual([]);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(seen.closed).toEqual(seen.opened);
  });

  it('refuses the start of a session, and starts nothing', async () => {
    process.env = { PATH: '/usr/bin' };
    const seen = swapping();
    const host: ProcessHost = new ProcessHost({ stateDir, chellEntry: '/opt/chell/dist/index.js', spawn, alive: async (): Promise<boolean> => false, bootTimeoutMs: 60, pollMs: 10, settleFs: seen.fs });
    await expect(host.spawn(IDENTITY, 'chris', 'https://cube.example.org/api/v1/', 'MINTED')).rejects.toThrow('changed while it was checked');
    expect(spawnCalls).toEqual([]);
    expect(seen.closed).toEqual(seen.opened);
  });
});

// agy's attack on step 0 (EVIDENCE 2026-11-27, ~/Projects/mise-audit/agy/attack-0/): each case it broke, held.
describe('what agy broke, held', () => {
  it('passes on only an address that is exactly its own origin', () => {
    expect(address_isPlain('http://proxy.example.org:3128')).toBe(true);
    expect(address_isPlain('http://proxy.example.org:3128/')).toBe(true);
    // An explicit default port is plain (Codex seq 381): a proxy written so is still passed on.
    expect(address_isPlain('http://proxy.example.org:80')).toBe(true);
    expect(address_isPlain('https://proxy.example.org:443/')).toBe(true);
    expect(address_isPlain('http://proxy.example.org:443')).toBe(true);
    for (const bad of [
      'http:\\\\proxy.example.org:3128', 'http://user\\@evil.example.org:3128',
      '  http://proxy.example.org:3128\r\n', 'http://proxy\n.example.org:3128', 'http://proxy.example.org:3128 ',
      'https://door.example.org/t/secret-door-token-999', 'http://proxy.example.org:3128/%40secret', 'HTTP://proxy.example.org',
    ]) expect(address_isPlain(bad)).toBe(false);
  });

  it('makes nothing for a path that leaves where it must be', () => {
    const root: string = join(stateDir, 'k');
    mkdirSync(root);
    expect(() => sessionDir_settle(join(root, '..', 'escaped'), root)).toThrow('lies outside');
    expect(existsSync(join(stateDir, 'escaped'))).toBe(false);
  });

  it('clears setgid and sticky bits', () => {
    for (const mode of [0o2700, 0o1700, 0o4700]) {
      const dir: string = join(stateDir, `m${mode.toString(8)}`);
      mkdirSync(dir);
      chmodSync(dir, mode);
      sessionDir_settle(dir, stateDir);
      expect(statSync(dir).mode & 0o7777).toBe(0o700);
    }
  });

  it('refuses a session whose root is a link, before any folder under it is touched', async () => {
    process.env = { PATH: '/usr/bin' };
    const host: ProcessHost = host_make();
    const elsewhere: string = mkdtempSync(join(tmpdir(), 'porter-elsewhere-'));
    try {
      chmodSync(elsewhere, 0o755);
      symlinkSync(elsewhere, join(host.dirs_build(IDENTITY).config, '..'));
      await expect(host.spawn(IDENTITY, 'chris', 'https://cube.example.org/api/v1/', 'MINTED')).rejects.toThrow('not a folder of its own');
      expect(spawnCalls).toEqual([]);
      expect(statSync(elsewhere).mode & 0o777).toBe(0o755);
      expect(existsSync(join(elsewhere, 'config'))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('writes the identity file never into a file at its name: a link, or a second name of another file', () => {
    for (const plant of [symlinkSync, linkSync]) {
      const outside: string = join(stateDir, `outside-${plant.name}.txt`);
      const marker: string = join(stateDir, `identity-${plant.name}`);
      writeFileSync(outside, 'kept\n', { mode: 0o644 });
      plant(outside, marker);
      identityFile_write(marker, 'stratus:oci@x');
      expect(readFileSync(outside, 'utf8')).toBe('kept\n');
      expect(statSync(outside).mode & 0o777).toBe(0o644);
      expect(readFileSync(marker, 'utf8')).toBe('stratus:oci@x\n');
    }
    identityFile_write(join(stateDir, 'own'), 'stratus:oci@x');
    expect(readFileSync(join(stateDir, 'own'), 'utf8')).toBe('stratus:oci@x\n');
    expect(statSync(join(stateDir, 'own')).mode & 0o777).toBe(0o600);
  });
});

describe('the identity marker at adoption and at setup', () => {
  it('adopts by a marker only from a file of this account\'s own that names the folder\'s own identity', async () => {
    const host: ProcessHost = new ProcessHost({ stateDir, chellEntry: '/opt/chell/dist/index.js', alive: async (): Promise<boolean> => true });
    const GOOD: string = 'stratus:oci@good@https://cube.example.org/api/v1/';
    const LINKED: string = 'stratus:oci@linked@https://cube.example.org/api/v1/';
    const MISPLACED: string = 'stratus:oci@misplaced@https://cube.example.org/api/v1/';
    const VICTIM: string = 'stratus:oci@victim@https://cube.example.org/api/v1/';
    const PLAIN: string = 'chris@https://cube.example.org/api/v1/';
    const plant = (identity: string, berthIdentity: string): string => {
      const dir: string = join(stateDir, berthKey_compute(identity));
      mkdirSync(join(dir, 'run', 'calypso'), { recursive: true });
      writeFileSync(join(dir, 'run', 'calypso', 'berth-x.json'), JSON.stringify({ identity: berthIdentity, url: 'ws://127.0.0.1:1', token: 'T' }));
      return dir;
    };
    identityFile_write(join(plant(GOOD, 'me@cloud'), 'identity'), GOOD);
    // A link at the marker's name: not believed.
    writeFileSync(join(stateDir, 'elsewhere'), `${VICTIM}\n`);
    symlinkSync(join(stateDir, 'elsewhere'), join(plant(LINKED, 'other@cloud'), 'identity'));
    // A real file of porter's, but naming another session's identity (copied from its folder): not believed.
    identityFile_write(join(plant(MISPLACED, 'third@cloud'), 'identity'), VICTIM);
    plant(PLAIN, PLAIN);
    const seen: string[] = (await host.sessions_adopt()).map((sighting) => sighting.identity).sort();
    expect(seen).toEqual([PLAIN, GOOD].sort());
    expect(identityFile_read(join(stateDir, 'nothing'))).toBeUndefined();
    expect(identityFile_read(join(stateDir, berthKey_compute(LINKED), 'identity'))).toBeNull();
  });

  it('fails a stratus start whose marker cannot be written, once and for good, spawning nothing', async () => {
    process.env = { PATH: '/usr/bin' };
    const host: ProcessHost = host_make();
    const root: string = join(host.dirs_build(STRATUS).config, '..');
    mkdirSync(join(root, 'identity'), { recursive: true });
    host.stratus_begin(STRATUS, '/creds/oci/config', false, false);
    let report: { state: string; reason?: string } | undefined;
    for (let i = 0; i < 50; i++) {
      const followed = host.boot_follow(STRATUS, { line: () => undefined, done: () => undefined });
      report = followed?.report;
      followed?.release();
      if (report !== undefined && report.state !== 'booting') break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(report?.state).toBe('failed');
    expect(spawnCalls).toEqual([]);
    // Refused again and again, it leaves nothing new in the session's folder.
    const before: string[] = nodeFs.readdirSync(root).sort();
    for (let i = 0; i < 3; i++) {
      host.stratus_begin(STRATUS, '/creds/oci/config', false, false);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(nodeFs.readdirSync(root).sort()).toEqual(before);
    expect(before.some((name: string): boolean => name.endsWith('.tmp'))).toBe(false);
  });

  it('changes nothing under a root put in place of the one verified, part way through setup', async () => {
    process.env = { PATH: '/usr/bin' };
    const changed: string[] = [];
    let swapped: boolean = false;
    const fs: SettleFs = {
      dir_make: (path, options) => nodeFs.mkdirSync(path, options),
      dir_open: (path, flags) => nodeFs.openSync(path, flags),
      open_stat: (fd) => nodeFs.fstatSync(fd),
      open_chmod: (fd, mode) => { changed.push(nodeFs.realpathSync(`/proc/self/fd/${fd}`)); nodeFs.fchmodSync(fd, mode); },
      // After the root is verified, its parent lookup from a child answers for another folder: the root was replaced.
      name_stat: (path) => {
        const real: nodeFs.Stats = nodeFs.lstatSync(path);
        if (!path.endsWith('..')) return real;
        swapped = true;
        return Object.assign(Object.create(Object.getPrototypeOf(real) as object) as nodeFs.Stats, real, { ino: real.ino + 1 });
      },
      path_real: (path) => nodeFs.realpathSync(path),
      open_close: (fd) => nodeFs.closeSync(fd),
    };
    const host: ProcessHost = new ProcessHost({ stateDir, chellEntry: '/opt/chell/dist/index.js', spawn, alive: async (): Promise<boolean> => false, bootTimeoutMs: 60, pollMs: 10, settleFs: fs });
    const root: string = join(host.dirs_build(IDENTITY).config, '..');
    mkdirSync(join(root, 'config'), { recursive: true, mode: 0o755 });
    chmodSync(join(root, 'config'), 0o755);
    await expect(host.spawn(IDENTITY, 'chris', 'https://cube.example.org/api/v1/', 'MINTED')).rejects.toThrow('no longer under the folder that was checked');
    expect(swapped).toBe(true);
    expect(changed.filter((path: string): boolean => path !== nodeFs.realpathSync(root))).toEqual([]);
    expect(statSync(join(root, 'config')).mode & 0o777).toBe(0o755);
    expect(spawnCalls).toEqual([]);
  });

  it('makes nothing in a root put at the name while the session is set up: all of it lands in the folder verified', async () => {
    process.env = { PATH: '/usr/bin' };
    const host0: ProcessHost = host_make();
    const root: string = join(host0.dirs_build(STRATUS).config, '..');
    let swapped: boolean = false;
    const fs: SettleFs = {
      dir_make: (path, options) => {
        // At the first folder made inside the root, the root is moved away and another put at its name.
        if (!swapped && path.endsWith('/config')) {
          swapped = true;
          nodeFs.renameSync(root, `${root}.moved`);
          nodeFs.mkdirSync(root, { mode: 0o700 });
        }
        return nodeFs.mkdirSync(path, options);
      },
      dir_open: (path, flags) => nodeFs.openSync(path, flags),
      open_stat: (fd) => nodeFs.fstatSync(fd),
      open_chmod: (fd, mode) => { nodeFs.fchmodSync(fd, mode); },
      name_stat: (path) => nodeFs.lstatSync(path),
      path_real: (path) => nodeFs.realpathSync(path),
      open_close: (fd) => { nodeFs.closeSync(fd); },
    };
    const host: ProcessHost = new ProcessHost({ stateDir, chellEntry: '/opt/chell/dist/index.js', stratusEntry: '/opt/stratus/dist/stratus.js', spawn, alive: async (): Promise<boolean> => false, bootTimeoutMs: 60, pollMs: 10, settleFs: fs });
    host.stratus_begin(STRATUS, '/creds/oci/config', false, false);
    let report: { state: string; reason?: string } | undefined;
    for (let i = 0; i < 50; i++) {
      const followed = host.boot_follow(STRATUS, { line: () => undefined, done: () => undefined });
      report = followed?.report;
      followed?.release();
      if (report !== undefined && report.state !== 'booting') break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(swapped).toBe(true);
    expect(report).toMatchObject({ state: 'failed' });
    expect(report?.reason).toContain('changed while it was set up');
    // The replacement holds nothing: no folder, no marker, no temporary file.
    expect(nodeFs.readdirSync(root)).toEqual([]);
    // Everything was made in the folder that was verified.
    expect(nodeFs.readdirSync(`${root}.moved`).sort()).toEqual(['cache', 'config', 'data', 'home', 'identity', 'run', 'state', 'tmp']);
    expect(spawnCalls).toEqual([]);
  });

  it('changes nothing it opened when the name has moved on by the time it would change it (agy, attack 0c)', () => {
    const root: string = join(stateDir, 'r');
    const outside: string = join(stateDir, 'outside');
    mkdirSync(join(root, 'home'), { recursive: true });
    mkdirSync(join(outside, 'home'), { recursive: true });
    chmodSync(join(outside, 'home'), 0o755);
    // The root is swapped for `outside` just before the folder is opened, and back just after.
    const fs: SettleFs = {
      dir_make: (path, options) => nodeFs.mkdirSync(path, options),
      dir_open: (path, flags) => {
        nodeFs.renameSync(root, `${root}.away`);
        nodeFs.renameSync(outside, root);
        const fd: number = nodeFs.openSync(path, flags);
        nodeFs.renameSync(root, outside);
        nodeFs.renameSync(`${root}.away`, root);
        return fd;
      },
      open_stat: (fd) => nodeFs.fstatSync(fd),
      open_chmod: (fd, mode) => { nodeFs.fchmodSync(fd, mode); },
      name_stat: (path) => nodeFs.lstatSync(path),
      path_real: (path) => nodeFs.realpathSync(path),
      open_close: (fd) => { nodeFs.closeSync(fd); },
    };
    expect(() => sessionDir_settle(join(root, 'home'), root, fs)).toThrow();
    expect(statSync(join(outside, 'home')).mode & 0o777).toBe(0o755);
  });
});

