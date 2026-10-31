/**
 * @file The installer driver: what turns machines into a cluster, the same on
 * every cloud (docs/stratus.adoc, D3). Red Hat's Assisted Installer is the
 * first; a hub's Hive or a Cluster API provider would be another.
 *
 * The build's steps call it for the cluster record, the discovery image,
 * the platform manifests, the hosts as they register, the install, and the
 * kubeconfig at the end. Every call is a request and an answer; a wait is
 * the step's own polling, so a step can be picked up again after a restart
 * from the ids it recorded.
 *
 * @module
 */

/** The installer's handles on a cluster. */
export interface InstallerIds {
  readonly clusterId: string;
  /** The discovery image's environment, which the hosts register with. */
  readonly infraEnvId: string;
}

/** One machine as the installer sees it. */
export interface InstallerHost {
  /** The installer's id for it. */
  id: string;
  /** Its name (the instance's). */
  name: string;
  /** The availability domain it runs in, when the installer says. */
  zone: string;
  /** Its role, once assigned. */
  role: 'master' | 'worker' | 'auto';
  /** When it registered, ISO 8601. */
  registered: string;
  /** Whether the installer's checks on it pass (Assisted: status `known`). */
  ready: boolean;
}

/** How far the install has come. */
export interface InstallStatus {
  /** `ready` is waiting to be started; the rest as named. */
  state: 'pending' | 'ready' | 'installing' | 'installed' | 'error';
  percent: number;
  /** The installer's own words on where it is. */
  note: string;
}

/** A platform manifest the cloud asks the installer to apply (OCI: its cloud controller and CSI driver). */
export interface PlatformManifest {
  name: string;
  content: string;
}

/** The cluster's administrator sign-in, kept on the host only. */
export interface InstallerCredentials {
  username: string;
  password: string;
  consoleUrl: string;
}

/** The installer, as the build's steps call it. */
export interface Installer {
  /** Its id (`assisted`, `fake`). */
  readonly id: string;
  /** Makes the cluster record and its infra-env. */
  cluster_create(request: { name: string; baseDomain: string; version: string; controlPlaneCount: number }): Promise<InstallerIds>;
  /** The discovery image's address and how long it holds. */
  isoUrl_get(ids: InstallerIds): Promise<{ url: string; expires: string }>;
  /** Sends the platform's manifests, replacing any of the same name. */
  manifests_upload(ids: InstallerIds, manifests: ReadonlyArray<PlatformManifest>): Promise<void>;
  /** The hosts registered so far. */
  hosts_list(ids: InstallerIds): Promise<InstallerHost[]>;
  /** Gives a host its role. */
  role_set(ids: InstallerIds, host: InstallerHost, role: 'master' | 'worker'): Promise<void>;
  /** Starts the install. */
  install_start(ids: InstallerIds): Promise<void>;
  /** Where the install stands. */
  install_status(ids: InstallerIds): Promise<InstallStatus>;
  /** The cluster's kubeconfig, once installed. */
  kubeconfig_get(ids: InstallerIds): Promise<string>;
  /** The administrator's sign-in, once installed. */
  credentials_get(ids: InstallerIds): Promise<InstallerCredentials>;
  /** Removes the infra-env and the cluster record; one already gone is no error. */
  cluster_delete(ids: InstallerIds): Promise<void>;
}
