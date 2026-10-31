/**
 * @file The installer's account, kept as a file on the host: Red Hat's
 * service account, which the Assisted Installer's token is asked with.
 *
 * A build needs it from its `cluster` step on. When the file is missing,
 * `cluster build` asks for it (a typed question: the id in the open, the
 * secret hidden) and keeps it here, mode 600; it is never sent back to a
 * surface (docs/stratus.adoc, D14).
 *
 * @module
 */
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

/** Where the installer's account is kept, and how to keep one. */
export interface InstallerAccountKeeper {
  /** The file it is kept in. */
  readonly path: string;
  /** Whether the file is there. */
  present(): boolean;
  /** Keeps an account, replacing none: refuses when one is there. */
  keep(clientId: string, clientSecret: string): void;
}

/**
 * The account kept in one file, in the form `serviceAccount_read` reads.
 *
 * @param path - The file.
 * @returns The keeper.
 */
export function fileAccount_make(path: string): InstallerAccountKeeper {
  return {
    path,
    present: (): boolean => existsSync(path),
    keep: (clientId: string, clientSecret: string): void => {
      if (existsSync(path)) throw new Error(`${path} is there already; it is not replaced from a question`);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, `RH_CLIENT_ID="${clientId}"\nRH_CLIENT_SECRET="${clientSecret}"\n`, { encoding: 'utf-8', mode: 0o600 });
      chmodSync(path, 0o600);
    },
  };
}
