/**
 * @file The OCI calls the resource kinds need: Compute, Virtual Network,
 * Block Storage, Load Balancing, Object Storage, DNS and Resource Search.
 *
 * Like `api.ts`, every call pages to the end and answers plain records, so
 * the driver maps records and its tests replay recorded answers. Each
 * service's client is made once per region. Only this folder imports an
 * `oci-*` package (`lint:stratus-deps`).
 *
 * @module
 */
import type { Readable } from 'node:stream';
import type * as common from 'oci-common';
import * as core from 'oci-core';
import * as dns from 'oci-dns';
import * as loadbalancer from 'oci-loadbalancer';
import * as objectstorage from 'oci-objectstorage';
import * as resourcesearch from 'oci-resourcesearch';

/** Tags as OCI keeps them on every resource. */
export interface OciTags {
  readonly freeformTags: Readonly<Record<string, string>>;
  readonly definedTags: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** What every resource record carries. */
export interface OciResourceRecord extends OciTags {
  readonly id: string;
  readonly displayName: string;
  readonly lifecycleState: string;
  /** ISO 8601, or empty. */
  readonly timeCreated: string;
  readonly raw: unknown;
}

/** An instance. */
export interface OciInstanceRecord extends OciResourceRecord {
  readonly shape: string;
  readonly availabilityDomain: string;
  /** Its OCPUs and memory, when the cloud says (a flexible shape's choice). */
  readonly ocpus?: number;
  readonly memoryInGBs?: number;
  /** The image it was made from. */
  readonly imageId?: string;
}

/** An image's operating system, as the cloud names it (`Canonical Ubuntu`, `26.04`). */
export interface OciImageRecord {
  readonly operatingSystem: string;
  readonly operatingSystemVersion: string;
}

/** One ingress rule of a network security group: TCP's ports when it names them. */
export interface OciIngressRecord {
  readonly source: string;
  /** The protocol's number (`6` TCP, `all`). */
  readonly protocol: string;
  readonly ports: { readonly min: number; readonly max: number } | null;
}

/** The backup policy a volume is assigned: its name and its schedules' periods (`ONE_DAY`). */
export interface OciBackupPolicyRecord {
  readonly name: string;
  readonly periods: ReadonlyArray<string>;
}

/** A VCN, with the address ranges it holds. */
export interface OciVcnRecord extends OciResourceRecord {
  readonly cidrBlocks: ReadonlyArray<string>;
}

/** A VNIC attached to an instance. */
export interface OciVnicAttachmentRecord {
  readonly instanceId: string;
  readonly vnicId: string;
  readonly lifecycleState: string;
}

/** A VNIC's addresses. */
export interface OciVnicRecord {
  readonly privateIp: string | null;
  readonly publicIp: string | null;
  /** The network security groups it is in. */
  readonly nsgIds?: ReadonlyArray<string>;
}

/** A subnet or a network security group: a member of a VCN. */
export interface OciVcnMemberRecord extends OciResourceRecord {
  readonly vcnId: string;
}

/** A load balancer. */
export interface OciLoadBalancerRecord extends OciResourceRecord {
  readonly ipAddresses: ReadonlyArray<string>;
  readonly shapeName: string;
  /** A flexible shape's minimum bandwidth, what it bills by. */
  readonly minimumMbps?: number;
}

/** A block or boot volume. */
export interface OciVolumeRecord extends OciResourceRecord {
  readonly sizeInGBs: number;
  readonly availabilityDomain: string;
  /** Its performance, in volume performance units per GB. */
  readonly vpusPerGB?: number;
}

/** A volume's attachment to an instance. */
export interface OciAttachmentRecord {
  readonly volumeId: string;
  readonly instanceId: string;
  readonly lifecycleState: string;
}

/** An object in a bucket. */
export interface OciObjectRecord {
  readonly name: string;
  readonly size: number;
  /** ISO 8601, or empty. */
  readonly timeModified: string;
}

/** A pre-authenticated request. */
export interface OciParRecord {
  readonly name: string;
  readonly objectName: string | null;
  readonly accessType: string;
  /** ISO 8601. */
  readonly timeExpires: string;
}

/** A DNS record. */
export interface OciDnsRecord {
  readonly domain: string;
  readonly rtype: string;
  readonly ttl: number;
  readonly rdata: string;
}

/** One hit of a structured search. */
export interface OciSearchRecord {
  readonly resourceType: string;
  readonly lifecycleState: string;
  /** Its OCID. */
  readonly identifier: string;
  readonly displayName: string;
  /** The compartment holding it; for a compartment, its parent. */
  readonly compartmentId: string;
  readonly freeformTags: Readonly<Record<string, string>>;
}

/** The resource calls the driver makes; every list is in one compartment and region. */
export interface OciResourceApi {
  instances_list(region: string, compartmentId: string): Promise<OciInstanceRecord[]>;
  vnicAttachments_list(region: string, compartmentId: string): Promise<OciVnicAttachmentRecord[]>;
  vnic_get(region: string, vnicId: string): Promise<OciVnicRecord>;
  image_get(region: string, imageId: string): Promise<OciImageRecord>;
  nsgIngress_list(region: string, nsgId: string): Promise<OciIngressRecord[]>;
  backupPolicy_read(region: string, volumeId: string): Promise<OciBackupPolicyRecord | null>;
  vcns_list(region: string, compartmentId: string): Promise<OciVcnRecord[]>;
  subnets_list(region: string, compartmentId: string): Promise<OciVcnMemberRecord[]>;
  nsgs_list(region: string, compartmentId: string): Promise<OciVcnMemberRecord[]>;
  loadBalancers_list(region: string, compartmentId: string): Promise<OciLoadBalancerRecord[]>;
  volumes_list(region: string, compartmentId: string): Promise<OciVolumeRecord[]>;
  bootVolumes_list(region: string, compartmentId: string, availabilityDomain: string): Promise<OciVolumeRecord[]>;
  volumeAttachments_list(region: string, compartmentId: string): Promise<OciAttachmentRecord[]>;
  bootVolumeAttachments_list(region: string, compartmentId: string, availabilityDomain: string): Promise<OciAttachmentRecord[]>;
  namespace_get(region: string): Promise<string>;
  buckets_list(region: string, namespace: string, compartmentId: string): Promise<OciResourceRecord[]>;
  objects_list(region: string, namespace: string, bucket: string): Promise<OciObjectRecord[]>;
  pars_list(region: string, namespace: string, bucket: string): Promise<OciParRecord[]>;
  object_get(region: string, namespace: string, bucket: string, object: string): Promise<Buffer>;
  zones_list(region: string, compartmentId: string): Promise<OciResourceRecord[]>;
  zoneRecords_list(region: string, zoneId: string): Promise<OciDnsRecord[]>;
  search_list(region: string, query: string): Promise<OciSearchRecord[]>;
}

/** A page of items and the token for the next. */
interface Page<T> {
  readonly items: T[];
  readonly next?: string;
}

/** Every item of a paged call. */
async function pages_drain<T>(page_get: (page: string | undefined) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  let token: string | undefined = undefined;
  do {
    const page: Page<T> = await page_get(token);
    items.push(...page.items);
    token = page.next === '' ? undefined : page.next;
  } while (token !== undefined);
  return items;
}

/** The page argument, when there is one. */
function page_arg(page: string | undefined): { page?: string } {
  return page !== undefined ? { page } : {};
}

/** A date as ISO 8601, or empty. */
function iso_format(value: Date | string | undefined): string {
  return value === undefined ? '' : new Date(value).toISOString();
}

/** The fields every resource record carries, from an SDK model. */
function resourceRecord_convert(model: {
  id: string; displayName?: string; lifecycleState?: unknown; timeCreated?: Date;
  freeformTags?: Record<string, string>; definedTags?: Record<string, Record<string, unknown>>;
}): OciResourceRecord {
  return {
    id: model.id,
    displayName: model.displayName ?? '',
    lifecycleState: String(model.lifecycleState ?? ''),
    timeCreated: iso_format(model.timeCreated),
    freeformTags: model.freeformTags ?? {},
    definedTags: model.definedTags ?? {},
    raw: model,
  };
}

/** A response body's bytes, whichever stream the SDK handed back. */
async function body_read(value: Readable | ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  if ('getReader' in value) {
    const reader: ReadableStreamDefaultReader<Uint8Array> = value.getReader();
    for (;;) {
      const next: ReadableStreamReadResult<Uint8Array> = await reader.read();
      if (next.done) break;
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks);
  }
  for await (const chunk of value) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** The service clients, one per service and region. */
class Clients {
  private readonly made: Map<string, { regionId: string }> = new Map();

  constructor(private readonly provider: common.AuthenticationDetailsProvider) {}

  /** The client for a service in a region, made on first use. */
  private client_resolve<T extends { regionId: string }>(service: string, region: string, make: (provider: common.AuthenticationDetailsProvider) => T): T {
    const key: string = `${service}/${region}`;
    const found: { regionId: string } | undefined = this.made.get(key);
    if (found !== undefined) return found as T;
    const client: T = make(this.provider);
    client.regionId = region;
    this.made.set(key, client);
    return client;
  }

  compute(region: string): core.ComputeClient {
    return this.client_resolve('compute', region, (provider) => new core.ComputeClient({ authenticationDetailsProvider: provider }));
  }

  network(region: string): core.VirtualNetworkClient {
    return this.client_resolve('network', region, (provider) => new core.VirtualNetworkClient({ authenticationDetailsProvider: provider }));
  }

  storage(region: string): core.BlockstorageClient {
    return this.client_resolve('storage', region, (provider) => new core.BlockstorageClient({ authenticationDetailsProvider: provider }));
  }

  balancer(region: string): loadbalancer.LoadBalancerClient {
    return this.client_resolve('balancer', region, (provider) => new loadbalancer.LoadBalancerClient({ authenticationDetailsProvider: provider }));
  }

  objects(region: string): objectstorage.ObjectStorageClient {
    return this.client_resolve('objects', region, (provider) => new objectstorage.ObjectStorageClient({ authenticationDetailsProvider: provider }));
  }

  dns(region: string): dns.DnsClient {
    return this.client_resolve('dns', region, (provider) => new dns.DnsClient({ authenticationDetailsProvider: provider }));
  }

  search(region: string): resourcesearch.ResourceSearchClient {
    return this.client_resolve('search', region, (provider) => new resourcesearch.ResourceSearchClient({ authenticationDetailsProvider: provider }));
  }
}

/**
 * The resource calls over the SDK.
 *
 * @param provider - The credential the clients sign with.
 * @returns The calls.
 */
export function ociResourceApi_make(provider: common.AuthenticationDetailsProvider): OciResourceApi {
  const clients: Clients = new Clients(provider);
  return {
    async instances_list(region: string, compartmentId: string): Promise<OciInstanceRecord[]> {
      const items: core.models.Instance[] = await pages_drain(async (page) => {
        const answer: core.responses.ListInstancesResponse = await clients.compute(region).listInstances({ compartmentId, ...page_arg(page) });
        return { items: answer.items, next: answer.opcNextPage };
      });
      return items.map((instance: core.models.Instance): OciInstanceRecord => ({
        ...resourceRecord_convert(instance), shape: instance.shape, availabilityDomain: instance.availabilityDomain,
        ...(instance.shapeConfig?.ocpus !== undefined ? { ocpus: instance.shapeConfig.ocpus } : {}),
        ...(instance.shapeConfig?.memoryInGBs !== undefined ? { memoryInGBs: instance.shapeConfig.memoryInGBs } : {}),
        ...(instance.imageId !== undefined ? { imageId: instance.imageId } : {}),
      }));
    },
    async vnicAttachments_list(region: string, compartmentId: string): Promise<OciVnicAttachmentRecord[]> {
      const items: core.models.VnicAttachment[] = await pages_drain(async (page) => {
        const answer: core.responses.ListVnicAttachmentsResponse = await clients.compute(region).listVnicAttachments({ compartmentId, ...page_arg(page) });
        return { items: answer.items, next: answer.opcNextPage };
      });
      return items.map((attachment: core.models.VnicAttachment): OciVnicAttachmentRecord => ({
        instanceId: attachment.instanceId, vnicId: attachment.vnicId ?? '', lifecycleState: String(attachment.lifecycleState),
      }));
    },
    async vnic_get(region: string, vnicId: string): Promise<OciVnicRecord> {
      const answer: core.responses.GetVnicResponse = await clients.network(region).getVnic({ vnicId });
      return { privateIp: answer.vnic.privateIp ?? null, publicIp: answer.vnic.publicIp ?? null, nsgIds: answer.vnic.nsgIds ?? [] };
    },
    async image_get(region: string, imageId: string): Promise<OciImageRecord> {
      const answer: core.responses.GetImageResponse = await clients.compute(region).getImage({ imageId });
      return { operatingSystem: answer.image.operatingSystem, operatingSystemVersion: answer.image.operatingSystemVersion };
    },
    async nsgIngress_list(region: string, nsgId: string): Promise<OciIngressRecord[]> {
      const items: core.models.SecurityRule[] = await pages_drain(async (page) => {
        const answer: core.responses.ListNetworkSecurityGroupSecurityRulesResponse = await clients.network(region).listNetworkSecurityGroupSecurityRules({
          networkSecurityGroupId: nsgId, direction: core.requests.ListNetworkSecurityGroupSecurityRulesRequest.Direction.Ingress, ...page_arg(page),
        });
        return { items: answer.items, next: answer.opcNextPage };
      });
      return items.map((rule: core.models.SecurityRule): OciIngressRecord => {
        const range: core.models.PortRange | undefined = rule.tcpOptions?.destinationPortRange;
        return { source: rule.source ?? '', protocol: rule.protocol, ports: range === undefined ? null : { min: range.min, max: range.max } };
      });
    },
    async backupPolicy_read(region: string, volumeId: string): Promise<OciBackupPolicyRecord | null> {
      const assigned: core.responses.GetVolumeBackupPolicyAssetAssignmentResponse = await clients.storage(region).getVolumeBackupPolicyAssetAssignment({ assetId: volumeId });
      const policyId: string | undefined = assigned.items[0]?.policyId;
      if (policyId === undefined) return null;
      const policy: core.responses.GetVolumeBackupPolicyResponse = await clients.storage(region).getVolumeBackupPolicy({ policyId });
      return { name: policy.volumeBackupPolicy.displayName, periods: policy.volumeBackupPolicy.schedules.map((schedule: core.models.VolumeBackupSchedule): string => String(schedule.period)) };
    },
    async vcns_list(region: string, compartmentId: string): Promise<OciVcnRecord[]> {
      const items: core.models.Vcn[] = await pages_drain(async (page) => {
        const answer: core.responses.ListVcnsResponse = await clients.network(region).listVcns({ compartmentId, ...page_arg(page) });
        return { items: answer.items, next: answer.opcNextPage };
      });
      return items.map((vcn: core.models.Vcn): OciVcnRecord => ({ ...resourceRecord_convert(vcn), cidrBlocks: vcn.cidrBlocks ?? (vcn.cidrBlock !== undefined ? [vcn.cidrBlock] : []) }));
    },
    async subnets_list(region: string, compartmentId: string): Promise<OciVcnMemberRecord[]> {
      const items: core.models.Subnet[] = await pages_drain(async (page) => {
        const answer: core.responses.ListSubnetsResponse = await clients.network(region).listSubnets({ compartmentId, ...page_arg(page) });
        return { items: answer.items, next: answer.opcNextPage };
      });
      return items.map((subnet: core.models.Subnet): OciVcnMemberRecord => ({ ...resourceRecord_convert(subnet), vcnId: subnet.vcnId }));
    },
    async nsgs_list(region: string, compartmentId: string): Promise<OciVcnMemberRecord[]> {
      const items: core.models.NetworkSecurityGroup[] = await pages_drain(async (page) => {
        const answer: core.responses.ListNetworkSecurityGroupsResponse = await clients.network(region).listNetworkSecurityGroups({ compartmentId, ...page_arg(page) });
        return { items: answer.items, next: answer.opcNextPage };
      });
      return items.map((group: core.models.NetworkSecurityGroup): OciVcnMemberRecord => ({ ...resourceRecord_convert(group), vcnId: group.vcnId }));
    },
    async loadBalancers_list(region: string, compartmentId: string): Promise<OciLoadBalancerRecord[]> {
      const items: loadbalancer.models.LoadBalancer[] = await pages_drain(async (page) => {
        const answer: loadbalancer.responses.ListLoadBalancersResponse = await clients.balancer(region).listLoadBalancers({ compartmentId, ...page_arg(page) });
        return { items: answer.items, next: answer.opcNextPage };
      });
      return items.map((balancer: loadbalancer.models.LoadBalancer): OciLoadBalancerRecord => ({
        ...resourceRecord_convert(balancer),
        ipAddresses: (balancer.ipAddresses ?? []).map((address: loadbalancer.models.IpAddress): string => address.ipAddress),
        shapeName: balancer.shapeName,
        ...(balancer.shapeDetails?.minimumBandwidthInMbps !== undefined ? { minimumMbps: balancer.shapeDetails.minimumBandwidthInMbps } : {}),
      }));
    },
    async volumes_list(region: string, compartmentId: string): Promise<OciVolumeRecord[]> {
      const items: core.models.Volume[] = await pages_drain(async (page) => {
        const answer: core.responses.ListVolumesResponse = await clients.storage(region).listVolumes({ compartmentId, ...page_arg(page) });
        return { items: answer.items, next: answer.opcNextPage };
      });
      return items.map((volume: core.models.Volume): OciVolumeRecord => ({ ...resourceRecord_convert(volume), sizeInGBs: volume.sizeInGBs ?? 0, availabilityDomain: volume.availabilityDomain ?? '', ...(volume.vpusPerGB !== undefined ? { vpusPerGB: volume.vpusPerGB } : {}) }));
    },
    async bootVolumes_list(region: string, compartmentId: string, availabilityDomain: string): Promise<OciVolumeRecord[]> {
      const items: core.models.BootVolume[] = await pages_drain(async (page) => {
        const answer: core.responses.ListBootVolumesResponse = await clients.storage(region).listBootVolumes({ compartmentId, availabilityDomain, ...page_arg(page) });
        return { items: answer.items, next: answer.opcNextPage };
      });
      return items.map((volume: core.models.BootVolume): OciVolumeRecord => ({ ...resourceRecord_convert(volume), sizeInGBs: volume.sizeInGBs ?? 0, availabilityDomain: volume.availabilityDomain ?? '', ...(volume.vpusPerGB !== undefined ? { vpusPerGB: volume.vpusPerGB } : {}) }));
    },
    async volumeAttachments_list(region: string, compartmentId: string): Promise<OciAttachmentRecord[]> {
      const items: core.models.VolumeAttachment[] = await pages_drain(async (page) => {
        const answer: core.responses.ListVolumeAttachmentsResponse = await clients.compute(region).listVolumeAttachments({ compartmentId, ...page_arg(page) });
        return { items: answer.items, next: answer.opcNextPage };
      });
      return items.map((attachment: core.models.VolumeAttachment): OciAttachmentRecord => ({
        volumeId: attachment.volumeId, instanceId: attachment.instanceId, lifecycleState: String(attachment.lifecycleState),
      }));
    },
    async bootVolumeAttachments_list(region: string, compartmentId: string, availabilityDomain: string): Promise<OciAttachmentRecord[]> {
      const items: core.models.BootVolumeAttachment[] = await pages_drain(async (page) => {
        const answer: core.responses.ListBootVolumeAttachmentsResponse = await clients.compute(region).listBootVolumeAttachments({ compartmentId, availabilityDomain, ...page_arg(page) });
        return { items: answer.items, next: answer.opcNextPage };
      });
      return items.map((attachment: core.models.BootVolumeAttachment): OciAttachmentRecord => ({
        volumeId: attachment.bootVolumeId, instanceId: attachment.instanceId, lifecycleState: String(attachment.lifecycleState),
      }));
    },
    async namespace_get(region: string): Promise<string> {
      const answer: objectstorage.responses.GetNamespaceResponse = await clients.objects(region).getNamespace({});
      return answer.value;
    },
    async buckets_list(region: string, namespace: string, compartmentId: string): Promise<OciResourceRecord[]> {
      const summaries: objectstorage.models.BucketSummary[] = await pages_drain(async (page) => {
        const answer: objectstorage.responses.ListBucketsResponse = await clients.objects(region).listBuckets({ namespaceName: namespace, compartmentId, fields: [objectstorage.requests.ListBucketsRequest.Fields.Tags], ...page_arg(page) });
        return { items: answer.items, next: answer.opcNextPage };
      });
      // A summary carries no id; the bucket itself does.
      const buckets: OciResourceRecord[] = [];
      for (const summary of summaries) {
        const answer: objectstorage.responses.GetBucketResponse = await clients.objects(region).getBucket({ namespaceName: namespace, bucketName: summary.name });
        const bucket: objectstorage.models.Bucket = answer.bucket;
        buckets.push({ ...resourceRecord_convert({ ...bucket, id: bucket.id ?? `${namespace}/${bucket.name}`, displayName: bucket.name, lifecycleState: 'ACTIVE' }), raw: bucket });
      }
      return buckets;
    },
    async objects_list(region: string, namespace: string, bucket: string): Promise<OciObjectRecord[]> {
      const items: objectstorage.models.ObjectSummary[] = await pages_drain(async (page) => {
        const answer: objectstorage.responses.ListObjectsResponse = await clients.objects(region).listObjects({
          namespaceName: namespace, bucketName: bucket, fields: 'name,size,timeModified', ...(page !== undefined ? { start: page } : {}),
        });
        return { items: answer.listObjects.objects, next: answer.listObjects.nextStartWith };
      });
      return items.map((object: objectstorage.models.ObjectSummary): OciObjectRecord => ({ name: object.name, size: object.size ?? 0, timeModified: iso_format(object.timeModified) }));
    },
    async pars_list(region: string, namespace: string, bucket: string): Promise<OciParRecord[]> {
      const items: objectstorage.models.PreauthenticatedRequestSummary[] = await pages_drain(async (page) => {
        const answer: objectstorage.responses.ListPreauthenticatedRequestsResponse = await clients.objects(region).listPreauthenticatedRequests({ namespaceName: namespace, bucketName: bucket, ...page_arg(page) });
        return { items: answer.items, next: answer.opcNextPage };
      });
      return items.map((par: objectstorage.models.PreauthenticatedRequestSummary): OciParRecord => ({
        name: par.name, objectName: par.objectName ?? null, accessType: String(par.accessType), timeExpires: iso_format(par.timeExpires),
      }));
    },
    async object_get(region: string, namespace: string, bucket: string, object: string): Promise<Buffer> {
      const answer: objectstorage.responses.GetObjectResponse = await clients.objects(region).getObject({ namespaceName: namespace, bucketName: bucket, objectName: object });
      return body_read(answer.value);
    },
    async zones_list(region: string, compartmentId: string): Promise<OciResourceRecord[]> {
      const zones: OciResourceRecord[] = [];
      for (const scope of [dns.models.Scope.Global, dns.models.Scope.Private]) {
        const items: dns.models.ZoneSummary[] = await pages_drain(async (page) => {
          const answer: dns.responses.ListZonesResponse = await clients.dns(region).listZones({ compartmentId, scope, ...page_arg(page) });
          return { items: answer.items, next: answer.opcNextPage };
        });
        zones.push(...items.map((zone: dns.models.ZoneSummary): OciResourceRecord => resourceRecord_convert({ ...zone, displayName: zone.name })));
      }
      return zones;
    },
    async zoneRecords_list(region: string, zoneId: string): Promise<OciDnsRecord[]> {
      const items: dns.models.Record[] = await pages_drain(async (page) => {
        const answer: dns.responses.GetZoneRecordsResponse = await clients.dns(region).getZoneRecords({ zoneNameOrId: zoneId, ...page_arg(page) });
        return { items: answer.recordCollection.items, next: answer.opcNextPage };
      });
      return items.map((record: dns.models.Record): OciDnsRecord => ({ domain: record.domain ?? '', rtype: record.rtype ?? '', ttl: record.ttl ?? 0, rdata: record.rdata ?? '' }));
    },
    async search_list(region: string, query: string): Promise<OciSearchRecord[]> {
      const items: resourcesearch.models.ResourceSummary[] = await pages_drain(async (page) => {
        const answer: resourcesearch.responses.SearchResourcesResponse = await clients.search(region).searchResources({
          searchDetails: { type: 'Structured', query } as resourcesearch.models.StructuredSearchDetails, limit: 1000, ...page_arg(page),
        });
        return { items: answer.resourceSummaryCollection.items ?? [], next: answer.opcNextPage };
      });
      return items.map((item: resourcesearch.models.ResourceSummary): OciSearchRecord => ({ resourceType: item.resourceType, lifecycleState: item.lifecycleState ?? '', identifier: item.identifier, displayName: item.displayName ?? '', compartmentId: item.compartmentId, freeformTags: { ...(item.freeformTags ?? {}) } }));
    },
  };
}
