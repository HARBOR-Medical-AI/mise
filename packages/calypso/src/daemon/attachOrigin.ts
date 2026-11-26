/**
 * @file Where an attach came from.
 *
 * A browser opens a socket to any address a page tells it to, and says
 * which page asked (`Origin`). The daemon's wire is for its own surface,
 * the page it serves itself, and for programs, which send no `Origin` at
 * all. A page from somewhere else that has got hold of a token is not
 * either, and its attach is refused before a word is exchanged. The token
 * is required as before in every case: this is a second question, not a
 * replacement for the first.
 *
 * The daemon's own page is the one served from the address the browser is
 * speaking to, so its `Origin` names the same host and port as the
 * request's own `Host`. Other origins are let in only by name
 * (`CALYPSO_ORIGINS`): a surface served from elsewhere (a development
 * server). A door in front (porter) checks the browser's origin against
 * its own name and relays the attach without one.
 *
 * @module
 */

/**
 * The origins named in the environment (`CALYPSO_ORIGINS`, comma-separated).
 *
 * @param env - The environment.
 * @returns The origins, normalised; what is not an origin is left out.
 */
export function attachOrigins_read(env: NodeJS.ProcessEnv): string[] {
  const named: string[] = [];
  for (const one of (env['CALYPSO_ORIGINS'] ?? '').split(',')) {
    const origin: string | null = origin_parse(one);
    if (origin !== null && !named.includes(origin)) named.push(origin);
  }
  return named;
}

/**
 * An origin as a browser writes it, or null for what is not one.
 *
 * @param text - What was written.
 * @returns Scheme, host and port.
 */
function origin_parse(text: string): string | null {
  try {
    const url: URL = new URL(text.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Whether an attach may go on, by where it says it came from.
 *
 * @param origin - The upgrade request's `Origin`; undefined from a program.
 * @param host - The upgrade request's `Host`: the address the client is speaking to.
 * @param named - The origins let in by name.
 * @returns True for no origin, the daemon's own page, or a named origin.
 */
export function attachOrigin_allowed(origin: string | undefined, host: string | undefined, named: ReadonlyArray<string>): boolean {
  if (origin === undefined) return true;
  const parsed: string | null = origin_parse(origin);
  if (parsed === null) return false;
  if (named.includes(parsed)) return true;
  // The daemon's own page: the same host and port the request itself was sent to.
  return host !== undefined && host !== '' && new URL(parsed).host.toLowerCase() === host.toLowerCase();
}
