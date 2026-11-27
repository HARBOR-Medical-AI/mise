/**
 * @file The daemon's terminal becomes its first surface once the engine is
 * ready, and stays the daemon's own between attachments. The surface it
 * spawns is injected — chell spawns itself, the calypso binary spawns
 * `chell` from the path.
 *
 * @module
 */
import { describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';

jest.mock('../src/daemon/console', () => ({
  consoleCage_start: jest.fn(),
  consoleCage_stop: jest.fn((): string[] => []),
}));

import {
  daemonConsole_run,
  surface_spawn,
  enter_await,
  CHELL_ON_PATH,
  chellLaunch_find,
  type DaemonConsoleDeps,
} from '../src/daemon/consoleSession';

type Deps = NonNullable<Parameters<typeof daemonConsole_run>[1]>;
const TARGET = { identity: 'me@https://cube.example.org/api/v1/', url: 'ws://pangea.tch.harvard.edu:42655', token: 'tok' };
const ANSI: RegExp = /\[[0-9;]*m/g;

function deps_make(overrides: Partial<Deps> = {}): Deps & { lines: string[]; events: string[] } {
  const lines: string[] = [];
  const events: string[] = [];
  const deps: Deps & { lines: string[]; events: string[] } = {
    lines,
    events,
    attach: jest.fn((): { exited: Promise<number> } => { events.push('attach'); return { exited: Promise.resolve(0) }; }),
    cage_start: jest.fn((): void => { events.push('cage_start'); }),
    cage_stop: jest.fn((): string[] => { events.push('cage_stop'); return []; }),
    enter_wait: jest.fn(async (): Promise<boolean> => false),
    log: (line: string): void => { lines.push(line.replace(ANSI, '')); },
    ...overrides,
  };
  return deps;
}

describe('daemonConsole_run', () => {
  it('attaches a surface, cages the daemon\'s writes for the duration, and says how to leave', async () => {
    const deps = deps_make();
    await daemonConsole_run(TARGET, deps);
    expect(deps.attach).toHaveBeenCalledWith(TARGET);
    expect(deps.events).toEqual(['cage_start', 'attach', 'cage_stop']);
    expect(deps.lines[0]).toContain(`Console attached to ${TARGET.identity}`);
    expect(deps.lines[0]).toContain("'exit' detaches");
    expect(deps.lines[deps.lines.length - 1]).toContain('the daemon is still running');
  });

  it('hands back what the daemon wrote while the surface held the terminal, after the surface\'s last line', async () => {
    const deps = deps_make({
      cage_stop: jest.fn((): string[] => ['[ OK ]    Roster       1 feed moved while away', '[ OK ]    Topology     Ready']),
    });
    await daemonConsole_run(TARGET, deps);
    const flushed: number = deps.lines.findIndex((line: string): boolean => line.includes('While the console was attached'));
    expect(flushed).toBeGreaterThan(0);
    expect(deps.lines[flushed + 1]).toContain('Roster');
    expect(deps.lines[flushed + 2]).toContain('Topology');
    expect(deps.lines[flushed + 3]).toContain('Console detached');
  });

  it('says nothing about held output when there was none', async () => {
    const deps = deps_make();
    await daemonConsole_run(TARGET, deps);
    expect(deps.lines.some((line: string): boolean => line.includes('While the console was attached'))).toBe(false);
  });

  it('attaches again on Enter, and returns when the terminal\'s input ends', async () => {
    const answers: boolean[] = [true, true, false];
    const deps = deps_make({ enter_wait: jest.fn(async (): Promise<boolean> => answers.shift() ?? false) });
    await daemonConsole_run(TARGET, deps);
    expect(deps.attach).toHaveBeenCalledTimes(3);
  });

  it('releases the cage even when the surface fails to start', async () => {
    const deps = deps_make({ attach: jest.fn((): { exited: Promise<number> } => { throw new Error('spawn ENOENT'); }) });
    await expect(daemonConsole_run(TARGET, deps)).rejects.toThrow('spawn ENOENT');
    expect(deps.cage_stop).toHaveBeenCalledTimes(1);
  });
});

describe('surface_spawn', () => {
  it('spawns the launch\'s exec with the surface flags, attached by address and marked as the console', async () => {
    const child = new EventEmitter();
    const spawn = jest.fn((): EventEmitter => child);
    const running = surface_spawn(TARGET, { exec: '/usr/bin/node', prefixArgs: ['/app/chell.js'] }, spawn);
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/node',
      ['/app/chell.js', '--remote', TARGET.identity, '--attach', TARGET.url],
      { stdio: 'inherit', env: expect.objectContaining({ CHELL_CONSOLE: '1', CHELL_ATTACH_TOKEN: TARGET.token }) },
    );
    // The token is in the surface's environment and nowhere in its arguments, which every user of the host can list.
    const args: string[] = (spawn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args.join(' ')).not.toContain(TARGET.token);
    expect(args).not.toContain('--token');
    child.emit('exit', 0);
    expect(await running.exited).toBe(0);
  });

  it('defaults to `chell` on the path, and settles 1 when the surface cannot start at all', async () => {
    const byPath = new EventEmitter();
    const spawn = jest.fn((): EventEmitter => byPath);
    const running = surface_spawn(TARGET, CHELL_ON_PATH, spawn);
    expect(spawn.mock.calls[0]?.[0]).toBe('chell');
    expect(spawn.mock.calls[0]?.[1]?.[0]).toBe('--remote');
    // A spawn error (no chell on the path) settles 1 rather than hanging.
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation((): boolean => true);
    byPath.emit('error', new Error('spawn chell ENOENT'));
    expect(await running.exited).toBe(1);
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });
});

describe('enter_await', () => {
  function input_make(): EventEmitter & { resume: jest.Mock; pause: jest.Mock } {
    return Object.assign(new EventEmitter(), { resume: jest.fn(), pause: jest.fn() });
  }

  it('resolves true on a line of input and lets the terminal go', async () => {
    const input = input_make();
    const waiting: Promise<boolean> = enter_await(input);
    expect(input.resume).toHaveBeenCalledTimes(1);
    input.emit('data', Buffer.from('\n'));
    expect(await waiting).toBe(true);
    expect(input.pause).toHaveBeenCalledTimes(1);
    expect(input.listenerCount('data')).toBe(0);
  });

  it('resolves false when the input ends, so the loop returns instead of waiting forever', async () => {
    const input = input_make();
    const waiting: Promise<boolean> = enter_await(input);
    input.emit('end');
    expect(await waiting).toBe(false);
  });
});

describe('chellLaunch_find', () => {
  it('launches the chell installed beside this calypso under this very node', () => {
    const found = chellLaunch_find();
    expect(found).not.toBeNull();
    expect(found?.exec).toBe(process.execPath);
    expect(found?.prefixArgs).toHaveLength(1);
    expect(found?.prefixArgs[0]).toMatch(/[\\/]chell[\\/]dist[\\/]index\.js$/);
  });

  it('is null where no chell is installed, leaving the path to decide', () => {
    expect(chellLaunch_find('file:///nowhere/at/all/calypso.js')).toBeNull();
  });
});
