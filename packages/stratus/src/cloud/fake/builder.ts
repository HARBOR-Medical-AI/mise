/**
 * @file The fake cloud's build half and the fake installer, over one small
 * world they share: an apply boots the machines, which register with the
 * installer a moment later, and the install runs on a clock. Every wait is a
 * tick (none in tests), so `stratus --fake` shows a build moving.
 *
 * @module
 */
import type { ClusterSpec } from '../../cluster/spec.js';
import { specNodes_build, type SpecNode } from '../../cluster/spec.js';
import type { Installer, InstallerCredentials, InstallerHost, InstallerIds, InstallStatus, PlatformManifest } from '../../installer/installer.js';
import type { BuildCall, CloudBuilder, InfraOutputs, InfraPlan, PlanRow, PreflightCheck, TeardownRequest } from '../builder.js';

/** The zones the fake region has, as the fake driver names them. */
const FAKE_ZONES: ReadonlyArray<string> = ['AD-1', 'AD-2', 'AD-3'];

/** What the fake world keeps of one cluster. */
interface FakeCluster {
  name: string;
  hosts: InstallerHost[];
  /** When each booted machine registers, epoch ms. */
  pending: Array<{ host: InstallerHost; at: number }>;
  installStarted?: number;
}

/**
 * The world the fake builder and installer share.
 *
 * @property tickMs - How long one tick of fake work takes.
 */
export class FakeBuildWorld {
  private readonly clusters: Map<string, FakeCluster> = new Map();
  /** The compartments made, by cluster. */
  readonly compartments: Map<string, string> = new Map();
  /** The DNS zones the tenancy holds. */
  readonly zones: string[] = ['fake.example'];
  /** The stacks the tenancy holds, by id, as `stack_describe` reads them back; a test seeds them. */
  readonly stacks: Map<string, { state: string; compartmentId: string; baseDomain: string | null; spec: ClusterSpec | null }> = new Map();
  /** How many resources each stack's state holds; a stack not named holds 17. */
  readonly stackResources: Map<string, number> = new Map();
  /** What the teardowns removed, a line each, for a test to read. */
  readonly removed: string[] = [];
  private serial: number = 0;

  constructor(readonly tickMs: number = 0) {}

  /**
   * Waits one tick, or several, unless stopped.
   *
   * @param ticks - How many.
   * @param signal - Stops the wait early.
   */
  async tick(ticks: number = 1, signal?: AbortSignal): Promise<void> {
    if (this.tickMs <= 0 || signal?.aborted === true) return;
    await new Promise<void>((resolve: () => void): void => {
      const timer: ReturnType<typeof setTimeout> = setTimeout(resolve, this.tickMs * ticks);
      signal?.addEventListener('abort', (): void => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  /** A new id of a kind. */
  id_next(kind: string): string {
    this.serial++;
    return `fake-${kind}-${this.serial}`;
  }

  /** A cluster by name, made when first asked for. */
  cluster_resolve(name: string): FakeCluster {
    let cluster: FakeCluster | undefined = this.clusters.get(name);
    if (cluster === undefined) {
      cluster = { name, hosts: [], pending: [] };
      this.clusters.set(name, cluster);
    }
    return cluster;
  }

  /**
   * Boots a cluster's machines: each registers with the installer a few ticks apart.
   *
   * @param name - The cluster's name.
   * @param nodes - Its machines.
   */
  machines_boot(name: string, nodes: ReadonlyArray<SpecNode>): void {
    const cluster: FakeCluster = this.cluster_resolve(name);
    const now: number = Date.now();
    cluster.pending = nodes.map((node: SpecNode, index: number): { host: InstallerHost; at: number } => ({
      host: { id: `host-${node.name}`, name: node.name, zone: FAKE_ZONES[node.zoneIndex] ?? 'AD-1', role: 'auto', registered: '', ready: true },
      at: now + this.tickMs * (2 + index),
    }));
  }

  /**
   * The hosts registered by now.
   *
   * @param name - The cluster's name.
   * @returns The hosts.
   */
  hosts_now(name: string): InstallerHost[] {
    const cluster: FakeCluster = this.cluster_resolve(name);
    const now: number = Date.now();
    for (const entry of cluster.pending.filter((p): boolean => p.at <= now)) {
      cluster.hosts.push({ ...entry.host, registered: new Date(entry.at).toISOString() });
    }
    cluster.pending = cluster.pending.filter((p): boolean => p.at > now);
    return cluster.hosts.map((host: InstallerHost): InstallerHost => ({ ...host }));
  }
}

/** The fake cloud's build half. */
export class FakeCloudBuilder implements CloudBuilder {
  readonly id: string = 'fake';

  constructor(private readonly world: FakeBuildWorld) {}

  async zones_list(_region: string): Promise<string[]> {
    return [...this.world.zones];
  }

  async compartment_ensure(request: { cluster: string; region: string }, call: BuildCall): Promise<{ id: string; made: boolean }> {
    await this.world.tick(1, call.signal);
    const kept: string | undefined = this.world.compartments.get(request.cluster);
    if (kept !== undefined) return { id: kept, made: false };
    const id: string = `ocid1.compartment.oc1..fake-${request.cluster}`;
    this.world.compartments.set(request.cluster, id);
    call.log(`made the compartment clusters/${request.cluster}`);
    return { id, made: true };
  }

  async preflight(request: { cluster: string; spec: ClusterSpec; region: string; baseDomain: string; compartmentId: string }, call: BuildCall): Promise<PreflightCheck[]> {
    await this.world.tick(1, call.signal);
    const checks: PreflightCheck[] = [
      { name: 'credential', ok: true, note: 'the fake key answers' },
      { name: 'tag namespace', ok: true, note: 'mise-cluster exists' },
      { name: 'load balancers', ok: true, note: '3 needed, 7 free' },
      { name: 'zone', ok: true, note: `${request.baseDomain} answers` },
    ];
    for (const check of checks) call.log(`${check.ok ? 'ok' : 'NO'}  ${check.name}: ${check.note}`);
    return checks;
  }

  async iso_store(request: { cluster: string; url: string; region: string; compartmentId: string }, call: BuildCall): Promise<{ object: string; expires: string; link: string; linkId: string }> {
    await this.world.tick(2, call.signal);
    const object: string = `${request.cluster}-discovery.iso`;
    call.log(`stored ${object} in stratus-iso, linked for 7 days`);
    return { object, expires: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(), link: `https://objectstorage.example/p/fake/${object}`, linkId: this.world.id_next('link') };
  }

  async infra_plan(request: { cluster: string; spec: ClusterSpec; region: string; isoObject: string; stackRef?: string; compartmentId?: string; baseDomain?: string; isoLink?: string }, call: BuildCall): Promise<InfraPlan> {
    await this.world.tick(3, call.signal);
    if (request.stackRef !== undefined) {
      // A built stack re-planned: nothing to make, OCI's own tags to strip.
      const drift: PlanRow[] = specNodes_build(request.cluster, request.spec, FAKE_ZONES.length).map((node: SpecNode): PlanRow => ({ action: 'change', kind: 'instances', name: node.name, drift: true }));
      call.log(`plan job done: 0 to create, ${drift.length} to change, 0 to destroy`);
      return { ref: this.world.id_next('plan'), rows: drift };
    }
    const nodes: SpecNode[] = specNodes_build(request.cluster, request.spec, FAKE_ZONES.length);
    const create = (kind: string, name: string): PlanRow => ({ action: 'create', kind, name });
    const rows: PlanRow[] = [
      ...nodes.map((node: SpecNode): PlanRow => create('instances', node.name)),
      ...nodes.map((node: SpecNode): PlanRow => create('volumes', `${node.name}-boot`)),
      create('loadbalancers', `${request.cluster}-api`), create('loadbalancers', `${request.cluster}-api-int`), create('loadbalancers', `${request.cluster}-apps`),
      create('networks', `${request.cluster}-vcn`),
      create('subnets', 'private'), create('subnets', 'private-ocp'), create('subnets', 'public'),
      create('securitygroups', 'cluster-lb'), create('securitygroups', 'cluster-controlplane'), create('securitygroups', 'cluster-compute'),
      create('image', `${request.cluster}-discovery`),
    ];
    call.log(`plan job done: ${rows.length} to create, 0 to change, 0 to destroy`);
    return { ref: this.world.id_next('plan'), rows, stackRef: this.world.id_next('stack') };
  }

  async infra_apply(request: { cluster: string; plan: InfraPlan; region: string; stackRef?: string }, call: BuildCall): Promise<InfraOutputs> {
    for (let i: number = 0; i < 4 && call.signal.aborted !== true; i++) {
      await this.world.tick(1, call.signal);
      call.log(`apply job: ${Math.round(((i + 1) / 4) * request.plan.rows.length)} of ${request.plan.rows.length} created`);
    }
    const nodes: SpecNode[] = request.plan.rows
      .filter((row: PlanRow): boolean => row.kind === 'instances')
      .map((row: PlanRow, index: number): SpecNode => ({ name: row.name, role: row.name.includes('-cp-') ? 'plane' : 'worker', vcpu: 0, ramGib: 0, zoneIndex: index % FAKE_ZONES.length }));
    this.world.machines_boot(request.cluster, nodes);
    return {
      apiIp: '10.0.0.10', apiIntIp: '10.0.0.11', appsIp: '10.0.0.12', stackRef: request.stackRef ?? request.plan.stackRef ?? this.world.id_next('stack'),
      manifests: [{ name: 'oci-dynamic-custom-manifest.yml', content: '# the fake cloud controller and CSI driver\n' }],
    };
  }

  async dns_upsert(request: { cluster: string; baseDomain: string; outputs: InfraOutputs; compartmentId: string; region: string }, call: BuildCall): Promise<string[]> {
    await this.world.tick(1, call.signal);
    const names: string[] = [`api.${request.cluster}.${request.baseDomain}`, `api-int.${request.cluster}.${request.baseDomain}`, `*.apps.${request.cluster}.${request.baseDomain}`];
    call.log(`upserted ${names.join(', ')}`);
    return names;
  }

  async stackResources_count(request: { region: string; stackRef: string }): Promise<number> {
    return this.world.stackResources.get(request.stackRef) ?? 17;
  }

  async teardown_run(request: TeardownRequest, call: BuildCall): Promise<string[]> {
    await this.world.tick(4, call.signal);
    const gone: string[] = [];
    if (request.stackRef !== undefined && request.stackEmpty !== true) gone.push(`the stack's resources (${request.stackRef})`);
    if (request.baseDomain !== '') gone.push('3 DNS records');
    if (request.isoObject !== undefined) gone.push(`the image ${request.isoObject} and its link`);
    if (request.volumeIds.length > 0) gone.push(`${request.volumeIds.length} volumes the cluster made`);
    if (request.stackRef !== undefined) {
      this.world.stacks.delete(request.stackRef);
      this.world.stackResources.set(request.stackRef, 0);
      gone.push('the stack itself');
    }
    if (this.world.compartments.get(request.cluster) === request.compartmentId) {
      this.world.compartments.delete(request.cluster);
      gone.push(`the compartment clusters/${request.cluster}`);
    }
    for (const line of gone) call.log(`removed ${line}`);
    this.world.removed.push(...gone);
    return gone;
  }

  async stack_describe(stackId: string, _region: string): Promise<{ state: string; compartmentId: string; baseDomain: string | null; spec: ClusterSpec | null }> {
    const kept = this.world.stacks.get(stackId);
    if (kept === undefined) throw new Error(`${stackId}: no such stack`);
    return { ...kept };
  }

  async stack_adopt(request: { cluster: string; region: string; compartmentId: string; variables: Record<string, string>; state: Buffer; stackVersion: string }, call: BuildCall): Promise<string> {
    await this.world.tick(2, call.signal);
    call.log(`stack made for ${request.cluster} with ${Object.keys(request.variables).length} variables; ${request.state.length} bytes of state imported`);
    return this.world.id_next('stack');
  }
}

/** The fake installer. */
export class FakeInstaller implements Installer {
  readonly id: string = 'fake';
  private readonly roles: Map<string, 'master' | 'worker'> = new Map();
  readonly deleted: string[] = [];

  constructor(private readonly world: FakeBuildWorld, private readonly installTicks: number = 6) {}

  async cluster_create(request: { name: string; baseDomain: string; version: string; controlPlaneCount: number }): Promise<InstallerIds> {
    await this.world.tick(1);
    this.world.cluster_resolve(request.name);
    return { clusterId: `cluster-${request.name}`, infraEnvId: `infraenv-${request.name}` };
  }

  async isoUrl_get(ids: InstallerIds): Promise<{ url: string; expires: string }> {
    return { url: `https://installer.example/${ids.infraEnvId}/discovery.iso`, expires: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString() };
  }

  async manifests_upload(_ids: InstallerIds, _manifests: ReadonlyArray<PlatformManifest>): Promise<void> {
    await this.world.tick(1);
  }

  async hosts_list(ids: InstallerIds): Promise<InstallerHost[]> {
    return this.world.hosts_now(ids.clusterId.replace(/^cluster-/, '')).map((host: InstallerHost): InstallerHost => ({ ...host, role: this.roles.get(host.name) ?? host.role }));
  }

  async role_set(_ids: InstallerIds, host: InstallerHost, role: 'master' | 'worker'): Promise<void> {
    this.roles.set(host.name, role);
  }

  async install_start(ids: InstallerIds): Promise<void> {
    this.world.cluster_resolve(ids.clusterId.replace(/^cluster-/, '')).installStarted = Date.now();
  }

  async install_status(ids: InstallerIds): Promise<InstallStatus> {
    const started: number | undefined = this.world.cluster_resolve(ids.clusterId.replace(/^cluster-/, '')).installStarted;
    if (started === undefined) return { state: 'ready', percent: 0, note: 'ready to install' };
    const span: number = Math.max(this.world.tickMs * this.installTicks, 1);
    const percent: number = this.world.tickMs <= 0 ? 100 : Math.min(100, Math.round(((Date.now() - started) / span) * 100));
    return percent >= 100 ? { state: 'installed', percent: 100, note: 'installed' } : { state: 'installing', percent, note: percent < 50 ? 'writing the image to disk' : 'waiting for the control plane' };
  }

  async kubeconfig_get(ids: InstallerIds): Promise<string> {
    return `# the fake cluster ${ids.clusterId}'s kubeconfig\napiVersion: v1\nkind: Config\n`;
  }

  async credentials_get(ids: InstallerIds): Promise<InstallerCredentials> {
    return { username: 'kubeadmin', password: 'fake-password', consoleUrl: `https://console.apps.${ids.clusterId}.fake.example` };
  }

  async cluster_delete(ids: InstallerIds): Promise<void> {
    this.deleted.push(ids.clusterId);
  }
}
