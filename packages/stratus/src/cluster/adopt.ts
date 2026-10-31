/**
 * @file Adopting a cluster `harbor-oci` built (docs/stratus.adoc, D4, step 4b).
 *
 * Adoption has two halves. Read from the checkout, on the host: the ids the
 * build recorded (the Assisted Installer's cluster and infra-env, the ISO
 * object), the spec, the settings, the step evidence, and the secrets, copied
 * into the cluster's own `auth/` (mode 600, never served). Then, with the
 * `tasks` tier: a Resource Manager stack of the pinned release with the
 * cluster's own variables, tagged with its name, and its Terraform state
 * imported. From then on the cluster's state is stratus's own and the
 * checkout is no longer read.
 *
 * An adopted cluster is planned against, never built on: its apply is refused
 * until the operator allows it by name (decided 2026-10-22).
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobContext, JobRun } from '@fnndsc/brasa/core';
import { envFile_parse, harborCluster_read, type HarborCluster } from '../checkout/harborOci.js';
import type { CloudBuilder } from '../cloud/builder.js';
import { specYaml_parse, SPEC_DEFAULT, type ClusterSpec } from './spec.js';
import { smokeVerdict_words } from '../kube/chris.js';
import { MACHINE_STEPS } from './steps.js';
import { ADOPTED_COMPARTMENT } from './view.js';
import type { ClusterRecord, ClusterStore, StepRecord } from './state.js';

/** What adoption reads from a checkout. */
export interface CheckoutRead {
  readonly cluster: HarborCluster;
  readonly record: ClusterRecord;
  readonly spec: ClusterSpec;
  /** The stack's variables, each a string, as Resource Manager takes them. */
  readonly variables: Record<string, string>;
  /** Where the Terraform state is on the host. */
  readonly stateFile: string;
  /** The stack release the checkout pinned. */
  readonly stackVersion: string;
  /** The secrets to copy, by name and host path. */
  readonly secrets: ReadonlyArray<{ name: string; hostPath: string }>;
}

/** The secrets a cluster keeps from its checkout. */
const KEPT_SECRETS: ReadonlyArray<string> = ['kubeconfig', 'kubeadmin-password'];

/**
 * Terraform variables as Resource Manager takes them: every value a string.
 *
 * @param tfvars - The variables as `harbor-oci` wrote them.
 * @returns The same, stringified.
 */
export function variables_stringify(tfvars: Readonly<Record<string, unknown>>): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(tfvars)) variables[key] = typeof value === 'string' ? value : JSON.stringify(value);
  return variables;
}

/**
 * Reads what adoption needs from a `harbor-oci` checkout.
 *
 * @param name - The cluster's name here.
 * @param root - The checkout.
 * @param now - The clock.
 * @returns What it read, or why it cannot be adopted.
 */
/**
 * The ChRIS steps a checkout already did, from what `harbor-oci` left in its
 * state: it keeps no record of them, but the test user's password is made by
 * its seed (which needs the deploy), and its smoke journey's log ends with
 * the verdict. Its `postinstall` was a placeholder, and OCI needs none.
 *
 * @param root - The checkout.
 * @returns The steps it shows done.
 */
export function chrisSteps_read(root: string): Record<string, StepRecord> {
  const steps: Record<string, StepRecord> = { postinstall: { state: 'done', note: 'nothing to do after the install on this cloud' } };
  if (!existsSync(join(root, 'state', 'auth', 'chris-test-user-password'))) return steps;
  steps['chris-deploy'] = { state: 'done', note: 'done before adoption (harbor-oci: ChRIS seeded, so deployed)' };
  steps['chris-seed'] = { state: 'done', note: 'done before adoption (harbor-oci: the test user\'s password is kept)' };
  const smokeLog: string = join(root, 'state', 'smoke.log');
  const last: string = existsSync(smokeLog) ? readFileSync(smokeLog, 'utf-8').trim().split('\n').pop() ?? '' : '';
  const words: string = smokeVerdict_words(last);
  if (words.startsWith('pass')) steps['smoke'] = { state: 'done', note: `done before adoption (harbor-oci: ${words})` };
  return steps;
}

export function checkout_read(name: string, root: string, now: Date): CheckoutRead | { error: string } {
  if (!existsSync(join(root, 'config.env'))) return { error: `${root}: not a harbor-oci checkout (no config.env)` };
  const cluster: HarborCluster = harborCluster_read({ name, root }, now);
  const harbor: Record<string, unknown> | null = cluster.state;
  if (harbor === null) return { error: `${root}: no state/harbor.json: nothing was built from it` };
  const settings: Record<string, string> = {
    ...envFile_parse(existsSync(join(root, 'config.env')) ? readFileSync(join(root, 'config.env'), 'utf-8') : ''),
    ...envFile_parse(existsSync(join(root, 'config.local.env')) ? readFileSync(join(root, 'config.local.env'), 'utf-8') : ''),
  };
  const stackDir: unknown = harbor['stackDir'];
  if (typeof stackDir !== 'string') return { error: `${root}: state/harbor.json names no stackDir: infra-plan was never run` };
  const stackPath: string = stackDir.startsWith('/') ? stackDir : join(root, stackDir);
  const tfvarsFile: string = join(stackPath, 'harbor.auto.tfvars.json');
  const stateFile: string = join(stackPath, 'terraform.tfstate');
  if (!existsSync(tfvarsFile)) return { error: `${tfvarsFile}: missing` };
  if (!existsSync(stateFile)) return { error: `${stateFile}: missing: infra-apply was never run` };
  const region: string | undefined = settings['OCI_REGION'];
  const baseDomain: string | undefined = settings['BASE_DOMAIN'];
  const compartmentId: string | undefined = settings['OCI_COMPARTMENT_OCID'];
  if (region === undefined || baseDomain === undefined || compartmentId === undefined) return { error: `${root}: its settings lack OCI_REGION, BASE_DOMAIN or OCI_COMPARTMENT_OCID` };
  const parsed = cluster.spec === null ? { spec: SPEC_DEFAULT } : specYaml_parse(cluster.spec);
  if ('error' in parsed) return { error: `${root}/spec.yaml: ${parsed.error}` };
  const steps: Record<string, StepRecord> = {};
  for (const step of cluster.steps) {
    // The cluster runs, so every step through run happened, whatever the host kept to show it.
    if (MACHINE_STEPS.includes(step.name)) steps[step.name] = { state: 'done', note: `done before adoption (harbor-oci: ${step.state}, ${step.evidence})` };
  }
  steps['compartment'] = { ...ADOPTED_COMPARTMENT };
  Object.assign(steps, chrisSteps_read(root));
  const ids: Record<string, string> = {};
  for (const [key, field] of [['clusterId', 'assistedClusterId'], ['infraEnvId', 'assistedInfraEnvId'], ['isoObject', 'isoObjectName']] as const) {
    if (typeof harbor[field] === 'string') ids[key] = harbor[field] as string;
  }
  // The load balancers' addresses, from the state's outputs, for the DNS check.
  const outputs: Record<string, { value?: unknown }> = (JSON.parse(readFileSync(stateFile, 'utf-8')) as { outputs?: Record<string, { value?: unknown }> }).outputs ?? {};
  for (const [key, output] of [['apiIp', 'open_shift_api_lb_addr'], ['apiIntIp', 'open_shift_api_int_lb_addr'], ['appsIp', 'open_shift_apps_lb_addr']] as const) {
    if (typeof outputs[output]?.value === 'string') ids[key] = outputs[output]!.value as string;
  }
  const record: ClusterRecord = {
    name, created: now.toISOString(), region, baseDomain, steps, ids, compartmentId,
    adopted: { from: root, at: now.toISOString() },
  };
  const secrets = cluster.secrets.filter((secret): boolean => KEPT_SECRETS.includes(secret.name));
  return {
    cluster, record, spec: parsed.spec, stateFile, secrets,
    variables: variables_stringify(JSON.parse(readFileSync(tfvarsFile, 'utf-8')) as Record<string, unknown>),
    stackVersion: settings['OCI_STACK_VERSION'] ?? '',
  };
}

/**
 * Keeps an adopted cluster here: its record, its spec, its secrets.
 *
 * @param store - The clusters this daemon keeps.
 * @param read - What was read from the checkout.
 */
export function adoption_keep(store: ClusterStore, read: CheckoutRead): void {
  store.create(read.record, read.spec);
  for (const secret of read.secrets) store.secret_write(read.record.name, secret.name, readFileSync(secret.hostPath, 'utf-8'));
}

/**
 * The job that puts an adopted cluster's stack in Resource Manager.
 *
 * @param store - The clusters.
 * @param builder - The cloud's build half, one that can adopt.
 * @param name - The cluster.
 * @param variables - The stack's variables.
 * @param stateFile - Where the Terraform state is on the host.
 * @param compartmentId - Where the stack goes.
 * @param stackVersion - The stack release the cluster was built with.
 * @returns The job's work.
 */
export function adoptRun_make(store: ClusterStore, builder: CloudBuilder, name: string, variables: Record<string, string>, stateFile: string, compartmentId: string, stackVersion: string): JobRun {
  return async (context: JobContext): Promise<void> => {
    const record: ClusterRecord | null = store.record_read(name);
    if (record === null) throw new Error(`${name}: no such cluster`);
    if (record.ids['stackRef'] !== undefined) { context.log_write(`already in Resource Manager: ${record.ids['stackRef']}`); return; }
    if (builder.stack_adopt === undefined) throw new Error(`${builder.id}: this cloud cannot adopt a stack`);
    const stackRef: string = await builder.stack_adopt(
      { cluster: name, region: record.region, compartmentId, variables, state: readFileSync(stateFile), stackVersion },
      { log: (line: string): void => context.log_write(line), signal: context.signal },
    );
    if (context.signal.aborted) return;
    store.record_update(name, (current: ClusterRecord): void => { current.ids['stackRef'] = stackRef; });
    context.log_write(`adopted: stack ${stackRef}`);
  };
}
