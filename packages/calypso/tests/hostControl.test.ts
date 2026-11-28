/**
 * @file Host control: parsing, the bind guard, the readout, and the host
 * runners.
 */
import { describe, it, expect } from '@jest/globals';
import {
  HOST_CONTROL_OFF,
  daemonCapabilities_compose,
  engineHost_grants,
  hostControl_build,
  hostControl_parseArgv,
  hostControl_guard,
  hostControl_describe,
  hostControl_tiers,
  hostShell_run,
  hostPipe_run,
  hostShellTerminal_refusal,
} from '../src/daemon/hostControl.js';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

describe('hostControl_build', () => {
  it('is off by default, all tiers when bare, the listed tiers otherwise', () => {
    expect(hostControl_build({})).toEqual({ policy: { tiers: new Set(), exposed: false } });
    const bare = hostControl_build({ flag: true });
    expect('policy' in bare && hostControl_tiers(bare.policy)).toEqual(['shell', 'files', 'pipes']);
    const some = hostControl_build({ flag: 'files,shell' });
    expect('policy' in some && hostControl_tiers(some.policy)).toEqual(['shell', 'files']);
  });
  it('grants tasks only when named: never by bare or all', () => {
    const named = hostControl_build({ flag: 'tasks' });
    expect('policy' in named && hostControl_tiers(named.policy)).toEqual(['tasks']);
    const allPlus = hostControl_build({ flag: 'all,tasks' });
    expect('policy' in allPlus && hostControl_tiers(allPlus.policy)).toEqual(['shell', 'files', 'pipes', 'tasks']);
    const all = hostControl_build({ flag: 'all' });
    expect('policy' in all && hostControl_tiers(all.policy)).toEqual(['shell', 'files', 'pipes']);
    const spaced = hostControl_parseArgv(['node', 'stratus', '--host-control', 'tasks', '--fake'], {});
    expect('policy' in spaced && hostControl_describe(spaced.policy)).toBe('tasks');
  });
  it('the flag wins over the env twin; the env alone counts; unknown words refuse', () => {
    const env = hostControl_build({ env: 'pipes' });
    expect('policy' in env && hostControl_tiers(env.policy)).toEqual(['pipes']);
    const both = hostControl_build({ flag: 'shell', env: 'pipes' });
    expect('policy' in both && hostControl_tiers(both.policy)).toEqual(['shell']);
    expect(hostControl_build({ flag: 'shell,root' })).toEqual({ error: "unknown host-control tier 'root' (shell, files, pipes, tasks, or all)" });
  });
  it('parses a raw argv for the standalone binary', () => {
    const bare = hostControl_parseArgv(['node', 'calypso', '--host-control'], {});
    expect('policy' in bare && hostControl_tiers(bare.policy)).toEqual(['shell', 'files', 'pipes']);
    const eq = hostControl_parseArgv(['node', 'calypso', '--host-control=files', '--expose-host-control'], {});
    expect('policy' in eq && eq.policy).toEqual({ tiers: new Set(['files']), exposed: true });
    const spaced = hostControl_parseArgv(['node', 'calypso', '--host-control', 'pipes', '--berths'], {});
    expect('policy' in spaced && hostControl_tiers(spaced.policy)).toEqual(['pipes']);
  });
});

describe('hostControl_guard', () => {
  const on = { tiers: new Set(['shell'] as const), exposed: false };
  it('needs nothing on loopback or when off', () => {
    expect(hostControl_guard(on, '127.0.0.1')).toBeNull();
    expect(hostControl_guard(HOST_CONTROL_OFF, '0.0.0.0')).toBeNull();
  });
  it('refuses a network bind unless the override was typed', () => {
    expect(hostControl_guard(on, '0.0.0.0')).toContain('--expose-host-control');
    expect(hostControl_guard({ ...on, exposed: true }, '0.0.0.0')).toBeNull();
  });
  it('names spending, not a shell, when only tasks is on', () => {
    expect(hostControl_guard({ tiers: new Set(['tasks'] as const), exposed: false }, '0.0.0.0')).toContain('the power to start jobs that spend money');
    expect(hostControl_guard({ tiers: new Set(['tasks', 'shell'] as const), exposed: false }, '0.0.0.0')).toContain('a shell on this host');
  });
});

describe('the readout and the runners', () => {
  it('describes tiers in canonical order', () => {
    expect(hostControl_describe({ tiers: new Set(['pipes', 'shell'] as const), exposed: false })).toBe('shell pipes');
    expect(hostControl_describe(HOST_CONTROL_OFF)).toBe('');
  });
  it('runs a shell command on the host, streaming both channels, and returns its exit code', async () => {
    const out: Array<[string, string]> = [];
    const code: number = await hostShell_run('echo out; echo err 1>&2; exit 3', (channel, chunk): void => { out.push([channel, chunk.trim()]); });
    expect(code).toBe(3);
    expect(out).toEqual(expect.arrayContaining([['data', 'out'], ['err', 'err']]));
  });
  it('a cancelled host command is killed, its whole group, and says it was stopped', async () => {
    const controller: AbortController = new AbortController();
    const out: string[] = [];
    const started: number = Date.now();
    const running: Promise<number> = hostShell_run('sleep 30 & sleep 30; wait', (_channel, chunk): void => { out.push(chunk); }, controller.signal);
    setTimeout((): void => controller.abort(), 150);
    const code: number = await running;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(code).not.toBe(0);
    expect(out.join('')).toContain('stopped');
  }, 10000);

  it('a cancelled pipe segment is killed too', async () => {
    const controller: AbortController = new AbortController();
    const started: number = Date.now();
    const running: Promise<Buffer> = hostPipe_run('sleep 30', Buffer.from(''), controller.signal);
    setTimeout((): void => controller.abort(), 150);
    await running;
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10000);

  it('runs a pipe segment on the host with the input on stdin', async () => {
    const output: Buffer = await hostPipe_run('tr a-z A-Z', Buffer.from('hello'));
    expect(output.toString('utf8')).toBe('HELLO');
  });
});

describe('a program that waits forever without a terminal', () => {
  // A PATH of its own: an `nvim`, a `vi` that is that nvim, and a `vim` that is not.
  const bin: string = mkdtempSync(path.join(tmpdir(), 'calypso-bin-'));
  writeFileSync(path.join(bin, 'nvim'), '#!/bin/sh\n');
  chmodSync(path.join(bin, 'nvim'), 0o755);
  symlinkSync(path.join(bin, 'nvim'), path.join(bin, 'vi'));
  writeFileSync(path.join(bin, 'vim'), '#!/bin/sh\n');
  chmodSync(path.join(bin, 'vim'), 0o755);
  const env: NodeJS.ProcessEnv = { PATH: bin };
  afterAll((): void => { rmSync(bin, { recursive: true, force: true }); });

  it('is refused by name on pipes, through its links and after assignments', () => {
    expect(hostShellTerminal_refusal('nvim notes.txt', env)).toBe('nvim needs a terminal, and this surface has none: attach chell --remote from a terminal to run it here');
    expect(hostShellTerminal_refusal('  vi notes.txt', env)).toMatch(/^vi needs a terminal/);
    expect(hostShellTerminal_refusal('TERM=xterm nvim', env)).toMatch(/^nvim needs a terminal/);
    expect(hostShellTerminal_refusal(`${path.join(bin, 'vi')} x`, env)).toMatch(/needs a terminal/);
  });

  it('runs when headless, and anything else runs', () => {
    expect(hostShellTerminal_refusal('nvim --headless +q', env)).toBeNull();
    expect(hostShellTerminal_refusal('nvim -es -c q', env)).toBeNull();
    expect(hostShellTerminal_refusal('nvim --version', env)).toBeNull();
    expect(hostShellTerminal_refusal('vim notes.txt', env)).toBeNull();
    expect(hostShellTerminal_refusal('ls -l', env)).toBeNull();
    expect(hostShellTerminal_refusal('FOO=1', env)).toBeNull();
    expect(hostShellTerminal_refusal('', {})).toBeNull();
    expect(hostShellTerminal_refusal('nvim x', {})).toMatch(/needs a terminal/);
  });
});

describe('engineHost_grants', () => {
  it('lets the engine start programs on this host only with the shell tier: pipes, files or tasks alone do not', () => {
    const grants = (...tiers: Array<'shell' | 'files' | 'pipes' | 'tasks'>) => engineHost_grants({ tiers: new Set(tiers), exposed: false });
    expect([grants(), grants('pipes'), grants('files'), grants('tasks')].map((one) => one.engineProcesses)).toEqual([false, false, false, false]);
    expect(grants('shell').engineProcesses).toBe(true);
    // A host pipeline is the pipes tier's: it runs here, while programs of the engine's own stay refused.
    expect(grants('pipes')).toEqual({ engineFilesystem: false, engineProcesses: false, pipesHere: true });
    expect(grants('files')).toEqual({ engineFilesystem: true, engineProcesses: false, pipesHere: false });
  });
});

describe('daemonCapabilities_compose', () => {
  it('takes what the engine may do on this host from the policy alone: an attached surface claiming every capability, or elevated, raises neither the disk nor programs', () => {
    const claiming = { color: true, pipeSegments: true, fileDelivery: true, localFilesystem: true, engineFilesystem: true, engineProcesses: true } as unknown as Parameters<typeof daemonCapabilities_compose>[0];
    const elevated = { ...(claiming as object), tasks: true } as Parameters<typeof daemonCapabilities_compose>[0];
    const policy = (...tiers: Array<'shell' | 'files' | 'pipes' | 'tasks'>) => ({ tiers: new Set(tiers), exposed: false });
    for (const attached of [claiming, elevated]) {
      expect(daemonCapabilities_compose(attached, HOST_CONTROL_OFF)).toMatchObject({ engineFilesystem: false, engineProcesses: false, color: true, localFilesystem: true });
      expect(daemonCapabilities_compose(attached, policy('pipes'))).toMatchObject({ engineFilesystem: false, engineProcesses: false, pipeSegments: true });
      expect(daemonCapabilities_compose(attached, policy('files'))).toMatchObject({ engineFilesystem: true, engineProcesses: false });
      expect(daemonCapabilities_compose(attached, policy('shell'))).toMatchObject({ engineFilesystem: false, engineProcesses: true });
    }
    // Pipe segments: here under pipes, else only where the acting surface runs them (a browser runs none).
    expect(daemonCapabilities_compose({ pipeSegments: false }, HOST_CONTROL_OFF).pipeSegments).toBe(false);
    expect(daemonCapabilities_compose({ pipeSegments: false }, policy('pipes')).pipeSegments).toBe(true);
    expect(daemonCapabilities_compose(null, HOST_CONTROL_OFF)).toMatchObject({ engineFilesystem: false, engineProcesses: false, pipeSegments: false, color: false });
  });
});

