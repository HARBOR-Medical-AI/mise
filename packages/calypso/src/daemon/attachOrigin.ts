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
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '' ? url.origin : null;
  } catch {
    return null;
  }
}

/** The port a scheme means when none is written. */
function schemePort_default(protocol: string): string {
  return protocol === 'https:' ? '443' : '80';
}

/**
 * Whether an attach may go on, by where it says it came from.
 *
 * @param origin - The upgrade request's `Origin`; undefined from a program.
 * @param host - The upgrade request's `Host`: the address the client is speaking to.
 * @param named - The origins let in by name.
 * @returns True for no origin, the daemon's own page, or a named origin.
 */
export function attachOrigin_allowed(origin: string | string[] | undefined, host: string | undefined, named: ReadonlyArray<string>): boolean {
  if (origin === undefined) return true;
  // One origin, as a browser serializes it; anything else was written by hand.
  if (Array.isArray(origin) || origin_parse(origin) !== origin) return false;
  if (named.includes(origin)) return true;
  // The daemon's own page: the same host and the same port the request itself was sent to. A port left
  // off either is the one the page's scheme means, since that is the port the browser spoke to.
  if (host === undefined || host === '') return false;
  let page: URL;
  let spoken: URL;
  try {
    page = new URL(origin);
    spoken = new URL(`${page.protocol}//${host}`);
  } catch {
    return false;
  }
  if (spoken.host === '' || spoken.pathname !== '/' || spoken.username !== '' || spoken.search !== '' || spoken.hash !== '') return false;
  const port = (url: URL): string => (url.port === '' ? schemePort_default(page.protocol) : url.port);
  return page.hostname === spoken.hostname && port(page) === port(spoken);
}
