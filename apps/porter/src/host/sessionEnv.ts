/**
 * @file The environment a session is started with.
 *
 * A session runs a shell for whoever signed in, and a shell reads its
 * environment (`${NAME}`). So a session is never given porter's own
 * environment, which holds the key that signs every door cookie
 * (`PORTER_SECRET`) and whatever else the operator put there. It is given
 * the names on a list, each there because a session needs it, and its own
 * folders on top. A name not on the list does not reach a session; nor
 * does the operator's host policy (`CALYPSO_HOST_CONTROL`): what a porter
 * session may do on the host is porter's to say, on the command line.
 *
 * Key components:
 * - sessionEnv_build: the environment one session is started with.
 * - sessionEnv_withheld: the names withheld for not being a plain address, said at start.
 * - address_isPlain: whether a value is a web address that carries no credential.
 *
 * Typical usage:
 * ```ts
 * const env: NodeJS.ProcessEnv = sessionEnv_build(process.env, { HOME: home, TMPDIR: tmp });
 * ```
 *
 * Dependencies: none.
 *
 * @module
 */

/** The names a session is given as they are, each because the session needs it. */
const SESSION_NAMES: ReadonlySet<string> = new Set([
  // Finding programs, and who the account is.
  'PATH', 'USER', 'LOGNAME', 'SHELL',
  // Language, time zone and terminal, for what the session prints.
  'LANG', 'LANGUAGE', 'TZ', 'TERM', 'NO_COLOR',
  'LC_ALL', 'LC_CTYPE', 'LC_COLLATE', 'LC_MESSAGES', 'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME',
  // The editor `edit` opens.
  'EDITOR', 'VISUAL',
  // The certificates Node trusts, for a CUBE behind a private authority.
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // The hosts reached without the proxy: a list of names, nothing secret.
  'NO_PROXY', 'no_proxy',
  // The daemon's own settings that are the operator's to make: where ARGUS is served from, no terminals, the upload ceiling.
  'CALYPSO_WEB_ROOT', 'CALYPSO_NO_PTY', 'CALYPSO_UPLOAD_HELD',
]);

/**
 * The names a session is given only as a plain address: a proxy the host
 * reaches the CUBE through, and the door's address `url` writes links with.
 */
const SESSION_ADDRESSES: ReadonlySet<string> = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'CHELL_DOOR']);

/** Porter's own names, never given to a session whatever the lists say. */
const PORTER_PREFIX: string = 'PORTER_';

/**
 * Whether a value is a plain web address: `http:` or `https:`, a host and
 * perhaps a port, and nothing else, written exactly as the address is.
 * A user, password, path, query or fragment can carry a credential, and a
 * value a reader would normalise (a backslash, spaces, a line break) is not
 * passed on as something another reader may take differently: the value
 * must already be its own origin, with at most a closing `/`.
 *
 * @param value - The value as set.
 * @returns True for a plain address.
 *
 * @example
 * ```ts
 * address_isPlain('http://proxy.example.org:3128'); // true
 * address_isPlain('http://me:pw@proxy.example.org'); // false
 * address_isPlain('http://proxy.example.org:80');   // true
 * address_isPlain('https://door.example.org/t/abc'); // false
 * ```
 */
export function address_isPlain(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // An explicit default port is plain too (`:80` for http, `:443` for https), though the origin leaves it out.
  const forms: string[] = [url.origin, `${url.protocol}//${url.hostname}:${url.protocol === 'http:' ? '80' : '443'}`];
  return forms.some((form: string): boolean => value === form || value === `${form}/`);
}

/**
 * The names of porter's environment a session would be given but is not,
 * because their address is not plain: said once at porter's start, by name,
 * never by value.
 *
 * @param parent - Porter's environment.
 * @returns The names withheld, sorted.
 *
 * @example
 * ```ts
 * sessionEnv_withheld({ HTTPS_PROXY: 'http://me:pw@proxy' }); // ['HTTPS_PROXY']
 * ```
 */
export function sessionEnv_withheld(parent: NodeJS.ProcessEnv): string[] {
  return Object.entries(parent)
    .filter(([name, value]: [string, string | undefined]): boolean => SESSION_ADDRESSES.has(name) && value !== undefined && !address_isPlain(value))
    .map(([name]: [string, string | undefined]): string => name)
    .sort();
}

/**
 * The environment a session is started with: the names of porter's it is
 * given, then the session's own, which win. A `PORTER_` name never reaches
 * it, from either side.
 *
 * @param parent - Porter's environment.
 * @param own - The session's own names (its folders and settings).
 * @returns The session's environment.
 *
 * @example
 * ```ts
 * sessionEnv_build({ PATH: '/usr/bin', PORTER_SECRET: 's' }, { TMPDIR: '/run/x/tmp' });
 * // { PATH: '/usr/bin', TMPDIR: '/run/x/tmp' }
 * ```
 */
export function sessionEnv_build(parent: NodeJS.ProcessEnv, own: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined || name.startsWith(PORTER_PREFIX)) continue;
    if (SESSION_NAMES.has(name) || (SESSION_ADDRESSES.has(name) && address_isPlain(value))) env[name] = value;
  }
  for (const [name, value] of Object.entries(own)) {
    if (!name.startsWith(PORTER_PREFIX)) env[name] = value;
  }
  return env;
}
