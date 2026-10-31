/**
 * @file The OCI API as the driver uses it: a few calls, plain answers.
 *
 * The SDK's clients sit behind this interface so the driver can be tested
 * against recorded answers (`tests/fixtures/oci/*.json`) and the SDK is
 * loaded only here. Every call pages to the end; the driver never sees a
 * page token. Only this folder may import an `oci-*` package
 * (`lint:stratus-deps`).
 *
 * @module
 */
import * as common from 'oci-common';
import * as identity from 'oci-identity';
import * as limits from 'oci-limits';
import * as core from 'oci-core';
import { ociResourceApi_make, type OciResourceApi } from './resourceApi.js';

/** What the SDK says about the credential's tenancy. */
export interface OciTenancyRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly homeRegionKey: string;
  readonly freeformTags: Readonly<Record<string, string>>;
  readonly definedTags: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** What the SDK says about a compartment. */
export interface OciCompartmentRecord {
  readonly id: string;
  readonly compartmentId: string;
  readonly name: string;
  readonly description: string;
  readonly lifecycleState: string;
  readonly timeCreated: string;
  readonly freeformTags: Readonly<Record<string, string>>;
  readonly definedTags: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** One limit value, as the Limits API lists it. */
export interface OciLimitValueRecord {
  readonly name: string;
  readonly scopeType: string;
  readonly availabilityDomain: string | null;
  readonly value: number;
}

/** A shape, as Compute lists it. */
export interface OciShapeRecord {
  readonly shape: string;
  readonly processorDescription: string;
  readonly ocpus: number | null;
  readonly memoryInGBs: number | null;
  readonly gpus: number;
  readonly isFlexible: boolean;
  readonly ocpuOptions: { readonly min: number; readonly max: number } | null;
  readonly memoryOptions: { readonly minInGBs: number; readonly maxInGBs: number } | null;
  readonly quotaNames: ReadonlyArray<string>;
  readonly raw: unknown;
}

/** The calls the driver makes: the tenancy's facts here, its resources in `resourceApi.ts`. */
export interface OciApi extends OciResourceApi {
  /** The credential's tenancy id, user id and home region, read from the profile without a call. */
  credential_get(): { tenancyId: string; userId: string; region: string };
  tenancy_get(tenancyId: string): Promise<OciTenancyRecord>;
  userName_get(userId: string): Promise<string>;
  compartments_list(parentId: string): Promise<OciCompartmentRecord[]>;
  regionSubscriptions_list(tenancyId: string): Promise<string[]>;
  availabilityDomains_list(region: string, tenancyId: string): Promise<string[]>;
  limitServices_list(region: string, tenancyId: string): Promise<string[]>;
  limitValues_list(region: string, tenancyId: string, service: string): Promise<OciLimitValueRecord[]>;
  resourceAvailability_get(region: string, tenancyId: string, service: string, limitName: string, availabilityDomain?: string): Promise<{ used: number; available: number } | null>;
  shapes_list(region: string, tenancyId: string): Promise<OciShapeRecord[]>;
}

/** How the real API is reached. */
export interface OciApiOptions {
  /** The profile's file; the SDK's default (`~/.oci/config`) when absent. */
  readonly configFile?: string;
  /** The profile; `DEFAULT` when absent. */
  readonly profile?: string;
}

/** A page of items and the token for the next, as every OCI list call answers. */
interface Page<T> {
  readonly items: T[];
  readonly opcNextPage?: string;
}

/**
 * Every item of a paged list call.
 *
 * @param page_get - Fetches one page, given the token of the previous (undefined first).
 * @returns Every item, in order.
 */
async function pages_drain<T>(page_get: (page: string | undefined) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  let token: string | undefined = undefined;
  do {
    const page: Page<T> = await page_get(token);
    items.push(...page.items);
    token = page.opcNextPage === '' ? undefined : page.opcNextPage;
  } while (token !== undefined);
  return items;
}

/** Tags as the SDK gives them, with absent ones as empty. */
function tags_build(freeform: Record<string, string> | undefined, defined: Record<string, Record<string, unknown>> | undefined): Pick<OciCompartmentRecord, 'freeformTags' | 'definedTags'> {
  return { freeformTags: freeform ?? {}, definedTags: defined ?? {} };
}

/**
 * The real API over the SDK, authenticated by an API-key profile.
 *
 * @param options - The profile.
 * @returns The API.
 */
export function ociApi_make(options: OciApiOptions = {}): OciApi {
  const provider: common.ConfigFileAuthenticationDetailsProvider = new common.ConfigFileAuthenticationDetailsProvider(options.configFile, options.profile);
  const clients: Map<string, identity.IdentityClient | limits.LimitsClient | core.ComputeClient> = new Map();
  const identityClient_resolve = (region: string): identity.IdentityClient => {
    const key: string = `identity/${region}`;
    let client: identity.IdentityClient | undefined = clients.get(key) as identity.IdentityClient | undefined;
    if (client === undefined) {
      client = new identity.IdentityClient({ authenticationDetailsProvider: provider });
      client.regionId = region;
      clients.set(key, client);
    }
    return client;
  };
  const limitsClient_resolve = (region: string): limits.LimitsClient => {
    const key: string = `limits/${region}`;
    let client: limits.LimitsClient | undefined = clients.get(key) as limits.LimitsClient | undefined;
    if (client === undefined) {
      client = new limits.LimitsClient({ authenticationDetailsProvider: provider });
      client.regionId = region;
      clients.set(key, client);
    }
    return client;
  };
  const computeClient_resolve = (region: string): core.ComputeClient => {
    const key: string = `compute/${region}`;
    let client: core.ComputeClient | undefined = clients.get(key) as core.ComputeClient | undefined;
    if (client === undefined) {
      client = new core.ComputeClient({ authenticationDetailsProvider: provider });
      client.regionId = region;
      clients.set(key, client);
    }
    return client;
  };
  const homeRegion: string = provider.getRegion().regionId;

  return {
    ...ociResourceApi_make(provider),
    credential_get: (): { tenancyId: string; userId: string; region: string } => ({
      tenancyId: provider.getTenantId(),
      userId: provider.getUser(),
      region: homeRegion,
    }),
    async tenancy_get(tenancyId: string): Promise<OciTenancyRecord> {
      const answer: identity.responses.GetTenancyResponse = await identityClient_resolve(homeRegion).getTenancy({ tenancyId });
      const tenancy: identity.models.Tenancy = answer.tenancy;
      return {
        id: tenancy.id ?? tenancyId,
        name: tenancy.name ?? '',
        description: tenancy.description ?? '',
        homeRegionKey: tenancy.homeRegionKey ?? '',
        ...tags_build(tenancy.freeformTags, tenancy.definedTags),
      };
    },
    async userName_get(userId: string): Promise<string> {
      const answer: identity.responses.GetUserResponse = await identityClient_resolve(homeRegion).getUser({ userId });
      return answer.user.name;
    },
    async compartments_list(parentId: string): Promise<OciCompartmentRecord[]> {
      const client: identity.IdentityClient = identityClient_resolve(homeRegion);
      const items: identity.models.Compartment[] = await pages_drain(async (page: string | undefined): Promise<Page<identity.models.Compartment>> => {
        const answer: identity.responses.ListCompartmentsResponse = await client.listCompartments({
          compartmentId: parentId,
          accessLevel: identity.requests.ListCompartmentsRequest.AccessLevel.Accessible,
          sortBy: identity.requests.ListCompartmentsRequest.SortBy.Name,
          sortOrder: identity.requests.ListCompartmentsRequest.SortOrder.Asc,
          ...(page !== undefined ? { page } : {}),
        });
        return { items: answer.items, opcNextPage: answer.opcNextPage };
      });
      return items.map((compartment: identity.models.Compartment): OciCompartmentRecord => ({
        id: compartment.id,
        compartmentId: compartment.compartmentId,
        name: compartment.name,
        description: compartment.description,
        lifecycleState: String(compartment.lifecycleState),
        timeCreated: new Date(compartment.timeCreated).toISOString(),
        ...tags_build(compartment.freeformTags, compartment.definedTags),
      }));
    },
    async regionSubscriptions_list(tenancyId: string): Promise<string[]> {
      const answer: identity.responses.ListRegionSubscriptionsResponse = await identityClient_resolve(homeRegion).listRegionSubscriptions({ tenancyId });
      return answer.items
        .filter((subscription: identity.models.RegionSubscription): boolean => String(subscription.status) === 'READY')
        .map((subscription: identity.models.RegionSubscription): string => subscription.regionName)
        .sort();
    },
    async availabilityDomains_list(region: string, tenancyId: string): Promise<string[]> {
      const answer: identity.responses.ListAvailabilityDomainsResponse = await identityClient_resolve(region).listAvailabilityDomains({ compartmentId: tenancyId });
      return answer.items.map((cluster: identity.models.AvailabilityDomain): string => cluster.name ?? '').filter((name: string): boolean => name !== '').sort();
    },
    async limitServices_list(region: string, tenancyId: string): Promise<string[]> {
      const client: limits.LimitsClient = limitsClient_resolve(region);
      const items: limits.models.ServiceSummary[] = await pages_drain(async (page: string | undefined): Promise<Page<limits.models.ServiceSummary>> => {
        const answer: limits.responses.ListServicesResponse = await client.listServices({ compartmentId: tenancyId, ...(page !== undefined ? { page } : {}) });
        return { items: answer.items, opcNextPage: answer.opcNextPage };
      });
      return items.map((service: limits.models.ServiceSummary): string => service.name ?? '').filter((name: string): boolean => name !== '').sort();
    },
    async limitValues_list(region: string, tenancyId: string, service: string): Promise<OciLimitValueRecord[]> {
      const client: limits.LimitsClient = limitsClient_resolve(region);
      const items: limits.models.LimitValueSummary[] = await pages_drain(async (page: string | undefined): Promise<Page<limits.models.LimitValueSummary>> => {
        const answer: limits.responses.ListLimitValuesResponse = await client.listLimitValues({ compartmentId: tenancyId, serviceName: service, ...(page !== undefined ? { page } : {}) });
        return { items: answer.items, opcNextPage: answer.opcNextPage };
      });
      return items.map((value: limits.models.LimitValueSummary): OciLimitValueRecord => ({
        name: value.name ?? '',
        scopeType: String(value.scopeType ?? ''),
        availabilityDomain: value.availabilityDomain ?? null,
        value: value.value ?? 0,
      }));
    },
    async resourceAvailability_get(region: string, tenancyId: string, service: string, limitName: string, availabilityDomain?: string): Promise<{ used: number; available: number } | null> {
      const answer: limits.responses.GetResourceAvailabilityResponse = await limitsClient_resolve(region).getResourceAvailability({
        serviceName: service,
        limitName,
        compartmentId: tenancyId,
        ...(availabilityDomain !== undefined ? { availabilityDomain } : {}),
      });
      const availability: limits.models.ResourceAvailability = answer.resourceAvailability;
      if (availability.used === undefined || availability.available === undefined) return null;
      return { used: availability.used, available: availability.available };
    },
    async shapes_list(region: string, tenancyId: string): Promise<OciShapeRecord[]> {
      const client: core.ComputeClient = computeClient_resolve(region);
      const items: core.models.Shape[] = await pages_drain(async (page: string | undefined): Promise<Page<core.models.Shape>> => {
        const answer: core.responses.ListShapesResponse = await client.listShapes({ compartmentId: tenancyId, ...(page !== undefined ? { page } : {}) });
        return { items: answer.items, opcNextPage: answer.opcNextPage };
      });
      return items.map((shape: core.models.Shape): OciShapeRecord => ({
        shape: shape.shape,
        processorDescription: shape.processorDescription ?? '',
        ocpus: shape.ocpus ?? null,
        memoryInGBs: shape.memoryInGBs ?? null,
        gpus: shape.gpus ?? 0,
        isFlexible: shape.isFlexible ?? false,
        ocpuOptions: shape.ocpuOptions !== undefined ? { min: shape.ocpuOptions.min ?? 0, max: shape.ocpuOptions.max ?? 0 } : null,
        memoryOptions: shape.memoryOptions !== undefined ? { minInGBs: shape.memoryOptions.minInGBs ?? 0, maxInGBs: shape.memoryOptions.maxInGBs ?? 0 } : null,
        quotaNames: shape.quotaNames ?? [],
        raw: shape,
      }));
    },
  };
}
