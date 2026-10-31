/**
 * @file `cluster protect <name> on|off`: whether a cluster may be torn down.
 *
 * A cluster is born protected (docs/stratus.adoc, D14). Lifting it is a line
 * of its own, so tearing a tenant down takes two deliberate acts: this, and
 * teardown's name typed back. It changes only the cluster's state on this
 * host, never the cloud, so it needs no tier. Bare, it says how the cluster
 * stands.
 *
 * @module
 */
import chalk from 'chalk';
import { envelope_error, envelope_ok, type CommandEnvelope } from '@fnndsc/menu';
import type { ClusterRecord } from '../cluster/state.js';
import type { BuildCommandContext } from './build.js';

/**
 * `cluster protect <name> [on|off]`.
 *
 * @param context - The session.
 * @param args - The words after `protect`.
 * @returns The envelope.
 */
export async function clusterProtect_run(context: BuildCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const [name, setting, ...extra] = args;
  if (name === undefined || extra.length > 0 || (setting !== undefined && setting !== 'on' && setting !== 'off')) {
    return envelope_error('', undefined, 'cluster protect: usage: cluster protect <name> [on|off]\n');
  }
  const record: ClusterRecord | null = context.store.record_read(name);
  if (record === null) return envelope_error('', undefined, `cluster protect: ${name}: no such cluster kept here\n`);
  if (setting === undefined) {
    return envelope_ok(`${name}: ${record.protected !== false ? 'protected (teardown refused)' : 'not protected (teardown asks for its name)'}\n`);
  }
  context.store.record_update(name, (current: ClusterRecord): void => { current.protected = setting === 'on'; });
  return envelope_ok(setting === 'on'
    ? `${name}: protected; teardown is refused\n`
    : `${chalk.yellow(name)}: no longer protected; cluster teardown ${name} will ask for its name\n`);
}
