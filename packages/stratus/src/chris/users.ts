/**
 * @file A ChRIS's users, made by the stratus that deployed it
 * (docs/stratus.adoc, D16). CUBE's own API makes no account once
 * `DISABLE_USER_ACCOUNT_CREATION` is set, which every deploy sets so a
 * stranger cannot make one; so the account is made on the VM, inside the
 * CUBE container, with CUBE's own user model, which gives the account its
 * groups and its home folders as a sign-up would. The program and the
 * password go to the container's Python on stdin, never on a command line.
 *
 * @module
 */
import type { JobContext, JobRun } from '@fnndsc/brasa/core';
import type { BuildCall } from '../cloud/builder.js';
import { vmRemote_open, type RemoteAnswer, type VmRemote } from '../vm/remote.js';
import type { DeployDeps } from './deploy.js';
import { CHRIS_DIR } from './compose.js';

/** The account asked for. */
export interface UserAsk {
  readonly username: string;
  readonly email: string;
  readonly password: string;
}

/** What CUBE said: made, there already (with its email), or the email another's; a password changed, or no such account. */
export type UserAnswer =
  | { readonly kind: 'added' }
  | { readonly kind: 'exists'; readonly email: string }
  | { readonly kind: 'emailTaken'; readonly username: string }
  | { readonly kind: 'changed' }
  | { readonly kind: 'absent' };

/** A user name CUBE takes: four to thirty-two of Django's letters, never a comma or a slash. */
export const USER_NAME: RegExp = /^[A-Za-z0-9_.@+-]{4,32}$/;

/** An email address, as far as a command line can tell. */
export const EMAIL: RegExp = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/** The line that runs a program, given on stdin, in the CUBE container with Django set up. */
export const CUBE_PYTHON_LINE: string = `cd ${CHRIS_DIR} && docker compose exec -T chris python -c 'import django, sys; django.setup(); exec(sys.stdin.read())'`;

/** What the program's answer line starts with. */
const ANSWER_MARK: string = 'stratus-user';

/**
 * The program that makes the account, or says why not: the ask carried as
 * base64 of its JSON, so no quoting of it can go wrong.
 *
 * @param ask - The account.
 * @returns The Python program.
 */
export function userAddProgram_render(ask: UserAsk): string {
  const carried: string = Buffer.from(JSON.stringify(ask), 'utf-8').toString('base64');
  return [
    'import base64, json',
    'from django.contrib.auth.models import User',
    'from users.models import UserProxy',
    `ask = json.loads(base64.b64decode('${carried}').decode('utf-8'))`,
    'same = User.objects.filter(username=ask["username"]).first()',
    'other = User.objects.filter(email=ask["email"]).exclude(username=ask["username"]).first()',
    'if same is not None:',
    `    print("${ANSWER_MARK} exists " + json.dumps(same.email))`,
    'elif other is not None:',
    `    print("${ANSWER_MARK} email-taken " + json.dumps(other.username))`,
    'else:',
    '    UserProxy.objects.create_user(username=ask["username"], email=ask["email"], password=ask["password"])',
    `    print("${ANSWER_MARK} added")`,
    '',
  ].join('\n');
}

/**
 * The program that sets an account's password, or says there is no such
 * account: the ask carried as base64 of its JSON, as an add's is.
 *
 * @param ask - The account's name and its new password.
 * @returns The Python program.
 */
export function userPasswdProgram_render(ask: { readonly username: string; readonly password: string }): string {
  const carried: string = Buffer.from(JSON.stringify(ask), 'utf-8').toString('base64');
  return [
    'import base64, json',
    'from django.contrib.auth.models import User',
    `ask = json.loads(base64.b64decode('${carried}').decode('utf-8'))`,
    'user = User.objects.filter(username=ask["username"]).first()',
    'if user is None:',
    `    print("${ANSWER_MARK} absent")`,
    'else:',
    '    user.set_password(ask["password"])',
    '    user.save()',
    `    print("${ANSWER_MARK} changed")`,
    '',
  ].join('\n');
}

/** What the admin-home program's answer line starts with. */
export const HOME_MARK: string = 'stratus-home';

/**
 * The program that gives the admin, `chris`, the home a sign-up gives any
 * account: CUBE makes `chris` with Django's bare `create_superuser` each
 * time its migrations first run, which makes no home, so a session signed
 * in as `chris` finds no `/home/chris/feeds`. The groups, `uploads/` and
 * `feeds/` and the `public` and `shared` links are made as CUBE 6.11's
 * `UserProxy.save` makes them; each one already there is left as it is, so
 * every deploy runs it.
 *
 * @returns The Python program.
 */
export function adminHomeProgram_render(): string {
  return [
    'from django.contrib.auth.models import Group, User',
    'from core.models import ChrisFolder, ChrisLinkFile',
    'user = User.objects.get(username="chris")',
    'made = []',
    'for name in ("all_users", "pacs_users"):',
    '    group = Group.objects.filter(name=name).first()',
    '    if group is not None and not user.groups.filter(pk=group.pk).exists():',
    '        user.groups.add(group)',
    '        made.append("group " + name)',
    'for path in ("home/chris/uploads", "home/chris/feeds"):',
    '    (folder, new) = ChrisFolder.objects.get_or_create(path=path, owner=user)',
    '    if new:',
    '        made.append(path)',
    'home = ChrisFolder.objects.get(path="home/chris")',
    'for (pointed, name) in (("PUBLIC", "public"), ("SHARED", "shared")):',
    '    if not ChrisLinkFile.objects.filter(fname="home/chris/" + name + ".chrislink").exists():',
    '        ChrisLinkFile(path=pointed, owner=user, parent_folder=home).save(name=name)',
    '        made.append("home/chris/" + name)',
    `print("${HOME_MARK} " + (", ".join(made) if made else "there"))`,
    '',
  ].join('\n');
}

/**
 * The program's answer, from its output.
 *
 * @param stdout - What the line printed.
 * @returns The answer, or null when it printed none.
 */
export function userAnswer_parse(stdout: string): UserAnswer | null {
  const line: string | undefined = stdout.split('\n').find((each: string): boolean => each.startsWith(`${ANSWER_MARK} `));
  if (line === undefined) return null;
  const [, kind = '', ...rest] = line.split(' ');
  const value: string = rest.join(' ');
  if (kind === 'added') return { kind: 'added' };
  if (kind === 'exists') return { kind: 'exists', email: JSON.parse(value) as string };
  if (kind === 'email-taken') return { kind: 'emailTaken', username: JSON.parse(value) as string };
  if (kind === 'changed') return { kind: 'changed' };
  if (kind === 'absent') return { kind: 'absent' };
  return null;
}

/** The user job's id. */
export const USER_JOBS = { add: (vm: string): string => `chris-${vm}-user-add` } as const;

/** Where the job leaves CUBE's answer for the command. */
export interface UserAddResult {
  answer?: UserAnswer;
}

/**
 * The job that makes an account on a VM's ChRIS.
 *
 * @param vm - The VM.
 * @param ask - The account.
 * @param deps - What it runs over (the deploy's).
 * @param result - Given CUBE's answer.
 * @returns The job's work.
 */
export function chrisUserAddRun_make(vm: string, ask: UserAsk, deps: DeployDeps, result: UserAddResult): JobRun {
  return async (context: JobContext): Promise<void> => {
    const call: BuildCall = { log: (line: string): void => context.log_write(line), signal: context.signal };
    const remote: VmRemote = await (deps.remote_open ?? ((name: string, inner: BuildCall): Promise<VmRemote> => vmRemote_open(name, { store: deps.store, nets: deps.nets, builder: deps.builder }, inner)))(vm, call);
    context.log_write(`asking CUBE on ${vm} for ${ask.username}`);
    const answer: RemoteAnswer = await remote.run(CUBE_PYTHON_LINE, userAddProgram_render(ask));
    const parsed: UserAnswer | null = userAnswer_parse(answer.stdout);
    if (answer.code !== 0 || parsed === null) throw new Error(`CUBE on ${vm} did not make ${ask.username}: exit ${answer.code}: ${(answer.stderr || answer.stdout).trim().split('\n').slice(-3).join(' / ')}`);
    result.answer = parsed;
    context.log_write(parsed.kind === 'added' ? `${ask.username} made` : `${ask.username} not made (${parsed.kind === 'exists' ? 'there already' : parsed.kind === 'emailTaken' ? `the email is ${parsed.username}'s` : parsed.kind})`);
  };
}
