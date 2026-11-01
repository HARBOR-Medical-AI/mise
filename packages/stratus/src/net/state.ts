/**
 * @file A network's own state, kept on the daemon's host beside the clusters'
 * (docs/stratus.adoc, D4, D16): `$XDG_STATE_HOME/stratus/nets/<name>/` holds
 * `spec.yaml` (the `net new` line's record), `state.json` (where it is built
 * and what the build left, written whole, mode 600) and `plan.json` (the
 * last plan, for the question before the apply).
 *
 * @module
 */
import * as os from 'os';
import * as path from 'path';
import { netSpecYaml_parse, netSpecYaml_render, type NetSpec } from './spec.js';
import { SpecStore, type KeptRecord } from '../kept/specStore.js';

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
export interface NetRecord extends KeptRecord {
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

/** The networks this daemon builds, on its host. */
export class NetStore extends SpecStore<NetSpec, NetRecord> {
  /**
   * @param root - The folder the networks live in.
   */
  constructor(root: string) {
    super(root, { noun: 'network', render: netSpecYaml_render, parse: netSpecYaml_parse });
  }
}
