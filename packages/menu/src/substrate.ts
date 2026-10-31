/**
 * @file The substrate's models: what a stratus session's `cluster status`
 * and `capacity` answer beneath their rendered text, so a surface lays
 * them out (docs/stratus.adoc, D11: the CLUSTERS and CAPACITY tiles).
 *
 * @module
 */
import { z } from 'zod';

/** The model kind `cluster status` carries. */
export const STRATUS_CLUSTERS_MODEL_KIND = 'stratus.clusters' as const;

/** One build step, where it stands. */
export const clusterStepSchema = z.object({
  /** Its folder, numbered in build order (`05-infra-apply`). */
  folder: z.string(),
  /** `done`, `not done`, `running`, `failed`, `expired`, or `unknown`. */
  state: z.string(),
  /** Its name (`infra-apply`); absent from an older daemon. */
  name: z.string().optional(),
  /** What it rests on, or why it failed, in a line. */
  evidence: z.string().optional(),
  /** When it started and ended, when kept. */
  started: z.string().nullable().optional(),
  ended: z.string().nullable().optional(),
});

/**
 * Where a cluster stands, in one word: the TD controller's CONDITION
 * (docs/stratus.adoc, D13). Billing is not a condition; it is said apart.
 * STOPPED is a build left part way: steps done, none running, not up.
 */
export const CLUSTER_CONDITIONS = ['SIZING', 'STOPPED', 'ASKING', 'BUILDING', 'UP', 'SERVING', 'FAILED', 'GONE'] as const;

/** One pool of nodes in a spec. */
export const nodePoolSchema = z.object({
  count: z.number(),
  vcpu: z.number(),
  ramGib: z.number(),
  bootGib: z.number(),
  bootTier: z.string(),
});

/** A cluster's spec: the cluster and the ChRIS on it. */
export const clusterSpecSchema = z.object({
  family: z.string(),
  controlPlane: nodePoolSchema,
  workers: nodePoolSchema,
  chris: z.object({ dataGib: z.number(), databaseGib: z.number(), queueGib: z.number() }),
});

/** One kind of resource a plan touches, and how. */
export const planGroupSchema = z.object({
  /** `create`, `replace`, `change`, `drift` or `destroy`. */
  action: z.string(),
  kind: z.string(),
  count: z.number(),
  /** The resources' names, as many as the plan gives. */
  names: z.array(z.string()),
});

/** The last infrastructure plan, counted, with drift apart from real change. */
export const planSummarySchema = z.object({
  create: z.number(),
  replace: z.number(),
  change: z.number(),
  drift: z.number(),
  destroy: z.number(),
  groups: z.array(planGroupSchema),
  /** When it was made, when known. */
  at: z.string().nullable(),
});

/** One of `cluster verify`'s checks. */
export const verifyCheckSchema = z.object({
  name: z.string(),
  /** True passed, false failed, null not run. */
  ok: z.boolean().nullable(),
  detail: z.string(),
  /** `reads` or `writes`. */
  how: z.string(),
});

/** One OpenShift cluster. */
export const clusterSummarySchema = z.object({
  name: z.string(),
  /** Its folder in the session (`/net/oci/fnndsc/clusters/harbor`). */
  path: z.string(),
  /** The cluster's DNS name, or null when its settings do not say. */
  cluster: z.string().nullable(),
  /** The last step done, or null when none is. */
  lastDone: z.string().nullable(),
  steps: z.array(clusterStepSchema),
  /** Its compartment's live resources by kind, or null when not counted. */
  resources: z.record(z.string(), z.number()).nullable(),
  /** What it costs at list price, an hour and so far, or null when not priced; absent from an older daemon. */
  cost: z.object({ hourly: z.number(), soFar: z.number(), currency: z.string() }).nullable().optional(),
  // What the TD controller draws, beyond the tile's glance; each absent from an older daemon.
  /** Where it stands in one word. */
  condition: z.enum(CLUSTER_CONDITIONS).optional(),
  /** Whether money runs: its machines are made and not torn down. */
  billing: z.boolean().optional(),
  /** `built` here, `adopted` (built elsewhere, planned against only), `checkout` (read from a harbor-oci checkout), or `found` (in the tenancy by its tag, not adopted: reads only). */
  origin: z.enum(['built', 'adopted', 'checkout', 'found']).optional(),
  /** Whether teardown is refused until `cluster protect <name> off`. */
  protected: z.boolean().optional(),
  /** The verbs refused for this cluster, by name, with why. */
  refused: z.record(z.string(), z.string()).optional(),
  region: z.string().nullable().optional(),
  compartment: z.string().nullable().optional(),
  /** When its teardown removed what it built, or null. */
  gone: z.string().nullable().optional(),
  spec: clusterSpecSchema.nullable().optional(),
  /** The first step not done, or null when every step is, or when the cluster is not built on here (adopted, torn down, read from a checkout). */
  next: z.string().nullable().optional(),
  /** The step from which billing starts. */
  billingStep: z.string().optional(),
  /** The build's task while it runs (`/proc/steps/<name>-build`), with the step running and since when. */
  running: z.object({ job: z.string(), step: z.string().nullable(), since: z.string().nullable() }).nullable().optional(),
  plan: planSummarySchema.nullable().optional(),
  /** The last `cluster verify`, check by check. */
  verify: z.object({ at: z.string().nullable(), checks: z.array(verifyCheckSchema) }).nullable().optional(),
  /** The question the engine has put and waits on, or null. */
  asking: z.string().nullable().optional(),
});

/** What `cluster status` answers. */
export const clustersModelSchema = z.object({
  clusters: z.array(clusterSummarySchema),
});

/**
 * The event a build shows its cluster by, on every change and before every
 * question it asks: one cluster's summary as the host knows it without asking
 * the cloud, so `resources` is null and `cost` absent (the last `cluster
 * status` holds them). A surface that missed events reads `cluster status`.
 */
export const STRATUS_CLUSTER_STATE_EVENT = 'stratus.cluster.state' as const;

/** The model kind `cluster size` carries. */
export const STRATUS_CLUSTER_SIZE_MODEL_KIND = 'stratus.cluster.size' as const;

/** What `cluster size` answers: what a spec is sized against, so a surface redraws fit and cost as its levers move. */
export const clusterSizeModelSchema = z.object({
  region: z.string(),
  /** The family sized for. */
  family: z.string(),
  /** The families the region has a flexible shape for. */
  families: z.array(z.string()),
  /** vCPU per core the cloud bills by. */
  vcpuPerCore: z.number(),
  /** The flexible shape's ranges per node. */
  cores: z.object({ min: z.number(), max: z.number() }).nullable(),
  memoryGib: z.object({ min: z.number(), max: z.number() }).nullable(),
  /** Each availability domain, with what its limits leave free (null when not said). */
  zones: z.array(z.object({ zone: z.string(), coresFree: z.number().nullable(), memoryFree: z.number().nullable() })),
  /** The family's price, or null when not in the price list. */
  price: z.object({ vcpuHour: z.number(), gibHour: z.number(), currency: z.string() }).nullable(),
  /** Storage and load balancing, or null when not priced. */
  services: z.object({ volumeGibMonth: z.number(), vpuGibMonth: z.number(), balancerHour: z.number(), balancerMbpsHour: z.number() }).nullable(),
  /** The spec a new cluster starts from. */
  start: clusterSpecSchema,
  /** The DNS zone a new cluster's names live under unless another is named: the session's, else the tenancy's only one; null when there is none to default to. */
  baseDomain: z.string().nullable(),
  /** The DNS zones the tenancy holds, by name; absent when the cloud cannot say. */
  dnsZones: z.array(z.string()).optional(),
});

/** The model kind `capacity` carries. */
export const STRATUS_CAPACITY_MODEL_KIND = 'stratus.capacity' as const;

/** One limit a shape draws on, in one place. */
export const capacityRowSchema = z.object({
  /** The shape family (`E5`). */
  family: z.string(),
  /** The limit (`standard-e5-core-count`). */
  limit: z.string(),
  /** The zone it applies in, or null for a region-wide limit. */
  zone: z.string().nullable(),
  /** What the limit permits. */
  value: z.number(),
  /** How much is spent and left; null when the cloud does not say. */
  used: z.number().nullable(),
  available: z.number().nullable(),
});

/** What `capacity` answers. */
export const capacityModelSchema = z.object({
  region: z.string(),
  rows: z.array(capacityRowSchema),
});

export type ClusterStep = z.infer<typeof clusterStepSchema>;
export type ClusterCondition = typeof CLUSTER_CONDITIONS[number];
export type ClusterSpecModel = z.infer<typeof clusterSpecSchema>;
export type PlanSummary = z.infer<typeof planSummarySchema>;
export type VerifyCheckModel = z.infer<typeof verifyCheckSchema>;
export type ClusterSizeModel = z.infer<typeof clusterSizeModelSchema>;
export type ClusterSummary = z.infer<typeof clusterSummarySchema>;
export type ClustersModel = z.infer<typeof clustersModelSchema>;
export type CapacityRow = z.infer<typeof capacityRowSchema>;
export type CapacityModel = z.infer<typeof capacityModelSchema>;
