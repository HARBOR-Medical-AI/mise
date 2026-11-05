/**
 * @file Recorded OCI resource answers, shaped like the live tenancy's
 * `harbor-oci` compartment on 2026-10-21 with every identifier scrubbed:
 * three control-plane nodes, a VCN with three subnets and three NSGs, three
 * load balancers, block volumes (some terminated) and boot volumes, a bucket
 * holding the discovery ISO, and DNS zones public and private.
 */
import type {
  OciAttachmentRecord, OciDnsRecord, OciInstanceRecord, OciLoadBalancerRecord, OciObjectRecord, OciParRecord, OciResourceApi, OciResourceRecord,
  OciSearchRecord, OciVcnMemberRecord, OciVnicAttachmentRecord, OciVnicRecord, OciVolumeRecord,
} from '../../src/cloud/oci/resourceApi.js';

/** The compartment the recorded resources live in. */
export const HARBOR_ID: string = 'ocid1.compartment.oc1..harbor';
/** The recorded availability domains. */
export const RECORDED_ZONES: ReadonlyArray<string> = ['disG:US-ASHBURN-AD-1', 'disG:US-ASHBURN-AD-2', 'disG:US-ASHBURN-AD-3'];

const tags = { freeformTags: { 'openshift-resource': 'harbor' }, definedTags: { 'Oracle-Tags': { CreatedBy: 'rudolph' } } };
const record = (id: string, displayName: string, lifecycleState: string): OciResourceRecord => ({
  id, displayName, lifecycleState, timeCreated: '2026-10-06T14:00:00.000Z', ...tags, raw: { id, displayName, lifecycleState },
});
const VCN: string = 'ocid1.vcn.oc1.iad.harbor';

const INSTANCES: OciInstanceRecord[] = [3, 1, 2].map((n: number): OciInstanceRecord => ({
  ...record(`ocid1.instance.oc1.iad.cp000${n}`, `harbor-cp-${n}`, 'RUNNING'), shape: 'VM.Standard.E5.Flex', availabilityDomain: RECORDED_ZONES[n - 1] as string,
  imageId: 'ocid1.image.oc1.iad.rhcos',
}));
const VNIC_ATTACHMENTS: OciVnicAttachmentRecord[] = [
  ...[1, 2, 3].map((n: number): OciVnicAttachmentRecord => ({ instanceId: `ocid1.instance.oc1.iad.cp000${n}`, vnicId: `ocid1.vnic.oc1.iad.vnic0${n}`, lifecycleState: 'ATTACHED' })),
  { instanceId: 'ocid1.instance.oc1.iad.cp0001', vnicId: 'ocid1.vnic.oc1.iad.gone00', lifecycleState: 'DETACHED' },
];
const VNICS: Record<string, OciVnicRecord> = {
  'ocid1.vnic.oc1.iad.vnic01': { privateIp: '10.0.16.11', publicIp: null },
  'ocid1.vnic.oc1.iad.vnic02': { privateIp: '10.0.16.12', publicIp: '129.0.0.12', nsgIds: ['ocid1.networksecuritygroup.oc1.iad.nsg001'] },
  'ocid1.vnic.oc1.iad.vnic03': { privateIp: '10.0.16.13', publicIp: null },
};
const SUBNETS: OciVcnMemberRecord[] = ['public', 'private_ocp', 'private_bare_metal'].map((name: string, n: number): OciVcnMemberRecord => ({ ...record(`ocid1.subnet.oc1.iad.sub00${n}`, name, 'AVAILABLE'), vcnId: VCN }));
const NSGS: OciVcnMemberRecord[] = ['cluster-lb-nsg', 'cluster-controlplane-nsg', 'cluster-compute-nsg'].map((name: string, n: number): OciVcnMemberRecord => ({ ...record(`ocid1.networksecuritygroup.oc1.iad.nsg00${n}`, name, 'AVAILABLE'), vcnId: VCN }));
const BALANCERS: OciLoadBalancerRecord[] = [
  { ...record('ocid1.loadbalancer.oc1.iad.lbapi0', 'harbor-openshift_api_lb', 'ACTIVE'), ipAddresses: ['129.0.0.10'], shapeName: 'flexible' },
  { ...record('ocid1.loadbalancer.oc1.iad.lbint0', 'harbor-openshift_api_int_lb', 'ACTIVE'), ipAddresses: ['10.0.32.5'], shapeName: 'flexible' },
  { ...record('ocid1.loadbalancer.oc1.iad.lbapp0', 'harbor-openshift_apps_lb', 'ACTIVE'), ipAddresses: ['129.0.0.11'], shapeName: 'flexible' },
];
const VOLUMES: OciVolumeRecord[] = [
  { ...record('ocid1.volume.oc1.iad.csi001', 'csi-9d5b2f0a', 'AVAILABLE'), sizeInGBs: 50, availabilityDomain: RECORDED_ZONES[2] as string },
  { ...record('ocid1.volume.oc1.iad.csi002', 'csi-52676dc4', 'TERMINATED'), sizeInGBs: 50, availabilityDomain: RECORDED_ZONES[0] as string },
];
const BOOT_VOLUMES: OciVolumeRecord[] = [1, 2, 3].map((n: number): OciVolumeRecord => ({
  ...record(`ocid1.bootvolume.oc1.iad.boot0${n}`, `harbor-cp-${n} (Boot Volume)`, 'AVAILABLE'), sizeInGBs: 200, availabilityDomain: RECORDED_ZONES[n - 1] as string,
}));
const VOLUME_ATTACHMENTS: OciAttachmentRecord[] = [
  { volumeId: 'ocid1.volume.oc1.iad.csi001', instanceId: 'ocid1.instance.oc1.iad.cp0003', lifecycleState: 'ATTACHED' },
  { volumeId: 'ocid1.volume.oc1.iad.csi002', instanceId: 'ocid1.instance.oc1.iad.cp0001', lifecycleState: 'DETACHED' },
];
const OBJECTS: OciObjectRecord[] = [{ name: 'harbor-discovery.iso', size: 138_596_352, timeModified: '2026-10-06T14:10:00.000Z' }];
const PARS: OciParRecord[] = [{ name: 'harbor-discovery-iso', objectName: 'harbor-discovery.iso', accessType: 'ObjectRead', timeExpires: '2026-11-06T14:10:00.000Z' }];
const PUBLIC_ZONE: OciResourceRecord = record('ocid1.dns-zone.oc1..public', 'oci.chrisproject.org', 'ACTIVE');
const PRIVATE_ZONE: OciResourceRecord = record('ocid1.dns-zone.oc1.iad.private', 'privateocp.openshiftvcn.oraclevcn.com', 'ACTIVE');
const RECORDS: Record<string, OciDnsRecord[]> = {
  [PUBLIC_ZONE.id]: [
    { domain: 'oci.chrisproject.org', rtype: 'SOA', ttl: 300, rdata: 'ns1.p201.dns.oraclecloud.net. hostmaster.oracle.com. 2 3600 3600 3600 300' },
    { domain: 'oci.chrisproject.org', rtype: 'NS', ttl: 86400, rdata: 'ns1.p201.dns.oraclecloud.net.' },
    { domain: 'api.harbor.oci.chrisproject.org', rtype: 'A', ttl: 300, rdata: '129.0.0.10' },
    { domain: '*.apps.harbor.oci.chrisproject.org', rtype: 'A', ttl: 300, rdata: '129.0.0.11' },
  ],
  [PRIVATE_ZONE.id]: [{ domain: 'harbor-cp-1.privateocp.openshiftvcn.oraclevcn.com', rtype: 'A', ttl: 300, rdata: '10.0.16.11' }],
};
/** One search hit, in the compartment every fixture stands in. */
const hit = (resourceType: string, lifecycleState: string): OciSearchRecord => ({ resourceType, lifecycleState, identifier: `ocid1.${resourceType.toLowerCase()}.oc1..x`, displayName: resourceType, compartmentId: HARBOR_ID, freeformTags: {} });

const SEARCH: OciSearchRecord[] = [
  ...[1, 2, 3].map((): OciSearchRecord => (hit('Instance', 'RUNNING'))),
  hit('Vcn', 'AVAILABLE'),
  ...[1, 2, 3].map((): OciSearchRecord => (hit('Subnet', 'AVAILABLE'))),
  ...[1, 2, 3].map((): OciSearchRecord => (hit('NetworkSecurityGroup', 'AVAILABLE'))),
  ...[1, 2, 3].map((): OciSearchRecord => (hit('LoadBalancer', 'ACTIVE'))),
  hit('Volume', 'AVAILABLE'),
  hit('Volume', 'TERMINATED'),
  ...[1, 2, 3].map((): OciSearchRecord => (hit('BootVolume', 'AVAILABLE'))),
  hit('Bucket', 'ACTIVE'),
  hit('CustomerDnsZone', 'ACTIVE'),
  hit('CustomerDnsZone', 'ACTIVE'),
  hit('PrivateIp', 'AVAILABLE'),
];

/**
 * The recorded resource calls: answers for `harbor-oci`, nothing elsewhere.
 *
 * @param seen - Each call's name and arguments, appended as it is made.
 * @returns The calls.
 */
export function recordedResourceApi_make(seen: string[] = []): OciResourceApi {
  const inHarbor = <T>(compartmentId: string, items: T[]): T[] => (compartmentId === HARBOR_ID ? items : []);
  return {
    async instances_list(_region, compartmentId) { seen.push('instances_list'); return inHarbor(compartmentId, INSTANCES); },
    async vnicAttachments_list(_region, compartmentId) { return inHarbor(compartmentId, VNIC_ATTACHMENTS); },
    async vnic_get(_region, vnicId) { seen.push(`vnic_get ${vnicId}`); return VNICS[vnicId] ?? { privateIp: null, publicIp: null }; },
    async image_get(_region, imageId) {
      seen.push(`image_get ${imageId}`);
      return imageId === 'ocid1.image.oc1.iad.ubuntu' ? { operatingSystem: 'Canonical Ubuntu', operatingSystemVersion: '26.04' } : { operatingSystem: 'Red Hat Enterprise Linux CoreOS', operatingSystemVersion: '4.22' };
    },
    async nsgIngress_list(_region, nsgId) {
      return nsgId === 'ocid1.networksecuritygroup.oc1.iad.nsg001' ? [
        { source: '0.0.0.0/0', protocol: '6', ports: { min: 443, max: 443 } },
        { source: '0.0.0.0/0', protocol: '6', ports: { min: 80, max: 80 } },
        { source: '10.0.0.0/16', protocol: '6', ports: { min: 22, max: 22 } },
        { source: '0.0.0.0/0', protocol: '17', ports: null },
      ] : [];
    },
    async backupPolicy_read(_region, volumeId) { return volumeId === 'ocid1.volume.oc1.iad.csi001' ? { name: 'harbor-daily', periods: ['ONE_DAY'] } : null; },
    async vcns_list(_region, compartmentId) { return inHarbor(compartmentId, [{ ...record(VCN, 'harbor', 'AVAILABLE'), cidrBlocks: ['10.0.0.0/16'] }]); },
    async subnets_list(_region, compartmentId) { return inHarbor(compartmentId, SUBNETS); },
    async nsgs_list(_region, compartmentId) { return inHarbor(compartmentId, NSGS); },
    async loadBalancers_list(_region, compartmentId) { return inHarbor(compartmentId, BALANCERS); },
    async volumes_list(_region, compartmentId) { return inHarbor(compartmentId, VOLUMES); },
    async bootVolumes_list(_region, compartmentId, availabilityDomain) {
      seen.push(`bootVolumes_list ${availabilityDomain}`);
      return inHarbor(compartmentId, BOOT_VOLUMES.filter((volume: OciVolumeRecord): boolean => volume.availabilityDomain === availabilityDomain));
    },
    async volumeAttachments_list(_region, compartmentId) { return inHarbor(compartmentId, VOLUME_ATTACHMENTS); },
    async bootVolumeAttachments_list(_region, compartmentId, availabilityDomain) {
      const n: number = RECORDED_ZONES.indexOf(availabilityDomain) + 1;
      return inHarbor(compartmentId, [{ volumeId: `ocid1.bootvolume.oc1.iad.boot0${n}`, instanceId: `ocid1.instance.oc1.iad.cp000${n}`, lifecycleState: 'ATTACHED' }]);
    },
    async namespace_get() { seen.push('namespace_get'); return 'scrubbedns'; },
    async buckets_list(_region, _namespace, compartmentId) { return inHarbor(compartmentId, [record('scrubbedns/harbor-oci-iso', 'harbor-oci-iso', 'ACTIVE')]); },
    async objects_list(_region, namespace, bucket) { seen.push(`objects_list ${namespace}/${bucket}`); return bucket === 'harbor-oci-iso' ? OBJECTS : []; },
    async pars_list(_region, _namespace, bucket) { return bucket === 'harbor-oci-iso' ? PARS : []; },
    async object_get(_region, namespace, bucket, object) { seen.push(`object_get ${namespace}/${bucket}/${object}`); return Buffer.from('iso bytes'); },
    // A zone a compartment holds may answer in both scopes; the driver lists it once.
    async zones_list(_region, compartmentId) { return inHarbor(compartmentId, [PUBLIC_ZONE, PRIVATE_ZONE, PRIVATE_ZONE]); },
    async zoneRecords_list(_region, zoneId) { return RECORDS[zoneId] ?? []; },
    async search_list(_region, query) { seen.push(`search_list ${query}`); return query.includes(HARBOR_ID) ? SEARCH : []; },
  };
}
