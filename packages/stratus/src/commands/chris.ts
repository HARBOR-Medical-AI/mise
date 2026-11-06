/**
 * @file `chris`: the ChRIS layer on a built VM (docs/stratus.adoc, D16).
 *
 * `chris deploy <vm> --profile <profile> [--compute <name>] [--host <name>]
 * [--porter <name>] [--admin-password-file <file>]` puts the all-in-one CUBE on the VM over
 * the bastion path, as a task: refused below the profile's floor; the
 * internal secrets generated once and kept on this host; the admin password
 * asked once (empty: generated and shown once) or read from a file; the
 * compute resource (default: the VM's name) registered. With `--host`, it
 * waits for public DNS and the certificate, and a replay resumes there. With
 * `--porter`, porter (the door to mise: chell, calypso, ARGUS) runs beside
 * it under its own name, logging in to this CUBE.
 * `chris status [<vm>]` says what is deployed where. `chris user add <name>
 * --email <address> [--password-file <file>] [--on <vm>]` makes an account
 * on a ChRIS this stratus deployed, on the VM itself (CUBE's API makes none
 * once sign-up is off); the password asked (empty: generated and shown once)
 * or read from a file, and never kept. `chris passwd [<user>] [--password-file
 * <file>] [--on <vm>]` changes an account's password there, the admin's
 * (`chris`, the default) on the host, in `cube.env` and in CUBE together,
 * CUBE's services started again to take it, and kept in the tenancy.
 *
 * @module
 */
import * as fs from 'fs';
import chalk from 'chalk';
import { envelope_error, envelope_ok, LINE_DECLINED_MODEL_KIND, STRATUS_CHRIS_PLAN_MODEL_KIND, STRATUS_CHRIS_STATUS_MODEL_KIND, type ChrisStatusRow, type CommandEnvelope } from '@fnndsc/menu';
import { repl_confirm, repl_questionHidden, type CommandHelp } from '@fnndsc/brasa/core';
import type { CloudBuilder } from '../cloud/builder.js';
import type { NetStore } from '../net/state.js';
import type { VmSpec } from '../vm/spec.js';
import type { VmRecord, VmStore } from '../vm/state.js';
import type { VmRemote } from '../vm/remote.js';
import type { BuildCall } from '../cloud/builder.js';
import { CHRIS_PROFILES, floor_short, type ChrisProfile } from '../chris/profiles.js';
import { VM_KEYLESS, vmKeyless_is } from '../vm/keep.js';
import { porterSecret_ensure, secret_make, secrets_ensure, secrets_read } from '../chris/secrets.js';
import { CHRIS_JOBS, chrisDeployRun_make, type DeployDeps } from '../chris/deploy.js';
import { host_split, point_plan, pointPlan_words, POINT_TTL, type Registrar } from '../chris/registrar.js';
import { chrisUserAddRun_make, EMAIL, USER_JOBS, USER_NAME, type UserAddResult, type UserAnswer } from '../chris/users.js';
import { CHRIS_ADMIN, chrisPasswdRun_make, PASSWD_JOBS, type PasswdResult } from '../chris/passwd.js';
import { job_runFollowed, options_read, tasks_granted } from './build.js';
import { TIER_REFUSAL } from '../tier.js';
import { chrisLive_read, type ChrisLive, type HttpGet } from '../chris/live.js';
import { chrisPlan_derive, chrisPlan_words, type ChrisPlan } from '../chris/plan.js';

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
const DEPLOY_OPTIONS: ReadonlyArray<string> = ['--profile', '--compute', '--host', '--porter', '--admin-password-file'];

/** `chris deploy`'s usage. */
const DEPLOY_USAGE: string = 'chris deploy <vm> --profile <profile> [--compute <name>] [--host <name>] [--porter <name>] [--admin-password-file <file>] [--plan]';

/** The options `chris user add` reads, each a value. */
const USER_OPTIONS: ReadonlyArray<string> = ['--email', '--password-file', '--on'];

/** `chris user add`'s usage. */
const USER_USAGE: string = 'chris user add <name> --email <address> [--password-file <file>] [--on <vm>]';

/** The options `chris passwd` reads, each a value. */
const PASSWD_OPTIONS: ReadonlyArray<string> = ['--password-file', '--on'];

/** `chris passwd`'s usage. */
const PASSWD_USAGE: string = 'chris passwd [<user>] [--password-file <file>] [--on <vm>]';

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
      image: chris.image ?? null, porterVersion: chris.porterVersion ?? null,
      live: live === null ? null : { at: live.at, cube: live.cube, porter: live.porter, accounts: live.accounts === null ? null : [...live.accounts], accountsWhy: live.accountsWhy },
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
  return [`  runs      ${cube}${porter}${read}`, `  accounts  ${accounts}`];
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
  if (verb !== 'add') return envelope_error('', undefined, `chris user: ${verb === undefined ? 'usage' : `${verb}: not a verb`}: ${USER_USAGE}\n`);
  const read = options_read(rest, USER_OPTIONS);
  if ('error' in read) return envelope_error('', undefined, `chris user add: ${read.error} (${USER_OPTIONS.join(', ')})\n`);
  const [username, ...extra] = read.rest;
  if (username === undefined || extra.length > 0) return envelope_error('', undefined, `chris user add: usage: ${USER_USAGE}\n`);
  if (!USER_NAME.test(username)) return envelope_error('', undefined, `chris user add: ${username}: a user name is 4 to 32 letters, digits or . @ + - _\n`);
  const email: string | undefined = read.options.get('--email');
  if (email === undefined) return envelope_error('', undefined, `chris user add: ${username}: --email <address> is needed (CUBE makes no account without one)\n`);
  if (!EMAIL.test(email)) return envelope_error('', undefined, `chris user add: --email ${email}: not an email address\n`);
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
  const file: string | undefined = read.options.get('--password-file');
  // A file's password is read before the question, so a bad file refuses without asking.
  const filed = file === undefined ? null : await userPassword_get(username, file);
  if (filed !== null && 'error' in filed) return envelope_error('', undefined, `chris user add: ${filed.error}\n`);
  const counted: string = live?.accounts === null || live === null ? `its accounts not read${live?.accountsWhy ? `: ${live.accountsWhy}` : ''}` : `${live.accounts.length} account${live.accounts.length === 1 ? '' : 's'} there now, read ${live.at.slice(11, 16)} UTC`;
  const question: string = `chris user add ${username}: makes the account ${username} (${email}) on the ChRIS at ${target.url}, on ${target.vm} (${counted}); its password ${file !== undefined ? `read from ${file}` : 'asked next, hidden'}. A NO makes nothing. Continue? [y/N]`;
  if (!await repl_confirm(question)) {
    return envelope_ok(`${chalk.gray(`stopped before ${username} was made; nothing changed on ${target.vm} (chris user add ${username} asks again)`)}\n`, { kind: LINE_DECLINED_MODEL_KIND, data: { line: `chris user add ${username}`, kept: 'nothing made' } });
  }
  const password = filed ?? await userPassword_get(username, undefined);
  if ('error' in password) return envelope_error('', undefined, `chris user add: ${password.error}\n`);
  const deps: DeployDeps = { store: context.vms, nets: context.nets, builder: context.builder, resolve: context.resolve, status_get: context.status_get, ...(context.remote_open !== undefined ? { remote_open: context.remote_open } : {}) };
  const result: UserAddResult = {};
  const ran = await job_runFollowed(USER_JOBS.add(target.vm), `add ${username} to the ChRIS on ${target.vm}`, chrisUserAddRun_make(target.vm, { username, email, password: password.password }, deps, result));
  if ('error' in ran) return envelope_error('', undefined, `chris user add: ${ran.error}\n`);
  const answer: UserAnswer | undefined = result.answer;
  if (answer?.kind === 'exists') {
    return answer.email === email
      ? envelope_ok(`${target.vm}: ${username} is there already (${email}); left as it is\n`)
      : envelope_error('', undefined, `chris user add: ${target.vm}: ${username} already exists, with ${answer.email}; left as it is\n`);
  }
  if (answer?.kind === 'emailTaken') return envelope_error('', undefined, `chris user add: ${target.vm}: ${email} is ${answer.username}'s already\n`);
  const shown: string = password.generated ? `${chalk.yellow(`the password for ${username}, generated, shown this once: ${password.password}`)}\n` : '';
  return envelope_ok(`${shown}${target.vm}: ${username} added at ${target.url} (${email})\n`);
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
  if (profile === undefined) return envelope_error('', undefined, `chris deploy: --profile ${profileName ?? '<profile>'}: one of ${Object.keys(CHRIS_PROFILES).join(', ')}\n`);
  const host: string | null = read.options.get('--host') ?? null;
  if (host !== null && !HOST_NAME.test(host)) return envelope_error('', undefined, `chris deploy: --host ${host}: not a host name\n`);
  const porter: string | null = read.options.get('--porter') ?? null;
  if (porter !== null && !HOST_NAME.test(porter)) return envelope_error('', undefined, `chris deploy: --porter ${porter}: not a host name\n`);
  if (porter !== null && host === null) return envelope_error('', undefined, `chris deploy: --porter ${porter} needs --host: porter's sessions reach CUBE by its name, both over HTTPS\n`);
  if (porter !== null && porter === host) return envelope_error('', undefined, `chris deploy: --porter ${porter}: porter needs a name of its own, not CUBE's\n`);
  const record: VmRecord | null = context.vms.record_read(name);
  const spec = context.vms.spec_read(name);
  if (record === null || spec === null || 'error' in spec) return envelope_error('', undefined, `chris deploy: ${name}: no such VM (vm new declares one)\n`);
  if (record.built === undefined) return envelope_error('', undefined, `chris deploy: ${name}: not built (vm build ${name})\n`);
  // Reaching the machine needs its own SSH key: kept in the tenancy, read into this host's cache with the VM.
  if (vmKeyless_is(context.vms, record)) return envelope_error('', undefined, `chris deploy: ${name}: ${VM_KEYLESS}\n`);
  const vmSpec: VmSpec = spec.spec;
  const short: string[] = floor_short(profile, vmSpec);
  if (short.length > 0) return envelope_error('', undefined, `chris deploy: ${name} is below the ${profile.name} profile's floor: ${short.join('; ')}\n`);
  if (!vmSpec.open.includes(80) || (host !== null && !vmSpec.open.includes(443))) return envelope_error('', undefined, `chris deploy: ${name} does not open ${host !== null ? '80 and 443' : '80'} (vm new ${name} --open 80,443, then vm build ${name})\n`);
  const compute: string = read.options.get('--compute') ?? name;
  const plan: ChrisPlan = await chrisPlan_read(context, record, { profile: profile.name, compute, host, porter });
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
  const secrets = porter !== null ? porterSecret_ensure(context.vms, name, kept) : kept;
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
  const ran = await job_runFollowed(CHRIS_JOBS.deploy(name), `deploy ChRIS on ${name}`, chrisDeployRun_make({ vm: name, profile, compute, host, porter, secrets }, deps));
  if ('error' in ran) return envelope_error('', undefined, `${shown}${pointed}chris deploy: ${ran.error}\n`);
  const done: VmRecord | null = context.vms.record_read(name);
  const door: string = porter !== null ? `; porter at https://${porter}/` : '';
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
async function chrisPlan_read(context: ChrisCommandContext, record: VmRecord, ask: { profile: string; compute: string; host: string | null; porter: string | null }): Promise<ChrisPlan> {
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
    default: return envelope_error('', undefined, `chris: ${verb}: not a verb (chris status, deploy, user, passwd)\n`);
  }
}

/** `chris`'s help. */
export const CHRIS_HELP: CommandHelp = {
  usage: 'chris [status [<vm>…]] | chris deploy <vm> --profile <profile> [--compute <name>] [--host <name>] [--porter <name>] [--admin-password-file <file>] | chris user add <name> --email <address> [--password-file <file>] [--on <vm>] | chris passwd [<user>] [--password-file <file>] [--on <vm>]',
  summary: 'Put ChRIS on a built VM, add its users, and change their passwords',
  category: 'Resources',
  description: 'chris deploy puts the all-in-one CUBE on a built VM, over the network\'s bastion and never through cloud-init, as a task (/proc/steps/chris-<vm>-deploy). A profile is data: minimal is CUBE 6.11.0 (production, uvicorn), its workers and scheduler, Postgres, Dragonfly, NATS and pfcon 5.3.1 in-network beside it running plugins through the VM\'s Docker, behind Caddy; a VM below its floor (2 vCPU, 4 GiB, 50 GB data) is refused and told by how much. Everything lands on the data volume (/srv/data/chris), so a rebuilt machine opens the old database. The internal secrets are generated by the first deploy and kept on this host; the admin password for chris is asked once (empty: generated and shown once) or read from --admin-password-file. The compute resource (--compute, default the VM\'s name) is registered, and the deploy checks chris sees the admin API, as plugin uploads need. Without --host, ChRIS answers over plain HTTP on the VM\'s address; with --host, Caddy obtains the certificate once public DNS gives the name the VM\'s address, which the deploy waits for (an hour at most; a replay resumes). No profile carries the ChRIS UI: --porter <name> (with --host) adds porter, the door to mise (chell, calypso and ARGUS), beside any profile, built on the VM from its pinned npm release, its sessions logging in to this CUBE by its name; Caddy obtains porter\'s certificate too, the registrar is asked for its name as for the host\'s, and porter\'s session folders are kept on the data volume. chris user add makes an account on a ChRIS this stratus deployed: the one --on names, or the only one (more than one and no --on is refused). Every deploy turns CUBE\'s own sign-up off, so the account is made on the VM, in the CUBE container, with CUBE\'s user model (its groups and home folders as a sign-up gives them). --email is needed; the password is asked (empty: generated and shown once) or read from --password-file, given on stdin, and never kept. A name already there with the same email is left as it is, so a script replays; with another email it is refused. chris passwd changes an account\'s password on that ChRIS: the new one typed twice (empty: generated and shown once) or read from --password-file, given on stdin. Without a user it is the admin\'s, chris: CUBE sets chris\'s password from cube.env each time it starts, so the new one is kept on this host, written to cube.env on the VM and set in CUBE, the services cube.env feeds are started again (CUBE is down for a minute or so, and the operator is asked first), chris is checked to sign in with it, and the tenancy keeps it with the VM\'s other secrets. A run stopped anywhere finishes when asked again with the same password. Any other account\'s is set in CUBE alone and never kept.',
  examples: ['chris deploy store --profile minimal --compute NERC --host cube.chrisproject.org --porter porter.chrisproject.org', 'chris deploy vm-try --profile minimal', 'chris status', 'chris user add jorge --email jorge@example.org --on store', 'chris passwd --on store', 'chris passwd jorge --on store'],
};
