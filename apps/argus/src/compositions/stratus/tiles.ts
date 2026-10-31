/**
 * @file The stratus composition's dashboard tiles: OPENSHIFT (each
 * cluster, its last step, a step gone wrong in red; a row opens the TD
 * controller on it) and CAPACITY (what the
 * region has free for the shape families the clusters' specs name)
 * (docs/stratus.adoc, D11).
 *
 * Each is asked of the session at paint time, from the commands a terminal
 * runs too: `cluster status` and `capacity`, through their models. `capacity`
 * walks the region limit by limit the first time, so a paint waits for it
 * only a moment: OPENSHIFT is painted with CAPACITY reading, and the dashboard
 * is painted again when the answer lands.
 *
 * @module
 */
import {
  capacityModelSchema, clustersModelSchema, STRATUS_CAPACITY_MODEL_KIND, STRATUS_CLUSTERS_MODEL_KIND,
  type CapacityModel, type CapacityRow, type ClusterSummary, type ClustersModel,
} from '@fnndsc/menu';
import type { ExecuteOutcome } from '../../calypso/client.js';
import { TILE_ABOUT } from '../../features/launcher/about.js';
import type { LauncherRow, LauncherTile } from '../../features/launcher/panel.js';
import type { TileContribution } from '../../app/dashboardTiles.js';

/** What the stratus tiles reach. */
export interface StratusTileHooks {
  /** Asks the session a line, quietly. */
  ask: (line: string) => Promise<ExecuteOutcome>;
  /** Opens the TD controller on a cluster: the line `cluster <name>`. */
  cluster_open: (name: string) => void;
  /** Opens home. */
  home_open: () => void;
  /** Runs a line in the console, where its answer is read whole. */
  line_run: (line: string) => void;
  /** Opens the CAPACITY pane on a family, or on every family the region offers when none is named. */
  capacity_open: (family: string) => void;
  /** Told the clusters each paint finds, so the language claims `cluster <name>` before the controller has read them. */
  names_seen?: (names: string[]) => void;
  /** Paints the dashboard again: called once a `capacity` a paint did not wait for has answered. */
  repaint?: () => void;
  /** How long a paint waits for `capacity`; {@link CAPACITY_GRACE_MS} when absent. */
  capacityGraceMs?: number;
}

/** How long a paint waits for `capacity` before painting without it. */
export const CAPACITY_GRACE_MS: number = 1500;

/**
 * An answer, or null when it has not come within the grace.
 *
 * @param pending - The answer on its way.
 * @param graceMs - How long to wait.
 * @returns The answer, or null.
 */
function answer_awaitFor(pending: Promise<ExecuteOutcome>, graceMs: number): Promise<ExecuteOutcome | null> {
  return new Promise<ExecuteOutcome | null>((resolve: (answer: ExecuteOutcome | null) => void): void => {
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => resolve(null), graceMs);
    pending.then(
      (answer: ExecuteOutcome): void => { clearTimeout(timer); resolve(answer); },
      (): void => { clearTimeout(timer); resolve(null); },
    );
  });
}

/** The step states a tile draws as gone wrong. */
const WRONG_STATES: ReadonlyArray<string> = ['expired', 'failed', 'error'];

/** The model of a kind an answer carries, parsed; null when it carries none. */
function model_extract<T>(answer: ExecuteOutcome, kind: string, parse: (data: unknown) => { success: boolean; data?: T }): T | null {
  for (const envelope of answer.envelopes) {
    if (envelope.model?.kind !== kind) continue;
    const parsed = parse(envelope.model.data);
    if (parsed.success && parsed.data !== undefined) return parsed.data;
  }
  return null;
}

/**
 * A zone as a tile has room for: the part after the cloud's prefix
 * (`disG:US-ASHBURN-AD-1` reads `US-ASHBURN-AD-1`).
 *
 * @param zone - The zone, or null for region-wide.
 * @returns The short form.
 */
export function zoneShort_format(zone: string | null): string {
  if (zone === null) return 'REGION';
  return zone.includes(':') ? zone.slice(zone.indexOf(':') + 1) : zone;
}

/**
 * A limit as a tile has room for: its measure, the family and `count` dropped
 * (`standard-e5-core-count` reads `core`).
 *
 * @param row - The capacity row.
 * @returns The short form.
 */
export function limitShort_format(row: CapacityRow): string {
  return row.limit.replace(new RegExp(`^(standard-)?${row.family.toLowerCase()}-`), '').replace(/-count$/, '');
}

/** One capacity row as a tile row's text. */
function capacityRow_text(row: CapacityRow): string {
  const free: string = row.available === null ? `${row.value} PERMITTED` : `${row.available} / ${row.value} FREE`;
  return `${row.family.toUpperCase()}  ${zoneShort_format(row.zone)}  ${limitShort_format(row)}  ${free}`;
}

/**
 * Money on a tile: `$0.62`, or `EUR 0.62`.
 *
 * @param amount - The amount.
 * @param currency - Its currency.
 * @returns The text.
 */
export function money_text(amount: number, currency: string): string {
  return `${currency === 'USD' ? '$' : `${currency} `}${amount.toFixed(2)}`;
}

/**
 * Makes the stratus tiles' source: asked each time the dashboard paints.
 *
 * @param hooks - What the tiles reach.
 * @returns The source.
 */
export function stratusTiles_make(hooks: StratusTileHooks): () => Promise<TileContribution> {
  // One `capacity` at a time: a paint that comes while one is on its way
  // waits on that one, and a paint that went without it is owed a repaint.
  let capacityPending: Promise<ExecuteOutcome> | null = null;
  let repaintOwed: boolean = false;
  const capacity_ask = (): Promise<ExecuteOutcome> => {
    if (capacityPending !== null) return capacityPending;
    const asked: Promise<ExecuteOutcome> = hooks.ask('capacity');
    capacityPending = asked;
    const settled = (): void => {
      if (capacityPending === asked) capacityPending = null;
      if (!repaintOwed) return;
      repaintOwed = false;
      hooks.repaint?.();
    };
    asked.then(settled, settled);
    return asked;
  };
  return async (): Promise<TileContribution> => {
    const [clustersAnswer, capacityAnswer]: [ExecuteOutcome, ExecuteOutcome | null] = await Promise.all([
      hooks.ask('cluster status'),
      answer_awaitFor(capacity_ask(), hooks.capacityGraceMs ?? CAPACITY_GRACE_MS),
    ]);
    const capacityReading: boolean = capacityAnswer === null;
    if (capacityReading) repaintOwed = true;
    const clustersModel: ClustersModel | null = model_extract(clustersAnswer, STRATUS_CLUSTERS_MODEL_KIND, (data) => clustersModelSchema.safeParse(data));
    const clusters: ClusterSummary[] = clustersModel?.clusters ?? [];
    if (clustersModel !== null) hooks.names_seen?.(clusters.map((cluster: ClusterSummary): string => cluster.name));
    const wrong = (cluster: ClusterSummary): boolean => cluster.steps.some((step): boolean => WRONG_STATES.includes(step.state));
    const wrongCount: number = clusters.filter(wrong).length;
    // What the clusters cost an hour together, at list price, when the daemon priced them.
    const priced: ClusterSummary[] = clusters.filter((cluster: ClusterSummary): boolean => cluster.cost !== undefined && cluster.cost !== null);
    const hourly: number = priced.reduce((sum: number, cluster: ClusterSummary): number => sum + (cluster.cost?.hourly ?? 0), 0);
    // One with nothing left of it but its tag is counted apart: it is not a cluster anyone can use.
    const goneCount: number = clusters.filter((cluster: ClusterSummary): boolean => cluster.condition === 'GONE').length;
    const standing: number = clusters.length - goneCount;
    const clustersTile: LauncherTile = {
      key: 'clusters', name: 'OPENSHIFT', hue: '--october-sunset', numeral: '',
      figures: [
        { text: standing === 0 ? 'NONE' : `${standing} CLUSTER${standing === 1 ? '' : 'S'}` },
        ...(goneCount > 0 ? [{ text: `${goneCount} GONE` }] : []),
        ...(wrongCount > 0 ? [{ text: `${wrongCount} NEED${wrongCount === 1 ? 'S' : ''} A LOOK`, errored: true }] : []),
        ...(priced.length > 0 ? [{ text: `${money_text(hourly, priced[0]?.cost?.currency ?? 'USD')}/H` }] : []),
      ],
      rows: clusters.slice(0, 6).map((cluster: ClusterSummary): LauncherRow => ({
        // The rate before the cluster's long name, so a narrow tile cuts the name, not the money.
        text: `${cluster.name}  ${cluster.condition === 'GONE' ? 'GONE' : cluster.origin === 'found' ? `${cluster.condition ?? 'FOUND'} · NOT ADOPTED` : cluster.lastDone ?? 'NOTHING DONE'}${cluster.cost !== undefined && cluster.cost !== null ? `  ${money_text(cluster.cost.hourly, cluster.cost.currency)}/h` : ''}  ${cluster.cluster ?? ''}`.trimEnd(),
        errored: wrong(cluster),
        // A row is that cluster's line: the TD controller opens on it (docs/stratus.adoc, D13).
        open: (): void => hooks.cluster_open(cluster.name),
      })),
      verb: 'OPEN THE CONTROLLER',
      about: TILE_ABOUT['clusters'],
      // The tile is the TD controller's door: `cluster`, on the cluster the controller chooses (docs/stratus.adoc, D13).
      enter: (): void => hooks.cluster_open(''),
    };

    const capacity: CapacityModel | null = capacityAnswer === null ? null : model_extract(capacityAnswer, STRATUS_CAPACITY_MODEL_KIND, (data) => capacityModelSchema.safeParse(data));
    const capacityTile: LauncherTile = {
      key: 'capacity', name: 'CAPACITY', hue: '--honey', numeral: '',
      // Still reading: the region is walked limit by limit, and this paint did not wait; the next one shows it.
      figures: capacity === null ? [{ text: capacityReading ? 'READING' : 'NOT READ' }] : [{ text: capacity.region.toUpperCase() }],
      // With nothing read, the block still opens the pane, which asks again.
      rows: capacity === null
        ? [{ text: 'capacity', open: (): void => hooks.capacity_open('') }]
        : capacity.rows.slice(0, 6).map((row: CapacityRow): LauncherRow => ({
          text: capacityRow_text(row),
          errored: row.available === 0,
          // A row is its family's line: the CAPACITY pane opens on it (#1284).
          open: (): void => hooks.capacity_open(row.family),
        })),
      verb: 'OPEN CAPACITY',
      about: TILE_ABOUT['capacity'],
      enter: (): void => hooks.capacity_open(''),
    };
    return {
      lead: { tile: clustersTile, weight: clusters.length },
      afterFiles: [capacityTile],
      afterPanes: [],
      about: { files: { text: 'Your home: the clusters this session knows, each a folder of its spec, settings, state and steps.' } },
    };
  };
}
