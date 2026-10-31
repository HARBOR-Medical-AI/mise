/**
 * @file OCI's build half: Terraform in Resource Manager (docs/stratus.adoc, D3).
 *
 * The stack is Oracle's own `oci-openshift` `create-cluster` release zip,
 * pinned by its digest, uploaded as a Resource Manager stack. A plan is a plan
 * job read back as JSON; adopting a cluster `harbor-oci` built is a stack with
 * that cluster's variables and an import-state job carrying its Terraform
 * state. Every wait polls the job and streams its log to the step's; a stop
 * asks Resource Manager to cancel the job without forcing it, and waits for
 * Terraform to finish its current operation.
 *
 * A new cluster's build, as `harbor-oci` proved it: preflight reads the
 * credential, the compartment, the attribution tag, the room per availability
 * domain, the load balancers free, the zone's delegation and the SSH key; the
 * discovery image is copied through this host into a private bucket and
 * linked for a week (the link is a secret); a new stack's variables come from
 * the spec (`stackVars.ts`); the apply's outputs give the load balancers'
 * addresses and the platform manifest; the three A records are replaced in
 * the zone. A cluster with workers is refused: only the compact one is proven.
 *
 * @module
 */
import { createHash } from 'node:crypto';
import type { ClusterSpec } from '../../cluster/spec.js';
import type { BuildCall, CloudBuilder, InfraOutputs, InfraPlan, PreflightCheck, TeardownRequest } from '../builder.js';
import { Readable } from 'node:stream';
import { planRows_read } from './planRead.js';
import type { OciBuildApi } from './buildApi.js';
import { notFound } from './errors.js';
import { familyShape_resolve, stackSpec_derive, stackVariables_build } from './stackVars.js';
import { CLUSTER_TAG } from '../../cluster/state.js';
import type { CloudDriver } from '../driver.js';
import { specFit_read } from '../../cluster/sizing.js';
import type { RmApi, RmJobRecord, RmOperation, RmStackRecord } from './rmApi.js';

/** The stack release stratus builds with: Oracle's zip of `create-cluster`, pinned. */
export const STACK_RELEASE = {
  version: 'v1.6.1',
  url: 'https://github.com/oracle-quickstart/oci-openshift/releases/download/v1.6.1/create-cluster-v1.6.1.zip',
  sha256: 'a4c8a52dcc4ffc030e90b94e90553cc9294fbb87ed66fb6ac6fae2c573b14c8b',
} as const;

/** The freeform tag a cluster's stack carries, so a fresh bastion finds it (D4). */
export { CLUSTER_TAG };

/** The job states that will not change again. */
const JOB_OVER: ReadonlyArray<string> = ['SUCCEEDED', 'FAILED', 'CANCELED'];

/** How the OCI builder is made. */
export interface OciBuilderOptions {
  /** Resource Manager in a region. */
  readonly rm: (region: string) => RmApi;
  /** The stack's zip, as fetched; `fetch` of {@link STACK_RELEASE} when absent. */
  readonly zip_fetch?: () => Promise<Buffer>;
  /** How often a job is asked again, in milliseconds. */
  readonly pollMs?: number;
  /** How long a call may answer not found for something just made before the step fails; ten minutes when absent. */
  readonly visibleWaitMs?: number;
  /** The build's other OCI calls in a region; absent, only adoption and re-plans work. */
  readonly api?: (region: string) => OciBuildApi;
  /** The read driver, for the fit per availability domain. */
  readonly driver?: CloudDriver;
  /** The nodes' SSH public key, read on the host, or null when there is none. */
  readonly sshPublicKey?: () => string | null;
  /** A zone's name servers from a resolver outside the tenancy. */
  readonly nameservers_resolve?: (zone: string) => Promise<string[]>;
  /** Fetches the discovery image: its bytes as a stream, and their length when known. */
  readonly iso_fetch?: (url: string) => Promise<{ body: Readable; length?: number }>;
  /** The bucket the discovery images live in. */
  readonly bucket?: string;
  /** How long the image's link lasts, in days. */
  readonly linkDays?: number;
}

/** The bucket the discovery images live in, one object per cluster. */
export const ISO_BUCKET: string = 'stratus-iso';

/**
 * Fetches a discovery image as a stream.
 *
 * @param url - Its address.
 * @returns Its bytes and their length.
 */
export async function iso_fetch(url: string): Promise<{ body: Readable; length?: number }> {
  const response: Response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || response.body === null) throw new Error(`the discovery image: HTTP ${response.status}`);
  const length: number = Number(response.headers.get('content-length') ?? NaN);
  return { body: Readable.from(response.body as AsyncIterable<Uint8Array>), ...(Number.isFinite(length) ? { length } : {}) };
}

/**
 * Fetches the pinned stack zip and checks its digest.
 *
 * @returns The zip.
 * @throws Error - When the download fails or the digest is not the pinned one.
 */
export async function stackZip_fetch(): Promise<Buffer> {
  const response: Response = await fetch(STACK_RELEASE.url);
  if (!response.ok) throw new Error(`stack ${STACK_RELEASE.version}: HTTP ${response.status} from ${STACK_RELEASE.url}`);
  const zip: Buffer = Buffer.from(await response.arrayBuffer());
  return stackZip_check(zip);
}

/**
 * Checks a zip against the pinned digest.
 *
 * @param zip - The zip.
 * @returns It, when it is the pinned one.
 * @throws Error - When it is not.
 */
export function stackZip_check(zip: Buffer): Buffer {
  const digest: string = createHash('sha256').update(zip).digest('hex');
  if (digest !== STACK_RELEASE.sha256) throw new Error(`stack ${STACK_RELEASE.version}: sha256 ${digest} is not the pinned ${STACK_RELEASE.sha256}`);
  return zip;
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

/** The tag namespace the stack attributes what it makes with: one per tenancy. */
export const TAG_NAMESPACE: string = 'openshift-tags';

/** The compartment every built cluster's own compartment sits in, under the tenancy root. */
export const CLUSTERS_COMPARTMENT: string = 'clusters';

/** OCI's build half, over Resource Manager. */
export class OciBuilder implements CloudBuilder {
  readonly id: string = 'oci';
  private zip: Buffer | null = null;

  constructor(private readonly options: OciBuilderOptions) {}

  /** The stack's zip, fetched once. */
  private async zip_get(): Promise<Buffer> {
    if (this.zip === null) this.zip = await (this.options.zip_fetch ?? stackZip_fetch)();
    return this.zip;
  }

  /**
   * Runs a job to its end: its log streamed to the step's, a stop passed on
   * as a cancel that is never forced.
   *
   * @param rm - Resource Manager.
   * @param stackId - The stack.
   * @param operation - What the job does.
   * @param name - What the job is called.
   * @param call - The step's log and stop.
   * @returns The job at its end.
   * @throws Error - When it failed or was cancelled.
   */
  async job_run(rm: RmApi, stackId: string, operation: RmOperation, name: string, call: BuildCall): Promise<RmJobRecord> {
    let job: RmJobRecord = await rm.job_create(stackId, operation, name);
    call.log(`Resource Manager ${operation.kind} job ${job.id}`);
    let shown: number = 0;
    let cancelAsked: boolean = false;
    for (;;) {
      if (call.signal.aborted && !cancelAsked) {
        cancelAsked = true;
        call.log(`asking Resource Manager to cancel ${job.id}; Terraform finishes its current operation first`);
        await rm.job_cancel(job.id);
      }
      job = await rm.job_get(job.id);
      shown = await this.log_follow(rm, job.id, shown, call);
      if (JOB_OVER.includes(job.state)) break;
      await poll_wait(this.options.pollMs ?? 10_000, call.signal);
    }
    if (job.state !== 'SUCCEEDED') throw new Error(`Resource Manager ${operation.kind} job ${job.id}: ${job.state}${job.failure !== undefined ? `: ${job.failure}` : ''}`);
    return job;
  }

  /**
   * Passes on the lines of a job's log not yet shown. A log read while the
   * job writes it can fail (Resource Manager pages a log that grows); the
   * log is only ever shown, so a failed read is skipped and read again on
   * the next poll, never the job's failure.
   *
   * @param rm - Resource Manager.
   * @param jobId - The job.
   * @param shown - How many lines were passed on already.
   * @param call - The step's log.
   * @returns How many lines have been passed on now.
   */
  private async log_follow(rm: RmApi, jobId: string, shown: number, call: BuildCall): Promise<number> {
    let lines: string[];
    try {
      lines = await rm.jobLog_read(jobId);
    } catch {
      return shown;
    }
    for (const line of lines.slice(shown)) call.log(line);
    return Math.max(shown, lines.length);
  }

  /**
   * Adopts a cluster `harbor-oci` built: a stack of the pinned release with its
   * variables, tagged with the cluster's name, and its Terraform state imported.
   *
   * @param request - The cluster, where the stack goes, its variables and its state.
   * @param call - The step's log and stop.
   * @returns The stack's id.
   */
  async stack_describe(stackId: string, region: string): Promise<{ state: string; compartmentId: string; baseDomain: string | null; spec: ClusterSpec | null }> {
    const stack: RmStackRecord = await this.options.rm(region).stack_get(stackId);
    const read = stackSpec_derive(stack.variables);
    return { state: stack.state.toLowerCase(), compartmentId: stack.compartmentId, baseDomain: read.baseDomain, spec: read.spec };
  }

  async stack_adopt(request: { cluster: string; region: string; compartmentId: string; variables: Record<string, string>; state: Buffer; stackVersion: string }, call: BuildCall): Promise<string> {
    // The state was written by that release's Terraform; another release would plan changes that are not there.
    if (request.stackVersion !== STACK_RELEASE.version) throw new Error(`the cluster was built with oci-openshift ${request.stackVersion || '(unpinned)'}; stratus builds with ${STACK_RELEASE.version}`);
    const rm: RmApi = this.options.rm(request.region);
    // A stack already tagged with the cluster is the one an earlier adoption made: its state is in, nothing to repeat.
    const found = (await rm.stacks_tagged(request.compartmentId, CLUSTER_TAG)).filter((stack): boolean => stack.tagValue === request.cluster && stack.state === 'ACTIVE');
    if (found.length > 1) throw new Error(`${found.length} stacks in ${request.compartmentId} are tagged ${CLUSTER_TAG}=${request.cluster}: ${found.map((stack) => stack.id).join(', ')}`);
    if (found.length === 1) {
      call.log(`stack ${found[0]!.id} is already tagged ${CLUSTER_TAG}=${request.cluster}: taken as this cluster's, its state already in`);
      return found[0]!.id;
    }
    const zip: Buffer = await this.zip_get();
    const stack = await rm.stack_create({
      compartmentId: request.compartmentId,
      displayName: `${request.cluster} · an OpenShift cluster`,
      description: `The ${request.cluster} cluster's infrastructure, oci-openshift ${STACK_RELEASE.version}, adopted from harbor-oci by stratus.`,
      zipBase64: zip.toString('base64'),
      variables: request.variables,
      tags: { [CLUSTER_TAG]: request.cluster },
    });
    call.log(`stack ${stack.id} made in ${request.compartmentId}`);
    await this.job_run(rm, stack.id, { kind: 'import', stateBase64: request.state.toString('base64') }, `${request.cluster}: import the state harbor-oci kept`, call);
    return stack.id;
  }

  /**
   * The build's other calls in a region.
   *
   * @param region - The region.
   * @returns The calls.
   * @throws Error - When the builder was made without them.
   */
  private api_resolve(region: string): OciBuildApi {
    if (this.options.api === undefined) throw new Error('this builder adopts and re-plans only');
    return this.options.api(region);
  }

  async zones_list(region: string): Promise<string[]> {
    return await this.api_resolve(region).zoneNames_list();
  }

  /**
   * The cluster's compartment, `clusters/<name>` under the tenancy root.
   * Compartments are free; making one is still a change to the tenancy, so
   * it runs in the build (the `tasks` tier), never at `cluster new`.
   *
   * @param request - The cluster, and the region its calls go through.
   * @param call - The step's log and stop.
   * @returns The compartment's id, and whether this call made it.
   */
  async compartment_ensure(request: { cluster: string; region: string }, call: BuildCall): Promise<{ id: string; made: boolean }> {
    const api: OciBuildApi = this.api_resolve(request.region);
    const tenancy = await api.tenancy_get();
    const parent = await api.compartmentChild_ensure(tenancy.id, CLUSTERS_COMPARTMENT, 'The OpenShift clusters stratus builds, one compartment each', { 'mise-role': 'clusters' });
    call.log(parent.made ? `made the compartment ${CLUSTERS_COMPARTMENT} under ${tenancy.name}` : `${CLUSTERS_COMPARTMENT} is there`);
    await this.compartment_awaitActive(api, parent.id, call);
    // A compartment just made may answer not found for a while, even after it reads ACTIVE.
    const own = await this.notFound_outwait(() => api.compartmentChild_ensure(parent.id, request.cluster, `The OpenShift cluster ${request.cluster}`, { 'mise-cluster': request.cluster }), `${CLUSTERS_COMPARTMENT} is not yet usable`, call);
    call.log(own.made ? `made the compartment ${CLUSTERS_COMPARTMENT}/${request.cluster}` : `${CLUSTERS_COMPARTMENT}/${request.cluster} is there`);
    await this.compartment_awaitActive(api, own.id, call);
    return own;
  }

  /**
   * Runs a call again while the cloud answers not found, for a bounded time:
   * what was just made is not at once visible everywhere.
   *
   * @param run - The call.
   * @param waiting - What the log says while it waits.
   * @param call - The step's log and stop.
   * @returns What the call answered.
   */
  private async notFound_outwait<T>(run: () => Promise<T>, waiting: string, call: BuildCall): Promise<T> {
    const pollMs: number = this.options.pollMs ?? 10_000;
    const until: number = Date.now() + (this.options.visibleWaitMs ?? 600_000);
    for (;;) {
      try {
        return await run();
      } catch (error: unknown) {
        if (!notFound(error) || Date.now() >= until || call.signal.aborted) throw error;
        call.log(`${waiting}; waiting`);
        await poll_wait(pollMs, call.signal);
      }
    }
  }

  /**
   * Waits until a compartment is active: a new one takes a moment to be usable.
   *
   * @param api - The build calls.
   * @param id - The compartment.
   * @param call - The step's log and stop.
   */
  private async compartment_awaitActive(api: OciBuildApi, id: string, call: BuildCall): Promise<void> {
    for (;;) {
      const state: string = await this.notFound_outwait(() => api.compartmentState_get(id), `${id} is not yet found`, call);
      if (state === 'ACTIVE') return;
      if (call.signal.aborted) throw new Error(`stopped while ${id} was ${state}`);
      call.log(`compartment ${state.toLowerCase()}; waiting`);
      await poll_wait(this.options.pollMs ?? 5000, call.signal);
    }
  }

  async preflight(request: { cluster: string; spec: ClusterSpec; region: string; baseDomain: string; compartmentId: string }, call: BuildCall): Promise<PreflightCheck[]> {
    const api: OciBuildApi = this.api_resolve(request.region);
    const checks: PreflightCheck[] = [];
    const check = async (name: string, run: () => Promise<{ ok: boolean; note: string }>): Promise<void> => {
      let result: { ok: boolean; note: string };
      try { result = await run(); } catch (error: unknown) { result = { ok: false, note: error instanceof Error ? error.message : String(error) }; }
      checks.push({ name, ...result });
      call.log(`${result.ok ? 'ok' : 'NO'}  ${name}: ${result.note}`);
    };
    await check('credential', async () => { const tenancy = await api.tenancy_get(); return { ok: true, note: `the key answers for ${tenancy.name}` }; });
    await check('compartment', async () => {
      if (request.compartmentId === '') return { ok: false, note: 'none chosen: cluster new --compartment <ocid>' };
      const state: string = await api.compartmentState_get(request.compartmentId);
      return { ok: state.toUpperCase() === 'ACTIVE', note: state.toLowerCase() };
    });
    await check('attribution tag', async () => {
      const home: string | null = await api.tagNamespaceCompartment_find(TAG_NAMESPACE);
      const ok: boolean = home !== null && await api.tag_exists(home, TAG_NAMESPACE, 'openshift-resource');
      return { ok, note: ok ? `${TAG_NAMESPACE}.openshift-resource exists${home === request.compartmentId ? '' : ', shared from another compartment'}` : `${TAG_NAMESPACE}.openshift-resource is missing in the tenancy` };
    });
    await check('spec', async () => {
      if (request.spec.workers.count > 0) return { ok: false, note: 'workers are not proven on OCI yet: a compact cluster (workers 0) only' };
      familyShape_resolve(request.spec.family);
      return { ok: true, note: `${request.spec.family}, compact, ${request.spec.controlPlane.count} nodes` };
    });
    await check('room', async () => {
      if (this.options.driver === undefined) return { ok: false, note: 'no driver to read the limits with' };
      const fits = await specFit_read(this.options.driver, request.region, request.cluster, request.spec);
      const short = fits.filter((fit): boolean => fit.fits !== true);
      return { ok: short.length === 0, note: short.length === 0 ? `fits all ${fits.length} availability domains` : `does not fit, or not said, in ${short.map((fit) => fit.zone).join(', ')}` };
    });
    await check('load balancers', async () => {
      const free: number | null = await api.limitFree_get('load-balancer', 'lb-flexible-count');
      return { ok: free !== null && free >= 3, note: `3 needed, ${free ?? 'unknown'} free` };
    });
    await check('zone', async () => {
      const zoneHome: string | null = await api.zoneCompartment_find(request.baseDomain);
      if (zoneHome === null) return { ok: false, note: `no zone ${request.baseDomain} in the tenancy` };
      const served: string[] = await api.zoneNameservers_get(request.baseDomain, zoneHome);
      const resolved: string[] = this.options.nameservers_resolve === undefined ? [] : (await this.options.nameservers_resolve(request.baseDomain)).map((name: string): string => name.replace(/\.$/, '')).sort();
      const same: boolean = served.length > 0 && JSON.stringify(served) === JSON.stringify(resolved);
      return { ok: same, note: same ? `${request.baseDomain} is delegated to OCI's name servers` : `${request.baseDomain}: OCI serves ${served.join(' ') || 'nothing'}, the world asks ${resolved.join(' ') || 'nobody'}` };
    });
    await check('SSH key', async () => {
      const key: string | null = this.options.sshPublicKey?.() ?? null;
      return { ok: key !== null && key.trim() !== '', note: key === null ? 'no public key on the host' : 'present' };
    });
    return checks;
  }

  async iso_store(request: { cluster: string; url: string; region: string; compartmentId: string }, call: BuildCall): Promise<{ object: string; expires: string; link: string; linkId: string }> {
    const api: OciBuildApi = this.api_resolve(request.region);
    const bucket: string = this.options.bucket ?? ISO_BUCKET;
    const object: string = `${request.cluster}-discovery.iso`;
    await api.bucket_ensure(bucket, request.compartmentId);
    // A bucket just made may refuse an object as not found for a while; the image is a stream, so each try fetches it again.
    await this.notFound_outwait(async (): Promise<void> => {
      const image = await (this.options.iso_fetch ?? iso_fetch)(request.url);
      call.log(`copying the discovery image into ${bucket}/${object}${image.length !== undefined ? ` (${Math.round(image.length / 1_048_576)} MiB)` : ''}`);
      await api.object_put(bucket, object, image.body, image.length);
    }, `${bucket} is not yet usable`, call);
    const expires: Date = new Date(Date.now() + (this.options.linkDays ?? 7) * 24 * 3600 * 1000);
    const link = await api.link_create(bucket, object, `${object}-link`, expires);
    call.log(`linked until ${expires.toISOString().slice(0, 10)}`);
    return { object, expires: expires.toISOString(), link: link.url, linkId: link.id };
  }

  async infra_plan(request: { cluster: string; spec: ClusterSpec; region: string; isoObject: string; stackRef?: string; compartmentId?: string; baseDomain?: string; isoLink?: string }, call: BuildCall): Promise<InfraPlan> {
    const rm: RmApi = this.options.rm(request.region);
    let stackRef: string | undefined = request.stackRef;
    let made: string | undefined;
    if (stackRef === undefined) {
      if (request.compartmentId === undefined || request.baseDomain === undefined || request.isoLink === undefined || request.isoLink === '') throw new Error('a new stack needs the compartment, the zone and the image\'s link');
      const sshPublicKey: string | null = this.options.sshPublicKey?.() ?? null;
      if (sshPublicKey === null) throw new Error('no SSH public key on the host');
      const api: OciBuildApi = this.api_resolve(request.region);
      const tenancyId: string = (await api.tenancy_get()).id;
      const tagHome: string | null = await api.tagNamespaceCompartment_find(TAG_NAMESPACE);
      const variables: Record<string, string> = stackVariables_build({
        cluster: request.cluster, spec: request.spec, tenancyId, compartmentId: request.compartmentId, region: request.region,
        ...(tagHome !== null ? { tagNamespaceCompartmentId: tagHome } : {}),
        baseDomain: request.baseDomain, isoLink: request.isoLink, sshPublicKey: sshPublicKey.trim(),
      });
      const stack = await rm.stack_create({
        compartmentId: request.compartmentId,
        displayName: `${request.cluster} · an OpenShift cluster`,
        description: `The ${request.cluster} cluster's infrastructure, oci-openshift ${STACK_RELEASE.version}, built by stratus.`,
        zipBase64: (await this.zip_get()).toString('base64'),
        variables,
        tags: { [CLUSTER_TAG]: request.cluster },
      });
      call.log(`stack ${stack.id} made in ${request.compartmentId}`);
      stackRef = stack.id;
      made = stack.id;
    }
    const job: RmJobRecord = await this.job_run(rm, stackRef, { kind: 'plan' }, `${request.cluster}: plan`, call);
    return { ref: job.id, rows: planRows_read(await rm.jobPlan_read(job.id)), ...(made !== undefined ? { stackRef: made } : {}) };
  }

  async infra_apply(request: { cluster: string; plan: InfraPlan; region: string; stackRef?: string }, call: BuildCall): Promise<InfraOutputs> {
    const stackRef: string | undefined = request.stackRef ?? request.plan.stackRef;
    if (stackRef === undefined) throw new Error('no stack to apply in');
    const rm: RmApi = this.options.rm(request.region);
    const job: RmJobRecord = await this.job_run(rm, stackRef, { kind: 'apply', planJobId: request.plan.ref }, `${request.cluster}: apply`, call);
    const outputs: Record<string, string> = await rm.jobOutputs_read(job.id);
    const need = (key: string): string => {
      const value: string | undefined = outputs[key];
      if (value === undefined || value === '') throw new Error(`the apply left no ${key}`);
      return value;
    };
    return {
      stackRef,
      apiIp: need('open_shift_api_lb_addr'),
      apiIntIp: need('open_shift_api_int_lb_addr'),
      appsIp: need('open_shift_apps_lb_addr'),
      manifests: [{ name: 'oci-dynamic-custom-manifest.yml', content: need('dynamic_custom_manifest') }],
    };
  }

  async dns_upsert(request: { cluster: string; baseDomain: string; outputs: InfraOutputs; compartmentId: string; region: string }, call: BuildCall): Promise<string[]> {
    const api: OciBuildApi = this.api_resolve(request.region);
    const cluster: string = `${request.cluster}.${request.baseDomain}`;
    const records: Array<[string, string]> = [[`api.${cluster}`, request.outputs.apiIp], [`api-int.${cluster}`, request.outputs.apiIntIp], [`*.apps.${cluster}`, request.outputs.appsIp]];
    // The zone is shared and lives where it was made, not in the cluster's own compartment.
    const zoneHome: string = (await api.zoneCompartment_find(request.baseDomain)) ?? request.compartmentId;
    for (const [name, address] of records) {
      await api.record_upsert(request.baseDomain, name, address, zoneHome);
      call.log(`${name} -> ${address}`);
    }
    return records.map(([name]: [string, string]): string => name);
  }

  async stackResources_count(request: { region: string; stackRef: string }): Promise<number> {
    return this.options.rm(request.region).stackResources_count(request.stackRef);
  }

  async teardown_run(request: TeardownRequest, call: BuildCall): Promise<string[]> {
    const api: OciBuildApi = this.api_resolve(request.region);
    const gone: string[] = [];
    if (request.stackRef !== undefined && request.stackEmpty !== true) {
      await this.job_run(this.options.rm(request.region), request.stackRef, { kind: 'destroy' }, `${request.cluster}: destroy`, call);
      gone.push(`the stack's resources (${request.stackRef})`);
    }
    const cluster: string = `${request.cluster}.${request.baseDomain}`;
    if (request.baseDomain === '') {
      call.log('no zone known for it: no records looked for');
    } else {
      const zoneHome: string = (await api.zoneCompartment_find(request.baseDomain)) ?? request.compartmentId;
      for (const name of [`api.${cluster}`, `api-int.${cluster}`, `*.apps.${cluster}`]) {
        await api.record_delete(request.baseDomain, name, zoneHome);
        call.log(`record ${name} removed`);
      }
      gone.push('3 DNS records');
    }
    const bucket: string = this.options.bucket ?? ISO_BUCKET;
    if (request.isoLinkId !== undefined) await api.link_delete(bucket, request.isoLinkId);
    if (request.isoObject !== undefined) {
      await api.object_delete(bucket, request.isoObject);
      gone.push(`the image ${request.isoObject} and its link`);
    }
    for (const volumeId of request.volumeIds) {
      await api.volume_delete(volumeId);
      call.log(`volume ${volumeId} removed`);
    }
    if (request.volumeIds.length > 0) gone.push(`${request.volumeIds.length} volumes the cluster made`);
    // Block volumes the cluster could not name (no kubeconfig here, or made
    // after it was read): what is left in the cluster's compartment carrying
    // the attribution tag namespace is the cluster's, the compartment being
    // the cluster's own.
    const left = (await api.volumes_list(request.compartmentId)).filter((volume): boolean => !request.volumeIds.includes(volume.id) && Object.keys(volume.tags).some((key: string): boolean => key.startsWith(`${TAG_NAMESPACE}.`)));
    for (const volume of left) {
      await api.volume_delete(volume.id);
      call.log(`volume ${volume.name} (${volume.id}) removed: left in the compartment with the attribution tag`);
    }
    if (left.length > 0) gone.push(`${left.length} volumes left in the compartment with the attribution tag`);
    // The stack carried the cluster's tag: left, the cluster would be found again.
    if (request.stackRef !== undefined) {
      await this.options.rm(request.region).stack_delete(request.stackRef);
      gone.push('the stack itself');
    }
    // The compartment: `clusters/<name>` is stratus's own, and the image bucket
    // in it went with the cluster; another's (harbor-oci's) keeps itself and
    // everything in it, and only loses the tag.
    const compartment = await api.compartment_describe(request.compartmentId);
    if (compartment.name === request.cluster && compartment.parentName === CLUSTERS_COMPARTMENT) {
      if (await api.bucket_remove(bucket, request.compartmentId)) gone.push(`the image bucket ${bucket}`);
      try {
        await api.compartment_delete(request.compartmentId);
        gone.push(`the compartment ${CLUSTERS_COMPARTMENT}/${request.cluster}`);
      } catch (error: unknown) {
        call.log(`the compartment ${CLUSTERS_COMPARTMENT}/${request.cluster} stays: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (compartment.tags[CLUSTER_TAG] === request.cluster) {
      await api.compartment_tagRemove(request.compartmentId, CLUSTER_TAG);
      gone.push(`the tag ${CLUSTER_TAG}=${request.cluster} off the compartment ${compartment.name}`);
    }
    return gone;
  }
}
