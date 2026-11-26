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
const world: {
  secret: { id: string; state: string; content: string } | null;
  unreadable: Error | null;
  contentless: boolean;
  /** What the bundle carries in place of the secret's content, as sent: for an encoding that is not base64. */
  rawContent: string | null;
  /** How many versions the secret has had made of it; its tag is this number. */
  versions: number;
  /** The next update is made and its reply lost: the caller sees a 503. */
  replyLost: boolean;
  /** How many of the next updates are refused as "changed since", whatever tag they carry. */
  conflictsFirst: number;
  /** The cloud's answers carry no version tag. */
  tagless: boolean;
  /** Every update is refused outright, in words that quote what was sent. */
  refused: boolean;
  asked: string[];
} = { secret: null, unreadable: null, contentless: false, rawContent: null, versions: 1, replyLost: false, conflictsFirst: 0, tagless: false, refused: false, asked: [] };

class StandInClient {
  regionId?: string;
  endpoint?: string;
  listVaults = async () => ({ items: [{ id: 'vault-1', displayName: 'mise', lifecycleState: 'ACTIVE', managementEndpoint: 'https://kms' }] });
  listKeys = async () => ({ items: [{ id: 'key-1', displayName: 'mise', lifecycleState: 'ENABLED' }] });
  listSecrets = async () => ({ items: world.secret === null ? [] : [{ id: world.secret.id, secretName: 'store', lifecycleState: world.secret.state }] });
  getSecret = async () => { world.asked.push('getSecret'); return { ...(world.tagless ? {} : { etag: String(world.versions) }), secret: { lifecycleState: world.secret?.state === 'PENDING_DELETION' ? 'PENDING_DELETION' : 'ACTIVE' } }; };
  cancelSecretDeletion = async () => { world.asked.push('cancelSecretDeletion'); if (world.secret !== null) world.secret.state = 'ACTIVE'; };
  getSecretBundleByName = async () => {
    world.asked.push('getSecretBundleByName');
    if (world.unreadable !== null) throw world.unreadable;
    if (world.contentless) return { secretBundle: {} };
    if (world.rawContent !== null) return { secretBundle: { secretBundleContent: { content: world.rawContent } } };
    return { secretBundle: { secretBundleContent: { content: Buffer.from(world.secret?.content ?? '').toString('base64') } } };
  };
  updateSecret = async (request: { ifMatch?: string; updateSecretDetails: { secretContent: { content: string } } }) => {
    world.asked.push('updateSecret');
    if (world.refused) throw Object.assign(new Error(`cannot store ${Buffer.from(request.updateSecretDetails.secretContent.content, 'base64').toString('utf-8')}`), { statusCode: 400, serviceCode: 'InvalidParameter' });
    // The cloud refuses a write bound to a tag the secret no longer has.
    if (world.conflictsFirst > 0) { world.conflictsFirst -= 1; throw Object.assign(new Error('Precondition Failed'), { statusCode: 412 }); }
    if (request.ifMatch !== undefined && request.ifMatch !== String(world.versions)) throw Object.assign(new Error('Precondition Failed'), { statusCode: 412 });
    if (world.secret !== null) world.secret.content = Buffer.from(request.updateSecretDetails.secretContent.content, 'base64').toString('utf-8');
    world.versions += 1;
    if (world.replyLost) { world.replyLost = false; throw Object.assign(new Error('Service Unavailable'), { statusCode: 503 }); }
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

const keep = () => ociKeepApi_make({ region: 'us-ashburn-1', pause: async (): Promise<void> => undefined });
const count = (call: string): number => world.asked.filter((asked: string): boolean => asked === call).length;
const quiet = (): void => undefined;

beforeEach(() => {
  world.secret = { id: 'secret-1', state: 'ACTIVE', content: 'what is kept' };
  world.unreadable = null;
  world.contentless = false;
  world.rawContent = null;
  world.versions = 1;
  world.replyLost = false;
  world.refused = false;
  world.conflictsFirst = 0;
  world.tagless = false;
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
    await expect(keep().secret_write('store', 'something new', quiet)).rejects.toThrow('the secret store is kept and could not be read (HTTP 503), so it was left as it is');
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

describe('a write is bound to the version it compared', () => {
  it('makes one version when the write lands and its reply is lost: it looks again before writing again', async () => {
    world.replyLost = true;
    await keep().secret_write('store', 'something new', quiet);
    expect(world.secret?.content).toBe('something new');
    expect(world.versions).toBe(2);
    expect(count('updateSecret')).toBe(1);
  });

  it('makes one version when two writers of the same content read the same version', async () => {
    await Promise.all([keep().secret_write('store', 'something new', quiet), keep().secret_write('store', 'something new', quiet)]);
    expect(world.secret?.content).toBe('something new');
    expect(world.versions).toBe(2);
    // The second writer's update was refused by its tag, and what it then read was already what it had to write.
    expect(count('updateSecret')).toBe(2);
  });

  it('sends the tag it read with the write', async () => {
    world.versions = 7;
    await keep().secret_write('store', 'something new', quiet);
    expect(world.versions).toBe(8);
  });

  it('writes nothing when the cloud gives no tag to bind the write to: an unbound write would be taken whatever the secret had become', async () => {
    world.tagless = true;
    await expect(keep().secret_write('store', 'something new', quiet)).rejects.toThrow('the cloud gave no version tag for it, so it was left as it is');
    expect(count('updateSecret')).toBe(0);
    expect(world.secret?.content).toBe('what is kept');
  });

  it('still writes nothing, and succeeds, when there is no tag and the content is already what is kept', async () => {
    world.tagless = true;
    await keep().secret_write('store', 'what is kept', quiet);
    expect(count('updateSecret')).toBe(0);
  });

  it('looks once more after its fifth write\'s reply is lost, and succeeds with no sixth write when that write landed', async () => {
    // Four writes are refused as changed since, and the fifth lands with its reply lost.
    world.conflictsFirst = 4;
    world.replyLost = true;
    await keep().secret_write('store', 'something new', quiet);
    expect(world.secret?.content).toBe('something new');
    expect(count('updateSecret')).toBe(5);
    expect(world.versions).toBe(2);
  });

  it('fails after its fifth write when the last look still shows other content, and writes no sixth time', async () => {
    world.conflictsFirst = 5;
    await expect(keep().secret_write('store', 'something new', quiet)).rejects.toThrow('the secret store could not be written (HTTP 412, after 5 tries)');
    expect(count('updateSecret')).toBe(5);
    expect(world.secret?.content).toBe('what is kept');
  });

  it('gives up after one try, saying only a status, when the cloud refuses the write outright', async () => {
    world.refused = true;
    const failure: Error = await keep().secret_write('store', 'a-password-nobody-should-see', quiet).then((): Error => new Error('did not fail'), (error: Error): Error => error);
    expect(failure.message).toBe('the secret store could not be written (HTTP 400 InvalidParameter)');
    expect(count('updateSecret')).toBe(1);
    expect(world.versions).toBe(1);
  });
});

describe('content that is not what it seems', () => {
  it('makes no version when the bundle\'s encoding is not base64: it is not decoded into something to compare', async () => {
    world.rawContent = 'not base64 at all!';
    await expect(keep().secret_write('store', 'something new', quiet)).rejects.toThrow('could not be read (the cloud answered content that is not base64)');
    expect(count('updateSecret')).toBe(0);
  });

  it('takes an empty secret as empty: no version for an empty write, one for a write of something', async () => {
    (world.secret as { content: string }).content = '';
    await keep().secret_write('store', '', quiet);
    expect(count('updateSecret')).toBe(0);
    await keep().secret_write('store', 'something', quiet);
    expect(count('updateSecret')).toBe(1);
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
