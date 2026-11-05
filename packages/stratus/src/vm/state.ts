/**
 * @file A VM's state on the host (docs/stratus.adoc, D16), beside its
 * `spec.yaml`: the cloud's handles on its two stacks (its data, which a
 * default teardown keeps, and its machine), what each apply left, the image
 * pinned at its first build, whether it is protected, and its SSH key, made
 * for it alone and never leaving the host but as the public half.
 *
 * Under `$XDG_STATE_HOME/stratus/vms/<name>/`.
 *
 * @module
 */
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SpecStore, type KeptRecord } from '../kept/specStore.js';
import { vmSpecYaml_parse, vmSpecYaml_render, type VmSpec } from './spec.js';

/** What stratus knows of a VM it builds. */
export interface VmRecord extends KeptRecord {
  /** Born true; `vm protect <name> off` lifts it, and teardown refuses while it holds. The tenancy keeps it (`kept/lock.ts`). */
  protected?: boolean;
  /** When the lock was last set. */
  protectedAt?: string;
  /** The time of the lock the tenancy's vault last held, as last read. */
  lockKept?: string;
  /** The place it stands in: its network's. */
  placeId?: string;
  /** The image pinned at the first build; a later plan never moves it silently. */
  image?: string;
  /** The data stack (volume, backups, reserved address) and what its apply left. */
  dataStackRef?: string;
  dataOutputs?: Record<string, string>;
  /** The machine stack (instance, boot disk, security group, attachment) and what its apply left. */
  machineStackRef?: string;
  machineOutputs?: Record<string, string>;
  built?: string;
  /** The spec the last build made the tenancy match, so a later declare says what a build would change. */
  builtSpec?: VmSpec;
  /** The ChRIS deployed on it (`chris deploy`). */
  chris?: { profile: string; compute: string; host: string | null; url: string; deployed: string; dns?: 'waiting' | 'seen'; porter?: string; /** The CUBE image and porter version the deploy put up. */ image?: string; porterVersion?: string };
  /** When this host's cache of it was read from the tenancy (its stacks, and the secrets its vault keeps): built by a session that left no record here. */
  takenFrom?: string;
  /** The machine as this cache last saw it: a tenancy that answers otherwise (rebuilt or resized from another session) has the cache read again. */
  seen?: { instanceId: string; vcpus: number; memoryGib: number };
  /** What the tenancy runs, read on the last listing: the instance's vCPUs and memory, the boot and data volumes' sizes, and when it was read. */
  stands?: VmStands;
  /** When the declaration the vault keeps was made: equal to `declared` once this host's declaration is kept in the tenancy. */
  keptDeclared?: string;
  /** The disks a build grew whose filesystems are not grown yet: the next build grows them. */
  growOwed?: { boot: boolean; data: boolean };
  /** The last teardown, once one has started: when, and each step (`machine`, `data`) as it began and ended. */
  teardown?: { started: string; steps: Record<string, { state: 'running' | 'done' | 'kept' | 'failed'; started?: string; ended?: string; note?: string }> };
  /** The machine went (a default teardown); the data stays. */
  machineGone?: string;
  /** Everything went (`--all`). */
  gone?: string;
}

/** What the tenancy runs of a VM, read from the cloud: never the declaration. */
export interface VmStands {
  /** When it was read. */
  readonly at: string;
  readonly vcpu: number | null;
  readonly memory: number | null;
  /** The boot volume's size in GB, or null when not read. */
  readonly disk: number | null;
  /** The data volume's size in GB, or null when not read. */
  readonly data: number | null;
  /** The ports its security groups open to the internet (from anywhere), sorted, or null when not read; absent from an older read. */
  readonly open?: number[] | null;
  /** Its data volume's backups: `daily`, `none`, or the policy's name when it is another; null when not read. */
  readonly backup?: string | null;
  /** The operating system its image is, in a script's words (`ubuntu-26.04`), or null when not read. */
  readonly os?: string | null;
}

/** The freeform tag a VM's stacks carry, so a fresh mise bastion finds them. */
export const VM_TAG: string = 'mise-service';

/** The freeform tags `chris deploy` puts on a VM's instance: the CUBE API's address, and porter's name when it runs one; read back by any session that finds the VM in the tenancy. */
export const CHRIS_URL_TAG: string = 'mise-chris';
export const CHRIS_PORTER_TAG: string = 'mise-porter';

/** A VM's name: a hostname label. */
export const VM_NAME: RegExp = /^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$/;

/** The user every image stratus builds from logs in as. */
export const VM_USER: string = 'ubuntu';

/**
 * Where VMs are kept.
 *
 * @param env - The environment.
 * @returns `$XDG_STATE_HOME/stratus/vms`.
 */
export function vmsRoot_derive(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env['XDG_STATE_HOME'] || path.join(os.homedir(), '.local', 'state'), 'stratus', 'vms');
}

/** The VMs this daemon builds, on its host. */
export class VmStore extends SpecStore<VmSpec, VmRecord> {
  /**
   * @param root - The folder the VMs live in.
   */
  constructor(root: string) {
    super(root, { noun: 'VM', render: vmSpecYaml_render, parse: vmSpecYaml_parse });
  }

  /**
   * Declares a VM; a new one is born protected.
   *
   * @param name - The VM.
   * @param spec - Its spec.
   * @param region - The region a new one is built in.
   * @returns Its record.
   */
  override declare(name: string, spec: VmSpec, region: string): VmRecord {
    const fresh: boolean = this.record_read(name) === null;
    const record: VmRecord = super.declare(name, spec, region);
    if (!fresh) return record;
    return this.record_update(name, (current: VmRecord): void => { current.protected = true; current.protectedAt = current.created; });
  }

  /**
   * The VM's SSH key, made on first ask (`ssh-keygen`, ed25519, no passphrase, mode 600).
   *
   * @param name - The VM.
   * @returns The private key's path and the public key's line.
   * @throws Error - When `ssh-keygen` fails.
   */
  key_ensure(name: string): { privatePath: string; publicKey: string } {
    const folder: string = path.join(this.folder_derive(name), 'ssh');
    const privatePath: string = path.join(folder, 'id_ed25519');
    if (!fs.existsSync(privatePath)) {
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      const made: SpawnSyncReturns<string> = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `stratus-${name}`, '-f', privatePath], { encoding: 'utf-8' });
      if (made.status !== 0) throw new Error(`ssh-keygen: ${(made.stderr || made.error?.message || 'failed').trim()}`);
    }
    return { privatePath, publicKey: fs.readFileSync(`${privatePath}.pub`, 'utf-8').trim() };
  }
}
