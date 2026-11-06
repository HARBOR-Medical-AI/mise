/**
 * @file Registering one plugin in the connected CUBE: `plugin add`.
 *
 * One verb, four ways in:
 *
 * - **a descriptor** (`plugin add --json <file>`): the descriptor's text goes
 *   straight to CUBE's administrative upload, unless that name and version
 *   are already registered;
 * - **a URL** of a plugin in another CUBE: passed through as the upload's
 *   `plugin_store_url`, and CUBE fetches the plugin itself;
 * - **a name** or **an image**: registered already? then nothing to do;
 *   else looked up in the peer store and imported from it; else the
 *   image's own descriptor is read out of it with docker and uploaded.
 *
 * Every path registers through one upload ({@link plugin_addDescriptor}
 * for descriptors), which `plugin sync` shares, and every refusal carries
 * CUBE's own reason. Compute resources default to all the CUBE has, as
 * `plugin add` always did; a failed read of them is a failure, never a
 * guess at `host`.
 *
 * Key components:
 * - PluginAddOutcome / PluginAddResult: what an add did.
 * - PluginAddOptions: compute resources, peer store, administrator credentials.
 * - pluginInput_detect: whether an input is a URL, an image or a name.
 * - computeNames_resolve: the compute resources a plugin is registered on.
 * - plugin_addDescriptor: upload one descriptor's text (shared with sync).
 * - plugin_addJson: `plugin add --json`.
 * - plugin_add: `plugin add <name|image|url>`.
 *
 * Typical usage:
 * ```ts
 * const result: PluginAddResult = await plugin_add('pl-dircopy', { store: storeUrl }, (line: string): void => sink(line));
 * ```
 *
 * Dependencies: cumin (CUBE reads and the administrative upload), the peer
 * store search, and docker on the host for the image path.
 *
 * @module
 */

import {
  Client,
  chrisConnection,
  computeResourceNames_parse,
  computeResources_getAll,
  computeResources_validate,
  errorStack,
  Err,
  Ok,
  pluginAdmin_upload,
  plugin_find,
  type ComputeResource,
  type Result,
} from '@fnndsc/cumin';

import { descriptorFromImage_extract, docker_isAvailable, dockerImage_ensure, type DockerRun, docker_run } from './plugin_docker.js';
import { plugins_searchPeers, type PeerStorePlugin } from './peer_search.js';
import { plugin_checkExists, type PluginRegistrationResponse } from './plugin_register.js';
import { plugin_importFromStore, type AdminCredentials, type PluginImportResult } from './store_import.js';

/** What an add did. */
export type PluginAddOutcome = 'installed' | 'already_exists' | 'failed';

/** Writes one progress line where the operator can see it. */
export type PluginAddNote = (line: string) => void;

/**
 * What `plugin add` was asked to do it with.
 *
 * @example
 * ```ts
 * const options: PluginAddOptions = { compute: 'host,gpu', store: 'https://cube.chrisproject.org/api/v1/' };
 * ```
 */
export interface PluginAddOptions {
  /** Compute resources, comma-separated; all the CUBE has when absent. */
  readonly compute?: string;
  /** The peer store to search; the caller's configured store. */
  readonly store?: string;
  /** Administrator username, for a non-interactive upload. */
  readonly adminUser?: string;
  /** Administrator password, for a non-interactive upload. */
  readonly adminPassword?: string;
  /** The plugin's repository, when an image's descriptor leaves it out. */
  readonly publicRepo?: string;
}

/**
 * What an add did, and to which plugin.
 *
 * @example
 * ```ts
 * const result: PluginAddResult = { outcome: 'installed', name: 'pl-dircopy', version: '2.1.1' };
 * ```
 */
export interface PluginAddResult {
  /** The outcome. */
  readonly outcome: PluginAddOutcome;
  /** The plugin's name, when known. */
  readonly name?: string;
  /** The plugin's version, when known. */
  readonly version?: string;
  /** Why it failed, when it did (also on the error stack). */
  readonly reason?: string;
}

/**
 * What an input names.
 *
 * @example
 * ```ts
 * pluginInput_detect('fnndsc/pl-dircopy:2.1.1'); // { kind: 'image', value: …, name: 'pl-dircopy', version: '2.1.1' }
 * ```
 */
export interface PluginInput {
  /** A plugin URL in another CUBE, an image reference, or a plugin name. */
  readonly kind: 'url' | 'image' | 'name';
  /** The input, trimmed. */
  readonly value: string;
  /** The plugin name it implies. */
  readonly name: string;
  /** The version it implies, when it names one. */
  readonly version?: string;
}

/**
 * Detects what an input names.
 *
 * A URL starts with `http://` or `https://`; an image holds `/` or `:`;
 * anything else is a plugin name, `pl-x-v1.2.3` naming a version.
 *
 * @param input - The input as typed.
 * @returns What it names.
 *
 * @example
 * ```ts
 * pluginInput_detect('pl-dircopy-v2.1.1'); // { kind: 'name', value: 'pl-dircopy', name: 'pl-dircopy', version: '2.1.1' }
 * ```
 */
export function pluginInput_detect(input: string): PluginInput {
  const value: string = input.trim();
  if (/^https?:\/\//.test(value)) return { kind: 'url', value, name: value };
  if (value.includes('/') || value.includes(':')) {
    const last: string = value.split('@')[0]?.split('/').pop() ?? value;
    const colon: number = last.indexOf(':');
    const name: string = colon === -1 ? last : last.slice(0, colon);
    return colon === -1 ? { kind: 'image', value, name } : { kind: 'image', value, name, version: last.slice(colon + 1) };
  }
  const marker: number = value.lastIndexOf('-v');
  if (marker > 0 && /^[0-9.]+$/.test(value.slice(marker + 2))) {
    const name: string = value.slice(0, marker);
    return { kind: 'name', value: name, name, version: value.slice(marker + 2) };
  }
  return { kind: 'name', value, name: value };
}

/**
 * Resolves the compute resources a plugin is registered on.
 *
 * @param compute - Comma-separated names; all the CUBE's resources when absent.
 * @returns The names, or an error on the error stack (an unknown name, or the
 *   CUBE's resources could not be read — never a guess).
 *
 * @example
 * ```ts
 * const names: Result<string[]> = await computeNames_resolve('host');
 * ```
 */
export async function computeNames_resolve(compute?: string): Promise<Result<string[]>> {
  if (compute !== undefined && compute.trim() !== '') {
    const names: string[] = computeResourceNames_parse(compute);
    const valid: Result<string[]> = await computeResources_validate(names);
    return valid.ok ? Ok(names) : Err();
  }
  const all: Result<ComputeResource[]> = await computeResources_getAll();
  if (!all.ok) {
    errorStack.stack_push('error', 'Could not read the compute resources; not guessing. Name them with --compute.');
    return Err();
  }
  if (all.value.length === 0) {
    errorStack.stack_push('error', 'This CUBE has no compute resources to register plugins on.');
    return Err();
  }
  return Ok(all.value.map((resource: ComputeResource): string => resource.name));
}

/**
 * Uploads one descriptor's text through CUBE's administrative upload.
 *
 * @param descriptor - The descriptor's JSON text.
 * @param computeNames - Compute resources to register it on.
 * @param creds - Administrator credentials; the session when absent.
 * @returns The registered plugin's fields, or an error on the error stack.
 *
 * @example
 * ```ts
 * const added: Result<Record<string, unknown>> = await plugin_addDescriptor(text, ['host']);
 * ```
 */
export async function plugin_addDescriptor(
  descriptor: string,
  computeNames: string[],
  creds?: AdminCredentials,
): Promise<Result<Record<string, unknown>>> {
  const token: string | undefined = await adminToken_get(creds);
  return pluginAdmin_upload({ descriptor }, computeNames, token);
}

/**
 * Registers one descriptor file's plugin: `plugin add --json`.
 *
 * @param text - The descriptor's JSON text.
 * @param options - Compute resources and credentials.
 * @param note - Where progress lines go.
 * @returns What the add did.
 *
 * @example
 * ```ts
 * const result: PluginAddResult = await plugin_addJson(readFileSync('pl-x.json', 'utf8'), {}, console.log);
 * ```
 */
export async function plugin_addJson(text: string, options: PluginAddOptions, note: PluginAddNote): Promise<PluginAddResult> {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    return addFailure_record(`the descriptor is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record: Record<string, unknown> = data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const name: string | undefined = typeof record['name'] === 'string' ? record['name'] : undefined;
  const version: string | undefined = typeof record['version'] === 'string' ? record['version'] : undefined;
  if (name === undefined || version === undefined) return addFailure_record('the descriptor names no plugin name and version');

  const computes: Result<string[]> = await computeNames_resolve(options.compute);
  if (!computes.ok) return { outcome: 'failed', name, version };
  if (await pluginVersion_isRegistered(name, version)) return { outcome: 'already_exists', name, version };

  note(`Registering ${name} ${version} on ${computes.value.join(', ')}…`);
  const added: Result<Record<string, unknown>> = await plugin_addDescriptor(text, computes.value, creds_build(options));
  return added.ok ? { outcome: 'installed', name, version } : { outcome: 'failed', name, version };
}

/**
 * Registers a plugin named by a URL, an image or a name: `plugin add`.
 *
 * @param input - The URL, image reference or plugin name.
 * @param options - Compute resources, peer store and credentials.
 * @param note - Where progress lines go.
 * @param run - The docker seam, for the image path.
 * @returns What the add did.
 *
 * @example
 * ```ts
 * const result: PluginAddResult = await plugin_add('fnndsc/pl-dircopy:2.1.1', {}, console.log);
 * ```
 */
export async function plugin_add(
  input: string,
  options: PluginAddOptions,
  note: PluginAddNote,
  run: DockerRun = docker_run,
): Promise<PluginAddResult> {
  const detected: PluginInput = pluginInput_detect(input);
  const computes: Result<string[]> = await computeNames_resolve(options.compute);
  if (!computes.ok) return { outcome: 'failed' };

  if (detected.kind === 'url') {
    note(`Asking CUBE to register the plugin at ${detected.value}…`);
    const token: string | undefined = await adminToken_get(creds_build(options));
    const added: Result<Record<string, unknown>> = await pluginAdmin_upload({ storeUrl: detected.value }, computes.value, token);
    if (!added.ok) return { outcome: 'failed' };
    return pluginRegistered_result(added.value);
  }

  const existing: PluginRegistrationResponse | null = await plugin_checkExists(detected.kind === 'image' ? detected.value : detected.name);
  if (existing !== null && (detected.version === undefined || existing['version'] === detected.version)) {
    return { outcome: 'already_exists', name: detected.name, ...(detected.version === undefined ? {} : { version: detected.version }) };
  }

  note(`Searching the peer store for ${detected.name}…`);
  const peerStores: string[] | undefined = options.store === undefined ? undefined : [options.store];
  const found: PeerStorePlugin | null = await plugins_searchPeers(detected.name, detected.version, peerStores);
  if (found !== null) {
    note(`Found in ${found.storeName}; importing.`);
    const imported: PluginImportResult = await plugin_importFromStore('', found.plugin, computes.value, creds_build(options));
    if (imported.success) return pluginRegistered_result(imported.plugin ?? {});
    return addFailure_record(imported.errorMessage ?? 'the peer store import failed', detected);
  }

  const image: string = detected.kind === 'image' ? detected.value : `${detected.name}:latest`;
  note(`Not in the peer store; reading the descriptor out of ${image}.`);
  return pluginFromImage_add(image, computes.value, options, run);
}

/**
 * Registers a plugin from its image's own descriptor.
 *
 * @param image - The image reference.
 * @param computeNames - Compute resources to register it on.
 * @param options - Credentials and the repository to fill in.
 * @param run - The docker seam.
 * @returns What the add did.
 */
async function pluginFromImage_add(
  image: string,
  computeNames: string[],
  options: PluginAddOptions,
  run: DockerRun,
): Promise<PluginAddResult> {
  if (!await docker_isAvailable(run)) return addFailure_record('docker is not installed or not running on this host');
  const missing: string | null = await dockerImage_ensure(image, run);
  if (missing !== null) return addFailure_record(missing);
  const descriptor: Record<string, unknown> | null = await descriptorFromImage_extract(image, options.publicRepo, run);
  if (descriptor === null) return addFailure_record(`${image} printed no plugin descriptor (is it a ChRIS plugin?)`);
  descriptorGaps_fill(descriptor, image, options.publicRepo);
  const added: Result<Record<string, unknown>> = await plugin_addDescriptor(JSON.stringify(descriptor), computeNames, creds_build(options));
  if (!added.ok) return { outcome: 'failed', name: String(descriptor['name']) };
  return pluginRegistered_result(added.value);
}

/**
 * Fills what an image's descriptor may leave out: its name, image and repository.
 *
 * @param descriptor - The descriptor, changed in place.
 * @param image - The image it came from.
 * @param publicRepo - The repository the operator named, when any.
 */
function descriptorGaps_fill(descriptor: Record<string, unknown>, image: string, publicRepo?: string): void {
  if (typeof descriptor['name'] !== 'string' || descriptor['name'] === '') descriptor['name'] = pluginInput_detect(image).name;
  if (typeof descriptor['dock_image'] !== 'string' || descriptor['dock_image'] === '') descriptor['dock_image'] = image;
  if (typeof descriptor['public_repo'] !== 'string' || descriptor['public_repo'] === '') {
    if (publicRepo !== undefined) descriptor['public_repo'] = publicRepo;
  }
}

/**
 * Reports whether a name and version are registered in the connected CUBE.
 *
 * @param name - The plugin name.
 * @param version - The version.
 * @returns True when CUBE holds that version.
 */
async function pluginVersion_isRegistered(name: string, version: string): Promise<boolean> {
  const client: Client | null = await chrisConnection.client_get();
  if (client === null) return false;
  try {
    return (await plugin_find(client, name, version)) !== null;
  } catch {
    // A failed read is not "registered": the upload that follows answers
    // with CUBE's own refusal if the version is there after all.
    return false;
  }
}

/**
 * Builds the result of a registration from CUBE's answer.
 *
 * @param plugin - The registered plugin's fields.
 * @returns An installed result naming it.
 */
function pluginRegistered_result(plugin: Record<string, unknown>): PluginAddResult {
  const name: unknown = plugin['name'];
  const version: unknown = plugin['version'];
  return {
    outcome: 'installed',
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof version === 'string' ? { version } : {}),
  };
}

/**
 * Records a failure on the error stack and as a result.
 *
 * @param reason - Why the add failed.
 * @param input - The input, for the plugin's name.
 * @returns A failed result carrying the reason.
 */
function addFailure_record(reason: string, input?: PluginInput): PluginAddResult {
  errorStack.stack_push('error', reason);
  return { outcome: 'failed', reason, ...(input === undefined ? {} : { name: input.name }) };
}

/**
 * Builds administrator credentials from the options, when both halves are given.
 *
 * @param options - The add options.
 * @returns The credentials, or undefined to upload as the session.
 */
function creds_build(options: PluginAddOptions): AdminCredentials | undefined {
  return options.adminUser && options.adminPassword ? { username: options.adminUser, password: options.adminPassword } : undefined;
}

/**
 * Gets an administrator token for credentials.
 *
 * @param creds - The credentials; none means the session uploads.
 * @returns The token, or undefined when there are no credentials or the login failed (a warning says so).
 */
async function adminToken_get(creds?: AdminCredentials): Promise<string | undefined> {
  if (creds?.username === undefined || creds.password === undefined) return undefined;
  const url: string | null = await chrisConnection.chrisURL_get();
  if (!url) return undefined;
  try {
    return await Client.getAuthToken(`${url.endsWith('/') ? url : `${url}/`}auth-token/`, creds.username, creds.password);
  } catch (error: unknown) {
    errorStack.stack_push('warning', `Failed to get admin token: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
