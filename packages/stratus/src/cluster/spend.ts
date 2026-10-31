/**
 * @file What a cluster costs: each live resource in its compartment priced at
 * list price, an hour, and what that has come to since each was made
 * (docs/stratus.adoc, D7). `harbor-oci`'s `burn`, read through the driver.
 *
 * Machines bill by vCPU and memory while running; volumes by size and
 * performance whatever the machine does; load balancers by the hour and their
 * minimum bandwidth. Buckets, networks and DNS zones are free at this scale.
 * The figures are estimates at list price, not the bill: discounts, free
 * tiers and traffic are not in them, and the lines say so.
 *
 * @module
 */
import type { CloudDriver, CloudInstance, CloudLoadBalancer, CloudPrice, CloudVolume, ServicePrices } from '../cloud/driver.js';

/** The hours a month is billed as, as `harbor-oci` reckons. */
export const HOURS_PER_MONTH: number = 730;

/** The states in which a machine bills. */
const COMPUTE_STATES: ReadonlyArray<string> = ['running', 'starting', 'provisioning'];

/** The states in which a resource is gone and bills nothing. */
const GONE_STATES: ReadonlyArray<string> = ['terminated', 'deleted', 'terminating', 'deleting'];

/** One priced resource. */
export interface SpendItem {
  readonly kind: 'compute' | 'volumes' | 'load balancers';
  readonly name: string;
  readonly detail: string;
  /** Per hour, or null when it could not be priced. */
  readonly hourly: number | null;
  /** Since it was made, or null when unpriced or its making is not known. */
  readonly soFar: number | null;
}

/** A compartment's spend. */
export interface Spend {
  readonly items: ReadonlyArray<SpendItem>;
  readonly hourly: number;
  readonly soFar: number;
  readonly currency: string;
  /** How many items could not be priced. */
  readonly unpriced: number;
}

/**
 * The hours since a time.
 *
 * @param created - ISO 8601, or empty.
 * @param now - The clock.
 * @returns Hours, or null when not known.
 */
function hours_since(created: string, now: Date): number | null {
  const at: number = Date.parse(created);
  return Number.isFinite(at) ? Math.max(0, (now.getTime() - at) / 3_600_000) : null;
}

/**
 * A machine's hour.
 *
 * @param instance - The machine.
 * @param prices - The shapes' prices.
 * @returns Its price an hour, or null.
 */
export function instance_hourly(instance: CloudInstance, prices: ReadonlyArray<CloudPrice>): number | null {
  const price: CloudPrice | undefined = prices.find((entry: CloudPrice): boolean => entry.shape === instance.shape);
  if (price === undefined || instance.vcpus === undefined || instance.memoryGib === undefined) return null;
  return instance.vcpus * price.vcpuHour + instance.memoryGib * price.gibHour;
}

/**
 * A volume's hour.
 *
 * @param volume - The volume.
 * @param prices - Storage prices.
 * @returns Its price an hour.
 */
export function volume_hourly(volume: CloudVolume, prices: ServicePrices): number {
  return (volume.sizeGib * (prices.volumeGibMonth + (volume.vpusPerGib ?? 10) * prices.vpuGibMonth)) / HOURS_PER_MONTH;
}

/**
 * A load balancer's hour.
 *
 * @param balancer - The load balancer.
 * @param prices - Load-balancing prices.
 * @returns Its price an hour.
 */
export function balancer_hourly(balancer: CloudLoadBalancer, prices: ServicePrices): number {
  return prices.balancerHour + (balancer.minimumMbps ?? 10) * prices.balancerMbpsHour;
}

/**
 * Prices every live resource in a compartment.
 *
 * @param driver - The cloud.
 * @param compartmentId - The compartment.
 * @param region - The region.
 * @param now - The clock.
 * @returns The spend.
 */
export async function spend_read(driver: CloudDriver, compartmentId: string, region: string, now: Date): Promise<Spend> {
  const [instances, volumes, balancers, prices, service] = await Promise.all([
    driver.instances_list(compartmentId, region),
    driver.volumes_list(compartmentId, region),
    driver.loadbalancers_list(compartmentId, region),
    driver.prices_list(),
    driver.servicePrices_get(),
  ]);
  const item = (kind: SpendItem['kind'], name: string, detail: string, hourly: number | null, created: string): SpendItem => {
    const hours: number | null = hours_since(created, now);
    return { kind, name, detail, hourly, soFar: hourly === null || hours === null ? null : hourly * hours };
  };
  const items: SpendItem[] = [
    ...instances.filter((instance: CloudInstance): boolean => COMPUTE_STATES.includes(instance.state))
      .map((instance: CloudInstance): SpendItem => item('compute', instance.name, `${instance.shape}, ${instance.vcpus ?? '?'} vCPU, ${instance.memoryGib ?? '?'} GiB`, instance_hourly(instance, prices), instance.created)),
    ...volumes.filter((volume: CloudVolume): boolean => !GONE_STATES.includes(volume.state))
      .map((volume: CloudVolume): SpendItem => item('volumes', volume.name, `${volume.sizeGib} GiB, ${volume.vpusPerGib ?? 10} VPU/GiB`, service === null ? null : volume_hourly(volume, service), volume.created)),
    ...balancers.filter((balancer: CloudLoadBalancer): boolean => !GONE_STATES.includes(balancer.state))
      .map((balancer: CloudLoadBalancer): SpendItem => item('load balancers', balancer.name, `${balancer.shape}, ${balancer.minimumMbps ?? 10} Mbps minimum`, service === null ? null : balancer_hourly(balancer, service), balancer.created)),
  ];
  return {
    items,
    hourly: items.reduce((sum: number, entry: SpendItem): number => sum + (entry.hourly ?? 0), 0),
    soFar: items.reduce((sum: number, entry: SpendItem): number => sum + (entry.soFar ?? 0), 0),
    currency: service?.currency ?? prices[0]?.currency ?? 'USD',
    unpriced: items.filter((entry: SpendItem): boolean => entry.hourly === null).length,
  };
}

/**
 * Money as the operator reads it.
 *
 * @param amount - The amount.
 * @param currency - Its currency.
 * @returns `$1.23`.
 */
export function money_words(amount: number, currency: string): string {
  // A rate under a cent is shown to the hundredth of a cent, never as nothing.
  const digits: number = amount !== 0 && Math.abs(amount) < 0.01 ? 4 : 2;
  return `${currency === 'USD' ? '$' : `${currency} `}${amount.toFixed(digits)}`;
}

/**
 * A spend in a line.
 *
 * @param spend - The spend.
 * @returns `$0.89 an hour · $412.30 so far, at list price`.
 */
export function spend_line(spend: Spend): string {
  return `${money_words(spend.hourly, spend.currency)} an hour · ${money_words(spend.soFar, spend.currency)} so far, at list price${spend.unpriced > 0 ? ` (${spend.unpriced} not priced)` : ''}`;
}
