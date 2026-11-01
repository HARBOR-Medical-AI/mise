/**
 * @file `chris deploy` as a job (docs/stratus.adoc, D16): ChRIS goes on a
 * built VM after the build, over the bastion path, never through cloud-init
 * (user data is readable by anyone who can read the compartment's
 * instances). The job reaches the VM, waits for its cloud-init, writes the
 * compose file and its environment to the data volume, starts it, waits for
 * CUBE, registers the compute resource the plugin uploads name, and checks
 * that `chris` sees the admin API. With a host, it then waits for public
 * DNS to show the VM's address and for the certificate.
 *
 * Every line CUBE is asked goes from the VM itself to 127.0.0.1:8000, the
 * admin password in curl's configuration on stdin, never on a command line.
 *
 * @module
 */
import type { JobContext, JobRun } from '@fnndsc/brasa/core';
import type { BuildCall, CloudBuilder } from '../cloud/builder.js';
import type { NetStore } from '../net/state.js';
import { pause, vmRemote_open, type RemoteAnswer, type VmRemote } from '../vm/remote.js';
import { vm_read } from '../vm/build.js';
import type { VmRecord, VmStore } from '../vm/state.js';
import { apiUrl_derive, caddyfile_render, CHRIS_DIR, compose_render, cubeEnv_render, PFCON_USER, pfconEnv_render, type ChrisSecrets, type ChrisTarget } from './compose.js';
import type { ChrisProfile } from './profiles.js';

/** What a deploy is asked for. */
export interface DeployRequest {
  readonly vm: string;
  readonly profile: ChrisProfile;
  /** The compute resource's name, as plugin uploads name it. */
  readonly compute: string;
  readonly host: string | null;
  readonly secrets: ChrisSecrets;
}

/** What a deploy runs over. */
export interface DeployDeps {
  readonly store: VmStore;
  readonly nets: NetStore;
  readonly builder: CloudBuilder;
  /** Reaches the VM; {@link vmRemote_open} when absent. */
  readonly remote_open?: (name: string, call: BuildCall) => Promise<VmRemote>;
  /** The addresses public resolvers give a name. */
  readonly resolve: (host: string) => Promise<string[]>;
  /** Asks a URL from this host; the status, or null when it does not answer. */
  readonly status_get: (url: string) => Promise<number | null>;
  /** Between tries, in milliseconds; scaled down by tests. */
  readonly tickMs?: number;
}

/** The deploy's job id. */
export const CHRIS_JOBS = { deploy: (name: string): string => `chris-${name}-deploy` } as const;

/**
 * A string as curl's configuration file quotes it.
 *
 * @param text - The text.
 * @returns It, quoted.
 */
export function curlQuote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Runs a line, refusing a failure.
 *
 * @param remote - The VM.
 * @param line - The line.
 * @param what - What it does, for the refusal.
 * @param input - Its input.
 * @returns Its answer.
 * @throws Error - When it exits non-zero.
 */
async function run_must(remote: VmRemote, line: string, what: string, input?: string): Promise<RemoteAnswer> {
  const answer: RemoteAnswer = await remote.run(line, input);
  if (answer.code !== 0) throw new Error(`${what}: exit ${answer.code}: ${(answer.stderr || answer.stdout).trim().split('\n').slice(-3).join(' / ')}`);
  return answer;
}

/**
 * Asks CUBE on the VM as `chris`, the password on stdin.
 *
 * @param remote - The VM.
 * @param secrets - The admin password.
 * @param pathPart - The path under `http://127.0.0.1:8000/`.
 * @param json - A body to POST, when one is sent.
 * @returns The status and the body.
 */
async function cube_ask(remote: VmRemote, secrets: ChrisSecrets, pathPart: string, json?: unknown): Promise<{ status: number; body: string }> {
  const config: string[] = [`user = ${curlQuote(`chris:${secrets.adminPassword}`)}`, 'header = "Accept: application/json"'];
  if (json !== undefined) config.push(`json = ${curlQuote(JSON.stringify(json))}`);
  const answer: RemoteAnswer = await remote.run(`curl -s -K - -w '\\n%{http_code}' http://127.0.0.1:8000/${pathPart}`, `${config.join('\n')}\n`);
  const lines: string[] = answer.stdout.trimEnd().split('\n');
  const status: number = Number(lines.pop() ?? '0');
  return { status: Number.isFinite(status) ? status : 0, body: lines.join('\n') };
}

/**
 * Waits until a test passes or the time is up.
 *
 * @param test - The test.
 * @param tries - How many tries.
 * @param everyMs - Between tries.
 * @param signal - Stops the wait.
 * @returns Whether it passed.
 */
async function until(test: () => Promise<boolean>, tries: number, everyMs: number, signal: AbortSignal): Promise<boolean> {
  for (let i: number = 0; i < tries && !signal.aborted; i++) {
    if (await test()) return true;
    await pause(everyMs, signal);
  }
  return false;
}

/**
 * The deploy's job.
 *
 * @param request - The VM, the profile, the compute, the host, the secrets.
 * @param deps - What it runs over.
 * @returns The job's work.
 */
export function chrisDeployRun_make(request: DeployRequest, deps: DeployDeps): JobRun {
  return async (context: JobContext): Promise<void> => {
    const call: BuildCall = { log: (line: string): void => context.log_write(line), signal: context.signal };
    const tick: number = deps.tickMs ?? 10_000;
    const { record } = vm_read(deps.store, request.vm);
    const address: string | undefined = record.dataOutputs?.['public_ip'];
    if (address === undefined) throw new Error(`${request.vm}: it has no public address`);
    const target: ChrisTarget = { host: request.host, address };
    const remote: VmRemote = await (deps.remote_open ?? ((name: string, inner: BuildCall): Promise<VmRemote> => vmRemote_open(name, { store: deps.store, nets: deps.nets, builder: deps.builder }, inner)))(request.vm, call);

    context.log_write('waiting for the VM\'s cloud-init (Docker, the data volume)');
    if (!await until(async (): Promise<boolean> => (await remote.run('test -f /var/lib/cloud/stratus-ready')).code === 0, 90, tick, context.signal)) throw new Error(`${request.vm}: cloud-init has not finished in fifteen minutes (/var/lib/cloud/stratus-ready)`);

    await run_must(remote, `sudo install -d -o ubuntu -g ubuntu -m 0750 ${CHRIS_DIR}`, `making ${CHRIS_DIR}`);
    const files: Array<[string, string, string]> = [
      ['compose.yml', compose_render(request.profile), '0644'],
      ['cube.env', cubeEnv_render(target, request.secrets), '0600'],
      ['pfcon.env', pfconEnv_render(request.secrets), '0600'],
      ['Caddyfile', caddyfile_render(target), '0644'],
    ];
    for (const [file, text, mode] of files) await run_must(remote, `umask 077 && cat > ${CHRIS_DIR}/${file}.new && chmod ${mode} ${CHRIS_DIR}/${file}.new && mv ${CHRIS_DIR}/${file}.new ${CHRIS_DIR}/${file}`, `writing ${file}`, text);
    context.log_write(`wrote ${files.map(([file]): string => file).join(', ')} to ${CHRIS_DIR}`);

    context.log_write('pulling the images and starting the services');
    await run_must(remote, `cd ${CHRIS_DIR} && docker compose pull -q && docker compose up -d --remove-orphans`, 'docker compose up');

    context.log_write('waiting for CUBE (migrations first)');
    const up: boolean = await until(async (): Promise<boolean> => {
      const answer: RemoteAnswer = await remote.run('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/api/v1/');
      return answer.stdout.trim() === '200' || answer.stdout.trim() === '401';
    }, 60, tick, context.signal);
    if (!up) {
      const ps: RemoteAnswer = await remote.run(`cd ${CHRIS_DIR} && docker compose ps -a --format '{{.Service}} {{.State}} {{.Status}}'`);
      throw new Error(`CUBE did not answer on 127.0.0.1:8000 in ten minutes; services: ${ps.stdout.trim().split('\n').join('; ')}`);
    }

    const found = await cube_ask(remote, request.secrets, `api/v1/computeresources/search/?name=${encodeURIComponent(request.compute)}`);
    if (found.status !== 200) throw new Error(`asking CUBE for the compute resource ${request.compute}: HTTP ${found.status} (is the admin password the one CUBE was made with?)`);
    if (found.body.includes(`"name":"${request.compute}"`) || found.body.includes(`"name": "${request.compute}"`)) {
      context.log_write(`the compute resource ${request.compute} is registered`);
    } else {
      const made = await cube_ask(remote, request.secrets, 'chris-admin/api/v1/computeresources/', {
        name: request.compute,
        compute_url: 'http://pfcon:5005/api/v1/',
        compute_user: PFCON_USER,
        compute_password: request.secrets.pfconPassword,
        compute_innetwork: true,
        description: `pfcon on ${request.vm}, in-network, beside CUBE (stratus chris deploy)`,
      });
      if (made.status !== 201) throw new Error(`registering the compute resource ${request.compute}: HTTP ${made.status}: ${made.body.slice(0, 200)}`);
      context.log_write(`registered the compute resource ${request.compute} (pfcon, in-network)`);
    }
    const root = await cube_ask(remote, request.secrets, 'api/v1/');
    if (root.status !== 200 || !root.body.includes('/chris-admin/')) throw new Error(`chris does not see the admin API at /api/v1/ (HTTP ${root.status}): the upload jobs would be refused`);
    context.log_write('chris sees the admin API: plugin uploads can register');

    const url: string = apiUrl_derive(target);
    deps.store.record_update(request.vm, (current: VmRecord): void => {
      current.chris = { profile: request.profile.name, compute: request.compute, host: request.host, url, deployed: new Date().toISOString(), ...(request.host !== null ? { dns: 'waiting' } : {}) };
    });
    if (request.host === null) {
      const outside: number | null = await deps.status_get(url);
      context.log_write(`from here: ${url} answers ${outside ?? 'nothing'}`);
      return;
    }

    context.log_write(`waiting for public DNS to give ${request.host} the address ${address} (each minute, for an hour)`);
    const seen: boolean = await until(async (): Promise<boolean> => (await deps.resolve(request.host as string)).includes(address), 60, tick * 6, context.signal);
    if (!seen) throw new Error(`waiting on DNS: ${request.host} does not resolve to ${address} yet (chris deploy again resumes here)`);
    context.log_write(`${request.host} resolves to ${address}; waiting for Caddy's certificate`);
    const secure: boolean = await until(async (): Promise<boolean> => { const status: number | null = await deps.status_get(url); return status === 200 || status === 401; }, 30, tick, context.signal);
    if (!secure) throw new Error(`${url} does not answer over HTTPS yet: Caddy may still be asking for the certificate (chris deploy again resumes here)`);
    deps.store.record_update(request.vm, (current: VmRecord): void => { if (current.chris !== undefined) current.chris.dns = 'seen'; });
    context.log_write(`${url} answers over HTTPS`);
  };
}
