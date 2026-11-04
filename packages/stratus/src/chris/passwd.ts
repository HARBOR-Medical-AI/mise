/**
 * @file `chris passwd` as a job (docs/stratus.adoc, D16): an account's
 * password changed on a ChRIS this stratus deployed.
 *
 * Any account's is set on the VM, in the CUBE container, with CUBE's own user
 * model, the password on stdin, and never kept. The admin's, `chris`, is kept
 * in three places that change together: the host's `auth/chris.json` (which
 * every replay renders `cube.env` from and every admin call signs in with),
 * `cube.env` on the VM (CUBE sets `chris`'s password from it each time its
 * migrations run, so a change made only in CUBE is undone at the next start),
 * and CUBE's database. So the job keeps the new password on the host first,
 * writes `cube.env`, sets the password in CUBE, starts again the services
 * whose environment changed, and signs in with the new password; the tenancy
 * keeps it last. No step needs the old password, so a job stopped anywhere
 * finishes when asked again with the same password.
 *
 * @module
 */
import type { JobContext, JobRun } from '@fnndsc/brasa/core';
import type { BuildCall } from '../cloud/builder.js';
import { vmRemote_open, type RemoteAnswer, type VmRemote } from '../vm/remote.js';
import { vm_read } from '../vm/build.js';
import { CHRIS_DIR, cubeEnv_render, type ChrisSecrets, type ChrisTarget } from './compose.js';
import { cube_ask, kept_write, run_must, until, type DeployDeps } from './deploy.js';
import { secrets_read, secrets_write } from './secrets.js';
import { CUBE_PYTHON_LINE, userAnswer_parse, userPasswdProgram_render, type UserAnswer } from './users.js';

/** The admin CUBE makes, whose password the deploy keeps. */
export const CHRIS_ADMIN: string = 'chris';

/** The passwd job's id. */
export const PASSWD_JOBS = { passwd: (vm: string): string => `chris-${vm}-passwd` } as const;

/** The account and its new password. */
export interface PasswdAsk {
  readonly username: string;
  readonly password: string;
}

/** Where the job leaves CUBE's answer for the command. */
export interface PasswdResult {
  answer?: UserAnswer;
  /** Whether the tenancy keeps the admin's new password. */
  kept?: boolean;
}

/**
 * Sets the password in CUBE's database, refusing a failure.
 *
 * @param remote - The VM.
 * @param vm - The VM's name.
 * @param ask - The account and its password.
 * @returns CUBE's answer.
 * @throws Error - When the program fails or answers nothing.
 */
async function password_set(remote: VmRemote, vm: string, ask: PasswdAsk): Promise<UserAnswer> {
  const answer: RemoteAnswer = await remote.run(CUBE_PYTHON_LINE, userPasswdProgram_render(ask));
  const parsed: UserAnswer | null = userAnswer_parse(answer.stdout);
  if (answer.code !== 0 || parsed === null) throw new Error(`CUBE on ${vm} did not set ${ask.username}'s password: exit ${answer.code}: ${(answer.stderr || answer.stdout).trim().split('\n').slice(-3).join(' / ')}`);
  return parsed;
}

/**
 * The job that changes an account's password on a VM's ChRIS.
 *
 * @param vm - The VM.
 * @param ask - The account and its new password.
 * @param deps - What it runs over (the deploy's).
 * @param result - Given CUBE's answer.
 * @returns The job's work.
 */
export function chrisPasswdRun_make(vm: string, ask: PasswdAsk, deps: DeployDeps, result: PasswdResult): JobRun {
  return async (context: JobContext): Promise<void> => {
    const call: BuildCall = { log: (line: string): void => context.log_write(line), signal: context.signal };
    const remote: VmRemote = await (deps.remote_open ?? ((name: string, inner: BuildCall): Promise<VmRemote> => vmRemote_open(name, { store: deps.store, nets: deps.nets, builder: deps.builder }, inner)))(vm, call);
    if (ask.username !== CHRIS_ADMIN) {
      context.log_write(`asking CUBE on ${vm} to set ${ask.username}'s password`);
      result.answer = await password_set(remote, vm, ask);
      context.log_write(result.answer.kind === 'changed' ? `${ask.username}'s password set` : `${ask.username}: no such account`);
      return;
    }

    const { record } = vm_read(deps.store, vm);
    const kept: ChrisSecrets | null = secrets_read(deps.store, vm);
    const address: string | undefined = record.dataOutputs?.['public_ip'];
    if (record.chris === undefined || kept === null) throw new Error(`${vm}: this host keeps no ChRIS secrets for it (chris deploy ${vm})`);
    if (address === undefined) throw new Error(`${vm}: it has no public address`);
    const secrets: ChrisSecrets = { ...kept, adminPassword: ask.password };
    secrets_write(deps.store, vm, secrets);
    context.log_write('kept the new password on this host');

    const target: ChrisTarget = { host: record.chris.host, address, porter: record.chris.porter ?? null };
    await run_must(remote, `umask 077 && cat > ${CHRIS_DIR}/cube.env.new && chmod 0600 ${CHRIS_DIR}/cube.env.new && mv ${CHRIS_DIR}/cube.env.new ${CHRIS_DIR}/cube.env`, 'writing cube.env', cubeEnv_render(target, secrets));
    context.log_write(`wrote cube.env to ${CHRIS_DIR}`);
    result.answer = await password_set(remote, vm, ask);
    if (result.answer.kind === 'absent') throw new Error(`CUBE on ${vm} has no ${CHRIS_ADMIN} account`);
    context.log_write(`${CHRIS_ADMIN}'s password set in CUBE`);

    context.log_write('starting again the services cube.env feeds, so they hold the new password');
    await run_must(remote, `cd ${CHRIS_DIR} && docker compose up -d`, 'docker compose up');
    const up: boolean = await until(async (): Promise<boolean> => {
      const answer: RemoteAnswer = await remote.run('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/api/v1/');
      return answer.stdout.trim() === '200' || answer.stdout.trim() === '401';
    }, 60, deps.tickMs ?? 10_000, context.signal);
    if (!up) throw new Error('CUBE did not answer on 127.0.0.1:8000 in ten minutes');
    const signed = await cube_ask(remote, secrets, 'api/v1/');
    if (signed.status !== 200) throw new Error(`${CHRIS_ADMIN} does not sign in with the new password (HTTP ${signed.status})`);
    context.log_write(`${CHRIS_ADMIN} signs in with the new password`);
    result.kept = await kept_write(deps, vm, context);
  };
}
