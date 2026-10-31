/**
 * @file ChRIS on a cluster: the build's `chris-deploy`, `chris-seed`
 * and `smoke` steps (docs/stratus.adoc, D14), as `harbor-oci` proved them
 * on harbor, over the Kubernetes API where it used `oc`.
 *
 * Two things run on the host, as they did for `harbor-oci`: `helm`, which
 * renders and installs the fnndsc/chris chart, and `uv`, which installs
 * miniChRIS-OKD's `chris_smoke` journey into a virtualenv beside the cluster
 * and runs it unchanged. Both read the cluster's kubeconfig or passwords from
 * the host; nothing secret leaves it.
 *
 * Every pod that mounts the shared storebase volume, and every plugin job,
 * is pinned to one node: OCI block volumes are ReadWriteOnce and bound to one
 * availability domain, and each node sits in its own. The pin goes to the
 * node with the most unrequested CPU on the first deploy and never moves.
 *
 * @module
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KubeError, type KubeApi } from './kube.js';
import { cpuFree_read } from '../cluster/verify.js';
import type { ClusterSpec } from '../cluster/spec.js';

/** What is installed, and as whom the smoke journey logs in; `harbor-oci`'s pins. */
export interface ChrisRelease {
  readonly namespace: string;
  readonly release: string;
  readonly chartVersion: string;
  readonly chrisomaticImage: string;
  readonly testUser: string;
  /** A pip requirement for `chris_smoke`. */
  readonly smokeSource: string;
}

/** The release every cluster gets. */
export const CHRIS_RELEASE: ChrisRelease = {
  namespace: 'chris',
  release: 'chris',
  chartVersion: '1.0.8',
  chrisomaticImage: 'ghcr.io/fnndsc/chrisomatic:1.0.0',
  testUser: 'smoke',
  smokeSource: 'git+https://github.com/FNNDSC/miniChRIS-OKD@bc27e67faf76c859f0eb3365a52d58aa02834376#subdirectory=smoke',
};

/** The chart's repository. */
const CHART_REPO: { name: string; url: string } = { name: 'fnndsc', url: 'https://fnndsc.github.io/charts' };

/** The chart's OpenShift values, shipped beside `dist/`. */
export const CHRIS_VALUES: string = fileURLToPath(new URL('../../chris/values-openshift.yaml', import.meta.url));

/** The label a node's name is selected by. */
const HOSTNAME_LABEL: string = 'kubernetes.io/hostname';

/** The cluster-wide mirror that serves the chart's removed Bitnami tags from `bitnamilegacy`. */
const BITNAMI_MIRROR: { name: string; path: string } = { name: 'bitnami-legacy', path: '/apis/config.openshift.io/v1/imagetagmirrorsets' };

/** The superuser the chart makes, and the compute resource it registers. */
const CHRIS_SUPERUSER: string = 'chris';
const PFCON_NAME: string = 'innetwork';

/** The workloads a deploy waits on, heart (the migrations) first. */
const DEPLOYMENTS: ReadonlyArray<string> = ['heart', 'server', 'worker-mains', 'worker-periodic', 'pfcon'];
const STATEFULSETS: ReadonlyArray<string> = ['postgresql', 'rabbitmq', 'nats'];

/** The test user's password, under the cluster's `auth/`. */
export const TEST_PASSWORD_FILE: string = 'chris-test-password';

/** The router's CA, under the cluster's `auth/`, for the smoke journey's HTTPS. */
export const ROUTER_CA_FILE: string = 'router-ca.crt';

/** What a host command answered. */
export interface HostResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** How a host command is run. */
export interface HostRunOptions {
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  /** Each line of its output, as it comes. */
  readonly line?: (text: string) => void;
  readonly signal?: AbortSignal;
}

/** Runs a command on the host, with no shell between. */
export type HostRun = (command: string, args: ReadonlyArray<string>, options?: HostRunOptions) => Promise<HostResult>;

/** How long the waits are, in milliseconds. */
export interface ChrisWaits {
  readonly pollMs: number;
  /** For the nodes to start taking the mirror; a pool that never starts needed no rollout. */
  readonly mirrorReactMs: number;
  /** For the nodes to take the mirror. */
  readonly mirrorWaitMs: number;
  /** For every workload to roll out; the first pulls images and migrates the database. */
  readonly rolloutWaitMs: number;
  /** For the seed job. */
  readonly seedWaitMs: number;
}

/** `harbor-oci`'s waits. */
export const CHRIS_WAITS: ChrisWaits = { pollMs: 5_000, mirrorReactMs: 120_000, mirrorWaitMs: 20 * 60_000, rolloutWaitMs: 45 * 60_000, seedWaitMs: 15 * 60_000 };

/** What a ChRIS step is handed. */
export interface ChrisCall {
  readonly kube: KubeApi;
  readonly host: HostRun;
  /** The kubeconfig's path on the host, for `helm`. */
  readonly kubeconfigPath: string;
  /** The cluster's folder, where the smoke virtualenv lives. */
  readonly folder: string;
  /** The CUBE's public host (`cube.apps.<cluster>`). */
  readonly cubeHost: string;
  readonly spec: ClusterSpec;
  readonly release: ChrisRelease;
  readonly waits: ChrisWaits;
  readonly secret_read: (file: string) => string | null;
  readonly secret_write: (file: string, text: string) => void;
  /** A secret's path on the host. */
  readonly secret_path: (file: string) => string;
  readonly log: (line: string) => void;
  readonly signal: AbortSignal;
}

/** The three ChRIS steps; the fake world answers them too. */
export interface ChrisWork {
  deploy(call: ChrisCall): Promise<string>;
  seed(call: ChrisCall): Promise<string>;
  smoke(call: ChrisCall): Promise<string>;
}

/**
 * Runs a command on the host: no shell, its output streamed by line.
 *
 * @param command - The program.
 * @param args - Its arguments.
 * @param options - Environment, folder, a line reader and a stop.
 * @returns Its exit code and output.
 */
export const hostRun_spawn: HostRun = (command, args, options = {}) => new Promise((resolve, reject): void => {
  const child = spawn(command, [...args], { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'], ...(options.signal !== undefined ? { signal: options.signal } : {}) });
  const out: string[] = [];
  const err: string[] = [];
  const lines = (into: string[]) => {
    let rest: string = '';
    return (chunk: Buffer): void => {
      const text: string = rest + chunk.toString('utf-8');
      into.push(chunk.toString('utf-8'));
      const parts: string[] = text.split('\n');
      rest = parts.pop() ?? '';
      for (const part of parts) if (part.trim() !== '') options.line?.(part);
    };
  };
  child.stdout.on('data', lines(out));
  child.stderr.on('data', lines(err));
  child.on('error', reject);
  child.on('close', (code: number | null): void => resolve({ code: code ?? 1, stdout: out.join(''), stderr: err.join('') }));
});

/**
 * Waits, unless stopped.
 *
 * @param ms - How long.
 * @param signal - Stops it.
 */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve: () => void): void => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(resolve, ms);
    signal.addEventListener('abort', (): void => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * A path's object, or null when the cluster has none.
 *
 * @param kube - The cluster.
 * @param path - The path.
 * @returns The object, or null on 404.
 */
async function object_find(kube: KubeApi, path: string): Promise<unknown> {
  try {
    return await kube.json_get(path);
  } catch (error: unknown) {
    if (error instanceof KubeError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Deletes a path's object; one already gone is no error.
 *
 * @param kube - The cluster.
 * @param path - The path.
 */
async function object_remove(kube: KubeApi, path: string): Promise<void> {
  try {
    await kube.delete(path);
  } catch (error: unknown) {
    if (!(error instanceof KubeError && error.status === 404)) throw error;
  }
}

/**
 * Runs a host command that must succeed.
 *
 * @param call - The step.
 * @param command - The program.
 * @param args - Its arguments.
 * @param options - As for `HostRun`.
 * @returns Its standard output.
 * @throws Error - When it exits other than 0, with its last words.
 */
async function host_need(call: ChrisCall, command: string, args: ReadonlyArray<string>, options: HostRunOptions = {}): Promise<string> {
  const result: HostResult = await call.host(command, args, { signal: call.signal, ...options });
  if (result.code !== 0) throw new Error(`${command} ${args[0] ?? ''} exited ${result.code}: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' · ')}`);
  return result.stdout;
}

/** A resource's conditions, by type. */
function conditions_map(conditions: Array<{ type: string; status: string }> | undefined): Record<string, string> {
  return Object.fromEntries((conditions ?? []).map((condition): [string, string] => [condition.type, condition.status]));
}

/**
 * Makes the Bitnami tag mirror unless it is there, and waits for the nodes
 * to take it (the machine-config pool updates; nodes are not rebooted).
 *
 * @param call - The step.
 */
async function mirror_ensure(call: ChrisCall): Promise<void> {
  if (await object_find(call.kube, `${BITNAMI_MIRROR.path}/${BITNAMI_MIRROR.name}`) !== null) {
    call.log('bitnami mirror already there');
    return;
  }
  await call.kube.json_post(BITNAMI_MIRROR.path, {
    apiVersion: 'config.openshift.io/v1', kind: 'ImageTagMirrorSet', metadata: { name: BITNAMI_MIRROR.name },
    spec: { imageTagMirrors: [{ source: 'docker.io/bitnami', mirrors: ['docker.io/bitnamilegacy'] }] },
  });
  call.log('bitnami mirror made: docker.io/bitnami pulls fall back to docker.io/bitnamilegacy');
  const pool: string = '/apis/machineconfiguration.openshift.io/v1/machineconfigpools/master';
  const started: number = Date.now();
  let updating: boolean = false;
  while (!call.signal.aborted && Date.now() - started < call.waits.mirrorWaitMs) {
    const state: string | undefined = conditions_map((await call.kube.json_get(pool) as { status?: { conditions?: Array<{ type: string; status: string }> } }).status?.conditions)['Updating'];
    if (state === 'True' && !updating) { updating = true; call.log('the nodes are taking the mirror, one at a time'); }
    if (updating && state === 'False') { call.log(`the nodes took the mirror in ${Math.round((Date.now() - started) / 1000)}s`); return; }
    if (!updating && Date.now() - started >= call.waits.mirrorReactMs) return;
    await wait(call.waits.pollMs * 3, call.signal);
  }
  if (updating && !call.signal.aborted) throw new Error(`the machine-config pool was still updating after ${Math.round(call.waits.mirrorWaitMs / 60_000)} minutes`);
}

/**
 * Makes the ChRIS project unless it is there: a project, not a namespace
 * Helm makes, because OpenShift's project annotations are not Helm's.
 *
 * @param call - The step.
 */
async function project_ensure(call: ChrisCall): Promise<void> {
  if (await object_find(call.kube, `/api/v1/namespaces/${call.release.namespace}`) !== null) return;
  await call.kube.json_post('/apis/project.openshift.io/v1/projectrequests', {
    apiVersion: 'project.openshift.io/v1', kind: 'ProjectRequest', metadata: { name: call.release.namespace }, description: 'ChRIS deployed by stratus',
  });
  call.log(`project ${call.release.namespace} made`);
}

/**
 * The node ChRIS is pinned to: the pin a deploy already made, else the node
 * with the most unrequested CPU.
 *
 * @param call - The step.
 * @returns The node's hostname label.
 */
async function pinNode_choose(call: ChrisCall): Promise<string> {
  const pfcon = await object_find(call.kube, `/apis/apps/v1/namespaces/${call.release.namespace}/deployments/${call.release.release}-pfcon`) as { spec?: { template?: { spec?: { nodeSelector?: Record<string, string> } } } } | null;
  const kept: string | undefined = pfcon?.spec?.template?.spec?.nodeSelector?.[HOSTNAME_LABEL];
  if (kept !== undefined) {
    call.log(`pin kept: ${kept} (its volume cannot move)`);
    return kept;
  }
  const free = await cpuFree_read(call.kube);
  const best = [...free].sort((a, b): number => b.cores - a.cores)[0];
  if (best === undefined) throw new Error('the cluster has no nodes to pin ChRIS to');
  call.log(`pin chosen by unrequested CPU: ${free.map((node): string => `${node.hostname} ${node.cores.toFixed(1)}`).join(', ')}`);
  return best.hostname;
}

/**
 * The `helm upgrade --install` arguments: the pinned chart, the OpenShift
 * values, the cluster's host, node and the spec's sizes.
 *
 * @param call - The step.
 * @param node - The pinned node.
 * @returns The arguments after `helm`.
 */
export function helmInstall_args(call: Pick<ChrisCall, 'kubeconfigPath' | 'release' | 'cubeHost' | 'spec'>, node: string): string[] {
  const sizes: Array<[string, number]> = [
    ['pfcon.storage.size', call.spec.chris.dataGib],
    ['postgresql.primary.persistence.size', call.spec.chris.databaseGib],
    ['rabbitmq.persistence.size', call.spec.chris.queueGib],
  ];
  return [
    `--kubeconfig=${call.kubeconfigPath}`, 'upgrade', '--install', call.release.release, `${CHART_REPO.name}/chris`,
    '--version', call.release.chartVersion, '--namespace', call.release.namespace, '--values', CHRIS_VALUES,
    '--set-string', `route.host=${call.cubeHost}`,
    '--set-string', `pfcon.nodeSelector.kubernetes\\.io/hostname=${node}`,
    '--set-string', `pfcon.pman.extraEnv.NODE_SELECTOR=${HOSTNAME_LABEL}=${node}`,
    ...sizes.flatMap(([key, gib]): string[] => ['--set-string', `${key}=${gib}Gi`]),
  ];
}

/** A workload's rollout, as far as the wait reads it. */
interface Workload {
  metadata?: { generation?: number };
  spec?: { replicas?: number };
  status?: { observedGeneration?: number; replicas?: number; updatedReplicas?: number; readyReplicas?: number; availableReplicas?: number };
}

/**
 * Whether a workload has rolled out: its generation seen, every replica
 * updated and ready.
 *
 * @param workload - The deployment or stateful set.
 * @returns True when done.
 */
export function rollout_done(workload: Workload | null): boolean {
  if (workload === null) return false;
  const want: number = workload.spec?.replicas ?? 1;
  const status = workload.status ?? {};
  return (status.observedGeneration ?? 0) >= (workload.metadata?.generation ?? 1)
    && (status.updatedReplicas ?? 0) >= want && (status.readyReplicas ?? 0) >= want;
}

/**
 * Waits for heart, then every other workload, to roll out.
 *
 * @param call - The step.
 */
async function rollouts_wait(call: ChrisCall): Promise<void> {
  const base: string = `/apis/apps/v1/namespaces/${call.release.namespace}`;
  const pending: string[] = [
    ...DEPLOYMENTS.map((name: string): string => `deployments/${call.release.release}-${name}`),
    ...STATEFULSETS.map((name: string): string => `statefulsets/${call.release.release}-${name}`),
  ];
  const deadline: number = Date.now() + call.waits.rolloutWaitMs;
  while (pending.length > 0 && !call.signal.aborted) {
    const next: string = pending[0] as string;
    if (rollout_done(await object_find(call.kube, `${base}/${next}`) as Workload | null)) {
      call.log(`${next.split('/')[1] ?? next} rolled out`);
      pending.shift();
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`${pending.map((entry: string): string => entry.split('/')[1] ?? entry).join(', ')} not rolled out after ${Math.round(call.waits.rolloutWaitMs / 60_000)} minutes`);
    await wait(call.waits.pollMs * 2, call.signal);
  }
}

/**
 * A secret's key, decoded.
 *
 * @param kube - The cluster.
 * @param namespace - Its namespace.
 * @param name - The secret.
 * @param key - The key.
 * @returns The value.
 * @throws Error - When it has none.
 */
async function secretValue_read(kube: KubeApi, namespace: string, name: string, key: string): Promise<string> {
  const secret = await kube.json_get(`/api/v1/namespaces/${namespace}/secrets/${name}`) as { data?: Record<string, string> };
  const value: string | undefined = secret.data?.[key];
  if (value === undefined) throw new Error(`secret ${namespace}/${name} has no ${key}`);
  return Buffer.from(value, 'base64').toString('utf-8');
}

/**
 * The chrisomatic config the seed job runs: the test user, the compute
 * resource the chart registers (re-declared with its own credentials, so a
 * re-run converges), and the smoke journey's plugins. YAML strings are
 * written as JSON strings, which YAML reads the same.
 *
 * @param values - The addresses and credentials.
 * @returns The config's text.
 */
export function chrisomaticConfig_render(values: { cubeUrl: string; superuserPassword: string; testUser: string; testPassword: string; pfconUrl: string; pfconUser: string; pfconPassword: string }): string {
  const q = (text: string): string => JSON.stringify(text);
  return [
    'version: 1.2',
    'on:',
    `  cube_url: ${q(values.cubeUrl)}`,
    '  chris_superuser:',
    `    username: ${q(CHRIS_SUPERUSER)}`,
    `    password: ${q(values.superuserPassword)}`,
    'cube:',
    '  users:',
    `    - username: ${q(values.testUser)}`,
    `      password: ${q(values.testPassword)}`,
    '  compute_resource:',
    `    - name: ${q(PFCON_NAME)}`,
    `      url: ${q(values.pfconUrl)}`,
    `      username: ${q(values.pfconUser)}`,
    `      password: ${q(values.pfconPassword)}`,
    `      description: ${q('Kubernetes cluster compute resource')}`,
    '      innetwork: true',
    '  plugins:',
    `    - name: ${q('pl-dircopy')}`,
    `      version: ${q('3.0.0')}`,
    `    - name: ${q('pl-simpledsapp')}`,
    `      version: ${q('2.1.5')}`,
    '',
  ].join('\n');
}

/**
 * The seed job: chrisomatic once over the config in its secret.
 *
 * @param release - The release.
 * @param timeoutSeconds - Its deadline.
 * @returns The Job.
 */
export function seedJob_build(release: ChrisRelease, timeoutSeconds: number): unknown {
  const labels: Record<string, string> = { 'app.kubernetes.io/name': 'chrisomatic', 'app.kubernetes.io/instance': release.release };
  return {
    apiVersion: 'batch/v1', kind: 'Job',
    metadata: { name: `${release.release}-seed`, namespace: release.namespace, labels: { ...labels, 'app.kubernetes.io/part-of': 'chris' } },
    spec: {
      // chrisomatic is idempotent and cheap: fail once, read why, run the step again.
      backoffLimit: 0,
      activeDeadlineSeconds: timeoutSeconds,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          containers: [{
            name: 'chrisomatic', image: release.chrisomaticImage, command: ['chrisomatic', '/etc/chrisomatic/chrisomatic.yml'],
            resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '1', memory: '512Mi' } },
            volumeMounts: [{ name: 'config', mountPath: '/etc/chrisomatic', readOnly: true }],
          }],
          volumes: [{ name: 'config', secret: { secretName: `${release.release}-seed-config` } }],
        },
      },
    },
  };
}

/** The verdict `chris_smoke` prints last, as far as it is read. */
interface SmokeVerdict {
  verdict?: string;
  failed_step?: string | null;
  duration_s?: number;
  steps?: Array<{ name: string; ok: boolean }>;
}

/**
 * The journey's last line in a few words: `chris_smoke` ends with its verdict
 * as JSON (`pass · 7 steps · 17 s`, or the step that failed); any other line
 * is kept as it is.
 *
 * @param line - The last line it printed.
 * @returns The words.
 */
export function smokeVerdict_words(line: string): string {
  let verdict: SmokeVerdict;
  try {
    verdict = JSON.parse(line) as SmokeVerdict;
  } catch {
    return line;
  }
  if (typeof verdict !== 'object' || verdict === null || typeof verdict.verdict !== 'string') return line;
  const steps: number = verdict.steps?.length ?? 0;
  const failed: string = typeof verdict.failed_step === 'string' ? ` · failed at ${verdict.failed_step}` : '';
  const seconds: string = typeof verdict.duration_s === 'number' ? ` · ${Math.round(verdict.duration_s)} s` : '';
  return `${verdict.verdict} · ${steps} step${steps === 1 ? '' : 's'}${failed}${seconds}`;
}

/** ChRIS on a real cluster. */
export const chrisWork_cluster: ChrisWork = {
  async deploy(call: ChrisCall): Promise<string> {
    await mirror_ensure(call);
    await project_ensure(call);
    const node: string = await pinNode_choose(call);
    await host_need(call, 'helm', ['repo', 'add', CHART_REPO.name, CHART_REPO.url, '--force-update']);
    await host_need(call, 'helm', helmInstall_args(call, node), { line: (text: string): void => call.log(`helm: ${text}`) });
    call.log(`release ${call.release.release}: fnndsc/chris ${call.release.chartVersion}; waiting for the rollouts (the first pulls images and migrates the database)`);
    await rollouts_wait(call);
    return `fnndsc/chris ${call.release.chartVersion} at https://${call.cubeHost}/api/v1/, pinned to ${node}`;
  },

  async seed(call: ChrisCall): Promise<string> {
    const { namespace, release } = call.release;
    let testPassword: string | null = call.secret_read(TEST_PASSWORD_FILE)?.trim() ?? null;
    if (testPassword === null || testPassword === '') {
      testPassword = randomBytes(18).toString('base64url');
      call.secret_write(TEST_PASSWORD_FILE, `${testPassword}\n`);
      call.log(`the test user's password is made, on the host (auth/${TEST_PASSWORD_FILE})`);
    }
    const config: string = chrisomaticConfig_render({
      cubeUrl: `http://${release}-server.${namespace}.svc:8000/api/v1/`,
      superuserPassword: await secretValue_read(call.kube, namespace, `${release}-chris-backend`, 'CHRIS_SUPERUSER_PASSWORD'),
      testUser: call.release.testUser,
      testPassword,
      pfconUrl: `http://${release}-pfcon.${namespace}.svc:5005/api/v1/`,
      pfconUser: await secretValue_read(call.kube, namespace, `${release}-pfcon`, 'PFCON_USER'),
      pfconPassword: await secretValue_read(call.kube, namespace, `${release}-pfcon`, 'PFCON_PASSWORD'),
    });
    // The config carries credentials: it goes into a secret, never to disk.
    const secrets: string = `/api/v1/namespaces/${namespace}/secrets`;
    await object_remove(call.kube, `${secrets}/${release}-seed-config`);
    await call.kube.json_post(secrets, { apiVersion: 'v1', kind: 'Secret', metadata: { name: `${release}-seed-config` }, stringData: { 'chrisomatic.yml': config } });
    const jobs: string = `/apis/batch/v1/namespaces/${namespace}/jobs`;
    const job: string = `${jobs}/${release}-seed`;
    await object_remove(call.kube, `${job}?propagationPolicy=Background`);
    const goneBy: number = Date.now() + 120_000;
    while (await object_find(call.kube, job) !== null) {
      if (Date.now() >= goneBy) throw new Error(`the last seed job ${release}-seed is still there after two minutes`);
      await wait(call.waits.pollMs, call.signal);
    }
    await call.kube.json_post(jobs, seedJob_build(call.release, Math.round(call.waits.seedWaitMs / 1000)));
    call.log('seed job started: chrisomatic makes the test user, the compute resource and the smoke plugins');
    const deadline: number = Date.now() + call.waits.seedWaitMs;
    let status: { succeeded?: number; failed?: number } = {};
    while (!call.signal.aborted && Date.now() < deadline) {
      status = (await call.kube.json_get(job) as { status?: { succeeded?: number; failed?: number } }).status ?? {};
      if ((status.succeeded ?? 0) > 0 || (status.failed ?? 0) > 0) break;
      await wait(call.waits.pollMs, call.signal);
    }
    const pods = await call.kube.json_get(`/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(`job-name=${release}-seed`)}`) as { items?: Array<{ metadata: { name: string } }> };
    const pod: string | undefined = pods.items?.[0]?.metadata.name;
    const logText: string = pod === undefined ? '' : await call.kube.text_get(`/api/v1/namespaces/${namespace}/pods/${pod}/log?tailLines=60`).catch((): string => '');
    if ((status.succeeded ?? 0) === 0) {
      for (const line of logText.trim().split('\n').slice(-10)) if (line.trim() !== '') call.log(`chrisomatic: ${line}`);
      throw new Error(`the seed job ${(status.failed ?? 0) > 0 ? 'failed' : `did not finish in ${Math.round(call.waits.seedWaitMs / 60_000)} minutes`}`);
    }
    const summary: string = logText.includes('Summary:') ? (logText.split('Summary:').pop() ?? '').replace(/[─\s]+/g, ' ').trim() : '';
    return `test user ${call.release.testUser}, compute resource ${PFCON_NAME}, pl-dircopy and pl-simpledsapp${summary !== '' ? ` · ${summary}` : ''}`;
  },

  async smoke(call: ChrisCall): Promise<string> {
    if (call.secret_read(TEST_PASSWORD_FILE) === null) throw new Error('no test user yet: chris-seed has not been done');
    const venv: string = join(call.folder, 'smoke-venv');
    const python: string = join(venv, 'bin', 'python');
    const stamp: string = join(venv, '.stratus-source');
    if (!existsSync(python) || !existsSync(stamp) || readFileSync(stamp, 'utf-8') !== call.release.smokeSource) {
      call.log(`installing chris_smoke from ${call.release.smokeSource}`);
      await host_need(call, 'uv', ['venv', '--quiet', '--allow-existing', venv]);
      await host_need(call, 'uv', ['pip', 'install', '--quiet', '--python', python, call.release.smokeSource]);
      mkdirSync(venv, { recursive: true });
      writeFileSync(stamp, call.release.smokeSource);
    }
    // The router's own CA signs the CUBE's certificate.
    const routerCa = await call.kube.json_get('/api/v1/namespaces/openshift-ingress-operator/secrets/router-ca') as { data?: Record<string, string> };
    const ca: string | undefined = routerCa.data?.['tls.crt'];
    if (ca === undefined) throw new Error('the router has no CA to trust');
    call.secret_write(ROUTER_CA_FILE, Buffer.from(ca, 'base64').toString('utf-8'));
    const result: HostResult = await call.host(python, ['-m', 'chris_smoke'], {
      cwd: call.folder,
      signal: call.signal,
      line: (text: string): void => call.log(`smoke: ${text}`),
      env: {
        CUBE_URL: `https://${call.cubeHost}/api/v1/`,
        CHRIS_SMOKE_USER: call.release.testUser,
        CHRIS_SMOKE_PASSWORD_FILE: call.secret_path(TEST_PASSWORD_FILE),
        SMOKE_CA_BUNDLE: call.secret_path(ROUTER_CA_FILE),
      },
    });
    const last: string = smokeVerdict_words(result.stdout.trim().split('\n').pop() ?? '');
    if (result.code === 1) throw new Error(`the smoke journey found ChRIS broken: ${last}`);
    if (result.code !== 0) throw new Error(`the smoke journey could not start (exit ${result.code}): ${(result.stderr.trim().split('\n').pop() ?? last)}`);
    return `the smoke journey passes as ${call.release.testUser}${last !== '' ? ` · ${last}` : ''}`;
  },
};
