/**
 * @file The fake cloud: a driver over a fixture in memory.
 *
 * It runs the same contract suite the OCI driver runs, so the driver
 * interface stays honest with one real cloud (docs/stratus.adoc, D1), and it
 * is what the boot proof and the unit tests host a session over.
 *
 * @module
 */
import type {
  CloudAvailability, CloudBucket, CloudContainer, CloudDnsZone, CloudDriver, CloudIdentity, CloudInstance, CloudLimit, CloudLink, CloudLoadBalancer,
  CloudNetwork, CloudObject, CloudPrice, ServicePrices, CloudRecord, CloudResource, CloudSecurityGroup, CloudShape, CloudSubnet, CloudVolume, CloudZone, FoundCluster, ResourceCounts, ResourceKind,
} from '../driver.js';

/** A Resource Manager stack in the fake cloud, as far as finding a cluster by its tag needs it. */
export interface FakeStack {
  readonly id: string;
  readonly displayName: string;
  readonly compartmentId: string;
  /** Its lifecycle state, lower case. */
  readonly state: string;
  readonly region: string;
  readonly tags: Readonly<Record<string, string>>;
}

/** A resource in the fake cloud: its kind, the container holding it, and its record. */
export type FakeResource =
  | { readonly kind: 'instances'; readonly containerId: string; readonly record: CloudInstance }
  | { readonly kind: 'networks'; readonly containerId: string; readonly record: CloudNetwork }
  | { readonly kind: 'subnets'; readonly containerId: string; readonly record: CloudSubnet }
  | { readonly kind: 'securitygroups'; readonly containerId: string; readonly record: CloudSecurityGroup }
  | { readonly kind: 'loadbalancers'; readonly containerId: string; readonly record: CloudLoadBalancer }
  | { readonly kind: 'volumes'; readonly containerId: string; readonly record: CloudVolume }
  | { readonly kind: 'buckets'; readonly containerId: string; readonly record: CloudBucket }
  | { readonly kind: 'dns'; readonly containerId: string; readonly record: CloudDnsZone };

/** The states a search leaves out: what is gone. */
const GONE_STATES: ReadonlyArray<string> = ['terminated', 'deleted'];

/** What a fake cloud holds. */
export interface FakeCloud {
  readonly identity: CloudIdentity;
  /** Every container, the root among them (its `parentId` null). */
  readonly containers: ReadonlyArray<CloudContainer>;
  readonly regions: ReadonlyArray<string>;
  /** Zones by region. */
  readonly zones: Readonly<Record<string, ReadonlyArray<CloudZone>>>;
  /** Limits by region. */
  readonly limits: Readonly<Record<string, ReadonlyArray<CloudLimit>>>;
  /** Availability by `region/service/name[/zone]`. */
  readonly availability: Readonly<Record<string, CloudAvailability>>;
  /** Shapes by region. */
  readonly shapes: Readonly<Record<string, ReadonlyArray<CloudShape>>>;
  readonly prices: ReadonlyArray<CloudPrice>;
  /** Storage and load-balancing prices; null when the list lacks them. */
  readonly servicePrices?: ServicePrices | null;
  /** Every resource, in any container and region. */
  readonly resources: ReadonlyArray<FakeResource>;
  /** The stacks, in any container and region; absent, none. */
  readonly stacks?: ReadonlyArray<FakeStack>;
  /** Objects by bucket name. */
  readonly objects: Readonly<Record<string, ReadonlyArray<CloudObject>>>;
  /** Object bytes by `bucket/object`. */
  readonly objectBytes: Readonly<Record<string, string>>;
  /** Pre-authenticated links by bucket name. */
  readonly links: Readonly<Record<string, ReadonlyArray<CloudLink>>>;
  /** Records by zone id. */
  readonly records: Readonly<Record<string, ReadonlyArray<CloudRecord>>>;
}

/** The key an availability is kept under. */
export function availabilityKey_make(region: string, service: string, name: string, zone?: string): string {
  return zone === undefined ? `${region}/${service}/${name}` : `${region}/${service}/${name}/${zone}`;
}

/** A driver over a fixture. */
export class FakeDriver implements CloudDriver {
  readonly cloud: string;
  private readonly cloudData: FakeCloud;
  /** How often each method was asked; the tests read it to prove caching. */
  readonly calls: Record<string, number> = {};

  constructor(cloudData: FakeCloud, cloud: string = 'oci') {
    this.cloudData = cloudData;
    this.cloud = cloud;
  }

  private call_count(method: string): void {
    this.calls[method] = (this.calls[method] ?? 0) + 1;
  }

  async identity_get(): Promise<CloudIdentity> {
    this.call_count('identity_get');
    return this.cloudData.identity;
  }

  async root_get(): Promise<CloudContainer> {
    this.call_count('root_get');
    const root: CloudContainer | undefined = this.cloudData.containers.find((container: CloudContainer): boolean => container.parentId === null);
    if (root === undefined) throw new Error('fake cloud: no root container');
    return root;
  }

  async containers_list(parentId: string): Promise<CloudContainer[]> {
    this.call_count('containers_list');
    return this.cloudData.containers
      .filter((container: CloudContainer): boolean => container.parentId === parentId)
      .sort((a: CloudContainer, b: CloudContainer): number => a.name.localeCompare(b.name));
  }

  async regions_list(): Promise<string[]> {
    this.call_count('regions_list');
    return [...this.cloudData.regions];
  }

  async zones_list(region: string): Promise<CloudZone[]> {
    this.call_count('zones_list');
    return [...(this.cloudData.zones[region] ?? [])];
  }

  async limitServices_list(region: string): Promise<string[]> {
    this.call_count('limitServices_list');
    const services: Set<string> = new Set((this.cloudData.limits[region] ?? []).map((limit: CloudLimit): string => limit.service));
    return [...services].sort();
  }

  async limits_list(region: string, service: string): Promise<CloudLimit[]> {
    this.call_count('limits_list');
    return (this.cloudData.limits[region] ?? []).filter((limit: CloudLimit): boolean => limit.service === service);
  }

  async limitAvailability_get(region: string, service: string, name: string, zone?: string): Promise<CloudAvailability | null> {
    this.call_count('limitAvailability_get');
    return this.cloudData.availability[availabilityKey_make(region, service, name, zone)] ?? null;
  }

  async shapes_list(region: string): Promise<CloudShape[]> {
    this.call_count('shapes_list');
    return [...(this.cloudData.shapes[region] ?? [])].sort((a: CloudShape, b: CloudShape): number => a.name.localeCompare(b.name));
  }

  async prices_list(): Promise<CloudPrice[]> {
    this.call_count('prices_list');
    return [...this.cloudData.prices];
  }

  async servicePrices_get(): Promise<ServicePrices | null> {
    this.call_count('servicePrices_get');
    return this.cloudData.servicePrices ?? null;
  }

  /** The records of one kind in a container and region, sorted by name; DNS is global. */
  private resources_list<T extends CloudResource>(kind: ResourceKind, containerId: string, region: string): T[] {
    this.call_count(`${kind}_list`);
    return this.cloudData.resources
      .filter((entry: FakeResource): boolean => entry.kind === kind && entry.containerId === containerId && (kind === 'dns' || entry.record.region === region))
      .map((entry: FakeResource): T => entry.record as T)
      .sort((a: T, b: T): number => a.name.localeCompare(b.name));
  }

  async instances_list(containerId: string, region: string): Promise<CloudInstance[]> {
    return this.resources_list<CloudInstance>('instances', containerId, region);
  }

  async networks_list(containerId: string, region: string): Promise<CloudNetwork[]> {
    return this.resources_list<CloudNetwork>('networks', containerId, region);
  }

  async subnets_list(containerId: string, region: string): Promise<CloudSubnet[]> {
    return this.resources_list<CloudSubnet>('subnets', containerId, region);
  }

  async securitygroups_list(containerId: string, region: string): Promise<CloudSecurityGroup[]> {
    return this.resources_list<CloudSecurityGroup>('securitygroups', containerId, region);
  }

  async loadbalancers_list(containerId: string, region: string): Promise<CloudLoadBalancer[]> {
    return this.resources_list<CloudLoadBalancer>('loadbalancers', containerId, region);
  }

  async volumes_list(containerId: string, region: string): Promise<CloudVolume[]> {
    return this.resources_list<CloudVolume>('volumes', containerId, region);
  }

  async buckets_list(containerId: string, region: string): Promise<CloudBucket[]> {
    return this.resources_list<CloudBucket>('buckets', containerId, region);
  }

  async dns_list(containerId: string, region: string): Promise<CloudDnsZone[]> {
    return this.resources_list<CloudDnsZone>('dns', containerId, region);
  }

  async objects_list(bucket: string): Promise<CloudObject[]> {
    this.call_count('objects_list');
    return [...(this.cloudData.objects[bucket] ?? [])];
  }

  async links_list(bucket: string): Promise<CloudLink[]> {
    this.call_count('links_list');
    return [...(this.cloudData.links[bucket] ?? [])];
  }

  async object_read(bucket: string, object: string): Promise<Buffer> {
    this.call_count('object_read');
    const text: string | undefined = this.cloudData.objectBytes[`${bucket}/${object}`];
    if (text === undefined) throw new Error(`fake cloud: no object ${bucket}/${object}`);
    return Buffer.from(text, 'utf-8');
  }

  async records_list(zoneId: string): Promise<CloudRecord[]> {
    this.call_count('records_list');
    return [...(this.cloudData.records[zoneId] ?? [])];
  }

  async clusters_find(tagKey: string, region: string): Promise<FoundCluster[]> {
    this.call_count('clusters_find');
    const byName: Map<string, { stack: FoundCluster['stack']; compartmentId: string | null }> = new Map();
    for (const container of this.cloudData.containers) {
      const name: string | undefined = container.tags[tagKey];
      if (name === undefined || container.state !== 'active') continue;
      byName.set(name, { ...(byName.get(name) ?? { stack: null, compartmentId: null }), compartmentId: container.id });
    }
    for (const stack of this.cloudData.stacks ?? []) {
      const name: string | undefined = stack.tags[tagKey];
      if (name === undefined || stack.region !== region || GONE_STATES.includes(stack.state)) continue;
      byName.set(name, { ...(byName.get(name) ?? { stack: null, compartmentId: null }), stack: { id: stack.id, state: stack.state, compartmentId: stack.compartmentId } });
    }
    return [...byName.entries()]
      .sort(([a]: [string, unknown], [b]: [string, unknown]): number => a.localeCompare(b))
      .map(([name, entry]): FoundCluster => ({ name, stack: entry.stack, compartmentId: entry.compartmentId, region }));
  }

  async resources_search(containerId: string, region: string): Promise<ResourceCounts> {
    this.call_count('resources_search');
    const counts: Partial<Record<ResourceKind, number>> = {};
    for (const entry of this.cloudData.resources) {
      if (entry.containerId !== containerId || GONE_STATES.includes(entry.record.state)) continue;
      if (entry.kind !== 'dns' && entry.record.region !== region) continue;
      counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
    }
    return counts;
  }
}

/**
 * A small cloud with the shape of the real one: a tenancy, two compartments
 * (one nested), one region with three zones, a few limits and shapes.
 *
 * @param tenancy - The tenancy's name.
 * @returns The fixture.
 */
export function fakeCloud_sample(tenancy: string = 'fnndsc'): FakeCloud {
  const region: string = 'us-ashburn-1';
  const zones: CloudZone[] = [1, 2, 3].map((n: number): CloudZone => ({ name: `Uocm:US-ASHBURN-AD-${n}` }));
  const container = (name: string, id: string, parentId: string | null, description: string, tags: Record<string, string> = {}): CloudContainer => ({
    name, id, parentId, state: 'active', created: '2026-08-27T12:00:00.000Z', description, tags, noun: 'compartment',
    raw: { id, name, description, compartmentId: parentId, lifecycleState: 'ACTIVE', timeCreated: '2026-08-27T12:00:00.000Z' },
  });
  const limit = (service: string, name: string, value: number, zone?: string): CloudLimit =>
    zone === undefined ? { service, name, scope: 'region', value } : { service, name, scope: 'zone', zone, value };
  const shape = (name: string, family: string, processor: string): CloudShape => ({
    name, family, flexible: true, vcpuPerCore: 2, cores: { min: 1, max: 94 }, memoryGib: { min: 1, max: 1049 }, processor, gpus: 0,
    quotaNames: [`standard-${family.toLowerCase()}-core-count`, `standard-${family.toLowerCase()}-memory-count`],
    limitService: 'compute',
    raw: { shape: name, processorDescription: processor, isFlexible: true },
  });
  return {
    identity: { user: 'rudolph', tenancy, tenancyId: 'ocid1.tenancy.oc1..root', homeRegion: region },
    containers: [
      container(tenancy, 'ocid1.tenancy.oc1..root', null, 'the root compartment'),
      container('harbor-oci', 'ocid1.compartment.oc1..harbor', 'ocid1.tenancy.oc1..root', 'Trusted Domain builds', { 'openshift-tags.openshift-resource': 'harbor' }),
      container('sandbox', 'ocid1.compartment.oc1..sandbox', 'ocid1.tenancy.oc1..root', 'scratch'),
      container('scratch-a', 'ocid1.compartment.oc1..scratcha', 'ocid1.compartment.oc1..sandbox', 'a nested scratch compartment'),
    ],
    regions: [region],
    zones: { [region]: zones },
    limits: {
      [region]: [
        ...zones.map((zone: CloudZone): CloudLimit => limit('compute', 'standard-e5-core-count', 9250, zone.name)),
        ...zones.map((zone: CloudZone): CloudLimit => limit('compute', 'standard-e5-memory-count', 9250 * 8, zone.name)),
        limit('load-balancer', 'lb-flexible-count', 50),
        { service: 'vcn', name: 'vcn-count', scope: 'global', value: 50 },
      ],
    },
    availability: {
      [availabilityKey_make(region, 'compute', 'standard-e5-core-count', zones[0].name)]: { used: 12, available: 9238 },
      [availabilityKey_make(region, 'load-balancer', 'lb-flexible-count')]: { used: 3, available: 47 },
      [availabilityKey_make(region, 'vcn', 'vcn-count')]: { used: 1, available: 49 },
    },
    shapes: { [region]: [shape('VM.Standard.E5.Flex', 'E5', 'AMD EPYC 9J14'), shape('VM.Standard.A2.Flex', 'A2', 'Ampere AmpereOne')] },
    prices: [
      { shape: 'VM.Standard.E5.Flex', vcpuHour: 0.015, gibHour: 0.002, currency: 'USD' },
      { shape: 'VM.Standard.A2.Flex', vcpuHour: 0.007, gibHour: 0.002, currency: 'USD' },
    ],
    servicePrices: { volumeGibMonth: 0.0255, vpuGibMonth: 0.0017, balancerHour: 0.0113, balancerMbpsHour: 0.0001, currency: 'USD' },
    ...fakeResources_sample(region, 'ocid1.compartment.oc1..harbor'),
  };
}

/**
 * The resources of a small cluster in one compartment: three nodes, a
 * network with subnets and security groups, two load balancers, their
 * volumes, a bucket holding an image, and a DNS zone.
 *
 * @param region - The region they live in.
 * @param containerId - The compartment holding them.
 * @returns The resource part of a fake cloud.
 */
export function fakeResources_sample(region: string, containerId: string): Pick<FakeCloud, 'resources' | 'objects' | 'objectBytes' | 'links' | 'records'> {
  const tags: Record<string, string> = { 'openshift-tags.openshift-resource': 'harbor' };
  const base = (name: string, id: string, state: string): CloudResource => ({
    name, id, state, region, created: '2026-10-06T14:00:00.000Z', tags, raw: { id, displayName: name, lifecycleState: state.toUpperCase() },
  });
  const vcn: string = 'ocid1.vcn.oc1.iad.harbor';
  const resources: FakeResource[] = [
    ...[0, 1, 2].map((n: number): FakeResource => ({
      kind: 'instances', containerId,
      record: { ...base(`node-${n}`, `ocid1.instance.oc1.iad.node0${n}`, 'running'), shape: 'VM.Standard.E5.Flex', zone: `Uocm:US-ASHBURN-AD-${n + 1}`, ips: [`10.0.16.${10 + n}`], vcpus: 8, memoryGib: 24 },
    })),
    { kind: 'instances', containerId, record: { ...base('bootstrap', 'ocid1.instance.oc1.iad.boot00', 'terminated'), shape: 'VM.Standard.E5.Flex', zone: 'Uocm:US-ASHBURN-AD-1', ips: [] } },
    { kind: 'networks', containerId, record: base('harbor-vcn', vcn, 'available') },
    ...['control', 'compute', 'lb'].map((name: string, n: number): FakeResource => ({ kind: 'subnets', containerId, record: { ...base(name, `ocid1.subnet.oc1.iad.sub00${n}`, 'available'), networkId: vcn } })),
    ...['cluster', 'api'].map((name: string, n: number): FakeResource => ({ kind: 'securitygroups', containerId, record: { ...base(name, `ocid1.networksecuritygroup.oc1.iad.nsg00${n}`, 'available'), networkId: vcn } })),
    { kind: 'loadbalancers', containerId, record: { ...base('api', 'ocid1.loadbalancer.oc1.iad.lbapi0', 'active'), ips: ['129.0.0.10', '10.0.32.5'], shape: 'flexible', minimumMbps: 10 } },
    { kind: 'loadbalancers', containerId, record: { ...base('apps', 'ocid1.loadbalancer.oc1.iad.lbapp0', 'active'), ips: ['129.0.0.11'], shape: 'flexible', minimumMbps: 10 } },
    ...[0, 1, 2].map((n: number): FakeResource => ({
      kind: 'volumes', containerId,
      record: { ...base(`node-${n} (Boot Volume)`, `ocid1.bootvolume.oc1.iad.boot0${n}`, 'available'), sizeGib: 120, attachedTo: `ocid1.instance.oc1.iad.node0${n}`, boot: true, vpusPerGib: 10 },
    })),
    { kind: 'volumes', containerId, record: { ...base('etcd-0', 'ocid1.volume.oc1.iad.etcd00', 'available'), sizeGib: 50, attachedTo: 'ocid1.instance.oc1.iad.node00', boot: false } },
    { kind: 'volumes', containerId, record: { ...base('spare', 'ocid1.volume.oc1.iad.spare0', 'available'), sizeGib: 50, attachedTo: null, boot: false } },
    { kind: 'buckets', containerId, record: base('iso', 'ocid1.bucket.oc1.iad.iso000', 'active') },
    { kind: 'dns', containerId, record: base('harbor.fnndsc.org', 'ocid1.dns-zone.oc1..harbor', 'active') },
  ];
  return {
    resources,
    objects: { iso: [{ name: 'agent.x86_64.iso', size: 1_181_745_152, modified: '2026-10-06T14:10:00.000Z' }, { name: 'README', size: 30, modified: '2026-10-06T14:00:00.000Z' }] },
    objectBytes: { 'iso/README': 'the agent ISO the nodes boot.\n' },
    links: { iso: [{ object: 'agent.x86_64.iso', name: 'agent-iso-read', access: 'ObjectRead', expires: '2026-11-06T14:10:00.000Z' }] },
    records: {
      'ocid1.dns-zone.oc1..harbor': [
        { domain: 'harbor.fnndsc.org', type: 'SOA', ttl: 300, data: 'ns1.p201.dns.oraclecloud.net. hostmaster.oracle.com. 2 3600 3600 3600 300' },
        { domain: 'api.harbor.fnndsc.org', type: 'A', ttl: 300, data: '129.0.0.10' },
        { domain: 'api-int.harbor.fnndsc.org', type: 'A', ttl: 300, data: '10.0.32.5' },
        { domain: '*.apps.harbor.fnndsc.org', type: 'A', ttl: 300, data: '129.0.0.11' },
      ],
    },
  };
}
