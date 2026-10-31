/**
 * @file A cluster's spec: the cluster and the ChRIS on it, in neutral units
 * (vCPU and GiB), as `harbor-oci`'s `spec.yaml` holds them (docs/stratus.adoc,
 * "Three layers, three tools, one spec").
 *
 * The file keeps `harbor-oci`'s shape, so a spec moves between the two: a
 * family, then `controlPlane`, `workers` and `chris` sections of `key: value`
 * lines. It is read and written here without a YAML library, because only
 * that shape is ever read; anything else refuses by line.
 *
 * @module
 */

/** One pool of nodes. */
export interface NodePool {
  count: number;
  vcpu: number;
  ramGib: number;
  bootGib: number;
  bootTier: string;
}

/** What ChRIS is given on the cluster. */
export interface ChrisSizing {
  dataGib: number;
  databaseGib: number;
  queueGib: number;
}

/** A cluster's spec. */
export interface ClusterSpec {
  family: string;
  controlPlane: NodePool;
  workers: NodePool;
  chris: ChrisSizing;
}

/** The spec a new cluster starts from: `harbor-oci`'s compact cluster. */
export const SPEC_DEFAULT: ClusterSpec = {
  family: 'E5',
  controlPlane: { count: 3, vcpu: 8, ramGib: 24, bootGib: 200, bootTier: 'ultra' },
  workers: { count: 0, vcpu: 8, ramGib: 32, bootGib: 120, bootTier: 'balanced' },
  chris: { dataGib: 20, databaseGib: 5, queueGib: 1 },
};

/** The sections a spec holds, and the numbers each takes. */
const SECTIONS: Readonly<Record<string, ReadonlyArray<string>>> = {
  controlPlane: ['count', 'vcpu', 'ramGib', 'bootGib', 'bootTier'],
  workers: ['count', 'vcpu', 'ramGib', 'bootGib', 'bootTier'],
  chris: ['dataGib', 'databaseGib', 'queueGib'],
};

/**
 * A copy of a spec, nothing shared.
 *
 * @param spec - The spec.
 * @returns The copy.
 */
export function spec_copy(spec: ClusterSpec): ClusterSpec {
  return { family: spec.family, controlPlane: { ...spec.controlPlane }, workers: { ...spec.workers }, chris: { ...spec.chris } };
}

/**
 * Sets one field of a section, by name: the names were checked against
 * {@link SECTIONS} by the caller.
 *
 * @param spec - The spec.
 * @param section - `controlPlane`, `workers` or `chris`.
 * @param key - The field.
 * @param value - Its value.
 */
function specField_set(spec: ClusterSpec, section: string, key: string, value: number | string): void {
  if (section === 'chris') {
    const chris: ChrisSizing = spec.chris;
    if (key === 'dataGib' || key === 'databaseGib' || key === 'queueGib') chris[key] = Number(value);
    return;
  }
  const pool: NodePool = section === 'workers' ? spec.workers : spec.controlPlane;
  if (key === 'bootTier') pool.bootTier = String(value);
  else if (key === 'count' || key === 'vcpu' || key === 'ramGib' || key === 'bootGib') pool[key] = Number(value);
}

/**
 * Writes a spec as `spec.yaml`.
 *
 * @param spec - The spec.
 * @returns The file's text.
 */
export function specYaml_render(spec: ClusterSpec): string {
  const pool = (name: string, p: NodePool, note: string): string[] => [
    `${name}:`,
    `  count: ${p.count}${note}`,
    `  vcpu: ${p.vcpu}`,
    `  ramGib: ${p.ramGib}`,
    `  bootGib: ${p.bootGib}`,
    `  bootTier: ${p.bootTier}`,
    '',
  ];
  return [
    '# An OpenShift cluster\'s spec: the cluster and the ChRIS on it, in vCPU and GiB.',
    '# Written by `cluster new`; harbor-oci reads the same shape.',
    '',
    `family: ${spec.family}`,
    '',
    ...pool('controlPlane', spec.controlPlane, spec.controlPlane.count === 3 ? '                # one per availability domain' : ''),
    ...pool('workers', spec.workers, spec.workers.count === 0 ? '                # 0: compact cluster, schedulable control plane' : ''),
    'chris:',
    `  dataGib: ${spec.chris.dataGib}                # grows, never shrinks`,
    `  databaseGib: ${spec.chris.databaseGib}             # fixed after the first deploy`,
    `  queueGib: ${spec.chris.queueGib}                # fixed after the first deploy`,
    '',
  ].join('\n');
}

/**
 * Reads `spec.yaml`.
 *
 * @param text - The file's text.
 * @returns The spec, or the line it could not read.
 */
export function specYaml_parse(text: string): { spec: ClusterSpec } | { error: string } {
  const spec: ClusterSpec = spec_copy(SPEC_DEFAULT);
  let section: string | null = null;
  const lines: string[] = text.split('\n');
  for (let index: number = 0; index < lines.length; index++) {
    const line: string = (lines[index] ?? '').replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (line.trim() === '') continue;
    const match: RegExpMatchArray | null = /^(\s*)([A-Za-z]+):\s*(\S*)\s*$/.exec(line);
    if (match === null) return { error: `line ${index + 1}: not a key: value line` };
    const indent: string = match[1] ?? '';
    const key: string = match[2] ?? '';
    const value: string = match[3] ?? '';
    if (indent === '') {
      if (key === 'family' && value !== '') { spec.family = value; section = null; continue; }
      if (SECTIONS[key] !== undefined && value === '') { section = key; continue; }
      return { error: `line ${index + 1}: ${key}: not a spec field` };
    }
    if (section === null || !(SECTIONS[section] ?? []).includes(key)) return { error: `line ${index + 1}: ${key}: not a field of ${section ?? 'the spec'}` };
    const number: number = Number(value);
    if (key !== 'bootTier' && (!Number.isInteger(number) || number < 0)) return { error: `line ${index + 1}: ${key}: wants a whole number, not '${value}'` };
    specField_set(spec, section, key, key === 'bootTier' ? value : number);
  }
  return { spec };
}

/**
 * Reads a pool written as `<count>x<vcpu>/<GiB>` (`3x8/24`).
 *
 * @param text - The words.
 * @returns The count, vCPU and GiB, or null.
 */
export function poolArg_parse(text: string): { count: number; vcpu: number; ramGib: number } | null {
  const match: RegExpMatchArray | null = /^(\d+)x(\d+)\/(\d+)$/.exec(text.trim());
  if (match === null) return null;
  return { count: Number(match[1]), vcpu: Number(match[2]), ramGib: Number(match[3]) };
}

/**
 * Applies `cluster new`'s sizing options to a spec.
 *
 * @param base - The spec to start from.
 * @param options - `--family`, `--plane`, `--workers`, `--data`, `--database`, `--queue`, by name.
 * @returns The spec, or what could not be read.
 */
export function specOptions_apply(base: ClusterSpec, options: ReadonlyMap<string, string>): { spec: ClusterSpec } | { error: string } {
  const spec: ClusterSpec = spec_copy(base);
  for (const [name, value] of options) {
    if (name === '--family') { spec.family = value; continue; }
    if (name === '--plane' || name === '--workers') {
      const pool = poolArg_parse(value);
      if (pool === null) return { error: `${name} takes <count>x<vCPU>/<GiB>, as 3x8/24, not '${value}'` };
      if (name === '--plane' && pool.count !== 3) return { error: '--plane: the control plane is three nodes, one per availability domain' };
      Object.assign(name === '--plane' ? spec.controlPlane : spec.workers, pool);
      continue;
    }
    const field: keyof ChrisSizing | undefined = ({ '--data': 'dataGib', '--database': 'databaseGib', '--queue': 'queueGib' } as const)[name as '--data' | '--database' | '--queue'];
    if (field === undefined) return { error: `${name}: unknown option` };
    const number: number = Number(value);
    if (!Number.isInteger(number) || number <= 0) return { error: `${name} wants a whole number of GiB, not '${value}'` };
    spec.chris[field] = number;
  }
  return { spec };
}

/** One node a spec asks for. */
export interface SpecNode {
  name: string;
  role: 'plane' | 'worker';
  vcpu: number;
  ramGib: number;
  /** Which availability domain it is placed in, as an index into the region's zones. */
  zoneIndex: number;
}

/**
 * The nodes a spec asks for, placed one per zone in turn.
 *
 * @param cluster - The cluster's name, for the nodes' names.
 * @param spec - The spec.
 * @param zones - How many zones the region has.
 * @returns The nodes.
 */
export function specNodes_build(cluster: string, spec: ClusterSpec, zones: number): SpecNode[] {
  const nodes: SpecNode[] = [];
  const count: number = Math.max(zones, 1);
  for (let i: number = 0; i < spec.controlPlane.count; i++) nodes.push({ name: `${cluster}-cp-${i}`, role: 'plane', vcpu: spec.controlPlane.vcpu, ramGib: spec.controlPlane.ramGib, zoneIndex: i % count });
  for (let i: number = 0; i < spec.workers.count; i++) nodes.push({ name: `${cluster}-w-${i}`, role: 'worker', vcpu: spec.workers.vcpu, ramGib: spec.workers.ramGib, zoneIndex: i % count });
  return nodes;
}
