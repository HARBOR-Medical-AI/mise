/**
 * @file The OCI driver: Oracle Cloud Infrastructure as stratus's cloud.
 *
 * Containers are compartments, the root the tenancy; zones are availability
 * domains; limits come from the Limits service and shapes from Compute,
 * each asked in the region given; prices from Oracle's public list. The
 * resource kinds come from their services (Compute, Virtual Network, Block
 * Storage, Load Balancing, Object Storage, DNS) and their counts from
 * Resource Search: VCNs are networks, NSGs security groups, block and boot
 * volumes both volumes. The SDK
 * is reached through `OciApi` (`api.ts`), so this file maps records and
 * tests run it over recorded answers.
 *
 * @module
 */
import type {
  CloudAvailability, CloudBucket, CloudContainer, CloudDnsZone, CloudDriver, CloudIdentity, CloudInstance, CloudLimit, CloudLink, CloudLoadBalancer,
  CloudNetwork, CloudObject, CloudPrice, ServicePrices, CloudRecord, CloudSecurityGroup, CloudShape, CloudSubnet, CloudVolume, CloudZone, FoundCluster, ResourceCounts,
} from '../driver.js';
import type { OciApi, OciCompartmentRecord, OciLimitValueRecord, OciShapeRecord, OciTenancyRecord } from './api.js';
import type { OciAttachmentRecord, OciInstanceRecord, OciResourceRecord, OciVnicAttachmentRecord, OciVnicRecord, OciVolumeRecord } from './resourceApi.js';
import { byName_sort, foundClusters_fold, resource_convert, searchHits_count, searchQuery_format, tagQuery_format } from './resourceMap.js';
import { ociPrices_read, ociServicePrices_read, shapeTerms_get, type JsonFetch } from './prices.js';

/** How the driver is made. */
export interface OciDriverOptions {
  /** The API; the real one when absent. */
  readonly api: OciApi;
  /** How the price list is fetched; Node's fetch when absent. */
  readonly fetchJson?: JsonFetch;
}

/** Tags flattened: freeform as `key`, defined as `namespace.key`. */
export function ociTags_flatten(freeform: Readonly<Record<string, string>>, defined: Readonly<Record<string, Readonly<Record<string, unknown>>>>): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(freeform)) tags[key] = value;
  for (const [namespace, keys] of Object.entries(defined)) {
    for (const [key, value] of Object.entries(keys)) tags[`${namespace}.${key}`] = String(value);
  }
  return tags;
}

/** A compartment record as a container. */
function container_convertFromCompartment(record: OciCompartmentRecord): CloudContainer {
  return {
    name: record.name,
    id: record.id,
    parentId: record.compartmentId,
    state: record.lifecycleState.toLowerCase(),
    created: record.timeCreated,
    description: record.description,
    tags: ociTags_flatten(record.freeformTags, record.definedTags),
    noun: 'compartment',
    raw: record,
  };
}

/** The tenancy as the root container. */
function container_convertFromTenancy(record: OciTenancyRecord): CloudContainer {
  return {
    name: record.name,
    id: record.id,
    parentId: null,
    state: 'active',
    created: '',
    description: record.description,
    tags: ociTags_flatten(record.freeformTags, record.definedTags),
    noun: 'tenancy',
    raw: record,
  };
}

/** A limit value as a limit at its scope. */
function limit_convert(service: string, record: OciLimitValueRecord): CloudLimit {
  const scope: string = record.scopeType.toUpperCase();
  if (scope === 'AD' && record.availabilityDomain !== null) {
    return { service, name: record.name, scope: 'zone', zone: record.availabilityDomain, value: record.value };
  }
  return { service, name: record.name, scope: scope === 'GLOBAL' ? 'global' : 'region', value: record.value };
}

/** A shape record as a shape. */
export function shape_convert(record: OciShapeRecord): CloudShape {
  const terms = shapeTerms_get(record.shape);
  const cores: { min: number; max: number } = record.isFlexible && record.ocpuOptions !== null
    ? { min: record.ocpuOptions.min * terms.vcpuPerOcpu, max: record.ocpuOptions.max * terms.vcpuPerOcpu }
    : { min: (record.ocpus ?? 0) * terms.vcpuPerOcpu, max: (record.ocpus ?? 0) * terms.vcpuPerOcpu };
  const memoryGib: { min: number; max: number } = record.isFlexible && record.memoryOptions !== null
    ? { min: record.memoryOptions.minInGBs, max: record.memoryOptions.maxInGBs }
    : { min: record.memoryInGBs ?? 0, max: record.memoryInGBs ?? 0 };
  return {
    name: record.shape,
    family: terms.family,
    flexible: record.isFlexible,
    vcpuPerCore: terms.vcpuPerOcpu,
    cores,
    memoryGib,
    processor: record.processorDescription,
    gpus: record.gpus,
    quotaNames: record.quotaNames,
    limitService: 'compute',
    raw: record.raw,
  };
}

/** Oracle Cloud Infrastructure as a cloud driver. */
export class OciDriver implements CloudDriver {
  readonly cloud: string = 'oci';
  private readonly api: OciApi;
  private readonly fetchJson: JsonFetch | undefined;
  private readonly namespaces: Map<string, Promise<string>> = new Map();

  constructor(options: OciDriverOptions) {
    this.api = options.api;
    this.fetchJson = options.fetchJson;
  }

  /** The Object Storage namespace, asked once per region. */
  private namespace_get(region: string): Promise<string> {
    let namespace: Promise<string> | undefined = this.namespaces.get(region);
    if (namespace === undefined) {
      namespace = this.api.namespace_get(region);
      namespace.catch((): void => { this.namespaces.delete(region); });
      this.namespaces.set(region, namespace);
    }
    return namespace;
  }

  async identity_get(): Promise<CloudIdentity> {
    const credential: { tenancyId: string; userId: string; region: string } = this.api.credential_get();
    const [tenancy, user]: [OciTenancyRecord, string] = await Promise.all([
      this.api.tenancy_get(credential.tenancyId),
      this.api.userName_get(credential.userId),
    ]);
    return { user, tenancy: tenancy.name, tenancyId: tenancy.id, homeRegion: credential.region };
  }

  async root_get(): Promise<CloudContainer> {
    return container_convertFromTenancy(await this.api.tenancy_get(this.api.credential_get().tenancyId));
  }

  async containers_list(parentId: string): Promise<CloudContainer[]> {
    const records: OciCompartmentRecord[] = await this.api.compartments_list(parentId);
    return records
      .filter((record: OciCompartmentRecord): boolean => record.lifecycleState.toUpperCase() !== 'DELETED')
      .map(container_convertFromCompartment)
      .sort((a: CloudContainer, b: CloudContainer): number => a.name.localeCompare(b.name));
  }

  async regions_list(): Promise<string[]> {
    return this.api.regionSubscriptions_list(this.api.credential_get().tenancyId);
  }

  async zones_list(region: string): Promise<CloudZone[]> {
    const names: string[] = await this.api.availabilityDomains_list(region, this.api.credential_get().tenancyId);
    return names.map((name: string): CloudZone => ({ name }));
  }

  async limitServices_list(region: string): Promise<string[]> {
    return this.api.limitServices_list(region, this.api.credential_get().tenancyId);
  }

  async limits_list(region: string, service: string): Promise<CloudLimit[]> {
    const records: OciLimitValueRecord[] = await this.api.limitValues_list(region, this.api.credential_get().tenancyId, service);
    return records.map((record: OciLimitValueRecord): CloudLimit => limit_convert(service, record));
  }

  async limitAvailability_get(region: string, service: string, name: string, zone?: string): Promise<CloudAvailability | null> {
    return this.api.resourceAvailability_get(region, this.api.credential_get().tenancyId, service, name, zone);
  }

  async shapes_list(region: string): Promise<CloudShape[]> {
    const records: OciShapeRecord[] = await this.api.shapes_list(region, this.api.credential_get().tenancyId);
    const seen: Set<string> = new Set();
    const shapes: CloudShape[] = [];
    for (const record of records) {
      if (seen.has(record.shape)) continue;
      seen.add(record.shape);
      shapes.push(shape_convert(record));
    }
    return shapes.sort((a: CloudShape, b: CloudShape): number => a.name.localeCompare(b.name));
  }

  async prices_list(): Promise<CloudPrice[]> {
    return ociPrices_read(this.fetchJson);
  }

  async servicePrices_get(): Promise<ServicePrices | null> {
    return ociServicePrices_read(this.fetchJson);
  }

  async instances_list(containerId: string, region: string): Promise<CloudInstance[]> {
    const [records, attachments]: [OciInstanceRecord[], OciVnicAttachmentRecord[]] = await Promise.all([
      this.api.instances_list(region, containerId),
      this.api.vnicAttachments_list(region, containerId),
    ]);
    const live: OciVnicAttachmentRecord[] = attachments.filter((attachment: OciVnicAttachmentRecord): boolean => attachment.lifecycleState.toUpperCase() === 'ATTACHED' && attachment.vnicId !== '');
    const vnics: OciVnicRecord[] = await Promise.all(live.map((attachment: OciVnicAttachmentRecord): Promise<OciVnicRecord> => this.api.vnic_get(region, attachment.vnicId)));
    const ipsByInstance: Map<string, string[]> = new Map();
    live.forEach((attachment: OciVnicAttachmentRecord, index: number): void => {
      const vnic: OciVnicRecord = vnics[index] as OciVnicRecord;
      const ips: string[] = ipsByInstance.get(attachment.instanceId) ?? [];
      if (vnic.privateIp !== null) ips.unshift(vnic.privateIp);
      if (vnic.publicIp !== null) ips.push(vnic.publicIp);
      ipsByInstance.set(attachment.instanceId, ips);
    });
    return byName_sort(records.map((record: OciInstanceRecord): CloudInstance => ({
      ...resource_convert(record, region), shape: record.shape, zone: record.availabilityDomain, ips: ipsByInstance.get(record.id) ?? [],
      ...(record.ocpus !== undefined ? { vcpus: record.ocpus * shapeTerms_get(record.shape).vcpuPerOcpu } : {}),
      ...(record.memoryInGBs !== undefined ? { memoryGib: record.memoryInGBs } : {}),
    })));
  }

  async networks_list(containerId: string, region: string): Promise<CloudNetwork[]> {
    return byName_sort((await this.api.vcns_list(region, containerId)).map((record: OciResourceRecord): CloudNetwork => resource_convert(record, region)));
  }

  async subnets_list(containerId: string, region: string): Promise<CloudSubnet[]> {
    return byName_sort((await this.api.subnets_list(region, containerId)).map((record) => ({ ...resource_convert(record, region), networkId: record.vcnId })));
  }

  async securitygroups_list(containerId: string, region: string): Promise<CloudSecurityGroup[]> {
    return byName_sort((await this.api.nsgs_list(region, containerId)).map((record) => ({ ...resource_convert(record, region), networkId: record.vcnId })));
  }

  async loadbalancers_list(containerId: string, region: string): Promise<CloudLoadBalancer[]> {
    return byName_sort((await this.api.loadBalancers_list(region, containerId)).map((record) => ({ ...resource_convert(record, region), ips: record.ipAddresses, shape: record.shapeName, ...(record.minimumMbps !== undefined ? { minimumMbps: record.minimumMbps } : {}) })));
  }

  async volumes_list(containerId: string, region: string): Promise<CloudVolume[]> {
    const zones: string[] = await this.api.availabilityDomains_list(region, this.api.credential_get().tenancyId);
    const [blocks, attachments, boots, bootAttachments]: [OciVolumeRecord[], OciAttachmentRecord[], OciVolumeRecord[][], OciAttachmentRecord[][]] = await Promise.all([
      this.api.volumes_list(region, containerId),
      this.api.volumeAttachments_list(region, containerId),
      Promise.all(zones.map((zone: string): Promise<OciVolumeRecord[]> => this.api.bootVolumes_list(region, containerId, zone))),
      Promise.all(zones.map((zone: string): Promise<OciAttachmentRecord[]> => this.api.bootVolumeAttachments_list(region, containerId, zone))),
    ]);
    const attachedTo: Map<string, string> = new Map();
    for (const attachment of [...attachments, ...bootAttachments.flat()]) {
      if (['ATTACHED', 'ATTACHING'].includes(attachment.lifecycleState.toUpperCase())) attachedTo.set(attachment.volumeId, attachment.instanceId);
    }
    const volume_convert = (record: OciVolumeRecord, boot: boolean): CloudVolume => ({
      ...resource_convert(record, region), sizeGib: record.sizeInGBs, attachedTo: attachedTo.get(record.id) ?? null, boot,
      ...(record.vpusPerGB !== undefined ? { vpusPerGib: record.vpusPerGB } : {}),
    });
    return byName_sort([
      ...blocks.map((record: OciVolumeRecord): CloudVolume => volume_convert(record, false)),
      ...boots.flat().map((record: OciVolumeRecord): CloudVolume => volume_convert(record, true)),
    ]);
  }

  async buckets_list(containerId: string, region: string): Promise<CloudBucket[]> {
    const namespace: string = await this.namespace_get(region);
    return byName_sort((await this.api.buckets_list(region, namespace, containerId)).map((record: OciResourceRecord): CloudBucket => resource_convert(record, region)));
  }

  async dns_list(containerId: string, region: string): Promise<CloudDnsZone[]> {
    const seen: Set<string> = new Set();
    const zones: CloudDnsZone[] = [];
    for (const record of await this.api.zones_list(region, containerId)) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      zones.push(resource_convert(record, region));
    }
    return byName_sort(zones);
  }

  async objects_list(bucket: string, region: string): Promise<CloudObject[]> {
    const records = await this.api.objects_list(region, await this.namespace_get(region), bucket);
    return records.map((record): CloudObject => ({ name: record.name, size: record.size, modified: record.timeModified }));
  }

  async links_list(bucket: string, region: string): Promise<CloudLink[]> {
    const records = await this.api.pars_list(region, await this.namespace_get(region), bucket);
    return records.map((record): CloudLink => ({ object: record.objectName, name: record.name, access: record.accessType, expires: record.timeExpires }));
  }

  async object_read(bucket: string, object: string, region: string): Promise<Buffer> {
    return this.api.object_get(region, await this.namespace_get(region), bucket, object);
  }

  async records_list(zoneId: string, region: string): Promise<CloudRecord[]> {
    const records = await this.api.zoneRecords_list(region, zoneId);
    return records.map((record): CloudRecord => ({ domain: record.domain, type: record.rtype, ttl: record.ttl, data: record.rdata }));
  }

  async resources_search(containerId: string, region: string): Promise<ResourceCounts> {
    return searchHits_count(await this.api.search_list(region, searchQuery_format(containerId)));
  }

  async clusters_find(tagKey: string, region: string): Promise<FoundCluster[]> {
    return foundClusters_fold(await this.api.search_list(region, tagQuery_format(tagKey)), tagKey, region);
  }
}
