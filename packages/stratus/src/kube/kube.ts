/**
 * @file The Kubernetes driver's beginning: a cluster reached with its
 * kubeconfig, over the Kubernetes API (docs/stratus.adoc, D3, D4). The same on
 * every cloud. What `verify` needs is here; the tree's `cluster/` comes with
 * step 5.
 *
 * @module
 */
import { load } from 'js-yaml';

/** How a kubeconfig reaches its cluster: the server, its CA, and who we are. */
export interface KubeAccess {
  /** The API server's address. */
  readonly server: string;
  /** The CA that signs the server's certificate, PEM, or null to trust the system's. */
  readonly ca: string | null;
  /** A client certificate and key, PEM. */
  readonly cert: string | null;
  readonly key: string | null;
  /** A bearer token. */
  readonly token: string | null;
}

/** A Kubernetes API answer that was not a success. */
export class KubeError extends Error {
  /**
   * @param status - The HTTP status.
   * @param message - What the server said.
   */
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'KubeError';
  }
}

/** The Kubernetes API, as `verify` calls it. */
export interface KubeApi {
  /** A path's JSON (`/api/v1/nodes`). */
  json_get(path: string): Promise<unknown>;
  /** A path's text (`/readyz`, a pod's log). */
  text_get(path: string): Promise<string>;
  /** Creates an object under a path. */
  json_post(path: string, body: unknown): Promise<unknown>;
  /** Deletes the object at a path. */
  delete(path: string): Promise<void>;
}

/** The parts of a kubeconfig read. */
interface Kubeconfig {
  'current-context'?: string;
  contexts?: Array<{ name: string; context: { cluster: string; user: string } }>;
  clusters?: Array<{ name: string; cluster: { server: string; 'certificate-authority-data'?: string } }>;
  users?: Array<{ name: string; user: { 'client-certificate-data'?: string; 'client-key-data'?: string; token?: string } }>;
}

/**
 * Reads a kubeconfig: the current context's cluster and user.
 *
 * @param text - The kubeconfig.
 * @returns How to reach the cluster.
 * @throws Error - When it names no cluster to reach.
 */
export function kubeconfig_read(text: string): KubeAccess {
  const config: Kubeconfig = (load(text) ?? {}) as Kubeconfig;
  const context = config.contexts?.find((entry): boolean => entry.name === config['current-context']) ?? config.contexts?.[0];
  const cluster = config.clusters?.find((entry): boolean => entry.name === context?.context.cluster) ?? config.clusters?.[0];
  const user = config.users?.find((entry): boolean => entry.name === context?.context.user) ?? config.users?.[0];
  if (cluster === undefined || typeof cluster.cluster?.server !== 'string') throw new Error('the kubeconfig names no cluster server');
  const pem = (data: string | undefined): string | null => (data === undefined ? null : Buffer.from(data, 'base64').toString('utf-8'));
  return {
    server: cluster.cluster.server.replace(/\/$/, ''),
    ca: pem(cluster.cluster['certificate-authority-data']),
    cert: pem(user?.user['client-certificate-data']),
    key: pem(user?.user['client-key-data']),
    token: user?.user.token ?? null,
  };
}
