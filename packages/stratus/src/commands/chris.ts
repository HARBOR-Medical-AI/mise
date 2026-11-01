/**
 * @file `chris`: the ChRIS layer on a built VM (docs/stratus.adoc, D16).
 *
 * `chris deploy <vm> --profile <profile> [--compute <name>] [--host <name>]
 * [--admin-password-file <file>]` puts the all-in-one CUBE on the VM over
 * the bastion path, as a task: refused below the profile's floor; the
 * internal secrets generated once and kept on this host; the admin password
 * asked once (empty: generated and shown once) or read from a file; the
 * compute resource (default: the VM's name) registered. With `--host`, it
 * waits for public DNS and the certificate, and a replay resumes there.
 * `chris status [<vm>]` says what is deployed where.
 *
 * @module
 */
import * as fs from 'fs';
import chalk from 'chalk';
import { envelope_error, envelope_ok, type CommandEnvelope } from '@fnndsc/menu';
import { repl_questionHidden, type CommandHelp } from '@fnndsc/brasa/core';
import type { CloudBuilder } from '../cloud/builder.js';
import type { NetStore } from '../net/state.js';
import type { VmSpec } from '../vm/spec.js';
import type { VmRecord, VmStore } from '../vm/state.js';
import type { VmRemote } from '../vm/remote.js';
import type { BuildCall } from '../cloud/builder.js';
import { CHRIS_PROFILES, floor_short, type ChrisProfile } from '../chris/profiles.js';
import { secret_make, secrets_ensure, secrets_read } from '../chris/secrets.js';
import { CHRIS_JOBS, chrisDeployRun_make, type DeployDeps } from '../chris/deploy.js';
import { job_runFollowed, options_read, tasks_granted } from './build.js';

/** What `chris` reads from the session. */
export interface ChrisCommandContext {
  readonly vms: VmStore;
  readonly nets: NetStore;
  readonly builder: CloudBuilder | null;
  readonly resolve: (host: string) => Promise<string[]>;
  readonly status_get: (url: string) => Promise<number | null>;
  /** Reaches a VM; through its bastion when absent. */
  readonly remote_open?: (name: string, call: BuildCall) => Promise<VmRemote>;
  readonly tickMs?: number;
}

/** The options `chris deploy` reads, each a value. */
const DEPLOY_OPTIONS: ReadonlyArray<string> = ['--profile', '--compute', '--host', '--admin-password-file'];

/** A host name: labels of letters, digits and hyphens. */
const HOST_NAME: RegExp = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * `chris status [<vm>…]`.
 *
 * @param context - The session.
 * @param names - The VMs asked about; every one with a deploy when none.
 * @returns The envelope.
 */
function chrisStatus_run(context: ChrisCommandContext, names: ReadonlyArray<string>): CommandEnvelope {
  const records: VmRecord[] = (names.length > 0 ? [...names] : context.vms.names_list()).map((name: string): VmRecord | null => context.vms.record_read(name)).filter((record): record is VmRecord => record !== null && (names.length > 0 || record.chris !== undefined));
  if (records.length === 0) return envelope_ok('no ChRIS deployed: chris deploy <vm> --profile minimal puts one on a built VM\n');
  const lines: string[] = records.map((record: VmRecord): string => record.chris === undefined
    ? `${chalk.bold(record.name)}  ${chalk.gray('no ChRIS')}`
    : `${chalk.bold(record.name)}  ${chalk.cyan(record.chris.profile)}  ${record.chris.url}  compute ${record.chris.compute}${record.chris.dns === 'waiting' ? chalk.yellow('  waiting on DNS') : ''}${chalk.gray(`  deployed ${record.chris.deployed}`)}`);
  return envelope_ok(`${lines.join('\n')}\n`);
}

/**
 * The admin password for a first deploy: the file's, the operator's typed one, or a new one.
 *
 * @param file - `--admin-password-file`, when given.
 * @returns The password and whether it was generated, or why not.
 */
async function adminPassword_get(file: string | undefined): Promise<{ password: string; generated: boolean } | { error: string }> {
  if (file !== undefined) {
    try {
      const password: string = fs.readFileSync(file, 'utf-8').trim();
      return password.length >= 8 ? { password, generated: false } : { error: `--admin-password-file ${file}: shorter than eight characters` };
    } catch (error: unknown) {
      return { error: `--admin-password-file ${file}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const typed: string = (await repl_questionHidden('admin password for chris (empty: generate one):')).trim();
  if (typed === '') return { password: secret_make(), generated: true };
  return typed.length >= 8 ? { password: typed, generated: false } : { error: 'the admin password is eight characters at least' };
}

/**
 * `chris deploy <vm> --profile <profile> …`.
 *
 * @param context - The session.
 * @param args - The words after `deploy`.
 * @returns The envelope.
 */
async function chrisDeploy_run(context: ChrisCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const read = options_read(args, DEPLOY_OPTIONS);
  if ('error' in read) return envelope_error('', undefined, `chris deploy: ${read.error} (${DEPLOY_OPTIONS.join(', ')})\n`);
  const [name, ...extra] = read.rest;
  if (name === undefined || extra.length > 0) return envelope_error('', undefined, 'chris deploy: usage: chris deploy <vm> --profile <profile> [--compute <name>] [--host <name>] [--admin-password-file <file>]\n');
  const profileName: string | undefined = read.options.get('--profile');
  const profile: ChrisProfile | undefined = profileName === undefined ? undefined : CHRIS_PROFILES[profileName];
  if (profile === undefined) return envelope_error('', undefined, `chris deploy: --profile ${profileName ?? '<profile>'}: one of ${Object.keys(CHRIS_PROFILES).join(', ')}\n`);
  const host: string | null = read.options.get('--host') ?? null;
  if (host !== null && !HOST_NAME.test(host)) return envelope_error('', undefined, `chris deploy: --host ${host}: not a host name\n`);
  const record: VmRecord | null = context.vms.record_read(name);
  const spec = context.vms.spec_read(name);
  if (record === null || spec === null || 'error' in spec) return envelope_error('', undefined, `chris deploy: ${name}: no such VM (vm new declares one)\n`);
  if (record.built === undefined) return envelope_error('', undefined, `chris deploy: ${name}: not built (vm build ${name})\n`);
  const vmSpec: VmSpec = spec.spec;
  const short: string[] = floor_short(profile, vmSpec);
  if (short.length > 0) return envelope_error('', undefined, `chris deploy: ${name} is below the ${profile.name} profile's floor: ${short.join('; ')}\n`);
  if (!vmSpec.open.includes(80) || (host !== null && !vmSpec.open.includes(443))) return envelope_error('', undefined, `chris deploy: ${name} does not open ${host !== null ? '80 and 443' : '80'} (vm new ${name} --open 80,443, then vm build ${name})\n`);
  if (!tasks_granted()) return envelope_error('', undefined, 'chris deploy: needs the tasks tier (stratus --host-control tasks)\n');
  if (context.builder === null) return envelope_error('', undefined, 'chris deploy: this cloud builds nothing yet\n');
  let generated: string | null = null;
  if (secrets_read(context.vms, name) === null) {
    const admin = await adminPassword_get(read.options.get('--admin-password-file'));
    if ('error' in admin) return envelope_error('', undefined, `chris deploy: ${admin.error}\n`);
    if (admin.generated) generated = admin.password;
    secrets_ensure(context.vms, name, admin.password);
  }
  const secrets = secrets_read(context.vms, name);
  if (secrets === null) return envelope_error('', undefined, `chris deploy: ${name}: its secrets were not kept\n`);
  const deps: DeployDeps = { store: context.vms, nets: context.nets, builder: context.builder, resolve: context.resolve, status_get: context.status_get, ...(context.remote_open !== undefined ? { remote_open: context.remote_open } : {}), ...(context.tickMs !== undefined ? { tickMs: context.tickMs } : {}) };
  const compute: string = read.options.get('--compute') ?? name;
  const shown: string = generated !== null ? `${chalk.yellow(`the admin password for chris, generated, shown this once: ${generated}`)}\n` : '';
  const ran = await job_runFollowed(CHRIS_JOBS.deploy(name), `deploy ChRIS on ${name}`, chrisDeployRun_make({ vm: name, profile, compute, host, secrets }, deps));
  if ('error' in ran) return envelope_error('', undefined, `${shown}chris deploy: ${ran.error}\n`);
  const done: VmRecord | null = context.vms.record_read(name);
  return envelope_ok(`${shown}${name}: ChRIS ${profile.name} at ${done?.chris?.url ?? '?'}, compute ${compute}; the admin is chris (its password is kept on this host, never shown again)\n`);
}

/**
 * `chris`.
 *
 * @param context - The session.
 * @param args - The words after `chris`.
 * @returns The envelope.
 */
export async function chris_run(context: ChrisCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const [verb = 'status', ...rest] = args;
  switch (verb) {
    case 'status': return chrisStatus_run(context, rest);
    case 'deploy': return await chrisDeploy_run(context, rest);
    default: return envelope_error('', undefined, `chris: ${verb}: not a verb (chris status, deploy)\n`);
  }
}

/** `chris`'s help. */
export const CHRIS_HELP: CommandHelp = {
  usage: 'chris [status [<vm>…]] | chris deploy <vm> --profile <profile> [--compute <name>] [--host <name>] [--admin-password-file <file>]',
  summary: 'Put ChRIS on a built VM',
  category: 'Resources',
  description: 'chris deploy puts the all-in-one CUBE on a built VM, over the network\'s bastion and never through cloud-init, as a task (/proc/steps/chris-<vm>-deploy). A profile is data: minimal is CUBE 6.11.0 (production, uvicorn), its workers and scheduler, Postgres, Dragonfly, NATS and pfcon 5.3.1 in-network beside it running plugins through the VM\'s Docker, behind Caddy; a VM below its floor (2 vCPU, 4 GiB, 50 GB data) is refused and told by how much. Everything lands on the data volume (/srv/data/chris), so a rebuilt machine opens the old database. The internal secrets are generated by the first deploy and kept on this host; the admin password for chris is asked once (empty: generated and shown once) or read from --admin-password-file. The compute resource (--compute, default the VM\'s name) is registered, and the deploy checks chris sees the admin API, as plugin uploads need. Without --host, ChRIS answers over plain HTTP on the VM\'s address; with --host, Caddy obtains the certificate once public DNS gives the name the VM\'s address, which the deploy waits for (an hour at most; a replay resumes). No profile carries the ChRIS UI.',
  examples: ['chris deploy store --profile minimal --compute NERC --host cube.chrisproject.org', 'chris deploy vm-try --profile minimal', 'chris status'],
};
