/**
 * @file A network's own state, kept on the daemon's host beside the clusters'
 * (docs/stratus.adoc, D4, D16): `$XDG_STATE_HOME/stratus/nets/<name>/` holds
 * `spec.yaml` (the `net new` line's record), `state.json` (where it is built
 * and what the build left, written whole, mode 600) and `plan.json` (the
 * last plan, for the question before the apply).
 *
 * @module
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { netSpecYaml_parse, netSpecYaml_render, type NetSpec } from './spec.js';

/**
 * What `state.json` holds.
 *
 * @property name - The network's name, and its place's (an OCI compartment).
 * @property created - When `net new` first wrote it.
 * @property region - The region it is built in.
 * @property placeId - The place it lives in (OCI: the compartment's id), once the build has it.
 * @property placeMade - Whether the build made the place, so its teardown removes it; false when an empty one was adopted.
 * @property stackRef - The stack its resources are in, once a plan made it.
 * @property outputs - What the apply left (the network's, subnet's and bastion's ids).
 * @property clientCidr - The address the managed bastion admits, as the build read it.
 * @property built - When its apply ended.
 * @property gone - When its teardown removed it.
 */
export interface NetRecord {
  name: string;
  created: string;
  region: string;
  placeId?: string;
  placeMade?: boolean;
  stackRef?: string;
  outputs?: Record<string, string>;
  clientCidr?: string;
  built?: string;
  gone?: string;
}

/** The freeform tag a network's stack and place carry, `mise-net=<name>`: how a session finds the tenancy's networks. */
export const NET_TAG: string = 'mise-net';

/** A network's name: lower-case letters, digits and hyphens, as an OCI compartment and a DNS label stem allow. */
export const NET_NAME: RegExp = /^[a-z]([a-z0-9-]{0,52}[a-z0-9])?$/;

/**
 * The folder a daemon keeps its networks in.
 *
 * @param env - The environment.
 * @returns `$XDG_STATE_HOME/stratus/nets`, or `~/.local/state/stratus/nets`.
 */
export function netsRoot_derive(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env['XDG_STATE_HOME'] || path.join(os.homedir(), '.local', 'state'), 'stratus', 'nets');
}

/**
 * Writes a file whole or not at all, readable by its owner only.
 *
 * @param file - Where.
 * @param text - What.
 */
function file_writeAtomic(file: string, text: string): void {
  const temporary: string = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** The networks this daemon builds, on its host. */
export class NetStore {
  /**
   * @param root - The folder the networks live in.
   */
  constructor(readonly root: string) {}

  /**
   * A network's folder.
   *
   * @param name - The network.
   * @returns Its folder.
   */
  folder_derive(name: string): string {
    return path.join(this.root, name);
  }

  /** The names of the networks kept, sorted. */
  names_list(): string[] {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root).filter((name: string): boolean => fs.existsSync(path.join(this.root, name, 'state.json'))).sort();
  }

  /**
   * Declares a network: writes its spec, and its first state when it has none.
   *
   * @param name - The network.
   * @param spec - Its spec.
   * @param region - The region a new one is built in.
   * @returns Its record.
   */
  declare(name: string, spec: NetSpec, region: string): NetRecord {
    const folder: string = this.folder_derive(name);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    file_writeAtomic(path.join(folder, 'spec.yaml'), netSpecYaml_render(name, spec));
    const kept: NetRecord | null = this.record_read(name);
    if (kept !== null) return kept;
    const record: NetRecord = { name, created: new Date().toISOString(), region };
    this.record_write(record);
    return record;
  }

  /**
   * A network's state.
   *
   * @param name - The network.
   * @returns Its record, or null when none is kept.
   */
  record_read(name: string): NetRecord | null {
    const file: string = path.join(this.folder_derive(name), 'state.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as NetRecord;
  }

  /**
   * Saves a network's state.
   *
   * @param record - Its record.
   */
  record_write(record: NetRecord): void {
    file_writeAtomic(path.join(this.folder_derive(record.name), 'state.json'), `${JSON.stringify(record, null, 2)}\n`);
  }

  /**
   * Changes a network's state and saves it.
   *
   * @param name - The network.
   * @param change - What to change.
   * @returns The record as saved.
   * @throws Error - When none is kept.
   */
  record_update(name: string, change: (record: NetRecord) => void): NetRecord {
    const record: NetRecord | null = this.record_read(name);
    if (record === null) throw new Error(`${name}: no such network`);
    change(record);
    this.record_write(record);
    return record;
  }

  /**
   * A network's spec.
   *
   * @param name - The network.
   * @returns The spec, or why it does not read, or null when there is no file.
   */
  spec_read(name: string): { spec: NetSpec } | { error: string } | null {
    const file: string = path.join(this.folder_derive(name), 'spec.yaml');
    if (!fs.existsSync(file)) return null;
    return netSpecYaml_parse(fs.readFileSync(file, 'utf-8'));
  }

  /**
   * Writes one of the network's own files (`plan.json`), whole.
   *
   * @param name - The network.
   * @param file - The file's name in its folder.
   * @param text - Its content.
   */
  file_write(name: string, file: string, text: string): void {
    file_writeAtomic(path.join(this.folder_derive(name), file), text);
  }

  /**
   * Reads one of the network's own files.
   *
   * @param name - The network.
   * @param file - The file's name in its folder.
   * @returns Its content, or null when it is not there.
   */
  file_read(name: string, file: string): string | null {
    const where: string = path.join(this.folder_derive(name), file);
    return fs.existsSync(where) ? fs.readFileSync(where, 'utf-8') : null;
  }

  /**
   * Removes one of the network's own files; one not there is no error.
   *
   * @param name - The network.
   * @param file - The file's name in its folder.
   */
  file_remove(name: string, file: string): void {
    fs.rmSync(path.join(this.folder_derive(name), file), { force: true });
  }
}
