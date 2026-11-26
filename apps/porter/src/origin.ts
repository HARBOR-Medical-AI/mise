/**
 * @file Where a request that rides the door's cookie came from.
 *
 * A browser sends the door's cookie with any request to the door, whoever
 * wrote the page that made it. So a request that changes something, or
 * opens the session's wire, on the strength of that cookie alone must also
 * say where it came from (`Origin`), and that must be the door itself. A
 * program that carries a bearer token and no cookie is not a browser being
 * steered: it is not asked.
 *
 * What the door itself is cannot be read off a request: behind a proxy the
 * request names whatever the proxy was told. The operator says it
 * (`PORTER_PUBLIC_ORIGIN`). Unsaid, the door is only what it listens on,
 * which is right for a porter on loopback and refuses every browser that
 * reaches it by another name, until the operator says.
 *
 * @module
 */

/** The methods that change nothing, and so are never asked where they came from. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The hosts that are this machine itself. */
const LOOPBACK_HOSTS: ReadonlyArray<string> = ['127.0.0.1', 'localhost', '[::1]'];

/**
 * An origin as a browser writes it: scheme, host and port, nothing after.
 *
 * @param text - What was written.
 * @returns The origin, or null for what is not one.
 */
export function origin_normalise(text: string): string | null {
  try {
    const url: URL = new URL(text.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username !== '' || url.password !== '') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The origins the door answers as, and whether the operator named them. */
export interface DoorOrigins {
  /** The origins, normalised. */
  readonly origins: ReadonlyArray<string>;
  /** True when they are the operator's (`PORTER_PUBLIC_ORIGIN`); false when they are only where the door listens. */
  readonly named: boolean;
}

/**
 * Resolves the origins the door answers as.
 *
 * @param configured - `PORTER_PUBLIC_ORIGIN`: one origin or several, comma-separated; undefined or empty when unsaid.
 * @param port - The port the door listens on.
 * @returns The origins: the operator's, or this machine's own names at that port.
 * @throws {Error} When `PORTER_PUBLIC_ORIGIN` holds something that is not an origin.
 */
export function doorOrigins_resolve(configured: string | undefined, port: number): DoorOrigins {
  const given: string[] = (configured ?? '').split(',').map((one: string): string => one.trim()).filter((one: string): boolean => one !== '');
  if (given.length === 0) {
    // Written as a browser writes them: a default port is left off (`http://127.0.0.1`, not `:80`).
    return { origins: LOOPBACK_HOSTS.map((host: string): string => new URL(`http://${host}:${port}`).origin), named: false };
  }
  const origins: string[] = [];
  for (const one of given) {
    const origin: string | null = origin_normalise(one);
    if (origin === null) throw new Error(`PORTER_PUBLIC_ORIGIN is not an origin: ${one} (write it as the browser's address bar shows it, e.g. https://porter.example.org)`);
    if (!origins.includes(origin)) origins.push(origin);
  }
  return { origins, named: true };
}

/**
 * Whether a method changes nothing.
 *
 * @param method - The request's method.
 * @returns True for GET, HEAD and OPTIONS.
 */
export function method_isSafe(method: string | undefined): boolean {
  return SAFE_METHODS.has((method ?? 'GET').toUpperCase());
}

/**
 * An `Origin` header as a browser sends one: exactly one origin, already
 * in its serialized form (lower case, no path, no default port, nothing
 * around it). What an operator types is forgiven its spelling
 * (`origin_normalise`); what arrives on a request is not, since a browser
 * never spells it another way and anything else was written by hand.
 *
 * @param header - The request's `Origin`, as sent.
 * @returns The origin, or null when none was sent, several were, or it is not a serialized origin.
 */
export function originHeader_read(header: string | string[] | undefined): string | null {
  if (header === undefined) return null;
  if (Array.isArray(header) && header.length !== 1) return null;
  const sent: string = Array.isArray(header) ? (header[0] as string) : header;
  return origin_normalise(sent) === sent ? sent : null;
}

/**
 * Whether a request said it came from the door.
 *
 * @param header - The request's `Origin`, as sent.
 * @param allowed - The origins the door answers as.
 * @returns True only when one serialized `Origin` was sent and is one of them.
 */
export function origin_isDoors(header: string | string[] | undefined, allowed: ReadonlyArray<string>): boolean {
  const origin: string | null = originHeader_read(header);
  return origin !== null && allowed.includes(origin);
}

/**
 * The words a refused request is told.
 *
 * @param header - The `Origin` it sent, if any.
 * @param origins - The origins the door answers as.
 * @returns One line.
 */
export function originRefusal_say(header: string | string[] | undefined, origins: DoorOrigins): string {
  const sent: string | undefined = Array.isArray(header) ? header.join(', ') : header;
  const from: string = sent === undefined ? 'a request that does not say where it came from' : `a request from ${sent}`;
  const fix: string = origins.named ? '' : '; if this door is reached by another name, set PORTER_PUBLIC_ORIGIN to it';
  return `the door does not take ${from}: it answers as ${origins.origins.join(', ')}${fix}`;
}
