/**
 * @file A cluster's build steps, written once over the three drivers
 * (docs/stratus.adoc, D3): their names and order, what each asks of the
 * cloud's builder and of the installer, and the run that takes a cluster from
 * its first step not done to where it was asked to stop.
 *
 * A run is one of the core runner's jobs (`/proc/steps/<cluster>-build`): it
 * outlives the command that started it and every surface. It stops on its
 * own before the first step that bills until the operator has accepted the
 * cost, which only the foreground `cluster build` asks; and before a step
 * this session does not have yet. Every step records what later ones need in
 * the cluster's state, so a run picked up after a restart starts from the
 * first step not done and repeats nothing the cloud already holds.
 *
 * The order and the waits are `harbor-oci`'s, proven live once: the hosts
 * have 45 minutes to register, the install 120.
 *
 * @module
 */
import { join } from 'node:path';
import type { JobContext, JobRun } from '@fnndsc/brasa/core';
import { CHRIS_RELEASE, CHRIS_WAITS, chrisWork_cluster, hostRun_spawn, type ChrisCall, type ChrisWaits, type ChrisWork, type HostRun } from '../kube/chris.js';
import type { VerifyReach } from '../commands/verify.js';
import { planCounts_alter, plan_count, planCounts_words, type BuildCall, type CloudBuilder, type InfraOutputs, type InfraPlan, type PreflightCheck } from '../cloud/builder.js';
import type { Installer, InstallerHost, InstallerIds, InstallStatus, PlatformManifest } from '../installer/installer.js';
import { specNodes_build, type ClusterSpec, type SpecNode } from './spec.js';
import type { ClusterRecord, ClusterStore, StepRecord } from './state.js';
import { verify_run, verifyChecks_keep, type VerifyCheck } from './verify.js';

/** The build's steps, in order: the machine, then ChRIS on it. */
export const BUILD_STEPS: ReadonlyArray<string> = ['compartment', 'preflight', 'cluster', 'iso', 'infra-plan', 'infra-apply', 'dns', 'manifests', 'hosts', 'run', 'postinstall', 'verify', 'chris-deploy', 'chris-seed', 'smoke'];

/** The first step that bills: the run stops before it until the cost is accepted. */
export const FIRST_BILLING_STEP: string = 'infra-apply';

/** The machine's steps, through the install: what an adopted checkout already did. */
export const MACHINE_STEPS: ReadonlyArray<string> = BUILD_STEPS.slice(0, BUILD_STEPS.indexOf('run') + 1);

/** The steps this session has; the run stops before any other. */
export const STEPS_WRITTEN: ReadonlyArray<string> = BUILD_STEPS;

/** The task source the runs are kept in. */
export const STEPS_SOURCE: string = 'steps';

/** What the steps run over. */
export interface BuildDeps {
  readonly store: ClusterStore;
  readonly builder: CloudBuilder;
  readonly installer: Installer;
  /** How many availability domains the region has. */
  readonly zones: number;
  /** The OpenShift version a cluster is made at. */
  readonly version: string;
  /** How often a wait asks again, in milliseconds. */
  readonly pollMs: number;
  /** How long the hosts have to register, in milliseconds. */
  readonly hostsWaitMs: number;
  /** How long the install has, in milliseconds. */
  readonly installWaitMs: number;
  /** How the steps after `run` reach the installed cluster: verify's reach. */
  readonly reach?: VerifyReach;
  /** ChRIS on the cluster; the real cluster's unless a test or the fake world hands its own. */
  readonly chris?: ChrisWork;
  /** How `helm` and `uv` run on the host. */
  readonly host?: HostRun;
  /** The shape a family's nodes are, which verify checks them against. */
  readonly shape_find?: (region: string, family: string) => Promise<string | null>;
  /** How long a freshly installed cluster has to pass verify, in milliseconds. */
  readonly verifyWaitMs?: number;
  readonly chrisWaits?: ChrisWaits;
}

/** How long a new cluster has to settle until verify passes: its operators go on rolling after the install says done. */
export const VERIFY_WAIT_MS: number = 30 * 60_000;

/** The waits `harbor-oci` proved, polled each minute. */
export const BUILD_WAITS: Pick<BuildDeps, 'pollMs' | 'hostsWaitMs' | 'installWaitMs'> = { pollMs: 60_000, hostsWaitMs: 45 * 60_000, installWaitMs: 120 * 60_000 };

/**
 * A run's job id.
 *
 * @param cluster - The cluster.
 * @returns `<cluster>-build`.
 */
export function buildJob_id(cluster: string): string {
  return `${cluster}-build`;
}

/**
 * The first step not done.
 *
 * @param record - The cluster's state.
 * @returns The step, or null when every step is done.
 */
export function stepNext_find(record: ClusterRecord): string | null {
  return BUILD_STEPS.find((step: string): boolean => record.steps[step]?.state !== 'done') ?? null;
}

/** What a step is handed. */
interface StepCall extends BuildCall {
  readonly name: string;
  readonly spec: ClusterSpec;
  readonly deps: BuildDeps;
  readonly record: () => ClusterRecord;
  readonly remember: (ids: Record<string, string>) => void;
  readonly progress: JobContext['progress_set'];
}

/**
 * Waits a poll, unless stopped.
 *
 * @param ms - How long.
 * @param signal - Stops it.
 */
function poll_wait(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve: () => void): void => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(resolve, ms);
    signal.addEventListener('abort', (): void => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * An id a later step needs, or why it is missing.
 *
 * @param record - The cluster's state.
 * @param key - The id.
 * @param step - The step that records it.
 * @returns The id.
 * @throws Error - When it was never recorded.
 */
function id_need(record: ClusterRecord, key: string, step: string): string {
  const value: string | undefined = record.ids[key];
  if (value === undefined) throw new Error(`no ${key} recorded: ${step} has not been done`);
  return value;
}

/**
 * The installer's ids, or why they are missing.
 *
 * @param record - The cluster's state.
 * @returns The ids.
 */
function ids_need(record: ClusterRecord): InstallerIds {
  return { clusterId: id_need(record, 'clusterId', 'cluster'), infraEnvId: id_need(record, 'infraEnvId', 'cluster') };
}

/**
 * The installed cluster's kubeconfig, or why there is none.
 *
 * @param call - The step.
 * @returns Its text.
 */
function kubeconfig_need(call: StepCall): string {
  const text: string | null = call.deps.store.secret_read(call.name, 'kubeconfig');
  if (text === null) throw new Error('no kubeconfig kept: run has not been done');
  return text;
}

/**
 * What a ChRIS step is handed, from the build's step.
 *
 * @param call - The step.
 * @returns The ChRIS call.
 */
function chrisCall_build(call: StepCall): ChrisCall {
  if (call.deps.reach === undefined) throw new Error('this session cannot reach a cluster');
  const folder: string = call.deps.store.folder_derive(call.name);
  return {
    kube: call.deps.reach.kube_make(kubeconfig_need(call)),
    host: call.deps.host ?? hostRun_spawn,
    kubeconfigPath: join(folder, 'auth', 'kubeconfig'),
    folder,
    cubeHost: `cube.apps.${call.name}.${call.record().baseDomain}`,
    spec: call.spec,
    release: CHRIS_RELEASE,
    waits: call.deps.chrisWaits ?? CHRIS_WAITS,
    secret_read: (file: string): string | null => call.deps.store.secret_read(call.name, file),
    secret_write: (file: string, text: string): void => call.deps.store.secret_write(call.name, file, text),
    secret_path: (file: string): string => join(folder, 'auth', file),
    log: call.log,
    signal: call.signal,
  };
}

/** Each step's work. */
const STEP_WORK: Readonly<Record<string, (call: StepCall) => Promise<string>>> = {
  compartment: async (call: StepCall): Promise<string> => {
    const record: ClusterRecord = call.record();
    if (record.compartmentId !== undefined) return `in ${record.compartmentId}`;
    if (call.deps.builder.compartment_ensure === undefined) throw new Error('this cloud cannot make a compartment: cluster new --compartment <id> names one');
    const own = await call.deps.builder.compartment_ensure({ cluster: call.name, region: record.region }, call);
    call.deps.store.record_update(call.name, (current: ClusterRecord): void => { current.compartmentId = own.id; });
    return `${own.made ? 'made' : 'found'} clusters/${call.name}: ${own.id}`;
  },
  preflight: async (call: StepCall): Promise<string> => {
    const record: ClusterRecord = call.record();
    const checks: PreflightCheck[] = await call.deps.builder.preflight({ cluster: call.name, spec: call.spec, region: record.region, baseDomain: record.baseDomain, compartmentId: record.compartmentId ?? '' }, call);
    const failed: PreflightCheck[] = checks.filter((check: PreflightCheck): boolean => !check.ok);
    if (failed.length > 0) throw new Error(`preflight: ${failed.map((check: PreflightCheck): string => `${check.name}: ${check.note}`).join('; ')}`);
    return `${checks.length} checks pass`;
  },
  cluster: async (call: StepCall): Promise<string> => {
    const record: ClusterRecord = call.record();
    if (record.ids['clusterId'] !== undefined) return `already made: ${record.ids['clusterId']}`;
    const made = await call.deps.installer.cluster_create({ name: call.name, baseDomain: record.baseDomain, version: call.deps.version, controlPlaneCount: call.spec.controlPlane.count });
    call.remember({ clusterId: made.clusterId, infraEnvId: made.infraEnvId });
    call.log(`installer: cluster ${made.clusterId}, infra-env ${made.infraEnvId}`);
    return `cluster ${made.clusterId}`;
  },
  iso: async (call: StepCall): Promise<string> => {
    const record: ClusterRecord = call.record();
    const image = await call.deps.installer.isoUrl_get(ids_need(record));
    const stored = await call.deps.builder.iso_store({ cluster: call.name, url: image.url, region: record.region, compartmentId: record.compartmentId ?? '' }, call);
    call.remember({ isoObject: stored.object, isoExpires: stored.expires, isoLinkId: stored.linkId });
    // The link opens the image to anyone holding it: a secret, kept on the host.
    call.deps.store.secret_write(call.name, 'iso-link', stored.link);
    return `${stored.object}, linked until ${stored.expires.slice(0, 10)}`;
  },
  'infra-plan': async (call: StepCall): Promise<string> => {
    const record: ClusterRecord = call.record();
    const plan: InfraPlan = await call.deps.builder.infra_plan({
      cluster: call.name, spec: call.spec, region: record.region, isoObject: id_need(record, 'isoObject', 'iso'),
      baseDomain: record.baseDomain, isoLink: call.deps.store.secret_read(call.name, 'iso-link') ?? '',
      ...(record.compartmentId !== undefined ? { compartmentId: record.compartmentId } : {}),
      ...(record.ids['stackRef'] !== undefined ? { stackRef: record.ids['stackRef'] } : {}),
    }, call);
    const counts = plan_count(plan);
    call.deps.store.file_write(call.name, 'plan.json', `${JSON.stringify(plan, null, 2)}\n`);
    call.remember({ planRef: plan.ref, ...(plan.stackRef !== undefined ? { stackRef: plan.stackRef } : {}) });
    if (planCounts_alter(counts)) throw new Error(`the plan touches what exists (${planCounts_words(counts)}): refused`);
    return planCounts_words(counts);
  },
  'infra-apply': async (call: StepCall): Promise<string> => {
    const record: ClusterRecord = call.record();
    if (record.ids['appliedAt'] !== undefined) return `already applied: ${record.ids['stackRef'] ?? ''}`;
    const text: string | null = call.deps.store.file_read(call.name, 'plan.json');
    if (text === null) throw new Error('no plan recorded: infra-plan has not been done');
    const plan: InfraPlan = JSON.parse(text) as InfraPlan;
    const outputs: InfraOutputs = await call.deps.builder.infra_apply({ cluster: call.name, plan, region: record.region, ...(record.ids['stackRef'] !== undefined ? { stackRef: record.ids['stackRef'] } : {}) }, call);
    call.remember({ stackRef: outputs.stackRef, apiIp: outputs.apiIp, apiIntIp: outputs.apiIntIp, appsIp: outputs.appsIp, appliedAt: new Date().toISOString() });
    // The manifests the stack made, for the manifests step, kept with the cluster.
    call.deps.store.file_write(call.name, 'manifests.json', `${JSON.stringify(outputs.manifests, null, 2)}\n`);
    return `${plan_count(plan).create} created; billing since ${new Date().toISOString().slice(0, 16)}`;
  },
  dns: async (call: StepCall): Promise<string> => {
    const record: ClusterRecord = call.record();
    const outputs: InfraOutputs = { stackRef: id_need(record, 'stackRef', 'infra-apply'), apiIp: id_need(record, 'apiIp', 'infra-apply'), apiIntIp: id_need(record, 'apiIntIp', 'infra-apply'), appsIp: id_need(record, 'appsIp', 'infra-apply'), manifests: [] };
    const names: string[] = await call.deps.builder.dns_upsert({ cluster: call.name, baseDomain: record.baseDomain, outputs, compartmentId: record.compartmentId ?? '', region: record.region }, call);
    return `${names.length} records`;
  },
  manifests: async (call: StepCall): Promise<string> => {
    const text: string | null = call.deps.store.file_read(call.name, 'manifests.json');
    if (text === null) throw new Error('no manifests recorded: infra-apply has not been done');
    const manifests: PlatformManifest[] = JSON.parse(text) as PlatformManifest[];
    await call.deps.installer.manifests_upload(ids_need(call.record()), manifests);
    call.log(`sent ${manifests.map((manifest: PlatformManifest): string => manifest.name).join(', ')}`);
    return `${manifests.length} platform manifests sent`;
  },
  hosts: async (call: StepCall): Promise<string> => {
    const ids: InstallerIds = ids_need(call.record());
    const nodes: SpecNode[] = specNodes_build(call.name, call.spec, call.deps.zones);
    const deadline: number = Date.now() + call.deps.hostsWaitMs;
    const assigned: Set<string> = new Set();
    let seen: number = -1;
    while (!call.signal.aborted) {
      const hosts: InstallerHost[] = await call.deps.installer.hosts_list(ids);
      for (const host of hosts.filter((entry: InstallerHost): boolean => !assigned.has(entry.id))) {
        const role: 'master' | 'worker' = nodes.find((node: SpecNode): boolean => node.name === host.name)?.role === 'worker' ? 'worker' : 'master';
        if (host.role !== role) await call.deps.installer.role_set(ids, host, role);
        assigned.add(host.id);
        call.log(`${host.name} registered${host.zone !== '' ? ` in ${host.zone}` : ''} · role ${role}`);
      }
      const ready: number = hosts.filter((host: InstallerHost): boolean => host.ready).length;
      if (ready !== seen) { call.progress({ current: ready, total: nodes.length, unit: 'nodes' }); seen = ready; }
      // Every host registered and passing the installer's checks (Assisted: `known`).
      if (hosts.length >= nodes.length && ready >= nodes.length) return `${hosts.length} of ${nodes.length} hosts registered and ready`;
      if (Date.now() >= deadline) throw new Error(`${hosts.length} of ${nodes.length} hosts registered, ${ready} ready, after ${Math.round(call.deps.hostsWaitMs / 60_000)} minutes`);
      await poll_wait(call.deps.pollMs, call.signal);
    }
    return 'stopped while waiting for hosts';
  },
  run: async (call: StepCall): Promise<string> => {
    const record: ClusterRecord = call.record();
    const ids: InstallerIds = ids_need(record);
    const deadline: number = Date.now() + call.deps.installWaitMs;
    let last: number = -1;
    while (!call.signal.aborted) {
      const status: InstallStatus = await call.deps.installer.install_status(ids);
      // The installer says when the cluster is ready; the install starts then, once.
      if (status.state === 'ready' && call.record().ids['installStarted'] === undefined) {
        await call.deps.installer.install_start(ids);
        call.remember({ installStarted: new Date().toISOString() });
        call.log('install started');
        continue;
      }
      if (status.percent !== last) { call.progress({ current: status.percent, total: 100 }); call.log(`install ${status.percent}% · ${status.note}`); last = status.percent; }
      if (status.state === 'installed') {
        call.deps.store.secret_write(call.name, 'kubeconfig', await call.deps.installer.kubeconfig_get(ids));
        call.deps.store.secret_write(call.name, 'kubeadmin-password', `${(await call.deps.installer.credentials_get(ids)).password}\n`);
        return 'installed; the kubeconfig and the administrator\'s password are on the host';
      }
      if (status.state === 'error') throw new Error(`the install failed: ${status.note}`);
      if (Date.now() >= deadline) throw new Error(`the install was at ${status.percent}% after ${Math.round(call.deps.installWaitMs / 60_000)} minutes`);
      await poll_wait(call.deps.pollMs, call.signal);
    }
    return 'stopped while installing';
  },
  postinstall: async (): Promise<string> => 'nothing to do after the install on this cloud',
  verify: async (call: StepCall): Promise<string> => {
    if (call.deps.reach === undefined) throw new Error('this session cannot reach a cluster');
    const reach: VerifyReach = call.deps.reach;
    const record: ClusterRecord = call.record();
    const kube = reach.kube_make(kubeconfig_need(call));
    const shape: string | null = call.deps.shape_find === undefined ? null : await call.deps.shape_find(record.region, call.spec.family).catch((): null => null);
    const deadline: number = Date.now() + (call.deps.verifyWaitMs ?? VERIFY_WAIT_MS);
    while (!call.signal.aborted) {
      const checks: VerifyCheck[] = await verify_run({
        kube, resolve: reach.resolve, https_status: reach.https_status, cluster: call.name, baseDomain: record.baseDomain, shape,
        expectedNodes: call.spec.controlPlane.count + call.spec.workers.count,
        addresses: { api: record.ids['apiIp'], apiInt: record.ids['apiIntIp'], apps: record.ids['appsIp'] },
        // The build runs under the tasks tier, so the volume probe may write.
        probe: true, probeTimeoutMs: reach.probeTimeoutMs, pollMs: reach.pollMs, signal: call.signal,
      });
      const summary: string = verifyChecks_keep(call.deps.store, call.name, checks);
      const failed: VerifyCheck[] = checks.filter((check: VerifyCheck): boolean => check.ok === false);
      if (failed.length === 0) return summary;
      const why: string = failed.map((check: VerifyCheck): string => `${check.name}: ${check.detail}`).join('; ');
      if (Date.now() >= deadline) throw new Error(`${summary} after ${Math.round((call.deps.verifyWaitMs ?? VERIFY_WAIT_MS) / 60_000)} minutes: ${why}`);
      call.log(`${summary}; the cluster may still be settling, asking again: ${why}`);
      await poll_wait(call.deps.pollMs, call.signal);
    }
    return 'stopped while verifying';
  },
  'chris-deploy': async (call: StepCall): Promise<string> => {
    const chris: ChrisCall = chrisCall_build(call);
    const note: string = await (call.deps.chris ?? chrisWork_cluster).deploy(chris);
    call.remember({ cubeUrl: `https://${chris.cubeHost}/api/v1/` });
    return note;
  },
  'chris-seed': async (call: StepCall): Promise<string> => (call.deps.chris ?? chrisWork_cluster).seed(chrisCall_build(call)),
  smoke: async (call: StepCall): Promise<string> => (call.deps.chris ?? chrisWork_cluster).smoke(chrisCall_build(call)),
};

/**
 * Records a step's state.
 *
 * @param store - The clusters.
 * @param name - The cluster.
 * @param step - The step.
 * @param change - What changed.
 */
function step_record(store: ClusterStore, name: string, step: string, change: StepRecord): void {
  store.record_update(name, (record: ClusterRecord): void => { record.steps[step] = { ...record.steps[step], ...change }; });
}

/**
 * The run that builds a cluster from its first step not done.
 *
 * @param name - The cluster.
 * @param through - The last step to run; absent, as far as this session's steps go.
 * @param deps - What the steps run over.
 * @returns The job's work.
 */
export function buildRun_make(name: string, through: string | undefined, deps: BuildDeps): JobRun {
  return async (context: JobContext): Promise<void> => {
    const spec: ClusterSpec | null = deps.store.spec_read(name)?.spec ?? null;
    if (spec === null) throw new Error(`${name}: its spec.yaml does not read`);
    if (deps.store.record_read(name)?.adopted !== undefined) throw new Error(`${name} was adopted: building on it is refused until it is allowed by name`);
    if (deps.store.record_read(name)?.gone !== undefined) throw new Error(`${name} was torn down: cluster new makes another`);
    for (;;) {
      if (context.signal.aborted) return;
      const record: ClusterRecord | null = deps.store.record_read(name);
      if (record === null) throw new Error(`${name}: no such cluster`);
      const step: string | null = stepNext_find(record);
      if (step === null) { context.log_write('every step is done'); return; }
      if (!STEPS_WRITTEN.includes(step)) { context.log_write(`stopping before ${step}: not a step this session has yet`); context.data_set('stoppedBefore', step); return; }
      if (step === FIRST_BILLING_STEP && record.billingAccepted === undefined) {
        context.log_write(`stopping before ${step}: it starts billing, and waits on the operator's answer (cluster build ${name})`);
        context.data_set('stoppedBefore', step);
        return;
      }
      context.data_set('step', step);
      step_record(deps.store, name, step, { state: 'running', started: new Date().toISOString() });
      context.log_write(`${step}: started`);
      const call: StepCall = {
        name, spec, deps,
        log: (line: string): void => context.log_write(`${step}: ${line}`),
        signal: context.signal,
        record: (): ClusterRecord => deps.store.record_read(name) as ClusterRecord,
        remember: (ids: Record<string, string>): void => { deps.store.record_update(name, (current: ClusterRecord): void => { Object.assign(current.ids, ids); }); },
        progress: (progress): void => context.progress_set(progress),
      };
      let note: string;
      try {
        note = await (STEP_WORK[step] as (call: StepCall) => Promise<string>)(call);
      } catch (error: unknown) {
        const reason: string = error instanceof Error ? error.message : String(error);
        step_record(deps.store, name, step, { state: 'failed', ended: new Date().toISOString(), note: reason });
        throw new Error(`${step}: ${reason}`);
      }
      if (context.signal.aborted) {
        step_record(deps.store, name, step, { state: 'not done', note: 'stopped when asked' });
        return;
      }
      step_record(deps.store, name, step, { state: 'done', ended: new Date().toISOString(), note });
      context.log_write(`${step}: done · ${note}`);
      if (step === through) { context.data_set('stoppedBefore', stepNext_find(deps.store.record_read(name) as ClusterRecord) ?? ''); return; }
    }
  };
}

/**
 * The run that plans a cluster against its stack and records the plan:
 * an adopted cluster's, or a built one's re-plan. It applies nothing.
 *
 * @param name - The cluster.
 * @param builder - The cloud's build half.
 * @param store - The clusters.
 * @returns The job's work.
 */
export function planRun_make(name: string, builder: CloudBuilder, store: ClusterStore): JobRun {
  return async (context: JobContext): Promise<void> => {
    const record: ClusterRecord | null = store.record_read(name);
    const spec: ClusterSpec | null = store.spec_read(name)?.spec ?? null;
    if (record === null || spec === null) throw new Error(`${name}: no such cluster, or its spec.yaml does not read`);
    const stackRef: string | undefined = record.ids['stackRef'];
    if (stackRef === undefined) throw new Error(`${name}: no stack yet`);
    const plan: InfraPlan = await builder.infra_plan(
      { cluster: name, spec, region: record.region, isoObject: record.ids['isoObject'] ?? '', stackRef },
      { log: (line: string): void => context.log_write(line), signal: context.signal },
    );
    if (context.signal.aborted) return;
    store.file_write(name, 'plan.json', `${JSON.stringify(plan, null, 2)}\n`);
    const counts = plan_count(plan);
    context.log_write(`plan: ${planCounts_words(counts)}`);
  };
}
