/**
 * @file Red Hat's Assisted Installer, as `harbor-oci` drove it, over its REST
 * API (docs/stratus.adoc, D3). The same on every cloud.
 *
 * A Red Hat service account's client credentials buy a 15-minute token; the
 * exchange must not send a `scope`, or the installer answers 401. Clusters
 * are visible only to the identity that made them, so one daemon keeps to one
 * account. The pull secret is fetched by API each time a cluster is made and
 * never written down. The cluster is an external-platform one (`oci`, its
 * cloud controller external), user-managed networking, highly available;
 * the image is the minimal ISO.
 *
 * @module
 */
import type { Installer, InstallerCredentials, InstallerHost, InstallerIds, InstallStatus, PlatformManifest } from './installer.js';

/** Red Hat's token endpoint. */
export const RED_HAT_SSO_URL: string = 'https://sso.redhat.com/auth/realms/redhat-external/protocol/openid-connect/token';

/** OpenShift Cluster Manager's API. */
export const OCM_API: string = 'https://api.openshift.com';

/** The Assisted Installer's API. */
export const ASSISTED_API: string = `${OCM_API}/api/assisted-install/v2`;

/** How long before a token's end it is renewed, in milliseconds. */
const TOKEN_MARGIN_MS: number = 60_000;

/** A fetch, as the installer calls it; a test hands in its own. */
export type InstallerFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; text: () => Promise<string> }>;

/** How the installer is made. */
export interface AssistedOptions {
  /** The service account's client id and secret, read on the host. */
  readonly account: () => { clientId: string; clientSecret: string };
  /** The nodes' SSH public key, read on the host. */
  readonly sshPublicKey: () => string;
  readonly fetch?: InstallerFetch;
}

/** An installer answer that was not what was wanted. */
export class InstallerError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'InstallerError';
  }
}

/**
 * Reads a service account file: `RH_CLIENT_ID=` and `RH_CLIENT_SECRET=` lines.
 *
 * @param text - The file.
 * @returns The id and secret.
 * @throws Error - When either is missing.
 */
export function serviceAccount_read(text: string): { clientId: string; clientSecret: string } {
  const value = (key: string): string | undefined => text.split('\n').map((line: string): string => line.trim().replace(/^export\s+/, ''))
    .find((line: string): boolean => line.startsWith(`${key}=`))?.slice(key.length + 1).replace(/^["']|["']$/g, '');
  const clientId: string | undefined = value('RH_CLIENT_ID');
  const clientSecret: string | undefined = value('RH_CLIENT_SECRET');
  if (clientId === undefined || clientSecret === undefined || clientId === '' || clientSecret === '') throw new Error('the service account file lacks RH_CLIENT_ID or RH_CLIENT_SECRET');
  return { clientId, clientSecret };
}

/** The Assisted Installer, as the build's steps call it. */
export class AssistedInstaller implements Installer {
  readonly id: string = 'assisted';
  private token: { value: string; until: number } | null = null;
  private readonly fetchFn: InstallerFetch;

  constructor(private readonly options: AssistedOptions) {
    this.fetchFn = options.fetch ?? (async (url, init) => {
      const response: Response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
      return { status: response.status, text: () => response.text() };
    });
  }

  /** A token good for at least another minute. */
  private async token_get(): Promise<string> {
    if (this.token !== null && this.token.until - Date.now() > TOKEN_MARGIN_MS) return this.token.value;
    const { clientId, clientSecret } = this.options.account();
    // No `scope`: with one, the installer answers 401.
    const body: string = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString();
    const answer = await this.fetchFn(RED_HAT_SSO_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const text: string = await answer.text();
    if (answer.status !== 200) throw new InstallerError(answer.status, `Red Hat token: HTTP ${answer.status}`);
    const json = JSON.parse(text) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, until: Date.now() + json.expires_in * 1000 };
    return this.token.value;
  }

  /**
   * One call to Red Hat, with the token.
   *
   * @param method - The method.
   * @param url - The full address.
   * @param ok - The statuses that are success.
   * @param body - A JSON body.
   * @returns The text.
   */
  private async call(method: string, url: string, ok: ReadonlyArray<number>, body?: unknown): Promise<string> {
    const answer = await this.fetchFn(url, {
      method,
      headers: { authorization: `Bearer ${await this.token_get()}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text: string = await answer.text();
    if (!ok.includes(answer.status)) {
      let reason: string = text.slice(0, 200);
      try { reason = (JSON.parse(text) as { reason?: string }).reason ?? reason; } catch { /* not JSON */ }
      throw new InstallerError(answer.status, `${method} ${url.replace(ASSISTED_API, '')}: HTTP ${answer.status}: ${reason}`);
    }
    return text;
  }

  /** The account's pull secret, fetched now and never kept. */
  private async pullSecret_get(): Promise<string> {
    const text: string = await this.call('POST', `${OCM_API}/api/accounts_mgmt/v1/access_token`, [200], {});
    const secret = JSON.parse(text) as { auths?: Record<string, unknown> };
    if (secret.auths === undefined || Object.keys(secret.auths).length === 0) throw new Error('Red Hat gave no pull secret for this account');
    return text;
  }

  async cluster_create(request: { name: string; baseDomain: string; version: string; controlPlaneCount: number }): Promise<InstallerIds> {
    const existing = JSON.parse(await this.call('GET', `${ASSISTED_API}/clusters`, [200])) as Array<{ id: string; name: string; base_dns_domain: string }>;
    if (existing.some((cluster): boolean => cluster.name === request.name && cluster.base_dns_domain === request.baseDomain)) {
      throw new Error(`a cluster ${request.name}.${request.baseDomain} already exists at Red Hat that this cluster did not record`);
    }
    const pullSecret: string = await this.pullSecret_get();
    const sshPublicKey: string = this.options.sshPublicKey().trim();
    const cluster = JSON.parse(await this.call('POST', `${ASSISTED_API}/clusters`, [201], {
      name: request.name, base_dns_domain: request.baseDomain, openshift_version: request.version,
      cpu_architecture: 'x86_64', high_availability_mode: 'Full', control_plane_count: request.controlPlaneCount, user_managed_networking: true,
      platform: { type: 'external', external: { platform_name: 'oci', cloud_controller_manager: 'External' } },
      pull_secret: pullSecret, ssh_public_key: sshPublicKey,
    })) as { id: string };
    const infraEnv = JSON.parse(await this.call('POST', `${ASSISTED_API}/infra-envs`, [201], {
      name: `${request.name}-infra-env`, cluster_id: cluster.id, pull_secret: pullSecret, ssh_authorized_key: sshPublicKey,
      image_type: 'minimal-iso', cpu_architecture: 'x86_64', openshift_version: request.version,
    })) as { id: string };
    return { clusterId: cluster.id, infraEnvId: infraEnv.id };
  }

  async isoUrl_get(ids: InstallerIds): Promise<{ url: string; expires: string }> {
    const image = JSON.parse(await this.call('GET', `${ASSISTED_API}/infra-envs/${ids.infraEnvId}/downloads/image-url`, [200])) as { url: string; expires_at: string };
    return { url: image.url, expires: image.expires_at };
  }

  async manifests_upload(ids: InstallerIds, manifests: ReadonlyArray<PlatformManifest>): Promise<void> {
    const existing = JSON.parse(await this.call('GET', `${ASSISTED_API}/clusters/${ids.clusterId}/manifests`, [200])) as Array<{ folder: string; file_name: string }>;
    for (const manifest of manifests) {
      if (existing.some((entry): boolean => entry.folder === 'manifests' && entry.file_name === manifest.name)) {
        await this.call('DELETE', `${ASSISTED_API}/clusters/${ids.clusterId}/manifests?folder=manifests&file_name=${encodeURIComponent(manifest.name)}`, [200, 204, 404]);
      }
      await this.call('POST', `${ASSISTED_API}/clusters/${ids.clusterId}/manifests`, [201], { folder: 'manifests', file_name: manifest.name, content: Buffer.from(manifest.content, 'utf-8').toString('base64') });
    }
  }

  async hosts_list(ids: InstallerIds): Promise<InstallerHost[]> {
    const hosts = JSON.parse(await this.call('GET', `${ASSISTED_API}/infra-envs/${ids.infraEnvId}/hosts`, [200])) as Array<{ id: string; requested_hostname?: string; status: string; role?: string; created_at?: string }>;
    return hosts.map((host): InstallerHost => ({
      id: host.id,
      name: (host.requested_hostname ?? host.id).split('.')[0] as string,
      zone: '',
      role: host.role === 'master' || host.role === 'worker' ? host.role : 'auto',
      registered: host.created_at ?? '',
      ready: host.status === 'known',
    })).sort((a: InstallerHost, b: InstallerHost): number => a.name.localeCompare(b.name));
  }

  async role_set(ids: InstallerIds, host: InstallerHost, role: 'master' | 'worker'): Promise<void> {
    await this.call('PATCH', `${ASSISTED_API}/infra-envs/${ids.infraEnvId}/hosts/${host.id}`, [200, 201], { host_role: role });
  }

  async install_start(ids: InstallerIds): Promise<void> {
    await this.call('POST', `${ASSISTED_API}/clusters/${ids.clusterId}/actions/install`, [202]);
  }

  async install_status(ids: InstallerIds): Promise<InstallStatus> {
    const cluster = JSON.parse(await this.call('GET', `${ASSISTED_API}/clusters/${ids.clusterId}`, [200])) as { status: string; status_info?: string; progress?: { total_percentage?: number } };
    const percent: number = cluster.progress?.total_percentage ?? 0;
    const note: string = cluster.status_info ?? cluster.status;
    if (cluster.status === 'installed') return { state: 'installed', percent: 100, note };
    if (cluster.status === 'ready') return { state: 'ready', percent, note };
    if (cluster.status === 'error' || cluster.status === 'cancelled') return { state: 'error', percent, note: `${cluster.status}: ${note}` };
    if (['insufficient', 'pending-for-input', 'adding-hosts'].includes(cluster.status)) return { state: 'pending', percent, note: `${cluster.status}: ${note}` };
    return { state: 'installing', percent, note };
  }

  async kubeconfig_get(ids: InstallerIds): Promise<string> {
    return this.call('GET', `${ASSISTED_API}/clusters/${ids.clusterId}/downloads/credentials?file_name=kubeconfig`, [200]);
  }

  async credentials_get(ids: InstallerIds): Promise<InstallerCredentials> {
    const credentials = JSON.parse(await this.call('GET', `${ASSISTED_API}/clusters/${ids.clusterId}/credentials`, [200])) as { username: string; password: string; console_url: string };
    return { username: credentials.username, password: credentials.password, consoleUrl: credentials.console_url };
  }

  async cluster_delete(ids: InstallerIds): Promise<void> {
    // An infra-env refuses to go while hosts are registered to it ("3 hosts
    // are still associated"), so its hosts are deregistered first; then the
    // infra-env, then the cluster. Each is gone already when it answers 404,
    // which is what lets a teardown that stopped part way run again.
    const listed: string = await this.call('GET', `${ASSISTED_API}/infra-envs/${ids.infraEnvId}/hosts`, [200, 404]);
    const hosts = (listed.trim().startsWith('[') ? JSON.parse(listed) : []) as Array<{ id: string }>;
    for (const host of hosts) await this.call('DELETE', `${ASSISTED_API}/infra-envs/${ids.infraEnvId}/hosts/${host.id}`, [204, 404]);
    await this.call('DELETE', `${ASSISTED_API}/infra-envs/${ids.infraEnvId}`, [204, 404]);
    await this.call('DELETE', `${ASSISTED_API}/clusters/${ids.clusterId}`, [204, 404]);
  }
}
