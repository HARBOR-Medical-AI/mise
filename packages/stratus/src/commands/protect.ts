/**
 * @file `cluster protect <name> on|off`: whether a cluster may be torn down.
 *
 * A cluster is born protected (docs/stratus.adoc, D14). Lifting it is a line
 * of its own, so tearing a tenant down takes two deliberate acts: this, and
 * teardown's name typed back. The tenancy keeps the lock (the vault's
 * `mise-cluster-<name>`, `cluster/keep.ts`), so a lock set on one host holds
 * on every host: a MANAGE session writes it there; a session below the tasks
 * tier sets it on this host only and says so. Bare, it says how the cluster
 * stands, as the tenancy keeps it.
 *
 * @module
 */
import chalk from 'chalk';
import { envelope_error, envelope_ok, type CommandEnvelope } from '@fnndsc/menu';
import type { ClusterRecord } from '../cluster/state.js';
import { clusterLock_refresh, clusterLock_write } from '../cluster/keep.js';
import { lock_where } from '../kept/lock.js';
import { tasks_granted, type BuildCommandContext } from './build.js';

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
  if (context.store.record_read(name) === null) return envelope_error('', undefined, `cluster protect: ${name}: no such cluster kept here\n`);
  if (setting === undefined) {
    const record: ClusterRecord = await clusterLock_refresh(context.builder, context.store, name);
    return envelope_ok(`${name}: ${record.protected !== false ? 'protected (teardown refused)' : 'not protected (teardown asks for its name)'} ${chalk.gray(lock_where(record, true))}\n`);
  }
  context.store.record_update(name, (current: ClusterRecord): void => { current.protected = setting === 'on'; current.protectedAt = new Date().toISOString(); });
  const said: string = setting === 'on'
    ? `${name}: protected; teardown is refused\n`
    : `${chalk.yellow(name)}: no longer protected; cluster teardown ${name} will ask for its name\n`;
  return envelope_ok(`${said}${await lock_keep(context, name)}`);
}

/**
 * Keeps the lock in the tenancy from a MANAGE session; below the tasks tier
 * it stays on this host and the line says so.
 *
 * @param context - The session.
 * @param name - The cluster whose lock was just set.
 * @returns A line saying where the lock is kept.
 */
async function lock_keep(context: BuildCommandContext, name: string): Promise<string> {
  if (!tasks_granted() || context.builder?.keep_write === undefined) {
    return `${chalk.yellow('kept on this host only: a session with the tasks tier keeps the lock in the tenancy (cluster protect again)')}\n`;
  }
  try {
    await clusterLock_write(context.builder, context.store, name, { log: (): void => undefined, signal: new AbortController().signal });
    return `${chalk.gray('kept in the tenancy: every session reads this lock')}\n`;
  } catch (error: unknown) {
    return `${chalk.yellow(`kept on this host only: the tenancy did not take it (${error instanceof Error ? error.message : String(error)})`)}\n`;
  }
}
