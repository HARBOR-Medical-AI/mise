/**
 * @file The stratus composition's dashboard tiles: OPENSHIFT (each
 * cluster, its last step, a step gone wrong in red; a row opens the TD
 * controller on it), SCRIPTS (each script in the library with where its
 * lines stand; a row opens the script screen on it, D17) and CAPACITY (what
 * the region has free for the shape families the clusters' specs name)
 * (docs/stratus.adoc, D11).
 *
 * Each is asked of the session at paint time, from the commands a terminal
 * runs too: `cluster status`, `ls /scripts` with `play --status`, and
 * `capacity`, through their models. `capacity` walks the region limit by
 * limit the first time, so a paint waits for it only a moment: OPENSHIFT is
 * painted with CAPACITY reading, and the dashboard is painted again when the
 * answer lands.
 *
 * @module
 */
import {
  capacityModelSchema, clustersModelSchema, manifestStatusModelSchema, MANIFEST_STATUS_MODEL_KIND, STRATUS_CAPACITY_MODEL_KIND, STRATUS_CLUSTERS_MODEL_KIND,
  type CapacityModel, type CapacityRow, type ClusterSummary, type ClustersModel, type ManifestStatusModel,
  STRATUS_VM_COST_MODEL_KIND, STRATUS_VM_STATUS_MODEL_KIND, vmCostModelSchema, vmStatusModelSchema, type VmCostModel, type VmCostRate, type VmCostRow, type VmStatusModel, type VmStatusRow,
} from '@fnndsc/menu';
import { counts_words, lines_build, runningStep_find, scriptName_derive, states_count, steps_build, rates_sum } from '../../features/script/model.js';
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
  /** Opens the script screen on the library (`''`) or a script: the lines `scripts` and `scripts open <path>`. */
  script_open: (path: string) => void;
  /** Opens the VM controller on a machine, or on a new one (`''`): the lines `vm <name>` and `vm`. */
  vm_open: (name: string) => void;
  /** Opens home. */
  home_open: () => void;
  /** Runs a line in the console, where its answer is read whole. */
  line_run: (line: string) => void;
  /** Opens the CAPACITY pane on a family, or on every family the region offers when none is named. */
  capacity_open: (family: string) => void;
  /** Told the clusters each paint finds, so the language claims `cluster <name>` before the controller has read them. */
  names_seen?: (names: string[]) => void;
  /** Told the VMs each paint finds, so the language claims `vm <name>` before the controller has read them. */
  vmNames_seen?: (names: string[]) => void;
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

/** One script the library holds, as the tile reads it. */
interface ScriptSeen {
  readonly path: string;
  readonly source: string;
  readonly standing: string;
  /** The step running now (`VM BUILD`), or null. */
  readonly running: string | null;
  /** Its lines as they would run, so a VM finds the script that declares it. */
  readonly lines: ReadonlyArray<string>;
}

/** One VM as the tile reads it: `vm status` with `vm cost` beside it. */
interface VmSeen {
  readonly row: VmStatusRow;
  readonly rate: VmCostRate | null;
}

/**
 * The VMs kept here, with what each bills: `vm status` and `vm cost`, both
 * read from the host's records and the price list. Nothing when the session
 * does not answer.
 *
 * @param ask - Asks the session quietly.
 * @returns The VMs, in the store's order.
 */
async function vms_read(ask: (line: string) => Promise<ExecuteOutcome>): Promise<VmSeen[]> {
  let status: VmStatusModel | null = null;
  let cost: VmCostModel | null = null;
  try { status = model_extract(await ask('vm status'), STRATUS_VM_STATUS_MODEL_KIND, (data) => vmStatusModelSchema.safeParse(data)); } catch { return []; }
  if (status === null) return [];
  try { cost = model_extract(await ask('vm cost'), STRATUS_VM_COST_MODEL_KIND, (data) => vmCostModelSchema.safeParse(data)); } catch { cost = null; }
  // What a VM bills is what runs of it, priced from what the tenancy answered; a daemon from before that prices the declaration.
  return status.vms.map((row: VmStatusRow): VmSeen => {
    const priced: VmCostRow | undefined = cost?.vms.find((each: VmCostRow): boolean => each.name === row.name);
    return { row, rate: priced?.runs !== undefined ? (priced.runs?.rate ?? null) : (priced?.cost ?? null) };
  });
}

/**
 * The script in the library that declares a VM: the first whose lines carry `vm new <name>`.
 *
 * @param scripts - The library as read.
 * @param name - The VM.
 * @returns Its path, or null when no script declares it.
 */
export function vmScript_find(scripts: ReadonlyArray<ScriptSeen>, name: string): string | null {
  const declares: RegExp = new RegExp(`^vm new ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
  return scripts.find((script: ScriptSeen): boolean => script.lines.some((line: string): boolean => declares.test(line)))?.path ?? null;
}

/**
 * The scripts under `/scripts/<source>/`, each with where its lines stand:
 * `ls /scripts`, `ls` each folder, `play <script> --status` for each. Every
 * read is of the host's records; a folder or script that does not answer is
 * left out.
 *
 * @param ask - Asks the session quietly.
 * @returns The scripts, in the library's order.
 */
async function scripts_read(ask: (line: string) => Promise<ExecuteOutcome>): Promise<ScriptSeen[]> {
  const items = (answer: ExecuteOutcome): Array<{ name: string; type: string }> => {
    for (const envelope of answer.envelopes) {
      if (envelope.model?.kind !== 'fs.listing' || !Array.isArray(envelope.model.data)) continue;
      const first: unknown = envelope.model.data[0];
      const listed: unknown = (first as { items?: unknown } | undefined)?.items;
      return Array.isArray(listed) ? (listed as Array<{ name: string; type: string }>) : [];
    }
    return [];
  };
  const seen: ScriptSeen[] = [];
  let folders: string[] = [];
  try { folders = items(await ask('ls /scripts')).map((item): string => item.name); } catch { return seen; }
  for (const folder of folders) {
    let scripts: string[] = [];
    try { scripts = items(await ask(`ls /scripts/${folder}`)).filter((item): boolean => item.type === 'script' || item.name.endsWith('.mise')).map((item): string => item.name); } catch { continue; }
    for (const name of scripts) {
      const path: string = `/scripts/${folder}/${name}`;
      let standing: string = 'NOT READ';
      let running: string | null = null;
      let texts: string[] = [];
      try {
        const status: ManifestStatusModel | null = model_extract(await ask(`play ${path} --status`), MANIFEST_STATUS_MODEL_KIND, (data) => manifestStatusModelSchema.safeParse(data));
        if (status !== null) {
          texts = status.lines.map((line): string => line.text);
          const lines = lines_build(texts.join('\n'), status.lines);
          running = runningStep_find(steps_build(lines))?.label ?? null;
          // A script with a step running says so in place of its counts: the run is what matters to a glance.
          standing = running === null ? counts_words(states_count(lines)) : `RUNNING · ${running}`;
        }
      } catch {
        // The tile shows the script and says its standing was not read.
      }
      seen.push({ path, source: folder, standing, running, lines: texts });
    }
  }
  return seen;
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
    const [clustersAnswer, capacityAnswer, scripts, vms]: [ExecuteOutcome, ExecuteOutcome | null, ScriptSeen[], VmSeen[]] = await Promise.all([
      hooks.ask('cluster status'),
      answer_awaitFor(capacity_ask(), hooks.capacityGraceMs ?? CAPACITY_GRACE_MS),
      scripts_read(hooks.ask),
      vms_read(hooks.ask),
    ]);
    const capacityReading: boolean = capacityAnswer === null;
    if (capacityReading) repaintOwed = true;
    const clustersModel: ClustersModel | null = model_extract(clustersAnswer, STRATUS_CLUSTERS_MODEL_KIND, (data) => clustersModelSchema.safeParse(data));
    const clusters: ClusterSummary[] = clustersModel?.clusters ?? [];
    if (clustersModel !== null) hooks.names_seen?.(clusters.map((cluster: ClusterSummary): string => cluster.name));
    hooks.vmNames_seen?.(vms.map((vm: VmSeen): string => vm.row.name));
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
        text: `${cluster.name}  ${cluster.condition === 'GONE' ? 'GONE' : cluster.condition === 'TEARING DOWN' || cluster.condition === 'PARTLY TORN' ? cluster.condition : cluster.origin === 'found' ? `${cluster.condition ?? 'FOUND'} · NOT ADOPTED` : cluster.lastDone ?? 'NOTHING DONE'}${cluster.cost !== undefined && cluster.cost !== null ? `  ${money_text(cluster.cost.hourly, cluster.cost.currency)}/h` : ''}  ${cluster.cluster ?? ''}`.trimEnd(),
        errored: wrong(cluster),
        // A row is that cluster's line: the TD controller opens on it (docs/stratus.adoc, D13).
        open: (): void => hooks.cluster_open(cluster.name),
      })),
      verb: 'OPEN THE CONTROLLER',
      about: TILE_ABOUT['clusters'],
      // The tile is the TD controller's door: `cluster`, on the cluster the controller chooses (docs/stratus.adoc, D13).
      enter: (): void => hooks.cluster_open(''),
    };

    // VIRTUAL MACHINES: what `vm status` lists (the VMs the tenancy runs, and those this session keeps), each with the ChRIS on it or its address and what it bills; a row opens the
    // script that declares the VM, its VM BUILD seat the way in (docs/stratus.adoc, D16 and D17).
    const billed: VmSeen[] = vms.filter((vm: VmSeen): boolean => vm.rate !== null && vm.row.state !== 'gone' && vm.row.state !== 'declared');
    const vmHourly: VmCostRate | null = rates_sum(billed.map((vm: VmSeen): VmCostRate | null => vm.rate));
    const vmsTile: LauncherTile = {
      key: 'vms', name: 'VIRTUAL MACHINES', hue: '--daybreak', numeral: '',
      figures: [
        { text: vms.length === 0 ? 'NONE' : `${vms.length} VM${vms.length === 1 ? '' : 'S'}` },
        ...(vms.some((vm: VmSeen): boolean => vm.row.state === 'built') ? [{ text: `${vms.filter((vm: VmSeen): boolean => vm.row.state === 'built').length} BUILT` }] : []),
        ...(vmHourly !== null ? [{ text: `${money_text(vmHourly.machineHour + vmHourly.dataHour, vmHourly.currency)}/H` }] : []),
      ],
      rows: vms.slice(0, 6).map((vm: VmSeen): LauncherRow => {
        const where: string = vm.row.chris?.host ?? vm.row.address ?? (vm.row.spec === null ? '' : `${vm.row.spec.vcpu} vCPU · ${vm.row.spec.memory} GiB`);
        const rate: string = vm.rate === null ? '' : `  ${money_text(vm.rate.machineHour + vm.rate.dataHour, vm.rate.currency)}/h`;
        // A VM the tenancy runs that this session keeps no record of says so, and what the cloud says it is doing.
        const state: string = vm.row.state === 'found' ? `FOUND · ${(vm.row.found?.state ?? 'unknown').toUpperCase()}` : vm.row.state.toUpperCase();
        return {
          text: `${vm.row.name}  ${state}  ${where}${rate}`.trimEnd(),
          errored: false,
          // A row is its machine's line: the VM controller opens on it (docs/stratus.adoc, D17 revised).
          open: (): void => hooks.vm_open(vm.row.name),
        };
      }),
      verb: 'OPEN THE VM CONTROLLER',
      about: TILE_ABOUT['vms'],
      // The tile is the controller's door: `vm`, on a new machine.
      enter: (): void => hooks.vm_open(''),
    };

    // SCRIPTS: the library, each script with where its lines stand; the tile is the script screen's door (docs/stratus.adoc, D17).
    const scriptsTile: LauncherTile = {
      key: 'scripts', name: 'SCRIPTS', hue: '--harvestgold', numeral: '',
      figures: [
        { text: scripts.length === 0 ? 'NONE' : `${scripts.length} SCRIPT${scripts.length === 1 ? '' : 'S'}` },
        ...(scripts.some((script: ScriptSeen): boolean => script.running !== null) ? [{ text: 'A STEP RUNS' }] : []),
        ...(scripts.some((script: ScriptSeen): boolean => /CHANGED/.test(script.standing)) ? [{ text: 'CHANGED UNDER A BUILD', errored: true }] : []),
      ],
      rows: scripts.slice(0, 6).map((script: ScriptSeen): LauncherRow => ({
        text: `${scriptName_derive(script.path)}  ${script.source.toUpperCase()}  ${script.standing}`,
        errored: /CHANGED/.test(script.standing),
        open: (): void => hooks.script_open(script.path),
      })),
      verb: 'OPEN THE LIBRARY',
      about: TILE_ABOUT['scripts'],
      enter: (): void => hooks.script_open(''),
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
      afterFiles: [vmsTile, scriptsTile, capacityTile],
      afterPanes: [],
      about: { files: { text: 'Your home: the clusters this session knows, each a folder of its spec, settings, state and steps.' } },
    };
  };
}
