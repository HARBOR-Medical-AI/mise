/**
 * @file The OCI driver over recorded answers: the contract, and how OCI's
 * records become containers, limits, shapes and prices.
 *
 * The answers are shaped like the live tenancy's on 2026-10-20 with every
 * identifier scrubbed; no network is touched.
 */
import { describe, it, expect } from '@jest/globals';
import { OciDriver, ociTags_flatten, shape_convert } from '../src/cloud/oci/driver.js';
import type { OciApi, OciCompartmentRecord, OciLimitValueRecord, OciShapeRecord, OciTenancyRecord } from '../src/cloud/oci/api.js';
import { driverContract_describe } from './support/driverContract.js';
import { HARBOR_ID, RECORDED_ZONES, recordedResourceApi_make } from './support/ociResources.js';

const TENANCY: OciTenancyRecord = { id: 'ocid1.tenancy.oc1..aaaaaa', name: 'fnndsc-bch', description: 'fnndsc-bch', homeRegionKey: 'IAD', freeformTags: {}, definedTags: {} };
const COMPARTMENTS: OciCompartmentRecord[] = [
  { id: HARBOR_ID, compartmentId: TENANCY.id, name: 'harbor-oci', description: 'Trusted Domain builds', lifecycleState: 'ACTIVE', timeCreated: '2026-10-06T14:00:00.000Z', freeformTags: { owner: 'rudolph' }, definedTags: { 'Oracle-Tags': { CreatedBy: 'rudolph', CreatedOn: '2026-10-06T14:00:00.000Z' } } },
  { id: 'ocid1.compartment.oc1..gone00', compartmentId: TENANCY.id, name: 'old', description: 'removed', lifecycleState: 'DELETED', timeCreated: '2026-09-01T00:00:00.000Z', freeformTags: {}, definedTags: {} },
  { id: 'ocid1.compartment.oc1..alpha0', compartmentId: TENANCY.id, name: 'alpha', description: '', lifecycleState: 'ACTIVE', timeCreated: '2026-09-02T00:00:00.000Z', freeformTags: {}, definedTags: {} },
];
const ZONES: string[] = [...RECORDED_ZONES];
const LIMITS: Record<string, OciLimitValueRecord[]> = {
  compute: [
    ...ZONES.map((zone: string): OciLimitValueRecord => ({ name: 'standard-e5-core-count', scopeType: 'AD', availabilityDomain: zone, value: 4629 })),
    { name: 'custom-image-count', scopeType: 'REGION', availabilityDomain: null, value: 25 },
  ],
  vcn: [{ name: 'vcn-count', scopeType: 'GLOBAL', availabilityDomain: null, value: 50 }],
};
const SHAPES: OciShapeRecord[] = [
  { shape: 'VM.Standard.E5.Flex', processorDescription: '4th Gen AMD EPYC', ocpus: null, memoryInGBs: null, gpus: 0, isFlexible: true, ocpuOptions: { min: 1, max: 94 }, memoryOptions: { minInGBs: 1, maxInGBs: 1049 }, quotaNames: ['standard-e5-core-count', 'standard-e5-memory-count'], raw: { shape: 'VM.Standard.E5.Flex' } },
  { shape: 'VM.Standard.E5.Flex', processorDescription: '4th Gen AMD EPYC', ocpus: null, memoryInGBs: null, gpus: 0, isFlexible: true, ocpuOptions: { min: 1, max: 94 }, memoryOptions: { minInGBs: 1, maxInGBs: 1049 }, quotaNames: [], raw: {} },
  { shape: 'VM.Standard.A1.Flex', processorDescription: 'Ampere Altra', ocpus: null, memoryInGBs: null, gpus: 0, isFlexible: true, ocpuOptions: { min: 1, max: 80 }, memoryOptions: { minInGBs: 1, maxInGBs: 512 }, quotaNames: ['standard-a1-core-count'], raw: {} },
  { shape: 'BM.GPU.A10.4', processorDescription: 'Intel Xeon', ocpus: 64, memoryInGBs: 1024, gpus: 4, isFlexible: false, ocpuOptions: null, memoryOptions: null, quotaNames: ['gpu-a10-count'], raw: {} },
];
const PRICE_LIST = {
  items: [
    { partNumber: 'B97384', currencyCodeLocalizations: [{ currencyCode: 'USD', prices: [{ model: 'PAY_AS_YOU_GO', value: 0.03 }] }] },
    { partNumber: 'B97385', currencyCodeLocalizations: [{ currencyCode: 'USD', prices: [{ model: 'PAY_AS_YOU_GO', value: 0.002 }] }] },
    { partNumber: 'B93297', currencyCodeLocalizations: [{ currencyCode: 'USD', prices: [{ model: 'PAY_AS_YOU_GO', value: 0.01 }, { model: 'MONTHLY_COMMIT', value: 0.009 }] }] },
    { partNumber: 'B93298', currencyCodeLocalizations: [{ currencyCode: 'USD', prices: [{ model: 'PAY_AS_YOU_GO', value: 0.0015 }] }, { currencyCode: 'EUR', prices: [{ model: 'PAY_AS_YOU_GO', value: 9 }] }] },
    { partNumber: 'B99999', currencyCodeLocalizations: [{ currencyCode: 'USD', prices: [] }] },
  ],
};

/** A recorded API: every call answers from the fixtures and counts itself. */
export function recordedApi_make(seen: string[] = []): OciApi {
  return {
    ...recordedResourceApi_make(seen),
    credential_get: () => ({ tenancyId: TENANCY.id, userId: 'ocid1.user.oc1..user00', region: 'us-ashburn-1' }),
    async tenancy_get(tenancyId: string) { seen.push(`tenancy_get ${tenancyId}`); return TENANCY; },
    async userName_get(userId: string) { seen.push(`userName_get ${userId}`); return 'rudolph.pienaar@childrens.harvard.edu'; },
    async compartments_list(parentId: string) { seen.push(`compartments_list ${parentId}`); return parentId === TENANCY.id ? COMPARTMENTS : []; },
    async regionSubscriptions_list() { return ['us-ashburn-1']; },
    async availabilityDomains_list(region: string) { return region === 'us-ashburn-1' ? ZONES : []; },
    async limitServices_list() { return Object.keys(LIMITS).sort(); },
    async limitValues_list(_region: string, _tenancyId: string, service: string) { return LIMITS[service] ?? []; },
    async resourceAvailability_get(_r: string, _t: string, service: string, limitName: string, availabilityDomain?: string) {
      if (service === 'compute' && limitName === 'standard-e5-core-count' && availabilityDomain === ZONES[0]) return { used: 4, available: 4625 };
      if (service === 'vcn') return null;
      return { used: 0, available: 25 };
    },
    async shapes_list() { return SHAPES; },
  };
}

const fetchJson = async (): Promise<unknown> => PRICE_LIST;

driverContract_describe('the OCI driver over recorded answers', () => new OciDriver({ api: recordedApi_make(), fetchJson }));

describe('the OCI driver', () => {
  it('reads the price list once for the session, for the shapes and the services alike, and says when', async () => {
    let fetched: number = 0;
    const driver = new OciDriver({ api: recordedApi_make(), fetchJson: async (): Promise<unknown> => { fetched += 1; return PRICE_LIST; } });
    expect(driver.pricesRead_get()).toBeNull();
    await Promise.all([driver.prices_list(), driver.servicePrices_get()]);
    await driver.prices_list();
    await driver.servicePrices_get();
    expect(fetched).toBe(1);
    expect(driver.pricesRead_get()).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('keeps no failed read of the price list: the next price asks again', async () => {
    let fetched: number = 0;
    const driver = new OciDriver({ api: recordedApi_make(), fetchJson: async (): Promise<unknown> => { fetched += 1; if (fetched === 1) throw new Error('price list: 503 Service Unavailable'); return PRICE_LIST; } });
    await expect(driver.prices_list()).rejects.toThrow('503');
    expect(driver.pricesRead_get()).toBeNull();
    expect((await driver.prices_list()).length).toBeGreaterThan(0);
    expect(fetched).toBe(2);
  });

  it('is the IAM user at the tenancy, with the profile\'s region as home', async () => {
    const driver = new OciDriver({ api: recordedApi_make(), fetchJson });
    expect(await driver.identity_get()).toEqual({ user: 'rudolph.pienaar@childrens.harvard.edu', tenancy: 'fnndsc-bch', tenancyId: TENANCY.id, homeRegion: 'us-ashburn-1' });
    expect((await driver.root_get()).noun).toBe('tenancy');
  });

  it('lists compartments as containers, deleted ones left out, sorted, tags flattened', async () => {
    const driver = new OciDriver({ api: recordedApi_make(), fetchJson });
    const children = await driver.containers_list(TENANCY.id);
    expect(children.map((c) => c.name)).toEqual(['alpha', 'harbor-oci']);
    const harbor = children[1];
    expect(harbor.noun).toBe('compartment');
    expect(harbor.state).toBe('active');
    expect(harbor.tags).toEqual({ owner: 'rudolph', 'Oracle-Tags.CreatedBy': 'rudolph', 'Oracle-Tags.CreatedOn': '2026-10-06T14:00:00.000Z' });
    expect(ociTags_flatten({}, {})).toEqual({});
  });

  it('reads an AD-scoped limit as a zone limit, a REGION one as region, GLOBAL as global', async () => {
    const driver = new OciDriver({ api: recordedApi_make(), fetchJson });
    const compute = await driver.limits_list('us-ashburn-1', 'compute');
    expect(compute.filter((l) => l.scope === 'zone').map((l) => l.zone)).toEqual(ZONES);
    expect(compute.find((l) => l.name === 'custom-image-count')).toEqual({ service: 'compute', name: 'custom-image-count', scope: 'region', value: 25 });
    expect(await driver.limits_list('us-ashburn-1', 'vcn')).toEqual([{ service: 'vcn', name: 'vcn-count', scope: 'global', value: 50 }]);
    expect(await driver.limitAvailability_get('us-ashburn-1', 'compute', 'standard-e5-core-count', ZONES[0])).toEqual({ used: 4, available: 4625 });
    expect(await driver.limitAvailability_get('us-ashburn-1', 'vcn', 'vcn-count')).toBeNull();
  });

  it('turns OCPU ranges into vCPU by the family\'s ratio, keeps fixed shapes fixed, lists each shape once', async () => {
    const driver = new OciDriver({ api: recordedApi_make(), fetchJson });
    const shapes = await driver.shapes_list('us-ashburn-1');
    expect(shapes.map((s) => s.name)).toEqual(['BM.GPU.A10.4', 'VM.Standard.A1.Flex', 'VM.Standard.E5.Flex']);
    const e5 = shapes[2];
    expect(e5).toMatchObject({ family: 'E5', flexible: true, vcpuPerCore: 2, cores: { min: 2, max: 188 }, memoryGib: { min: 1, max: 1049 }, gpus: 0 });
    const a1 = shapes[1];
    expect(a1).toMatchObject({ family: 'A1', vcpuPerCore: 1, cores: { min: 1, max: 80 } });
    const gpu = shapes[0];
    expect(gpu).toMatchObject({ family: 'BM.GPU.A10.4', flexible: false, cores: { min: 128, max: 128 }, memoryGib: { min: 1024, max: 1024 }, gpus: 4 });
    expect(shape_convert({ ...SHAPES[3], ocpus: null, memoryInGBs: null }).cores).toEqual({ min: 0, max: 0 });
  });

  it('prices the shapes whose parts the list holds, per vCPU-hour, from the fetched list', async () => {
    const driver = new OciDriver({ api: recordedApi_make(), fetchJson });
    const prices = await driver.prices_list();
    expect(prices).toEqual([
      { shape: 'VM.Standard.A1.Flex', vcpuHour: 0.01, gibHour: 0.0015, currency: 'USD' },
      { shape: 'VM.Standard.E5.Flex', vcpuHour: 0.015, gibHour: 0.002, currency: 'USD' },
    ]);
  });
});

describe('the OCI driver\'s resources', () => {
  const region = 'us-ashburn-1';

  it('gives each instance its private addresses first, its public after, from attached VNICs only', async () => {
    const seen: string[] = [];
    const driver = new OciDriver({ api: recordedApi_make(seen), fetchJson });
    const instances = await driver.instances_list(HARBOR_ID, region);
    expect(instances.map((i) => [i.name, i.zone, i.ips])).toEqual([
      ['harbor-cp-1', ZONES[0], ['10.0.16.11']],
      ['harbor-cp-2', ZONES[1], ['10.0.16.12', '129.0.0.12']],
      ['harbor-cp-3', ZONES[2], ['10.0.16.13']],
    ]);
    expect(instances[0]).toMatchObject({ state: 'running', shape: 'VM.Standard.E5.Flex', region, created: '2026-10-06T14:00:00.000Z', tags: { 'openshift-resource': 'harbor', 'Oracle-Tags.CreatedBy': 'rudolph' } });
    expect(seen.filter((call) => call.startsWith('vnic_get'))).toHaveLength(3);
    expect(await driver.instances_list('ocid1.compartment.oc1..alpha0', region)).toEqual([]);
  });

  it('lists block and boot volumes together, each boot volume asked per availability domain, attached only while attached', async () => {
    const seen: string[] = [];
    const driver = new OciDriver({ api: recordedApi_make(seen), fetchJson });
    const volumes = await driver.volumes_list(HARBOR_ID, region);
    expect(volumes.map((v) => [v.name, v.state, v.sizeGib, v.attachedTo, v.boot])).toEqual([
      ['csi-52676dc4', 'terminated', 50, null, false],
      ['csi-9d5b2f0a', 'available', 50, 'ocid1.instance.oc1.iad.cp0003', false],
      ['harbor-cp-1 (Boot Volume)', 'available', 200, 'ocid1.instance.oc1.iad.cp0001', true],
      ['harbor-cp-2 (Boot Volume)', 'available', 200, 'ocid1.instance.oc1.iad.cp0002', true],
      ['harbor-cp-3 (Boot Volume)', 'available', 200, 'ocid1.instance.oc1.iad.cp0003', true],
    ]);
    expect(seen.filter((call) => call.startsWith('bootVolumes_list'))).toEqual(ZONES.map((zone) => `bootVolumes_list ${zone}`));
  });

  it('nests subnets and NSGs in their VCN, and gives load balancers their addresses and shape', async () => {
    const driver = new OciDriver({ api: recordedApi_make(), fetchJson });
    expect((await driver.networks_list(HARBOR_ID, region)).map((n) => n.name)).toEqual(['harbor']);
    expect((await driver.subnets_list(HARBOR_ID, region)).map((n) => [n.name, n.networkId])).toEqual([['private_bare_metal', 'ocid1.vcn.oc1.iad.harbor'], ['private_ocp', 'ocid1.vcn.oc1.iad.harbor'], ['public', 'ocid1.vcn.oc1.iad.harbor']]);
    expect((await driver.securitygroups_list(HARBOR_ID, region)).map((n) => n.name)).toEqual(['cluster-compute-nsg', 'cluster-controlplane-nsg', 'cluster-lb-nsg']);
    expect((await driver.loadbalancers_list(HARBOR_ID, region)).map((n) => [n.name, n.ips, n.shape, n.state])).toEqual([
      ['harbor-openshift_api_int_lb', ['10.0.32.5'], 'flexible', 'active'],
      ['harbor-openshift_api_lb', ['129.0.0.10'], 'flexible', 'active'],
      ['harbor-openshift_apps_lb', ['129.0.0.11'], 'flexible', 'active'],
    ]);
  });

  it('asks the Object Storage namespace once, and reads buckets, objects, links and bytes in it', async () => {
    const seen: string[] = [];
    const driver = new OciDriver({ api: recordedApi_make(seen), fetchJson });
    expect((await driver.buckets_list(HARBOR_ID, region)).map((b) => [b.name, b.state])).toEqual([['harbor-oci-iso', 'active']]);
    expect(await driver.objects_list('harbor-oci-iso', region)).toEqual([{ name: 'harbor-discovery.iso', size: 138_596_352, modified: '2026-10-06T14:10:00.000Z' }]);
    expect(await driver.links_list('harbor-oci-iso', region)).toEqual([{ object: 'harbor-discovery.iso', name: 'harbor-discovery-iso', access: 'ObjectRead', expires: '2026-11-06T14:10:00.000Z' }]);
    expect((await driver.object_read('harbor-oci-iso', 'harbor-discovery.iso', region)).toString()).toBe('iso bytes');
    expect(seen.filter((call) => call === 'namespace_get')).toHaveLength(1);
    expect(seen).toContain('object_get scrubbedns/harbor-oci-iso/harbor-discovery.iso');
  });

  it('asks the namespace again after a failure', async () => {
    let fails = 1;
    const api = { ...recordedApi_make(), async namespace_get() { if (fails-- > 0) throw new Error('throttled'); return 'scrubbedns'; } };
    const driver = new OciDriver({ api, fetchJson });
    await expect(driver.buckets_list(HARBOR_ID, region)).rejects.toThrow('throttled');
    expect(await driver.buckets_list(HARBOR_ID, region)).toHaveLength(1);
  });

  it('lists a zone answering in both scopes once, and its records as the zone holds them', async () => {
    const driver = new OciDriver({ api: recordedApi_make(), fetchJson });
    const zones = await driver.dns_list(HARBOR_ID, region);
    expect(zones.map((z) => z.name)).toEqual(['oci.chrisproject.org', 'privateocp.openshiftvcn.oraclevcn.com']);
    expect((await driver.records_list(zones[0].id, region)).map((r) => [r.domain, r.type])).toEqual([
      ['oci.chrisproject.org', 'SOA'], ['oci.chrisproject.org', 'NS'], ['api.harbor.oci.chrisproject.org', 'A'], ['*.apps.harbor.oci.chrisproject.org', 'A'],
    ]);
  });

  it('counts a compartment\'s live resources by kind in one structured search', async () => {
    const seen: string[] = [];
    const driver = new OciDriver({ api: recordedApi_make(seen), fetchJson });
    expect(await driver.resources_search(HARBOR_ID, region)).toEqual({ instances: 3, networks: 1, subnets: 3, securitygroups: 3, loadbalancers: 3, volumes: 4, buckets: 1, dns: 2 });
    const query = seen.find((call) => call.startsWith('search_list')) ?? '';
    expect(query).toContain(`where compartmentId = '${HARBOR_ID}'`);
    expect(query).toContain('query instance, vcn, subnet, networksecuritygroup, loadbalancer, volume, bootvolume, bucket, customerdnszone resources');
  });
});
