/**
 * @file The tenancy's `clusters/`: the OpenShift clusters built in it, the
 * session's home (docs/stratus.adoc, D4).
 *
 * A cluster is a folder: `spec.yaml` as written, `settings` (the cluster's
 * name, base domain, region, compartment and pinned versions, never a
 * credential), `state.json` (the build's state document with its secrets
 * withheld), `steps/<nn-name>/` with each step's `state` and the `evidence`
 * it rests on, and `auth/`, which names the credential files and refuses to
 * read them, saying where they are on the host (D8). The clusters are the
 * daemon's to know (`stratus --cluster <name>=<checkout>`); each is read
 * from the host when it is asked for, so what is listed is what is there.
 * Beside them stand the manifests the engine ships (`tenant.mise`), files
 * whose names a cluster's DNS label can never take, so `play ~/tenant.mise`
 * finds one in the home.
 *
 * @module
 */
import type { VFSItem } from '@fnndsc/fond';
import { harborCluster_read, lastDone_find, type ClusterSecret, type ClusterSource, type HarborCluster, type StepState } from '../checkout/harborOci.js';
import type { ResourceNode } from './resources.js';
import type { ClusterStore } from '../cluster/state.js';
import { builtCluster_read } from '../cluster/view.js';
import type { ShippedManifest } from '../cluster/manifests.js';

/** What a cluster folder holds, in listing order. */
export const CLUSTER_ENTRIES: ReadonlyArray<string> = ['spec.yaml', 'settings', 'state.json', 'steps', 'auth'];

/** How the clusters tree is made. */
export interface ClusterTreeOptions {
  /** The clusters the daemon was given. */
  readonly sources: ReadonlyArray<ClusterSource>;
  /** Who rows are shown as owned by. */
  readonly owner: () => string;
  /** The clock. */
  readonly now: () => Date;
  /** The clusters this daemon builds, kept on its host. */
  readonly store?: ClusterStore;
  /** The manifests shown beside the clusters. */
  readonly manifests?: ReadonlyArray<ShippedManifest>;
}

/** The clusters a tenancy holds, as folders. */
export class ClusterTree {
  private readonly options: ClusterTreeOptions;

  constructor(options: ClusterTreeOptions) {
    this.options = options;
  }

  /** Every cluster, read now: those read from checkouts, then those kept here; one kept here (adopted) stands in for its checkout. */
  clusters_read(): HarborCluster[] {
    const store: ClusterStore | undefined = this.options.store;
    const kept: string[] = store?.names_list() ?? [];
    const read: HarborCluster[] = this.options.sources
      .filter((source: ClusterSource): boolean => !kept.includes(source.name))
      .map((source: ClusterSource): HarborCluster => harborCluster_read(source, this.options.now()));
    if (store === undefined) return read;
    const built: HarborCluster[] = kept
      .map((name: string): HarborCluster | null => builtCluster_read(store, name))
      .filter((cluster: HarborCluster | null): cluster is HarborCluster => cluster !== null);
    return [...read, ...built];
  }

  /** One cluster by name, read now: the one kept here, else the checkout's; null when there is none. */
  cluster_read(name: string): HarborCluster | null {
    const kept: HarborCluster | null = this.options.store === undefined ? null : builtCluster_read(this.options.store, name);
    if (kept !== null) return kept;
    const source: ClusterSource | undefined = this.options.sources.find((entry: ClusterSource): boolean => entry.name === name);
    return source === undefined ? null : harborCluster_read(source, this.options.now());
  }

  /**
   * The node a path below `clusters/` names.
   *
   * @param segments - The segments after `clusters`.
   * @returns The node.
   */
  node_resolve(segments: ReadonlyArray<string>): ResourceNode {
    const manifests: ReadonlyArray<ShippedManifest> = this.options.manifests ?? [];
    if (segments.length === 0) {
      return { kind: 'listing', list: async (): Promise<VFSItem[]> => [
        ...this.clusters_read().map((cluster: HarborCluster): VFSItem => this.cluster_item(cluster)),
        ...manifests.map((manifest: ShippedManifest): VFSItem => this.file_item(manifest.name, manifest.text)),
      ] };
    }
    const [name, entry, ...rest] = segments;
    const manifest: ShippedManifest | undefined = manifests.find((shipped: ShippedManifest): boolean => shipped.name === name);
    if (manifest !== undefined) return rest.length > 0 || entry !== undefined ? { kind: 'missing' } : { kind: 'file', text: manifest.text };
    const cluster: HarborCluster | null = this.cluster_read(name as string);
    if (cluster === null) return { kind: 'missing' };
    if (entry === undefined) return { kind: 'listing', list: async (): Promise<VFSItem[]> => this.clusterEntries_items(cluster) };
    if (entry === 'steps') return this.stepNode_resolve(cluster, rest);
    if (entry === 'auth') return this.authNode_resolve(cluster, rest);
    if (rest.length > 0) return { kind: 'missing' };
    const text: string | null = clusterFile_text(cluster, entry);
    return text === null ? { kind: 'missing' } : { kind: 'file', text };
  }

  private stepNode_resolve(cluster: HarborCluster, segments: ReadonlyArray<string>): ResourceNode {
    if (segments.length === 0) return { kind: 'listing', list: async (): Promise<VFSItem[]> => cluster.steps.map((step: StepState): VFSItem => this.step_item(step)) };
    const step: StepState | undefined = cluster.steps.find((entry: StepState): boolean => entry.folder === segments[0]);
    if (step === undefined) return { kind: 'missing' };
    const fields: Array<[string, string]> = [['state', `${step.state}\n`], ['evidence', `${step.evidence}\n`]];
    if (segments.length === 1) return { kind: 'listing', list: async (): Promise<VFSItem[]> => fields.map(([name, text]: [string, string]): VFSItem => this.file_item(name, text)) };
    if (segments.length > 2) return { kind: 'missing' };
    const field: [string, string] | undefined = fields.find(([name]: [string, string]): boolean => name === segments[1]);
    return field === undefined ? { kind: 'missing' } : { kind: 'file', text: field[1] };
  }

  private authNode_resolve(cluster: HarborCluster, segments: ReadonlyArray<string>): ResourceNode {
    if (segments.length === 0) {
      return { kind: 'listing', list: async (): Promise<VFSItem[]> => cluster.secrets.map((secret: ClusterSecret): VFSItem => ({ name: secret.name, type: 'secret', size: 0, owner: this.options.owner(), date: this.options.now().toISOString() })) };
    }
    const secret: ClusterSecret | undefined = cluster.secrets.find((entry: ClusterSecret): boolean => entry.name === segments[0]);
    if (secret === undefined || segments.length > 1) return { kind: 'missing' };
    return { kind: 'refused', errno: 'EACCES', reason: `a secret stays on the daemon's host: ${secret.hostPath}` };
  }

  // ---- rows ----

  private cluster_item(cluster: HarborCluster): VFSItem {
    const last: StepState | null = lastDone_find(cluster);
    return {
      name: cluster.name,
      type: 'cluster',
      size: 0,
      owner: this.options.owner(),
      date: this.options.now().toISOString(),
      status: last !== null ? last.folder : 'empty',
      ...(cluster.cluster !== null ? { title: cluster.cluster } : {}),
    };
  }

  private clusterEntries_items(cluster: HarborCluster): VFSItem[] {
    const items: VFSItem[] = [];
    for (const entry of CLUSTER_ENTRIES) {
      if (entry === 'steps') items.push(this.folder_item('steps', cluster.steps.length));
      else if (entry === 'auth') items.push(this.folder_item('auth', cluster.secrets.length));
      else {
        const text: string | null = clusterFile_text(cluster, entry);
        if (text !== null) items.push(this.file_item(entry, text));
      }
    }
    return items;
  }

  private step_item(step: StepState): VFSItem {
    return { name: step.folder, type: 'step', size: 0, owner: this.options.owner(), date: this.options.now().toISOString(), status: step.state, title: step.evidence };
  }

  private folder_item(name: string, count: number): VFSItem {
    return { name, type: 'kind', size: count, owner: 'cloud', date: this.options.now().toISOString() };
  }

  private file_item(name: string, text: string): VFSItem {
    return { name, type: 'file', size: Buffer.byteLength(text), owner: this.options.owner(), date: this.options.now().toISOString() };
  }
}

/** The text of a cluster's own files; null when the cluster has none of that name. */
function clusterFile_text(cluster: HarborCluster, entry: string): string | null {
  if (entry === 'spec.yaml') return cluster.spec;
  if (entry === 'state.json') return cluster.state === null ? null : `${JSON.stringify(cluster.state, null, 2)}\n`;
  if (entry === 'settings') return Object.entries(cluster.settings).map(([key, value]: [string, string]): string => `${key}=${value}\n`).join('');
  return null;
}
