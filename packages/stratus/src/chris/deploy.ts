/**
 * @file `chris deploy` as a job (docs/stratus.adoc, D16): ChRIS goes on a
 * built VM after the build, over the bastion path, never through cloud-init
 * (user data is readable by anyone who can read the compartment's
 * instances). The job reaches the VM, waits for its cloud-init, writes the
 * compose file and its environment to the data volume, starts it, waits for
 * CUBE, registers the compute resource the plugin uploads name, and checks
 * that `chris` sees the admin API. With a host, it then waits for public
 * DNS to show the VM's address and for the certificate; with a porter, for
 * porter's name and its certificate too. With berths, it pulls the berth
 * image porter's release pins and waits for the launcher's socket.
 *
 * Every line CUBE is asked goes from the VM itself to 127.0.0.1:8000, the
 * admin password in curl's configuration on stdin, never on a command line.
 *
 * @module
 */
import type { JobContext, JobRun } from '@fnndsc/brasa/core';
import type { BuildCall, CloudBuilder } from '../cloud/builder.js';
import { CHRIS_PORTER_TAG, CHRIS_URL_TAG } from '../vm/state.js';
import type { NetStore } from '../net/state.js';
import { pause, vmRemote_open, type RemoteAnswer, type VmRemote } from '../vm/remote.js';
import { vmKept_write } from '../vm/keep.js';
import { vm_read } from '../vm/build.js';
import type { VmRecord, VmStore } from '../vm/state.js';
import { apiUrl_derive, BERTH_DIR, caddyfile_render, CHRIS_DIR, compose_render, cubeEnv_render, LAUNCHER_CONTAINER, launcherEnv_render, PFCON_HOST, PFCON_USER, pfconEnv_render, PORTER_UID, porterEnv_render, type ChrisSecrets, type ChrisTarget } from './compose.js';
import { CHRIS_IMAGES, PORTER_VERSION, type ChrisProfile } from './profiles.js';
import { adminHomeProgram_render, CUBE_PYTHON_LINE, HOME_MARK } from './users.js';

/** What a deploy is asked for. */
export interface DeployRequest {
  readonly vm: string;
  readonly profile: ChrisProfile;
  /** The compute resource's name, as plugin uploads name it. */
  readonly compute: string;
  readonly host: string | null;
  /** The name porter answers to, or null for no porter; needs a host. */
  readonly porter: string | null;
  /** Whether porter starts each person's session in a berth of its own; needs a porter. */
  readonly berths: boolean;
  readonly secrets: ChrisSecrets;
}

/** Where porter's release keeps the berth image it pins, in porter's image. */
const BERTH_PIN_MODULE: string = '/usr/local/lib/node_modules/@fnndsc/porter/dist/launcher/launcher.js';

/** A berth image named by digest, as porter pins it. */
const BERTH_IMAGE_PINNED: RegExp = /^[a-z0-9./-]+@sha256:[0-9a-f]{64}$/;

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
export async function run_must(remote: VmRemote, line: string, what: string, input?: string): Promise<RemoteAnswer> {
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
export async function cube_ask(remote: VmRemote, secrets: ChrisSecrets, pathPart: string, json?: unknown): Promise<{ status: number; body: string }> {
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
export async function until(test: () => Promise<boolean>, tries: number, everyMs: number, signal: AbortSignal): Promise<boolean> {
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
    const remote: VmRemote = await (deps.remote_open ?? ((name: string, inner: BuildCall): Promise<VmRemote> => vmRemote_open(name, { store: deps.store, nets: deps.nets, builder: deps.builder }, inner)))(request.vm, call);

    context.log_write('waiting for the VM\'s cloud-init (Docker, the data volume)');
    if (!await until(async (): Promise<boolean> => (await remote.run('test -f /var/lib/cloud/stratus-ready')).code === 0, 90, tick, context.signal)) throw new Error(`${request.vm}: cloud-init has not finished in fifteen minutes (/var/lib/cloud/stratus-ready)`);

    await run_must(remote, `sudo install -d -o ubuntu -g ubuntu -m 0750 ${CHRIS_DIR}`, `making ${CHRIS_DIR}`);
    const berths: boolean = request.berths && request.porter !== null;
    // The launcher alone is given the group that owns Docker's socket.
    const dockerGid: number | null = berths ? Number((await run_must(remote, 'stat -c %g /var/run/docker.sock', 'reading the group of Docker\'s socket')).stdout.trim()) : null;
    if (dockerGid !== null && !Number.isInteger(dockerGid)) throw new Error('reading the group of Docker\'s socket: not a number');
    const target: ChrisTarget = { host: request.host, address, porter: request.porter, berths: dockerGid !== null ? { dockerGid } : null };
    const files: Array<[string, string, string]> = [
      ['compose.yml', compose_render(request.profile, target), '0644'],
      ['cube.env', cubeEnv_render(target, request.secrets), '0600'],
      ['pfcon.env', pfconEnv_render(request.secrets), '0600'],
      ['Caddyfile', caddyfile_render(target), '0644'],
      ...(request.porter !== null ? [['porter.env', porterEnv_render(target, request.secrets), '0600'] as [string, string, string]] : []),
      ...(berths ? [['launcher.env', launcherEnv_render(request.profile, target), '0600'] as [string, string, string]] : []),
    ];
    for (const [file, text, mode] of files) await run_must(remote, `umask 077 && cat > ${CHRIS_DIR}/${file}.new && chmod ${mode} ${CHRIS_DIR}/${file}.new && mv ${CHRIS_DIR}/${file}.new ${CHRIS_DIR}/${file}`, `writing ${file}`, text);
    context.log_write(`wrote ${files.map(([file]): string => file).join(', ')} to ${CHRIS_DIR}`);
    if (berths) {
      // porter's and the launcher's own user (the image's node) reads the secret and makes the socket; nobody else.
      if (request.secrets.launcherSecret === undefined) throw new Error('berths need the launcher\'s secret');
      await run_must(remote, `sudo install -d -o ${PORTER_UID} -g ${PORTER_UID} -m 0700 ${BERTH_DIR} ${BERTH_DIR}/run`, `making ${BERTH_DIR}`);
      const berthFiles: Array<[string, string, string]> = [['launcher.secret', `${request.secrets.launcherSecret}\n`, '0600'], ['policy.json', '{}\n', '0644']];
      for (const [file, text, mode] of berthFiles) await run_must(remote, `sudo sh -c 'umask 077 && cat > ${BERTH_DIR}/${file}.new && chown ${PORTER_UID}:${PORTER_UID} ${BERTH_DIR}/${file}.new && chmod ${mode} ${BERTH_DIR}/${file}.new && mv ${BERTH_DIR}/${file}.new ${BERTH_DIR}/${file}'`, `writing ${file}`, text);
      context.log_write(`wrote launcher.secret and policy.json to ${BERTH_DIR} (the image's node user's)`);
    }

    context.log_write(request.porter !== null ? 'pulling the images, building porter\'s, and starting the services' : 'pulling the images and starting the services');
    await run_must(remote, `cd ${CHRIS_DIR} && docker compose pull -q --ignore-buildable${request.porter !== null ? ' && docker compose build -q' : ''}`, 'docker compose pull');
    let berthImage: string | null = null;
    if (berths) {
      // The berth image is the one porter's release pins, read from the porter just built, and pulled before any login waits on it.
      const pin: RemoteAnswer = await run_must(remote, `docker run --rm --entrypoint node stratus/porter:${PORTER_VERSION} --input-type=module -e "console.log((await import('${BERTH_PIN_MODULE}')).BERTH_IMAGE_DEFAULT)"`, 'reading the berth image porter pins');
      const image: string = pin.stdout.trim().split('\n').pop() ?? '';
      if (!BERTH_IMAGE_PINNED.test(image)) throw new Error(`reading the berth image porter pins: ${image || 'nothing'} is not an image by digest`);
      context.log_write(`pulling the berth image ${image}`);
      await run_must(remote, `docker pull -q ${image}`, 'pulling the berth image');
      berthImage = image;
    }
    await run_must(remote, `cd ${CHRIS_DIR} && docker compose up -d --build --remove-orphans`, 'docker compose up');
    if (berths) {
      context.log_write('waiting for the berth launcher\'s socket');
      const healthy: boolean = await until(async (): Promise<boolean> => (await remote.run(`docker inspect -f '{{.State.Health.Status}}' ${LAUNCHER_CONTAINER}`)).stdout.trim() === 'healthy', 30, tick, context.signal);
      if (!healthy) {
        const logs: RemoteAnswer = await remote.run(`docker logs --tail 5 ${LAUNCHER_CONTAINER} 2>&1`);
        throw new Error(`the berth launcher did not answer on its socket in five minutes: ${logs.stdout.trim().split('\n').join(' / ')}`);
      }
      context.log_write('the berth launcher answers on its socket: porter starts a berth for each person');
    }

    context.log_write('waiting for CUBE (migrations first)');
    const up: boolean = await until(async (): Promise<boolean> => {
      const answer: RemoteAnswer = await remote.run('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/api/v1/');
      return answer.stdout.trim() === '200' || answer.stdout.trim() === '401';
    }, 60, tick, context.signal);
    if (!up) {
      const ps: RemoteAnswer = await remote.run(`cd ${CHRIS_DIR} && docker compose ps -a --format '{{.Service}} {{.State}} {{.Status}}'`);
      throw new Error(`CUBE did not answer on 127.0.0.1:8000 in ten minutes; services: ${ps.stdout.trim().split('\n').join('; ')}`);
    }

    // The admin's home, which CUBE's own superuser leaves out, so a session signed in as chris has its feeds.
    const home: RemoteAnswer = await remote.run(CUBE_PYTHON_LINE, adminHomeProgram_render());
    const homeLine: string | undefined = home.stdout.split('\n').find((line: string): boolean => line.startsWith(`${HOME_MARK} `));
    if (home.code !== 0 || homeLine === undefined) throw new Error(`giving chris its home in CUBE: exit ${home.code}: ${(home.stderr || home.stdout).trim().split('\n').slice(-3).join(' / ')}`);
    const homeMade: string = homeLine.slice(HOME_MARK.length + 1);
    context.log_write(homeMade === 'there' ? 'chris has its home (/home/chris/feeds, uploads)' : `made chris's home: ${homeMade}`);

    const found = await cube_ask(remote, request.secrets, `api/v1/computeresources/search/?name=${encodeURIComponent(request.compute)}`);
    if (found.status !== 200) throw new Error(`asking CUBE for the compute resource ${request.compute}: HTTP ${found.status} (is the admin password the one CUBE was made with?)`);
    if (found.body.includes(`"name":"${request.compute}"`) || found.body.includes(`"name": "${request.compute}"`)) {
      context.log_write(`the compute resource ${request.compute} is registered`);
    } else {
      const made = await cube_ask(remote, request.secrets, 'chris-admin/api/v1/computeresources/', {
        name: request.compute,
        compute_url: `http://${PFCON_HOST}:5005/api/v1/`,
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
    // What runs here, said on the machine itself, so a session reading the tenancy (one that keeps no record of this
    // VM) knows it is CUBE at this address; a tag that cannot be written is said, never the deploy's failure.
    const instanceId: string | undefined = deps.store.record_read(request.vm)?.machineOutputs?.['instance_id'];
    if (instanceId !== undefined && deps.builder.instance_tag !== undefined) {
      try {
        await deps.builder.instance_tag({ region: deps.store.record_read(request.vm)?.region ?? '', instanceId, tags: { [CHRIS_URL_TAG]: url, ...(request.porter !== null ? { [CHRIS_PORTER_TAG]: request.porter } : {}) } }, { log: (line: string): void => context.log_write(line), signal: context.signal });
      } catch (error: unknown) {
        context.log_write(`the instance was not tagged with what runs on it (${error instanceof Error ? error.message : String(error)}): a session reading the tenancy will not know it is ChRIS`);
      }
    }
    deps.store.record_update(request.vm, (current: VmRecord): void => {
      current.chris = { profile: request.profile.name, compute: request.compute, host: request.host, url, deployed: new Date().toISOString(), image: CHRIS_IMAGES.cube, ...(request.host !== null ? { dns: 'waiting' } : {}), ...(request.porter !== null ? { porter: request.porter, porterVersion: PORTER_VERSION } : {}), ...(berthImage !== null ? { berths: 'launcher' as const, berthImage } : {}) };
    });
    await kept_write(deps, request.vm, context);
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
    context.log_write(`${url} answers over HTTPS`);
    if (request.porter !== null) {
      const porter: string = request.porter;
      const door: string = `https://${porter}/login`;
      context.log_write(`waiting for public DNS to give ${porter} the address ${address}, then for porter's certificate`);
      if (!await until(async (): Promise<boolean> => (await deps.resolve(porter)).includes(address), 60, tick * 6, context.signal)) throw new Error(`waiting on DNS: ${porter} does not resolve to ${address} yet (chris deploy again resumes here)`);
      if (!await until(async (): Promise<boolean> => await deps.status_get(door) === 200, 30, tick, context.signal)) throw new Error(`${door} does not answer over HTTPS yet: Caddy may still be asking for the certificate, or porter still starting (chris deploy again resumes here)`);
      context.log_write(`${door} answers over HTTPS: porter's door`);
    }
    deps.store.record_update(request.vm, (current: VmRecord): void => { if (current.chris !== undefined) current.chris.dns = 'seen'; });
    await kept_write(deps, request.vm, context);
  };
}

/**
 * Keeps the deploy's record and passwords in the tenancy beside the VM's SSH
 * key, so any session on any host manages this ChRIS; one the tenancy could
 * not keep is said loudly, and the host's copy holds them till a replay keeps them.
 *
 * @param deps - The deploy's deps.
 * @param vm - The VM.
 * @param context - The job's log and stop.
 * @returns Whether the tenancy keeps them now.
 */
export async function kept_write(deps: DeployDeps, vm: string, context: JobContext): Promise<boolean> {
  if (deps.builder.keep_write === undefined) return false;
  try {
    const kept: string | null = await vmKept_write(deps.builder, deps.store, vm, deps.store.record_read(vm)?.region ?? '', { log: (line: string): void => context.log_write(line), signal: context.signal });
    if (kept !== null) context.log_write(`${vm}: ${kept} kept in the tenancy`);
    return kept !== null;
  } catch (error: unknown) {
    context.log_write(`${vm}: NOT kept in the tenancy (${error instanceof Error ? error.message : String(error)}): only this host holds ChRIS's passwords until vm keep ${vm} (or chris deploy ${vm}) runs again`);
    return false;
  }
}
