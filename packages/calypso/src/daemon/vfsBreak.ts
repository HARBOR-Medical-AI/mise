/**
 * @file The daemon's one line about a file whose bytes stopped coming from CUBE.
 *
 * `GET /vfs` pipes CUBE's bytes to the browser. When that pipe breaks, the
 * browser sees only a failed request and the porter only a closed socket; the
 * daemon is the one place that knows which file it was, how far it got and
 * what CUBE's side said. This module words that as one line for the daemon's
 * own log. It names the file and the counts, never any of the file's bytes.
 *
 * Key components:
 * - VfsBreak: the facts of one broken transfer.
 * - vfsBreak_format: the log line for it.
 * - ErrorFacts, errorFacts_read: an error's message and code, whatever threw it.
 *
 * Typical usage:
 * ```ts
 * log(vfsBreak_format({ path, sentBytes, statedBytes: opened.size, elapsedMs, ...errorFacts_read(error) }));
 * ```
 *
 * Dependencies: none.
 *
 * @module
 */

/**
 * The facts of one transfer from CUBE that broke.
 *
 * @example
 * ```ts
 * const facts: VfsBreak = { path: '/home/demo/x.dcm', sentBytes: 4096, statedBytes: 9000, elapsedMs: 310, message: 'aborted', code: 'ECONNRESET' };
 * ```
 */
export interface VfsBreak {
  /** The ChRIS path asked for. */
  readonly path: string;
  /** Bytes handed to the response before the break. */
  readonly sentBytes: number;
  /** The size CUBE stated for the file, when it stated one. */
  readonly statedBytes?: number | undefined;
  /** Milliseconds from the request to the break. */
  readonly elapsedMs: number;
  /** What the failing side said. */
  readonly message: string;
  /** The error's code, when it carried one. */
  readonly code?: string | undefined;
}

/**
 * Words a broken transfer as one line for the daemon's log.
 *
 * @param facts - The transfer's facts.
 * @returns One line: the file, how many bytes went out of how many, how long
 *   it ran, and the cause with its code.
 *
 * @example
 * ```ts
 * vfsBreak_format({ path: '/home/demo/x.dcm', sentBytes: 0, elapsedMs: 12, message: 'socket hang up' });
 * // '[!] vfs: /home/demo/x.dcm: the file stopped arriving from CUBE after 0 bytes of an unstated size, 12 ms in: socket hang up'
 * ```
 */
export function vfsBreak_format(facts: VfsBreak): string {
  const size: string = facts.statedBytes === undefined ? 'an unstated size' : `${facts.statedBytes}`;
  const code: string = facts.code === undefined || facts.code === '' ? '' : ` [${facts.code}]`;
  return `[!] vfs: ${facts.path}: the file stopped arriving from CUBE after ${facts.sentBytes} bytes of ${size}, ${facts.elapsedMs} ms in: ${facts.message}${code}`;
}

/** What an error said and the code it carried. */
export interface ErrorFacts {
  /** The error's message, or the thrown value as text. */
  readonly message: string;
  /** The error's code, when it carried a string one. */
  readonly code?: string;
}

/**
 * The message and code of whatever was thrown.
 *
 * @param error - What a stream or a pipeline threw.
 * @returns Its message (the value itself when it is not an Error) and its
 *   `code` when it has a string one.
 *
 * @example
 * ```ts
 * errorFacts_read(Object.assign(new Error('aborted'), { code: 'ECONNRESET' })); // { message: 'aborted', code: 'ECONNRESET' }
 * ```
 */
export function errorFacts_read(error: unknown): ErrorFacts {
  const said: string = error instanceof Error ? error.message : String(error);
  const message: string = said === '' ? 'no reason given' : said;
  const code: unknown = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? { message, code } : { message };
}
