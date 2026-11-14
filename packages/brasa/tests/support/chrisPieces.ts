/**
 * @file Installs a backend made of the ChRIS backend's own pieces, over
 * whatever the test mocked beneath them (salsa's dispatcher, cumin's cache).
 *
 * A core module reaches the filesystem, completion and listings through the
 * installed backend; a test that mocks the ChRIS packages installs the ChRIS
 * pieces that read them, and the module under test meets its mocks as before.
 */
import type { Backend } from '../../src/core/backend.js';
import type { CommandDeclaration } from '../../src/core/commandDeclaration.js';

/** The pieces a test may install. */
export interface ChrisPieces {
  /** The session's home; absent, the given user's. */
  home_get?: () => Promise<string>;
  vfs?: boolean;
  completion?: boolean;
  listingLook?: boolean;
  /** The argument kinds the ChRIS backend registers (`feed`, `plugin`, `pipeline`, …). */
  kinds?: boolean;
  /** The declaration of a word the backend answers (a `/bin` entry's), as the fallback makes it. */
  declaration?: (command: string) => Promise<CommandDeclaration | null>;
}

/**
 * Installs the asked-for ChRIS pieces, with a session whose home is the
 * given user's.
 *
 * @param pieces - Which pieces.
 * @param user - The session's user, for `~`.
 */
export async function chrisPieces_install(pieces: ChrisPieces, user: string | null = 'testuser'): Promise<void> {
  const { backend_install } = await import('../../src/core/backend.js');
  const backend: Backend = {
    id: 'chris',
    session: {
      init: async (): Promise<void> => undefined,
      identity_get: async () => ({ user: user ?? 'disconnected', where: 'no-cube', connected: user !== null }),
      user_get: async (): Promise<string | null> => user,
      home_get: pieces.home_get ?? (async (): Promise<string> => (user ? `/home/${user}` : '/')),
      cwd_load: async (): Promise<string | null> => null,
      cwd_save: async (): Promise<void> => undefined,
    },
    ...(pieces.vfs ? { vfs: (await import('../../src/chris/filesystem.js')).chrisFilesystem } : {}),
    ...(pieces.completion ? { completion: (await import('../../src/chris/completion.js')).chrisCompletion } : {}),
    ...(pieces.listingLook ? { listingLook: (await import('@fnndsc/chili/views/ls.js')).chrisListingLook } : {}),
    ...(pieces.kinds ? { argumentKinds: (await import('../../src/chris/kinds.js')).chrisArgumentKinds } : {}),
    ...(pieces.declaration ? { fallback: { declaration: pieces.declaration } } : {}),
  };
  backend_install(backend);
}
