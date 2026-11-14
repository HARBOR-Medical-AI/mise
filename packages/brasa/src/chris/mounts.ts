/**
 * @file The mounts a ChRIS session adds to salsa's dispatcher beyond CUBE's
 * own: `/bin`, and the hook through which the dispatcher asks where a path
 * lives in the store, which is the one resolver every file command asks
 * (`storePath_resolve`).
 *
 * @module
 */
import { vfsDispatcher } from '@fnndsc/salsa';
import { session } from '../session/index.js';
import { storePath_resolve } from '../core/paths.js';
import { BinVfsProvider } from './binMount.js';

let mounted: boolean = false;

/**
 * Adds `/bin` to the dispatcher, and the hook that maps a path handed to the
 * store to where the store keeps it (following `.chrislink` folders), unless
 * the session is in physical mode. Once; before the core adds its own
 * mounts, so `/` lists `/bin` where it always has.
 */
export function chrisMounts_register(): void {
  if (mounted) return;
  mounted = true;
  vfsDispatcher.provider_register(new BinVfsProvider());
  vfsDispatcher.pathResolver_register(async (logicalPath: string): Promise<string> => (
    session.physicalMode_get() ? logicalPath : storePath_resolve(logicalPath)
  ));
}
