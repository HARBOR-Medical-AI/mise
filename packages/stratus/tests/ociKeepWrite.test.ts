/**
 * @file A kept secret is written only when its content changed, and never unread.
 *
 * The keep's calls are real. The SDK's clients are one stand-in holding a
 * vault, its key and at most one secret, and recording every call in order.
 * Every `updateSecret` makes a version, and the cloud holds thirty at once,
 * so each case asserts how many were asked for.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

type Row = Record<string, unknown>;

/** The stand-in cloud: the secret it holds, whether its content can be read, and the calls asked. */
const world: { secret: { id: string; state: string; content: string } | null; unreadable: Error | null; contentless: boolean; asked: string[] } = { secret: null, unreadable: null, contentless: false, asked: [] };

class StandInClient {
  regionId?: string;
  endpoint?: string;
  listVaults = async () => ({ items: [{ id: 'vault-1', displayName: 'mise', lifecycleState: 'ACTIVE', managementEndpoint: 'https://kms' }] });
  listKeys = async () => ({ items: [{ id: 'key-1', displayName: 'mise', lifecycleState: 'ENABLED' }] });
  listSecrets = async () => ({ items: world.secret === null ? [] : [{ id: world.secret.id, secretName: 'store', lifecycleState: world.secret.state }] });
  getSecret = async () => { world.asked.push('getSecret'); return { secret: { lifecycleState: world.secret?.state === 'PENDING_DELETION' ? 'PENDING_DELETION' : 'ACTIVE' } }; };
  cancelSecretDeletion = async () => { world.asked.push('cancelSecretDeletion'); if (world.secret !== null) world.secret.state = 'ACTIVE'; };
  getSecretBundleByName = async () => {
    world.asked.push('getSecretBundleByName');
    if (world.unreadable !== null) throw world.unreadable;
    if (world.contentless) return { secretBundle: {} };
    return { secretBundle: { secretBundleContent: { content: Buffer.from(world.secret?.content ?? '').toString('base64') } } };
  };
  updateSecret = async (request: { updateSecretDetails: { secretContent: { content: string } } }) => {
    world.asked.push('updateSecret');
    if (world.secret !== null) world.secret.content = Buffer.from(request.updateSecretDetails.secretContent.content, 'base64').toString('utf-8');
    return {};
  };
  createSecret = async (request: { createSecretDetails: { secretContent: { content: string } } }) => {
    world.asked.push('createSecret');
    world.secret = { id: 'secret-new', state: 'ACTIVE', content: Buffer.from(request.createSecretDetails.secretContent.content, 'base64').toString('utf-8') };
    return { secret: { id: 'secret-new' } };
  };
}

/** The SDK package with its client classes replaced by the stand-in; its models stay real. */
function sdk_standIn(name: string, clients: string[]): Row {
  return { ...(jest.requireActual(name) as Row), ...Object.fromEntries(clients.map((client: string): [string, unknown] => [client, StandInClient])) };
}

jest.unstable_mockModule('oci-common', () => ({
  ...(jest.requireActual('oci-common') as Row),
  ConfigFileAuthenticationDetailsProvider: class { getTenantId(): string { return 'tenancy'; } },
}));
jest.unstable_mockModule('oci-keymanagement', () => sdk_standIn('oci-keymanagement', ['KmsVaultClient', 'KmsManagementClient']));
jest.unstable_mockModule('oci-vault', () => sdk_standIn('oci-vault', ['VaultsClient']));
jest.unstable_mockModule('oci-secrets', () => sdk_standIn('oci-secrets', ['SecretsClient']));

const { ociKeepApi_make } = await import('../src/cloud/oci/keepApi.js');

const keep = () => ociKeepApi_make({ region: 'us-ashburn-1' });
const count = (call: string): number => world.asked.filter((asked: string): boolean => asked === call).length;
const quiet = (): void => undefined;

beforeEach(() => {
  world.secret = { id: 'secret-1', state: 'ACTIVE', content: 'what is kept' };
  world.unreadable = null;
  world.contentless = false;
  world.asked = [];
});

describe('writing a secret that is there', () => {
  it('makes no version when the content is what the secret already holds', async () => {
    await keep().secret_write('store', 'what is kept', quiet);
    expect(count('updateSecret')).toBe(0);
    expect(count('getSecretBundleByName')).toBe(1);
  });

  it('makes one version when the content differs', async () => {
    await keep().secret_write('store', 'something new', quiet);
    expect(count('updateSecret')).toBe(1);
    expect(world.secret?.content).toBe('something new');
  });

  it('makes no version, and fails, when the secret cannot be read', async () => {
    world.unreadable = Object.assign(new Error('Service Unavailable'), { statusCode: 503 });
    await expect(keep().secret_write('store', 'something new', quiet)).rejects.toThrow('the secret store is kept and could not be read (Service Unavailable), so it was left as it is');
    expect(count('updateSecret')).toBe(0);
    expect(world.secret?.content).toBe('what is kept');
  });

  it('makes no version, and fails, when the cloud answers the read with no content', async () => {
    world.contentless = true;
    await expect(keep().secret_write('store', 'something new', quiet)).rejects.toThrow('answered no content');
    expect(count('updateSecret')).toBe(0);
  });

  it('does not put the content it was given into the failure', async () => {
    world.unreadable = new Error('Service Unavailable');
    const failure: Error = await keep().secret_write('store', 'a-password-nobody-should-see', quiet).then((): Error => new Error('did not fail'), (error: Error): Error => error);
    expect(failure.message).not.toContain('a-password-nobody-should-see');
  });

  it('brings back one scheduled for deletion and waits for it before reading it, then compares', async () => {
    (world.secret as { state: string }).state = 'PENDING_DELETION';
    await keep().secret_write('store', 'what is kept', quiet);
    expect(world.asked.indexOf('cancelSecretDeletion')).toBeGreaterThanOrEqual(0);
    expect(world.asked.indexOf('cancelSecretDeletion')).toBeLessThan(world.asked.indexOf('getSecret'));
    expect(world.asked.indexOf('getSecret')).toBeLessThan(world.asked.indexOf('getSecretBundleByName'));
    expect(count('updateSecret')).toBe(0);
  });
});

describe('writing a secret that is not there', () => {
  it('makes the secret, and no version of one', async () => {
    world.secret = null;
    await keep().secret_write('store', 'first', quiet);
    expect(count('createSecret')).toBe(1);
    expect(count('updateSecret')).toBe(0);
    expect(count('getSecretBundleByName')).toBe(0);
  });
});
