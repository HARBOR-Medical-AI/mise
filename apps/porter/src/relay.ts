/**
 * @file How the porter relays a request to a session, and words what breaks.
 *
 * Everything under `/s/<key>/` goes to the session's daemon. A body the
 * browser sends (a file posted to `/vfs`) goes on as the stream it arrived
 * as: the porter parses nothing, holds nothing and refuses no size, so the
 * daemon's own limit on `POST /vfs` is the only one. An answer coming back is
 * counted as it passes, so when it stops part way the porter can say which
 * file, how far it got and why, and a socket closed before any answer is
 * told apart from a session that is not there.
 *
 * Key components:
 * - bodyStream_pass: the parser that hands every body on unread.
 * - relayTimeout_derive: no deadline on a request that carries a body.
 * - answer_watch: counts an answer and reports where it stopped.
 * - relayTarget_name: what a relayed request asked for, for the words.
 * - relayBreak_format: the line for an answer that stopped part way.
 * - relayFailure_describe: the words for a request the session never answered.
 *
 * Typical usage:
 * ```ts
 * await app.register(async (scope: FastifyInstance): Promise<void> => {
 *   bodyStream_pass(scope);
 *   scope.all('/s/:key/*', handler);
 * });
 * ```
 *
 * Dependencies: Fastify (a scope's content-type parsers) and Node's streams;
 * errors as @fastify/reply-from hands them over (a `code`, the socket's error
 * as `cause`).
 *
 * @module
 */
import type { IncomingMessage } from 'node:http';
import { Transform, pipeline, type Readable, type TransformCallback } from 'node:stream';

import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Makes a scope hand every request body on as the stream it arrived as.
 *
 * The scope's inherited parsers (JSON, text, forms) are removed and one
 * catch-all takes their place, so nothing is read, buffered or held to
 * Fastify's `bodyLimit` (1 MiB by default, which answered a posted file 413,
 * and a form-typed one 500). The body reaches `reply.from` as a stream, which
 * forwards it as it arrives.
 *
 * @param scope - The Fastify scope holding the relay's routes (an
 *   encapsulated plugin, so the rest of the porter keeps its parsers).
 *
 * @example
 * ```ts
 * await app.register(async (scope: FastifyInstance): Promise<void> => { bodyStream_pass(scope); scope.all('/s/:key/*', relay); });
 * ```
 */
export function bodyStream_pass(scope: FastifyInstance): void {
  scope.removeAllContentTypeParsers();
  scope.addContentTypeParser('*', (_request: FastifyRequest, payload: IncomingMessage, done: (error: Error | null, body?: unknown) => void): void => {
    done(null, payload);
  });
}

/**
 * The relay's deadline for one request.
 *
 * A request carrying a body (a file posted to `/vfs`) is answered only once
 * the daemon has put the file in CUBE, which at CUBE's pace can take many
 * minutes; the daemon's own stall watch is what fails a write that stops.
 * Any other request keeps the relay's default.
 *
 * @param method - The request's HTTP method.
 * @returns `0` (no deadline) for a method that carries a body, otherwise
 *   undefined (the default).
 *
 * @example
 * ```ts
 * relayTimeout_derive('POST'); // 0
 * relayTimeout_derive('GET'); // undefined
 * ```
 */
export function relayTimeout_derive(method: string): number | undefined {
  return method === 'GET' || method === 'HEAD' ? undefined : 0;
}

/**
 * Counts a session's answer as it passes, and reports where it stopped.
 *
 * The answer is piped through a counter, which is what goes to the browser.
 * When the session's side fails part way, `onBreak` hears how many bytes
 * had passed and why. A browser that leaves ends both sides too, and is
 * not reported: that is the person's choice, not a break.
 *
 * @param source - The session's answer, as the relay received it.
 * @param onBreak - Hears the bytes passed and the cause when the answer stops part way.
 * @returns The stream to send the browser.
 *
 * @example
 * ```ts
 * reply.send(answer_watch(res.stream, (sentBytes: number, cause: string): void => log(`${sentBytes}: ${cause}`)));
 * ```
 */
export function answer_watch(source: Readable, onBreak: (sentBytes: number, cause: string) => void): Readable {
  let sentBytes: number = 0;
  const counted: Transform = new Transform({
    transform: (chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void => {
      sentBytes += chunk.length;
      done(null, chunk);
    },
  });
  // Heard before the pipeline's own listener: a browser that left has
  // already destroyed the counter by the time the session's side errors.
  source.once('error', (error: Error): void => {
    if (!counted.destroyed) onBreak(sentBytes, errorCause_read(error));
  });
  pipeline(source, counted, (): void => undefined);
  return counted;
}

/**
 * Names what a relayed request asked for: the file for `/vfs`, else the path.
 *
 * @param rest - The path after `/s/<key>`, query included (never holding the
 *   attach token, which the porter adds only upstream).
 * @returns `/vfs <path>` for the byte route, otherwise the pathname.
 *
 * @example
 * ```ts
 * relayTarget_name('/vfs?path=%2Fhome%2Fdemo%2Fx.dcm'); // '/vfs /home/demo/x.dcm'
 * relayTarget_name('/assets/app.js?v=2'); // '/assets/app.js'
 * ```
 */
export function relayTarget_name(rest: string): string {
  const cut: number = rest.indexOf('?');
  const pathname: string = cut === -1 ? rest : rest.slice(0, cut);
  const asked: string | null = cut === -1 ? null : new URLSearchParams(rest.slice(cut + 1)).get('path');
  return pathname === '/vfs' && asked !== null ? `/vfs ${asked}` : pathname;
}

/**
 * The facts of one answer that stopped part way.
 *
 * @example
 * ```ts
 * const facts: RelayBreak = { target: '/vfs /home/demo/x.dcm', sentBytes: 6, statedBytes: 11, cause: 'other side closed' };
 * ```
 */
export interface RelayBreak {
  /** What was asked for, as `relayTarget_name` names it. */
  readonly target: string;
  /** Bytes that reached the browser's side before the stop. */
  readonly sentBytes: number;
  /** The size the session stated (its `content-length`), when it stated one. */
  readonly statedBytes?: number | undefined;
  /** Why the session's side stopped. */
  readonly cause: string;
}

/**
 * Words an answer that stopped part way, for the porter's log.
 *
 * @param facts - The answer's facts.
 * @returns One line: the file stopped arriving part way, which, how far, why.
 *
 * @example
 * ```ts
 * relayBreak_format({ target: '/vfs /home/demo/x.dcm', sentBytes: 6, statedBytes: 11, cause: 'other side closed' });
 * // 'the file stopped arriving part way: /vfs /home/demo/x.dcm after 6 of 11 bytes (other side closed)'
 * ```
 */
export function relayBreak_format(facts: RelayBreak): string {
  const of: string = facts.statedBytes === undefined ? 'of an unstated size' : `of ${facts.statedBytes}`;
  return `the file stopped arriving part way: ${facts.target} after ${facts.sentBytes} bytes ${of} (${facts.cause})`;
}

/**
 * Words a request the session never answered, for the browser and the log.
 *
 * reply-from calls its error handler only before the session's answer has
 * begun. A socket the session closed then (a daemon that cut the request
 * without a status) is not a session that is absent, and is said so.
 *
 * @param error - The error reply-from handed over.
 * @returns The sentence.
 *
 * @example
 * ```ts
 * relayFailure_describe(Object.assign(new Error('Undici Socket Error'), { code: 'UND_ERR_SOCKET', cause: new Error('other side closed') }));
 * // 'the session closed the connection before it answered (other side closed)'
 * ```
 */
export function relayFailure_describe(error: Error): string {
  const code: unknown = (error as Error & { code?: unknown }).code;
  const cause: string = errorCause_read(error);
  if (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET') {
    return `the session closed the connection before it answered (${cause})`;
  }
  return `the session did not answer: ${cause}`;
}

/**
 * The most telling words an error carries: its cause's message when it
 * wraps one (reply-from's errors wrap the socket's), else its own.
 *
 * @param error - The error.
 * @returns The message.
 */
function errorCause_read(error: Error): string {
  const cause: unknown = error.cause;
  if (cause instanceof Error && cause.message !== '') return cause.message;
  return error.message === '' ? 'no reason given' : error.message;
}
