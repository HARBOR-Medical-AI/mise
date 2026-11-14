/**
 * @file The ChRIS session's prompt context: the engine-known facts a prompt reflects.
 *
 * A prompt shows live session state — user, CUBE, working directory, PACS,
 * physical-mode, warm-up progress — plus the last command's outcome. Only the
 * process holding the session can know these, but how they are *rendered*
 * (theme, segments, terminal width) is a frontend concern. This module builds
 * the engine half; each frontend renders it with its own theme, so the daemon
 * ships context and never a themed string.
 *
 * @module
 */

import { jobsState_derive, type JobsState } from './jobsState.js';
import type { ProcFeedPromptProgress } from '@fnndsc/menu';
import { session } from '../session/index.js';
import { warmupFailures_list, warmupPending_list, type WarmupFailure } from '../core/warmupFailures.js';
import { context_getSingle } from '@fnndsc/salsa';
import { type ProcFeed, pace_get, type CubePace, type ProcRosterSyncKind, SingleContext, procCache_get, type ProcCacheLifecycle, type ProcFeedLoadProgress, type ProcPromptProgress, type ProcPromptState, type ProcWarmupProgress, type ProcLandedFeed } from '@fnndsc/cumin';

/**
 * The engine-known facts a prompt reflects, independent of any theme.
 *
 * This is the shape carried over the wire to remote frontends. Rendering
 * inputs a frontend owns (terminal width, enabled segments, theme) are not
 * here — each surface supplies its own.
 */
export interface SessionPromptContext {
  user: string;
  uri: string;
  cwd: string;
  pacsserver: string | null;
  physicalMode: boolean;
  lastExitCode: number;
  lastCommandDurationMs: number;
  /** Present while /proc indexing is active, reconciling, or has failed. */
  procWarmup?: ProcPromptProgress;
  /** Steady-state index counts, present whenever the cache holds anything. */
  procIndex?: { jobs: number; feeds: number };
  /** Calypso's declared host-control tiers, when it acts on its own host. */
  hostControl?: string[];
  /**
   * Warm-up steps that failed behind the prompt and have not since
   * succeeded. They persist until a later attempt clears them: a step
   * that left the boot gate has no other way to be heard.
   */
  warmupFailures?: WarmupFailure[];
  /**
   * Warm-up steps still running behind the prompt, by label. A daemon
   * listens before its warm-up ends, so a surface that attaches early is
   * told what the session is still warming.
   */
  warmupPending?: string[];
}

/**
 * Inputs the caller knows that the session state does not.
 *
 * @property lastExitCode - The previous command's exit code (default 0).
 * @property lastCommandDurationMs - The previous command's duration (default 0).
 */
export interface SessionPromptContextOptions {
  lastExitCode?: number;
  lastCommandDurationMs?: number;
}

/**
 * Snapshots the live process-index counts, cheaply: no network, just the
 * cache's own registers. The daemon's telemetry heartbeat reads this.
 *
 * @returns The jobs and feeds the index currently holds.
 */
export function procIndex_snapshot(): ProcIndexSnapshot {
  const cache = procCache_get();
  const pace: CubePace | null = pace_get();
  return {
    jobs: cache.warmupProgress_get().loaded,
    feeds: cache.feedScopeCounts_get('').total,
    ...(pace !== null ? { cube: { msPerPage: pace.msPerPage, samples: pace.samples } } : {}),
    state: jobsState_derive(cache.feeds_find('')),
  };
}

/** What the daemon heartbeats about the index, the pace and the lab's pulse. */
export interface ProcIndexSnapshot {
  jobs: number;
  feeds: number;
  cube?: { msPerPage: number; samples: number };
  state?: JobsState;
}


/**
 * Builds the current session's prompt context.
 *
 * @param options - The last-command inputs the session cannot know.
 * @returns The engine-known prompt facts.
 */
export async function sessionPromptContext_build(
  options: SessionPromptContextOptions = {},
): Promise<SessionPromptContext> {
  const context: SingleContext = await context_getSingle();
  const cwd: string = await session.getCWD();
  const isOffline: boolean = session.offline;

  const warmupRaw: ProcWarmupProgress = procCache_get().warmupProgress_get();
  const lifecycle: ProcCacheLifecycle = procCache_get().lifecycle_get();
  const restored: boolean = lifecycle.checkpointAt !== undefined;
  const procState: ProcPromptState = lifecycle.state === 'failed'
    ? 'failed'
    : restored ? 'cached' : 'cold';
  // A feed's first-visit load and roster arrivals ride the same segment:
  // both are index movement no command announces, and the daemon keeps
  // pushing the promptline while the segment is present.
  const feedLoads: ProcFeedLoadProgress[] = procCache_get().feedLoads_all();
  const feedLoad: ProcFeedLoadProgress | null = feedLoads[0] ?? null;
  const feeds: ProcFeedPromptProgress[] = feedLoads.map((load: ProcFeedLoadProgress): ProcFeedPromptProgress => ({
    id: load.feedID, loaded: load.loaded, total: load.total, ...(load.failed !== undefined ? { failed: load.failed } : {}),
  }));
  const arrived: number[] = procCache_get().arrivals_recent();
  // Feeds whose topology just landed, each with its shape: the space of
  // everything run here, materialising on a surface as the index reads it.
  const landed: ProcLandedFeed[] = procCache_get().topologyLanded_recent();
  const roster: ProcRosterSyncKind | null = procCache_get().rosterSync_get();
  const sweeping: boolean =
    warmupRaw.active || lifecycle.state === 'reconciling' || lifecycle.state === 'failed';
  const warmupFailures: WarmupFailure[] = warmupFailures_list();
  const warmupPending: string[] = warmupPending_list();
  const procWarmup: ProcPromptProgress | undefined =
    sweeping || feedLoad !== null || arrived.length > 0 || landed.length > 0 || roster !== null
      ? {
          loaded: warmupRaw.loaded,
          total: warmupRaw.total,
          restored,
          state: procState,
          sweeping,
          ...(feedLoad !== null ? { feed: feeds[0], feeds } : {}),
          ...(arrived.length > 0 ? { arrived } : {}),
          ...(landed.length > 0 ? { landed } : {}),
          ...(roster !== null ? { roster } : {}),
        }
      : undefined;
  // Steady-state counts stay visible after warm-up settles: warmup progress
  // retains its final figures, and the feed map is the live index.
  const procIndex: { jobs: number; feeds: number } | undefined =
    warmupRaw.loaded > 0 || procCache_get().feedScopeCounts_get(context.user ?? '').total > 0
      ? {
          jobs: warmupRaw.loaded,
          feeds: procCache_get().feedScopeCounts_get(context.user ?? '').total,
        }
      : undefined;

  return {
    user:                  isOffline ? 'disconnected' : (context.user ?? 'disconnected'),
    uri:                   isOffline ? 'no-cube'      : (context.URL  ?? 'no-cube'),
    cwd:                   isOffline ? '/'            : cwd,
    pacsserver:            context.pacsserver ?? null,
    physicalMode:          session.physicalMode_get(),
    lastExitCode:          options.lastExitCode ?? 0,
    lastCommandDurationMs: options.lastCommandDurationMs ?? 0,
    procWarmup,
    ...(warmupFailures.length > 0 ? { warmupFailures } : {}),
    ...(warmupPending.length > 0 ? { warmupPending } : {}),
    procIndex,
  };
}
