/**
 * @file The instance route: a daemon proves it is the instance its berth record names.
 *
 * A record's address can outlive its daemon, and the port can be taken by another program, another account's
 * among them. A client that holds the record asks `GET /instance?nonce=<64 lowercase hex>` and checks the answer
 * against the record's probe key (`berthInstance_probe`): only the instance that wrote the record can answer with
 * the proof. The request carries no secret and the answer gives none away.
 *
 * Key components:
 * - instanceRequest_serve: answers `GET /instance` with the proof, or a refusal.
 *
 * Typical usage:
 * ```ts
 * if (requestPath === '/instance') instanceRequest_serve(request, response, this.instance);
 * ```
 *
 * Dependencies: node:http (types only), ./berth.js (instanceProof_compute).
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { instanceProof_compute, type InstanceFacts } from './berth.js';

export type { InstanceFacts } from './berth.js';

/** The one query the route takes. */
const INSTANCE_QUERY: RegExp = /^\?nonce=([0-9a-f]{64})$/;

/**
 * Answers an instance probe: the proof for the nonce asked with, or a refusal. Only `GET`, and only a query of
 * exactly one nonce of 64 lowercase hex characters (400 otherwise), so nothing else enters the proof.
 *
 * @param request - The request, its path `/instance`.
 * @param response - Where the answer goes.
 * @param facts - This daemon's instance facts, or null before its record is written (then 404).
 *
 * @example
 * ```ts
 * if (requestPath === '/instance') instanceRequest_serve(request, response, this.instance);
 * ```
 */
export function instanceRequest_serve(request: IncomingMessage, response: ServerResponse, facts: InstanceFacts | null): void {
  const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
  if (request.method !== 'GET') {
    response.writeHead(405, { ...headers, allow: 'GET' });
    response.end('only GET');
    return;
  }
  if (facts === null) {
    response.writeHead(404, headers);
    response.end('not yet');
    return;
  }
  const url: string = request.url ?? '';
  const asked: RegExpExecArray | null = INSTANCE_QUERY.exec(url.slice(url.indexOf('?') < 0 ? url.length : url.indexOf('?')));
  if (asked === null) {
    response.writeHead(400, headers);
    response.end('a probe is ?nonce=<64 lowercase hex>');
    return;
  }
  response.writeHead(200, { ...headers, 'content-type': 'application/json' });
  response.end(JSON.stringify({ proof: instanceProof_compute(facts, asked[1]) }));
}
