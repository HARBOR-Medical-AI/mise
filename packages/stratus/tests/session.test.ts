/**
 * @file The session: its identity, home, region and kept working directory.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FakeDriver, fakeCloud_sample } from '../src/cloud/fake/driver.js';
import { StratusSession, configDir_default } from '../src/session.js';

describe('StratusSession', () => {
  let configDir: string;
  beforeEach(() => { configDir = mkdtempSync(path.join(tmpdir(), 'stratus-session-')); });
  afterEach(() => { rmSync(configDir, { recursive: true, force: true }); });

  it('is the cloud user at the tenancy, at home in clusters/, in the credential\'s region', async () => {
    const session = new StratusSession({ driver: new FakeDriver(fakeCloud_sample()), configDir });
    await session.init();
    expect(await session.identity_get()).toEqual({ user: 'rudolph', where: 'fnndsc', connected: true });
    expect(await session.user_get()).toBe('rudolph');
    expect(await session.home_get()).toBe('/net/oci/fnndsc/clusters');
    expect(session.mount).toBe('/net/oci');
    expect(session.tenancyPath).toBe('/net/oci/fnndsc');
    expect(session.cloud).toBe('oci');
    expect(session.region).toBe('us-ashburn-1');
    expect(session.disconnectedReason).toBeNull();
    expect(await session.cwd_load()).toBeNull();
    expect(session.cwd_get()).toBeNull();
  });

  it('keeps the working directory per identity, under the configuration directory, mode 600', async () => {
    const session = new StratusSession({ driver: new FakeDriver(fakeCloud_sample()), configDir });
    await session.init();
    await session.cwd_save('/net/oci/fnndsc/harbor-oci');
    expect(session.cwd_get()).toBe('/net/oci/fnndsc/harbor-oci');
    const file = path.join(configDir, 'rudolph@fnndsc', 'cwd');
    expect(readFileSync(file, 'utf-8')).toBe('/net/oci/fnndsc/harbor-oci\n');
    const again = new StratusSession({ driver: new FakeDriver(fakeCloud_sample()), configDir });
    await again.init();
    expect(await again.cwd_load()).toBe('/net/oci/fnndsc/harbor-oci');
  });

  it('takes the region asked for, and changes it', async () => {
    const session = new StratusSession({ driver: new FakeDriver(fakeCloud_sample()), configDir, region: 'us-phoenix-1' });
    expect(session.region).toBe('us-phoenix-1');
    await session.init();
    expect(session.region).toBe('us-phoenix-1');
    session.region_set('eu-frankfurt-1');
    expect(session.region).toBe('eu-frankfurt-1');
  });

  it('is disconnected@<cloud> when the credential does not work, at home on the mount, keeping nothing', async () => {
    const broken = new (class extends FakeDriver {
      override async identity_get(): Promise<never> { throw new Error('profile DEFAULT not found'); }
    })(fakeCloud_sample());
    const session = new StratusSession({ driver: broken, configDir });
    await session.init();
    expect(await session.identity_get()).toEqual({ user: 'disconnected', where: 'oci', connected: false });
    expect(session.disconnectedReason).toBe('profile DEFAULT not found');
    expect(await session.user_get()).toBeNull();
    expect(await session.home_get()).toBe('/net/oci');
    expect(session.tenancyPath).toBe('/net/oci');
    expect(session.region).toBeNull();
    await session.cwd_save('/net/oci');
    expect(session.cwd_get()).toBe('/net/oci');
    expect(existsSync(path.join(configDir, 'disconnected@oci'))).toBe(false);
  });

  it('finds the configuration directory from XDG_CONFIG_HOME, else ~/.config', () => {
    expect(configDir_default({ XDG_CONFIG_HOME: '/x' })).toBe('/x/mise/stratus');
    expect(configDir_default({})).toMatch(/\.config\/mise\/stratus$/);
  });
});
