/**
 * @file A Terraform plan, as Resource Manager returns it in JSON, read into
 * the rows the operator is asked about (docs/stratus.adoc, D6).
 *
 * OCI writes its own `Oracle-Tags` (who made a resource and when) after an
 * apply; Terraform then wants to strip them on every re-plan. An update whose
 * only difference is those tags is drift, counted apart; anything else is a
 * real change, and the apply is refused unless asked for by name. A replace
 * (delete then create) is never drift, whatever caused it: `harbor-oci` saw
 * tag drift on instances recreate every load-balancer backend.
 *
 * @module
 */
import type { PlanRow } from '../builder.js';

/** The tag namespace OCI writes on its own. */
export const ORACLE_TAGS: string = 'Oracle-Tags';

/** One entry of a plan's `resource_changes`. */
interface ResourceChange {
  address?: string;
  type?: string;
  name?: string;
  change?: { actions?: string[]; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null; after_unknown?: Record<string, unknown> | null };
}

/**
 * A resource's values as leaves: a path each (a block, which Terraform writes
 * as a list of one, is stepped into without its index), its value in a word.
 *
 * @param value - The value.
 * @param prefix - The path so far.
 * @param into - The leaves.
 * @returns The leaves.
 */
function leaves_read(value: unknown, prefix: string = '', into: Map<string, string | null> = new Map()): Map<string, string | null> {
  const step = (key: string): string => (prefix === '' ? key : `${prefix}.${key}`);
  if (Array.isArray(value)) {
    if (value.length === 1 && typeof value[0] === 'object' && value[0] !== null) return leaves_read(value[0], prefix, into);
    into.set(prefix, JSON.stringify(value));
    return into;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) leaves_read(inner, step(key), into);
    return into;
  }
  into.set(prefix, value === null || value === undefined ? null : String(value));
  return into;
}

/**
 * What an update changes, leaf by leaf: OCI's own tags left out, and the
 * leaves the plan only knows after the apply (computed) left out too.
 *
 * @param change - The resource's change.
 * @returns The leaves that differ, before and after.
 */
export function update_leaves(change: ResourceChange['change']): Array<{ path: string; before: string | null; after: string | null }> {
  const before: Map<string, string | null> = leaves_read(change?.before ?? {});
  const after: Map<string, string | null> = leaves_read(change?.after ?? {});
  const unknown: Map<string, string | null> = leaves_read(change?.after_unknown ?? {});
  const paths: Set<string> = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((path: string): boolean => !path.startsWith('defined_tags') && unknown.get(path) !== 'true' && (before.get(path) ?? null) !== (after.get(path) ?? null))
    .sort()
    .map((path: string) => ({ path, before: before.get(path) ?? null, after: after.get(path) ?? null }));
}

/** The neutral kind a Terraform resource type is listed under. */
const TYPE_KINDS: ReadonlyArray<[RegExp, string]> = [
  [/^oci_core_instance$/, 'instances'],
  [/^oci_core_vcn$/, 'networks'],
  [/^oci_core_subnet$/, 'subnets'],
  [/^oci_core_network_security_group/, 'securitygroups'],
  [/^oci_load_balancer|^oci_network_load_balancer/, 'loadbalancers'],
  [/^oci_core_volume|^oci_core_boot_volume/, 'volumes'],
  [/^oci_objectstorage_bucket$/, 'buckets'],
  [/^oci_dns_/, 'dns'],
];

/**
 * A Terraform type's neutral kind, or the type itself.
 *
 * @param type - The resource type (`oci_core_instance`).
 * @returns The kind.
 */
export function terraformType_kind(type: string): string {
  return TYPE_KINDS.find(([pattern]: [RegExp, string]): boolean => pattern.test(type))?.[1] ?? type;
}

/**
 * Whether an update changes nothing but OCI's own tags.
 *
 * @param before - The resource before.
 * @param after - The resource after.
 * @returns True when only `Oracle-Tags.*` defined tags differ.
 */
export function update_isDrift(before: Record<string, unknown> | null | undefined, after: Record<string, unknown> | null | undefined): boolean {
  if (before === null || before === undefined || after === null || after === undefined) return false;
  const keys: Set<string> = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [...keys].filter((key: string): boolean => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  if (changed.length === 0 || changed.some((key: string): boolean => key !== 'defined_tags')) return false;
  const tagsBefore: Record<string, unknown> = (before['defined_tags'] ?? {}) as Record<string, unknown>;
  const tagsAfter: Record<string, unknown> = (after['defined_tags'] ?? {}) as Record<string, unknown>;
  const tagKeys: Set<string> = new Set([...Object.keys(tagsBefore), ...Object.keys(tagsAfter)]);
  return [...tagKeys]
    .filter((key: string): boolean => JSON.stringify(tagsBefore[key]) !== JSON.stringify(tagsAfter[key]))
    .every((key: string): boolean => key.startsWith(`${ORACLE_TAGS}.`));
}

/**
 * A plan's rows.
 *
 * @param plan - Terraform's plan JSON.
 * @returns One row per resource the plan touches (a replace is a destroy and a create); none for no-ops and reads.
 */
export function planRows_read(plan: unknown): PlanRow[] {
  const changes: ResourceChange[] = ((plan as { resource_changes?: ResourceChange[] } | null)?.resource_changes) ?? [];
  const rows: PlanRow[] = [];
  for (const change of changes) {
    const actions: string[] = change.change?.actions ?? [];
    const kind: string = terraformType_kind(change.type ?? '');
    const name: string = change.address ?? `${change.type ?? '?'}.${change.name ?? '?'}`;
    const type: { type?: string } = change.type !== undefined ? { type: change.type } : {};
    if (actions.includes('delete')) rows.push({ action: 'destroy', kind, name, ...type });
    if (actions.includes('create')) rows.push({ action: 'create', kind, name, ...type });
    if (actions.length === 1 && actions[0] === 'update') {
      const drift: boolean = update_isDrift(change.change?.before, change.change?.after);
      rows.push({ action: 'change', kind, name, ...type, ...(drift ? { drift: true } : { changes: update_leaves(change.change) }) });
    }
  }
  return rows;
}
