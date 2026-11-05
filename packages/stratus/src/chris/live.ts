/**
 * @file What runs of a ChRIS a deploy put up, read from it (AEGIS's
 * a-change-is-a-loop, clause 1: render what stands, from its truth, with its
 * age): CUBE's API as the public reaches it and whether the admin signs in,
 * CUBE's accounts (the `all_users` group's members, every page), and porter's
 * health, open sessions and version. Read over HTTPS from this host with the
 * admin password the host keeps, so a READ session reads it: no bastion
 * session is made, nothing in the tenancy changes.
 *
 * @module
 */
import type { VmRecord } from '../vm/state.js';
import type { ChrisSecrets } from './compose.js';

/** A GET as this host makes it: the status and the JSON body, or null when nothing answered. */
export type HttpGet = (url: string, auth: { user: string; password: string } | null) => Promise<{ status: number; body: unknown } | null>;

/** A CUBE account as the ChRIS holds it. */
export interface ChrisAccount {
  readonly username: string;
  readonly email: string;
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
 * CUBE's accounts: the members of `all_users`, every page.
 *
 * @param api - CUBE's API root, ending in `/`.
 * @param auth - The admin's credentials.
 * @param get - How a GET is made.
 * @returns The accounts, or why they were not read.
 */
async function accounts_read(api: string, auth: { user: string; password: string }, get: HttpGet): Promise<{ accounts: ChrisAccount[] } | { why: string }> {
  const found = await get(`${api}groups/search/?name=all_users`, auth);
  if (found === null || found.status !== 200) return { why: `groups/search answered ${found?.status ?? 'nothing'}` };
  const group: unknown = page_read(found.body).results[0];
  const id: unknown = typeof group === 'object' && group !== null ? (group as Record<string, unknown>)['id'] : undefined;
  if (typeof id !== 'number') return { why: 'CUBE has no all_users group' };
  const accounts: ChrisAccount[] = [];
  let next: string | null = `${api}groups/${id}/users/?limit=${PAGE}`;
  while (next !== null) {
    const answered = await get(next, auth);
    if (answered === null || answered.status !== 200) return { why: `the group's users answered ${answered?.status ?? 'nothing'}` };
    const read = page_read(answered.body);
    for (const one of read.results) {
      // A group's member is a membership: CUBE names the account `user_username`, `user_email` (6.11.0).
      const row: Record<string, unknown> = typeof one === 'object' && one !== null ? one as Record<string, unknown> : {};
      const username: unknown = row['user_username'] ?? row['username'];
      const email: unknown = row['user_email'] ?? row['email'];
      if (typeof username === 'string') accounts.push({ username, email: typeof email === 'string' ? email : '' });
    }
    // CUBE names its next page by the address it was asked at, which behind the proxy may be plain http: the path is
    // kept and the origin is the one the public reaches.
    next = read.next === null ? null : new URL(`${new URL(read.next).pathname}${new URL(read.next).search}`, api).toString();
  }
  return { accounts: accounts.sort((a: ChrisAccount, b: ChrisAccount): number => a.username.localeCompare(b.username)) };
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
  if (auth === null) return { at, cube, porter, accounts: null, accountsWhy: 'this host keeps no admin password for it' };
  if (cube.admin !== true) return { at, cube, porter, accounts: null, accountsWhy: 'the admin does not sign in' };
  const read = await accounts_read(api, auth, get);
  return 'accounts' in read ? { at, cube, porter, accounts: read.accounts, accountsWhy: null } : { at, cube, porter, accounts: null, accountsWhy: read.why };
}
