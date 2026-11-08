/**
 * @file A fake ChRIS VM, for tests and for `stratus --fake`: a VM that answers
 * `chris deploy`'s, `chris user add`'s and `chris plugin sync`'s lines as a
 * VM running CUBE and porter would, keeping the files written, the computes
 * registered, CUBE's accounts and its plugins; and the fleet of them a fake
 * daemon reaches, which answers CUBE's API and porter's health over "HTTPS"
 * from what each was given.
 */
import type { RemoteAnswer, VmRemote } from '../../vm/remote.js';
import { CUBE_PYTHON_LINE } from '../../chris/users.js';
import { EXIT_CHELL_OLD, EXIT_NO_PORTER, EXIT_NO_TOKEN, PLUGIN_MARK, PLUGIN_SYNC_LINE, type PluginSyncAsk } from '../../chris/plugins.js';

/** One descriptor in the fake plugin index. */
export interface FakeIndexPlugin {
  readonly name: string;
  readonly version: string;
  /** Whether it fails the index's rules, as `pl-s3path` does in the real one. */
  readonly invalid?: boolean;
}

/** The fake plugin index: four good descriptors and one that fails its rules. */
export const FAKE_PLUGIN_INDEX: ReadonlyArray<FakeIndexPlugin> = [
  { name: 'pl-dircopy', version: '3.0.0' },
  { name: 'pl-simpledsapp', version: '2.1.3' },
  { name: 'pl-tsdircopy', version: '1.2.1' },
  { name: 'pl-dcm2niix', version: '1.0.2' },
  { name: 'pl-s3path', version: '1.0.0', invalid: true },
];

/** The commit the fake index stands at. */
export const FAKE_INDEX_COMMIT: string = '8c9a1f6e2d4b7a0c1e3f5a7b9d1c3e5f7a9b1d3c';
import type { HttpGet } from '../../chris/live.js';
import type { ChrisCommandContext } from '../../commands/chris.js';

/** A VM that answers the deploy's lines, recording them and the files written. */
export class FakeChrisVm implements VmRemote {
  lines: string[] = [];
  files: Map<string, string> = new Map();
  computes: string[] = [];
  /** CUBE's accounts, by name: their emails. */
  users: Map<string, string> = new Map([['chris', 'dev@babymri.org']]);
  /** CUBE's groups, by name: their members, as a fresh CUBE holds them (the admin's home program puts chris in both). */
  groups: Map<string, Set<string>> = new Map([['all_users', new Set(['chris'])], ['pacs_users', new Set(['chris'])]]);
  /** Each account made, as CUBE was given it. */
  made: Array<{ username: string; email: string; password: string }> = [];
  /** Each account's password, as CUBE holds it: chris's set from cube.env each time the services start, as CUBE's migrations do. */
  passwords: Map<string, string> = new Map();
  /** Whether the admin has its home. */
  adminHome: boolean = false;
  /** Lines that fail, once each. */
  failing: Set<string> = new Set();
  /** CUBE's plugins, by name: their versions. */
  plugins: Map<string, string> = new Map();
  /** The plugin index porter's chell reads. */
  pluginIndex: FakeIndexPlugin[] = [...FAKE_PLUGIN_INDEX];
  /** The chell in porter's container. */
  chellVersion: string = '5.20.0';
  /** Whether porter's container answers. */
  porterRuns: boolean = true;
  /** Whether CUBE refuses chris's token, as when cube.env's password is not CUBE's. */
  tokenRefused: boolean = false;
  /** Each plugin sync run's ask, as it reached the chell: `plan` or `apply`, the source, the ref. */
  syncs: Array<{ kind: string; ask: PluginSyncAsk }> = [];
  /** The group that owns Docker's socket on this VM. */
  dockerGid: string = '998';
  /** What porter's image prints for the berth image it pins. */
  berthPin: string = `ghcr.io/fnndsc/berth@sha256:${'ab12'.repeat(16)}`;
  /** What the berth launcher's health reads, until it is `healthy`. */
  launcherHealth: string = 'healthy';
  /** Each image pulled by name. */
  pulled: string[] = [];
  /** How long each line takes, in milliseconds, so a walk sees a deploy move. */
  readonly lineMs: number;

  /**
   * @param lineMs - How long each line takes; none when absent.
   */
  constructor(lineMs: number = 0) {
    this.lineMs = lineMs;
  }

  /**
   * Answers a line as the VM would.
   *
   * @param line - The line.
   * @param input - What it is given on stdin.
   * @returns Its answer.
   */
  async run(line: string, input?: string, watch?: (chunk: string) => void): Promise<RemoteAnswer> {
    this.lines.push(line);
    if (this.lineMs > 0) await new Promise((done: (value: unknown) => void): void => { setTimeout(done, this.lineMs); });
    if (this.failing.delete(line)) return { code: 1, stdout: '', stderr: 'it failed' };
    if (line === PLUGIN_SYNC_LINE) return this.pluginSync_answer(input ?? '', watch);
    if (line === 'stat -c %g /var/run/docker.sock') return { code: 0, stdout: `${this.dockerGid}\n`, stderr: '' };
    if (line.startsWith('docker run --rm --entrypoint node ')) return { code: 0, stdout: `${this.berthPin}\n`, stderr: '' };
    if (line.startsWith('docker pull -q ')) { this.pulled.push(line.slice('docker pull -q '.length)); return { code: 0, stdout: '', stderr: '' }; }
    if (line.startsWith('docker inspect -f ')) return { code: 0, stdout: `${this.launcherHealth}\n`, stderr: '' };
    if (line.startsWith('docker logs --tail 5 ')) return { code: 0, stdout: 'listening failed\nEACCES docker.sock\n', stderr: '' };
    if (line.includes('docker compose up')) {
      const env: string = this.files.get('/srv/data/chris/cube.env') ?? '';
      const admin: string | undefined = /^CHRIS_SUPERUSER_PASSWORD=(.*)$/m.exec(env)?.[1];
      if (admin !== undefined) this.passwords.set('chris', admin);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (line.includes('curl -s -K -')) {
      const signed: string | undefined = /^user = "chris:(.*)"$/m.exec(input ?? '')?.[1];
      if (this.passwords.has('chris') && signed !== this.passwords.get('chris')) return { code: 0, stdout: '{}\n401', stderr: '' };
    }
    if (line === CUBE_PYTHON_LINE && (input ?? '').includes('home/chris/feeds')) {
      const made: boolean = !this.adminHome;
      this.adminHome = true;
      return { code: 0, stdout: `stratus-home ${made ? 'home/chris/uploads, home/chris/feeds, home/chris/public, home/chris/shared' : 'there'}\n`, stderr: '' };
    }
    if (line === CUBE_PYTHON_LINE) {
      const ask = JSON.parse(Buffer.from((/b64decode\('([^']+)'\)/.exec(input ?? '') as RegExpMatchArray)[1] as string, 'base64').toString('utf-8')) as { username: string; email?: string; password?: string; groups?: string[] };
      if ((input ?? '').includes('set_password')) {
        if (!this.users.has(ask.username)) return { code: 0, stdout: 'stratus-user absent\n', stderr: '' };
        this.passwords.set(ask.username, ask.password ?? '');
        return { code: 0, stdout: 'stratus-user changed\n', stderr: '' };
      }
      const same: string | undefined = this.users.get(ask.username);
      const other: string | undefined = ask.email === undefined ? undefined : [...this.users.entries()].find(([name, email]): boolean => email === ask.email && name !== ask.username)?.[0];
      const missing: string[] = (ask.groups ?? []).filter((name: string): boolean => !this.groups.has(name));
      // A change of an account: its email, its groups set whole with all_users kept.
      if (ask.password === undefined) {
        if (same === undefined) return { code: 0, stdout: 'stratus-user absent\n', stderr: '' };
        if (other !== undefined) return { code: 0, stdout: `stratus-user email-taken ${JSON.stringify(other)}\n`, stderr: '' };
        if (missing.length > 0) return { code: 0, stdout: `stratus-user no-group ${JSON.stringify(missing)}\n`, stderr: '' };
        if (ask.email !== undefined) this.users.set(ask.username, ask.email);
        if (ask.groups !== undefined) {
          const wanted: Set<string> = new Set([...ask.groups, 'all_users']);
          for (const [name, members] of this.groups) { if (wanted.has(name)) members.add(ask.username); else members.delete(ask.username); }
        }
        return { code: 0, stdout: 'stratus-user changed\n', stderr: '' };
      }
      if (same !== undefined) return { code: 0, stdout: `stratus-user exists ${JSON.stringify(same)}\n`, stderr: '' };
      if (other !== undefined) return { code: 0, stdout: `stratus-user email-taken ${JSON.stringify(other)}\n`, stderr: '' };
      if (missing.length > 0) return { code: 0, stdout: `stratus-user no-group ${JSON.stringify(missing)}\n`, stderr: '' };
      this.users.set(ask.username, ask.email ?? '');
      for (const name of ['all_users', ...(ask.groups ?? [])]) this.groups.get(name)?.add(ask.username);
      this.made.push({ username: ask.username, email: ask.email ?? '', password: ask.password });
      return { code: 0, stdout: 'stratus-user added\n', stderr: '' };
    }
    const written: RegExpMatchArray | null = /cat > (\S+)\.new/.exec(line);
    if (written !== null) this.files.set(written[1] as string, input ?? '');
    if (line.includes('-o /dev/null')) return { code: 0, stdout: '200', stderr: '' };
    if (line.includes('computeresources/search/')) return { code: 0, stdout: `{"results":[${this.computes.map((name: string): string => `{"name":"${name}"}`).join(',')}]}\n200`, stderr: '' };
    if (line.includes('chris-admin/api/v1/computeresources/')) {
      const quoted: string = (/json = (".*")/.exec(input ?? '') as RegExpMatchArray)[1] as string;
      this.computes.push((JSON.parse(JSON.parse(quoted) as string) as { name: string }).name);
      return { code: 0, stdout: '{}\n201', stderr: '' };
    }
    if (line.endsWith('http://127.0.0.1:8000/api/v1/')) return { code: 0, stdout: '{"collection_links":{"admin":"http://127.0.0.1:8000/chris-admin/api/v1/"}}\n200', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  }

  /**
   * Answers a plugin sync script as porter's chell would: the plan's fields
   * in marked lines, or each plugin added and the summary.
   *
   * @param script - The script, its first line carrying the ask.
   * @param watch - Sees the output as it comes.
   * @returns Its answer.
   */
  private pluginSync_answer(script: string, watch?: (chunk: string) => void): RemoteAnswer {
    const head: RegExpExecArray | null = new RegExp(`^# ${PLUGIN_MARK} (plan|apply) (\\S+)`).exec(script);
    if (head === null) return { code: 2, stdout: '', stderr: 'sh: no script' };
    const kind: string = head[1] as string;
    const ask: PluginSyncAsk = JSON.parse(Buffer.from(head[2] as string, 'base64').toString('utf-8')) as PluginSyncAsk;
    this.syncs.push({ kind, ask });
    if (!this.porterRuns) return { code: EXIT_NO_PORTER, stdout: `${PLUGIN_MARK} no-porter\n`, stderr: 'service "porter" is not running' };
    let stdout: string = `${PLUGIN_MARK} chell ${this.chellVersion}\n`;
    const [major = 0, minor = 0] = this.chellVersion.split('.').map(Number);
    if (major < 5 || (major === 5 && minor < 20)) return { code: EXIT_CHELL_OLD, stdout, stderr: '' };
    if (this.tokenRefused) return { code: EXIT_NO_TOKEN, stdout: `${stdout}${PLUGIN_MARK} no-token\n`, stderr: '' };
    const source: string = ask.source ?? 'FNNDSC/chris-plugins@main';
    const label: string = `chris-plugins @ ${FAKE_INDEX_COMMIT.slice(0, 7)}`;
    const entries: Array<{ group: string; name: string; version: string }> = this.pluginIndex.map((plugin: FakeIndexPlugin) => {
      const held: string | undefined = this.plugins.get(plugin.name);
      const group: string = plugin.invalid === true ? 'invalid' : held === undefined ? 'add' : held === plugin.version ? 'skip' : held < plugin.version ? 'newer' : 'cubeNewer';
      return { group, name: plugin.name, version: plugin.version };
    });
    const computes: string[] = this.computes.length > 0 ? [...this.computes] : ['host'];
    if (kind === 'plan') {
      stdout += `plugin sync: ${label}, ${this.pluginIndex.length} plugins → this CUBE, on ${computes.join(', ')}\n`;
      const marks: Array<[string, string]> = [['indexed', String(this.pluginIndex.length)], ['label', label], ['source', source], ['commit', FAKE_INDEX_COMMIT], ['computes', computes.join(' ')], ['entries.group', entries.map((entry): string => entry.group).join(' ')], ['entries.name', entries.map((entry): string => entry.name).join(' ')]];
      for (const [field, value] of marks) stdout += `${PLUGIN_MARK} ${field} ${value}\n`;
      return { code: 0, stdout, stderr: '' };
    }
    let added: number = 0;
    for (const entry of entries.filter((each): boolean => each.group === 'add' || each.group === 'newer')) {
      this.plugins.set(entry.name, entry.version);
      added += 1;
      const landed: string = `added  ${entry.name} ${entry.version}\n`;
      stdout += landed;
      watch?.(landed);
    }
    const skipped: number = entries.filter((entry): boolean => entry.group === 'skip').length;
    stdout += `${added} added, ${skipped} skipped, ${entries.length - added - skipped} reported, 0 failed.\n`;
    return { code: 0, stdout, stderr: '' };
  }
}

/** The fake VMs a fake daemon reaches, one per name, and what they answer from outside. */
export class FakeChrisFleet {
  readonly vms: Map<string, FakeChrisVm> = new Map();
  /** How long each VM's line takes. */
  readonly lineMs: number;

  /**
   * @param lineMs - How long each VM's line takes.
   */
  constructor(lineMs: number = 0) {
    this.lineMs = lineMs;
  }

  /**
   * The VM of a name, made the first time it is reached.
   *
   * @param name - The VM's name.
   * @returns Its fake.
   */
  vm_get(name: string): FakeChrisVm {
    const found: FakeChrisVm | undefined = this.vms.get(name);
    if (found !== undefined) return found;
    const made: FakeChrisVm = new FakeChrisVm(this.lineMs);
    this.vms.set(name, made);
    return made;
  }

  /**
   * The VM a URL reaches: the last one given a file naming its host.
   *
   * @param url - The URL.
   * @returns The VM, or null when none serves it.
   */
  served_find(url: string): FakeChrisVm | null {
    const host: string = new URL(url).hostname;
    const serving: FakeChrisVm[] = [...this.vms.values()].filter((vm: FakeChrisVm): boolean => [...vm.files.values()].some((text: string): boolean => text.includes(host)));
    return serving.at(-1) ?? null;
  }

  /** CUBE's API and porter's health, as the public reaches them. */
  readonly http_get: HttpGet = async (url: string, auth: { user: string; password: string } | null): Promise<{ status: number; body: unknown } | null> => {
    const vm: FakeChrisVm | null = this.served_find(url);
    if (vm === null) return null;
    const path: string = new URL(url).pathname;
    if (path === '/healthz') return { status: 200, body: { ok: true, sessions: 0 } };
    const signed: boolean = auth !== null && vm.passwords.get(auth.user) === auth.password;
    if (path.endsWith('/api/v1/')) return { status: auth === null || signed ? 200 : 401, body: {} };
    if (!signed) return { status: 401, body: {} };
    const names: string[] = [...vm.groups.keys()];
    if (path.endsWith('/groups/')) return { status: 200, body: { next: null, results: names.map((name: string, at: number) => ({ id: at + 1, name })) } };
    const members: RegExpExecArray | null = /\/groups\/(\d+)\/users\/$/.exec(path);
    if (members !== null) {
      const name: string | undefined = names[Number(members[1]) - 1];
      const ids: string[] = [...vm.users.keys()];
      return { status: 200, body: { next: null, results: [...(name === undefined ? [] : vm.groups.get(name) ?? [])].map((username: string) => ({ user_id: ids.indexOf(username) + 1, user_username: username, user_email: vm.users.get(username) ?? '' })) } };
    }
    return { status: 404, body: {} };
  };

  /**
   * A name's public addresses: every fake VM answers on the fake cloud's one address.
   *
   * @returns The address.
   */
  async resolve(): Promise<string[]> {
    return ['203.0.113.10'];
  }

  /**
   * A URL's status from outside: 200 once a VM serves it.
   *
   * @param url - The URL.
   * @returns The status, or null.
   */
  async status_get(url: string): Promise<number | null> {
    return this.served_find(url) === null ? null : 200;
  }
}

/**
 * How a fake daemon reaches ChRIS on its VMs: the fleet answers, and no registrar writes DNS.
 *
 * @param fleet - The fake VMs.
 * @param tickMs - The deploy's wait between tries.
 * @returns The reach.
 */
export function chrisReach_fake(fleet: FakeChrisFleet, tickMs: number): Pick<ChrisCommandContext, 'remote_open' | 'http_get' | 'resolve' | 'nameservers_get' | 'registrar' | 'status_get' | 'tickMs'> {
  return {
    remote_open: async (name: string): Promise<VmRemote> => fleet.vm_get(name),
    http_get: fleet.http_get,
    resolve: async (): Promise<string[]> => fleet.resolve(),
    nameservers_get: async (): Promise<string[]> => ['ns1.fake.example', 'ns2.fake.example'],
    registrar: null,
    status_get: async (url: string): Promise<number | null> => fleet.status_get(url),
    tickMs,
  };
}
