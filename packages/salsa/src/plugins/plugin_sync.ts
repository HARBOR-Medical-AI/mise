/**
 * @file Filling a CUBE from a plugin index: `plugin sync`.
 *
 * A sync is a plan, then the plan's adds. The plan compares every descriptor
 * in the index with what the connected CUBE holds and puts each plugin in
 * one group:
 *
 * | group | what it means | action |
 * |---|---|---|
 * | add | not in the CUBE | add |
 * | newer | the index has a newer version | add beside the older one |
 * | skip | same name and version, same descriptor | nothing |
 * | cubeNewer | the CUBE has a newer version | report |
 * | drift | same name and version, different descriptor | report, never touched |
 * | imageTaken | the image is registered under another version | report: CUBE would refuse it |
 * | cubeOnly | in the CUBE, not in the index | report |
 * | invalid | fails rules 1–4 of `plugin validate` | report, never uploaded |
 *
 * A sync never deletes and never changes a plugin already there: deleting
 * cascades to its runs and to its nodes in every pipeline, and CUBE's admin
 * `PUT` changes only compute resources, so a descriptor cannot be corrected
 * in place anyway. Drift ignores what only reflects CUBE's defaults (a limit
 * the index leaves out because it equals the default, `1000m` against a
 * stored `1000`, a field CUBE fills in when it is not given).
 *
 * Applying uploads the plan's adds four at a time, each failure contained to
 * its plugin; what landed stays, so a rerun continues where a stopped one
 * left off. Every CUBE read and the upload go through {@link SyncSeams}, so
 * the plan and the apply are testable without a CUBE.
 *
 * Key components:
 * - SyncGroup / SyncPlanEntry / SyncPlan: the plan.
 * - SyncResult / SyncReceipt: what applying it did.
 * - SyncSeams / syncSeams_cube: the CUBE reads and the upload.
 * - syncPlan_build: compare an index with the CUBE.
 * - syncPlanAdds_list: the entries a plan would upload.
 * - syncPlan_apply: upload them, four at a time.
 * - descriptorDrift_find: how two descriptors of one version differ, defaults aside.
 * - version_compare: dotted-number ordering.
 *
 * Typical usage:
 * ```ts
 * const plan: SyncPlan = await syncPlan_build(index, ['host'], syncSeams_cube);
 * const receipt: SyncReceipt = await syncPlan_apply(plan, syncSeams_cube, (r: SyncResult): void => console.log(r));
 * ```
 *
 * Dependencies: cumin's CUBE reads (plugin pages, parameters) and the
 * administrative upload; the index and its local checks.
 *
 * @module
 */

import {
  chrisConnection,
  errorStack,
  listPages_drain,
  plugin_find,
  pluginParameters_drain,
  pluginsPage_get,
  type Client,
  type ListPage,
  type PluginData,
  type PluginFound,
  type Result,
} from '@fnndsc/cumin';

import { plugin_addDescriptor } from './plugin_add.js';
import type { PluginIndex } from './plugin_index.js';
import { descriptors_checkLocal, type DescriptorChecked, type LocalCheck, type ValidateFinding } from './plugin_validate.js';
import { items_mapPooled, POOL_WIDTH } from './pool.js';

/** CUBE's stand-in for "no limit" (Python's maxint, as `Plugin.defaults['max_limit']`). */
const MAX_LIMIT: number = 2_147_483_647;

/** What CUBE stores for a limit a descriptor leaves out (`plugins/models.py`). */
const LIMIT_DEFAULTS: Readonly<Record<string, number>> = {
  min_number_of_workers: 1,
  max_number_of_workers: MAX_LIMIT,
  min_cpu_limit: 1000,
  max_cpu_limit: MAX_LIMIT,
  min_memory_limit: 200,
  max_memory_limit: MAX_LIMIT,
  min_gpu_limit: 0,
  max_gpu_limit: 0,
};

/**
 * Plugin fields compared as text; a field the index leaves out is not
 * compared. The plugin-meta fields (title, authors, license, …) belong to
 * the name, not the version, and a newer upload rewrites them, so they are
 * not a version's drift.
 */
const TEXT_FIELDS: readonly string[] = ['dock_image', 'type', 'execshell', 'selfpath', 'selfexec', 'description'];

/** Parameter fields compared; one the index leaves out is CUBE's to fill. */
const PARAMETER_FIELDS: readonly string[] = ['type', 'optional', 'flag', 'short_flag', 'action', 'help', 'ui_exposed', 'default'];

/** The read API's parameter types, in the upload's spelling (`plugins/enums.py`). */
const READ_TYPES: Readonly<Record<string, string>> = { string: 'str', integer: 'int', boolean: 'bool', float: 'float', path: 'path', unextpath: 'unextpath' };

/** The groups a plan's entries fall in, in the order a plan lists them. */
export const SYNC_GROUPS = ['add', 'newer', 'skip', 'cubeNewer', 'drift', 'imageTaken', 'cubeOnly', 'invalid'] as const;

/** One group of the plan. */
export type SyncGroup = typeof SYNC_GROUPS[number];

/** The groups that upload. */
export const SYNC_ADD_GROUPS: readonly SyncGroup[] = ['add', 'newer'];

/**
 * One plugin's place in the plan.
 *
 * @example
 * ```ts
 * const entry: SyncPlanEntry = { group: 'newer', name: 'pl-x', version: '1.2.0', cubeVersions: ['1.1.0'] };
 * ```
 */
export interface SyncPlanEntry {
  /** Its group. */
  readonly group: SyncGroup;
  /** The plugin's name (the file's, for an invalid descriptor that names none). */
  readonly name: string;
  /** The index's version, when the entry comes from the index. */
  readonly version?: string;
  /** The versions the CUBE holds of this name. */
  readonly cubeVersions?: string[];
  /** The index file it comes from. */
  readonly file?: string;
  /** Why it is in a report group, in a line. */
  readonly detail?: string;
  /** The descriptor's text, for the entries that upload. */
  readonly descriptor?: string;
}

/**
 * The plan.
 *
 * @example
 * ```ts
 * const plan: SyncPlan = await syncPlan_build(index, ['host'], seams);
 * plan.entries.filter((e: SyncPlanEntry): boolean => e.group === 'add').length;
 * ```
 */
export interface SyncPlan {
  /** The index's short name (`chris-plugins @ 8c9a1f6`). */
  readonly label: string;
  /** The index's source word. */
  readonly source: string;
  /** The commit read, when known. */
  readonly commit: string | null;
  /** How many descriptors the index holds. */
  readonly indexed: number;
  /** The compute resources adds are registered on. */
  readonly computes: string[];
  /** Every entry, by group then name. */
  readonly entries: SyncPlanEntry[];
}

/**
 * One upload's outcome.
 *
 * @example
 * ```ts
 * const result: SyncResult = { name: 'pl-x', version: '1.2.0', ok: false, reason: 'Plugin with name pl-x and version 1.2.0 already exists.' };
 * ```
 */
export interface SyncResult {
  /** The plugin. */
  readonly name: string;
  /** Its version. */
  readonly version: string;
  /** True when CUBE registered it. */
  readonly ok: boolean;
  /** CUBE's reason, when it refused. */
  readonly reason?: string;
}

/**
 * What applying a plan did.
 *
 * @example
 * ```ts
 * const receipt: SyncReceipt = await syncPlan_apply(plan, seams, () => undefined);
 * receipt.failed === 0;
 * ```
 */
export interface SyncReceipt {
  /** The plan applied. */
  readonly plan: SyncPlan;
  /** Each upload's outcome, in plan order. */
  readonly results: SyncResult[];
  /** Plugins registered. */
  readonly added: number;
  /** Plugins already there, the same. */
  readonly skipped: number;
  /** Plugins in a report group. */
  readonly reported: number;
  /** Uploads that should have worked and did not. */
  readonly failed: number;
  /** Whether a stop (`kill %N`, Ctrl-C) ended it before every add was sent. */
  readonly stopped: boolean;
  /** Adds the plan had that were never sent, because it was stopped. */
  readonly unsent: number;
}

/**
 * One plugin row the CUBE holds.
 *
 * @example
 * ```ts
 * const row: CubePluginRow = { name: 'pl-x', version: '1.0.0', dock_image: 'fnndsc/pl-x:1.0.0' };
 * ```
 */
export interface CubePluginRow {
  /** Its name. */
  readonly name: string;
  /** Its version. */
  readonly version: string;
  /** Its image. */
  readonly dock_image: string;
}

/** What an upload answered. */
export type UploadAnswer = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * The CUBE reads and the upload a sync needs.
 *
 * @example
 * ```ts
 * const seams: SyncSeams = { ...syncSeams_cube, descriptor_upload: async () => ({ ok: true }) };
 * ```
 */
export interface SyncSeams {
  /**
   * Reads every plugin the CUBE holds.
   *
   * @returns The rows, every page.
   */
  cubePlugins_read(): Promise<CubePluginRow[]>;
  /**
   * Reads one registered version whole: its fields and every parameter.
   *
   * @param name - The plugin's name.
   * @param version - The version.
   * @returns The plugin's fields with `parameters`, or null when CUBE has no such version.
   */
  cubeDescriptor_read(name: string, version: string): Promise<Record<string, unknown> | null>;
  /**
   * Uploads one descriptor.
   *
   * @param descriptor - The descriptor's text.
   * @param computes - Compute resources to register it on.
   * @returns Whether CUBE registered it, and why not.
   */
  descriptor_upload(descriptor: string, computes: string[]): Promise<UploadAnswer>;
}

/** The connected CUBE's reads and upload. */
export const syncSeams_cube: SyncSeams = {
  async cubePlugins_read(): Promise<CubePluginRow[]> {
    const client: Client = await client_require();
    const rows: PluginData[] = await listPages_drain<PluginData>(
      (offset: number, limit: number): Promise<ListPage<PluginData>> => pluginsPage_get(client, { offset, limit }));
    return rows.flatMap((row: PluginData): CubePluginRow[] =>
      typeof row.name === 'string' && typeof row.version === 'string'
        ? [{ name: row.name, version: row.version, dock_image: typeof row['dock_image'] === 'string' ? row['dock_image'] : '' }]
        : []);
  },
  async cubeDescriptor_read(name: string, version: string): Promise<Record<string, unknown> | null> {
    const client: Client = await client_require();
    const found: PluginFound | null = await plugin_find(client, name, version);
    if (found === null) return null;
    return { ...found.data, parameters: await pluginParameters_drain(found.handle) };
  },
  async descriptor_upload(descriptor: string, computes: string[]): Promise<UploadAnswer> {
    const added: Result<Record<string, unknown>> = await plugin_addDescriptor(descriptor, computes);
    if (added.ok) return { ok: true };
    return { ok: false, reason: errorStack.stack_pop()?.message ?? 'CUBE refused the plugin' };
  },
};

/**
 * Builds the plan: compares an index with the connected CUBE.
 *
 * @param index - The index.
 * @param computes - The compute resources adds would be registered on.
 * @param seams - The CUBE reads.
 * @returns The plan.
 * @throws {Error} When the CUBE cannot be read.
 *
 * @example
 * ```ts
 * const plan: SyncPlan = await syncPlan_build(index, ['host'], syncSeams_cube);
 * ```
 */
export async function syncPlan_build(index: PluginIndex, computes: string[], seams: SyncSeams): Promise<SyncPlan> {
  const local: LocalCheck = descriptors_checkLocal(index);
  const cube: CubePluginRow[] = await seams.cubePlugins_read();
  const byName: Map<string, CubePluginRow[]> = new Map();
  for (const row of cube) byName.set(row.name, [...(byName.get(row.name) ?? []), row]);

  const entries: SyncPlanEntry[] = [];
  const sameVersion: Array<{ checked: DescriptorChecked; name: string; version: string; cubeVersions: string[] }> = [];
  const indexed: Set<string> = new Set();
  for (const checked of local.descriptors) {
    const name: string = typeof checked.data?.['name'] === 'string' ? checked.data['name'] : checked.file.replace(/\.json$/, '');
    if (checked.findings.length > 0 || checked.data === null) {
      entries.push({ group: 'invalid', name, file: checked.file, detail: findings_summarize(checked.findings) });
      if (checked.data !== null) indexed.add(name);
      continue;
    }
    indexed.add(name);
    const version: string = String(checked.data['version']);
    const image: string = String(checked.data['dock_image']);
    const rows: CubePluginRow[] = byName.get(name) ?? [];
    const cubeVersions: string[] = rows.map((row: CubePluginRow): string => row.version).sort(version_compare);
    const base: { name: string; version: string; file: string } = { name, version, file: checked.file };
    if (rows.length === 0) {
      entries.push({ group: 'add', ...base, descriptor: checked.text });
    } else if (cubeVersions.includes(version)) {
      sameVersion.push({ checked, name, version, cubeVersions });
    } else if (rows.some((row: CubePluginRow): boolean => row.dock_image === image)) {
      const holder: CubePluginRow | undefined = rows.find((row: CubePluginRow): boolean => row.dock_image === image);
      entries.push({ group: 'imageTaken', ...base, cubeVersions, detail: `${image} is registered as ${name} ${holder?.version ?? '?'}` });
    } else if (cubeVersions.every((held: string): boolean => version_compare(version, held) > 0)) {
      entries.push({ group: 'newer', ...base, cubeVersions, descriptor: checked.text });
    } else {
      entries.push({ group: 'cubeNewer', ...base, cubeVersions, detail: `the CUBE holds ${cubeVersions.at(-1) ?? '?'}` });
    }
  }

  const compared: SyncPlanEntry[] = await items_mapPooled(sameVersion, POOL_WIDTH,
    async (item: { checked: DescriptorChecked; name: string; version: string; cubeVersions: string[] }): Promise<SyncPlanEntry> => {
      const held: Record<string, unknown> | null = await seams.cubeDescriptor_read(item.name, item.version);
      const differences: string[] = held === null ? [] : descriptorDrift_find(item.checked.data ?? {}, held);
      const base: SyncPlanEntry = { group: 'skip', name: item.name, version: item.version, file: item.checked.file, cubeVersions: item.cubeVersions };
      return differences.length === 0 ? base : { ...base, group: 'drift', detail: `differs in ${differences.join(', ')}` };
    });
  entries.push(...compared);

  for (const [name, rows] of byName) {
    if (indexed.has(name)) continue;
    const cubeVersions: string[] = rows.map((row: CubePluginRow): string => row.version).sort(version_compare);
    entries.push({ group: 'cubeOnly', name, cubeVersions });
  }

  entries.sort((a: SyncPlanEntry, b: SyncPlanEntry): number =>
    SYNC_GROUPS.indexOf(a.group) - SYNC_GROUPS.indexOf(b.group) || a.name.localeCompare(b.name));
  return { label: index.label, source: index.source, commit: index.commit, indexed: index.descriptors.length, computes, entries };
}

/**
 * Lists the entries a plan would upload.
 *
 * @param plan - The plan.
 * @returns Its add and newer entries, in plan order.
 *
 * @example
 * ```ts
 * syncPlanAdds_list(plan).length; // how many plugins a yes registers
 * ```
 */
export function syncPlanAdds_list(plan: SyncPlan): SyncPlanEntry[] {
  return plan.entries.filter((entry: SyncPlanEntry): boolean => SYNC_ADD_GROUPS.includes(entry.group));
}

/**
 * Applies a plan: uploads its adds, four at a time.
 *
 * @param plan - The plan.
 * @param seams - The upload.
 * @param note - Called once per upload as it lands, in the order they land.
 * @param signal - A stop: the uploads in flight finish, no more start, and
 *   what landed stays (a rerun continues from it).
 * @returns What it did, `stopped` when the signal ended it early.
 *
 * @example
 * ```ts
 * const receipt: SyncReceipt = await syncPlan_apply(plan, syncSeams_cube, (r: SyncResult): void => console.log(r.name, r.ok));
 * ```
 */
export async function syncPlan_apply(plan: SyncPlan, seams: SyncSeams, note: (result: SyncResult) => void, signal?: AbortSignal): Promise<SyncReceipt> {
  const adds: SyncPlanEntry[] = syncPlanAdds_list(plan);
  const results: SyncResult[] = await items_mapPooled(adds, POOL_WIDTH, async (entry: SyncPlanEntry): Promise<SyncResult> => {
    const version: string = entry.version ?? '';
    let result: SyncResult;
    try {
      const answer: UploadAnswer = await seams.descriptor_upload(entry.descriptor ?? '', plan.computes);
      result = answer.ok ? { name: entry.name, version, ok: true } : { name: entry.name, version, ok: false, reason: answer.reason };
    } catch (error: unknown) {
      result = { name: entry.name, version, ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    note(result);
    return result;
  }, signal);
  const added: number = results.filter((result: SyncResult): boolean => result.ok).length;
  return {
    plan,
    results,
    added,
    skipped: plan.entries.filter((entry: SyncPlanEntry): boolean => entry.group === 'skip').length,
    reported: plan.entries.filter((entry: SyncPlanEntry): boolean => !SYNC_ADD_GROUPS.includes(entry.group) && entry.group !== 'skip').length,
    failed: results.length - added,
    stopped: results.length < adds.length,
    unsent: adds.length - results.length,
  };
}

/**
 * Finds how two descriptors of one version differ, CUBE's defaults aside.
 *
 * @param indexed - The index's descriptor.
 * @param held - The CUBE's plugin fields with its `parameters`.
 * @returns The differing fields (`dock_image`, `parameters.--dir.help`), empty when none.
 *
 * @example
 * ```ts
 * descriptorDrift_find({ min_cpu_limit: '1000m' }, { min_cpu_limit: 1000 }); // []
 * ```
 */
export function descriptorDrift_find(indexed: Record<string, unknown>, held: Record<string, unknown>): string[] {
  const differences: string[] = [];
  for (const field of TEXT_FIELDS) {
    if (!(field in indexed)) continue;
    if (text_normalize(indexed[field]) !== text_normalize(held[field])) differences.push(field);
  }
  for (const [field, fallback] of Object.entries(LIMIT_DEFAULTS)) {
    const mine: number | null = limit_normalize(indexed[field], limitFallback_get(indexed, field, fallback));
    const theirs: number | null = limit_normalize(held[field], fallback);
    if (mine !== theirs) differences.push(field);
  }
  differences.push(...parametersDrift_find(indexed['parameters'], held['parameters']));
  return differences;
}

/**
 * Orders two dotted-number versions.
 *
 * @param a - One version.
 * @param b - The other.
 * @returns Negative when `a` is older, positive when newer, zero when equal.
 *
 * @example
 * ```ts
 * ['1.10.0', '1.2.0'].sort(version_compare); // ['1.2.0', '1.10.0']
 * ```
 */
export function version_compare(a: string, b: string): number {
  const left: number[] = a.split('.').map(Number);
  const right: number[] = b.split('.').map(Number);
  for (let at: number = 0; at < Math.max(left.length, right.length); at++) {
    const difference: number = (left[at] ?? 0) - (right[at] ?? 0);
    if (Number.isNaN(difference)) return a.localeCompare(b);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The connected CUBE's client, or an error.
 *
 * @returns The client.
 * @throws {Error} When not connected.
 */
async function client_require(): Promise<Client> {
  const client: Client | null = await chrisConnection.client_get();
  if (client === null) throw new Error('Not connected to ChRIS. Please log in.');
  return client;
}

/**
 * Summarizes a descriptor's findings in a line.
 *
 * @param findings - Its findings.
 * @returns The first finding with its rule, and how many more.
 */
function findings_summarize(findings: readonly ValidateFinding[]): string {
  const first: ValidateFinding | undefined = findings[0];
  if (first === undefined) return 'not a descriptor';
  const more: string = findings.length > 1 ? ` (+${findings.length - 1} more)` : '';
  return `rule ${first.rule}: ${first.message}${more}`;
}

/**
 * What CUBE stores for a limit a descriptor leaves out.
 *
 * @param descriptor - The index's descriptor.
 * @param field - The limit.
 * @param fallback - The model's default.
 * @returns The default, with CUBE's one dependent case: a GPU minimum above
 *   zero and no maximum stores the maximum as unlimited.
 */
function limitFallback_get(descriptor: Record<string, unknown>, field: string, fallback: number): number {
  if (field === 'max_gpu_limit' && !('max_gpu_limit' in descriptor)) {
    const least: number | null = limit_normalize(descriptor['min_gpu_limit'], 0);
    if (least !== null && least > 0) return MAX_LIMIT;
  }
  return fallback;
}

/**
 * Reads a limit as a number, in CUBE's stored units.
 *
 * @param value - `1000m`, `512Mi`, `2Gi`, a number, an empty string, or absent.
 * @param fallback - What an absent or empty value stands for.
 * @returns Millicores or mebibytes or a count; null when unreadable.
 */
function limit_normalize(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number') return value;
  const match: RegExpExecArray | null = /^(\d+)(m|Mi|Gi)?$/.exec(String(value));
  if (match === null || match[1] === undefined) return null;
  const amount: number = Number(match[1]);
  return match[2] === 'Gi' ? amount * 1024 : amount;
}

/**
 * Finds how two parameter lists differ, fields the index leaves out aside.
 *
 * @param indexed - The index's parameters.
 * @param held - The CUBE's parameters.
 * @returns The differing fields, as `parameters.<flag>.<field>`.
 */
function parametersDrift_find(indexed: unknown, held: unknown): string[] {
  const mine: Map<string, Record<string, unknown>> = parameters_index(indexed);
  const theirs: Map<string, Record<string, unknown>> = parameters_index(held);
  const differences: string[] = [];
  for (const name of new Set([...mine.keys(), ...theirs.keys()])) {
    const left: Record<string, unknown> | undefined = mine.get(name);
    const right: Record<string, unknown> | undefined = theirs.get(name);
    if (left === undefined || right === undefined) {
      differences.push(`parameters.${name}`);
      continue;
    }
    for (const field of PARAMETER_FIELDS) {
      if (!(field in left)) continue;
      if (!parameterValues_equal(field, left[field], right[field], String(left['type'] ?? ''))) differences.push(`parameters.${name}.${field}`);
    }
  }
  return differences;
}

/**
 * Indexes a parameter list by name.
 *
 * @param parameters - The list.
 * @returns The parameters by name; empty when the list is not one.
 */
function parameters_index(parameters: unknown): Map<string, Record<string, unknown>> {
  const byName: Map<string, Record<string, unknown>> = new Map();
  if (!Array.isArray(parameters)) return byName;
  for (const parameter of parameters) {
    if (parameter === null || typeof parameter !== 'object') continue;
    const record: Record<string, unknown> = parameter as Record<string, unknown>;
    if (typeof record['name'] === 'string') byName.set(record['name'], record);
  }
  return byName;
}

/**
 * Compares one parameter field, the read API's spellings aside.
 *
 * @param field - The field.
 * @param mine - The index's value.
 * @param theirs - The CUBE's value.
 * @param type - The parameter's type, in the upload's spelling (`bool`, `int`, …).
 * @returns True when they mean the same.
 */
function parameterValues_equal(field: string, mine: unknown, theirs: unknown, type: string): boolean {
  if (field === 'type') return String(mine) === (READ_TYPES[String(theirs)] ?? String(theirs));
  if (field === 'default') {
    if ((mine === null || mine === undefined) && (theirs === null || theirs === undefined || theirs === '')) return true;
    return defaultValue_normalize(mine, type) === defaultValue_normalize(theirs, type);
  }
  if (field === 'help' || field === 'short_flag') return text_normalize(mine) === text_normalize(theirs);
  return mine === theirs;
}

/**
 * A text field as CUBE stores it: its serializers trim the whitespace around
 * every text field on upload (DRF's `trim_whitespace`), so a descriptor's
 * indented help reads back without its leading newline.
 *
 * @param value - The field's value, absent as empty.
 * @returns The text, trimmed.
 */
function text_normalize(value: unknown): string {
  return String(value ?? '').trim();
}

/** The spellings CUBE's boolean default field reads as true (DRF `BooleanField.TRUE_VALUES`). */
const BOOLEAN_TRUE: ReadonlySet<string> = new Set(['true', 't', 'yes', 'y', 'on', '1']);

/**
 * A parameter default as CUBE stores it: the default serializer for the
 * parameter's type coerces the upload's value (`'False'` reads back as
 * `false`, `'5'` as `5`) and trims text.
 *
 * @param value - The default.
 * @param type - The parameter's type, in the upload's spelling.
 * @returns A comparable spelling of the default.
 */
function defaultValue_normalize(value: unknown, type: string): string {
  const text: string = text_normalize(value);
  if (type === 'bool' || type === 'boolean') return String(BOOLEAN_TRUE.has(text.toLowerCase()));
  if (type === 'int' || type === 'integer' || type === 'float') {
    const number: number = Number(text);
    return Number.isFinite(number) ? String(number) : text;
  }
  return text;
}
