/**
 * @file The Kubernetes API over HTTPS with a kubeconfig's CA and client
 * certificate. The wire only; what is asked and what the answers mean are in
 * `cluster/verify.ts`, tested over recorded answers.
 *
 * @module
 */
import { request } from 'node:https';
import { KubeError, type KubeAccess, type KubeApi } from './kube.js';

/** How long one call may take, in milliseconds. */
const KUBE_TIMEOUT_MS: number = 30_000;

/** How many times a call answered 429 is made, in all. */
const BUSY_TRIES: number = 10;

/**
 * How long a 429 asks to be waited, from its Status (`details.retryAfterSeconds`), within one to ten seconds.
 *
 * @param text - The answer's body.
 * @returns Milliseconds.
 */
export function busyWait_parse(text: string): number {
  let seconds: number = 2;
  try {
    const asked: unknown = (JSON.parse(text) as { details?: { retryAfterSeconds?: unknown } }).details?.retryAfterSeconds;
    if (typeof asked === 'number') seconds = asked;
  } catch {
    // Not a Status: the default.
  }
  return Math.min(10, Math.max(1, seconds)) * 1000;
}

/**
 * One HTTPS call.
 *
 * @param access - How to reach the cluster.
 * @param method - The method.
 * @param path - The path.
 * @param body - A JSON body, for a POST.
 * @returns The status and text.
 */
function call(access: KubeAccess, method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const url: URL = new URL(path, access.server);
  const payload: string | undefined = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject): void => {
    const req = request(url, {
      method,
      timeout: KUBE_TIMEOUT_MS,
      ...(access.ca !== null ? { ca: access.ca } : {}),
      ...(access.cert !== null ? { cert: access.cert } : {}),
      ...(access.key !== null ? { key: access.key } : {}),
      headers: {
        accept: 'application/json, */*',
        ...(access.token !== null ? { authorization: `Bearer ${access.token}` } : {}),
        ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res): void => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer): void => { chunks.push(chunk); });
      res.on('end', (): void => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('timeout', (): void => { req.destroy(new Error(`${url.host}: no answer in ${KUBE_TIMEOUT_MS / 1000}s`)); });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/**
 * The Kubernetes API over HTTPS.
 *
 * @param access - How to reach the cluster.
 * @returns The calls.
 */
export function kubeApi_make(access: KubeAccess): KubeApi {
  const ok = async (method: string, path: string, body?: unknown): Promise<string> => {
    let answer = await call(access, method, path, body);
    // A server still settling answers 429 with how long to wait; it is waited out, briefly.
    for (let tries: number = 1; answer.status === 429 && tries < BUSY_TRIES; tries++) {
      await new Promise((resolve): void => { setTimeout(resolve, busyWait_parse(answer.text)); });
      answer = await call(access, method, path, body);
    }
    if (answer.status < 200 || answer.status >= 300) throw new KubeError(answer.status, `${method} ${path}: HTTP ${answer.status} ${answer.text.slice(0, 200)}`);
    return answer.text;
  };
  return {
    json_get: async (path: string): Promise<unknown> => JSON.parse(await ok('GET', path)) as unknown,
    text_get: (path: string): Promise<string> => ok('GET', path),
    json_post: async (path: string, body: unknown): Promise<unknown> => JSON.parse(await ok('POST', path, body)) as unknown,
    delete: async (path: string): Promise<void> => { await ok('DELETE', path); },
  };
}

/**
 * The HTTP status a URL answers with, trusting a CA beside the system's.
 *
 * @param url - The address.
 * @param ca - A CA in PEM, or null.
 * @returns The status.
 */
export function httpsStatus_get(url: string, ca: string | null): Promise<number> {
  return new Promise((resolve, reject): void => {
    const req = request(url, { method: 'GET', timeout: KUBE_TIMEOUT_MS, ...(ca !== null ? { ca } : {}) }, (res): void => {
      res.resume();
      res.on('end', (): void => resolve(res.statusCode ?? 0));
    });
    req.on('timeout', (): void => { req.destroy(new Error(`${url}: no answer in ${KUBE_TIMEOUT_MS / 1000}s`)); });
    req.on('error', reject);
    req.end();
  });
}
