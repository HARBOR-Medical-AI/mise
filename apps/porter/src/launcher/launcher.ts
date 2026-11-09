/**
 * @file The berth launcher (docs/berths.adoc): starts, stops and reports one
 * person's berth, and fixes everything about it but who it is for and which
 * cohort it holds. The image is the pinned digest; the home is the person's
 * own volume, one for life; `/incoming` and `/outgoing` are one volume per
 * person and cohort; the CUBE token is written to a tmpfs at
 * `/run/mise/token`, mode 0400 and owned by the person's uid, on stdin,
 * never a command line or the environment; the limits are the spoke's
 * policy and the spoke refuses when full; no Docker socket, no privilege,
 * every capability dropped, no new privileges, a read-only root.
 *
 * The wires (berths.adoc, the topology): each berth hangs off porter on a
 * network of its own, `<prefix>-net-<user>`, whose members are that berth
 * and porter (joined when the berth starts, left when it stops, when porter
 * is a container; a porter on the host reaches the bridge as it is); every
 * berth also stands on `cube-net`, which blocks traffic between its
 * containers and carries only the CUBE API, published at its gateway or by
 * its public name. No berth has a path to another.
 *
 * @module
 */
import { berthKey_compute, identity_normalise } from '@fnndsc/calypso/berth';
import { berthCapacity_derive, profileFloor_get, type HostSize } from '@fnndsc/menu';
import type { DockerAnswer, DockerApi } from './docker.js';
import { capacityRefusal_words, type BerthPolicy } from './policy.js';

/**
 * The image a berth runs when the deployment names none: mise-berth, pinned
 * by digest. `images/mise-berth/pin.mjs` moves it to the digest the
 * workflow pushed, and `lint:berth-pin` refuses a build where the image's
 * source changed and the pin did not.
 */
export const BERTH_IMAGE_DEFAULT: string = 'ghcr.io/harbor-medical-ai/mise-berth@sha256:446b470b3fb8ab9ea237dc2e5ded76b0d33a476052d0eada8bb6e33951ddbe5d';

/** The SHA-256 of `images/mise-berth`'s source the pin above was built from (pin.mjs writes it; lint:berth-pin checks it). */
export const BERTH_IMAGE_SOURCE: string = '792832b25cbde139087b793eee103d8d0aa962b3106b9b8cefaf344876602394';

/** The label every berth, its networks and its volumes carry: the launcher's prefix. */
export const BERTH_LABEL: string = 'org.fnndsc.mise.berth';

/** Where the token lives inside a berth, on its tmpfs. */
export const BERTH_TOKEN_DIR: string = '/run/mise';

/** The cohort volume's name for a berth with no cohort. */
export const NO_COHORT: string = 'none';

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
  /** The cohort (a feed's id) `/incoming` and `/outgoing` are for; null or absent for none. */
  readonly cohort?: number | null;
}

/** A berth as the launcher reports it. */
export interface BerthState {
  readonly identity: string;
  readonly user: string;
  readonly state: 'running' | 'stopped';
  /** Where its calypso answers, on the berth's own wire, when running. */
  readonly url: string | null;
  /** Its calypso's attach token, when running. */
  readonly token: string | null;
  readonly container: string;
  /** The cohort it holds, or `none`. */
  readonly cohort: string;
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
  /** The network CUBE's API is reached on, shared by every berth; made when missing. */
  readonly cubeNetwork: string;
  /** Porter's container, when porter is one: joined to each berth's wire as it starts; null when porter runs on the host. */
  readonly porterContainer: string | null;
  /**
   * The name CUBE answers to (`cube.chrisproject.org`) when the spoke publishes its API on cube-net's gateway: inside
   * each berth that name resolves to the gateway, so the session's URL is the one porter's is; absent, by public DNS.
   */
  readonly cubeHost?: string;
  /** The ChRIS profile the spoke runs, for its floor. */
  readonly profile?: string;
  /** How long a berth has to answer, in ms. */
  readonly bootMs?: number;
  /** How often its berth file is looked for, in ms. */
  readonly pollMs?: number;
}

/** The names a berth's container, wire and volumes take. */
export interface BerthNames {
  readonly container: string;
  /** The berth's own wire: porter and this berth. */
  readonly network: string;
  /** The person's home, one for life. */
  readonly home: string;
  /** `/incoming` and `/outgoing` for this person and cohort. */
  readonly cohort: string;
}

/**
 * A cohort as a volume's name carries it: a feed's id, or `none`.
 *
 * @param cohort - The feed's id, or null.
 * @returns The word.
 */
export function cohort_word(cohort: number | null | undefined): string {
  return cohort === null || cohort === undefined ? NO_COHORT : String(cohort);
}

/**
 * The names a berth's container, wire and volumes take: the prefix, the
 * identity's berth key, and the cohort for the pair of mounts.
 *
 * @param prefix - The launcher's prefix.
 * @param identity - The normalised identity.
 * @param user - The CUBE user, for the wire's name.
 * @param cohort - The cohort, or null.
 * @returns The names.
 */
export function berthNames_derive(prefix: string, identity: string, user: string, cohort: number | null | undefined): BerthNames {
  const key: string = berthKey_compute(identity);
  const wire: string = user.replace(/[^A-Za-z0-9_.-]/g, '-');
  return { container: `${prefix}-${key}`, network: `${prefix}-net-${wire}`, home: `${prefix}-${key}-home`, cohort: `${prefix}-${key}-cohort-${cohort_word(cohort)}` };
}

/**
 * The container a berth is: everything fixed here but who it is for and
 * which cohort it holds.
 *
 * @param options - The launcher's image, prefix, networks and policy.
 * @param ask - Who it is for.
 * @param identity - The normalised identity.
 * @returns The engine's create body.
 */
export function berthContainer_spec(options: Pick<LauncherOptions, 'image' | 'prefix' | 'cubeNetwork' | 'policy'>, ask: BerthAsk, identity: string, hosts: ReadonlyArray<string> = []): Record<string, unknown> {
  const names: BerthNames = berthNames_derive(options.prefix, identity, ask.user, ask.cohort);
  const limits = options.policy.limits;
  const cohort: string = cohort_word(ask.cohort);
  // nocopy: an empty volume is not filled from the image's mount point, whose root ownership would undo the user's.
  const mount = (target: string, source: string, subpath: string | null, readOnly: boolean): Record<string, unknown> =>
    ({ Type: 'volume', Source: source, Target: target, ReadOnly: readOnly, VolumeOptions: { NoCopy: true, ...(subpath !== null ? { Subpath: subpath } : {}) } });
  return {
    Image: options.image,
    User: `${ask.uid}:${ask.gid}`,
    Hostname: `berth-${ask.user.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 50)}`,
    Env: [
      `MISE_USER=${ask.user}`,
      `MISE_CUBE_URL=${ask.cubeUrl}`,
      `MISE_COHORT=${cohort}`,
      'MISE_HOST_CONTROL=shell',
      // Porter reaches the session over the berth's wire, never loopback.
      'CALYPSO_BIND=0.0.0.0',
    ],
    Labels: { [BERTH_LABEL]: options.prefix, [`${BERTH_LABEL}.identity`]: identity, [`${BERTH_LABEL}.user`]: ask.user, [`${BERTH_LABEL}.cohort`]: cohort },
    HostConfig: {
      Mounts: [
        mount(`/home/${ask.user}`, names.home, null, false),
        mount('/incoming', names.cohort, 'incoming', true),
        mount('/outgoing', names.cohort, 'outgoing', false),
      ],
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
      // The berth's own wire is its first network; cube-net its second.
      NetworkMode: names.network,
      ...(hosts.length > 0 ? { ExtraHosts: [...hosts] } : {}),
      RestartPolicy: { Name: 'no' },
    },
    NetworkingConfig: { EndpointsConfig: { [names.network]: {}, [options.cubeNetwork]: {} } },
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

/** A filter on the launcher's label, for the engine's list calls. */
function labelFilter_build(prefix: string, more: Record<string, string[]> = {}): string {
  return encodeURIComponent(JSON.stringify({ label: [`${BERTH_LABEL}=${prefix}`], ...more }));
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
   * Memory is rounded up to whole GiB: the engine reports what the kernel
   * leaves after its own reserve (about 7.7 GiB on an 8 GiB machine), and
   * the machine is sized, and counted by every surface, at its nominal GiB.
   * CPUs are taken as reported.
   *
   * @returns The capacity.
   */
  public async capacity_get(): Promise<number> {
    const info: DockerAnswer = await this.options.docker.call('GET', '/info');
    const cpus: unknown = field_get(info.body, 'NCPU');
    const memory: unknown = field_get(info.body, 'MemTotal');
    const host: HostSize = { cpus: typeof cpus === 'number' ? cpus : 0, memoryGib: typeof memory === 'number' ? Math.ceil(memory / 1024 ** 3) : 0 };
    return berthCapacity_derive(host, profileFloor_get(this.options.profile), this.options.policy);
  }

  /**
   * What a launcher starting finds left behind: helper containers of an
   * earlier run, and wires with no berth on them, removed; cube-net made
   * when missing.
   *
   * @returns What was removed, by name.
   */
  public async orphans_clear(): Promise<string[]> {
    const docker: DockerApi = this.options.docker;
    const removed: string[] = [];
    await this.cubeNetwork_ensure();
    const helpers: DockerAnswer = await docker.call('GET', `/containers/json?all=true&filters=${labelFilter_build(this.options.prefix, { name: [`${this.options.prefix}-`] })}`);
    for (const row of Array.isArray(helpers.body) ? helpers.body : []) {
      const names: unknown = field_get(row, 'Names');
      const name: string = Array.isArray(names) && typeof names[0] === 'string' ? names[0].replace(/^\//, '') : '';
      if (!name.endsWith('-own')) continue;
      await docker.call('DELETE', `/containers/${name}?force=true`);
      removed.push(name);
    }
    const wires: DockerAnswer = await docker.call('GET', `/networks?filters=${labelFilter_build(this.options.prefix)}`);
    for (const row of Array.isArray(wires.body) ? wires.body : []) {
      const name: unknown = field_get(row, 'Name');
      if (typeof name !== 'string' || !name.startsWith(`${this.options.prefix}-net-`)) continue;
      const inspected: DockerAnswer = await docker.call('GET', `/networks/${name}`);
      const members: unknown = field_get(inspected.body, 'Containers');
      // A berth is named by the prefix and its identity's key, nothing else; porter or a helper on the wire does not keep it.
      const berthOn: boolean = typeof members === 'object' && members !== null && Object.values(members as Record<string, unknown>).some((member: unknown): boolean => {
        const memberName: unknown = field_get(member, 'Name');
        return typeof memberName === 'string' && new RegExp(`^${this.options.prefix}-[0-9a-f]{16}$`).test(memberName);
      });
      if (berthOn) continue;
      await this.porter_leave(name);
      await docker.call('DELETE', `/networks/${name}`);
      removed.push(name);
    }
    return removed;
  }

  /**
   * Starts a person's berth, or rewrites the token of the one running.
   *
   * @param given - Who it is for, their token, and the cohort.
   * @returns The berth, running.
   * @throws {BerthRefusal} When the ask is not one, the spoke is full, or the berth does not come up.
   */
  public start(given: BerthAsk): Promise<BerthState> {
    if (!USER_NAME.test(given.user)) return Promise.reject(new BerthRefusal(400, `${given.user}: not a CUBE user name`));
    try { new URL(given.cubeUrl); } catch { return Promise.reject(new BerthRefusal(400, `${given.cubeUrl}: not a URL`)); }
    if (given.cohort !== null && given.cohort !== undefined && (!Number.isInteger(given.cohort) || given.cohort <= 0)) return Promise.reject(new BerthRefusal(400, `${String(given.cohort)}: a cohort is a feed's id`));
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
   * Stops a person's berth: its container removed, porter taken off its wire
   * and the wire removed; its volumes stay.
   *
   * @param user - The CUBE user.
   * @param cubeUrl - The CUBE.
   * @returns Whether there was one.
   */
  public async stop(user: string, cubeUrl: string): Promise<boolean> {
    const identity: string = identity_normalise(user, cubeUrl);
    const names: BerthNames = berthNames_derive(this.options.prefix, identity, user, null);
    this.held.delete(identity);
    const found: DockerAnswer = await this.options.docker.call('GET', `/containers/${names.container}/json`);
    const was: boolean = found.status !== 404;
    if (was) {
      await this.options.docker.call('POST', `/containers/${names.container}/stop?t=10`);
      await this.options.docker.call('DELETE', `/containers/${names.container}?force=true`);
    }
    await this.porter_leave(names.network);
    await this.options.docker.call('DELETE', `/networks/${names.network}`);
    return was;
  }

  /**
   * A person's berth as it stands, or every berth of this spoke.
   *
   * @param who - The user and CUBE, or null for all.
   * @returns The berths.
   */
  public async status(who: { user: string; cubeUrl: string } | null): Promise<BerthState[]> {
    const listed: DockerAnswer = await this.options.docker.call('GET', `/containers/json?all=true&filters=${labelFilter_build(this.options.prefix)}`);
    const rows: unknown[] = Array.isArray(listed.body) ? listed.body : [];
    const want: string | null = who === null ? null : identity_normalise(who.user, who.cubeUrl);
    const states: BerthState[] = [];
    for (const row of rows) {
      const identity: unknown = field_get(row, 'Labels', `${BERTH_LABEL}.identity`);
      const user: unknown = field_get(row, 'Labels', `${BERTH_LABEL}.user`);
      const cohort: unknown = field_get(row, 'Labels', `${BERTH_LABEL}.cohort`);
      if (typeof identity !== 'string' || typeof user !== 'string' || (want !== null && identity !== want)) continue;
      const names: BerthNames = berthNames_derive(this.options.prefix, identity, user, null);
      const up: boolean = field_get(row, 'State') === 'running';
      const berth = up ? await this.berth_read(names, identity).catch((): null => null) : null;
      states.push({ identity, user, state: up && berth !== null ? 'running' : 'stopped', url: berth?.url ?? null, token: berth?.token ?? null, container: names.container, cohort: typeof cohort === 'string' ? cohort : NO_COHORT });
    }
    return states;
  }

  /**
   * The start itself: a running berth on the same cohort gets the new
   * token; one on another cohort is stopped first; otherwise the spoke's
   * room is checked, the wires and volumes made, the container made and
   * started, porter joined to the wire, the token written, and the berth
   * waited for.
   *
   * @param ask - The ask.
   * @param identity - Its identity.
   * @returns The berth.
   */
  private async start_run(ask: BerthAsk, identity: string): Promise<BerthState> {
    const docker: DockerApi = this.options.docker;
    const names: BerthNames = berthNames_derive(this.options.prefix, identity, ask.user, ask.cohort);
    const token: string | null = ask.token;
    if (token === null) throw new BerthRefusal(409, `${ask.user}: no token to start a berth on; log in again`);
    const found: DockerAnswer = await docker.call('GET', `/containers/${names.container}/json`);
    const cohortHeld: unknown = field_get(found.body, 'Config', 'Labels', `${BERTH_LABEL}.cohort`);
    if (found.status === 200 && field_get(found.body, 'State', 'Running') === true && cohortHeld === cohort_word(ask.cohort)) {
      // A porter made again since the berth started has left its wire: joined again before it is handed back.
      await this.porter_join(names.network);
      await this.token_write(names.container, ask, token);
      this.held.set(identity, { token, uid: ask.uid, gid: ask.gid });
      const berth = await this.berth_read(names, identity);
      return { identity, user: ask.user, state: 'running', url: berth.url, token: berth.token, container: names.container, cohort: cohort_word(ask.cohort) };
    }
    // A berth stopped, or on another cohort: made again from the image; the home stays.
    if (found.status === 200) {
      await docker.call('POST', `/containers/${names.container}/stop?t=10`);
      await docker.call('DELETE', `/containers/${names.container}?force=true`);
    }
    // The spoke's room, before anything is made.
    const others: BerthState[] = (await this.status(null)).filter((one: BerthState): boolean => one.state === 'running' && one.identity !== identity);
    const capacity: number = await this.capacity_get();
    if (others.length >= capacity) throw new BerthRefusal(409, capacityRefusal_words(capacity, others.map((one: BerthState): string => one.user)));
    await this.cubeNetwork_ensure();
    await this.wire_ensure(names.network, ask.user);
    await this.volumes_ensure(names, ask);
    const made: DockerAnswer = await docker.call('POST', `/containers/create?name=${names.container}`, berthContainer_spec(this.options, ask, identity, await this.cubeHosts_read()));
    if (made.status !== 201) throw new BerthRefusal(502, `${ask.user}'s berth was not made: ${JSON.stringify(made.body)}`);
    const started: DockerAnswer = await docker.call('POST', `/containers/${names.container}/start`);
    if (started.status !== 204 && started.status !== 304) throw new BerthRefusal(502, `${ask.user}'s berth did not start: ${JSON.stringify(started.body)}`);
    await this.porter_join(names.network);
    await this.token_write(names.container, ask, token);
    this.held.set(identity, { token, uid: ask.uid, gid: ask.gid });
    const berth = await this.berth_wait(names, identity);
    return { identity, user: ask.user, state: 'running', url: berth.url, token: berth.token, container: names.container, cohort: cohort_word(ask.cohort) };
  }

  /**
   * The host lines a berth carries: CUBE's name at cube-net's gateway, when the spoke publishes its API there.
   *
   * @returns `cube.chrisproject.org:172.18.0.1`, or none.
   * @throws {BerthRefusal} When cube-net names no gateway.
   */
  private async cubeHosts_read(): Promise<string[]> {
    if (this.options.cubeHost === undefined) return [];
    const found: DockerAnswer = await this.options.docker.call('GET', `/networks/${this.options.cubeNetwork}`);
    const configs: unknown = field_get(found.body, 'IPAM', 'Config');
    const gateway: unknown = Array.isArray(configs) ? (configs as unknown[]).map((one: unknown): unknown => field_get(one, 'Gateway')).find((one: unknown): boolean => typeof one === 'string' && one !== '') : undefined;
    if (typeof gateway !== 'string') throw new BerthRefusal(502, `cube-net ${this.options.cubeNetwork} names no gateway for ${this.options.cubeHost}`);
    return [`${this.options.cubeHost}:${gateway}`];
  }

  /** cube-net, made when missing: a bridge whose containers cannot reach one another, carrying only the CUBE API. */
  private async cubeNetwork_ensure(): Promise<void> {
    const docker: DockerApi = this.options.docker;
    const found: DockerAnswer = await docker.call('GET', `/networks/${this.options.cubeNetwork}`);
    if (found.status === 200) return;
    const made: DockerAnswer = await docker.call('POST', '/networks/create', {
      Name: this.options.cubeNetwork, Driver: 'bridge',
      Options: { 'com.docker.network.bridge.enable_icc': 'false' },
      Labels: { [BERTH_LABEL]: this.options.prefix, [`${BERTH_LABEL}.net`]: 'cube' },
    });
    if (made.status !== 201) throw new BerthRefusal(502, `cube-net ${this.options.cubeNetwork} was not made: ${JSON.stringify(made.body)}`);
  }

  /**
   * A berth's own wire, made when missing: a bridge for porter and that berth.
   *
   * @param network - Its name.
   * @param user - Whose.
   */
  private async wire_ensure(network: string, user: string): Promise<void> {
    const docker: DockerApi = this.options.docker;
    const found: DockerAnswer = await docker.call('GET', `/networks/${network}`);
    if (found.status === 200) return;
    const made: DockerAnswer = await docker.call('POST', '/networks/create', {
      Name: network, Driver: 'bridge',
      Labels: { [BERTH_LABEL]: this.options.prefix, [`${BERTH_LABEL}.net`]: 'wire', [`${BERTH_LABEL}.user`]: user },
    });
    if (made.status !== 201) throw new BerthRefusal(502, `${user}'s wire ${network} was not made: ${JSON.stringify(made.body)}`);
  }

  /**
   * Porter joins a berth's wire, when porter is a container.
   *
   * @param network - The wire.
   */
  private async porter_join(network: string): Promise<void> {
    if (this.options.porterContainer === null) return;
    const joined: DockerAnswer = await this.options.docker.call('POST', `/networks/${network}/connect`, { Container: this.options.porterContainer });
    if (joined.status !== 200 && joined.status !== 403) throw new BerthRefusal(502, `porter did not join ${network}: ${JSON.stringify(joined.body)}`);
  }

  /**
   * Porter leaves a berth's wire, when porter is a container.
   *
   * @param network - The wire.
   */
  private async porter_leave(network: string): Promise<void> {
    if (this.options.porterContainer === null) return;
    await this.options.docker.call('POST', `/networks/${network}/disconnect`, { Container: this.options.porterContainer, Force: true });
  }

  /**
   * The person's volumes, made when missing: the home, and the cohort's
   * pair, given to the person's uid (with `incoming/` and `outgoing/` made in
   * the pair) by a one-shot container that can change ownership and
   * nothing else.
   *
   * @param names - The volumes' names.
   * @param ask - Whose.
   */
  private async volumes_ensure(names: BerthNames, ask: BerthAsk): Promise<void> {
    const docker: DockerApi = this.options.docker;
    const fresh: string[] = [];
    for (const [volume, kind] of [[names.home, 'home'], [names.cohort, 'cohort']] as const) {
      const found: DockerAnswer = await docker.call('GET', `/volumes/${volume}`);
      if (found.status === 200) continue;
      await docker.call('POST', '/volumes/create', { Name: volume, Labels: { [BERTH_LABEL]: this.options.prefix, [`${BERTH_LABEL}.user`]: ask.user, [`${BERTH_LABEL}.volume`]: kind, ...(kind === 'cohort' ? { [`${BERTH_LABEL}.cohort`]: cohort_word(ask.cohort) } : {}) } });
      fresh.push(volume);
    }
    if (fresh.length === 0) return;
    // Volumes never given to the person are removed again, so the next start makes them and gives them anew.
    try {
      await this.volumes_own(names, ask);
    } catch (error: unknown) {
      for (const volume of fresh) await docker.call('DELETE', `/volumes/${volume}`);
      throw error;
    }
  }

  /**
   * Gives the person's volumes to their uid, `incoming/` and `outgoing/` made in the cohort's pair.
   *
   * @param names - The volumes' names.
   * @param ask - Whose.
   * @throws {BerthRefusal} When the one-shot container is not made or does not succeed.
   */
  private async volumes_own(names: BerthNames, ask: BerthAsk): Promise<void> {
    const docker: DockerApi = this.options.docker;
    const owner: string = `${names.container}-own`;
    await docker.call('DELETE', `/containers/${owner}?force=true`);
    const made: DockerAnswer = await docker.call('POST', `/containers/create?name=${owner}`, {
      Image: this.options.image,
      User: '0:0',
      Entrypoint: ['sh', '-c', `mkdir -p /v/cohort/incoming /v/cohort/outgoing && chown ${ask.uid}:${ask.gid} /v/home /v/cohort /v/cohort/incoming /v/cohort/outgoing`],
      Labels: { [BERTH_LABEL]: this.options.prefix },
      HostConfig: { Binds: [`${names.home}:/v/home`, `${names.cohort}:/v/cohort`], NetworkMode: 'none', CapDrop: ['ALL'], CapAdd: ['CHOWN', 'DAC_OVERRIDE'], SecurityOpt: ['no-new-privileges'], ReadonlyRootfs: true },
    });
    if (made.status !== 201) throw new BerthRefusal(502, `${ask.user}'s volumes were not given to them: ${JSON.stringify(made.body)}`);
    await docker.call('POST', `/containers/${owner}/start`);
    const waited: DockerAnswer = await docker.call('POST', `/containers/${owner}/wait`);
    await docker.call('DELETE', `/containers/${owner}?force=true`);
    if (field_get(waited.body, 'StatusCode') !== 0) throw new BerthRefusal(502, `${ask.user}'s volumes were not given to them (exit ${String(field_get(waited.body, 'StatusCode'))})`);
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
   * The berth file the session's calypso wrote, its address moved to the container's on its own wire.
   *
   * @param names - The berth's names.
   * @param identity - Whose.
   * @returns Its address and attach token.
   */
  private async berth_read(names: BerthNames, identity: string): Promise<{ url: string; token: string }> {
    const docker: DockerApi = this.options.docker;
    const inspected: DockerAnswer = await docker.call('GET', `/containers/${names.container}/json`);
    const user: unknown = field_get(inspected.body, 'Config', 'User');
    const read = await docker.exec(names.container, ['sh', '-c', `cat ${BERTH_TOKEN_DIR}/calypso/berth-${berthKey_compute(identity)}.json`], typeof user === 'string' ? user : '65534:65534', null);
    if (read.code !== 0) throw new Error('no berth file yet');
    const berth: unknown = JSON.parse(read.stdout);
    const url: unknown = field_get(berth, 'url');
    const token: unknown = field_get(berth, 'token');
    const address: unknown = field_get(inspected.body, 'NetworkSettings', 'Networks', names.network, 'IPAddress');
    if (typeof url !== 'string' || typeof token !== 'string' || typeof address !== 'string' || address === '') throw new Error('the berth file is not one');
    const at: URL = new URL(url);
    return { url: `${at.protocol}//${address}:${at.port}`, token };
  }

  /**
   * Waits for the session to write its berth file; a berth that exits first is refused with its last words.
   *
   * @param names - The berth's names.
   * @param identity - Whose.
   * @returns Its address and attach token.
   */
  private async berth_wait(names: BerthNames, identity: string): Promise<{ url: string; token: string }> {
    const deadline: number = Date.now() + (this.options.bootMs ?? 90_000);
    while (Date.now() < deadline) {
      const inspected: DockerAnswer = await this.options.docker.call('GET', `/containers/${names.container}/json`);
      if (field_get(inspected.body, 'State', 'Running') !== true) {
        const said: string = await this.logsTail_read(names.container);
        throw new BerthRefusal(502, `the berth stopped as it started: ${said}`);
      }
      try { return await this.berth_read(names, identity); } catch { /* not yet */ }
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
    // The log is the engine's multiplexed stream: its frame headers are control bytes, taken out; the lines stay.
    // eslint-disable-next-line no-control-regex
    const text: string = typeof answer.body === 'string' ? answer.body.replace(/[\u0000-\u0009\u000b-\u001f]/g, '') : '';
    return text.split('\n').map((line: string): string => line.trim()).filter((line: string): boolean => line !== '').slice(-3).join(' / ') || 'no words';
  }
}
