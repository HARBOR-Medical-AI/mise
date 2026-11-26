/**
 * @file A failure of the keep whose words are safe to show.
 *
 * What the keep handles is secret: keys, passwords, the record that holds
 * them. An error raised near it can quote it without meaning to: a parse
 * error carries a fragment of what it could not parse, and a service's
 * message may echo what it was sent. So an error from the keep is shown to
 * the operator only when it is one of these, whose message was composed in
 * this code from names and status numbers, or through `keepFailure_describe`,
 * which takes nothing from any other error but its status and its code.
 *
 * Key components:
 * - KeepFault: an error of the keep with content-free words.
 * - keepFailure_describe: any error of the keep, in words that are safe.
 *
 * Typical usage:
 * ```ts
 * try { await keep(); } catch (error: unknown) { say(keepFailure_describe(error)); }
 * ```
 *
 * Dependencies: none.
 *
 * @module
 */

/**
 * An error of the keep whose message holds no secret content.
 *
 * @example
 * ```ts
 * throw new KeepFault('the secret mise-vm-store could not be read (HTTP 503)');
 * ```
 */
export class KeepFault extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeepFault';
  }
}

/** An error code as a service or the network gives one: capitals, digits and underscores. */
const SAFE_CODE: RegExp = /^[A-Za-z0-9_]{1,48}$/;

/**
 * What an error says of itself that cannot be content: its HTTP status and
 * its code.
 *
 * @param error - The thrown value.
 * @returns Those, in words; "no status" when it carries neither.
 *
 * @example
 * ```ts
 * const words: string = errorStatus_describe({ statusCode: 502 }); // 'HTTP 502'
 * ```
 */
export function errorStatus_describe(error: unknown): string {
  const read: { statusCode?: unknown; serviceCode?: unknown; code?: unknown } = (error ?? {}) as { statusCode?: unknown; serviceCode?: unknown; code?: unknown };
  const status: string | null = typeof read.statusCode === 'number' ? `HTTP ${read.statusCode}` : null;
  const named: unknown = read.serviceCode ?? read.code;
  const code: string | null = typeof named === 'string' && SAFE_CODE.test(named) ? named : null;
  if (status === null && code === null) return 'no status';
  return [status, code].filter((part: string | null): part is string => part !== null).join(' ');
}

/**
 * Any error of the keep, in words that are safe to show.
 *
 * @param error - The thrown value.
 * @returns A {@link KeepFault}'s own message; for anything else, only its
 *   status and code, since its message may quote what was kept.
 *
 * @example
 * ```ts
 * const reason: string = keepFailure_describe(new Error('unexpected token in "hunter2"')); // 'no status'
 * ```
 */
export function keepFailure_describe(error: unknown): string {
  return error instanceof KeepFault ? error.message : errorStatus_describe(error);
}
