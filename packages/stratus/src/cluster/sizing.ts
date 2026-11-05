/**
 * @file What a spec needs of a region, read and never written: whether it
 * fits each availability domain's limits, and what it costs an hour. This is
 * what `cluster plan` shows without the `tasks` tier (docs/stratus.adoc, D6).
 *
 * The cost is compute and memory, from the price list; block volumes and
 * load balancers are priced when `spend` is (step 4c), and the line says so.
 *
 * @module
 */
import type { CapacityRow } from '@fnndsc/menu';
import type { CloudDriver, CloudPrice, CloudShape, CloudZone, ServicePrices } from '../cloud/driver.js';
import { capacityRows_read } from '../commands/capacity.js';
import { specNodes_build, type ClusterSpec, type SpecNode } from './spec.js';

/** One availability domain's fit. */
export interface ZoneFit {
  zone: string;
  /** The machines placed there. */
  nodes: string[];
  coresNeeded: number;
  coresFree: number | null;
  memoryNeeded: number;
  memoryFree: number | null;
  /** Null when the cloud did not say what is free. */
  fits: boolean | null;
}

/** What a spec costs an hour. */
export interface SpecCost {
  hourly: number;
  currency: string;
  /** What the figure covers. */
  covers: string;
}

/**
 * The flexible shape a spec's family runs on.
 *
 * @param shapes - The region's shapes.
 * @param family - The family.
 * @returns The shape, or undefined.
 */
export function familyShape_find(shapes: ReadonlyArray<CloudShape>, family: string): CloudShape | undefined {
  const ofFamily: CloudShape[] = shapes.filter((shape: CloudShape): boolean => shape.family.toLowerCase() === family.toLowerCase());
  return ofFamily.find((shape: CloudShape): boolean => shape.flexible) ?? ofFamily[0];
}

/**
 * What a spec costs an hour in compute and memory.
 *
 * @param spec - The spec.
 * @param shape - Its family's shape.
 * @param prices - The price list.
 * @returns The cost, or null when the shape is not priced.
 */
export function specCost_compute(spec: ClusterSpec, shape: CloudShape | undefined, prices: ReadonlyArray<CloudPrice>): SpecCost | null {
  const price: CloudPrice | undefined = shape === undefined ? undefined : prices.find((entry: CloudPrice): boolean => entry.shape === shape.name);
  if (price === undefined) return null;
  const vcpu: number = spec.controlPlane.count * spec.controlPlane.vcpu + spec.workers.count * spec.workers.vcpu;
  const gib: number = spec.controlPlane.count * spec.controlPlane.ramGib + spec.workers.count * spec.workers.ramGib;
  return { hourly: vcpu * price.vcpuHour + gib * price.gibHour, currency: price.currency, covers: `compute and memory (${vcpu} vCPU, ${gib} GiB); volumes and load balancers are not priced yet` };
}

/** The volume performance units each boot tier buys per GiB, as the OCI driver's modules make them. */
const TIER_VPUS: Readonly<Record<string, number>> = { balanced: 10, higher: 20, ultra: 30 };

/** The load balancers a cluster makes (api-int, api, apps), each at its minimum bandwidth in Mbps. */
const BALANCERS: number = 3;
const BALANCER_MBPS: number = 10;

/** Hours in a month, as the price list counts them. */
const HOURS_A_MONTH: number = 730;

/**
 * What a spec costs an hour, whole: compute and memory, the boot volumes at
 * their tiers, ChRIS's volumes and the load balancers, as SIZE prices it,
 * so the question before billing asks the consequence the offer showed
 * (AEGIS a-change-is-a-loop, clause 4). Storage and load balancing fall back
 * to compute and memory alone, said so, when the list does not price them.
 *
 * @param spec - The spec.
 * @param shape - Its family's shape.
 * @param prices - The shapes' price list.
 * @param services - Storage and load-balancing prices, or null.
 * @returns The cost, or null when the shape is not priced.
 */
export function specCostWhole_compute(spec: ClusterSpec, shape: CloudShape | undefined, prices: ReadonlyArray<CloudPrice>, services: ServicePrices | null): SpecCost | null {
  const base: SpecCost | null = specCost_compute(spec, shape, prices);
  if (base === null || services === null) return base;
  const volumeHour = (gib: number, tier: string): number => (gib * (services.volumeGibMonth + (TIER_VPUS[tier] ?? 10) * services.vpuGibMonth)) / HOURS_A_MONTH;
  const boot: number = volumeHour(spec.controlPlane.count * spec.controlPlane.bootGib, spec.controlPlane.bootTier) + volumeHour(spec.workers.count * spec.workers.bootGib, spec.workers.bootTier);
  const chrisGib: number = spec.chris.dataGib + spec.chris.databaseGib + spec.chris.queueGib;
  const balancers: number = BALANCERS * (services.balancerHour + BALANCER_MBPS * services.balancerMbpsHour);
  const vcpu: number = spec.controlPlane.count * spec.controlPlane.vcpu + spec.workers.count * spec.workers.vcpu;
  const gib: number = spec.controlPlane.count * spec.controlPlane.ramGib + spec.workers.count * spec.workers.ramGib;
  return { hourly: base.hourly + boot + volumeHour(chrisGib, 'balanced') + balancers, currency: base.currency, covers: `compute and memory (${vcpu} vCPU, ${gib} GiB), the boot and ChRIS volumes, and ${BALANCERS} load balancers` };
}

/**
 * Money as the operator reads it.
 *
 * @param cost - The cost.
 * @returns `$0.62 an hour (USD, compute and memory …)`.
 */
export function cost_words(cost: SpecCost): string {
  const symbol: string = cost.currency === 'USD' ? '$' : `${cost.currency} `;
  return `${symbol}${cost.hourly.toFixed(2)} an hour (${cost.covers})`;
}

/**
 * Whether a spec fits each availability domain, read from the limits.
 *
 * @param driver - The cloud.
 * @param region - The region.
 * @param cluster - The cluster's name, for its machines' names.
 * @param spec - The spec.
 * @returns One row per zone, in the region's order.
 */
export async function specFit_read(driver: CloudDriver, region: string, cluster: string, spec: ClusterSpec): Promise<ZoneFit[]> {
  const zones: CloudZone[] = await driver.zones_list(region);
  const shape: CloudShape | undefined = familyShape_find(await driver.shapes_list(region), spec.family);
  const perCore: number = shape?.vcpuPerCore ?? 2;
  const rows: CapacityRow[] = await capacityRows_read(driver, region, [spec.family]);
  const nodes: SpecNode[] = specNodes_build(cluster, spec, zones.length);
  return zones.map((zone: CloudZone, index: number): ZoneFit => {
    const here: SpecNode[] = nodes.filter((node: SpecNode): boolean => node.zoneIndex === index);
    const free = (word: string): number | null => rows.find((row: CapacityRow): boolean => row.zone === zone.name && row.limit.includes(word))?.available ?? null;
    const coresNeeded: number = here.reduce((sum: number, node: SpecNode): number => sum + node.vcpu / perCore, 0);
    const memoryNeeded: number = here.reduce((sum: number, node: SpecNode): number => sum + node.ramGib, 0);
    const coresFree: number | null = free('core');
    const memoryFree: number | null = free('memory');
    const fits: boolean | null = coresFree === null || memoryFree === null ? null : coresNeeded <= coresFree && memoryNeeded <= memoryFree;
    return { zone: zone.name, nodes: here.map((node: SpecNode): string => node.name), coresNeeded, coresFree, memoryNeeded, memoryFree, fits };
  });
}
