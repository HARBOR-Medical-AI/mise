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
    expect(await host.evict(IDENTITY)).toBe(false);
  });
});

describe('a porter restarted', () => {
  it('adopts the sessions its state directory holds, and ends an adopted one by its berth\'s pid', async () => {
    const killed: Array<{ pid: number; signal: string }> = [];
    const host: ProcessHost = new ProcessHost({ stateDir, chellEntry: '/opt/chell/dist/index.js', spawn, alive: async (): Promise<boolean> => alive, kill: (pid: number, signal: NodeJS.Signals): void => { killed.push({ pid, signal }); } });
    berth_plant(host, 31337);
    const sightings = await host.sessions_adopt();
    expect(sightings).toEqual([{ identity: IDENTITY, berth: { identity: IDENTITY, url: 'ws://127.0.0.1:4444', token: 'ATTACH', pid: 31337 }, alive: true }]);
    expect(host.boot_follow(IDENTITY, { line: (): void => undefined, done: (): void => undefined })?.report.state).toBe('ready');
    expect(await host.evict(IDENTITY)).toBe(true);
    expect(killed).toEqual([{ pid: 31337, signal: 'SIGTERM' }]);
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
