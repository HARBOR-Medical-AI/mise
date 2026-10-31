/**
 * @file The OCI calls a build makes beside Resource Manager: the checks before
 * it (tenancy, compartment, attribution tag, load-balancer room, the DNS
 * zone's name servers), the discovery image's bucket, object and link, and
 * the cluster's DNS records. The wire only; the builder decides what to ask
 * and its tests replay recorded answers. Only this folder imports `oci-*`.
 *
 * @module
 */
import type { Readable } from 'node:stream';
import * as common from 'oci-common';
import * as core from 'oci-core';
import * as dns from 'oci-dns';
import * as identity from 'oci-identity';
import * as limits from 'oci-limits';
import * as objectstorage from 'oci-objectstorage';
import { ociTags_flatten } from './driver.js';
import { notFound } from './errors.js';

/** A pre-authenticated link to an object. */
export interface OciLink {
  readonly id: string;
  /** The URL; a secret. */
  readonly url: string;
}

/** The build's calls, in one region. */
export interface OciBuildApi {
  /** The tenancy's id and name: the credential works. */
  tenancy_get(): Promise<{ id: string; name: string }>;
  /** A compartment's lifecycle state. */
  compartmentState_get(compartmentId: string): Promise<string>;
  /** The compartment a DNS zone of a name lives in, anywhere in the tenancy, or null. */
  zoneCompartment_find(zone: string): Promise<string | null>;
  /** The names of the DNS zones anywhere in the tenancy, sorted. */
  zoneNames_list(): Promise<string[]>;
  /** The compartment a tag namespace of a name lives in, anywhere in the tenancy, or null. Its name is the tenancy's, not a compartment's. */
  tagNamespaceCompartment_find(namespace: string): Promise<string | null>;
  /** An active compartment of a name directly under a parent, made (with the tags given) when there is none; its id. */
  compartmentChild_ensure(parentId: string, name: string, description: string, tags: Record<string, string>): Promise<{ id: string; made: boolean }>;
  /** Whether a tag namespace holds a tag, in a compartment. */
  tag_exists(compartmentId: string, namespace: string, tag: string): Promise<boolean>;
  /** How many of a limit are free, region-wide. */
  limitFree_get(service: string, limit: string): Promise<number | null>;
  /** A DNS zone's name servers, as OCI serves it. */
  zoneNameservers_get(zone: string, compartmentId: string): Promise<string[]>;
  /** Makes a private bucket unless it is there. */
  bucket_ensure(bucket: string, compartmentId: string): Promise<void>;
  /** Puts an object. */
  object_put(bucket: string, object: string, body: Readable | Buffer, length?: number): Promise<void>;
  /** Removes an object; one already gone is no error. */
  object_delete(bucket: string, object: string): Promise<void>;
  /** Makes a read link to an object, until a time. */
  link_create(bucket: string, object: string, name: string, expires: Date): Promise<OciLink>;
  /** Removes a link; one already gone is no error. */
  link_delete(bucket: string, linkId: string): Promise<void>;
  /** Replaces an A record set. */
  record_upsert(zone: string, name: string, address: string, compartmentId: string): Promise<void>;
  /** Removes an A record set; one already gone is no error. */
  record_delete(zone: string, name: string, compartmentId: string): Promise<void>;
  /** Removes a block volume; one already gone is no error. */
  volume_delete(volumeId: string): Promise<void>;
  /** The block volumes a compartment holds that are not gone: id, name and flattened tags. */
  volumes_list(compartmentId: string): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>>;
  /** A compartment's name, its parent's name (null under the tenancy root) and its freeform tags. */
  compartment_describe(compartmentId: string): Promise<{ name: string; parentName: string | null; tags: Record<string, string> }>;
  /** Takes one freeform tag off a compartment; one not carried is no error. */
  compartment_tagRemove(compartmentId: string, key: string): Promise<void>;
  /** Puts one freeform tag on a compartment, keeping the others. */
  compartment_tagSet(compartmentId: string, key: string, value: string): Promise<void>;
  /** Removes a compartment, which must hold nothing; the cloud refuses one that does. */
  compartment_delete(compartmentId: string): Promise<void>;
  /** Removes a bucket of a name and what it holds (objects, links), when it is in the compartment given; answers whether it was there. */
  bucket_remove(bucket: string, compartmentId: string): Promise<boolean>;
}

/** How the calls authenticate, and where. */
export interface OciBuildApiOptions {
  readonly configFile?: string;
  readonly profile?: string;
  readonly region: string;
}


/**
 * The build's calls over the SDK.
 *
 * @param options - The profile and the region.
 * @returns The calls.
 */
export function ociBuildApi_make(options: OciBuildApiOptions): OciBuildApi {
  const provider: common.ConfigFileAuthenticationDetailsProvider = new common.ConfigFileAuthenticationDetailsProvider(options.configFile, options.profile);
  const regional = <T extends { regionId?: string }>(client: T): T => { client.regionId = options.region; return client; };
  const ident: identity.IdentityClient = regional(new identity.IdentityClient({ authenticationDetailsProvider: provider }));
  const limit: limits.LimitsClient = regional(new limits.LimitsClient({ authenticationDetailsProvider: provider }));
  const dnsClient: dns.DnsClient = regional(new dns.DnsClient({ authenticationDetailsProvider: provider }));
  const store: objectstorage.ObjectStorageClient = regional(new objectstorage.ObjectStorageClient({ authenticationDetailsProvider: provider }));
  const blocks: core.BlockstorageClient = regional(new core.BlockstorageClient({ authenticationDetailsProvider: provider }));
  const tenancyId: string = provider.getTenantId();
  let namespace: string | null = null;
  // The root and every active compartment beneath it: where a shared thing
  // (the zone, the tag namespace) may live.
  const compartments_all = async (): Promise<string[]> => {
    const beneath = (await ident.listCompartments({ compartmentId: tenancyId, compartmentIdInSubtree: true, lifecycleState: identity.models.Compartment.LifecycleState.Active })).items;
    return [tenancyId, ...beneath.map((compartment): string => compartment.id).filter((id): id is string => typeof id === 'string')];
  };
  const namespace_get = async (): Promise<string> => {
    if (namespace === null) namespace = (await store.getNamespace({ compartmentId: tenancyId })).value;
    return namespace;
  };
  return {
    async tenancy_get() {
      const tenancy = (await ident.getTenancy({ tenancyId })).tenancy;
      return { id: tenancy.id ?? tenancyId, name: tenancy.name ?? '' };
    },
    async compartmentState_get(compartmentId) {
      return String((await ident.getCompartment({ compartmentId })).compartment.lifecycleState);
    },
    async zoneCompartment_find(zone) {
      for (const compartmentId of await compartments_all()) {
        const zones = (await dnsClient.listZones({ compartmentId, name: zone })).items;
        if (zones.length > 0) return compartmentId;
      }
      return null;
    },
    async zoneNames_list() {
      const names: Set<string> = new Set();
      for (const compartmentId of await compartments_all()) {
        for (const zone of (await dnsClient.listZones({ compartmentId })).items) if (typeof zone.name === 'string') names.add(zone.name);
      }
      return [...names].sort();
    },
    async tagNamespaceCompartment_find(namespaceName) {
      for (const compartmentId of await compartments_all()) {
        const spaces = (await ident.listTagNamespaces({ compartmentId })).items;
        if (spaces.some((space): boolean => space.name === namespaceName)) return compartmentId;
      }
      return null;
    },
    async compartmentChild_ensure(parentId, name, description, tags) {
      const children = (await ident.listCompartments({ compartmentId: parentId, lifecycleState: identity.models.Compartment.LifecycleState.Active })).items;
      const found = children.find((child): boolean => child.name === name);
      if (found?.id !== undefined) return { id: found.id, made: false };
      const made = (await ident.createCompartment({ createCompartmentDetails: { compartmentId: parentId, name, description, freeformTags: tags } })).compartment;
      return { id: made.id ?? '', made: true };
    },
    async tag_exists(compartmentId, namespaceName, tag) {
      const spaces = (await ident.listTagNamespaces({ compartmentId, lifecycleState: identity.models.TagNamespace.LifecycleState.Active })).items;
      const space = spaces.find((entry): boolean => entry.name === namespaceName);
      if (space === undefined || space.id === undefined) return false;
      try {
        await ident.getTag({ tagNamespaceId: space.id, tagName: tag });
        return true;
      } catch (error: unknown) {
        if (notFound(error)) return false;
        throw error;
      }
    },
    async limitFree_get(service, name) {
      const answer = await limit.getResourceAvailability({ serviceName: service, limitName: name, compartmentId: tenancyId });
      return answer.resourceAvailability.available ?? null;
    },
    async zoneNameservers_get(zone, compartmentId) {
      const answer = await dnsClient.getZone({ zoneNameOrId: zone, compartmentId });
      return (answer.zone.nameservers ?? []).map((server): string => server.hostname.replace(/\.$/, '')).sort();
    },
    async bucket_ensure(bucket, compartmentId) {
      const namespaceName: string = await namespace_get();
      try {
        await store.getBucket({ namespaceName, bucketName: bucket });
      } catch (error: unknown) {
        if (!notFound(error)) throw error;
        await store.createBucket({ namespaceName, createBucketDetails: { name: bucket, compartmentId, publicAccessType: objectstorage.models.CreateBucketDetails.PublicAccessType.NoPublicAccess, storageTier: objectstorage.models.CreateBucketDetails.StorageTier.Standard } });
      }
    },
    async object_put(bucket, object, body, length) {
      await store.putObject({ namespaceName: await namespace_get(), bucketName: bucket, objectName: object, putObjectBody: body, ...(length !== undefined ? { contentLength: length } : {}) });
    },
    async object_delete(bucket, object) {
      try {
        await store.deleteObject({ namespaceName: await namespace_get(), bucketName: bucket, objectName: object });
      } catch (error: unknown) {
        if (!notFound(error)) throw error;
      }
    },
    async link_create(bucket, object, name, expires) {
      const answer = await store.createPreauthenticatedRequest({
        namespaceName: await namespace_get(),
        bucketName: bucket,
        createPreauthenticatedRequestDetails: { name, objectName: object, accessType: objectstorage.models.CreatePreauthenticatedRequestDetails.AccessType.ObjectRead, timeExpires: expires },
      });
      const link = answer.preauthenticatedRequest;
      return { id: link.id, url: link.fullPath ?? `https://objectstorage.${options.region}.oraclecloud.com${link.accessUri}` };
    },
    async link_delete(bucket, linkId) {
      try {
        await store.deletePreauthenticatedRequest({ namespaceName: await namespace_get(), bucketName: bucket, parId: linkId });
      } catch (error: unknown) {
        if (!notFound(error)) throw error;
      }
    },
    async record_upsert(zone, name, address, compartmentId) {
      await dnsClient.updateRRSet({ zoneNameOrId: zone, domain: name, rtype: 'A', compartmentId, updateRRSetDetails: { items: [{ domain: name, rtype: 'A', rdata: address, ttl: 300 }] } });
    },
    async volume_delete(volumeId) {
      try {
        await blocks.deleteVolume({ volumeId });
      } catch (error: unknown) {
        if (!notFound(error)) throw error;
      }
    },
    async record_delete(zone, name, compartmentId) {
      try {
        await dnsClient.deleteRRSet({ zoneNameOrId: zone, domain: name, rtype: 'A', compartmentId });
      } catch (error: unknown) {
        if (!notFound(error)) throw error;
      }
    },
    async volumes_list(compartmentId) {
      const volumes: Array<{ id: string; name: string; tags: Record<string, string> }> = [];
      for await (const volume of blocks.listAllVolumes({ compartmentId })) {
        const state: string = String(volume.lifecycleState ?? '').toLowerCase();
        if (state === 'terminated' || state === 'terminating' || typeof volume.id !== 'string') continue;
        volumes.push({ id: volume.id, name: volume.displayName ?? volume.id, tags: ociTags_flatten(volume.freeformTags ?? {}, (volume.definedTags ?? {}) as Record<string, Record<string, unknown>>) });
      }
      return volumes;
    },
    async compartment_describe(compartmentId) {
      const compartment = (await ident.getCompartment({ compartmentId })).compartment;
      const parentId: string | undefined = compartment.compartmentId;
      const parentName: string | null = parentId === undefined || parentId === tenancyId ? null : (await ident.getCompartment({ compartmentId: parentId })).compartment.name ?? null;
      return { name: compartment.name ?? '', parentName, tags: { ...(compartment.freeformTags ?? {}) } };
    },
    async compartment_tagRemove(compartmentId, key) {
      const compartment = (await ident.getCompartment({ compartmentId })).compartment;
      const tags: Record<string, string> = { ...(compartment.freeformTags ?? {}) };
      if (!(key in tags)) return;
      delete tags[key];
      await ident.updateCompartment({ compartmentId, updateCompartmentDetails: { freeformTags: tags } });
    },
    async compartment_tagSet(compartmentId, key, value) {
      const compartment = (await ident.getCompartment({ compartmentId })).compartment;
      const tags: Record<string, string> = { ...(compartment.freeformTags ?? {}) };
      if (tags[key] === value) return;
      tags[key] = value;
      await ident.updateCompartment({ compartmentId, updateCompartmentDetails: { freeformTags: tags } });
    },
    async compartment_delete(compartmentId) {
      try {
        await ident.deleteCompartment({ compartmentId });
      } catch (error: unknown) {
        if (!notFound(error)) throw error;
      }
    },
    async bucket_remove(bucket, compartmentId) {
      const namespaceName: string = await namespace_get();
      let kept: objectstorage.models.Bucket;
      try {
        kept = (await store.getBucket({ namespaceName, bucketName: bucket })).bucket;
      } catch (error: unknown) {
        if (notFound(error)) return false;
        throw error;
      }
      if (kept.compartmentId !== compartmentId) return false;
      // Every object, then every link, then the bucket: the cloud refuses a bucket holding either.
      let start: string | undefined;
      do {
        const page = (await store.listObjects({ namespaceName, bucketName: bucket, fields: 'name', ...(start !== undefined ? { start } : {}) })).listObjects;
        for (const object of page.objects ?? []) if (typeof object.name === 'string') await store.deleteObject({ namespaceName, bucketName: bucket, objectName: object.name });
        start = page.nextStartWith || undefined;
      } while (start !== undefined);
      for (const link of (await store.listPreauthenticatedRequests({ namespaceName, bucketName: bucket })).items ?? []) {
        if (typeof link.id === 'string') await store.deletePreauthenticatedRequest({ namespaceName, bucketName: bucket, parId: link.id });
      }
      await store.deleteBucket({ namespaceName, bucketName: bucket });
      return true;
    },
  };
}
