/**
 * @file A new cluster's stack variables: the spec in OCI's units, and the
 * choices `harbor-oci` made for every build (its `tfvars_build`). Every value
 * is a string, as Resource Manager takes them.
 *
 * The choices: the stack writes no DNS (the zone is long-lived and the dns
 * step writes the three records), the attribution tag namespace is the one
 * the tenancy already has, wherever it lives (its name is tenancy-wide), the API's load balancer is public, the Assisted
 * Installer installs. With no workers only `compute_count` is set: the stack
 * still reads `compute_shape` for the image, so its other compute variables
 * keep their defaults and a compact cluster plans unchanged.
 *
 * @module
 */
import { SPEC_DEFAULT, type ClusterSpec, type NodePool } from '../../cluster/spec.js';
import { SHAPE_TERMS } from './prices.js';

/** Volume performance units per GB for each tier, as `harbor-oci` sets them. */
export const TIER_VPUS: Readonly<Record<string, number>> = { balanced: 10, higher: 20, ultra: 100 };

/** The OCI cloud controller and CSI driver release the stack installs. */
export const OCI_DRIVER_VERSION: string = 'v1.34.0';

/**
 * The flexible shape a family runs on, and its vCPU per OCPU.
 *
 * @param family - The family (`E5`).
 * @returns The shape and its ratio.
 * @throws Error - For a family with no flexible shape known.
 */
export function familyShape_resolve(family: string): { shape: string; vcpuPerOcpu: number } {
  const found = Object.entries(SHAPE_TERMS).find(([, terms]): boolean => terms.family === family);
  if (found === undefined) throw new Error(`${family}: no flexible shape known for this family`);
  return { shape: found[0], vcpuPerOcpu: found[1].vcpuPerOcpu };
}

/**
 * One pool as the stack's `<prefix>_*` variables.
 *
 * @param prefix - `control_plane` or `compute`.
 * @param pool - The pool.
 * @param family - The family.
 * @returns The variables.
 * @throws Error - When the vCPU is not whole OCPUs, or the tier is unknown.
 */
function pool_variables(prefix: string, pool: NodePool, family: string): Record<string, string> {
  const { shape, vcpuPerOcpu } = familyShape_resolve(family);
  if (pool.vcpu % vcpuPerOcpu !== 0) throw new Error(`${prefix}: ${pool.vcpu} vCPU is not whole OCPUs on ${family} (${vcpuPerOcpu} vCPU an OCPU)`);
  const vpus: number | undefined = TIER_VPUS[pool.bootTier];
  if (vpus === undefined) throw new Error(`${prefix}: boot tier ${pool.bootTier} is not one of ${Object.keys(TIER_VPUS).join(', ')}`);
  return {
    [`${prefix}_count`]: String(pool.count),
    [`${prefix}_shape`]: shape,
    [`${prefix}_ocpu`]: String(pool.vcpu / vcpuPerOcpu),
    [`${prefix}_memory`]: String(pool.ramGib),
    [`${prefix}_boot_size`]: String(pool.bootGib),
    [`${prefix}_boot_volume_vpus_per_gb`]: String(vpus),
  };
}

/** What a new stack's variables are made from. */
export interface StackVarsRequest {
  readonly cluster: string;
  readonly spec: ClusterSpec;
  readonly tenancyId: string;
  readonly compartmentId: string;
  /** Where the `openshift-tags` namespace lives: a tenancy-wide name, so wherever the first cluster made it. */
  readonly tagNamespaceCompartmentId?: string;
  readonly region: string;
  readonly baseDomain: string;
  /** The discovery image's link; a secret. */
  readonly isoLink: string;
  readonly sshPublicKey: string;
}

/**
 * A new cluster's stack variables.
 *
 * @param request - The cluster, its spec, where it goes, the image and the key.
 * @returns The variables, each a string.
 */
export function stackVariables_build(request: StackVarsRequest): Record<string, string> {
  return {
    tenancy_ocid: request.tenancyId,
    compartment_ocid: request.compartmentId,
    tag_namespace_compartment_ocid_resource_tagging: request.tagNamespaceCompartmentId ?? request.compartmentId,
    region: request.region,
    cluster_name: request.cluster,
    zone_dns: request.baseDomain,
    installation_method: 'Assisted',
    openshift_image_source_uri: request.isoLink,
    public_ssh_key: request.sshPublicKey,
    ...pool_variables('control_plane', request.spec.controlPlane, request.spec.family),
    ...(request.spec.workers.count > 0 ? pool_variables('compute', request.spec.workers, request.spec.family) : { compute_count: '0' }),
    create_public_dns: 'false',
    create_private_dns: 'false',
    enable_public_api_lb: 'true',
    enable_public_apps_lb: 'true',
    oci_driver_version: OCI_DRIVER_VERSION,
  };
}

/**
 * One pool read back from a stack's `<prefix>_*` variables: the inverse of
 * {@link stackVariables_build}'s pool, for a stack found in the tenancy.
 *
 * @param variables - The stack's variables.
 * @param prefix - `control_plane` or `compute`.
 * @returns The pool and its family, or null when the variables do not say.
 */
function pool_derive(variables: Readonly<Record<string, string>>, prefix: string): { pool: NodePool; family: string } | null {
  const shape: string | undefined = variables[`${prefix}_shape`];
  const terms = shape === undefined ? undefined : SHAPE_TERMS[shape];
  const count: number = Number(variables[`${prefix}_count`]);
  const ocpu: number = Number(variables[`${prefix}_ocpu`]);
  const memory: number = Number(variables[`${prefix}_memory`]);
  const boot: number = Number(variables[`${prefix}_boot_size`]);
  const vpus: number = Number(variables[`${prefix}_boot_volume_vpus_per_gb`]);
  if (terms === undefined || ![count, ocpu, memory, boot].every((n: number): boolean => Number.isFinite(n))) return null;
  const tier: string = Object.entries(TIER_VPUS).find(([, value]: [string, number]): boolean => value === vpus)?.[0] ?? 'balanced';
  return { family: terms.family, pool: { count, vcpu: ocpu * terms.vcpuPerOcpu, ramGib: memory, bootGib: boot, bootTier: tier } };
}

/**
 * What a stack's variables say of the cluster they build: the zone its names
 * live under and the spec, as far as the variables carry it (ChRIS's sizes
 * are not in the stack; they start from the default).
 *
 * @param variables - The stack's variables, as Resource Manager holds them.
 * @returns The zone and the spec, each null when the variables do not say.
 */
export function stackSpec_derive(variables: Readonly<Record<string, string>>): { spec: ClusterSpec | null; baseDomain: string | null } {
  const baseDomain: string | null = variables['zone_dns'] ?? null;
  const plane = pool_derive(variables, 'control_plane');
  if (plane === null) return { spec: null, baseDomain };
  const workers = pool_derive(variables, 'compute');
  const workerCount: number = Number(variables['compute_count'] ?? '0');
  return {
    spec: {
      family: plane.family,
      controlPlane: plane.pool,
      workers: workers?.pool ?? { ...SPEC_DEFAULT.workers, count: Number.isFinite(workerCount) ? workerCount : 0 },
      chris: { ...SPEC_DEFAULT.chris },
    },
    baseDomain,
  };
}
