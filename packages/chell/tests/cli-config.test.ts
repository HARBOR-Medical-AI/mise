/**
 * @file Unit tests for the pure cliConfig_parse derivation.
 *
 * @module
 */
import { describe, it, expect } from '@jest/globals';
import { attachTokenEnv_take, cliConfig_parse } from '../src/core/cli.js';

const noFile = () => false;
const anyFile = () => true;

/** No default door: these cases are the machine-independent ones (a login on this host must not change them). */
const noDoor = (): null => null;

describe('cliConfig_parse', () => {
  it('takes a daemon\'s attach token from the environment when none is typed, and removes it from there whichever wins', () => {
    const handed: NodeJS.ProcessEnv = { CHELL_ATTACH_TOKEN: 'from-the-daemon', OTHER: 'kept' };
    expect(cliConfig_parse(undefined, { attach: 'ws://127.0.0.1:9' }, noFile, noDoor, handed).attachToken).toBe('from-the-daemon');
    expect(handed).toEqual({ OTHER: 'kept' });
    // A token typed on the command line wins, and the variable is still taken out.
    const both: NodeJS.ProcessEnv = { CHELL_ATTACH_TOKEN: 'from-the-daemon' };
    expect(cliConfig_parse(undefined, { attach: 'ws://127.0.0.1:9', token: 'typed' }, noFile, noDoor, both).attachToken).toBe('typed');
    expect('CHELL_ATTACH_TOKEN' in both).toBe(false);
    // An empty one is no token, and is removed too.
    const empty: NodeJS.ProcessEnv = { CHELL_ATTACH_TOKEN: '' };
    expect(cliConfig_parse(undefined, { attach: 'ws://127.0.0.1:9' }, noFile, noDoor, empty).attachToken).toBeUndefined();
    expect('CHELL_ATTACH_TOKEN' in empty).toBe(false);
    expect(attachTokenEnv_take({})).toBeUndefined();
  });

  it('defaults to interactive with no args', () => {
    expect(cliConfig_parse(undefined, {}, noFile, noDoor)).toEqual({ mode: 'interactive', physicalFS: undefined });
  });

  it('--file => script mode with stopOnError from -e', () => {
    const c = cliConfig_parse(undefined, { file: 's.chell', e: true }, noFile, noDoor);
    expect(c.mode).toBe('script');
    expect(c.scriptFile).toBe('s.chell');
    expect(c.stopOnError).toBe(true);
  });

  it('--command => execute mode', () => {
    const c = cliConfig_parse(undefined, { command: 'ls' }, noFile, noDoor);
    expect(c.mode).toBe('execute');
    expect(c.commandToExecute).toBe('ls');
  });

  it('auto-detects an existing target file as a script', () => {
    const c = cliConfig_parse('run.chell', {}, anyFile, noDoor);
    expect(c.mode).toBe('script');
    expect(c.scriptFile).toBe('run.chell');
  });

  it('connect mode from a url, prepending http and parsing user@url', () => {
    const c = cliConfig_parse('chris@cube.example.org', { password: 'pw' }, noFile, noDoor);
    expect(c.mode).toBe('connect');
    expect(c.connectConfig).toEqual({ user: 'chris', password: 'pw', url: 'http://cube.example.org' });
  });

  it('keeps an explicit https url', () => {
    const c = cliConfig_parse('https://secure.org', { user: 'u' }, noFile, noDoor);
    expect(c.connectConfig?.url).toBe('https://secure.org');
  });

  it('takes a door with -u and -p, needing no user@url target', () => {
    const c = cliConfig_parse(undefined, { remote: true, door: 'https://titan/', user: 'chris', password: 'pw' }, noFile, noDoor);
    expect(c.mode).toBe('remote');
    expect(c.door).toBe('https://titan/');
    expect(c.connectConfig).toEqual({ user: 'chris', password: 'pw' });
    const bare = cliConfig_parse(undefined, { remote: true, door: 'https://titan/' }, noFile, noDoor);
    expect(bare.connectConfig).toEqual({});
  });

  it('carries --auth-token-stdin beside the identity, and without one', () => {
    const withIdentity = cliConfig_parse('chris@https://cube.example.org/api/v1/', { daemon: true, authTokenStdin: true }, noFile, noDoor);
    expect(withIdentity.mode).toBe('daemon');
    expect(withIdentity.authTokenStdin).toBe(true);
    expect(withIdentity.connectConfig).toEqual({ user: 'chris', password: undefined, url: 'https://cube.example.org/api/v1/' });
    // The flag survives a target-less invocation so the boot can refuse it by name.
    const alone = cliConfig_parse(undefined, { daemon: true, authTokenStdin: true }, noFile, noDoor);
    expect(alone.authTokenStdin).toBe(true);
    expect(alone.connectConfig).toBeUndefined();
  });

  it('carries --saved-token beside the identity, so a porter can restart a session without the password', () => {
    const c = cliConfig_parse('chris@https://cube.example.org/api/v1/', { daemon: true, savedToken: true }, noFile, noDoor);
    expect(c.mode).toBe('daemon');
    expect(c.savedToken).toBe(true);
    expect(c.authTokenStdin).toBeUndefined();
    expect(c.connectConfig).toEqual({ user: 'chris', password: undefined, url: 'https://cube.example.org/api/v1/' });
  });

  it('applies startup preference toggles', () => {
    const c = cliConfig_parse(undefined, { prefetchFeeds: false, logo: false, asciiBoot: true }, noFile, noDoor);
    expect(c.prefetchFeeds).toBe(false);
    expect(c.showLogo).toBe(false);
    expect(c.asciiBoot).toBe(true);
  });

  it('carries the identity into remote mode when a user@url target is given', () => {
    const c = cliConfig_parse('chris@https://cube.example.org/api/v1/', { remote: true }, noFile, noDoor);
    expect(c.mode).toBe('remote');
    expect(c.connectConfig).toEqual({ user: 'chris', password: undefined, url: 'https://cube.example.org/api/v1/' });
  });

  it('keeps a remote target exactly as typed for berth lookup', () => {
    expect(cliConfig_parse('rudolph@fnndsc', { remote: true }, noFile, noDoor).remoteTarget).toBe('rudolph@fnndsc');
    expect(cliConfig_parse('rudolph.pienaar@childrens.harvard.edu@fnndsc-bch', { remote: true }, noFile, noDoor).remoteTarget)
      .toBe('rudolph.pienaar@childrens.harvard.edu@fnndsc-bch');
    expect(cliConfig_parse('cube.example.org', { remote: true, user: 'chris' }, noFile, noDoor).remoteTarget).toBe('chris@http://cube.example.org');
    expect(cliConfig_parse(undefined, { remote: true }, noFile, noDoor).remoteTarget).toBeUndefined();
  });

  it('retains a one-shot command in remote mode', () => {
    const c = cliConfig_parse(
      'chris@https://cube.example.org/api/v1/',
      { remote: true, command: 'pwd' },
      noFile,
    );
    expect(c.mode).toBe('remote');
    expect(c.commandToExecute).toBe('pwd');
  });

  it('leaves remote mode without a connectConfig for a bare --remote', () => {
    const c = cliConfig_parse(undefined, { remote: true }, noFile, noDoor);
    expect(c).toEqual({ mode: 'remote', connectConfig: undefined });
  });
});

describe('the default door', () => {
  const door = (): string | null => 'https://titan.tch.harvard.edu/';
  const none = (): string | null => null;

  it('a bare chell and a chell -c with no target go through the default door, carrying -e, -u and -p', () => {
    expect(cliConfig_parse(undefined, {}, noFile, door)).toEqual({ mode: 'remote', door: 'https://titan.tch.harvard.edu/', physicalFS: undefined });
    expect(cliConfig_parse(undefined, { command: 'ls /proc/jobs', e: true }, noFile, door)).toEqual({ mode: 'remote', door: 'https://titan.tch.harvard.edu/', physicalFS: undefined, commandToExecute: 'ls /proc/jobs', stopOnError: true });
    expect(cliConfig_parse(undefined, { command: 'pwd', user: 'chris', password: 'pw' }, noFile, door)).toMatchObject({ mode: 'remote', connectConfig: { user: 'chris', password: 'pw' } });
  });

  it('a target, --no-door, a script, a daemon and --remote are never re-routed', () => {
    expect(cliConfig_parse('chris@cube.example.org', {}, noFile, door).mode).toBe('connect');
    expect(cliConfig_parse(undefined, { noDoor: true }, noFile, door)).toEqual({ mode: 'interactive', physicalFS: undefined });
    expect(cliConfig_parse(undefined, { noDoor: true, command: 'pwd' }, noFile, door).mode).toBe('execute');
    expect(cliConfig_parse(undefined, { file: 's.chell' }, noFile, door).mode).toBe('script');
    expect(cliConfig_parse(undefined, { daemon: true }, noFile, door).mode).toBe('daemon');
    expect(cliConfig_parse(undefined, { remote: true, door: 'https://other/', command: 'pwd', e: true }, noFile, door)).toMatchObject({ mode: 'remote', door: 'https://other/', stopOnError: true });
  });

  it('with no default door nothing changes', () => {
    expect(cliConfig_parse(undefined, {}, noFile, none)).toEqual({ mode: 'interactive', physicalFS: undefined });
    expect(cliConfig_parse(undefined, { command: 'pwd' }, noFile, none).mode).toBe('execute');
  });
});
