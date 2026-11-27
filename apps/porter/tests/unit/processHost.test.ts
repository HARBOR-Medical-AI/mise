/**
 * @file Sessions as processes: four directories each, the token on stdin,
 * the boot followed, the berth read from where the child put it.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { berth_pathIn } from '@fnndsc/calypso/berth';
import { ProcessHost, BOOT_LINES_KEPT, bootRow_parse, type SpawnedSession, type SessionSpawn } from '../../src/host/processHost.js';
import { restartLine_render, type BootLine } from '../../src/host/sessionHost.js';

const IDENTITY: string = 'chris@https://cube.example.org/api/v1/';

/** A child the test drives: streams it can write, an exit it can fire. */
class FakeChild extends EventEmitter implements SpawnedSession {
  public pid: number = 4242;
  public stdout: PassThrough = new PassThrough();
  public stderr: PassThrough = new PassThrough();
  public stdin: PassThrough = new PassThrough();
  public exitCode: number | null = null;
  public stdinText: string = '';
  public killed: NodeJS.Signals | null = null;
  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer): void => { this.stdinText += chunk.toString(); });
  }
  kill(signal?: NodeJS.Signals): boolean { this.killed = signal ?? 'SIGTERM'; this.exit(143); return true; }
  exit(code: number): void { this.exitCode = code; this.emit('exit', code); }
}

let stateDir: string;
let child: FakeChild;
let spawnCalls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }>;
let alive: boolean;

const spawn: SessionSpawn = (command, args, options): SpawnedSession => {
  spawnCalls.push({ command, args, env: options.env });
  return child;
};

function host_make(): ProcessHost {
  return new ProcessHost({ stateDir, chellEntry: '/opt/chell/dist/index.js', spawn, alive: async (): Promise<boolean> => alive, bootTimeoutMs: 2_000, pollMs: 20 });
}

function berth_plant(host: ProcessHost, pid?: number): void {
  const runtime: string = host.dirs_build(IDENTITY).runtime;
  const path: string = berth_pathIn(runtime, IDENTITY);
  mkdirSync(join(runtime, 'calypso'), { recursive: true });
  writeFileSync(path, JSON.stringify({ identity: IDENTITY, url: 'ws://127.0.0.1:4444', token: 'ATTACH', ...(pid !== undefined ? { pid } : {}) }));
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'porter-host-'));
  child = new FakeChild();
  spawnCalls = [];
  alive = true;
});
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

describe('ProcessHost', () => {
  it('finds nothing before a session exists, and a berth that answers after', async () => {
    const host: ProcessHost = host_make();
    expect(await host.find(IDENTITY)).toBeNull();
    berth_plant(host);
    expect(await host.find(IDENTITY)).toEqual({ identity: IDENTITY, url: 'ws://127.0.0.1:4444', token: 'ATTACH' });
    alive = false;
    expect(await host.find(IDENTITY)).toBeNull();
  });

  it('starts chell with the token on stdin, in four directories of its own', async () => {
    const host: ProcessHost = host_make();
    const starting: Promise<unknown> = host.spawn(IDENTITY, 'chris', 'https://cube.example.org/api/v1/', 'MINTED');
    await new Promise((r) => setTimeout(r, 30));
    const call = spawnCalls[0];
    expect(call).toBeDefined();
    expect(call?.command).toBe(process.execPath);
    expect(call?.args).toEqual(['/opt/chell/dist/index.js', 'chris@https://cube.example.org/api/v1/', '--daemon', '--auth-token-stdin', '--no-logo']);
    expect(call?.args.join(' ')).not.toContain('MINTED');
    expect(child.stdinText).toBe('MINTED\n');
    const dirs = host.dirs_build(IDENTITY);
    expect(call?.env.XDG_CONFIG_HOME).toBe(dirs.config);
    expect(call?.env.XDG_RUNTIME_DIR).toBe(dirs.runtime);
    expect(call?.env.XDG_CACHE_HOME).toBe(dirs.cache);
    expect(call?.env.TMPDIR).toBe(dirs.tmp);
    for (const dir of Object.values(dirs)) expect(existsSync(dir)).toBe(true);
    berth_plant(host);
    const berth = await starting;
    expect(berth).toEqual({ identity: IDENTITY, url: 'ws://127.0.0.1:4444', token: 'ATTACH' });
  });

  it('keeps the boot for a follower, and tells one who is there', async () => {
    const host: ProcessHost = host_make();
    const starting: Promise<unknown> = host.spawn(IDENTITY, 'chris', 'https://cube.example.org/api/v1/', 'MINTED');
    await new Promise((r) => setTimeout(r, 10));
    child.stdout.write('[ OK ] Session\n[ OK ] Con');
    child.stderr.write('warm\n');
    await new Promise((r) => setTimeout(r, 10));
    const seen: BootLine[] = [];
    let ended: string | null = null;
    const followed = host.boot_follow(IDENTITY, { line: (line: BootLine): void => { seen.push(line); }, done: (state: string): void => { ended = state; } });
    expect(followed?.report.state).toBe('booting');
    expect(followed?.report.lines).toEqual([{ channel: 'out', text: '[ OK ] Session', id: 0 }, { channel: 'err', text: 'warm', id: 1 }]);
    child.stdout.write('nect\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([{ channel: 'out', text: '[ OK ] Connect', id: 2 }]);
    berth_plant(host);
    await starting;
    expect(ended).toBe('ready');
    expect(host.boot_follow(IDENTITY, { line: (): void => undefined, done: (): void => undefined })?.report.state).toBe('ready');
  });

  it('settles an open row in place: the outcome of a [PENDING] step replaces it, for the follower and the late one alike', async () => {
    const host: ProcessHost = host_make();
    const starting: Promise<unknown> = host.spawn(IDENTITY, 'chris', 'https://cube.example.org/api/v1/', 'MINTED');
    await new Promise((r) => setTimeout(r, 10));
    const seen: BootLine[] = [];
    host.boot_follow(IDENTITY, { line: (line: BootLine): void => { seen.push(line); }, done: (): void => undefined });
    // The tags arrive coloured (FORCE_COLOR under porter), padded as chell pads them.
    child.stdout.write('\x1b[36m[PENDING]  \x1b[39m Feeds        Warming /home/x/feeds behind the prompt\n');
    child.stdout.write('\x1b[36m[PENDING]  \x1b[39m Queries      Indexing prior PACS queries behind the prompt\n');
    child.stdout.write('\x1b[32m[ OK ]     \x1b[39m Groups       Cached 71 groups\n');
    child.stdout.write('\x1b[33m[RETRY]    \x1b[39m Feeds        CUBE is slow; asking again\n');
    child.stdout.write('\x1b[32m[ OK ]     \x1b[39m Queries      2100 PACS queries indexed, 33 new\n');
    child.stdout.write('\x1b[32m[ OK ]     \x1b[39m Feeds        Cached 2477 feeds\n');
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.map((line: BootLine): [number | undefined, number | undefined] => [line.id, line.replaces])).toEqual([[0, undefined], [1, undefined], [2, undefined], [0, 0], [1, 1], [0, 0]]);
    // The kept boot holds each step once, settled, in the row it opened on.
    const late = host.boot_follow(IDENTITY, { line: (): void => undefined, done: (): void => undefined });
    expect(late?.report.lines.map((line: BootLine): string => line.text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim())).toEqual([
      '[ OK ] Feeds Cached 2477 feeds',
      '[ OK ] Queries 2100 PACS queries indexed, 33 new',
      '[ OK ] Groups Cached 71 groups',
    ]);
    // A settled label that opens again is a new row, not the old one.
    child.stdout.write('[PENDING]   Feeds        full roster refresh\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(seen[seen.length - 1]).toEqual({ channel: 'out', text: '[PENDING]   Feeds        full roster refresh', id: 3 });
    berth_plant(host);
    await starting;
  });

  it('fails the boot when the child exits first', async () => {
    const host: ProcessHost = host_make();
    const starting: Promise<unknown> = host.spawn(IDENTITY, 'chris', 'https://cube.example.org/api/v1/', 'BAD');
    await new Promise((r) => setTimeout(r, 10));
    child.exit(1);
    await expect(starting).rejects.toThrow('exited during boot (code 1)');
    expect(host.boot_follow(IDENTITY, { line: (): void => undefined, done: (): void => undefined })?.report.state).toBe('failed');
  });

  it('gives up on a boot that never answers, and kills the child', async () => {
    const host: ProcessHost = new ProcessHost({ stateDir, chellEntry: '/opt/chell/dist/index.js', spawn, alive: async (): Promise<boolean> => true, bootTimeoutMs: 100, pollMs: 20 });
    await expect(host.spawn(IDENTITY, 'chris', 'https://cube.example.org/api/v1/', 'MINTED')).rejects.toThrow('did not answer');
    expect(child.killed).toBe('SIGTERM');
  });

  it('joins a boot already under way rather than starting a rival', async () => {
    const host: ProcessHost = host_make();
    const first: Promise<unknown> = host.spawn(IDENTITY, 'chris', 'https://cube.example.org/api/v1/', 'MINTED');
    const second: Promise<unknown> = host.spawn(IDENTITY, 'chris', 'https://cube.example.org/api/v1/', 'MINTED');
    berth_plant(host);
    const [one, two] = await Promise.all([first, second]);
    expect(two).toEqual(one);
    expect(spawnCalls.length).toBe(1);
  });

  it('begins a boot without holding anyone, and records how it ended', async () => {
    const host: ProcessHost = host_make();
    host.spawn_begin(IDENTITY, 'chris', 'https://cube.example.org/api/v1/', 'BAD');
    await new Promise((r) => setTimeout(r, 10));
    child.exit(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(host.boot_follow(IDENTITY, { line: (): void => undefined, done: (): void => undefined })?.report).toMatchObject({ state: 'failed', reason: 'the session exited during boot (code 1)' });
  });

  it('evicts a session it started, and says so', async () => {
    const host: ProcessHost = host_make();
    const starting: Promise<unknown> = host.spawn(IDENTITY, 'chris', 'https://cube.example.org/api/v1/', 'MINTED');
    berth_plant(host);
    await starting;
    expect(await host.evict(IDENTITY)).toBe(true);
    expect(child.killed).toBe('SIGTERM');
    // The daemon is gone and its berth no longer answers: there is nothing more to end.
    alive = false;
    expect(await host.evict(IDENTITY)).toBe(false);
  });
});

describe('a porter restarted', () => {
  it('adopts the sessions its state directory holds, and ends an adopted one by its berth\'s pid', async () => {
    const killed: Array<{ pid: number; signal: string }> = [];
    let gone: boolean = false;
    const host: ProcessHost = new ProcessHost({ stateDir, chellEntry: '/opt/chell/dist/index.js', spawn, alive: async (): Promise<boolean> => alive, kill: (pid: number, signal: NodeJS.Signals): void => { killed.push({ pid, signal }); gone = true; }, processStart_read: (): string | null => (gone ? null : '1000') });
    berth_plant(host, 31337);
    const sightings = await host.sessions_adopt();
    expect(sightings).toEqual([{ identity: IDENTITY, berth: { identity: IDENTITY, url: 'ws://127.0.0.1:4444', token: 'ATTACH', pid: 31337 }, alive: true }]);
    expect(host.boot_follow(IDENTITY, { line: (): void => undefined, done: (): void => undefined })?.report.state).toBe('ready');
    expect(await host.evict(IDENTITY)).toBe(true);
    expect(killed).toEqual([{ pid: 31337, signal: 'SIGTERM' }]);
  });

  /** A host over an adopted pid whose process the test stands in: signals noted, start time as the test says. */
  function adopted_make(world: { started: string | null | undefined; onSignal: (signal: NodeJS.Signals) => void }, killed: string[]): ProcessHost {
    return new ProcessHost({
      stateDir, chellEntry: '/opt/chell/dist/index.js', spawn, alive: async (): Promise<boolean> => alive, pollMs: 5, stopWaitMs: 40, killWaitMs: 40,
      kill: (_pid: number, signal: NodeJS.Signals): void => { killed.push(signal); world.onSignal(signal); },
      processStart_read: (): string | null | undefined => world.started,
    });
  }

  it('does not signal an adopted pid that has become another process', async () => {
    const killed: string[] = [];
    const world = { started: '1000' as string | null, onSignal: (): void => undefined };
    const host: ProcessHost = adopted_make(world, killed);
    berth_plant(host, 31337);
    await host.sessions_adopt();
    // The daemon went and its pid was given to something else, started later.
    world.started = '2000';
    await expect(host.evict(IDENTITY)).rejects.toThrow('pid 31337 is no longer the session\'s calypso daemon; it was not signalled');
    expect(killed).toEqual([]);
  });

  it('kills an adopted daemon that outlives the wait, and answers once it is gone', async () => {
    const killed: string[] = [];
    const world = { started: '1000' as string | null, onSignal: (signal: NodeJS.Signals): void => { if (signal === 'SIGKILL') world.started = null; } };
    const host: ProcessHost = adopted_make(world, killed);
    berth_plant(host, 31337);
    await host.sessions_adopt();
    expect(await host.evict(IDENTITY)).toBe(true);
    expect(killed).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('does not kill when the pid stopped being the daemon during the wait', async () => {
    const killed: string[] = [];
    const world = { started: '1000' as string | null, onSignal: (): void => { world.started = '2000'; } };
    const host: ProcessHost = adopted_make(world, killed);
    berth_plant(host, 31337);
    await host.sessions_adopt();
    expect(await host.evict(IDENTITY)).toBe(true);
    expect(killed).toEqual(['SIGTERM']);
  });

  it('says so when a daemon is still there after being killed: the stop is not reported done', async () => {
    const killed: string[] = [];
    const world = { started: '1000' as string | null, onSignal: (): void => undefined };
    const host: ProcessHost = adopted_make(world, killed);
    berth_plant(host, 31337);
    await host.sessions_adopt();
    await expect(host.evict(IDENTITY)).rejects.toThrow('the old calypso daemon did not stop, even when killed');
    expect(killed).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('keeps what proved the pid through a failed stop: a second and a third try are refused the same way', async () => {
    const killed: string[] = [];
    const world = { started: '1000' as string | null | undefined, onSignal: (): void => undefined };
    const host: ProcessHost = adopted_make(world, killed);
    berth_plant(host, 31337);
    await host.sessions_adopt();
    world.started = '2000';
    for (let attempt: number = 0; attempt < 3; attempt++) {
      await expect(host.evict(IDENTITY)).rejects.toThrow('pid 31337 is no longer the session\'s calypso daemon; it was not signalled');
    }
    // And through a restart that failed on it.
    host.restart_begin(IDENTITY, 'chris', 'https://cube.example.org/api/v1/');
    await new Promise((r) => setTimeout(r, 60));
    await expect(host.evict(IDENTITY)).rejects.toThrow('it was not signalled');
    expect(killed).toEqual([]);
  });

  it('where the process cannot be read at all, an adopted pid is asked to stop but never killed, and that is said', async () => {
    const killed: string[] = [];
    const world = { started: undefined as string | null | undefined, onSignal: (): void => undefined };
    const host: ProcessHost = adopted_make(world, killed);
    berth_plant(host, 31337);
    await host.sessions_adopt();
    await expect(host.evict(IDENTITY)).rejects.toThrow('pid 31337 could not be proved to be the session\'s calypso daemon (its process cannot be read from /proc); it was asked to stop and did not, and was not killed');
    expect(killed).toEqual(['SIGTERM']);
    // A restart says it on its boot record, and starts nothing.
    host.restart_begin(IDENTITY, 'chris', 'https://cube.example.org/api/v1/');
    await new Promise((r) => setTimeout(r, 120));
    expect(host.boot_follow(IDENTITY, { line: (): void => undefined, done: (): void => undefined })?.report).toMatchObject({ state: 'failed', reason: expect.stringContaining('was not killed') });
    expect(killed).toEqual(['SIGTERM', 'SIGTERM']);
    expect(spawnCalls).toEqual([]);
  });

  it('a pid that was proved and can no longer be read is not signalled', async () => {
    const killed: string[] = [];
    const world = { started: '1000' as string | null | undefined, onSignal: (): void => undefined };
    const host: ProcessHost = adopted_make(world, killed);
    berth_plant(host, 31337);
    await host.sessions_adopt();
    world.started = undefined;
    await expect(host.evict(IDENTITY)).rejects.toThrow('could not be proved to be the session\'s calypso daemon (its process can no longer be read from /proc); it was not signalled');
    expect(killed).toEqual([]);
  });

  it('a berth that stops answering is not a daemon that is gone: a live process is killed, and one that cannot be read is reported unconfirmed', async () => {
    // Its process readable: the berth goes silent at TERM, the process lives on, and is killed.
    const killed: string[] = [];
    const world = { started: '1000' as string | null | undefined, onSignal: (signal: NodeJS.Signals): void => { alive = false; if (signal === 'SIGKILL') world.started = null; } };
    const host: ProcessHost = adopted_make(world, killed);
    berth_plant(host, 31337);
    await host.sessions_adopt();
    expect(await host.evict(IDENTITY)).toBe(true);
    expect(killed).toEqual(['SIGTERM', 'SIGKILL']);
    // Its process not readable: silence proves nothing, and the stop is reported unconfirmed.
    alive = true;
    const blindKilled: string[] = [];
    const blind = { started: undefined as string | null | undefined, onSignal: (): void => { alive = false; } };
    const blindHost: ProcessHost = adopted_make(blind, blindKilled);
    await blindHost.sessions_adopt();
    await expect(blindHost.evict(IDENTITY)).rejects.toThrow('the calypso daemon no longer answers, but its exit could not be confirmed');
    expect(blindKilled).toEqual(['SIGTERM']);
  });

  it('a proved daemon whose berth is already silent is still stopped: silence before the first signal is not "nothing was running"', async () => {
    const killed: string[] = [];
    const world = { started: '1000' as string | null | undefined, onSignal: (signal: NodeJS.Signals): void => { if (signal === 'SIGTERM') world.started = null; } };
    const host: ProcessHost = adopted_make(world, killed);
    berth_plant(host, 31337);
    await host.sessions_adopt();
    // The berth stops answering, and its file goes; the process lives.
    alive = false;
    rmSync(berth_pathIn(host.dirs_build(IDENTITY).runtime, IDENTITY));
    expect(await host.evict(IDENTITY)).toBe(true);
    expect(killed).toEqual(['SIGTERM']);
    // And one whose process is known to be gone is "nothing was running", with nothing signalled.
    expect(await host.evict(IDENTITY)).toBe(false);
    expect(killed).toEqual(['SIGTERM']);
  });

  it('an adopted daemon that was never proved and has gone silent is not forgotten: each try says its exit could not be confirmed', async () => {
    const killed: string[] = [];
    const world = { started: undefined as string | null | undefined, onSignal: (): void => undefined };
    const host: ProcessHost = adopted_make(world, killed);
    berth_plant(host, 31337);
    await host.sessions_adopt();
    alive = false;
    for (let attempt: number = 0; attempt < 2; attempt++) {
      await expect(host.evict(IDENTITY)).rejects.toThrow('the calypso daemon no longer answers, but its exit could not be confirmed');
    }
    // A restart does not start a daemon beside it.
    host.restart_begin(IDENTITY, 'chris', 'https://cube.example.org/api/v1/');
    await new Promise((r) => setTimeout(r, 80));
    expect(host.boot_follow(IDENTITY, { line: (): void => undefined, done: (): void => undefined })?.report.state).toBe('failed');
    expect(spawnCalls).toEqual([]);
    expect(killed).toEqual([]);
  });

  it('a pid that could not be read when it was adopted is asked to stop on its berth\'s word and never killed, whatever is read of it later', async () => {
    const killed: string[] = [];
    const world = { started: undefined as string | null | undefined, onSignal: (): void => undefined };
    const host: ProcessHost = adopted_make(world, killed);
    berth_plant(host, 31337);
    await host.sessions_adopt();
    world.started = '5000';
    await expect(host.evict(IDENTITY)).rejects.toThrow('it was asked to stop and did not, and was not killed');
    expect(killed).toEqual(['SIGTERM']);
  });

  it('a pid that was no process when it was adopted is never signalled: what holds the number later is another', async () => {
    const killed: string[] = [];
    const world = { started: null as string | null | undefined, onSignal: (): void => undefined };
    const host: ProcessHost = adopted_make(world, killed);
    berth_plant(host, 31337);
    await host.sessions_adopt();
    world.started = '5000';
    for (let attempt: number = 0; attempt < 2; attempt++) {
      await expect(host.evict(IDENTITY)).rejects.toThrow('pid 31337 was not a process when the session was adopted');
    }
    expect(killed).toEqual([]);
  });

  it.each([['no pid', undefined], ['pid 0', 0], ['a negative pid', -31337], ['pid 1', 1]])('a berth that answers and names %s is a daemon not stopped: nothing is signalled, and the stop fails', async (_name: string, pid: number | undefined) => {
    const killed: string[] = [];
    const world = { started: '1000' as string | null | undefined, onSignal: (): void => undefined };
    const host: ProcessHost = adopted_make(world, killed);
    berth_plant(host, pid);
    await host.sessions_adopt();
    await expect(host.evict(IDENTITY)).rejects.toThrow('the session\'s berth answers but names no process that can be stopped; nothing was signalled');
    expect(killed).toEqual([]);
  });

  it('an unproved pid is not signalled once the berth names another', async () => {
    const killed: string[] = [];
    const world = { started: undefined as string | null | undefined, onSignal: (): void => undefined };
    const host: ProcessHost = adopted_make(world, killed);
    berth_plant(host, 31337);
    await host.sessions_adopt();
    // The berth file is written again, by a daemon with another pid.
    berth_plant(host, 40404);
    await expect(host.evict(IDENTITY)).rejects.toThrow('the session\'s berth no longer names pid 31337; nothing was signalled');
    expect(killed).toEqual([]);
  });

  it('a restart whose old daemon will not stop ends its boot failed and starts nothing beside it', async () => {
    const killed: string[] = [];
    const world = { started: '1000' as string | null, onSignal: (): void => undefined };
    const host: ProcessHost = adopted_make(world, killed);
    berth_plant(host, 31337);
    await host.sessions_adopt();
    host.restart_begin(IDENTITY, 'chris', 'https://cube.example.org/api/v1/');
    expect(host.boot_follow(IDENTITY, { line: (): void => undefined, done: (): void => undefined })?.report.state).toBe('booting');
    await new Promise((r) => setTimeout(r, 200));
    const report = host.boot_follow(IDENTITY, { line: (): void => undefined, done: (): void => undefined })?.report;
    expect(report).toMatchObject({ state: 'failed', reason: 'the old calypso daemon did not stop, even when killed' });
    expect(spawnCalls).toEqual([]);
  });

  it('kills a child it started that ignores the request to stop', async () => {
    class Stubborn extends FakeChild {
      public signals: string[] = [];
      kill(signal?: NodeJS.Signals): boolean { this.signals.push(signal ?? 'SIGTERM'); if (signal === 'SIGKILL') this.exit(137); return true; }
    }
    const stubborn: Stubborn = new Stubborn();
    const host: ProcessHost = new ProcessHost({ stateDir, chellEntry: '/opt/chell/dist/index.js', spawn: (): SpawnedSession => stubborn, alive: async (): Promise<boolean> => alive, bootTimeoutMs: 2_000, pollMs: 5, stopWaitMs: 40, killWaitMs: 40 });
    const starting: Promise<unknown> = host.spawn(IDENTITY, 'chris', 'https://cube.example.org/api/v1/', 'MINTED');
    berth_plant(host);
    await starting;
    expect(await host.evict(IDENTITY)).toBe(true);
    expect(stubborn.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('lists a berth whose daemon is gone as such, and never signals its pid', async () => {
    const killed: number[] = [];
    alive = false;
    const host: ProcessHost = new ProcessHost({ stateDir, chellEntry: '/opt/chell/dist/index.js', spawn, alive: async (): Promise<boolean> => alive, kill: (pid: number): void => { killed.push(pid); } });
    berth_plant(host, 31337);
    expect((await host.sessions_adopt())[0]?.alive).toBe(false);
    expect(await host.evict(IDENTITY)).toBe(false);
    expect(killed).toEqual([]);
  });

  it('keeps only the last boot lines for a late follower', async () => {
    const host: ProcessHost = host_make();
    const starting: Promise<unknown> = host.spawn(IDENTITY, 'chris', 'https://cube.example.org/api/v1/', 'MINTED');
    await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < BOOT_LINES_KEPT + 5; i++) child.stdout.write(`line ${i}\n`);
    await new Promise((r) => setTimeout(r, 30));
    const report = host.boot_follow(IDENTITY, { line: (): void => undefined, done: (): void => undefined })?.report;
    expect(report?.lines.length).toBe(BOOT_LINES_KEPT);
    expect(report?.lines[0]?.text).toBe('line 5');
    berth_plant(host);
    await starting;
  });
});

describe('bootRow_parse', () => {
  it('reads the tag and label through colour, and knows which rows stay open', () => {
    expect(bootRow_parse('\x1b[36m[PENDING]  \x1b[39m Feeds   Warming')).toEqual({ label: 'Feeds', open: true });
    expect(bootRow_parse('[RETRY]     Feeds   again')).toEqual({ label: 'Feeds', open: true });
    expect(bootRow_parse('[ OK ]      Feeds   Cached')).toEqual({ label: 'Feeds', open: false });
    expect(bootRow_parse('[FAIL]      Shared  no')).toEqual({ label: 'Shared', open: false });
    expect(bootRow_parse('          Plugins      Prefetching /bin for completions')).toBeNull();
    expect(bootRow_parse('[+] Session initialized.')).toBeNull();
  });
});

describe('ProcessHost restart', () => {
  const CUBE: string = 'https://cube.example.org/api/v1/';

  it('leaves the old daemon its reason, ends it, and boots a fresh one on the saved login, all as one boot', async () => {
    const children: FakeChild[] = [new FakeChild(), new FakeChild()];
    const calls: string[][] = [];
    const host: ProcessHost = new ProcessHost({
      stateDir, chellEntry: '/opt/chell/dist/index.js', alive: async (): Promise<boolean> => alive, bootTimeoutMs: 2_000, pollMs: 20,
      spawn: (_command, args): SpawnedSession => { calls.push(args); return children[calls.length - 1] as FakeChild; },
    });
    const first: Promise<unknown> = host.spawn(IDENTITY, 'chris', CUBE, 'MINTED');
    berth_plant(host);
    await first;

    host.restart_begin(IDENTITY, 'chris', CUBE);
    const lines: string[] = [];
    const followed = host.boot_follow(IDENTITY, { line: (line: BootLine): void => { lines.push(line.text); }, done: (): void => undefined });
    expect(followed?.report.state).toBe('booting');
    expect(followed?.report.lines[0]?.text).toBe('Restarting the calypso daemon, as asked');
    await new Promise((r) => setTimeout(r, 80));
    expect(children[0]?.killed).toBe('SIGTERM');
    const closing: string = join(host.dirs_build(IDENTITY).runtime, 'calypso', `closing-${(await import('@fnndsc/calypso/berth')).berthKey_compute(IDENTITY)}.json`);
    expect(existsSync(closing)).toBe(true);
    expect(calls[1]).toEqual(['/opt/chell/dist/index.js', `chris@${CUBE}`, '--daemon', '--saved-token', '--no-logo']);
    expect(children[1]?.stdinText).toBe('');
    expect(lines.some((text: string): boolean => /fresh calypso daemon/.test(text))).toBe(true);
    berth_plant(host);
    await new Promise((r) => setTimeout(r, 80));
    expect(host.boot_follow(IDENTITY, { line: (): void => undefined, done: (): void => undefined })?.report.state).toBe('ready');
  });

  it('says in plain words why a session restarts: a stale daemon names the packages that moved', () => {
    expect(restartLine_render({ kind: 'stale', behind: ['brasa 0.31.5 → 0.33.0', 'argus 0.26.3 → 0.26.4'] })).toBe('Restarting a stale calypso daemon (brasa 0.31.5 → 0.33.0, argus 0.26.3 → 0.26.4)');
    expect(restartLine_render({ kind: 'stale', behind: [] })).toBe('Restarting a stale calypso daemon');
    expect(restartLine_render({ kind: 'asked' })).toBe('Restarting the calypso daemon, as asked');
    expect(restartLine_render({ kind: 'saved-login' })).toBe('Starting a calypso daemon on the saved login');
  });

  it('ends the boot failed, with the reason, when the saved login is refused', async () => {
    const children: FakeChild[] = [new FakeChild(), new FakeChild()];
    let n: number = 0;
    const host: ProcessHost = new ProcessHost({
      stateDir, chellEntry: '/opt/chell/dist/index.js', alive: async (): Promise<boolean> => alive, bootTimeoutMs: 2_000, pollMs: 20,
      spawn: (): SpawnedSession => children[n++] as FakeChild,
    });
    const first: Promise<unknown> = host.spawn(IDENTITY, 'chris', CUBE, 'MINTED');
    berth_plant(host);
    await first;
    rmSync(berth_pathIn(host.dirs_build(IDENTITY).runtime, IDENTITY));
    host.restart_begin(IDENTITY, 'chris', CUBE);
    await new Promise((r) => setTimeout(r, 60));
    children[1]?.exit(1);
    await new Promise((r) => setTimeout(r, 60));
    const report = host.boot_follow(IDENTITY, { line: (): void => undefined, done: (): void => undefined })?.report;
    expect(report?.state).toBe('failed');
    expect(report?.reason).toMatch(/exited during boot/);
  });

  it('an administrator\'s end leaves the daemon the reason "end"', async () => {
    const host: ProcessHost = host_make();
    const first: Promise<unknown> = host.spawn(IDENTITY, 'chris', CUBE, 'MINTED');
    berth_plant(host);
    await first;
    expect(await host.evict(IDENTITY)).toBe(true);
    const { berthKey_compute } = await import('@fnndsc/calypso/berth');
    const left = JSON.parse((await import('node:fs')).readFileSync(join(host.dirs_build(IDENTITY).runtime, 'calypso', `closing-${berthKey_compute(IDENTITY)}.json`), 'utf8')) as { cause: string };
    expect(left.cause).toBe('end');
  });
});

describe('a stratus session', () => {
  const STRATUS: string = `stratus:oci@${IDENTITY}`;

  it('starts stratus on the person\'s config, read-only unless asked, in a home and state of its own', async () => {
    const host: ProcessHost = new ProcessHost({ stateDir, chellEntry: '/opt/chell/dist/index.js', stratusEntry: '/opt/stratus/dist/stratus.js', spawn, alive: async (): Promise<boolean> => alive, bootTimeoutMs: 2_000, pollMs: 20 });
    host.stratus_begin(STRATUS, '/creds/oci/config', false, false, { cubeUrl: 'https://cube.example.org/api/v1/', user: 'rudolph' });
    // The daemon names its berth by its cloud identity; the one in the session's directory is the session's.
    const runtime: string = host.dirs_build(STRATUS).runtime;
    mkdirSync(join(runtime, 'calypso'), { recursive: true });
    writeFileSync(berth_pathIn(runtime, 'me@fnndsc-bch'), JSON.stringify({ identity: 'me@fnndsc-bch', url: 'ws://127.0.0.1:5555', token: 'T' }));
    for (let i = 0; i < 20 && (await host.find(STRATUS)) === null; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await host.find(STRATUS)).toMatchObject({ url: 'ws://127.0.0.1:5555' });
    expect(spawnCalls[0]?.args).toEqual(['/opt/stratus/dist/stratus.js', '--config', '/creds/oci/config']);
    expect(spawnCalls[0]?.env['XDG_STATE_HOME']).toMatch(/\/state$/);
    expect(spawnCalls[0]?.env['HOME']).toMatch(/\/home$/);
    // The door, for a READ session to be raised at with the person's password (D14).
    expect(spawnCalls[0]?.env['CALYPSO_ELEVATION_URL']).toBe('https://cube.example.org/api/v1/');
    expect(spawnCalls[0]?.env['CALYPSO_ELEVATION_USER']).toBe('rudolph');
    expect(host.stratus_armed(STRATUS)).toBe(false);
    // A porter restarted adopts it under the session's identity, not the cloud's.
    const again: ProcessHost = new ProcessHost({ stateDir, chellEntry: '/opt/chell/dist/index.js', alive: async (): Promise<boolean> => true });
    expect((await again.sessions_adopt()).map((sighting) => sighting.identity)).toContain(STRATUS);
  });

  it('refuses to start when this porter carries no stratus', async () => {
    const host: ProcessHost = host_make();
    host.stratus_begin(STRATUS, '/creds/oci/config', true, false);
    for (let i = 0; i < 20 && host.boot_follow(STRATUS, { line: () => undefined, done: () => undefined })?.report.state === 'booting'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(host.boot_follow(STRATUS, { line: () => undefined, done: () => undefined })?.report).toMatchObject({ state: 'failed', reason: 'this porter has no stratus to start' });
  });
});

describe('the boot lines a greeter is shown', () => {
  it('never carry the attach token: the porter holds it', async () => {
    const { bootLine_redact } = await import('../../src/host/processHost.js');
    const token: string = '8dfe664ed7b943d5cad82efd59b9a2729999abe456b7a0ee8c8a4bd7dae0c0c3';
    expect(bootLine_redact(`    token:     ${token}`)).toBe('    token:     (held by the porter)');
    expect(bootLine_redact(`[+] ARGUS web surface at http://127.0.0.1:4000/?token=${token}`)).toBe('[+] ARGUS web surface at http://127.0.0.1:4000/?token=…');
    expect(bootLine_redact(`    from another machine:   chell --remote --attach ws://h:1 --token ${token}`)).toBe('    from another machine:   chell --remote --attach ws://h:1 --token …');
    expect(bootLine_redact('[ OK ] Feeds')).toBe('[ OK ] Feeds');
  });
});

describe('a porter that runs sessions on its host and the cloud session', () => {
  it('can start one when it carries stratus, and says why not when it does not', () => {
    const dir: string = mkdtempSync(join(tmpdir(), 'porter-stratus-'));
    const spawn: SessionSpawn = (): SpawnedSession => { throw new Error('not asked'); };
    expect(new ProcessHost({ stateDir: dir, chellEntry: '/opt/chell/dist/index.js', stratusEntry: '/opt/stratus/dist/stratus.js', spawn }).stratus_refusal()).toBeNull();
    expect(new ProcessHost({ stateDir: dir, chellEntry: '/opt/chell/dist/index.js', spawn }).stratus_refusal()).toBe('this porter has no stratus to start');
    rmSync(dir, { recursive: true, force: true });
  });
});
