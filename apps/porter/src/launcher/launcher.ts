/**
 * @file The berth launcher (docs/dev-bastion.adoc, stand-in, Q1–Q3, Q5):
 * starts, stops and reports one ChRIS user's berth, and fixes everything
 * about it but who it is for. The image is the pinned digest; the home is
 * the user's named volume; `/incoming` is read-only and `/outgoing` the
 * user's own; the CUBE token is written to a tmpfs at `/run/mise/token`,
 * mode 0400 and owned by the user's uid, on stdin, never a command line or
 * the environment; the limits are the spoke's policy and the spoke refuses
 * when full; no Docker socket, no privilege, every capability dropped, no
 * new privileges, a read-only root; one network, shared only with porter.
 *
 * @module
 */
import { berthKey_compute, identity_normalise } from '@fnndsc/calypso/berth';
import type { DockerAnswer, DockerApi } from './docker.js';
import { berthCapacity_derive, capacityRefusal_words, profileFloor_get, type BerthPolicy, type HostSize } from './policy.js';

/** The image a berth runs when the deployment names none: mise-berth, pinned by digest. */
export const BERTH_IMAGE_DEFAULT: string = 'ghcr.io/harbor-medical-ai/mise-berth@sha256:5ffe45e8a55e7ab2990a6886eaefac544fb48f67844c54b4c6461a6732495360';

/** The label every berth, its network and its volumes carry: the launcher's prefix. */
export const BERTH_LABEL: string = 'org.fnndsc.mise.berth';

/** Where the token lives inside a berth, on its tmpfs. */
export const BERTH_TOKEN_DIR: string = '/run/mise';

/** A CUBE user name, as CUBE takes one. */
const USER_NAME: RegExp = /^[A-Za-z0-9_.@+-]{1,32}$/;

/** What porter asks a berth for. */
export interface BerthAsk {
  readonly user: string;
  /** CUBE's id for the user: the berth's uid. */
  readonly uid: number;
  /** The user-private group: CUBE's id again. */
  readonly gid: number;
  readonly cubeUrl: string;
  /** The user's CUBE token; null asks for the one the launcher holds from the last start. */
  readonly token: string | null;
}

/** A berth as the launcher reports it. */
export interface BerthState {
  readonly identity: string;
  readonly user: string;
  readonly state: 'running' | 'stopped';
  /** Where its calypso answers, on the berth network, when running. */
  readonly url: string | null;
  /** Its calypso's attach token, when running. */
  readonly token: string | null;
  readonly container: string;
}

/** A refusal the launcher gives, with the HTTP status it answers. */
export class BerthRefusal extends Error {
  public readonly status: number;

  /**
   * @param status - 400 for a bad ask, 409 for a full spoke, 502 for a berth that did not come up.
   * @param message - Why.
   */
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** How a launcher is set up. */
export interface LauncherOptions {
  readonly docker: DockerApi;
  readonly policy: BerthPolicy;
  /** The image, pinned by digest. */
  readonly image: string;
  /** What every name and label begins with (`mise-berth`): one spoke's berths. */
  readonly prefix: string;
  /** The berth network's name; made when missing. */
  readonly network: string;
  /** The ChRIS profile the spoke runs, for its floor. */
  readonly profile?: string;
  /** How long a berth has to answer, in ms. */
  readonly bootMs?: number;
  /** How often its berth file is looked for, in ms. */
  readonly pollMs?: number;
}

/**
 * The names a berth's container and volumes take: the prefix and the identity's berth key.
 *
 * @param prefix - The launcher's prefix.
 * @param identity - The normalised identity.
 * @returns The names.
 */
export function berthNames_derive(prefix: string, identity: string): { container: string; home: string; incoming: string; outgoing: string } {
  const key: string = berthKey_compute(identity);
  return { container: `${prefix}-${key}`, home: `${prefix}-${key}-home`, incoming: `${prefix}-${key}-incoming`, outgoing: `${prefix}-${key}-outgoing` };
}

/**
 * The container a berth is: everything fixed here but who it is for.
 *
 * @param options - The launcher's image, prefix, network and policy.
 * @param ask - Who it is for.
 * @param identity - The normalised identity.
 * @returns The engine's create body.
 */
export function berthContainer_spec(options: Pick<LauncherOptions, 'image' | 'prefix' | 'network' | 'policy'>, ask: BerthAsk, identity: string): Record<string, unknown> {
  const names = berthNames_derive(options.prefix, identity);
  const limits = options.policy.limits;
  return {
    Image: options.image,
    User: `${ask.uid}:${ask.gid}`,
    Hostname: `berth-${ask.user.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 50)}`,
    Env: [
      `MISE_USER=${ask.user}`,
      `MISE_CUBE_URL=${ask.cubeUrl}`,
      'MISE_HOST_CONTROL=shell',
      // Porter reaches the session over the berth network, never loopback.
      'CALYPSO_BIND=0.0.0.0',
    ],
    Labels: { [BERTH_LABEL]: options.prefix, [`${BERTH_LABEL}.identity`]: identity, [`${BERTH_LABEL}.user`]: ask.user },
    HostConfig: {
      // nocopy: an empty volume is not filled from the image's mount point, whose root ownership would undo the user's.
      Binds: [`${names.home}:/home/${ask.user}:nocopy`, `${names.incoming}:/incoming:ro,nocopy`, `${names.outgoing}:/outgoing:nocopy`],
      Tmpfs: {
        [BERTH_TOKEN_DIR]: `rw,nosuid,nodev,noexec,size=1m,mode=0700,uid=${ask.uid},gid=${ask.gid}`,
        '/tmp': 'rw,nosuid,nodev,size=1g,mode=1777',
      },
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      NanoCpus: Math.round(limits.cpus * 1e9),
      Memory: Math.round(limits.memoryGib * 1024 ** 3),
      PidsLimit: limits.pids,
      NetworkMode: options.network,
      RestartPolicy: { Name: 'no' },
    },
  };
}

/**
 * A field of a JSON object the engine answered, or undefined.
 *
 * @param body - The body.
 * @param path - The keys, outermost first.
 * @returns The value.
 */
function field_get(body: unknown, ...path: string[]): unknown {
  let at: unknown = body;
  for (const key of path) at = typeof at === 'object' && at !== null ? (at as Record<string, unknown>)[key] : undefined;
  return at;
}

/** The berth launcher: the only holder of the engine. */
export class BerthLauncher {
  private readonly options: LauncherOptions;
  /** The CUBE token and id each running berth was started with, for a restart; memory only. */
  private readonly held: Map<string, { token: string; uid: number; gid: number }> = new Map();
  /** Starts in flight, so two asks for one identity share one start. */
  private readonly starting: Map<string, Promise<BerthState>> = new Map();

  /**
   * @param options - How it is set up.
   */
  constructor(options: LauncherOptions) {
    this.options = options;
  }

  /**
   * How many berths this spoke holds, from the host the engine reports.
   *
   * @returns The capacity.
   */
  public async capacity_get(): Promise<number> {
    const info: DockerAnswer = await this.options.docker.call('GET', '/info');
    const cpus: unknown = field_get(info.body, 'NCPU');
    const memory: unknown = field_get(info.body, 'MemTotal');
    const host: HostSize = { cpus: typeof cpus === 'number' ? cpus : 0, memoryGib: typeof memory === 'number' ? memory / 1024 ** 3 : 0 };
    return berthCapacity_derive(host, profileFloor_get(this.options.profile), this.options.policy);
  }

  /**
   * Starts a user's berth, or rewrites the token of the one running.
   *
   * @param ask - Who it is for, and their token.
   * @returns The berth, running.
   * @throws {BerthRefusal} When the ask is not one, the spoke is full, or the berth does not come up.
   */
  public start(given: BerthAsk): Promise<BerthState> {
    if (!USER_NAME.test(given.user)) return Promise.reject(new BerthRefusal(400, `${given.user}: not a CUBE user name`));
    try { new URL(given.cubeUrl); } catch { return Promise.reject(new BerthRefusal(400, `${given.cubeUrl}: not a URL`)); }
    // No token: a restart on the one the launcher holds from the last start, with its ids.
    const kept = given.token === null ? this.held.get(identity_normalise(given.user, given.cubeUrl)) : undefined;
    if (given.token === null && kept === undefined) return Promise.reject(new BerthRefusal(409, `${given.user}: no token to start a berth on; log in again`));
    const ask: BerthAsk = kept === undefined ? given : { ...given, token: kept.token, uid: kept.uid, gid: kept.gid };
    if (!Number.isInteger(ask.uid) || !Number.isInteger(ask.gid) || ask.uid <= 0 || ask.gid <= 0) return Promise.reject(new BerthRefusal(400, 'a berth runs as the user\'s CUBE id, never root'));
    const identity: string = identity_normalise(ask.user, ask.cubeUrl);
    const running: Promise<BerthState> | undefined = this.starting.get(identity);
    if (running !== undefined) return running;
    const started: Promise<BerthState> = this.start_run(ask, identity).finally((): void => { this.starting.delete(identity); });
    this.starting.set(identity, started);
    return started;
  }

  /**
   * Stops a user's berth and removes its container; its volumes stay.
   *
   * @param user - The CUBE user.
   * @param cubeUrl - The CUBE.
   * @returns Whether there was one.
   */
  public async stop(user: string, cubeUrl: string): Promise<boolean> {
    const identity: string = identity_normalise(user, cubeUrl);
    const name: string = berthNames_derive(this.options.prefix, identity).container;
    this.held.delete(identity);
    const found: DockerAnswer = await this.options.docker.call('GET', `/containers/${name}/json`);
    if (found.status === 404) return false;
    await this.options.docker.call('POST', `/containers/${name}/stop?t=10`);
    await this.options.docker.call('DELETE', `/containers/${name}?force=true`);
    return true;
  }

  /**
   * A user's berth as it stands, or every berth of this spoke.
   *
   * @param who - The user and CUBE, or null for all.
   * @returns The berths.
   */
  public async status(who: { user: string; cubeUrl: string } | null): Promise<BerthState[]> {
    const listed: DockerAnswer = await this.options.docker.call('GET', `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: [`${BERTH_LABEL}=${this.options.prefix}`] }))}`);
    const rows: unknown[] = Array.isArray(listed.body) ? listed.body : [];
    const want: string | null = who === null ? null : identity_normalise(who.user, who.cubeUrl);
    const states: BerthState[] = [];
    for (const row of rows) {
      const identity: unknown = field_get(row, 'Labels', `${BERTH_LABEL}.identity`);
      const user: unknown = field_get(row, 'Labels', `${BERTH_LABEL}.user`);
      if (typeof identity !== 'string' || typeof user !== 'string' || (want !== null && identity !== want)) continue;
      const name: string = berthNames_derive(this.options.prefix, identity).container;
      const up: boolean = field_get(row, 'State') === 'running';
      const berth = up ? await this.berth_read(name, identity).catch((): null => null) : null;
      states.push({ identity, user, state: up && berth !== null ? 'running' : 'stopped', url: berth?.url ?? null, token: berth?.token ?? null, container: name });
    }
    return states;
  }

  /**
   * The start itself: a running berth gets the new token; otherwise the
   * spoke's room is checked, the network and volumes made, the container
   * made and started, the token written, and the berth waited for.
   *
   * @param ask - The ask.
   * @param identity - Its identity.
   * @returns The berth.
   */
  private async start_run(ask: BerthAsk, identity: string): Promise<BerthState> {
    const docker: DockerApi = this.options.docker;
    const names = berthNames_derive(this.options.prefix, identity);
    const token: string | null = ask.token;
    if (token === null) throw new BerthRefusal(409, `${ask.user}: no token to start a berth on; log in again`);
    const found: DockerAnswer = await docker.call('GET', `/containers/${names.container}/json`);
    if (found.status === 200 && field_get(found.body, 'State', 'Running') === true) {
      await this.token_write(names.container, ask, token);
      this.held.set(identity, { token, uid: ask.uid, gid: ask.gid });
      const berth = await this.berth_read(names.container, identity);
      return { identity, user: ask.user, state: 'running', url: berth.url, token: berth.token, container: names.container };
    }
    if (found.status === 200) await docker.call('DELETE', `/containers/${names.container}?force=true`);
    // The spoke's room, before anything is made.
    const others: BerthState[] = (await this.status(null)).filter((one: BerthState): boolean => one.state === 'running' && one.identity !== identity);
    const capacity: number = await this.capacity_get();
    if (others.length >= capacity) throw new BerthRefusal(409, capacityRefusal_words(capacity, others.map((one: BerthState): string => one.user)));
    await this.network_ensure();
    await this.volumes_ensure(names, ask);
    const made: DockerAnswer = await docker.call('POST', `/containers/create?name=${names.container}`, berthContainer_spec(this.options, ask, identity));
    if (made.status !== 201) throw new BerthRefusal(502, `${ask.user}'s berth was not made: ${JSON.stringify(made.body)}`);
    const started: DockerAnswer = await docker.call('POST', `/containers/${names.container}/start`);
    if (started.status !== 204 && started.status !== 304) throw new BerthRefusal(502, `${ask.user}'s berth did not start: ${JSON.stringify(started.body)}`);
    await this.token_write(names.container, ask, token);
    this.held.set(identity, { token, uid: ask.uid, gid: ask.gid });
    const berth = await this.berth_wait(names.container, identity);
    return { identity, user: ask.user, state: 'running', url: berth.url, token: berth.token, container: names.container };
  }

  /** The berth network, made when missing: a bridge whose containers cannot reach one another. */
  private async network_ensure(): Promise<void> {
    const docker: DockerApi = this.options.docker;
    const found: DockerAnswer = await docker.call('GET', `/networks/${this.options.network}`);
    if (found.status === 200) return;
    const made: DockerAnswer = await docker.call('POST', '/networks/create', {
      Name: this.options.network, Driver: 'bridge', Internal: false,
      Options: { 'com.docker.network.bridge.enable_icc': 'false' },
      Labels: { [BERTH_LABEL]: this.options.prefix },
    });
    if (made.status !== 201) throw new BerthRefusal(502, `the berth network ${this.options.network} was not made: ${JSON.stringify(made.body)}`);
  }

  /**
   * The user's volumes, made when missing, the home and `/outgoing` given to
   * the user's uid by a one-shot container that can change ownership and
   * nothing else.
   *
   * @param names - The volumes' names.
   * @param ask - Whose.
   */
  private async volumes_ensure(names: ReturnType<typeof berthNames_derive>, ask: BerthAsk): Promise<void> {
    const docker: DockerApi = this.options.docker;
    for (const volume of [names.home, names.incoming, names.outgoing]) {
      const found: DockerAnswer = await docker.call('GET', `/volumes/${volume}`);
      if (found.status === 200) continue;
      await docker.call('POST', '/volumes/create', { Name: volume, Labels: { [BERTH_LABEL]: this.options.prefix, [`${BERTH_LABEL}.user`]: ask.user } });
    }
    const owner: string = `${names.container}-own`;
    await docker.call('DELETE', `/containers/${owner}?force=true`);
    const made: DockerAnswer = await docker.call('POST', `/containers/create?name=${owner}`, {
      Image: this.options.image,
      User: '0:0',
      Entrypoint: ['chown', `${ask.uid}:${ask.gid}`, '/v/home', '/v/outgoing'],
      Labels: { [BERTH_LABEL]: this.options.prefix },
      HostConfig: { Binds: [`${names.home}:/v/home`, `${names.outgoing}:/v/outgoing`], NetworkMode: 'none', CapDrop: ['ALL'], CapAdd: ['CHOWN'], SecurityOpt: ['no-new-privileges'], ReadonlyRootfs: true },
    });
    if (made.status !== 201) throw new BerthRefusal(502, `${ask.user}'s home was not given to them: ${JSON.stringify(made.body)}`);
    await docker.call('POST', `/containers/${owner}/start`);
    const waited: DockerAnswer = await docker.call('POST', `/containers/${owner}/wait`);
    await docker.call('DELETE', `/containers/${owner}?force=true`);
    if (field_get(waited.body, 'StatusCode') !== 0) throw new BerthRefusal(502, `${ask.user}'s home was not given to them (exit ${String(field_get(waited.body, 'StatusCode'))})`);
  }

  /**
   * Writes the token to the berth's tmpfs as the user, on stdin, mode 0400.
   *
   * @param container - The berth.
   * @param ask - Whose.
   * @param token - The CUBE token.
   */
  private async token_write(container: string, ask: BerthAsk, token: string): Promise<void> {
    const written = await this.options.docker.exec(container, ['sh', '-c', `umask 0377 && cat > ${BERTH_TOKEN_DIR}/.token.new && mv -f ${BERTH_TOKEN_DIR}/.token.new ${BERTH_TOKEN_DIR}/token`], `${ask.uid}:${ask.gid}`, `${token}\n`);
    if (written.code !== 0) throw new BerthRefusal(502, `${ask.user}'s token was not written to the berth: ${written.stderr.trim()}`);
  }

  /**
   * The berth file the session's calypso wrote, its address moved to the container's on the berth network.
   *
   * @param container - The berth.
   * @param identity - Whose.
   * @returns Its address and attach token.
   */
  private async berth_read(container: string, identity: string): Promise<{ url: string; token: string }> {
    const docker: DockerApi = this.options.docker;
    const inspected: DockerAnswer = await docker.call('GET', `/containers/${container}/json`);
    const user: unknown = field_get(inspected.body, 'Config', 'User');
    const read = await docker.exec(container, ['sh', '-c', `cat ${BERTH_TOKEN_DIR}/calypso/berth-${berthKey_compute(identity)}.json`], typeof user === 'string' ? user : '65534:65534', null);
    if (read.code !== 0) throw new Error('no berth file yet');
    const berth: unknown = JSON.parse(read.stdout);
    const url: unknown = field_get(berth, 'url');
    const token: unknown = field_get(berth, 'token');
    const address: unknown = field_get(inspected.body, 'NetworkSettings', 'Networks', this.options.network, 'IPAddress');
    if (typeof url !== 'string' || typeof token !== 'string' || typeof address !== 'string' || address === '') throw new Error('the berth file is not one');
    const at: URL = new URL(url);
    return { url: `${at.protocol}//${address}:${at.port}`, token };
  }

  /**
   * Waits for the session to write its berth file; a berth that exits first is refused with its last words.
   *
   * @param container - The berth.
   * @param identity - Whose.
   * @returns Its address and attach token.
   */
  private async berth_wait(container: string, identity: string): Promise<{ url: string; token: string }> {
    const deadline: number = Date.now() + (this.options.bootMs ?? 90_000);
    while (Date.now() < deadline) {
      const inspected: DockerAnswer = await this.options.docker.call('GET', `/containers/${container}/json`);
      if (field_get(inspected.body, 'State', 'Running') !== true) {
        const said: string = await this.logsTail_read(container);
        throw new BerthRefusal(502, `the berth stopped as it started: ${said}`);
      }
      try { return await this.berth_read(container, identity); } catch { /* not yet */ }
      await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, this.options.pollMs ?? 500); });
    }
    throw new BerthRefusal(502, `the berth did not answer within ${Math.round((this.options.bootMs ?? 90_000) / 1000)} s`);
  }

  /**
   * A stopped berth's last lines, for its refusal.
   *
   * @param container - The berth.
   * @returns The lines, joined.
   */
  private async logsTail_read(container: string): Promise<string> {
    const docker: DockerApi = this.options.docker;
    const answer: DockerAnswer = await docker.call('GET', `/containers/${container}/logs?stdout=true&stderr=true&tail=6`);
    // eslint-disable-next-line no-control-regex
    const text: string = typeof answer.body === 'string' ? answer.body.replace(/[\u0000-\u0008]/g, '') : '';
    return text.split('\n').map((line: string): string => line.trim()).filter((line: string): boolean => line !== '').slice(-3).join(' / ') || 'no words';
  }
}
