import { describe, it, expect, jest } from '@jest/globals';

const config = await import('../src/config/storeConfig.js');

describe('the peer store setting', () => {
  it('reads the default, takes an override, and clears it', () => {
    expect(config.storeUrl_get()).toBe(config.DEFAULT_STORE_URL);
    expect(config.storeUrl_isDefault()).toBe(true);
    config.storeUrl_set('https://peer/api/v1/');
    expect(config.storeUrl_get()).toBe('https://peer/api/v1/');
    expect(config.storeUrlOverride_get()).toBe('https://peer/api/v1/');
    expect(config.storeUrl_isDefault()).toBe(false);
    config.storeUrl_clear();
    expect(config.storeUrlOverride_get()).toBeUndefined();
  });

  it('persists through the host\'s hook, and in memory without one', async () => {
    await config.storeConfig_persist();
    const persist = jest.fn(async (): Promise<void> => undefined);
    config.storeConfigPersist_install(persist);
    await config.storeConfig_persist();
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
