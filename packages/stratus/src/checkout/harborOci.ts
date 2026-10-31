/**
 * @file A cluster as a `harbor-oci` checkout leaves it on the host.
 *
 * The first cluster stratus reads is the one `harbor-oci` built
 * (docs/stratus.adoc, "What exists"): its `spec.yaml`, its settings
 * (`config.env` under `config.local.env`), its state document
 * (`state/harbor.json`), the Terraform state in the staged stack, and the
 * credentials in `state/auth/`. This module reads them and nothing else.
 *
 * `harbor-oci` records no history of its steps: each step records only what
 * a later step needs. So a step's state is read from that evidence (`done`
 * with what shows it), and a step whose result is kept nowhere on the host
 * is `unknown`, never guessed. Secrets never leave this module as text: the
 * ISO link's URL is withheld from `state.json`, the credential files are
 * named with their host path only, and the Terraform state is counted, never
 * shown.
 *
 * @module
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ClusterSpec } from '../cluster/spec.js';

/** The build's steps, in the order `just install` runs them. */
export const HARBOR_STEPS: ReadonlyArray<string> = ['preflight', 'cluster', 'iso', 'infra-plan', 'infra-apply', 'dns', 'manifests', 'hosts', 'run', 'postinstall', 'verify'];

/** The settings a cluster shows; every other key (credentials among them) stays on the host. */
const SHOWN_SETTINGS: ReadonlyArray<string> = ['CLUSTER_NAME', 'BASE_DOMAIN', 'OCI_REGION', 'OCI_COMPARTMENT_OCID', 'OCP_VERSION', 'OCI_STACK_VERSION'];

/** The fields of `state/harbor.json` that are secrets. */
const SECRET_STATE_FIELDS: ReadonlyArray<string> = ['parUrl'];

/** Where one step stands. */
export interface StepState {
  /** Its folder name, numbered in build order (`05-infra-apply`). */
  readonly folder: string;
  readonly name: string;
  /** `done`, `not done`, `expired`, or `unknown` when the host keeps nothing to tell. */
  readonly state: string;
  /** What the state rests on, in a line. */
  readonly evidence: string;
}

/** A secret the cluster holds on the host. */
export interface ClusterSecret {
  readonly name: string;
  /** Where it is on the host; the only thing about it a surface is told. */
  readonly hostPath: string;
}

/** A cluster read from a `harbor-oci` checkout. */
export interface HarborCluster {
  readonly name: string;
  /** The checkout. */
  readonly root: string;
  /** `spec.yaml` as written, or null when there is none. */
  readonly spec: string | null;
  /** The shown settings, by key. */
  readonly settings: Readonly<Record<string, string>>;
  /** `state/harbor.json` with its secrets withheld, or null when there is none. */
  readonly state: Readonly<Record<string, unknown>> | null;
  /** Every step, in build order. */
  readonly steps: ReadonlyArray<StepState>;
  /** The credential files in `state/auth/`. */
  readonly secrets: ReadonlyArray<ClusterSecret>;
  /** The cluster's DNS name, `<CLUSTER_NAME>.<BASE_DOMAIN>`, or null. */
  readonly cluster: string | null;
  /** Where it comes from: a `harbor-oci` checkout read, built by this daemon, or found in the tenancy by its tag and not adopted (absent: a checkout). */
  readonly origin?: 'checkout' | 'built' | 'found';
  /** For one found in the tenancy: what carries its tag, and what the cloud says of it (`cluster/found.ts`). */
  readonly found?: {
    readonly stack: { readonly id: string; readonly state: string; readonly compartmentId: string } | null;
    readonly compartmentId: string | null;
    readonly baseDomain: string | null;
    readonly spec: ClusterSpec | null;
    readonly resources: Readonly<Record<string, number>> | null;
    readonly stackResources: number | null;
    /** Machines live (UP), something of its stack stands (STOPPED), or nothing is left but its tag (GONE). */
    readonly condition: 'UP' | 'STOPPED' | 'GONE';
  };
}

/** Where a cluster is read from: its name and its checkout. */
export interface ClusterSource {
  readonly name: string;
  readonly root: string;
}

/**
 * Reads `KEY=value` lines; comments, blanks and quotes handled as a shell
 * `.env` writes them.
 *
 * @param text - The file's text.
 * @returns The values, by key.
 */
export function envFile_parse(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line: string = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const equals: number = line.indexOf('=');
    if (equals <= 0) continue;
    const key: string = line.slice(0, equals).trim().replace(/^export\s+/, '');
    let value: string = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

/** A file's text, or null when it is not there. */
function text_read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}

/** The shown settings: `config.env`, then `config.local.env` over it, only the keys a cluster shows. */
function settings_read(root: string): Record<string, string> {
  const merged: Record<string, string> = {
    ...envFile_parse(text_read(join(root, 'config.env')) ?? ''),
    ...envFile_parse(text_read(join(root, 'config.local.env')) ?? ''),
  };
  const shown: Record<string, string> = {};
  for (const key of SHOWN_SETTINGS) if (merged[key] !== undefined && merged[key] !== '') shown[key] = merged[key];
  return shown;
}

/** The state document with its secrets replaced by where they are. */
function state_read(root: string): Record<string, unknown> | null {
  const path: string = join(root, 'state', 'harbor.json');
  const text: string | null = text_read(path);
  if (text === null) return null;
  const state: Record<string, unknown> = JSON.parse(text) as Record<string, unknown>;
  for (const field of SECRET_STATE_FIELDS) {
    if (state[field] !== undefined) state[field] = `withheld: a secret, on the host in ${path}`;
  }
  return state;
}

/** How many resources a Terraform state holds; null when there is no state. */
function terraformResources_count(stackDir: string): number | null {
  const text: string | null = text_read(join(stackDir, 'terraform.tfstate'));
  if (text === null) return null;
  const resources: unknown = (JSON.parse(text) as { resources?: unknown }).resources;
  return Array.isArray(resources) ? resources.length : 0;
}

/**
 * Where each step stands, from the evidence the checkout keeps.
 *
 * @param root - The checkout.
 * @param state - The state document as read (secrets withheld does not matter here).
 * @param now - The clock.
 * @returns One state per step, in build order.
 */
export function steps_read(root: string, state: Readonly<Record<string, unknown>> | null, now: Date = new Date()): StepState[] {
  const known = (name: string, done: boolean, evidence: string): Omit<StepState, 'folder'> => ({ name, state: done ? 'done' : 'not done', evidence });
  const unknown = (name: string, why: string): Omit<StepState, 'folder'> => ({ name, state: 'unknown', evidence: why });
  const field = (key: string): string | null => (typeof state?.[key] === 'string' ? (state[key] as string) : null);
  const stackDir: string | null = field('stackDir');
  const resources: number | null = stackDir !== null ? terraformResources_count(stackDir) : null;
  const kubeconfig: string = join(root, 'state', 'auth', 'kubeconfig');
  const steps: Record<string, Omit<StepState, 'folder'>> = {
    preflight: unknown('preflight', 'its checks are run live and not kept'),
    cluster: known('cluster', field('assistedClusterId') !== null && field('assistedInfraEnvId') !== null, field('assistedClusterId') !== null ? `Assisted Installer cluster ${field('assistedClusterId')}` : 'no Assisted Installer cluster in state'),
    iso: ((): Omit<StepState, 'folder'> => {
      const expires: string | null = field('parExpiresAt');
      if (field('parId') === null) return known('iso', false, 'no ISO link in state');
      if (expires !== null && new Date(expires).getTime() < now.getTime()) return { name: 'iso', state: 'expired', evidence: `${field('isoObjectName') ?? 'the ISO'}: its link expired ${expires}` };
      return known('iso', true, `${field('isoObjectName') ?? 'the ISO'}: link valid until ${expires ?? 'unknown'}`);
    })(),
    'infra-plan': known('infra-plan', stackDir !== null && existsSync(join(stackDir, 'harbor.auto.tfvars.json')), stackDir !== null ? `stack staged at ${stackDir}` : 'no stack staged'),
    'infra-apply': known('infra-apply', (resources ?? 0) > 0, resources === null ? 'no Terraform state' : `Terraform state holds ${resources} resources`),
    dns: unknown('dns', 'its records are in the zone, not in state; see dns/ in the compartment'),
    manifests: unknown('manifests', 'pushed to the Assisted Installer, not kept on the host'),
    hosts: unknown('hosts', 'host registration is the Assisted Installer\'s, not kept on the host'),
    run: known('run', existsSync(kubeconfig), existsSync(kubeconfig) ? `kubeconfig saved at ${kubeconfig}` : 'no kubeconfig saved'),
    postinstall: known('postinstall', false, 'a placeholder in harbor-oci, never run'),
    verify: unknown('verify', 'its checks are run live and not kept'),
  };
  return HARBOR_STEPS.map((name: string, index: number): StepState => ({ folder: `${String(index + 1).padStart(2, '0')}-${name}`, ...(steps[name] as Omit<StepState, 'folder'>) }));
}

/** The credential files in `state/auth/`, by name and host path. */
function secrets_read(root: string): ClusterSecret[] {
  const auth: string = join(root, 'state', 'auth');
  if (!existsSync(auth) || !statSync(auth).isDirectory()) return [];
  return readdirSync(auth).sort().map((name: string): ClusterSecret => ({ name, hostPath: join(auth, name) }));
}

/**
 * Reads a cluster from its checkout.
 *
 * @param source - The cluster's name and checkout.
 * @param now - The clock, for the ISO link's expiry.
 * @returns The cluster.
 */
export function harborCluster_read(source: ClusterSource, now: Date = new Date()): HarborCluster {
  const settings: Record<string, string> = settings_read(source.root);
  const state: Record<string, unknown> | null = state_read(source.root);
  const cluster: string | null = settings['CLUSTER_NAME'] !== undefined && settings['BASE_DOMAIN'] !== undefined ? `${settings['CLUSTER_NAME']}.${settings['BASE_DOMAIN']}` : null;
  return {
    name: source.name,
    root: source.root,
    spec: text_read(join(source.root, 'spec.yaml')),
    settings,
    state,
    steps: steps_read(source.root, state, now),
    secrets: secrets_read(source.root),
    cluster,
  };
}

/**
 * The step a cluster last finished, in build order; null when none is done.
 *
 * @param cluster - The cluster.
 * @returns The step.
 */
export function lastDone_find(cluster: HarborCluster): StepState | null {
  const done: StepState[] = cluster.steps.filter((step: StepState): boolean => step.state === 'done');
  return done.length > 0 ? (done[done.length - 1] as StepState) : null;
}
