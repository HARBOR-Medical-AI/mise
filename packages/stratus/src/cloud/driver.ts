/**
 * @file The cloud driver: what stratus asks of a cloud, and nothing a cloud
 * asks of stratus.
 *
 * One substrate backend, clouds as drivers (docs/stratus.adoc, D1). The tree,
 * the verbs and the composition are written once against this interface; a
 * cloud implements it (`oci/`), and the fake implements it for tests and the
 * boot proof. Every driver passes the same contract suite
 * (`tests/support/driverContract.ts`).
 *
 * Names are the cloud's own words where the cloud has them (a shape, a
 * limit's service) and neutral where every cloud has the thing (a container,
 * a zone, a region).
 *
 * @module
 */

/** Who the session is, as the cloud knows it. */
export interface CloudIdentity {
  /** The user's name, as the cloud shows it (an IAM user's name). */
  readonly user: string;
  /** The root container's display name: the tenancy, the account, the organization. */
  readonly tenancy: string;
  /** The root container's id. */
  readonly tenancyId: string;
  /** The region the credential names as home. */
  readonly homeRegion: string;
}

/** A container of resources: a compartment, an account, a project, a resource group. */
export interface CloudContainer {
  /** Its display name; the path segment. */
  readonly name: string;
  /** Its id (an OCID). */
  readonly id: string;
  /** The container holding it, or null for the root. */
  readonly parentId: string | null;
  /** Its lifecycle state, lower case (`active`, `deleting`). */
  readonly state: string;
  /** When it was made, ISO 8601. */
  readonly created: string;
  /** What the cloud says it is for. */
  readonly description: string;
  /** Its tags, flattened: freeform as `key`, defined as `namespace.key`. */
  readonly tags: Readonly<Record<string, string>>;
  /** What the cloud calls this kind of container: `compartment`, `project`, `account`. */
  readonly noun: string;
  /** The whole record, for `info.json`. */
  readonly raw: unknown;
}

/** A zone inside a region: an availability domain, an availability zone. */
export interface CloudZone {
  /** Its name, as the cloud's API wants it back (`Uocm:US-ASHBURN-AD-1`). */
  readonly name: string;
}

/** One service limit, at the scope the cloud keeps it. */
export interface CloudLimit {
  /** The service it belongs to (`compute`). */
  readonly service: string;
  /** The limit's name (`standard-e5-core-count`). */
  readonly name: string;
  /** Where it applies. */
  readonly scope: 'global' | 'region' | 'zone';
  /** The zone, when the scope is a zone. */
  readonly zone?: string;
  /** The permitted amount. */
  readonly value: number;
}

/** How much of a limit is spent and left. */
export interface CloudAvailability {
  readonly used: number;
  readonly available: number;
}

/** A machine shape the region offers. */
export interface CloudShape {
  /** The cloud's name for it (`VM.Standard.E5.Flex`). */
  readonly name: string;
  /** A neutral family name (`E5`). */
  readonly family: string;
  /** Whether cores and memory are chosen per instance. */
  readonly flexible: boolean;
  /** vCPU per core unit the cloud bills (OCI: per OCPU). */
  readonly vcpuPerCore: number;
  /** Cores a fixed shape has, or the range a flexible one allows. */
  readonly cores: { readonly min: number; readonly max: number };
  /** Memory in GiB a fixed shape has, or the range a flexible one allows. */
  readonly memoryGib: { readonly min: number; readonly max: number };
  /** The processor, in the cloud's words. */
  readonly processor: string;
  /** GPUs, when the shape has them. */
  readonly gpus: number;
  /** The limit names the shape draws on. */
  readonly quotaNames: ReadonlyArray<string>;
  /** The limit service those names belong to (OCI: `compute`). */
  readonly limitService: string;
  /** The whole record, for `info.json`. */
  readonly raw: unknown;
}

/** What a shape's family costs, per hour, at list price. */
export interface CloudPrice {
  /** The shape it prices. */
  readonly shape: string;
  /** Per vCPU-hour. */
  readonly vcpuHour: number;
  /** Per GiB-hour of memory. */
  readonly gibHour: number;
  /** The currency code. */
  readonly currency: string;
}

/**
 * What storage and load balancing cost, per the price list.
 *
 * @property volumeGibMonth - A GiB of block or boot volume, a month.
 * @property vpuGibMonth - A volume performance unit on a GiB, a month.
 * @property balancerHour - A flexible load balancer, an hour, before bandwidth.
 * @property balancerMbpsHour - A megabit per second of its minimum bandwidth, an hour.
 */
export interface ServicePrices {
  readonly volumeGibMonth: number;
  readonly vpuGibMonth: number;
  readonly balancerHour: number;
  readonly balancerMbpsHour: number;
  readonly currency: string;
}

/**
 * The resource kinds every cloud has, as the tree's folder names
 * (docs/stratus.adoc, D4). Subnets and security groups nest under their
 * network; the rest stand at a container's level.
 */
export type ResourceKind = 'instances' | 'networks' | 'subnets' | 'securitygroups' | 'loadbalancers' | 'volumes' | 'buckets' | 'dns';

/** What every resource row carries: the fields every kind has. */
export interface CloudResource {
  /** Its display name; the path segment. */
  readonly name: string;
  /** Its id (an OCID). */
  readonly id: string;
  /** Its lifecycle state, lower case (`running`, `available`). */
  readonly state: string;
  /** The region it lives in; for a global kind, the region it was asked in. */
  readonly region: string;
  /** When it was made, ISO 8601, or empty when the cloud does not say. */
  readonly created: string;
  /** Its tags, flattened: freeform as `key`, defined as `namespace.key`. */
  readonly tags: Readonly<Record<string, string>>;
  /** The whole record, for `info.json`. */
  readonly raw: unknown;
}

/** A machine. */
export interface CloudInstance extends CloudResource {
  /** The cloud's shape name. */
  readonly shape: string;
  /** The zone it runs in. */
  readonly zone: string;
  /** Its addresses, private first. */
  readonly ips: ReadonlyArray<string>;
  /** Its vCPUs and memory, when the cloud says. */
  readonly vcpus?: number;
  readonly memoryGib?: number;
}

/** A private network: a VCN, a VPC. */
export type CloudNetwork = CloudResource;

/** A subnet, inside a network. */
export interface CloudSubnet extends CloudResource {
  /** The network it belongs to. */
  readonly networkId: string;
}

/** A security group (OCI: a network security group), inside a network. */
export interface CloudSecurityGroup extends CloudResource {
  /** The network it belongs to. */
  readonly networkId: string;
}

/** A load balancer. */
export interface CloudLoadBalancer extends CloudResource {
  /** Its addresses. */
  readonly ips: ReadonlyArray<string>;
  /** The cloud's shape name (`flexible`). */
  readonly shape: string;
  /** A flexible shape's minimum bandwidth, what it bills by. */
  readonly minimumMbps?: number;
}

/** A block volume or a boot volume. */
export interface CloudVolume extends CloudResource {
  /** Its size in GiB. */
  readonly sizeGib: number;
  /** The id of the instance it is attached to, or null. */
  readonly attachedTo: string | null;
  /** Whether it is an instance's boot volume. */
  readonly boot: boolean;
  /** Its performance, in volume performance units per GiB. */
  readonly vpusPerGib?: number;
}

/** An object-storage bucket. */
export type CloudBucket = CloudResource;

/** One object in a bucket. */
export interface CloudObject {
  /** Its name; may hold `/`, which the tree keeps flat. */
  readonly name: string;
  /** Its size in bytes. */
  readonly size: number;
  /** When it last changed, ISO 8601, or empty. */
  readonly modified: string;
}

/** A pre-authenticated link to a bucket or one of its objects. */
export interface CloudLink {
  /** The object it opens, or null for the whole bucket. */
  readonly object: string | null;
  /** Its name. */
  readonly name: string;
  /** What it allows (`ObjectRead`). */
  readonly access: string;
  /** When it stops working, ISO 8601. */
  readonly expires: string;
}

/** A DNS zone. */
export type CloudDnsZone = CloudResource;

/** One DNS record. */
export interface CloudRecord {
  /** The fully qualified name it answers for. */
  readonly domain: string;
  /** Its type (`A`, `CNAME`). */
  readonly type: string;
  /** Its time to live, in seconds. */
  readonly ttl: number;
  /** Its data, as a zone file writes it. */
  readonly data: string;
}

/** How many of each kind a container holds in a region, as a search counts them. */
export type ResourceCounts = Readonly<Partial<Record<ResourceKind, number>>>;

/**
 * A cluster the tenancy holds, found by the tag its build or its
 * adoption put on its stack and its compartment (`mise-cluster=<name>`): what
 * a session lists before it keeps anything of the cluster itself.
 */
export interface FoundCluster {
  /** The tag's value: the cluster's name. */
  readonly name: string;
  /** The stack carrying the tag, or null when only a compartment does. */
  readonly stack: { readonly id: string; readonly state: string; readonly compartmentId: string } | null;
  /** The compartment carrying the tag, or null when only a stack does. */
  readonly compartmentId: string | null;
  readonly region: string;
}

/**
 * A cloud, as stratus sees it. Every method answers for the region it is
 * given: the region is the session's, not the driver's (docs/stratus.adoc,
 * D4), so a driver holds no current region.
 */
export interface CloudDriver {
  /** The cloud's short name; the mount under `/net` (`oci`). */
  readonly cloud: string;
  /** Who the credential is, and its home region. Throws when the credential does not work. */
  identity_get(): Promise<CloudIdentity>;
  /** The root container. */
  root_get(): Promise<CloudContainer>;
  /** The containers directly inside one. */
  containers_list(parentId: string): Promise<CloudContainer[]>;
  /** The regions the tenancy is subscribed to. */
  regions_list(): Promise<string[]>;
  /** The zones of a region. */
  zones_list(region: string): Promise<CloudZone[]>;
  /** The services that have limits. */
  limitServices_list(region: string): Promise<string[]>;
  /** One service's limits in a region, at every scope. */
  limits_list(region: string, service: string): Promise<CloudLimit[]>;
  /** How much of one limit is spent and left; null when the cloud does not say. */
  limitAvailability_get(region: string, service: string, name: string, zone?: string): Promise<CloudAvailability | null>;
  /** The shapes a region offers. */
  shapes_list(region: string): Promise<CloudShape[]>;
  /** List prices for the shapes, per hour. */
  prices_list(): Promise<CloudPrice[]>;
  /** What storage and load balancing cost; null when the list does not say. */
  servicePrices_get(): Promise<ServicePrices | null>;
  /** The machines in a container, in a region. */
  instances_list(containerId: string, region: string): Promise<CloudInstance[]>;
  /** The private networks in a container, in a region. */
  networks_list(containerId: string, region: string): Promise<CloudNetwork[]>;
  /** The subnets in a container, in a region, each naming its network. */
  subnets_list(containerId: string, region: string): Promise<CloudSubnet[]>;
  /** The security groups in a container, in a region, each naming its network. */
  securitygroups_list(containerId: string, region: string): Promise<CloudSecurityGroup[]>;
  /** The load balancers in a container, in a region. */
  loadbalancers_list(containerId: string, region: string): Promise<CloudLoadBalancer[]>;
  /** The block and boot volumes in a container, in a region. */
  volumes_list(containerId: string, region: string): Promise<CloudVolume[]>;
  /** The buckets in a container, in a region. */
  buckets_list(containerId: string, region: string): Promise<CloudBucket[]>;
  /** The DNS zones in a container, public and private. */
  dns_list(containerId: string, region: string): Promise<CloudDnsZone[]>;
  /** A bucket's objects, every page. */
  objects_list(bucket: string, region: string): Promise<CloudObject[]>;
  /** A bucket's pre-authenticated links. */
  links_list(bucket: string, region: string): Promise<CloudLink[]>;
  /** One object's bytes. */
  object_read(bucket: string, object: string, region: string): Promise<Buffer>;
  /** A zone's records. */
  records_list(zoneId: string, region: string): Promise<CloudRecord[]>;
  /** How many of each kind a container holds in a region, in one search; live resources only. */
  resources_search(containerId: string, region: string): Promise<ResourceCounts>;
  /** The clusters the tenancy holds, by the tag on their stacks and compartments, in one search across every container: one per name, sorted; a deleted carrier is left out. */
  clusters_find(tagKey: string, region: string): Promise<FoundCluster[]>;
}
