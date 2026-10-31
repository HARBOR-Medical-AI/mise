/**
 * @file `cluster size [--family <family>]`: what a new cluster is sized
 * against in the session's region, read and never written (docs/stratus.adoc,
 * D13, SIZE): each availability domain's free cores and memory for the
 * family, the family's flexible shape and price, what storage and load
 * balancing cost, the spec a new cluster starts from, and the DNS zones its
 * names may live under (the tenancy's only one is the default).
 *
 * The answer carries the `stratus.cluster.size` model, so a surface redraws
 * fit and cost as its levers move without a line per move; what it shows is
 * presentation, and `cluster new` checks again when the spec is committed.
 *
 * @module
 */
import chalk from 'chalk';
import { envelope_error, envelope_ok, STRATUS_CLUSTER_SIZE_MODEL_KIND, type CapacityRow, type CommandEnvelope, type ClusterSizeModel } from '@fnndsc/menu';
import type { CloudPrice, CloudShape, CloudZone, ServicePrices } from '../cloud/driver.js';
import { capacityRows_read } from './capacity.js';
import { familyShape_find } from '../cluster/sizing.js';
import { SPEC_DEFAULT } from '../cluster/spec.js';
import { baseDomain_default, dnsZones_read, options_read, spec_line, type BuildCommandContext } from './build.js';

/**
 * What a limit leaves free in a zone, by a word in its name (`core`, `memory`).
 *
 * @param rows - The family's limits.
 * @param zone - The zone.
 * @param word - The word.
 * @returns What is free, or null when the cloud does not say.
 */
function free_find(rows: ReadonlyArray<CapacityRow>, zone: string, word: string): number | null {
  return rows.find((row: CapacityRow): boolean => row.zone === zone && row.limit.includes(word))?.available ?? null;
}

/**
 * `cluster size [--family <family>]`.
 *
 * @param context - The session.
 * @param args - The words after `size`.
 * @returns The envelope.
 */
export async function clusterSize_run(context: BuildCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const read = options_read(args, ['--family']);
  if ('error' in read) return envelope_error('', undefined, `cluster size: ${read.error} (--family)\n`);
  if (read.rest.length > 0) return envelope_error('', undefined, 'cluster size: usage: cluster size [--family <family>]\n');
  const region: string | null = context.region();
  if (region === null) return envelope_error('', undefined, 'cluster size: not connected\n');
  const family: string = read.options.get('--family') ?? SPEC_DEFAULT.family;
  const shapes: CloudShape[] = await context.driver.shapes_list(region);
  const shape: CloudShape | undefined = familyShape_find(shapes, family);
  if (shape === undefined) return envelope_error('', undefined, `cluster size: ${family}: no such family in ${region} (${[...new Set(shapes.map((each: CloudShape): string => each.family))].sort().join(', ')})\n`);
  const [zones, prices, services, rows, dnsZones] = await Promise.all([
    context.driver.zones_list(region),
    context.driver.prices_list(),
    context.driver.servicePrices_get(),
    capacityRows_read(context.driver, region, [family]),
    dnsZones_read(context, region),
  ]) as [CloudZone[], CloudPrice[], ServicePrices | null, CapacityRow[], string[]];
  const price: CloudPrice | undefined = prices.find((entry: CloudPrice): boolean => entry.shape === shape.name);
  const model: ClusterSizeModel = {
    region,
    family: shape.family,
    families: [...new Set(shapes.filter((each: CloudShape): boolean => each.flexible).map((each: CloudShape): string => each.family))].sort(),
    vcpuPerCore: shape.vcpuPerCore,
    cores: shape.flexible ? { ...shape.cores } : null,
    memoryGib: shape.flexible ? { ...shape.memoryGib } : null,
    zones: zones.map((zone: CloudZone) => ({ zone: zone.name, coresFree: free_find(rows, zone.name, 'core'), memoryFree: free_find(rows, zone.name, 'memory') })),
    price: price === undefined ? null : { vcpuHour: price.vcpuHour, gibHour: price.gibHour, currency: price.currency },
    services: services === null ? null : { volumeGibMonth: services.volumeGibMonth, vpuGibMonth: services.vpuGibMonth, balancerHour: services.balancerHour, balancerMbpsHour: services.balancerMbpsHour },
    start: { ...SPEC_DEFAULT, family: shape.family },
    baseDomain: baseDomain_default(context, dnsZones),
    dnsZones,
  };
  const free = (value: number | null): string => value === null ? '?' : String(value);
  const lines: string[] = [
    `${chalk.bold(shape.family)}  ${shape.name} in ${region}${price === undefined ? chalk.gray('  not in the price list') : `  ${price.currency} ${price.vcpuHour} a vCPU-hour, ${price.gibHour} a GiB-hour`}`,
    ...model.zones.map((zone) => `  ${zone.zone.padEnd(24)} ${free(zone.coresFree)} cores, ${free(zone.memoryFree)} GiB free`),
    chalk.gray(`starts from: ${spec_line(model.start)}`),
    model.baseDomain !== null ? chalk.gray(`names under: ${model.baseDomain}`) : chalk.yellow(`names under: none chosen; cluster new --base-domain names one (${dnsZones.join(', ') || 'the tenancy holds no DNS zone'})`),
  ];
  return envelope_ok(`${lines.join('\n')}\n`, { kind: STRATUS_CLUSTER_SIZE_MODEL_KIND, data: model });
}
