/**
 * @file What runs of a ChRIS a deploy put up, read from it (AEGIS's
 * a-change-is-a-loop, clause 1: render what stands, from its truth, with its
 * age): CUBE's API as the public reaches it and whether the admin signs in,
 * CUBE's groups and their members (every page; an account is a member of
 * `all_users` at least, its id CUBE's own), and porter's
 * health, open sessions and version, and porter's berths (each person's
 * berth or kept home, with what a running one uses, from `GET /berths`, asked
 * with the admin's credentials). Read over HTTPS from this host with the
 * admin password the host keeps, so a READ session reads it: no bastion
 * session is made, nothing in the tenancy changes.
 *
 * @module
 */
import type { VmRecord } from '../vm/state.js';
import type { ChrisSecrets } from './compose.js';

/** A GET as this host makes it: the status and the JSON body, or null when nothing answered. */
export type HttpGet = (url: string, auth: { user: string; password: string } | null) => Promise<{ status: number; body: unknown } | null>;

/** A CUBE account as the ChRIS holds it: its CUBE id (null when CUBE does not say) and the groups it is in. */
export interface ChrisAccount {
  readonly username: string;
  readonly email: string;
  readonly id: number | null;
  readonly groups: ReadonlyArray<string>;
}

/** One person's berth as porter answers it: up with what it uses, or stopped with the home kept. */
export interface ChrisBerth {
  readonly user: string;
  readonly state: 'running' | 'stopped';
  /** The cohort a running berth holds (`none` for no cohort); null when stopped. */
  readonly cohort: string | null;
  /** CPU use as a percent of one CPU; null when stopped or not sampled. */
  readonly cpuPercent: number | null;
  /** Memory in use, in bytes; null when stopped or not sampled. */
  readonly memoryBytes: number | null;
  /** Memory the berth may use, in bytes; null when stopped or not sampled. */
  readonly memoryLimitBytes: number | null;
}

/** What runs of a deployed ChRIS, read from it. */
export interface ChrisLive {
  /** When it was read. */
  readonly at: string;
  /** CUBE's API: what it answered (null: nothing), and whether the admin signs in (null: no password kept here). */
  readonly cube: { readonly url: string; readonly status: number | null; readonly admin: boolean | null };
  /** Porter's door, when one was deployed: what `/healthz` answered, its open sessions and its version (null when it does not say). */
  readonly porter: { readonly url: string; readonly status: number | null; readonly sessions: number | null; readonly version: string | null } | null;
  /** CUBE's accounts, or null when they could not be read; with why. */
  readonly accounts: ReadonlyArray<ChrisAccount> | null;
  readonly accountsWhy: string | null;
  /** CUBE's groups by name, read with the accounts (null when they were not). */
  readonly groups: ReadonlyArray<string> | null;
  /** Porter's berths by person (a person with neither a berth nor a home is absent), or null when they could not be read; with why. */
  readonly berths: ReadonlyArray<ChrisBerth> | null;
  readonly berthsWhy: string | null;
  /** True when porter answered that it starts no berths (`berths` null, `berthsWhy` null): an answer, not a failed read. */
  readonly berthsOff: boolean;
}

/** How many accounts a page asks for; the walk follows every page. */
const PAGE: number = 100;

/**
 * The default GET: Node's fetch, JSON asked for, fifteen seconds.
 *
 * @param url - The address.
 * @param auth - Basic credentials, or null.
 * @returns The status and the parsed body (null when the body is not JSON), or null when nothing answered.
 */
export const httpGet_default: HttpGet = async (url: string, auth: { user: string; password: string } | null): Promise<{ status: number; body: unknown } | null> => {
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (auth !== null) headers['Authorization'] = `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString('base64')}`;
    const response: Response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    let body: unknown = null;
    try { body = await response.json(); } catch { body = null; }
    return { status: response.status, body };
  } catch {
    return null;
  }
};

/**
 * A DRF list's results and next page.
 *
 * @param body - The body.
 * @returns Its results and the next page's address (null on the last).
 */
function page_read(body: unknown): { results: unknown[]; next: string | null } {
  const record: Record<string, unknown> = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  return { results: Array.isArray(record['results']) ? record['results'] : [], next: typeof record['next'] === 'string' ? record['next'] : null };
}

/**
 * Every page of a DRF list, from the first.
 *
 * @param api - CUBE's API root, ending in `/`.
 * @param first - The first page's address.
 * @param auth - The admin's credentials.
 * @param get - How a GET is made.
 * @returns Every result, or why not.
 */
async function pages_walk(api: string, first: string, auth: { user: string; password: string }, get: HttpGet): Promise<{ results: unknown[] } | { why: string }> {
  const results: unknown[] = [];
  let next: string | null = first;
  while (next !== null) {
    const answered = await get(next, auth);
    if (answered === null || answered.status !== 200) return { why: `${new URL(next).pathname} answered ${answered?.status ?? 'nothing'}` };
    const read = page_read(answered.body);
    results.push(...read.results);
    // CUBE names its next page by the address it was asked at, which behind the proxy may be plain http: the path is
    // kept and the origin is the one the public reaches.
    next = read.next === null ? null : new URL(`${new URL(read.next).pathname}${new URL(read.next).search}`, api).toString();
  }
  return { results };
}

/**
 * CUBE's groups and accounts: every group, then each group's members, every
 * page; an account is any member of any group (`all_users` holds them all).
 *
 * @param api - CUBE's API root, ending in `/`.
 * @param auth - The admin's credentials.
 * @param get - How a GET is made.
 * @returns The accounts with their groups and the groups' names, or why they were not read.
 */
async function accounts_read(api: string, auth: { user: string; password: string }, get: HttpGet): Promise<{ accounts: ChrisAccount[]; groups: string[] } | { why: string }> {
  const listed = await pages_walk(api, `${api}groups/?limit=${PAGE}`, auth, get);
  if ('why' in listed) return { why: listed.why };
  const groups: Array<{ id: number; name: string }> = [];
  for (const one of listed.results) {
    const row: Record<string, unknown> = typeof one === 'object' && one !== null ? one as Record<string, unknown> : {};
    if (typeof row['id'] === 'number' && typeof row['name'] === 'string') groups.push({ id: row['id'], name: row['name'] });
  }
  if (!groups.some((group): boolean => group.name === 'all_users')) return { why: 'CUBE has no all_users group' };
  const held: Map<string, { email: string; id: number | null; groups: string[] }> = new Map();
  for (const group of groups) {
    const members = await pages_walk(api, `${api}groups/${group.id}/users/?limit=${PAGE}`, auth, get);
    if ('why' in members) return { why: members.why };
    for (const one of members.results) {
      // A group's member is a membership: CUBE names the account `user_id`, `user_username`, `user_email` (6.11.0).
      const row: Record<string, unknown> = typeof one === 'object' && one !== null ? one as Record<string, unknown> : {};
      const username: unknown = row['user_username'] ?? row['username'];
      if (typeof username !== 'string') continue;
      const email: unknown = row['user_email'] ?? row['email'];
      const id: unknown = row['user_id'];
      const account = held.get(username) ?? { email: typeof email === 'string' ? email : '', id: typeof id === 'number' ? id : null, groups: [] };
      account.groups.push(group.name);
      held.set(username, account);
    }
  }
  const accounts: ChrisAccount[] = [...held.entries()].map(([username, account]): ChrisAccount => ({ username, email: account.email, id: account.id, groups: account.groups.sort() }));
  return { accounts: accounts.sort((a: ChrisAccount, b: ChrisAccount): number => a.username.localeCompare(b.username)), groups: groups.map((group): string => group.name).sort() };
}

/**
 * One berth row as porter answered it, or null when it is not one.
 *
 * @param one - The row.
 * @returns The berth.
 */
function berth_take(one: unknown): ChrisBerth | null {
  const row: Record<string, unknown> = typeof one === 'object' && one !== null ? one as Record<string, unknown> : {};
  if (typeof row['user'] !== 'string' || (row['state'] !== 'running' && row['state'] !== 'stopped')) return null;
  const number_take = (value: unknown): number | null => typeof value === 'number' ? value : null;
  return { user: row['user'], state: row['state'], cohort: typeof row['cohort'] === 'string' ? row['cohort'] : null, cpuPercent: number_take(row['cpuPercent']), memoryBytes: number_take(row['memoryBytes']), memoryLimitBytes: number_take(row['memoryLimitBytes']) };
}

/**
 * Porter's berths, asked of its `GET /berths` with the admin's credentials.
 *
 * @param porter - Porter's name, or undefined when none was deployed.
 * @param version - Porter's version as `/healthz` said it, or null.
 * @param auth - The admin's credentials, or null when this host keeps none.
 * @param get - How a GET is made.
 * @returns The berths, that porter starts none, or why they were not read.
 */
async function berths_read(porter: string | undefined, version: string | null, auth: { user: string; password: string } | null, get: HttpGet): Promise<{ berths: ChrisBerth[] } | { why: string } | { off: true }> {
  if (porter === undefined) return { why: 'no porter was deployed' };
  if (auth === null) return { why: 'this host keeps no admin password for it' };
  const answered = await get(`https://${porter}/berths`, auth);
  if (answered === null) return { why: 'porter does not answer' };
  if (answered.status === 404) return { why: `porter ${version ?? '?'} answers no berth status` };
  if (answered.status !== 200) return { why: `porter answered ${answered.status} to the admin` };
  const body: Record<string, unknown> = typeof answered.body === 'object' && answered.body !== null ? answered.body as Record<string, unknown> : {};
  // `{berths: null, why}` is porter's word that it starts no berths: an answer, not a failed read.
  if (body['berths'] === null) return { off: true };
  if (!Array.isArray(body['berths'])) return { why: 'porter answered no berths' };
  return { berths: body['berths'].map(berth_take).filter((one): one is ChrisBerth => one !== null) };
}

/**
 * Reads what runs of a VM's ChRIS.
 *
 * @param chris - The deploy's record.
 * @param secrets - The passwords this host keeps for it, or null.
 * @param get - How a GET is made.
 * @returns What runs, with when.
 */
export async function chrisLive_read(chris: NonNullable<VmRecord['chris']>, secrets: ChrisSecrets | null, get: HttpGet = httpGet_default): Promise<ChrisLive> {
  const at: string = new Date().toISOString();
  const api: string = chris.url.endsWith('/') ? chris.url : `${chris.url}/`;
  const auth: { user: string; password: string } | null = secrets === null ? null : { user: 'chris', password: secrets.adminPassword };
  const signed = await get(api, auth);
  const cube: ChrisLive['cube'] = { url: api, status: signed?.status ?? null, admin: auth === null || signed === null ? null : signed.status === 200 };
  let porter: ChrisLive['porter'] = null;
  if (chris.porter !== undefined) {
    const url: string = `https://${chris.porter}/healthz`;
    const health = await get(url, null);
    const body: Record<string, unknown> = typeof health?.body === 'object' && health.body !== null ? health.body as Record<string, unknown> : {};
    porter = { url, status: health?.status ?? null, sessions: typeof body['sessions'] === 'number' ? body['sessions'] : null, version: typeof body['version'] === 'string' ? body['version'] : null };
  }
  // Porter's berths and CUBE's accounts are read together: the launcher takes a second to sample a berth.
  const berthsRead = berths_read(chris.porter, porter?.version ?? null, auth, get);
  const berths = async (): Promise<Pick<ChrisLive, 'berths' | 'berthsWhy' | 'berthsOff'>> => {
    const read = await berthsRead;
    if ('berths' in read) return { berths: read.berths, berthsWhy: null, berthsOff: false };
    return 'off' in read ? { berths: null, berthsWhy: null, berthsOff: true } : { berths: null, berthsWhy: read.why, berthsOff: false };
  };
  if (auth === null) return { at, cube, porter, accounts: null, accountsWhy: 'this host keeps no admin password for it', groups: null, ...await berths() };
  if (cube.admin !== true) return { at, cube, porter, accounts: null, accountsWhy: 'the admin does not sign in', groups: null, ...await berths() };
  const read = await accounts_read(api, auth, get);
  return 'accounts' in read ? { at, cube, porter, accounts: read.accounts, accountsWhy: null, groups: read.groups, ...await berths() } : { at, cube, porter, accounts: null, accountsWhy: read.why, groups: null, ...await berths() };
}
