/**
 * @file Every OCI list call reads past its first page.
 *
 * The build's and the keep's calls are real. The SDK's clients are replaced
 * by one stand-in whose list calls answer in pages: the first page of each
 * carries a next-page token and lacks the one thing looked for, and the
 * second holds it. Each case asks a public call that depends on that thing
 * being found.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

type Row = Record<string, unknown>;

/** What the stand-in cloud holds: each list call's pages, and every call asked. */
const world: { pages: Record<string, Array<Row[] | null>>; asked: Array<{ call: string; request: Row }> } = { pages: {}, asked: [] };

/**
 * One page of a list call, by the token the caller passed.
 *
 * @param call - The list call's name.
 * @param request - What was asked; `page` is the token.
 * @returns The page, with a token when another follows.
 */
function page_answer(call: string, request: Row): { items?: Row[]; opcNextPage?: string } {
  world.asked.push({ call, request });
  const pages: Array<Row[] | null> = world.pages[call] ?? [[]];
  const index: number = request.page === undefined ? 0 : Number(request.page);
  const page: Row[] | null | undefined = pages[index];
  const rows: Row[] | null = page === undefined ? [] : page;
  // A null page is an answer with no body: the SDK then leaves `items` out.
  return { ...(rows === null ? {} : { items: rows }), ...(index < pages.length - 1 ? { opcNextPage: String(index + 1) } : {}) };
}

/** A client of any SDK package: its list calls page, and the few other calls the cases reach answer plainly. */
class StandInClient {
  regionId?: string;
  endpoint?: string;
  listCompartments = async (request: Row) => page_answer('listCompartments', request);
  listZones = async (request: Row) => {
    if (request.name === undefined) return page_answer('listZones', request);
    const there: string = `listZones named in ${String(request.compartmentId)}`;
    return page_answer(there in world.pages ? there : 'listZones named', request);
  };
  listTagNamespaces = async (request: Row) => page_answer('listTagNamespaces', request);
  listPreauthenticatedRequests = async (request: Row) => page_answer('listPreauthenticatedRequests', request);
  listVaults = async (request: Row) => page_answer('listVaults', request);
  listKeys = async (request: Row) => page_answer('listKeys', request);
  listSecrets = async (request: Row) => page_answer('listSecrets', request);
  getTag = async (request: Row) => { world.asked.push({ call: 'getTag', request }); return {}; };
  createCompartment = async (request: Row) => { world.asked.push({ call: 'createCompartment', request }); return { compartment: { id: 'made' } }; };
  getNamespace = async () => ({ value: 'ns' });
  getBucket = async () => ({ bucket: { compartmentId: 'home' } });
  listObjects = async () => ({ listObjects: { objects: [] } });
  deletePreauthenticatedRequest = async (request: Row) => { world.asked.push({ call: 'deletePreauthenticatedRequest', request }); };
  deleteBucket = async (request: Row) => { world.asked.push({ call: 'deleteBucket', request }); };
  createKey = async (request: Row) => { world.asked.push({ call: 'createKey', request }); return {}; };
  createVault = async (request: Row) => { world.asked.push({ call: 'createVault', request }); return {}; };
  getSecretBundleByName = async () => ({ secretBundle: { secretBundleContent: { content: Buffer.from('kept').toString('base64') } } });
  scheduleSecretDeletion = async (request: Row) => { world.asked.push({ call: 'scheduleSecretDeletion', request }); return {}; };
}

/** The SDK package with every client class replaced by the stand-in; its models stay real. */
function sdk_standIn(name: string, clients: string[]): Record<string, unknown> {
  const actual: Record<string, unknown> = jest.requireActual(name) as Record<string, unknown>;
  return { ...actual, ...Object.fromEntries(clients.map((client: string): [string, unknown] => [client, StandInClient])) };
}

jest.unstable_mockModule('oci-common', () => ({
  ...(jest.requireActual('oci-common') as Record<string, unknown>),
  ConfigFileAuthenticationDetailsProvider: class { getTenantId(): string { return 'tenancy'; } },
}));
jest.unstable_mockModule('oci-identity', () => sdk_standIn('oci-identity', ['IdentityClient']));
jest.unstable_mockModule('oci-dns', () => sdk_standIn('oci-dns', ['DnsClient']));
jest.unstable_mockModule('oci-limits', () => sdk_standIn('oci-limits', ['LimitsClient']));
jest.unstable_mockModule('oci-objectstorage', () => sdk_standIn('oci-objectstorage', ['ObjectStorageClient']));
jest.unstable_mockModule('oci-core', () => sdk_standIn('oci-core', ['BlockstorageClient', 'VirtualNetworkClient', 'ComputeClient']));
jest.unstable_mockModule('oci-bastion', () => sdk_standIn('oci-bastion', ['BastionClient']));
jest.unstable_mockModule('oci-keymanagement', () => sdk_standIn('oci-keymanagement', ['KmsVaultClient', 'KmsManagementClient']));
jest.unstable_mockModule('oci-vault', () => sdk_standIn('oci-vault', ['VaultsClient']));
jest.unstable_mockModule('oci-secrets', () => sdk_standIn('oci-secrets', ['SecretsClient']));

const { ociBuildApi_make } = await import('../src/cloud/oci/buildApi.js');
const { ociKeepApi_make } = await import('../src/cloud/oci/keepApi.js');
const { pages_drain } = await import('../src/cloud/oci/pages.js');

/** The names of the calls asked, in order. */
const asked_list = (): string[] => world.asked.map((entry: { call: string }): string => entry.call);

/** How many times one call was asked. */
const asked_count = (call: string): number => asked_list().filter((name: string): boolean => name === call).length;

const VAULT: Row = { id: 'vault-1', displayName: 'mise', lifecycleState: 'ACTIVE', managementEndpoint: 'https://kms' };

beforeEach(() => {
  world.pages = {};
  world.asked = [];
});

describe('pages_drain', () => {
  it('follows the token until a page carries none, and takes an empty token as none', async () => {
    const tokens: Array<string | undefined> = [];
    const all: number[] = await pages_drain(async (page: string | undefined) => {
      tokens.push(page);
      if (page === undefined) return { items: [1], opcNextPage: 'b' };
      if (page === 'b') return { items: [], opcNextPage: 'c' };
      return { items: [3], opcNextPage: '' };
    });
    expect(all).toEqual([1, 3]);
    expect(tokens).toEqual([undefined, 'b', 'c']);
  });
});

describe('a page that carries no list is not an empty page', () => {
  it('a later page of compartments with no items fails the call, and no compartment is made', async () => {
    world.pages = { listCompartments: [[{ id: 'a', name: 'other' }], null] };
    await expect(ociBuildApi_make({ region: 'us-ashburn-1' }).compartmentChild_ensure('parent', 'wanted', 'a description', {})).rejects.toThrow('carries no list of items');
    expect(asked_count('createCompartment')).toBe(0);
  });

  it('a page of vaults with no items fails the read: the vault is not taken as absent', async () => {
    world.pages = { listVaults: [null] };
    await expect(ociKeepApi_make({ region: 'us-ashburn-1' }).secret_read('store')).rejects.toThrow('carries no list of items');
    expect(asked_count('createVault')).toBe(0);
  });

  it('a bucket whose links answer with no list has none, and is removed', async () => {
    world.pages = { listPreauthenticatedRequests: [null] };
    await ociBuildApi_make({ region: 'us-ashburn-1' }).bucket_remove('images', 'home');
    expect(asked_count('deleteBucket')).toBe(1);
  });
});

describe('the build\'s list calls find what is on the second page', () => {
  const build = () => ociBuildApi_make({ region: 'us-ashburn-1' });

  it('a compartment beneath the tenancy, where the zone lives', async () => {
    // The zone is only in the compartment the second page names.
    world.pages = { listCompartments: [[{ id: 'first' }], [{ id: 'second' }]], 'listZones named in second': [[{ name: 'oci.example.org' }]] };
    expect(await build().zoneCompartment_find('oci.example.org')).toBe('second');
  });

  it('a zone asked for by name', async () => {
    world.pages = { 'listZones named': [[], [{ name: 'oci.example.org' }]] };
    expect(await build().zoneCompartment_find('oci.example.org')).toBe('tenancy');
  });

  it('a zone among all the zones', async () => {
    world.pages = { listZones: [[{ name: 'a.example.org' }], [{ name: 'b.example.org' }]] };
    expect(await build().zoneNames_list()).toEqual(['a.example.org', 'b.example.org']);
  });

  it('the tag namespace, looked for across compartments', async () => {
    world.pages = { listTagNamespaces: [[{ name: 'other' }], [{ name: 'harbor', id: 'space' }]] };
    expect(await build().tagNamespaceCompartment_find('harbor')).toBe('tenancy');
  });

  it('a child compartment that is already there, which is then not made a second time', async () => {
    world.pages = { listCompartments: [[{ id: 'a', name: 'other' }], [{ id: 'b', name: 'wanted' }]] };
    expect(await build().compartmentChild_ensure('parent', 'wanted', 'a description', {})).toEqual({ id: 'b', made: false });
    expect(asked_count('createCompartment')).toBe(0);
  });

  it('the tag namespace a tag is asked of', async () => {
    world.pages = { listTagNamespaces: [[{ name: 'other', id: 'x' }], [{ name: 'harbor', id: 'space' }]] };
    expect(await build().tag_exists('home', 'harbor', 'cluster')).toBe(true);
    expect(world.asked.find((entry) => entry.call === 'getTag')?.request).toEqual({ tagNamespaceId: 'space', tagName: 'cluster' });
  });

  it('a bucket\'s link, which has to go before the bucket can', async () => {
    world.pages = { listPreauthenticatedRequests: [[{ id: 'link-1' }], [{ id: 'link-2' }]] };
    await build().bucket_remove('images', 'home');
    const removed: unknown[] = world.asked.filter((entry) => entry.call === 'deletePreauthenticatedRequest').map((entry) => entry.request.parId);
    expect(removed).toEqual(['link-1', 'link-2']);
    expect(asked_list().indexOf('deleteBucket')).toBeGreaterThan(asked_list().lastIndexOf('deletePreauthenticatedRequest'));
  });
});

describe('the keep\'s list calls find what is on the second page', () => {
  const keep = () => ociKeepApi_make({ region: 'us-ashburn-1' });

  it('the vault, without which a secret reads as not there', async () => {
    world.pages = { listVaults: [[{ id: 'v0', displayName: 'another', lifecycleState: 'ACTIVE' }], [VAULT]] };
    expect(await keep().secret_read('store')).toBe('kept');
    expect(asked_count('listVaults')).toBe(2);
  });

  it('a secret of the name, which is then dropped', async () => {
    world.pages = { listVaults: [[VAULT]], listSecrets: [[{ id: 's0', secretName: 'store', lifecycleState: 'DELETED' }], [{ id: 's1', secretName: 'store', lifecycleState: 'ACTIVE' }]] };
    expect(await keep().secret_drop('store')).toBe(true);
    expect(world.asked.find((entry) => entry.call === 'scheduleSecretDeletion')?.request.secretId).toBe('s1');
  });

  it('the vault\'s key, which is then not made a second time', async () => {
    world.pages = {
      listVaults: [[VAULT]],
      listKeys: [[{ id: 'k0', displayName: 'another', lifecycleState: 'ENABLED' }], [{ id: 'k1', displayName: 'mise', lifecycleState: 'ENABLED' }]],
      listSecrets: [[]],
    };
    // The write goes on to make the secret, which this stand-in does not offer; the key is settled before that.
    await expect(keep().secret_write('store', 'content', (): void => undefined)).rejects.toThrow();
    expect(asked_count('listKeys')).toBe(2);
    expect(asked_count('createKey')).toBe(0);
  });
});
