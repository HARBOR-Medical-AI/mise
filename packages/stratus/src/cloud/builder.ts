/**
 * @file The cloud driver's build half: what a cluster's steps ask of a cloud
 * (docs/stratus.adoc, D3). The read half is `driver.ts`; a cloud that cannot
 * build yet has a driver and no builder, and the build verbs say so.
 *
 * OCI's builder runs Terraform in Resource Manager: a plan is a plan job
 * read as JSON, an apply is an apply job. Its plan says which changes are
 * `Oracle-Tags` drift, so a re-plan can be read for real change (D6).
 *
 * @module
 */
import type { ClusterSpec } from '../cluster/spec.js';
import type { PlatformManifest } from '../installer/installer.js';

/** One check the build makes before it starts. */
export interface PreflightCheck {
  name: string;
  ok: boolean;
  note: string;
}

/** One change a plan would make. */
export interface PlanRow {
  action: 'create' | 'change' | 'destroy';
  /** The neutral kind (`instances`, `loadbalancers`, …) or the cloud's own. */
  kind: string;
  name: string;
  /** A change the cloud makes to its own tags after an apply, not a real one. */
  drift?: boolean;
  /** The cloud's own type of the resource (`oci_core_instance`), when the plan says it. */
  type?: string;
  /** A change's leaves, as paths into the resource (`shape_config.ocpus`), each before and after; absent when the plan does not say. */
  changes?: ReadonlyArray<{ path: string; before: string | null; after: string | null }>;
}

/**
 * An infrastructure plan, as the operator is asked about it.
 *
 * @property ref - The cloud's handle on it, for the apply (OCI: the plan job's id).
 * @property rows - Each change.
 */
export interface InfraPlan {
  ref: string;
  rows: ReadonlyArray<PlanRow>;
  /** The stack the plan was made in, when the plan made one. */
  stackRef?: string;
}

/** A plan's counts: a resource both destroyed and created is replaced, drift is apart from real change. */
export interface PlanCounts {
  create: number;
  replace: number;
  change: number;
  drift: number;
  destroy: number;
  /** The kinds replaced, for the line. */
  replacedKinds: string[];
}

/**
 * A plan's counts (D6).
 *
 * @param plan - The plan.
 * @returns Creations, replacements, real changes, drift, destructions.
 */
export function plan_count(plan: InfraPlan): PlanCounts {
  const rows: ReadonlyArray<PlanRow> = plan.rows;
  const created: Set<string> = new Set(rows.filter((row: PlanRow): boolean => row.action === 'create').map((row: PlanRow): string => row.name));
  const replaced: PlanRow[] = rows.filter((row: PlanRow): boolean => row.action === 'destroy' && created.has(row.name));
  const replacedNames: Set<string> = new Set(replaced.map((row: PlanRow): string => row.name));
  return {
    create: rows.filter((row: PlanRow): boolean => row.action === 'create' && !replacedNames.has(row.name)).length,
    replace: replaced.length,
    change: rows.filter((row: PlanRow): boolean => row.action === 'change' && row.drift !== true).length,
    drift: rows.filter((row: PlanRow): boolean => row.action === 'change' && row.drift === true).length,
    destroy: rows.filter((row: PlanRow): boolean => row.action === 'destroy' && !replacedNames.has(row.name)).length,
    replacedKinds: [...new Set(replaced.map((row: PlanRow): string => row.kind))].sort(),
  };
}

/**
 * Whether a plan touches anything that exists, drift aside: what an apply refuses unless asked by name.
 *
 * @param counts - The plan's counts.
 * @returns True when it replaces, changes or destroys.
 */
export function planCounts_alter(counts: PlanCounts): boolean {
  return counts.replace > 0 || counts.change > 0 || counts.destroy > 0;
}

/**
 * A plan's counts in a line.
 *
 * @param counts - The counts.
 * @returns `3 to create, 21 to replace (loadbalancers), 0 to change and 24 Oracle-Tags drift, 0 to destroy`.
 */
export function planCounts_words(counts: PlanCounts): string {
  const replace: string = counts.replace > 0 ? `, ${counts.replace} to replace (${counts.replacedKinds.join(', ')})` : '';
  const drift: string = counts.drift > 0 ? ` and ${counts.drift} Oracle-Tags drift` : '';
  return `${counts.create} to create${replace}, ${counts.change} to change${drift}, ${counts.destroy} to destroy`;
}

/** What every builder call is given to report with and to stop on. */
export interface BuildCall {
  /** Writes a line to the step's log. */
  readonly log: (line: string) => void;
  /** Aborted when the operator asks the step to stop. */
  readonly signal: AbortSignal;
}

/** The addresses an apply leaves for the DNS records. */
export interface InfraOutputs {
  /** The API's load balancer address. */
  apiIp: string;
  /** The internal API's address. */
  apiIntIp: string;
  /** The applications' (`*.apps`) address. */
  appsIp: string;
  /** The stack's handle, for a later plan and the teardown. */
  stackRef: string;
  /** The platform manifests the stack made for the installer (OCI: its cloud controller and CSI driver). */
  manifests: PlatformManifest[];
}

/** What a cluster's teardown removes, beside its stack. */
export interface TeardownRequest {
  readonly cluster: string;
  readonly region: string;
  readonly compartmentId: string;
  readonly baseDomain: string;
  /** The stack whose resources a destroy job removes, when one was made. */
  readonly stackRef?: string;
  /** The discovery image and its link, when the iso step ran. */
  readonly isoObject?: string;
  readonly isoLinkId?: string;
  /** Block volumes the cluster made that the stack never knew (its CSI claims). */
  readonly volumeIds: ReadonlyArray<string>;
}

/** The teardown's steps, in the order they run; each lands on the record as it begins and ends. The installer's is the kernel's, after the cloud's. */
export const TEARDOWN_STEPS = ['destroy', 'dns', 'image', 'volumes', 'stack', 'compartment', 'installer'] as const;
export type TeardownStep = typeof TEARDOWN_STEPS[number];

/** What a teardown step is reported as: `skipped` when there was nothing of it to remove. */
export type TeardownStepState = 'running' | 'done' | 'skipped' | 'failed';

/** The note on a step passed over because an earlier pass finished it: the record keeps that pass's time and words. */
export const EARLIER_PASS: string = 'done by an earlier pass';

/** What a teardown is given beyond a build call: each step's beginning and end, and the steps an earlier pass finished. */
export interface TeardownCall extends BuildCall {
  readonly step: (name: TeardownStep, state: TeardownStepState, note?: string) => void;
  readonly done: ReadonlySet<TeardownStep>;
}

/**
 * Runs one step of a teardown: passed over when an earlier pass finished it,
 * begun and ended on the call, failed with why when its work throws.
 *
 * @param call - The teardown's call.
 * @param name - The step.
 * @param work - Its work; answers what went, or null when there was nothing of it to remove.
 * @returns What went, or null.
 */
export async function teardownStep_run(call: TeardownCall, name: TeardownStep, work: () => Promise<string | null>): Promise<string | null> {
  if (call.done.has(name)) {
    call.step(name, 'done', EARLIER_PASS);
    return null;
  }
  call.step(name, 'running');
  try {
    const went: string | null = await work();
    call.step(name, went === null ? 'skipped' : 'done', went ?? 'nothing of it to remove');
    return went;
  } catch (error: unknown) {
    call.step(name, 'failed', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** A Terraform module the driver keeps, each made into a stack of its own (docs/stratus.adoc, D16): `net` is a network's; a VM has two, its data's (kept by a default teardown) and its machine's. */
export type StackModule = 'net' | 'vmData' | 'vmMachine';

/**
 * A module's stack, planned: made in the place when it has no stack yet,
 * its variables set again when it has one.
 *
 * @property module - Which module.
 * @property owner - What the stack belongs to, as the tag it carries (`mise-net=<name>`).
 * @property region - Where its calls go.
 * @property placeId - The place it is made in (OCI: a compartment).
 * @property inputs - What the module is given, in neutral words (`net`: `cidr`, `clientCidr`); the driver lowers them to its own.
 * @property stackRef - Its stack, when one was made already.
 */
/** A module's stack read back from the cloud: which module, its handle, and the inputs it was last given. */
export interface ModuleStackRead {
  readonly module: StackModule;
  readonly stackRef: string;
  readonly inputs: Readonly<Record<string, string>>;
  /** What its last apply left (its Terraform state's outputs); empty when nothing was applied. */
  readonly outputs: Readonly<Record<string, string>>;
}

export interface ModulePlanRequest {
  readonly module: StackModule;
  readonly owner: { readonly tag: string; readonly name: string };
  readonly region: string;
  readonly placeId: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly stackRef?: string;
}

/**
 * A place stratus keeps a network in, under the tenancy's root (OCI: a
 * compartment named as the network).
 *
 * @property id - Its id.
 * @property made - Whether this call made it.
 * @property tagged - Whether it carries the owner's tag already: made by stratus, or adopted before.
 */
export interface PlaceAnswer {
  readonly id: string;
  readonly made: boolean;
  readonly tagged: boolean;
}

/**
 * A shell session asked of a network's managed bastion: a port forward to a
 * VM's SSH, admitting one public key, for a while.
 *
 * @property bastionId - The bastion.
 * @property privateIp - The VM's address inside the network.
 * @property publicKey - The key the session admits (OpenSSH's line).
 * @property ttlSeconds - How long it lasts.
 */
export interface ShellSessionRequest {
  readonly region: string;
  readonly bastionId: string;
  readonly privateIp: string;
  readonly publicKey: string;
  readonly ttlSeconds: number;
  readonly label: string;
}

/** A session opened: SSH reaches the VM as `<sessionId>@<host>` forwarding to its port 22. */
export interface ShellSession {
  readonly sessionId: string;
  readonly host: string;
}

/** A cloud's build half. */
export interface CloudBuilder {
  /**
   * A place of a name under the tenancy's root, made with the owner's tag
   * when there is none and waited on until it is usable. One that is there
   * is answered as it is; whether it may be adopted is the caller's to ask.
   */
  place_ensure?(request: { name: string; region: string; tag: string }, call: BuildCall): Promise<PlaceAnswer>;
  /** Puts the owner's tag on a place adopted. */
  place_tag?(request: { placeId: string; region: string; tag: string; name: string }, call: BuildCall): Promise<void>;
  /** Removes a place stratus made, or takes the owner's tag off one it adopted. Returns what was done, in a line. */
  place_release?(request: { placeId: string; region: string; tag: string; made: boolean }, call: BuildCall): Promise<string>;
  /** Plans a module's stack; the plan's `stackRef` is the stack, made or found. */
  modulePlan_run?(request: ModulePlanRequest, call: BuildCall): Promise<InfraPlan>;
  /** Applies a module's plan; answers the stack's outputs. */
  moduleApply_run?(request: { region: string; stackRef: string; plan: InfraPlan; label: string }, call: BuildCall): Promise<Record<string, string>>;
  /** Destroys what a module's stack holds, then the stack. Returns what went, a line each. */
  moduleDestroy_run?(request: { region: string; stackRef: string; label: string }, call: BuildCall): Promise<string[]>;
  /** Merges freeform tags onto a VM's instance: what was put on it (ChRIS's address), said where any session reading the tenancy finds it. */
  instance_tag?(request: { region: string; instanceId: string; tags: Readonly<Record<string, string>> }, call: BuildCall): Promise<void>;
  /** The module stacks a place holds for one owner, read back from the cloud in the words a plan was given (the inputs), for a session that keeps no record of them (a VM found in the tenancy, taken over on its first act). */
  moduleStacks_read?(request: { region: string; placeId: string; tag: string; owner: string }): Promise<ModuleStackRead[]>;
  /**
   * What the tenancy keeps for stratus by name (docs/stratus.adoc, D16): a
   * secret's content (a VM's SSH key and its ChRIS's passwords, as one JSON
   * text), read back by any session on any host that holds the tenancy's
   * credentials; null when none is kept. The host's copy is a cache of it.
   */
  keep_read?(request: { region: string; name: string }): Promise<string | null>;
  /** Writes what the tenancy keeps by name: a new version of it, the keep made first when the tenancy has none. */
  keep_write?(request: { region: string; name: string; content: string }, call: BuildCall): Promise<void>;
  /** Drops what the tenancy keeps by name (OCI: scheduled for deletion a day on); answers whether it was kept. */
  keep_drop?(request: { region: string; name: string }, call: BuildCall): Promise<boolean>;
  /** The shape a VM is made of (D16: the driver chooses the family), for its price. */
  readonly vmShape?: string;
  /** Points a reserved public address at a machine's private one. */
  address_point?(request: { region: string; publicIpId: string; privateIpId: string }, call: BuildCall): Promise<void>;
  /** Opens a shell session on a network's managed bastion, waited on until it admits. */
  shellSession_open?(request: ShellSessionRequest, call: BuildCall): Promise<ShellSession>;
  /** Its id (`oci`, `fake`). */
  readonly id: string;
  /** The DNS zones the tenancy holds, by name: where a new cluster's names may live. */
  zones_list?(region: string): Promise<string[]>;
  /**
   * The cluster's own compartment, `clusters/<name>` under the tenancy, tagged
   * `mise-cluster=<name>`, made with its `clusters` parent when either is
   * missing and waited on until it is active. Answers the compartment's id,
   * and whether this call made it.
   */
  compartment_ensure?(request: { cluster: string; region: string }, call: BuildCall): Promise<{ id: string; made: boolean }>;
  /** Checks the tenancy can take the cluster: keys, limits, the tag namespace, the zone. */
  preflight(request: { cluster: string; spec: ClusterSpec; region: string; baseDomain: string; compartmentId: string }, call: BuildCall): Promise<PreflightCheck[]>;
  /** Puts the discovery image where the machines boot from: its object, a link to it (a secret) and the link's end. */
  iso_store(request: { cluster: string; url: string; region: string; compartmentId: string }, call: BuildCall): Promise<{ object: string; expires: string; link: string; linkId: string }>;
  /** Plans the infrastructure: against the cluster's stack when it has one (adopted, or a re-plan), else in a new one. */
  infra_plan(request: { cluster: string; spec: ClusterSpec; region: string; isoObject: string; stackRef?: string; compartmentId?: string; baseDomain?: string; isoLink?: string }, call: BuildCall): Promise<InfraPlan>;
  /** Applies a plan. Billing starts here. */
  infra_apply(request: { cluster: string; plan: InfraPlan; region: string; stackRef?: string }, call: BuildCall): Promise<InfraOutputs>;
  /** Writes the cluster's records in its zone. */
  dns_upsert(request: { cluster: string; baseDomain: string; outputs: InfraOutputs; compartmentId: string; region: string }, call: BuildCall): Promise<string[]>;
  /** Takes in infrastructure built elsewhere: a stack with its variables and its Terraform state; returns the stack's handle. */
  /** How many resources a stack's state holds: what a destroy job removes. */
  stackResources_count?(request: { region: string; stackRef: string }): Promise<number>;
  /**
   * Removes what a cluster built: the stack's resources (a destroy job), then
   * its records, image, link and volumes; then the stack itself, any block
   * volume still in its compartment carrying the attribution tag, and the
   * compartment with its image bucket when stratus made it (`clusters/<name>`),
   * else the cluster's tag off the compartment. Returns what went, a line each.
   */
  teardown_run?(request: TeardownRequest, call: TeardownCall): Promise<string[]>;
  stack_adopt?(request: { cluster: string; region: string; compartmentId: string; variables: Record<string, string>; state: Buffer; stackVersion: string }, call: BuildCall): Promise<string>;
  /** A stack found in the tenancy, read back: its state, its compartment, and the zone and spec its variables say; absent, a found cluster adopts without a spec. */
  stack_describe?(stackId: string, region: string): Promise<{ state: string; compartmentId: string; baseDomain: string | null; spec: ClusterSpec | null }>;
}
