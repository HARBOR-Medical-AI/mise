/**
 * @file `cluster verify [<name>]`: the ten checks against a cluster
 * (docs/stratus.adoc, D7), through its kubeconfig on the host, which never
 * leaves it. The result is kept as the cluster's verify step, so `cluster
 * status` and the CLUSTERS tile show it.
 *
 * @module
 */
import { promises as dns } from 'node:dns';
import { readFileSync } from 'node:fs';
import chalk from 'chalk';
import { envelope_error, envelope_ok, type CommandEnvelope } from '@fnndsc/menu';
import { commandCancellation_enable, commandCancellation_signalGet, surface_get } from '@fnndsc/brasa/core';
import { kubeconfig_read, type KubeApi } from '../kube/kube.js';
import { httpsStatus_get, kubeApi_make } from '../kube/kubeHttp.js';
import type { HarborCluster } from '../checkout/harborOci.js';
import type { ClusterRecord } from '../cluster/state.js';
import { familyShape_find } from '../cluster/sizing.js';
import { verify_run, verifyChecks_keep, type VerifyCheck } from '../cluster/verify.js';
import type { BuildCommandContext } from './build.js';

/** The resolver `verify` asks, as `harbor-oci` did: one outside the tenancy. */
export const PUBLIC_RESOLVER: string = '8.8.8.8';

/** What `verify` reaches the cluster and the world with; a test hands in its own. */
export interface VerifyReach {
  readonly kube_make: (kubeconfig: string) => KubeApi;
  readonly resolve: (name: string) => Promise<string[]>;
  readonly https_status: (url: string, ca: string | null) => Promise<number>;
  readonly probeTimeoutMs: number;
  readonly pollMs: number;
}

/**
 * The reach over the network: the Kubernetes API, a public resolver, HTTPS.
 *
 * @returns The reach.
 */
export function verifyReach_default(): VerifyReach {
  const resolver: dns.Resolver = new dns.Resolver();
  resolver.setServers([PUBLIC_RESOLVER]);
  return {
    kube_make: (kubeconfig: string): KubeApi => kubeApi_make(kubeconfig_read(kubeconfig)),
    resolve: (name: string): Promise<string[]> => resolver.resolve4(name),
    https_status: httpsStatus_get,
    probeTimeoutMs: 300_000,
    pollMs: 5_000,
  };
}

/**
 * A check as a line.
 *
 * @param check - The check.
 * @returns The line.
 */
function check_line(check: VerifyCheck): string {
  const mark: string = check.ok === null ? chalk.gray('·') : check.ok ? chalk.cyan('✓') : chalk.red('✗');
  return `  ${mark} ${check.name.padEnd(16)} ${check.ok === false ? chalk.red(check.detail) : check.detail}${check.how === 'writes' ? chalk.yellow('  (writes)') : ''}`;
}

/**
 * `cluster verify [<name>]`.
 *
 * @param context - The session.
 * @param reach - How the checks reach the cluster.
 * @param args - The words after `verify`.
 * @returns The envelope: failed when a check failed.
 */
export async function clusterVerify_run(context: BuildCommandContext, reach: VerifyReach, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  if (args.length > 1 || args.some((word: string): boolean => word.startsWith('-'))) return envelope_error('', undefined, 'cluster verify: usage: cluster verify [<name>]\n');
  const kept: string[] = context.store.names_list();
  const name: string | undefined = args[0] ?? (kept.length === 1 ? kept[0] : undefined);
  if (name === undefined) return envelope_error('', undefined, `cluster verify: which cluster? (${kept.join(', ') || 'none kept here'})\n`);
  const cluster: HarborCluster | null = context.clusters.cluster_read(name);
  if (cluster === null) return envelope_error('', undefined, `cluster verify: ${name}: no such cluster\n`);
  const record: ClusterRecord | null = context.store.record_read(name);
  if (cluster.origin !== 'built' || record === null) return envelope_error('', undefined, `cluster verify: ${name}: read from a harbor-oci checkout; cluster adopt ${name} --from ${cluster.root} keeps it here first\n`);
  const kubeconfig = cluster.secrets.find((secret): boolean => secret.name === 'kubeconfig');
  if (kubeconfig === undefined) return envelope_error('', undefined, `cluster verify: ${name}: no kubeconfig yet: its cluster is not installed\n`);
  const spec = context.store.spec_read(name)?.spec ?? null;
  const shapes = context.region() === null ? [] : await context.driver.shapes_list(record.region).catch(() => []);
  commandCancellation_enable();
  const checks: VerifyCheck[] = await verify_run({
    kube: reach.kube_make(readFileSync(kubeconfig.hostPath, 'utf-8')),
    resolve: reach.resolve,
    https_status: reach.https_status,
    cluster: name,
    baseDomain: record.baseDomain,
    shape: spec === null ? null : familyShape_find(shapes, spec.family)?.name ?? null,
    expectedNodes: spec === null ? 0 : spec.controlPlane.count + spec.workers.count,
    addresses: { api: record.ids['apiIp'], apiInt: record.ids['apiIntIp'], apps: record.ids['appsIp'] },
    probe: surface_get().capabilities.tasks === true,
    probeTimeoutMs: reach.probeTimeoutMs,
    pollMs: reach.pollMs,
    ...(commandCancellation_signalGet() !== undefined ? { signal: commandCancellation_signalGet() } : {}),
  });
  const summary: string = verifyChecks_keep(context.store, name, checks);
  const failed: boolean = checks.some((check: VerifyCheck): boolean => check.ok === false);
  const text: string = [`${chalk.bold(name)}  ${name}.${record.baseDomain}`, ...checks.map(check_line), `verify: ${summary}`].join('\n');
  return failed ? { ...envelope_error(`${text}\n`), renderedErr: '' } : envelope_ok(`${text}\n`);
}
