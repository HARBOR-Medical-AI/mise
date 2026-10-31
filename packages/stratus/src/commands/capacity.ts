/**
 * @file `capacity`: how much of each limit a shape family draws on is free,
 * per zone, in the session's region (docs/stratus.adoc, D7).
 *
 * The families are the ones named, else the ones the daemon's clusters'
 * specs name (`family:`), else every family the region offers, so a session
 * with no clusters still reads its room. For each, the region's shapes of that family say
 * which limits they draw on; each limit is read at every zone it is kept in,
 * with what is used and left when the cloud says. The answer carries the
 * `stratus.capacity` model the CAPACITY tile draws.
 *
 * Every family of a region is hundreds of reads, one per limit and zone,
 * against a Limits API that throttles; so the reads go a few at a time,
 * and what they read is kept for a while, so the next `capacity`, a
 * repaint of the dashboard or the CAPACITY pane opening, answers at once.
 *
 * @module
 */
import chalk from 'chalk';
import { envelope_error, envelope_ok, STRATUS_CAPACITY_MODEL_KIND, type CapacityModel, type CapacityRow, type CommandEnvelope } from '@fnndsc/menu';
import type { CommandHelp } from '@fnndsc/brasa/core';
import type { CloudAvailability, CloudDriver, CloudLimit, CloudShape } from '../cloud/driver.js';
import { AnswerCache } from '../cache.js';
import type { HarborCluster } from '../checkout/harborOci.js';
import type { ClusterTree } from '../vfs/clusters.js';

/** What `capacity` reads from the session. */
export interface CapacityCommandContext {
  readonly clusters: ClusterTree;
  readonly driver: CloudDriver;
  /** The session's region, or null when not connected. */
  readonly region: () => string | null;
  /** Where the limits read are kept between asks; absent, every ask reads the cloud. */
  readonly cache?: AnswerCache;
}

/** How long a limit read stays current: limits move slowly, and a repaint should not walk the region again. */
export const CAPACITY_CACHE_LIFE_MS: number = 10 * 60_000;

/** How many availability reads go to the cloud at once: the Limits API throttles, and one at a time took minutes. */
export const CAPACITY_READS_AT_ONCE: number = 4;

/**
 * Runs a read over each item, a few at a time, keeping the items' order.
 *
 * @param items - What to read.
 * @param atOnce - How many reads run together.
 * @param read - The read.
 * @returns The answers, in the items' order.
 */
async function fewAtOnce_read<T, R>(items: ReadonlyArray<T>, atOnce: number, read: (item: T) => Promise<R>): Promise<R[]> {
  const answers: R[] = [];
  for (let start = 0; start < items.length; start += atOnce) {
    answers.push(...await Promise.all(items.slice(start, start + atOnce).map(read)));
  }
  return answers;
}

/**
 * The shape family a spec names (`family: E5`), or null.
 *
 * @param spec - The spec's text.
 * @returns The family.
 */
export function specFamily_parse(spec: string | null): string | null {
  const match: RegExpMatchArray | null = spec?.match(/^family:\s*([A-Za-z0-9.]+)/m) ?? null;
  return match?.[1] ?? null;
}

/**
 * The capacity rows for families in a region.
 *
 * @param driver - The cloud.
 * @param region - The region.
 * @param families - The families.
 * @param cache - Where the reads are kept; absent, nothing is kept.
 * @returns One row per limit and zone, family by family.
 */
export async function capacityRows_read(driver: CloudDriver, region: string, families: ReadonlyArray<string>, cache: AnswerCache = new AnswerCache(0)): Promise<CapacityRow[]> {
  const shapes: CloudShape[] = await cache.answer_get(`capacity/${region}/shapes`, (): Promise<CloudShape[]> => driver.shapes_list(region));
  const rows: CapacityRow[] = [];
  for (const family of families) {
    const ofFamily: CloudShape[] = shapes.filter((shape: CloudShape): boolean => shape.family.toLowerCase() === family.toLowerCase());
    const quotas: Map<string, string> = new Map();
    for (const shape of ofFamily) for (const name of shape.quotaNames) quotas.set(name, shape.limitService);
    const byService: Map<string, CloudLimit[]> = new Map();
    const wanted: CloudLimit[] = [];
    for (const [name, service] of quotas) {
      if (!byService.has(service)) byService.set(service, await cache.answer_get(`capacity/${region}/limits/${service}`, (): Promise<CloudLimit[]> => driver.limits_list(region, service)));
      wanted.push(...(byService.get(service) ?? []).filter((limit: CloudLimit): boolean => limit.name === name));
    }
    const availabilities: Array<CloudAvailability | null> = await fewAtOnce_read(wanted, CAPACITY_READS_AT_ONCE, (limit: CloudLimit): Promise<CloudAvailability | null> =>
      cache.answer_get(`capacity/${region}/free/${limit.service}/${limit.name}/${limit.zone ?? 'region'}`, (): Promise<CloudAvailability | null> => driver.limitAvailability_get(region, limit.service, limit.name, limit.zone)));
    wanted.forEach((limit: CloudLimit, index: number): void => {
      const availability: CloudAvailability | null = availabilities[index] ?? null;
      rows.push({ family, limit: limit.name, zone: limit.zone ?? null, value: limit.value, used: availability?.used ?? null, available: availability?.available ?? null });
    });
  }
  return rows;
}

/** One row as a line. */
function row_line(row: CapacityRow, limitWidth: number, zoneWidth: number): string {
  const free: string = row.available === null ? chalk.gray(`${row.value} permitted, use not reported`) : `${row.available} of ${row.value} free`;
  return `${row.family.padEnd(4)}  ${row.limit.padEnd(limitWidth)}  ${(row.zone ?? 'region').padEnd(zoneWidth)}  ${free}`;
}

/**
 * Runs `capacity`.
 *
 * @param context - The session.
 * @param args - Families, or none for the clusters' own.
 * @returns The envelope, with the `stratus.capacity` model.
 */
export async function capacity_run(context: CapacityCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const region: string | null = context.region();
  if (region === null) return envelope_error('', undefined, 'capacity: not connected\n');
  const named: string[] = args.length > 0
    ? [...args]
    : [...new Set(context.clusters.clusters_read().map((cluster: HarborCluster): string | null => specFamily_parse(cluster.spec)).filter((family: string | null): family is string => family !== null))];
  // No family named and no spec naming one: every family the region offers, so a session with no clusters still reads its room.
  const cache: AnswerCache = context.cache ?? new AnswerCache(0);
  const families: string[] = named.length > 0 ? named : [...new Set((await cache.answer_get(`capacity/${region}/shapes`, (): Promise<CloudShape[]> => context.driver.shapes_list(region))).map((shape: CloudShape): string => shape.family))].sort();
  if (families.length === 0) return envelope_error('', undefined, `capacity: ${region} offers no shape family\n`);
  const rows: CapacityRow[] = await capacityRows_read(context.driver, region, families, cache);
  const model: CapacityModel = { region, rows };
  if (rows.length === 0) return envelope_ok(`capacity in ${region}: no limits for ${families.join(', ')}\n`, { kind: STRATUS_CAPACITY_MODEL_KIND, data: model });
  const limitWidth: number = Math.max(...rows.map((row: CapacityRow): number => row.limit.length));
  const zoneWidth: number = Math.max(...rows.map((row: CapacityRow): number => (row.zone ?? 'region').length));
  const text: string = [`capacity in ${region}`, ...rows.map((row: CapacityRow): string => row_line(row, limitWidth, zoneWidth))].join('\n');
  return envelope_ok(`${text}\n`, { kind: STRATUS_CAPACITY_MODEL_KIND, data: model });
}

/** `capacity`'s help. */
export const CAPACITY_HELP: CommandHelp = {
  usage: 'capacity [<family>…]',
  summary: 'What the region has free for a shape family, per zone',
  category: 'Resources',
  description: 'For each shape family named (or, with none, each family a cluster\'s spec names), the limits its shapes draw on in the session\'s region, at every zone they are kept in: what is permitted and, when the cloud says, how much is free. The same facts are under regions/<region>/limits.',
  examples: ['capacity', 'capacity E5 A1'],
};
