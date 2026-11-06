/**
 * @file A fake ChRIS VM, for tests and for `stratus --fake`: a VM that answers
 * `chris deploy`'s and `chris user add`'s lines as a VM running CUBE would,
 * keeping the files written, the computes registered and CUBE's accounts; and
 * the fleet of them a fake daemon reaches, which answers CUBE's API and
 * porter's health over "HTTPS" from what each was given.
 */
import type { RemoteAnswer, VmRemote } from '../../vm/remote.js';
import { CUBE_PYTHON_LINE } from '../../chris/users.js';
import type { HttpGet } from '../../chris/live.js';
import type { ChrisCommandContext } from '../../commands/chris.js';

/** A VM that answers the deploy's lines, recording them and the files written. */
export class FakeChrisVm implements VmRemote {
  lines: string[] = [];
  files: Map<string, string> = new Map();
  computes: string[] = [];
  /** CUBE's accounts, by name: their emails. */
  users: Map<string, string> = new Map([['chris', 'dev@babymri.org']]);
  /** Each account made, as CUBE was given it. */
  made: Array<{ username: string; email: string; password: string }> = [];
  /** Each account's password, as CUBE holds it: chris's set from cube.env each time the services start, as CUBE's migrations do. */
  passwords: Map<string, string> = new Map();
  /** Whether the admin has its home. */
  adminHome: boolean = false;
  /** Lines that fail, once each. */
  failing: Set<string> = new Set();
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
  async run(line: string, input?: string): Promise<RemoteAnswer> {
    this.lines.push(line);
    if (this.lineMs > 0) await new Promise((done: (value: unknown) => void): void => { setTimeout(done, this.lineMs); });
    if (this.failing.delete(line)) return { code: 1, stdout: '', stderr: 'it failed' };
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
      const ask = JSON.parse(Buffer.from((/b64decode\('([^']+)'\)/.exec(input ?? '') as RegExpMatchArray)[1] as string, 'base64').toString('utf-8')) as { username: string; email: string; password: string };
      if ((input ?? '').includes('set_password')) {
        if (!this.users.has(ask.username)) return { code: 0, stdout: 'stratus-user absent\n', stderr: '' };
        this.passwords.set(ask.username, ask.password);
        return { code: 0, stdout: 'stratus-user changed\n', stderr: '' };
      }
      const same: string | undefined = this.users.get(ask.username);
      const other: string | undefined = [...this.users.entries()].find(([name, email]): boolean => email === ask.email && name !== ask.username)?.[0];
      if (same !== undefined) return { code: 0, stdout: `stratus-user exists ${JSON.stringify(same)}\n`, stderr: '' };
      if (other !== undefined) return { code: 0, stdout: `stratus-user email-taken ${JSON.stringify(other)}\n`, stderr: '' };
      this.users.set(ask.username, ask.email);
      this.made.push(ask);
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
    if (path.endsWith('/groups/search/')) return { status: 200, body: { next: null, results: [{ id: 1, name: 'all_users' }] } };
    if (path.endsWith('/groups/1/users/')) return { status: 200, body: { next: null, results: [...vm.users.entries()].map(([username, email]: [string, string]) => ({ user_username: username, user_email: email })) } };
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
