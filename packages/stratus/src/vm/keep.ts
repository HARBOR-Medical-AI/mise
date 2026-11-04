/**
 * @file What the tenancy keeps of a VM (docs/stratus.adoc, D16): the secrets
 * no stack holds, as one secret in the tenancy's vault, `mise-vm-<name>`: the
 * VM's SSH key, and when ChRIS is deployed on it, the deploy's record and
 * passwords. The tenancy is the truth; a host's folder for the VM is a cache
 * of its stacks and of this, so any session on any host that holds the
 * tenancy's credentials reaches the VM, resizes it and manages its ChRIS.
 *
 * Written whenever the cache gains a secret (a build's machine, a deploy),
 * and read back when a session finds a VM it keeps no record of.
 *
 * @module
 */
import * as fs from 'fs';
import * as path from 'path';
import type { BuildCall, CloudBuilder } from '../cloud/builder.js';
import type { ChrisSecrets } from '../chris/compose.js';
import { secrets_read, secrets_write } from '../chris/secrets.js';
import type { VmRecord, VmStore } from './state.js';

/** What a verb says of a VM whose SSH key neither the tenancy nor this host keeps. */
export const VM_KEYLESS: string = 'the tenancy keeps no SSH key for it, and this host holds none: it was built before stratus kept keys in the tenancy, so the machine is not reached from here (vm keep <name>, on the host that holds its key, keeps it in the tenancy)';

/** What one VM's secret holds. */
export interface VmKept {
  readonly vm: string;
  readonly ssh: { readonly privateKey: string; readonly publicKey: string };
  readonly chris?: { readonly record: NonNullable<VmRecord['chris']>; readonly secrets: ChrisSecrets };
}

/**
 * The secret's name in the tenancy's vault.
 *
 * @param name - The VM.
 * @returns `mise-vm-<name>`.
 */
export function vmKeepName_derive(name: string): string {
  return `mise-vm-${name}`;
}

/**
 * The VM's SSH key's files in its cache folder.
 *
 * @param store - The VMs.
 * @param name - The VM.
 * @returns The private key's path and the public key's.
 */
function keyFiles_derive(store: VmStore, name: string): { privatePath: string; publicPath: string } {
  const privatePath: string = path.join(store.folder_derive(name), 'ssh', 'id_ed25519');
  return { privatePath, publicPath: `${privatePath}.pub` };
}

/**
 * Whether the cache holds the VM's SSH key.
 *
 * @param store - The VMs.
 * @param name - The VM.
 * @returns True when it does.
 */
export function vmKey_held(store: VmStore, name: string): boolean {
  return fs.existsSync(keyFiles_derive(store, name).privatePath);
}

/**
 * Whether a VM is read and never reached: read from the tenancy, which keeps
 * no SSH key for it, and this host holds none. A VM declared or built here
 * holds its own key (made at its first plan).
 *
 * @param store - The VMs.
 * @param record - Its record.
 * @returns True when it is keyless.
 */
export function vmKeyless_is(store: VmStore, record: VmRecord): boolean {
  return record.takenFrom !== undefined && !vmKey_held(store, record.name);
}

/**
 * What the cache holds of the VM's secrets, as the tenancy keeps them.
 *
 * @param store - The VMs.
 * @param name - The VM.
 * @returns The secret's content, or null when the cache holds no SSH key for it.
 */
export function vmKept_gather(store: VmStore, name: string): VmKept | null {
  const { privatePath, publicPath } = keyFiles_derive(store, name);
  if (!fs.existsSync(privatePath) || !fs.existsSync(publicPath)) return null;
  const record: VmRecord | null = store.record_read(name);
  const secrets: ChrisSecrets | null = secrets_read(store, name);
  return {
    vm: name,
    ssh: { privateKey: fs.readFileSync(privatePath, 'utf-8'), publicKey: fs.readFileSync(publicPath, 'utf-8').trim() },
    ...(record?.chris !== undefined && secrets !== null ? { chris: { record: record.chris, secrets } } : {}),
  };
}

/**
 * Writes the VM's secrets to the tenancy, from the cache.
 *
 * @param builder - The cloud.
 * @param store - The VMs.
 * @param name - The VM.
 * @param region - Its region.
 * @param call - The step's log and stop.
 * @returns What was kept, in a word, or null when the cache holds nothing to keep.
 * @throws Error - When the cloud keeps nothing.
 */
export async function vmKept_write(builder: CloudBuilder, store: VmStore, name: string, region: string, call: BuildCall): Promise<string | null> {
  if (builder.keep_write === undefined) throw new Error('this cloud keeps nothing in the tenancy');
  const kept: VmKept | null = vmKept_gather(store, name);
  if (kept === null) return null;
  await builder.keep_write({ region, name: vmKeepName_derive(name), content: JSON.stringify(kept) }, call);
  return kept.chris !== undefined ? 'its SSH key and its ChRIS' : 'its SSH key';
}

/**
 * Reads the VM's secrets back from the tenancy into the cache: its SSH key,
 * and its ChRIS's record and passwords when kept.
 *
 * @param builder - The cloud.
 * @param store - The VMs; the VM's record must exist.
 * @param name - The VM.
 * @param region - Its region.
 * @returns True when the tenancy kept them, false when it keeps nothing of the VM.
 */
export async function vmKept_restore(builder: CloudBuilder, store: VmStore, name: string, region: string): Promise<boolean> {
  if (builder.keep_read === undefined) return false;
  const content: string | null = await builder.keep_read({ region, name: vmKeepName_derive(name) });
  if (content === null) return false;
  const kept: VmKept = JSON.parse(content) as VmKept;
  if (kept.vm !== name || typeof kept.ssh?.privateKey !== 'string' || typeof kept.ssh?.publicKey !== 'string') throw new Error(`${vmKeepName_derive(name)}: the tenancy's secret is not a VM's keep`);
  const { privatePath, publicPath } = keyFiles_derive(store, name);
  fs.mkdirSync(path.dirname(privatePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(privatePath, kept.ssh.privateKey.endsWith('\n') ? kept.ssh.privateKey : `${kept.ssh.privateKey}\n`, { mode: 0o600 });
  fs.writeFileSync(publicPath, `${kept.ssh.publicKey}\n`, { mode: 0o644 });
  if (kept.chris !== undefined) {
    secrets_write(store, name, kept.chris.secrets);
    const chris: NonNullable<VmRecord['chris']> = kept.chris.record;
    store.record_update(name, (current: VmRecord): void => { current.chris = chris; });
  }
  return true;
}
