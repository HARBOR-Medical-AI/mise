/**
 * @file `verify`: a cluster is healthy and does what ChRIS needs,
 * by `harbor-oci`'s ten checks, through the Kubernetes API and DNS rather
 * than `oc` and `dig` (docs/stratus.adoc, D3, D7).
 *
 * Nine checks only read. The block-volume probe writes (a namespace with a
 * 50 GiB claim and a pod, deleted again), so it runs only under the `tasks`
 * tier and, without it, says so by name instead (decided 2026-10-22). Each
 * check is independent: a failure is a failed check, never the end of the
 * rest.
 *
 * @module
 */
import type { VerifyCheckModel } from '@fnndsc/menu';
import type { KubeApi } from '../kube/kube.js';
import type { ClusterRecord, ClusterStore } from './state.js';

/** The file `verify` keeps its checks in, beside `plan.json`. */
export const VERIFY_FILE: string = 'verify.json';

/** What `verify.json` holds. */
export interface VerifyKept {
  at: string;
  checks: VerifyCheckModel[];
}

/** The storage class ChRIS's claims use. */
export const STORAGE_CLASS: string = 'oci-bv';

/** The annotation that makes a storage class the default. */
const DEFAULT_CLASS_ANNOTATION: string = 'storageclass.kubernetes.io/is-default-class';

/** The cores one ChRIS plugin job asks for. */
export const PLUGIN_CPU_CORES: number = 2;

/** The namespace the volume probe makes and deletes. */
export const PROBE_NAMESPACE: string = 'stratus-verify';

/** What the probe writes and reads back. */
const PROBE_TEXT: string = 'stratus';

/** One check's answer. */
export interface VerifyCheck {
  readonly name: string;
  /** True passed, false failed, null not run. */
  readonly ok: boolean | null;
  readonly detail: string;
  /** Whether it only reads, or writes. */
  readonly how: 'reads' | 'writes';
}

/** What every check reads. */
export interface VerifyContext {
  readonly kube: KubeApi;
  /** The addresses a name has, from a public resolver. */
  readonly resolve: (name: string) => Promise<string[]>;
  /** The status a URL answers with, trusting a CA. */
  readonly https_status: (url: string, ca: string | null) => Promise<number>;
  /** The cluster's name and DNS zone. */
  readonly cluster: string;
  readonly baseDomain: string;
  /** The shape every node should be, or null when not known. */
  readonly shape: string | null;
  readonly expectedNodes: number;
  /** The load balancers' addresses the build recorded. */
  readonly addresses: { readonly api?: string; readonly apiInt?: string; readonly apps?: string };
  /** Whether the probe may write (the `tasks` tier). */
  readonly probe: boolean;
  readonly probeTimeoutMs: number;
  readonly pollMs: number;
  readonly signal?: AbortSignal;
}

/** Kubernetes list answers, as far as the checks read them. */
interface KubeList<T> { items?: T[] }
interface Condition { type: string; status: string }
interface KubeNode {
  metadata: { name: string; labels?: Record<string, string> };
  spec?: { providerID?: string };
  status?: { conditions?: Condition[]; allocatable?: { cpu?: string } };
}
interface KubePod {
  spec?: { nodeName?: string; containers?: Array<{ resources?: { requests?: { cpu?: string } } }> };
  status?: { phase?: string };
}

/**
 * A resource's conditions, by type.
 *
 * @param conditions - Its conditions.
 * @returns Type to status.
 */
function conditions_map(conditions: Condition[] | undefined): Record<string, string> {
  return Object.fromEntries((conditions ?? []).map((condition: Condition): [string, string] => [condition.type, condition.status]));
}

/**
 * A CPU quantity in cores: `500m` is a half, `2` is two.
 *
 * @param quantity - The quantity.
 * @returns Cores.
 */
export function cpuQuantity_parse(quantity: string): number {
  return quantity.endsWith('m') ? Number(quantity.slice(0, -1)) / 1000 : Number(quantity);
}

/**
 * Waits, unless stopped.
 *
 * @param ms - How long.
 * @param signal - Stops it.
 */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted === true) return Promise.resolve();
  return new Promise<void>((resolve: () => void): void => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(resolve, ms);
    signal?.addEventListener('abort', (): void => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** A node's unrequested CPU. */
export interface NodeCpu {
  readonly name: string;
  /** Its `kubernetes.io/hostname` label, what a pod is pinned by. */
  readonly hostname: string;
  readonly cores: number;
}

/**
 * Each node's allocatable cores less what its running pods request.
 *
 * @param kube - The cluster.
 * @returns By node, in the cluster's order.
 */
export async function cpuFree_read(kube: KubeApi): Promise<NodeCpu[]> {
  const nodes: KubeNode[] = (await kube.json_get('/api/v1/nodes') as KubeList<KubeNode>).items ?? [];
  const pods: KubePod[] = (await kube.json_get('/api/v1/pods') as KubeList<KubePod>).items ?? [];
  const requested: Map<string, number> = new Map();
  for (const pod of pods) {
    if (pod.status?.phase === 'Succeeded' || pod.status?.phase === 'Failed' || pod.spec?.nodeName === undefined) continue;
    for (const container of pod.spec.containers ?? []) {
      const cpu: string | undefined = container.resources?.requests?.cpu;
      if (cpu !== undefined) requested.set(pod.spec.nodeName, (requested.get(pod.spec.nodeName) ?? 0) + cpuQuantity_parse(cpu));
    }
  }
  return nodes.map((node: KubeNode): NodeCpu => ({
    name: node.metadata.name,
    hostname: node.metadata.labels?.['kubernetes.io/hostname'] ?? node.metadata.name,
    cores: cpuQuantity_parse(node.status?.allocatable?.cpu ?? '0') - (requested.get(node.metadata.name) ?? 0),
  }));
}

/** The checks, in `harbor-oci`'s order. */
const CHECKS: ReadonlyArray<{ name: string; how: 'reads' | 'writes'; run: (context: VerifyContext) => Promise<{ ok: boolean | null; detail: string }> }> = [
  {
    name: 'API', how: 'reads',
    run: async (context) => {
      const answer: string = (await context.kube.text_get('/readyz')).trim();
      return { ok: answer === 'ok', detail: `/readyz ${answer}` };
    },
  },
  {
    name: 'cluster version', how: 'reads',
    run: async (context) => {
      const version = await context.kube.json_get('/apis/config.openshift.io/v1/clusterversions/version') as { status?: { desired?: { version?: string }; conditions?: Condition[] } };
      const conditions: Record<string, string> = conditions_map(version.status?.conditions);
      return { ok: conditions['Available'] === 'True' && conditions['Failing'] !== 'True', detail: `${version.status?.desired?.version ?? '?'}, Available=${conditions['Available'] ?? '?'}` };
    },
  },
  {
    name: 'nodes', how: 'reads',
    run: async (context) => {
      const nodes: KubeNode[] = (await context.kube.json_get('/api/v1/nodes') as KubeList<KubeNode>).items ?? [];
      const ready: number = nodes.filter((node: KubeNode): boolean => conditions_map(node.status?.conditions)['Ready'] === 'True').length;
      return { ok: nodes.length === context.expectedNodes && ready === context.expectedNodes, detail: `${ready}/${context.expectedNodes} Ready` };
    },
  },
  {
    name: 'OCI CCM', how: 'reads',
    run: async (context) => {
      const nodes: KubeNode[] = (await context.kube.json_get('/api/v1/nodes') as KubeList<KubeNode>).items ?? [];
      const problems: string[] = [];
      const zones: Set<string> = new Set();
      for (const node of nodes) {
        const labels: Record<string, string> = node.metadata.labels ?? {};
        if (!(node.spec?.providerID ?? '').startsWith('oci://')) problems.push(`${node.metadata.name} has no oci:// providerID`);
        if (context.shape !== null && labels['node.kubernetes.io/instance-type'] !== context.shape) problems.push(`${node.metadata.name} is ${labels['node.kubernetes.io/instance-type'] ?? '?'}`);
        zones.add(labels['topology.kubernetes.io/zone'] ?? '?');
      }
      return { ok: problems.length === 0, detail: problems.length > 0 ? problems.join('; ') : `${nodes.length} nodes over ${zones.size} zones, providerIDs set` };
    },
  },
  {
    name: 'operators', how: 'reads',
    run: async (context) => {
      const operators = (await context.kube.json_get('/apis/config.openshift.io/v1/clusteroperators') as KubeList<{ metadata: { name: string }; status?: { conditions?: Condition[] } }>).items ?? [];
      const unhealthy: string[] = operators.filter((operator): boolean => {
        const conditions: Record<string, string> = conditions_map(operator.status?.conditions);
        return conditions['Available'] !== 'True' || conditions['Progressing'] !== 'False' || conditions['Degraded'] !== 'False';
      }).map((operator): string => operator.metadata.name);
      return { ok: unhealthy.length === 0, detail: `${operators.length} operators, ${unhealthy.length === 0 ? 'all available, none degraded' : `not settled: ${unhealthy.join(', ')}`}` };
    },
  },
  {
    name: 'storage class', how: 'reads',
    run: async (context) => {
      const classes = (await context.kube.json_get('/apis/storage.k8s.io/v1/storageclasses') as KubeList<{ metadata: { name: string; annotations?: Record<string, string> } }>).items ?? [];
      const defaults: string[] = classes.filter((entry): boolean => entry.metadata.annotations?.[DEFAULT_CLASS_ANNOTATION] === 'true').map((entry): string => entry.metadata.name);
      return { ok: defaults.length === 1 && defaults[0] === STORAGE_CLASS, detail: `default: ${defaults.join(', ') || 'none'}` };
    },
  },
  {
    name: 'DNS', how: 'reads',
    run: async (context) => {
      const cluster: string = `${context.cluster}.${context.baseDomain}`;
      const wanted: Array<[string, string, string | undefined]> = [
        [`api.${cluster}`, `api.${cluster}`, context.addresses.api],
        [`api-int.${cluster}`, `api-int.${cluster}`, context.addresses.apiInt],
        [`*.apps.${cluster}`, `verify.apps.${cluster}`, context.addresses.apps],
      ];
      const problems: string[] = [];
      for (const [label, name, address] of wanted) {
        if (address === undefined) { problems.push(`${label}: no address recorded`); continue; }
        const answer: string[] = await context.resolve(name).catch((): string[] => []);
        if (!answer.includes(address)) problems.push(`${label} -> ${answer.join(' ') || 'nothing'} (wanted ${address})`);
      }
      return { ok: problems.length === 0, detail: problems.join('; ') || '3 records answer from a public resolver' };
    },
  },
  {
    name: 'console', how: 'reads',
    run: async (context) => {
      const secret = await context.kube.json_get('/api/v1/namespaces/openshift-ingress-operator/secrets/router-ca') as { data?: Record<string, string> };
      const ca: string | null = secret.data?.['tls.crt'] === undefined ? null : Buffer.from(secret.data['tls.crt'], 'base64').toString('utf-8');
      const url: string = `https://console-openshift-console.apps.${context.cluster}.${context.baseDomain}/`;
      const status: number = await context.https_status(url, ca);
      return { ok: status === 200, detail: `${url} HTTP ${status}` };
    },
  },
  {
    name: 'CPU headroom', how: 'reads',
    run: async (context) => {
      const free: number[] = (await cpuFree_read(context.kube)).map((node: NodeCpu): number => node.cores);
      return { ok: Math.max(0, ...free) >= PLUGIN_CPU_CORES, detail: `unrequested cores: ${free.map((cores: number): string => cores.toFixed(1)).join(' / ')} (a plugin job asks ${PLUGIN_CPU_CORES})` };
    },
  },
  {
    name: 'block volume', how: 'writes',
    run: async (context) => {
      if (!context.probe) return { ok: null, detail: `not run: it makes a 50 GiB ${STORAGE_CLASS} claim and a pod, which needs the tasks tier` };
      const ns: string = `/api/v1/namespaces/${PROBE_NAMESPACE}`;
      await context.kube.delete(ns).catch((): void => undefined);
      await context.kube.json_post('/api/v1/namespaces', { apiVersion: 'v1', kind: 'Namespace', metadata: { name: PROBE_NAMESPACE } });
      const started: number = Date.now();
      let phase: string = '';
      let output: string = '';
      try {
        await context.kube.json_post(`${ns}/persistentvolumeclaims`, { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'probe' }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '50Gi' } } } });
        await context.kube.json_post(`${ns}/pods`, {
          apiVersion: 'v1', kind: 'Pod', metadata: { name: 'probe' },
          spec: {
            restartPolicy: 'Never',
            containers: [{
              name: 'probe', image: 'registry.access.redhat.com/ubi9/ubi-minimal',
              command: ['sh', '-c', `echo ${PROBE_TEXT} > /data/probe && cat /data/probe`],
              volumeMounts: [{ name: 'data', mountPath: '/data' }],
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
            }],
            volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'probe' } }],
          },
        });
        while (Date.now() - started < context.probeTimeoutMs && context.signal?.aborted !== true) {
          phase = (await context.kube.json_get(`${ns}/pods/probe`) as KubePod).status?.phase ?? '';
          if (phase === 'Succeeded' || phase === 'Failed') break;
          await wait(context.pollMs, context.signal);
        }
        if (phase === 'Succeeded') output = (await context.kube.text_get(`${ns}/pods/probe/log`)).trim();
      } finally {
        await context.kube.delete(ns).catch((): void => undefined);
      }
      return { ok: phase === 'Succeeded' && output === PROBE_TEXT, detail: `50Gi ${STORAGE_CLASS} pod ${phase || 'timed out'}, read back '${output}', ${Math.round((Date.now() - started) / 1000)}s` };
    },
  },
];

/**
 * Runs every check, in order.
 *
 * @param context - What they read.
 * @returns Each check's answer.
 */
export async function verify_run(context: VerifyContext): Promise<VerifyCheck[]> {
  const results: VerifyCheck[] = [];
  for (const check of CHECKS) {
    try {
      const answer = await check.run(context);
      results.push({ name: check.name, how: check.how, ...answer });
    } catch (error: unknown) {
      results.push({ name: check.name, how: check.how, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/**
 * The checks in a line: how many pass, fail, and were not run.
 *
 * @param checks - The checks.
 * @returns `9 of 10 pass, 1 fail`.
 */
export function verifySummary_render(checks: ReadonlyArray<VerifyCheck>): string {
  const ran: VerifyCheck[] = checks.filter((check: VerifyCheck): boolean => check.ok !== null);
  const passed: number = ran.filter((check: VerifyCheck): boolean => check.ok === true).length;
  const failed: number = ran.length - passed;
  const skipped: number = checks.length - ran.length;
  return `${passed} of ${checks.length} pass${failed > 0 ? `, ${failed} fail` : ''}${skipped > 0 ? `, ${skipped} not run (needs the tasks tier)` : ''}`;
}

/**
 * Keeps a verify as the cluster's verify step and in `verify.json`, so `cluster status` and the tiles show it.
 *
 * @param store - The clusters.
 * @param name - The cluster.
 * @param checks - The checks.
 * @returns The summary.
 */
export function verifyChecks_keep(store: ClusterStore, name: string, checks: ReadonlyArray<VerifyCheck>): string {
  const summary: string = verifySummary_render(checks);
  const at: string = new Date().toISOString();
  const failed: boolean = checks.some((check: VerifyCheck): boolean => check.ok === false);
  store.record_update(name, (current: ClusterRecord): void => {
    current.steps['verify'] = { state: failed ? 'failed' : 'done', ended: at, note: summary };
  });
  const kept: VerifyKept = { at, checks: checks.map((check: VerifyCheck) => ({ name: check.name, ok: check.ok, detail: check.detail, how: check.how })) };
  store.file_write(name, VERIFY_FILE, `${JSON.stringify(kept, null, 2)}\n`);
  return summary;
}
