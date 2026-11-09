/**
 * @file `chris`: the ChRIS layer on a built VM (docs/stratus.adoc, D16).
 *
 * `chris deploy <vm> --profile <profile> [--compute <name>] [--host <name>]
 * [--porter <name>] [--berths on|off] [--berth-cpus <N>] [--berth-memory <GiB>] [--admin-password-file <file>]` puts the all-in-one CUBE on the VM over
 * the bastion path, as a task: refused below the profile's floor; the
 * internal secrets generated once and kept on this host; the admin password
 * asked once (empty: generated and shown once) or read from a file; the
 * compute resource (default: the VM's name) registered. With `--host`, it
 * waits for public DNS and the certificate, and a replay resumes there. With
 * `--porter`, porter (the door to mise: chell, calypso, ARGUS) runs beside
 * it under its own name, logging in to this CUBE, and starts each person's
 * session in a berth of its own through the berth launcher unless
 * `--berths off` (docs/berths.adoc), each with `--berth-cpus` CPUs and
 * `--berth-memory` GiB at most (default 1 and 2), written to the launcher's policy.
 * `chris status [<vm>]` says what is deployed where. `chris user add <name>
 * --email <address> [--groups <group,…>] [--password-file <file>] [--on <vm>]`
 * makes an account on a ChRIS this stratus deployed, on the VM itself
 * (CUBE's API makes none once sign-up is off), in the groups named beside
 * `all_users`; the password asked (empty: generated and shown once) or read
 * from a file, and never kept. `chris user mod <name> [--email <address>]
 * [--groups <group,…>] [--on <vm>]` changes an account's email or its groups
 * (set whole, `all_users` always kept) there the same way, asking first. `chris passwd [<user>] [--password-file
 * <file>] [--on <vm>]` changes an account's password there, the admin's
 * (`chris`, the default) on the host, in `cube.env` and in CUBE together,
 * CUBE's services started again to take it, and kept in the tenancy.
 * `chris plugin sync [<source>] [--ref <ref>] [--on <vm>] [--plan]` fills that
 * ChRIS from the plugin index with the chell porter runs beside it: the
 * plan read there first, asked about here with its counts, then applied
 * pinned to the commit it read.
 *
 * @module
 */
import * as fs from 'fs';
import chalk from 'chalk';
import { berthCapacity_derive, CHRIS_PROFILE_OFFERS, envelope_error, envelope_ok, LINE_DECLINED_MODEL_KIND, STRATUS_CHRIS_PLAN_MODEL_KIND, STRATUS_CHRIS_STATUS_MODEL_KIND, type ChrisProfileOffer, type ChrisStatusRow, type CommandEnvelope } from '@fnndsc/menu';
import { repl_confirm, repl_questionHidden, type CommandHelp } from '@fnndsc/brasa/core';
import type { CloudBuilder } from '../cloud/builder.js';
import type { NetStore } from '../net/state.js';
import type { VmSpec } from '../vm/spec.js';
import type { BerthLimits, VmRecord, VmStore } from '../vm/state.js';
import type { VmRemote } from '../vm/remote.js';
import type { BuildCall } from '../cloud/builder.js';
import { BERTH_LIMITS_DEFAULT, CHRIS_PROFILES, floor_short, type ChrisProfile } from '../chris/profiles.js';
import { VM_KEYLESS, vmKeyless_is } from '../vm/keep.js';
import { launcherSecret_ensure, porterSecret_ensure, secret_make, secrets_ensure, secrets_read } from '../chris/secrets.js';
import { CHRIS_JOBS, chrisDeployRun_make, type DeployDeps } from '../chris/deploy.js';
import { host_split, point_plan, pointPlan_words, POINT_TTL, type Registrar } from '../chris/registrar.js';
import { ALL_USERS, chrisUserAddRun_make, chrisUserModRun_make, EMAIL, GROUP_NAME, USER_JOBS, USER_NAME, type UserAddResult, type UserAnswer, type UserModAsk } from '../chris/users.js';
import { CHRIS_ADMIN, chrisPasswdRun_make, PASSWD_JOBS, type PasswdResult } from '../chris/passwd.js';
import { job_runFollowed, options_read, tasks_granted } from './build.js';
import { TIER_REFUSAL } from '../tier.js';
import { chrisLive_read, type ChrisLive, type HttpGet } from '../chris/live.js';
import { berthLimits_words, chrisPlan_derive, chrisPlan_words, type ChrisPlan } from '../chris/plan.js';
import { chrisPluginApplyRun_make, chrisPluginPlanRun_make, PLUGIN_JOBS, PLUGIN_REF, PLUGIN_SOURCE, PLUGIN_SYNC_CHELL_MIN, pluginPlanAdds_count, pluginPlanStanding_words, pluginSyncQuestion_words, type PluginApplyResult, type PluginPlanRead, type PluginPlanResult, type PluginSyncAsk } from '../chris/plugins.js';

/** What `chris` reads from the session. */
export interface ChrisCommandContext {
  readonly vms: VmStore;
  readonly nets: NetStore;
  readonly builder: CloudBuilder | null;
  readonly resolve: (host: string) => Promise<string[]>;
  /** A zone's name servers, as public DNS gives them. */
  readonly nameservers_get: (zone: string) => Promise<string[]>;
  /** The registrar whose API this host holds a token for, or null. */
  readonly registrar: Registrar | null;
  readonly status_get: (url: string) => Promise<number | null>;
  /** A GET with the JSON body, for reading what runs of a ChRIS over HTTPS; reading is skipped when absent. */
  readonly http_get?: HttpGet;
  /** Reaches a VM; through its bastion when absent. */
  readonly remote_open?: (name: string, call: BuildCall) => Promise<VmRemote>;
  readonly tickMs?: number;
}

/** The options `chris deploy` reads, each a value. */
const DEPLOY_OPTIONS: ReadonlyArray<string> = ['--profile', '--compute', '--host', '--porter', '--berths', '--berth-cpus', '--berth-memory', '--admin-password-file'];

/** `chris deploy`'s usage. */
const DEPLOY_USAGE: string = 'chris deploy <vm> --profile <profile> [--compute <name>] [--host <name>] [--porter <name>] [--berths on|off] [--berth-cpus <N>] [--berth-memory <GiB>] [--admin-password-file <file>] [--plan]';

/** A berth's CPUs: a positive number, at most two decimals. */
const BERTH_CPUS: RegExp = /^\d+(\.\d{1,2})?$/;

/** A berth's memory in GiB: a positive number, at most one decimal. */
const BERTH_MEMORY: RegExp = /^\d+(\.\d)?$/;

/** The options `chris user add` reads, each a value. */
const USER_OPTIONS: ReadonlyArray<string> = ['--email', '--groups', '--password-file', '--on'];

/** `chris user`'s usage. */
const USER_USAGE: string = 'chris user add <name> --email <address> [--groups <group,…>] [--password-file <file>] [--on <vm>] | chris user mod <name> [--email <address>] [--groups <group,…>] [--on <vm>]';

/** The options `chris user mod` reads, each a value. */
const USER_MOD_OPTIONS: ReadonlyArray<string> = ['--email', '--groups', '--on'];

/** The options `chris passwd` reads, each a value. */
const PASSWD_OPTIONS: ReadonlyArray<string> = ['--password-file', '--on'];

/** `chris passwd`'s usage. */
const PASSWD_USAGE: string = 'chris passwd [<user>] [--password-file <file>] [--on <vm>]';

/** The options `chris plugin sync` reads, each a value. */
const PLUGIN_OPTIONS: ReadonlyArray<string> = ['--ref', '--on'];

/** `chris plugin sync`'s usage. */
const PLUGIN_USAGE: string = 'chris plugin sync [<source>] [--ref <ref>] [--on <vm>] [--plan]';

/** A host name: labels of letters, digits and hyphens. */
const HOST_NAME: RegExp = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * `chris status [<vm>…]`.
 *
 * @param context - The session.
 * @param names - The VMs asked about; every one with a deploy when none.
 * @returns The envelope.
 */
async function chrisStatus_run(context: ChrisCommandContext, names: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const records: VmRecord[] = (names.length > 0 ? [...names] : context.vms.names_list()).map((name: string): VmRecord | null => context.vms.record_read(name)).filter((record): record is VmRecord => record !== null && (names.length > 0 || record.chris !== undefined));
  if (records.length === 0) return envelope_ok('no ChRIS deployed: chris deploy <vm> --profile minimal puts one on a built VM\n', { kind: STRATUS_CHRIS_STATUS_MODEL_KIND, data: { chris: [] } });
  const lines: string[] = [];
  const rows: ChrisStatusRow[] = [];
  for (const record of records) {
    if (record.chris === undefined) { lines.push(`${chalk.bold(record.name)}  ${chalk.gray('no ChRIS')}`); continue; }
    const chris = record.chris;
    // What runs, read from it over HTTPS (AEGIS a-change-is-a-loop, clause 1): never the deploy's record standing in for it.
    const live: ChrisLive | null = context.http_get === undefined ? null : await chrisLive_read(chris, secrets_read(context.vms, record.name), context.http_get);
    lines.push(`${chalk.bold(record.name)}  ${chalk.cyan(chris.profile)}  ${chris.url}  compute ${chris.compute}${chris.porter !== undefined ? `  porter https://${chris.porter}/` : ''}${chris.dns === 'waiting' ? chalk.yellow('  waiting on DNS') : ''}${chalk.gray(`  deployed ${chris.deployed}${chris.image !== undefined ? ` (${chris.image}${chris.porterVersion !== undefined ? `, porter ${chris.porterVersion}` : ''})` : ''}`)}`);
    if (live !== null) lines.push(...chrisLive_lines(live));
    rows.push({
      vm: record.name, profile: chris.profile, compute: chris.compute, url: chris.url, host: chris.host, porter: chris.porter ?? null, deployed: chris.deployed,
      image: chris.image ?? null, porterVersion: chris.porterVersion ?? null, berths: chris.berths === 'launcher', berthLimits: chris.berthLimits ?? null,
      live: live === null ? null : { at: live.at, cube: live.cube, porter: live.porter, accounts: live.accounts === null ? null : live.accounts.map((one) => ({ ...one, groups: [...one.groups] })), accountsWhy: live.accountsWhy, groups: live.groups === null ? null : [...live.groups], berths: live.berths === null ? null : live.berths.map((one) => ({ ...one })), berthsWhy: live.berthsWhy, berthsOff: live.berthsOff },
    });
  }
  return envelope_ok(`${lines.join('\n')}\n`, { kind: STRATUS_CHRIS_STATUS_MODEL_KIND, data: { chris: rows } });
}

/**
 * What runs of a ChRIS, in lines under its record.
 *
 * @param live - What was read.
 * @returns The lines.
 */
function chrisLive_lines(live: ChrisLive): string[] {
  const read: string = chalk.gray(`  (read ${live.at.slice(11, 16)} UTC)`);
  const cube: string = live.cube.status === null ? chalk.red('CUBE does not answer') : `CUBE answers ${live.cube.status}${live.cube.admin === true ? ', chris signs in' : live.cube.admin === false ? chalk.red(', chris does not sign in') : ''}`;
  const porter: string = live.porter === null ? '' : live.porter.status === null ? `; ${chalk.red('porter does not answer')}` : `; porter answers ${live.porter.status}${live.porter.sessions !== null ? `, ${live.porter.sessions} session${live.porter.sessions === 1 ? '' : 's'} open` : ''}${live.porter.version !== null ? `, porter ${live.porter.version}` : ''}`;
  const accounts: string = live.accounts === null ? chalk.yellow(`accounts not read: ${live.accountsWhy ?? '?'}`) : `${live.accounts.length} account${live.accounts.length === 1 ? '' : 's'}: ${live.accounts.map((one) => one.username).join(', ')}`;
  const lines: string[] = [`  runs      ${cube}${porter}${read}`, `  accounts  ${accounts}`];
  // Berths are porter's: a ChRIS with no porter has none to say.
  if (live.porter !== null) {
    const running: number = live.berths?.filter((one): boolean => one.state === 'running').length ?? 0;
    const stopped: number = (live.berths?.length ?? 0) - running;
    lines.push(`  berths    ${live.berths === null ? (live.berthsOff ? 'off' : chalk.yellow(`not read: ${live.berthsWhy ?? '?'}`)) : live.berths.length === 0 ? 'none' : `${running} running, ${stopped} home${stopped === 1 ? '' : 's'} kept (${live.berths.map((one) => `${one.user} ${one.state}`).join(', ')})`}`);
  }
  return lines;
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
 * A new account's password: the file's, the operator's typed one, or a new one.
 *
 * @param username - Whose, for the question.
 * @param file - `--password-file`, when given.
 * @returns The password and whether it was generated, or why not.
 */
async function userPassword_get(username: string, file: string | undefined): Promise<{ password: string; generated: boolean } | { error: string }> {
  const fits = (password: string): string | null => password.length < 8 ? 'shorter than eight characters' : password.length > 100 ? 'longer than a hundred characters' : null;
  if (file !== undefined) {
    try {
      const password: string = fs.readFileSync(file, 'utf-8').trim();
      const wrong: string | null = fits(password);
      return wrong === null ? { password, generated: false } : { error: `--password-file ${file}: ${wrong}` };
    } catch (error: unknown) {
      return { error: `--password-file ${file}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const typed: string = (await repl_questionHidden(`${username}'s password (empty: generate one):`)).trim();
  if (typed === '') return { password: secret_make(), generated: true };
  const wrong: string | null = fits(typed);
  return wrong === null ? { password: typed, generated: false } : { error: `the password is ${wrong}` };
}

/**
 * A changed password: the file's, or the operator's typed twice, or a new one.
 *
 * @param username - Whose, for the question.
 * @param file - `--password-file`, when given.
 * @returns The password and whether it was generated, or why not.
 */
async function newPassword_get(username: string, file: string | undefined): Promise<{ password: string; generated: boolean } | { error: string }> {
  if (file !== undefined) return await userPassword_get(username, file);
  const fits = (password: string): string | null => password.length < 8 ? 'shorter than eight characters' : password.length > 100 ? 'longer than a hundred characters' : null;
  const typed: string = (await repl_questionHidden(`${username}'s new password (empty: generate one):`)).trim();
  if (typed === '') return { password: secret_make(), generated: true };
  const wrong: string | null = fits(typed);
  if (wrong !== null) return { error: `the password is ${wrong}` };
  const again: string = (await repl_questionHidden(`${username}'s new password, again:`)).trim();
  return again === typed ? { password: typed, generated: false } : { error: 'the two passwords typed differ; nothing changed' };
}

/**
 * The ChRIS a user verb acts on: the one `--on` names, or the only one this
 * stratus deployed.
 *
 * @param context - The session.
 * @param on - `--on`, when given.
 * @returns The VM and its ChRIS's URL, or why not.
 */
function chrisTarget_pick(context: ChrisCommandContext, on: string | undefined): { vm: string; url: string } | { error: string } {
  if (on !== undefined) {
    const record: VmRecord | null = context.vms.record_read(on);
    if (record === null) return { error: `--on ${on}: no such VM` };
    if (record.chris === undefined) return { error: `--on ${on}: no ChRIS deployed there (chris deploy ${on} --profile minimal)` };
    return { vm: on, url: record.chris.url };
  }
  const deployed: VmRecord[] = context.vms.names_list().map((name: string): VmRecord | null => context.vms.record_read(name)).filter((record): record is VmRecord => record !== null && record.chris !== undefined);
  const [only] = deployed;
  if (only === undefined || only.chris === undefined) return { error: 'no ChRIS deployed (chris deploy <vm> --profile minimal)' };
  if (deployed.length > 1) return { error: `stratus runs ${deployed.length} ChRIS (${deployed.map((record: VmRecord): string => record.name).join(', ')}); say which with --on` };
  return { vm: only.name, url: only.chris.url };
}

/**
 * `chris user add <name> --email <address> …`.
 *
 * @param context - The session.
 * @param args - The words after `user`.
 * @returns The envelope.
 */
async function chrisUser_run(context: ChrisCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const [verb, ...rest] = args;
  if (verb === 'mod') return chrisUserMod_run(context, rest);
  if (verb !== 'add') return envelope_error('', undefined, `chris user: ${verb === undefined ? 'usage' : `${verb}: not a verb`}: ${USER_USAGE}\n`);
  const read = options_read(rest, USER_OPTIONS);
  if ('error' in read) return envelope_error('', undefined, `chris user add: ${read.error} (${USER_OPTIONS.join(', ')})\n`);
  const [username, ...extra] = read.rest;
  if (username === undefined || extra.length > 0) return envelope_error('', undefined, `chris user add: usage: ${USER_USAGE}\n`);
  if (!USER_NAME.test(username)) return envelope_error('', undefined, `chris user add: ${username}: a user name is 4 to 32 letters, digits or . @ + - _\n`);
  const email: string | undefined = read.options.get('--email');
  if (email === undefined) return envelope_error('', undefined, `chris user add: ${username}: --email <address> is needed (CUBE makes no account without one)\n`);
  if (!EMAIL.test(email)) return envelope_error('', undefined, `chris user add: --email ${email}: not an email address\n`);
  const groups = groups_read(read.options.get('--groups'));
  if ('error' in groups) return envelope_error('', undefined, `chris user add: ${groups.error}\n`);
  const target = chrisTarget_pick(context, read.options.get('--on'));
  if ('error' in target) return envelope_error('', undefined, `chris user add: ${target.error}\n`);
  if (!tasks_granted()) return envelope_error('', undefined, `chris user add: ${TIER_REFUSAL}\n`);
  if (context.builder === null) return envelope_error('', undefined, 'chris user add: this cloud builds nothing yet\n');
  // What CUBE holds, read before the question (AEGIS a-change-is-a-loop, clauses 1 and 4): an account already there is left as it is, unasked.
  const record: VmRecord | null = context.vms.record_read(target.vm);
  const live: ChrisLive | null = context.http_get === undefined || record?.chris === undefined ? null : await chrisLive_read(record.chris, secrets_read(context.vms, target.vm), context.http_get);
  const held = live?.accounts?.find((one): boolean => one.username === username) ?? null;
  if (held !== null) {
    return held.email === email
      ? envelope_ok(`${target.vm}: ${username} is there already (${email}, read ${live?.at.slice(11, 16) ?? '?'} UTC); left as it is\n`)
      : envelope_error('', undefined, `chris user add: ${target.vm}: ${username} already exists, with ${held.email}; left as it is\n`);
  }
  const owner = live?.accounts?.find((one): boolean => one.email === email) ?? null;
  if (owner !== null) return envelope_error('', undefined, `chris user add: ${target.vm}: ${email} is ${owner.username}'s already\n`);
  // Only groups CUBE holds are joined: one it does not is refused before the question.
  const unheld: string[] = live?.groups == null ? [] : groups.groups.filter((name: string): boolean => !(live.groups ?? []).includes(name));
  if (unheld.length > 0) return envelope_error('', undefined, `chris user add: ${target.vm}: CUBE has no group ${unheld.join(', ')} (it holds ${live?.groups?.join(', ') ?? '?'})\n`);
  const file: string | undefined = read.options.get('--password-file');
  // A file's password is read before the question, so a bad file refuses without asking.
  const filed = file === undefined ? null : await userPassword_get(username, file);
  if (filed !== null && 'error' in filed) return envelope_error('', undefined, `chris user add: ${filed.error}\n`);
  const counted: string = live?.accounts === null || live === null ? `its accounts not read${live?.accountsWhy ? `: ${live.accountsWhy}` : ''}` : `${live.accounts.length} account${live.accounts.length === 1 ? '' : 's'} there now, read ${live.at.slice(11, 16)} UTC`;
  const joins: string = groups.groups.length === 0 ? '' : `, in ${['all_users', ...groups.groups].join(', ')}`;
  const question: string = `chris user add ${username}: makes the account ${username} (${email}${joins}) on the ChRIS at ${target.url}, on ${target.vm} (${counted}); its password ${file !== undefined ? `read from ${file}` : 'asked next, hidden'}. A NO makes nothing. Continue? [y/N]`;
  if (!await repl_confirm(question)) {
    return envelope_ok(`${chalk.gray(`stopped before ${username} was made; nothing changed on ${target.vm} (chris user add ${username} asks again)`)}\n`, { kind: LINE_DECLINED_MODEL_KIND, data: { line: `chris user add ${username}`, kept: 'nothing made' } });
  }
  const password = filed ?? await userPassword_get(username, undefined);
  if ('error' in password) return envelope_error('', undefined, `chris user add: ${password.error}\n`);
  const deps: DeployDeps = { store: context.vms, nets: context.nets, builder: context.builder, resolve: context.resolve, status_get: context.status_get, ...(context.remote_open !== undefined ? { remote_open: context.remote_open } : {}) };
  const result: UserAddResult = {};
  const ran = await job_runFollowed(USER_JOBS.add(target.vm), `add ${username} to the ChRIS on ${target.vm}`, chrisUserAddRun_make(target.vm, { username, email, password: password.password, ...(groups.groups.length > 0 ? { groups: groups.groups } : {}) }, deps, result));
  if ('error' in ran) return envelope_error('', undefined, `chris user add: ${ran.error}\n`);
  const answer: UserAnswer | undefined = result.answer;
  if (answer?.kind === 'exists') {
    return answer.email === email
      ? envelope_ok(`${target.vm}: ${username} is there already (${email}); left as it is\n`)
      : envelope_error('', undefined, `chris user add: ${target.vm}: ${username} already exists, with ${answer.email}; left as it is\n`);
  }
  if (answer?.kind === 'emailTaken') return envelope_error('', undefined, `chris user add: ${target.vm}: ${email} is ${answer.username}'s already\n`);
  if (answer?.kind === 'noGroup') return envelope_error('', undefined, `chris user add: ${target.vm}: CUBE has no group ${answer.groups.join(', ')}; nothing made\n`);
  const shown: string = password.generated ? `${chalk.yellow(`the password for ${username}, generated, shown this once: ${password.password}`)}\n` : '';
  return envelope_ok(`${shown}${target.vm}: ${username} added at ${target.url} (${email}${joins})\n`);
}

/**
 * A `--groups` value: the groups named, comma-separated, `all_users` dropped
 * (every account's, never named), each once.
 *
 * @param value - The option's value, or undefined.
 * @returns The groups, or why the value is not a list of them.
 */
function groups_read(value: string | undefined): { groups: string[] } | { error: string } {
  if (value === undefined) return { groups: [] };
  const named: string[] = value.split(',').map((name: string): string => name.trim()).filter((name: string): boolean => name !== '');
  const wrong: string | undefined = named.find((name: string): boolean => !GROUP_NAME.test(name));
  if (wrong !== undefined) return { error: `--groups ${value}: ${wrong} is not a group name` };
  return { groups: [...new Set(named)].filter((name: string): boolean => name !== ALL_USERS) };
}

/**
 * `chris user mod <name> [--email <address>] [--groups <group,…>] [--on <vm>]`:
 * an account's email or groups changed on a ChRIS this stratus deployed. What
 * CUBE holds is read first: no account, an email another's, a group CUBE
 * does not hold, each refused before the question; a change that is already
 * so is said and not asked.
 *
 * @param context - The session.
 * @param rest - The words after `mod`.
 * @returns The envelope.
 */
async function chrisUserMod_run(context: ChrisCommandContext, rest: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const read = options_read(rest, USER_MOD_OPTIONS);
  if ('error' in read) return envelope_error('', undefined, `chris user mod: ${read.error} (${USER_MOD_OPTIONS.join(', ')})\n`);
  const [username, ...extra] = read.rest;
  if (username === undefined || extra.length > 0) return envelope_error('', undefined, `chris user mod: usage: ${USER_USAGE}\n`);
  if (!USER_NAME.test(username)) return envelope_error('', undefined, `chris user mod: ${username}: a user name is 4 to 32 letters, digits or . @ + - _\n`);
  const email: string | undefined = read.options.get('--email');
  if (email !== undefined && !EMAIL.test(email)) return envelope_error('', undefined, `chris user mod: --email ${email}: not an email address\n`);
  const named: string | undefined = read.options.get('--groups');
  const groups = groups_read(named);
  if ('error' in groups) return envelope_error('', undefined, `chris user mod: ${groups.error}\n`);
  if (email === undefined && named === undefined) return envelope_error('', undefined, `chris user mod: ${username}: nothing to change: --email or --groups\n`);
  const target = chrisTarget_pick(context, read.options.get('--on'));
  if ('error' in target) return envelope_error('', undefined, `chris user mod: ${target.error}\n`);
  const record: VmRecord | null = context.vms.record_read(target.vm);
  if (record !== null && vmKeyless_is(context.vms, record)) return envelope_error('', undefined, `chris user mod: ${target.vm}: ${VM_KEYLESS}\n`);
  if (!tasks_granted()) return envelope_error('', undefined, `chris user mod: ${TIER_REFUSAL}\n`);
  if (context.builder === null) return envelope_error('', undefined, 'chris user mod: this cloud builds nothing yet\n');
  // What CUBE holds, read before the question (AEGIS a-change-is-a-loop, clauses 1 and 4).
  const live: ChrisLive | null = context.http_get === undefined || record?.chris === undefined ? null : await chrisLive_read(record.chris, secrets_read(context.vms, target.vm), context.http_get);
  const held = live?.accounts?.find((one): boolean => one.username === username) ?? null;
  if (live?.accounts != null && held === null) return envelope_error('', undefined, `chris user mod: ${target.vm}: no account ${username} (chris user add ${username} --email <address>)\n`);
  const owner = email === undefined ? null : live?.accounts?.find((one): boolean => one.email === email && one.username !== username) ?? null;
  if (owner !== null) return envelope_error('', undefined, `chris user mod: ${target.vm}: ${email ?? ''} is ${owner.username}'s already\n`);
  const unheld: string[] = live?.groups == null ? [] : groups.groups.filter((name: string): boolean => !(live.groups ?? []).includes(name));
  if (unheld.length > 0) return envelope_error('', undefined, `chris user mod: ${target.vm}: CUBE has no group ${unheld.join(', ')} (it holds ${live?.groups?.join(', ') ?? '?'})\n`);
  // The change in words, against what CUBE holds when it was read.
  const wanted: string[] = [ALL_USERS, ...groups.groups].sort();
  const had: ReadonlyArray<string> | null = held?.groups ?? null;
  const said: string[] = [];
  if (email !== undefined && held?.email !== email) said.push(`email ${held?.email ?? '?'} → ${email}`);
  if (named !== undefined) {
    const plus: string[] = had === null ? wanted : wanted.filter((name: string): boolean => !had.includes(name));
    const minus: string[] = had === null ? [] : had.filter((name: string): boolean => !wanted.includes(name));
    if (plus.length > 0 || minus.length > 0) said.push(`groups ${[...plus.map((name: string): string => `+ ${name}`), ...minus.map((name: string): string => `− ${name}`)].join(', ')}`);
  }
  if (said.length === 0) return envelope_ok(`${target.vm}: ${username} is so already (read ${live?.at.slice(11, 16) ?? '?'} UTC); nothing changed\n`);
  const question: string = `chris user mod ${username}: on the ChRIS at ${target.url}, on ${target.vm}: ${said.join('; ')}. A NO changes nothing. Continue? [y/N]`;
  if (!await repl_confirm(question)) {
    return envelope_ok(`${chalk.gray(`stopped before ${username} was changed; nothing changed on ${target.vm}`)}\n`, { kind: LINE_DECLINED_MODEL_KIND, data: { line: `chris user mod ${username}`, kept: 'nothing changed' } });
  }
  const deps: DeployDeps = { store: context.vms, nets: context.nets, builder: context.builder, resolve: context.resolve, status_get: context.status_get, ...(context.remote_open !== undefined ? { remote_open: context.remote_open } : {}) };
  const result: UserAddResult = {};
  const ask: UserModAsk = { username, ...(email !== undefined ? { email } : {}), ...(named !== undefined ? { groups: groups.groups } : {}) };
  const ran = await job_runFollowed(USER_JOBS.mod(target.vm), `change ${username} on the ChRIS on ${target.vm}`, chrisUserModRun_make(target.vm, ask, deps, result));
  if ('error' in ran) return envelope_error('', undefined, `chris user mod: ${ran.error}\n`);
  const answer: UserAnswer | undefined = result.answer;
  if (answer?.kind === 'absent') return envelope_error('', undefined, `chris user mod: ${target.vm}: no account ${username}\n`);
  if (answer?.kind === 'emailTaken') return envelope_error('', undefined, `chris user mod: ${target.vm}: ${email ?? ''} is ${answer.username}'s already\n`);
  if (answer?.kind === 'noGroup') return envelope_error('', undefined, `chris user mod: ${target.vm}: CUBE has no group ${answer.groups.join(', ')}; nothing changed\n`);
  return envelope_ok(`${target.vm}: ${username} changed at ${target.url}: ${said.join('; ')}\n`);
}

/**
 * `chris plugin sync [<source>] …`: the plugin index into a ChRIS this
 * stratus deployed, by the chell porter runs beside it. The plan is read
 * there first and asked about here, with its counts; a yes applies it,
 * pinned to the commit the plan read.
 *
 * @param context - The session.
 * @param args - The words after `plugin`.
 * @returns The envelope.
 */
async function chrisPlugin_run(context: ChrisCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const [verb, ...rest] = args;
  if (verb !== 'sync') return envelope_error('', undefined, `chris plugin: ${verb === undefined ? 'usage' : `${verb}: not a verb`}: ${PLUGIN_USAGE}\n`);
  // `--plan` reads the plan and stops: nothing is asked or registered.
  const planOnly: boolean = rest.includes('--plan');
  const read = options_read(rest.filter((word: string): boolean => word !== '--plan'), PLUGIN_OPTIONS);
  if ('error' in read) return envelope_error('', undefined, `chris plugin sync: ${read.error} (${PLUGIN_OPTIONS.join(', ')}, --plan)\n`);
  const [source, ...extra] = read.rest;
  if (extra.length > 0) return envelope_error('', undefined, `chris plugin sync: usage: ${PLUGIN_USAGE}\n`);
  if (source !== undefined && !PLUGIN_SOURCE.test(source)) return envelope_error('', undefined, `chris plugin sync: ${source}: an index is owner/repo[@ref], cube:<path> or host:<path>\n`);
  const ref: string | undefined = read.options.get('--ref');
  if (ref !== undefined && !PLUGIN_REF.test(ref)) return envelope_error('', undefined, `chris plugin sync: --ref ${ref}: a branch, a tag or a commit\n`);
  const target = chrisTarget_pick(context, read.options.get('--on'));
  if ('error' in target) return envelope_error('', undefined, `chris plugin sync: ${target.error}\n`);
  const record: VmRecord | null = context.vms.record_read(target.vm);
  if (record?.chris?.porter === undefined) return envelope_error('', undefined, `chris plugin sync: ${target.vm}: no porter runs there, and plugin sync runs in porter's chell (chris deploy ${target.vm} --host <name> --porter <name>)\n`);
  if (vmKeyless_is(context.vms, record)) return envelope_error('', undefined, `chris plugin sync: ${target.vm}: ${VM_KEYLESS}\n`);
  if (!tasks_granted()) return envelope_error('', undefined, `chris plugin sync: ${TIER_REFUSAL}\n`);
  if (context.builder === null) return envelope_error('', undefined, 'chris plugin sync: this cloud builds nothing yet\n');
  const deps: DeployDeps = { store: context.vms, nets: context.nets, builder: context.builder, resolve: context.resolve, status_get: context.status_get, ...(context.remote_open !== undefined ? { remote_open: context.remote_open } : {}) };
  const ask: PluginSyncAsk = { ...(source !== undefined ? { source } : {}), ...(ref !== undefined ? { ref } : {}) };
  const line: string = `chris plugin sync${source !== undefined ? ` ${source}` : ''}${read.options.has('--on') ? ` --on ${target.vm}` : ''}`;
  // What the index holds against what CUBE holds, read on the VM before the question (AEGIS a-change-is-a-loop, clauses 1, 2 and 4).
  const planned: PluginPlanResult = {};
  const readRun = await job_runFollowed(PLUGIN_JOBS.sync(target.vm), `read the plugin plan on ${target.vm}`, chrisPluginPlanRun_make(target.vm, target.url, ask, deps, planned));
  if ('error' in readRun) return envelope_error('', undefined, `chris plugin sync: ${readRun.error}\n`);
  if (planned.old !== undefined) return envelope_error('', undefined, `chris plugin sync: the ${target.vm}'s chell is ${planned.old}; plugin sync needs ${PLUGIN_SYNC_CHELL_MIN} — replay chris deploy ${target.vm}\n`);
  const plan: PluginPlanRead | undefined = planned.plan;
  if (plan === undefined) return envelope_error('', undefined, `chris plugin sync: ${target.vm}: no plan was read\n`);
  const adds: number = pluginPlanAdds_count(plan);
  const question: string = pluginSyncQuestion_words(target.vm, plan);
  if (adds === 0) return envelope_ok(`${target.vm}: nothing to add from ${plan.label}; ${pluginPlanStanding_words(plan)}\n`);
  if (planOnly) return envelope_ok(`chris plugin sync ${target.vm}: would add ${adds} from ${plan.label}, ${pluginPlanStanding_words(plan)}; --plan: nothing was registered\n`);
  if (!await repl_confirm(question)) {
    return envelope_ok(`${chalk.gray(`stopped before any plugin was registered; nothing changed on ${target.vm} (${line} plans and asks again)`)}\n`, { kind: LINE_DECLINED_MODEL_KIND, data: { line, kept: 'nothing registered' } });
  }
  const applied: PluginApplyResult = {};
  const applyRun = await job_runFollowed(PLUGIN_JOBS.sync(target.vm), `sync plugins on ${target.vm} from ${plan.label}`, chrisPluginApplyRun_make(target.vm, target.url, plan, deps, applied));
  if ('error' in applyRun) return envelope_error('', undefined, `chris plugin sync: ${applyRun.error}\n`);
  const receipt = applied.receipt;
  if (receipt === undefined) return envelope_error('', undefined, `chris plugin sync: ${target.vm}: no receipt was read\n`);
  const summary: string = `${receipt.added} added, ${receipt.skipped} skipped, ${receipt.reported} reported, ${receipt.failed} failed`;
  if (receipt.stopped) return envelope_error('', undefined, `chris plugin sync: ${target.vm}: stopped: ${summary}; what was added stays, and ${line} continues from it\n`);
  if (receipt.failed > 0) return envelope_error('', undefined, `chris plugin sync: ${target.vm}: ${summary} from ${plan.label} (the task's log names each)\n`);
  return envelope_ok(`${target.vm}: ${summary} from ${plan.label} at ${target.url}\n`);
}

/**
 * `chris passwd [<user>] …`.
 *
 * @param context - The session.
 * @param args - The words after `passwd`.
 * @returns The envelope.
 */
async function chrisPasswd_run(context: ChrisCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  const read = options_read(args, PASSWD_OPTIONS);
  if ('error' in read) return envelope_error('', undefined, `chris passwd: ${read.error} (${PASSWD_OPTIONS.join(', ')})\n`);
  const [username = CHRIS_ADMIN, ...extra] = read.rest;
  if (extra.length > 0) return envelope_error('', undefined, `chris passwd: usage: ${PASSWD_USAGE}\n`);
  if (!USER_NAME.test(username)) return envelope_error('', undefined, `chris passwd: ${username}: a user name is 4 to 32 letters, digits or . @ + - _\n`);
  const target = chrisTarget_pick(context, read.options.get('--on'));
  if ('error' in target) return envelope_error('', undefined, `chris passwd: ${target.error}\n`);
  const record: VmRecord | null = context.vms.record_read(target.vm);
  if (record !== null && vmKeyless_is(context.vms, record)) return envelope_error('', undefined, `chris passwd: ${target.vm}: ${VM_KEYLESS}\n`);
  const admin: boolean = username === CHRIS_ADMIN;
  if (admin && secrets_read(context.vms, target.vm) === null) return envelope_error('', undefined, `chris passwd: ${target.vm}: this host keeps no ChRIS secrets for it (chris deploy ${target.vm})\n`);
  if (!tasks_granted()) return envelope_error('', undefined, `chris passwd: ${TIER_REFUSAL}\n`);
  if (context.builder === null) return envelope_error('', undefined, 'chris passwd: this cloud builds nothing yet\n');
  if (admin && !await repl_confirm(`chris passwd: ${CHRIS_ADMIN} on ${target.vm}: CUBE at ${target.url} starts again to take the new password, and is down for a minute or so. Continue? [y/N]`)) {
    return envelope_ok(`${target.vm}: ${CHRIS_ADMIN}'s password not changed\n`);
  }
  const password = await newPassword_get(username, read.options.get('--password-file'));
  if ('error' in password) return envelope_error('', undefined, `chris passwd: ${password.error}\n`);
  const deps: DeployDeps = { store: context.vms, nets: context.nets, builder: context.builder, resolve: context.resolve, status_get: context.status_get, ...(context.remote_open !== undefined ? { remote_open: context.remote_open } : {}), ...(context.tickMs !== undefined ? { tickMs: context.tickMs } : {}) };
  const result: PasswdResult = {};
  const shown: string = password.generated ? `${chalk.yellow(`the new password for ${username}, generated, shown this once: ${password.password}`)}\n` : '';
  const ran = await job_runFollowed(PASSWD_JOBS.passwd(target.vm), `change ${username}'s password on the ChRIS on ${target.vm}`, chrisPasswdRun_make(target.vm, { username, password: password.password }, deps, result));
  if ('error' in ran) {
    const again: string = admin ? ` (this host keeps the new password already: chris passwd${read.options.has('--on') ? ` --on ${target.vm}` : ''} again, with the same one, finishes it)` : '';
    return envelope_error('', undefined, `${shown}chris passwd: ${ran.error}${again}\n`);
  }
  if (result.answer?.kind === 'absent') return envelope_error('', undefined, `chris passwd: ${target.vm}: no account ${username} (chris user add ${username} --email <address>)\n`);
  const where: string = !admin ? ' (never kept)' : result.kept === true ? ' (kept on this host and in the tenancy, never shown again)' : ` (kept on this host, never shown again; NOT in the tenancy: vm keep ${target.vm} keeps it there)`;
  return envelope_ok(`${shown}${target.vm}: ${username}'s password changed at ${target.url}${where}\n`);
}

/**
 * Points a host at the VM's address where its zone is kept, asking first: at
 * the registrar, when this host holds its token and the zone's name servers
 * are its; otherwise says what to change by hand. The deploy waits for
 * public DNS either way.
 *
 * @param context - The session.
 * @param host - The name.
 * @param address - The VM's address.
 * @returns What was done, in a line, or why it failed.
 */
async function dns_point(context: ChrisCommandContext, host: string, address: string): Promise<{ line: string } | { error: string }> {
  if ((await context.resolve(host)).includes(address)) return { line: `${host} already resolves to ${address}` };
  const { zone, name } = host_split(host);
  const servers: string[] = await context.nameservers_get(zone);
  const registrar: Registrar | null = context.registrar !== null && context.registrar.serves(servers) ? context.registrar : null;
  if (registrar === null) return { line: `${host} does not resolve to ${address}: point it there where ${zone} is kept (name servers ${servers.join(', ') || 'unknown'}); the deploy waits for public DNS` };
  try {
    const plan = point_plan(await registrar.records_list(zone, name), address);
    if (plan.remove.length === 0 && !plan.create) return { line: `${host} points at ${address} at ${registrar.id}; public DNS has not caught up yet` };
    const yes: boolean = await repl_confirm(`chris deploy: at ${registrar.id}, in ${zone}: ${pointPlan_words(plan, name, address)}? [y/N]`);
    if (!yes) return { line: `${zone} at ${registrar.id} not changed; the deploy waits for public DNS to give ${host} ${address}` };
    for (const record of plan.remove) await registrar.record_delete(zone, record.id);
    if (plan.create) await registrar.record_create(zone, { name, type: 'A', data: address, ttl: POINT_TTL });
    const longest: number = Math.max(0, ...plan.remove.map((record): number => record.ttl));
    return { line: `${host} points at ${address} at ${registrar.id}${longest > 0 ? ` (resolvers may keep the old answer up to ${longest} s)` : ''}` };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A berth limit from the line: a positive number in the shape asked.
 *
 * @param option - The option, for the refusal.
 * @param word - The value, or undefined when the option is absent.
 * @param shape - What the value must look like.
 * @param said - How the shape is said in the refusal.
 * @param kept - The limit when the option is absent.
 * @returns The limit, or the refusal.
 */
function berthLimit_parse(option: string, word: string | undefined, shape: RegExp, said: string, kept: number): { value: number } | { error: string } {
  if (word === undefined) return { value: kept };
  const value: number = Number(word);
  if (!shape.test(word) || !(value > 0)) return { error: `chris deploy: ${option} ${word}: ${said}\n` };
  return { value };
}

/**
 * `chris deploy <vm> --profile <profile> …`.
 *
 * @param context - The session.
 * @param args - The words after `deploy`.
 * @returns The envelope.
 */
async function chrisDeploy_run(context: ChrisCommandContext, args: ReadonlyArray<string>): Promise<CommandEnvelope> {
  // `--plan` says what the deploy would do and does nothing: a surface draws it as the offer's options, at any tier.
  const planOnly: boolean = args.includes('--plan');
  const read = options_read(args.filter((word: string): boolean => word !== '--plan'), DEPLOY_OPTIONS);
  if ('error' in read) return envelope_error('', undefined, `chris deploy: ${read.error} (${DEPLOY_OPTIONS.join(', ')})\n`);
  const [name, ...extra] = read.rest;
  if (name === undefined || extra.length > 0) return envelope_error('', undefined, `chris deploy: usage: ${DEPLOY_USAGE}\n`);
  const profileName: string | undefined = read.options.get('--profile');
  const profile: ChrisProfile | undefined = profileName === undefined ? undefined : CHRIS_PROFILES[profileName];
  const unbuilt: boolean = CHRIS_PROFILE_OFFERS.some((offer: ChrisProfileOffer): boolean => offer.name === profileName && !offer.built);
  if (profile === undefined && unbuilt) return envelope_error('', undefined, `chris deploy: --profile ${profileName ?? ''} is not built yet; one of ${Object.keys(CHRIS_PROFILES).join(', ')}\n`);
  if (profile === undefined) return envelope_error('', undefined, `chris deploy: --profile ${profileName ?? '<profile>'}: one of ${Object.keys(CHRIS_PROFILES).join(', ')}\n`);
  const host: string | null = read.options.get('--host') ?? null;
  if (host !== null && !HOST_NAME.test(host)) return envelope_error('', undefined, `chris deploy: --host ${host}: not a host name\n`);
  const porter: string | null = read.options.get('--porter') ?? null;
  if (porter !== null && !HOST_NAME.test(porter)) return envelope_error('', undefined, `chris deploy: --porter ${porter}: not a host name\n`);
  if (porter !== null && host === null) return envelope_error('', undefined, `chris deploy: --porter ${porter} needs --host: porter's sessions reach CUBE by its name, both over HTTPS\n`);
  if (porter !== null && porter === host) return envelope_error('', undefined, `chris deploy: --porter ${porter}: porter needs a name of its own, not CUBE's\n`);
  // A porter starts each person's session in a berth of its own unless the deploy says off.
  const berthsWord: string | undefined = read.options.get('--berths');
  if (berthsWord !== undefined && berthsWord !== 'on' && berthsWord !== 'off') return envelope_error('', undefined, `chris deploy: --berths ${berthsWord}: on or off\n`);
  if (berthsWord === 'on' && porter === null) return envelope_error('', undefined, 'chris deploy: --berths on needs --porter: berths are started behind porter\'s door\n');
  const berths: boolean = porter !== null && berthsWord !== 'off';
  const cpus = berthLimit_parse('--berth-cpus', read.options.get('--berth-cpus'), BERTH_CPUS, 'a positive number of CPUs, at most two decimals', BERTH_LIMITS_DEFAULT.cpus);
  if ('error' in cpus) return envelope_error('', undefined, cpus.error);
  const memory = berthLimit_parse('--berth-memory', read.options.get('--berth-memory'), BERTH_MEMORY, 'a positive number of GiB, at most one decimal', BERTH_LIMITS_DEFAULT.memoryGib);
  if ('error' in memory) return envelope_error('', undefined, memory.error);
  for (const option of ['--berth-cpus', '--berth-memory']) {
    if (read.options.has(option) && !berths) return envelope_error('', undefined, `chris deploy: ${option} needs berths (a --porter, and not --berths off)\n`);
  }
  const berthLimits: BerthLimits = { cpus: cpus.value, memoryGib: memory.value };
  const record: VmRecord | null = context.vms.record_read(name);
  const spec = context.vms.spec_read(name);
  if (record === null || spec === null || 'error' in spec) return envelope_error('', undefined, `chris deploy: ${name}: no such VM (vm new declares one)\n`);
  if (record.built === undefined) return envelope_error('', undefined, `chris deploy: ${name}: not built (vm build ${name})\n`);
  // Reaching the machine needs its own SSH key: kept in the tenancy, read into this host's cache with the VM.
  if (vmKeyless_is(context.vms, record)) return envelope_error('', undefined, `chris deploy: ${name}: ${VM_KEYLESS}\n`);
  const vmSpec: VmSpec = spec.spec;
  const short: string[] = floor_short(profile, vmSpec);
  if (short.length > 0) return envelope_error('', undefined, `chris deploy: ${name} is below the ${profile.name} profile's floor: ${short.join('; ')}\n`);
  // A berth's CPUs are a cap on CPUs it shares with CUBE: no more than the machine has; how many berths it holds is memory alone.
  if (berths && berthLimits.cpus > vmSpec.vcpu) return envelope_error('', undefined, `chris deploy: --berth-cpus ${berthLimits.cpus}: ${name} has ${vmSpec.vcpu} vCPU\n`);
  if (berths && berthCapacity_derive({ cpus: vmSpec.vcpu, memoryGib: vmSpec.memory }, profile.floor, { limits: berthLimits, holds: null }) === 0) {
    return envelope_error('', undefined, `chris deploy: berths of ${berthLimits.memoryGib} GiB do not fit ${name} above the ${profile.name} profile's floor (${vmSpec.memory} GiB; the floor takes ${profile.floor.memory} GiB)\n`);
  }
  if (!vmSpec.open.includes(80) || (host !== null && !vmSpec.open.includes(443))) return envelope_error('', undefined, `chris deploy: ${name} does not open ${host !== null ? '80 and 443' : '80'} (vm new ${name} --open 80,443, then vm build ${name})\n`);
  const compute: string = read.options.get('--compute') ?? name;
  const plan: ChrisPlan = await chrisPlan_read(context, record, { profile: profile.name, compute, host, porter, berths, berthLimits });
  if (planOnly) return envelope_ok(`${chrisPlan_words(name, plan)}\n`, { kind: STRATUS_CHRIS_PLAN_MODEL_KIND, data: { vm: name, ...plan } });
  if (!tasks_granted()) return envelope_error('', undefined, `chris deploy: ${TIER_REFUSAL}\n`);
  // A first deploy, or a replay that restarts or changes what runs, asks first, with all of it (a-change-is-a-loop, clause 4);
  // a first deploy's admin password is asked after the yes, so the question says what it is for.
  const passwordNext: boolean = secrets_read(context.vms, name) === null && !read.options.has('--admin-password-file');
  const question: string = `${chrisPlan_words(name, plan)}${passwordNext ? '; the admin password for chris is asked next, hidden (empty: one is generated)' : ''}. A NO changes nothing. Continue? [y/N]`;
  if (plan.asks && !(await repl_confirm(question))) return envelope_ok(`${chalk.gray(`stopped before the deploy; nothing changed (chris deploy ${name} plans and asks again)`)}\n`, { kind: LINE_DECLINED_MODEL_KIND, data: { line: `chris deploy ${name}`, kept: 'nothing made or changed' } });
  if (context.builder === null) return envelope_error('', undefined, 'chris deploy: this cloud builds nothing yet\n');
  let generated: string | null = null;
  if (secrets_read(context.vms, name) === null) {
    const admin = await adminPassword_get(read.options.get('--admin-password-file'));
    if ('error' in admin) return envelope_error('', undefined, `chris deploy: ${admin.error}\n`);
    if (admin.generated) generated = admin.password;
    secrets_ensure(context.vms, name, admin.password);
  }
  const kept = secrets_read(context.vms, name);
  if (kept === null) return envelope_error('', undefined, `chris deploy: ${name}: its secrets were not kept\n`);
  const withPorter = porter !== null ? porterSecret_ensure(context.vms, name, kept) : kept;
  const secrets = berths ? launcherSecret_ensure(context.vms, name, withPorter) : withPorter;
  const deps: DeployDeps = { store: context.vms, nets: context.nets, builder: context.builder, resolve: context.resolve, status_get: context.status_get, ...(context.remote_open !== undefined ? { remote_open: context.remote_open } : {}), ...(context.tickMs !== undefined ? { tickMs: context.tickMs } : {}) };
  let pointed: string = '';
  const address: string | undefined = record.dataOutputs?.['public_ip'];
  if (host !== null && address !== undefined) {
    for (const each of [host, ...(porter !== null ? [porter] : [])]) {
      const point = await dns_point(context, each, address);
      if ('error' in point) return envelope_error('', undefined, `${pointed}chris deploy: pointing ${each}: ${point.error}\n`);
      pointed += `${point.line}\n`;
    }
  }
  const shown: string = generated !== null ? `${chalk.yellow(`the admin password for chris, generated, shown this once: ${generated}`)}\n` : '';
  const ran = await job_runFollowed(CHRIS_JOBS.deploy(name), `deploy ChRIS on ${name}`, chrisDeployRun_make({ vm: name, profile, compute, host, porter, berths, berthLimits, secrets }, deps));
  if ('error' in ran) return envelope_error('', undefined, `${shown}${pointed}chris deploy: ${ran.error}\n`);
  const done: VmRecord | null = context.vms.record_read(name);
  const door: string = porter !== null ? `; porter at https://${porter}/${berths ? ', a berth for each person' : ''}` : '';
  return envelope_ok(`${shown}${pointed}${name}: ChRIS ${profile.name} at ${done?.chris?.url ?? '?'}, compute ${compute}${door}; the admin is chris (its password is kept on this host, never shown again)\n`);
}

/**
 * What a deploy would do, with porter's open sessions read from it when a
 * porter restart is among the restarts.
 *
 * @param context - The session.
 * @param record - The VM's record.
 * @param ask - What the deploy is asked to put up.
 * @returns The plan.
 */
async function chrisPlan_read(context: ChrisCommandContext, record: VmRecord, ask: { profile: string; compute: string; host: string | null; porter: string | null; berths: boolean; berthLimits: BerthLimits }): Promise<ChrisPlan> {
  const first: ChrisPlan = chrisPlan_derive(record.chris, ask, null);
  const porterRestarts: boolean = first.restarts.some((one: string): boolean => one.startsWith('porter (') || one.startsWith('CUBE and porter'));
  if (!porterRestarts || record.chris === undefined || context.http_get === undefined) return first;
  const live: ChrisLive = await chrisLive_read(record.chris, null, context.http_get);
  return chrisPlan_derive(record.chris, ask, live.porter?.sessions ?? null);
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
    case 'status': return await chrisStatus_run(context, rest);
    case 'deploy': return await chrisDeploy_run(context, rest);
    case 'user': return await chrisUser_run(context, rest);
    case 'passwd': return await chrisPasswd_run(context, rest);
    case 'plugin': return await chrisPlugin_run(context, rest);
    default: return envelope_error('', undefined, `chris: ${verb}: not a verb (chris status, deploy, user, passwd, plugin)\n`);
  }
}

/** `chris`'s help. */
export const CHRIS_HELP: CommandHelp = {
  usage: 'chris [status [<vm>…]] | chris deploy <vm> --profile <profile> [--compute <name>] [--host <name>] [--porter <name>] [--berths on|off] [--berth-cpus <N>] [--berth-memory <GiB>] [--admin-password-file <file>] | chris user add <name> --email <address> [--password-file <file>] [--on <vm>] | chris passwd [<user>] [--password-file <file>] [--on <vm>] | chris plugin sync [<source>] [--ref <ref>] [--on <vm>] [--plan]',
  summary: 'Put ChRIS on a built VM, add its users, change their passwords, and fill its plugins',
  category: 'Resources',
  description: 'chris deploy puts the all-in-one CUBE on a built VM, over the network\'s bastion and never through cloud-init, as a task (/proc/steps/chris-<vm>-deploy). A profile is data: minimal is CUBE 6.11.0 (production, uvicorn), its workers and scheduler, Postgres, Dragonfly, NATS and pfcon 5.3.1 in-network beside it running plugins through the VM\'s Docker, behind Caddy; a VM below its floor (2 vCPU, 4 GiB, 50 GB data) is refused and told by how much. Everything lands on the data volume (/srv/data/chris), so a rebuilt machine opens the old database. The internal secrets are generated by the first deploy and kept on this host; the admin password for chris is asked once (empty: generated and shown once) or read from --admin-password-file. The compute resource (--compute, default the VM\'s name) is registered, and the deploy checks chris sees the admin API, as plugin uploads need. Without --host, ChRIS answers over plain HTTP on the VM\'s address; with --host, Caddy obtains the certificate once public DNS gives the name the VM\'s address, which the deploy waits for (an hour at most; a replay resumes). No profile carries the ChRIS UI: --porter <name> (with --host) adds porter, the door to mise (chell, calypso and ARGUS), beside any profile, built on the VM from its pinned npm release, its sessions logging in to this CUBE by its name; Caddy obtains porter\'s certificate too, the registrar is asked for its name as for the host\'s, and porter\'s session folders are kept on the data volume. With --porter, porter starts each person\'s session in a berth of its own through the berth launcher unless --berths off; --berth-cpus <N> (a positive number, at most two decimals) and --berth-memory <GiB> (at most one decimal) are the most one berth may use, default 1 CPU and 2 GiB, written to the launcher\'s policy; both are refused without berths. A replay that changes them restarts the berth launcher, asked first: running berths keep their limits and sessions until their next start, which needs a fresh login. chris user add makes an account on a ChRIS this stratus deployed: the one --on names, or the only one (more than one and no --on is refused). Every deploy turns CUBE\'s own sign-up off, so the account is made on the VM, in the CUBE container, with CUBE\'s user model (its groups and home folders as a sign-up gives them). --email is needed; the password is asked (empty: generated and shown once) or read from --password-file, given on stdin, and never kept. A name already there with the same email is left as it is, so a script replays; with another email it is refused. chris passwd changes an account\'s password on that ChRIS: the new one typed twice (empty: generated and shown once) or read from --password-file, given on stdin. Without a user it is the admin\'s, chris: CUBE sets chris\'s password from cube.env each time it starts, so the new one is kept on this host, written to cube.env on the VM and set in CUBE, the services cube.env feeds are started again (CUBE is down for a minute or so, and the operator is asked first), chris is checked to sign in with it, and the tenancy keeps it with the VM\'s other secrets. A run stopped anywhere finishes when asked again with the same password. Any other account\'s is set in CUBE alone and never kept. chris plugin sync fills that ChRIS from the plugin index (FNNDSC/chris-plugins by default, or the source given; --ref pins a branch, tag or commit) with the chell porter runs beside it, so it needs a deploy with --porter whose chell is 5.20.0 or later (an older one is refused, naming the deploy replay that updates it). On the VM, chris\'s password is read from cube.env and exchanged there for a token, which reaches that chell on stdin; it never leaves the VM. The chell reads the plan first: what it would add, what is there already, and what it reports and never touches (newer in CUBE, a different descriptor, an image taken, not in the index, invalid). The question names those counts; a yes applies the plan pinned to the commit it read, one line per plugin in the task\'s log, and nothing in CUBE is removed or changed. Nothing to add asks nothing, so a script replays; --plan reads the plan and stops.',
  examples: ['chris deploy store --profile minimal --compute NERC --host cube.chrisproject.org --porter porter.chrisproject.org', 'chris deploy vm-try --profile minimal', 'chris status', 'chris user add jorge --email jorge@example.org --on store', 'chris passwd --on store', 'chris passwd jorge --on store', 'chris plugin sync --on store', 'chris plugin sync FNNDSC/chris-plugins --ref 8c9a1f6 --on store --plan'],
};
