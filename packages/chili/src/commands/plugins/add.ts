/**
 * @file `chili plugins add`: a thin pass to salsa's `plugin_add`.
 *
 * Registering a plugin is salsa's logic (`plugin_add`: a URL, an image or
 * a name, through the peer store or the image's own descriptor). chili's
 * own command-line tool keeps its `plugins add` by handing the words over
 * and printing what salsa writes; nothing of the registration lives here.
 *
 * @module
 */

import { plugin_add as salsa_plugin_add, type PluginAddOutcome, type PluginAddResult } from '@fnndsc/salsa';

import { CLIoptions } from '../../utils/cli.js';
import { chiliErrLog, chiliLog } from '../../screen/output.js';

export type { PluginAddOutcome };

/**
 * Options `chili plugins add` passes through.
 */
interface PluginAddOptions extends CLIoptions {
  compute?: string;
  store?: string;
  adminUser?: string;
  adminPassword?: string;
  public_repo?: string;
}

/**
 * Registers a plugin from a URL, an image or a name.
 *
 * @param input - The plugin's URL, image reference or name.
 * @param options - Compute resources, peer store, credentials and repository.
 * @returns The add outcome.
 */
export async function plugin_add(input: string, options: PluginAddOptions): Promise<PluginAddOutcome> {
  const result: PluginAddResult = await salsa_plugin_add(input, {
    ...(options.compute !== undefined ? { compute: options.compute } : {}),
    ...(options.store !== undefined ? { store: options.store } : {}),
    ...(options.adminUser !== undefined ? { adminUser: options.adminUser } : {}),
    ...(options.adminPassword !== undefined ? { adminPassword: options.adminPassword } : {}),
    ...(options.public_repo !== undefined ? { publicRepo: options.public_repo } : {}),
  }, chiliLog);
  if (result.outcome === 'failed' && result.reason !== undefined) chiliErrLog(result.reason);
  return result.outcome;
}
