/**
 * @file What the tenancy keeps for stratus (docs/stratus.adoc, D16): one
 * vault in the tenancy's root compartment, `mise`, with one software key, and
 * a secret per thing stratus built that has secrets of its own (a VM's SSH
 * key, its ChRIS's passwords). The tenancy is the truth about what stratus
 * built, and a host's records only a cache of it: any session, on any host,
 * that holds the tenancy's credentials reads the same secrets back. The vault
 * is made on the first write and kept; a secret dropped is scheduled for
 * deletion, and one written again while scheduled is brought back.
 *
 * The wire only; the builder decides what to keep. Only this folder imports `oci-*`.
 *
 * @module
 */
import * as common from 'oci-common';
import * as keymanagement from 'oci-keymanagement';
import * as secrets from 'oci-secrets';
import * as vault from 'oci-vault';
import { KeepFault, errorStatus_describe } from '../keepFault.js';
import { notFound } from './errors.js';
import { pages_drain } from './pages.js';

/** The vault's and its key's display name. */
export const KEEP_VAULT: string = 'mise';

/** The freeform tag the vault and every secret carry, so a reader of the tenancy sees whose they are. */
const KEEP_TAGS: Record<string, string> = { 'mise-keep': 'stratus' };

/** How long a dropped secret waits before the cloud deletes it: the cloud's shortest. */
const DROP_DAYS: number = 1;

/** The calls, in one region. */
export interface OciKeepApi {
  /** A secret's content, or null when the vault or the secret is not there (or the secret is scheduled for deletion). */
  secret_read(name: string): Promise<string | null>;
  /** Writes a secret's content: a new version of one there when its content differs (brought back first when scheduled for deletion), else a new secret; the vault and its key made first when missing. One there that cannot be read is left as it is, and the write fails. */
  secret_write(name: string, content: string, log: (line: string) => void): Promise<void>;
  /** Schedules a secret's deletion; one not there is no error. Answers whether it was there. */
  secret_drop(name: string): Promise<boolean>;
}

/** How the calls authenticate, and where. */
export interface OciKeepApiOptions {
  readonly configFile?: string;
  readonly profile?: string;
  readonly region: string;
  /** How a wait is made; a check hands in one that does not wait. */
  readonly pause?: (ms: number) => Promise<void>;
}

/** Base64 as the cloud writes it: the alphabet, padded to a multiple of four. */
const BASE64: RegExp = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * A secret's content out of the bundle the cloud answers.
 *
 * @param bundle - The answer to a bundle read.
 * @returns The content as text (empty for an empty secret), or undefined
 *   when the bundle carries none.
 * @throws {KeepFault} When the content is not base64: decoded leniently it
 *   would be some other text, and compared as if it were the secret's.
 */
function content_decode(bundle: secrets.responses.GetSecretBundleByNameResponse): string | undefined {
  const content: unknown = (bundle.secretBundle.secretBundleContent as { content?: unknown } | undefined)?.content;
  if (content === undefined) return undefined;
  if (typeof content !== 'string' || !BASE64.test(content)) throw new KeepFault('the cloud answered content that is not base64');
  return Buffer.from(content, 'base64').toString('utf-8');
}

/** How many times a write looks again and tries again before it gives up. */
const WRITE_TRIES: number = 5;

/** The statuses that say another writer changed the secret since it was read. */
const HTTP_CONFLICTS: ReadonlyArray<number> = [409, 412];

/** Waits a while. */
const pause_default = (ms: number): Promise<void> => new Promise((resolve): void => { setTimeout(resolve, ms); });

/**
 * The keep's calls over the SDK.
 *
 * @param options - The profile and the region.
 * @returns The calls.
 */
export function ociKeepApi_make(options: OciKeepApiOptions): OciKeepApi {
  const provider: common.ConfigFileAuthenticationDetailsProvider = new common.ConfigFileAuthenticationDetailsProvider(options.configFile, options.profile);
  const regional = <T extends { regionId?: string }>(client: T): T => { client.regionId = options.region; return client; };
  const vaults: keymanagement.KmsVaultClient = regional(new keymanagement.KmsVaultClient({ authenticationDetailsProvider: provider }));
  const secretsOf: vault.VaultsClient = regional(new vault.VaultsClient({ authenticationDetailsProvider: provider }));
  const bundles: secrets.SecretsClient = regional(new secrets.SecretsClient({ authenticationDetailsProvider: provider }));
  const root: string = provider.getTenantId();
  const pause: (ms: number) => Promise<void> = options.pause ?? pause_default;

  /** The vault, active, or null; one still being made is waited on. */
  const vault_find = async (): Promise<keymanagement.models.VaultSummary | null> => {
    for (let tries: number = 0; tries < 60; tries += 1) {
      const found: keymanagement.models.VaultSummary[] = (await pages_drain((page: string | undefined) => vaults.listVaults({ compartmentId: root, page })))
        .filter((one): boolean => one.displayName === KEEP_VAULT && (one.lifecycleState === 'ACTIVE' || one.lifecycleState === 'CREATING'));
      const active: keymanagement.models.VaultSummary | undefined = found.find((one): boolean => one.lifecycleState === 'ACTIVE');
      if (active !== undefined) return active;
      if (found.length === 0) return null;
      await pause(5000);
    }
    throw new Error(`the vault ${KEEP_VAULT} is still being made after five minutes`);
  };

  /** The vault's key management, at the vault's own endpoint. */
  const keysClient_make = (found: keymanagement.models.VaultSummary): keymanagement.KmsManagementClient => {
    const client: keymanagement.KmsManagementClient = new keymanagement.KmsManagementClient({ authenticationDetailsProvider: provider });
    client.endpoint = found.managementEndpoint;
    return client;
  };

  /** The vault's key, enabled, made when missing and waited on. */
  const key_ensure = async (found: keymanagement.models.VaultSummary, log: (line: string) => void): Promise<string> => {
    const keys: keymanagement.KmsManagementClient = keysClient_make(found);
    for (let tries: number = 0; tries < 60; tries += 1) {
      const all: keymanagement.models.KeySummary[] = (await pages_drain((page: string | undefined) => keys.listKeys({ compartmentId: root, page }))).filter((one): boolean => one.displayName === KEEP_VAULT);
      const enabled: keymanagement.models.KeySummary | undefined = all.find((one): boolean => one.lifecycleState === 'ENABLED');
      if (enabled !== undefined) return enabled.id;
      if (!all.some((one): boolean => one.lifecycleState === 'CREATING' || one.lifecycleState === 'ENABLING')) {
        log(`the vault ${KEEP_VAULT}: making its key`);
        await keys.createKey({ createKeyDetails: { compartmentId: root, displayName: KEEP_VAULT, freeformTags: KEEP_TAGS, keyShape: { algorithm: keymanagement.models.KeyShape.Algorithm.Aes, length: 32 }, protectionMode: keymanagement.models.CreateKeyDetails.ProtectionMode.Software } });
      }
      await pause(5000);
    }
    throw new Error(`the vault ${KEEP_VAULT}'s key is still being made after five minutes`);
  };

  /** The vault, made when missing. */
  const vault_ensure = async (log: (line: string) => void): Promise<keymanagement.models.VaultSummary> => {
    const found: keymanagement.models.VaultSummary | null = await vault_find();
    if (found !== null) return found;
    log(`the tenancy keeps no vault ${KEEP_VAULT} in this region: making it (a virtual vault, free; made once and kept)`);
    await vaults.createVault({ createVaultDetails: { compartmentId: root, displayName: KEEP_VAULT, freeformTags: KEEP_TAGS, vaultType: keymanagement.models.CreateVaultDetails.VaultType.Default } });
    const made: keymanagement.models.VaultSummary | null = await vault_find();
    if (made === null) throw new Error(`the vault ${KEEP_VAULT} was asked for and is not there`);
    return made;
  };

  /** A call retried while the cloud answers it with a 5xx, as a vault or key just made does for a while. */
  const settled_call = async <T>(call: () => Promise<T>): Promise<T> => {
    for (let tries: number = 1; ; tries += 1) {
      try {
        return await call();
      } catch (error: unknown) {
        const status: number | undefined = (error as { statusCode?: number }).statusCode;
        if (status === undefined || status < 500 || tries >= 12) throw error;
        await pause(10_000);
      }
    }
  };

  /** A secret of a name in the vault, in any state but deleted, or null. */
  const secret_find = async (vaultId: string, name: string): Promise<vault.models.SecretSummary | null> => {
    const all: vault.models.SecretSummary[] = await pages_drain((page: string | undefined) => secretsOf.listSecrets({ compartmentId: root, vaultId, name, page }));
    return all.find((one): boolean => one.secretName === name && one.lifecycleState !== 'DELETED') ?? null;
  };

  /** Waits a secret out of its passing states, and answers its tag as it then stands: what a write is bound to. */
  const secret_settle = async (secretId: string): Promise<string | undefined> => {
    for (let tries: number = 0; tries < 60; tries += 1) {
      const answer = await secretsOf.getSecret({ secretId });
      const state: string = answer.secret.lifecycleState;
      if (state === 'ACTIVE') return answer.etag;
      if (state === 'FAILED') throw new Error('the cloud failed the secret');
      await pause(2000);
    }
    throw new Error('the secret is not active after two minutes');
  };

  return {
    async secret_read(name: string): Promise<string | null> {
      const found: keymanagement.models.VaultSummary | null = await vault_find();
      if (found === null) return null;
      try {
        return content_decode(await bundles.getSecretBundleByName({ secretName: name, vaultId: found.id })) ?? null;
      } catch (error: unknown) {
        // A secret scheduled for deletion answers as not there, as a deleted one does.
        if (notFound(error) || (error as { statusCode?: number }).statusCode === 409) return null;
        throw error;
      }
    },

    async secret_write(name: string, content: string, log: (line: string) => void): Promise<void> {
      const found: keymanagement.models.VaultSummary = await vault_ensure(log);
      const keyId: string = await key_ensure(found, log);
      const body: vault.models.Base64SecretContentDetails = { contentType: vault.models.Base64SecretContentDetails.contentType, content: Buffer.from(content, 'utf-8').toString('base64') };
      const kept: vault.models.SecretSummary | null = await secret_find(found.id, name);
      if (kept === null) {
        const made = await settled_call(() => secretsOf.createSecret({ createSecretDetails: { compartmentId: root, vaultId: found.id, keyId, secretName: name, freeformTags: KEEP_TAGS, secretContent: body } }));
        await secret_settle(made.secret.id);
        return;
      }
      if (kept.lifecycleState === 'PENDING_DELETION') await secretsOf.cancelSecretDeletion({ secretId: kept.id });
      // Every update makes a version and the cloud holds thirty at once, so
      // a write of what the secret already holds is not made. Each try
      // reads the secret's tag and then its content, compares, and writes
      // bound to that tag (`ifMatch`): the cloud refuses the write if the
      // secret changed since. After a refusal like that, or an answer that
      // does not say whether the write was made (a 5xx, no answer), the
      // secret is read again before anything else: a write that did land
      // then compares equal, and no second version is made of it.
      /** What the secret holds now, with the tag it stands at; unread, it is left as it is. */
      const held_read = async (): Promise<{ tag: string | undefined; held: string }> => {
        const tag: string | undefined = await secret_settle(kept.id);
        let held: string | undefined;
        try {
          held = content_decode(await bundles.getSecretBundleByName({ secretName: name, vaultId: found.id }));
        } catch (error: unknown) {
          // Writing unread is how the thirty are spent on a vault that answers no reads.
          const why: string = error instanceof KeepFault ? error.message : errorStatus_describe(error);
          throw new KeepFault(`the secret ${name} is kept and could not be read (${why}), so it was left as it is`);
        }
        if (held === undefined) throw new KeepFault(`the secret ${name} is kept and the cloud answered no content for it, so it was left as it is`);
        return { tag, held };
      };
      let last: string = 'no status';
      for (let tries: number = 1; tries <= WRITE_TRIES; tries += 1) {
        const now: { tag: string | undefined; held: string } = await held_read();
        if (now.held === content) return;
        // Without a tag the write would be bound to nothing, and the cloud
        // would take it whatever the secret had become.
        if (typeof now.tag !== 'string' || now.tag.trim() === '') {
          throw new KeepFault(`the secret ${name} is kept and the cloud gave no version tag for it, so it was left as it is`);
        }
        try {
          await secretsOf.updateSecret({ secretId: kept.id, ifMatch: now.tag, updateSecretDetails: { secretContent: body } });
        } catch (error: unknown) {
          const status: number | undefined = (error as { statusCode?: number }).statusCode;
          const changedSince: boolean = status !== undefined && HTTP_CONFLICTS.includes(status);
          const unsure: boolean = status === undefined || status >= 500;
          last = errorStatus_describe(error);
          if (!changedSince && !unsure) throw new KeepFault(`the secret ${name} could not be written (${last})`);
          if (unsure && tries < WRITE_TRIES) await pause(10_000);
          continue;
        }
        await secret_settle(kept.id);
        return;
      }
      // The last write's fate is not known either. One more look, and no
      // more writes: if it landed, the secret holds what was to be kept.
      if ((await held_read()).held === content) return;
      throw new KeepFault(`the secret ${name} could not be written (${last}, after ${WRITE_TRIES} tries)`);
    },

    async secret_drop(name: string): Promise<boolean> {
      const found: keymanagement.models.VaultSummary | null = await vault_find();
      if (found === null) return false;
      const kept: vault.models.SecretSummary | null = await secret_find(found.id, name);
      if (kept === null || kept.lifecycleState === 'PENDING_DELETION') return false;
      const when: Date = new Date(Date.now() + DROP_DAYS * 24 * 3_600_000 + 60_000);
      await secretsOf.scheduleSecretDeletion({ secretId: kept.id, scheduleSecretDeletionDetails: { timeOfDeletion: when } });
      return true;
    },
  };
}
