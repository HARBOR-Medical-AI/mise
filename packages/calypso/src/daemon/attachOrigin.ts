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
 * speaking to, over the plain HTTP the daemon speaks: its `Origin` is
 * `http://` and the request's own `Host`. Other origins are let in only by
 * name (`CALYPSO_ORIGINS`): a surface served from elsewhere (a development
 * server), or the daemon's page reached through something that changes its
 * address (a proxy that ends TLS). A door in front (porter) checks the browser's origin against
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

/**
 * Whether an attach may go on, by where it says it came from.
 *
 * The daemon's own page is the one served from the address this very
 * request was sent to, and the daemon speaks plain HTTP: so the page's
 * origin is `http://` and the request's own `Host`, exactly. Nothing is
 * inferred from the page's side. A page reached another way (through a
 * proxy that ends TLS, under another name) is not the daemon's own as far
 * as the daemon can tell, and is let in by name or not at all.
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
  if (host === undefined || host === '') return false;
  let spoken: URL;
  try {
    spoken = new URL(`http://${host}`);
  } catch {
    return false;
  }
  // A Host that is more than a host and a port is not compared at all.
  if (spoken.pathname !== '/' || spoken.username !== '' || spoken.password !== '' || spoken.search !== '' || spoken.hash !== '' || host.includes('/') || host.includes('?') || host.includes('#') || host.includes('@')) return false;
  return origin === spoken.origin;
}

/** The one WebSocket version a browser speaks, and the only one this daemon takes. */
const WEBSOCKET_VERSION: string = '13';

/** The headers of an upgrade that the check reads. */
export interface AttachHeaders {
  /** `Origin`, as node gives it: several lines joined by a comma. */
  origin?: string | undefined;
  /** `Host`. */
  host?: string | undefined;
  /** `Sec-WebSocket-Version`. */
  'sec-websocket-version'?: string | string[] | undefined;
  /** `Sec-WebSocket-Origin`: where older drafts of the protocol said the page's origin. */
  'sec-websocket-origin'?: string | string[] | undefined;
}

/**
 * Whether an upgrade may go on, and why not.
 *
 * The origin is read from `Origin`, which is where version 13 says it. An
 * older draft said it in `Sec-WebSocket-Origin`; rather than read two
 * fields and choose, the daemon takes version 13 only, and an upgrade that
 * carries the older field at all is refused, so there is never a second
 * field that says something else.
 *
 * @param headers - The upgrade request's headers.
 * @param named - The origins let in by name.
 * @returns Null when it may go on; otherwise the reason, for the log.
 */
export function attachRequest_refusal(headers: AttachHeaders, named: ReadonlyArray<string>): string | null {
  if (headers['sec-websocket-version'] !== WEBSOCKET_VERSION) return `WebSocket version ${String(headers['sec-websocket-version'])} is not taken (only ${WEBSOCKET_VERSION})`;
  if (headers['sec-websocket-origin'] !== undefined) return 'it carries Sec-WebSocket-Origin, a second place to say where it came from';
  if (!attachOrigin_allowed(headers.origin, headers.host, named)) return `it came from ${String(headers.origin)}: not this daemon's own page, and not named in CALYPSO_ORIGINS`;
  return null;
}
