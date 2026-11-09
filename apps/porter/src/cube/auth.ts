/**
 * @file The one thing the door does with a password: trade it for a token.
 *
 * CUBE is the identity provider. The porter posts the operator's password to
 * `auth-token/` once, keeps the token it gets back for the session it
 * starts, and holds no password anywhere — not in memory past this call,
 * not on disk, not on a child's argv.
 *
 * @module
 */
import { loginFailure_classify, loginFailure_lines, type LoginFailure } from '@fnndsc/cumin/login-failure';

/** What CUBE said to a login. */
export interface TokenMint {
  /** The token, when CUBE issued one. */
  token: string | null;
  /** Why not, when it did not: CUBE's status, or the network's word. */
  reason?: string;
}

/** The shape of `fetch` this module needs, so a test can stand one in. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Trades a password for a CUBE token.
 *
 * @param cubeUrl - The CUBE API base, trailing slash included.
 * @param username - The operator's CUBE username.
 * @param password - The operator's password; used here and nowhere else.
 * @param fetchLike - The HTTP client; the global `fetch` by default.
 * @returns The token, or the reason there is none.
 */
export async function cubeToken_mint(
  cubeUrl: string,
  username: string,
  password: string,
  fetchLike: FetchLike = fetch as unknown as FetchLike,
): Promise<TokenMint> {
  let response: { ok: boolean; status: number; json(): Promise<unknown> };
  try {
    response = await fetchLike(`${cubeUrl}auth-token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  } catch (error: unknown) {
    // fetch nests the network's word under `cause`: an untrusted certificate
    // or an unreachable host says so, as chell's login does (#965).
    const failure: LoginFailure = loginFailure_classify(error);
    if (failure.kind === 'tls' || failure.kind === 'network') return { token: null, reason: loginFailure_lines(failure, cubeUrl).join(' ') };
    return { token: null, reason: `CUBE unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!response.ok) {
    return { token: null, reason: response.status === 400 || response.status === 401 ? 'CUBE refused the login' : `CUBE answered ${response.status}` };
  }
  const body: unknown = await response.json();
  const token: unknown = typeof body === 'object' && body !== null ? (body as { token?: unknown }).token : undefined;
  if (typeof token !== 'string' || token.length === 0) {
    return { token: null, reason: 'CUBE answered without a token' };
  }
  return { token };
}

/** What CUBE says of the credentials a caller presents. */
export type AdminVerdict = 'admin' | 'not-admin' | 'refused' | 'unreachable';

/** The shape of an answer the admin check reads: its status, its body to read or let go. */
export interface AdminAnswer {
  status: number;
  json(): Promise<unknown>;
  /** The body stream, when the client has one; let go of when the answer is not read. */
  body?: { cancel(): Promise<void> } | null;
}

/** The shape of `fetch` the admin check needs, so a test can stand one in. */
export type AdminFetch = (url: string, init: { headers: Record<string, string>; redirect: 'manual' }) => Promise<AdminAnswer>;

/**
 * Asks CUBE whether the credentials presented are an administrator's. The
 * API root answers a signed-in caller with its links, and names the `admin`
 * link only to an administrator (`collection_links.admin`; it is the link the
 * plugin upload workflow reads, and fails without when the user is not an
 * admin). The root is a list of feeds, so one item is asked for (`?limit=1`;
 * the links do not change with it). CUBE does the verifying: the header is
 * handed over as it came, a token or Basic credentials, and neither is kept
 * or logged here. A redirect is not followed, so the header goes to the one
 * CUBE and nowhere it points; it counts as CUBE not answering. Every answer
 * not read is let go of.
 *
 * @param cubeUrl - The CUBE API base, trailing slash included.
 * @param authorization - The caller's `Authorization` header.
 * @param fetchLike - The HTTP client; the global `fetch` by default.
 * @returns `admin` when the root names the admin link, `not-admin` when it does not, `refused` when CUBE does not accept the credentials, `unreachable` when CUBE does not answer.
 */
export async function cubeAdmin_check(
  cubeUrl: string,
  authorization: string,
  fetchLike: AdminFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }),
): Promise<AdminVerdict> {
  let response: AdminAnswer;
  try {
    response = await fetchLike(`${cubeUrl}?limit=1`, { headers: { Authorization: authorization, Accept: 'application/json' }, redirect: 'manual' });
  } catch {
    return 'unreachable';
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch((): void => undefined);
    return response.status === 401 || response.status === 403 ? 'refused' : 'unreachable';
  }
  let body: unknown = null;
  try { body = await response.json(); } catch { body = null; }
  const links: unknown = typeof body === 'object' && body !== null ? (body as { collection_links?: unknown }).collection_links : undefined;
  const admin: unknown = typeof links === 'object' && links !== null ? (links as { admin?: unknown }).admin : undefined;
  return typeof admin === 'string' && admin.length > 0 ? 'admin' : 'not-admin';
}
