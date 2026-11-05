/**
 * @file What the tenancy keeps of a VM (docs/stratus.adoc, D16): the secrets
 * no stack holds, as one secret in the tenancy's vault, `mise-vm-<name>`: the
 * VM's SSH key, and when ChRIS is deployed on it, the deploy's record and
 * passwords. The tenancy is the truth; a host's folder for the VM is a cache
 * of its stacks and of this, so any session on any host that holds the
 * tenancy's credentials reaches the VM, resizes it and manages its ChRIS.
 *
 * It also keeps what was last declared of the VM, with when (the operator,
 * 2026-11-04): a declaration a MANAGE session makes, or a build applies,
 * reaches every session, so no size declared on one host is silently lost to
 * another. A write merges with what the vault holds: a key or a ChRIS another
 * host kept is never dropped by a host that lacks it, and the newer
 * declaration wins.
 *
 * It keeps the VM's lock (PROTECT) too, with when it was set: a lock set on
 * one host holds on every host, and of two the newer is the lock
 * (`kept/lock.ts`).
 *
 * Written whenever the cache gains a secret (a build's machine, a deploy) or
 * a MANAGE session declares, read back when a session finds a VM it keeps no
 * record of, and read on each listing for a declaration newer than the
 * cache's.
 *
 * @module
 */
import * as fs from 'fs';
import * as path from 'path';
import type { BuildCall, CloudBuilder } from '../cloud/builder.js';
import type { ChrisSecrets } from '../chris/compose.js';
import { secrets_read, secrets_write } from '../chris/secrets.js';
import { lock_adopt, lock_newer, lock_read, type KeptLock } from '../kept/lock.js';
import type { VmSpec } from './spec.js';
import type { VmRecord, VmStore } from './state.js';

/** What a verb says of a VM whose SSH key neither the tenancy nor this host keeps. */
export const VM_KEYLESS: string = 'the tenancy keeps no SSH key for it, and this host holds none: it was built before stratus kept keys in the tenancy, so the machine is not reached from here (vm keep <name>, on the host that holds its key, keeps it in the tenancy)';

/** What one VM's secret holds. */
export interface VmKept {
  readonly vm: string;
  /** Its SSH key; absent while a VM is only declared (the key is made at its first plan). */
  readonly ssh?: { readonly privateKey: string; readonly publicKey: string };
  readonly chris?: { readonly record: NonNullable<VmRecord['chris']>; readonly secrets: ChrisSecrets };
  /** What was last declared of it, and when. */
  readonly declared?: { readonly spec: VmSpec; readonly at: string };
  /** Whether teardown is refused, and when that was set. */
  readonly lock?: KeptLock;
}

/**
 * Two keeps of one VM as one: each part from whichever holds it, the
 * newer declaration of the two, this host's key and ChRIS over the vault's
 * when both hold them (this host's are the ones it acts with).
 *
 * @param vault - What the vault holds, or null.
 * @param here - What this host holds.
 * @returns The keep to write.
 */
export function vmKept_merge(vault: VmKept | null, here: VmKept): VmKept {
  const declared: VmKept['declared'] = vault?.declared === undefined ? here.declared
    : here.declared === undefined ? vault.declared
      : here.declared.at >= vault.declared.at ? here.declared : vault.declared;
  const ssh: VmKept['ssh'] = here.ssh ?? vault?.ssh;
  const chris: VmKept['chris'] = here.chris ?? vault?.chris;
  const lock: KeptLock | undefined = lock_newer(here.lock, vault?.lock);
  return { vm: here.vm, ...(ssh !== undefined ? { ssh } : {}), ...(chris !== undefined ? { chris } : {}), ...(declared !== undefined ? { declared } : {}), ...(lock !== undefined ? { lock } : {}) };
}

/**
 * The vault's keep of a VM, read and checked.
 *
 * @param builder - The cloud.
 * @param name - The VM.
 * @param region - Its region.
 * @returns The keep, or null when the vault keeps nothing of it (or this cloud keeps nothing).
 * @throws Error - When the secret is not a VM's keep.
 */
export async function vmKept_read(builder: CloudBuilder, name: string, region: string): Promise<VmKept | null> {
  if (builder.keep_read === undefined) return null;
  const content: string | null = await builder.keep_read({ region, name: vmKeepName_derive(name) });
  if (content === null) return null;
  const kept: VmKept = JSON.parse(content) as VmKept;
  const sshBad: boolean = kept.ssh !== undefined && (typeof kept.ssh.privateKey !== 'string' || typeof kept.ssh.publicKey !== 'string');
  if (kept.vm !== name || sshBad) throw new Error(`${vmKeepName_derive(name)}: the tenancy's secret is not a VM's keep`);
  return kept;
}

/**
 * Takes the vault's declaration into the cache when it is newer than the
 * cache's (declared by another session or host), its time kept as when it
 * was declared.
 *
 * @param store - The VMs; the VM's record must exist.
 * @param name - The VM.
 * @param kept - The vault's keep.
 * @returns True when the cache took it.
 */
export function vmDeclared_adopt(store: VmStore, name: string, kept: VmKept | null): boolean {
  const record: VmRecord | null = store.record_read(name);
  if (record === null || kept?.declared === undefined) return false;
  if (record.declared !== undefined && record.declared >= kept.declared.at) return false;
  const at: string = kept.declared.at;
  store.declare(name, kept.declared.spec, record.region);
  store.record_update(name, (current: VmRecord): void => { current.declared = at; });
  return true;
}

/**
 * Takes the vault's lock into the cache when it is newer than the cache's
 * (set by another session or host), and keeps its time as the tenancy's.
 *
 * @param store - The VMs; the VM's record must exist.
 * @param name - The VM.
 * @param kept - The vault's keep.
 */
export function vmLock_adopt(store: VmStore, name: string, kept: VmKept | null): void {
  if (store.record_read(name) === null) return;
  store.record_update(name, (current: VmRecord): void => { lock_adopt(current, kept?.lock, false); });
}

/**
 * Takes the vault's ChRIS (its deploy's record and passwords) into the cache
 * when it is newer than the cache's: a deploy made from another host, so
 * this host's plans and renders say what that deploy put up.
 *
 * @param store - The VMs; the VM's record must exist.
 * @param name - The VM.
 * @param kept - The vault's keep.
 * @returns True when the cache took it.
 */
export function vmChris_adopt(store: VmStore, name: string, kept: VmKept | null): boolean {
  const record: VmRecord | null = store.record_read(name);
  if (record === null || kept?.chris === undefined) return false;
  if (record.chris !== undefined && record.chris.deployed >= kept.chris.record.deployed) return false;
  secrets_write(store, name, kept.chris.secrets);
  const chris: NonNullable<VmRecord['chris']> = kept.chris.record;
  store.record_update(name, (current: VmRecord): void => { current.chris = chris; });
  return true;
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
  const keyed: boolean = fs.existsSync(privatePath) && fs.existsSync(publicPath);
  const record: VmRecord | null = store.record_read(name);
  const secrets: ChrisSecrets | null = secrets_read(store, name);
  const read = store.spec_read(name);
  const spec: VmSpec | null = read !== null && 'spec' in read ? read.spec : null;
  const declared: VmKept['declared'] = spec !== null && record?.declared !== undefined ? { spec, at: record.declared } : undefined;
  const chris: VmKept['chris'] = record?.chris !== undefined && secrets !== null ? { record: record.chris, secrets } : undefined;
  const lock: KeptLock | undefined = record?.protected === undefined ? undefined : lock_read(record, false);
  if (!keyed && chris === undefined && declared === undefined && lock === undefined) return null;
  return {
    vm: name,
    ...(keyed ? { ssh: { privateKey: fs.readFileSync(privatePath, 'utf-8'), publicKey: fs.readFileSync(publicPath, 'utf-8').trim() } } : {}),
    ...(chris !== undefined ? { chris } : {}),
    ...(declared !== undefined ? { declared } : {}),
    ...(lock !== undefined ? { lock } : {}),
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
  const here: VmKept | null = vmKept_gather(store, name);
  if (here === null) return null;
  const kept: VmKept = vmKept_merge(await vmKept_read(builder, name, region), here);
  await builder.keep_write({ region, name: vmKeepName_derive(name), content: JSON.stringify(kept) }, call);
  // The vault's declaration may be the newer: the cache follows it, so this host acts on what was last declared.
  vmDeclared_adopt(store, name, kept);
  vmLock_adopt(store, name, kept);
  const keptAt: string | undefined = kept.declared?.at;
  if (keptAt !== undefined) store.record_update(name, (current: VmRecord): void => { current.keptDeclared = keptAt; });
  const parts: string[] = [...(kept.ssh !== undefined ? ['its SSH key'] : []), ...(kept.chris !== undefined ? ['its ChRIS'] : []), ...(kept.declared !== undefined ? ['what was declared'] : []), ...(kept.lock !== undefined ? ['its lock'] : [])];
  return parts.length === 0 ? null : parts.length === 1 ? parts[0] as string : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) as string}`;
}

/**
 * Reads the VM's secrets back from the tenancy into the cache: its SSH key,
 * its ChRIS's record and passwords when kept, and its declaration when newer
 * than the cache's.
 *
 * @param builder - The cloud.
 * @param store - The VMs; the VM's record must exist.
 * @param name - The VM.
 * @param region - Its region.
 * @returns True when the tenancy kept its SSH key, false when it keeps none.
 */
export async function vmKept_restore(builder: CloudBuilder, store: VmStore, name: string, region: string): Promise<boolean> {
  const kept: VmKept | null = await vmKept_read(builder, name, region);
  if (kept === null) return false;
  vmDeclared_adopt(store, name, kept);
  vmLock_adopt(store, name, kept);
  if (kept.chris !== undefined) {
    secrets_write(store, name, kept.chris.secrets);
    const chris: NonNullable<VmRecord['chris']> = kept.chris.record;
    store.record_update(name, (current: VmRecord): void => { current.chris = chris; });
  }
  if (kept.ssh === undefined) return false;
  const { privatePath, publicPath } = keyFiles_derive(store, name);
  fs.mkdirSync(path.dirname(privatePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(privatePath, kept.ssh.privateKey.endsWith('\n') ? kept.ssh.privateKey : `${kept.ssh.privateKey}\n`, { mode: 0o600 });
  fs.writeFileSync(publicPath, `${kept.ssh.publicKey}\n`, { mode: 0o644 });
  return true;
}
