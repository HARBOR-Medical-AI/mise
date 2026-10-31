/**
 * @file The TD controller's model: what the screen draws, read from the
 * session's answers (docs/stratus.adoc, D13), and the lines its controls
 * send. Pure of DOM.
 *
 * A cluster is what `cluster status` answers for it, and the
 * `stratus.cluster.state` events a build shows between those reads; an event
 * carries no live counts and no cost, so those stay from the last read. SIZE
 * redraws fit and cost from what `cluster size` read once: presentation only,
 * the engine checks again when COMMIT sends `cluster new`.
 *
 * @module
 */
import type { ClusterSizeModel, ClusterSpecModel, ClusterSummary } from '@fnndsc/menu';

/** The views the gutter offers, in its order. */
export type ControllerView = 'overview' | 'size' | 'build' | 'cluster' | 'chris' | 'teardown';

/** The views, in the gutter's order. */
export const CONTROLLER_VIEWS: ReadonlyArray<ControllerView> = ['overview', 'size', 'build', 'cluster', 'chris', 'teardown'];

/** The steps that are ChRIS on the cluster, drawn on CHRIS. */
export const CHRIS_STEPS: ReadonlyArray<string> = ['chris-deploy', 'chris-seed', 'smoke'];

/** The hours a month is billed as (`harbor-oci`'s reckoning, as stratus's `spend`). */
export const HOURS_PER_MONTH: number = 730;

/** Volume performance units per GiB, by the spec's tier names. */
const TIER_VPUS: Readonly<Record<string, number>> = { balanced: 10, higher: 20, ultra: 30 };

/** The load balancers a cluster makes (api-int, api, apps), each at its minimum bandwidth. */
const BALANCERS: number = 3;
const BALANCER_MBPS: number = 10;

/**
 * A cluster after an event: the event's fields over what was known, keeping
 * the live counts and the cost an event does not carry.
 *
 * @param known - The cluster as last drawn, if it was.
 * @param shown - The event's summary.
 * @returns The merged cluster.
 */
export function summary_merge(known: ClusterSummary | undefined, shown: ClusterSummary): ClusterSummary {
  if (known === undefined) return shown;
  return {
    ...known,
    ...shown,
    resources: shown.resources ?? known.resources,
    cost: shown.cost !== undefined ? shown.cost : known.cost,
  };
}

/**
 * Money as the screen says it: `$0.62`, or `EUR 0.62`.
 *
 * @param amount - The amount.
 * @param currency - Its currency.
 * @param places - Decimal places.
 * @returns The text.
 */
export function money_text(amount: number, currency: string, places: number = 2): string {
  return `${currency === 'USD' ? '$' : `${currency} `}${amount.toFixed(places)}`;
}

/**
 * A length of time in the screen's words: `42s`, `12m`, `3h 10m`, `2d 4h`.
 *
 * @param ms - The length.
 * @returns The text.
 */
export function duration_text(ms: number): string {
  const seconds: number = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes: number = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours: number = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** What a cluster is, in the badge beside its name. */
export function classBadge_render(cluster: ClusterSummary): string {
  if (cluster.origin === 'found') return cluster.condition === 'GONE' ? 'FOUND · NOTHING LEFT' : 'FOUND · NOT ADOPTED';
  if (cluster.origin === 'adopted') return 'ADOPTED · PLANS ONLY';
  if (cluster.origin === 'checkout') return 'CHECKOUT · READ ONLY';
  if (cluster.gone !== null && cluster.gone !== undefined) return 'TORN DOWN';
  return 'BUILT HERE';
}

/**
 * The line under CONDITION: whether money runs, and why the cluster is as it is.
 *
 * @param cluster - The cluster.
 * @returns The line, and whether it says billing (drawn orange).
 */
export function conditionWhy_derive(cluster: ClusterSummary): { text: string; billing: boolean } {
  const billing: boolean = cluster.billing === true;
  const why: string = cluster.origin === 'adopted' ? 'ADOPTED' : cluster.origin === 'checkout' ? 'READ FROM A CHECKOUT'
    : cluster.condition === 'GONE' ? 'TORN DOWN' : cluster.condition === 'SIZING' ? 'NOTHING BUILT'
    : cluster.condition === 'STOPPED' ? (!billing && cluster.next === cluster.billingStep ? 'PLANNED' : 'NOT FINISHED') : cluster.condition ?? '';
  return billing ? { text: `BILLING · ${why}`, billing } : { text: `${why} · NOTHING BILLED`, billing };
}

/** One step as drawn on the grid and the strip. */
export interface StepLook {
  /** Its number in build order, two digits. */
  n: string;
  name: string;
  /** The word under it. */
  word: string;
  /** How it is drawn. */
  tone: 'done' | 'running' | 'failed' | 'asking' | 'next' | 'later' | 'unknown' | 'expired';
  /** What it rests on, in a line. */
  note: string;
  /** Whether billing starts at it: the line is drawn before it. */
  billFrom: boolean;
}

/**
 * Each step, as the grid and the strip draw it.
 *
 * @param cluster - The cluster.
 * @returns The steps in build order.
 */
export function stepLooks_build(cluster: ClusterSummary): StepLook[] {
  return cluster.steps.map((step, index: number): StepLook => {
    const name: string = step.name ?? step.folder.replace(/^\d+-/, '');
    const n: string = String(index + 1).padStart(2, '0');
    const note: string = noteShort_format(step.evidence ?? '');
    const billFrom: boolean = name === cluster.billingStep;
    const look = (word: string, tone: StepLook['tone']): StepLook => ({ n, name, word, tone, note, billFrom });
    if (step.state === 'done') return look('DONE', 'done');
    if (step.state === 'running') return look('RUNNING', 'running');
    if (step.state === 'failed') return look('FAILED', 'failed');
    if (step.state === 'expired') return look('EXPIRED', 'expired');
    if (step.state === 'unknown') return look('UNKNOWN', 'unknown');
    if (name === cluster.next) return cluster.asking !== null && cluster.asking !== undefined ? look('ASKING', 'asking') : look('NEXT', 'next');
    return look('NOT DONE', 'later');
  });
}

/**
 * A step's evidence cut to what a cell has room for: what `harbor-oci` said
 * of an adopted step, without the preamble.
 *
 * @param evidence - The evidence.
 * @returns The short form.
 */
export function noteShort_format(evidence: string): string {
  const adopted: RegExpMatchArray | null = evidence.match(/^done before adoption \(harbor-oci: [a-z ]+, (.*)\)$/);
  const text: string = adopted?.[1] ?? evidence;
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** How many steps are done, of how many. */
export function stepsDone_count(cluster: ClusterSummary): { done: number; total: number } {
  return { done: cluster.steps.filter((step): boolean => step.state === 'done').length, total: cluster.steps.length };
}

/** One row of SINCE LAST COMMAND. */
export interface SinceRow {
  label: string;
  text: string;
}

/**
 * What changed between two reads of a cluster, as SINCE LAST COMMAND says it.
 *
 * @param before - The cluster when the last command was sent, or null.
 * @param after - The cluster now.
 * @returns At most three rows; one saying nothing changed when nothing did.
 */
export function since_build(before: ClusterSummary | null, after: ClusterSummary): SinceRow[] {
  if (before === null) return [{ label: '', text: 'FIRST READ' }];
  const rows: SinceRow[] = [];
  if (before.condition !== after.condition) rows.push({ label: 'CONDITION', text: `${before.condition ?? '?'} → ${after.condition ?? '?'}` });
  const stepsBefore: Map<string, string> = new Map(before.steps.map((step): [string, string] => [step.name ?? step.folder, step.state]));
  const moved = after.steps.filter((step): boolean => stepsBefore.get(step.name ?? step.folder) !== step.state);
  for (const step of moved.slice(-2)) rows.push({ label: (step.name ?? step.folder).toUpperCase(), text: `${(stepsBefore.get(step.name ?? step.folder) ?? 'NONE').toUpperCase()} → ${step.state.toUpperCase()}` });
  const verify = (cluster: ClusterSummary): string | null => cluster.verify === null || cluster.verify === undefined ? null : verifyWords_render(cluster.verify.checks);
  if (verify(before) !== verify(after)) rows.push({ label: 'VERIFY', text: verify(after) ?? 'NOT RUN' });
  const plan = (cluster: ClusterSummary): string | null => cluster.plan === null || cluster.plan === undefined ? null : planWords_render(cluster.plan);
  if (plan(before) !== plan(after)) rows.push({ label: 'PLAN', text: plan(after) ?? 'NONE' });
  const hourly = (cluster: ClusterSummary): string | null => cluster.cost === null || cluster.cost === undefined ? null : money_text(cluster.cost.hourly, cluster.cost.currency);
  if (hourly(before) !== hourly(after) && hourly(before) !== null && hourly(after) !== null) rows.push({ label: 'PER HOUR', text: `${hourly(before)} → ${hourly(after)}` });
  if (before.protected !== after.protected) rows.push({ label: 'LOCK', text: after.protected === false ? 'OFF' : 'ON' });
  return rows.length === 0 ? [{ label: '', text: 'NO CHANGE' }] : rows.slice(0, 3);
}

/**
 * Verify's checks in a phrase.
 *
 * @param checks - The checks.
 * @returns `10 OF 10 PASS`, `9 OF 10 PASS · 1 FAIL`.
 */
export function verifyWords_render(checks: ReadonlyArray<{ ok: boolean | null }>): string {
  const passed: number = checks.filter((check): boolean => check.ok === true).length;
  const failed: number = checks.filter((check): boolean => check.ok === false).length;
  const skipped: number = checks.length - passed - failed;
  return `${passed} OF ${checks.length} PASS${failed > 0 ? ` · ${failed} FAIL` : ''}${skipped > 0 ? ` · ${skipped} NOT RUN` : ''}`;
}

/**
 * A plan's counts in a phrase, drift apart.
 *
 * @param plan - The plan.
 * @returns `52 + · 0 ~ · 0 −`, `0 + · 6 ~ TAG DRIFT · 0 −`.
 */
export function planWords_render(plan: NonNullable<ClusterSummary['plan']>): string {
  const real: number = plan.change + plan.replace;
  const change: string = real > 0 || plan.drift === 0 ? `${real} ~` : '';
  const drift: string = plan.drift > 0 ? `${plan.drift} ~ TAG DRIFT` : '';
  return [`${plan.create} +`, change, drift, `${plan.destroy} −`].filter((part: string): boolean => part !== '').join(' · ');
}

/**
 * A zone's short name: after the cloud's prefix (`disG:US-ASHBURN-AD-1` reads `AD-1`).
 *
 * @param zone - The zone.
 * @returns The short form.
 */
export function zoneShort_format(zone: string): string {
  const bare: string = zone.includes(':') ? zone.slice(zone.indexOf(':') + 1) : zone;
  const ad: RegExpMatchArray | null = bare.match(/AD-\d+$/i);
  return ad !== null ? ad[0].toUpperCase() : bare;
}

/** One zone's fit, as SIZE draws it. */
export interface ZoneFitLook {
  zone: string;
  /** The machines placed there. */
  nodes: string[];
  coresNeeded: number;
  coresFree: number | null;
  memoryNeeded: number;
  memoryFree: number | null;
  /** Null when the cloud did not say what is free. */
  fits: boolean | null;
  /** Whether it has the least room left after. */
  tightest: boolean;
}

/**
 * Whether a spec fits each zone: the planes one per zone, the workers round
 * the zones, each needing its cores and memory (stratus's `specFit_read`, as
 * presentation).
 *
 * @param size - What `cluster size` read.
 * @param spec - The spec as the levers stand.
 * @param name - The cluster's name, for the machines'.
 * @returns One per zone.
 */
export function sizeFit_compute(size: ClusterSizeModel, spec: ClusterSpecModel, name: string): ZoneFitLook[] {
  const count: number = Math.max(size.zones.length, 1);
  const placed: Array<{ name: string; vcpu: number; ramGib: number; zone: number }> = [];
  for (let i: number = 0; i < spec.controlPlane.count; i++) placed.push({ name: `${name}-cp-${i}`, vcpu: spec.controlPlane.vcpu, ramGib: spec.controlPlane.ramGib, zone: i % count });
  for (let i: number = 0; i < spec.workers.count; i++) placed.push({ name: `${name}-w-${i}`, vcpu: spec.workers.vcpu, ramGib: spec.workers.ramGib, zone: i % count });
  const fits: ZoneFitLook[] = size.zones.map((zone, index: number): ZoneFitLook => {
    const here = placed.filter((node): boolean => node.zone === index);
    const coresNeeded: number = here.reduce((sum: number, node): number => sum + node.vcpu / size.vcpuPerCore, 0);
    const memoryNeeded: number = here.reduce((sum: number, node): number => sum + node.ramGib, 0);
    const known: boolean = zone.coresFree !== null && zone.memoryFree !== null;
    return {
      zone: zone.zone, nodes: here.map((node): string => node.name), coresNeeded, coresFree: zone.coresFree, memoryNeeded, memoryFree: zone.memoryFree,
      fits: known ? coresNeeded <= (zone.coresFree as number) && memoryNeeded <= (zone.memoryFree as number) : null, tightest: false,
    };
  });
  const left = (fit: ZoneFitLook): number => fit.coresFree === null ? Infinity : (fit.coresFree - fit.coresNeeded) / Math.max(fit.coresFree, 1);
  const tightest: ZoneFitLook | undefined = [...fits].filter((fit): boolean => fit.coresFree !== null).sort((a, b): number => left(a) - left(b))[0];
  if (tightest !== undefined && fits.length > 1) tightest.tightest = true;
  return fits;
}

/** One line of SIZE's cost. */
export interface CostRow {
  what: string;
  /** Per hour, or null when not priced. */
  hourly: number | null;
}

/**
 * What a spec would cost an hour at list price, by what bills: compute,
 * memory, boot volumes, ChRIS's volumes, the load balancers.
 *
 * @param size - What `cluster size` read.
 * @param spec - The spec as the levers stand.
 * @returns The rows, the total (null when nothing is priced), the currency.
 */
export function sizeCost_compute(size: ClusterSizeModel, spec: ClusterSpecModel): { rows: CostRow[]; hourly: number | null; currency: string } {
  const vcpu: number = spec.controlPlane.count * spec.controlPlane.vcpu + spec.workers.count * spec.workers.vcpu;
  const gib: number = spec.controlPlane.count * spec.controlPlane.ramGib + spec.workers.count * spec.workers.ramGib;
  const volumeHour = (sizeGib: number, tier: string): number | null => size.services === null ? null
    : (sizeGib * (size.services.volumeGibMonth + (TIER_VPUS[tier] ?? 10) * size.services.vpuGibMonth)) / HOURS_PER_MONTH;
  const bootGib: number = spec.controlPlane.count * spec.controlPlane.bootGib + spec.workers.count * spec.workers.bootGib;
  const bootHour: number | null = size.services === null ? null
    : (volumeHour(spec.controlPlane.count * spec.controlPlane.bootGib, spec.controlPlane.bootTier) as number) + (volumeHour(spec.workers.count * spec.workers.bootGib, spec.workers.bootTier) as number);
  const chrisGib: number = spec.chris.dataGib + spec.chris.databaseGib + spec.chris.queueGib;
  const rows: CostRow[] = [
    { what: `COMPUTE · ${vcpu} vCPU`, hourly: size.price === null ? null : vcpu * size.price.vcpuHour },
    { what: `MEMORY · ${gib} GiB`, hourly: size.price === null ? null : gib * size.price.gibHour },
    { what: `BOOT VOLUMES · ${bootGib} GiB`, hourly: bootHour },
    { what: `CHRIS VOLUMES · ${chrisGib} GiB`, hourly: volumeHour(chrisGib, 'balanced') },
    { what: `LOAD BALANCERS · ${BALANCERS}`, hourly: size.services === null ? null : BALANCERS * (size.services.balancerHour + BALANCER_MBPS * size.services.balancerMbpsHour) },
  ];
  const priced: CostRow[] = rows.filter((row: CostRow): boolean => row.hourly !== null);
  return { rows, hourly: priced.length === 0 ? null : priced.reduce((sum: number, row: CostRow): number => sum + (row.hourly as number), 0), currency: size.price?.currency ?? 'USD' };
}

/**
 * The line COMMIT sends: `cluster new` with each option that differs from
 * the spec a new cluster starts from.
 *
 * @param name - The new cluster's name.
 * @param spec - The spec as the levers stand.
 * @param start - The spec a new cluster starts from.
 * @param zone - The DNS zone to name, when it is not the session's default.
 * @returns The line.
 */
export function newLine_build(name: string, spec: ClusterSpecModel, start: ClusterSpecModel, zone: string | null = null): string {
  const words: string[] = ['cluster', 'new', name];
  if (zone !== null) words.push('--base-domain', zone);
  const pool = (one: ClusterSpecModel['controlPlane']): string => `${one.count}x${one.vcpu}/${one.ramGib}`;
  if (spec.family !== start.family) words.push('--family', spec.family);
  if (pool(spec.controlPlane) !== pool(start.controlPlane)) words.push('--plane', pool(spec.controlPlane));
  if (pool(spec.workers) !== pool(start.workers)) words.push('--workers', pool(spec.workers));
  if (spec.chris.dataGib !== start.chris.dataGib) words.push('--data', String(spec.chris.dataGib));
  if (spec.chris.databaseGib !== start.chris.databaseGib) words.push('--database', String(spec.chris.databaseGib));
  if (spec.chris.queueGib !== start.chris.queueGib) words.push('--queue', String(spec.chris.queueGib));
  return words.join(' ');
}

/**
 * A copy of a spec, nothing shared, for levers to move.
 *
 * @param spec - The spec.
 * @returns The copy.
 */
export function spec_copy(spec: ClusterSpecModel): ClusterSpecModel {
  return { family: spec.family, controlPlane: { ...spec.controlPlane }, workers: { ...spec.workers }, chris: { ...spec.chris } };
}

/** A cluster's name is a DNS label: lower-case letters, digits and hyphens, at most 54 (stratus's `CLUSTER_NAME`). */
export const CLUSTER_NAME: RegExp = /^[a-z]([a-z0-9-]{0,52}[a-z0-9])?$/;

/**
 * Whether a name may be a new cluster's, and why not.
 *
 * @param name - The name typed.
 * @param known - The clusters there are.
 * @returns Null when it may; else why not.
 */
export function nameRefusal_derive(name: string, known: ReadonlyArray<string>): string | null {
  if (name === '') return 'NAME IT FIRST';
  if (!CLUSTER_NAME.test(name)) return 'A DNS LABEL: a-z, 0-9 AND -, A LETTER FIRST';
  if (known.includes(name)) return `${name.toUpperCase()} IS TAKEN`;
  return null;
}

/** The lines each control sends, by what it does. */
export const LINES = {
  status: (name: string): string => `cluster ${name}`,
  adopt: (name: string): string => `cluster adopt ${name}`,
  plan: (name: string): string => `cluster plan ${name}`,
  verify: (name: string): string => `cluster verify ${name}`,
  spend: (name: string): string => `spend ${name}`,
  build: (name: string): string => `cluster build ${name}`,
  kill: (job: string): string => `kill ${job}`,
  follow: (name: string): string => `cluster build ${name}`,
  protect: (name: string, on: boolean): string => `cluster protect ${name} ${on ? 'on' : 'off'}`,
  teardown: (name: string): string => `cluster teardown ${name}`,
  size: (family?: string): string => family === undefined ? 'cluster size' : `cluster size --family ${family}`,
  tenant: (name: string): string => `play ~/tenant.mise --param NAME=${name}`,
} as const;

/**
 * How the engine's question is answered on the strip: by pills, or by a typed word.
 *
 * @param message - The question.
 * @returns `yes-no` for a `[y/N]` question, `typed` for anything else.
 */
export function askForm_derive(message: string): 'yes-no' | 'typed' {
  return /\[y\/N\]\s*$/i.test(message.trim()) ? 'yes-no' : 'typed';
}

/**
 * Which cluster a line opens the controller on, when it is the controller's.
 *
 * @param line - The line as typed.
 * @param names - The clusters there are.
 * @returns `''` for bare `cluster` (the controller on the first cluster, or NEW), a name for `cluster <name>`, null for any other line.
 */
export function controllerLine_parse(line: string, names: ReadonlyArray<string>): string | null {
  const words: string[] = line.trim().split(/\s+/);
  if (words[0] !== 'cluster') return null;
  if (words.length === 1) return '';
  if (words.length === 2 && names.includes(words[1] as string)) return words[1] as string;
  return null;
}
