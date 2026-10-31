/**
 * @file The stratus session: who it is, where it starts, where it left off.
 *
 * The identity is the cloud user at the tenancy (`rudolph@fnndsc`), the
 * berth a daemon advertises; disconnected, it is `disconnected@<cloud>`, so
 * two disconnected substrate daemons never share a name with each other or
 * with a ChRIS one. Home is the tenancy's `clusters/`. The working directory
 * is kept per identity under the user's configuration directory, so a
 * restarted daemon stands where it stood. The region is the session's
 * (docs/stratus.adoc, D4 and D8).
 *
 * @module
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { BackendSession, SessionIdentity } from '@fnndsc/brasa/core';
import type { CloudDriver, CloudIdentity } from './cloud/driver.js';

/** Where mise keeps a user's configuration. */
export function configDir_default(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env['XDG_CONFIG_HOME'] ?? path.join(homedir(), '.config'), 'mise', 'stratus');
}

/** How a session is made. */
export interface StratusSessionOptions {
  readonly driver: CloudDriver;
  /** The region the session works in; the credential's home region when absent. */
  readonly region?: string;
  /** Where the working directory is kept; the user's configuration directory when absent. */
  readonly configDir?: string;
}

/** The session over a cloud. */
export class StratusSession implements BackendSession {
  private readonly driver: CloudDriver;
  private readonly configDir: string;
  private readonly regionAsked: string | undefined;
  private cloudIdentity: CloudIdentity | null = null;
  private failure: string | null = null;
  private cwd: string | null = null;
  private regionCurrent: string | null = null;

  constructor(options: StratusSessionOptions) {
    this.driver = options.driver;
    this.configDir = options.configDir ?? configDir_default();
    this.regionAsked = options.region;
  }

  /** The cloud's short name. */
  get cloud(): string {
    return this.driver.cloud;
  }

  /** Why the session is not connected, or null when it is. */
  get disconnectedReason(): string | null {
    return this.failure;
  }

  /** The cloud identity, or null when not connected. */
  get identity(): CloudIdentity | null {
    return this.cloudIdentity;
  }

  /** The session's region, or null when not connected and none was asked. */
  get region(): string | null {
    return this.regionCurrent ?? this.regionAsked ?? null;
  }

  /** Changes the session's region. */
  region_set(region: string): void {
    this.regionCurrent = region;
  }

  /** The cloud's name as the prompt leads with it: the driver's id in capitals (`OCI`). */
  get cloudLabel(): string {
    return this.driver.cloud.toUpperCase();
  }

  /** The mount the tenancy lives under. */
  get mount(): string {
    return `/net/${this.driver.cloud}`;
  }

  /** The tenancy's folder, or the mount when not connected. */
  get tenancyPath(): string {
    return this.cloudIdentity === null ? this.mount : `${this.mount}/${this.cloudIdentity.tenancy}`;
  }

  async init(): Promise<void> {
    try {
      this.cloudIdentity = await this.driver.identity_get();
      this.failure = null;
      if (this.regionCurrent === null) this.regionCurrent = this.regionAsked ?? this.cloudIdentity.homeRegion;
    } catch (error: unknown) {
      this.cloudIdentity = null;
      this.failure = error instanceof Error ? error.message : String(error);
    }
    this.cwd = this.cwd_read();
  }

  async identity_get(): Promise<SessionIdentity> {
    if (this.cloudIdentity === null) return { user: 'disconnected', where: this.driver.cloud, connected: false };
    return { user: this.cloudIdentity.user, where: this.cloudIdentity.tenancy, connected: true };
  }

  async user_get(): Promise<string | null> {
    return this.cloudIdentity?.user ?? null;
  }

  async home_get(): Promise<string> {
    return this.cloudIdentity === null ? this.mount : `${this.tenancyPath}/clusters`;
  }

  async cwd_load(): Promise<string | null> {
    return this.cwd;
  }

  async cwd_save(cwd: string): Promise<void> {
    this.cwd = cwd;
    const file: string | null = this.cwdFile_get();
    if (file === null) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, `${cwd}\n`, { mode: 0o600 });
    } catch {
      // Deliberate absorption: a working directory that cannot be kept is
      // still the working directory; the next start begins at home.
    }
  }

  /** The working directory as it stands, for the prompt. */
  cwd_get(): string | null {
    return this.cwd;
  }

  /** The file the working directory is kept in, or null when not connected. */
  private cwdFile_get(): string | null {
    if (this.cloudIdentity === null) return null;
    const berth: string = `${this.cloudIdentity.user}@${this.cloudIdentity.tenancy}`.replace(/[^A-Za-z0-9@._-]/g, '_');
    return path.join(this.configDir, berth, 'cwd');
  }

  private cwd_read(): string | null {
    const file: string | null = this.cwdFile_get();
    if (file === null) return null;
    try {
      const text: string = readFileSync(file, 'utf-8').trim();
      return text === '' ? null : text;
    } catch {
      return null;
    }
  }
}
