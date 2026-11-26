/**
 * @file The ChRIS backend's descriptor: a session over a CUBE.
 *
 * The identity's context (cumin's per-user, per-CUBE configuration) names
 * the session (the CUBE user and URL) and holds the working directory; the
 * home is the CUBE user's home. The CUBE connection the ChRIS commands use is
 * reached as `session.connection`, which this module adds to the session.
 * The prompt and the daemon's heartbeat read the user, the CUBE, PACS and
 * the /proc index (`promptContext.ts`).
 *
 * @module
 */
import { chrisConnection, chrisConnection_init, NodeStorageProvider, chrisContext, Context } from '@fnndsc/cumin';
import { identityScope_run } from '@fnndsc/cumin/identity-epoch';
import { runtimeOutput_set } from '@fnndsc/cumin/runtime-output';
import type { Backend, SessionIdentity } from '../core/backend.js';
import { Session } from '../session/index.js';
import { homePath_derive } from '../builtins/utils.js';
import { sink_get } from '../core/sink.js';
import { procIndex_snapshot, sessionPromptContext_build } from './promptContext.js';
import { chrisAnswerKinds, chrisReferences, chrisVerbTakes } from './references.js';
import { chrisExpectSubjects } from './expectSubjects.js';
import { chrisFallback } from './commandFallback.js';
import { chrisFiles } from './files.js';
import { elevation_run } from '@fnndsc/chili/commands/connect/elevation.js';
import { chrisWatch } from './watch.js';
import { chrisJobsSource } from './tasks.js';
import { chrisListingLook } from '@fnndsc/chili/views/ls.js';
import { chrisFilesystem } from './filesystem.js';
import { chrisMounts_register } from './mounts.js';
import { chrisCompletion } from './completion.js';
import { chrisArgumentKinds } from './kinds.js';
import { chrisDebug_get, chrisDebug_set } from './debug.js';

declare module '../session/index.js' {
  interface Session {
    /** The CUBE connection the ChRIS commands use. */
    readonly connection: typeof chrisConnection;
  }
}

let connection: typeof chrisConnection | undefined;

// cumin reports operational notices through a narrow port. The callback
// resolves the sink at write time, preserving each invocation's
// AsyncLocalStorage scope rather than pinning output to one terminal.
runtimeOutput_set({
  data_write: (chunk: string | Buffer): void => { sink_get().data_write(chunk); },
  err_write: (chunk: string | Buffer): void => { sink_get().err_write(chunk); },
});

Object.defineProperty(Session.prototype, 'connection', {
  get(): typeof chrisConnection {
    return connection || chrisConnection;
  },
  configurable: true,
});

/** A ChRIS session with no restored CUBE login: its berth name is `disconnected@no-cube`. */
const CHRIS_DISCONNECTED: SessionIdentity = { user: 'disconnected', where: 'no-cube', connected: false };

/** The ChRIS backend: a session over a CUBE. */
export const chrisBackend: Backend = {
  id: 'chris',
  // A line is one piece of work begun under whoever is connected when it starts: what it fetches is kept
  // only while that is still who is connected.
  work_run: <T>(work: () => Promise<T>): Promise<T> => identityScope_run(work),
  session: {
    async init(): Promise<void> {
      chrisMounts_register();
      const nodeStorageProvider: NodeStorageProvider = new NodeStorageProvider();
      // Initialize the connection singleton which also initializes config
      connection = await chrisConnection_init(nodeStorageProvider);

      try {
        // Also initialize chili's duplicate copy of the connection singleton to align monorepo package boundaries
        const { chrisConnection_init: chiliConnection_init } = await import('@fnndsc/chili/utils');
        await chiliConnection_init(nodeStorageProvider);
      } catch (e: unknown) {
        // Deliberate absorption, adjudicated 2026-08: chili's connection init
        // is an optional secondary wiring (cumin's own init is the required
        // one); when it is absent or fails, chili paths fall back to cumin's
        // connection at call time.
      }
    },
    async identity_get(): Promise<SessionIdentity> {
      const where: string | null = await chrisContext.ChRISURL_get();
      const user: string | null = await chrisContext.ChRISuser_get();
      return user && where ? { user, where, connected: true } : CHRIS_DISCONNECTED;
    },
    async user_get(): Promise<string | null> {
      return chrisContext.ChRISuser_get();
    },
    async home_get(): Promise<string> {
      return homePath_derive(await chrisContext.current_get(Context.ChRISuser));
    },
    async cwd_load(): Promise<string | null> {
      return chrisContext.current_get(Context.ChRISfolder);
    },
    async cwd_save(path: string): Promise<void> {
      // Cache invalidation is handled automatically by cumin's chrisContext.
      await chrisContext.current_set(Context.ChRISfolder, path);
    },
  },
  prompt: sessionPromptContext_build,
  telemetry: procIndex_snapshot,
  references: chrisReferences,
  expectSubjects: chrisExpectSubjects,
  answerKinds: chrisAnswerKinds,
  verbTakes: chrisVerbTakes,
  fallback: chrisFallback,
  elevate: elevation_run,
  watch: chrisWatch,
  tasks: [chrisJobsSource],
  files: chrisFiles,
  vfs: chrisFilesystem,
  completion: chrisCompletion,
  argumentKinds: chrisArgumentKinds,
  listingLook: chrisListingLook,
  debug_get: chrisDebug_get,
  debug_set: chrisDebug_set,
};
